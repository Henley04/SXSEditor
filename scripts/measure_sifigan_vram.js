/**
 * SiFiGAN 显存实测脚本
 *
 * 目标：准确测量 SiFiGAN 在不同 chunk size 下的峰值显存占用，修正 gpuInfo.js 的预算公式。
 *
 * 测量方式：
 * 1. 加载 diffStep + vocoder(SiFiGAN) 到 DML
 * 2. 跑一次 diffusion（让 diffStep 激活工作区占满）
 * 3. 释放 diffStep + gpuDrainLong
 * 4. 跑 vocoder 单 chunk，采样 VRAM 峰值
 * 5. 跨多个 chunk size 重复，得到 chunk_frames ↔ peak_VRAM 曲线
 *
 * 用法: node scripts/measure_sifigan_vram.js [precision] [modelDir]
 *   precision: fp32 | fp16 (默认 fp32)
 *   modelDir: 模型目录（默认 onnx_models）
 */

const path = require('path');
const fs = require('fs');
const ort = require('onnxruntime-node');
const { loadSettings } = require('../src/main/settings');

// 复用 pipeline 的工具
const { createFloatTensor, disposeTensor, gpuDrain, gpuDrainLong } = require('../src/inference/pipeline/utils');
const { MEL_DIM, HOP_SIZE, SIFIGAN_HOP_SIZE } = require('../src/inference/pipeline/constants');

const args = process.argv.slice(2);
const precision = args[0] === 'fp16' ? 'fp16' : 'fp32';
const modelDir = args[1] || path.join(__dirname, '..', 'onnx_models');

console.log(`[Measure] precision=${precision}, modelDir=${modelDir}`);

// ----- VRAM 采样（nvidia-smi 精确查询，比 systeminformation 准确）-----
const { execSync } = require('child_process');
let baselineVram = 0;
function sampleVRAM(label) {
    try {
        const out = execSync('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits', { encoding: 'utf8' }).trim();
        const [usedMB, totalMB] = out.split(',').map(s => parseInt(s.trim(), 10));
        return { label, usedMB, totalMB };
    } catch (e) {
        console.warn(`[VRAM] sample failed: ${e.message.substring(0, 80)}`);
        return { label, usedMB: -1, totalMB: -1 };
    }
}

// ----- 加载 session -----
async function loadSession(file) {
    const fp = path.join(modelDir, file);
    if (!fs.existsSync(fp)) {
        throw new Error(`Model file not found: ${fp}`);
    }
    const opts = {
        executionProviders: ['dml'],
        graphOptimizationLevel: 'all',
        enableMemPattern: false,
        enableCpuMemArena: false,
    };
    const t0 = Date.now();
    const session = await ort.InferenceSession.create(fp, opts);
    console.log(`[Load] ${file} in ${Date.now() - t0}ms`);
    return session;
}

// ----- 构造 SiFiGAN 输入 -----
function buildSifiganInputs(totalFrames, isFP16) {
    const mel = new Float32Array(totalFrames * MEL_DIM);
    for (let i = 0; i < mel.length; i++) mel[i] = (Math.random() - 0.5) * 0.1;
    const f0 = new Float32Array(totalFrames);
    for (let i = 0; i < totalFrames; i++) f0[i] = 200 + Math.sin(i * 0.1) * 50;  // 150-250Hz 浊音
    const floatType = isFP16 ? 'float16' : 'float32';
    const melT = createFloatTensor(floatType, mel, [1, totalFrames, MEL_DIM]);
    const f0T = createFloatTensor(floatType, f0, [1, totalFrames, 1]);
    return { mel: melT, f0: f0T };  // ONNX 输入名: mel, f0
}

// ----- 主流程 -----
async function main() {
    console.log('=== SiFiGAN VRAM Measurement ===');

    // 0. baseline
    const base = sampleVRAM('baseline');
    baselineVram = base.usedMB;
    console.log(`[VRAM] baseline: used=${base.usedMB}MB / total=${base.totalMB}MB`);

    // 1. 加载 diffStep
    const diffFile = fs.existsSync(path.join(modelDir, 'diff_step_dml.onnx')) ? 'diff_step_dml.onnx' : 'diff_step.onnx';
    const diffStep = await loadSession(diffFile);
    const afterDiffLoad = sampleVRAM('after diffStep load');
    console.log(`[VRAM] after diffStep load: used=${afterDiffLoad.usedMB}MB (delta=${afterDiffLoad.usedMB - baselineVram}MB)`);

    // 2. 跑一次小 diffusion，让 diffStep 激活工作区占满（模拟合成后状态）
    console.log('[Diffusion] running 1 step to warm activation workspace...');
    // diffStep 输入构造：用真实输入名 + 保守形状 [1, 64, 128]
    const diffInputs = {};
    for (const name of diffStep.inputNames) {
        diffInputs[name] = new ort.Tensor('float32', new Float32Array(1 * 64 * MEL_DIM), [1, 64, MEL_DIM]);
    }
    try {
        const r = await diffStep.run(diffInputs);
        for (const k of Object.keys(r)) disposeTensor(r[k]);
    } catch (e) {
        console.log('[Diffusion] warm-up run failed (expected for fake inputs):', e.message.substring(0, 100));
    }
    const afterDiffRun = sampleVRAM('after diffStep run');
    console.log(`[VRAM] after diffStep run: used=${afterDiffRun.usedMB}MB (delta=${afterDiffRun.usedMB - baselineVram}MB)`);

    // 3. 加载 SiFiGAN vocoder
    const sifiganFile = precision === 'fp16' ? 'sifigan_vocoder_dml_fp16.onnx' : 'sifigan_vocoder_dml.onnx';
    const vocoder = await loadSession(sifiganFile);
    const afterVocLoad = sampleVRAM('after vocoder load');
    console.log(`[VRAM] after vocoder load: used=${afterVocLoad.usedMB}MB (delta=${afterVocLoad.usedMB - baselineVram}MB)`);

    // 4. 释放 diffStep（模拟 _maybeUnloadDiffStepBeforeVocoder）
    console.log('[Release] releasing diffStep session...');
    try { diffStep.release(); } catch (_) {}
    await gpuDrainLong();
    const afterDiffRelease = sampleVRAM('after diffStep release');
    console.log(`[VRAM] after diffStep release + 800ms drain: used=${afterDiffRelease.usedMB}MB (delta=${afterDiffRelease.usedMB - baselineVram}MB)`);

    // 5. 跨 chunk size 测量 vocoder 单 chunk 峰值
    console.log('\n=== Vocoder single-chunk VRAM sweep ===');
    const chunkSizes = [64, 128, 192, 256, 384, 512, 768, 1024];  // user_frames (×4 = actual mel frames)
    const results = [];
    for (const uf of chunkSizes) {
        const actualMelFrames = uf * 4;  // SiFiGAN 4× upsample
        // 先 drain
        await gpuDrainLong();
        const before = sampleVRAM(`before chunk ${uf}`);
        // 跑 vocoder
        const inputs = buildSifiganInputs(actualMelFrames, precision === 'fp16');
        const t0 = Date.now();
        let ok = true, errMsg = '';
        try {
            const r = await vocoder.run(inputs);
            for (const k of Object.keys(r)) disposeTensor(r[k]);
        } catch (e) {
            ok = false;
            errMsg = e.message.substring(0, 120);
        }
        const after = sampleVRAM(`after chunk ${uf}`);
        const peakDeltaMB = after.usedMB - before.usedMB;
        const elapsed = Date.now() - t0;
        results.push({ uf, actualMelFrames, beforeMB: before.usedMB, afterMB: after.usedMB, peakDeltaMB, elapsedMs: elapsed, ok, errMsg });
        disposeTensor(inputs.mel);
        disposeTensor(inputs.f0);
        console.log(`[Chunk] user_frames=${uf} actual_mel=${actualMelFrames} before=${before.usedMB}MB after=${after.usedMB}MB delta=${peakDeltaMB}MB ${elapsed}ms ${ok ? 'OK' : 'FAIL: ' + errMsg}`);
        // 等 VRAM 回收
        await gpuDrainLong();
    }

    // 6. 释放 vocoder
    console.log('\n[Release] releasing vocoder...');
    try { vocoder.release(); } catch (_) {}
    await gpuDrainLong();
    const finalVram = sampleVRAM('final');
    console.log(`[VRAM] final: used=${finalVram.usedMB}MB (delta from baseline=${finalVram.usedMB - baselineVram}MB)`);

    // 7. 汇总
    console.log('\n=== Summary ===');
    console.log('user_frames | actual_mel | peak_delta_MB | elapsed_ms | status');
    console.log('------------|------------|----------------|------------|-------');
    for (const r of results) {
        console.log(`${String(r.uf).padStart(11)} | ${String(r.actualMelFrames).padStart(10)} | ${String(r.peakDeltaMB).padStart(14)} | ${String(r.elapsedMs).padStart(10)} | ${r.ok ? 'OK' : 'FAIL'}`);
    }
    console.log(`\nbaseline: ${baselineVram}MB, after vocoder load: ${afterVocLoad.usedMB}MB (vocoder weights = ${afterVocLoad.usedMB - afterDiffRelease.usedMB}MB)`);
}

main().catch(e => {
    console.error('[Fatal]', e);
    process.exit(1);
});
