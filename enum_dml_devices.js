const ort = require('onnxruntime-node');
const path = require('path');

async function enumerateDMLDevices() {
    const modelPath = path.join(__dirname, 'onnx_models', 'note_text_encoder.onnx');
    
    // Capture stderr for verbose device discovery logs
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    let stderrBuf = '';
    const iconv = require('iconv-lite');
    process.stderr.write = function(chunk, encoding, callback) {
        if (typeof chunk === 'string') stderrBuf += chunk;
        else if (Buffer.isBuffer(chunk)) stderrBuf += iconv.decode(chunk, process.platform === 'win32' ? 'gbk' : 'utf-8');
        else stderrBuf += chunk.toString('utf-8');
        return origStderrWrite(chunk, encoding, callback);
    };

    ort.env.logLevel = 'verbose';
    
    try {
        const session = await ort.InferenceSession.create(modelPath, {
            executionProviders: [{ name: 'dml', deviceId: 0 }, 'cpu']
        });
        session.release();
    } catch (_) {}
    
    // Restore stderr
    process.stderr.write = origStderrWrite;
    ort.env.logLevel = 'warning';
    
    // Parse device discovery lines
    const devices = [];
    const lines = stderrBuf.split('\n');
    for (const line of lines) {
        const match = line.match(/Discovered OrtHardwareDevice \{vendor_id:(0x[\da-f]+), device_id:(0x[\da-f]+), vendor:(\w+), type:(\d+), metadata: \[Description=([^,]+)(?:, Discrete=(\d))?(?:, DxgiAdapterNumber=(\d+))?(?:, DxgiHighPerformanceIndex=(\d+))?(?:, DxgiVideoMemory=(\d+ [MG]B))?/);
        if (match) {
            const device = {
                vendorId: match[1],
                deviceId: match[2],
                vendor: match[3],
                type: parseInt(match[4]),
                name: match[5].trim(),
                discrete: match[6] === '1',
                dxgiAdapterNumber: match[7] !== undefined ? parseInt(match[7]) : undefined,
                dxgiHighPerformanceIndex: match[8] !== undefined ? parseInt(match[8]) : undefined,
                videoMemory: match[9] || undefined,
            };
            devices.push(device);
        }
    }
    
    console.log('=== DML 设备枚举结果 ===\n');
    for (const d of devices) {
        const typeStr = d.type === 0 ? 'CPU' : d.type === 1 ? 'GPU' : d.type === 2 ? 'NPU' : `Type${d.type}`;
        const vramStr = d.videoMemory ? ` (${d.videoMemory})` : '';
        const discreteStr = d.type === 1 ? (d.discrete ? ' [独显]' : ' [核显]') : '';
        const dxgiStr = d.dxgiAdapterNumber !== undefined ? ` deviceId=${d.dxgiAdapterNumber}` : '';
        console.log(`  ${d.name}${vramStr}${discreteStr} | ${typeStr}${dxgiStr} | ${d.vendor}`);
    }
    
    // Find best GPU (discrete > integrated, then by VRAM)
    const gpus = devices.filter(d => d.type === 1);
    if (gpus.length > 0) {
        const discrete = gpus.filter(d => d.discrete);
        const best = discrete.length > 0 ? discrete[0] : gpus[0];
        console.log(`\n推荐: ${best.name} (deviceId=${best.dxgiAdapterNumber})`);
    }
    
    return devices;
}

enumerateDMLDevices().catch(console.error);
