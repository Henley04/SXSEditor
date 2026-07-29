const { MEL_DIM, COND_DIM, NPU_STATIC_SEQ_LEN } = require('./constants');
const { createFloatTensor, outputToFloat32, disposeTensor, gpuDrain } = require('./utils');
const { createSampler, resolveSamplerName } = require('./samplers');

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
     *
     * @param {string} [samplerName='euler'] - 求解器名称，见 samplers/index.js
     */
    async runDiffusionLoop(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes = false, samplerName = 'euler') {
        const floatType = isFP16 ? 'float16' : 'float32';
        const totalFramesWithPrompt = ptFrameCount + totalFrames;
        const seqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFramesWithPrompt;

        // 诊断：输出 diffStep session 的输入元数据
        if (sessions.diffStep) {
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

        // ===== 求解器抽象 =====
        // evalDiffStep(t, xtOverride?): 执行 cond + (可选)uncond 推理，返回独立副本
        // combine(condPred, uncondPred): CFG + Rescale 合并，返回 v(x,t)
        // sampler.step 返回 delta，调用方累加到 xt.data
        // 注：每次 runDiffusionLoop 新建 sampler 实例，STORK 的跨步 v_prev 缓存在
        // chunk 边界会丢失（分块路径每 chunk 新建），退化为局部 Euler，不影响正确性。
        const sampler = createSampler(samplerName);
        const useCfg = cfgStrength > 0;

        // evalDiffStep: 执行 cond + (可选)uncond 推理，返回 {condPred, uncondPred}
        // xtOverride 可选：用于多步评估求解器（如 Heun）的预测子步骤，覆盖默认 xt.data
        const evalDiffStep = async (t, xtOverride) => {
            const xtData = xtOverride || xt.data;
            // cond 分支：xtInputBuf = [ptMelData | xtData]
            xtInputBuf.set(xtData, ptFrameCount * MEL_DIM);
            const condPred = await this._runDiffStepWithCachedTensors(
                sessions, xtInputBuf, t, condTensorCached, condMaskTensorCached,
                totalFramesWithPrompt, isFP16, useStaticShapes
            );

            let uncondPred = null;
            if (useCfg) {
                // uncond 分支：target-only 序列
                xtUncondBuf.set(xtData, 0);
                uncondPred = await this._runDiffStepWithCachedTensors(
                    sessions, xtUncondBuf, t, uncondCondTensorCached, uncondMaskTensorCached,
                    totalFrames, isFP16, useStaticShapes
                );
            }
            return { condPred, uncondPred };
        };

        // combine: CFG + Rescale 合并，返回 v(x,t)（target 段，长度 totalFrames*MEL_DIM）
        const combine = (condPred, uncondPred) => {
            if (!useCfg) {
                // 无 CFG：直接取 cond 分支 target 段
                const v = new Float32Array(totalFrames * MEL_DIM);
                for (let f = 0; f < totalFrames; f++) {
                    const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        v[f * MEL_DIM + d] = condPred[tgtOffset + d];
                    }
                }
                return v;
            }
            // CFG + Rescale：复用原 2-pass 逻辑
            const targetLen = totalFrames * MEL_DIM;
            let posSum = 0, cfgAdjSum = 0, posSumSq = 0, cfgAdjSumSq = 0;
            for (let f = 0; f < totalFrames; f++) {
                const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    const condVal = condPred[tgtOffset + d];
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
            // Bessel 校正（N-1 分母），对齐 PyTorch torch.std()
            const posStd = Math.sqrt(posVarSum / (targetLen - 1) + 1e-8);
            const cfgAdjStd = Math.sqrt(cfgAdjVarSum / (targetLen - 1) + 1e-8);
            const rescale = posStd / (cfgAdjStd + 1e-8);

            const v = new Float32Array(targetLen);
            for (let f = 0; f < totalFrames; f++) {
                for (let d = 0; d < MEL_DIM; d++) {
                    const cfgVal = cfgPredBuf[f * MEL_DIM + d];
                    v[f * MEL_DIM + d] = cfgRescale * (cfgVal * rescale) + (1 - cfgRescale) * cfgVal;
                }
            }
            return v;
        };

        try {
            for (let step = 0; step < totalSteps; step++) {
                const { delta } = await sampler.step({
                    evalDiffStep, combine, step, totalSteps, xtData: xt.data,
                });
                // 累加 delta 到 xt.data
                for (let i = 0; i < delta.length; i++) {
                    xt.data[i] += delta[i];
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
            // 诊断：检测扩散输出是否包含 NaN/Inf + 统计输出分布
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
                console.log(`[DiffusionDiag] OUTPUT xt: frames=${totalFrames}, len=${xtLen}, NaN=${xtNaN}, Inf=${xtInf}, min=${xtMin.toFixed(6)}, max=${xtMax.toFixed(6)}, mean=${xtMean.toFixed(6)}, std=${xtStd.toFixed(6)}`);
                if (xtNaN > 0 || xtInf > 0) {
                    console.error(`[DiffusionDiag] DIFFUSION OUTPUT HAS NaN/Inf! NaN=${xtNaN}, Inf=${xtInf - xtNaN}, total=${xtLen}, frames=${totalFrames}, mean=${xtMean.toFixed(6)}`);

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
     * @returns {{specs: Array, overlap: number, fadeWindow: Float32Array}|null}
     */
    _planChunks(totalFrames, chunkFrames, overlapFrames) {
        // 防御：totalFrames <= 0 时直接返回 null，由调用方短路处理
        if (!Number.isFinite(totalFrames) || totalFrames <= 0) return null;
        const safeChunk = Math.max(50, Math.floor(chunkFrames));
        let safeOverlap = Math.max(0, Math.floor(overlapFrames));
        if (safeOverlap >= safeChunk) safeOverlap = Math.floor(safeChunk / 2);
        if (safeChunk >= totalFrames) return null;
        // safeOverlap === 0 时无交叉淡入淡出，fadeWindow 为空数组（循环不执行）
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

        // Hann 交叉淡入淡出窗：使用 (i+1)/(N+1) 归一化保证 w[i] + w[N-1-i] = 1 严格成立
        // 旧实现 i/N 在 i=N-1 时 w < 1，紧邻非重叠区权重=1 存在微小不连续。
        const fadeWindow = new Float32Array(safeOverlap);
        for (let i = 0; i < safeOverlap; i++) {
            // w[i] = 0.5 * (1 - cos(π * (i+1) / (N+1)))，对称且 w[i] + w[N-1-i] = 1
            fadeWindow[i] = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (safeOverlap + 1)));
        }
        return { specs, overlap: safeOverlap, fadeWindow };
    }

    /**
     * 执行单个分块的扩散推理（提取噪声 → 完整扩散循环 → Hann 交叉淡入淡出写回）。
     * 可独立调用，供多分片时间交错流式编排器按时间顺序逐块调用。
     *
     * @param {Object} ctx - 分块上下文（由调用方持有，跨块共享 xt.data 状态）
     *   { sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond,
     *     totalSteps, cfgStrength, cfgRescale, isFP16, useStaticShapes, overlap, fadeWindow }
     * @param {Object} spec - 分块规格 { chunkStart, chunkEnd, currentChunkFrames, isFirst, isLast }
     * @param {Function} onProgress
     * @param {number} progressStart
     * @param {number} progressRange
     * @returns {Promise<{newCommitted: number}>} 本块完成后新确定的帧数（不含重叠区，末尾块为 chunkEnd）
     */
    async _runSingleDiffusionChunk(ctx, spec, onProgress, progressStart, progressRange) {
        const { sessions, xt, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, useStaticShapes, overlap, fadeWindow, samplerName } = ctx;
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
            chunkOnProgress, progressStart, progressRange, useStaticShapes, ctx.samplerName
        );

        // 4. Hann 交叉淡入淡出写回
        if (isFirst) {
            // 首 chunk：无前序数据，直接整段 memcpy
            xtOut.set(subXt.data.subarray(0, currentChunkFrames * MEL_DIM), chunkStart * MEL_DIM);
        } else {
            // 重叠区：逐帧加权混合（overlap 帧 × MEL_DIM 元素，无法用 set 批量）
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
            // 非重叠区：用 TypedArray.set 走 memcpy，比逐元素快 2-3 倍
            const nonOverlapStart = ov * MEL_DIM;
            const nonOverlapLen = (currentChunkFrames - ov) * MEL_DIM;
            if (nonOverlapLen > 0) {
                xtOut.set(
                    subXt.data.subarray(nonOverlapStart, nonOverlapStart + nonOverlapLen),
                    (chunkStart + ov) * MEL_DIM
                );
            }
        }

        // 5. GPU 排空
        await gpuDrain();

        // 6. 计算 committed 帧数
        const newCommitted = isLast ? chunkEnd : Math.max(0, chunkEnd - overlap);
        return { newCommitted };
    }

    async runDiffusionLoopChunked(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes, chunkFrames, overlapFrames, onChunkMel = null, samplerName = 'euler') {
        // 分块规划
        const plan = this._planChunks(totalFrames, chunkFrames, overlapFrames);
        if (!plan) {
            // 无需分块，直接整段推理
            return this.runDiffusionLoop(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes, samplerName);
        }

        const { specs, overlap, fadeWindow } = plan;
        const totalChunks = specs.length;
        console.log(`[DiffusionChunk] Chunked diffusion: totalFrames=${totalFrames}, ptFrameCount=${ptFrameCount}, chunkFrames=${chunkFrames}, overlap=${overlap}, steps=${totalSteps}, chunks=${totalChunks}, sampler=${samplerName}`);

        const ctx = { sessions, xt, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, useStaticShapes, overlap, fadeWindow, samplerName };
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
