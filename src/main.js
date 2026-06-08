const { app, BrowserWindow, ipcMain, dialog, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 启用 WebNN API，使渲染进程可通过 onnxruntime-web WebNN EP 使用 NPU 推理
app.commandLine.appendSwitch('enable-features', 'WebMachineLearningNeuralNetwork');

if (require('electron-squirrel-startup')) {
  app.quit();
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

const { enumerateDMLDevices } = require('./inference/nativeSvsPipeline');

const {
  createWindow,
  getMainWindow,
  buildAppMenu,
  registerWindowIpc,
} = require('./main/windowManager');
const { loadMainLocale, t } = require('./main/locale');
const { loadSettings, saveSettingsFile, setCachedDMLDevices: setSettingsCachedDMLDevices } = require('./main/settings');
const { authorizePath, isPathAllowed } = require('./main/security');
const { getModelDir } = require('./main/modelDir');
const {
  classifyDeviceFromName,
  startGPUPreload,
  ensureGPUInfo,
} = require('./main/gpuInfo');
const { checkAndDownloadModels, registerModelDownloadIpc } = require('./main/modelDownload');
const { registerThemeIpc } = require('./main/themeIpc');
const { registerSvsIpc, resetSvsPipeline } = require('./main/svsIpc');
const { registerPitchMidiIpc, resetRmvpe, resetBasicPitch, resetRosvot } = require('./main/pitchMidiIpc');
const { registerSingerIpc } = require('./main/singerIpc');
const { registerAudioIpc, resetAudioManagers } = require('./main/audioIpc');
const { registerDialogIpc } = require('./main/dialogIpc');
const { registerSettingsIpc, setCachedDMLDevices, invalidateDMLDevices } = require('./main/settingsIpc');
const { registerResourceManagerIpc } = require('./main/resourceManagerIpc');
const { registerWebnnIpc } = require('./main/webnnIpc');

let cachedDMLDevices = null;

app.on('second-instance', () => {
  const mainWindow = getMainWindow();
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
});

// 注册自定义 protocol scheme，必须在 app.whenReady() 之前调用
const { protocol } = require('electron');
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'onnx',
    privileges: {
      bypassCSP: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);

app.whenReady().then(() => {
  // 注册 onnx:// protocol handler，允许渲染进程安全访问模型文件
  protocol.handle('onnx', (request) => {
    const url = new URL(request.url);
    const modelPath = decodeURIComponent(url.pathname);
    const modelDir = getModelDir();
    const resolvedPath = path.resolve(modelDir, modelPath.replace(/^\/+/, ''));
    if (!resolvedPath.startsWith(path.resolve(modelDir))) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!resolvedPath.endsWith('.onnx')) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!fs.existsSync(resolvedPath)) {
      return new Response('Not Found', { status: 404 });
    }
    return net.fetch(`file:///${resolvedPath.replace(/\\/g, '/')}`);
  });

  loadMainLocale();
  const mainWindow = createWindow();

  // 设备丢失检测：主窗口加载完成后校验用户指定的设备
  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      const settings = loadSettings();
      const deviceMode = settings.deviceMode || (settings.deviceId !== undefined && settings.deviceId !== null ? 'manual' : 'smart');

      if (deviceMode === 'manual' || deviceMode === 'advanced') {
        const gpuInfo = await ensureGPUInfo();
        const dmlDevices = cachedDMLDevices || [];
        const allDevices = [...dmlDevices];
        for (const c of gpuInfo) {
          if (!allDevices.find(d => d.name === c.model)) {
            const vramBytes = (c.memoryTotal || c.vram || 0) * 1024 * 1024;
            const deviceType = classifyDeviceFromName(c.model, vramBytes);
            allDevices.push({ name: c.model, deviceType, isDiscrete: deviceType === 'discrete-gpu', vramBytes, source: 'systeminformation' });
          }
        }

        const npuAvailable = allDevices.some(d => d.deviceType === 'npu');

        if (deviceMode === 'manual') {
          const preferredId = settings.preferredDeviceId ?? settings.deviceId;
          const preferredType = settings.preferredDeviceType;
          const found = preferredId !== undefined && preferredId !== null
            ? allDevices.find(d => d.dxgiAdapterNumber === preferredId)
            : null;

          if (!found || (preferredType === 'npu' && !npuAvailable)) {
            const deviceName = found ? found.name : `deviceId=${preferredId}`;
            dialog.showMessageBoxSync(mainWindow, {
              type: 'warning',
              title: 'Device Not Found',
              message: `Previously selected device "${deviceName}" was not found. Switched to smart mode.`,
              buttons: ['OK'],
            });
            const newSettings = { ...settings, deviceMode: 'smart' };
            delete newSettings.preferredDeviceId;
            delete newSettings.preferredDeviceType;
            await saveSettingsFile(newSettings);
          }
        } else if (deviceMode === 'advanced' && settings.modelDeviceMapping) {
          const newMapping = { ...settings.modelDeviceMapping };
          let changed = false;
          for (const [groupId, mapping] of Object.entries(newMapping)) {
            if (typeof mapping === 'object' && mapping.deviceType === 'npu' && !npuAvailable) {
              newMapping[groupId] = 'auto';
              changed = true;
            }
          }
          if (changed) {
            dialog.showMessageBoxSync(mainWindow, {
              type: 'warning',
              title: 'NPU Not Available',
              message: 'NPU device not found. Model groups assigned to NPU have been switched to auto.',
              buttons: ['OK'],
            });
            await saveSettingsFile({ ...settings, modelDeviceMapping: newMapping });
          }
        }
      }
    } catch (err) {
      console.warn('[Main] Device validation failed:', err.message);
    }
  });

  // 后台线程预加载GPU信息，不阻塞主线程
  startGPUPreload();
  // 等待GPU信息加载完成后再枚举DML设备
  ensureGPUInfo().then(controllers => {
    return enumerateDMLDevices(getModelDir(), controllers);
  }).then(devices => {
    cachedDMLDevices = devices;
    setCachedDMLDevices(devices);
    setSettingsCachedDMLDevices(devices);
    console.log(`[Main] GPU设备预加载完成: ${devices.length} 个设备`);
  }).catch(err => {
    console.warn('[Main] GPU设备预加载失败:', err.message);
  });
  // 模型检查延后执行，不阻塞窗口显示
  checkAndDownloadModels().catch(err => {
    console.warn('[Main] 模型检查失败:', err.message);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch(err => {
  console.error('[Main] 应用初始化失败:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  resetSvsPipeline();
  resetRmvpe();
  resetBasicPitch();
  resetRosvot();
  resetAudioManagers();
  const { getFragmentWindows } = require('./main/windowManager');
  const fragmentWindows = getFragmentWindows();
  for (const id in fragmentWindows) {
    if (fragmentWindows[id] && !fragmentWindows[id].isDestroyed()) {
      fragmentWindows[id].destroy();
    }
  }
});

// 注册所有 IPC
registerWindowIpc();
registerDialogIpc();
registerSettingsIpc();
registerThemeIpc();
registerSvsIpc();
registerPitchMidiIpc();
registerSingerIpc();
registerAudioIpc();
registerModelDownloadIpc();
registerResourceManagerIpc();
registerWebnnIpc();
