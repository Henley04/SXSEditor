/**
 * Standalone DML FP32 test - reproduces Electron app conditions
 * Usage: node test_dml_fp32.js
 */
const path = require('path');
const fs = require('fs');

// Set env vars BEFORE loading onnxruntime-node
process.env.ORT_DML_DEBUG = '1';
process.env.ORT_LOGGING_LEVEL = '0';

const ort = require('onnxruntime-node');
ort.env.logLevel = 'verbose';

const MODEL_PATH = path.join(__dirname, 'onnx_models', 'diff_step_dml.onnx');

async function main() {
    console.log('=== DML FP32 Test ===');
    console.log(`Model: ${MODEL_PATH}`);
    console.log(`ORT version: ${ort.env.versions?.common || 'unknown'}`);
    console.log(`logLevel: ${ort.env.logLevel}`);

    // Check model file
    const modelStat = fs.statSync(MODEL_PATH);
    console.log(`Model size: ${modelStat.size} bytes`);
    const dataPath = MODEL_PATH + '.data';
    if (fs.existsSync(dataPath)) {
        const dataStat = fs.statSync(dataPath);
        console.log(`External data: ${(dataStat.size / 1024 / 1024).toFixed(1)} MB`);
    }

    // Create session with DML (deviceId=1, same as Electron)
    console.log('\nCreating DML session with deviceId=1...');
    let session;
    try {
        session = await ort.InferenceSession.create(MODEL_PATH, {
            executionProviders: [{ name: 'dml', deviceId: 1 }, 'cpu'],
            enableMemPattern: false,
            executionMode: 'sequential',
        });
        console.log('Session created successfully');
    } catch (err) {
        console.error('Session creation failed:', err.message);
        process.exit(1);
    }

    // Print input metadata
    console.log('\nInput metadata:');
    for (let i = 0; i < session.inputNames.length; i++) {
        const name = session.inputNames[i];
        const meta = session.inputMetadata[i];
        console.log(`  ${i}: ${name} type=${meta.type} dims=${JSON.stringify(meta.dims)} (rawShape=${JSON.stringify(meta.shape)})`);
    }

    const MEL_DIM = 128;
    const COND_DIM = 1024;

    // Test sizes
    const testSizes = [3, 10, 100, 500, 1197, 1654];
    const results = [];

    for (const seqLen of testSizes) {
        const xtData = new Float32Array(seqLen * MEL_DIM);
        const tData = new Float32Array([0.5]);
        const condData = new Float32Array(seqLen * COND_DIM);
        const maskData = new Float32Array(seqLen).fill(1);

        // Fill with random data at realistic scale
        for (let i = 0; i < xtData.length; i++) xtData[i] = (Math.random() - 0.5) * 2.0;
        for (let i = 0; i < condData.length; i++) condData[i] = (Math.random() - 0.5) * 2.0;

        const feeds = {
            xt_input: new ort.Tensor('float32', xtData, [1, seqLen, MEL_DIM]),
            t: new ort.Tensor('float32', tData, [1]),
            cond: new ort.Tensor('float32', condData, [1, seqLen, COND_DIM]),
            xt_mask: new ort.Tensor('float32', maskData, [1, seqLen]),
        };

        try {
            const output = await session.run(feeds);
            const pred = output['flow_pred'].data;
            let nanCount = 0, infCount = 0, sum = 0, finCount = 0;
            for (let i = 0; i < pred.length; i++) {
                if (Number.isNaN(pred[i])) nanCount++;
                else if (!Number.isFinite(pred[i])) infCount++;
                else { sum += pred[i]; finCount++; }
            }
            const mean = finCount > 0 ? sum / finCount : NaN;
            const status = nanCount > 0 ? 'FAIL (NaN)' : 'OK';
            console.log(`  T=${seqLen}: ${status} NaN=${nanCount}, Inf=${infCount}, mean=${mean.toFixed(6)}`);
            results.push({ seqLen, nanCount, infCount, mean, status });
        } catch (err) {
            console.log(`  T=${seqLen}: ERROR - ${err.message}`);
            results.push({ seqLen, error: err.message, status: 'ERROR' });
        }
    }

    // Also test with CPU
    console.log('\n\nCreating CPU session for comparison...');
    let cpuSession;
    try {
        cpuSession = await ort.InferenceSession.create(MODEL_PATH, {
            executionProviders: ['cpu'],
        });
        console.log('CPU session created successfully');
    } catch (err) {
        console.error('CPU session creation failed:', err.message);
    }

    if (cpuSession) {
        const seqLen = 1654;
        const xtData = new Float32Array(seqLen * MEL_DIM);
        const tData = new Float32Array([0.5]);
        const condData = new Float32Array(seqLen * COND_DIM);
        const maskData = new Float32Array(seqLen).fill(1);
        for (let i = 0; i < xtData.length; i++) xtData[i] = (Math.random() - 0.5) * 0.01;
        for (let i = 0; i < condData.length; i++) condData[i] = (Math.random() - 0.5) * 0.1;

        try {
            const output = await cpuSession.run({
                xt_input: new ort.Tensor('float32', xtData, [1, seqLen, MEL_DIM]),
                t: new ort.Tensor('float32', tData, [1]),
                cond: new ort.Tensor('float32', condData, [1, seqLen, COND_DIM]),
                xt_mask: new ort.Tensor('float32', maskData, [1, seqLen]),
            });
            const pred = output['flow_pred'].data;
            let nanCount = 0, sum = 0, finCount = 0;
            for (let i = 0; i < pred.length; i++) {
                if (Number.isNaN(pred[i])) nanCount++;
                else { sum += pred[i]; finCount++; }
            }
            const mean = finCount > 0 ? sum / finCount : NaN;
            console.log(`  CPU T=${seqLen}: NaN=${nanCount}, mean=${mean.toFixed(6)}`);
        } catch (err) {
            console.log(`  CPU T=${seqLen}: ERROR - ${err.message}`);
        }
        cpuSession.release();
    }

    session.release();

    console.log('\n=== Summary ===');
    const allOk = results.every(r => r.status === 'OK');
    console.log(allOk ? 'ALL OK' : 'SOME FAILED');
    for (const r of results) {
        if (r.status !== 'OK') {
            console.log(`  T=${r.seqLen}: ${r.status}`);
        }
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});