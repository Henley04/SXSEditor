const path = require('node:path');
const { Worker } = require('node:worker_threads');

// GPU 信息后台缓存
let _gpuInfoCache = null;
let _gpuInfoPending = null;

let _vramUsageCache = null;
let _vramUsageCacheTime = 0;
let _vramUsagePromise = null;
const VRAM_USAGE_TTL = 3000;

/**
 * 统一设备分类函数 — 与 nativeSvsPipeline.js 中的 classifyDevice 保持同步
 * @param {string} name - 设备名称
 * @param {number} vramBytes - 显存大小（字节），0 表示未知
 * @param {boolean|undefined} dmlDiscreteFlag - DirectML 报告的 Discrete 标志
 * @returns {'discrete-gpu'|'integrated-gpu'|'npu'|'cpu'}
 */
function classifyDeviceFromName(name, vramBytes = 0, dmlDiscreteFlag = undefined) {
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

function startGPUPreload() {
  _gpuInfoPending = new Promise((resolve) => {
    try {
      const worker = new Worker(path.join(__dirname, '..', 'utils', 'gpuWorker.js'));
      worker.once('message', (msg) => {
        if (msg.success) {
          _gpuInfoCache = msg.data;
          console.log(`[Main] GPU 信息预加载完成: ${msg.data.length} 个设备`);
        } else {
          console.warn('[Main] GPU 信息预加载失败:', msg.error);
        }
        resolve();
      });
      worker.once('error', (err) => {
        console.warn('[Main] GPU worker 错误:', err.message);
        resolve();
      });
    } catch (e) {
      console.warn('[Main] GPU worker 启动失败:', e.message);
      resolve();
    }
  });
}

async function ensureGPUInfo() {
  if (_gpuInfoCache) return _gpuInfoCache;
  if (_gpuInfoPending) {
    await _gpuInfoPending;
    return _gpuInfoCache;
  }
  // 兜底：同步加载
  try {
    const si = require('systeminformation');
    const graphics = await si.graphics();
    const controllers = graphics.controllers || [];
    _gpuInfoCache = controllers.map((c, idx) => {
      const vramBytes = (c.memoryTotal || c.vram || 0) * 1024 * 1024;
      const deviceType = classifyDeviceFromName(c.model, vramBytes);
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
  } catch (e) {
    _gpuInfoCache = [];
  }
  return _gpuInfoCache;
}

async function queryGPUVRAMUsage() {
  const now = Date.now();
  if (_vramUsageCache && now - _vramUsageCacheTime < VRAM_USAGE_TTL) {
    return _vramUsageCache;
  }
  if (_vramUsagePromise) return _vramUsagePromise;

  _vramUsagePromise = (async () => {
    try {
      const si = require('systeminformation');
      const graphics = await si.graphics();
      const controllers = graphics.controllers || [];
      const result = controllers.map((c, idx) => ({
        adapterIndex: idx,
        name: c.model || '',
        totalBytes: (c.memoryTotal || c.vram || 0) * 1024 * 1024,
        usageBytes: (c.memoryUsed || 0) * 1024 * 1024,
        budgetBytes: (c.memoryTotal || c.vram || 0) * 1024 * 1024,
      }));
      _vramUsageCache = result;
      _vramUsageCacheTime = Date.now();
      return result;
    } catch (e) {
      console.warn('[Main] GPU 信息获取失败:', e.message);
      return [];
    } finally {
      _vramUsagePromise = null;
    }
  })();

  return _vramUsagePromise;
}

module.exports = {
  classifyDeviceFromName,
  startGPUPreload,
  ensureGPUInfo,
  queryGPUVRAMUsage,
};
