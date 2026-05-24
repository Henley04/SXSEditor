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
  // Test rosvot_mel model
  try {
    const melSess = await ort.InferenceSession.create(
      path.join(__dirname, 'onnx_models/preprocess/rosvot_mel.onnx'),
      { executionProviders: ['cpu'] }
    );
    console.log('=== rosvot_mel.onnx ===');
    console.log('Input names:', [...melSess.inputNames]);
    console.log('Output names:', [...melSess.outputNames]);

    // Test with audio input
    const wavLen = 512000;
    const wav = new Float32Array(wavLen);
    const feeds = { audio: new ort.Tensor('float32', wav, [1, wavLen]) };
    const results = await melSess.run(feeds);
    for (const [name, tensor] of Object.entries(results)) {
      console.log(`Output: ${name}, shape: [${tensor.dims}], type: ${tensor.type}, size: ${tensor.size}`);
    }
  } catch (e) {
    console.error('rosvot_mel error:', e.message);
  }

  // Test rosvot_model with actual pitch data
  try {
    const sess = await ort.InferenceSession.create(
      path.join(__dirname, 'onnx_models/preprocess/rosvot_model.onnx'),
      { executionProviders: ['cpu'] }
    );

    const frameLen = 4000;
    const wavLen = 512000;

    // Simulate some pitch data - a 440Hz tone (MIDI 69) for frames 500-1500
    const wav = new Float32Array(wavLen);
    const pitch = new BigInt64Array(frameLen);
    const uv = new BigInt64Array(frameLen);
    const word_bd = new BigInt64Array(frameLen);

    // Generate a sine wave at 440Hz for the middle portion
    for (let i = 0; i < wavLen; i++) {
      wav[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 24000);
    }

    // Pitch embedding table has 300 entries (0-299)
    // Try MIDI note number for 440Hz = 69
    // Also try with offset (e.g., MIDI + 1 or some other mapping)
    const midiPitch = 69; // A4 = 440Hz

    for (let i = 500; i < 1500; i++) {
      pitch[i] = BigInt(midiPitch);
      uv[i] = 0n; // voiced
    }
    // Unvoiced elsewhere
    for (let i = 0; i < 500; i++) {
      uv[i] = 1n;
    }
    for (let i = 1500; i < frameLen; i++) {
      uv[i] = 1n;
    }

    const feeds = {
      wav: new ort.Tensor('float32', wav, [1, wavLen]),
      pitch: new ort.Tensor('int64', pitch, [1, frameLen]),
      uv: new ort.Tensor('int64', uv, [1, frameLen]),
      word_bd: new ort.Tensor('int64', word_bd, [1, frameLen]),
    };

    console.log('\n=== Testing rosvot_model with sine wave ===');
    const results = await sess.run(feeds);
    for (const [name, tensor] of Object.entries(results)) {
      console.log(`Output: ${name}, shape: [${tensor.dims}], type: ${tensor.type}, size: ${tensor.size}`);
      const data = tensor.data;
      if (name === 'note_bd_pred') {
        // Find non-zero boundary predictions
        const boundaries = [];
        for (let i = 0; i < data.length; i++) {
          if (data[i] !== 0n && data[i] !== 0) boundaries.push(i);
        }
        console.log(`  Note boundaries at frames: [${boundaries.join(', ')}]`);
      } else if (name === 'note_pred') {
        const notes = Array.from(data);
        console.log(`  Note pitches: [${notes.join(', ')}]`);
      } else if (name === 'note_lengths') {
        console.log(`  Number of notes: ${data[0]}`);
      }
    }
  } catch (e) {
    console.error('rosvot_model test error:', e.message);
  }
}

main();
