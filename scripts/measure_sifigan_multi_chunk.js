/**
 * SiFiGAN 多 chunk 累积显存实测（模拟真实合成场景）
 *
 * 目标：测量连续多 chunk 推理时，chunk 间排空时间对显存累积的影响
 * 关键问题：实测一脚本单 chunk 都 OK，但实际合成 chunk 1 失败 → 累积问题
 *
 * 场景：5 个 chunk 连续推理（模拟用户错误 chunk 1/5），分别测试：
 *   - 无排空 / gpuDrain(50ms) / gpuDrainLong(800ms) / 2s
 *
 * 用法: node scripts/measure_sifigan_multi_chunk.js [precision] [drainMode]
 *   drainMode: none | short(50ms) | long(800ms) | xlong(2000ms)  默认 long
 */

const path = require('path');
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
    } catch (_e) {
        return { label, usedMB: -1, totalMB: -1 };
    }
}

async function sleep(ms) {
    if (ms <= 0) return;
    return new Promise(r => setTimeout(r, ms));
}
async function gpuDrainN() {
    for (let i = 0; i < DRAIN_ROUNDS; i++) await sleep(DRAIN_MS);
}

async function main() {
    console.log('=== SiFiGAN Multi-Chunk Accumulation Test ===');
    const base = sampleVRAM('baseline');
    console.log(`[VRAM] baseline: ${base.usedMB}MB / ${base.totalMB}MB`);

    // 只加载 vocoder（不加载 diffStep，专注测多 chunk 累积）
    const sifiganFile = precision === 'fp16' ? 'sifigan_vocoder_dml_fp16.onnx' : 'sifigan_vocoder_dml.onnx';
    const fp = path.join(modelDir, sifiganFile);
    const t0 = Date.now();
    const vocoder = await ort.InferenceSession.create(fp, {
        executionProviders: ['dml'],
        graphOptimizationLevel: 'all',
        enableMemPattern: false,
        enableCpuMemArena: false,
    });
    console.log(`[Load] ${sifiganFile} in ${Date.now() - t0}ms`);
    const afterLoad = sampleVRAM('after vocoder load');
    console.log(`[VRAM] after vocoder load: ${afterLoad.usedMB}MB`);

    // 模拟用户场景：5 个 chunk，每个 user_frames=256（actual_mel=1024）
    // 用户错误：Vocoder OOM at chunk 1/5 (frames=1024, offset=992)
    // → frames=1024 是 actual_mel（已 4× 上采样），user_frames=256
    const NUM_CHUNKS = 5;
    const USER_FRAMES = 256;       // 与用户设置一致
    const ACTUAL_MEL = USER_FRAMES * 4;  // 1024

    console.log(`\n=== Simulating ${NUM_CHUNKS} chunks, user_frames=${USER_FRAMES} actual_mel=${ACTUAL_MEL} ===`);

    await gpuDrainN();
    for (let i = 0; i < NUM_CHUNKS; i++) {
        const beforeChunk = sampleVRAM(`before chunk ${i}`);
        // 构造输入
        const mel = new Float32Array(ACTUAL_MEL * MEL_DIM);
        for (let k = 0; k < mel.length; k++) mel[k] = (Math.random() - 0.5) * 0.1;
        const f0 = new Float32Array(ACTUAL_MEL);
        for (let k = 0; k < ACTUAL_MEL; k++) f0[k] = 200 + Math.sin(k * 0.1) * 50;
        const floatType = precision === 'fp16' ? 'float16' : 'float32';
        const melT = createFloatTensor(floatType, mel, [1, ACTUAL_MEL, MEL_DIM]);
        const f0T = createFloatTensor(floatType, f0, [1, ACTUAL_MEL, 1]);

        const t1 = Date.now();
        let ok = true, errMsg = '';
        try {
            const r = await vocoder.run({ mel: melT, f0: f0T });
            disposeTensor(r['waveform']);
        } catch (e) {
            ok = false;
            errMsg = e.message.substring(0, 100);
        }
        const afterChunk = sampleVRAM(`after chunk ${i}`);
        console.log(`[Chunk ${i}] before=${beforeChunk.usedMB}MB after=${afterChunk.usedMB}MB delta=${afterChunk.usedMB - beforeChunk.usedMB}MB ${Date.now() - t1}ms ${ok ? 'OK' : 'FAIL: ' + errMsg}`);

        disposeTensor(melT);
        disposeTensor(f0T);
        // chunk 间排空（最后一个 chunk 也排空，便于看 final）
        await gpuDrainN();
    }

    const final = sampleVRAM('final');
    console.log(`[VRAM] final: ${final.usedMB}MB (delta from after-load=${final.usedMB - afterLoad.usedMB}MB)`);

    // 释放 vocoder
    try { vocoder.release(); } catch (_) {}
    await sleep(1000);
    const afterRelease = sampleVRAM('after vocoder release');
    console.log(`[VRAM] after vocoder release: ${afterRelease.usedMB}MB`);
}

main().catch(e => { console.error('[Fatal]', e); process.exit(1); });
