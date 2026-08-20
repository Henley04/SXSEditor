/* 对比各精度目录 diff_step 模型签名 + 实测 cond 维度兼容性 */
const path = require('path');
const ort = require('onnxruntime-node');

async function inspect(label, filePath) {
    console.log(`\n===== ${label} =====`);
    try {
        const sess = await ort.InferenceSession.create(filePath, { executionProviders: ['cpu'] });
        for (const m of sess.inputMetadata) {
            console.log(`  IN ${m.name}: ${m.type} [${m.shape}]`);
        }
        for (const m of sess.outputMetadata) {
            console.log(`  OUT ${m.name}: ${m.type} [${m.shape}]`);
        }
        await sess.release();
        return true;
    } catch (e) {
        console.log('  ERROR:', e.message.split('\n')[0]);
        return false;
    }
}

async function tryInfer(label, filePath, condDim, maskType) {
    console.log(`\n===== INFER TEST ${label} (condDim=${condDim}, maskType=${maskType}) =====`);
    try {
        const sess = await ort.InferenceSession.create(filePath, { executionProviders: ['cpu'] });
        const seqLen = 4;
        const feeds = {};
        for (const m of sess.inputMetadata) {
            if (m.name === 'xt_input' || m.name === 'x') {
                feeds[m.name] = new ort.Tensor('float32', new Float32Array(seqLen * 128), [1, seqLen, 128]);
            } else if (m.name === 't' || m.name === 'diffusion_step') {
                feeds[m.name] = new ort.Tensor('float32', new Float32Array([0.5]), [1]);
            } else if (m.name === 'cond') {
                feeds[m.name] = new ort.Tensor('float32', new Float32Array(seqLen * condDim), [1, seqLen, condDim]);
            } else if (m.name === 'xt_mask' || m.name === 'x_mask') {
                if (m.type === 'bool') {
                    const data = new Uint8Array(seqLen).fill(1);
                    feeds[m.name] = new ort.Tensor('bool', data, [1, seqLen]);
                } else {
                    feeds[m.name] = new ort.Tensor('float32', new Float32Array(seqLen).fill(1), [1, seqLen]);
                }
            }
        }
        const t0 = Date.now();
        const outs = await sess.run(feeds);
        const out = outs[sess.outputNames[0]];
        console.log(`  OK in ${Date.now() - t0}ms, out=${out.type} [${out.dims}]`);
        // 统计输出数值范围
        const d = out.data;
        let mn = Infinity, mx = -Infinity, nan = 0;
        for (let i = 0; i < d.length; i++) {
            const v = d[i];
            if (typeof v === 'number') { if (Number.isNaN(v)) nan++; else { if (v < mn) mn = v; if (v > mx) mx = v; } }
        }
        console.log(`  stats: min=${mn}, max=${mx}, nan=${nan}`);
        await sess.release();
        return true;
    } catch (e) {
        console.log('  ERROR:', e.message.split('\n')[0]);
        return false;
    }
}

(async () => {
    const int8 = 'd:/Document/electron/SXSEditor/onnx_models/int8';
    // 1. 根目录 FP32 模型（若存在）
    const rootModels = ['d:/Document/electron/SXSEditor/onnx_models/diff_step_dml.onnx',
                        'd:/Document/electron/SXSEditor/onnx_models/diff_step.onnx',
                        'd:/Document/electron/SXSEditor/onnx_models/fp16/diff_step_dml.onnx'];
    for (const p of rootModels) {
        await inspect(path.basename(p), p);
    }

    // 2. 旧 int8 模型用 pipeline 实际喂的 1024 cond 测试
    const oldInt8 = path.join(int8, 'diff_step_dml.onnx');
    await tryInfer('OLD int8 1024cond fp32mask', oldInt8, 1024, 'float32');
    // 3. 新 QDIT 模型用 1024 cond + bool mask 测试
    const newQdit = path.join(int8, 'diffstep.onnx');
    await tryInfer('NEW QDIT 1024cond boolmask', newQdit, 1024, 'bool');
    // 4. 新 QDIT 模型用 512 cond 测试（看是否内嵌 cond_emb）
    await tryInfer('NEW QDIT 512cond boolmask', newQdit, 512, 'bool');
})();
