/**
 * Q-Drift 三方对比评测（A/B/C[/D]）+ wav 导出 + 感知敏感指标
 *
 *   A = FP32 DiT（+ FP32 vocoder）          参考
 *   B = 量化 DiT（fp16→FP16 vocoder / int8→FP32 vocoder）  现状
 *   C = 量化 DiT + Q-Drift（同 B 的 vocoder）              校正后
 *   D = 仅 fp16：FP16 DiT + Q-Drift + FP32 vocoder         隔离 DiT 校正贡献
 *
 * 为什么不看全局余弦就完事：全局相对残差 ≈ 局部相对残差 × sqrt(失真时长占比)。
 * 爆破音 ~20ms 落在 10s 里 → p=0.002 → 即使该处 100% 失真，全局余弦只掉 0.001。
 * 所以同时报分段残差 p99/max、local_to_global_ratio、逐通道边缘分布偏移，
 * 外加用户硬指标 cosine_global（≥0.9）与 SNR（非负）。最终以试听为准。
 *
 * 用法:
 *   node qdrift/scripts/eval_dml.js [--precision fp16|int8]
 *        [--items nat_000,nat_001] [--data-dir qdrift/conds_bin|qdrift/conds_proj]
 *        [--seed 1234] [--no-wav]
 */
const fs = require('fs');
const path = require('path');
const {
    ROOT, N_STEPS, MEL_DIM,
    makeDiffSession, makeVocoderSession, runSampler, loadItem, loadManifests,
} = require('./common');

const OUT_MEL = path.join(ROOT, 'qdrift', 'eval', 'mel');
const OUT_WAV = path.join(ROOT, 'qdrift', 'eval', 'wav');
const SAMPLE_RATE = 24000;

// ---------------------------------------------------------------- 指标
function norm(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s); }
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

function melMetrics(ref, test, frames) {
    const diff = Float32Array.from(ref, (v, i) => v - test[i]);
    const gr = norm(diff) / (norm(ref) + 1e-12);
    // 全局余弦 + SNR（用户硬指标）
    const cosine = dot(ref, test) / (norm(ref) * norm(test) + 1e-12);
    const eRef = dot(ref, ref);
    const snrDb = 10 * Math.log10(eRef / (dot(diff, diff) + 1e-30) + 1e-30);
    // 逐帧相对残差 / 逐帧余弦
    const fr = new Float64Array(frames);
    let fCosSum = 0, fCosMin = 1;
    for (let f = 0; f < frames; f++) {
        const off = f * MEL_DIM;
        let num = 0, den = 0, aa = 0, ab = 0, bb = 0;
        for (let d = 0; d < MEL_DIM; d++) {
            const a = ref[off + d], b = test[off + d], e = b - a;
            num += e * e; den += a * a; aa += a * a; ab += a * b; bb += b * b;
        }
        fr[f] = Math.sqrt(num) / (Math.sqrt(den) + 1e-12);
        const fc = ab / (Math.sqrt(aa * bb) + 1e-12);
        fCosSum += fc; if (fc < fCosMin) fCosMin = fc;
    }
    const sorted = Array.from(fr).sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const topK = Math.max(1, Math.floor(frames * 0.01));
    let topSum = 0;
    for (let i = frames - topK; i < frames; i++) topSum += sorted[i];
    const local = topSum / topK;

    // 边缘分布：逐通道均值 / 标准差的偏移（Q-Drift 的目标量）
    let meanDiff = 0, stdDiff = 0, refStdSum = 0;
    for (let d = 0; d < MEL_DIM; d++) {
        let mr = 0, mt = 0;
        for (let f = 0; f < frames; f++) { mr += ref[f * MEL_DIM + d]; mt += test[f * MEL_DIM + d]; }
        mr /= frames; mt /= frames;
        let vr = 0, vt = 0;
        for (let f = 0; f < frames; f++) {
            const a = ref[f * MEL_DIM + d] - mr, b = test[f * MEL_DIM + d] - mt;
            vr += a * a; vt += b * b;
        }
        const sr = Math.sqrt(vr / frames), st = Math.sqrt(vt / frames);
        meanDiff += Math.abs(mt - mr);
        stdDiff += Math.abs(st - sr);
        refStdSum += sr;
    }
    return {
        cosine_global: cosine,
        snr_db: snrDb,
        cosine_frame_mean: fCosSum / frames,
        cosine_frame_min: fCosMin,
        global_rel_res: gr,
        frame_relres_p50: q(0.50),
        frame_relres_p99: q(0.99),
        frame_relres_max: sorted[sorted.length - 1],
        local_to_global_ratio: local / (gr + 1e-12),
        channel_mean_absdiff: meanDiff / MEL_DIM,
        channel_std_absdiff: stdDiff / MEL_DIM,
        channel_std_rel: stdDiff / (refStdSum + 1e-12),
    };
}

/** 20ms 窗 RMS 包络的 Pearson 相关（电平结构一致性） */
function envelopeCorr(a, b) {
    const win = Math.round(SAMPLE_RATE * 0.02);
    const n = Math.min(a.length, b.length);
    const frames = Math.floor(n / win);
    const ea = new Float64Array(frames), eb = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
        let sa = 0, sb = 0;
        for (let i = 0; i < win; i++) { const v = a[f * win + i]; sa += v * v; sb += b[f * win + i] * b[f * win + i]; }
        ea[f] = Math.sqrt(sa / win); eb[f] = Math.sqrt(sb / win);
    }
    let ma = 0, mb = 0;
    for (let i = 0; i < frames; i++) { ma += ea[i]; mb += eb[i]; }
    ma /= frames; mb /= frames;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < frames; i++) {
        const x = ea[i] - ma, y = eb[i] - mb;
        num += x * y; da += x * x; db += y * y;
    }
    return num / (Math.sqrt(da * db) + 1e-12);
}

function rms(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); }

// ---------------------------------------------------------------- WAV
function writeWav(file, samples) {
    const n = samples.length;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SAMPLE_RATE, 24);
    buf.writeUInt32LE(SAMPLE_RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    }
    fs.writeFileSync(file, buf);
}

// ---------------------------------------------------------------- 主流程
async function main() {
    const args = process.argv.slice(2);
    const getArg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
    const precision = getArg('precision', 'fp16');
    if (!['fp16', 'int8'].includes(precision)) throw new Error(`bad --precision ${precision}`);
    // 支持跨目录选 item（如 nat_* 在 conds_bin、prj_* 在 conds_proj）。
    // --data-dir 单目录形式保留兼容。
    const dirsArg = getArg('data-dirs', getArg('data-dir', path.join('qdrift', 'conds_bin')));
    const dataDirs = dirsArg.split(',').map(s => s.trim()).filter(Boolean);
    const itemDir = new Map();
    for (const dd of dataDirs) {
        try {
            for (const m of loadManifests([dd], null)) itemDir.set(m.item, m._dir);
        } catch (_) { /* 目录可能没有 manifest.json，退回直接拼路径 */ }
    }
    const items = getArg('items', 'nat_000,nat_001,nat_002').split(',');
    const resolveItem = (item) => loadItem(item, itemDir.get(item) || dataDirs[0]);
    const seed = parseInt(getArg('seed', '1234'), 10);
    const noWav = args.includes('--no-wav');

    const quantDiff = precision === 'fp16'
        ? path.join(ROOT, 'onnx_models', 'fp16', 'diff_step_dml.onnx')
        : path.join(ROOT, 'onnx_models', 'int8', 'diff_step_dml.onnx');
    const corrPrefix = getArg('calib-prefix',
        precision === 'fp16' ? path.join('qdrift', 'calib', 'qdrift') : path.join('qdrift', 'calib_int8', 'qdrift'));
    const corrPath = path.isAbsolute(corrPrefix) ? corrPrefix + '_c.bin' : path.join(ROOT, corrPrefix + '_c.bin');
    const correction = new Float32Array(fs.readFileSync(corrPath).buffer);

    fs.mkdirSync(OUT_MEL, { recursive: true });
    fs.mkdirSync(OUT_WAV, { recursive: true });
    console.log(`[Eval] precision=${precision} items=${items.join(',')} data=${dataDirs.join(',')} seed=${seed} steps=${N_STEPS}`);
    console.log(`[Eval] correction=${path.relative(ROOT, corrPath)}`);

    // ---- Phase 1: mel（两张 DiT 图）----
    console.log('[Eval] Phase 1/3: 生成 mel ...');
    const fp32 = await makeDiffSession(path.join(ROOT, 'onnx_models', 'diff_step_dml.onnx'));
    const quant = await makeDiffSession(quantDiff);

    const mels = {};   // item -> { A, B, C }
    for (const item of items) {
        const d = resolveItem(item);
        mels[item] = {};
        const t0 = Date.now();
        for (const [tag, diff, corr] of [['A', fp32, null], ['B', quant, null], ['C', quant, correction]]) {
            const mel = await runSampler(diff, d.prompt, d.cond, d.prompt_len, d.target_len, seed, corr);
            mels[item][tag] = mel;
            fs.writeFileSync(path.join(OUT_MEL, `${precision}__${item}__${tag}.bin`), Buffer.from(mel.buffer));
        }
        if (typeof global.gc === 'function') global.gc();
        console.log(`  ${item} (${d.seconds}s, tl=${d.target_len}, pl=${d.prompt_len}) ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    // 释放 DiT 会话，给 vocoder 腾显存
    try { await fp32.sess.release(); await quant.sess.release(); } catch (_) { /* ORT 可能无 release */ }
    if (typeof global.gc === 'function') global.gc();
    console.log('[Eval] Phase 1 完成，DiT 会话已释放');

    // ---- Phase 2: wav ----
    // fp16：B/C 用 FP16 vocoder，另出 D（FP32 vocoder）隔离声码器影响。
    // int8：没有 INT8 vocoder，三条全部走 FP32 vocoder（DiT 贡献不被 vocoder 混淆）。
    const passes = [];
    let voc32 = null, voc16 = null;
    if (!noWav) {
        console.log('[Eval] Phase 2/3: 声码器合成 ...');
        voc32 = await makeVocoderSession(path.join(ROOT, 'onnx_models', 'vocoder_dml.onnx'));
        if (precision === 'fp16') voc16 = await makeVocoderSession(path.join(ROOT, 'onnx_models', 'fp16', 'vocoder_dml.onnx'));
        const quantVoc = precision === 'fp16' ? voc16 : voc32;
        passes.push(['A', voc32], ['B', quantVoc], ['C', quantVoc]);
        if (precision === 'fp16') passes.push(['D', voc32]);
    }
    const wavs = {};
    for (const item of items) {
        const d = resolveItem(item);
        wavs[item] = {};
        for (const [tag, voc] of passes) {
            const mel = mels[item][tag === 'D' ? 'C' : tag];
            const w = await voc(mel, d.target_len);
            wavs[item][tag] = w;
            writeWav(path.join(OUT_WAV, `${precision}__${item}__${tag}.wav`), w);
        }
        if (passes.length) console.log(`  ${item}: wav passes=${passes.map(p => p[0]).join('')}`);
    }
    try { if (voc32 && voc32.release) voc32.release(); if (voc16 && voc16.release) voc16.release(); } catch (_) { /* noop */ }

    // ---- Phase 3: 指标 ----
    console.log('[Eval] Phase 3/3: 指标 ...');
    const report = { precision, seed, n_steps: N_STEPS, correction: path.relative(ROOT, corrPath), items: {} };
    for (const item of items) {
        const d = resolveItem(item);
        const A = mels[item].A, B = mels[item].B, C = mels[item].C;
        const entry = {
            seconds: d.seconds,
            prompt_len: d.prompt_len,
            target_len: d.target_len,
            mel: { B_vs_A: melMetrics(A, B, d.target_len), C_vs_A: melMetrics(A, C, d.target_len) },
        };
        if (!noWav && wavs[item].A) {
            entry.audio = {};
            for (const k of ['B', 'C', 'D']) {
                if (!wavs[item][k]) continue;
                entry.audio[`${k}_vs_A`] = {
                    envelope_corr: envelopeCorr(wavs[item].A, wavs[item][k]),
                    rms_ratio: rms(wavs[item][k]) / (rms(wavs[item].A) + 1e-12),
                };
            }
        }
        report.items[item] = entry;
    }
    // 跨样本聚合（硬指标：cosine≥0.9、SNR≥0）
    const agg = {};
    for (const pair of ['B_vs_A', 'C_vs_A']) {
        const ms = Object.values(report.items).map(it => it.mel[pair]);
        const avg = (k) => ms.reduce((s, m) => s + m[k], 0) / ms.length;
        agg[pair] = {
            cosine_global_mean: avg('cosine_global'),
            cosine_global_min: Math.min(...ms.map(m => m.cosine_global)),
            snr_db_mean: avg('snr_db'),
            snr_db_min: Math.min(...ms.map(m => m.snr_db)),
            global_rel_res_mean: avg('global_rel_res'),
            channel_std_rel_mean: avg('channel_std_rel'),
        };
    }
    report.aggregate = agg;
    const reportPath = path.join(ROOT, 'qdrift', 'eval', `report_${precision}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log('\n===== mel 域（A = FP32 参考）=====');
    console.log('item      pass   cosine     SNR(dB)  帧cos均  帧cosmin 全局残差   帧p99    帧max    通道std相对');
    for (const item of items) {
        const r = report.items[item];
        for (const k of ['B_vs_A', 'C_vs_A']) {
            const m = r.mel[k];
            console.log(`${item.padEnd(22)} ${k}  ${m.cosine_global.toFixed(5)}  ${m.snr_db.toFixed(2).padStart(6)}  ` +
                `${m.cosine_frame_mean.toFixed(5)}  ${m.cosine_frame_min.toFixed(5)}  ` +
                `${m.global_rel_res.toExponential(2)}  ${m.frame_relres_p99.toFixed(4)}  ${m.frame_relres_max.toFixed(4)}  ` +
                `${(m.channel_std_rel * 100).toFixed(3)}%`);
        }
    }
    console.log('\n===== 聚合硬指标（阈值：cosine≥0.90，SNR≥0 dB）=====');
    for (const [k, a] of Object.entries(agg)) {
        const cosOk = a.cosine_global_min >= 0.9 ? 'PASS' : 'FAIL';
        const snrOk = a.snr_db_min >= 0 ? 'PASS' : 'FAIL';
        console.log(`${k}: cosine mean=${a.cosine_global_mean.toFixed(5)} min=${a.cosine_global_min.toFixed(5)} [${cosOk}]  ` +
            `SNR mean=${a.snr_db_mean.toFixed(2)}dB min=${a.snr_db_min.toFixed(2)}dB [${snrOk}]`);
    }
    if (!noWav) {
        console.log('\n===== 音频域（20ms 包络相关 / RMS 比）=====');
        for (const item of items) {
            const a = report.items[item].audio;
            if (!a) continue;
            const parts = Object.entries(a).map(([k, v]) =>
                `${k.replace('_vs_A', '')}: corr=${v.envelope_corr.toFixed(6)} rms×${v.rms_ratio.toFixed(4)}`);
            console.log(`${item}  ${parts.join('  |  ')}`);
        }
    }
    console.log(`\n[Eval] wav -> ${OUT_WAV}`);
    console.log(`[Eval] 报告 -> ${reportPath}`);
}

main().catch(e => { console.error('[Eval] 失败:', e); process.exit(1); });
