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

  // Vocoder type default + startup fallback:
  // If stored value is 'sifigan' but the model file is missing, temporarily fall
  // back to 'default' for this run (settings.json is NOT modified).
  if (typeof _settingsCache.vocoderType !== 'string') {
    _settingsCache.vocoderType = 'default';
  } else if (_settingsCache.vocoderType === 'sifigan') {
    try {
      const { getModelDir } = require('./modelDir');
      const modelDir = getModelDir();
      const sifiganOnnx = path.join(modelDir, 'sifigan_vocoder_dml.onnx');
      const sifiganFallback = path.join(modelDir, 'sifigan_vocoder.onnx');
      if (!fs.existsSync(sifiganOnnx) && !fs.existsSync(sifiganFallback)) {
        console.warn('[Main] vocoderType=sifigan but sifigan_vocoder_dml.onnx / sifigan_vocoder.onnx not found, falling back to default for this run');
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
  'npuDiffBatchSize', 'npuVocoderBatchSize',
  'vocoderType',
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
