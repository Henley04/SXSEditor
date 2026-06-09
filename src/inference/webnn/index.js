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
import { HOP_SIZE, MEL_DIM, EMBED_DIM, COND_DIM, VOCODER_CHUNK_FRAMES } from './constants.js';
import { ensureOrt, getOrt } from './ortSetup.js';
import { outputToFloat32, createFloatTensor } from './utils.js';
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

    const {
        sequences, tokenCount, totalFrames,
        ptMelData, ptFrameCount,
        totalSteps, cfgStrength, cfgRescale,
        isFP16,
        npuDiffBatchSize = 4,
        npuVocoderBatchSize = 2,
    } = params;

    const floatType = isFP16 ? 'float16' : 'float32';

    // ===== Stage 1: Encoder =====
    const tEnc0 = performance.now();
    const { combinedCond, totalCondFrames, totalFramesWithPrompt } = await runEncoderStage({
        sequences, tokenCount, totalFrames, ptFrameCount, ptMelData, floatType,
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
    });

    // ===== Stage 3: Vocoder =====
    const { audioData, vocTotalMs } = await runVocoder({
        xtData: diffResult.xtData,
        totalFrames,
        floatType,
        npuVocoderBatchSize,
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
    console.log(`[WebNN]   Output: ${totalFrames} frames, ${(totalFrames * HOP_SIZE / 24000).toFixed(1)}s audio`);
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

    // ===== Stage 1: Encode both segments in parallel =====
    const tEnc0 = performance.now();
    const segData = [];

    for (const params of paramsArray) {
        const { sequences, tokenCount, totalFrames, ptMelData, ptFrameCount } = params;

        const phonemeIds = new BigInt64Array(sequences.noteTextSeq.map(v => BigInt(v)));
        const pitchIds = new BigInt64Array(sequences.notePitchSeq.map(v => BigInt(v)));
        const typeIds = new BigInt64Array(sequences.noteTypeSeq.map(v => BigInt(v)));
        const f0IdsArr = new BigInt64Array(sequences.f0Ids.map(v => BigInt(v)));

        const [textResults, pitchResults, typeResults, f0Results] = await Promise.all([
            runSession('noteTextEncoder', { input_ids: new ort.Tensor('int64', phonemeIds, [1, tokenCount]) }),
            runSession('notePitchEncoder', { input_ids: new ort.Tensor('int64', pitchIds, [1, tokenCount]) }),
            runSession('noteTypeEncoder', { input_ids: new ort.Tensor('int64', typeIds, [1, tokenCount]) }),
            runSession('f0Encoder', { input_ids: new ort.Tensor('int64', f0IdsArr, [1, totalFrames]) }),
        ]);

        const textEmb = outputToFloat32(textResults['embeddings']);
        const pitchEmb = outputToFloat32(pitchResults['embeddings']);
        const typeEmb = outputToFloat32(typeResults['embeddings']);
        const f0Emb = outputToFloat32(f0Results['embeddings']);

        const tokenEmb = new Float32Array(tokenCount * EMBED_DIM);
        for (let t = 0; t < tokenCount; t++) {
            for (let d = 0; d < EMBED_DIM; d++) {
                tokenEmb[t * EMBED_DIM + d] =
                    textEmb[t * EMBED_DIM + d] +
                    pitchEmb[t * EMBED_DIM + d] +
                    typeEmb[t * EMBED_DIM + d];
            }
        }

        const featuresTensor = createFloatTensor(floatType, tokenEmb, [1, tokenCount, EMBED_DIM]);
        const preflowResults = await runSession('preflow', { features: featuresTensor });
        const processedTokenEmb = outputToFloat32(preflowResults['processed_features']);

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

        const condCodeTensor = createFloatTensor(floatType, condCodeData, [1, totalCondFrames, EMBED_DIM]);
        const condEmbResults = await runSession('condEmb', { cond_code: condCodeTensor });
        const combinedCond = outputToFloat32(condEmbResults['cond_embedding']);

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
    const xts = await runBatchDiffusionLoop({ segData, totalSteps, floatType });

    // ===== Stage 3: Vocoder per segment =====
    const results = [];
    for (let si = 0; si < 2; si++) {
        const s = segData[si];
        const xt = xts[si];
        const totalSamples = s.totalFrames * HOP_SIZE;
        let audioData;

        if (s.totalFrames <= VOCODER_CHUNK_FRAMES) {
            const melTensor = createFloatTensor(floatType, xt, [1, s.totalFrames, MEL_DIM]);
            const vocoderResults = await runSession('vocoder', { mel: melTensor });
            const waveform = outputToFloat32(vocoderResults['waveform']);
            audioData = Array.from(waveform.subarray(0, Math.min(waveform.length, totalSamples)));
        } else {
            const result = await runSegmentedVocoder({
                xtData: xt,
                totalFrames: s.totalFrames,
                floatType,
                npuVocoderBatchSize: s.npuVocoderBatchSize,
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
