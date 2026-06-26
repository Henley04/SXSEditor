// Diagnostic v2: use real FP16 dummy inputs from the codebase to test if DML can run FP8 models.
const path = require('node:path');
const fs = require('node:fs');
const ort = require('onnxruntime-node');
const { DUMMY_TEST_INPUTS_FP16, DUMMY_TEST_INPUTS_FP32 } = require('../src/inference/pipeline/modelLoader');

const FP8_DIR = path.join(__dirname, '..', 'onnx_models', 'fp8');

const SESSION_TO_FILE = {
    noteTextEncoder: 'note_text_encoder.onnx',
    notePitchEncoder: 'note_pitch_encoder.onnx',
    noteTypeEncoder: 'note_type_encoder.onnx',
    f0Encoder: 'f0_encoder.onnx',
    preflow: 'preflow.onnx',
    condEmb: 'cond_emb.onnx',
    diffStep: 'diff_step_dml.onnx',
    vocoder: 'vocoder_dml.onnx',
    melTransform: 'mel_transform.onnx',
};

async function probe(key) {
    const file = SESSION_TO_FILE[key];
    const modelPath = path.join(FP8_DIR, file);
    if (!fs.existsSync(modelPath)) {
        console.log(`[SKIP] ${key} (${file}): not found`);
        return;
    }
    const sizeMB = fs.statSync(modelPath).size / (1024 * 1024);
    console.log(`\n=== ${key} / ${file} (${sizeMB.toFixed(1)} MB) ===`);

    // Probe input type via CPU session
    let cpuSess;
    try {
        cpuSess = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    } catch (e) {
        console.log(`  CPU load FAILED: ${e.message.substring(0, 120)}`);
        return;
    }
    const firstInput = cpuSess.inputNames[0];
    const inputType = cpuSess.inputMetadata[firstInput]?.type;
    console.log(`  Input type: ${inputType} (first input: ${firstInput})`);
    cpuSess.release();

    const isFP16 = inputType === 'float16';
    const dummyInputs = isFP16 ? DUMMY_TEST_INPUTS_FP16[key] : DUMMY_TEST_INPUTS_FP32[key];
    if (!dummyInputs) {
        console.log(`  No dummy inputs for ${key}`);
        return;
    }

    // DML session + run
    let dmlSess = null;
    try {
        dmlSess = await ort.InferenceSession.create(modelPath, {
            executionProviders: [{ name: 'dml' }, 'cpu'],
            graphOptimizationLevel: 'all',
        });
    } catch (e) {
        console.log(`  DML create FAILED: ${e.message.substring(0, 200)}`);
        return;
    }

    try {
        const out = await dmlSess.run(dummyInputs);
        const summary = Object.keys(out).map(n => {
            const t = out[n];
            return `${n}:${t.type}[${t.dims.join(',')}]`;
        });
        console.log(`  DML run OK with ${isFP16 ? 'FP16' : 'FP32'} inputs: {${summary.join(', ')}}`);
        console.log(`  >>> DML CAN run this FP8 model (with correct input types)`);
    } catch (e) {
        console.log(`  DML run FAILED: ${e.message.substring(0, 300)}`);
        console.log(`  >>> DML CANNOT run this FP8 model — would fall back to CPU`);
    }
    dmlSess.release();
}

async function main() {
    const keys = Object.keys(SESSION_TO_FILE);
    for (const k of keys) {
        try { await probe(k); } catch (e) { console.error(`Error probing ${k}:`, e.message); }
    }
}

main().catch(e => { console.error(e); process.exit(1); });
