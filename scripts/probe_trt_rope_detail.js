'use strict';
/**
 * Detail view of the TRT-vs-DML rope divergence: raw cos_1/sin_1/matmul values
 * around the 2048 boundary, per frame and per freq channel.
 * Run: node scripts/probe_trt_rope_detail.js [seq=2100]
 */
globalThis.__SXS_SETTINGS_SNAPSHOT__ = { winmlEnabled: true, nativeInferenceBackend: 'winml' };
require('../src/inference/pipeline/float16Patch.js');
const ort = require('onnxruntime-node');
const { float32ToF16Buffer } = require('../src/inference/pipeline/utils');

const SEQ = Number(process.argv[2] || 2100);
const MODEL = require('node:path').join(__dirname, '..', 'onnx_models', 'fp16', 'diff_step_probe2.onnx');

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

function toRows(t, dims, axesToSeq) {
    // flatten and return {seqIdx -> per-channel slice} for the rope layout [1,seq,32]
    const isF16 = t.type === 'float16';
    const d = t.data;
    const get = (i) => (isF16 ? fp16ToNumber(d[i]) : Number(d[i]));
    const [ch, seqlen] = [dims[1], dims[axesToSeq]]; // matmul [1,32,seq] axis2; cos_1 [1,seq,32] axis1
    return { get, ch, seqlen };
}

async function main() {
    const feeds = makeFeeds(SEQ);
    const s = await ort.InferenceSession.create(MODEL, {
        executionProviders: [{ name: 'dml', deviceId: 0 }, 'cpu'],
        graphOptimizationLevel: 'all', executionMode: 'sequential', enableMemPattern: false,
    });
    const dml = await s.run(feeds); await s.release();

    const provider = require('../src/inference/winml/winmlProvider');
    const r = await provider.tryCreateWinMLSession(MODEL, false, false);
    if (!r || !String(r.ep).includes('NvTensorRTRTX')) throw new Error(`ep=${r && r.ep}`);
    const trt = await r.session.run(feeds); r.session.release();

    const names = ['matmul', 'cos_1', 'sin_1'];
    for (const name of names) {
        const td = trt[name].dims.map(Number), dd = dml[name].dims.map(Number);
        const seqAxT = td.findIndex((x) => x === SEQ), seqAxD = dd.findIndex((x) => x === SEQ);
        console.log(`\n=== ${name} dims trt=${JSON.stringify(td)} dml=${JSON.stringify(dd)} (seq axis: trt=${seqAxT} dml=${seqAxD}) ===`);
        const nCh = seqAxT === 2 ? td[1] : td[2];
        const strideT = seqAxT === 2 ? 1 : td[2];  // [1,32,seq]: idx = ch*SEQ + f ; [1,seq,32]: idx = f*32 + ch
        const baseT = seqAxT === 2 ? 0 : 0;
        const valT = (ch, f) => {
            const isF16 = trt[name].type === 'float16';
            const d = trt[name].data;
            const i = seqAxT === 2 ? ch * SEQ + f : f * td[2] + ch;
            return isF16 ? fp16ToNumber(d[i]) : Number(d[i]);
        };
        const valD = (ch, f) => {
            const isF16 = dml[name].type === 'float16';
            const d = dml[name].data;
            const i = seqAxD === 2 ? ch * SEQ + f : f * dd[2] + ch;
            return isF16 ? fp16ToNumber(d[i]) : Number(d[i]);
        };
        const f0 = 2040, f1 = Math.min(2062, SEQ - 1);
        const chans = nCh <= 32 ? [0, 1, 2, 3, 4] : [0, 1, 2];
        let hdr = 'frame |';
        for (const c of chans) hdr += ` ch${c} trt vs dml (diff) |`;
        console.log(hdr);
        let oddBad = 0, evenBad = 0, firstBadFrame = -1;
        for (let f = f0; f <= f1; f++) {
            let line = `${String(f).padEnd(5)} |`;
            for (const c of chans) {
                const a = valT(c, f), b = valD(c, f);
                line += ` ${a.toFixed(4).padStart(8)} vs ${b.toFixed(4).padStart(8)} (${(a - b).toFixed(4)}) |`;
            }
            console.log(line);
        }
        // full-scan frame/channel badness
        for (let f = 0; f < SEQ; f++) {
            let bad = false;
            for (let c = 0; c < nCh; c++) { if (Math.abs(valT(c, f) - valD(c, f)) > 1e-4) bad = true; }
            if (bad) {
                if (firstBadFrame < 0) firstBadFrame = f;
                if (f % 2 === 1) oddBad++; else evenBad++;
            }
        }
        console.log(`${name}: frames with any channel diff>1e-4: first=${firstBadFrame} odd=${oddBad} even=${evenBad} (of ${SEQ - firstBadFrame} frames >= first)`);
    }
}

main().then(() => process.exit(0)).catch((e) => { console.error('[fatal]', e.message || e); process.exit(1); });
