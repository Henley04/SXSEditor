// Diagnostic v4: apply float16Patch first, then test DML with FP8 vs FP16.
require('../src/inference/pipeline/float16Patch');
const path = require('node:path');
const fs = require('node:fs');
const ort = require('onnxruntime-node');
const { DUMMY_TEST_INPUTS_FP16, DUMMY_TEST_INPUTS_FP32 } = require('../src/inference/pipeline/modelLoader');

const ROOT = path.join(__dirname, '..', 'onnx_models');

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

async function probe(key, precisionDir) {
    const file = SESSION_TO_FILE[key];
    const modelPath = path.join(ROOT, precisionDir, file);
    if (!fs.existsSync(modelPath)) return null;

    let cpuSess;
    try {
        cpuSess = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    } catch (e) {
        return `cpu-load-fail:${e.message.substring(0, 60)}`;
    }
    const inputType = cpuSess.inputMetadata[0]?.type;
    cpuSess.release();

    const isFP16 = inputType === 'float16';
    const dummyInputs = isFP16 ? DUMMY_TEST_INPUTS_FP16[key] : DUMMY_TEST_INPUTS_FP32[key];
    if (!dummyInputs) return 'no-dummy';

    let dmlSess = null;
    try {
        dmlSess = await ort.InferenceSession.create(modelPath, {
            executionProviders: [{ name: 'dml' }, 'cpu'],
        });
    } catch (e) {
        return `create-fail:${e.message.substring(0, 80)}`;
    }

    try {
        await dmlSess.run(dummyInputs);
        dmlSess.release();
        return 'DML-OK';
    } catch (e) {
        dmlSess.release();
        return `run-fail:${e.message.substring(0, 100)}`;
    }
}

async function main() {
    console.log('=== FP8 vs FP16 DML support (with float16Patch applied) ===\n');
    for (const key of Object.keys(SESSION_TO_FILE)) {
        const fp16 = await probe(key, 'fp16');
        const fp8 = await probe(key, 'fp8');
        const pad = (s) => String(s).padEnd(45);
        console.log(`${key.padEnd(18)} FP16: ${pad(fp16)}  FP8: ${fp8}`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
