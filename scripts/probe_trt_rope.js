'use strict';
/**
 * TRT-RTX 2048-frame divergence probe — locates the exact tensor where the
 * RoPE/position chain diverges between NvTensorRTRTX and DirectML.
 *
 * Phase 1 (baseline): original diff_step_dml.onnx — reconfirm flow_pred
 *   collapses from frame 2048 on TRT vs DML at seq=2100.
 * Phase 2 (probe): diff_step_probe2.onnx — same inputs, extra outputs on the
 *   RoPE chain (arange -> cast fp32 -> matmul pos*inv_freq -> concat -> sin/cos
 *   -> cast fp16) and layer/attention internals.
 *
 * The RoPE chain depends only on seq_len, not on input values, so any
 * divergence seen in cos_1/sin_1/matmul is purely positional.
 *
 * Usage: node scripts/probe_trt_rope.js [seq=2100]
 */

process.env.SXS_WINML_BENCH = process.env.SXS_WINML_BENCH || '1';
// Pure-Node WinML recipe: provider reads this snapshot instead of Electron settings.
globalThis.__SXS_SETTINGS_SNAPSHOT__ = { winmlEnabled: true, nativeInferenceBackend: 'winml' };

const path = require('node:path');
require('../src/inference/pipeline/float16Patch.js');
const ort = require('onnxruntime-node');
const { float32ToF16Buffer } = require('../src/inference/pipeline/utils');

const SEQ = Number(process.argv[2] || process.env.PROBE_SEQ || 2100);
const MODELS_DIR = path.join(__dirname, '..', 'onnx_models', 'fp16');
const BASELINE = process.env.BASELINE_MODEL || path.join(MODELS_DIR, 'diff_step_dml.onnx');
const PROBE = process.env.PROBE_MODEL || path.join(MODELS_DIR, 'diff_step_probe2.onnx');

const fp16ToNumber = (bits) => {
    const s = bits & 0x8000, e = (bits >> 10) & 0x1f, m = bits & 0x3ff;
    let v;
    if (e === 0) v = m * 2 ** -24;
    else if (e === 31) v = m ? NaN : (s ? -Infinity : Infinity);
    else v = (1 + m / 1024) * 2 ** (e - 15);
    return s ? -v : v;
};

function makeFeeds(seq) {
    const n1 = seq * 128, n2 = seq * 1024;
    const xt = new Float32Array(n1), cond = new Float32Array(n2);
    for (let i = 0; i < n1; i++) xt[i] = Math.sin((i + 17) * 0.013) * 0.4 + Math.cos((i + 29) * 0.031) * 0.2;
    for (let i = 0; i < n2; i++) cond[i] = Math.sin((i + 7) * 0.007) * 0.5 + Math.cos((i + 41) * 0.017) * 0.3;
    const mask = new Float32Array(seq).fill(1);
    return {
        xt_input: new ort.Tensor('float16', float32ToF16Buffer(xt), [1, seq, 128]),
        t: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array([0.5])), [1]),
        cond: new ort.Tensor('float16', float32ToF16Buffer(cond), [1, seq, 1024]),
        xt_mask: new ort.Tensor('float16', float32ToF16Buffer(mask), [1, seq]),
    };
}

function decode(t) {
    const isF16 = t.type === 'float16';
    const data = t.data;
    const out = new Float64Array(data.length);
    if (isF16) { for (let i = 0; i < data.length; i++) out[i] = fp16ToNumber(data[i]); }
    else { for (let i = 0; i < data.length; i++) out[i] = Number(data[i]); }
    return out;
}

// per-frame cosine along every axis whose length equals seq
function frameCosReport(name, ta, da, dims, seq) {
    const strides = new Array(dims.length); let acc = 1;
    for (let i = dims.length - 1; i >= 0; i--) { strides[i] = acc; acc *= dims[i]; }
    let worstMin = 1, worstAx = -1, firstBadAll = -1, badPre = 0, badPost = 0, total = Math.max(0, seq - 2048);
    let maxAbs = 0;
    for (let ax = 0; ax < dims.length; ax++) {
        if (dims[ax] !== seq) continue;
        const outer = strides[ax], span = strides[ax] * dims[ax];
        let min = 1, firstBad = -1, run = 0;
        for (let idx = 0; idx < seq; idx++) {
            const base = idx * strides[ax];
            let sa = 0, sb = 0, sab = 0;
            for (let blk = 0; blk < ta.length; blk += span) {
                for (let j = 0; j < outer; j++) {
                    const a = ta[blk + base + j], b = da[blk + base + j];
                    const d = Math.abs(a - b); if (d > maxAbs) maxAbs = d;
                    sa += a * a; sb += b * b; sab += a * b;
                }
            }
            const c = (sa > 0 && sb > 0) ? sab / Math.sqrt(sa * sb) : 1;
            if (c < min) min = c;
            if (c < 0.999) { run++; if (firstBad < 0 && run >= 4) firstBad = idx - run + 1; } else run = 0;
        }
        if (firstBad >= 0 && (firstBadAll < 0 || firstBad < firstBadAll)) firstBadAll = firstBad;
        for (let idx = 0; idx < seq; idx++) { if (idx >= 2048) badPost++; }
        if (min < worstMin) { worstMin = min; worstAx = ax; }
    }
    return { name, worstMin, worstAx, firstBadAll, maxAbs };
}

async function runOnEp(modelPath, feeds, eps) {
    const s = await ort.InferenceSession.create(modelPath, {
        executionProviders: eps,
        graphOptimizationLevel: 'all',
        executionMode: 'sequential',
        enableMemPattern: false,
    });
    try { return await s.run(feeds); } finally { try { await s.release(); } catch (_) {} }
}

async function runOnTrt(modelPath, feeds) {
    const provider = require('../src/inference/winml/winmlProvider');
    const r = await provider.tryCreateWinMLSession(modelPath, false, false);
    if (!r) throw new Error('no WinML session');
    if (!String(r.ep).includes('NvTensorRTRTX')) throw new Error(`TRT not selected: got ep=${r.ep}`);
    console.log(`[trt] session ep=${r.ep}`);
    try { return await r.session.run(feeds); } finally { try { r.session.release(); } catch (_) {} }
}

function asBridgeTensor(t) {
    // ort.Tensor (DML) -> {type, data, dims} normalized view
    if (t && t.type && t.data && t.dims) return { type: t.type, data: t.data, dims: t.dims.map(Number) };
    return t;
}

async function compareModel(label, modelPath, outFilter) {
    console.log(`\n########## ${label} @ seq=${SEQ} ##########`);
    const feeds = makeFeeds(SEQ);
    const peers = [
        ['dml', [{ name: 'dml', deviceId: 0 }, 'cpu']],
        ['cpu', ['cpu']],
    ];
    const peerResults = {};
    for (const [label2, eps] of peers) {
        const t0 = Date.now();
        peerResults[label2] = await runOnEp(modelPath, feeds, eps);
        console.log(`[${label2}] done in ${((Date.now() - t0) / 1000).toFixed(1)}s outputs=${Object.keys(peerResults[label2]).length}`);
    }
    const dml = peerResults.dml;
    const t1 = Date.now();
    const trtRaw = await runOnTrt(modelPath, feeds);
    console.log(`[trt] done in ${((Date.now() - t1) / 1000).toFixed(1)}s outputs=${Object.keys(trtRaw).length}`);

    const trt = {};
    for (const [k, v] of Object.entries(trtRaw)) trt[k] = asBridgeTensor(v);

    const rows = [];
    for (const name of Object.keys(trt)) {
        if (outFilter && !outFilter.test(name)) continue;
        const dt = trt[name], dd = dml[name];
        if (!dd) { console.log(`  ${name}: missing on DML`); continue; }
        const ta = decode(dt), da = decode(dd);
        const dims = dt.dims;
        if (ta.length !== da.length) {
            console.log(`  ${name}: LENGTH MISMATCH trt=${ta.length} dml=${da.length} dims=${JSON.stringify(dims)}`);
            continue;
        }
        rows.push(frameCosReport(name, ta, da, dims, SEQ));
    }
    console.log(`\n--- per-output divergence (seq=${SEQ}) ---`);
    for (const r of rows) {
        const flag = r.firstBadAll >= 0 ? '  <-- DIVERGES' : '';
        console.log(`  ${r.name.padEnd(12)} dims_ax${r.worstAx} minCos=${r.worstMin.toFixed(6)} firstBad=${r.firstBadAll} maxAbsDiff=${r.maxAbs.toExponential(3)}${flag}`);
    }
    return rows;
}

async function main() {
    console.log(`seq=${SEQ} (boundary: fp16/TF32 exact-integer limit 2048 = 2^11)`);
    if (process.env.SKIP_BASELINE !== '1') {
        await compareModel('BASELINE ' + path.basename(BASELINE), BASELINE, /^flow_pred$/);
    }
    await compareModel('PROBE ' + path.basename(PROBE), PROBE, null);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[fatal]', e); process.exit(1); });
