/**
 * WebNN 推理模块 — 长音频分段拼接
 *
 * 注意：vocoder 强制串行执行（vocBatch=1）。
 * DML 后端下，单次 session.run() 提交 [batch>1, ...] 张量会显著增加 GPU 单次 kernel 工作量，
 * 触发 TDR 超时 / DXGI_ERROR_DEVICE_REMOVED (0x887A0006)。
 * 旧版本的 batch 并行分支已移除，所有 chunk 按顺序逐个推理。
 */

import { MEL_DIM, HOP_SIZE, VOCODER_CHUNK_FRAMES, VOCODER_OVERLAP_FRAMES, NPU_VOCODER_SEQ_LEN } from './constants.js';
import { runSession } from './sessionManager.js';
import { createFloatTensor, outputToFloat32, padToLength } from './utils.js';

/**
 * 分段 vocoder 推理 + 交叉淡入淡出拼接（强制串行）
 * @param {Object} params
 * @param {Float32Array} params.xtData - mel 数据
 * @param {number} params.totalFrames - 总帧数
 * @param {string} params.floatType - 'float32' 或 'float16'
 * @param {number} params.npuVocoderBatchSize - vocoder 批量大小（已忽略，强制为 1，保留参数向后兼容）
 * @param {boolean} params.useStaticShapes - 是否使用 NPU 静态形状
 * @param {number} [params.vocoderChunkFrames=0] - 每段 vocoder 的帧数（仅 useStaticShapes=false 时生效；<=0 回退 VOCODER_CHUNK_FRAMES）
 *        由设置项「智能分配/手动设置」决定，pipeline 在调用前解析后透传。
 * @param {function} [params.onChunkComplete] - 每个 chunk 完成后的回调，签名 (chunkInfo) => void
 *        chunkInfo = { chunkIndex, sampleOffset, audio: Float32Array, totalSamples, isLast }
 *        audio 为该 chunk 贡献的"已确定"音频段（weightSum=1，可直接播放），按顺序拼接即得完整音频。
 * @returns {{ audioData: Float32Array, vocChunkCount: number, vocPrepTotal: number, vocInferTotal: number, vocPostTotal: number }}
 */
export async function runSegmentedVocoder({ xtData, totalFrames, floatType, npuVocoderBatchSize, useStaticShapes = false, vocoderChunkFrames = 0, onChunkComplete = null }) {
    const totalSamples = totalFrames * HOP_SIZE;
    const effectiveVocChunk = (vocoderChunkFrames && vocoderChunkFrames > 0) ? vocoderChunkFrames : VOCODER_CHUNK_FRAMES;
    const chunkSize = useStaticShapes ? Math.min(VOCODER_CHUNK_FRAMES, NPU_VOCODER_SEQ_LEN) : effectiveVocChunk;
    const overlapFrames = VOCODER_OVERLAP_FRAMES;
    // 强制串行：忽略 npuVocoderBatchSize，永远 1 个 chunk 一次推理。
    // DML batch 并行会触发 GPU 设备移除（0x887A0006），见文件头注释。
    void npuVocoderBatchSize;
    const output = new Float32Array(totalSamples);
    const weightSum = new Float32Array(totalSamples);
    const stepFrames = chunkSize - overlapFrames;
    const fadeSamples = overlapFrames * HOP_SIZE;
    const fadeWindow = new Float32Array(fadeSamples);
    for (let i = 0; i < fadeSamples; i++) {
        fadeWindow[i] = 0.5 * (1 - Math.cos(Math.PI * i / fadeSamples));
    }

    const vocSeqLen = useStaticShapes ? NPU_VOCODER_SEQ_LEN : 0;

    let vocChunkCount = 0, vocInferTotal = 0, vocPrepTotal = 0, vocPostTotal = 0;

    // 流式播放：committedSamples 标记已通过 onChunkComplete 推送的样本位置。
    // 每完成一个 chunk，推送 [committedSamples, stableEnd] 区间（weightSum=1，已归一化）。
    // - 首 chunk：stableEnd = (isLast ? chunkEnd : chunkEnd - overlapFrames) * HOP_SIZE
    // - 中间 chunk：stableEnd = (isLast ? chunkEnd : chunkEnd - overlapFrames) * HOP_SIZE
    //   该 chunk 推送时包含头部 overlap 的 crossfade 结果（前 chunk 已写入 fade-out，本 chunk 写入 fade-in，weightSum=1）
    //   和稳定段（weightSum=1）。
    // - 末 chunk：stableEnd = chunkEnd * HOP_SIZE（尾部无 fade）
    let committedSamples = 0;
    let chunkIndex = 0;

    let offset = 0;
    while (offset < totalFrames) {
        const end = Math.min(offset + chunkSize, totalFrames);
        const chunkFrames = end - offset;
        const isLast = end >= totalFrames;
        const isFirst = chunkIndex === 0;

        // 单 chunk 推理（强制串行，无 batch）
        const chunkMel = new Float32Array(chunkFrames * MEL_DIM);
        for (let f = 0; f < chunkFrames; f++) {
            for (let d = 0; d < MEL_DIM; d++) {
                chunkMel[f * MEL_DIM + d] = xtData[(offset + f) * MEL_DIM + d];
            }
        }

        const tVocPrep = performance.now();
        const singleVocLen = useStaticShapes ? Math.max(chunkFrames, vocSeqLen) : chunkFrames;
        const paddedMel = useStaticShapes ? padToLength(chunkMel, singleVocLen * MEL_DIM) : chunkMel;
        const melTensor = createFloatTensor(floatType, paddedMel, [1, singleVocLen, MEL_DIM]);
        const prepMs = performance.now() - tVocPrep;

        const tVocInfer = performance.now();
        const vocoderResults = await runSession('vocoder', { mel: melTensor });
        const inferMs = performance.now() - tVocInfer;

        const tVocPost = performance.now();
        const waveform = outputToFloat32(vocoderResults['waveform']);
        const chunkSamples = chunkFrames * HOP_SIZE;
        const startSample = offset * HOP_SIZE;

        for (let i = 0; i < chunkSamples; i++) {
            const idx = startSample + i;
            if (idx < totalSamples) {
                let w = 1.0;
                if (!isFirst && i < fadeSamples) w = fadeWindow[i];
                if (!isLast && i >= chunkSamples - fadeSamples) w = fadeWindow[chunkSamples - 1 - i];
                output[idx] += waveform[i] * w;
                weightSum[idx] += w;
            }
        }
        const postMs = performance.now() - tVocPost;
        vocPrepTotal += prepMs;
        vocInferTotal += inferMs;
        vocPostTotal += postMs;
        vocChunkCount++;
        console.log(`[WebNN]   vocoder chunk #${chunkIndex} [${offset}-${end}/${totalFrames}]: prep=${prepMs.toFixed(1)} infer=${inferMs.toFixed(1)} post=${postMs.toFixed(1)}${isLast ? ' (last)' : ''}`);

        // 流式推送：推送 [committedSamples, stableEnd]（weightSum=1，已归一化）
        if (onChunkComplete) {
            const stableEndFrames = isLast ? end : (end - overlapFrames);
            const stableEnd = Math.min(stableEndFrames * HOP_SIZE, totalSamples);
            if (stableEnd > committedSamples) {
                const segAudio = output.slice(committedSamples, stableEnd);
                try {
                    onChunkComplete({
                        chunkIndex,
                        sampleOffset: committedSamples,
                        sampleEnd: stableEnd,
                        audio: segAudio,
                        totalSamples,
                        isLast,
                    });
                } catch (e) {
                    console.warn('[WebNN] onChunkComplete callback error:', e.message);
                }
                committedSamples = stableEnd;
            }
        }

        chunkIndex++;
        offset += stepFrames;
    }

    // 归一化 overlap 区间（weightSum>0 的样本除以权重）。流式已推送的稳定段 weightSum=1，不受影响。
    for (let i = 0; i < totalSamples; i++) {
        if (weightSum[i] > 0 && weightSum[i] !== 1) {
            output[i] /= weightSum[i];
        }
    }

    const audioData = output.slice();

    return { audioData, vocChunkCount, vocPrepTotal, vocInferTotal, vocPostTotal };
}
