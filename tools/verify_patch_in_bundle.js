// Verify float16Patch works by loading the webpack bundle's patch code in a Node context
// that simulates the webpack environment.
const path = require('node:path');
const ort = require('onnxruntime-node');

// Simulate what the webpack bundle does:
// 1. The patch code uses `require` (which webpack leaves as native require in Node target)
// 2. Check if tensor-impl-type-mapping is in require.cache after loading ort

// Trigger tensor creation to load tensor-impl-type-mapping
try { new ort.Tensor('float16', new Uint16Array(1), [1]); } catch (_) {}

// Ensure onnxruntime-common is loaded
try { require('onnxruntime-common'); } catch (_) {}

// Search native require.cache
const cache = require.cache || {};
let found = false;
let patched = false;
for (const [key, mod] of Object.entries(cache)) {
    if (key.includes('onnxruntime-common') && key.includes('tensor-impl-type-mapping')) {
        found = true;
        const map = mod.exports?.NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP;
        if (map) {
            console.log('Before patch: float16 ->', map.get('float16')?.name);
            map.set('float16', Uint16Array);
            console.log('After patch:  float16 ->', map.get('float16')?.name);
            patched = true;
        } else {
            console.log('Module found but no NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP export');
            console.log('Exports:', Object.keys(mod.exports || {}));
        }
        break;
    }
}
console.log(`Module found: ${found}, patched: ${patched}`);

if (!found) {
    console.log('\nSearching all onnxruntime-common modules in cache:');
    for (const [key, mod] of Object.entries(cache)) {
        if (key.includes('onnxruntime-common')) {
            console.log(`  ${key.substring(key.lastIndexOf('onnxruntime-common'))} exports: [${Object.keys(mod.exports || {}).join(',')}]`);
        }
    }
}

// Now test: create a float16 tensor and run on DML
if (patched) {
    const { DUMMY_TEST_INPUTS_FP16 } = require('../src/inference/pipeline/modelLoader');
    const modelPath = path.join(__dirname, '..', 'onnx_models', 'fp8', 'preflow.onnx');
    (async () => {
        try {
            const sess = await ort.InferenceSession.create(modelPath, {
                executionProviders: [{ name: 'dml' }, 'cpu'],
            });
            await sess.run(DUMMY_TEST_INPUTS_FP16.preflow);
            console.log('\nDML run with FP8 preflow: OK (patch works!)');
            sess.release();
        } catch (e) {
            console.log('\nDML run with FP8 preflow FAILED:', e.message.substring(0, 150));
        }
    })();
}
