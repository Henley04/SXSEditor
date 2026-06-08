const { ipcMain, dialog } = require('electron');
const { loadSettings, saveSettingsFile, ALLOWED_SETTINGS_KEYS, updateLocaleSetting, invalidateSettingsCache } = require('./settings');
const { classifyDeviceFromName, ensureGPUInfo } = require('./gpuInfo');
const { getModelDir } = require('./modelDir');
const { enumerateDMLDevices } = require('../inference/nativeSvsPipeline');
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
  ipcMain.handle('settings:getDMLDevices', async () => {
    try {
      if (!cachedDMLDevices) {
        const modelDir = getModelDir();
        console.log('[Main] 枚举 DML 设备，模型目录:', modelDir);
        const controllers = await ensureGPUInfo();
        cachedDMLDevices = await enumerateDMLDevices(modelDir, controllers);
      }
      return cachedDMLDevices;
    } catch (err) {
      console.error('[Main] 枚举 DML 设备失败:', err);
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
      console.error('[Main] 获取当前硬件信息失败:', err);
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

    const gpuInfo = await ensureGPUInfo();
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

    let npuAvailable = false;
    try {
      await ipcMain.handleOnce('__internal:webnnDetectNPU') || {};
    } catch (_) {}
    npuAvailable = allDevices.some(d => d.deviceType === 'npu');

    if (deviceMode === 'manual') {
      const preferredId = settings.preferredDeviceId;
      const preferredType = settings.preferredDeviceType;
      if (preferredId !== undefined && preferredId !== null) {
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
      if (preferredType === 'npu' && !npuAvailable) {
        issues.push({
          type: 'npu-not-available',
          mode: 'manual',
          message: 'NPU device not available',
          fix: { deviceMode: 'smart' },
        });
      }
    } else if (deviceMode === 'advanced' && settings.modelDeviceMapping) {
      for (const [groupId, mapping] of Object.entries(settings.modelDeviceMapping)) {
        if (mapping === 'auto' || mapping === 'npu-webnn') continue;
        if (typeof mapping === 'object' && mapping.deviceType === 'npu' && !npuAvailable) {
          issues.push({
            type: 'model-group-npu-not-available',
            mode: 'advanced',
            groupId,
            message: `Model group ${groupId} assigned to NPU but NPU not available`,
            fix: { groupId, newMapping: 'auto' },
          });
        }
      }
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

    if (settings.deviceMode !== undefined || settings.preferredDeviceId !== undefined || settings.modelDeviceMapping !== undefined) {
      resetSvsPipeline();
      resetRmvpe();
      resetBasicPitch();
      resetRosvot();
    }

    invalidateDMLDevices();

    return { success: true };
  });

  ipcMain.handle('get-locale', async () => {
    return require('./locale').getLocale();
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
