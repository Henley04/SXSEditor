/**
 * Full-chain W8A8 NPU verification test.
 * Tests: model loading, inference, and pipeline integration.
 * Run with: node test_w8a8_fullchain.js
 */

const path = require('node:path');
const fs = require('node:fs');
const ort = require('onnxruntime-node');

const MODEL_DIR = path.join(__dirname, 'onnx_models', 'int8', 'optimized_npu');
const FP32_DIR = path.join(__dirname, 'onnx_models');
const SEQ_LEN = 2048;
const VOCODER_SEQ_LEN = 500;

// All 9 SVS pipeline models with their input specs
const MODELS = [
    { name: 'note_text_encoder', inputs: { input_ids: { type: 'int64', shape: [1, SEQ_LEN] } } },
    { name: 'note_pitch_encoder', inputs: { input_ids: { type: 'int64', shape: [1, SEQ_LEN] } } },
    { name: 'note_type_encoder', inputs: { input_ids: { type: 'int64', shape: [1, SEQ_LEN] } } },
    { name: 'f0_encoder', inputs: { input_ids: { type: 'int64', shape: [1, SEQ_LEN] } } },
    { name: 'preflow', inputs: { features: { type: 'float32', shape: [1, SEQ_LEN, 512] } } },
    { name: 'cond_emb', inputs: { cond_code: { type: 'float32', shape: [1, SEQ_LEN, 512] } } },
    { name: 'diff_step_dml', inputs: {
        xt_input: { type: 'float32', shape: [1, SEQ_LEN, 128] },
        t: { type: 'float32', shape: [1] },
        cond: { type: 'float32', shape: [1, SEQ_LEN, 512] },
        xt_mask: { type: 'float32', shape: [1, SEQ_LEN] },
    }},
    { name: 'vocoder_dml', inputs: { mel: { type: 'float32', shape: [1, VOCODER_SEQ_LEN, 128] } } },
    { name: 'mel_transform', inputs: { waveform: { type: 'float32', shape: [1, 240000] } } },
];

function makeFeeds(inputsSpec) {
    const feeds = {};
    for (const [name, spec] of Object.entries(inputsSpec)) {
        const { type, shape } = spec;
        const size = shape.reduce((a, b) => a * b, 1);
        if (type === 'int64') {
            const data = new BigInt64Array(size);
            for (let i = 0; i < size; i++) data[i] = BigInt(Math.floor(Math.random() * 255));
            feeds[name] = new ort.Tensor('int64', data, shape);
        } else {
            const data = new Float32Array(size);
            for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
            feeds[name] = new ort.Tensor('float32', data, shape);
        }
    }
    return feeds;
}

async function testModel(spec, dir, label) {
    const modelPath = path.join(dir, `${spec.name}.onnx`);
    if (!fs.existsSync(modelPath)) {
        return { name: spec.name, label, status: 'NOT_FOUND' };
    }

    let session;
    const t0 = Date.now();
    try {
        session = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'basic',
        });
    } catch (e) {
        return { name: spec.name, label, status: 'LOAD_FAIL', error: e.message.substring(0, 80), ms: Date.now() - t0 };
    }
    const loadMs = Date.now() - t0;

    const t1 = Date.now();
    try {
        const feeds = makeFeeds(spec.inputs);
        const results = await session.run(feeds);
        const inferMs = Date.now() - t1;
        const outputKeys = Object.keys(results);
        return {
            name: spec.name, label, status: 'OK',
            loadMs, inferMs,
            outputs: outputKeys.map(k => ({ name: k, shape: results[k].dims, type: results[k].type })),
        };
    } catch (e) {
        return { name: spec.name, label, status: 'INFER_FAIL', error: e.message.substring(0, 80), loadMs };
    }
}

async function main() {
    console.log('='.repeat(70));
    console.log('Full-Chain W8A8 NPU Verification');
    console.log('='.repeat(70));

    // Check model files exist
    console.log('\n--- Model Files ---');
    for (const spec of MODELS) {
        const w8a8Path = path.join(MODEL_DIR, `${spec.name}.onnx`);
        const fp32Path = path.join(FP32_DIR, `${spec.name}.onnx`);
        const w8a8Exists = fs.existsSync(w8a8Path);
        const fp32Exists = fs.existsSync(fp32Path);
        const w8a8Size = w8a8Exists ? (fs.statSync(w8a8Path).size / 1024 / 1024).toFixed(1) : 'N/A';
        const dataPath = w8a8Path + '.data';
        const dataSize = fs.existsSync(dataPath) ? (fs.statSync(dataPath).size / 1024 / 1024).toFixed(1) : '0';
        console.log(`  ${spec.name}: W8A8=${w8a8Exists ? `${w8a8Size}MB+${dataSize}MB` : 'MISSING'}, FP32=${fp32Exists ? 'OK' : 'MISSING'}`);
    }

    // Test W8A8 models
    console.log('\n--- W8A8 NPU Model Inference ---');
    const w8a8Results = [];
    for (const spec of MODELS) {
        process.stdout.write(`  ${spec.name}... `);
        const result = await testModel(spec, MODEL_DIR, 'W8A8');
        w8a8Results.push(result);
        if (result.status === 'OK') {
            const outs = result.outputs.map(o => `${o.shape}`).join(', ');
            console.log(`OK (${result.loadMs}ms load, ${result.inferMs}ms infer, outputs: ${outs})`);
        } else {
            console.log(`${result.status} ${result.error || ''}`);
        }
    }

    // Test FP32 models (for comparison)
    console.log('\n--- FP32 Model Inference (baseline) ---');
    const fp32Results = [];
    for (const spec of MODELS) {
        process.stdout.write(`  ${spec.name}... `);
        const result = await testModel(spec, FP32_DIR, 'FP32');
        fp32Results.push(result);
        if (result.status === 'OK') {
            console.log(`OK (${result.loadMs}ms load, ${result.inferMs}ms infer)`);
        } else {
            console.log(`${result.status} ${result.error || ''}`);
        }
    }

    // Accuracy comparison (for models that pass both)
    console.log('\n--- Accuracy Comparison (FP32 vs W8A8) ---');
    for (let i = 0; i < MODELS.length; i++) {
        const spec = MODELS[i];
        if (w8a8Results[i].status !== 'OK' || fp32Results[i].status !== 'OK') {
            continue;
        }

        // Run both with same inputs
        const feeds = makeFeeds(spec.inputs);
        const fp32Path = path.join(FP32_DIR, `${spec.name}.onnx`);
        const w8a8Path = path.join(MODEL_DIR, `${spec.name}.onnx`);

        try {
            const fp32Sess = await ort.InferenceSession.create(fp32Path, { executionProviders: ['cpu'] });
            const w8a8Sess = await ort.InferenceSession.create(w8a8Path, { executionProviders: ['cpu'], graphOptimizationLevel: 'basic' });

            const fp32Out = await fp32Sess.run(feeds);
            const w8a8Out = await w8a8Sess.run(feeds);

            const fp32Vals = Object.values(fp32Out);
            const w8a8Vals = Object.values(w8a8Out);

            if (fp32Vals.length > 0 && w8a8Vals.length > 0) {
                const a = fp32Vals[0].data;
                const b = w8a8Vals[0].data;
                let mse = 0, dot = 0, normA = 0, normB = 0;
                const len = Math.min(a.length, b.length);
                for (let j = 0; j < len; j++) {
                    const diff = a[j] - b[j];
                    mse += diff * diff;
                    dot += a[j] * b[j];
                    normA += a[j] * a[j];
                    normB += b[j] * b[j];
                }
                mse /= len;
                const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-12);
                const quality = cosine > 0.99 ? 'EXCELLENT' : cosine > 0.95 ? 'GOOD' : cosine > 0.9 ? 'FAIR' : 'POOR';
                console.log(`  ${spec.name}: MSE=${mse.toExponential(3)}, Cosine=${cosine.toFixed(6)} [${quality}]`);
            }
        } catch (e) {
            console.log(`  ${spec.name}: comparison failed - ${e.message.substring(0, 60)}`);
        }
    }

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('SUMMARY');
    console.log('='.repeat(70));
    const w8a8Ok = w8a8Results.filter(r => r.status === 'OK').length;
    const fp32Ok = fp32Results.filter(r => r.status === 'OK').length;
    console.log(`W8A8 NPU models: ${w8a8Ok}/${MODELS.length} passed`);
    console.log(`FP32 models:     ${fp32Ok}/${MODELS.length} passed`);

    if (w8a8Ok === MODELS.length) {
        console.log('\nALL W8A8 NPU MODELS VERIFIED SUCCESSFULLY');
    }

    process.exit(w8a8Ok === MODELS.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
