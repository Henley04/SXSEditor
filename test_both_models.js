// Test both FP32 (root) and W16A32 (fp16 subdir) diff_step models on DML
const path = require('path');
const ort = require('onnxruntime-node');

const FP32_MODEL = path.join(__dirname, 'onnx_models', 'diff_step_dml.onnx');
const FP16_MODEL = path.join(__dirname, 'onnx_models', 'fp16', 'diff_step_dml.onnx');

function printStats(name, arr) {
    let nan = 0, inf = 0, min = Infinity, max = -Infinity, sum = 0;
    for (const v of arr) {
        if (Number.isNaN(v)) { nan++; continue; }
        if (!Number.isFinite(v)) { inf++; continue; }
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
    }
    const mean = sum / (arr.length - nan - inf);
    console.log(`  ${name}: len=${arr.length}, NaN=${nan}, Inf=${inf}, mean=${mean.toFixed(6)}, min=${min.toFixed(6)}, max=${max.toFixed(6)}`);
}

async function testModel(modelPath, label, inputType) {
    const T = 100;
    const MEL_DIM = 128;
    const COND_DIM = 1024;

    const xtInput = new (inputType === 'float16' ? Uint16Array : Float32Array)(T * MEL_DIM);
    const cond = new (inputType === 'float16' ? Uint16Array : Float32Array)(T * COND_DIM);
    const xtMask = new (inputType === 'float16' ? Uint16Array : Float32Array)(T).fill(inputType === 'float16' ? 0x3C00 : 1); // 1.0 in FP16
    const t = new (inputType === 'float16' ? Uint16Array : Float32Array)([inputType === 'float16' ? 0x3F00 : 0.5]); // 0.5 in FP16

    // Fill with deterministic values (FP16: simple pattern, FP32: same as before)
    if (inputType === 'float32') {
        for (let i = 0; i < xtInput.length; i++) {
            xtInput[i] = Math.sin(i * 0.1) * 0.5 + Math.cos(i * 0.07) * 0.3;
        }
        for (let i = 0; i < cond.length; i++) {
            cond[i] = Math.sin(i * 0.05) * 0.3 + Math.cos(i * 0.03) * 0.2;
        }
    }
    // For FP16, leave as zeros (just testing if inference works, not precision)

    const feeds = {
        xt_input: new ort.Tensor(inputType, xtInput, [1, T, MEL_DIM]),
        t: new ort.Tensor(inputType, t, [1]),
        cond: new ort.Tensor(inputType, cond, [1, T, COND_DIM]),
        xt_mask: new ort.Tensor(inputType, xtMask, [1, T]),
    };

    console.log(`\n--- ${label} ---`);
    console.log(`  Model: ${path.basename(modelPath)}`);
    console.log(`  Input type: ${inputType}`);

    // CPU
    let cpuOutput = null;
    try {
        const sessCpu = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
        const resultCpu = await sessCpu.run(feeds);
        cpuOutput = resultCpu['flow_pred'].data;
        printStats('CPU output', cpuOutput);
        await sessCpu.release();
    } catch (e) {
        console.log('  CPU failed:', e.message.substring(0, 100));
    }

    // DML
    let dmlOutput = null;
    try {
        const sessDml = await ort.InferenceSession.create(modelPath, {
            executionProviders: [{ name: 'dml', deviceId: 0 }, 'cpu'],
            enableMemPattern: false,
            executionMode: 'sequential',
        });
        console.log('  DML session created');
        const resultDml = await sessDml.run(feeds);
        dmlOutput = resultDml['flow_pred'].data;
        printStats('DML output', dmlOutput);
        await sessDml.release();
    } catch (e) {
        console.log('  DML failed:', e.message.substring(0, 200));
    }

    if (cpuOutput && dmlOutput) {
        let cos = 0, normA = 0, normB = 0;
        for (let i = 0; i < cpuOutput.length; i++) {
            cos += cpuOutput[i] * dmlOutput[i];
            normA += cpuOutput[i] * cpuOutput[i];
            normB += dmlOutput[i] * dmlOutput[i];
        }
        cos = cos / (Math.sqrt(normA) * Math.sqrt(normB));
        console.log(`  Cosine(CPU vs DML): ${cos.toFixed(6)}`);
        if (cos > 0.999) {
            console.log('  ✅ PASS');
        } else {
            console.log('  ❌ FAIL: DML output mismatch!');
        }
    }
}

async function main() {
    console.log('ORT version:', ort.env.version || 'unknown');

    // Test FP32 model (root directory)
    await testModel(FP32_MODEL, 'FP32 model (root, 1688MB)', 'float32');

    // Test W16A32 model (fp16 subdir)
    await testModel(FP16_MODEL, 'W16A32 model (fp16 subdir, 844MB)', 'float16');
}

main().catch(e => {
    console.error('Error:', e);
    process.exit(1);
});
