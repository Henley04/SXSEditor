const ort = require('onnxruntime-node');
const path = require('path');

const modelPath = process.argv[2];
if (!modelPath) {
    process.send({ error: 'No model path provided' });
    process.exit(1);
}

/**
 * 统一设备分类函数 — 与 nativeSvsPipeline.js 中的 classifyDevice 保持同步
 * @param {string} name - 设备名称
 * @param {number} vramBytes - 显存大小（字节），0 表示未知
 * @param {boolean|undefined} dmlDiscreteFlag - DirectML 报告的 Discrete 标志
 * @returns {'discrete-gpu'|'integrated-gpu'|'npu'|'cpu'}
 */
function classifyDevice(name, vramBytes = 0, dmlDiscreteFlag = undefined) {
    const n = (name || '').toLowerCase();

    // 1. NPU 名称匹配（最高优先级）
    const npuKeywords = [
        'npu', 'neural processing', 'neural compute',
        'intel ai boost', 'intel neural', 'intel npu',
        'amd xdna', 'amd ryzen ai', 'amd ai engine',
        'qualcomm hexagon', 'qcom npu', 'hexagon npu',
        'snapdragon neural', 'mediatek apu', 'rockchip npu',
    ];
    for (const kw of npuKeywords) {
        if (n.includes(kw)) return 'npu';
    }

    // 2. GPU 独显名称匹配
    const discreteGpuKeywords = [
        { includes: ['nvidia'] }, { includes: ['geforce'] },
        { includes: ['rtx'] }, { includes: ['gtx'] }, { includes: ['quadro'] },
        { includes: ['radeon', 'rx'] }, { includes: ['radeon', 'pro'] },
        { includes: ['radeon', 'instinct'] },
        { includes: ['amd', 'rx '] }, { includes: ['amd', 'pro w'] }, { includes: ['amd', 'pro v'] },
    ];
    for (const rule of discreteGpuKeywords) {
        if (rule.includes.every(kw => n.includes(kw))) return 'discrete-gpu';
    }
    if (n.includes('intel') && n.includes('arc') && /\barc\s*a\d/i.test(n)) return 'discrete-gpu';

    // 3. GPU 核显名称匹配
    const integratedGpuKeywords = [
        { includes: ['intel', 'uhd'] }, { includes: ['intel', 'iris'] },
        { includes: ['intel', 'xe'] }, { includes: ['intel', 'hd graphics'] },
    ];
    for (const rule of integratedGpuKeywords) {
        if (rule.includes.every(kw => n.includes(kw))) return 'integrated-gpu';
    }
    if (n.includes('radeon') && !n.includes('rx') && !n.includes('pro') && !n.includes('instinct')) return 'integrated-gpu';
    if (n.includes('microsoft') && n.includes('basic')) return 'integrated-gpu';

    // 4. DML Discrete 标志
    if (dmlDiscreteFlag === true) return 'discrete-gpu';
    if (dmlDiscreteFlag === false) return 'integrated-gpu';

    // 5. 显存阈值兜底（>= 512MB 视为独显）
    if (vramBytes > 0 && vramBytes >= 512 * 1024 * 1024) return 'discrete-gpu';
    if (vramBytes > 0) return 'integrated-gpu';

    return 'cpu';
}

async function enumerate() {
    // 注意：此方法通过劫持 process.stderr.write 来捕获 ONNX Runtime 的 verbose 日志输出
    // 这依赖 ONNX Runtime 的内部日志格式，版本更新后可能失效
    // 如果 ONNX Runtime 提供了枚举设备的 API，应优先使用
    const origWrite = process.stderr.write.bind(process.stderr);
    let stderrBuf = '';
    const iconv = require('iconv-lite');
    process.stderr.write = function(chunk, encoding, callback) {
        if (typeof chunk === 'string') stderrBuf += chunk;
        else if (Buffer.isBuffer(chunk)) stderrBuf += iconv.decode(chunk, process.platform === 'win32' ? 'gbk' : 'utf-8');
        return origWrite(chunk, encoding, callback);
    };

    ort.env.logLevel = 'verbose';

    try {
        try {
            const session = await ort.InferenceSession.create(modelPath, {
                executionProviders: [{ name: 'dml', deviceId: 0 }, 'cpu']
            });
            session.release();
        } catch (_) {}

        await new Promise(r => setTimeout(r, 500));
    } finally {
        process.stderr.write = origWrite;
        ort.env.logLevel = 'warning';
    }

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
        let vramStr = undefined;
        let vramBytes = 0;
        if (vramMatch) {
            const vramVal = parseInt(vramMatch[1]);
            const vramUnit = vramMatch[2];
            vramStr = `${vramVal} ${vramUnit}`;
            if (vramUnit === 'GB') vramBytes = vramVal * 1024 * 1024 * 1024;
            else if (vramUnit === 'MB') vramBytes = vramVal * 1024 * 1024;
        }

        const deviceType = classifyDevice(gpuName, vramBytes, isDiscreteFromFlag);

        devices.push({
            name: gpuName,
            type: typeVal,
            deviceType,
            isDiscrete: deviceType === 'discrete-gpu',
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
