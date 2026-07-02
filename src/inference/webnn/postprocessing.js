/**
 * WebNN 推理模块 — Vocoder、mel-to-audio 转换
 */

import { MEL_DIM, HOP_SIZE, VOCODER_CHUNK_FRAMES, NPU_VOCODER_SEQ_LEN, VOCODER_OUTPUT_TRIM_SAMPLES } from './constants.js';
import { runSession } from './sessionManager.js';
import { createFloatTensor, outputToFloat32, padToLength } from './utils.js';
import { runSegmentedVocoder } from './audioSegmentation.js';

/**
 * 将音频峰值归一化到 threshold（默认 0.95），与 DML pipeline/utils.js 保持一致。
 * 用于 WebNN 路径，确保 DML↔WebNN 后端切换时段间响度匹配。
 * @param {Float32Array|number[]} arr - 原地修改
 * @param {number} [threshold=0.95]
 */
export function normalizePeakTo(arr, threshold = 0.95) {
    let peak = 0;
    for (let i = 0; i < arr.length; i++) {
        const abs = Math.abs(arr[i]);
        if (abs > peak) peak = abs;
    }
    if (peak > threshold) {
        const scale = threshold / peak;
        for (let i = 0; i < arr.length; i++) arr[i] *= scale;
    }
}

/**
 * 运行 vocoder 将 mel 转换为音频（强制串行，支持流式回调）
 * @param {Object} params
 * @param {Float32Array} params.xtData - mel 数据
 * @param {number} params.totalFrames - 总帧数
 * @param {string} params.floatType - 'float32' 或 'float16'
 * @param {number} params.npuVocoderBatchSize - vocoder 批量大小（已忽略，强制 1，保留向后兼容）
 * @param {boolean} params.useStaticShapes - 是否使用 NPU 静态形状
 * @param {function} [params.onChunkComplete] - chunk 完成回调（流式播放用）
 * @returns {{ audioData: Float32Array, vocTotalMs: number }}
 */
export async function runVocoder({ xtData, totalFrames, floatType, npuVocoderBatchSize, useStaticShapes = false, vocoderChunkFrames = 0, onChunkComplete = null }) {
    const totalSamples = totalFrames * HOP_SIZE;
    const tVoc0 = performance.now();
    let audioData;
    let vocChunkCount = 0, vocInferTotal = 0, vocPrepTotal = 0, vocPostTotal = 0;

    const effectiveVocChunk = (vocoderChunkFrames && vocoderChunkFrames > 0) ? vocoderChunkFrames : VOCODER_CHUNK_FRAMES;
    const vocSeqLen = useStaticShapes ? NPU_VOCODER_SEQ_LEN : totalFrames;
    const maxSingleChunk = useStaticShapes ? NPU_VOCODER_SEQ_LEN : effectiveVocChunk;

    if (totalFrames <= maxSingleChunk) {
        const tVocPrep = performance.now();
        const paddedMel = useStaticShapes ? padToLength(xtData, vocSeqLen * MEL_DIM) : xtData;
        const melTensor = createFloatTensor(floatType, paddedMel, [1, vocSeqLen, MEL_DIM]);
        const vocPrepMs = performance.now() - tVocPrep;

        const tVocInfer = performance.now();
        const vocoderResults = await runSession('vocoder', { mel: melTensor });
        const vocInferMs = performance.now() - tVocInfer;

        const tVocPost = performance.now();
        const waveform = outputToFloat32(vocoderResults['waveform']);
        // Vocoder ISTFT Conv + Slice 产生略少于 seq_len*HOP_SIZE 的样本
        // 实际输出 = seq_len*HOP_SIZE - VOCODER_OUTPUT_TRIM_SAMPLES
        const trimmed = waveform.subarray(0, Math.min(waveform.length, totalSamples));
        audioData = trimmed.slice(); // TypedArray.slice() 比 Array.from() 快得多
        const vocPostMs = performance.now() - tVocPost;

        vocChunkCount = 1;
        vocPrepTotal = vocPrepMs;
        vocInferTotal = vocInferMs;
        vocPostTotal = vocPostMs;
        console.log(`[WebNN] vocoder (single): prep=${vocPrepMs.toFixed(1)} infer=${vocInferMs.toFixed(1)} post=${vocPostMs.toFixed(1)} [${totalFrames}frames -> ${totalSamples}samples${useStaticShapes ? ', NPU static' : ''}]`);

        // Peak 归一化（与 DML postprocessing.js:788 单 chunk 路径一致）。
        // 在 onChunkComplete 流式推送之前归一化，确保流式音频与最终返回音频响度一致。
        normalizePeakTo(audioData);

        // 单 chunk 路径：一次性推送全部音频（流式播放用）
        if (onChunkComplete) {
            try {
                onChunkComplete({
                    chunkIndex: 0,
                    sampleOffset: 0,
                    sampleEnd: audioData.length,
                    audio: audioData,
                    totalSamples: audioData.length,
                    isLast: true,
                });
            } catch (e) {
                console.warn('[WebNN] onChunkComplete callback error:', e.message);
            }
        }
    } else {
        // Chunked vocoder（强制串行，runSegmentedVocoder 内部已禁用 batch）
        const result = await runSegmentedVocoder({ xtData, totalFrames, floatType, npuVocoderBatchSize, useStaticShapes, vocoderChunkFrames: effectiveVocChunk, onChunkComplete });
        audioData = result.audioData;
        vocChunkCount = result.vocChunkCount;
        vocPrepTotal = result.vocPrepTotal;
        vocInferTotal = result.vocInferTotal;
        vocPostTotal = result.vocPostTotal;
    }

    const vocTotalMs = performance.now() - tVoc0;
    console.log(`[WebNN] Vocoder total: ${vocTotalMs.toFixed(0)}ms (${vocChunkCount} chunks, serial)`);
    console.log(`[WebNN]   prep  — total=${vocPrepTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   infer — total=${vocInferTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   post  — total=${vocPostTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   overhead: ${(vocTotalMs - vocPrepTotal - vocInferTotal - vocPostTotal).toFixed(0)}ms`);

    // Peak 归一化到 0.95（与 DML postprocessing.js:951 chunked 路径一致）。
    // 单 chunk 路径已在上方归一化，此处为 no-op；chunked 路径在此完成首次归一化。
    // 替代旧版 clip-to-[-1,1]：归一化后峰值 ≤0.95 <1.0，自然防爆音，且段间响度匹配 DML。
    normalizePeakTo(audioData);

    return { audioData, vocTotalMs };
}
