const { ipcMain, shell } = require('electron');
const { loadSettings, saveSettingsFile, ALLOWED_SETTINGS_KEYS, updateLocaleSetting, normalizeSettings } = require('./settings');
const { classifyDeviceFromName, ensureGPUInfo, getGPUPhase, detectNPUCached, getVocoderChunkFramesInfo, getVocoderChunkFramesTable } = require('./gpuInfo');
const { getModelDir } = require('./modelDir');
const { enumerateDMLDevices } = require('../inference/pipeline');
const { getSvsPipeline, resetSvsPipeline } = require('./svsIpc');
const { resetRmvpe, resetBasicPitch, resetRosvot } = require('./pitchMidiIpc');
const { isSystemPath } = require('./security');
const { t } = require('./locale');

// W10: Semantic value validation for known setting keys.
// The whitelist (ALLOWED_SETTINGS_KEYS) only filters by key name; these
// validators constrain values so a bad modelDir (system path), an out-of-range
// vocoderChunkFrames, an unknown modelPrecision, or a malformed theme id
// cannot be persisted. Invalid values are skipped with a warning rather
// than failing the whole save, to avoid breaking existing saves.
const VALID_MODEL_PRECISIONS = ['fp32', 'fp16', 'int8', 'int8-npu'];
// Theme ids are kebab-case (matches src/themes/themeValidator.js ID_RE).
// Built-in + user themes both follow this format.
const THEME_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const BOOLEAN_SETTING_KEYS = new Set([
  'useRosvot',
  'previewDiffStepChunkEnabled',
  'releaseDmlVramAfterSynthesis',
  'releaseDiffStepBeforeVocoder',
  'ortEnableMemPattern',
  'ortForceMemPatternOnDml',
  'ortEnableCpuMemArena',
  'autoCheckUpdates',
  'dontRemindAppUpdates',
  'enableLoudnormFinal',
  'enableAntiAliasing',
  'enableSDEditRepair',
  'diagnosticMode',
  'previewDynamicThresholdEnabled',
  'exportDynamicThresholdEnabled',
]);

function isValidSettingValue(key, value) {
  switch (key) {
    case 'modelDir':
      // Allow empty string (clears the custom dir); otherwise must be a
      // non-system path string.
      if (typeof value !== 'string') return false;
      if (value.length === 0) return true;
      return !isSystemPath(value);
    case 'theme':
      if (typeof value !== 'string') return false;
      if (value.length === 0 || value.length > 200) return false;
      return THEME_ID_RE.test(value);
    case 'vocoderChunkFrames':
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (!Number.isInteger(value)) return false;
      return value >= 1 && value <= 4096;
    case 'modelPrecision':
      return VALID_MODEL_PRECISIONS.includes(value);
    case 'previewDynamicThresholdPercentile':
    case 'exportDynamicThresholdPercentile':
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      return value >= 0.9 && value <= 0.999;
    default:
      if (BOOLEAN_SETTING_KEYS.has(key)) {
        return typeof value === 'boolean';
      }
      return true; // unvalidated keys pass through
  }
}

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
      // 传入当前模型精度 + vocoderType，让设置页显示按精度扣除常驻权重 + 按 vocoder 类型独立分档的 smartFrames
      // SiFiGAN 模式下返回值不再除以上采样倍率（模型体积小，可用更长分片）
      const settings = loadSettings();
      const vocoderType = settings.vocoderType === 'sifigan' ? 'sifigan' : 'default';
      return getVocoderChunkFramesInfo(settings.modelPrecision, vocoderType);
    } catch (err) {
      console.error('[Main] Failed to get vocoder chunk frames info:', err);
      return { gpuPhase: 'none', smartFrames: 1024, bestVramBytes: 0, bestGpuName: null };
    }
  });

  // 不同显存档位下的 vocoder 分片对照表（设置页 UI 展示用）。
  // 以 8GB 为基准，向下扩展到核显（2GB）、向上扩展到旗舰独显（24GB）。
  // 当精度或 vocoder 类型切换时，前端会重新调用此接口刷新对照表。
  ipcMain.handle('settings:getVocoderChunkFramesTable', async () => {
    try {
      const settings = loadSettings();
      const vocoderType = settings.vocoderType === 'sifigan' ? 'sifigan' : 'default';
      return getVocoderChunkFramesTable(settings.modelPrecision, vocoderType);
    } catch (err) {
      console.error('[Main] Failed to get vocoder chunk frames table:', err);
      return [];
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

  ipcMain.handle('settings:saveSettings', async (event, settings) => {
    const current = loadSettings();
    const filtered = {};
    for (const key of ALLOWED_SETTINGS_KEYS) {
      if (settings[key] === undefined) continue;
      // W10: validate the value for known keys; skip invalid ones with a
      // warning instead of failing the whole save.
      if (!isValidSettingValue(key, settings[key])) {
        console.warn(`[Main] Invalid value for setting "${key}", skipping`);
        continue;
      }
      filtered[key] = settings[key];
    }
    const merged = normalizeSettings({ ...current, ...filtered });
    // W7: saveSettingsFile now returns { success, error? }; propagate a
    // write failure to the renderer instead of reporting a false success.
    const saveResult = await saveSettingsFile(merged);
    if (!saveResult.success) {
      return saveResult;
    }

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
    const RESET_TRIGGER_KEYS = [
        'deviceMode', 'preferredDeviceId', 'modelDeviceMapping', 'modelPrecision', 'inferenceProvider',
        // ORT session 选项在模型加载时生效，修改后必须重置 pipeline 让新会话使用新配置
        'ortEnableMemPattern', 'ortForceMemPatternOnDml', 'ortEnableCpuMemArena',
        'ortGraphOptLevel', 'ortExecutionMode',
        'ortIntraOpNumThreads', 'ortInterOpNumThreads', 'ortLogSeverityLevel',
        // Windows ML vendor EP 开关影响 diffStep/vocoder/preflow 会话创建路径，
        // 切换后必须重建 pipeline（重建时 createSessionWithValidation 才会尝试 WinML 链）
        'winmlEnabled',
    ];
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
      // Windows ML 开启时后台预热：立即解析/下载兼容 EP 的 MSIX 运行库，
      // 下一次合成 spawn worker 时 getReadyEpLibraries() 即可拿到就绪列表。
      if (merged.winmlEnabled === true && current.winmlEnabled !== true) {
        try {
          require('../inference/winml/winmlProvider')
            .getReadyEpLibraries()
            .then((eps) => console.log(`[Main][WinML] warmup=done eps=${eps.map((e) => e.name).join(',') || 'none'}`))
            .catch((err) => console.warn('[Main] WinML EP warmup failed:', err.message));
        } catch (_) { /* best effort */ }
      }
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

    // Japanese vocalization mode changed: update TextProcessing without reloading models.
    // en-phonemes → base model + English phonemes; jp-lora → JP LoRA + jp_ phonemes.
    // The actual model swap (base ↔ JP) happens per-synthesis via ensurePipelineLanguage(),
    // so we only need to update the TextProcessing field and clear the synthesis cache.
    const jpVocalizationChanged = current.japaneseVocalization !== merged.japaneseVocalization;
    if (jpVocalizationChanged && !needsPipelineReset) {
      const pipeline = getSvsPipeline();
      if (pipeline && pipeline._textProcessing) {
        pipeline._textProcessing.japaneseVocalization = merged.japaneseVocalization || 'hybrid';
        pipeline._japaneseVocalization = merged.japaneseVocalization || 'hybrid';
        // Clear synthesis cache: phoneme processing changed, old results are stale
        if (typeof pipeline.clearSynthCache === 'function') {
          pipeline.clearSynthCache();
        }
        console.log(`[Main] Japanese vocalization updated: ${current.japaneseVocalization || 'default'} -> ${merged.japaneseVocalization}`);
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

  ipcMain.handle('settings:run-trtrtx-diagnostic', async () => {
    try {
      const settings = loadSettings();
      const hw = await ensureGPUInfo().catch(() => null);
      // Resolve EP packages in the Electron main process, where WinRT/package
      // identity is available. The diagnostic child runs as plain Node and
      // must receive the same snapshots as the normal SVS worker.
      const winmlProvider = require('../inference/winml/winmlProvider');
      const winmlEps = await winmlProvider.getReadyEpLibraries();
      const payload = {
        modelDir: getModelDir(), precision: settings.modelPrecision || 'fp16',
        dmlDeviceId: Number(settings.preferredDeviceId) || 0,
        gpu: hw?.bestGPU?.name || hw?.gpuName || null,
        settingsSnapshot: {
          ...settings,
          winmlEnabled: true,
          diagnosticMode: true,
        },
        winmlEps,
      };
      const fs = require('node:fs');
      const diagnosticRoot = require('node:path').join(payload.modelDir, 'diagnostics');
      payload.dumpDir = require('node:path').join(
        diagnosticRoot,
        `trtrtx-${new Date().toISOString().replace(/[:.]/g, '-')}`
      );
      fs.mkdirSync(payload.dumpDir, { recursive: true });
      const { fork } = require('node:child_process');
      const path = require('node:path');
      // settingsIpc is compiled into .webpack/main/index.js. At runtime
      // __dirname already points to .webpack/main, so moving to ".." produced
      // the invalid .webpack/inference/winml path seen in the crash log.
      const runnerCandidates = [
        path.join(__dirname, 'inference', 'winml', 'trtDiagnosticRunner.js'),
        path.resolve(process.cwd(), '.webpack', 'main', 'inference', 'winml', 'trtDiagnosticRunner.js'),
        path.resolve(process.cwd(), 'src', 'inference', 'winml', 'trtDiagnosticRunner.js'),
      ];
      const runner = runnerCandidates.find(candidate => fs.existsSync(candidate));
      if (!runner) {
        throw new Error(`TensorRT-RTX diagnostic runner was not packaged. Tried: ${runnerCandidates.join(', ')}`);
      }
      // Vendor EP failures may terminate the process without throwing. A real
      // child process isolates Electron from native TRT/driver crashes. A
      // worker_thread is insufficient because it shares the same process.
      const report = await new Promise((resolve, reject) => {
        const child = fork(runner, [], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            SXS_TRT_DIAGNOSTIC_PAYLOAD: JSON.stringify(payload),
            SXS_WINML_TRACE: '1',
            SXS_TRTRTX_NO_PROFILE: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let settled = false;
        child.stdout?.on('data', chunk => process.stdout.write(`[TRTRTX-DIAG] ${chunk}`));
        child.stderr?.on('data', chunk => process.stderr.write(`[TRTRTX-DIAG] ${chunk}`));
        child.on('message', message => {
          if (settled) return;
          if (message?.type === 'result') {
            if (!message.report || typeof message.report !== 'object') {
              settled = true;
              reject(new Error('TensorRT-RTX diagnostic returned an invalid report'));
              return;
            }
            settled = true;
            resolve(message.report);
          } else if (message?.type === 'error') {
            settled = true;
            reject(new Error(message.error));
          }
        });
        child.on('error', error => {
          if (!settled) { settled = true; reject(error); }
        });
        child.on('exit', (code, signal) => {
          if (!settled) {
            settled = true;
            // Native access violations cannot be caught in JS. Recover the
            // latest atomic checkpoint so the application still opens a useful
            // report instead of losing all completed probes.
            const partialPath = require('node:path').join(payload.dumpDir, 'report.partial.json');
            try {
              const partial = JSON.parse(fs.readFileSync(partialPath, 'utf8'));
              if (!partial || typeof partial !== 'object') throw new Error('invalid partial report');
              partial.summary = `NATIVE_CRASH code=${code} signal=${signal || 'none'}`;
              partial.nativeCrash = { code, signal: signal || null };
              fs.writeFileSync(require('node:path').join(payload.dumpDir, 'report.json'), JSON.stringify(partial, null, 2));
              fs.writeFileSync(require('node:path').join(payload.dumpDir, 'report.txt'),
                `summary=${partial.summary}\ndumpDir=${payload.dumpDir}\nSee report.partial.json for completed checks.`);
              resolve(partial);
            } catch (_) {
              reject(new Error(
                `TensorRT-RTX diagnostic process exited unexpectedly: code=${code} signal=${signal || 'none'}`
              ));
            }
          }
        });
      });
      await shell.openPath(report.dumpDir);
      return { success: true, report };
    } catch (err) {
      console.error('[TRTRTX][diagnostic] failed:', err);
      return { success: false, error: err.message || String(err) };
    }
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
