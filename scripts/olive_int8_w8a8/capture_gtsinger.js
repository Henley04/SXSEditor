/**
 * Capture real diff_step / vocoder tensors from the FP32 pipeline, driven by
 * GTSinger note-level inputs.
 *
 * Why: INT8 calibration and accuracy validation must use the model's *real*
 * input distribution (xt from the actual diffusion trajectory, cond from real
 * phonemes, mel from a real vocoder input). Random tensors over-range the
 * activations and make INT8 look far worse than it is.
 *
 * Output:
 *   calibrate/data/gt_int8/raw/tensors.bin   raw little-endian float32 blobs
 *   calibrate/data/gt_int8/raw/manifest.json offsets + shapes + t + item info
 *
 * Usage:
 *   node scripts/olive_int8_w8a8/capture_gtsinger.js [--limit N] [--per-item 4]
 *        [--precision fp32] [--out calibrate/data/gt_int8/raw]
 */
const fs = require('node:fs');
const path = require('node:path');
const { OnnxSVSPipeline } = require('../../src/inference/pipeline');

const ROOT = path.resolve(__dirname, '..', '..');
const BPM = 120;

function arg(flag, dflt) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const LIMIT = Number(arg('--limit', '8'));
const PER_ITEM = Number(arg('--per-item', '4'));
const PRECISION = arg('--precision', 'fp32');
const OUT_DIR = path.resolve(ROOT, arg('--out', 'calibrate/data/gt_int8/raw'));
const ITEMS = path.resolve(ROOT, 'calibrate/data/gt_int8/items.json');

function toNotes(item) {
    const spb = 60 / BPM; // seconds per beat
    return item.notes.map((n) => ({
        pitch: n.pitch,
        start: n.start / spb,
        duration: n.duration / spb,
        lyric: n.noteType === 'rest' ? '<SP>' : n.phoneme,
        noteType: n.noteType === 'rest' ? 1 : 2,
    }));
}

function main() {
    if (!fs.existsSync(ITEMS)) {
        throw new Error(`missing ${ITEMS} — run prepare_gtsinger.py first`);
    }
    const data = JSON.parse(fs.readFileSync(ITEMS, 'utf8'));
    const items = data.items.slice(0, LIMIT);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const binPath = path.join(OUT_DIR, 'tensors.bin');
    const fd = fs.openSync(binPath, 'w');
    let offset = 0;
    const manifest = {
        createdAt: new Date().toISOString(),
        bpm: BPM,
        precision: PRECISION,
        sampleRate: 24000,
        items: [],
        diffStep: [],
        vocoder: [],
    };

    const writeTensor = (arr) => {
        const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
        fs.writeSync(fd, buf);
        const rec = { offset, bytes: buf.length, dims: null };
        offset += buf.length;
        return rec;
    };

    let diffRunIdx = 0;
    let vocRunIdx = 0;

    const patchSessions = (p) => {
        const ds = p.sessions && p.sessions.diffStep;
        if (ds && !ds.__captured) {
            const orig = ds.run.bind(ds);
            ds.run = async (feeds) => {
                const out = await orig(feeds);
                diffRunIdx++;
                const state = ds.__captureState || (ds.__captureState = { idx: 0, total: 0, plan: null });
                // capture a spread of trajectory points, plus the very first pass
                const plan = state.plan;
                const shouldSave = plan ? plan.includes(state.idx) || state.idx === 0 : state.idx === 0;
                state.idx++;
                if (shouldSave && state.itemIdx !== undefined && state.count < PER_ITEM) {
                    const rec = { item: state.itemIdx, run: state.idx - 1, t: null, seq: null, inputs: {}, output: null };
                    for (const [name, tensor] of Object.entries(feeds)) {
                        if (!tensor || !tensor.data) continue;
                        const data32 = tensor.data instanceof Float32Array
                            ? tensor.data
                            : (tensor.data instanceof BigInt64Array ? null : Float32Array.from(tensor.data));
                        if (!data32) continue;
                        const w = writeTensor(data32);
                        w.dims = Array.from(tensor.dims || []);
                        rec.inputs[name] = w;
                        if (name === 't') rec.t = Array.from(tensor.data)[0];
                        if (name === 'xt_input' || name === 'x') rec.seq = (tensor.dims || [])[1];
                    }
                    const outName = Object.keys(out)[0];
                    const outTensor = out[outName];
                    if (outTensor && outTensor.data) {
                        const w = writeTensor(outTensor.data);
                        w.dims = Array.from(outTensor.dims || []);
                        rec.output = w;
                        rec.outputName = outName;
                    }
                    manifest.diffStep.push(rec);
                    state.count = (state.count || 0) + 1;
                }
                return out;
            };
            ds.__captured = true;
        }
        const vs = p.sessions && p.sessions.vocoder;
        if (vs && !vs.__captured) {
            const orig = vs.run.bind(vs);
            vs.run = async (feeds) => {
                const out = await orig(feeds);
                vocRunIdx++;
                const st = vs.__captureState;
                if (st && st.itemIdx !== undefined) {
                    const rec = { item: st.itemIdx, run: vocRunIdx, inputs: {}, output: null };
                    for (const [name, tensor] of Object.entries(feeds)) {
                        if (!tensor || !tensor.data) continue;
                        const w = writeTensor(tensor.data);
                        w.dims = Array.from(tensor.dims || []);
                        rec.inputs[name] = w;
                    }
                    const outName = Object.keys(out)[0];
                    const ot = out[outName];
                    if (ot && ot.data) {
                        const w = writeTensor(ot.data);
                        w.dims = Array.from(ot.dims || []);
                        rec.output = w;
                        rec.outputName = outName;
                    }
                    manifest.vocoder.push(rec);
                }
                return out;
            };
            vs.__captured = true;
        }
    };

    (async () => {
        const p = new OnnxSVSPipeline(path.join(ROOT, 'onnx_models'), {
            modelPrecision: PRECISION === 'fp32' ? null : PRECISION,
            deviceId: 0,
            inferenceProvider: 'ortnode',
        });
        await p.init();
        console.log(`[capture] pipeline ready (modelDir=${p.modelDir})`);

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const notes = toNotes(item);
            patchSessions(p);
            const ds = p.sessions.diffStep;
            const vs = p.sessions.vocoder;
            // per-item capture state
            const totalRuns = 64; // CFG doubles the steps; sample a spread
            const plan = [0, Math.floor(totalRuns * 0.25), Math.floor(totalRuns * 0.5), Math.floor(totalRuns * 0.75), totalRuns - 1];
            if (ds) ds.__captureState = { itemIdx: i, idx: 0, count: 0, plan };
            if (vs) vs.__captureState = { itemIdx: i };

            const t0 = Date.now();
            try {
                const audio = await p.synthesize(notes, BPM, {});
                let peak = 0;
                for (let k = 0; k < audio.length; k++) peak = Math.max(peak, Math.abs(audio[k]));
                console.log(`[capture] item ${i} OK ${(audio.length / 24000).toFixed(2)}s peak=${peak.toFixed(3)} ` +
                    `in ${((Date.now() - t0) / 1000).toFixed(1)}s (diffSaved=${(ds.__captureState || {}).count || 0})`);
                manifest.items.push({
                    index: i, item: item.item, language: item.language,
                    durationSec: +(audio.length / 24000).toFixed(3), peak: +peak.toFixed(4),
                });
            } catch (e) {
                console.error(`[capture] item ${i} FAILED: ${e && e.message}`);
                manifest.items.push({ index: i, item: item.item, error: String(e && e.message) });
            }
        }

        fs.closeSync(fd);
        manifest.binPath = path.relative(ROOT, binPath);
        manifest.binBytes = offset;
        const mf = path.join(OUT_DIR, 'manifest.json');
        fs.writeFileSync(mf, JSON.stringify(manifest, null, 1));
        console.log(`[capture] diffStep=${manifest.diffStep.length} vocoder=${manifest.vocoder.length} ` +
            `bin=${(offset / 1e6).toFixed(1)}MB -> ${mf}`);
    })().catch((e) => { console.error(e); process.exit(1); });
}

main();
