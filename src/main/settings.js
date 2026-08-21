const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { setLocale } = require('./locale');

const DEFAULT_THEME = 'acg';
const DEFAULT_THEME_PER_WINDOW = {};


const ENUM_SETTINGS = {
  deviceMode: ['smart', 'manual', 'advanced'],
  inferenceProvider: ['ortnode', 'ortweb'],
  modelPrecision: ['fp32', 'fp16', 'int8', 'int8-npu'],
  midiExtractTool: ['fcpe', 'basicpitch', 'rmvpe'],
  audioOutputMode: ['shared', 'exclusive'],
  audioBitDepth: ['float32', 'int32', 'int24', 'int16'],
  vocoderType: ['default', 'sifigan'],
  sifiganPrecision: ['fp32', 'fp16'],
  japaneseVocalization: ['hybrid', 'en-phonemes', 'jp-lora'],
  vocoderChunkMode: ['smart', 'manual'],
  ortGraphOptLevel: ['disabled', 'basic', 'extended', 'all'],
  ortExecutionMode: ['sequential', 'parallel'],
  ortLogSeverityLevel: ['verbose', 'info', 'warning', 'error', 'fatal'],
  updateChannel: ['nightly', 'release'],
  fcpeThreshold: ['low', 'mid', 'high'],
  fcpeSmoothing: ['low', 'medium', 'high'],
  fcpeQuantization: ['strict', 'pitchbend'],
};

const NUMERIC_SETTINGS = {
  previewDiffSteps: [4, 64, 16], previewCfgStrength: [0, 10, 3], previewCfgRescale: [0, 1, 0.75],
  previewDiffStepChunkFrames: [100, 2000, 500], previewDiffStepOverlapFrames: [0, 200, 50],
  exportDiffSteps: [4, 64, 32], exportCfgStrength: [0, 10, 3], exportCfgRescale: [0, 1, 0.75], exportSampleRate: [24000, 96000, 48000],
  audioSampleRate: [8000, 192000, 48000], audioBufferSize: [64, 4096, 1024], audioVolume: [0, 1, 1],
  vocoderChunkFrames: [256, 4096, 1024], ortIntraOpNumThreads: [0, 64, 0], ortInterOpNumThreads: [0, 64, 0],
  npuDiffBatchSize: [1, 4, 1], npuVocoderBatchSize: [1, 4, 1],
  fcpeF0Min: [20, 2000, 80], fcpeF0Max: [20, 2000, 880],
  fcpeMinNoteDuration: [0.01, 1, 0.05], fcpeBpm: [40, 240, 120],
};

/** Normalize persisted and IPC-provided settings at the trust boundary. */
function normalizeSettings(settings) {
  const out = { ...(settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}) };
  for (const [key, allowed] of Object.entries(ENUM_SETTINGS)) {
    if (out[key] !== undefined && !allowed.includes(out[key])) delete out[key];
  }
  for (const [key, [min, max, fallback]] of Object.entries(NUMERIC_SETTINGS)) {
    if (out[key] === undefined) continue;
    const n = Number(out[key]);
    out[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }
  if (out.audioSampleRate !== undefined && ![22050, 24000, 44100, 48000, 96000, 192000].includes(out.audioSampleRate)) out.audioSampleRate = 48000;
  if (out.exportSampleRate !== undefined && ![24000, 44100, 48000, 96000].includes(out.exportSampleRate)) out.exportSampleRate = 48000;
  if (out.audioBufferSize !== undefined && ![64, 128, 256, 512, 1024, 2048, 4096].includes(out.audioBufferSize)) out.audioBufferSize = 1024;
  if (out.preferredDeviceId !== undefined && out.preferredDeviceId !== null && out.preferredDeviceId !== 'npu' && out.preferredDeviceId !== 'webnn-gpu' && !Number.isInteger(out.preferredDeviceId)) delete out.preferredDeviceId;
  if (out.modelDeviceMapping !== undefined && (typeof out.modelDeviceMapping !== 'object' || out.modelDeviceMapping === null || Array.isArray(out.modelDeviceMapping))) out.modelDeviceMapping = {};
  return out;
}

let _settingsCache = null;
let cachedDMLDevices = null;

function getSettingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function setCachedDMLDevices(devices) {
  cachedDMLDevices = devices;
}

function loadSettings() {
  if (_settingsCache) return _settingsCache;
  try {
    const filePath = getSettingsFilePath();
    if (fs.existsSync(filePath)) {
      _settingsCache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } else {
      _settingsCache = {};
    }
  } catch (err) {
    console.warn('[Main] Failed to load settings, using defaults:', err.message);
    _settingsCache = {};
  }
  if (!Number.isFinite(_settingsCache.audioSampleRate)) _settingsCache.audioSampleRate = 48000;
  if (![24000, 44100, 48000, 96000].includes(_settingsCache.exportSampleRate)) _settingsCache.exportSampleRate = 48000;

  // Merge defaults for theme fields
  if (typeof _settingsCache.theme !== 'string') {
    _settingsCache.theme = DEFAULT_THEME;
  }
  if (typeof _settingsCache.themePerWindow !== 'object' || _settingsCache.themePerWindow === null || Array.isArray(_settingsCache.themePerWindow)) {
    _settingsCache.themePerWindow = { ...DEFAULT_THEME_PER_WINDOW };
  }

  // Migration: removed contrast-onyx theme -> fall back to default
  if (_settingsCache.theme === 'contrast-onyx') {
    _settingsCache.theme = DEFAULT_THEME;
  }

  // Migration: old deviceId (number) -> deviceMode + preferredDeviceId + preferredDeviceType
  if (_settingsCache.deviceMode === undefined) {
    if (typeof _settingsCache.deviceId === 'number') {
      _settingsCache.deviceMode = 'manual';
      _settingsCache.preferredDeviceId = _settingsCache.deviceId;
      // Try to look up deviceType from cachedDMLDevices
      if (cachedDMLDevices) {
        const matched = cachedDMLDevices.find(d => d.dxgiAdapterNumber === _settingsCache.deviceId);
        if (matched && matched.deviceType) {
          _settingsCache.preferredDeviceType = matched.deviceType;
        }
      }
    } else {
      // deviceId is null/undefined and no deviceMode set
      _settingsCache.deviceMode = 'smart';
    }
  }

  // Vocoder 分片长度模式：'smart' 依据显存智能分配，'manual' 用户手动指定帧数
  if (_settingsCache.vocoderChunkMode !== 'manual') {
    _settingsCache.vocoderChunkMode = 'smart';
  }
  if (typeof _settingsCache.vocoderChunkFrames !== 'number' || !Number.isFinite(_settingsCache.vocoderChunkFrames) || _settingsCache.vocoderChunkFrames <= 0) {
    _settingsCache.vocoderChunkFrames = 1024;
  }

  // 合成完成后是否释放并重建重型 DML session，强制回收 DirectML 内存池（默认关闭，仅 DML 后端有效）
  if (typeof _settingsCache.releaseDmlVramAfterSynthesis !== 'boolean') {
    _settingsCache.releaseDmlVramAfterSynthesis = false;
  }

  // Vocoder 推理前是否临时释放 diffStep session（默认关闭，仅 DML 后端有效）
  // diffStep 模型权重 + 32 步 diffusion 激活工作区（~2GB）在 vocoder 推理期间仍占用显存，
  // 与 vocoder 激活叠加易触发 DXGI_ERROR_DEVICE_REMOVED (0x887A0006) / TDR (屏幕全黑)。
  // 开启后：diffusion 完成 → 释放 diffStep → vocoder 推理 → 重载 diffStep。
  // 代价：每次 vocoder 推理后需重载 diffStep（~1-3秒），多 segment 合成会变慢。
  // 默认 false：尊重用户显式选择。只有用户开启时，OOM 路径才允许释放并重试。
  // WebNN 路径无需此优化（diffStep 在渲染进程，vocoder 在主进程 DML，互不抢占显存）。
  if (typeof _settingsCache.releaseDiffStepBeforeVocoder !== 'boolean') {
    _settingsCache.releaseDiffStepBeforeVocoder = false;
  }

  // 诊断模式（默认关闭）。开启后输出 [DiffusionDiag] / [VocoderDiag] 统计/采样日志，
  // 用于排查 NaN/Inf / silent failure 等推理问题。NaN/Inf 致命错误（console.error）
  // 始终输出，不受此开关影响。
  if (typeof _settingsCache.diagnosticMode !== 'boolean') {
    _settingsCache.diagnosticMode = false;
  }

  // Vocoder 分块间重叠帧数（默认 32，范围 8-96）。重叠越大边界越平滑但计算量增加。
  // 与 shared/constants.js 的 VOCODER_OVERLAP_FRAMES 常量对齐（32 帧 ≈ 640ms 感受野）。
  // 用户可在 settings.json 覆盖；运行时由 pipeline/index.js 透传到 runVocoderChunked。
  if (!Number.isFinite(_settingsCache.vocoderOverlapFrames) ||
      _settingsCache.vocoderOverlapFrames < 8 || _settingsCache.vocoderOverlapFrames > 96) {
    _settingsCache.vocoderOverlapFrames = 32;
  }

  // 末端 EBU R128 响度归一化（−14 LUFS）+ true-peak 限制器（−1 dBTP）。
  // 默认开启，符合流媒体分发标准；关闭时仅保留旧的 normalizePeakTo(0.95) 行为。
  if (typeof _settingsCache.enableLoudnormFinal !== 'boolean') {
    _settingsCache.enableLoudnormFinal = true;
  }

  // resampleLinear 降采样前的 Butterworth 1st-order IIR 抗混叠低通滤波（截止 = dstSr/2）。
  // 默认关闭以保持默认输出特征不变；开启后可减少降采样混叠（以少量 CPU 开销为代价）。
  if (typeof _settingsCache.enableAntiAliasing !== 'boolean') {
    _settingsCache.enableAntiAliasing = false;
  }

  // SDEdit 局部修复（默认关闭）。检测 diffusion 输出 mel 局部 NaN/能量突变后用浅噪声重噪
  // + 少步重采样修复（STORK-2 5 步，仅更新异常帧）。默认 false 时不执行任何修复代码路径。
  if (typeof _settingsCache.enableSDEditRepair !== 'boolean') {
    _settingsCache.enableSDEditRepair = false;
  }

  // ===== Task 11: CFG 强度曲线调度 =====
  // 在 diffusion 采样循环中按 step 动态调整 CFG 引导强度。
  // mode: 'constant'（固定，与改造前字节一致）| 'linear'（线性）| 'cosine'（余弦）| 'custom'（关键帧）
  // cfgStrengthStart: null 时回退到 cfgStrength * 0.5（linear/cosine 从 0.5×cfg 上升到 cfg）
  // cfgScheduleKeyframes: null 或 [{step, value}, ...]（custom 模式分段线性插值）
  // 默认 'linear'：早期低 CFG 稳定结构，后期高 CFG 锐化细节。
  // 顶层键为通用默认；preview*/export* 镜像键分别覆盖预览/导出路径。
  const _validScheduleModes = ['constant', 'linear', 'cosine', 'custom'];
  if (!_validScheduleModes.includes(_settingsCache.cfgScheduleMode)) {
    _settingsCache.cfgScheduleMode = 'linear';
  }
  if (_settingsCache.cfgStrengthStart !== null && !Number.isFinite(_settingsCache.cfgStrengthStart)) {
    _settingsCache.cfgStrengthStart = null;
  }
  if (_settingsCache.cfgScheduleKeyframes !== null && !Array.isArray(_settingsCache.cfgScheduleKeyframes)) {
    _settingsCache.cfgScheduleKeyframes = null;
  }
  // 预览镜像键
  if (!_validScheduleModes.includes(_settingsCache.previewCfgScheduleMode)) {
    _settingsCache.previewCfgScheduleMode = 'linear';
  }
  if (_settingsCache.previewCfgStrengthStart !== null && !Number.isFinite(_settingsCache.previewCfgStrengthStart)) {
    _settingsCache.previewCfgStrengthStart = null;
  }
  if (_settingsCache.previewCfgScheduleKeyframes !== null && !Array.isArray(_settingsCache.previewCfgScheduleKeyframes)) {
    _settingsCache.previewCfgScheduleKeyframes = null;
  }
  // 导出镜像键
  if (!_validScheduleModes.includes(_settingsCache.exportCfgScheduleMode)) {
    _settingsCache.exportCfgScheduleMode = 'linear';
  }
  if (_settingsCache.exportCfgStrengthStart !== null && !Number.isFinite(_settingsCache.exportCfgStrengthStart)) {
    _settingsCache.exportCfgStrengthStart = null;
  }
  if (_settingsCache.exportCfgScheduleKeyframes !== null && !Array.isArray(_settingsCache.exportCfgScheduleKeyframes)) {
    _settingsCache.exportCfgScheduleKeyframes = null;
  }

  // ===== Dynamic Thresholding (arXiv:2507.08965) =====
  // Per-frame percentile clipping of CFG-predicted mel before rescale.
  // Prevents over-exposure artifacts at high CFG strengths.
  // previewDynamicThresholdEnabled / exportDynamicThresholdEnabled: boolean (default false)
  // previewDynamicThresholdPercentile / exportDynamicThresholdPercentile: 0.9–0.999 (default 0.995)
  if (typeof _settingsCache.previewDynamicThresholdPercentile !== 'number' ||
      !Number.isFinite(_settingsCache.previewDynamicThresholdPercentile) ||
      _settingsCache.previewDynamicThresholdPercentile < 0.9 ||
      _settingsCache.previewDynamicThresholdPercentile > 0.999) {
    _settingsCache.previewDynamicThresholdPercentile = 0.995;
  }
  if (typeof _settingsCache.exportDynamicThresholdPercentile !== 'number' ||
      !Number.isFinite(_settingsCache.exportDynamicThresholdPercentile) ||
      _settingsCache.exportDynamicThresholdPercentile < 0.9 ||
      _settingsCache.exportDynamicThresholdPercentile > 0.999) {
    _settingsCache.exportDynamicThresholdPercentile = 0.995;
  }

  // ===== 预览 diffStep 分块推理设置 =====
  // 预览时将 diffStep 的目标帧分块推理（每块独立运行完整扩散循环，再交叉淡入淡出拼接）。
  // 注意力复杂度 O(n²)，分块可显著加速长片段预览，代价是块边界可能产生轻微伪影。
  // 仅影响预览路径（getPreviewInferenceOptions 传入），导出始终使用整段推理。
  if (typeof _settingsCache.previewDiffStepChunkEnabled !== 'boolean') {
    _settingsCache.previewDiffStepChunkEnabled = false;
  }
  if (!Number.isFinite(_settingsCache.previewDiffStepChunkFrames) || _settingsCache.previewDiffStepChunkFrames < 100) {
    _settingsCache.previewDiffStepChunkFrames = 500;
  }
  if (!Number.isFinite(_settingsCache.previewDiffStepOverlapFrames) || _settingsCache.previewDiffStepOverlapFrames < 0) {
    _settingsCache.previewDiffStepOverlapFrames = 50;
  }

  // 推理提供者: 'ortnode' (默认, onnxruntime-node DirectML/CPU) | 'ortweb' (onnxruntime-web WebNN)
  if (_settingsCache.inferenceProvider !== 'ortweb' && _settingsCache.inferenceProvider !== 'ortnode') {
    _settingsCache.inferenceProvider = 'ortnode';
  }

  // ===== ONNX Runtime session 选项 =====
  // 这些选项在模型加载时（InferenceSession.create）生效，修改后需要重置 pipeline。
  // 详细说明在 settings.html 的 "ORT 高级设置" 区域。
  // 默认值策略见 src/inference/shared/ortOptions.js。

  // 是否启用内存模式优化（默认 true，ORT 官方默认值）。
  // DML 路径会单独受 ortForceMemPatternOnDml 控制。
  if (typeof _settingsCache.ortEnableMemPattern !== 'boolean') {
    _settingsCache.ortEnableMemPattern = true;
  }

  // 是否在 DML 执行提供者路径上启用 enableMemPattern（默认 false，高风险项）。
  // 原因：DML EP + memory pattern 会导致 DirectML 过度预分配 GPU 内存池，
  // 可能引发 OOM 或 TDR。仅在显存充裕且想测试 DML 路径下内存复用收益时开启。
  if (typeof _settingsCache.ortForceMemPatternOnDml !== 'boolean') {
    _settingsCache.ortForceMemPatternOnDml = false;
  }

  // 是否启用 CPU 内存池分配器（默认 true）
  if (typeof _settingsCache.ortEnableCpuMemArena !== 'boolean') {
    _settingsCache.ortEnableCpuMemArena = true;
  }

  // 图优化级别: 'disabled' | 'basic' | 'extended' | 'all'（默认 'all'）
  if (!['disabled', 'basic', 'extended', 'all'].includes(_settingsCache.ortGraphOptLevel)) {
    _settingsCache.ortGraphOptLevel = 'all';
  }

  // 执行模式: 'sequential' | 'parallel'（默认 'sequential'）
  if (_settingsCache.ortExecutionMode !== 'sequential' && _settingsCache.ortExecutionMode !== 'parallel') {
    _settingsCache.ortExecutionMode = 'sequential';
  }

  // 算子内并发线程数（CPU 路径有效；0 = 自动，由 ORT 决定）
  if (!Number.isFinite(_settingsCache.ortIntraOpNumThreads) || _settingsCache.ortIntraOpNumThreads < 0) {
    _settingsCache.ortIntraOpNumThreads = 0;
  }

  // 算子间并发线程数（CPU 路径有效；0 = 自动，由 ORT 决定）
  if (!Number.isFinite(_settingsCache.ortInterOpNumThreads) || _settingsCache.ortInterOpNumThreads < 0) {
    _settingsCache.ortInterOpNumThreads = 0;
  }

  // 日志严重级别: 'verbose' | 'info' | 'warning' | 'error' | 'fatal'（默认 'warning'）
  // 注意：开启 verbose 会显著影响推理性能（大量 IO），仅用于排查问题。
  if (!['verbose', 'info', 'warning', 'error', 'fatal'].includes(_settingsCache.ortLogSeverityLevel)) {
    _settingsCache.ortLogSeverityLevel = 'warning';
  }

  // SiFiGAN 精度: 'fp32' (默认, 全精度) | 'fp16' (低质量, cos≈0.95)
  // 仅在 vocoderType === 'sifigan' 时生效，控制加载 sifigan_vocoder_dml_fp16.onnx 还是 sifigan_vocoder_dml.onnx
  if (_settingsCache.sifiganPrecision !== 'fp16' && _settingsCache.sifiganPrecision !== 'fp32') {
    _settingsCache.sifiganPrecision = 'fp32';
  }

  // Japanese vocalization method: 'hybrid' (default, improved ARPAbet mapping:
  // L for ら行, AO for お段, on base model)
  // | 'en-phonemes' (English ARPAbet on base model, original mapping)
  // | 'jp-lora' (JP LoRA models, in development — not available for download yet)
  if (_settingsCache.japaneseVocalization !== 'en-phonemes' && _settingsCache.japaneseVocalization !== 'hybrid' && _settingsCache.japaneseVocalization !== 'jp-lora') {
    _settingsCache.japaneseVocalization = 'hybrid';
  }

  // Vocoder type default + startup fallback:
  // If stored value is 'sifigan' but none of the SiFiGAN model files exist,
  // temporarily fall back to 'default' for this run (settings.json is NOT modified).
  // Recognized SiFiGAN files (in priority order):
  //   sifigan_vocoder_dml_fp16.onnx (FP16, preferred)
  //   sifigan_vocoder_dml.onnx      (FP32 DML optimized)
  //   sifigan_vocoder.onnx          (FP32 plain)
  if (typeof _settingsCache.vocoderType !== 'string') {
    _settingsCache.vocoderType = 'default';
  } else if (_settingsCache.vocoderType === 'sifigan') {
    try {
      const { getModelDir } = require('./modelDir');
      const modelDir = getModelDir();
      const sifiganFp16Onnx = path.join(modelDir, 'sifigan_vocoder_dml_fp16.onnx');
      const sifiganOnnx = path.join(modelDir, 'sifigan_vocoder_dml.onnx');
      const sifiganFallback = path.join(modelDir, 'sifigan_vocoder.onnx');
      const hasAny = fs.existsSync(sifiganFp16Onnx)
                  || fs.existsSync(sifiganOnnx)
                  || fs.existsSync(sifiganFallback);
      if (!hasAny) {
        console.warn('[Main] vocoderType=sifigan but no SiFiGAN onnx file found, falling back to default for this run');
        _settingsCache.vocoderType = 'default';
      }
    } catch (err) {
      console.warn('[Main] Failed to detect SiFiGAN model files, falling back to default:', err.message);
      _settingsCache.vocoderType = 'default';
    }
  }

  // Update check settings
  if (_settingsCache.updateChannel !== 'nightly' && _settingsCache.updateChannel !== 'release') {
    _settingsCache.updateChannel = 'release';
  }
  if (typeof _settingsCache.autoCheckUpdates !== 'boolean') {
    _settingsCache.autoCheckUpdates = true;
  }
  if (typeof _settingsCache.skippedAppVersion !== 'string') {
    _settingsCache.skippedAppVersion = null;
  }
  if (typeof _settingsCache.dontRemindAppUpdates !== 'boolean') {
    _settingsCache.dontRemindAppUpdates = false;
  }
  if (typeof _settingsCache.lastUpdateCheckTime !== 'string') {
    _settingsCache.lastUpdateCheckTime = null;
  }

  _settingsCache = normalizeSettings(_settingsCache);
  return _settingsCache;
}

// W7: Atomic settings write. Writes to settings.json.tmp then renames it
// (atomic on the same filesystem) to settings.json, so a crash mid-write
// cannot leave a truncated/invalid JSON file that would lose all settings
// on next launch. On failure the cache is invalidated and an error result
// is returned so callers do not report a false success.
async function saveSettingsFile(settings) {
  const filePath = getSettingsFilePath();
  const tmpPath = `${filePath}.tmp`;
  try {
    const data = JSON.stringify(settings, null, 2);
    await fs.promises.writeFile(tmpPath, data, 'utf-8');
    try {
      await fs.promises.rename(tmpPath, filePath);
    } catch (renameErr) {
      // On Windows, rename may fail if the target exists; fall back to a
      // synchronous rename which POSIX-overwrites the target.
      try {
        fs.renameSync(tmpPath, filePath);
      } catch (_) {
        throw renameErr;
      }
    }
    _settingsCache = null;
    return { success: true };
  } catch (err) {
    console.error('[Main] Failed to save settings:', err);
    // Clean up the leftover temp file if it still exists.
    try { await fs.promises.unlink(tmpPath); } catch (_) {}
    invalidateSettingsCache();
    return { success: false, error: err.message };
  }
}

function invalidateSettingsCache() {
  _settingsCache = null;
}

const ALLOWED_SETTINGS_KEYS = [
  'deviceId', 'modelDir', 'modelPrecision', 'midiExtractTool', 'useRosvot',
  'previewDiffSteps', 'previewCfgStrength', 'previewCfgRescale', 'previewSampler',
  'previewDiffStepChunkEnabled', 'previewDiffStepChunkFrames', 'previewDiffStepOverlapFrames',
  'exportDiffSteps', 'exportCfgStrength', 'exportCfgRescale', 'exportSampler',
  'audioOutputMode', 'audioOutputDevice', 'audioSampleRate', 'audioBitDepth', 'exportSampleRate',
  'audioBufferSize', 'audioVolume', 'locale',
  'theme', 'themePerWindow',
  'deviceMode', 'preferredDeviceId', 'preferredDeviceType', 'modelDeviceMapping',
  'vocoderType', 'sifiganPrecision', 'japaneseVocalization',
  'vocoderChunkMode', 'vocoderChunkFrames',
  'releaseDmlVramAfterSynthesis',
  'releaseDiffStepBeforeVocoder',
  'diagnosticMode',
  'vocoderOverlapFrames',
  'enableLoudnormFinal',
  'enableAntiAliasing',
  'enableSDEditRepair',
  'cfgScheduleMode',
  'cfgStrengthStart',
  'cfgScheduleKeyframes',
  'previewCfgScheduleMode',
  'previewCfgStrengthStart',
  'previewCfgScheduleKeyframes',
  'exportCfgScheduleMode',
  'exportCfgStrengthStart',
  'exportCfgScheduleKeyframes',
  'previewDynamicThresholdEnabled',
  'previewDynamicThresholdPercentile',
  'exportDynamicThresholdEnabled',
  'exportDynamicThresholdPercentile',
  'inferenceProvider',
  'ortEnableMemPattern',
  'ortForceMemPatternOnDml',
  'ortEnableCpuMemArena',
  'ortGraphOptLevel',
  'ortExecutionMode',
  'ortIntraOpNumThreads',
  'ortInterOpNumThreads',
  'ortLogSeverityLevel',
  'npuDiffBatchSize',
  'npuVocoderBatchSize',
  'updateChannel',
  'autoCheckUpdates',
  'skippedAppVersion',
  'dontRemindAppUpdates',
  'lastUpdateCheckTime',
  // FCPE MIDI extraction parameters (global, used by all FCPE call sites)
  'fcpeThreshold', 'fcpeSmoothing', 'fcpeQuantization',
  'fcpeF0Min', 'fcpeF0Max', 'fcpeF0RangeAuto',
  'fcpeMinNoteDuration', 'fcpeAutoBpm', 'fcpeBpm', 'fcpeNormalize',
];

async function updateLocaleSetting(locale) {
  const mainLocales = require('./locale').getMainLocales();
  if (locale && mainLocales[locale]) {
    setLocale(locale);
    try {
      const configPath = path.join(app.getPath('userData'), 'sxseditor-locale.json');
      await fs.promises.writeFile(configPath, JSON.stringify({ locale }), 'utf8');
    } catch (_) {}
  }
}

module.exports = {
  loadSettings,
  saveSettingsFile,
  invalidateSettingsCache,
  setCachedDMLDevices,
  getSettingsFilePath,
  ALLOWED_SETTINGS_KEYS,
  updateLocaleSetting,
  normalizeSettings,
  DEFAULT_THEME,
  DEFAULT_THEME_PER_WINDOW,
};
