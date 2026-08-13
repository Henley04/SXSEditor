const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { VOCODER_CHUNK_FRAMES } = require('../inference/shared/constants.js');
const { classifyDevice } = require('../utils/deviceClassifier');

// Backward-compatible alias: gpuInfo historically exposed classifyDeviceFromName
const classifyDeviceFromName = classifyDevice;

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
// 缓存按 (precision, vocoderType) 独立存储：
//   - 不同精度的常驻权重差异巨大（FP32≈2.9GB vs INT8≈0.96GB），可用显存余量不同
//   - SiFiGAN 模型体积远小于 default vocoder（fp16: 23MB vs 519MB），
//     虽然 SiFiGAN 内部有 4× mel 上采样，但模型本身占用与激活工作区远小于 default，
//     因此 SiFiGAN 可用更长的分片。按 vocoderType 独立预算常驻权重与分片档位。
const _vocoderChunkFramesCache = {};
const MIN_VOCODER_CHUNK_FRAMES = 256;
const MAX_VOCODER_CHUNK_FRAMES = 2048;
// SiFiGAN 与 default 共用同一 user-visible 帧数范围 [256, 2048]。
// 旧版将 SiFiGAN 上限除以 4（基于"4× 上采样=4× 资源"的错误假设），
// 实测 SiFiGAN 模型仅 23MB（fp16），整体资源占用远低于 default vocoder（519MB），
// 无需缩减上限。

// 各精度下常驻 GPU 显存的模型权重估算（MB），按 vocoderType 分别列出。
// 包含 diff_step + vocoder + 6 个 encoder/辅助模型，数据来自 onnx_models/{precision}/README.md。
// 注意：diff_step 在 vocoder 推理阶段不释放（_synthesizeSegment 连续执行 diffusion → vocoder），
// 因此 vocoder 单片峰值显存 = 常驻权重 + diff_step 激活 + vocoder 激活工作区 + OS 占用，
// 必须从 VRAM 中扣除前三项后再分配 vocoder 分片。
// SiFiGAN 模型体积远小于 default vocoder（fp16: 23MB vs 519MB），
// 因此 SiFiGAN 路径的常驻权重显著降低，可用显存余量更大。
const RESIDENT_WEIGHT_MB = {
  default: {
    'fp32':     2906,  // 1772 + 1054 + ~80
    'fp16':     1446,  // 887  + 519  + ~40
    'int8':      960,  // 445  + 485  + ~30
    'int8-npu':  960,  // 同 int8
  },
  sifigan: {
    'fp32':     2463,  // 1772 + 611 + ~80  (sifigan fp32 ≈ 611MB)
    'fp16':      950,  // 887  + 23  + ~40  (sifigan fp16 ≈ 23MB)
    'int8':      498,  // 445  + 23  + ~30
    'int8-npu':  498,  // 同 int8
  },
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

// 音频采样率与帧hop，用于估算分片时长（与 constants.js 保持一致，此处独立定义避免循环依赖）
const AUDIO_SAMPLE_RATE = 24000;
const AUDIO_HOP_SIZE = 480;

// 常见显存档位（GB），用于 UI 对照表展示。
// 覆盖从核显（2GB）到旗舰独显（24GB）的典型配置，
// 让用户能直观看到不同显存下的推荐分片，而不只是当前显卡的单条结果。
const VRAM_TIERS_GB = [2, 3, 4, 6, 8, 10, 12, 16, 20, 24];

/**
 * 依据显存大小（字节）、模型精度、vocoder 类型计算推荐的 vocoder 分片帧数（user-visible）。
 *
 * 预算公式：available = (VRAM - 常驻权重 - diff_step 激活 - OS 占用) × 安全系数
 *   - 常驻权重 RESIDENT_WEIGHT_MB：按 (vocoderType, precision) 查表
 *     default: FP32≈2.9GB / FP16≈1.4GB / INT8≈0.96GB
 *     sifigan: FP32≈2.5GB / FP16≈0.95GB / INT8≈0.5GB（vocoder 部分仅 23MB）
 *   - diff_step 激活 DIFFSTEP_ACTIVATION_MB：~2GB，与精度无关（diffusion 32 步激活工作区）
 *   - OS 占用 GPU_OS_RESERVE_MB：~1GB，DWM/浏览器/OS/DML 命令队列
 *   - 安全系数 VRAM_SAFETY_FACTOR=0.7：再预留 30% 给碎片化/多 segment 串行等
 *
 * default vocoder 与 SiFiGAN 使用各自独立的分档表：
 *   - default vocoder 模型体积大（fp16: 519MB）、激活工作区大，采用更保守的档位
 *     （8GB fp16 → 约 2.5GB 预算 → 1024 帧 ≈ 20.5s）
 *   - SiFiGAN 模型体积小（fp16: 23MB），虽有 4× mel 上采样但整体资源占用远低于 default，
 *     采用更宽松的档位（8GB fp16 → 约 2.85GB 预算 → 1280 帧 ≈ 25.6s）
 */
function computeVocoderChunkFramesFromVRAM(vramBytes, precision = DEFAULT_RESIDENT_PRECISION, vocoderType = 'default') {
  const isSifigan = vocoderType === 'sifigan';
  if (!vramBytes || vramBytes <= 0) {
    // 未知显存 → 默认值（SiFiGAN 不再除以 4，使用 VOCODER_CHUNK_FRAMES）
    return Math.round(VOCODER_CHUNK_FRAMES / 8) * 8;
  }
  const weightTable = isSifigan ? RESIDENT_WEIGHT_MB.sifigan : RESIDENT_WEIGHT_MB.default;
  const residentMb = weightTable[precision] || weightTable[DEFAULT_RESIDENT_PRECISION];
  const residentBytes = residentMb * 1024 * 1024;
  const diffstepBytes = DIFFSTEP_ACTIVATION_MB * 1024 * 1024;
  const osReserveBytes = GPU_OS_RESERVE_MB * 1024 * 1024;
  // 预算 = (VRAM - 常驻权重 - diff_step 激活 - OS 占用) × 安全系数
  const availableBytes = (vramBytes - residentBytes - diffstepBytes - osReserveBytes) * VRAM_SAFETY_FACTOR;
  // 常驻 + diff_step + OS 已超 VRAM：仅给最小片，避免加载阶段就 OOM
  if (availableBytes <= 0) {
    return MIN_VOCODER_CHUNK_FRAMES;
  }
  const availGb = availableBytes / (1024 * 1024 * 1024);
  let frames;
  // 分档基于"可用预算"（已扣除常驻权重 + diff_step 激活 + OS 占用 + 安全系数）。
  // 8GB 为基准点：default→1024帧(≈20.5s)，SiFiGAN→1280帧(≈25.6s)。
  // 更小显存按比例缩减，更大显存按比例增加。
  if (!isSifigan) {
    if (availGb < 0.5) frames = 512;        // 极紧张：~10.2s
    else if (availGb < 1.0) frames = 640;    // 紧张：~12.8s
    else if (availGb < 1.5) frames = 768;    // 一般偏紧：~15.4s
    else if (availGb < 2.0) frames = 896;    // 一般：~17.9s
    else if (availGb < 3.0) frames = 1024;   // 8GB fp16 落点：~20.5s
    else if (availGb < 4.0) frames = 1280;   // 宽裕：~25.6s
    else if (availGb < 5.0) frames = 1536;   // 很宽裕：~30.7s
    else frames = 2048;                       // 极宽裕：~40.9s
  } else {
    // SiFiGAN：宽松档位，模型仅 23MB（fp16），激活工作区远小于 default vocoder
    //   8GB fp16（预算≈2.85GB）→ 1280 帧 ≈ 25.6s
    //   旧版错误地除以 4（仅 192 帧 ≈ 3.8s），导致分片过多、拼接开销大
    if (availGb < 0.5) frames = 512;         // 极紧张
    else if (availGb < 1.0) frames = 768;     // 紧张：~15.4s
    else if (availGb < 2.0) frames = 1024;    // 一般：~20.5s
    else if (availGb < 3.0) frames = 1280;    // 8GB fp16 落点：~25.6s
    else if (availGb < 4.0) frames = 1536;    // 宽裕：~30.7s
    else if (availGb < 5.0) frames = 1792;    // 很宽裕：~35.8s
    else frames = 2048;                        // 极宽裕：~40.9s
  }
  frames = Math.max(MIN_VOCODER_CHUNK_FRAMES, Math.min(MAX_VOCODER_CHUNK_FRAMES, frames));
  frames = Math.round(frames / 8) * 8;
  return frames;
}

/**
 * 从已缓存的 GPU 控制器中选取最大显存并计算 vocoder 分片帧数。
 * 懒计算：首次调用时若缓存为空且 _gpuInfoCache 可用则填充，之后直接复用。
 * 缓存按 (precision, vocoderType) 独立存储（键 `${precision}:${vocoderType}`），
 * 同一显卡在不同精度/vocoder 类型下会得到不同的分片帧数。
 * @param {string} [precision] - 模型精度（fp32/fp16/int8/int8-npu），缺省时按 fp16 保守估算
 * @param {string} [vocoderType] - vocoder 类型（'default' | 'sifigan'）
 */
function getCachedVocoderChunkFrames(precision = DEFAULT_RESIDENT_PRECISION, vocoderType = 'default') {
  const cacheKey = `${precision}:${vocoderType}`;
  if (_vocoderChunkFramesCache[cacheKey] != null) {
    return _vocoderChunkFramesCache[cacheKey];
  }
  if (!_gpuInfoCache) {
    // GPU 未检测完成时：返回默认值（SiFiGAN 不再除以 4）
    return VOCODER_CHUNK_FRAMES;
  }
  let bestVramBytes = 0;
  for (const c of _gpuInfoCache) {
    const vramBytes = ((c && (c.memoryTotal || c.vram)) || 0) * 1024 * 1024;
    if (vramBytes > bestVramBytes) bestVramBytes = vramBytes;
  }
  const frames = computeVocoderChunkFramesFromVRAM(bestVramBytes, precision, vocoderType);
  _vocoderChunkFramesCache[cacheKey] = frames;
  const weightTable = vocoderType === 'sifigan' ? RESIDENT_WEIGHT_MB.sifigan : RESIDENT_WEIGHT_MB.default;
  const residentMb = weightTable[precision] || weightTable[DEFAULT_RESIDENT_PRECISION];
  const budgetMb = Math.max(0, (bestVramBytes / (1024 * 1024)) - residentMb - DIFFSTEP_ACTIVATION_MB - GPU_OS_RESERVE_MB) * VRAM_SAFETY_FACTOR;
  console.log(`[Main] Vocoder chunk frames from VRAM: ${frames} (precision=${precision}, vocoderType=${vocoderType}, bestVram=${(bestVramBytes / (1024 * 1024 * 1024)).toFixed(2)}GB, resident=${residentMb}MB, diffstep=${DIFFSTEP_ACTIVATION_MB}MB, osReserve=${GPU_OS_RESERVE_MB}MB, safetyFactor=${VRAM_SAFETY_FACTOR}, budget=${budgetMb.toFixed(0)}MB)`);
  return frames;
}

/**
 * 获取生效的 vocoder 分片帧数（user-visible）。
 * @param {'smart'|'manual'} mode - 分片分配模式
 * @param {number} manualFrames - manual 模式下用户指定的帧数
 * @param {string} [precision] - 模型精度（仅 smart 模式生效，用于按精度扣除常驻权重）
 * @param {string} [vocoderType] - vocoder 类型（'default' | 'sifigan'）
 *   - smart 模式：按 vocoderType 使用各自独立的分档表与常驻权重
 *   - manual 模式：用户输入值 clamp 到 [256, 2048]（default 与 sifigan 共用同一范围）
 */
function getEffectiveVocoderChunkFrames(mode, manualFrames, precision, vocoderType = 'default') {
  if (mode === 'manual') {
    const v = parseInt(manualFrames);
    if (Number.isFinite(v) && v > 0) {
      return Math.max(MIN_VOCODER_CHUNK_FRAMES, Math.min(MAX_VOCODER_CHUNK_FRAMES, v));
    }
  }
  return getCachedVocoderChunkFrames(precision, vocoderType);
}

/**
 * 返回 vocoder 分片信息（供设置页 UI 显示智能分配结果）。
 * GPU 检测完成前 smartFrames 为默认值，gpuPhase='none'；完成后返回实际计算值。
 * @param {string} [precision] - 模型精度，用于按精度计算 smartFrames
 * @param {string} [vocoderType] - vocoder 类型（'default' | 'sifigan'），SiFiGAN 模式下返回的 smartFrames 已除以上采样倍率
 * @returns {{ gpuPhase: string, smartFrames: number, bestVramBytes: number, bestGpuName: string|null }}
 */
function getVocoderChunkFramesInfo(precision, vocoderType = 'default') {
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
    smartFrames: getCachedVocoderChunkFrames(precision, vocoderType),
    bestVramBytes,
    bestGpuName,
  };
}

/**
 * 返回不同显存档位下的 vocoder 分片帧数对照表（供设置页 UI 展示）。
 *
 * 以 8GB 为基准点，向下扩展到核显（2GB）、向上扩展到旗舰独显（24GB）。
 * 对照表覆盖 VRAM_TIERS_GB 中所有档位，每行包含：
 *   - tierGb：显存大小（GB）
 *   - frames：推荐分片帧数（已对齐到 8 的倍数）
 *   - budgetGb：可用预算（GB），即 (VRAM - 常驻 - diff_step - OS) × 安全系数
 *   - approxSeconds：分片对应音频时长（秒），= frames × HOP_SIZE / SAMPLE_RATE
 *
 * 当 precision / vocoderType 变化时，常驻权重不同，budget 与 frames 会动态变化，
 * 设置页在切换精度或 vocoder 类型时应重新调用此函数刷新对照表。
 *
 * @param {string} [precision] - 模型精度（fp32/fp16/int8/int8-npu），缺省按 fp16
 * @param {string} [vocoderType] - vocoder 类型（'default' | 'sifigan'）
 * @returns {{ tierGb: number, frames: number, budgetGb: number, approxSeconds: number }[]}
 */
function getVocoderChunkFramesTable(precision = DEFAULT_RESIDENT_PRECISION, vocoderType = 'default') {
  const isSifigan = vocoderType === 'sifigan';
  const weightTable = isSifigan ? RESIDENT_WEIGHT_MB.sifigan : RESIDENT_WEIGHT_MB.default;
  const residentMb = weightTable[precision] || weightTable[DEFAULT_RESIDENT_PRECISION];
  const residentBytes = residentMb * 1024 * 1024;
  const diffstepBytes = DIFFSTEP_ACTIVATION_MB * 1024 * 1024;
  const osReserveBytes = GPU_OS_RESERVE_MB * 1024 * 1024;
  return VRAM_TIERS_GB.map((gb) => {
    const vramBytes = gb * 1024 * 1024 * 1024;
    const frames = computeVocoderChunkFramesFromVRAM(vramBytes, precision, vocoderType);
    const budgetBytes = (vramBytes - residentBytes - diffstepBytes - osReserveBytes) * VRAM_SAFETY_FACTOR;
    const budgetGb = Math.max(0, budgetBytes / (1024 * 1024 * 1024));
    const approxSeconds = (frames * AUDIO_HOP_SIZE) / AUDIO_SAMPLE_RATE;
    return { tierGb: gb, frames, budgetGb, approxSeconds };
  });
}

/**
 * 启动 GPU 信息后台加载（两阶segment(s)：WMI 快速 → systeminformation 完整）
 */
function startGPUPreload() {
  _gpuInfoPending = new Promise((resolve) => {
    try {
      const worker = new Worker(path.join(__dirname, 'utils', 'gpuWorker.js'));
      let settled = false;
      // W8: ensure the worker thread is terminated in every exit path so a
      // hung systeminformation.graphics() call does not keep consuming
      // CPU/memory in the background after the promise has settled.
      const terminateWorker = () => {
        try { worker.terminate(); } catch (_) {}
      };

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
          if (!settled) { settled = true; terminateWorker(); resolve(); }
        } else if (msg.phase === 'error') {
          console.warn('[Main] GPU detection failed:', msg.error);
          if (!settled) { settled = true; terminateWorker(); resolve(); }
        }
      });

      worker.once('error', (err) => {
        console.warn('[Main] GPU worker error:', err.message);
        if (!settled) { settled = true; terminateWorker(); resolve(); }
      });

      // 超时保护：15 秒后强制完成
      setTimeout(() => {
        if (!settled) {
           console.warn('[Main] GPU detection timeout, using fallback');
          settled = true;
          terminateWorker();
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
  } catch (_e) {
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
  // 清空所有 (precision, vocoderType) 的分片缓存
  for (const k of Object.keys(_vocoderChunkFramesCache)) {
    delete _vocoderChunkFramesCache[k];
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
  getVocoderChunkFramesTable,
};
