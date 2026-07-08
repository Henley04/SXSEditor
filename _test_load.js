const ort = require('onnxruntime-node');
const path = require('path');

const MEL_DIM = 128;
const COND_DIM = 1024;

async function testLoad(modelRelPath, label) {
    const mp = path.join(__dirname, modelRelPath);
    console.log(`\n=== Testing ${label}: ${modelRelPath} ===`);
    try {
        const sess = await ort.InferenceSession.create(mp, { executionProviders: ['cpu'] });
        console.log('  loaded ok, inputs:', sess.inputNames);
        // Print input metadata
        for (const n of sess.inputNames) {
            const meta = sess.inputMetadata ? sess.inputMetadata[n] : null;
            if (meta) {
                console.log(`    ${n}: dims=${JSON.stringify(meta.dims)} type=${meta.type}`);
            } else {
                console.log(`    ${n}: (no metadata)`);
            }
        }
        // Try run with float32 [1,3,128]
        try {
            const xt = new ort.Tensor('float32', new Float32Array(3 * MEL_DIM), [1, 3, MEL_DIM]);
            const t = new ort.Tensor('float32', new Float32Array([0.5]), [1]);
            const cond = new ort.Tensor('float32', new Float32Array(3 * COND_DIM), [1, 3, COND_DIM]);
            const mask = new ort.Tensor('float32', new Float32Array([1, 1, 1]), [1, 3]);
            const out = await sess.run({ xt_input: xt, t, cond, xt_mask: mask });
            console.log('  RUN OK (f32), outputs:', Object.keys(out));
        } catch (runErr) {
            console.error('  RUN ERR (f32):', runErr.message.substring(0, 200));
        }
        sess.release();
    } catch (e) {
        console.error('  LOAD ERR:', e.message.substring(0, 300));
    }
}

(async () => {
    await testLoad(path.join('onnx_models', 'fp16', 'diff_step_dml.onnx'), 'FP16 diff_step');
    await testLoad(path.join('onnx_models', 'diff_step_dml.onnx'), 'ROOT diff_step');
    await testLoad(path.join('onnx_models', 'fp16', 'vocoder_dml.onnx'), 'FP16 vocoder');
    await testLoad(path.join('onnx_models', 'vocoder_dml.onnx'), 'ROOT vocoder');
})();
