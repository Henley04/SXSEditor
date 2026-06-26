const { ipcMain, dialog } = require('electron');
const { loadSettings, saveSettingsFile, ALLOWED_SETTINGS_KEYS, updateLocaleSetting, invalidateSettingsCache } = require('./settings');
const { classifyDeviceFromName, ensureGPUInfo, getGPUPhase, detectAllHardware, detectNPUCached, invalidateGPUCache, invalidateNPUCache } = require('./gpuInfo');
const { getModelDir } = require('./modelDir');
const { enumerateDMLDevices } = require('../inference/pipeline');
const { getSvsPipeline, resetSvsPipeline } = require('./svsIpc');
const { resetRmvpe, resetBasicPitch, resetRosvot } = require('./pitchMidiIpc');
const { t } = require('./locale');

let cachedDMLDevices = null;

function setCachedDMLDevices(devices) {
  cachedDMLDevices = devices;
}

function getCachedDMLDevices() {
  return cachedDMLDevices;
}

function invalidateDMLDevices() {
  cachedDMLDevices = null;
}

function registerSettingsIpc() {
  // 硬件检测状态（供 UI 显示加载进度）
  ipcMain.handle('settings:getHardwareStatus', async () => {
    return {
      gpuPhase: getGPUPhase(), // 'none' | 'fast' | 'full'
      hasCachedDevices: !!(cachedDMLDevices && cachedDMLDevices.length > 0),
    };
  });

  ipcMain.handle('settings:getDMLDevices', async () => {
    try {
      // 并行获取 GPU 信息和 NPU 检测
      const [controllers, npuResult] = await Promise.all([
        ensureGPUInfo(),
        detectNPUCached(),
      ]);

      if (!cachedDMLDevices || cachedDMLDevices.length === 0) {
        const modelDir = getModelDir();
        cachedDMLDevices = await enumerateDMLDevices(modelDir, controllers);
      }

      const devices = [...cachedDMLDevices];
      if (npuResult.npuAvailable && !devices.some(d => d.deviceType === 'npu')) {
        devices.push({
          name: 'NPU (WebNN)',
          deviceType: 'npu',
          isDiscrete: false,
          vramBytes: 0,
          vram: '0 MB',
          vendor: '',
          dxgiAdapterNumber: undefined,
          source: 'webnn',
        });
      }
      return devices;
    } catch (err) {
      console.error('[Main] DML device enumeration failed:', err);
      return [];
    }
  });

  ipcMain.handle('settings:getCurrentHardware', async () => {
    try {
      const pipeline = getSvsPipeline();
      if (pipeline && pipeline.initialized) {
        return pipeline.getHardwareInfo();
      }
      return null;
    } catch (err) {
      console.error('[Main] Failed to get current hardware info:', err);
      return null;
    }
  });

  ipcMain.handle('settings:getSettings', async () => {
    return loadSettings();
  });

  ipcMain.handle('settings:validateDevices', async () => {
    const settings = loadSettings();
    const deviceMode = settings.deviceMode || 'smart';
    const issues = [];

    const [gpuInfo, npuResult] = await Promise.all([
      ensureGPUInfo(),
      detectNPUCached(),
    ]);
    const dmlDevices = cachedDMLDevices || [];
    const allDevices = [...dmlDevices];

    for (const c of gpuInfo) {
      if (!allDevices.find(d => d.name === c.model)) {
        const vramBytes = (c.memoryTotal || c.vram || 0) * 1024 * 1024;
        const deviceType = classifyDeviceFromName(c.model, vramBytes);
        allDevices.push({
          name: c.model,
          deviceType,
          isDiscrete: deviceType === 'discrete-gpu',
          vramBytes,
          source: 'systeminformation',
        });
      }
    }

    let npuAvailable = npuResult.npuAvailable;
    if (!npuAvailable) {
      npuAvailable = allDevices.some(d => d.deviceType === 'npu');
    }

    if (deviceMode === 'manual') {
      const preferredId = settings.preferredDeviceId;
      const preferredType = settings.preferredDeviceType;
      // NPU is validated at pipeline init via probe — don't flag as issue
      if (preferredType !== 'npu' && preferredId !== undefined && preferredId !== null) {
        const found = allDevices.find(d => d.dxgiAdapterNumber === preferredId);
        if (!found) {
          issues.push({
            type: 'device-not-found',
            mode: 'manual',
            message: `Previously selected device (deviceId=${preferredId}) not found`,
            fix: { deviceMode: 'smart' },
          });
        }
      }
    } else if (deviceMode === 'advanced' && settings.modelDeviceMapping) {
      // NPU mappings are validated at pipeline init — don't flag as issue
    }

    return { issues, deviceMode, npuAvailable, devices: allDevices };
  });

  ipcMain.handle('app:getVersion', async () => {
    return require('electron').app.getVersion();
  });

  ipcMain.handle('settings:saveSettings', async (event, settings) => {
    const current = loadSettings();
    const filtered = {};
    for (const key of ALLOWED_SETTINGS_KEYS) {
      if (settings[key] !== undefined) filtered[key] = settings[key];
    }
    const merged = { ...current, ...filtered };
    await saveSettingsFile(merged);

    if (settings.locale) {
      await updateLocaleSetting(settings.locale);
    }

    // 精度 / vocoder 类型 / 设备设置变化时必须重置 pipeline，
    // 否则切换 INT8-NPU 等精度后仍使用旧 pipeline（模型仍加载在旧设备上）
    if (settings.deviceMode !== undefined ||
        settings.preferredDeviceId !== undefined ||
        settings.modelDeviceMapping !== undefined ||
        settings.modelPrecision !== undefined ||
        settings.vocoderType !== undefined) {
      resetSvsPipeline();
      resetRmvpe();
      resetBasicPitch();
      resetRosvot();
    }

    invalidateDMLDevices();
    invalidateGPUCache();

    return { success: true };
  });

  ipcMain.handle('get-locale', async () => {
    return require('./locale').getLocale();
  });

  ipcMain.handle('settings:check-models', async () => {
    const { checkMissingFiles } = require('../modelManager');
    const modelDir = getModelDir();
    const precisions = ['fp32', 'fp16', 'fp8', 'int8', 'int8-npu'];
    const result = {};
    for (const p of precisions) {
      const { missing, existing } = checkMissingFiles(modelDir, p);
      result[p] = { ready: missing.length === 0, missing: missing.length, total: missing.length + existing.length };
    }
    return result;
  });

  ipcMain.handle('save-locale', async (event, locale) => {
    try {
      const mainLocales = require('./locale').getMainLocales();
      if (typeof locale !== 'string' || !mainLocales[locale]) {
        return { success: false, error: 'Invalid locale' };
      }
      const configPath = require('node:path').join(require('electron').app.getPath('userData'), 'sxseditor-locale.json');
      await require('node:fs').promises.writeFile(configPath, JSON.stringify({ locale }), 'utf8');
      require('./locale').setLocale(locale);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('getModelDir', async () => {
    return getModelDir();
  });
}

module.exports = {
  registerSettingsIpc,
  setCachedDMLDevices,
  getCachedDMLDevices,
  invalidateDMLDevices,
};
