// Compare DML support: FP16 vs FP8 for the same models.
const path = require('node:path');
const fs = require('node:fs');
const ort = require('onnxruntime-node');
const { DUMMY_TEST_INPUTS_FP16, DUMMY_TEST_INPUTS_FP32 } = require('../src/inference/pipeline/modelLoader');

const ROOT = path.join(__dirname, '..', 'onnx_models');

const SESSION_TO_FILE = {
    preflow: 'preflow.onnx',
    condEmb: 'cond_emb.onnx',
    diffStep: 'diff_step_dml.onnx',
    vocoder: 'vocoder_dml.onnx',
    melTransform: 'mel_transform.onnx',
};

async function probe(key, precisionDir) {
    const file = SESSION_TO_FILE[key];
    const modelPath = path.join(ROOT, precisionDir, file);
    if (!fs.existsSync(modelPath)) {
        console.log(`  [SKIP] ${precisionDir}/${file}: not found`);
        return null;
    }

    let cpuSess;
    try {
        cpuSess = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    } catch (e) {
        console.log(`  [${precisionDir}] CPU load FAILED: ${e.message.substring(0, 80)}`);
        return null;
    }
    const inputType = cpuSess.inputMetadata[0]?.type;
    cpuSess.release();

    const isFP16 = inputType === 'float16';
    const dummyInputs = isFP16 ? DUMMY_TEST_INPUTS_FP16[key] : DUMMY_TEST_INPUTS_FP32[key];

    let dmlSess = null;
    try {
        dmlSess = await ort.InferenceSession.create(modelPath, {
            executionProviders: [{ name: 'dml' }, 'cpu'],
        });
    } catch (e) {
        return `create:${e.message.substring(0, 60)}`;
    }

    try {
        await dmlSess.run(dummyInputs);
        dmlSess.release();
        return 'OK';
    } catch (e) {
        dmlSess.release();
        return `run:${e.message.substring(0, 80)}`;
    }
}

async function main() {
    for (const key of Object.keys(SESSION_TO_FILE)) {
        console.log(`\n=== ${key} / ${SESSION_TO_FILE[key]} ===`);
        const fp16 = await probe(key, 'fp16');
        const fp8 = await probe(key, 'fp8');
        console.log(`  FP16 DML: ${fp16}`);
        console.log(`  FP8  DML: ${fp8}`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
