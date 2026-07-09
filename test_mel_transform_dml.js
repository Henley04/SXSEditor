/**
 * Test mel_transform ONNX model on DML with float32 input
 */
const path = require('path');
const ort = require('onnxruntime-node');

const MODEL_PATH = path.join(__dirname, 'onnx_models', 'mel_transform.onnx');

async function main() {
    console.log('=== mel_transform DML Test ===');
    console.log(`Model: ${MODEL_PATH}`);

    const session = await ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: [{ name: 'dml', deviceId: 1 }, 'cpu'],
        enableMemPattern: false,
        executionMode: 'sequential',
    });

    console.log('Input metadata:', JSON.stringify(session.inputMetadata, null, 2));
    console.log('Output metadata:', JSON.stringify(session.outputMetadata, null, 2));

    const SAMPLE_RATE = 48000;
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];

    // Test with various sizes
    const testSizes = [24000, 48000, 96000, 192000];
    for (const size of testSizes) {
        const audio = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            audio[i] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5;
        }
        try {
            const result = await session.run({
                [inputName]: new ort.Tensor('float32', audio, [1, size]),
            });
            const mel = result[outputName].data;
            let nanCount = 0, infCount = 0, sum = 0, finCount = 0;
            for (let i = 0; i < mel.length; i++) {
                if (Number.isNaN(mel[i])) nanCount++;
                else if (!Number.isFinite(mel[i])) infCount++;
                else { sum += mel[i]; finCount++; }
            }
            const mean = finCount > 0 ? sum / finCount : NaN;
            const status = nanCount > 0 ? 'FAIL (NaN)' : 'OK';
            console.log(`  size=${size}: ${status} NaN=${nanCount}, Inf=${infCount}, total=${mel.length}, mean=${mean.toFixed(6)}`);
        } catch (err) {
            console.log(`  size=${size}: ERROR - ${err.message}`);
        }
    }

    session.release();
    console.log('Done');
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});