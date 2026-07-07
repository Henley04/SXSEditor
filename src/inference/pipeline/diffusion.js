const { MEL_DIM, COND_DIM, NPU_STATIC_SEQ_LEN } = require('./constants');
const { createFloatTensor, outputToFloat32, disposeTensor } = require('./utils');

/**
 * Diffusion sampling loop (the core synthesis algorithm)
 */
class Diffusion {
    /**
     * Run a single diffusion step (public API).
     *
     * 张量生命周期：本函数在 diffusion loop 中被调用 2×totalSteps 次（cond + uncond），
     * 是显存累积的最大头（32 步 × 2 × 5 张量 = 320 个/合成）。
     * 推理后立即释放所有输入和输出张量，防止 GPU 显存耗尽触发 887A0005/887A0006。
     *
     * 注意：每次调用都会重建 cond/mask 张量。在 runDiffusionLoop 中，cond/mask 跨步不变，
     * 应优先调用 _runDiffStepWithCachedTensors 以避免 64 倍冗余张量重建。
     */
    async runDiffStep(sessions, xtInputData, tVal, condData, maskData, totalFramesWithPrompt, isFP16, useStaticShapes = false) {
        const floatType = isFP16 ? 'float16' : 'float32';
        const seqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFramesWithPrompt;

        const padFloat = (src, len) => {
            if (src.length >= len) return src;
            const padded = new Float32Array(len);
            padded.set(src);
            return padded;
        };

        const xtPadded = useStaticShapes ? padFloat(xtInputData, seqLen * MEL_DIM) : xtInputData;
        const condPadded = useStaticShapes ? padFloat(condData, seqLen * COND_DIM) : condData;
        const maskPadded = useStaticShapes ? padFloat(maskData, seqLen) : maskData;

        const xtTensor = createFloatTensor(floatType, xtPadded, [1, seqLen, MEL_DIM]);
        const tTensor = createFloatTensor(floatType, new Float32Array([tVal]), [1]);
        const condTensor = createFloatTensor(floatType, condPadded, [1, seqLen, COND_DIM]);
        const maskTensor = createFloatTensor(floatType, maskPadded, [1, seqLen]);

        let results;
        try {
            results = await sessions.diffStep.run({
                xt_input: xtTensor,
                t: tTensor,
                cond: condTensor,
                xt_mask: maskTensor,
            });
        } catch (err) {
            // 推理失败也要释放输入张量
            disposeTensor(xtTensor);
            disposeTensor(tTensor);
            disposeTensor(condTensor);
            disposeTensor(maskTensor);
            throw err;
        }

        const pred = outputToFloat32(results['flow_pred']);
        // 立即释放输出张量和所有输入张量：outputToFloat32 已拷贝数据到独立 Float32Array
        disposeTensor(results['flow_pred']);
        disposeTensor(xtTensor);
        disposeTensor(tTensor);
        disposeTensor(condTensor);
        disposeTensor(maskTensor);

        if (useStaticShapes) {
            return pred.subarray(0, totalFramesWithPrompt * MEL_DIM);
        }
        return pred;
    }

    /**
     * 单步扩散推理（使用预构建的 cond/mask 张量）。
     *
     * cond/mask 在 diffusion loop 中跨步不变，预先构建一次后复用，避免 64 步 × 2 分支
     * 的冗余 seqLen×COND_DIM FP16 转换（每步约 256KB→128KB 浪费）。
     * xt/t 每步变化，仍在本函数内构建并释放。
     *
     * @param {Object} sessions
     * @param {Float32Array} xtInputData - xt 输入（每步变化）
     * @param {number} tVal - 时间步值（每步变化）
     * @param {Object} condTensor - 预构建的 cond 张量（跨步复用，由调用方管理生命周期）
     * @param {Object} maskTensor - 预构建的 mask 张量（跨步复用，由调用方管理生命周期）
     * @param {number} totalFramesWithPrompt
     * @param {boolean} isFP16
     * @param {boolean} useStaticShapes
     * @returns {Promise<Float32Array>} flow_pred 数据（独立拷贝）
     * @private
     */
    async _runDiffStepWithCachedTensors(sessions, xtInputData, tVal, condTensor, maskTensor, totalFramesWithPrompt, isFP16, useStaticShapes = false) {
        const floatType = isFP16 ? 'float16' : 'float32';
        const seqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFramesWithPrompt;

        const padFloat = (src, len) => {
            if (src.length >= len) return src;
            const padded = new Float32Array(len);
            padded.set(src);
            return padded;
        };

        const xtPadded = useStaticShapes ? padFloat(xtInputData, seqLen * MEL_DIM) : xtInputData;
        const xtTensor = createFloatTensor(floatType, xtPadded, [1, seqLen, MEL_DIM]);
        const tTensor = createFloatTensor(floatType, new Float32Array([tVal]), [1]);

        let results;
        try {
            results = await sessions.diffStep.run({
                xt_input: xtTensor,
                t: tTensor,
                cond: condTensor,
                xt_mask: maskTensor,
            });
        } catch (err) {
            disposeTensor(xtTensor);
            disposeTensor(tTensor);
            throw err;
        }

        const pred = outputToFloat32(results['flow_pred']);
        disposeTensor(results['flow_pred']);
        disposeTensor(xtTensor);
        disposeTensor(tTensor);
        // 注意：condTensor/maskTensor 由调用方在 loop 结束时释放，此处不释放

        if (useStaticShapes) {
            return pred.subarray(0, totalFramesWithPrompt * MEL_DIM);
        }
        return pred;
    }

    /**
     * Run the full diffusion sampling loop
     */
    async runDiffusionLoop(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes = false) {
        const floatType = isFP16 ? 'float16' : 'float32';
        const totalFramesWithPrompt = ptFrameCount + totalFrames;

        // 对齐官方 PyTorch reverse_diffusion (flow_matching.py:254-309)：
        //   cond 分支:  xt_input = [prompt, xt],  seq_len = prompt_len + target_len
        //   uncond 分支: xt_input = xt (target only), seq_len = target_len
        //   uncond cond = zeros(target_len, COND_DIM), uncond mask = ones(target_len)
        // 旧实现把 uncond seq_len 也用 totalFramesWithPrompt，导致 RoPE 位置编码与官方不一致，
        // target 帧在 uncond 分支被赋予 position ptFrameCount.. 而非 0..，CFG 引导方向错误，
        // 32 步累积导致 mel 严重偏离 → 咬字不清。

        // cond 分支 cached tensors (seq_len = totalFramesWithPrompt)
        const condSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFramesWithPrompt;
        const frameMask = new Float32Array(totalFramesWithPrompt).fill(1);
        const xtInputBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);

        // uncond 分支 cached tensors (seq_len = totalFrames, 对齐官方)
        const uncondSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFrames;
        const uncondCondBuf = new Float32Array(totalFrames * COND_DIM);  // 全零
        const uncondMask = new Float32Array(totalFrames).fill(1);        // 全 1
        const xtUncondBuf = new Float32Array(totalFrames * MEL_DIM);     // 只含 target 段
        const cfgPredBuf = new Float32Array(totalFrames * MEL_DIM);

        const padFloat = (src, len) => {
            if (src.length >= len) return src;
            const padded = new Float32Array(len);
            padded.set(src);
            return padded;
        };
        const condPadded = useStaticShapes ? padFloat(combinedCond, condSeqLen * COND_DIM) : combinedCond;
        const condMaskPadded = useStaticShapes ? padFloat(frameMask, condSeqLen) : frameMask;
        const uncondCondPadded = useStaticShapes ? padFloat(uncondCondBuf, uncondSeqLen * COND_DIM) : uncondCondBuf;
        const uncondMaskPadded = useStaticShapes ? padFloat(uncondMask, uncondSeqLen) : uncondMask;
        const condTensorCached = createFloatTensor(floatType, condPadded, [1, condSeqLen, COND_DIM]);
        const condMaskTensorCached = createFloatTensor(floatType, condMaskPadded, [1, condSeqLen]);
        const uncondCondTensorCached = createFloatTensor(floatType, uncondCondPadded, [1, uncondSeqLen, COND_DIM]);
        const uncondMaskTensorCached = createFloatTensor(floatType, uncondMaskPadded, [1, uncondSeqLen]);

        const dt = 1.0 / totalSteps;
        const progressPerStep = progressRange / totalSteps;

        // prompt frames在循环中不变，预先拷贝一次
        xtInputBuf.set(ptMelData, 0);

        try {
            for (let step = 0; step < totalSteps; step++) {
                const tVal = (step + 0.5) / totalSteps;

                // cond 分支: xt_input = [prompt, xt]
                xtInputBuf.set(xt.data, ptFrameCount * MEL_DIM);
                const predData = await this._runDiffStepWithCachedTensors(sessions, xtInputBuf, tVal, condTensorCached, condMaskTensorCached, totalFramesWithPrompt, isFP16, useStaticShapes);

                if (cfgStrength > 0) {
                    // uncond 分支: xt_input = xt (target only, seq_len = totalFrames)
                    xtUncondBuf.set(xt.data, 0);
                    const uncondPred = await this._runDiffStepWithCachedTensors(sessions, xtUncondBuf, tVal, uncondCondTensorCached, uncondMaskTensorCached, totalFrames, isFP16, useStaticShapes);

                    const targetLen = totalFrames * MEL_DIM;
                    // Pass 1 (merged): compute CFG pred + write cfgPredBuf + accumulate
                    // sums AND sum-of-squares for variance in a single pass.
                    // Var(X) = E[X²] - E[X]²  →  sum((x-μ)²) = sumSq - sum²/n
                    // 注意: cond flow 从 ptFrameCount 偏移读（cond 输入含 prompt），
                    //       uncond flow 从 0 偏移读（uncond 输入只有 target）。
                    let posSum = 0;
                    let cfgAdjSum = 0;
                    let posSumSq = 0;
                    let cfgAdjSumSq = 0;
                    for (let f = 0; f < totalFrames; f++) {
                        const condOffset = (ptFrameCount + f) * MEL_DIM;
                        const uncondOffset = f * MEL_DIM;
                        for (let d = 0; d < MEL_DIM; d++) {
                            const condVal = predData[condOffset + d];
                            const uncondVal = uncondPred[uncondOffset + d];
                            posSum += condVal;
                            posSumSq += condVal * condVal;
                            const cfgVal = condVal + cfgStrength * (condVal - uncondVal);
                            cfgPredBuf[f * MEL_DIM + d] = cfgVal;
                            cfgAdjSum += cfgVal;
                            cfgAdjSumSq += cfgVal * cfgVal;
                        }
                    }
                    const posVarSum = posSumSq - posSum * posSum / targetLen;
                    const cfgAdjVarSum = cfgAdjSumSq - cfgAdjSum * cfgAdjSum / targetLen;

                    // 长片段时 pass 之间 yield 一次，避免单步内 2 次 totalFrames*MEL_DIM
                    // 循环累积阻塞主线程（2000 frames × 128 = 256k 迭代/pass）
                    if (totalFrames > 256) {
                        await new Promise(r => setImmediate(r));
                    }

                    // Pass 2: compute std/rescale + apply rescale + update xt
                    // 对齐官方 torch.std (unbiased, correction=1, 除以 N-1)。
                    // 分母加 1e-8 防止早期 step (xt=纯噪声, flow≈0) 时 cfgAdjStd→0 导致 rescale 爆炸。
                    // 官方 PyTorch 的 torch.std() 在 std=0 时返回 0, 后续 0/0=nan 会被 PyTorch
                    // 的 autograd 吸收; JS 的 x/0=Infinity 会直接传播导致 xt 溢出。
                    const posStd = Math.sqrt(posVarSum / Math.max(1, targetLen - 1));
                    const cfgAdjStd = Math.sqrt(cfgAdjVarSum / Math.max(1, targetLen - 1));
                    const rescale = posStd / (cfgAdjStd + 1e-8);

                    for (let f = 0; f < totalFrames; f++) {
                        for (let d = 0; d < MEL_DIM; d++) {
                            const cfgVal = cfgPredBuf[f * MEL_DIM + d];
                            const rescaledVal = cfgRescale * (cfgVal * rescale) + (1 - cfgRescale) * cfgVal;
                            xt.data[f * MEL_DIM + d] += rescaledVal * dt;
                        }
                    }
                } else {
                    for (let f = 0; f < totalFrames; f++) {
                        const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                        for (let d = 0; d < MEL_DIM; d++) {
                            xt.data[f * MEL_DIM + d] += predData[tgtOffset + d] * dt;
                        }
                    }
                }

                const currentProgress = progressStart + (step + 1) * progressPerStep;
                onProgress(Math.min(Math.round(currentProgress), 90));
                // GPU 排空：每 8 步用 setTimeout(20) 代替 setImmediate，给 DML 后端 20ms 时间
                // 回收内部 GPU 资源池中的 transformer 注意力中间张量。
                // 旧版 setImmediate(~1ms) 太短，DML 来不及回收，64 次连续推理后累积导致 887A0005。
                // 每 8 步一次（共 4 次/32 步）增加总合成时间约 80ms，可接受。
                if (step % 8 === 7) {
                    await new Promise(r => setTimeout(r, 20));
                } else if (step % 4 === 3) {
                    await new Promise(r => setImmediate(r));
                }
            }
        } finally {
            // 循环结束：释放预构建的 cond/mask 张量
            disposeTensor(condTensorCached);
            disposeTensor(condMaskTensorCached);
            disposeTensor(uncondCondTensorCached);
            disposeTensor(uncondMaskTensorCached);
        }
    }

    /**
     * Generate random Gaussian noise
     */
    randomNoise(frameLen, melDim) {
        const data = new Float32Array(frameLen * melDim);
        for (let i = 0; i < data.length; i += 2) {
            const u1 = Math.random();
            const u2 = Math.random();
            const r = Math.sqrt(-2.0 * Math.log(u1 + 1e-10));
            const theta = 2.0 * Math.PI * u2;
            data[i] = r * Math.cos(theta);
            if (i + 1 < data.length) {
                data[i + 1] = r * Math.sin(theta);
            }
        }
        return { data, dims: [1, frameLen, melDim] };
    }
}

module.exports = { Diffusion };
