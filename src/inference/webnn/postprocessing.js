/**
 * WebNN 推理模块 — Vocoder、mel-to-audio 转换
 */

import { MEL_DIM, HOP_SIZE, VOCODER_CHUNK_FRAMES, NPU_VOCODER_SEQ_LEN, VOCODER_OUTPUT_TRIM_SAMPLES } from './constants.js';
import { runSession } from './sessionManager.js';
import { createFloatTensor, outputToFloat32, padToLength } from './utils.js';
import { runSegmentedVocoder } from './audioSegmentation.js';

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
        console.log(`[WebNN] vocoder (single): prep=${vocPrepMs.toFixed(1)} infer=${vocInferMs.toFixed(1)} post=${vocPostMs.toFixed(1)} [${totalFrames}frames → ${totalSamples}samples${useStaticShapes ? ', NPU static' : ''}]`);

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

    // Clip to [-1, 1] 防止爆音（流式播放与最终返回使用同一份音频，不做 peak 归一化以保持段间音量一致）
    for (let i = 0; i < audioData.length; i++) {
        if (audioData[i] > 1.0) audioData[i] = 1.0;
        else if (audioData[i] < -1.0) audioData[i] = -1.0;
    }

    return { audioData, vocTotalMs };
}
