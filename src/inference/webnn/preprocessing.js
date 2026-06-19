/**
 * WebNN 推理模块 — 预处理：文本/音素编码、音高编码、F0 编码
 */

import { MEL_DIM, EMBED_DIM, COND_DIM, NPU_STATIC_SEQ_LEN } from './constants.js';
import { ensureOrt, getOrt } from './ortSetup.js';
import { runSession } from './sessionManager.js';
import { createFloatTensor, outputToFloat32, padInt64ToLength, padToLength, trimOutputToLength } from './utils.js';

/**
 * 运行编码器阶段（4 个编码器 + preflow + condEmb）
 * @param {Object} params
 * @param {Object} params.sequences - notesToSequences 的输出
 * @param {number} params.tokenCount - token 数量
 * @param {number} params.totalFrames - 总帧数
 * @param {number} params.ptFrameCount - 参考音频帧数
 * @param {Float32Array|null} params.ptMelData - 参考音频 mel 数据
 * @param {string} params.floatType - 'float32' 或 'float16'
 * @returns {{ combinedCond: Float32Array, totalCondFrames: number, totalFramesWithPrompt: number }}
 */
export async function runEncoderStage({ sequences, tokenCount, totalFrames, ptFrameCount, ptMelData, floatType, useStaticShapes = false }) {
    await ensureOrt();
    const ort = getOrt();

    const tEnc0 = performance.now();

    const phonemeIds = new BigInt64Array(sequences.noteTextSeq.map(v => BigInt(v)));
    const pitchIds = new BigInt64Array(sequences.notePitchSeq.map(v => BigInt(v)));
    const typeIds = new BigInt64Array(sequences.noteTypeSeq.map(v => BigInt(v)));
    const f0IdsArr = new BigInt64Array(sequences.f0Ids.map(v => BigInt(v)));
    const tEncPrep = performance.now();

    const encSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : tokenCount;
    const encF0Len = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFrames;

    const encPaddedText = useStaticShapes ? padInt64ToLength(phonemeIds, encSeqLen) : phonemeIds;
    const encPaddedPitch = useStaticShapes ? padInt64ToLength(pitchIds, encSeqLen) : pitchIds;
    const encPaddedType = useStaticShapes ? padInt64ToLength(typeIds, encSeqLen) : typeIds;
    const encPaddedF0 = useStaticShapes ? padInt64ToLength(f0IdsArr, encF0Len) : f0IdsArr;

    // Run 4 encoders in parallel (they are independent)
    const t4 = performance.now();
    const [textResults, pitchResults, typeResults, f0Results] = await Promise.all([
        runSession('noteTextEncoder', { input_ids: new ort.Tensor('int64', encPaddedText, [1, encSeqLen]) }),
        runSession('notePitchEncoder', { input_ids: new ort.Tensor('int64', encPaddedPitch, [1, encSeqLen]) }),
        runSession('noteTypeEncoder', { input_ids: new ort.Tensor('int64', encPaddedType, [1, encSeqLen]) }),
        runSession('f0Encoder', { input_ids: new ort.Tensor('int64', encPaddedF0, [1, encF0Len]) }),
    ]);
    const encInferMs = performance.now() - t4;
    console.log(`[WebNN] 4 encoders (parallel): ${encInferMs.toFixed(0)}ms [tokens=${tokenCount}, f0Frames=${totalFrames}${useStaticShapes ? ', NPU static' : ''}]`);
    console.log(`[WebNN]   enc prep: ${(t4 - tEncPrep).toFixed(1)}ms, infer: ${encInferMs.toFixed(1)}ms`);

    const tEncPost = performance.now();
    const textEmb = useStaticShapes ? trimOutputToLength(textResults['embeddings'], tokenCount) : outputToFloat32(textResults['embeddings']);
    const pitchEmb = useStaticShapes ? trimOutputToLength(pitchResults['embeddings'], tokenCount) : outputToFloat32(pitchResults['embeddings']);
    const typeEmb = useStaticShapes ? trimOutputToLength(typeResults['embeddings'], tokenCount) : outputToFloat32(typeResults['embeddings']);
    const f0Emb = useStaticShapes ? trimOutputToLength(f0Results['embeddings'], totalFrames) : outputToFloat32(f0Results['embeddings']);

    // Combine token embeddings
    const tokenEmb = new Float32Array(tokenCount * EMBED_DIM);
    for (let t = 0; t < tokenCount; t++) {
        for (let d = 0; d < EMBED_DIM; d++) {
            tokenEmb[t * EMBED_DIM + d] =
                textEmb[t * EMBED_DIM + d] +
                pitchEmb[t * EMBED_DIM + d] +
                typeEmb[t * EMBED_DIM + d];
        }
    }
    console.log(`[WebNN]   enc postprocess (combine embeddings): ${(performance.now() - tEncPost).toFixed(1)}ms`);

    // Preflow
    const tpf = performance.now();
    const preflowSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : tokenCount;
    const preflowTokenEmb = useStaticShapes ? padToLength(tokenEmb, preflowSeqLen * EMBED_DIM) : tokenEmb;
    const featuresTensor = createFloatTensor(floatType, preflowTokenEmb, [1, preflowSeqLen, EMBED_DIM]);
    const preflowResults = await runSession('preflow', { features: featuresTensor });
    const processedTokenEmb = useStaticShapes ? trimOutputToLength(preflowResults['processed_features'], tokenCount) : outputToFloat32(preflowResults['processed_features']);
    console.log(`[WebNN] preflow: ${(performance.now() - tpf).toFixed(0)}ms [${tokenCount}tokens × ${EMBED_DIM}${useStaticShapes ? ', NPU static' : ''}]`);

    // Expand and combine with f0
    const tExpand = performance.now();
    const mel2token = sequences.mel2token;
    const totalCondFrames = ptFrameCount > 0 ? ptFrameCount + totalFrames : totalFrames;
    const condCodeData = new Float32Array(totalCondFrames * EMBED_DIM);
    for (let f = 0; f < totalFrames; f++) {
        const tokenIdx = mel2token[f];
        for (let d = 0; d < EMBED_DIM; d++) {
            const combined = processedTokenEmb[tokenIdx * EMBED_DIM + d] + f0Emb[f * EMBED_DIM + d];
            condCodeData[(ptFrameCount + f) * EMBED_DIM + d] = combined;
        }
    }
    console.log(`[WebNN]   expand+combine (mel2token+f0): ${(performance.now() - tExpand).toFixed(1)}ms [${totalCondFrames}condFrames]`);

    // Cond embedding
    const tce = performance.now();
    const condSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalCondFrames;
    const paddedCondCode = useStaticShapes ? padToLength(condCodeData, condSeqLen * EMBED_DIM) : condCodeData;
    const condCodeTensor = createFloatTensor(floatType, paddedCondCode, [1, condSeqLen, EMBED_DIM]);
    const condEmbResults = await runSession('condEmb', { cond_code: condCodeTensor });
    const combinedCond = useStaticShapes ? trimOutputToLength(condEmbResults['cond_embedding'], totalCondFrames) : outputToFloat32(condEmbResults['cond_embedding']);
    console.log(`[WebNN] condEmb: ${(performance.now() - tce).toFixed(0)}ms [${totalCondFrames}frames × ${COND_DIM}${useStaticShapes ? ', NPU static' : ''}]`);

    console.log(`[WebNN] Encoder total: ${(performance.now() - tEnc0).toFixed(0)}ms`);

    return {
        combinedCond,
        totalCondFrames,
        totalFramesWithPrompt: ptFrameCount + totalFrames,
        f0Emb,
    };
}
