const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { getLocale, setLocale } = require('./locale');

const DEFAULT_THEME = 'dark-aurora';
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

  // 推理提供者: 'ortnode' (默认, onnxruntime-node DirectML/CPU) | 'ortweb' (onnxruntime-web WebNN)
  if (_settingsCache.inferenceProvider !== 'ortweb' && _settingsCache.inferenceProvider !== 'ortnode') {
    _settingsCache.inferenceProvider = 'ortnode';
  }

  // SiFiGAN 精度: 'fp32' (默认, 全精度) | 'fp16' (低质量, cos≈0.95)
  // 仅在 vocoderType === 'sifigan' 时生效，控制加载 sifigan_vocoder_dml_fp16.onnx 还是 sifigan_vocoder_dml.onnx
  if (_settingsCache.sifiganPrecision !== 'fp16' && _settingsCache.sifiganPrecision !== 'fp32') {
    _settingsCache.sifiganPrecision = 'fp32';
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

  return _settingsCache;
}

async function saveSettingsFile(settings) {
  try {
    const filePath = getSettingsFilePath();
    await fs.promises.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf-8');
    _settingsCache = null;
  } catch (err) {
    console.error('[Main] Failed to save settings:', err);
  }
}

function invalidateSettingsCache() {
  _settingsCache = null;
}

const ALLOWED_SETTINGS_KEYS = [
  'deviceId', 'modelDir', 'modelPrecision', 'midiExtractTool', 'useRosvot',
  'previewDiffSteps', 'previewCfgStrength', 'previewCfgRescale',
  'exportDiffSteps', 'exportCfgStrength', 'exportCfgRescale',
  'audioOutputMode', 'audioOutputDevice', 'audioSampleRate', 'audioBitDepth',
  'audioBufferSize', 'audioVolume', 'locale',
  'theme', 'themePerWindow',
  'deviceMode', 'preferredDeviceId', 'preferredDeviceType', 'modelDeviceMapping',
  'vocoderType', 'sifiganPrecision',
  'vocoderChunkMode', 'vocoderChunkFrames',
  'releaseDmlVramAfterSynthesis',
  'inferenceProvider',
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
