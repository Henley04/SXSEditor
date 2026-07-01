const { ipcMain, dialog } = require('electron');
const { loadSettings, saveSettingsFile, ALLOWED_SETTINGS_KEYS, updateLocaleSetting, invalidateSettingsCache } = require('./settings');
const { classifyDeviceFromName, ensureGPUInfo, getGPUPhase, detectAllHardware, detectNPUCached, invalidateNPUCache, getVocoderChunkFramesInfo } = require('./gpuInfo');
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
      if (npuResult.gpuAvailable && !devices.some(d => d.deviceType === 'webnn-gpu')) {
        devices.push({
          name: t('settings.webnnGpuDevice'),
          deviceType: 'webnn-gpu',
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

  // 智能分配的 vocoder 分片帧数（设置页 UI 显示用）
  // GPU 检测完成后基于最大显存计算，启动前返回默认值。
  ipcMain.handle('settings:getVocoderChunkFramesInfo', async () => {
    try {
      // 传入当前模型精度，让设置页显示按精度扣除常驻权重后的 smartFrames
      const settings = loadSettings();
      return getVocoderChunkFramesInfo(settings.modelPrecision);
    } catch (err) {
      console.error('[Main] Failed to get vocoder chunk frames info:', err);
      return { gpuPhase: 'none', smartFrames: 1008, bestVramBytes: 0, bestGpuName: null };
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

    // 精度 / 设备设置变化时必须重置 pipeline，
    // 否则切换 INT8-NPU 等精度后仍使用旧 pipeline（模型仍加载在旧设备上）
    //
    // 注意：必须比较新旧值是否真正变化，而不能用 `!== undefined` 判断。
    // 因为 settings.js 的 collectSettings() 总是返回包含全部字段的完整对象
    // （deviceMode/modelPrecision 等始终有值，永不为 undefined），
    // 若仅判断 `!== undefined`，则修改 previewDiffSteps/exportDiffSteps/audioVolume
    // 等无关参数时也会误触发 resetSvsPipeline()，导致 NPU 上 WebNN session 被销毁重建，
    // 重建时若 NPU 资源未完全释放（dispose 异步卸载未 await），probe 会静默回退到 WASM/CPU，
    // 然后 markNPUUnavailable() 永久污染 NPU 检测缓存，造成"修改 diffstep 后 NPU 静默回退 CPU"。
    //
    // vocoderType 不在此列：仅切换 vocoder 时走增量 swapVocoder 路径，只重载 vocoder session，
    // 避免主模型（encoders/preflow/condEmb/diffStep/melTransform）被重新加载。
    // 但若其他 RESET_TRIGGER_KEYS 同时变化，仍走完整 reset（重建时自动读取最新 vocoderType）。
    const RESET_TRIGGER_KEYS = ['deviceMode', 'preferredDeviceId', 'modelDeviceMapping', 'modelPrecision', 'inferenceProvider'];
    const needsPipelineReset = RESET_TRIGGER_KEYS.some(key => {
      // modelDeviceMapping 是对象，需深比较；其他字段为标量，直接比较
      if (key === 'modelDeviceMapping') {
        return JSON.stringify(current[key] || {}) !== JSON.stringify(merged[key] || {});
      }
      return current[key] !== merged[key];
    });
    const vocoderTypeChanged = current.vocoderType !== merged.vocoderType;
    const sifiganPrecisionChanged = current.sifiganPrecision !== merged.sifiganPrecision;
    if (needsPipelineReset) {
      resetSvsPipeline();
      resetRmvpe();
      resetBasicPitch();
      resetRosvot();
    } else if (vocoderTypeChanged) {
      // 增量切换 vocoder：仅重载 vocoder session，主模型保持不变
      const newVocoderType = merged.vocoderType === 'sifigan' ? 'sifigan' : 'default';
      const pipeline = getSvsPipeline();
      if (pipeline && pipeline.initialized && typeof pipeline.swapVocoder === 'function') {
        try {
          await pipeline.swapVocoder(newVocoderType);
        } catch (err) {
          console.error('[Main] Vocoder swap failed:', err.message);
        }
      } else {
        // Pipeline 未初始化：下次 init 时会读取最新 vocoderType，无需立即处理
        console.log('[Main] Pipeline not initialized, vocoderType will apply on next init');
      }
    } else if (sifiganPrecisionChanged && merged.vocoderType === 'sifigan') {
      // 增量切换 SiFiGAN 精度（仅 vocoderType === 'sifigan' 时）：仅重载 vocoder session
      const newPrecision = merged.sifiganPrecision === 'fp16' ? 'fp16' : 'fp32';
      const pipeline = getSvsPipeline();
      if (pipeline && typeof pipeline.swapSifiganPrecision === 'function') {
        try {
          await pipeline.swapSifiganPrecision(newPrecision);
        } catch (err) {
          console.error('[Main] SiFiGAN precision swap failed:', err.message);
        }
      } else {
        console.log('[Main] Pipeline not initialized or swapSifiganPrecision unavailable, sifiganPrecision will apply on next init');
      }
    }

    // 硬件探测仅在应用启动后执行一次并缓存复用，
    // 保存设置时不再失效 GPU/DML 缓存（避免运行时重复触发 GPU 检测与 DML 探针推理，
    // 同时规避检测与推理并发提交命令流导致 DXGI_ERROR_DEVICE_REMOVED 的风险）。

    return { success: true };
  });

  ipcMain.handle('get-locale', async () => {
    return require('./locale').getLocale();
  });

  ipcMain.handle('settings:check-models', async () => {
    const { checkMissingFiles } = require('../modelManager');
    const modelDir = getModelDir();
    const precisions = ['fp32', 'fp16', 'int8', 'int8-npu'];
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
