/**
 * WebNN 推理模块 — 长音频分段拼接
 */

import { MEL_DIM, HOP_SIZE, VOCODER_CHUNK_FRAMES, VOCODER_OVERLAP_FRAMES } from './constants.js';
import { runSession } from './sessionManager.js';
import { createFloatTensor, outputToFloat32 } from './utils.js';

/**
 * 分段 vocoder 推理 + 交叉淡入淡出拼接
 * @param {Object} params
 * @param {Float32Array} params.xtData - mel 数据
 * @param {number} params.totalFrames - 总帧数
 * @param {string} params.floatType - 'float32' 或 'float16'
 * @param {number} params.npuVocoderBatchSize - vocoder 批量大小
 * @returns {{ audioData: Float32Array, vocChunkCount: number, vocPrepTotal: number, vocInferTotal: number, vocPostTotal: number }}
 */
export async function runSegmentedVocoder({ xtData, totalFrames, floatType, npuVocoderBatchSize }) {
    const totalSamples = totalFrames * HOP_SIZE;
    const chunkSize = VOCODER_CHUNK_FRAMES;
    const overlapFrames = VOCODER_OVERLAP_FRAMES;
    const vocBatch = Math.max(1, npuVocoderBatchSize);
    const output = new Float32Array(totalSamples);
    const weightSum = new Float32Array(totalSamples);
    const stepFrames = chunkSize - overlapFrames;
    const fadeSamples = overlapFrames * HOP_SIZE;
    const fadeWindow = new Float32Array(fadeSamples);
    for (let i = 0; i < fadeSamples; i++) {
        fadeWindow[i] = 0.5 * (1 - Math.cos(Math.PI * i / fadeSamples));
    }

    let vocChunkCount = 0, vocInferTotal = 0, vocPrepTotal = 0, vocPostTotal = 0;

    let offset = 0;
    while (offset < totalFrames) {
        // Collect up to vocBatch chunks
        const batchMels = [];
        const batchInfos = [];
        let maxChunkFrames = 0;

        for (let b = 0; b < vocBatch && offset < totalFrames; b++) {
            const end = Math.min(offset + chunkSize, totalFrames);
            const chunkFrames = end - offset;
            const chunkMel = new Float32Array(chunkFrames * MEL_DIM);
            for (let f = 0; f < chunkFrames; f++) {
                for (let d = 0; d < MEL_DIM; d++) {
                    chunkMel[f * MEL_DIM + d] = xtData[(offset + f) * MEL_DIM + d];
                }
            }
            batchMels.push(chunkMel);
            batchInfos.push({ offset, chunkFrames, end });
            maxChunkFrames = Math.max(maxChunkFrames, chunkFrames);
            offset += stepFrames;
        }

        const batchSize = batchMels.length;
        vocChunkCount += batchSize;
        const tVocBatchPrep = performance.now();

        if (batchSize === 1) {
            // Single chunk, run directly
            const info = batchInfos[0];
            const melTensor = createFloatTensor(floatType, batchMels[0], [1, info.chunkFrames, MEL_DIM]);
            const prepMs = performance.now() - tVocBatchPrep;

            const tVocBatchInfer = performance.now();
            const vocoderResults = await runSession('vocoder', { mel: melTensor });
            const inferMs = performance.now() - tVocBatchInfer;

            const tVocBatchPost = performance.now();
            const waveform = outputToFloat32(vocoderResults['waveform']);
            const chunkSamples = info.chunkFrames * HOP_SIZE;
            const startSample = info.offset * HOP_SIZE;

            for (let i = 0; i < chunkSamples; i++) {
                const idx = startSample + i;
                if (idx < totalSamples) {
                    let w = 1.0;
                    if (info.offset > 0 && i < fadeSamples) w = fadeWindow[i];
                    if (info.end < totalFrames && i >= chunkSamples - fadeSamples) w = fadeWindow[chunkSamples - 1 - i];
                    output[idx] += waveform[i] * w;
                    weightSum[idx] += w;
                }
            }
            const postMs = performance.now() - tVocBatchPost;
            vocPrepTotal += prepMs;
            vocInferTotal += inferMs;
            vocPostTotal += postMs;
            console.log(`[WebNN]   vocoder chunk [${info.offset}-${info.end}/${totalFrames}]: prep=${prepMs.toFixed(1)} infer=${inferMs.toFixed(1)} post=${postMs.toFixed(1)}`);
        } else {
            // Batch inference: pad all chunks to maxChunkFrames
            const batchData = new Float32Array(batchSize * maxChunkFrames * MEL_DIM);
            for (let b = 0; b < batchSize; b++) {
                const mel = batchMels[b];
                const frames = batchInfos[b].chunkFrames;
                for (let f = 0; f < frames; f++) {
                    for (let d = 0; d < MEL_DIM; d++) {
                        batchData[(b * maxChunkFrames + f) * MEL_DIM + d] = mel[f * MEL_DIM + d];
                    }
                }
            }

            const melTensor = createFloatTensor(floatType, batchData, [batchSize, maxChunkFrames, MEL_DIM]);
            const prepMs = performance.now() - tVocBatchPrep;

            const tVocBatchInfer = performance.now();
            const vocoderResults = await runSession('vocoder', { mel: melTensor });
            const inferMs = performance.now() - tVocBatchInfer;

            const tVocBatchPost = performance.now();
            const batchWaveform = outputToFloat32(vocoderResults['waveform']);
            const samplesPerChunk = maxChunkFrames * HOP_SIZE;

            for (let b = 0; b < batchSize; b++) {
                const info = batchInfos[b];
                const chunkSamples = info.chunkFrames * HOP_SIZE;
                const startSample = info.offset * HOP_SIZE;
                const waveOff = b * samplesPerChunk;

                for (let i = 0; i < chunkSamples; i++) {
                    const idx = startSample + i;
                    if (idx < totalSamples) {
                        let w = 1.0;
                        if (info.offset > 0 && i < fadeSamples) w = fadeWindow[i];
                        if (info.end < totalFrames && i >= chunkSamples - fadeSamples) w = fadeWindow[chunkSamples - 1 - i];
                        output[idx] += batchWaveform[waveOff + i] * w;
                        weightSum[idx] += w;
                    }
                }
            }
            const postMs = performance.now() - tVocBatchPost;
            vocPrepTotal += prepMs;
            vocInferTotal += inferMs;
            vocPostTotal += postMs;
            const chunkRange = batchInfos.map(i => `${i.offset}-${i.end}`).join(', ');
            console.log(`[WebNN]   vocoder batch=${batchSize} [${chunkRange}]: prep=${prepMs.toFixed(1)} infer=${inferMs.toFixed(1)} post=${postMs.toFixed(1)}`);
        }
    }
    for (let i = 0; i < totalSamples; i++) {
        if (weightSum[i] > 0) output[i] /= weightSum[i];
    }
    const audioData = output.slice(); // TypedArray.slice() 替代 Array.from()

    return { audioData, vocChunkCount, vocPrepTotal, vocInferTotal, vocPostTotal };
}
