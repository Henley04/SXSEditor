/**
 * Q-Drift 三方对比评测（A/B/C/D）+ wav 导出 + 感知敏感指标
 *
 *   A = FP32 DiT + FP32 vocoder     参考
 *   B = FP16 DiT + FP16 vocoder     现状
 *   C = FP16 DiT + Q-Drift + FP16 vocoder   校正后
 *   D = FP16 DiT + Q-Drift + FP32 vocoder   隔离 DiT 校正本身的贡献（排除 vocoder 干扰）
 *
 * 为什么不看全局余弦：全局相对残差 ≈ 局部相对残差 × sqrt(失真时长占比)。
 * 爆破音 ~20ms 落在 10s 里 → p=0.002 → 即使该处 100% 失真，全局余弦只掉 0.001。
 * 因此主看分段残差 p99/max、local_to_global_ratio，以及 Q-Drift 真正针对的
 * 边缘分布指标（逐通道均值/标准差偏移）。最终以试听为准。
 *
 * 用法: node qdrift/scripts/eval_dml.js [--items nat_000,nat_001] [--seed 1234]
 */
const fs = require('fs');
const path = require('path');
const {
    ROOT, N_STEPS, MEL_DIM, H,
    makeDiffSession, makeVocoderSession, runSampler, loadItem,
} = require('./common');

const CONDS = path.join(ROOT, 'qdrift', 'conds_bin');
const OUT_MEL = path.join(ROOT, 'qdrift', 'eval', 'mel');
const OUT_WAV = path.join(ROOT, 'qdrift', 'eval', 'wav');
const SAMPLE_RATE = 24000;

function loadCorrection() {
    const p = path.join(ROOT, 'qdrift', 'calib', 'qdrift_c.bin');
    return new Float32Array(fs.readFileSync(p).buffer);
}

// ---------------------------------------------------------------- 指标
function norm(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s); }

function melMetrics(ref, test, frames) {
    const gr = norm(Float32Array.from(ref, (v, i) => v - test[i])) / (norm(ref) + 1e-12);
    // 逐帧相对残差
    const fr = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
        const off = f * MEL_DIM;
        let num = 0, den = 0;
        for (let d = 0; d < MEL_DIM; d++) {
            const diff = test[off + d] - ref[off + d];
            num += diff * diff; den += ref[off + d] * ref[off + d];
        }
        fr[f] = Math.sqrt(num) / (Math.sqrt(den) + 1e-12);
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
        let v = Math.max(-1, Math.min(1, samples[i]));
        buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    }
    fs.writeFileSync(file, buf);
}

// ---------------------------------------------------------------- 主流程
async function main() {
    const args = process.argv.slice(2);
    const getArg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
    const items = getArg('items', 'nat_000,nat_001,nat_002').split(',');
    const seed = parseInt(getArg('seed', '1234'), 10);

    fs.mkdirSync(OUT_MEL, { recursive: true });
    fs.mkdirSync(OUT_WAV, { recursive: true });
    const correction = loadCorrection();
    console.log(`[Eval] items=${items.join(',')} seed=${seed} steps=${N_STEPS}`);

    // ---- Phase 1: mel（只需两张 DiT 图）----
    console.log('[Eval] Phase 1/3: 生成 mel ...');
    const fp32 = await makeDiffSession(path.join(ROOT, 'onnx_models', 'diff_step_dml.onnx'));
    const fp16 = await makeDiffSession(path.join(ROOT, 'onnx_models', 'fp16', 'diff_step_dml.onnx'));

    const mels = {};   // item -> { A, B, C }
    for (const item of items) {
        const d = loadItem(item);
        mels[item] = {};
        const t0 = Date.now();
        for (const [tag, diff, corr] of [['A', fp32, null], ['B', fp16, null], ['C', fp16, correction]]) {
            const mel = await runSampler(diff, d.prompt, d.cond, d.prompt_len, d.target_len, seed, corr);
            mels[item][tag] = mel;
            fs.writeFileSync(path.join(OUT_MEL, `${item}__${tag}.bin`), Buffer.from(mel.buffer));
        }
        console.log(`  ${item} (${d.seconds}s, tl=${d.target_len}) ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    // 释放 DiT 会话，给 vocoder 腾显存
    try { await fp32.sess.release(); await fp16.sess.release(); } catch (_) { /* ORT 可能无 release */ }
    console.log('[Eval] Phase 1 完成，DiT 会话已释放');

    // ---- Phase 2: wav ----
    console.log('[Eval] Phase 2/3: 声码器合成 ...');
    const voc32 = await makeVocoderSession(path.join(ROOT, 'onnx_models', 'vocoder_dml.onnx'));
    const voc16 = await makeVocoderSession(path.join(ROOT, 'onnx_models', 'fp16', 'vocoder_dml.onnx'));
    const wavs = {};
    for (const item of items) {
        const d = loadItem(item);
        wavs[item] = {};
        for (const [tag, voc] of [['A', voc32], ['B', voc16], ['C', voc16], ['D', voc32]]) {
            const mel = mels[item][tag === 'D' ? 'C' : tag];
            const w = await voc(mel, d.target_len);
            wavs[item][tag] = w;
            writeWav(path.join(OUT_WAV, `${item}__${tag}.wav`), w);
        }
        console.log(`  ${item}: A=${wavs[item].A.length} B=${wavs[item].B.length} C=${wavs[item].C.length} D=${wavs[item].D.length} samples`);
    }
    try { await voc32.release; } catch (_) { /* noop */ }

    // ---- Phase 3: 指标 ----
    console.log('[Eval] Phase 3/3: 指标 ...');
    const report = { seed, n_steps: N_STEPS, items: {} };
    for (const item of items) {
        const d = loadItem(item);
        const A = mels[item].A, B = mels[item].B, C = mels[item].C;
        report.items[item] = {
            seconds: d.seconds,
            mel: { B_vs_A: melMetrics(A, B, d.target_len), C_vs_A: melMetrics(A, C, d.target_len) },
            audio: {
                B_vs_A: {
                    envelope_corr: envelopeCorr(wavs[item].A, wavs[item].B),
                    rms_ratio: rms(wavs[item].B) / (rms(wavs[item].A) + 1e-12),
                },
                C_vs_A: {
                    envelope_corr: envelopeCorr(wavs[item].A, wavs[item].C),
                    rms_ratio: rms(wavs[item].C) / (rms(wavs[item].A) + 1e-12),
                },
                D_vs_A: {
                    envelope_corr: envelopeCorr(wavs[item].A, wavs[item].D),
                    rms_ratio: rms(wavs[item].D) / (rms(wavs[item].A) + 1e-12),
                },
            },
        };
    }
    fs.writeFileSync(path.join(ROOT, 'qdrift', 'eval', 'report.json'), JSON.stringify(report, null, 2));

    console.log('\n===== mel 域（A = FP32 参考）=====');
    console.log('item      pass   全局相对残差  帧p99    帧max    local/global  通道均值偏移  通道std偏移  std相对');
    for (const item of items) {
        const r = report.items[item];
        for (const k of ['B_vs_A', 'C_vs_A']) {
            const m = r.mel[k];
            console.log(`${item}  ${k}  ${m.global_rel_res.toExponential(3)}  ` +
                `${m.frame_relres_p99.toFixed(4)}  ${m.frame_relres_max.toFixed(4)}  ` +
                `${m.local_to_global_ratio.toFixed(2)}          ` +
                `${m.channel_mean_absdiff.toExponential(2)}     ${m.channel_std_absdiff.toExponential(2)}   ` +
                `${(m.channel_std_rel * 100).toFixed(3)}%`);
        }
    }
    console.log('\n===== 音频域（20ms 包络相关 / RMS 比）=====');
    for (const item of items) {
        const a = report.items[item].audio;
        console.log(`${item}  B: corr=${a.B_vs_A.envelope_corr.toFixed(6)} rms×${a.B_vs_A.rms_ratio.toFixed(4)}  |  ` +
            `C: corr=${a.C_vs_A.envelope_corr.toFixed(6)} rms×${a.C_vs_A.rms_ratio.toFixed(4)}  |  ` +
            `D: corr=${a.D_vs_A.envelope_corr.toFixed(6)} rms×${a.D_vs_A.rms_ratio.toFixed(4)}`);
    }
    console.log(`\n[Eval] wav -> ${OUT_WAV}`);
    console.log(`[Eval] 报告 -> ${path.join(ROOT, 'qdrift', 'eval', 'report.json')}`);
}

main().catch(e => { console.error('[Eval] 失败:', e); process.exit(1); });
