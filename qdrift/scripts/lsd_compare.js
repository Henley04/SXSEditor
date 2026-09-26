/**
 * 任意两条音频的 LSD 对比（复用 spectral.js 的 DSP）。
 *
 * 用于真实工程产出的对比，例如：
 *   node qdrift/scripts/lsd_compare.js qdrift/proj/fp32.wav qdrift/proj/fp16.wav
 *
 * 注意 LSD 的读法（见 spectral.js 顶部注释）：它是"与参考的差异"，不是"音质分"。
 * 只有在两条音频**同 seed、同配置、只换一个组件**时，数字才有判读意义。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spec, lsd, frameLsd, stats, frameHfEnergy, bandEnergy, readWav, rms, SAMPLE_RATE } = require('./spectral');

const BANDS = [[0, 1000], [1000, 4000], [4000, 8000], [8000, 12000]];

function main() {
    const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const opts = { segMs: 300 };
    for (let i = 0; i < process.argv.length; i++) {
        if (process.argv[i] === '--seg-ms') opts.segMs = parseInt(process.argv[i + 1], 10);
    }
    if (args.length < 2) {
        console.error('用法: node qdrift/scripts/lsd_compare.js <ref.wav> <test.wav> [test2.wav ...] [--seg-ms N]');
        process.exit(2);
    }
    const [refPath, ...testPaths] = args;
    const ref = readWav(refPath);
    console.log(`参考: ${path.basename(refPath)}  ${ref.sampleRate}Hz ${ref.channels}ch  ${(ref.data.length / ref.sampleRate).toFixed(2)}s  RMS ${rms(ref.data).toFixed(4)}`);
    const refS = spec(ref.data, 'ref');

    const hfE = frameHfEnergy(refS);
    const order = Array.from({ length: hfE.length }, (_, i) => i).sort((a, b) => hfE[b] - hfE[a]);
    const sibIdx = order.slice(0, Math.max(1, Math.floor(order.length * 0.10)));
    const susIdx = order.slice(Math.floor(order.length * 0.50));

    const rows = [];
    for (const p of testPaths) {
        if (!fs.existsSync(p)) { console.log(`  !! 缺失: ${p}`); continue; }
        const t = readWav(p);
        if (t.sampleRate !== ref.sampleRate) {
            console.log(`  !! 采样率不一致（${t.sampleRate} vs ${ref.sampleRate}），LSD 不可比：${p}`);
            continue;
        }
        const ts = spec(t.data, p);
        const l = lsd(refS, ts, { segMs: opts.segMs });
        const per = frameLsd(refS, ts);
        const bands = BANDS.map(([lo, hi]) => lsd(refS, ts, { bandLo: lo, bandHi: hi }).mean);
        const hfRef = bandEnergy(refS, 6000, SAMPLE_RATE / 2) / bandEnergy(refS, 0, SAMPLE_RATE / 2);
        const hfTest = bandEnergy(ts, 6000, SAMPLE_RATE / 2) / bandEnergy(ts, 0, SAMPLE_RATE / 2);
        const sib = stats(sibIdx.map(i => per[i]));
        const sus = stats(susIdx.map(i => per[i]));
        rows.push({
            name: path.basename(p), l, bands, sib, sus,
            rms: rms(t.data), hfRef, hfTest,
            dur: t.data.length / t.sampleRate,
        });
    }

    console.log('\n===== LSD vs 参考（dB，越小越接近参考）=====');
    console.log('文件                              均值   p50   p95   max | 段p50 段p95 段max | 齿音  稳态 | RMS');
    for (const r of rows) {
        console.log(`${r.name.padEnd(32)} ${r.l.mean.toFixed(2)}  ${r.l.p50.toFixed(2)}  ${r.l.p95.toFixed(2)}  ${r.l.max.toFixed(2)} |` +
            ` ${r.l.seg_p50.toFixed(2)} ${r.l.seg_p95.toFixed(2)} ${r.l.seg_max.toFixed(2)} | ${r.sib.mean.toFixed(2)} ${r.sus.mean.toFixed(2)} | ${r.rms.toFixed(4)}`);
    }

    console.log('\n===== 分频段 LSD 均值（dB）=====');
    console.log('文件                             ' + BANDS.map(b => `${b[0]}-${b[1]}Hz`.padEnd(12)).join(''));
    for (const r of rows) {
        console.log(`${r.name.padEnd(33)}${r.bands.map(v => v.toFixed(2).padEnd(12)).join('')}`);
    }

    console.log('\n===== 时长 / 高频能量比 =====');
    for (const r of rows) {
        console.log(`  ${r.name.padEnd(32)} ${r.dur.toFixed(2)}s  参考 ${r.hfRef.toFixed(4)} → 本文件 ${r.hfTest.toFixed(4)}  (${((r.hfTest / r.hfRef - 1) * 100).toFixed(2)}%)`);
    }
}

main();
