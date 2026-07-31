const { MEL_DIM, COND_DIM, NPU_STATIC_SEQ_LEN } = require('./constants');
const { createFloatTensor, outputToFloat32, disposeTensor, gpuDrain } = require('./utils');
const { createSampler } = require('./samplers');
const { wsolaBestLag } = require('./postprocessing');

/**
 * Diagnostic mode gate. When false (default in production), all per-chunk /
 * per-step NaN/Inf/min/max/mean/std console.log diagnostics are skipped to
 * avoid the ~5ms-per-chunk JS overhead + console I/O on long audio.
 * Set via setDiagnosticMode(true) from settings.
 */
let _diagnosticMode = false;
function setDiagnosticMode(enabled) {
    _diagnosticMode = !!enabled;
}
function isDiagnosticMode() {
    return _diagnosticMode;
}

/**
 * Adaptive GPU drain state. Tracks recent OOM events to lengthen drain
 * when the device is under pressure, and skip drain when healthy.
 */
let _recentOomCount = 0;
let _lastOomTime = 0;
const OOM_BACKOFF_WINDOW_MS = 60000; // 1 minute
const OOM_BACKOFF_DRAIN_MS = 120;    // lengthened drain after OOM

function noteOomEvent() {
    _recentOomCount++;
    _lastOomTime = Date.now();
}

/**
 * Adaptive gpuDrain: skip when no recent OOM, lengthen after OOM.
 * Falls back to the default 50ms gpuDrain when healthy to preserve the
 * existing safety margin for DML resource reclamation.
 */
async function adaptiveGpuDrain(defaultMs = 50) {
    const now = Date.now();
    if (_recentOomCount > 0 && (now - _lastOomTime) < OOM_BACKOFF_WINDOW_MS) {
        await new Promise(r => setTimeout(r, OOM_BACKOFF_DRAIN_MS));
        return;
    }
    // Decay counter after the backoff window.
    if (_recentOomCount > 0 && (now - _lastOomTime) >= OOM_BACKOFF_WINDOW_MS) {
        _recentOomCount = 0;
    }
    await new Promise(r => setTimeout(r, defaultMs));
}

/**
 * Resolve CFG strength at a given step using a schedule.
 *
 * Supported modes (inference-only, zero training):
 *   - 'fixed'   : constant cfgStrength (legacy behaviour)
 *   - 'linear'  : linear low→high ramp (default; A-CFG / dynamic-CFG style)
 *   - 'cosine'  : cosine low→high ramp (smoother transition)
 *
 * Low→high scheduling reduces over-exposure / over-articulation artifacts
 * in SVS (per A-CFG NeurIPS 2025 arXiv:2507.08965 and dynamic CFG literature):
 * early diffusion steps use low guidance (let the model explore), later steps
 * use high guidance (lock onto the condition).
 *
 * @param {number} step - current step index (0-based)
 * @param {number} totalSteps
 * @param {number} cfgStrength - base / late-step strength
 * @param {{mode: string, startStrength: number, endStrength: number}|null} cfgSchedule
 * @returns {number}
 */
function resolveCfgStrength(step, totalSteps, cfgStrength, cfgSchedule) {
    if (!cfgSchedule || cfgSchedule.mode === 'fixed') return cfgStrength;
    const t = totalSteps > 1 ? step / (totalSteps - 1) : 1.0; // 0..1
    const start = (typeof cfgSchedule.startStrength === 'number') ? cfgSchedule.startStrength : 1.0;
    const end = (typeof cfgSchedule.endStrength === 'number') ? cfgSchedule.endStrength : cfgStrength;
    if (cfgSchedule.mode === 'linear') {
        return start + (end - start) * t;
    }
    if (cfgSchedule.mode === 'cosine') {
        return start + (end - start) * 0.5 * (1 - Math.cos(Math.PI * t));
    }
    return cfgStrength;
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

        // 诊断：检查第一个 step 的输出（gated by diagnosticMode）
        if (_diagnosticMode && tVal < 0.1) {
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
        if (_diagnosticMode && tVal < 0.1) {
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
     *
     * @param {string} [samplerName='stork2'] - 求解器名称，见 samplers/index.js
     * @param {{mode: string, startStrength: number, endStrength: number}|null} [cfgSchedule=null]
     *        CFG 强度调度配置。mode: 'fixed'|'linear'|'cosine'。null 或 'fixed' 时使用常量 cfgStrength。
     *        low→high 调度（'linear' / 'cosine'）遵循 A-CFG / dynamic CFG 论文，减少过曝光伪影。
     * @param {Float32Array|null} [f0Data=null] - 可选 F0 序列（50Hz），用于 F0 感知分块边界规划。
     */
    async runDiffusionLoop(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes = false, samplerName = 'stork2', cfgSchedule = null, f0Data = null) {
        const floatType = isFP16 ? 'float16' : 'float32';
        const totalFramesWithPrompt = ptFrameCount + totalFrames;
        const seqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFramesWithPrompt;
        const useCfg = cfgStrength > 0;

        // 诊断：输出 diffStep session 的输入元数据（gated）
        if (_diagnosticMode && sessions.diffStep) {
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
                console.log(`[DiffusionDiag] isFP16=${isFP16}, floatType=${floatType}, cfgSchedule=${cfgSchedule ? cfgSchedule.mode : 'fixed'}`);
            } catch (e) {
                console.log('[DiffusionDiag] Failed to read diffStep inputMetadata:', e.message);
            }
        }

        // 条件分支 mask：所有帧均有效（含 prompt）
        const frameMask = new Float32Array(totalFramesWithPrompt).fill(1);
        const xtInputBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);
        // prompt frames在循环中不变，预先拷贝一次
        xtInputBuf.set(ptMelData, 0);

        const progressPerStep = progressRange / totalSteps;
        const targetLen = totalFrames * MEL_DIM;

        // ===== 求解器抽象 =====
        const sampler = createSampler(samplerName);

        // 预分配复用缓冲区（跨步复用，0 per-step 分配）
        const buffers = {
            vBuf: new Float32Array(targetLen),     // combine 输出
            deltaBuf: new Float32Array(targetLen),  // sampler delta 输出
            v1Buf: new Float32Array(targetLen),     // Heun 保存 v1
            xPredBuf: new Float32Array(targetLen),  // Heun 预测状态
        };

        // ===== P0-1: DML 路径 cond/uncond batch 合并（对齐 WebNN 路径） =====
        // diffStep ONNX 已接受 batch 维度（WebNN 路径证明）。将 cond + uncond 合并为
        // [2, seqLen, MEL_DIM] 单次 session.run，diffusion 步数 32 时直接 ~2× 加速。
        //
        // cond 分支：xt = [ptMelData | xtData]，mask = all ones
        // uncond 分支：xt = [xtData | zeros_padding]，mask = [ones(target) | zeros(padding)]
        //   （对齐 WebNN 路径与官方 reverse_diffusion：uncond 使用 target-only 序列，
        //    通过 mask=0 让模型忽略 prompt 段的 zero padding）
        let evalDiffStep;
        let _batchTensors = null; // 跨步复用的 cond/mask 张量
        let _batchXtTensor = null; // 跨步复用的 xt 张量（每步只更新 .data）
        let _batchTTensor = null;  // 跨步复用的 t 张量（每步只更新 .data）
        let _batchXtBuf = null;    // 复用的 Float32Array buffer for xt input
        let _batchTBuf = null;     // 复用的 Float32Array buffer for t input
        const condTargetOffset = ptFrameCount * MEL_DIM;

        if (useCfg) {
            // === CFG batch path: cond + uncond in one session.run ===
            const padFloat = (src, len) => {
                if (src.length >= len) return src;
                const padded = new Float32Array(len);
                padded.set(src);
                return padded;
            };

            // cond row: full combinedCond (prompt + target), mask all ones
            const condPadded = useStaticShapes ? padFloat(combinedCond, seqLen * COND_DIM) : combinedCond;
            const condMaskPadded = useStaticShapes ? padFloat(frameMask, seqLen) : frameMask;
            const condTensorCached = createFloatTensor(floatType, condPadded, [1, seqLen, COND_DIM]);
            const condMaskTensorCached = createFloatTensor(floatType, condMaskPadded, [1, seqLen]);

            // uncond row: cond = zeros (target-only), mask = [ones(target) | zeros(padding)]
            const uncondCondBuf = new Float32Array(seqLen * COND_DIM); // all zeros
            const uncondMaskBuf = new Float32Array(seqLen);
            uncondMaskBuf.fill(1, 0, totalFrames); // target region = 1
            // padding region (totalFrames..seqLen) stays 0
            const uncondCondTensorCached = createFloatTensor(floatType, uncondCondBuf, [1, seqLen, COND_DIM]);
            const uncondMaskTensorCached = createFloatTensor(floatType, uncondMaskBuf, [1, seqLen]);

            // Batched cond+uncond tensors: [2, seqLen, ...]
            // Build batched buffers once, reuse across steps (only xt/t data changes)
            const batchCondBuf = new Float32Array(2 * seqLen * COND_DIM);
            batchCondBuf.set(condPadded, 0);
            batchCondBuf.set(uncondCondBuf, seqLen * COND_DIM);
            const batchMaskBuf = new Float32Array(2 * seqLen);
            batchMaskBuf.set(condMaskPadded, 0);
            batchMaskBuf.set(uncondMaskBuf, seqLen);

            const batchCondTensor = createFloatTensor(floatType, batchCondBuf, [2, seqLen, COND_DIM]);
            const batchMaskTensor = createFloatTensor(floatType, batchMaskBuf, [2, seqLen]);

            // Pre-allocate xt + t tensors (reused across steps, only .data updates)
            _batchXtBuf = new Float32Array(2 * seqLen * MEL_DIM);
            _batchTBuf = new Float32Array(2);
            _batchXtTensor = createFloatTensor(floatType, _batchXtBuf, [2, seqLen, MEL_DIM]);
            _batchTTensor = createFloatTensor(floatType, _batchTBuf, [2]);

            _batchTensors = {
                condTensorCached, condMaskTensorCached,
                uncondCondTensorCached, uncondMaskTensorCached,
                batchCondTensor, batchMaskTensor,
            };

            evalDiffStep = async (t, xtOverride) => {
                const xtData = xtOverride || xt.data;
                // cond row: [ptMelData | xtData] (already in xtInputBuf)
                xtInputBuf.set(xtData, condTargetOffset);
                _batchXtBuf.set(xtInputBuf, 0); // row 0 = cond
                // uncond row: [xtData | zeros_padding]
                _batchXtBuf.set(xtData, seqLen * MEL_DIM); // row 1 positions 0..totalFrames-1
                // positions totalFrames..seqLen-1 in row 1 stay 0 (already zero from init / previous fill)
                // Re-zero the padding region of uncond row to avoid stale data
                if (seqLen > totalFrames) {
                    const padStart = seqLen * MEL_DIM + totalFrames * MEL_DIM;
                    const padEnd = 2 * seqLen * MEL_DIM;
                    _batchXtBuf.fill(0, padStart, padEnd);
                }
                _batchTBuf[0] = t;
                _batchTBuf[1] = t;

                let results;
                try {
                    results = await sessions.diffStep.run({
                        xt_input: _batchXtTensor,
                        t: _batchTTensor,
                        cond: _batchCondTensorRef.batchCondTensor,
                        xt_mask: _batchCondTensorRef.batchMaskTensor,
                    });
                } catch (err) {
                    throw err;
                }

                const predRaw = results['flow_pred'];
                const batchPred = outputToFloat32(predRaw);
                // Take an independent copy so we can dispose the output tensor immediately.
                const batchPredSafe = batchPred.slice();
                disposeTensor(predRaw);

                // Extract cond target segment and uncond target segment
                const condPred = new Float32Array(targetLen);
                const uncondPred = new Float32Array(targetLen);
                // cond row: target at positions [ptFrameCount, ptFrameCount+totalFrames)
                const condSrcBase = condTargetOffset;
                // uncond row: target at positions [0, totalFrames)
                const uncondSrcBase = seqLen * MEL_DIM;
                for (let f = 0; f < totalFrames; f++) {
                    const srcCondOff = condSrcBase + f * MEL_DIM;
                    const srcUncondOff = uncondSrcBase + f * MEL_DIM;
                    const dstOff = f * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        condPred[dstOff + d] = batchPredSafe[srcCondOff + d];
                        uncondPred[dstOff + d] = batchPredSafe[srcUncondOff + d];
                    }
                }
                return { condPred, uncondPred };
            };
            // (closure references _batchXtBuf / _batchXtTensor / _batchTBuf / _batchTTensor directly)
            // Reference batch cond/mask tensors via a stable holder to avoid re-allocating the closure.
            var _batchCondTensorRef = _batchTensors;
        } else {
            // === No-CFG path: single batch=1 call ===
            const padFloat = (src, len) => {
                if (src.length >= len) return src;
                const padded = new Float32Array(len);
                padded.set(src);
                return padded;
            };
            const condPadded = useStaticShapes ? padFloat(combinedCond, seqLen * COND_DIM) : combinedCond;
            const condMaskPadded = useStaticShapes ? padFloat(frameMask, seqLen) : frameMask;
            const condTensorCached = createFloatTensor(floatType, condPadded, [1, seqLen, COND_DIM]);
            const condMaskTensorCached = createFloatTensor(floatType, condMaskPadded, [1, seqLen]);
            _batchTensors = { condTensorCached, condMaskTensorCached };

            evalDiffStep = async (t, xtOverride) => {
                const xtData = xtOverride || xt.data;
                xtInputBuf.set(xtData, condTargetOffset);
                const condPred = await this._runDiffStepWithCachedTensors(
                    sessions, xtInputBuf, t, condTensorCached, condMaskTensorCached,
                    totalFramesWithPrompt, isFP16, useStaticShapes
                );
                // condPred covers [0, totalFramesWithPrompt * MEL_DIM); extract target segment.
                const targetPred = new Float32Array(targetLen);
                for (let f = 0; f < totalFrames; f++) {
                    const srcOff = (ptFrameCount + f) * MEL_DIM;
                    const dstOff = f * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        targetPred[dstOff + d] = condPred[srcOff + d];
                    }
                }
                return { condPred: targetPred, uncondPred: null };
            };
        }

        // combine: CFG + Rescale 合并，写入 vBuf（复用），返回 vBuf 引用
        // P1: 单趟 Welford 在线方差（替代三趟 two-pass）
        // P1: 支持调度 CFG —— 每步通过 currentCfgStrength 传入实际生效的强度
        let currentCfgStrength = cfgStrength;
        const cfgPredBuf = new Float32Array(targetLen);
        const combine = (condPred, uncondPred) => {
            const v = buffers.vBuf;
            if (!useCfg) {
                // 无 CFG：直接取 cond 分支 target 段 → vBuf（condPred 已是 target 段）
                v.set(condPred);
                return v;
            }
            // Single-pass Welford-style accumulation:
            //   - Compute cfgVal and accumulate pos/cfg mean+M2 online
            //   - Then a single rescale pass to write v
            // Numerical stability: Welford online variance (Bessel-corrected).
            let posMean = 0, cfgAdjMean = 0;
            let posM2 = 0, cfgAdjM2 = 0;
            let n = 0;
            const effCfg = currentCfgStrength;
            for (let i = 0; i < targetLen; i++) {
                const condVal = condPred[i];
                const uncondVal = uncondPred[i];
                const cfgVal = condVal + effCfg * (condVal - uncondVal);
                cfgPredBuf[i] = cfgVal;
                n++;
                const deltaPos = condVal - posMean;
                posMean += deltaPos / n;
                posM2 += deltaPos * (condVal - posMean);
                const deltaCfg = cfgVal - cfgAdjMean;
                cfgAdjMean += deltaCfg / n;
                cfgAdjM2 += deltaCfg * (cfgVal - cfgAdjMean);
            }
            const posStd = Math.sqrt(Math.max(0, posM2 / Math.max(1, n - 1)));
            const cfgAdjStd = Math.sqrt(Math.max(0, cfgAdjM2 / Math.max(1, n - 1)));
            const rescale = posStd / (cfgAdjStd + 1e-8);
            // Rescale pass → vBuf
            for (let i = 0; i < targetLen; i++) {
                const cfgVal = cfgPredBuf[i];
                v[i] = cfgRescale * (cfgVal * rescale) + (1 - cfgRescale) * cfgVal;
            }
            return v;
        };

        try {
            let totalNFE = 0;
            for (let step = 0; step < totalSteps; step++) {
                // P1: 调度 CFG —— 每步解析实际生效的 cfgStrength
                currentCfgStrength = resolveCfgStrength(step, totalSteps, cfgStrength, cfgSchedule);

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
                // P2: 自适应 GPU 排空 —— 无 OOM 时保持轻量 yield，OOM 后加长
                if (step % 8 === 7) {
                    await adaptiveGpuDrain(20);
                } else if (totalFrames > 256) {
                    // 长片段每步 yield：combine 的单趟全数组遍历会阻塞主线程
                    await new Promise(r => setImmediate(r));
                }
            }
            // 诊断：检测扩散输出是否包含 NaN/Inf + 统计输出分布（gated）
            if (_diagnosticMode) {
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
                const xtMean = xtLen > 0 ? xtSum / xtLen : 0;
                const xtStd = xtLen > 0 ? Math.sqrt(Math.max(0, xtSumSq / xtLen - xtMean * xtMean)) : 0;
                console.log(`[DiffusionDiag] OUTPUT xt: frames=${totalFrames}, len=${xtLen}, NaN=${xtNaN}, Inf=${xtInf}, min=${xtMin.toFixed(6)}, max=${xtMax.toFixed(6)}, mean=${xtMean.toFixed(6)}, std=${xtStd.toFixed(6)}, nfe=${totalNFE}`);
                if (xtNaN > 0 || xtInf > 0) {
                    console.error(`[DiffusionDiag] DIFFUSION OUTPUT HAS NaN/Inf! NaN=${xtNaN}, Inf=${xtInf - xtNaN}, total=${xtLen}, frames=${totalFrames}, mean=${xtMean.toFixed(6)}`);

                    // Dump ORT native debug logs from stderr capture
                    if (typeof globalThis._flushOrtDebugLogs === 'function') {
                        globalThis._flushOrtDebugLogs();
                    }
                }
            }
        } finally {
            // 循环结束：释放预构建的 cond/mask/batch 张量
            if (_batchTensors) {
                disposeTensor(_batchTensors.condTensorCached);
                disposeTensor(_batchTensors.condMaskTensorCached);
                if (_batchTensors.uncondCondTensorCached) disposeTensor(_batchTensors.uncondCondTensorCached);
                if (_batchTensors.uncondMaskTensorCached) disposeTensor(_batchTensors.uncondMaskTensorCached);
                if (_batchTensors.batchCondTensor) disposeTensor(_batchTensors.batchCondTensor);
                if (_batchTensors.batchMaskTensor) disposeTensor(_batchTensors.batchMaskTensor);
            }
            if (_batchXtTensor) disposeTensor(_batchXtTensor);
            if (_batchTTensor) disposeTensor(_batchTTensor);
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
     * Q2-2 (RDSinger, arXiv:2410.21641): 分块边界避开 F0 突变区，减少音高过渡处伪影。
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
     * @param {Function} [onChunkMel] - 流式回调
     * @param {string} [samplerName='stork2']
     * @param {{mode: string, startStrength: number, endStrength: number}|null} [cfgSchedule=null]
     * @param {Float32Array|null} [f0Data=null] - F0 序列（50Hz），用于 F0 感知边界规划
     */

    /**
     * 计算分块边界与交叉淡入淡出窗。
     * 返回 null 表示无需分块（chunkFrames >= totalFrames 或 totalFrames <= 0）。
     *
     * P1 (WSOLA): 对有音高信号（歌声是典型），对称 Hann OLA 在重叠区不保证相位连续，
     * 会产生轻微 flanging/梳状滤波。改用基于互相关搜索对齐的 WSOLA 思想：
     * 在重叠区内，对每个输出帧寻找最佳对齐的输入帧（搜索范围 ±searchRange），
     * 减少相位不连续。此处实现简化版：保留 Hann 窗作为 fallback，
     * 当 f0Data 可用时优先使用 F0 感知边界（Q2-2），overlap 区使用 Hann 窗。
     *
     * Q2-2 (RDSinger): 若提供 f0Data，将边界 snap 到 F0 稳定区
     * （|f0[i+1]-f0[i]| < slopeThreshold），避免在音高过渡处切分。
     *
     * @param {number} totalFrames
     * @param {number} chunkFrames
     * @param {number} overlapFrames
     * @param {Float32Array|null} [f0Data=null]
     * @returns {{specs: Array, overlap: number, fadeWindow: Float32Array}|null}
     */
    _planChunks(totalFrames, chunkFrames, overlapFrames, f0Data = null) {
        // 防御：totalFrames <= 0 时直接返回 null，由调用方短路处理
        if (!Number.isFinite(totalFrames) || totalFrames <= 0) return null;
        const safeChunk = Math.max(50, Math.floor(chunkFrames));
        let safeOverlap = Math.max(0, Math.floor(overlapFrames));
        if (safeOverlap >= safeChunk) safeOverlap = Math.floor(safeChunk / 2);
        if (safeChunk >= totalFrames) return null;
        if (safeOverlap < 1) safeOverlap = 0;

        // Q2-2: F0 感知边界调整。若 f0Data 提供，计算每帧 F0 斜率，
        // 在规划边界时优先选择 F0 稳定的位置（斜率 < threshold）。
        // 搜索范围：以理想边界为中心 ±safeOverlap/2。
        const f0SlopeThreshold = 50; // cents/frame ≈ 50 cents = 半音的 1/2
        const findStableBoundary = (idealBoundary) => {
            if (!f0Data || f0Data.length < 2) return idealBoundary;
            const searchRadius = Math.max(1, Math.floor(safeOverlap / 2));
            let bestBoundary = idealBoundary;
            let bestScore = Infinity;
            for (let delta = -searchRadius; delta <= searchRadius; delta++) {
                const b = idealBoundary + delta;
                if (b < 1 || b >= totalFrames || b >= f0Data.length) continue;
                // 斜率 = |f0[b] - f0[b-1]| in cents (avoid log of 0)
                const f0Prev = f0Data[b - 1];
                const f0Curr = f0Data[b];
                let slope = 0;
                if (f0Prev > 1 && f0Curr > 1) {
                    slope = Math.abs(1200 * Math.log2(f0Curr / f0Prev));
                } else if ((f0Prev > 1) !== (f0Curr > 1)) {
                    // voiced/unvoiced transition — high penalty
                    slope = f0SlopeThreshold * 4;
                }
                // Prefer boundaries close to ideal (penalty proportional to |delta|)
                const score = slope + Math.abs(delta) * 5;
                if (score < bestScore) {
                    bestScore = score;
                    bestBoundary = b;
                }
            }
            return bestBoundary;
        };

        const specs = [];
        let framePos = 0;
        let chunkIdx = 0;
        while (framePos < totalFrames) {
            const isFirst = chunkIdx === 0;
            const chunkStart = isFirst ? 0 : Math.max(0, framePos - safeOverlap);
            let chunkEnd = Math.min(chunkStart + safeChunk, totalFrames);
            const isLast = chunkEnd >= totalFrames;
            // Q2-2: 对非首/非末 chunk 的结束位置做 F0 感知调整
            if (!isLast && f0Data) {
                const adjustedEnd = findStableBoundary(chunkEnd);
                chunkEnd = Math.min(Math.max(chunkStart + 1, adjustedEnd), totalFrames);
            }
            const currentChunkFrames = chunkEnd - chunkStart;
            specs.push({ chunkStart, chunkEnd, currentChunkFrames, isFirst, isLast });
            if (isLast) break;
            framePos = chunkEnd;
            chunkIdx++;
        }

        // Hann 交叉淡入淡出窗：使用 (i+1)/(N+1) 归一化保证 w[i] + w[N-1-i] = 1 严格成立
        const fadeWindow = new Float32Array(safeOverlap);
        for (let i = 0; i < safeOverlap; i++) {
            fadeWindow[i] = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (safeOverlap + 1)));
        }
        return { specs, overlap: safeOverlap, fadeWindow };
    }

    /**
     * 执行单个分块的扩散推理（提取噪声 → 完整扩散循环 → Hann 交叉淡入淡出写回）。
     * 可独立调用，供多分片时间交错流式编排器按时间顺序逐块调用。
     *
     * @param {Object} ctx - 分块上下文
     * @param {Object} spec - 分块规格
     * @param {Function} onProgress
     * @param {number} progressStart
     * @param {number} progressRange
     * @returns {Promise<{newCommitted: number}>}
     */
    async _runSingleDiffusionChunk(ctx, spec, onProgress, progressStart, progressRange) {
        const { sessions, xt, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, useStaticShapes, overlap, fadeWindow, samplerName, cfgSchedule, f0Data } = ctx;
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
        const chunkOnProgress = (p) => {
            if (onProgress) onProgress(Math.round(p));
        };
        await this.runDiffusionLoop(
            sessions, subXt, currentChunkFrames, ptMelData, ptFrameCount,
            chunkCond, totalSteps, cfgStrength, cfgRescale, isFP16,
            chunkOnProgress, progressStart, progressRange, useStaticShapes, samplerName, cfgSchedule, f0Data
        );

        // 4. Hann 交叉淡入淡出写回（P1/Q0-2: WSOLA 对齐后交叉淡入淡出）
        if (isFirst) {
            // 首 chunk：无前序数据，直接整段 memcpy
            xtOut.set(subXt.data.subarray(0, currentChunkFrames * MEL_DIM), chunkStart * MEL_DIM);
        } else {
            // 重叠区：逐帧加权混合
            const ov = overlap;
            // P1 / Q0-2: WSOLA mel-domain alignment. Mel spectrograms are magnitude-only
            // (no phase), so WSOLA here aligns spectral features rather than phase — less
            // critical than the audio path but still reduces boundary spectral jumps.
            // Search a small frame lag (<=2 frames) for the best spectral correlation
            // between the previous chunk's committed tail and the current chunk's head.
            // The lag drops `delta` frames from the current chunk's head; the resulting
            // `delta`-frame gap at the chunk tail is covered by the next chunk's overlap
            // (delta << overlap, so the stale frames are crossfaded away).
            let wsolaDelta = 0;
            if (ov >= 8 && currentChunkFrames > ov + 2) {
                const wsolaSearchRange = Math.min(Math.floor(ov / 8), 2);
                wsolaDelta = wsolaBestLag(
                    xtOut, chunkStart * MEL_DIM,       // reference = previous committed tail
                    subXt.data, 0,                      // signal = current chunk head
                    ov, wsolaSearchRange, MEL_DIM
                );
            }
            const effOv = ov; // overlap window length (frames) stays the same
            for (let f = 0; f < effOv && f + wsolaDelta < currentChunkFrames; f++) {
                const dstOffset = (chunkStart + f) * MEL_DIM;
                const srcOffset = (f + wsolaDelta) * MEL_DIM;
                const w = fadeWindow[f];
                const invW = 1 - w;
                for (let d = 0; d < MEL_DIM; d++) {
                    xtOut[dstOffset + d] = xtOut[dstOffset + d] * invW + subXt.data[srcOffset + d] * w;
                }
            }
            // 非重叠区：用 TypedArray.set 走 memcpy（跳过 wsolaDelta 帧对齐偏移）
            const nonOverlapStart = (effOv + wsolaDelta) * MEL_DIM;
            const nonOverlapLen = (currentChunkFrames - effOv - wsolaDelta) * MEL_DIM;
            if (nonOverlapLen > 0) {
                xtOut.set(
                    subXt.data.subarray(nonOverlapStart, nonOverlapStart + nonOverlapLen),
                    (chunkStart + effOv) * MEL_DIM
                );
            }
        }

        // 5. GPU 排空（自适应）
        await adaptiveGpuDrain();

        // 6. 计算 committed 帧数
        const newCommitted = isLast ? chunkEnd : Math.max(0, chunkEnd - overlap);
        return { newCommitted };
    }

    async runDiffusionLoopChunked(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes, chunkFrames, overlapFrames, onChunkMel = null, samplerName = 'stork2', cfgSchedule = null, f0Data = null) {
        // 分块规划
        const plan = this._planChunks(totalFrames, chunkFrames, overlapFrames, f0Data);
        if (!plan) {
            // 无需分块，直接整段推理
            return this.runDiffusionLoop(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes, samplerName, cfgSchedule, f0Data);
        }

        const { specs, overlap, fadeWindow } = plan;
        const totalChunks = specs.length;
        if (_diagnosticMode) {
            console.log(`[DiffusionChunk] Chunked diffusion: totalFrames=${totalFrames}, ptFrameCount=${ptFrameCount}, chunkFrames=${chunkFrames}, overlap=${overlap}, steps=${totalSteps}, chunks=${totalChunks}, sampler=${samplerName}, cfgSchedule=${cfgSchedule ? cfgSchedule.mode : 'fixed'}`);
        }

        const ctx = { sessions, xt, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, useStaticShapes, overlap, fadeWindow, samplerName, cfgSchedule, f0Data };
        const progressPerChunk = progressRange / totalChunks;
        let committedFrames = 0;

        try {
            for (let ci = 0; ci < totalChunks; ci++) {
                const spec = specs[ci];
                if (_diagnosticMode) {
                    console.log(`[DiffusionChunk] chunk ${ci}/${totalChunks}: frames[${spec.chunkStart},${spec.chunkEnd})=${spec.currentChunkFrames}frames`);
                }

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

        if (_diagnosticMode) {
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

module.exports = { Diffusion, setDiagnosticMode, isDiagnosticMode, noteOomEvent, adaptiveGpuDrain, resolveCfgStrength };
