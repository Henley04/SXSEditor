/**
 * WebNN 推理模块 — 入口文件
 *
 * 在渲染进程中使用 onnxruntime-web + WebNN EP 执行 NPU 推理。
 * 模型文件通过自定义 protocol (onnx://) 从主进程安全获取。
 * 推理输入/输出通过 IPC 与主进程协调。
 */

import { detectNPU } from './npuDetection.js';
import { loadModel, unloadModel, runInference, getStatus, runSession } from './sessionManager.js';
import { runEncoderStage } from './preprocessing.js';
import { runDiffusionLoop, runBatchDiffusionLoop } from './diffusion.js';
import { runVocoder } from './postprocessing.js';
import { SAMPLE_RATE, HOP_SIZE, MEL_DIM, EMBED_DIM, COND_DIM, VOCODER_CHUNK_FRAMES, NPU_STATIC_SEQ_LEN, NPU_VOCODER_SEQ_LEN } from './constants.js';
import { ensureOrt, getOrt } from './ortSetup.js';
import { outputToFloat32, createFloatTensor, padInt64ToLength, padToLength, trimOutputToLength } from './utils.js';
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
    await ensureOrt();

    let {
        sequences, tokenCount, totalFrames,
        ptMelData, ptFrameCount,
        totalSteps, cfgStrength, cfgRescale,
        isFP16,
        npuDiffBatchSize = 4,
        npuVocoderBatchSize = 2,
        useStaticShapes = false,
    } = params;

    const floatType = isFP16 ? 'float16' : 'float32';

    // NPU 静态形状模型限制：totalFramesWithPrompt 不能超过 2048
    if (useStaticShapes && ptFrameCount + totalFrames > NPU_STATIC_SEQ_LEN) {
        const maxFrames = NPU_STATIC_SEQ_LEN - Math.min(ptFrameCount, 50);
        if (totalFrames > maxFrames) {
            console.warn(`[WebNN] NPU frame limit: ${totalFrames} > ${maxFrames}, truncating`);
            sequences = {
                ...sequences,
                f0Ids: sequences.f0Ids.subarray(0, maxFrames),
                mel2token: sequences.mel2token.subarray(0, maxFrames),
            };
            totalFrames = maxFrames;
        }
    }

    // ===== Stage 1: Encoder =====
    const tEnc0 = performance.now();
    const { combinedCond, totalCondFrames, totalFramesWithPrompt } = await runEncoderStage({
        sequences, tokenCount, totalFrames, ptFrameCount, ptMelData, floatType, useStaticShapes,
    });

    // ===== Stage 2: Diffusion Loop =====
    const diffResult = await runDiffusionLoop({
        combinedCond,
        totalFrames,
        totalFramesWithPrompt,
        ptFrameCount,
        ptMelData,
        totalSteps,
        cfgStrength,
        cfgRescale,
        floatType,
        npuDiffBatchSize,
        useStaticShapes,
    });

    // ===== Stage 3: Vocoder =====
    const { audioData, vocTotalMs } = await runVocoder({
        xtData: diffResult.xtData,
        totalFrames,
        floatType,
        npuVocoderBatchSize,
        useStaticShapes,
    });

    const synthTotalMs = performance.now() - tEnc0;
    const encMs = diffResult.diffTotalMs > 0 ? tEnc0 : 0; // placeholder, encMs computed from tDiff0 - tEnc0
    const diffMs = diffResult.diffTotalMs;
    const vocMs = vocTotalMs;
    console.log(`[WebNN] ===== Synthesis Summary =====`);
    console.log(`[WebNN]   Input: ${tokenCount} tokens, ${totalFrames} frames, ${totalSteps} diffusion steps`);
    console.log(`[WebNN]   Diffusion:  ${diffMs.toFixed(0)}ms (${(diffMs / synthTotalMs * 100).toFixed(1)}%) — infer avg ${(diffResult.diffInferTotal / totalSteps).toFixed(0)}ms/step`);
    console.log(`[WebNN]   Vocoder:    ${vocMs.toFixed(0)}ms (${(vocMs / synthTotalMs * 100).toFixed(1)}%)`);
    console.log(`[WebNN]   Total:      ${synthTotalMs.toFixed(0)}ms`);
    console.log(`[WebNN]   Output: ${totalFrames} frames, ${(totalFrames * HOP_SIZE / SAMPLE_RATE).toFixed(1)}s audio`);
    console.log(`[WebNN] ================================`);

    return { audioData, totalFrames };
}

/**
 * 批量合成：同时处理 2 个片段，diffusion batch=4（2 片段 × 2 CFG）
 * @param {Array} paramsArray - 2 个 runSynthesis 参数对象的数组
 * @returns {Array} 2 个 { audioData, totalFrames } 的数组
 */
async function runSynthesisBatch(paramsArray) {
    if (!paramsArray || paramsArray.length === 0) return [];
    if (paramsArray.length === 1) return [await runSynthesis(paramsArray[0])];

    await ensureOrt();

    const ort = getOrt();
    const isFP16 = paramsArray[0].isFP16;
    const floatType = isFP16 ? 'float16' : 'float32';
    const useStaticShapes = paramsArray[0].useStaticShapes || false;

    // ===== Stage 1: Encode both segments in parallel =====
    const tEnc0 = performance.now();
    const segData = [];

    for (const params of paramsArray) {
        const { sequences, tokenCount, totalFrames, ptMelData, ptFrameCount } = params;

        const phonemeIds = new BigInt64Array(sequences.noteTextSeq.map(v => BigInt(v)));
        const pitchIds = new BigInt64Array(sequences.notePitchSeq.map(v => BigInt(v)));
        const typeIds = new BigInt64Array(sequences.noteTypeSeq.map(v => BigInt(v)));
        const f0IdsArr = new BigInt64Array(sequences.f0Ids.map(v => BigInt(v)));

        const bEncSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : tokenCount;
        const bEncF0Len = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFrames;
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

        const textEmb = useStaticShapes ? trimOutputToLength(textResults['embeddings'], tokenCount) : outputToFloat32(textResults['embeddings']);
        const pitchEmb = useStaticShapes ? trimOutputToLength(pitchResults['embeddings'], tokenCount) : outputToFloat32(pitchResults['embeddings']);
        const typeEmb = useStaticShapes ? trimOutputToLength(typeResults['embeddings'], tokenCount) : outputToFloat32(typeResults['embeddings']);
        const f0Emb = useStaticShapes ? trimOutputToLength(f0Results['embeddings'], totalFrames) : outputToFloat32(f0Results['embeddings']);

        const tokenEmb = new Float32Array(tokenCount * EMBED_DIM);
        for (let t = 0; t < tokenCount; t++) {
            for (let d = 0; d < EMBED_DIM; d++) {
                tokenEmb[t * EMBED_DIM + d] =
                    textEmb[t * EMBED_DIM + d] +
                    pitchEmb[t * EMBED_DIM + d] +
                    typeEmb[t * EMBED_DIM + d];
            }
        }

        const bPreflowSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : tokenCount;
        const bPreflowTokenEmb = useStaticShapes ? padToLength(tokenEmb, bPreflowSeqLen * EMBED_DIM) : tokenEmb;
        const featuresTensor = createFloatTensor(floatType, bPreflowTokenEmb, [1, bPreflowSeqLen, EMBED_DIM]);
        const preflowResults = await runSession('preflow', { features: featuresTensor });
        const processedTokenEmb = useStaticShapes ? trimOutputToLength(preflowResults['processed_features'], tokenCount) : outputToFloat32(preflowResults['processed_features']);

        const mel2token = sequences.mel2token;
        const totalCondFrames = ptFrameCount > 0 ? ptFrameCount + totalFrames : totalFrames;
        const condCodeData = new Float32Array(totalCondFrames * EMBED_DIM);
        for (let f = 0; f < totalFrames; f++) {
            const tokenIdx = mel2token[f];
            for (let d = 0; d < EMBED_DIM; d++) {
                condCodeData[(ptFrameCount + f) * EMBED_DIM + d] =
                    processedTokenEmb[tokenIdx * EMBED_DIM + d] + f0Emb[f * EMBED_DIM + d];
            }
        }

        const bCondSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalCondFrames;
        const bPaddedCondCode = useStaticShapes ? padToLength(condCodeData, bCondSeqLen * EMBED_DIM) : condCodeData;
        const condCodeTensor = createFloatTensor(floatType, bPaddedCondCode, [1, bCondSeqLen, EMBED_DIM]);
        const condEmbResults = await runSession('condEmb', { cond_code: condCodeTensor });
        const combinedCond = useStaticShapes ? trimOutputToLength(condEmbResults['cond_embedding'], totalCondFrames) : outputToFloat32(condEmbResults['cond_embedding']);

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
    const totalSteps = segData[0].totalSteps;
    const xts = await runBatchDiffusionLoop({ segData, totalSteps, floatType, useStaticShapes });

    // ===== Stage 3: Vocoder per segment =====
    const results = [];
    for (let si = 0; si < 2; si++) {
        const s = segData[si];
        const xt = xts[si];
        const totalSamples = s.totalFrames * HOP_SIZE;
        let audioData;

        const maxVocChunk = useStaticShapes ? NPU_VOCODER_SEQ_LEN : VOCODER_CHUNK_FRAMES;
        if (s.totalFrames <= maxVocChunk) {
            const bVocSeqLen = useStaticShapes ? NPU_VOCODER_SEQ_LEN : s.totalFrames;
            const paddedMel = useStaticShapes ? padToLength(xt, bVocSeqLen * MEL_DIM) : xt;
            const melTensor = createFloatTensor(floatType, paddedMel, [1, bVocSeqLen, MEL_DIM]);
            const vocoderResults = await runSession('vocoder', { mel: melTensor });
            const waveform = outputToFloat32(vocoderResults['waveform']);
            audioData = Array.from(waveform.subarray(0, Math.min(waveform.length, totalSamples)));
        } else {
            const result = await runSegmentedVocoder({
                xtData: xt,
                totalFrames: s.totalFrames,
                floatType,
                npuVocoderBatchSize: s.npuVocoderBatchSize,
                useStaticShapes,
            });
            audioData = result.audioData;
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
    loadModel,
    unloadModel,
    runInference,
    runSynthesis,
    runSynthesisBatch,
    getStatus,
};
