/**
 * WebNN 推理模块 — 入口文件
 *
 * 在渲染进程中使用 onnxruntime-web + WebNN EP 执行 NPU 推理。
 * 模型文件通过自定义 protocol (onnx://) 从主进程安全获取。
 * 推理输入/输出通过 IPC 与主进程协调。
 */

import { detectNPU, clearCache } from './npuDetection.js';
import { loadModel, unloadModel, runInference, getStatus, runSession, withRunLock } from './sessionManager.js';
import { runEncoderStage } from './preprocessing.js';
import { runDiffusionLoop, runBatchDiffusionLoop } from './diffusion.js';
import { runVocoder, normalizePeakTo } from './postprocessing.js';
import { SAMPLE_RATE, HOP_SIZE, MEL_DIM, EMBED_DIM, COND_DIM, VOCODER_CHUNK_FRAMES, NPU_STATIC_SEQ_LEN, NPU_VOCODER_SEQ_LEN } from './constants.js';
import { ensureOrt, getOrt } from './ortSetup.js';
import { outputToFloat32, createFloatTensor, padInt64ToLength, padToLength, trimOutputToLength, disposeTensor } from './utils.js';
import { runSegmentedVocoder } from './audioSegmentation.js';

/**
 * 在渲染进程中运行完整的合成推理管线（encoder + diffusion loop + vocoder）
 * 所有推理在本地执行，无 IPC 开销，最大化 NPU 利用率
 *
 * @param {Object} params
 * @param {Object} params.sequences - notesToSequences 的输出
 * @param {number} params.tokenCount - token 数量
 * @param {number} params.totalFrames - 总帧数
 * @param {Float32Array|null} params.ptMelData - 参考音频 mel 数据
 * @param {number} params.ptFrameCount - 参考音频帧数
 * @param {number} params.totalSteps - 扩散步数
 * @param {number} params.cfgStrength - CFG 强度
 * @param {number} params.cfgRescale - CFG rescale
 * @param {boolean} params.isFP16 - 是否 FP16
 * @returns {{ audioData: number[], totalFrames: number }}
 */
async function runSynthesis(params) {
    // 整体持锁：防止与另一个 runSynthesis / runInference 并发执行，
    // 触发 ORT WASM 共享栈损坏（"Session already started" / "memory access out of bounds"）。
    return withRunLock(() => _runSynthesisUnlocked(params));
}

async function _runSynthesisUnlocked(params) {
    await ensureOrt();

    let {
        sequences, tokenCount, totalFrames,
        ptMelData, ptFrameCount,
        totalSteps, cfgStrength, cfgRescale,
        isFP16,
        diffStepIsFP16,
        vocoderIsFP16,
        npuDiffBatchSize = 4,
        npuVocoderBatchSize = 2,
        useStaticShapes = false,
        vocoderChunkFrames = 0,
        onProgress,
        onChunkComplete = null,
        skipVocoder = false,
        promptSeq = null,
        sampler = 'euler',
        cfgScheduleOpts = null,
        dynamicThresholdOpts = null,
    } = params;

    const floatType = isFP16 ? 'float16' : 'float32';
    // diff_step 可能有独立精度（W16A32 回退到 FP32 时 diffStepIsFP16=false 但 isFP16=true）
    const diffFloatType = (diffStepIsFP16 ?? isFP16) ? 'float16' : 'float32';
    const vocoderFloatType = (vocoderIsFP16 ?? isFP16) ? 'float16' : 'float32';
    const warnings = [];

    // NPU 静态形状模型限制：totalFramesWithPrompt 不能超过 2048
    if (useStaticShapes && ptFrameCount + totalFrames > NPU_STATIC_SEQ_LEN) {
        const maxFrames = NPU_STATIC_SEQ_LEN - Math.min(ptFrameCount, 50);
        if (totalFrames > maxFrames) {
            console.warn(`[WebNN] NPU frame limit: ${totalFrames} > ${maxFrames}, truncating`);
            warnings.push(`NPU_STATIC_SHAPE_TRUNCATION: audio truncated from ${totalFrames} to ${maxFrames} frames`);
            sequences = {
                ...sequences,
                f0Ids: sequences.f0Ids.subarray(0, maxFrames),
                mel2token: sequences.mel2token.subarray(0, maxFrames),
            };
            totalFrames = maxFrames;
        }
    }

    // ===== Stage 1: Encoder =====
    if (onProgress) onProgress(10);
    const tEnc0 = performance.now();
    const { combinedCond, totalCondFrames, totalFramesWithPrompt } = await runEncoderStage({
        sequences, tokenCount, totalFrames, ptFrameCount, ptMelData, floatType, useStaticShapes, promptSeq,
    });

    // ===== Stage 2: Diffusion Loop =====
    if (onProgress) onProgress(30);
    const diffResult = await runDiffusionLoop({
        combinedCond,
        totalFrames,
        totalFramesWithPrompt,
        ptFrameCount,
        ptMelData,
        totalSteps,
        cfgStrength,
        cfgRescale,
        floatType: diffFloatType,
        npuDiffBatchSize,
        useStaticShapes,
        samplerName: sampler,
        cfgScheduleOpts,
        dynamicThresholdOpts,
    });

    // ===== Stage 3: Vocoder =====
    // skipVocoder 模式：WebNN 路径下 vocoder 由主进程 DML 执行（支持 SiFiGAN 双输入），
    // 渲染进程仅运行 encoder+diffusion，返回 mel (xtData) 给主进程。
    if (skipVocoder) {
        if (onProgress) onProgress(100);
        const synthTotalMs = performance.now() - tEnc0;
        const diffMs = diffResult.diffTotalMs;
        console.log(`[WebNN] Synthesis (skipVocoder): ${tokenCount}tok, ${totalFrames}frm, ${totalSteps}steps, ${synthTotalMs.toFixed(0)}ms (diff ${diffMs.toFixed(0)}ms)`);
        return { xtData: diffResult.xtData, totalFrames, warnings };
    }

    if (onProgress) onProgress(80);
    const { audioData, vocTotalMs } = await runVocoder({
        xtData: diffResult.xtData,
        totalFrames,
        floatType: vocoderFloatType,
        npuVocoderBatchSize,
        useStaticShapes,
        vocoderChunkFrames,
        onChunkComplete,
    });

    const synthTotalMs = performance.now() - tEnc0;
    // B10: removed dead `encMs` placeholder (was computed but never used)
    const diffMs = diffResult.diffTotalMs;
    const vocMs = vocTotalMs;
    console.log(`[WebNN] ===== Synthesis Summary =====`);
    console.log(`[WebNN]   Input: ${tokenCount} tokens, ${totalFrames} frames, ${totalSteps} diffusion steps`);
    console.log(`[WebNN]   Diffusion:  ${diffMs.toFixed(0)}ms (${(diffMs / synthTotalMs * 100).toFixed(1)}%) — infer avg ${(diffResult.diffInferTotal / totalSteps).toFixed(0)}ms/step`);
    console.log(`[WebNN]   Vocoder:    ${vocMs.toFixed(0)}ms (${(vocMs / synthTotalMs * 100).toFixed(1)}%)`);
    console.log(`[WebNN]   Total:      ${synthTotalMs.toFixed(0)}ms`);
    console.log(`[WebNN]   Output: ${totalFrames} frames, ${(totalFrames * HOP_SIZE / SAMPLE_RATE).toFixed(1)}s audio`);
    console.log(`[WebNN] ================================`);

    return { audioData, totalFrames, warnings };
}

/**
 * 批量合成：同时处理 2 个片段，diffusion batch=4（2 片段 × 2 CFG）
 * @param {Array} paramsArray - 2 个 runSynthesis 参数对象的数组
 * @returns {Array} 2 个 { audioData, totalFrames } 的数组
 */
async function runSynthesisBatch(paramsArray) {
    if (!paramsArray || paramsArray.length === 0) return [];
    if (paramsArray.length === 1) return [await runSynthesis(paramsArray[0])];

    // 整体持锁：原因同 runSynthesis（见 withRunLock 注释）。
    return withRunLock(() => _runSynthesisBatchUnlocked(paramsArray));
}

async function _runSynthesisBatchUnlocked(paramsArray) {
    const onProgress = paramsArray[0].onProgress;

    await ensureOrt();

    const ort = getOrt();
    const isFP16 = paramsArray[0].isFP16;
    const diffStepIsFP16 = paramsArray[0].diffStepIsFP16;
    const vocoderIsFP16 = paramsArray[0].vocoderIsFP16 ?? isFP16;
    const floatType = isFP16 ? 'float16' : 'float32';
    const diffFloatType = (diffStepIsFP16 ?? isFP16) ? 'float16' : 'float32';
    const vocoderFloatType = vocoderIsFP16 ? 'float16' : 'float32';
    const useStaticShapes = paramsArray[0].useStaticShapes || false;
    const vocoderChunkFrames = paramsArray[0].vocoderChunkFrames || 0;
    const skipVocoder = paramsArray[0].skipVocoder || false;
    const sampler = paramsArray[0].sampler || 'euler';
    const cfgScheduleOpts = paramsArray[0].cfgScheduleOpts || null;
    const dynamicThresholdOpts = paramsArray[0].dynamicThresholdOpts || null;

    // ===== Stage 1: Encode both segments in parallel =====
    if (onProgress) onProgress(10);
    const tEnc0 = performance.now();
    const segData = [];

    for (const params of paramsArray) {
        const { sequences, tokenCount, totalFrames, ptMelData, ptFrameCount, promptSeq: batchPromptSeq } = params;

        // P1 fix: Merge prompt + target token sequences when promptSeq is available
        const hasPrompt = batchPromptSeq && ptFrameCount > 0 && batchPromptSeq.tokenCount > 0;
        const ptTokenCount = hasPrompt ? batchPromptSeq.tokenCount : 0;
        const combinedTokenCount = ptTokenCount + tokenCount;
        const combinedFrames = ptFrameCount + totalFrames;

        const phonemeIds = new BigInt64Array(combinedTokenCount);
        const pitchIds = new BigInt64Array(combinedTokenCount);
        const typeIds = new BigInt64Array(combinedTokenCount);
        const f0IdsArr = new BigInt64Array(combinedFrames);

        if (hasPrompt) {
            for (let i = 0; i < ptTokenCount; i++) {
                phonemeIds[i] = BigInt(batchPromptSeq.noteTextSeq[i]);
                pitchIds[i] = BigInt(batchPromptSeq.notePitchSeq[i]);
                typeIds[i] = BigInt(batchPromptSeq.noteTypeSeq[i]);
            }
            for (let i = 0; i < ptFrameCount; i++) {
                f0IdsArr[i] = BigInt(batchPromptSeq.f0Ids[i]);
            }
        }
        for (let i = 0; i < tokenCount; i++) {
            phonemeIds[ptTokenCount + i] = BigInt(sequences.noteTextSeq[i]);
            pitchIds[ptTokenCount + i] = BigInt(sequences.notePitchSeq[i]);
            typeIds[ptTokenCount + i] = BigInt(sequences.noteTypeSeq[i]);
        }
        for (let i = 0; i < totalFrames; i++) {
            f0IdsArr[ptFrameCount + i] = BigInt(sequences.f0Ids[i]);
        }

        const bEncSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : combinedTokenCount;
        const bEncF0Len = useStaticShapes ? NPU_STATIC_SEQ_LEN : combinedFrames;
        const bEncText = useStaticShapes ? padInt64ToLength(phonemeIds, bEncSeqLen) : phonemeIds;
        const bEncPitch = useStaticShapes ? padInt64ToLength(pitchIds, bEncSeqLen) : pitchIds;
        const bEncType = useStaticShapes ? padInt64ToLength(typeIds, bEncSeqLen) : typeIds;
        const bEncF0 = useStaticShapes ? padInt64ToLength(f0IdsArr, bEncF0Len) : f0IdsArr;

        const [textResults, pitchResults, typeResults, f0Results] = await Promise.all([
            runSession('noteTextEncoder', { input_ids: new ort.Tensor('int64', bEncText, [1, bEncSeqLen]) }),
            runSession('notePitchEncoder', { input_ids: new ort.Tensor('int64', bEncPitch, [1, bEncSeqLen]) }),
            runSession('noteTypeEncoder', { input_ids: new ort.Tensor('int64', bEncType, [1, bEncSeqLen]) }),
            runSession('f0Encoder', { input_ids: new ort.Tensor('int64', bEncF0, [1, bEncF0Len]) }),
        ]);

        const textEmb = useStaticShapes ? trimOutputToLength(textResults['embeddings'], combinedTokenCount) : outputToFloat32(textResults['embeddings']);
        const pitchEmb = useStaticShapes ? trimOutputToLength(pitchResults['embeddings'], combinedTokenCount) : outputToFloat32(pitchResults['embeddings']);
        const typeEmb = useStaticShapes ? trimOutputToLength(typeResults['embeddings'], combinedTokenCount) : outputToFloat32(typeResults['embeddings']);
        // f0Emb 需在后续 condCodeData 构建中使用，且 dispose f0 张量前需独立拷贝
        const f0EmbRaw = useStaticShapes ? trimOutputToLength(f0Results['embeddings'], combinedFrames) : outputToFloat32(f0Results['embeddings']);
        const f0Emb = f0EmbRaw.slice();

        const tokenEmb = new Float32Array(combinedTokenCount * EMBED_DIM);
        for (let t = 0; t < combinedTokenCount; t++) {
            for (let d = 0; d < EMBED_DIM; d++) {
                tokenEmb[t * EMBED_DIM + d] =
                    textEmb[t * EMBED_DIM + d] +
                    pitchEmb[t * EMBED_DIM + d] +
                    typeEmb[t * EMBED_DIM + d];
            }
        }
        // 释放 4 个编码器输出张量
        disposeTensor(textResults['embeddings']);
        disposeTensor(pitchResults['embeddings']);
        disposeTensor(typeResults['embeddings']);
        disposeTensor(f0Results['embeddings']);

        const bPreflowSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : combinedTokenCount;
        const bPreflowTokenEmb = useStaticShapes ? padToLength(tokenEmb, bPreflowSeqLen * EMBED_DIM) : tokenEmb;
        const featuresTensor = createFloatTensor(floatType, bPreflowTokenEmb, [1, bPreflowSeqLen, EMBED_DIM]);
        const preflowResults = await runSession('preflow', { features: featuresTensor });
        const processedTokenEmb = useStaticShapes ? trimOutputToLength(preflowResults['processed_features'], combinedTokenCount) : outputToFloat32(preflowResults['processed_features']);
        disposeTensor(featuresTensor);

        // Build combined mel2token
        const combinedMel2token = new Int32Array(combinedFrames);
        if (hasPrompt) {
            for (let f = 0; f < ptFrameCount; f++) {
                combinedMel2token[f] = batchPromptSeq.mel2token[f];
            }
        }
        for (let f = 0; f < totalFrames; f++) {
            combinedMel2token[ptFrameCount + f] = ptTokenCount + sequences.mel2token[f];
        }

        const totalCondFrames = combinedFrames;
        const condCodeData = new Float32Array(totalCondFrames * EMBED_DIM);
        for (let f = 0; f < combinedFrames; f++) {
            const tokenIdx = combinedMel2token[f];
            for (let d = 0; d < EMBED_DIM; d++) {
                condCodeData[f * EMBED_DIM + d] =
                    processedTokenEmb[tokenIdx * EMBED_DIM + d] + f0Emb[f * EMBED_DIM + d];
            }
        }
        disposeTensor(preflowResults['processed_features']);

        const bCondSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalCondFrames;
        const bPaddedCondCode = useStaticShapes ? padToLength(condCodeData, bCondSeqLen * EMBED_DIM) : condCodeData;
        const condCodeTensor = createFloatTensor(floatType, bPaddedCondCode, [1, bCondSeqLen, EMBED_DIM]);
        const condEmbResults = await runSession('condEmb', { cond_code: condCodeTensor });
        // combinedCond 需存入 segData 供后续 diffusion 使用，取独立拷贝
        const combinedCondRaw = useStaticShapes ? trimOutputToLength(condEmbResults['cond_embedding'], totalCondFrames) : outputToFloat32(condEmbResults['cond_embedding']);
        const combinedCond = combinedCondRaw.slice();
        disposeTensor(condCodeTensor);
        disposeTensor(condEmbResults['cond_embedding']);

        segData.push({
            totalFrames, tokenCount, ptMelData, ptFrameCount, combinedCond,
            totalCondFrames,
            totalFramesWithPrompt: ptFrameCount + totalFrames,
            totalSteps: params.totalSteps || 32,
            cfgStrength: params.cfgStrength ?? 3.0,
            cfgRescale: params.cfgRescale ?? 0.75,
            npuVocoderBatchSize: params.npuVocoderBatchSize || 1,
        });
    }
    const batchEncMs = performance.now() - tEnc0;
    console.log(`[WebNN] Batch encoder (2 segments): ${batchEncMs.toFixed(0)}ms [seg0: ${segData[0].tokenCount}tok/${segData[0].totalFrames}frm, seg1: ${segData[1].tokenCount}tok/${segData[1].totalFrames}frm]`);

    // ===== Stage 2: Batched Diffusion Loop (batch=4) =====
    if (onProgress) onProgress(30);
    const totalSteps = segData[0].totalSteps;
    const xts = await runBatchDiffusionLoop({ segData, totalSteps, floatType: diffFloatType, useStaticShapes, samplerName: sampler, cfgScheduleOpts, dynamicThresholdOpts });

    // ===== Stage 3: Vocoder per segment =====
    // skipVocoder 模式：返回 mel 给主进程，vocoder 由主进程 DML 执行（支持 SiFiGAN 双输入）
    if (skipVocoder) {
        if (onProgress) onProgress(100);
        const batchSynthMs = performance.now() - tEnc0;
        console.log(`[WebNN] Batch synthesis (skipVocoder): 2 segs (${segData[0].totalFrames}+${segData[1].totalFrames}frm), ${batchSynthMs.toFixed(0)}ms`);
        return segData.map((s, si) => ({ xtData: xts[si], totalFrames: s.totalFrames }));
    }

    if (onProgress) onProgress(80);
    const results = [];
    for (let si = 0; si < 2; si++) {
        const s = segData[si];
        const xt = xts[si];
        const totalSamples = s.totalFrames * HOP_SIZE;
        let audioData;

        const effectiveVocChunk = (vocoderChunkFrames && vocoderChunkFrames > 0) ? vocoderChunkFrames : VOCODER_CHUNK_FRAMES;
        const maxVocChunk = useStaticShapes ? NPU_VOCODER_SEQ_LEN : effectiveVocChunk;
        if (s.totalFrames <= maxVocChunk) {
            const bVocSeqLen = useStaticShapes ? NPU_VOCODER_SEQ_LEN : s.totalFrames;
            const paddedMel = useStaticShapes ? padToLength(xt, bVocSeqLen * MEL_DIM) : xt;
            const melTensor = createFloatTensor(vocoderFloatType, paddedMel, [1, bVocSeqLen, MEL_DIM]);
            const vocoderResults = await runSession('vocoder', { mel: melTensor });
            const waveformRaw = vocoderResults['waveform'];
            const waveform = outputToFloat32(waveformRaw);
            audioData = Array.from(waveform.subarray(0, Math.min(waveform.length, totalSamples)));
            // 释放 vocoder 输入和输出张量
            disposeTensor(melTensor);
            disposeTensor(waveformRaw);
            // Peak 归一化（与 runVocoder 单 chunk 路径一致，确保 batch 段间响度匹配 DML）
            normalizePeakTo(audioData);
        } else {
            const result = await runSegmentedVocoder({
                xtData: xt,
                totalFrames: s.totalFrames,
                floatType: vocoderFloatType,
                npuVocoderBatchSize: s.npuVocoderBatchSize,
                useStaticShapes,
                vocoderChunkFrames: effectiveVocChunk,
            });
            audioData = result.audioData;
            // Peak 归一化（runSegmentedVocoder 不做归一化，此处补齐，与单 chunk 路径一致）
            normalizePeakTo(audioData);
        }

        results.push({ audioData, totalFrames: s.totalFrames });
    }

    const batchSynthMs = performance.now() - tEnc0;
    console.log(`[WebNN] ===== Batch Synthesis Summary =====`);
    console.log(`[WebNN]   Segments: 2 (seg0: ${segData[0].totalFrames}frm, seg1: ${segData[1].totalFrames}frm)`);
    console.log(`[WebNN]   Encoder:    ${batchEncMs.toFixed(0)}ms`);
    console.log(`[WebNN]   Total:      ${batchSynthMs.toFixed(0)}ms`);
    console.log(`[WebNN] =====================================`);
    return results;
}

// 导出接口供 IPC 调用（保持与原始模块相同的 API）
export {
    detectNPU,
    clearCache, // W12: 暴露缓存清除入口，供需要强制重新检测时调用
    loadModel,
    unloadModel,
    runInference,
    runSynthesis,
    runSynthesisBatch,
    getStatus,
};
