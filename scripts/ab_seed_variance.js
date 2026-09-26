#!/usr/bin/env node
/**
 * ab_seed_variance.js — 量化扩散生成固有的乐句级响度随机性（Task #6）。
 *
 * 同一校准样本（同 prompt/cond/f0 条件），两个不同噪声种子各跑一次 32 步
 * Euler 采样（app 合约：CFG 3.0 linear、rescale 0.7），对比：
 *   1) 逐帧 mel 能量差（dB）
 *   2) 1s 窗（50 帧）平均能量差的分布（mean/std/p95/max）——即"同一乐句
 *      两次合成"的响度波动幅度
 *   3) 差异最大的 5 个 1s 窗（定位是否集中在特定音乐段）
 *
 * 若波动达到 ±1.5dB 以上，则"某些乐句整体偏小/偏大"主要由生成随机性贡献，
 * 位置由条件内容决定（某些音符模式天生容易被渲染弱/强）。
 *
 * 用法: node scripts/ab_seed_variance.js [item] [seedA] [seedB]
 */

const path = require('node:path');
const C = require('../qdrift/scripts/common.js');

const ITEM = process.argv[2] || 'prj_lagtrain_f0_s02';
const SEED_A = Number(process.argv[3] || 1234);
const SEED_B = Number(process.argv[4] || 5678);
const MEL_DIM = C.MEL_DIM;
const MODEL = path.join(C.ROOT, 'onnx_models', 'fp16', 'diff_step_dml.onnx');

function cfgAtStep(step, totalSteps, cfg) {
    return cfg * 0.5 + (cfg * 0.5) * step / (totalSteps - 1);
}

async function sampleOnce(diff, item, seed) {
    const pl = item.prompt_len, tl = item.target_len;
    const xt = C.randn(C.mulberry32(seed), tl * MEL_DIM);
    for (let step = 0; step < C.N_STEPS; step++) {
        const tVal = (step + 0.5) / C.N_STEPS;
        const cfg = cfgAtStep(step, C.N_STEPS, C.CFG);
        const v = await C.cfgVelocity(diff, xt, item.prompt, item.cond, pl, tl, tVal, cfg);
        for (let k = 0; k < xt.length; k++) xt[k] += C.H * v[k];
    }
    return xt;
}

function frameEnergyDb(mel, frames) {
    const out = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
        let s = 0;
        for (let d = 0; d < MEL_DIM; d++) { const v = mel[f * MEL_DIM + d]; s += v * v; }
        out[f] = 10 * Math.log10(s / MEL_DIM + 1e-12);
    }
    return out;
}

async function main() {
    console.log(`item=${ITEM} seeds: A=${SEED_A} B=${SEED_B} (app contract: 32 steps, CFG 3.0 linear, rescale 0.7)`);
    const item = C.loadItem(ITEM, 'qdrift/conds_proj');
    const tl = item.target_len;
    const diff = await C.makeDiffSession(MODEL);

    console.log('sampling A...');
    const mA = await sampleOnce(diff, item, SEED_A);
    console.log('sampling B...');
    const mB = await sampleOnce(diff, item, SEED_B);
    try { await diff.sess.release(); } catch (_) {}

    const eA = frameEnergyDb(mA, tl);
    const eB = frameEnergyDb(mB, tl);

    // 1s 窗统计
    const W = 50;
    const wins = [];
    for (let f0 = 0; f0 + W <= tl; f0 += W) {
        let s = 0;
        for (let f = f0; f < f0 + W; f++) s += eA[f] - eB[f];
        wins.push({ t: f0 / 50, d: s / W });
    }
    const ds = wins.map(w => w.d);
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    const std = Math.sqrt(ds.reduce((a, b) => a + (b - mean) ** 2, 0) / ds.length);
    const sorted = [...ds].sort((a, b) => a - b);
    const p05 = sorted[Math.floor(sorted.length * 0.05)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    console.log(`\n== 1s 窗能量差 (A−B, dB)：N=${ds.length} ==`);
    console.log(`mean=${mean.toFixed(3)}  std=${std.toFixed(3)}  p05=${p05.toFixed(3)}  p95=${p95.toFixed(3)}  min=${sorted[0].toFixed(3)}  max=${sorted[sorted.length - 1].toFixed(3)}`);
    console.log(`→ 同一乐句两次合成的响度波动约 ±${Math.max(Math.abs(p05), Math.abs(p95)).toFixed(2)}dB (p05..p95)`);

    console.log('\n差异最大的 6 个 1s 窗:');
    const byAbs = [...wins].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 6);
    for (const w of byAbs) console.log(`  ${Math.floor(w.t / 60)}:${(w.t % 60).toFixed(1).padStart(4, '0')}  ${w.d >= 0 ? '+' : ''}${w.d.toFixed(2)}dB`);

    // 逐帧差的分布（不窗化）
    let sAll = 0, sSq = 0;
    for (let f = 0; f < tl; f++) { const d = eA[f] - eB[f]; sAll += d; sSq += d * d; }
    const mF = sAll / tl, sF = Math.sqrt(sSq / tl - mF * mF);
    console.log(`\n逐帧差: mean=${mF.toFixed(3)}dB std=${sF.toFixed(3)}dB`);

    // CSV
    const fs = require('node:fs');
    const lines = ['frame,time_s,eA_dB,eB_dB,diff_dB'];
    for (let f = 0; f < tl; f++) lines.push(`${f},${(f / 50).toFixed(2)},${eA[f].toFixed(3)},${eB[f].toFixed(3)},${(eA[f] - eB[f]).toFixed(3)}`);
    fs.writeFileSync(path.join(C.ROOT, 'ab_seed_variance_curve.csv'), lines.join('\n'));
    console.log('\ncsv -> ab_seed_variance_curve.csv');
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
