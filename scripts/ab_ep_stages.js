'use strict';
/**
 * 阶段级 EP 扫描：app 的 WinML 路径下 preflow / cond_emb / vocoder 都会上 TRT-RTX，
 * 本脚本用确定性输入逐阶段对比 TRT vs DML 输出，定位响度不一致的残留来源。
 *
 *   1) preflow  : features [1,seq,512] → processed_features（fp32 模型，TRT 上可能走 TF32）
 *   2) cond_emb : cond_code [1,seq,512] → cond（2 节点线性层）
 *   3) vocoder  : 同一真实 mel（DML 采样器产出）→ 波形 RMS 包络逐窗 dB 差
 *
 * 用法: SXS_ORT_BRIDGE_PATH=.webpack/main/native/ort_bridge.node node scripts/ab_ep_stages.js [seq=2211]
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

const SEQ = Number(process.argv[2] || 2211);
const FP16_DIR = path.join(common.ROOT, 'onnx_models', 'fp16');
const OUT_DIR = common.ROOT;
const MEL_MEAN = -4.92, MEL_STD = Math.sqrt(8.14);

function deterministicF32(n, salt, scale = 1.0) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = (Math.sin((i + salt) * 0.017) * 0.7 + Math.cos((i + salt) * 0.031) * 0.3) * scale;
    return a;
}

async function makeSession(modelPath, ep) {
    if (ep === 'trt') {
        const provider = require('../src/inference/winml/winmlProvider');
        const r = await provider.tryCreateWinMLSession(modelPath, false, false);
        if (!r || !String(r.ep).includes('NvTensorRTRTX')) throw new Error(`TRT not selected for ${path.basename(modelPath)}: ${r ? r.ep : 'null'}`);
        console.log(`  [trt] ${path.basename(modelPath)} ep=${r.ep}`);
        return r.session;
    }
    return ort.InferenceSession.create(modelPath, {
        executionProviders: ep === 'dml' ? [{ name: 'dml', deviceId: 0 }, 'cpu'] : ['cpu'],
        graphOptimizationLevel: 'all', executionMode: 'sequential', enableMemPattern: false,
    });
}

function inputInfo(sess) {
    const meta = sess.inputMetadata;
    const list = Array.isArray(meta) ? meta : Object.values(meta || {});
    return list.map(m => ({ name: m.name, type: String(m.type || ''), shape: (m.shape || []).map(Number) }));
}

function decode(t) {
    const data = t.data;
    if (t.type === 'float16') return common.asFloat32(data instanceof Uint16Array ? data : Uint16Array.from(data));
    return common.asFloat32(data);
}

/** 沿 seq 轴逐帧余弦 + 逐帧能量差（dB），dims 需含 seq 维 */
function frameReport(name, a, b, dims, seq) {
    // 找 seq 所在轴（第一个长度=seq 的轴，默认 1）
    let ax = dims.findIndex(d => Number(d) === seq);
    if (ax < 0) ax = 1;
    const outer = dims.slice(ax + 1).reduce((x, y) => x * Number(y), 1) || 1;
    const span = outer * seq;
    const nFrames = dims.slice(0, ax).reduce((x, y) => x * Number(y), 1) || 1;
    let min = 1, firstBad = -1, run = 0, maxAbs = 0;
    const energyDb = [];
    for (let idx = 0; idx < seq; idx++) {
        let sa = 0, sb = 0, sab = 0, ea = 0;
        for (let blk = 0; blk < nFrames; blk++) {
            for (let j = 0; j < outer; j++) {
                const o = (blk * span) + idx * outer + j;
                const x = a[o], y = b[o];
                const d = Math.abs(x - y); if (d > maxAbs) maxAbs = d;
                sa += x * x; sb += y * y; sab += x * y; ea += x * x;
            }
        }
        const c = (sa > 0 && sb > 0) ? sab / Math.sqrt(sa * sb) : 1;
        if (c < min) min = c;
        if (c < 0.999) { run++; if (firstBad < 0 && run >= 4) firstBad = idx - run + 1; } else run = 0;
        energyDb.push(10 * Math.log10(ea / (nFrames * outer) + 1e-12));
    }
    return { name, minCos: min, firstBad, maxAbs, energyDb };
}

function wavRmsDb(wav, rate, winMs = 100) {
    const win = Math.floor(rate * winMs / 1000);
    const n = Math.floor(wav.length / win);
    const out = [];
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < win; j++) s += wav[i * win + j] * wav[i * win + j];
        out.push(20 * Math.log10(Math.sqrt(s / win) + 1e-10));
    }
    return out;
}

function statsOf(delta) {
    let mean = 0; for (const v of delta) mean += v; mean /= delta.length;
    let mx = -1e9, mn = 1e9, o1 = 0, o3 = 0;
    for (const v of delta) { if (v > mx) mx = v; if (v < mn) mn = v; if (Math.abs(v) > 1) o1++; if (Math.abs(v) > 3) o3++; }
    return `mean=${mean.toFixed(3)}dB [${mn.toFixed(2)}, ${mx.toFixed(2)}] >1dB:${(100 * o1 / delta.length).toFixed(1)}% >3dB:${(100 * o3 / delta.length).toFixed(1)}%`;
}

async function compareStage(label, modelFile, feedsBuilder, seq, outName) {
    console.log(`\n===== ${label} (${modelFile}) @ seq=${seq} =====`);
    const modelPath = path.join(FP16_DIR, modelFile);
    const sDml = await makeSession(modelPath, 'dml');
    const meta = inputInfo(sDml);
    console.log(`  inputs: ${JSON.stringify(meta)}`);
    const feeds = feedsBuilder(meta);
    const rDml = await sDml.run(feeds);
    const tDml = rDml[outName] || rDml[Object.keys(rDml)[0]];
    const aDml = decode(tDml);
    try { await sDml.release(); } catch (_) {}

    const sTrt = await makeSession(modelPath, 'trt');
    const rTrt = await sTrt.run(feeds);
    const tTrt = rTrt[outName] || rTrt[Object.keys(rTrt)[0]];
    const aTrt = decode(tTrt);
    try { await sTrt.release(); } catch (_) {}

    const dims = (tTrt.dims || tDml.dims).map(Number);
    const rep = frameReport(outName, aTrt, aDml, dims, seq);
    console.log(`  out=${JSON.stringify(dims)} minCos=${rep.minCos.toFixed(6)} firstBad=${rep.firstBad} maxAbsDiff=${rep.maxAbs.toExponential(3)}`);
    // 逐帧能量差
    const delta = rep.energyDb.map((v, i) => v - 0); // energyDb 是 TRT 自身能量；与 DML 能量对比需重算
    return { rep, aDml, aTrt, dims };
}

/** 逐帧能量差（TRT vs DML），需要在 frameReport 外单独算，因为 energyDb 只算了 TRT */
function energyDelta(aTrt, aDml, dims, seq) {
    let ax = dims.findIndex(d => Number(d) === seq);
    if (ax < 0) ax = 1;
    const outer = dims.slice(ax + 1).reduce((x, y) => x * Number(y), 1) || 1;
    const span = outer * seq;
    const nFrames = dims.slice(0, ax).reduce((x, y) => x * Number(y), 1) || 1;
    const d = [];
    for (let idx = 0; idx < seq; idx++) {
        let ea = 0, eb = 0;
        for (let blk = 0; blk < nFrames; blk++) {
            for (let j = 0; j < outer; j++) {
                const o = (blk * span) + idx * outer + j;
                ea += aTrt[o] * aTrt[o]; eb += aDml[o] * aDml[o];
            }
        }
        d.push(10 * Math.log10((ea + 1e-20) / (eb + 1e-20)));
    }
    return d;
}

async function main() {
    // ---- 1) preflow
    {
        const build = (meta) => {
            const m = meta.find(x => x.name === 'features') || meta[0];
            const isF16 = m.type.includes('16');
            const data = deterministicF32(SEQ * 512, 11);
            const dims = [1, SEQ, 512];
            return { features: isF16 ? new ort.Tensor('float16', common.toF16(data), dims) : new ort.Tensor('float32', data, dims) };
        };
        const { rep, aDml, aTrt, dims } = await compareStage('1. preflow', 'preflow.onnx', build, SEQ, 'processed_features');
        const d = energyDelta(aTrt, aDml, dims, SEQ);
        console.log(`  per-frame energy Δ(TRT-DML): ${statsOf(d)}`);
    }
    // ---- 2) cond_emb
    {
        const build = (meta) => {
            const m = meta.find(x => x.name === 'cond_code') || meta[0];
            const isF16 = m.type.includes('16');
            const data = deterministicF32(SEQ * 512, 29);
            const dims = [1, SEQ, 512];
            return { cond_code: isF16 ? new ort.Tensor('float16', common.toF16(data), dims) : new ort.Tensor('float32', data, dims) };
        };
        const { rep, aDml, aTrt, dims } = await compareStage('2. cond_emb', 'cond_emb.onnx', build, SEQ, null);
        const d = energyDelta(aTrt, aDml, dims, SEQ);
        console.log(`  per-frame energy Δ(TRT-DML): ${statsOf(d)}`);
    }
    // ---- 3) vocoder（真实 mel：DML 采样器产出，缓存复用）
    console.log(`\n===== 3. vocoder (real mel, TRT vs DML) =====`);
    const melBin = path.join(OUT_DIR, 'ab_mel_dml.bin');
    let mel, frames;
    if (fs.existsSync(melBin)) {
        const buf = fs.readFileSync(melBin);
        frames = buf.readUInt32LE(0);
        mel = new Float32Array(buf.buffer, buf.byteOffset + 4, frames * 128);
        console.log(`  cached mel: frames=${frames} (${melBin})`);
    } else {
        console.log('  generating real mel via DML sampler (prj_lagtrain_f0_s02, seed=1234)...');
        const item = common.loadItem('prj_lagtrain_f0_s02', 'qdrift/conds_proj');
        const s = await common.makeDiffSession(path.join(FP16_DIR, 'diff_step_dml.onnx'));
        mel = await common.runSampler(s, item.prompt, item.cond, item.prompt_len, item.target_len, 1234);
        frames = item.target_len;
        try { await s.sess.release(); } catch (_) {}
        const out = Buffer.alloc(4 + mel.length * 4);
        out.writeUInt32LE(frames, 0);
        out.set(Buffer.from(mel.buffer, 0, mel.length * 4), 4);
        fs.writeFileSync(melBin, out);
        console.log(`  mel cached: frames=${frames}`);
    }
    const vocPath = path.join(FP16_DIR, 'vocoder_dml.onnx');
    const vocFeeds = (sess) => {
        const m = inputInfo(sess).find(x => x.name === 'mel');
        const isF16 = m && m.type.includes('16');
        return isF16
            ? { mel: new ort.Tensor('float16', common.toF16(mel), [1, frames, 128]) }
            : { mel: new ort.Tensor('float32', mel, [1, frames, 128]) };
    };
    const pickOut = (sess, res) => {
        const name = (sess.outputNames || []).includes('waveform') ? 'waveform' : (sess.outputNames || Object.keys(res))[0];
        return res[name] || res[Object.keys(res)[0]];
    };
    const vDml = await makeSession(vocPath, 'dml');
    const wDml = common.asFloat32(pickOut(vDml, await vDml.run(vocFeeds(vDml))).data);
    try { await vDml.release(); } catch (_) {}
    const vTrt = await makeSession(vocPath, 'trt');
    const wTrt = common.asFloat32(pickOut(vTrt, await vTrt.run(vocFeeds(vTrt))).data);
    try { await vTrt.release(); } catch (_) {}

    const n = Math.min(wDml.length, wTrt.length);
    let cos = 0, aa = 0, bb = 0;
    for (let i = 0; i < n; i++) { cos += wDml[i] * wTrt[i]; aa += wDml[i] * wDml[i]; bb += wTrt[i] * wTrt[i]; }
    cos /= Math.sqrt(aa * bb);
    console.log(`  waveform: len=${wDml.length}/${wTrt.length} cos=${cos.toFixed(6)}`);
    writeWavFile(path.join(OUT_DIR, 'ab_stage_vocoder_dml.wav'), wDml.subarray(0, n));
    writeWavFile(path.join(OUT_DIR, 'ab_stage_vocoder_trt.wav'), wTrt.subarray(0, n));
    const envD = wavRmsDb(wDml.subarray(0, n), 24000);
    const envT = wavRmsDb(wTrt.subarray(0, n), 24000);
    const dEnv = envT.map((v, i) => v - envD[i]);
    console.log(`  audio envelope Δ(TRT-DML) 100ms: ${statsOf(dEnv)}`);
    console.log('\n[done]');
}

function writeWavFile(file, samples, rate = 24000) {
    const pcm = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        pcm.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8);
    hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
    hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28);
    hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
    hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(file, Buffer.concat([hdr, pcm]));
    console.log(`  [wav] ${path.basename(file)}: ${(samples.length / rate).toFixed(2)}s`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[fatal]', e); process.exit(1); });
