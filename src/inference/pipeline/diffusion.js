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

        // 诊断：检查第一个 step 的输出
        if (tVal < 0.1) {
            let predNaN = 0, predInf = 0;
            for (let i = 0; i < pred.length; i++) {
                if (Number.isNaN(pred[i])) predNaN++;
                if (!Number.isFinite(pred[i])) predInf++;
            }
            const nonNaN = pred.filter(v => Number.isFinite(v));
            const predMean = nonNaN.length > 0 ? nonNaN.reduce((a,b)=>a+b,0)/nonNaN.length : 0;
            console.log(`[DiffusionDiag] Step t=${tVal.toFixed(4)}: xt=[${xtTensor.type} ${xtTensor.dims}], cond=[${condTensor.type} ${condTensor.dims}], flow_pred NaN=${predNaN}, Inf=${predInf - predNaN}, mean=${predMean.toFixed(6)}`);
        }
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

        // 诊断第一步：输入数据统计
        if (tVal < 0.1) {
            let xtNaN = 0, xtInf = 0, xtMin = Infinity, xtMax = -Infinity;
            for (let i = 0; i < xtPadded.length; i++) {
                if (Number.isNaN(xtPadded[i])) { xtNaN++; continue; }
                if (!Number.isFinite(xtPadded[i])) { xtInf++; continue; }
                if (xtPadded[i] < xtMin) xtMin = xtPadded[i];
                if (xtPadded[i] > xtMax) xtMax = xtPadded[i];
            }
            console.log(`[DiffusionDiag] Input xt: t=${tVal.toFixed(4)}, len=${xtPadded.length}, NaN=${xtNaN}, Inf=${xtInf}, min=${xtMin.toFixed(6)}, max=${xtMax.toFixed(6)}`);
            
            // Check cond tensor data
            const condData = condTensor.data;
            let cNaN = 0, cInf = 0, cMin = Infinity, cMax = -Infinity;
            for (let i = 0; i < condData.length; i++) {
                if (Number.isNaN(condData[i])) { cNaN++; continue; }
                if (!Number.isFinite(condData[i])) { cInf++; continue; }
                if (condData[i] < cMin) cMin = condData[i];
                if (condData[i] > cMax) cMax = condData[i];
            }
            console.log(`[DiffusionDiag] Input cond: len=${condData.length}, NaN=${cNaN}, Inf=${cInf}, min=${cMin.toFixed(6)}, max=${cMax.toFixed(6)}`);
        }

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
        const seqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFramesWithPrompt;

        // 诊断：输出 diffStep session 的输入元数据
        if (sessions.diffStep) {
            try {
                const inputMeta = sessions.diffStep.inputMetadata;
                console.log('[DiffusionDiag] diffStep input metadata:');
                for (const [name, meta] of Object.entries(inputMeta)) {
                    console.log(`  ${name}: type=${meta.type}, dims=${JSON.stringify(meta.dims)}`);
                }
            } catch (e) {
                console.log('[DiffusionDiag] Failed to read diffStep inputMetadata:', e.message);
            }
        }
        // 条件分支 mask：所有帧均有效（含 prompt）
        const frameMask = new Float32Array(totalFramesWithPrompt).fill(1);
        // 非条件分支（target-only，对齐官方 PyTorch reverse_diffusion）：
        // uncond 使用 target-only 序列（长度 = totalFrames，无 prompt 段），
        // cond 为 target-only zeros，mask 为 target-only x_mask（全 1）。
        // 官方：uncond_flow_pred = diff_estimator(xt, t, zeros_like(cond)[:, :xt.shape[1], :], x_mask)
        const uncondMask = new Float32Array(totalFrames).fill(1);
        const xtInputBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);
        // uncond 输入：target-only 序列（无 prompt 段），直接从 0 开始填 xt
        const xtUncondBuf = new Float32Array(totalFrames * MEL_DIM);
        // 非条件 cond：target-only 全零
        const uncondCondBuf = new Float32Array(totalFrames * COND_DIM);
        const cfgPredBuf = new Float32Array(totalFrames * MEL_DIM);

        // 预构建 cond/mask 张量（跨步不变，循环外构建一次，与 WebNN 路径对齐）
        const padFloat = (src, len) => {
            if (src.length >= len) return src;
            const padded = new Float32Array(len);
            padded.set(src);
            return padded;
        };
        const condPadded = useStaticShapes ? padFloat(combinedCond, seqLen * COND_DIM) : combinedCond;
        const condMaskPadded = useStaticShapes ? padFloat(frameMask, seqLen) : frameMask;
        // uncond 张量维度：target-only（useStaticShapes 时填充到 NPU_STATIC_SEQ_LEN）
        const uncondSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFrames;
        const uncondCondPadded = useStaticShapes ? padFloat(uncondCondBuf, uncondSeqLen * COND_DIM) : uncondCondBuf;
        const uncondMaskPadded = useStaticShapes ? padFloat(uncondMask, uncondSeqLen) : uncondMask;
        const condTensorCached = createFloatTensor(floatType, condPadded, [1, seqLen, COND_DIM]);
        const condMaskTensorCached = createFloatTensor(floatType, condMaskPadded, [1, seqLen]);
        const uncondCondTensorCached = createFloatTensor(floatType, uncondCondPadded, [1, uncondSeqLen, COND_DIM]);
        const uncondMaskTensorCached = createFloatTensor(floatType, uncondMaskPadded, [1, uncondSeqLen]);

        const dt = 1.0 / totalSteps;
        const progressPerStep = progressRange / totalSteps;

        // prompt frames在循环中不变，预先拷贝一次
        xtInputBuf.set(ptMelData, 0);

        try {
            for (let step = 0; step < totalSteps; step++) {
                const tVal = (step + 0.5) / totalSteps;

                xtInputBuf.set(xt.data, ptFrameCount * MEL_DIM);

                const predData = await this._runDiffStepWithCachedTensors(sessions, xtInputBuf, tVal, condTensorCached, condMaskTensorCached, totalFramesWithPrompt, isFP16, useStaticShapes);

                if (cfgStrength > 0) {
                    // 构造 uncond 输入：target-only 序列，直接从 0 开始填 xt
                    xtUncondBuf.set(xt.data, 0);

                    const uncondPred = await this._runDiffStepWithCachedTensors(sessions, xtUncondBuf, tVal, uncondCondTensorCached, uncondMaskTensorCached, totalFrames, isFP16, useStaticShapes);

                    const targetLen = totalFrames * MEL_DIM;
                    // Pass 1 (merged): compute CFG pred + write cfgPredBuf + accumulate
                    // sums AND sum-of-squares for variance in a single pass.
                    // Var(X) = E[X²] - E[X]²  →  sum((x-μ)²) = sumSq - sum²/n
                    let posSum = 0;
                    let cfgAdjSum = 0;
                    let posSumSq = 0;
                    let cfgAdjSumSq = 0;
                    for (let f = 0; f < totalFrames; f++) {
                        const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                        for (let d = 0; d < MEL_DIM; d++) {
                            const condVal = predData[tgtOffset + d];
                            const uncondVal = uncondPred[f * MEL_DIM + d];
                            posSum += condVal;
                            posSumSq += condVal * condVal;
                            const cfgVal = condVal + cfgStrength * (condVal - uncondVal);
                            cfgPredBuf[f * MEL_DIM + d] = cfgVal;
                            cfgAdjSum += cfgVal;
                            cfgAdjSumSq += cfgVal * cfgVal;
                        }
                    }
                    const posMean = posSum / targetLen;
                    const cfgAdjMean = cfgAdjSum / targetLen;
                    const posVarSum = posSumSq - posSum * posSum / targetLen;
                    const cfgAdjVarSum = cfgAdjSumSq - cfgAdjSum * cfgAdjSum / targetLen;

                    // 长片段时 pass 之间 yield 一次，避免单步内 2 次 totalFrames*MEL_DIM
                    // 循环累积阻塞主线程（2000 frames × 128 = 256k 迭代/pass）
                    if (totalFrames > 256) {
                        await new Promise(r => setImmediate(r));
                    }

                    // Pass 2: compute std/rescale + apply rescale + update xt
                    // Bessel 校正（N-1 分母），对齐 PyTorch torch.std() 默认行为
                    const posStd = Math.sqrt(posVarSum / (targetLen - 1) + 1e-8);
                    const cfgAdjStd = Math.sqrt(cfgAdjVarSum / (targetLen - 1) + 1e-8);
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
            // 诊断：检测扩散输出是否包含 NaN/Inf
            {
                let xtNaN = 0, xtInf = 0;
                const xtData = xt.data;
                for (let i = 0; i < xtData.length; i++) {
                    if (Number.isNaN(xtData[i])) xtNaN++;
                    if (!Number.isFinite(xtData[i])) xtInf++;
                }
                if (xtNaN > 0 || xtInf > 0) {
                    console.error(`[DiffusionDiag] DIFFUSION OUTPUT HAS NaN/Inf! NaN=${xtNaN}, Inf=${xtInf - xtNaN}, total=${xtData.length}, frames=${totalFrames}, mean=${(xtData.reduce((a,b)=>a+b,0)/xtData.length).toFixed(6)}`);

                    // Dump ORT native debug logs from stderr capture
                    if (typeof globalThis._flushOrtDebugLogs === 'function') {
                        globalThis._flushOrtDebugLogs();
                    }
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
