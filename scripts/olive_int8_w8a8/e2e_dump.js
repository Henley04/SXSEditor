/**
 * End-to-end synthesis dump for INT8 A/B comparison.
 *
 * Runs the full SXSEditor pipeline (base encoders -> diff_step -> vocoder) on a
 * fixed GTSinger note sequence with a fixed noise seed, and writes the resulting
 * audio so two model directories can be compared sample-exactly.
 *
 * Usage:
 *   node scripts/olive_int8_w8a8/e2e_dump.js \
 *       --model-dir onnx_models \
 *       --out int8_w8a8_output/e2e/fp32 \
 *       --items 0,1,2 --seed 1234 [--precision fp32]
 *
 * Output: <out>/item<N>.f32 (raw little-endian float32 mono 24 kHz)
 *         <out>/item<N>.wav (16-bit, for listening)
 *         <out>/summary.json
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

const MODEL_DIR = path.resolve(ROOT, arg('--model-dir', 'onnx_models'));
const OUT_DIR = path.resolve(ROOT, arg('--out', 'int8_w8a8_output/e2e/run'));
const ITEMS = String(arg('--items', '0,1,2')).split(',').map((s) => Number(s.trim()));
const SEED = Number(arg('--seed', '1234'));
const PRECISION_ARG = arg('--precision', 'fp32');
const PRECISION = PRECISION_ARG === 'fp32' ? null : PRECISION_ARG;
const ITEM_FILE = path.resolve(ROOT, 'calibrate/data/gt_int8/items.json');

function toNotes(item) {
    const spb = 60 / BPM;
    return item.notes.map((n) => ({
        pitch: n.pitch,
        start: n.start / spb,
        duration: n.duration / spb,
        lyric: n.noteType === 'rest' ? '<SP>' : n.phoneme,
        noteType: n.noteType === 'rest' ? 1 : 2,
    }));
}

function writeWav(file, samples, rate) {
    const pcm = Buffer.allocUnsafe(samples.length * 2);
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
}

function stats(audio) {
    let peak = 0, sum = 0, nonFinite = 0;
    for (let i = 0; i < audio.length; i++) {
        const v = audio[i];
        if (!Number.isFinite(v)) { nonFinite++; continue; }
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sum += v * v;
    }
    return {
        samples: audio.length,
        durationSec: +(audio.length / 24000).toFixed(3),
        peak: +peak.toFixed(5),
        rms: +Math.sqrt(sum / Math.max(1, audio.length)).toFixed(5),
        nonFinite,
    };
}

(async () => {
    if (!fs.existsSync(ITEM_FILE)) throw new Error(`missing ${ITEM_FILE} — run prepare_gtsinger.py first`);
    const data = JSON.parse(fs.readFileSync(ITEM_FILE, 'utf8'));
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const p = new OnnxSVSPipeline(MODEL_DIR, {
        modelPrecision: PRECISION,
        deviceId: 0,
        inferenceProvider: 'ortnode',
    });
    const tInit = Date.now();
    await p.init();
    console.log(`[e2e] init ${((Date.now() - tInit) / 1000).toFixed(1)}s modelDir=${p.modelDir}`);
    console.log(`[e2e] diff_step=${await p._resolveDiffStepFile().catch(() => '?')}`);
    console.log(`[e2e] vocoder=${p._resolvedVocoderFile || '?'}`);

    const summary = {
        createdAt: new Date().toISOString(),
        modelDir: path.relative(ROOT, p.modelDir),
        precision: PRECISION_ARG,
        seed: SEED,
        bpm: BPM,
        diffStepFile: path.basename(await p._resolveDiffStepFile().catch(() => '?')),
        vocoderFile: path.basename(p._resolvedVocoderFile || '?'),
        initSec: +((Date.now() - tInit) / 1000).toFixed(2),
        items: [],
    };

    for (const idx of ITEMS) {
        const item = data.items[idx];
        if (!item) { console.warn(`[e2e] item ${idx} missing`); continue; }
        const notes = toNotes(item);
        const t0 = Date.now();
        try {
            const audio = await p.synthesize(notes, BPM, { seed: SEED });
            const sec = (Date.now() - t0) / 1000;
            const base = path.join(OUT_DIR, `item${idx}`);
            fs.writeFileSync(`${base}.f32`, Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
            writeWav(`${base}.wav`, audio, 24000);
            const s = stats(audio);
            summary.items.push({
                index: idx, item: item.item, language: item.language,
                notes: notes.length, synthSec: +sec.toFixed(2),
                rtf: +(sec / s.durationSec).toFixed(3), ...s,
            });
            console.log(`[e2e] item${idx} (${item.language}) ${s.durationSec}s in ${sec.toFixed(1)}s ` +
                `rtf=${(sec / s.durationSec).toFixed(2)} peak=${s.peak} rms=${s.rms} nonFinite=${s.nonFinite}`);
        } catch (e) {
            console.error(`[e2e] item${idx} FAILED: ${e && e.message}`);
            summary.items.push({ index: idx, item: item.item, error: String(e && e.message) });
        }
    }

    fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 1));
    console.log(`[e2e] -> ${path.relative(ROOT, OUT_DIR)}`);
})().catch((e) => { console.error('[e2e] fatal', e); process.exit(1); });
