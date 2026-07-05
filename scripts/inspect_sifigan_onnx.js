// 快速检查 SiFiGAN ONNX 模型输入输出
const path = require('path');
const ort = require('onnxruntime-node');
const fs = require('fs');

async function main() {
    const file = path.join(__dirname, '..', 'onnx_models', 'sifigan_vocoder_dml.onnx');
    console.log('Loading:', file, 'exists:', fs.existsSync(file));
    const s = await ort.InferenceSession.create(file, { executionProviders: ['cpu'] });
    console.log('inputNames:', s.inputNames);
    console.log('outputNames:', s.outputNames);
    // 试 inputMetadata
    console.log('inputMetadata keys:', Object.keys(s.inputMetadata || {}));
    console.log('inputMetadata:', s.inputMetadata);
}
main().catch(e => { console.error(e); process.exit(1); });
