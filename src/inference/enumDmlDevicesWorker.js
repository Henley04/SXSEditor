const ort = require('onnxruntime-node');
const path = require('path');

const modelPath = process.argv[2];
if (!modelPath) {
    process.send({ error: 'No model path provided' });
    process.exit(1);
}

function isDiscreteGPUByName(name) {
    const n = name.toLowerCase();
    if (n.includes('nvidia') || n.includes('geforce') || n.includes('rtx') || n.includes('gtx') || n.includes('quadro')) return true;
    if (n.includes('radeon rx') || n.includes('radeon pro') || n.includes('radeon instinct')) return true;
    if (n.includes('amd') && (n.includes('rx ') || n.includes('pro w') || n.includes('pro v'))) return true;
    if (n.includes('arc') && n.includes('intel')) return true;
    if (n.includes('intel') && (n.includes('uhd') || n.includes('iris') || n.includes('xe') || n.includes('hd graphics'))) return false;
    if (n.includes('radeon') && !n.includes('rx') && !n.includes('pro') && !n.includes('instinct')) return false;
    if (n.includes('microsoft') && n.includes('basic')) return false;
    return undefined;
}

async function enumerate() {
    // 注意：此方法通过劫持 process.stderr.write 来捕获 ONNX Runtime 的 verbose 日志输出
    // 这依赖 ONNX Runtime 的内部日志格式，版本更新后可能失效
    // 如果 ONNX Runtime 提供了枚举设备的 API，应优先使用
    const origWrite = process.stderr.write.bind(process.stderr);
    let stderrBuf = '';
    process.stderr.write = function(chunk, encoding, callback) {
        if (typeof chunk === 'string') stderrBuf += chunk;
        else if (Buffer.isBuffer(chunk)) stderrBuf += chunk.toString('utf-8');
        return origWrite(chunk, encoding, callback);
    };

    ort.env.logLevel = 'verbose';

    try {
        const session = await ort.InferenceSession.create(modelPath, {
            executionProviders: [{ name: 'dml', deviceId: 0 }, 'cpu']
        });
        session.release();
    } catch (_) {}

    await new Promise(r => setTimeout(r, 500));

    process.stderr.write = origWrite;
    ort.env.logLevel = 'warning';

    const devices = [];
    const lines = stderrBuf.split('\n');
    for (const line of lines) {
        if (!line.includes('Discovered OrtHardwareDevice')) continue;

        const descMatch = line.match(/Description=([^,\]]+)/);
        const typeMatch = line.match(/type:(\d+)/);
        const discreteMatch = line.match(/Discrete=(\d)/);
        const adapterMatch = line.match(/DxgiAdapterNumber=(\d+)/);
        const vramMatch = line.match(/DxgiVideoMemory=(\d+)\s*([MG]B)/);
        const vendorMatch = line.match(/vendor:([^,\]]+)/);

        if (!descMatch || !typeMatch) continue;

        const gpuName = descMatch[1].trim();
        const typeVal = parseInt(typeMatch[1]);

        const isDiscreteFromFlag = discreteMatch ? discreteMatch[1] === '1' : undefined;
        const isDiscreteFromName = isDiscreteGPUByName(gpuName);
        let isDiscrete;
        if (isDiscreteFromName !== undefined) {
            isDiscrete = isDiscreteFromName || (isDiscreteFromFlag === true);
        } else if (isDiscreteFromFlag !== undefined) {
            isDiscrete = isDiscreteFromFlag;
        } else {
            isDiscrete = false;
        }

        let vramStr = undefined;
        let vramBytes = 0;
        if (vramMatch) {
            const vramVal = parseInt(vramMatch[1]);
            const vramUnit = vramMatch[2];
            vramStr = `${vramVal} ${vramUnit}`;
            if (vramUnit === 'GB') vramBytes = vramVal * 1024 * 1024 * 1024;
            else if (vramUnit === 'MB') vramBytes = vramVal * 1024 * 1024;
        }

        if (typeVal !== 1) continue;

        devices.push({
            name: gpuName,
            type: typeVal,
            isDiscrete: isDiscrete,
            dxgiAdapterNumber: adapterMatch ? parseInt(adapterMatch[1]) : undefined,
            vram: vramStr,
            vramBytes: vramBytes,
            vendor: vendorMatch ? vendorMatch[1].trim() : '',
        });
    }

    process.send({ devices });
}

enumerate().catch(err => {
    process.send({ error: err.message });
});
