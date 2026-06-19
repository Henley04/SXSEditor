/**
 * Test W8A8 NPU model loading and inference through the SVS pipeline.
 * Run with: node test_w8a8_pipeline.js
 */

const path = require('node:path');
const ort = require('onnxruntime-node');

const MODEL_DIR = path.join(__dirname, 'onnx_models', 'int8', 'optimized_npu');
const SEQ_LEN = 2048;
const VOCODER_SEQ_LEN = 500;

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

async function testModel(modelSpec) {
    const modelPath = path.join(MODEL_DIR, `${modelSpec.name}.onnx`);
    const fs = require('node:fs');
    if (!fs.existsSync(modelPath)) {
        return { name: modelSpec.name, status: 'NOT_FOUND' };
    }

    // Test 1: Load session
    let session;
    try {
        session = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'basic',
        });
    } catch (e) {
        return { name: modelSpec.name, status: 'LOAD_FAIL', error: e.message.substring(0, 100) };
    }

    // Test 2: Run inference
    try {
        const feeds = makeFeeds(modelSpec.inputs);
        const results = await session.run(feeds);
        const outputKeys = Object.keys(results);
        const outputShapes = outputKeys.map(k => results[k].dims);
        return { name: modelSpec.name, status: 'OK', outputs: outputShapes };
    } catch (e) {
        return { name: modelSpec.name, status: 'INFER_FAIL', error: e.message.substring(0, 100) };
    }
}

async function main() {
    console.log('='.repeat(60));
    console.log('W8A8 NPU Model Loading & Inference Test');
    console.log(`Model dir: ${MODEL_DIR}`);
    console.log('='.repeat(60));

    const results = [];
    for (const spec of MODELS) {
        process.stdout.write(`  ${spec.name}... `);
        const result = await testModel(spec);
        results.push(result);
        if (result.status === 'OK') {
            console.log(`OK (outputs: ${JSON.stringify(result.outputs)})`);
        } else {
            console.log(`${result.status} ${result.error || ''}`);
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log('Summary');
    console.log('='.repeat(60));
    const ok = results.filter(r => r.status === 'OK').length;
    const fail = results.filter(r => r.status !== 'OK');
    console.log(`${ok}/${results.length} models passed`);
    if (fail.length > 0) {
        console.log('Failed:');
        for (const f of fail) {
            console.log(`  ${f.name}: ${f.status} ${f.error || ''}`);
        }
    }

    process.exit(ok === results.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
