const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { getLocale, setLocale } = require('./locale');

const DEFAULT_THEME = 'acg';
const DEFAULT_THEME_PER_WINDOW = {};

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
    _settingsCache.vocoderChunkFrames = 1008;
  }

  // 合成完成后是否释放并重建重型 DML session，强制回收 DirectML 内存池（默认关闭，仅 DML 后端有效）
  if (typeof _settingsCache.releaseDmlVramAfterSynthesis !== 'boolean') {
    _settingsCache.releaseDmlVramAfterSynthesis = false;
  }

  // Vocoder 推理前是否临时释放 diffStep session（默认开启，仅 DML 后端有效）
  // diffStep 模型权重 + 32 步 diffusion 激活工作区（~2GB）在 vocoder 推理期间仍占用显存，
  // 与 vocoder 激活叠加易触发 DXGI_ERROR_DEVICE_REMOVED (0x887A0006) / TDR (屏幕全黑)。
  // 开启后：diffusion 完成 → 释放 diffStep → vocoder 推理 → 重载 diffStep。
  // 代价：每次 vocoder 推理后需重载 diffStep（~1-3秒），多 segment 合成会显著变慢。
  // WebNN 路径无需此优化（diffStep 在渲染进程，vocoder 在主进程 DML，互不抢占显存）。
  if (typeof _settingsCache.releaseDiffStepBeforeVocoder !== 'boolean') {
    _settingsCache.releaseDiffStepBeforeVocoder = true;
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
  'audioOutputMode', 'audioOutputDevice', 'audioSampleRate', 'audioBitDepth',
  'audioBufferSize', 'audioVolume', 'locale',
  'theme', 'themePerWindow',
  'deviceMode', 'preferredDeviceId', 'preferredDeviceType', 'modelDeviceMapping',
  'vocoderType', 'sifiganPrecision', 'japaneseVocalization',
  'vocoderChunkMode', 'vocoderChunkFrames',
  'releaseDmlVramAfterSynthesis',
  'releaseDiffStepBeforeVocoder',
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
  DEFAULT_THEME,
  DEFAULT_THEME_PER_WINDOW,
};
