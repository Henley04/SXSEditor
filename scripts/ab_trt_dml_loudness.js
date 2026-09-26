'use strict';
/**
 * TRT-RTX vs DML 端到端响度 A/B（rope 修复后残留调查）。
 *
 * 用真实采样配置（Euler @32 步、CFG=3.0、rescale=0.7、同一噪声种子、真实校准
 * prompt/cond）分别在 DML 与 TRT-RTX（WinML 桥）上跑完整扩散循环，对比：
 *   1) 最终 mel 的逐帧响度曲线差（mel 域 dB 代理）
 *   2) 各自经 vocoder（DML，单 chunk，与 app 相同路径）渲染的 wav + RMS 包络差
 *   3) 有/无 Q-Drift 修正的四种组合
 *
 * 用法:
 *   SXS_ORT_BRIDGE_PATH=.webpack/main/native/ort_bridge.node \
 *   node scripts/ab_trt_dml_loudness.js [item=prj_lagtrain_f0_s02] [seed=1234]
 *
 * 产物: ab_loudness_*.wav + ab_loudness_report.json + ab_loudness_curve.csv
 */

process.env.SXS_WINML_BENCH = process.env.SXS_WINML_BENCH || '1';
globalThis.__SXS_SETTINGS_SNAPSHOT__ = { winmlEnabled: true, nativeInferenceBackend: 'winml' };
process.env.SXS_ORT_BRIDGE_PATH = process.env.SXS_ORT_BRIDGE_PATH
    || require('node:path').join(__dirname, '..', '.webpack', 'main', 'native', 'ort_bridge.node');

const fs = require('node:fs');
const path = require('node:path');
require('../src/inference/pipeline/float16Patch.js');
const ort = require('onnxruntime-node');
const common = require('../qdrift/scripts/common.js');

const ITEM = process.argv[2] || 'prj_lagtrain_f0_s02';
const SEED = Number(process.argv[3] || 1234);
const FP16_DIR = path.join(common.ROOT, 'onnx_models', 'fp16');
const DIFF_MODEL = path.join(FP16_DIR, 'diff_step_dml.onnx');
const VOC_MODEL = path.join(FP16_DIR, 'vocoder_dml.onnx');
const OUT_DIR = common.ROOT;

const { MEL_DIM } = common;
const MEL_MEAN = -4.92, MEL_STD = Math.sqrt(8.14); // 与 postprocessing.js 反标准化一致

// ---------------------------------------------------------------- Q-Drift 资产
function loadCorrection() {
    const m = require('../src/inference/pipeline/qdrift/qdriftCorrection.js');
    // 模块实际导出 { meta, base64 }（小写）；兼容旧命名以防回改。
    const cand = m.CORRECTION || m.correction || (m.default && (m.default.CORRECTION || m.default.correction));
    let corr = null;
    if (cand) corr = cand instanceof Float32Array ? cand : Float32Array.from(cand);
    else if (m.BASE64 || m.base64) {
        const buf = Buffer.from(m.BASE64 || m.base64, 'base64');
        corr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    }
    if (!corr || corr.length !== 32 * MEL_DIM) {
        console.warn(`[qdrift] correction asset unavailable or unexpected length=${corr ? corr.length : 'null'} — runs WITHOUT correction only`);
        return null;
    }
    console.log(`[qdrift] correction loaded: ${corr.length} floats (32x128)`);
    return corr;
}

// ---------------------------------------------------------------- TRT 会话包装
async function makeTrtDiffSession(modelPath) {
    const provider = require('../src/inference/winml/winmlProvider');
    const r = await provider.tryCreateWinMLSession(modelPath, false, false);
    if (!r) throw new Error('no WinML session');
    if (!String(r.ep).includes('NvTensorRTRTX')) throw new Error(`TRT not selected: got ep=${r.ep}`);
    console.log(`[trt] session ep=${r.ep}`);
    return {
        tag: 'trt',
        session: r.session,
        async call(xt, t, cond, mask, seqLen) {
            const feeds = {
                xt_input: new ort.Tensor('float16', common.toF16(xt), [1, seqLen, MEL_DIM]),
                t: new ort.Tensor('float16', common.toF16(new Float32Array([t])), [1]),
                cond: new ort.Tensor('float16', common.toF16(cond), [1, seqLen, cond.length / seqLen]),
                xt_mask: new ort.Tensor('float16', common.toF16(mask), [1, seqLen]),
            };
            const res = await r.session.run(feeds);
            const out = res.flow_pred || res[Object.keys(res)[0]];
            return common.asFloat32(out.data);
        },
        async release() { try { await r.session.release(); } catch (_) {} },
    };
}

// ---------------------------------------------------------------- 分析
function frameLoudnessDb(mel, frames) {
    // mel 域响度代理：反标准化后 10*log10(mean_bins(10^(mel/10)))
    const out = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
        let e = 0;
        for (let d = 0; d < MEL_DIM; d++) {
            const v = mel[f * MEL_DIM + d] * MEL_STD + MEL_MEAN;
            e += Math.pow(10, v / 10);
        }
        out[f] = 10 * Math.log10(e / MEL_DIM + 1e-12);
    }
    return out;
}

function frameRms(mel, frames) {
    const out = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
        let s = 0;
        for (let d = 0; d < MEL_DIM; d++) { const v = mel[f * MEL_DIM + d]; s += v * v; }
        out[f] = Math.sqrt(s / MEL_DIM);
    }
    return out;
}

function cosine(a, b) {
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return dot / Math.sqrt(aa * bb);
}

function maxAbsDiff(a, b) {
    let m = 0;
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; }
    return m;
}

function diffStats(deltaDb) {
    const n = deltaDb.length;
    let mean = 0; for (const v of deltaDb) mean += v; mean /= n;
    let mx = -1e9, mn = 1e9, over1 = 0, over3 = 0;
    for (const v of deltaDb) { if (v > mx) mx = v; if (v < mn) mn = v; if (Math.abs(v) > 1) over1++; if (Math.abs(v) > 3) over3++; }
    return { meanDb: mean, minDb: mn, maxDb: mx, pctOver1dB: 100 * over1 / n, pctOver3dB: 100 * over3 / n };
}

// ---------------------------------------------------------------- WAV 输出
function writeWav(file, samples, rate) {
    const pcm = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        let v = Math.max(-1, Math.min(1, samples[i]));
        pcm.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8);
    hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
    hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28);
    hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
    hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(file, Buffer.concat([hdr, pcm]));
    console.log(`[wav] ${path.basename(file)}: ${(samples.length / rate).toFixed(2)}s`);
}

function audioEnvelopeDb(wav, rate, winMs = 100) {
    const win = Math.floor(rate * winMs / 1000);
    const n = Math.floor(wav.length / win);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < win; j++) { const v = wav[i * win + j]; s += v * v; }
        out[i] = 20 * Math.log10(Math.sqrt(s / win) + 1e-10);
    }
    return out;
}

// ---------------------------------------------------------------- 主流程
async function main() {
    const item = common.loadItem(ITEM, 'qdrift/conds_proj');
    const pl = item.prompt_len, tl = item.target_len;
    console.log(`item=${ITEM} pl=${pl} tl=${tl} total=${pl + tl} seed=${SEED}`);
    if (item.cond.length !== (pl + tl) * 1024) throw new Error(`cond len mismatch: ${item.cond.length}`);

    const corr = loadCorrection();
    const results = {};

    // ---- 1) DML 参考
    console.log('\n=== [1/4] DML diffusion (no qdrift) ===');
    let s = await common.makeDiffSession(DIFF_MODEL);
    let t0 = Date.now();
    const melDml = await common.runSampler(s, item.prompt, item.cond, pl, tl, SEED);
    console.log(`dml done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    try { await s.sess.release(); } catch (_) {}
    s = null;

    // ---- 2) DML + qdrift
    if (corr) {
        console.log('=== [2/4] DML diffusion (qdrift) ===');
        s = await common.makeDiffSession(DIFF_MODEL);
        t0 = Date.now();
        results.melDmlQ = await common.runSampler(s, item.prompt, item.cond, pl, tl, SEED, corr);
        console.log(`dml+q done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        try { await s.sess.release(); } catch (_) {}
        s = null;
    }

    // ---- 3) TRT
    console.log('=== [3/4] TRT-RTX diffusion (no qdrift) ===');
    const trt = await makeTrtDiffSession(DIFF_MODEL);
    t0 = Date.now();
    const melTrt = await common.runSampler(trt, item.prompt, item.cond, pl, tl, SEED);
    console.log(`trt done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // ---- 4) TRT + qdrift
    if (corr) {
        console.log('=== [4/4] TRT-RTX diffusion (qdrift) ===');
        t0 = Date.now();
        results.melTrtQ = await common.runSampler(trt, item.prompt, item.cond, pl, tl, SEED, corr);
        console.log(`trt+q done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    await trt.release();

    // ---- mel 级对比（以 DML 无修正为基准）
    const L = frameLoudnessDb(melDml, tl);
    const variants = [
        ['trt', melTrt, results.melTrtQ],
        ...(results.melDmlQ ? [['dml_q', results.melDmlQ, null]] : []),
    ];
    const report = { item: ITEM, pl, tl, total: pl + tl, seed: SEED, melCosine: {}, loudness: {} };
    console.log('\n--- mel-level: variant vs dml(baseline) ---');
    for (const [name, mel] of variants) {
        const cos = cosine(mel, melDml);
        const mad = maxAbsDiff(mel, melDml);
        const Lv = frameLoudnessDb(mel, tl);
        const delta = new Float64Array(tl);
        for (let f = 0; f < tl; f++) delta[f] = Lv[f] - L[f];
        const st = diffStats(delta);
        report.melCosine[name] = cos;
        report.loudness[name] = { ...st, maxAbsDiff: mad };
        console.log(`${name.padEnd(8)} cos=${cos.toFixed(6)} maxAbsDiff=${mad.toExponential(3)} | ΔLoudness mean=${st.meanDb.toFixed(3)}dB [${st.minDb.toFixed(2)}, ${st.maxDb.toFixed(2)}] >1dB:${st.pctOver1dB.toFixed(1)}% >3dB:${st.pctOver3dB.toFixed(1)}%`);
    }
    // 头/中/尾分布（trt vs dml）
    {
        const Lv = frameLoudnessDb(melTrt, tl);
        const seg = (a, b) => {
            let s = 0; for (let f = a; f < b; f++) s += Lv[f] - L[f]; return (s / (b - a)).toFixed(3);
        };
        console.log(`trt ΔLoudness by region: head[0-10%]=${seg(0, Math.floor(tl * .1))} mid[45-55%]=${seg(Math.floor(tl * .45), Math.floor(tl * .55))} tail[90-100%]=${seg(Math.floor(tl * .9), tl)} (dB)`);
    }

    // ---- vocoder 渲染（DML，单 chunk，同 app 路径）
    console.log('\n=== vocoder (DML, single chunk) ===');
    const voc = await common.makeVocoderSession(VOC_MODEL);
    const wavs = { dml: melDml, trt: melTrt };
    if (results.melDmlQ) wavs.dml_q = results.melDmlQ;
    if (results.melTrtQ) wavs.trt_q = results.melTrtQ;
    const envelopes = {};
    for (const [name, mel] of Object.entries(wavs)) {
        const wav = await voc(mel, tl);
        writeWav(path.join(OUT_DIR, `ab_loudness_${name}.wav`), wav, 24000);
        envelopes[name] = Array.from(audioEnvelopeDb(wav, 24000));
    }
    // 音频包络差
    console.log('\n--- audio envelope (100ms windows): variant vs dml ---');
    for (const [name, env] of Object.entries(envelopes)) {
        if (name === 'dml') continue;
        const delta = env.map((v, i) => v - envelopes.dml[i]);
        const st = diffStats(delta);
        report.loudness[name].audioEnv = st;
        console.log(`${name.padEnd(8)} Δenv mean=${st.meanDb.toFixed(3)}dB [${st.minDb.toFixed(2)}, ${st.maxDb.toFixed(2)}] >1dB:${st.pctOver1dB.toFixed(1)}% >3dB:${st.pctOver3dB.toFixed(1)}%`);
    }

    // ---- 曲线 CSV
    const csv = ['frame,L_dml,L_trt,dL_trt' + (results.melTrtQ ? ',L_trt_q,dL_trt_q' : '')];
    const Ltrt = frameLoudnessDb(melTrt, tl);
    const LtrtQ = results.melTrtQ ? frameLoudnessDb(results.melTrtQ, tl) : null;
    for (let f = 0; f < tl; f++) {
        let row = `${f},${L[f].toFixed(3)},${Ltrt[f].toFixed(3)},${(Ltrt[f] - L[f]).toFixed(3)}`;
        if (LtrtQ) row += `,${LtrtQ[f].toFixed(3)},${(LtrtQ[f] - L[f]).toFixed(3)}`;
        csv.push(row);
    }
    fs.writeFileSync(path.join(OUT_DIR, 'ab_loudness_curve.csv'), csv.join('\n'));

    fs.writeFileSync(path.join(OUT_DIR, 'ab_loudness_report.json'), JSON.stringify(report, null, 2));
    console.log('\n[done] report -> ab_loudness_report.json, curve -> ab_loudness_curve.csv');
}

main().then(() => process.exit(0)).catch((e) => { console.error('[fatal]', e); process.exit(1); });
