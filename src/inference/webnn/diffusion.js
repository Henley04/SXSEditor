/**
 * WebNN 推理模块 — 扩散采样循环
 */

import { MEL_DIM, COND_DIM } from './constants.js';
import { getOrt } from './ortSetup.js';
import { runSession } from './sessionManager.js';
import { createFloatTensor, outputToFloat32, float32ToFloat16, batchFloat32ToFloat16, gaussianRandom } from './utils.js';

/**
 * 单片段扩散采样循环
 * @param {Object} params
 * @returns {{ xtData: Float32Array, totalFrames: number, diffTotalMs: number, diffInferTotal: number }}
 */
export async function runDiffusionLoop({
    combinedCond,
    totalFrames,
    totalFramesWithPrompt,
    ptFrameCount,
    ptMelData,
    totalSteps,
    cfgStrength,
    cfgRescale,
    floatType,
    npuDiffBatchSize = 4,
}) {
    const ort = getOrt();

    const diffBatch = cfgStrength > 0 ? Math.max(2, npuDiffBatchSize) : 1;

    // Initialize xt with random noise
    const xt = { data: new Float32Array(totalFrames * MEL_DIM) };
    for (let i = 0; i < xt.data.length; i++) {
        xt.data[i] = Math.sqrt(1.0) * gaussianRandom();
    }

    const frameMask = new Float32Array(totalFramesWithPrompt).fill(1);
    const xtInputBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);
    const cfgPredBuf = new Float32Array(totalFrames * MEL_DIM);
    const dt = 1.0 / totalSteps;

    // prompt frames don't change, copy once
    if (ptMelData) {
        for (let f = 0; f < ptFrameCount; f++) {
            for (let d = 0; d < MEL_DIM; d++) {
                xtInputBuf[f * MEL_DIM + d] = ptMelData[f * MEL_DIM + d];
            }
        }
    }

    // Pre-create CONSTANT tensors once (these don't change between diffusion steps)
    const condTensorConst = createFloatTensor(floatType, combinedCond, [1, totalFramesWithPrompt, COND_DIM]);
    const frameMaskTensorConst = createFloatTensor(floatType, frameMask, [1, totalFramesWithPrompt]);

    // CFG batch: merge conditional + unconditional into one inference call
    // When diffBatch > 2, duplicate rows to fill batch for better NPU utilization
    const cfgBatchBuf = new Float32Array(diffBatch * totalFramesWithPrompt * MEL_DIM);
    const cfgCondBuf = new Float32Array(diffBatch * totalFramesWithPrompt * COND_DIM);
    const cfgMaskBuf = new Float32Array(diffBatch * totalFramesWithPrompt);
    // Rows 0,2,4,... mask = all ones (conditional)
    // Rows 1,3,5,... mask = zeros for prompt, ones for target (unconditional)
    for (let r = 0; r < diffBatch; r++) {
        const rowOff = r * totalFramesWithPrompt;
        if (r % 2 === 0) {
            // conditional: all ones
            cfgMaskBuf.fill(1, rowOff, rowOff + totalFramesWithPrompt);
        } else {
            // unconditional: zeros for prompt, ones for target
            cfgMaskBuf.fill(1, rowOff + ptFrameCount, rowOff + totalFramesWithPrompt);
        }
    }
    // Cond rows: even rows = combinedCond, odd rows = zeros (unconditional)
    for (let r = 0; r < diffBatch; r += 2) {
        cfgCondBuf.set(combinedCond, r * totalFramesWithPrompt * COND_DIM);
    }

    let cfgXtTensor, cfgTTensor, cfgCondTensor, cfgMaskTensor;
    let cfgTBuf;
    if (floatType === 'float16') {
        cfgXtTensor = new ort.Tensor('float16', new Uint16Array(diffBatch * totalFramesWithPrompt * MEL_DIM), [diffBatch, totalFramesWithPrompt, MEL_DIM]);
        cfgTBuf = new Uint16Array(diffBatch);
        cfgTTensor = new ort.Tensor('float16', cfgTBuf, [diffBatch]);
        cfgCondTensor = createFloatTensor(floatType, cfgCondBuf, [diffBatch, totalFramesWithPrompt, COND_DIM]);
        cfgMaskTensor = createFloatTensor(floatType, cfgMaskBuf, [diffBatch, totalFramesWithPrompt]);
    } else {
        cfgXtTensor = new ort.Tensor('float32', cfgBatchBuf, [diffBatch, totalFramesWithPrompt, MEL_DIM]);
        cfgTBuf = new Float32Array(diffBatch);
        cfgTTensor = new ort.Tensor('float32', cfgTBuf, [diffBatch]);
        cfgCondTensor = createFloatTensor(floatType, cfgCondBuf, [diffBatch, totalFramesWithPrompt, COND_DIM]);
        cfgMaskTensor = createFloatTensor(floatType, cfgMaskBuf, [diffBatch, totalFramesWithPrompt]);
    }

    // Pre-allocate for no-CFG path
    let xtInputTensor, tTensorBuf, tTensor;
    if (floatType === 'float16') {
        xtInputTensor = new ort.Tensor('float16', new Uint16Array(totalFramesWithPrompt * MEL_DIM), [1, totalFramesWithPrompt, MEL_DIM]);
        tTensorBuf = new Uint16Array(1);
        tTensor = new ort.Tensor('float16', tTensorBuf, [1]);
    } else {
        xtInputTensor = new ort.Tensor('float32', xtInputBuf, [1, totalFramesWithPrompt, MEL_DIM]);
        tTensorBuf = new Float32Array(1);
        tTensor = new ort.Tensor('float32', tTensorBuf, [1]);
    }

    // Diffusion step timing stats
    let diffInferMin = Infinity, diffInferMax = 0, diffInferTotal = 0;
    let diffPrepMin = Infinity, diffPrepMax = 0, diffPrepTotal = 0;
    let diffCfgMin = Infinity, diffCfgMax = 0, diffCfgTotal = 0;

    const tDiff0 = performance.now();

    for (let step = 0; step < totalSteps; step++) {
        const tVal = (step + 0.5) / totalSteps;

        // Update xt input buffer (only the non-prompt part changes)
        const tPrep0 = performance.now();
        for (let f = 0; f < totalFrames; f++) {
            for (let d = 0; d < MEL_DIM; d++) {
                xtInputBuf[(ptFrameCount + f) * MEL_DIM + d] = xt.data[f * MEL_DIM + d];
            }
        }

        const tStep = performance.now();

        if (cfgStrength > 0) {
            // === CFG batch: conditional + unconditional in one call ===
            const tPrep = performance.now();
            cfgBatchBuf.fill(0);
            for (let r = 0; r < diffBatch; r++) {
                const rowOff = r * totalFramesWithPrompt * MEL_DIM;
                if (r % 2 === 0) {
                    cfgBatchBuf.set(xtInputBuf, rowOff);
                } else {
                    for (let f = 0; f < totalFrames; f++) {
                        for (let d = 0; d < MEL_DIM; d++) {
                            cfgBatchBuf[rowOff + (ptFrameCount + f) * MEL_DIM + d] = xt.data[f * MEL_DIM + d];
                        }
                    }
                }
            }

            if (floatType === 'float16') {
                batchFloat32ToFloat16(cfgBatchBuf, cfgXtTensor.data, cfgBatchBuf.length);
                for (let r = 0; r < diffBatch; r++) cfgTBuf[r] = float32ToFloat16(tVal);
            } else {
                cfgTBuf.fill(tVal);
            }
            const prepMs = performance.now() - tPrep;

            // NPU inference
            const tInfer = performance.now();
            const batchResults = await runSession('diffStep', {
                xt_input: cfgXtTensor, t: cfgTTensor, cond: cfgCondTensor, xt_mask: cfgMaskTensor,
            });
            const batchPred = outputToFloat32(batchResults['flow_pred']);
            const inferMs = performance.now() - tInfer;

            // CFG post-processing: merged into 2 passes instead of 3
            // Pass 1: compute CFG values + accumulate means
            const tCfg = performance.now();
            const targetLen = totalFrames * MEL_DIM;
            let posSum = 0, cfgAdjSum = 0;
            for (let f = 0; f < totalFrames; f++) {
                const condSrc = (ptFrameCount + f) * MEL_DIM;
                const uncondSrc = (totalFramesWithPrompt + ptFrameCount + f) * MEL_DIM;
                const flatBase = f * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    const condVal = batchPred[condSrc + d];
                    const uncondVal = batchPred[uncondSrc + d];
                    posSum += condVal;
                    const cfgVal = condVal + cfgStrength * (condVal - uncondVal);
                    cfgPredBuf[flatBase + d] = cfgVal;
                    cfgAdjSum += cfgVal;
                }
            }
            const posMean = posSum / targetLen;
            const cfgAdjMean = cfgAdjSum / targetLen;
            // Pass 2: compute variance + apply rescale + update xt (merged)
            let posVarSum = 0, cfgAdjVarSum = 0;
            for (let i = 0; i < targetLen; i++) {
                const pv = batchPred[ptFrameCount * MEL_DIM + i] - posMean;
                posVarSum += pv * pv;
                const cd = cfgPredBuf[i] - cfgAdjMean;
                cfgAdjVarSum += cd * cd;
            }
            const rescale = cfgRescale * (Math.sqrt(posVarSum / targetLen) + 1e-6) / (Math.sqrt(cfgAdjVarSum / targetLen) + 1e-6);
            for (let i = 0; i < targetLen; i++) {
                xt.data[i] += dt * (cfgPredBuf[i] * rescale);
            }
            const cfgMs = performance.now() - tCfg;

            // Track stats
            const prepTotalMs = prepMs + (tPrep - tPrep0);
            diffPrepMin = Math.min(diffPrepMin, prepTotalMs);
            diffPrepMax = Math.max(diffPrepMax, prepTotalMs);
            diffPrepTotal += prepTotalMs;
            diffInferMin = Math.min(diffInferMin, inferMs);
            diffInferMax = Math.max(diffInferMax, inferMs);
            diffInferTotal += inferMs;
            diffCfgMin = Math.min(diffCfgMin, cfgMs);
            diffCfgMax = Math.max(diffCfgMax, cfgMs);
            diffCfgTotal += cfgMs;

            if (step === 0 || step === totalSteps - 1) {
                console.log(`[WebNN] diffStep batch=${diffBatch} [${step}/${totalSteps}]: total=${(performance.now() - tStep).toFixed(0)}ms (prep=${prepMs.toFixed(1)} + infer=${inferMs.toFixed(1)} + cfg=${cfgMs.toFixed(1)})`);
            }
        } else {
            // === No CFG: single batch=1 call ===
            const tPrep = performance.now();
            if (floatType === 'float16') {
                batchFloat32ToFloat16(xtInputBuf, xtInputTensor.data, xtInputBuf.length);
                tTensorBuf[0] = float32ToFloat16(tVal);
            } else {
                tTensorBuf[0] = tVal;
            }
            const prepMs = performance.now() - tPrep;

            const tInfer = performance.now();
            const predResults = await runSession('diffStep', {
                xt_input: xtInputTensor, t: tTensor, cond: condTensorConst, xt_mask: frameMaskTensorConst,
            });
            const predData = outputToFloat32(predResults['flow_pred']);
            const inferMs = performance.now() - tInfer;

            const prepTotalMs = prepMs + (tPrep - tPrep0);
            diffPrepMin = Math.min(diffPrepMin, prepTotalMs);
            diffPrepMax = Math.max(diffPrepMax, prepTotalMs);
            diffPrepTotal += prepTotalMs;
            diffInferMin = Math.min(diffInferMin, inferMs);
            diffInferMax = Math.max(diffInferMax, inferMs);
            diffInferTotal += inferMs;

            if (step === 0 || step === totalSteps - 1) {
                console.log(`[WebNN] diffStep batch=1 [${step}/${totalSteps}]: total=${(performance.now() - tStep).toFixed(0)}ms (prep=${prepMs.toFixed(1)} + infer=${inferMs.toFixed(1)})`);
            }

            for (let f = 0; f < totalFrames; f++) {
                const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    xt.data[f * MEL_DIM + d] += dt * predData[tgtOffset + d];
                }
            }
        }
    }

    const diffTotalMs = performance.now() - tDiff0;
    console.log(`[WebNN] Diffusion total: ${diffTotalMs.toFixed(0)}ms (${totalSteps} steps, batch=${diffBatch})`);
    console.log(`[WebNN]   prep  — min=${diffPrepMin.toFixed(1)} max=${diffPrepMax.toFixed(1)} avg=${(diffPrepTotal / totalSteps).toFixed(1)} total=${diffPrepTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   infer — min=${diffInferMin.toFixed(1)} max=${diffInferMax.toFixed(1)} avg=${(diffInferTotal / totalSteps).toFixed(1)} total=${diffInferTotal.toFixed(0)}ms`);
    if (cfgStrength > 0) {
        console.log(`[WebNN]   cfg   — min=${diffCfgMin.toFixed(1)} max=${diffCfgMax.toFixed(1)} avg=${(diffCfgTotal / totalSteps).toFixed(1)} total=${diffCfgTotal.toFixed(0)}ms`);
    }
    const diffOverhead = diffTotalMs - diffPrepTotal - diffInferTotal - diffCfgTotal;
    console.log(`[WebNN]   overhead (tensor alloc, result copy): ${diffOverhead.toFixed(0)}ms`);

    return {
        xtData: xt.data,
        totalFrames,
        diffTotalMs,
        diffInferTotal,
    };
}

/**
 * 批量扩散采样循环（2 个片段，batch=4）
 * @param {Object} params
 * @returns {Array<{ xtData: Float32Array, totalFrames: number }>}
 */
export async function runBatchDiffusionLoop({
    segData,
    totalSteps,
    floatType,
}) {
    const ort = getOrt();
    const diffBatch = 4; // 2 segments × 2 CFG

    const maxTotalFramesWithPrompt = Math.max(...segData.map(s => s.totalFramesWithPrompt));
    const maxTotalFrames = Math.max(...segData.map(s => s.totalFrames));

    // Initialize xt for both segments
    const xts = segData.map(s => {
        const xt = new Float32Array(s.totalFrames * MEL_DIM);
        for (let i = 0; i < xt.length; i++) xt[i] = gaussianRandom();
        return xt;
    });

    // Build batch=4 tensors padded to maxTotalFramesWithPrompt
    const cfgBatchBuf = new Float32Array(diffBatch * maxTotalFramesWithPrompt * MEL_DIM);
    const cfgCondBuf = new Float32Array(diffBatch * maxTotalFramesWithPrompt * COND_DIM);
    const cfgMaskBuf = new Float32Array(diffBatch * maxTotalFramesWithPrompt);
    const xtInputBufs = segData.map(s => new Float32Array(s.totalFramesWithPrompt * MEL_DIM));
    const cfgPredBufs = segData.map(s => new Float32Array(s.totalFrames * MEL_DIM));

    // Set up cond and mask for batch=4:
    // Row 0: seg0 conditional, Row 1: seg0 unconditional
    // Row 2: seg1 conditional, Row 3: seg1 unconditional
    for (let si = 0; si < 2; si++) {
        const s = segData[si];
        const condRow = si * 2;
        const uncondRow = si * 2 + 1;
        const condOff = condRow * maxTotalFramesWithPrompt * COND_DIM;
        const maskCondOff = condRow * maxTotalFramesWithPrompt;
        const maskUncondOff = uncondRow * maxTotalFramesWithPrompt;

        cfgCondBuf.set(s.combinedCond, condOff);
        cfgMaskBuf.fill(1, maskCondOff, maskCondOff + s.totalFramesWithPrompt);
        cfgMaskBuf.fill(1, maskUncondOff + s.ptFrameCount, maskUncondOff + s.totalFramesWithPrompt);

        if (s.ptMelData) {
            for (let f = 0; f < s.ptFrameCount; f++) {
                for (let d = 0; d < MEL_DIM; d++) {
                    xtInputBufs[si][f * MEL_DIM + d] = s.ptMelData[f * MEL_DIM + d];
                }
            }
        }
    }

    let cfgXtTensor, cfgTTensor, cfgCondTensor, cfgMaskTensor;
    let cfgTBuf;
    if (floatType === 'float16') {
        cfgXtTensor = new ort.Tensor('float16', new Uint16Array(diffBatch * maxTotalFramesWithPrompt * MEL_DIM), [diffBatch, maxTotalFramesWithPrompt, MEL_DIM]);
        cfgTBuf = new Uint16Array(diffBatch);
        cfgTTensor = new ort.Tensor('float16', cfgTBuf, [diffBatch]);
        cfgCondTensor = createFloatTensor(floatType, cfgCondBuf, [diffBatch, maxTotalFramesWithPrompt, COND_DIM]);
        cfgMaskTensor = createFloatTensor(floatType, cfgMaskBuf, [diffBatch, maxTotalFramesWithPrompt]);
    } else {
        cfgXtTensor = new ort.Tensor('float32', cfgBatchBuf, [diffBatch, maxTotalFramesWithPrompt, MEL_DIM]);
        cfgTBuf = new Float32Array(diffBatch);
        cfgTTensor = new ort.Tensor('float32', cfgTBuf, [diffBatch]);
        cfgCondTensor = createFloatTensor(floatType, cfgCondBuf, [diffBatch, maxTotalFramesWithPrompt, COND_DIM]);
        cfgMaskTensor = createFloatTensor(floatType, cfgMaskBuf, [diffBatch, maxTotalFramesWithPrompt]);
    }

    const dt = 1.0 / totalSteps;
    const cfgStrength0 = segData[0].cfgStrength;
    const cfgRescale0 = segData[0].cfgRescale;

    // Batch diffusion timing stats
    let bDiffInferMin = Infinity, bDiffInferMax = 0, bDiffInferTotal = 0;
    let bDiffPrepTotal = 0, bDiffCfgTotal = 0;

    const tDiff0 = performance.now();

    for (let step = 0; step < totalSteps; step++) {
        const tVal = (step + 0.5) / totalSteps;
        const tStepPrep = performance.now();
        cfgBatchBuf.fill(0);

        for (let si = 0; si < 2; si++) {
            const s = segData[si];
            const xt = xts[si];
            const xtInputBuf = xtInputBufs[si];
            const condRow = si * 2;
            const uncondRow = si * 2 + 1;
            const condRowOff = condRow * maxTotalFramesWithPrompt * MEL_DIM;
            const uncondRowOff = uncondRow * maxTotalFramesWithPrompt * MEL_DIM;

            for (let f = 0; f < s.totalFrames; f++) {
                for (let d = 0; d < MEL_DIM; d++) {
                    xtInputBuf[(s.ptFrameCount + f) * MEL_DIM + d] = xt[f * MEL_DIM + d];
                }
            }
            cfgBatchBuf.set(xtInputBuf, condRowOff);
            for (let f = 0; f < s.totalFrames; f++) {
                for (let d = 0; d < MEL_DIM; d++) {
                    cfgBatchBuf[uncondRowOff + (s.ptFrameCount + f) * MEL_DIM + d] = xt[f * MEL_DIM + d];
                }
            }
        }

        if (floatType === 'float16') {
            batchFloat32ToFloat16(cfgBatchBuf, cfgXtTensor.data, cfgBatchBuf.length);
            for (let r = 0; r < diffBatch; r++) cfgTBuf[r] = float32ToFloat16(tVal);
        } else {
            cfgTBuf.fill(tVal);
        }

        const prepMs = performance.now() - tStepPrep;

        const tStepInfer = performance.now();
        const batchResults = await runSession('diffStep', {
            xt_input: cfgXtTensor, t: cfgTTensor, cond: cfgCondTensor, xt_mask: cfgMaskTensor,
        });
        const batchPred = outputToFloat32(batchResults['flow_pred']);
        const inferMs = performance.now() - tStepInfer;

        const tStepCfg = performance.now();
        // Apply CFG per segment
        for (let si = 0; si < 2; si++) {
            const s = segData[si];
            const xt = xts[si];
            const cfgPredBuf = cfgPredBufs[si];
            const condRow = si * 2;
            const uncondRow = si * 2 + 1;
            const condRowOff = condRow * maxTotalFramesWithPrompt * MEL_DIM;
            const uncondRowOff = uncondRow * maxTotalFramesWithPrompt * MEL_DIM;
            const targetLen = s.totalFrames * MEL_DIM;

            let posSum = 0, cfgAdjSum = 0;
            for (let f = 0; f < s.totalFrames; f++) {
                const condSrc = condRowOff + (s.ptFrameCount + f) * MEL_DIM;
                const uncondSrc = uncondRowOff + (s.ptFrameCount + f) * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    const condVal = batchPred[condSrc + d];
                    const uncondVal = batchPred[uncondSrc + d];
                    posSum += condVal;
                    const cfgVal = condVal + cfgStrength0 * (condVal - uncondVal);
                    cfgPredBuf[f * MEL_DIM + d] = cfgVal;
                    cfgAdjSum += cfgVal;
                }
            }
            const posMean = posSum / targetLen;
            const cfgAdjMean = cfgAdjSum / targetLen;
            let posVarSum = 0, cfgAdjVarSum = 0;
            for (let f = 0; f < s.totalFrames; f++) {
                const condSrc = condRowOff + (s.ptFrameCount + f) * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    const pv = batchPred[condSrc + d] - posMean;
                    posVarSum += pv * pv;
                    const cd = cfgPredBuf[f * MEL_DIM + d] - cfgAdjMean;
                    cfgAdjVarSum += cd * cd;
                }
            }
            const posStd = Math.sqrt(posVarSum / targetLen + 1e-8);
            const cfgAdjStd = Math.sqrt(cfgAdjVarSum / targetLen + 1e-8);
            const rescale = posStd / (cfgAdjStd + 1e-8);

            for (let f = 0; f < s.totalFrames; f++) {
                for (let d = 0; d < MEL_DIM; d++) {
                    const cfgVal = cfgPredBuf[f * MEL_DIM + d];
                    const rescaledVal = cfgRescale0 * (cfgVal * rescale) + (1 - cfgRescale0) * cfgVal;
                    xt[f * MEL_DIM + d] += rescaledVal * dt;
                }
            }
        }
        const cfgMs = performance.now() - tStepCfg;

        bDiffPrepTotal += prepMs;
        bDiffInferTotal += inferMs;
        bDiffInferMin = Math.min(bDiffInferMin, inferMs);
        bDiffInferMax = Math.max(bDiffInferMax, inferMs);
        bDiffCfgTotal += cfgMs;

        if (step === 0 || step === totalSteps - 1) {
            console.log(`[WebNN]   batch diffStep [${step}/${totalSteps}]: prep=${prepMs.toFixed(1)} infer=${inferMs.toFixed(1)} cfg=${cfgMs.toFixed(1)}`);
        }
    }
    const batchDiffMs = performance.now() - tDiff0;
    console.log(`[WebNN] Batch diffusion (2 segs, batch=4): ${batchDiffMs.toFixed(0)}ms (${totalSteps} steps)`);
    console.log(`[WebNN]   prep  — total=${bDiffPrepTotal.toFixed(0)}ms avg=${(bDiffPrepTotal / totalSteps).toFixed(1)}ms`);
    console.log(`[WebNN]   infer — min=${bDiffInferMin.toFixed(1)} max=${bDiffInferMax.toFixed(1)} avg=${(bDiffInferTotal / totalSteps).toFixed(1)} total=${bDiffInferTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   cfg   — total=${bDiffCfgTotal.toFixed(0)}ms avg=${(bDiffCfgTotal / totalSteps).toFixed(1)}ms`);

    return xts;
}
