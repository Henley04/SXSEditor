const { parentPort } = require('node:worker_threads');

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

async function queryGPU() {
  const si = require('systeminformation');
  const graphics = await si.graphics();
  const controllers = graphics.controllers || [];
  return controllers.map((c, idx) => {
    const vramBytes = (c.memoryTotal || c.vram || 0) * 1024 * 1024;
    const deviceType = classifyDevice(c.model, vramBytes, undefined);
    return {
      adapterIndex: idx,
      model: c.model || '',
      vram: c.vram || 0,
      memoryTotal: c.memoryTotal || c.vram || 0,
      memoryUsed: c.memoryUsed || 0,
      vendor: c.vendor || '',
      deviceType,
      isDiscrete: deviceType === 'discrete-gpu',
    };
  });
}

queryGPU().then(result => {
  parentPort.postMessage({ success: true, data: result });
}).catch(err => {
  parentPort.postMessage({ success: false, error: err.message });
});
