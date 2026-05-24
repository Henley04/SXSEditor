const ort = require('onnxruntime-node');
const path = require('path');

async function inspectModel(modelPath) {
  const sess = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });

  console.log('=== Model:', path.basename(modelPath), '===');
  console.log('Input names:', [...sess.inputNames]);
  console.log('Output names:', [...sess.outputNames]);
  console.log('Keys:', Object.keys(sess));

  // Try to get input/output details
  if (sess.inputNames) {
    for (const name of sess.inputNames) {
      try {
        const meta = sess.metadata;
        console.log(`Input meta for ${name}:`, meta);
      } catch(e) {}
    }
  }

  // The Split node expects exactly 4000 frames! The model has a fixed sequence length.
  // frameLen = 4000, wavLen = 4000 * 128 = 512000 samples (21.33s at 24kHz)
  // But wait - maybe the model uses hop_size=480, not 128
  // Let's try frameLen=4000 with different wav lengths

  const frameLen = 4000;
  const testWavLens = [
    4000 * 128,   // 512000 samples if hop=128
    4000 * 480,   // 1920000 samples if hop=480 (80s at 24kHz)
    24000 * 5,    // 5 seconds (README example)
    24000 * 10,   // 10 seconds
    24000 * 20,   // 20 seconds
  ];

  for (const wavLen of testWavLens) {
    const wav = new Float32Array(wavLen);
    const pitch = new BigInt64Array(frameLen);
    const uv = new BigInt64Array(frameLen);
    const word_bd = new BigInt64Array(frameLen);

    const feeds = {
      wav: new ort.Tensor('float32', wav, [1, wavLen]),
      pitch: new ort.Tensor('int64', pitch, [1, frameLen]),
      uv: new ort.Tensor('int64', uv, [1, frameLen]),
      word_bd: new ort.Tensor('int64', word_bd, [1, frameLen]),
    };

    try {
      console.log(`Trying wavLen=${wavLen}, frameLen=${frameLen}...`);
      const results = await sess.run(feeds);
      console.log(`  SUCCESS!`);
      for (const [name, tensor] of Object.entries(results)) {
        console.log(`  Output: ${name}, shape: [${tensor.dims}], type: ${tensor.type}, size: ${tensor.size}`);
        const data = tensor.data;
        const preview = Array.from(data.slice(0, 20));
        console.log(`  Preview: [${preview.join(', ')}]`);
      }
      break;
    } catch (e) {
      console.log(`  Failed: ${e.message.substring(0, 150)}`);
    }
  }
}

async function main() {
  try {
    await inspectModel(path.join(__dirname, 'onnx_models/preprocess/rosvot_model.onnx'));
  } catch (e) {
    console.error('rosvot_model error:', e.message);
  }

  try {
    await inspectModel(path.join(__dirname, 'onnx_models/preprocess/rosvot_mel.onnx'));
  } catch (e) {
    console.error('rosvot_mel error:', e.message);
  }
}

main();
