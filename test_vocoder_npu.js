/**
 * Vocoder NPU 验证脚本
 *
 * 验证 optimized_npu vocoder 模型可正常加载和推理。
 * 使用 onnxruntime-node CPU EP 验证模型图结构有效；
 * 输出信息可用于确认模型符合 NPU 推理要求（静态形状、输出维度等）。
 *
 * 用法: node test_vocoder_npu.js
 */

const ort = require('onnxruntime-node');
const path = require('path');
const fs = require('fs');

const NPU_VOCODER_SEQ_LEN = 500;
const MEL_DIM = 128;
const HOP_SIZE = 480;

async function main() {
    console.log('=== Vocoder NPU Model Verification ===\n');

    // 1. Find vocoder model
    const optimizedDir = path.join(__dirname, 'onnx_models', 'int8', 'optimized_npu');
    let modelPath = path.join(optimizedDir, 'vocoder_dml.onnx');
    if (!fs.existsSync(modelPath)) {
        modelPath = path.join(optimizedDir, 'vocoder.onnx');
    }
    if (!fs.existsSync(modelPath)) {
        console.error(`[FAIL] Vocoder model not found in ${optimizedDir}`);
        process.exit(1);
    }

    const modelSize = fs.statSync(modelPath).size;
    console.log(`[INFO] Model: ${path.basename(modelPath)} (${(modelSize / 1024 / 1024).toFixed(1)} MB)`);

    // 2. Check for external data file
    const dataPath = modelPath + '.data';
    if (fs.existsSync(dataPath)) {
        const dataSize = fs.statSync(dataPath).size;
        console.log(`[INFO] External data: ${path.basename(dataPath)} (${(dataSize / 1024 / 1024).toFixed(1)} MB)`);
    }

    // 3. Load model
    console.log(`\n[TEST] Loading model with CPU EP (basic graph optimization)...`);
    const loadStart = Date.now();
    let session;
    try {
        session = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'basic',
        });
    } catch (e) {
        console.error(`[FAIL] Model load failed: ${e.message}`);
        process.exit(1);
    }
    const loadMs = Date.now() - loadStart;
    console.log(`[OK] Model loaded in ${loadMs}ms`);

    // 4. Print model I/O metadata
    console.log(`\n[INFO] Input metadata:`);
    for (const inp of session.inputNames) {
        const meta = session.inputMetadata?.[inp];
        console.log(`  ${inp}: type=${meta?.type || 'unknown'}, shape=${JSON.stringify(meta?.dimensions || [])}`);
    }
    console.log(`[INFO] Output metadata:`);
    for (const out of session.outputNames) {
        const meta = session.outputMetadata?.[out];
        console.log(`  ${out}: type=${meta?.type || 'unknown'}, shape=${JSON.stringify(meta?.dimensions || [])}`);
    }

    // 5. Create dummy mel input [1, NPU_VOCODER_SEQ_LEN, MEL_DIM]
    const seqLen = NPU_VOCODER_SEQ_LEN;
    const melData = new Float32Array(seqLen * MEL_DIM);
    // Fill with small random values to simulate mel spectrogram
    for (let i = 0; i < melData.length; i++) {
        melData[i] = (Math.random() - 0.5) * 0.1;
    }
    const melTensor = new ort.Tensor('float32', melData, [1, seqLen, MEL_DIM]);
    console.log(`\n[TEST] Running inference: mel input [1, ${seqLen}, ${MEL_DIM}] = ${(melData.length * 4 / 1024 / 1024).toFixed(2)} MB`);

    // 6. Run inference
    const inferStart = Date.now();
    let results;
    try {
        results = await session.run({ mel: melTensor });
    } catch (e) {
        console.error(`[FAIL] Inference failed: ${e.message}`);
        session.release();
        process.exit(1);
    }
    const inferMs = Date.now() - inferStart;
    console.log(`[OK] Inference completed in ${inferMs}ms`);

    // 7. Verify output
    const waveform = results['waveform'];
    if (!waveform) {
        console.error(`[FAIL] No 'waveform' output found. Available outputs: ${Object.keys(results).join(', ')}`);
        session.release();
        process.exit(1);
    }

    const outDims = waveform.dims;
    const outData = waveform.data;
    const expectedSamples = seqLen * HOP_SIZE;
    const outFloat32 = outData instanceof Float32Array ? outData : new Float32Array(outData);

    console.log(`\n[INFO] Output 'waveform':`);
    console.log(`  Shape: [${outDims.join(', ')}]`);
    console.log(`  Length: ${outFloat32.length} samples`);
    console.log(`  Expected: ${expectedSamples} samples (seq_len=${seqLen} × hop=${HOP_SIZE})`);
    console.log(`  Duration: ${(outFloat32.length / 24000).toFixed(2)}s @ 24kHz`);

    // 8. Check output values
    let nanCount = 0, infCount = 0, zeroCount = 0;
    let maxAbs = 0, sum = 0;
    for (let i = 0; i < outFloat32.length; i++) {
        const v = outFloat32[i];
        if (isNaN(v)) nanCount++;
        if (!isFinite(v)) infCount++;
        if (v === 0) zeroCount++;
        const abs = Math.abs(v);
        if (abs > maxAbs) maxAbs = abs;
        sum += abs;
    }
    const meanAbs = sum / outFloat32.length;
    const zeroRatio = zeroCount / outFloat32.length;

    console.log(`\n[INFO] Output statistics:`);
    console.log(`  Max |value|: ${maxAbs.toFixed(6)}`);
    console.log(`  Mean |value|: ${meanAbs.toFixed(6)}`);
    console.log(`  Zero values: ${zeroCount} (${(zeroRatio * 100).toFixed(1)}%)`);
    console.log(`  NaN count: ${nanCount}`);
    console.log(`  Inf count: ${infCount}`);

    // 9. Final verdict
    const passed = nanCount === 0 && infCount === 0 && maxAbs > 1e-6;
    console.log(`\n${'='.repeat(45)}`);
    if (passed) {
        console.log(`[PASS] Vocoder model verification PASSED`);
        console.log(`  - Model loads successfully`);
        console.log(`  - Inference produces valid waveform output`);
        console.log(`  - Output shape: [${outDims.join(', ')}]`);
        console.log(`  - No NaN/Inf values in output`);
        console.log(`  - Non-zero output (max|v|=${maxAbs.toFixed(6)})`);
    } else {
        console.log(`[FAIL] Vocoder model verification FAILED`);
        if (nanCount > 0) console.log(`  - ${nanCount} NaN values in output`);
        if (infCount > 0) console.log(`  - ${infCount} Inf values in output`);
        if (maxAbs <= 1e-6) console.log(`  - Output is effectively zero (max|v|=${maxAbs})`);
    }
    console.log(`${'='.repeat(45)}`);

    session.release();
    process.exit(passed ? 0 : 1);
}

main().catch(e => {
    console.error(`[ERROR] ${e.message}`);
    process.exit(1);
});
