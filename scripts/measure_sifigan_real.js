/**
 * SiFiGAN 真实合成场景实测：diffStep 释放后跑多 chunk vocoder
 *
 * 复现用户错误：合成失败 Vocoder OOM at chunk 1/5
 * 真实场景：diffStep 已加载（合成完 diffusion）→ 释放 diffStep → 跑多 chunk vocoder
 *
 * 用法: node scripts/measure_sifigan_real.js [precision] [drainMode]
 *   drainMode: none | short(50ms) | long(800ms) | xlong(2000ms)
 */

const path = require('path');
const fs = require('fs');
const ort = require('onnxruntime-node');
const { execSync } = require('child_process');
const { createFloatTensor, disposeTensor } = require('../src/inference/pipeline/utils');
const { MEL_DIM } = require('../src/inference/pipeline/constants');

const args = process.argv.slice(2);
const precision = args[0] === 'fp16' ? 'fp16' : 'fp32';
const drainMode = args[1] || 'long';
const modelDir = path.join(__dirname, '..', 'onnx_models');

const DRAIN_MS = { none: 0, short: 50, long: 200, xlong: 2000 }[drainMode] ?? 200;
const DRAIN_ROUNDS = drainMode === 'long' ? 4 : 1;

console.log(`[Measure] precision=${precision}, drainMode=${drainMode} (${DRAIN_ROUNDS}×${DRAIN_MS}ms)`);

function sampleVRAM(label) {
    try {
        const out = execSync('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits', { encoding: 'utf8' }).trim();
        const [usedMB, totalMB] = out.split(',').map(s => parseInt(s.trim(), 10));
        return { label, usedMB, totalMB };
    } catch (e) {
        return { label, usedMB: -1, totalMB: -1 };
    }
}
async function sleep(ms) { if (ms > 0) return new Promise(r => setTimeout(r, ms)); }
async function gpuDrainN() { for (let i = 0; i < DRAIN_ROUNDS; i++) await sleep(DRAIN_MS); }

async function loadSession(file) {
    const fp = path.join(modelDir, file);
    if (!fs.existsSync(fp)) throw new Error(`Not found: ${fp}`);
    const t0 = Date.now();
    const s = await ort.InferenceSession.create(fp, {
        executionProviders: ['dml'],
        graphOptimizationLevel: 'all',
        enableMemPattern: false,
        enableCpuMemArena: false,
    });
    console.log(`[Load] ${file} in ${Date.now() - t0}ms`);
    return s;
}

async function main() {
    console.log('=== SiFiGAN Real Synthesis Scenario ===');
    const base = sampleVRAM('baseline');
    console.log(`[VRAM] baseline: ${base.usedMB}MB / ${base.totalMB}MB`);

    // 1. 加载 diffStep（模拟合成开始）
    const diffStep = await loadSession('diff_step_dml.onnx');
    const afterDiff = sampleVRAM('after diffStep load');
    console.log(`[VRAM] after diffStep load: ${afterDiff.usedMB}MB (delta=${afterDiff.usedMB - base.usedMB}MB)`);

    // 2. 加载 vocoder
    const sifiganFile = precision === 'fp16' ? 'sifigan_vocoder_dml_fp16.onnx' : 'sifigan_vocoder_dml.onnx';
    const vocoder = await loadSession(sifiganFile);
    const afterVoc = sampleVRAM('after vocoder load');
    console.log(`[VRAM] after vocoder load: ${afterVoc.usedMB}MB (delta=${afterVoc.usedMB - afterDiff.usedMB}MB)`);

    // 3. 释放 diffStep（模拟 _maybeUnloadDiffStepBeforeVocoder）
    console.log(`[Release] releasing diffStep, draining ${DRAIN_ROUNDS}×${DRAIN_MS}ms...`);
    try { diffStep.release(); } catch (_) {}
    await gpuDrainN();
    const afterRelease = sampleVRAM('after diffStep release + drain');
    console.log(`[VRAM] after diffStep release: ${afterRelease.usedMB}MB (delta from baseline=${afterRelease.usedMB - base.usedMB}MB)`);

    // 4. 跑 5 个 chunk vocoder
    const NUM_CHUNKS = 5;
    const USER_FRAMES = 256;
    const ACTUAL_MEL = USER_FRAMES * 4;
    console.log(`\n=== ${NUM_CHUNKS} chunks, user_frames=${USER_FRAMES} actual_mel=${ACTUAL_MEL} ===`);

    const floatType = precision === 'fp16' ? 'float16' : 'float32';
    for (let i = 0; i < NUM_CHUNKS; i++) {
        const beforeChunk = sampleVRAM(`before chunk ${i}`);
        const mel = new Float32Array(ACTUAL_MEL * MEL_DIM);
        for (let k = 0; k < mel.length; k++) mel[k] = (Math.random() - 0.5) * 0.1;
        const f0 = new Float32Array(ACTUAL_MEL);
        for (let k = 0; k < ACTUAL_MEL; k++) f0[k] = 200 + Math.sin(k * 0.1) * 50;
        const melT = createFloatTensor(floatType, mel, [1, ACTUAL_MEL, MEL_DIM]);
        const f0T = createFloatTensor(floatType, f0, [1, ACTUAL_MEL, 1]);

        const t1 = Date.now();
        let ok = true, errMsg = '';
        try {
            const r = await vocoder.run({ mel: melT, f0: f0T });
            disposeTensor(r['waveform']);
        } catch (e) {
            ok = false;
            errMsg = e.message.substring(0, 120);
        }
        const afterChunk = sampleVRAM(`after chunk ${i}`);
        console.log(`[Chunk ${i}] before=${beforeChunk.usedMB}MB after=${afterChunk.usedMB}MB delta=${afterChunk.usedMB - beforeChunk.usedMB}MB ${Date.now() - t1}ms ${ok ? 'OK' : 'FAIL: ' + errMsg}`);

        disposeTensor(melT);
        disposeTensor(f0T);
        await gpuDrainN();
    }

    const final = sampleVRAM('final');
    console.log(`[VRAM] final: ${final.usedMB}MB`);
}

main().catch(e => { console.error('[Fatal]', e); process.exit(1); });
