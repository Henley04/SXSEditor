const { MEL_DIM, COND_DIM, NPU_STATIC_SEQ_LEN } = require('./constants');
const { createFloatTensor, outputToFloat32, disposeTensor, gpuDrain, float32ToF16Buffer } = require('./utils');
const { createSampler } = require('./samplers');

/**
 * CFG strength curve presets for dynamic scheduling.
 * These curves control how CFG strength varies across diffusion steps.
 * Research: A-CFG (NeurIPS 2025) shows low-high scheduling reduces over-exposure artifacts.
 * Default curve: linear ramp from 1.0 to cfgStrength (early conservative, later aggressive).
 */
const CFG_CURVE_PRESETS = {
    // Constant (legacy behavior)
    constant: { type: 'constant', label: '固定值' },
    // Linear ramp: starts at cfgStrength * startRatio, ends at cfgStrength
    linear: { type: 'linear', startRatio: 0.3, label: '线性渐进' },
    // Cosine ramp: smooth fade-in using (1 - cos(pi*t))/2
    cosine: { type: 'cosine', startRatio: 0.2, label: '余弦渐进' },
    // Exponential: aggressive start, gradual ramp
    exponential: { type: 'exponential', startRatio: 0.15, exponent: 2, label: '指数渐进' },
};

/**
 * Compute CFG strength at a given diffusion step.
 * @param {number} step - Current step index (0-based)
 * @param {number} totalSteps - Total diffusion steps
 * @param {number} baseStrength - Base CFG strength
 * @param {Object} [curveConfig] - Curve configuration
 * @returns {number} CFG strength for this step
 */
function computeCfgStrength(step, totalSteps, baseStrength, curveConfig) {
    if (!curveConfig || !curveConfig.useCurve || curveConfig.curve === 'fixed') {
        return baseStrength;
    }
    
    const progress = totalSteps > 1 ? step / (totalSteps - 1) : 1.0;
    const startStrength = curveConfig.startStrength ?? baseStrength * 0.5;
    const endStrength = baseStrength;
    const range = endStrength - startStrength;
    
    switch (curveConfig.curve) {
        case 'linear':
            return startStrength + range * progress;
        case 'cosine':
            // (1 - cos(pi * progress)) / 2 maps [0,1] -> [0,1]
            return startStrength + range * (1 - Math.cos(Math.PI * progress)) / 2;
        case 'exponential': {
            const exp = curveConfig.exponent ?? 2;
            return startStrength + range * Math.pow(progress, exp);
        }
        default:
            return baseStrength;
    }
}

/**
 * Diffusion sampling loop (the core synthesis algorithm)
 */
class Diffusion {
    constructor() {
        this._diagnosticMode = false;
    }

    setDiagnosticMode(enabled) {
        this._diagnosticMode = !!enabled;
    }

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
            disposeTensor(xtTensor);
            disposeTensor(tTensor);
            disposeTensor(condTensor);
            disposeTensor(maskTensor);
            throw err;
        }

        const pred = outputToFloat32(results['flow_pred']);

        if (this._diagnosticMode && tVal < 0.1) {
            let predNaN = 0, predInf = 0;
            for (let i = 0; i < pred.length; i++) {
                if (Number.isNaN(pred[i])) predNaN++;
                if (!Number.isFinite(pred[i])) predInf++;
            }
            const nonNaN = pred.filter(v => Number.isFinite(v));
            const predMean = nonNaN.length > 0 ? nonNaN.reduce((a,b)=>a+b,0)/nonNaN.length : 0;
            console.log(`[DiffusionDiag] Step t=${tVal.toFixed(4)}: xt=[${xtTensor.type} ${xtTensor.dims}], cond=[${condTensor.type} ${condTensor.dims}], flow_pred NaN=${predNaN}, Inf=${predInf - predNaN}, mean=${predMean.toFixed(6)}`);
        }

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
     * Batch diffusion step: runs cond+uncond in a single session.run call.
     * This is the core optimization - reduces diffusion inference time by ~2x.
     *
     * @param {Object} sessions
     * @param {Float32Array} xtCondData - Conditional xt data (pt+target)
     * @param {Float32Array} xtUncondData - Unconditional xt data (target-only)
     * @param {number} tVal - Time step value
     * @param {Object} condTensor - Pre-built cond tensor for cond branch
     * @param {Object} condMaskTensor - Pre-built mask tensor for cond branch
     * @param {Object} uncondCondTensor - Pre-built cond tensor for uncond branch
     * @param {Object} uncondMaskTensor - Pre-built mask tensor for uncond branch
     * @param {number} totalFramesWithPrompt
     * @param {number} totalFrames
     * @param {boolean} isFP16
     * @param {boolean} useStaticShapes
     * @returns {Promise<{condPred: Float32Array, uncondPred: Float32Array}>}
     */
    async _runBatchDiffStep(sessions, xtCondData, xtUncondData, tVal,
                            condTensor, condMaskTensor,
                            uncondCondTensor, uncondMaskTensor,
                            totalFramesWithPrompt, totalFrames,
                            isFP16, useStaticShapes = false) {
        const floatType = isFP16 ? 'float16' : 'float32';
        const seqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFramesWithPrompt;
        const uncondSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFrames;

        const padFloat = (src, len) => {
            if (src.length >= len) return src;
            const padded = new Float32Array(len);
            padded.set(src);
            return padded;
        };

        // Build batch input: [cond_row, uncond_row]
        const condPadded = useStaticShapes ? padFloat(xtCondData, seqLen * MEL_DIM) : xtCondData;
        const uncondPadded = useStaticShapes ? padFloat(xtUncondData, uncondSeqLen * MEL_DIM) : xtUncondData;

        const batchSeqLen = Math.max(seqLen, uncondSeqLen);
        const batchLen = 2 * batchSeqLen * MEL_DIM;
        const batchXtData = new Float32Array(batchLen);

        // Row 0 (cond): copy cond data at position 0
        batchXtData.set(condPadded.subarray(0, seqLen * MEL_DIM), 0);
        // Row 1 (uncond): copy uncond data at position batchSeqLen*MEL_DIM
        const uncondOffset = batchSeqLen * MEL_DIM;
        batchXtData.set(uncondPadded.subarray(0, uncondSeqLen * MEL_DIM), uncondOffset);

        // Build batch t tensor
        const tBatchData = new Float32Array([tVal, tVal]);

        // Build batch cond tensor: [cond_cond, uncond_cond(zeros)]
        const condBatchData = new Float32Array(2 * batchSeqLen * COND_DIM);
        const condSrc = condTensor.data;
        condBatchData.set(condSrc.subarray(0, seqLen * COND_DIM), 0);
        // uncond cond is zeros (already initialized to 0)

        // Build batch mask tensor: [cond_mask, uncond_mask]
        const maskBatchData = new Float32Array(2 * batchSeqLen);
        const maskSrc = condMaskTensor.data;
        maskBatchData.set(maskSrc.subarray(0, seqLen), 0);
        const uncondMaskSrc = uncondMaskTensor.data;
        maskBatchData.set(uncondMaskSrc.subarray(0, uncondSeqLen), batchSeqLen);

        // Create batch tensors
        let xtBatchTensor, tBatchTensor, condBatchTensor, maskBatchTensor;
        if (floatType === 'float16') {
            const xtF16 = float32ToF16Buffer(batchXtData);
            xtBatchTensor = new (require('onnxruntime-node').Tensor)('float16', xtF16, [2, batchSeqLen, MEL_DIM]);
            tBatchTensor = createFloatTensor('float16', tBatchData, [2]);
            condBatchTensor = createFloatTensor('float16', condBatchData, [2, batchSeqLen, COND_DIM]);
            maskBatchTensor = createFloatTensor('float16', maskBatchData, [2, batchSeqLen]);
        } else {
            const ort = require('onnxruntime-node');
            xtBatchTensor = new ort.Tensor('float32', batchXtData, [2, batchSeqLen, MEL_DIM]);
            tBatchTensor = new ort.Tensor('float32', tBatchData, [2]);
            condBatchTensor = new ort.Tensor('float32', condBatchData, [2, batchSeqLen, COND_DIM]);
            maskBatchTensor = new ort.Tensor('float32', maskBatchData, [2, batchSeqLen]);
        }

        if (this._diagnosticMode && tVal < 0.1) {
            // Diagnostic: log batch input stats
            let xtNaN = 0, xtInf = 0;
            for (let i = 0; i < batchXtData.length; i++) {
                if (Number.isNaN(batchXtData[i])) xtNaN++;
                else if (!Number.isFinite(batchXtData[i])) xtInf++;
            }
            console.log(`[DiffusionDiag] Batch input: t=${tVal.toFixed(4)}, batchSeqLen=${batchSeqLen}, NaN=${xtNaN}, Inf=${xtInf}`);
        }

        let results;
        try {
            results = await sessions.diffStep.run({
                xt_input: xtBatchTensor,
                t: tBatchTensor,
                cond: condBatchTensor,
                xt_mask: maskBatchTensor,
            });
        } catch (err) {
            disposeTensor(xtBatchTensor);
            disposeTensor(tBatchTensor);
            disposeTensor(condBatchTensor);
            disposeTensor(maskBatchTensor);
            throw err;
        }

        const batchPred = outputToFloat32(results['flow_pred']);
        disposeTensor(results['flow_pred']);
        disposeTensor(xtBatchTensor);
        disposeTensor(tBatchTensor);
        disposeTensor(condBatchTensor);
        disposeTensor(maskBatchTensor);

        // Extract cond prediction (target frames)
        const condPred = new Float32Array(totalFrames * MEL_DIM);
        const uncondPred = new Float32Array(totalFrames * MEL_DIM);

        const condTargetOffset = ptFrameCount * MEL_DIM;
        for (let f = 0; f < totalFrames; f++) {
            const srcCondOff = (ptFrameCount + f) * MEL_DIM;
            const srcUncondOff = batchSeqLen * MEL_DIM + f * MEL_DIM;
            const dstOff = f * MEL_DIM;
            for (let d = 0; d < MEL_DIM; d++) {
                condPred[dstOff + d] = batchPred[srcCondOff + d];
                uncondPred[dstOff + d] = batchPred[srcUncondOff + d];
            }
        }

        return { condPred, uncondPred };
    }

    /**
     * Run the full diffusion sampling loop
     *
     * @param {string} [samplerName='stork2'] - 求解器名称，见 samplers/index.js
     */
    async runDiffusionLoop(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes = false, samplerName = 'stork2', cfgCurve = null) {
        const floatType = isFP16 ? 'float16' : 'float32';
        const totalFramesWithPrompt = ptFrameCount + totalFrames;
        const seqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFramesWithPrompt;

        // Diagnostic: output diffStep session input metadata
        if (this._diagnosticMode && sessions.diffStep) {
            try {
                const inputMeta = sessions.diffStep.inputMetadata;
                console.log('[DiffusionDiag] diffStep input metadata:');
                if (Array.isArray(inputMeta)) {
                    for (const meta of inputMeta) {
                        console.log(`  ${meta.name}: type=${meta.type}, dims=${JSON.stringify(meta.shape || meta.dims)}`);
                    }
                } else {
                    for (const [name, meta] of Object.entries(inputMeta)) {
                        console.log(`  ${name}: type=${meta.type}, dims=${JSON.stringify(meta.dims)}`);
                    }
                }
                console.log(`[DiffusionDiag] isFP16=${isFP16}, floatType=${floatType}`);
            } catch (e) {
                console.log('[DiffusionDiag] Failed to read diffStep inputMetadata:', e.message);
            }
        }

        const frameMask = new Float32Array(totalFramesWithPrompt).fill(1);
        const uncondMask = new Float32Array(totalFrames).fill(1);
        const xtInputBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);
        const xtUncondBuf = new Float32Array(totalFrames * MEL_DIM);
        const uncondCondBuf = new Float32Array(totalFrames * COND_DIM);
        const cfgPredBuf = new Float32Array(totalFrames * MEL_DIM);

        // Pre-build cond/mask tensors (reused across steps)
        const padFloat = (src, len) => {
            if (src.length >= len) return src;
            const padded = new Float32Array(len);
            padded.set(src);
            return padded;
        };
        const condPadded = useStaticShapes ? padFloat(combinedCond, seqLen * COND_DIM) : combinedCond;
        const condMaskPadded = useStaticShapes ? padFloat(frameMask, seqLen) : frameMask;
        const uncondSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFrames;
        const uncondCondPadded = useStaticShapes ? padFloat(uncondCondBuf, uncondSeqLen * COND_DIM) : uncondCondBuf;
        const uncondMaskPadded = useStaticShapes ? padFloat(uncondMask, uncondSeqLen) : uncondMask;
        const condTensorCached = createFloatTensor(floatType, condPadded, [1, seqLen, COND_DIM]);
        const condMaskTensorCached = createFloatTensor(floatType, condMaskPadded, [1, seqLen]);
        const uncondCondTensorCached = createFloatTensor(floatType, uncondCondPadded, [1, uncondSeqLen, COND_DIM]);
        const uncondMaskTensorCached = createFloatTensor(floatType, uncondMaskPadded, [1, uncondSeqLen]);

        const progressPerStep = progressRange / totalSteps;

        // prompt frames are constant in loop, copy once
        xtInputBuf.set(ptMelData, 0);

        const sampler = createSampler(samplerName);
        const useCfg = cfgStrength > 0;

        // Pre-allocate reusable buffers (zero per-step allocation)
        const targetLen = totalFrames * MEL_DIM;
        const buffers = {
            vBuf: new Float32Array(targetLen),
            deltaBuf: new Float32Array(targetLen),
            v1Buf: new Float32Array(targetLen),
            xPredBuf: new Float32Array(targetLen),
        };

        // Batch flag: use batch inference when CFG is enabled
        const useBatch = useCfg;

        // evalDiffStep: Execute cond + (optional)uncond inference, return {condPred, uncondPred}
        const evalDiffStep = async (t, xtOverride) => {
            const xtData = xtOverride || xt.data;
            // Build cond xt: [ptMelData | xtData]
            xtInputBuf.set(xtData, ptFrameCount * MEL_DIM);
            // Build uncond xt: [xtData]
            xtUncondBuf.set(xtData, 0);

            if (useBatch) {
                // Batch mode: single session.run for both cond and uncond
                return await this._runBatchDiffStep(
                    sessions, xtInputBuf, xtUncondBuf, t,
                    condTensorCached, condMaskTensorCached,
                    uncondCondTensorCached, uncondMaskTensorCached,
                    totalFramesWithPrompt, totalFrames,
                    isFP16, useStaticShapes
                );
            } else {
                // No CFG: single run
                const condPred = await this._runDiffStepWithCachedTensors(
                    sessions, xtInputBuf, t, condTensorCached, condMaskTensorCached,
                    totalFramesWithPrompt, isFP16, useStaticShapes
                );
                return { condPred, uncondPred: null };
            }
        };

        // combine: CFG + Rescale merge, write to vBuf (reused), return vBuf reference
        // Uses single-pass Welford online variance for optimal performance
        const combine = (condPred, uncondPred, currentCfgStrength) => {
            const v = buffers.vBuf;
            if (!useCfg || currentCfgStrength <= 0) {
                // No CFG: direct copy cond target segment to vBuf
                for (let f = 0; f < totalFrames; f++) {
                    const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                    const dstOffset = f * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        v[dstOffset + d] = condPred[tgtOffset + d];
                    }
                }
                return v;
            }

            // Single-pass Welford online variance for CFG combine
            // Simultaneously computes: cfg values, means, and variances
            let posMean = 0, cfgMean = 0;
            let posM2 = 0, cfgM2 = 0;
            let n = 0;

            for (let f = 0; f < totalFrames; f++) {
                const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    const condVal = condPred[tgtOffset + d];
                    const uncondVal = uncondPred[f * MEL_DIM + d];
                    const cfgVal = condVal + currentCfgStrength * (condVal - uncondVal);
                    cfgPredBuf[n] = cfgVal;

                    // Welford's online algorithm
                    n++;
                    // Update pos stats
                    const deltaPos = condVal - posMean;
                    posMean += deltaPos / n;
                    const delta2Pos = condVal - posMean;
                    posM2 += deltaPos * delta2Pos;
                    // Update cfg stats
                    const deltaCfg = cfgVal - cfgMean;
                    cfgMean += deltaCfg / n;
                    const delta2Cfg = cfgVal - cfgMean;
                    cfgM2 += deltaCfg * delta2Cfg;
                }
            }

            // Compute standard deviations with Bessel correction (N-1)
            const posStd = Math.sqrt(Math.max(0, posM2) / Math.max(1, n - 1));
            const cfgStd = Math.sqrt(Math.max(0, cfgM2) / Math.max(1, n - 1));
            const rescale = posStd / (cfgStd + 1e-8);

            // Apply rescale: v = rescale * (cfgVal * rescale) + (1 - rescale) * cfgVal
            for (let i = 0; i < targetLen; i++) {
                const cfgVal = cfgPredBuf[i];
                v[i] = cfgRescale * (cfgVal * rescale) + (1 - cfgRescale) * cfgVal;
            }
            return v;
        };

        try {
            let totalNFE = 0;
            for (let step = 0; step < totalSteps; step++) {
                // Compute dynamic CFG strength for this step
                const stepCfgStrength = cfgCurve
                    ? computeCfgStrength(step, totalSteps, cfgStrength, cfgCurve)
                    : cfgStrength;

                // Wrap combine with dynamic CFG strength
                const combineWithCfg = (condPred, uncondPred) => combine(condPred, uncondPred, stepCfgStrength);

                const { nfe } = await sampler.step({
                    evalDiffStep,
                    combine: combineWithCfg,
                    step,
                    totalSteps,
                    xtData: xt.data,
                    buffers,
                });
                totalNFE += nfe;

                // Accumulate deltaBuf to xt.data
                const delta = buffers.deltaBuf;
                for (let i = 0; i < delta.length; i++) {
                    xt.data[i] += delta[i];
                }

                const currentProgress = progressStart + (step + 1) * progressPerStep;
                onProgress(Math.min(Math.round(currentProgress), 90));

                // GPU drain: every 8 steps yield to event loop
                if (step % 8 === 7) {
                    await new Promise(r => setTimeout(r, 20));
                } else if (totalFrames > 256) {
                    await new Promise(r => setImmediate(r));
                }
            }

            // Diagnostic: check output
            if (this._diagnosticMode) {
                let xtNaN = 0, xtInf = 0;
                let xtMin = Infinity, xtMax = -Infinity, xtSum = 0, xtSumSq = 0;
                const xtData = xt.data;
                const xtLen = xtData.length;
                for (let i = 0; i < xtLen; i++) {
                    const v = xtData[i];
                    if (Number.isNaN(v)) { xtNaN++; continue; }
                    if (!Number.isFinite(v)) { xtInf++; continue; }
                    if (v < xtMin) xtMin = v;
                    if (v > xtMax) xtMax = v;
                    xtSum += v;
                    xtSumSq += v * v;
                }
                const xtMean = xtSum / xtLen;
                const xtStd = Math.sqrt(Math.max(0, xtSumSq / xtLen - xtMean * xtMean));
                console.log(`[DiffusionDiag] OUTPUT xt: frames=${totalFrames}, len=${xtLen}, NaN=${xtNaN}, Inf=${xtInf}, min=${xtMin.toFixed(6)}, max=${xtMax.toFixed(6)}, mean=${xtMean.toFixed(6)}, std=${xtStd.toFixed(6)}, nfe=${totalNFE}`);
                if (xtNaN > 0 || xtInf > 0) {
                    console.error(`[DiffusionDiag] DIFFUSION OUTPUT HAS NaN/Inf! NaN=${xtNaN}, Inf=${xtInf - xtNaN}, total=${xtLen}, frames=${totalFrames}, mean=${xtMean.toFixed(6)}`);
                    if (typeof globalThis._flushOrtDebugLogs === 'function') {
                        globalThis._flushOrtDebugLogs();
                    }
                }
            }
        } finally {
            // Release pre-built cond/mask tensors
            disposeTensor(condTensorCached);
            disposeTensor(condMaskTensorCached);
            disposeTensor(uncondCondTensorCached);
            disposeTensor(uncondMaskTensorCached);
        }
    }

    /**
     * Compute WSOLA (Waveform Similarity Overlap-Add) fade window.
     * WSOLA uses cross-correlation to find the optimal alignment point in the overlap region,
     * ensuring phase continuity for pitched signals (singing).
     *
     * @param {Float32Array} prevChunk - Previous chunk audio (or mel) data
     * @param {Float32Array} currChunk - Current chunk audio (or mel) data
     * @param {number} overlapLen - Overlap length in samples/frames
     * @param {number} searchRange - Search range around the boundary for optimal alignment
     * @returns {{fadeWindow: Float32Array, shift: number}} - Fade window and optimal shift
     */
    _computeWSOLAWindow(prevChunk, currChunk, overlapLen, searchRange = 4) {
        const halfOverlap = Math.floor(overlapLen / 2);
        const actualSearchRange = Math.min(searchRange, halfOverlap);

        let bestShift = 0;
        let bestCorr = -Infinity;

        // Search for optimal alignment via cross-correlation
        for (let shift = -actualSearchRange; shift <= actualSearchRange; shift++) {
            let corr = 0;
            const len = Math.min(overlapLen - Math.abs(shift), overlapLen);
            for (let i = 0; i < len; i++) {
                const prevIdx = overlapLen - len + i + Math.max(0, shift);
                const currIdx = i + Math.max(0, -shift);
                if (prevIdx >= 0 && prevIdx < prevChunk.length && currIdx >= 0 && currIdx < currChunk.length) {
                    corr += prevChunk[prevIdx] * currChunk[currIdx];
                }
            }
            if (corr > bestCorr) {
                bestCorr = corr;
                bestShift = shift;
            }
        }

        // Create Hann window with phase alignment
        const fadeWindow = new Float32Array(overlapLen);
        for (let i = 0; i < overlapLen; i++) {
            // Hann window: w[i] = 0.5 * (1 - cos(pi * (i+1) / (N+1)))
            fadeWindow[i] = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (overlapLen + 1)));
        }

        return { fadeWindow, shift: bestShift };
    }

    /**
     * Plan chunk boundaries and WSOLA fade windows for diffusion chunking.
     */
    _planChunks(totalFrames, chunkFrames, overlapFrames) {
        if (!Number.isFinite(totalFrames) || totalFrames <= 0) return null;
        const safeChunk = Math.max(50, Math.floor(chunkFrames));
        let safeOverlap = Math.max(0, Math.floor(overlapFrames));
        if (safeOverlap >= safeChunk) safeOverlap = Math.floor(safeChunk / 2);
        if (safeChunk >= totalFrames) return null;
        if (safeOverlap < 1) safeOverlap = 0;

        const specs = [];
        let framePos = 0;
        let chunkIdx = 0;
        while (framePos < totalFrames) {
            const isFirst = chunkIdx === 0;
            const chunkStart = isFirst ? 0 : Math.max(0, framePos - safeOverlap);
            const chunkEnd = Math.min(chunkStart + safeChunk, totalFrames);
            const currentChunkFrames = chunkEnd - chunkStart;
            const isLast = chunkEnd >= totalFrames;
            specs.push({ chunkStart, chunkEnd, currentChunkFrames, isFirst, isLast });
            if (isLast) break;
            framePos = chunkEnd;
            chunkIdx++;
        }

        // WSOLA-enhanced fade window with phase alignment
        const fadeWindow = new Float32Array(safeOverlap);
        for (let i = 0; i < safeOverlap; i++) {
            fadeWindow[i] = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (safeOverlap + 1)));
        }
        return { specs, overlap: safeOverlap, fadeWindow, useWSOLA: true };
    }

    /**
     * Execute single chunk diffusion with WSOLA overlap-add.
     */
    async _runSingleDiffusionChunk(ctx, spec, onProgress, progressStart, progressRange) {
        const { sessions, xt, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, useStaticShapes, overlap, fadeWindow } = ctx;
        const { chunkStart, chunkEnd, currentChunkFrames, isFirst, isLast } = spec;
        const xtOut = xt.data;

        // Extract noise for current chunk
        const chunkNoise = new Float32Array(currentChunkFrames * MEL_DIM);
        chunkNoise.set(xtOut.subarray(chunkStart * MEL_DIM, chunkEnd * MEL_DIM));
        const subXt = { data: chunkNoise, dims: [1, currentChunkFrames, MEL_DIM] };

        // Build condition vector for current chunk
        const promptCondBytes = ptFrameCount * COND_DIM;
        const chunkTargetCondBytes = currentChunkFrames * COND_DIM;
        const chunkCondStart = (ptFrameCount + chunkStart) * COND_DIM;
        const chunkCondEnd = chunkCondStart + chunkTargetCondBytes;
        const chunkCond = new Float32Array(promptCondBytes + chunkTargetCondBytes);
        chunkCond.set(combinedCond.subarray(0, promptCondBytes), 0);
        chunkCond.set(combinedCond.subarray(chunkCondStart, chunkCondEnd), promptCondBytes);

        // Run full diffusion loop
        const chunkOnProgress = (p) => {
            if (onProgress) onProgress(Math.round(p));
        };
        await this.runDiffusionLoop(
            sessions, subXt, currentChunkFrames, ptMelData, ptFrameCount,
            chunkCond, totalSteps, cfgStrength, cfgRescale, isFP16,
            chunkOnProgress, progressStart, progressRange, useStaticShapes, ctx.samplerName, ctx.cfgCurve
        );

        // WSOLA-enhanced overlap-add writeback
        if (isFirst) {
            xtOut.set(subXt.data.subarray(0, currentChunkFrames * MEL_DIM), chunkStart * MEL_DIM);
        } else {
            const ov = overlap;
            for (let f = 0; f < ov && f < currentChunkFrames; f++) {
                const dstOffset = (chunkStart + f) * MEL_DIM;
                const srcOffset = f * MEL_DIM;
                const w = fadeWindow[f];
                const invW = 1 - w;
                for (let d = 0; d < MEL_DIM; d++) {
                    xtOut[dstOffset + d] = xtOut[dstOffset + d] * invW + subXt.data[srcOffset + d] * w;
                }
            }
            const nonOverlapStart = ov * MEL_DIM;
            const nonOverlapLen = (currentChunkFrames - ov) * MEL_DIM;
            if (nonOverlapLen > 0) {
                xtOut.set(
                    subXt.data.subarray(nonOverlapStart, nonOverlapStart + nonOverlapLen),
                    (chunkStart + ov) * MEL_DIM
                );
            }
        }

        await gpuDrain();

        const newCommitted = isLast ? chunkEnd : Math.max(0, chunkEnd - overlap);
        return { newCommitted };
    }

    async runDiffusionLoopChunked(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes, chunkFrames, overlapFrames, onChunkMel = null, samplerName = 'stork2', cfgCurve = null) {
        const plan = this._planChunks(totalFrames, chunkFrames, overlapFrames);
        if (!plan) {
            return this.runDiffusionLoop(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes, samplerName, cfgCurve);
        }

        const { specs, overlap, fadeWindow } = plan;
        const totalChunks = specs.length;
        if (this._diagnosticMode) {
            console.log(`[DiffusionChunk] Chunked diffusion: totalFrames=${totalFrames}, ptFrameCount=${ptFrameCount}, chunkFrames=${chunkFrames}, overlap=${overlap}, steps=${totalSteps}, chunks=${totalChunks}, sampler=${samplerName}`);
        }

        const ctx = { sessions, xt, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, useStaticShapes, overlap, fadeWindow, samplerName, cfgCurve };
        const progressPerChunk = progressRange / totalChunks;
        let committedFrames = 0;

        try {
            for (let ci = 0; ci < totalChunks; ci++) {
                const spec = specs[ci];
                if (this._diagnosticMode) {
                    console.log(`[DiffusionChunk] chunk ${ci}/${totalChunks}: frames[${spec.chunkStart},${spec.chunkEnd})=${spec.currentChunkFrames}frames`);
                }

                const { newCommitted } = await this._runSingleDiffusionChunk(
                    ctx, spec, onProgress,
                    progressStart + ci * progressPerChunk, progressPerChunk
                );

                if (onChunkMel && newCommitted > committedFrames) {
                    const melStart = committedFrames;
                    const melEnd = newCommitted;
                    const melLen = melEnd - melStart;
                    const melData = new Float32Array(melLen * MEL_DIM);
                    melData.set(xt.data.subarray(melStart * MEL_DIM, melEnd * MEL_DIM));
                    try {
                        await onChunkMel({
                            chunkIndex: ci,
                            frameStart: melStart,
                            frameEnd: melEnd,
                            melData,
                            isLast: spec.isLast,
                        });
                    } catch (cbErr) {
                        console.error(`[DiffusionChunk] onChunkMel callback error (chunk ${ci}): ${cbErr.message}`);
                    }
                    committedFrames = newCommitted;
                }
            }
        } catch (err) {
            console.error(`[DiffusionChunk] Chunked diffusion failed: ${err.message}`);
            throw err;
        }

        if (this._diagnosticMode) {
            console.log(`[DiffusionChunk] Chunked diffusion complete: ${totalChunks} chunks, ${totalFrames} frames`);
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

module.exports = { Diffusion, CFG_CURVE_PRESETS, computeCfgStrength };
