const path = require('node:path');
const { Worker } = require('node:worker_threads');

// GPU 信息缓存（两阶segment(s)）
let _gpuInfoCache = null;      // 当前使用的完整数据
let _gpuInfoFast = null;        // WMI 快速数据（~400ms）
let _gpuInfoPending = null;     // 完整数据的 Promise
let _gpuPhase = 'none';         // 'none' | 'fast' | 'full'

// VRAM 使用量缓存
let _vramUsageCache = null;
let _vramUsageCacheTime = 0;
let _vramUsagePromise = null;
const VRAM_USAGE_TTL = 3000;

// NPU 检测缓存
let _npuCache = null;
let _npuPending = null;

/**
 * 统一设备分类函数 — 与 nativeSvsPipeline.js 中的 classifyDevice 保持同步
 */
function classifyDeviceFromName(name, vramBytes = 0, dmlDiscreteFlag = undefined) {
  const n = (name || '').toLowerCase();

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

  const integratedGpuKeywords = [
    { includes: ['intel', 'uhd'] }, { includes: ['intel', 'iris'] },
    { includes: ['intel', 'xe'] }, { includes: ['intel', 'hd graphics'] },
  ];
  for (const rule of integratedGpuKeywords) {
    if (rule.includes.every(kw => n.includes(kw))) return 'integrated-gpu';
  }
  if (n.includes('radeon') && !n.includes('rx') && !n.includes('pro') && !n.includes('instinct')) return 'integrated-gpu';
  if (n.includes('microsoft') && n.includes('basic')) return 'integrated-gpu';

  if (dmlDiscreteFlag === true) return 'discrete-gpu';
  if (dmlDiscreteFlag === false) return 'integrated-gpu';

  if (vramBytes > 0 && vramBytes >= 512 * 1024 * 1024) return 'discrete-gpu';
  if (vramBytes > 0) return 'integrated-gpu';

  return 'cpu';
}

/**
 * 启动 GPU 信息后台加载（两阶segment(s)：WMI 快速 → systeminformation 完整）
 */
function startGPUPreload() {
  _gpuInfoPending = new Promise((resolve) => {
    try {
      const worker = new Worker(path.join(__dirname, '..', 'utils', 'gpuWorker.js'));
      let settled = false;

      worker.on('message', (msg) => {
        if (msg.phase === 'fast' && msg.success && msg.data && msg.data.length > 0) {
          _gpuInfoFast = msg.data;
          _gpuPhase = 'fast';
          console.log(`[Main] GPU fast detection complete (WMI): ${msg.data.length}  device(s)`);
          // 不 resolve，继续等待完整数据
        } else if (msg.phase === 'full' && msg.success) {
          _gpuInfoCache = msg.data;
          _gpuPhase = 'full';
          console.log(`[Main] GPU fast detection complete (systeminformation): ${msg.data.length}  device(s)`);
          if (!settled) { settled = true; resolve(); }
        } else if (msg.phase === 'error') {
          console.warn('[Main] GPU detection failed:', msg.error);
          if (!settled) { settled = true; resolve(); }
        }
      });

      worker.once('error', (err) => {
        console.warn('[Main] GPU worker error:', err.message);
        if (!settled) { settled = true; resolve(); }
      });

      // 超时保护：15 秒后强制完成
      setTimeout(() => {
        if (!settled) {
           console.warn('[Main] GPU detection timeout, using fallback');
          settled = true;
          resolve();
        }
      }, 15000);
    } catch (e) {
      console.warn('[Main] GPU worker creation failed:', e.message);
      resolve();
    }
  });
}

/**
 * 获取 GPU 控制器信息（优先返回最完整的数据）
 * @param {boolean} waitComplete - 是否等待完整数据（默认 false，返回最快可用数据）
 */
async function ensureGPUInfo(waitComplete = false) {
  if (waitComplete) {
    // 等待完整 systeminformation 数据
    if (_gpuInfoCache) return _gpuInfoCache;
    if (_gpuInfoPending) {
      await _gpuInfoPending;
      return _gpuInfoCache || _gpuInfoFast || [];
    }
  }

  // 快速路径：已有完整数据
  if (_gpuInfoCache) return _gpuInfoCache;

  // 等待任意可用数据
  if (_gpuInfoPending) {
    await _gpuInfoPending;
    return _gpuInfoCache || _gpuInfoFast || [];
  }

  // 没有预加载，同步获取
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
    _gpuPhase = 'full';
  } catch (e) {
    _gpuInfoCache = [];
  }
  return _gpuInfoCache;
}

/**
 * 获取当前 GPU 检测阶segment(s)
 * @returns {'none' | 'fast' | 'full'}
 */
function getGPUPhase() {
  return _gpuPhase;
}

/**
 * 并行检测所有硬件（GPU + NPU）并返回结果
 * @returns {{ gpuControllers: Array, npuAvailable: boolean, npuDetails: string }}
 */
async function detectAllHardware() {
  const [gpuControllers, npuResult] = await Promise.all([
    ensureGPUInfo(),
    detectNPUCached(),
  ]);
  return {
    gpuControllers,
    npuAvailable: npuResult.npuAvailable,
    npuDetails: npuResult.details || '',
  };
}

/**
 * NPU 检测（带缓存）
 */
async function detectNPUCached() {
  if (_npuCache) return _npuCache;
  if (_npuPending) return _npuPending;

  _npuPending = (async () => {
    try {
      const { detectNPUAvailability } = require('./webnnIpc');
      const result = await detectNPUAvailability();
      _npuCache = result;
      return result;
    } catch (e) {
      return { npuAvailable: false, details: e.message };
    } finally {
      _npuPending = null;
    }
  })();

  return _npuPending;
}

/**
 * 使 GPU 信息缓存失效
 */
function invalidateGPUCache() {
  _gpuInfoCache = null;
  _gpuInfoFast = null;
  _gpuPhase = 'none';
  _npuCache = null;
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
      console.warn('[Main] GPU info fetch failed:', e.message);
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
  getGPUPhase,
  detectAllHardware,
  detectNPUCached,
  invalidateGPUCache,
  queryGPUVRAMUsage,
};
