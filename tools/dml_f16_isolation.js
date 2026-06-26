// Isolate: does DML work with fresh (non-singleton) float16 inputs?
const path = require('node:path');
const ort = require('onnxruntime-node');

const { EMBED_DIM, MEL_DIM, COND_DIM, HOP_SIZE } = require('../src/inference/pipeline/constants');

async function makeFreshFP16Inputs(key) {
    // Build fresh tensors each call (no sharing)
    const f32to16 = (arr) => {
        const f16 = new Float16Array(arr.length);
        for (let i = 0; i < f16.length; i++) f16[i] = arr[i];
        return new Uint16Array(f16.buffer, f16.byteOffset, f16.length);
    };
    const t16 = (f32, dims) => new ort.Tensor('float16', f32to16(f32), dims);

    switch (key) {
        case 'preflow':
            return { features: t16(new Float32Array(3 * EMBED_DIM).fill(0.1), [1, 3, EMBED_DIM]) };
        case 'condEmb':
            return { cond_code: t16(new Float32Array(3 * EMBED_DIM).fill(0.1), [1, 3, EMBED_DIM]) };
        case 'diffStep':
            return {
                xt_input: t16(new Float32Array(3 * MEL_DIM).fill(0.1), [1, 3, MEL_DIM]),
                t: t16(new Float32Array([0.5]), [1]),
                cond: t16(new Float32Array(3 * COND_DIM).fill(0.1), [1, 3, COND_DIM]),
                xt_mask: t16(new Float32Array([1, 1, 1]), [1, 3]),
            };
        case 'vocoder':
            return { mel: t16(new Float32Array(3 * MEL_DIM).fill(0.1), [1, 3, MEL_DIM]) };
        case 'melTransform':
            return { waveform: t16(new Float32Array(HOP_SIZE * 3).fill(0.1), [1, HOP_SIZE * 3]) };
    }
}

async function testModel(key, file, precisionDir) {
    const modelPath = path.join(__dirname, '..', 'onnx_models', precisionDir, file);
    const fs = require('node:fs');
    if (!fs.existsSync(modelPath)) {
        console.log(`  [SKIP] ${precisionDir}/${file}`);
        return;
    }

    // Test 1: shared singleton inputs (like the app)
    const { DUMMY_TEST_INPUTS_FP16 } = require('../src/inference/pipeline/modelLoader');
    const sharedInputs = DUMMY_TEST_INPUTS_FP16[key];

    let s1;
    try {
        const sess = await ort.InferenceSession.create(modelPath, { executionProviders: [{ name: 'dml' }, 'cpu'] });
        await sess.run(sharedInputs);
        s1 = 'OK';
        sess.release();
    } catch (e) {
        s1 = `FAIL: ${e.message.substring(0, 80)}`;
    }

    // Test 2: fresh inputs
    const freshInputs = await makeFreshFP16Inputs(key);
    let s2;
    try {
        const sess = await ort.InferenceSession.create(modelPath, { executionProviders: [{ name: 'dml' }, 'cpu'] });
        await sess.run(freshInputs);
        s2 = 'OK';
        sess.release();
    } catch (e) {
        s2 = `FAIL: ${e.message.substring(0, 80)}`;
    }

    // Test 3: fresh inputs, graphOptimizationLevel disabled
    let s3;
    try {
        const sess = await ort.InferenceSession.create(modelPath, {
            executionProviders: [{ name: 'dml' }, 'cpu'],
            graphOptimizationLevel: 'disabled',
        });
        await sess.run(freshInputs);
        s3 = 'OK';
        sess.release();
    } catch (e) {
        s3 = `FAIL: ${e.message.substring(0, 80)}`;
    }

    console.log(`  ${precisionDir}/${file}:\n    shared=${s1}\n    fresh=${s2}\n    fresh+no-opt=${s3}`);
}

async function main() {
    const cases = [
        ['preflow', 'preflow.onnx'],
        ['condEmb', 'cond_emb.onnx'],
        ['diffStep', 'diff_step_dml.onnx'],
        ['vocoder', 'vocoder_dml.onnx'],
    ];
    for (const [key, file] of cases) {
        console.log(`\n=== ${key} ===`);
        await testModel(key, file, 'fp16');
        await testModel(key, file, 'fp8');
    }
}

main().catch(e => { console.error(e); process.exit(1); });
