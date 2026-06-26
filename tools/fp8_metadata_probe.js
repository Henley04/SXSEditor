// Probe the actual inputMetadata structure of onnxruntime-node 1.27
const path = require('node:path');
const ort = require('onnxruntime-node');

async function main() {
    const fp8Preflow = path.join(__dirname, '..', 'onnx_models', 'fp8', 'preflow.onnx');
    const fp16Preflow = path.join(__dirname, '..', 'onnx_models', 'fp16', 'preflow.onnx');

    for (const [label, p] of [['FP8 preflow', fp8Preflow], ['FP16 preflow', fp16Preflow]]) {
        console.log(`\n=== ${label}: ${p} ===`);
        const sess = await ort.InferenceSession.create(p, { executionProviders: ['cpu'] });
        console.log(`  inputNames:`, sess.inputNames);
        console.log(`  outputNames:`, sess.outputNames);
        console.log(`  inputMetadata keys:`, Object.keys(sess.inputMetadata));
        console.log(`  inputMetadata[0]:`, sess.inputMetadata[0]);
        console.log(`  inputMetadata[firstInput]:`, sess.inputMetadata[sess.inputNames[0]]);
        // Try array-style
        const arr = sess.inputMetadata;
        console.log(`  Array.isArray(inputMetadata):`, Array.isArray(arr));
        console.log(`  inputMetadata typeof:`, typeof arr);
        // Dump full structure
        console.log(`  JSON inputMetadata:`, JSON.stringify(arr, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2).substring(0, 800));
        sess.release();
    }
}

main().catch(e => { console.error(e); process.exit(1); });
