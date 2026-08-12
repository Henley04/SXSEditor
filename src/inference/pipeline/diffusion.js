const ort = require('onnxruntime-node');
const { MEL_DIM, COND_DIM, NPU_STATIC_SEQ_LEN } = require('./constants');
const { createFloatTensor, outputToFloat32, disposeTensor, gpuDrainAdaptive, float32ToFloat16, batchFloat32ToFloat16 } = require('./utils');
const { createSampler, DEFAULT_SOLVER } = require('./samplers');
const { wsolaCrossfadeMel } = require('./wsola');
const { resolveCfgAtStep, applyDynamicThreshold } = require('./cfgSchedule');

/**
 * Read diagnosticMode flag lazily from settings. Returns false if settings
 * cannot be loaded (e.g. running outside Electron main process, in tests).
 * Used to gate [DiffusionDiag] statistical console.log blocks; NaN/Inf fatal
 * console.error is always-on regardless of this flag.
 * @returns {boolean}
 */
function _readDiagnosticMode() {
    try {
        const { loadSettings } = require('../../main/settings');
        return loadSettings().diagnosticMode === true;
    } catch (_) {
        return false;
    }
}

/**
 * Read enableSDEditRepair flag lazily from settings. Returns false if settings
 * cannot be loaded (e.g. running outside Electron main process, in tests).
 * When false, runDiffusionLoop skips the SDEdit repair code path entirely
 * (zero overhead, no behavior change vs. pre-Task-17).
 * @returns {boolean}
 */
function _readSDEditRepair() {
    try {
        const { loadSettings } = require('../../main/settings');
        return loadSettings().enableSDEditRepair === true;
    } catch (_) {
        return false;
    }
}

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

        // 诊断：检查第一个 step 的输出（gated by diagnosticMode；NaN/Inf 致命错误见下方 always-on console.error）
        if (tVal < 0.1 && _readDiagnosticMode()) {
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

        // 诊断第一步：输入数据统计（gated by diagnosticMode）
        if (tVal < 0.1 && _readDiagnosticMode()) {
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
     * Separate cond/uncond inference (fallback when model rejects batch>1).
     *
     * Runs two batch=1 session.run calls instead of a single batch=2 call:
     *   1. Cond call: xt = [ptMelData | xtData], cond = combinedCond, mask = all ones
     *   2. Uncond call: xt = xtData (target only, no prompt), cond = zeros, mask = ones for target only
     *
     * Reuses the pre-allocated batch=1 tensors (xtInputTensor, tTensor,
     * condTensorConst, condMaskTensorConst) for the cond branch.
     * For the uncond branch, creates temporary tensors per call (the uncond
     * cond/mask differ from cond and cannot reuse the cached tensors).
     *
     * @param {Object} sessions
     * @param {Float32Array} xtInputBuf - pre-allocated buffer [ptMelData | xtData]
     * @param {Float32Array} xtData - target xt data (without prompt)
     * @param {number} t - timestep value
     * @param {string} floatType - 'float16' or 'float32'
     * @param {Object} xtInputTensor - pre-allocated [1, seqLen, MEL_DIM] tensor
     * @param {Uint16Array|Float32Array} tTensorBuf - pre-allocated t buffer
     * @param {Object} tTensor - pre-allocated [1] tensor
     * @param {Object} condTensorConst - pre-allocated cond tensor (combinedCond)
     * @param {Object} condMaskTensorConst - pre-allocated mask tensor (all ones for prompt+target)
     * @param {number} ptFrameCount
     * @param {number} totalFrames
     * @param {number} seqLen
     * @param {number} targetLen
     * @returns {Promise<{condPred: Float32Array, uncondPred: Float32Array}>}
     * @private
     */
    async _evalDiffStepSeparate(sessions, xtInputBuf, xtData, t, floatType,
        xtInputTensor, tTensorBuf, tTensor,
        condTensorConst, condMaskTensorConst,
        ptFrameCount, totalFrames, seqLen, targetLen) {

        // === Cond branch: xt = [ptMelData | xtData], cond = combinedCond ===
        xtInputBuf.set(xtData, ptFrameCount * MEL_DIM);
        if (floatType === 'float16') {
            batchFloat32ToFloat16(xtInputBuf, xtInputTensor.data, xtInputBuf.length);
            tTensorBuf[0] = float32ToFloat16(t);
        } else {
            xtInputTensor.data.set(xtInputBuf);
            tTensorBuf[0] = t;
        }

        const condResults = await sessions.diffStep.run({
            xt_input: xtInputTensor,
            t: tTensor,
            cond: condTensorConst,
            xt_mask: condMaskTensorConst,
        });
        const condPredRaw = condResults['flow_pred'];
        const condPredFull = outputToFloat32(condPredRaw);
        disposeTensor(condPredRaw);

        // Slice cond target segment (skip prompt prefix)
        const condPred = new Float32Array(targetLen);
        for (let f = 0; f < totalFrames; f++) {
            const srcOff = (ptFrameCount + f) * MEL_DIM;
            const dstBase = f * MEL_DIM;
            for (let d = 0; d < MEL_DIM; d++) {
                condPred[dstBase + d] = condPredFull[srcOff + d];
            }
        }

        // === Uncond branch: xt = xtData (target only), cond = zeros, mask = ones for target ===
        const uncondXtData = new Float32Array(seqLen * MEL_DIM);
        // Place target xt at position 0 (no prompt prefix)
        for (let f = 0; f < totalFrames; f++) {
            const srcOff = f * MEL_DIM;
            const dstOff = f * MEL_DIM;
            for (let d = 0; d < MEL_DIM; d++) {
                uncondXtData[dstOff + d] = xtData[srcOff + d];
            }
        }
        const uncondXtTensor = createFloatTensor(floatType, uncondXtData, [1, seqLen, MEL_DIM]);

        // Uncond cond = zeros, mask = ones for target only
        const uncondCondData = new Float32Array(seqLen * COND_DIM); // zeros
        const uncondMaskData = new Float32Array(seqLen); // zeros
        for (let i = 0; i < totalFrames; i++) uncondMaskData[i] = 1;
        const uncondCondTensor = createFloatTensor(floatType, uncondCondData, [1, seqLen, COND_DIM]);
        const uncondMaskTensor = createFloatTensor(floatType, uncondMaskData, [1, seqLen]);

        // Reuse tTensor (same t value), just ensure t buffer has correct value
        // (already set above for cond branch; t is the same for uncond)

        const uncondResults = await sessions.diffStep.run({
            xt_input: uncondXtTensor,
            t: tTensor,
            cond: uncondCondTensor,
            xt_mask: uncondMaskTensor,
        });
        const uncondPredRaw = uncondResults['flow_pred'];
        const uncondPredFull = outputToFloat32(uncondPredRaw);
        disposeTensor(uncondPredRaw);
        disposeTensor(uncondXtTensor);
        disposeTensor(uncondCondTensor);
        disposeTensor(uncondMaskTensor);

        // Slice uncond target segment (starts at position 0, no prompt offset)
        const uncondPred = new Float32Array(targetLen);
        for (let f = 0; f < totalFrames; f++) {
            const srcOff = f * MEL_DIM;
            const dstBase = f * MEL_DIM;
            for (let d = 0; d < MEL_DIM; d++) {
                uncondPred[dstBase + d] = uncondPredFull[srcOff + d];
            }
        }

        return { condPred, uncondPred };
    }

    /**
     * Run the full diffusion sampling loop
     *
     * Task 1 (batch merge): when cfgStrength > 0, cond + uncond are merged
     *   into a single [2, seqLen, MEL_DIM] batched session.run call (was 2
     *   separate calls). Aligns DML path with webnn/diffusion.js.
     * Task 6 (tensor reuse): xtInputTensor / tTensor / cfgXtTensor / cfgTTensor
     *   are pre-allocated once before the loop and their .data buffers are
     *   rewritten each step (no per-step `new ort.Tensor`).
     * Task 7 (Welford): combine uses single-pass Welford online variance
     *   instead of three-pass sum/Var/rescale.
     *
     * @param {string} [samplerName='euler'] - 求解器名称，见 samplers/index.js
     */
    async runDiffusionLoop(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes = false, samplerName = DEFAULT_SOLVER, cfgScheduleOpts = null, dynamicThresholdOpts = null) {
        const floatType = isFP16 ? 'float16' : 'float32';
        const totalFramesWithPrompt = ptFrameCount + totalFrames;
        const seqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFramesWithPrompt;
        const useCfg = cfgStrength > 0;
        // Task 1: cond + uncond batched into a single [2, seqLen, MEL_DIM] call.
        // No-CFG path uses batch=1 (cond only).
        const diffBatch = useCfg ? 2 : 1;
        const diagnosticMode = _readDiagnosticMode();

        // Pre-check: if the model's xt_input batch dimension is fixed to 1 (all
        // current diff_step exports have batch=1), skip batch merge entirely to
        // avoid a guaranteed-to-fail first step. The model metadata shape is
        // [1, "seq_len", MEL_DIM] — batch dim = shape[0].
        let batchMergeDisabled = false;
        if (useCfg && sessions.diffStep) {
            try {
                const inputMeta = sessions.diffStep.inputMetadata;
                if (Array.isArray(inputMeta)) {
                    const xtMeta = inputMeta.find(m => m.name === 'xt_input');
                    if (xtMeta) {
                        const shape = xtMeta.shape || xtMeta.dims;
                        if (shape && shape[0] === 1) {
                            batchMergeDisabled = true;
                            console.log('[Diffusion] diff_step batch dim = 1, using separate cond/uncond calls (batch merge disabled)');
                        }
                    }
                }
            } catch (_) { /* metadata read failure — let runtime fallback handle it */ }
        }

        // 诊断：输出 diffStep session 的输入元数据（gated by diagnosticMode）
        if (diagnosticMode && sessions.diffStep) {
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

        const padFloat = (src, len) => {
            if (src.length >= len) return src;
            const padded = new Float32Array(len);
            padded.set(src);
            return padded;
        };

        // 条件分支 mask：所有 prompt+target 帧均有效
        const frameMask = new Float32Array(seqLen).fill(0);
        for (let i = 0; i < totalFramesWithPrompt; i++) frameMask[i] = 1;

        const condPadded = useStaticShapes ? padFloat(combinedCond, seqLen * COND_DIM) : combinedCond;
        const condMaskPadded = useStaticShapes ? padFloat(frameMask, seqLen) : frameMask;

        // cond 分支输入 buffer：[ptMelData | xtData]，prompt 段在循环外拷贝一次
        const xtInputBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);
        xtInputBuf.set(ptMelData, 0);

        // ===== Task 6: pre-allocate per-step tensors once, reuse .data =====
        // No-CFG (batch=1) path tensors
        const condTensorConst = createFloatTensor(floatType, condPadded, [1, seqLen, COND_DIM]);
        const condMaskTensorConst = createFloatTensor(floatType, condMaskPadded, [1, seqLen]);
        let xtInputTensor, tTensorBuf, tTensor;
        if (floatType === 'float16') {
            xtInputTensor = new ort.Tensor('float16', new Uint16Array(seqLen * MEL_DIM), [1, seqLen, MEL_DIM]);
            tTensorBuf = new Uint16Array(1);
            tTensor = new ort.Tensor('float16', tTensorBuf, [1]);
        } else {
            xtInputTensor = new ort.Tensor('float32', new Float32Array(seqLen * MEL_DIM), [1, seqLen, MEL_DIM]);
            tTensorBuf = new Float32Array(1);
            tTensor = new ort.Tensor('float32', tTensorBuf, [1]);
        }

        // ===== Task 1: CFG batch tensors (only when useCfg) =====
        // Row 0 = cond (full xt incl. prompt, cond=combinedCond, mask all ones for prompt+target)
        // Row 1 = uncond (target xt at position 0..totalFrames-1, padding zeros,
        //                  cond=zeros, mask ones for target only zeros for padding)
        // Aligns with webnn/diffusion.js lines 60-101 (DML path previously used
        // a target-only uncond seqLen which is now folded into the batch).
        let cfgXtTensor = null, cfgTTensor = null, cfgTBuf = null;
        let cfgCondTensor = null, cfgMaskTensor = null;
        let cfgBatchBuf = null, cfgPredBuf = null;
        if (useCfg) {
            cfgBatchBuf = new Float32Array(diffBatch * seqLen * MEL_DIM);
            cfgPredBuf = new Float32Array(totalFrames * MEL_DIM);
            const cfgCondBuf = new Float32Array(diffBatch * seqLen * COND_DIM);
            const cfgMaskBuf = new Float32Array(diffBatch * seqLen);
            // Row 0 (cond): combinedCond + mask all ones for prompt+target
            cfgCondBuf.set(condPadded, 0);
            cfgMaskBuf.fill(1, 0, totalFramesWithPrompt);
            // Row 1 (uncond): cond zeros (already zero), mask ones for target only
            cfgMaskBuf.fill(1, seqLen, seqLen + totalFrames);
            // (positions seqLen+totalFrames .. 2*seqLen-1 remain 0, padding)

            cfgCondTensor = createFloatTensor(floatType, cfgCondBuf, [diffBatch, seqLen, COND_DIM]);
            cfgMaskTensor = createFloatTensor(floatType, cfgMaskBuf, [diffBatch, seqLen]);

            if (floatType === 'float16') {
                cfgXtTensor = new ort.Tensor('float16', new Uint16Array(diffBatch * seqLen * MEL_DIM), [diffBatch, seqLen, MEL_DIM]);
                cfgTBuf = new Uint16Array(diffBatch);
                cfgTTensor = new ort.Tensor('float16', cfgTBuf, [diffBatch]);
            } else {
                cfgXtTensor = new ort.Tensor('float32', cfgBatchBuf, [diffBatch, seqLen, MEL_DIM]);
                cfgTBuf = new Float32Array(diffBatch);
                cfgTTensor = new ort.Tensor('float32', cfgTBuf, [diffBatch]);
            }
        }

        const _disposeAllTensors = () => {
            disposeTensor(condTensorConst);
            disposeTensor(condMaskTensorConst);
            disposeTensor(xtInputTensor);
            disposeTensor(tTensor);
            if (cfgXtTensor) disposeTensor(cfgXtTensor);
            if (cfgTTensor) disposeTensor(cfgTTensor);
            if (cfgCondTensor) disposeTensor(cfgCondTensor);
            if (cfgMaskTensor) disposeTensor(cfgMaskTensor);
        };

        const progressPerStep = progressRange / totalSteps;

        // ===== 求解器抽象 =====
        // evalDiffStep(t, xtOverride?): 执行 cond + (可选)uncond 推理，返回独立副本
        // combine(condPred, uncondPred): CFG + Rescale 合并，写入 vBuf（复用），返回 vBuf 引用
        // sampler.step 将 delta 写入 deltaBuf（复用），调用方累加到 xt.data
        // 注：每次 runDiffusionLoop 新建 sampler 实例。Extrapolated Euler 的跨步 v_prev
        // 缓存在 chunk 边界会丢失（分块路径每 chunk 新建），退化为局部 Euler，不影响正确性。
        const sampler = createSampler(samplerName);

        // 预分配复用缓冲区（跨步复用，0 per-step 分配）
        const targetLen = totalFrames * MEL_DIM;
        const buffers = {
            vBuf: new Float32Array(targetLen),     // combine 输出
            deltaBuf: new Float32Array(targetLen),  // sampler delta 输出
            v1Buf: new Float32Array(targetLen),     // Heun 保存 v1
            xPredBuf: new Float32Array(targetLen),  // Heun 预测状态
        };

        // evalDiffStep: 执行 cond + (可选)uncond 推理，返回 {condPred, uncondPred}
        // xtOverride 可选：用于多步评估求解器（如 Heun）的预测子步骤，覆盖默认 xt.data
        //
        // Task 1: when useCfg, cond + uncond are merged into a single
        // [2, seqLen, MEL_DIM] batched session.run call (halves NFE session
        // calls). When !useCfg, batch=1 cond-only path is used.
        // Fallback: if the model rejects batch>1 (invalid dimensions), falls
        // back to two separate batch=1 calls for all subsequent steps.
        const evalDiffStep = async (t, xtOverride) => {
            const xtData = xtOverride || xt.data;
            // cond 分支：xtInputBuf = [ptMelData | xtData]
            xtInputBuf.set(xtData, ptFrameCount * MEL_DIM);

            if (useCfg) {
                // === Fallback path: separate cond/uncond calls (batch=1) ===
                // Used when the model rejects batch>1 (e.g. static-shape _dml.onnx
                // with batch dim fixed to 1). Each call is [1, seqLen, MEL_DIM].
                if (batchMergeDisabled) {
                    return await this._evalDiffStepSeparate(
                        sessions, xtInputBuf, xtData, t, floatType,
                        xtInputTensor, tTensorBuf, tTensor,
                        condTensorConst, condMaskTensorConst,
                        ptFrameCount, totalFrames, seqLen, targetLen);
                }

                // === Task 1: CFG batched call ===
                // Fill cfgBatchBuf: row 0 = xtInputBuf (prompt+target), row 1 = target xt at pos 0
                cfgBatchBuf.fill(0);
                cfgBatchBuf.set(xtInputBuf, 0);  // row 0: full xt (prompt + target)
                const row1Off = seqLen * MEL_DIM;
                for (let f = 0; f < totalFrames; f++) {
                    const srcOff = f * MEL_DIM;
                    const dstOff = row1Off + f * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        cfgBatchBuf[dstOff + d] = xtData[srcOff + d];
                    }
                }
                // Write t into pre-allocated t buffer
                if (floatType === 'float16') {
                    batchFloat32ToFloat16(cfgBatchBuf, cfgXtTensor.data, cfgBatchBuf.length);
                    cfgTBuf[0] = float32ToFloat16(t);
                    cfgTBuf[1] = float32ToFloat16(t);
                } else {
                    // FP32: cfgXtTensor.data aliases cfgBatchBuf (same buffer);
                    // tBuf is Float32Array, just fill.
                    cfgTBuf[0] = t;
                    cfgTBuf[1] = t;
                }

                let batchResults;
                try {
                    batchResults = await sessions.diffStep.run({
                        xt_input: cfgXtTensor,
                        t: cfgTTensor,
                        cond: cfgCondTensor,
                        xt_mask: cfgMaskTensor,
                    });
                } catch (err) {
                    // Model rejects batch>1 (e.g. static-shape variant with batch dim = 1).
                    // Fall back to separate cond/uncond calls for this and all future steps.
                    if (err.message && err.message.includes('invalid dimensions')) {
                        console.warn('[Diffusion] Model rejected batch>1 (batch merge disabled), falling back to separate calls:', err.message.split('\n')[0]);
                        batchMergeDisabled = true;
                        return await this._evalDiffStepSeparate(
                            sessions, xtInputBuf, xtData, t, floatType,
                            xtInputTensor, tTensorBuf, tTensor,
                            condTensorConst, condMaskTensorConst,
                            ptFrameCount, totalFrames, seqLen, targetLen);
                    }
                    throw err;
                }
                const batchPredRaw = batchResults['flow_pred'];
                const batchPred = outputToFloat32(batchPredRaw);
                // outputToFloat32 returns a fresh Float32Array; safe to dispose source now
                disposeTensor(batchPredRaw);

                // Split batchPred [diffBatch, seqLen, MEL_DIM] into cond + uncond target slices.
                // Row 0 (cond): target at positions ptFrameCount..ptFrameCount+totalFrames-1
                // Row 1 (uncond): target at positions 0..totalFrames-1 (no prompt offset)
                const condPred = new Float32Array(targetLen);
                const uncondPred = new Float32Array(targetLen);
                for (let f = 0; f < totalFrames; f++) {
                    const condSrc = (ptFrameCount + f) * MEL_DIM;
                    const uncondSrc = (seqLen + f) * MEL_DIM;
                    const dstBase = f * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        condPred[dstBase + d] = batchPred[condSrc + d];
                        uncondPred[dstBase + d] = batchPred[uncondSrc + d];
                    }
                }
                return { condPred, uncondPred };
            }

            // === No-CFG: batch=1 cond-only call (Task 6 pre-allocated tensors) ===
            if (floatType === 'float16') {
                batchFloat32ToFloat16(xtInputBuf, xtInputTensor.data, xtInputBuf.length);
                tTensorBuf[0] = float32ToFloat16(t);
            } else {
                // FP32: xtInputTensor.data is a fresh Float32Array buffer; copy xtInputBuf in
                xtInputTensor.data.set(xtInputBuf);
                tTensorBuf[0] = t;
            }

            let results;
            try {
                results = await sessions.diffStep.run({
                    xt_input: xtInputTensor,
                    t: tTensor,
                    cond: condTensorConst,
                    xt_mask: condMaskTensorConst,
                });
            } catch (err) {
                throw err;
            }
            const predRaw = results['flow_pred'];
            const pred = outputToFloat32(predRaw);
            disposeTensor(predRaw);

            // Slice target segment (skip prompt prefix)
            const condPred = new Float32Array(targetLen);
            for (let f = 0; f < totalFrames; f++) {
                const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                const dstBase = f * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    condPred[dstBase + d] = pred[tgtOffset + d];
                }
            }
            return { condPred, uncondPred: null };
        };

        // combine: CFG + Rescale 合并，写入 vBuf（复用），返回 vBuf 引用
        // 无 CFG 时直接拷贝 cond 分支 target 段到 vBuf。
        // 有 CFG 时使用 single-pass Welford online variance（Task 7）：
        //   Pass 1: 计算 cfgVal → cfgPredBuf，同时 Welford 累加 posMean/posM2 + cfgAdjMean/cfgAdjM2
        //   Pass 2: 用 Welford 最终值算 std/rescale，写入 vBuf
        // 数值与原 three-pass 实现在 1e-7 内一致（Bessel 校正 N-1 分母）。
        //
        // Task 11: 当 cfgScheduleOpts 提供（非 null）时，按 currentStep 调用
        // resolveCfgAtStep 取有效 CFG 值替代固定 cfgStrength。constant 模式
        // 直接返回 cfgStrength（字节级一致，无浮点误差）；linear/cosine/custom
        // 按 step 动态调整。cfgScheduleOpts 为 null 时行为与改造前完全一致。
        let currentStep = 0;
        const combine = (condPred, uncondPred, stepOverride, totalStepsOverride) => {
            const v = buffers.vBuf;
            if (!useCfg) {
                // 无 CFG：condPred 已是 target 段（evalDiffStep 切片过），直接拷贝
                v.set(condPred);
                return v;
            }
            // Task 11: resolve effective CFG for this step (constant = cfgStrength, byte-identical)
            // M3: allow step/totalSteps override so SDEdit repair steps use the
            // repair loop's step index instead of the stale main-loop currentStep.
            const effStep = stepOverride != null ? stepOverride : currentStep;
            const effTotal = totalStepsOverride != null ? totalStepsOverride : totalSteps;
            const effectiveCfg = cfgScheduleOpts
                ? resolveCfgAtStep({ ...cfgScheduleOpts, cfgStrength, step: effStep, totalSteps: effTotal })
                : cfgStrength;
            // Pass 1: cfgVal → cfgPredBuf, Welford accumulate posMean/posM2 + cfgAdjMean/cfgAdjM2
            let posMean = 0, posM2 = 0;
            let cfgAdjMean = 0, cfgAdjM2 = 0;
            let n = 0;
            for (let i = 0; i < targetLen; i++) {
                const condVal = condPred[i];
                const uncondVal = uncondPred[i];
                const cfgVal = condVal + effectiveCfg * (condVal - uncondVal);
                cfgPredBuf[i] = cfgVal;
                n++;
                // Welford for posMean/posM2 (on condVal)
                const posDelta = condVal - posMean;
                posMean += posDelta / n;
                posM2 += posDelta * (condVal - posMean);
                // Welford for cfgAdjMean/cfgAdjM2 (on cfgVal)
                const cfgDelta = cfgVal - cfgAdjMean;
                cfgAdjMean += cfgDelta / n;
                cfgAdjM2 += cfgDelta * (cfgVal - cfgAdjMean);
            }
            // Dynamic thresholding (arXiv:2507.08965): clip extreme CFG values
            // per-frame before rescale. Prevents over-exposure artifacts from
            // large cond-uncond divergence at high CFG strengths.
            if (dynamicThresholdOpts && dynamicThresholdOpts.percentile > 0) {
                applyDynamicThreshold(cfgPredBuf, targetLen, MEL_DIM, dynamicThresholdOpts.percentile);
            }
            // Pass 2: std/rescale + write vBuf
            // Bessel 校正（N-1 分母），对齐 PyTorch torch.std() 与原 two-pass 实现
            const posStd = Math.sqrt(Math.max(0, posM2) / Math.max(1, n - 1));
            const cfgAdjStd = Math.sqrt(Math.max(0, cfgAdjM2) / Math.max(1, n - 1));
            const rescale = posStd / (cfgAdjStd + 1e-8);
            for (let i = 0; i < targetLen; i++) {
                const cfgVal = cfgPredBuf[i];
                v[i] = cfgRescale * (cfgVal * rescale) + (1 - cfgRescale) * cfgVal;
            }
            return v;
        };

        try {
            let totalNFE = 0;
            for (let step = 0; step < totalSteps; step++) {
                currentStep = step;
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

                const currentProgress = progressStart + (step + 1) * progressPerStep;
                onProgress(Math.min(Math.round(currentProgress), 90));
                // GPU 排空：每 8 步用 setTimeout(20) 代替 setImmediate，给 DML 后端 20ms 时间
                // 回收内部 GPU 资源池中的 transformer 注意力中间张量。
                if (step % 8 === 7) {
                    await new Promise(r => setTimeout(r, 20));
                } else if (totalFrames > 256) {
                    // 长片段每步 yield：combine 的全数组遍历（256k+ 迭代）
                    // 会阻塞主线程，需要 setImmediate yield。
                    await new Promise(r => setImmediate(r));
                }
            }
            // Task 17: SDEdit local repair (default false via settings). When
            // enabled, detect mel frames with NaN or energy > median × 5 and
            // re-denoise those regions with shallow noise (t=0.3) + 5 STORK-2
            // steps, blending repaired frames with original via Hann crossfade.
            // When disabled (default), this is a no-op (zero overhead).
            if (_readSDEditRepair()) {
                await this._sdeditRepair({
                    sessions, xt, totalFrames, ptMelData, ptFrameCount,
                    combinedCond, cfgStrength, cfgRescale, isFP16, useStaticShapes,
                    evalDiffStep, combine, buffers, diagnosticMode,
                });
            }
            // 诊断：检测扩散输出是否包含 NaN/Inf + 统计输出分布（gated by diagnosticMode）
            // NaN/Inf 致命错误 console.error 始终输出（always-on），不受 diagnosticMode 影响。
            {
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
                if (diagnosticMode) {
                    console.log(`[DiffusionDiag] OUTPUT xt: frames=${totalFrames}, len=${xtLen}, NaN=${xtNaN}, Inf=${xtInf}, min=${xtMin.toFixed(6)}, max=${xtMax.toFixed(6)}, mean=${xtMean.toFixed(6)}, std=${xtStd.toFixed(6)}, nfe=${totalNFE}`);
                }
                if (xtNaN > 0 || xtInf > 0) {
                    console.error(`[DiffusionDiag] DIFFUSION OUTPUT HAS NaN/Inf! NaN=${xtNaN}, Inf=${xtInf - xtNaN}, total=${xtLen}, frames=${totalFrames}, mean=${xtMean.toFixed(6)}`);

                    // Dump ORT native debug logs from stderr capture
                    if (typeof globalThis._flushOrtDebugLogs === 'function') {
                        globalThis._flushOrtDebugLogs();
                    }
                }
            }
        } finally {
            // Task 6: dispose all pre-allocated tensors on exit (success or exception)
            _disposeAllTensors();
        }
    }

    /**
     * Task 17: SDEdit 局部修复。
     *
     * 在 runDiffusionLoop 主循环结束后调用（仅当 settings.enableSDEditRepair=true）。
     * 检测 mel 局部异常帧（NaN/Inf 或帧能量 > 中位数 ×5），对每个异常区间：
     *   1. 保存原始 mel（用于边界交叉淡入淡出）
     *   2. 加浅噪声重噪到 t=0.3 水平：xt = 0.7*x0 + 0.3*noise
     *   3. 用 STORK-2 求解器运行 5 步重采样
     *   4. 仅更新异常区间帧，边界用 Hann 窗交叉淡入淡出平滑过渡
     *
     * 复用 runDiffusionLoop 闭包内的 evalDiffStep / combine / buffers，无需重建张量。
     * 默认 false 时此方法不被调用（零开销）。
     *
     * @param {Object} ctx - runDiffusionLoop 内部闭包与参数
     * @private
     */
    async _sdeditRepair(ctx) {
        const { xt, totalFrames, evalDiffStep, combine, buffers, diagnosticMode } = ctx;
        const REPAIR_STEPS = 5;
        const REPAIR_T0 = 0.3;            // shallow noise level
        const ENERGY_SPIKE_FACTOR = 5.0;  // frame energy > median × 5 = anomaly
        const CROSSFADE_PAD = 3;          // frames to pad each side for Hann blend

        const xtData = xt.data;
        const targetLen = totalFrames * MEL_DIM;

        // 1. 计算每帧能量，标记 NaN/Inf 帧
        const frameEnergy = new Float32Array(totalFrames);
        for (let f = 0; f < totalFrames; f++) {
            let sum = 0;
            let frameBad = false;
            const base = f * MEL_DIM;
            for (let d = 0; d < MEL_DIM; d++) {
                const v = xtData[base + d];
                if (!Number.isFinite(v)) { frameBad = true; break; }
                sum += v * v;
            }
            frameEnergy[f] = frameBad ? Infinity : sum;
        }

        // 2. 计算中位数能量（排除异常帧）
        const validEnergies = [];
        for (let f = 0; f < totalFrames; f++) {
            if (Number.isFinite(frameEnergy[f])) validEnergies.push(frameEnergy[f]);
        }
        if (validEnergies.length === 0) return; // 全部 NaN，无法修复
        validEnergies.sort((a, b) => a - b);
        const median = validEnergies[Math.floor(validEnergies.length / 2)];

        // 3. 标记异常帧
        const threshold = median * ENERGY_SPIKE_FACTOR;
        const isAnomalous = new Uint8Array(totalFrames);
        let anomalyCount = 0;
        for (let f = 0; f < totalFrames; f++) {
            if (!Number.isFinite(frameEnergy[f]) || frameEnergy[f] > threshold) {
                isAnomalous[f] = 1;
                anomalyCount++;
            }
        }
        if (anomalyCount === 0) return; // 无异常，跳过修复

        if (diagnosticMode) {
            console.log(`[DiffusionDiag] SDEdit repair: ${anomalyCount}/${totalFrames} anomalous frames, median=${median.toFixed(4)}, threshold=${threshold.toFixed(4)}`);
        }

        // 4. 将连续异常帧分组成区间（含 CROSSFADE_PAD 帧边距用于 Hann 混合）
        const regions = [];
        let regionStart = -1;
        for (let f = 0; f <= totalFrames; f++) {
            if (f < totalFrames && isAnomalous[f]) {
                if (regionStart < 0) regionStart = f;
            } else if (regionStart >= 0) {
                const coreEnd = f;
                const paddedStart = Math.max(0, regionStart - CROSSFADE_PAD);
                const paddedEnd = Math.min(totalFrames, coreEnd + CROSSFADE_PAD);
                regions.push({ start: paddedStart, end: paddedEnd, coreStart: regionStart, coreEnd });
                regionStart = -1;
            }
        }
        if (regions.length === 0) return;

        // 5. 对每个区间：保存原始 mel → 加浅噪声 → 5 步 STORK-2 重采样 → Hann 混合
        const repairSampler = createSampler('stork2');
        const originalBuf = new Float32Array(targetLen);

        for (const region of regions) {
            const { start, end, coreStart, coreEnd } = region;

            // 保存原始 mel（含边距），用于后续 Hann 混合。
            // NaN/Inf 帧归零保存，否则 Hann 混合时 (1-weight)*NaN = NaN 会传播。
            const regionBytes = (end - start) * MEL_DIM;
            const regionOffset = start * MEL_DIM;
            for (let i = regionOffset; i < regionOffset + regionBytes; i++) {
                originalBuf[i] = Number.isFinite(xtData[i]) ? xtData[i] : 0;
            }

            // 加浅噪声到 t=0.3 水平：xt = (1-t)*x0 + t*noise = 0.7*x0 + 0.3*noise
            // NaN/Inf 帧需先归零（否则 0.7*NaN = NaN 会传播），用 0 作为 x0 重噪。
            const sqrtOneMinusT = Math.sqrt(1 - REPAIR_T0);
            const sqrtT = Math.sqrt(REPAIR_T0);
            for (let i = regionOffset; i < regionOffset + regionBytes; i++) {
                const x0 = Number.isFinite(xtData[i]) ? xtData[i] : 0;
                const noise = Math.random() * 2 - 1;
                xtData[i] = sqrtOneMinusT * x0 + sqrtT * noise;
            }

            // 5 步 STORK-2 重采样：仅更新区间内帧
            // M3: repairCombine forwards step/REPAIR_STEPS to combine so the CFG
            // schedule resolves against the repair loop's 0..4/5 progress instead
            // of the stale main-loop currentStep (totalSteps-1)/totalSteps.
            for (let step = 0; step < REPAIR_STEPS; step++) {
                const repairCombine = (condPred, uncondPred) => combine(condPred, uncondPred, step, REPAIR_STEPS);
                await repairSampler.step({
                    evalDiffStep, combine: repairCombine, step, totalSteps: REPAIR_STEPS,
                    xtData: xt.data, buffers,
                });
                const delta = buffers.deltaBuf;
                // 仅对区间内帧累加 delta（区间外帧保持不变）
                for (let f = start; f < end; f++) {
                    const base = f * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        xtData[base + d] += delta[base + d];
                    }
                }
            }

            // Hann 窗交叉淡入淡出：核心区用修复后值，边距区平滑过渡到原始值
            for (let f = start; f < end; f++) {
                let weight; // 1 = 修复后, 0 = 原始
                if (f >= coreStart && f < coreEnd) {
                    weight = 1.0;
                } else if (f < coreStart) {
                    const t = (f - start) / Math.max(1, coreStart - start);
                    weight = 0.5 * (1 - Math.cos(Math.PI * t));
                } else {
                    const t = (f - coreEnd) / Math.max(1, end - coreEnd);
                    weight = 0.5 * (1 + Math.cos(Math.PI * t));
                }
                const base = f * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    const idx = base + d;
                    xtData[idx] = weight * xtData[idx] + (1 - weight) * originalBuf[idx];
                }
            }
        }

        if (diagnosticMode) {
            let postNaN = 0;
            for (let i = 0; i < targetLen; i++) {
                if (Number.isNaN(xtData[i])) postNaN++;
            }
            console.log(`[DiffusionDiag] SDEdit repair complete: ${regions.length} regions, post-repair NaN=${postNaN}`);
        }
    }

    /**
     * 分块扩散推理：将目标帧分块，每块独立运行完整扩散循环后交叉淡入淡出拼接。
     *
     * 注意力复杂度 O(n²)，分块后总计算量 N×(pt+chunk)² 通常小于 (pt+total)²，
     * 对长片段预览有显著加速；代价是块边界处可能产生轻微伪影（由 overlap 交叉淡入淡出缓解）。
     * 每块均以 prompt mel 为前缀，保证音色/风格上下文一致。
     *
     * 仅用于预览路径（由 _runDiffusionLoop 在 previewDiffStepChunkEnabled 时调用）。
     * useStaticShapes（NPU 固定形状）路径不适用分块（每块仍 pad 到 NPU_STATIC_SEQ_LEN，
     * 无计算量收益），调用方应在该路径下跳过分块。
     *
     * @param {Object} sessions
     * @param {{data: Float32Array, dims: number[]}} xt - 噪声容器，分块结果最终写回 xt.data
     * @param {number} totalFrames - 目标帧数（不含 prompt）
     * @param {Float32Array} ptMelData - prompt mel 数据
     * @param {number} ptFrameCount - prompt 帧数
     * @param {Float32Array} combinedCond - 完整条件向量 (ptFrameCount+totalFrames)*COND_DIM
     * @param {number} totalSteps
     * @param {number} cfgStrength
     * @param {number} cfgRescale
     * @param {boolean} isFP16
     * @param {Function} onProgress
     * @param {number} progressStart
     * @param {number} progressRange
     * @param {boolean} useStaticShapes
     * @param {number} chunkFrames - 分块大小（帧）
     * @param {number} overlapFrames - 分块间重叠（帧）
     * @param {Function} [onChunkMel] - 流式回调：每块完成且 mel 已确定后调用，用于立即运行 vocoder
     *   签名: async ({chunkIndex, frameStart, frameEnd, melData, isLast}) => {}
     *   frameStart/frameEnd 为已确定帧在完整 mel 中的绝对位置；melData 为该段 mel 副本
     */

    /**
     * 计算分块边界与 Hann 窗。
     * 返回 null 表示无需分块（chunkFrames >= totalFrames 或 totalFrames <= 0）。
     *
     * Task 15: 当提供 f0Slope（每帧 F0 斜率数组）时，在安全重叠区
     *   [chunkStart + minBeats, chunkStart + maxBeats]
     * 内选择 |f0Slope[boundary]| 最小的位置作为 chunkEnd，避开 F0 斜率突变处
     * （颤音起止、音符转换）切分，减少边界伪影（RDSinger arXiv:2410.21641 启发）。
     * f0Slope 为 null/undefined 或长度不足（out-of-range）时回退到固定 safeChunk
     * 逻辑，行为与改造前完全一致。
     *
     * @param {number} totalFrames
     * @param {number} chunkFrames
     * @param {number} overlapFrames
     * @param {Float32Array|number[]|null} [f0Slope=null] - per-frame F0 slope (f0[i+1]-f0[i])
     * @returns {{specs: Array, overlap: number}|null}
     */
    _planChunks(totalFrames, chunkFrames, overlapFrames, f0Slope = null) {
        // 防御：totalFrames <= 0 时直接返回 null，由调用方短路处理
        if (!Number.isFinite(totalFrames) || totalFrames <= 0) return null;
        const safeChunk = Math.max(50, Math.floor(chunkFrames));
        let safeOverlap = Math.max(0, Math.floor(overlapFrames));
        if (safeOverlap >= safeChunk) safeOverlap = Math.floor(safeChunk / 2);
        if (safeChunk >= totalFrames) return null;
        // safeOverlap === 0 时无交叉淡入淡出
        if (safeOverlap < 1) safeOverlap = 0;

        // Task 15: F0-aware boundary selection setup.
        // hasF0 requires f0Slope to cover the full totalFrames range so every
        // candidate boundary index is in-range; otherwise fall back to fixed
        // safeChunk (no behavior change).
        const hasF0 = !!(f0Slope && f0Slope.length >= totalFrames);
        // Safe overlap zone: chunk size may vary by up to ±safeOverlap around
        // safeChunk (clamped to [75%, 125%] of safeChunk to avoid degenerate
        // chunks). When safeOverlap = 0 the zone collapses and no search runs.
        const minBeats = hasF0
            ? Math.max(Math.floor(safeChunk * 0.75), safeChunk - safeOverlap)
            : safeChunk;
        const maxBeats = hasF0
            ? Math.min(safeChunk + safeOverlap, Math.floor(safeChunk * 1.25))
            : safeChunk;
        const canSearch = hasF0 && maxBeats > minBeats;

        const specs = [];
        let framePos = 0;
        let chunkIdx = 0;
        while (framePos < totalFrames) {
            const isFirst = chunkIdx === 0;
            const chunkStart = isFirst ? 0 : Math.max(0, framePos - safeOverlap);
            const defaultChunkEnd = Math.min(chunkStart + safeChunk, totalFrames);
            const isLast = defaultChunkEnd >= totalFrames;
            let chunkEnd;
            if (isLast) {
                chunkEnd = totalFrames;
            } else if (canSearch) {
                // Task 15: search [chunkStart + minBeats, chunkStart + maxBeats]
                // for the boundary with smallest |f0Slope[boundary]|.
                const lo = Math.max(chunkStart + minBeats, chunkStart + 1);
                const hi = Math.min(chunkStart + maxBeats, totalFrames - 1);
                let bestBoundary = defaultChunkEnd;
                let bestSlope = Infinity;
                for (let b = lo; b <= hi; b++) {
                    if (b < 0 || b >= f0Slope.length) continue;
                    const s = Math.abs(f0Slope[b]);
                    if (s < bestSlope) {
                        bestSlope = s;
                        bestBoundary = b;
                    }
                }
                chunkEnd = bestBoundary;
            } else {
                chunkEnd = defaultChunkEnd;
            }
            const currentChunkFrames = chunkEnd - chunkStart;
            const finalIsLast = chunkEnd >= totalFrames;
            specs.push({ chunkStart, chunkEnd, currentChunkFrames, isFirst, isLast: finalIsLast });
            if (finalIsLast) break;
            framePos = chunkEnd;
            chunkIdx++;
        }

        return { specs, overlap: safeOverlap };
    }

    /**
     * 执行单个分块的扩散推理（提取噪声 → 完整扩散循环 → Hann 交叉淡入淡出写回）。
     * 可独立调用，供多分片时间交错流式编排器按时间顺序逐块调用。
     *
     * @param {Object} ctx - 分块上下文（由调用方持有，跨块共享 xt.data 状态）
     *   { sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond,
     *     totalSteps, cfgStrength, cfgRescale, isFP16, useStaticShapes, overlap }
     * @param {Object} spec - 分块规格 { chunkStart, chunkEnd, currentChunkFrames, isFirst, isLast }
     * @param {Function} onProgress
     * @param {number} progressStart
     * @param {number} progressRange
     * @returns {Promise<{newCommitted: number}>} 本块完成后新确定的帧数（不含重叠区，末尾块为 chunkEnd）
     */
    async _runSingleDiffusionChunk(ctx, spec, onProgress, progressStart, progressRange) {
        const { sessions, xt, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, useStaticShapes, overlap, cfgScheduleOpts, dynamicThresholdOpts } = ctx;
        const { chunkStart, chunkEnd, currentChunkFrames, isFirst, isLast } = spec;
        const xtOut = xt.data;

        // 1. 提取当前块的噪声
        const chunkNoise = new Float32Array(currentChunkFrames * MEL_DIM);
        chunkNoise.set(xtOut.subarray(chunkStart * MEL_DIM, chunkEnd * MEL_DIM));
        const subXt = { data: chunkNoise, dims: [1, currentChunkFrames, MEL_DIM] };

        // 2. 构建当前块的条件向量
        const promptCondBytes = ptFrameCount * COND_DIM;
        const chunkTargetCondBytes = currentChunkFrames * COND_DIM;
        const chunkCondStart = (ptFrameCount + chunkStart) * COND_DIM;
        const chunkCondEnd = chunkCondStart + chunkTargetCondBytes;
        const chunkCond = new Float32Array(promptCondBytes + chunkTargetCondBytes);
        chunkCond.set(combinedCond.subarray(0, promptCondBytes), 0);
        chunkCond.set(combinedCond.subarray(chunkCondStart, chunkCondEnd), promptCondBytes);

        // 3. 运行完整扩散循环
        // 子进度直接透传：onProgress 已被外层映射到本 chunk 的 [progressStart, progressStart+progressRange] 区间，
        // 不再截断到 90，避免 32 步 diffusion 期间进度条停滞。
        const chunkOnProgress = (p) => {
            if (onProgress) onProgress(Math.round(p));
        };
        await this.runDiffusionLoop(
            sessions, subXt, currentChunkFrames, ptMelData, ptFrameCount,
            chunkCond, totalSteps, cfgStrength, cfgRescale, isFP16,
            chunkOnProgress, progressStart, progressRange, useStaticShapes, ctx.samplerName, cfgScheduleOpts, dynamicThresholdOpts
        );

        // 4. WSOLA mel 域交叉淡入淡出写回（取代对称 Hann 加权混合）
        if (isFirst) {
            // 首 chunk：无前序数据，直接整段 memcpy
            xtOut.set(subXt.data.subarray(0, currentChunkFrames * MEL_DIM), chunkStart * MEL_DIM);
        } else {
            // WSOLA mel 域交叉淡入淡出：prevTailMel 为已提交的前一 chunk 尾部 mel，
            // currHeadMel 为当前 chunk 头部 mel，按帧用余弦相似度对齐后 Hann OLA，
            // 消除有音高信号在 chunk 边界的 flanging/梳状滤波。
            const actualOv = Math.min(overlap, currentChunkFrames);
            if (actualOv > 0) {
                const prevTailMel = xtOut.subarray(chunkStart * MEL_DIM, (chunkStart + actualOv) * MEL_DIM);
                const currHeadMel = subXt.data.subarray(0, actualOv * MEL_DIM);
                const wsolaMel = wsolaCrossfadeMel(prevTailMel, currHeadMel, actualOv, MEL_DIM);
                xtOut.set(wsolaMel, chunkStart * MEL_DIM);
            }
            // 非重叠区：用 TypedArray.set 走 memcpy，比逐元素快 2-3 倍
            const nonOverlapStart = actualOv * MEL_DIM;
            const nonOverlapLen = (currentChunkFrames - actualOv) * MEL_DIM;
            if (nonOverlapLen > 0) {
                xtOut.set(
                    subXt.data.subarray(nonOverlapStart, nonOverlapStart + nonOverlapLen),
                    (chunkStart + actualOv) * MEL_DIM
                );
            }
        }

        // 5. GPU 排空（自适应：正常 setImmediate yield，OOM 后 200ms 长等待）
        await gpuDrainAdaptive();

        // 6. 计算 committed 帧数
        const newCommitted = isLast ? chunkEnd : Math.max(0, chunkEnd - overlap);
        return { newCommitted };
    }

    async runDiffusionLoopChunked(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes, chunkFrames, overlapFrames, onChunkMel = null, samplerName = DEFAULT_SOLVER, pitchCurveF0 = null, cfgScheduleOpts = null, dynamicThresholdOpts = null) {
        // Task 15: compute per-frame F0 slope from pitchCurveF0 for F0-aware
        // chunk boundary selection. f0Slope[i] = f0[i+1] - f0[i], with 0 at the
        // last index. When pitchCurveF0 is null/undefined or too short, f0Slope
        // is null and _planChunks falls back to fixed safeChunk (no change).
        let f0Slope = null;
        if (pitchCurveF0 && pitchCurveF0.length >= 2) {
            f0Slope = new Float32Array(pitchCurveF0.length);
            for (let i = 0; i < pitchCurveF0.length - 1; i++) {
                f0Slope[i] = pitchCurveF0[i + 1] - pitchCurveF0[i];
            }
            f0Slope[pitchCurveF0.length - 1] = 0;
        }

        // 分块规划
        const plan = this._planChunks(totalFrames, chunkFrames, overlapFrames, f0Slope);
        if (!plan) {
            // 无需分块，直接整段推理
            return this.runDiffusionLoop(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes, samplerName, cfgScheduleOpts, dynamicThresholdOpts);
        }

        const { specs, overlap } = plan;
        const totalChunks = specs.length;
        console.log(`[DiffusionChunk] Chunked diffusion: totalFrames=${totalFrames}, ptFrameCount=${ptFrameCount}, chunkFrames=${chunkFrames}, overlap=${overlap}, steps=${totalSteps}, chunks=${totalChunks}, sampler=${samplerName}`);

        const ctx = { sessions, xt, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, useStaticShapes, overlap, samplerName, cfgScheduleOpts, dynamicThresholdOpts };
        const progressPerChunk = progressRange / totalChunks;
        let committedFrames = 0;

        try {
            for (let ci = 0; ci < totalChunks; ci++) {
                const spec = specs[ci];
                console.log(`[DiffusionChunk] chunk ${ci}/${totalChunks}: frames[${spec.chunkStart},${spec.chunkEnd})=${spec.currentChunkFrames}frames`);

                const { newCommitted } = await this._runSingleDiffusionChunk(
                    ctx, spec, onProgress,
                    progressStart + ci * progressPerChunk, progressPerChunk
                );

                // 流式回调：推送已确定的 mel 片段
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

        console.log(`[DiffusionChunk] Chunked diffusion complete: ${totalChunks} chunks, ${totalFrames} frames`);
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
