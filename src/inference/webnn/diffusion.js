/**
 * WebNN 推理模块 — 扩散采样循环
 */

import { MEL_DIM, COND_DIM, NPU_STATIC_SEQ_LEN } from './constants.js';
import { getOrt } from './ortSetup.js';
import { runSession } from './sessionManager.js';
import { createFloatTensor, outputToFloat32, float32ToFloat16, batchFloat32ToFloat16, gaussianRandom, padToLength, disposeTensor } from './utils.js';
import { createSampler } from '../pipeline/samplers/index.js';

/**
 * 单片段扩散采样循环
 * @param {Object} params
 * @param {string} [params.samplerName='euler'] - 求解器名称
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
    useStaticShapes = false,
    samplerName = 'euler',
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

    // prompt frames don't change, copy once
    if (ptMelData) {
        const copyLen = ptFrameCount * MEL_DIM;
        if (ptMelData.length === copyLen) {
            xtInputBuf.set(ptMelData);
        } else {
            xtInputBuf.set(ptMelData.subarray(0, copyLen));
        }
    }

    // Pre-create CONSTANT tensors once (these don't change between diffusion steps)
    const diffSeqLen = useStaticShapes ? Math.max(totalFramesWithPrompt, NPU_STATIC_SEQ_LEN) : totalFramesWithPrompt;
    const paddedCondForConst = useStaticShapes ? padToLength(combinedCond, diffSeqLen * COND_DIM) : combinedCond;
    const paddedMaskForConst = useStaticShapes ? padToLength(frameMask, diffSeqLen) : frameMask;
    const condTensorConst = createFloatTensor(floatType, paddedCondForConst, [1, diffSeqLen, COND_DIM]);
    const frameMaskTensorConst = createFloatTensor(floatType, paddedMaskForConst, [1, diffSeqLen]);

    // CFG batch: merge conditional + unconditional into one inference call
    // When diffBatch > 2, duplicate rows to fill batch for better NPU utilization
    const cfgBatchBuf = new Float32Array(diffBatch * diffSeqLen * MEL_DIM);
    const cfgCondBuf = new Float32Array(diffBatch * diffSeqLen * COND_DIM);
    const cfgMaskBuf = new Float32Array(diffBatch * diffSeqLen);
    // Rows 0,2,4,... mask = all ones (conditional)
    // Rows 1,3,5,... mask = all ones for target, zeros for padding (unconditional)
    for (let r = 0; r < diffBatch; r++) {
        const rowOff = r * diffSeqLen;
        if (r % 2 === 0) {
            // conditional: all ones
            cfgMaskBuf.fill(1, rowOff, rowOff + totalFramesWithPrompt);
        } else {
            // unconditional: all ones for target (positions 0..totalFrames-1),
            // zeros for padding (positions totalFrames..diffSeqLen-1).
            // Aligns with DML path and official reverse_diffusion which use
            // target_len as the unconditional seq_len.
            cfgMaskBuf.fill(1, rowOff, rowOff + totalFrames);
        }
    }
    // Cond rows: even rows = combinedCond, odd rows = zeros (unconditional)
    for (let r = 0; r < diffBatch; r += 2) {
        cfgCondBuf.set(combinedCond, r * diffSeqLen * COND_DIM);
    }

    let cfgXtTensor, cfgTTensor, cfgCondTensor, cfgMaskTensor;
    let cfgTBuf;
    if (floatType === 'float16') {
        cfgXtTensor = new ort.Tensor('float16', new Uint16Array(diffBatch * diffSeqLen * MEL_DIM), [diffBatch, diffSeqLen, MEL_DIM]);
        cfgTBuf = new Uint16Array(diffBatch);
        cfgTTensor = new ort.Tensor('float16', cfgTBuf, [diffBatch]);
        cfgCondTensor = createFloatTensor(floatType, cfgCondBuf, [diffBatch, diffSeqLen, COND_DIM]);
        cfgMaskTensor = createFloatTensor(floatType, cfgMaskBuf, [diffBatch, diffSeqLen]);
    } else {
        cfgXtTensor = new ort.Tensor('float32', cfgBatchBuf, [diffBatch, diffSeqLen, MEL_DIM]);
        cfgTBuf = new Float32Array(diffBatch);
        cfgTTensor = new ort.Tensor('float32', cfgTBuf, [diffBatch]);
        cfgCondTensor = createFloatTensor(floatType, cfgCondBuf, [diffBatch, diffSeqLen, COND_DIM]);
        cfgMaskTensor = createFloatTensor(floatType, cfgMaskBuf, [diffBatch, diffSeqLen]);
    }

    // Pre-allocate for no-CFG path
    const noCfgSeqLen = useStaticShapes ? Math.max(totalFramesWithPrompt, NPU_STATIC_SEQ_LEN) : totalFramesWithPrompt;
    let xtInputTensor, tTensorBuf, tTensor;
    if (floatType === 'float16') {
        xtInputTensor = new ort.Tensor('float16', new Uint16Array(noCfgSeqLen * MEL_DIM), [1, noCfgSeqLen, MEL_DIM]);
        tTensorBuf = new Uint16Array(1);
        tTensor = new ort.Tensor('float16', tTensorBuf, [1]);
    } else {
        xtInputTensor = new ort.Tensor('float32', new Float32Array(noCfgSeqLen * MEL_DIM), [1, noCfgSeqLen, MEL_DIM]);
        tTensorBuf = new Float32Array(1);
        tTensor = new ort.Tensor('float32', tTensorBuf, [1]);
    }

    // S11: dispose every pre-allocated tensor on exit (success or exception).
    // Previously the dispose calls lived after the loop, so a runSession throw
    // mid-loop would skip them and leak NPU memory across syntheses.
    const _disposeAllTensors = () => {
        disposeTensor(condTensorConst);
        disposeTensor(frameMaskTensorConst);
        disposeTensor(cfgCondTensor);
        disposeTensor(cfgMaskTensor);
        disposeTensor(cfgXtTensor);
        disposeTensor(cfgTTensor);
        disposeTensor(xtInputTensor);
        disposeTensor(tTensor);
    };

    // Diffusion step timing stats
    let diffInferMin = Infinity, diffInferMax = 0, diffInferTotal = 0;
    let diffPrepMin = Infinity, diffPrepMax = 0, diffPrepTotal = 0;
    let diffCfgMin = Infinity, diffCfgMax = 0, diffCfgTotal = 0;

    const tDiff0 = performance.now();

    // ===== 求解器抽象 =====
    // 与 ORT/DML 路径 (pipeline/diffusion.js) 对齐：
    //   evalDiffStep(t, xtOverride?): 执行 cond + (可选)uncond 推理，返回独立副本
    //   combine(condPred, uncondPred): CFG + Rescale 合并，写入 vBuf（复用）
    //   sampler.step 将 delta 写入 deltaBuf（复用），返回 { nfe }
    const sampler = createSampler(samplerName);
    const useCfg = cfgStrength > 0;

    // 预分配复用缓冲区（跨步复用，0 per-step 分配）
    const _targetLen = totalFrames * MEL_DIM;
    const buffers = {
        vBuf: new Float32Array(_targetLen),
        deltaBuf: new Float32Array(_targetLen),
        v1Buf: new Float32Array(_targetLen),
        xPredBuf: new Float32Array(_targetLen),
    };

    // evalDiffStep: 执行 cond + (可选)uncond 推理
    // xtOverride 可选：用于多步评估求解器（如 Heun）的预测子步骤
    const evalDiffStep = async (t, xtOverride) => {
        const xtData = xtOverride || xt.data;
        // 更新 xtInputBuf 的 target 段
        for (let f = 0; f < totalFrames; f++) {
            for (let d = 0; d < MEL_DIM; d++) {
                xtInputBuf[(ptFrameCount + f) * MEL_DIM + d] = xtData[f * MEL_DIM + d];
            }
        }

        if (useCfg) {
            // === CFG batch: conditional + unconditional in one call ===
            const tPrep = performance.now();
            cfgBatchBuf.fill(0);
            for (let r = 0; r < diffBatch; r++) {
                const rowOff = r * diffSeqLen * MEL_DIM;
                if (r % 2 === 0) {
                    cfgBatchBuf.set(xtInputBuf, rowOff);
                } else {
                    // unconditional: xt at position 0 (no prompt offset)
                    for (let f = 0; f < totalFrames; f++) {
                        for (let d = 0; d < MEL_DIM; d++) {
                            cfgBatchBuf[rowOff + f * MEL_DIM + d] = xtData[f * MEL_DIM + d];
                        }
                    }
                }
            }
            if (floatType === 'float16') {
                batchFloat32ToFloat16(cfgBatchBuf, cfgXtTensor.data, cfgBatchBuf.length);
                for (let r = 0; r < diffBatch; r++) cfgTBuf[r] = float32ToFloat16(t);
            } else {
                cfgTBuf.fill(t);
            }
            const prepMs = performance.now() - tPrep;

            const tInfer = performance.now();
            const batchResults = await runSession('diffStep', {
                xt_input: cfgXtTensor, t: cfgTTensor, cond: cfgCondTensor, xt_mask: cfgMaskTensor,
            });
            const batchPredRaw = batchResults['flow_pred'];
            const batchPred = outputToFloat32(batchPredRaw);
            const batchPredSafe = batchPredRaw.type === 'float32' ? batchPred.slice() : batchPred;
            disposeTensor(batchPredRaw);
            const inferMs = performance.now() - tInfer;

            // 统计：prep/infer 在此累加（与原实现一致）
            diffPrepMin = Math.min(diffPrepMin, prepMs);
            diffPrepMax = Math.max(diffPrepMax, prepMs);
            diffPrepTotal += prepMs;
            diffInferMin = Math.min(diffInferMin, inferMs);
            diffInferMax = Math.max(diffInferMax, inferMs);
            diffInferTotal += inferMs;

            // 提取 cond 段（target 部分）和 uncond 段（target 部分）为独立副本
            const condPred = new Float32Array(totalFrames * MEL_DIM);
            const uncondPred = new Float32Array(totalFrames * MEL_DIM);
            for (let f = 0; f < totalFrames; f++) {
                const condSrc = (ptFrameCount + f) * MEL_DIM;
                const uncondSrc = (diffSeqLen + f) * MEL_DIM;
                const flatBase = f * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    condPred[flatBase + d] = batchPredSafe[condSrc + d];
                    uncondPred[flatBase + d] = batchPredSafe[uncondSrc + d];
                }
            }
            return { condPred, uncondPred };
        } else {
            // === No CFG: single batch=1 call ===
            const tPrep = performance.now();
            if (floatType === 'float16') {
                batchFloat32ToFloat16(xtInputBuf, xtInputTensor.data, xtInputBuf.length);
                tTensorBuf[0] = float32ToFloat16(t);
            } else {
                const noCfgData = xtInputTensor.data;
                noCfgData.fill(0);
                noCfgData.set(xtInputBuf);
                tTensorBuf[0] = t;
            }
            const prepMs = performance.now() - tPrep;

            const tInfer = performance.now();
            const predResults = await runSession('diffStep', {
                xt_input: xtInputTensor, t: tTensor, cond: condTensorConst, xt_mask: frameMaskTensorConst,
            });
            const predRaw = predResults['flow_pred'];
            const predData = outputToFloat32(predRaw);
            const predDataSafe = predRaw.type === 'float32' ? predData.slice() : predData;
            disposeTensor(predRaw);
            const inferMs = performance.now() - tInfer;

            diffPrepMin = Math.min(diffPrepMin, prepMs);
            diffPrepMax = Math.max(diffPrepMax, prepMs);
            diffPrepTotal += prepMs;
            diffInferMin = Math.min(diffInferMin, inferMs);
            diffInferMax = Math.max(diffInferMax, inferMs);
            diffInferTotal += inferMs;

            // 提取 target 段为独立副本
            const condPred = new Float32Array(totalFrames * MEL_DIM);
            for (let f = 0; f < totalFrames; f++) {
                const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    condPred[f * MEL_DIM + d] = predDataSafe[tgtOffset + d];
                }
            }
            return { condPred, uncondPred: null };
        }
    };

    // combine: CFG + Rescale 合并，写入 vBuf（复用），返回 vBuf 引用
    // 无 CFG 时直接拷贝 condPred 到 vBuf（condPred 已是 target 段）。
    // 有 CFG 时 three-pass（与 ORT 路径完全一致）：
    //   Pass 1: cfgVal → cfgPredBuf, 累加 sum
    //   Pass 2: two-pass 方差
    //   Pass 3: 应用 rescale → vBuf
    const combineRaw = (condPred, uncondPred) => {
        const v = buffers.vBuf;
        if (!useCfg) {
            v.set(condPred); // condPred 已是 target 段
            return v;
        }
        const targetLen = totalFrames * MEL_DIM;
        let posSum = 0, cfgAdjSum = 0;
        for (let i = 0; i < targetLen; i++) {
            posSum += condPred[i];
            const cfgVal = condPred[i] + cfgStrength * (condPred[i] - uncondPred[i]);
            cfgPredBuf[i] = cfgVal;
            cfgAdjSum += cfgVal;
        }
        const posMean = posSum / targetLen;
        const cfgAdjMean = cfgAdjSum / targetLen;
        let posVarSum = 0, cfgAdjVarSum = 0;
        for (let i = 0; i < targetLen; i++) {
            const pv = condPred[i] - posMean;
            posVarSum += pv * pv;
            const cd = cfgPredBuf[i] - cfgAdjMean;
            cfgAdjVarSum += cd * cd;
        }
        const posStd = Math.sqrt(Math.max(0, posVarSum) / Math.max(1, targetLen - 1));
        const cfgAdjStd = Math.sqrt(Math.max(0, cfgAdjVarSum) / Math.max(1, targetLen - 1));
        const rescale = posStd / (cfgAdjStd + 1e-8);
        for (let i = 0; i < targetLen; i++) {
            const cfgVal = cfgPredBuf[i];
            v[i] = cfgRescale * (cfgVal * rescale) + (1 - cfgRescale) * cfgVal;
        }
        return v;
    };

    // 计时包装：combine 调用前后累加 diffCfg 统计
    const combine = (condPred, uncondPred) => {
        const tCfg = performance.now();
        const result = combineRaw(condPred, uncondPred);
        const cfgMs = performance.now() - tCfg;
        diffCfgMin = Math.min(diffCfgMin, cfgMs);
        diffCfgMax = Math.max(diffCfgMax, cfgMs);
        diffCfgTotal += cfgMs;
        return result;
    };

    let totalNFE = 0;
    try {
        for (let step = 0; step < totalSteps; step++) {
            const tStep = performance.now();
            const { nfe } = await sampler.step({
                evalDiffStep, combine, step, totalSteps,
                xtData: xt.data, buffers,
            });
            totalNFE += nfe;
            // 累加 deltaBuf 到 xt.data
            const delta = buffers.deltaBuf;
            for (let i = 0; i < delta.length; i++) {
                xt.data[i] += delta[i];
            }

            if (step === 0 || step === totalSteps - 1) {
                console.log(`[WebNN] diffStep batch=${diffBatch} sampler=${samplerName} [${step}/${totalSteps}]: total=${(performance.now() - tStep).toFixed(0)}ms nfe=${nfe}`);
            }
        }
    } finally {
        // S11: always release pre-allocated tensors, even if runSession throws
        // mid-loop. Without this, an exception would leak 8 tensors' worth of
        // NPU memory per synthesis.
        _disposeAllTensors();
    }

    const diffTotalMs = performance.now() - tDiff0;
    console.log(`[WebNN] Diffusion total: ${diffTotalMs.toFixed(0)}ms (${totalSteps} steps, ${totalNFE} NFE, batch=${diffBatch})`);
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
        totalNFE,
    };
}

/**
 * 批量扩散采样循环（2 个片段，batch=4）
 *
 * 注意：批量路径的 batch=4 优化与多步评估求解器（Heun/Extrap）的 per-segment
 * evalDiffStep 抽象不兼容。Phase 1 策略：
 *   - Euler 求解器：走原 batch=4 优化路径
 *   - 非 Euler 求解器：退化为两次独立 runDiffusionLoop 调用（牺牲 batch 优化，保证正确性）
 *
 * @param {Object} params
 * @param {string} [params.samplerName='euler'] - 求解器名称
 * @returns {Array<{ xtData: Float32Array, totalFrames: number }>}
 */
export async function runBatchDiffusionLoop({
    segData,
    totalSteps,
    floatType,
    useStaticShapes = false,
    samplerName = 'euler',
}) {
    // 非 Euler 求解器：退化为两次单段调用，保证正确性
    if (samplerName !== 'euler') {
        console.warn(`[WebNN] runBatchDiffusionLoop: sampler=${samplerName} not supported in batch path, fallback to sequential single-segment calls`);
        const results = [];
        for (const s of segData) {
            const r = await runDiffusionLoop({
                combinedCond: s.combinedCond,
                totalFrames: s.totalFrames,
                totalFramesWithPrompt: s.totalFramesWithPrompt,
                ptFrameCount: s.ptFrameCount,
                ptMelData: s.ptMelData,
                totalSteps,
                cfgStrength: s.cfgStrength,
                cfgRescale: s.cfgRescale,
                floatType,
                npuDiffBatchSize: 2,
                useStaticShapes,
                samplerName,
            });
            results.push({ xtData: r.xtData, totalFrames: r.totalFrames });
        }
        return results;
    }
    const ort = getOrt();
    const diffBatch = 4; // 2 segments × 2 CFG

    const maxTotalFramesWithPrompt = Math.max(...segData.map(s => s.totalFramesWithPrompt));
    const batchDiffSeqLen = useStaticShapes ? Math.max(maxTotalFramesWithPrompt, NPU_STATIC_SEQ_LEN) : maxTotalFramesWithPrompt;

    // Initialize xt for both segments
    const xts = segData.map(s => {
        const xt = new Float32Array(s.totalFrames * MEL_DIM);
        for (let i = 0; i < xt.length; i++) xt[i] = gaussianRandom();
        return xt;
    });

    // Build batch=4 tensors padded to batchDiffSeqLen
    const cfgBatchBuf = new Float32Array(diffBatch * batchDiffSeqLen * MEL_DIM);
    const cfgCondBuf = new Float32Array(diffBatch * batchDiffSeqLen * COND_DIM);
    const cfgMaskBuf = new Float32Array(diffBatch * batchDiffSeqLen);
    const xtInputBufs = segData.map(s => new Float32Array(s.totalFramesWithPrompt * MEL_DIM));
    const cfgPredBufs = segData.map(s => new Float32Array(s.totalFrames * MEL_DIM));

    // Set up cond and mask for batch=4:
    // Row 0: seg0 conditional, Row 1: seg0 unconditional
    // Row 2: seg1 conditional, Row 3: seg1 unconditional
    for (let si = 0; si < 2; si++) {
        const s = segData[si];
        const condRow = si * 2;
        const uncondRow = si * 2 + 1;
        const condOff = condRow * batchDiffSeqLen * COND_DIM;
        const maskCondOff = condRow * batchDiffSeqLen;
        const maskUncondOff = uncondRow * batchDiffSeqLen;

        cfgCondBuf.set(s.combinedCond, condOff);
        cfgMaskBuf.fill(1, maskCondOff, maskCondOff + s.totalFramesWithPrompt);
        cfgMaskBuf.fill(1, maskUncondOff, maskUncondOff + s.totalFrames);

        if (s.ptMelData) {
            const copyLen = s.ptFrameCount * MEL_DIM;
            if (s.ptMelData.length === copyLen) {
                xtInputBufs[si].set(s.ptMelData);
            } else {
                xtInputBufs[si].set(s.ptMelData.subarray(0, copyLen));
            }
        }
    }

    let cfgXtTensor, cfgTTensor, cfgCondTensor, cfgMaskTensor;
    let cfgTBuf;
    if (floatType === 'float16') {
        cfgXtTensor = new ort.Tensor('float16', new Uint16Array(diffBatch * batchDiffSeqLen * MEL_DIM), [diffBatch, batchDiffSeqLen, MEL_DIM]);
        cfgTBuf = new Uint16Array(diffBatch);
        cfgTTensor = new ort.Tensor('float16', cfgTBuf, [diffBatch]);
        cfgCondTensor = createFloatTensor(floatType, cfgCondBuf, [diffBatch, batchDiffSeqLen, COND_DIM]);
        cfgMaskTensor = createFloatTensor(floatType, cfgMaskBuf, [diffBatch, batchDiffSeqLen]);
    } else {
        cfgXtTensor = new ort.Tensor('float32', cfgBatchBuf, [diffBatch, batchDiffSeqLen, MEL_DIM]);
        cfgTBuf = new Float32Array(diffBatch);
        cfgTTensor = new ort.Tensor('float32', cfgTBuf, [diffBatch]);
        cfgCondTensor = createFloatTensor(floatType, cfgCondBuf, [diffBatch, batchDiffSeqLen, COND_DIM]);
        cfgMaskTensor = createFloatTensor(floatType, cfgMaskBuf, [diffBatch, batchDiffSeqLen]);
    }

    const dt = 1.0 / totalSteps;
    const cfgStrength0 = segData[0].cfgStrength;
    const cfgRescale0 = segData[0].cfgRescale;

    // Batch diffusion timing stats
    let bDiffInferMin = Infinity, bDiffInferMax = 0, bDiffInferTotal = 0;
    let bDiffPrepTotal = 0, bDiffCfgTotal = 0;

    const tDiff0 = performance.now();

    // S11: dispose all pre-allocated tensors on exit (success or exception).
    const _disposeBatchTensors = () => {
        disposeTensor(cfgXtTensor);
        disposeTensor(cfgTTensor);
        disposeTensor(cfgCondTensor);
        disposeTensor(cfgMaskTensor);
    };

    try {
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
                const condRowOff = condRow * batchDiffSeqLen * MEL_DIM;
                const uncondRowOff = uncondRow * batchDiffSeqLen * MEL_DIM;

                for (let f = 0; f < s.totalFrames; f++) {
                    for (let d = 0; d < MEL_DIM; d++) {
                        xtInputBuf[(s.ptFrameCount + f) * MEL_DIM + d] = xt[f * MEL_DIM + d];
                    }
                }
                cfgBatchBuf.set(xtInputBuf, condRowOff);
                // unconditional: xt at position 0 (no prompt offset),
                // matching DML path and official reverse_diffusion
                for (let f = 0; f < s.totalFrames; f++) {
                    for (let d = 0; d < MEL_DIM; d++) {
                        cfgBatchBuf[uncondRowOff + f * MEL_DIM + d] = xt[f * MEL_DIM + d];
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
            const batchPredRaw = batchResults['flow_pred'];
            // 同单段路径：取独立副本后立即释放张量，防止 32 步 × batch=4 累积
            const batchPred = outputToFloat32(batchPredRaw);
            const batchPredSafe = batchPredRaw.type === 'float32' ? batchPred.slice() : batchPred;
            disposeTensor(batchPredRaw);
            const inferMs = performance.now() - tStepInfer;

            const tStepCfg = performance.now();
            // Apply CFG per segment
            for (let si = 0; si < 2; si++) {
                const s = segData[si];
                const xt = xts[si];
                const cfgPredBuf = cfgPredBufs[si];
                const condRow = si * 2;
                const uncondRow = si * 2 + 1;
                const condRowOff = condRow * batchDiffSeqLen * MEL_DIM;
                const uncondRowOff = uncondRow * batchDiffSeqLen * MEL_DIM;
                const targetLen = s.totalFrames * MEL_DIM;

                let posSum = 0, cfgAdjSum = 0;
                for (let f = 0; f < s.totalFrames; f++) {
                    const condSrc = condRowOff + (s.ptFrameCount + f) * MEL_DIM;
                    const uncondSrc = uncondRowOff + f * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        const condVal = batchPredSafe[condSrc + d];
                        const uncondVal = batchPredSafe[uncondSrc + d];
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
                        const pv = batchPredSafe[condSrc + d] - posMean;
                        posVarSum += pv * pv;
                        const cd = cfgPredBuf[f * MEL_DIM + d] - cfgAdjMean;
                        cfgAdjVarSum += cd * cd;
                    }
                }
                const posStd = Math.sqrt(Math.max(0, posVarSum) / Math.max(1, targetLen - 1));
                const cfgAdjStd = Math.sqrt(Math.max(0, cfgAdjVarSum) / Math.max(1, targetLen - 1));
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
    } finally {
        // S11: always release pre-allocated tensors, even on exception.
        _disposeBatchTensors();
    }

    const batchDiffMs = performance.now() - tDiff0;
    console.log(`[WebNN] Batch diffusion (2 segs, batch=4): ${batchDiffMs.toFixed(0)}ms (${totalSteps} steps)`);
    console.log(`[WebNN]   prep  — total=${bDiffPrepTotal.toFixed(0)}ms avg=${(bDiffPrepTotal / totalSteps).toFixed(1)}ms`);
    console.log(`[WebNN]   infer — min=${bDiffInferMin.toFixed(1)} max=${bDiffInferMax.toFixed(1)} avg=${(bDiffInferTotal / totalSteps).toFixed(1)} total=${bDiffInferTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   cfg   — total=${bDiffCfgTotal.toFixed(0)}ms avg=${(bDiffCfgTotal / totalSteps).toFixed(1)}ms`);

    return xts;
}
