// Diagnostic: probe whether DirectML EP can run FP8-quantized models.
// Usage: node tools/fp8_dml_probe.js [modelFile]
const path = require('node:path');
const fs = require('node:fs');
const ort = require('onnxruntime-node');

const FP8_DIR = path.join(__dirname, '..', 'onnx_models', 'fp8');

async function probeModel(modelFile) {
    const modelPath = path.join(FP8_DIR, modelFile);
    if (!fs.existsSync(modelPath)) {
        console.log(`[SKIP] ${modelFile}: not found`);
        return;
    }
    const sizeMB = fs.statSync(modelPath).size / (1024 * 1024);
    console.log(`\n=== ${modelFile} (${sizeMB.toFixed(1)} MB) ===`);

    // 1) CPU load + list capabilities
    let cpuSess = null;
    try {
        cpuSess = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'all',
        });
        const inputs = cpuSess.inputNames.map(n => {
            const meta = cpuSess.inputMetadata[n];
            return `${n}:${meta?.type||'?'}[${(meta?.shape||[]).map(d => typeof d === 'number' ? d : '?').join(',')}]`;
        });
        console.log(`  CPU: inputs=[${inputs.join(', ')}]`);
    } catch (e) {
        console.log(`  CPU load FAILED: ${e.message.substring(0, 120)}`);
        return;
    }

    // 2) DML load (no validation run yet)
    let dmlSess = null;
    try {
        dmlSess = await ort.InferenceSession.create(modelPath, {
            executionProviders: [{ name: 'dml' }, 'cpu'],
            graphOptimizationLevel: 'all',
        });
        console.log(`  DML: session created (with cpu fallback)`);
    } catch (e) {
        console.log(`  DML load FAILED: ${e.message.substring(0, 200)}`);
        if (cpuSess) cpuSess.release();
        return;
    }

    // 3) Build dummy feeds from metadata
    const feeds = {};
    for (const name of dmlSess.inputNames) {
        const meta = dmlSess.inputMetadata[name];
        const shape = (meta?.shape || [1]).map(d => typeof d === 'number' ? d : 1);
        const total = shape.reduce((a, b) => a * b, 1);
        if (meta?.type === 'int64' || meta?.type === 'int32') {
            feeds[name] = new ort.Tensor('int64', BigInt64Array.from({ length: total }, (_, i) => BigInt(i % 100 + 1)), shape);
        } else if (meta?.type === 'float16') {
            const u16 = new Uint16Array(total);
            feeds[name] = new ort.Tensor('float16', u16, shape);
        } else {
            feeds[name] = new ort.Tensor('float32', new Float32Array(total).fill(0.1), shape);
        }
    }

    // 4) Run on DML session and capture which EP each node used
    try {
        const out = await dmlSess.run(feeds);
        const outNames = Object.keys(out);
        const summary = outNames.map(n => {
            const t = out[n];
            const mean = t.data.length > 0
                ? (t.data instanceof Float32Array
                    ? t.data.reduce((a, b) => a + b, 0) / t.data.length
                    : 'non-f32')
                : 0;
            return `${n}:${t.type}[${t.dims.join(',')}]mean=${typeof mean === 'number' ? mean.toFixed(4) : mean}`;
        });
        console.log(`  DML run OK: outputs={${summary.join(', ')}}`);
        console.log(`  >>> DML CAN run this FP8 model`);
    } catch (e) {
        console.log(`  DML run FAILED: ${e.message.substring(0, 250)}`);
        console.log(`  >>> DML CANNOT run this FP8 model — falls back to CPU in createSessionWithValidation`);
    }

    // 5) Try DML-only (no cpu fallback) to see if pure DML is possible
    try {
        const dmlOnly = await ort.InferenceSession.create(modelPath, {
            executionProviders: [{ name: 'dml' }],
            graphOptimizationLevel: 'all',
        });
        await dmlOnly.run(feeds);
        console.log(`  DML-only (no cpu) run OK`);
        dmlOnly.release();
    } catch (e) {
        console.log(`  DML-only run FAILED: ${e.message.substring(0, 150)}`);
    }

    if (cpuSess) cpuSess.release();
    if (dmlSess) dmlSess.release();
}

async function main() {
    const argModel = process.argv[2];
    const models = argModel
        ? [argModel]
        : ['preflow.onnx', 'cond_emb.onnx', 'diff_step_dml.onnx', 'vocoder_dml.onnx', 'note_text_encoder.onnx'];
    for (const m of models) {
        await probeModel(m);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
