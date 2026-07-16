// Test diff_step inference on onnxruntime-node DML vs CPU
// Compares with Python test_precision.py results
const path = require('path');
const ort = require('onnxruntime-node');

const MODEL_PATH = path.join(__dirname, 'onnx_models', 'diff_step_dml.onnx');

function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function snrDb(a, b) {
    let varA = 0, varE = 0;
    const meanA = a.reduce((s, v) => s + v, 0) / a.length;
    for (let i = 0; i < a.length; i++) {
        varA += (a[i] - meanA) ** 2;
        varE += (a[i] - b[i]) ** 2;
    }
    varA /= a.length;
    varE /= a.length;
    return 10 * Math.log10(varA / (varE + 1e-12));
}

function printStats(name, arr) {
    let nan = 0, inf = 0, min = Infinity, max = -Infinity, sum = 0;
    for (const v of arr) {
        if (Number.isNaN(v)) { nan++; continue; }
        if (!Number.isFinite(v)) { inf++; continue; }
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
    }
    const mean = sum / (arr.length - nan - inf);
    console.log(`  ${name}: len=${arr.length}, NaN=${nan}, Inf=${inf}, mean=${mean.toFixed(6)}, min=${min.toFixed(6)}, max=${max.toFixed(6)}`);
}

async function main() {
    console.log('ORT version:', ort.env.version || 'unknown');

    // Same input as test_precision.py (seed=42, T=100)
    const T = 100;
    const MEL_DIM = 128;
    const COND_DIM = 1024;

    // Reproduce numpy seed=42 random data
    // numpy: np.random.randn(1, T, 128) and np.random.randn(1, T, 1024)
    // We can't reproduce numpy RNG in JS, so use simple deterministic values
    // Just test if DML and CPU produce the same output for same input
    const xtInput = new Float32Array(T * MEL_DIM);
    const cond = new Float32Array(T * COND_DIM);
    const xtMask = new Float32Array(T).fill(1);
    const t = new Float32Array([0.5]);

    // Fill with deterministic pseudo-random values (same as test_precision pattern)
    for (let i = 0; i < xtInput.length; i++) {
        xtInput[i] = Math.sin(i * 0.1) * 0.5 + Math.cos(i * 0.07) * 0.3;
    }
    for (let i = 0; i < cond.length; i++) {
        cond[i] = Math.sin(i * 0.05) * 0.3 + Math.cos(i * 0.03) * 0.2;
    }

    const feeds = {
        xt_input: new ort.Tensor('float32', xtInput, [1, T, MEL_DIM]),
        t: new ort.Tensor('float32', t, [1]),
        cond: new ort.Tensor('float32', cond, [1, T, COND_DIM]),
        xt_mask: new ort.Tensor('float32', xtMask, [1, T]),
    };

    // Test CPU
    console.log('\n--- CPU Inference ---');
    const sessCpu = await ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ['cpu'],
    });
    console.log('CPU session created, inputs:', sessCpu.inputNames, 'outputs:', sessCpu.outputNames);
    const resultCpu = await sessCpu.run(feeds);
    const outputCpu = resultCpu['flow_pred'].data;
    printStats('CPU output', outputCpu);

    // Test DML
    console.log('\n--- DML Inference ---');
    let outputDml = null;
    try {
        const sessDml = await ort.InferenceSession.create(MODEL_PATH, {
            executionProviders: [{ name: 'dml', deviceId: 0 }, 'cpu'],
            enableMemPattern: false,
            executionMode: 'sequential',
        });
        console.log('DML session created');
        const resultDml = await sessDml.run(feeds);
        outputDml = resultDml['flow_pred'].data;
        printStats('DML output', outputDml);

        // Compare
        console.log('\n--- Comparison ---');
        const cos = cosineSimilarity(outputCpu, outputDml);
        const snr = snrDb(outputCpu, outputDml);
        console.log(`  Cosine(CPU vs DML): ${cos.toFixed(6)}`);
        console.log(`  SNR(CPU vs DML): ${snr.toFixed(2)} dB`);

        if (cos > 0.999 && snr > 30) {
            console.log('  ✅ PASS: DML output matches CPU');
        } else {
            console.log('  ❌ FAIL: DML output mismatch!');
        }

        await sessDml.release();
    } catch (e) {
        console.log('DML failed:', e.message);
    }

    await sessCpu.release();
}

main().catch(e => {
    console.error('Error:', e);
    process.exit(1);
});
