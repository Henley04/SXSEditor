const { MEL_DIM, COND_DIM } = require('./constants');
const { createFloatTensor, outputToFloat32 } = require('./utils');

const NPU_STATIC_SEQ_LEN = 2048;

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
        const frameMask = new Float32Array(totalFramesWithPrompt).fill(1);
        const targetMask = new Float32Array(totalFrames).fill(1);

        const xtInputBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);
        const xtTargetBuf = new Float32Array(totalFrames * MEL_DIM);
        const uncondCondBuf = new Float32Array(totalFrames * COND_DIM);
        const cfgPredBuf = new Float32Array(totalFrames * MEL_DIM);

        const dt = 1.0 / totalSteps;
        const progressPerStep = progressRange / totalSteps;

        // prompt frames在循环中不变，预先拷贝一次
        xtInputBuf.set(ptMelData instanceof Float32Array ? ptMelData : new Float32Array(ptMelData), 0);

        for (let step = 0; step < totalSteps; step++) {
            const tVal = (step + 0.5) / totalSteps;

            xtInputBuf.set(xt.data instanceof Float32Array ? xt.data : new Float32Array(xt.data), ptFrameCount * MEL_DIM);

            const predData = await this.runDiffStep(sessions, xtInputBuf, tVal, combinedCond, frameMask, totalFramesWithPrompt, isFP16, useStaticShapes);

            if (cfgStrength > 0) {
                for (let i = 0; i < totalFrames * MEL_DIM; i++) {
                    xtTargetBuf[i] = xt.data[i];
                }

                const uncondPred = await this.runDiffStep(sessions, xtTargetBuf, tVal, uncondCondBuf, targetMask, totalFrames, isFP16, useStaticShapes);

                const targetLen = totalFrames * MEL_DIM;
                // Single pass: compute conditional mean, CFG prediction, and CFG mean
                let posSum = 0;
                let cfgAdjSum = 0;
                for (let f = 0; f < totalFrames; f++) {
                    const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        const condVal = predData[tgtOffset + d];
                        const uncondVal = uncondPred[f * MEL_DIM + d];
                        posSum += condVal;
                        const cfgVal = condVal + cfgStrength * (condVal - uncondVal);
                        cfgPredBuf[f * MEL_DIM + d] = cfgVal;
                        cfgAdjSum += cfgVal;
                    }
                }
                const posMean = posSum / targetLen;
                const cfgAdjMean = cfgAdjSum / targetLen;

                // Second pass: compute variances
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

                // Third pass: apply rescaled CFG
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
            await new Promise(r => setTimeout(r, 0));
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
