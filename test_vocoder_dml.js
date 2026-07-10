// Quick test: compare vocoder output with normalized vs denormalized mel
// Proves that Vocos vocoder expects denormalized mel (mean=-4.92, std=2.85)
// Usage: node test_vocoder_dml.js
const path = require('path');
const ort = require('onnxruntime-node');

const VOCODER_PATH = path.join(__dirname, 'onnx_models', 'vocoder_dml.onnx');
const MEL_DIM = 128;
const SEQ_LEN = 100;
const MEL_MEAN = -4.92;
const MEL_VAR = 8.14;

async function main() {
    console.log('=== Vocoder normalized vs denormalized mel test ===');
    console.log(`Model: ${VOCODER_PATH}`);

    // Generate normalized mel (mean=0, std=1) - matches diffusion output
    const melNorm = new Float32Array(SEQ_LEN * MEL_DIM);
    let seed = 42;
    for (let i = 0; i < melNorm.length; i++) {
        seed = (seed * 9301 + 49297) % 233280;
        const u1 = seed / 233280;
        seed = (seed * 9301 + 49297) % 233280;
        const u2 = seed / 233280;
        const r = Math.sqrt(-2.0 * Math.log(u1 + 1e-10));
        const theta = 2.0 * Math.PI * u2;
        melNorm[i] = r * Math.cos(theta);
    }

    // Denormalize: mel = mel * sqrt(MEL_VAR) + MEL_MEAN
    const melStd = Math.sqrt(MEL_VAR);
    const melDenorm = new Float32Array(melNorm.length);
    for (let i = 0; i < melNorm.length; i++) {
        melDenorm[i] = melNorm[i] * melStd + MEL_MEAN;
    }

    console.log(`Normalized mel: mean=${mean(melNorm).toFixed(6)}, std=${std(melNorm).toFixed(6)}, min=${min(melNorm).toFixed(6)}, max=${max(melNorm).toFixed(6)}`);
    console.log(`Denormalized mel: mean=${mean(melDenorm).toFixed(6)}, std=${std(melDenorm).toFixed(6)}, min=${min(melDenorm).toFixed(6)}, max=${max(melDenorm).toFixed(6)}`);

    // Test on CPU with both mel types
    console.log('\n--- CPU EP ---');
    const cpuSess = await ort.InferenceSession.create(VOCODER_PATH, {
        executionProviders: ['cpu'],
    });

    // Normalized mel (BUG: causes explosion)
    const normTensor = new ort.Tensor('float32', melNorm, [1, SEQ_LEN, MEL_DIM]);
    const normResult = await cpuSess.run({ mel: normTensor });
    const normWav = normResult['waveform'].data;
    console.log(`\nNormalized mel -> CPU output: mean=${mean(normWav).toFixed(6)}, std=${std(normWav).toFixed(6)}, min=${min(normWav).toFixed(6)}, max=${max(normWav).toFixed(6)}`);
    console.log(`  RMS (first 10 hops): ${rmsPerHop(normWav, 480, 10)}`);

    // Denormalized mel (FIX: reasonable output)
    const denormTensor = new ort.Tensor('float32', melDenorm, [1, SEQ_LEN, MEL_DIM]);
    const denormResult = await cpuSess.run({ mel: denormTensor });
    const denormWav = denormResult['waveform'].data;
    console.log(`\nDenormalized mel -> CPU output: mean=${mean(denormWav).toFixed(6)}, std=${std(denormWav).toFixed(6)}, min=${min(denormWav).toFixed(6)}, max=${max(denormWav).toFixed(6)}`);
    console.log(`  RMS (first 10 hops): ${rmsPerHop(denormWav, 480, 10)}`);

    cpuSess.release();

    // Test on DML with denormalized mel
    console.log('\n--- DML EP (denormalized mel) ---');
    try {
        const dmlSess = await ort.InferenceSession.create(VOCODER_PATH, {
            executionProviders: ['dml', 'cpu'],
            enableMemPattern: false,
            executionMode: 'sequential',
        });
        const dmlResult = await dmlSess.run({ mel: denormTensor });
        const dmlWav = dmlResult['waveform'].data;
        console.log(`DML output: mean=${mean(dmlWav).toFixed(6)}, std=${std(dmlWav).toFixed(6)}, min=${min(dmlWav).toFixed(6)}, max=${max(dmlWav).toFixed(6)}`);
        console.log(`  RMS (first 10 hops): ${rmsPerHop(dmlWav, 480, 10)}`);

        // Compare CPU vs DML for denormalized mel
        const minLen = Math.min(denormWav.length, dmlWav.length);
        let diffSum = 0, diffMax = 0;
        for (let i = 0; i < minLen; i++) {
            const d = Math.abs(denormWav[i] - dmlWav[i]);
            diffSum += d;
            if (d > diffMax) diffMax = d;
        }
        console.log(`\nDiff (CPU vs DML, denormalized): mean=${(diffSum / minLen).toFixed(6)}, max=${diffMax.toFixed(6)}`);

        dmlSess.release();
    } catch (dmlErr) {
        console.error(`DML failed: ${dmlErr.message}`);
    }

    console.log('\n=== Conclusion ===');
    console.log(`Normalized mel output std: ${std(normWav).toFixed(6)} (explosion if >> 1)`);
    console.log(`Denormalized mel output std: ${std(denormWav).toFixed(6)} (reasonable if < 1)`);
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
