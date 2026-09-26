#!/usr/bin/env node
/**
 * ab_vocoder_boundary.js — 实证 vocoder 分块渲染的两个局部效应（Task #6）：
 *   1) 逐块峰值分布 → normalizePeakTo(0.95) 的块级压缩量（若每块独立触发）
 *   2) WSOLA 边界写回 vs 整段单块渲染的差异 → 边界塌陷/台阶
 *
 * 方法：ab_mel_dml.bin（711 帧真实模型 mel）时间拼接 3 份 = 2133 帧，
 *   A = 整段单块渲染（reference）
 *   B = app 同款 1024/32 WSOLA 分块渲染（chunkSpecs + wsolaCrossfade 与
 *       postprocessing.runVocoderChunked 一致）
 *   对比逐 100ms RMS 差（B−A, dB）与边界前后台阶。
 *
 * 用法: node scripts/ab_vocoder_boundary.js
 * 输出: ab_vocoder_boundary.log / ab_vocoder_boundary_curve.csv / ab_voc_boundary_{a,b}.wav
 */

const fs = require('node:fs');
const path = require('node:path');
const C = require('../qdrift/scripts/common.js');
const { wsolaCrossfade } = require('../src/inference/pipeline/wsola.js');

const MEL_DIM = C.MEL_DIM; // 128
const HOP = 480;           // 24kHz / 50fps
const SR = 24000;
const CHUNK = 1024, OVERLAP = 32;
const REPEATS = 3;

const MEL_BIN = path.join(C.ROOT, 'ab_mel_dml.bin');
const VOC_MODEL = path.join(C.ROOT, 'onnx_models', 'fp16', 'vocoder_dml.onnx');

function frameRmsDb(x, winSamples) {
    const out = [];
    for (let i = 0; i + winSamples <= x.length; i += winSamples) {
        let s = 0;
        for (let j = i; j < i + winSamples; j++) s += x[j] * x[j];
        out.push(10 * Math.log10(s / winSamples + 1e-12));
    }
    return out;
}

async function main() {
    // ---- 载入并拼接 mel ----
    const buf = fs.readFileSync(MEL_BIN);
    const frames1 = buf.readUInt32LE(0);
    const mel1 = new Float32Array(buf.buffer, buf.byteOffset + 4, frames1 * MEL_DIM);
    const frames = frames1 * REPEATS;
    const mel = new Float32Array(frames * MEL_DIM);
    for (let r = 0; r < REPEATS; r++) mel.set(mel1, r * frames1 * MEL_DIM);
    console.log(`mel: ${frames1}f x${REPEATS} = ${frames}f (${(frames / 50).toFixed(1)}s)`);
    // 拼接边界位置（帧）：frames1, 2*frames1 —— 这些点本身不连续，分析时排除
    const spliceFrames = [];
    for (let r = 1; r < REPEATS; r++) spliceFrames.push(r * frames1);
    console.log(`splice boundaries (artificial, excluded): ${spliceFrames.map(f => `${f}f/${(f / 50).toFixed(2)}s`).join(', ')}`);

    const voc = await C.makeVocoderSession(VOC_MODEL);

    // ---- A: 整段渲染 ----
    console.log('A: whole-render (single session)...');
    let A;
    try {
        A = await voc(mel, frames);
        console.log(`  A ok: ${A.length} samples (${(A.length / SR).toFixed(2)}s)`);
    } catch (err) {
        console.log(`  A whole-render failed: ${err.message.split('\n')[0]}`);
        console.log('  fallback: two non-overlap halves (skip 1067f boundary in analysis)');
        const h1 = Math.ceil(frames / 2);
        const w1 = await voc(mel.subarray(0, h1 * MEL_DIM), h1);
        const w2 = await voc(mel.subarray(h1 * MEL_DIM), frames - h1);
        A = new Float32Array(frames * HOP);
        A.set(w1.subarray(0, Math.min(w1.length, A.length)), 0);
        A.set(w2.subarray(0, Math.min(w2.length, A.length - w1.length)), w1.length);
        console.log(`  A fallback ok: ${A.length} samples`);
    }

    // ---- B: app 同款 1024/32 WSOLA 分块 ----
    console.log('B: chunked 1024/32 WSOLA render (app-equivalent)...');
    const totalSamples = frames * HOP;
    const chunkSpecs = [];
    {
        let framePos = 0, idx = 0;
        while (framePos < frames) {
            const isFirst = idx === 0;
            const chunkStart = isFirst ? 0 : Math.max(0, framePos - OVERLAP);
            const chunkEnd = Math.min(chunkStart + CHUNK, frames);
            const isLast = chunkEnd >= frames;
            chunkSpecs.push({ chunkStart, chunkEnd, isFirst, isLast });
            if (isLast) break;
            framePos = chunkEnd; idx++;
        }
    }
    console.log(`  chunks: ${chunkSpecs.map(s => `[${s.chunkStart},${s.chunkEnd})`).join(' ')}`);

    const B = new Float32Array(totalSamples);
    const fadeSamples = OVERLAP * HOP; // 15360
    let prevChunkTail = null;
    const chunkPeaks = [];
    for (let i = 0; i < chunkSpecs.length; i++) {
        const spec = chunkSpecs[i];
        const cur = spec.chunkEnd - spec.chunkStart;
        const wave = await voc(mel.subarray(spec.chunkStart * MEL_DIM, spec.chunkEnd * MEL_DIM), cur);
        let peak = 0;
        for (let k = 0; k < wave.length; k++) { const a = Math.abs(wave[k]); if (a > peak) peak = a; }
        chunkPeaks.push({ chunk: i, frames: cur, peak, normDb: peak > 0.95 ? 20 * Math.log10(0.95 / peak) : 0 });
        const writeStart = spec.chunkStart * HOP;
        const writeLen = Math.min(wave.length, totalSamples - writeStart);
        const overlapWriteLen = Math.min(fadeSamples, writeLen);
        const canWsola = !spec.isFirst && prevChunkTail && overlapWriteLen > 0 &&
            prevChunkTail.length >= overlapWriteLen && wave.length >= overlapWriteLen;
        if (canWsola) {
            const head = wave.subarray(0, overlapWriteLen);
            const xed = wsolaCrossfade(prevChunkTail, head, overlapWriteLen, SR); // 默认 ±4ms
            B.set(xed.subarray(0, Math.min(overlapWriteLen, totalSamples - writeStart)), writeStart);
            const stableStart = writeStart + overlapWriteLen;
            const stableCopy = Math.min(writeLen - overlapWriteLen, totalSamples - stableStart);
            if (stableCopy > 0) B.set(wave.subarray(overlapWriteLen, overlapWriteLen + stableCopy), stableStart);
            // WSOLA 对齐质量诊断
            let dot = 0, e1 = 0, e2 = 0;
            for (let k = 0; k < overlapWriteLen; k++) { dot += prevChunkTail[k] * head[k]; e1 += prevChunkTail[k] ** 2; e2 += head[k] ** 2; }
            const cos = dot / (Math.sqrt(e1 * e2) + 1e-12);
            console.log(`  chunk${i} [${spec.chunkStart},${spec.chunkEnd}) peak=${peak.toFixed(3)} wsola cos(prev,curr)=${cos.toFixed(4)}`);
        } else {
            const copyLen = Math.min(writeLen, totalSamples - writeStart);
            if (copyLen > 0) B.set(wave.subarray(0, copyLen), writeStart);
            console.log(`  chunk${i} [${spec.chunkStart},${spec.chunkEnd}) peak=${peak.toFixed(3)} (direct write)`);
        }
        if (!spec.isLast && wave.length >= fadeSamples) prevChunkTail = wave.subarray(wave.length - fadeSamples);
    }

    console.log('\n-- 每块峰值与 normalizePeakTo(0.95) 触发情况（app 若逐块推送归一化） --');
    for (const p of chunkPeaks) {
        console.log(`  chunk${p.chunk} (${p.frames}f): peak=${p.peak.toFixed(4)} ${p.normDb < 0 ? `-> press ${p.normDb.toFixed(2)}dB` : '(no norm)'}`);
    }

    // ---- 分析：逐 100ms RMS 差 ----
    const win = Math.floor(0.1 * SR);
    const ra = frameRmsDb(A, win), rb = frameRmsDb(B, win);
    const n = Math.min(ra.length, rb.length);
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = rb[i] - ra[i];
    let mean = 0; for (let i = 0; i < n; i++) mean += d[i]; mean /= n;
    let mn = Infinity, mx = -Infinity, mni = 0, mxi = 0;
    for (let i = 0; i < n; i++) if (d[i] < mn) { mn = d[i]; mni = i; } else if (d[i] > mx) { mx = d[i]; mxi = i; }
    console.log(`\nB−A 100ms RMS diff: mean=${mean.toFixed(3)}dB min=${mn.toFixed(3)}@${(mni * 0.1).toFixed(1)}s max=${mx.toFixed(3)}@${(mxi * 0.1).toFixed(1)}s`);

    // 边界台阶：写回边界前后各 0.3s 的均值跳变（排除拼接点 ±1s）
    console.log('\n-- WSOLA 边界台阶（B−A，边界前 0.3s vs 重叠区 0.64s） --');
    const nearSplice = (t) => spliceFrames.some(f => Math.abs(t - f / 50) < 1.0);
    for (let i = 1; i < chunkSpecs.length; i++) {
        const bFrame = chunkSpecs[i].chunkStart; // 写回起点（帧）
        const tSec = bFrame / 50;
        if (nearSplice(tSec)) { console.log(`  boundary@${bFrame}f (${tSec.toFixed(2)}s): skipped (near splice)`); continue; }
        const i0 = Math.max(0, Math.round((tSec - 0.3) / 0.1));
        const i1 = Math.round(tSec / 0.1);
        const i2 = Math.min(n, Math.round((tSec + 0.64) / 0.1));
        const avg = (a, b) => { let s = 0; for (let k = a; k < b; k++) s += d[k]; return s / (b - a); };
        if (i1 > i0 && i2 > i1) {
            console.log(`  boundary@${bFrame}f (${tSec.toFixed(2)}s): before=${avg(i0, i1).toFixed(3)}dB overlap=${avg(i1, i2).toFixed(3)}dB step=${(avg(i1, i2) - avg(i0, i1)).toFixed(3)}dB`);
        }
    }

    // ---- 输出 ----
    const csv = ['time_s,B_minus_A_dB,rmsA_dB,rmsB_dB'];
    for (let i = 0; i < n; i++) csv.push(`${(i * 0.1).toFixed(1)},${d[i].toFixed(4)},${ra[i].toFixed(3)},${rb[i].toFixed(3)}`);
    fs.writeFileSync(path.join(C.ROOT, 'ab_vocoder_boundary_curve.csv'), csv.join('\n'));

    const { writeWavFile } = (() => { try { return require('./ab_ep_stages.js'); } catch (_) { return {}; } })();
    // 简单 wav 写出（float32）
    const writeWav = (x, name) => {
        const hdr = Buffer.alloc(44);
        const dataLen = x.length * 4;
        hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + dataLen, 4); hdr.write('WAVE', 8);
        hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(3, 20); hdr.writeUInt16LE(1, 22);
        hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(32, 34);
        hdr.write('data', 36); hdr.writeUInt32LE(dataLen, 40);
        const body = Buffer.alloc(dataLen);
        for (let i = 0; i < x.length; i++) body.writeFloatLE(x[i], i * 4);
        fs.writeFileSync(path.join(C.ROOT, name), Buffer.concat([hdr, body]));
    };
    writeWav(A, 'ab_voc_boundary_a.wav');
    writeWav(B, 'ab_voc_boundary_b.wav');
    console.log('\nwav -> ab_voc_boundary_a.wav (whole) / ab_voc_boundary_b.wav (chunked WSOLA)');
    console.log('csv -> ab_vocoder_boundary_curve.csv');
    console.log('done.');
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
