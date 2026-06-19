/**
 * NPU 模型加载基准测试
 *
 * 测量 vocoder 和 diff_step 模型的加载时间和推理时间。
 * 用于对比优化前后的性能差异。
 *
 * 用法: node benchmark_model_load.js [--before|--after]
 */

const ort = require('onnxruntime-node');
const path = require('path');
const fs = require('fs');

const MEL_DIM = 128;
const COND_DIM = 1024;
const HOP_SIZE = 480;
const NPU_VOCODER_SEQ_LEN = 500;
const NPU_STATIC_SEQ_LEN = 2048;

const MODELS_DIR = path.join(__dirname, 'onnx_models', 'int8', 'optimized_npu');
const RESULTS_FILE = path.join(__dirname, 'benchmark_results.json');

function findModel(name) {
    const candidates = [
        path.join(MODELS_DIR, name + '_dml.onnx'),
        path.join(MODELS_DIR, name + '.onnx'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function getModelSize(modelPath) {
    let total = fs.statSync(modelPath).size;
    const dataPath = modelPath + '.data';
    if (fs.existsSync(dataPath)) {
        total += fs.statSync(dataPath).size;
    }
    return total;
}

async function benchmarkModel(name, modelPath, createInputs) {
    const sizeMB = getModelSize(modelPath) / 1024 / 1024;
    console.log(`\n--- ${name} (${path.basename(modelPath)}, ${sizeMB.toFixed(1)} MB) ---`);

    // Load
    const loadStart = Date.now();
    let session;
    try {
        session = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'basic',
        });
    } catch (e) {
        console.error(`  [FAIL] Load failed: ${e.message}`);
        return { name, sizeMB, loadMs: -1, inferMs: -1, error: e.message };
    }
    const loadMs = Date.now() - loadStart;
    console.log(`  Load: ${loadMs}ms`);

    // Warmup
    const inputs = createInputs();
    try {
        await session.run(inputs);
    } catch (_) {}

    // Benchmark inference (3 runs, take average)
    const inferTimes = [];
    for (let i = 0; i < 3; i++) {
        const inp = createInputs();
        const t0 = Date.now();
        try {
            await session.run(inp);
            inferTimes.push(Date.now() - t0);
        } catch (e) {
            console.error(`  [FAIL] Inference ${i} failed: ${e.message}`);
            inferTimes.push(-1);
        }
    }
    const validTimes = inferTimes.filter(t => t >= 0);
    const avgInferMs = validTimes.length > 0 ? Math.round(validTimes.reduce((a, b) => a + b) / validTimes.length) : -1;
    console.log(`  Inference: ${avgInferMs}ms avg (runs: ${validTimes.join(', ')})`);

    session.release();
    return { name, sizeMB: Math.round(sizeMB * 10) / 10, loadMs, inferMs: avgInferMs };
}

async function main() {
    const tag = process.argv[2] || '--current';
    console.log(`=== NPU Model Load Benchmark (${tag}) ===`);
    console.log(`Models dir: ${MODELS_DIR}`);

    const results = { tag, timestamp: new Date().toISOString(), models: [] };

    // Benchmark vocoder
    const vocoderPath = findModel('vocoder');
    if (vocoderPath) {
        const r = await benchmarkModel('vocoder', vocoderPath, () => ({
            mel: new ort.Tensor('float32', new Float32Array(NPU_VOCODER_SEQ_LEN * MEL_DIM), [1, NPU_VOCODER_SEQ_LEN, MEL_DIM]),
        }));
        results.models.push(r);
    } else {
        console.log('[SKIP] vocoder model not found');
    }

    // Benchmark diff_step
    const diffStepPath = findModel('diff_step');
    if (diffStepPath) {
        const seqLen = NPU_STATIC_SEQ_LEN;
        const r = await benchmarkModel('diff_step', diffStepPath, () => ({
            xt_input: new ort.Tensor('float32', new Float32Array(seqLen * MEL_DIM), [1, seqLen, MEL_DIM]),
            t: new ort.Tensor('float32', new Float32Array([0.5]), [1]),
            cond: new ort.Tensor('float32', new Float32Array(seqLen * COND_DIM), [1, seqLen, COND_DIM]),
            xt_mask: new ort.Tensor('float32', new Float32Array(seqLen), [1, seqLen]),
        }));
        results.models.push(r);
    } else {
        console.log('[SKIP] diff_step model not found');
    }

    // Save results
    let prevResults = {};
    if (fs.existsSync(RESULTS_FILE)) {
        try { prevResults = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8')); } catch (_) {}
    }
    prevResults[tag] = results;
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(prevResults, null, 2));

    // Print comparison if both before and after exist
    console.log('\n=== Results Summary ===');
    for (const r of results.models) {
        console.log(`  ${r.name}: load=${r.loadMs}ms, infer=${r.inferMs}ms, size=${r.sizeMB}MB`);
    }

    if (prevResults['--before'] && prevResults['--after']) {
        console.log('\n=== Before vs After ===');
        const before = Object.fromEntries(prevResults['--before'].models.map(m => [m.name, m]));
        const after = Object.fromEntries(prevResults['--after'].models.map(m => [m.name, m]));
        for (const name of Object.keys(after)) {
            const b = before[name], a = after[name];
            if (!b || !a) continue;
            const loadDiff = b.loadMs > 0 && a.loadMs > 0 ? ((1 - a.loadMs / b.loadMs) * 100).toFixed(1) : 'N/A';
            const inferDiff = b.inferMs > 0 && a.inferMs > 0 ? ((1 - a.inferMs / b.inferMs) * 100).toFixed(1) : 'N/A';
            console.log(`  ${name}:`);
            console.log(`    Load:   ${b.loadMs}ms → ${a.loadMs}ms (${loadDiff}% change)`);
            console.log(`    Infer:  ${b.inferMs}ms → ${a.inferMs}ms (${inferDiff}% change)`);
            console.log(`    Size:   ${b.sizeMB}MB → ${a.sizeMB}MB`);
        }
    }

    console.log(`\nResults saved to ${RESULTS_FILE}`);
}

main().catch(e => {
    console.error(`[ERROR] ${e.message}`);
    process.exit(1);
});
