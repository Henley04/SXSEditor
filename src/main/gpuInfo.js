const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { VOCODER_CHUNK_FRAMES } = require('../inference/shared/constants.js');

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

// ===== Vocoder 分片长度（依据显存智能分配） =====
// 启动后依据检测结果计算一次，运行时不再重新探测硬件，直接复用此缓存。
// 缓存按精度独立存储：不同精度的常驻权重差异巨大（FP32≈2.9GB vs INT8≈0.96GB），
// 同一显卡在不同精度下可用显存余量不同，必须分别计算。
const _vocoderChunkFramesCacheByPrecision = {};
const MIN_VOCODER_CHUNK_FRAMES = 256;
const MAX_VOCODER_CHUNK_FRAMES = 2048;

// 各精度下常驻 GPU 显存的模型权重估算（MB）。
// 包含 diff_step + vocoder + 6 个 encoder/辅助模型，数据来自 onnx_models/{precision}/README.md。
// 注意：diff_step 在 vocoder 推理阶段不释放（_synthesizeSegment 连续执行 diffusion → vocoder），
// 因此 vocoder 单片峰值显存 = 常驻权重 + diff_step 激活 + vocoder 激活工作区 + OS 占用，
// 必须从 VRAM 中扣除前三项后再分配 vocoder 分片。
const RESIDENT_WEIGHT_MB = {
  'fp32':     2906,  // 1772 + 1054 + ~80
  'fp16':     1446,  // 887  + 519  + ~40
  'int8':      960,  // 445  + 485  + ~30
  'int8-npu':  960,  // 同 int8
};

// diff_step 推理阶段驻留的激活工作区估算（MB），与精度无关。
// _synthesizeSegment 中 diffusion（默认 32 步）→ vocoder 串行执行，
// diff_step session 在 vocoder 推理阶段未释放，其激活张量仍占显存。
// 经验值 ~2GB（基于 32 步 diffusion + 中等长度 segment 的实测峰值）。
// 旧版仅以 0.8 安全余量笼统覆盖，长音频合成 OOM 的根因之一就是
// 该 2GB 未显式扣除，导致 chunk 偏大触发 887A0006 / 全零输出。
const DIFFSTEP_ACTIVATION_MB = 2048;

// GPU 正常使用显存占用（MB）：Windows 桌面合成器 (DWM) / 浏览器 / OS / 其他应用 / DML 命令队列缓冲区。
// 旧版仅在 0.8 安全余量中隐含覆盖，对低端独显（4-6GB）不够保守，
// 现显式扣除 1GB 以避免与桌面渲染争用显存导致 887A0006。
const GPU_OS_RESERVE_MB = 1024;

// 安全系数：在已扣除常驻权重 + diff_step 激活 + OS 占用之后，
// 再预留 30% 给显存碎片化、多 segment 串行合成、DML 运行时缓冲等未计入开销。
// 旧版 0.8（20%）偏低，调整为 0.7（30%）以进一步降低 vocoder 激活峰值。
const VRAM_SAFETY_FACTOR = 0.7;

const DEFAULT_RESIDENT_PRECISION = 'fp16'; // 启动时精度未知，用 fp16 保守估算

/**
 * 依据显存大小（字节）与模型精度计算推荐的 vocoder 分片帧数。
 *
 * 预算公式：available = (VRAM - 常驻权重 - diff_step 激活 - OS 占用) × 安全系数
 *   - 常驻权重 RESIDENT_WEIGHT_MB：按精度查表（FP32≈2.9GB / FP16≈1.4GB / INT8≈0.96GB）
 *   - diff_step 激活 DIFFSTEP_ACTIVATION_MB：~2GB，与精度无关（diffusion 32 步激活工作区）
 *   - OS 占用 GPU_OS_RESERVE_MB：~1GB，DWM/浏览器/OS/DML 命令队列
 *   - 安全系数 VRAM_SAFETY_FACTOR=0.7：再预留 30% 给碎片化/多 segment 串行等
 *
 * 旧版仅扣除常驻权重并以 0.8 安全余量笼统覆盖 diff_step 激活 + OS 占用，
 * 在 4-6GB 低显存独显上经常触发 vocoder chunk 0 全零输出（887A0006 / VRAM exhaustion）。
 * 显式扣除这两项后，分档阈值相应下调以保证 vocoder 激活工作区峰值在预算内。
 *
 * 所有返回值对齐到 8 的倍数（与 VOCODER_OVERLAP_FRAMES 兼容）。
 */
function computeVocoderChunkFramesFromVRAM(vramBytes, precision = DEFAULT_RESIDENT_PRECISION) {
  if (!vramBytes || vramBytes <= 0) return VOCODER_CHUNK_FRAMES; // 未知显存 → 默认值
  const residentMb = RESIDENT_WEIGHT_MB[precision] || RESIDENT_WEIGHT_MB[DEFAULT_RESIDENT_PRECISION];
  const residentBytes = residentMb * 1024 * 1024;
  const diffstepBytes = DIFFSTEP_ACTIVATION_MB * 1024 * 1024;
  const osReserveBytes = GPU_OS_RESERVE_MB * 1024 * 1024;
  // 预算 = (VRAM - 常驻权重 - diff_step 激活 - OS 占用) × 安全系数
  const availableBytes = (vramBytes - residentBytes - diffstepBytes - osReserveBytes) * VRAM_SAFETY_FACTOR;
  // 常驻 + diff_step + OS 已超 VRAM：仅给最小片，避免加载阶段就 OOM
  if (availableBytes <= 0) return MIN_VOCODER_CHUNK_FRAMES;
  const availGb = availableBytes / (1024 * 1024 * 1024);
  let frames;
  // 分档基于"可用预算"（已扣除常驻权重 + diff_step 激活 + OS 占用 + 安全系数），
  // 阈值考虑 vocoder 激活工作区峰值随 seq_len 近似线性增长。
  // 较旧版整体下调一档（旧版 512→1008→1280 现 384→768→1008），更保守以避免 OOM。
  if (availGb < 0.5) frames = 256;       // 极紧张：常驻+diff_step+OS 几乎吃满，仅最小片
  else if (availGb < 1.0) frames = 384;   // 紧张：~7.7s
  else if (availGb < 2.0) frames = 512;   // 一般：~10.2s
  else if (availGb < 4.0) frames = 768;   // 宽裕：~15.4s
  else frames = 1008;                      // 很宽裕：~20.2s（与默认值一致，不再上调到 1280）
  frames = Math.round(frames / 8) * 8;
  return Math.max(MIN_VOCODER_CHUNK_FRAMES, Math.min(MAX_VOCODER_CHUNK_FRAMES, frames));
}

/**
 * 从已缓存的 GPU 控制器中选取最大显存并计算 vocoder 分片帧数。
 * 懒计算：首次调用时若缓存为空且 _gpuInfoCache 可用则填充，之后直接复用。
 * 缓存按精度独立存储（_vocoderChunkFramesCacheByPrecision[precision]），
 * 同一显卡在不同精度下会得到不同的分片帧数。
 * @param {string} [precision] - 模型精度（fp32/fp16/int8/int8-npu），缺省时按 fp16 保守估算
 */
function getCachedVocoderChunkFrames(precision = DEFAULT_RESIDENT_PRECISION) {
  if (_vocoderChunkFramesCacheByPrecision[precision] != null) {
    return _vocoderChunkFramesCacheByPrecision[precision];
  }
  if (!_gpuInfoCache) return VOCODER_CHUNK_FRAMES;
  let bestVramBytes = 0;
  for (const c of _gpuInfoCache) {
    const vramBytes = ((c && (c.memoryTotal || c.vram)) || 0) * 1024 * 1024;
    if (vramBytes > bestVramBytes) bestVramBytes = vramBytes;
  }
  const frames = computeVocoderChunkFramesFromVRAM(bestVramBytes, precision);
  _vocoderChunkFramesCacheByPrecision[precision] = frames;
  const residentMb = RESIDENT_WEIGHT_MB[precision] || RESIDENT_WEIGHT_MB[DEFAULT_RESIDENT_PRECISION];
  const budgetMb = Math.max(0, (bestVramBytes / (1024 * 1024)) - residentMb - DIFFSTEP_ACTIVATION_MB - GPU_OS_RESERVE_MB) * VRAM_SAFETY_FACTOR;
  console.log(`[Main] Vocoder chunk frames from VRAM: ${frames} (precision=${precision}, bestVram=${(bestVramBytes / (1024 * 1024 * 1024)).toFixed(2)}GB, resident=${residentMb}MB, diffstep=${DIFFSTEP_ACTIVATION_MB}MB, osReserve=${GPU_OS_RESERVE_MB}MB, safetyFactor=${VRAM_SAFETY_FACTOR}, budget=${budgetMb.toFixed(0)}MB)`);
  return frames;
}

/**
 * 获取生效的 vocoder 分片帧数。
 * @param {'smart'|'manual'} mode - 分片分配模式
 * @param {number} manualFrames - manual 模式下用户指定的帧数
 * @param {string} [precision] - 模型精度（仅 smart 模式生效，用于按精度扣除常驻权重）
 */
function getEffectiveVocoderChunkFrames(mode, manualFrames, precision) {
  if (mode === 'manual') {
    const v = parseInt(manualFrames);
    if (Number.isFinite(v) && v > 0) {
      return Math.max(MIN_VOCODER_CHUNK_FRAMES, Math.min(MAX_VOCODER_CHUNK_FRAMES, v));
    }
  }
  return getCachedVocoderChunkFrames(precision);
}

/**
 * 返回 vocoder 分片信息（供设置页 UI 显示智能分配结果）。
 * GPU 检测完成前 smartFrames 为默认值，gpuPhase='none'；完成后返回实际计算值。
 * @param {string} [precision] - 模型精度，用于按精度计算 smartFrames
 * @returns {{ gpuPhase: string, smartFrames: number, bestVramBytes: number, bestGpuName: string|null }}
 */
function getVocoderChunkFramesInfo(precision) {
  let bestVramBytes = 0;
  let bestGpuName = null;
  if (_gpuInfoCache && _gpuInfoCache.length > 0) {
    for (const c of _gpuInfoCache) {
      const vramBytes = ((c && (c.memoryTotal || c.vram)) || 0) * 1024 * 1024;
      if (vramBytes > bestVramBytes) {
        bestVramBytes = vramBytes;
        bestGpuName = c?.model || null;
      }
    }
  }
  return {
    gpuPhase: _gpuPhase,
    smartFrames: getCachedVocoderChunkFrames(precision),
    bestVramBytes,
    bestGpuName,
  };
}

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
      const worker = new Worker(path.join(__dirname, 'utils', 'gpuWorker.js'));
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
          console.log(`[Main] GPU full detection complete (systeminformation): ${msg.data.length}  device(s)`);
          // 依据显存预计算 vocoder 分片帧数（一次性，运行时复用）
          try { getCachedVocoderChunkFrames(); } catch (_) {}
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
    // 依据显存预计算 vocoder 分片帧数（一次性，运行时复用）
    try { getCachedVocoderChunkFrames(); } catch (_) {}
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
 * 使 GPU 信息缓存失效（不影响 NPU 缓存）
 */
function invalidateGPUCache() {
  _gpuInfoCache = null;
  _gpuInfoFast = null;
  _gpuPhase = 'none';
  // 清空所有精度的分片缓存（按精度独立存储）
  for (const k of Object.keys(_vocoderChunkFramesCacheByPrecision)) {
    delete _vocoderChunkFramesCacheByPrecision[k];
  }
}

/**
 * 使 NPU 检测缓存失效
 */
function invalidateNPUCache() {
  _npuCache = null;
  _npuPending = null;
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
  invalidateNPUCache,
  queryGPUVRAMUsage,
  computeVocoderChunkFramesFromVRAM,
  getCachedVocoderChunkFrames,
  getEffectiveVocoderChunkFrames,
  getVocoderChunkFramesInfo,
};
