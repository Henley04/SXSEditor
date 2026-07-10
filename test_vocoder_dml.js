// Quick test: compare vocoder output on DML vs CPU
// Usage: node test_vocoder_dml.js
const path = require('path');
const ort = require('onnxruntime-node');

const VOCODER_PATH = path.join(__dirname, 'onnx_models', 'vocoder_dml.onnx');
const MEL_DIM = 128;
const SEQ_LEN = 100;

async function main() {
    console.log('=== Vocoder DML vs CPU test ===');
    console.log(`Model: ${VOCODER_PATH}`);

    // Generate normalized mel (mean=0, std=1) - matches diffusion output
    const mel = new Float32Array(SEQ_LEN * MEL_DIM);
    let seed = 42;
    for (let i = 0; i < mel.length; i++) {
        // Simple Gaussian noise (Box-Muller)
        seed = (seed * 9301 + 49297) % 233280;
        const u1 = seed / 233280;
        seed = (seed * 9301 + 49297) % 233280;
        const u2 = seed / 233280;
        const r = Math.sqrt(-2.0 * Math.log(u1 + 1e-10));
        const theta = 2.0 * Math.PI * u2;
        mel[i] = r * Math.cos(theta);
    }

    console.log(`Input mel: len=${mel.length}, mean=${mean(mel).toFixed(6)}, std=${std(mel).toFixed(6)}, min=${min(mel).toFixed(6)}, max=${max(mel).toFixed(6)}`);

    const melTensor = new ort.Tensor('float32', mel, [1, SEQ_LEN, MEL_DIM]);
    const feeds = { mel: melTensor };

    // Test on CPU
    console.log('\n--- CPU EP ---');
    const cpuSess = await ort.InferenceSession.create(VOCODER_PATH, {
        executionProviders: ['cpu'],
    });
    const cpuResult = await cpuSess.run(feeds);
    const cpuWav = cpuResult['waveform'].data;
    console.log(`CPU output: len=${cpuWav.length}, mean=${mean(cpuWav).toFixed(6)}, std=${std(cpuWav).toFixed(6)}, min=${min(cpuWav).toFixed(6)}, max=${max(cpuWav).toFixed(6)}`);
    console.log(`CPU RMS (first 10 hops): ${rmsPerHop(cpuWav, 480, 10)}`);
    cpuSess.release();

    // Test on DML
    console.log('\n--- DML EP ---');
    try {
        const dmlSess = await ort.InferenceSession.create(VOCODER_PATH, {
            executionProviders: ['dml', 'cpu'],
            enableMemPattern: false,
            executionMode: 'sequential',
        });
        const dmlResult = await dmlSess.run(feeds);
        const dmlWav = dmlResult['waveform'].data;
        console.log(`DML output: len=${dmlWav.length}, mean=${mean(dmlWav).toFixed(6)}, std=${std(dmlWav).toFixed(6)}, min=${min(dmlWav).toFixed(6)}, max=${max(dmlWav).toFixed(6)}`);
        console.log(`DML RMS (first 10 hops): ${rmsPerHop(dmlWav, 480, 10)}`);

        // Compare
        const minLen = Math.min(cpuWav.length, dmlWav.length);
        let diffSum = 0, diffMax = 0;
        for (let i = 0; i < minLen; i++) {
            const d = Math.abs(cpuWav[i] - dmlWav[i]);
            diffSum += d;
            if (d > diffMax) diffMax = d;
        }
        console.log(`\nDiff (CPU vs DML): mean=${(diffSum / minLen).toFixed(6)}, max=${diffMax.toFixed(6)}`);

        dmlSess.release();
    } catch (dmlErr) {
        console.error(`DML failed: ${dmlErr.message}`);
    }
}

function mean(arr) {
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}
function std(arr) {
    const m = mean(arr);
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(s / arr.length);
}
function min(arr) {
    let m = Infinity;
    for (let i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i];
    return m;
}
function max(arr) {
    let m = -Infinity;
    for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    return m;
}
function rmsPerHop(arr, hop, nHops) {
    const parts = [];
    for (let f = 0; f < nHops; f++) {
        let s = 0;
        const s0 = f * hop;
        const s1 = Math.min(s0 + hop, arr.length);
        for (let i = s0; i < s1; i++) s += arr[i] * arr[i];
        parts.push(`f${f}=${Math.sqrt(s / Math.max(1, s1 - s0)).toFixed(5)}`);
    }
    return parts.join(', ');
}

main().catch(console.error);
