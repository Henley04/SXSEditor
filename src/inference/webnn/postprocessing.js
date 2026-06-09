/**
 * WebNN 推理模块 — Vocoder、mel-to-audio 转换
 */

import { MEL_DIM, HOP_SIZE, VOCODER_CHUNK_FRAMES } from './constants.js';
import { runSession } from './sessionManager.js';
import { createFloatTensor, outputToFloat32 } from './utils.js';
import { runSegmentedVocoder } from './audioSegmentation.js';

/**
 * 运行 vocoder 将 mel 转换为音频
 * @param {Object} params
 * @param {Float32Array} params.xtData - mel 数据
 * @param {number} params.totalFrames - 总帧数
 * @param {string} params.floatType - 'float32' 或 'float16'
 * @param {number} params.npuVocoderBatchSize - vocoder 批量大小
 * @returns {{ audioData: Float32Array, vocTotalMs: number }}
 */
export async function runVocoder({ xtData, totalFrames, floatType, npuVocoderBatchSize }) {
    const totalSamples = totalFrames * HOP_SIZE;
    const tVoc0 = performance.now();
    let audioData;
    let vocChunkCount = 0, vocInferTotal = 0, vocPrepTotal = 0, vocPostTotal = 0;

    if (totalFrames <= VOCODER_CHUNK_FRAMES) {
        const tVocPrep = performance.now();
        const melTensor = createFloatTensor(floatType, xtData, [1, totalFrames, MEL_DIM]);
        const vocPrepMs = performance.now() - tVocPrep;

        const tVocInfer = performance.now();
        const vocoderResults = await runSession('vocoder', { mel: melTensor });
        const vocInferMs = performance.now() - tVocInfer;

        const tVocPost = performance.now();
        const waveform = outputToFloat32(vocoderResults['waveform']);
        const trimmed = waveform.subarray(0, Math.min(waveform.length, totalSamples));
        audioData = trimmed.slice(); // TypedArray.slice() 比 Array.from() 快得多
        const vocPostMs = performance.now() - tVocPost;

        vocChunkCount = 1;
        vocPrepTotal = vocPrepMs;
        vocInferTotal = vocInferMs;
        vocPostTotal = vocPostMs;
        console.log(`[WebNN] vocoder (single): prep=${vocPrepMs.toFixed(1)} infer=${vocInferMs.toFixed(1)} post=${vocPostMs.toFixed(1)} [${totalFrames}frames → ${totalSamples}samples]`);
    } else {
        // Chunked vocoder with batch processing
        const result = await runSegmentedVocoder({ xtData, totalFrames, floatType, npuVocoderBatchSize });
        audioData = result.audioData;
        vocChunkCount = result.vocChunkCount;
        vocPrepTotal = result.vocPrepTotal;
        vocInferTotal = result.vocInferTotal;
        vocPostTotal = result.vocPostTotal;
    }

    const vocTotalMs = performance.now() - tVoc0;
    console.log(`[WebNN] Vocoder total: ${vocTotalMs.toFixed(0)}ms (${vocChunkCount} chunks, batch=${npuVocoderBatchSize})`);
    console.log(`[WebNN]   prep  — total=${vocPrepTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   infer — total=${vocInferTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   post  — total=${vocPostTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   overhead: ${(vocTotalMs - vocPrepTotal - vocInferTotal - vocPostTotal).toFixed(0)}ms`);

    return { audioData, vocTotalMs };
}
