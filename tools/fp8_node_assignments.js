// Check node-to-EP assignments for FP8 models on DML.
// Enable verbose logging to see which nodes fall back to CPU.
require('../src/inference/pipeline/float16Patch');
const path = require('node:path');
const ort = require('onnxruntime-node');
const { DUMMY_TEST_INPUTS_FP16 } = require('../src/inference/pipeline/modelLoader');

// Enable verbose logging
ort.env.logLevel = 'verbose';
ort.env.log = (level, message) => {
    // Capture only partitioning-related messages
    if (typeof message === 'string' && (
        message.includes('partition') ||
        message.includes('DequantizeLinear') ||
        message.includes('assigned') ||
        message.includes('Dml') ||
        message.includes('CPUExecutionProvider')
    )) {
        console.log(`[${level}] ${message.substring(0, 200)}`);
    }
};

async function checkModel(key, file) {
    const modelPath = path.join(__dirname, '..', 'onnx_models', 'fp8', file);
    console.log(`\n${'='.repeat(60)}\n${key} / ${file}\n${'='.repeat(60)}`);

    let sess;
    try {
        sess = await ort.InferenceSession.create(modelPath, {
            executionProviders: [{ name: 'dml' }, 'cpu'],
            graphOptimizationLevel: 'all',
        });
    } catch (e) {
        console.log(`Session create FAILED: ${e.message.substring(0, 150)}`);
        return;
    }

    try {
        await sess.run(DUMMY_TEST_INPUTS_FP16[key]);
        console.log(`Run OK`);
    } catch (e) {
        console.log(`Run FAILED: ${e.message.substring(0, 150)}`);
    }
    sess.release();
}

async function main() {
    // Test the most important FP8 models
    await checkModel('diffStep', 'diff_step_dml.onnx');
    await checkModel('vocoder', 'vocoder_dml.onnx');
    // Reset log level
    ort.env.logLevel = 'warning';
}

main().catch(e => { console.error(e); process.exit(1); });
