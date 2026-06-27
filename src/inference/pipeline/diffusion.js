const { MEL_DIM, COND_DIM, NPU_STATIC_SEQ_LEN } = require('./constants');
const { createFloatTensor, outputToFloat32 } = require('./utils');

/**
 * Diffusion sampling loop (the core synthesis algorithm)
 */
class Diffusion {
    /**
     * Run a single diffusion step
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

        const results = await sessions.diffStep.run({
            xt_input: xtTensor,
            t: tTensor,
            cond: condTensor,
            xt_mask: maskTensor,
        });

        const pred = outputToFloat32(results['flow_pred']);
        if (useStaticShapes) {
            return pred.subarray(0, totalFramesWithPrompt * MEL_DIM);
        }
        return pred;
    }

    /**
     * Run the full diffusion sampling loop
     */
    async runDiffusionLoop(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes = false) {
        const totalFramesWithPrompt = ptFrameCount + totalFrames;
        // 条件分支 mask：所有帧均有效（含 prompt）
        const frameMask = new Float32Array(totalFramesWithPrompt).fill(1);
        // 非条件分支 mask：prompt 段为 0，target 段为 1。
        // 关键：uncond 推理 seq_len 必须与 cond 一致（=totalFramesWithPrompt），
        // 否则基于 Transformer 的 diff_step 会对同一目标帧产生不同位置编码，
        // 导致 DML 与 WebNN 路径输出系统性偏差。
        const uncondMask = new Float32Array(totalFramesWithPrompt);
        uncondMask.fill(0, 0, ptFrameCount);
        uncondMask.fill(1, ptFrameCount, totalFramesWithPrompt);

        const xtInputBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);
        // uncond 输入：prompt 段为 0，target 段为 xt（与 cond 共享 seq_len 与位置编码）
        const xtUncondBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);
        // 非条件 cond：全零（与 WebNN 路径一致）
        const uncondCondBuf = new Float32Array(totalFramesWithPrompt * COND_DIM);
        const cfgPredBuf = new Float32Array(totalFrames * MEL_DIM);

        const dt = 1.0 / totalSteps;
        const progressPerStep = progressRange / totalSteps;

        // prompt frames在循环中不变，预先拷贝一次
        xtInputBuf.set(ptMelData, 0);

        for (let step = 0; step < totalSteps; step++) {
            const tVal = (step + 0.5) / totalSteps;

            xtInputBuf.set(xt.data, ptFrameCount * MEL_DIM);

            const predData = await this.runDiffStep(sessions, xtInputBuf, tVal, combinedCond, frameMask, totalFramesWithPrompt, isFP16, useStaticShapes);

            if (cfgStrength > 0) {
                // 构造 uncond 输入：prompt 段保持 0，target 段填入当前 xt
                xtUncondBuf.set(xt.data, ptFrameCount * MEL_DIM);

                const uncondPred = await this.runDiffStep(sessions, xtUncondBuf, tVal, uncondCondBuf, uncondMask, totalFramesWithPrompt, isFP16, useStaticShapes);

                const targetLen = totalFrames * MEL_DIM;
                // Pass 1: 计算 cond/uncond 均值 + CFG 预测 + 写 cfgPredBuf
                let posSum = 0;
                let cfgAdjSum = 0;
                for (let f = 0; f < totalFrames; f++) {
                    const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        const condVal = predData[tgtOffset + d];
                        const uncondVal = uncondPred[tgtOffset + d];
                        posSum += condVal;
                        const cfgVal = condVal + cfgStrength * (condVal - uncondVal);
                        cfgPredBuf[f * MEL_DIM + d] = cfgVal;
                        cfgAdjSum += cfgVal;
                    }
                }
                const posMean = posSum / targetLen;
                const cfgAdjMean = cfgAdjSum / targetLen;

                // Pass 2: 计算方差 + 应用 rescale + 更新 xt（与 WebNN 路径一致合并）
                let posVarSum = 0;
                let cfgAdjVarSum = 0;
                for (let f = 0; f < totalFrames; f++) {
                    const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        const condVal = predData[tgtOffset + d];
                        const diff1 = condVal - posMean;
                        posVarSum += diff1 * diff1;
                        const cfgVal = cfgPredBuf[f * MEL_DIM + d];
                        const diff2 = cfgVal - cfgAdjMean;
                        cfgAdjVarSum += diff2 * diff2;
                    }
                }
                const posStd = Math.sqrt(posVarSum / targetLen + 1e-8);
                const cfgAdjStd = Math.sqrt(cfgAdjVarSum / targetLen + 1e-8);
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
            // 降低 yield 频率：每 4 步 yield 一次，减少 setTimeout 累计开销
            // setImmediate 比 setTimeout(0) 快约 4 倍（Windows ~1ms vs ~4ms）
            if (step % 4 === 3) {
                await new Promise(r => setImmediate(r));
            }
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
