/**
 * WebNN 推理模块 — 预处理：文本/音素编码、音高编码、F0 编码
 */

import { EMBED_DIM, COND_DIM, NPU_STATIC_SEQ_LEN } from './constants.js';
import { ensureOrt, getOrt } from './ortSetup.js';
import { runSession } from './sessionManager.js';
import { createFloatTensor, outputToFloat32, padInt64ToLength, padToLength, trimOutputToLength, disposeTensor } from './utils.js';

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
export async function runEncoderStage({ sequences, tokenCount, totalFrames, ptFrameCount, _ptMelData, floatType, useStaticShapes = false, promptSeq = null }) {
    await ensureOrt();
    const ort = getOrt();

    const tEnc0 = performance.now();

    // P1 fix: When promptSeq is provided, merge prompt + target token sequences
    // so the prompt section of cond has full encoder features (text+pitch+type+preflow+f0).
    const hasPrompt = promptSeq && ptFrameCount > 0 && promptSeq.tokenCount > 0;
    const ptTokenCount = hasPrompt ? promptSeq.tokenCount : 0;
    const combinedTokenCount = ptTokenCount + tokenCount;
    const combinedFrames = ptFrameCount + totalFrames;

    const phonemeIds = new BigInt64Array(combinedTokenCount);
    const pitchIds = new BigInt64Array(combinedTokenCount);
    const typeIds = new BigInt64Array(combinedTokenCount);
    const f0IdsArr = new BigInt64Array(combinedFrames);

    if (hasPrompt) {
        for (let i = 0; i < ptTokenCount; i++) {
            phonemeIds[i] = BigInt(promptSeq.noteTextSeq[i]);
            pitchIds[i] = BigInt(promptSeq.notePitchSeq[i]);
            typeIds[i] = BigInt(promptSeq.noteTypeSeq[i]);
        }
        for (let i = 0; i < ptFrameCount; i++) {
            f0IdsArr[i] = BigInt(promptSeq.f0Ids[i]);
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
    const tEncPrep = performance.now();

    const encSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : combinedTokenCount;
    const encF0Len = useStaticShapes ? NPU_STATIC_SEQ_LEN : combinedFrames;

    const encPaddedText = useStaticShapes ? padInt64ToLength(phonemeIds, encSeqLen) : phonemeIds;
    const encPaddedPitch = useStaticShapes ? padInt64ToLength(pitchIds, encSeqLen) : pitchIds;
    const encPaddedType = useStaticShapes ? padInt64ToLength(typeIds, encSeqLen) : typeIds;
    const encPaddedF0 = useStaticShapes ? padInt64ToLength(f0IdsArr, encF0Len) : f0IdsArr;

    // Run 4 encoders sequentially (they are independent, but concurrency is
    // forbidden: ORT WASM 的 stackAlloc/stackRestore 是共享的，跨 session 并发
    // session.run() 会破坏栈指针 —— 见 sessionManager.js 的全局锁注释
    // (onnxruntime Issue #19443)。DML/WebNN GPU 下串行同样符合该约束。
    const t4 = performance.now();
    // W17: 顺序执行时也要保证"某个 encoder 失败 → 已拿到的输出张量必须释放"，
    // 否则 NPU/GPU 显存泄漏。这里先把成功的输出收集起来，异常时统一 dispose。
    const encoderNames = ['noteTextEncoder', 'notePitchEncoder', 'noteTypeEncoder', 'f0Encoder'];
    const encoderFeeds = [
        { input_ids: new ort.Tensor('int64', encPaddedText, [1, encSeqLen]) },
        { input_ids: new ort.Tensor('int64', encPaddedPitch, [1, encSeqLen]) },
        { input_ids: new ort.Tensor('int64', encPaddedType, [1, encSeqLen]) },
        { input_ids: new ort.Tensor('int64', encPaddedF0, [1, encF0Len]) },
    ];
    const encoderOutputs = [];
    try {
        for (let i = 0; i < encoderNames.length; i++) {
            encoderOutputs.push(await runSession(encoderNames[i], encoderFeeds[i]));
        }
    } catch (err) {
        for (const out of encoderOutputs) {
            if (out && out['embeddings']) disposeTensor(out['embeddings']);
        }
        throw err;
    }
    const [textResults, pitchResults, typeResults, f0Results] = encoderOutputs;
    const encInferMs = performance.now() - t4;
    console.log(`[WebNN] 4 encoders (sequential): ${encInferMs.toFixed(0)}ms [tokens=${combinedTokenCount}, f0Frames=${combinedFrames}${useStaticShapes ? ', NPU static' : ''}]`);
    console.log(`[WebNN]   enc prep: ${(t4 - tEncPrep).toFixed(1)}ms, infer: ${encInferMs.toFixed(1)}ms`);

    const tEncPost = performance.now();
    const textEmb = useStaticShapes ? trimOutputToLength(textResults['embeddings'], combinedTokenCount) : outputToFloat32(textResults['embeddings']);
    const pitchEmb = useStaticShapes ? trimOutputToLength(pitchResults['embeddings'], combinedTokenCount) : outputToFloat32(pitchResults['embeddings']);
    const typeEmb = useStaticShapes ? trimOutputToLength(typeResults['embeddings'], combinedTokenCount) : outputToFloat32(typeResults['embeddings']);
    const f0EmbRaw = useStaticShapes ? trimOutputToLength(f0Results['embeddings'], combinedFrames) : outputToFloat32(f0Results['embeddings']);
    const f0Emb = f0EmbRaw.slice();

    // Combine token embeddings
    const tokenEmb = new Float32Array(combinedTokenCount * EMBED_DIM);
    for (let t = 0; t < combinedTokenCount; t++) {
        for (let d = 0; d < EMBED_DIM; d++) {
            tokenEmb[t * EMBED_DIM + d] =
                textEmb[t * EMBED_DIM + d] +
                pitchEmb[t * EMBED_DIM + d] +
                typeEmb[t * EMBED_DIM + d];
        }
    }
    console.log(`[WebNN]   enc postprocess (combine embeddings): ${(performance.now() - tEncPost).toFixed(1)}ms`);

    // 释放 4 个编码器输出张量（tokenEmb 已是独立数组，f0Emb 已 slice）
    disposeTensor(textResults['embeddings']);
    disposeTensor(pitchResults['embeddings']);
    disposeTensor(typeResults['embeddings']);
    disposeTensor(f0Results['embeddings']);

    // Preflow
    const tpf = performance.now();
    const preflowSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : combinedTokenCount;
    const preflowTokenEmb = useStaticShapes ? padToLength(tokenEmb, preflowSeqLen * EMBED_DIM) : tokenEmb;
    const featuresTensor = createFloatTensor(floatType, preflowTokenEmb, [1, preflowSeqLen, EMBED_DIM]);
    // W17: ensure preflow input tensor is disposed even if runSession rejects
    // or post-encoder processing throws (input tensor leak on exception).
    let preflowResults;
    try {
        preflowResults = await runSession('preflow', { features: featuresTensor });
    } finally {
        disposeTensor(featuresTensor);
    }
    const processedTokenEmb = useStaticShapes ? trimOutputToLength(preflowResults['processed_features'], combinedTokenCount) : outputToFloat32(preflowResults['processed_features']);
    console.log(`[WebNN] preflow: ${(performance.now() - tpf).toFixed(0)}ms [${combinedTokenCount}tokens × ${EMBED_DIM}${useStaticShapes ? ', NPU static' : ''}]`);

    // Build combined mel2token: prompt frames → prompt token indices (unchanged),
    // target frames → target token indices shifted by ptTokenCount
    const combinedMel2token = new Int32Array(combinedFrames);
    if (hasPrompt) {
        for (let f = 0; f < ptFrameCount; f++) {
            combinedMel2token[f] = promptSeq.mel2token[f];
        }
    }
    for (let f = 0; f < totalFrames; f++) {
        combinedMel2token[ptFrameCount + f] = ptTokenCount + sequences.mel2token[f];
    }

    // Expand and combine with f0: all frames (prompt + target) have real encoder features
    const tExpand = performance.now();
    const totalCondFrames = combinedFrames;
    const condCodeData = new Float32Array(totalCondFrames * EMBED_DIM);
    for (let f = 0; f < combinedFrames; f++) {
        const tokenIdx = combinedMel2token[f];
        for (let d = 0; d < EMBED_DIM; d++) {
            const combined = processedTokenEmb[tokenIdx * EMBED_DIM + d] + f0Emb[f * EMBED_DIM + d];
            condCodeData[f * EMBED_DIM + d] = combined;
        }
    }
    console.log(`[WebNN]   expand+combine (mel2token+f0): ${(performance.now() - tExpand).toFixed(1)}ms [${totalCondFrames}condFrames]`);
    // 释放 preflow 输出张量（condCodeData 已是独立数组）
    disposeTensor(preflowResults['processed_features']);

    // Cond embedding
    const tce = performance.now();
    const condSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalCondFrames;
    const paddedCondCode = useStaticShapes ? padToLength(condCodeData, condSeqLen * EMBED_DIM) : condCodeData;
    const condCodeTensor = createFloatTensor(floatType, paddedCondCode, [1, condSeqLen, EMBED_DIM]);
    // W17: ensure condEmb input tensor is disposed even if runSession rejects
    // or post-encoder processing throws (input tensor leak on exception).
    let condEmbResults;
    try {
        condEmbResults = await runSession('condEmb', { cond_code: condCodeTensor });
    } finally {
        disposeTensor(condCodeTensor);
    }
    // combinedCond 需返回给调用方，取独立拷贝
    const combinedCondRaw = useStaticShapes ? trimOutputToLength(condEmbResults['cond_embedding'], totalCondFrames) : outputToFloat32(condEmbResults['cond_embedding']);
    const combinedCond = combinedCondRaw.slice();
    // 释放 condEmb 输出张量
    disposeTensor(condEmbResults['cond_embedding']);
    console.log(`[WebNN] condEmb: ${(performance.now() - tce).toFixed(0)}ms [${totalCondFrames}frames × ${COND_DIM}${useStaticShapes ? ', NPU static' : ''}]`);

    console.log(`[WebNN] Encoder total: ${(performance.now() - tEnc0).toFixed(0)}ms`);

    return {
        combinedCond,
        totalCondFrames,
        totalFramesWithPrompt: ptFrameCount + totalFrames,
        f0Emb,
    };
}
