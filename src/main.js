const { app, BrowserWindow, ipcMain, dialog, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Fix Windows console encoding for Chinese log output
if (process.platform === 'win32') {
  try { require('child_process').execSync('chcp 65001', { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (_) {}
}

// Suppress EPIPE errors when stdout/stderr pipe breaks (e.g. terminal closed)
// console.log throws synchronously via Socket.write — must wrap the write method
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.write === 'function') {
    const originalWrite = stream.write.bind(stream);
    stream.write = function (chunk, encoding, cb) {
      try { return originalWrite(chunk, encoding, cb); }
      catch (e) { if (e?.code === 'EPIPE') return false; throw e; }
    };
  }
  if (stream && typeof stream.on === 'function') {
    stream.on('error', () => {}); // swallow async EPIPE events
  }
}

// Catch unhandled errors to prevent silent crashes
process.on('uncaughtException', (err) => {
  try { process.stderr.write(`[FATAL] ${err.stack || err}\n`); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try { process.stderr.write(`[UNHANDLED REJECTION] ${reason}\n`); } catch (_) {}
});

// 启用 WebNN API，使渲染进程可通过 onnxruntime-web WebNN EP Using NPU 推理
app.commandLine.appendSwitch('enable-features', 'WebMachineLearningNeuralNetwork');

if (require('electron-squirrel-startup')) {
  app.quit();
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

const { enumerateDMLDevices } = require('./inference/pipeline');

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
  detectAllHardware,
} = require('./main/gpuInfo');
const { checkAndDownloadModels, registerModelDownloadIpc } = require('./main/modelDownload');
const { registerThemeIpc } = require('./main/themeIpc');
const { registerSvsIpc, resetSvsPipeline } = require('./main/svsIpc');
const { registerPitchMidiIpc, resetRmvpe, resetBasicPitch, resetRosvot } = require('./main/pitchMidiIpc');
const { registerSingerIpc } = require('./main/singerIpc');
const { registerAudioIpc, resetAudioManagers } = require('./main/audioIpc');
const { registerDialogIpc } = require('./main/dialogIpc');
const { registerSettingsIpc, setCachedDMLDevices, getCachedDMLDevices, invalidateDMLDevices } = require('./main/settingsIpc');
const { registerResourceManagerIpc } = require('./main/resourceManagerIpc');
const { registerWebnnIpc } = require('./main/webnnIpc');
const {
  createSplashWindow,
  closeSplashWindow,
  getSplashReadyAt,
  waitForSplashReady,
  registerSplashIpc,
} = require('./main/splashManager');

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
  const isDev = !app.isPackaged;

  const cspScriptSrc = isDev ? "'self' 'unsafe-eval'" : "'self'";
  const cspConnectSrc = isDev
    ? "'self' https://modelscope.cn ws://0.0.0.0:3000 ws://localhost:3000"
    : "'self' https://modelscope.cn";
  const contentSecurityPolicy = `default-src 'self'; script-src ${cspScriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src ${cspConnectSrc}; font-src 'self' data:; worker-src 'self' blob:; child-src 'self' blob:;`;

  // Content Security Policy: restrict resource loading to self-origin
  const { session } = require('electron');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy],
        // Enable cross-origin isolation so renderers get crossOriginIsolated=true,
        // which unlocks SharedArrayBuffer for multi-threaded WASM (ort.env.wasm.numThreads > 1).
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
      },
    });
  });

  // 注册 onnx:// protocol handler，允许渲染进程安全访问Model files
  protocol.handle('onnx', (request) => {
    const url = new URL(request.url);
    const modelPath = decodeURIComponent(url.pathname);
    const modelDir = getModelDir();
    const resolvedPath = path.resolve(modelDir, modelPath.replace(/^\/+/, ''));
    if (!resolvedPath.startsWith(path.resolve(modelDir))) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!resolvedPath.endsWith('.onnx') && !resolvedPath.endsWith('.onnx.data')) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!fs.existsSync(resolvedPath)) {
      return new Response('Not Found', { status: 404 });
    }
    return net.fetch(`file:///${resolvedPath.replace(/\\/g, '/')}`);
  });

  loadMainLocale();

  // Splash screen is shown only in packaged builds. In dev mode the
  // main window is shown immediately — devs don't need the splash and
  // forcing it would slow down iteration. (isDev was declared above,
  // next to the CSP setup.)
  const showSplash = !isDev;
  // Minimum visible duration of the splash, measured from when the
  // splash's SVG actually painted. Set to 0 so the splash never
  // artificially delays startup — the main window is revealed as soon
  // as the splash has painted (see waitForSplashReady below).
  const MIN_SPLASH_MS = 0;

  if (showSplash) {
    createSplashWindow();
  }

  const mainWindow = createWindow({ show: false });

  // Helper: reveal the main window (and close the splash if any). In
  // dev mode this runs immediately after did-finish-load; in packaged
  // mode it waits for the splash's minimum visible duration.
  const revealMainWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    if (showSplash) {
      closeSplashWindow();
    }
  };

  // 主窗口渲染进程就绪后：先显示窗口，再后台完成硬件检测和设备校验
  // （此前此处 await detectAllHardware() 会阻塞主窗口显示，因为完整
  //  systeminformation GPU 检测可能耗时数秒甚至 ~9s。现将窗口显示与
  //  硬件检测解耦，让用户立即看到应用界面。）
  mainWindow.webContents.once('did-finish-load', () => {
    // 1. 立即显示主窗口（不等待 GPU/NPU 检测）
    // In dev mode: reveal the main window immediately.
    // In packaged mode: first guarantee the splash has actually
    // painted (so it is visible before the main window appears),
    // then enforce the splash's minimum visible duration measured
    // from when the splash's SVG painted. With MIN_SPLASH_MS = 0
    // the main window is revealed the moment the splash is visible.
    if (!showSplash) {
      revealMainWindow();
    } else {
      (async () => {
        try {
          await waitForSplashReady();
          const readyAt = getSplashReadyAt();
          const referenceTime = readyAt || Date.now();
          const elapsed = Date.now() - referenceTime;
          const wait = Math.max(0, MIN_SPLASH_MS - elapsed);
          if (wait > 0) {
            setTimeout(revealMainWindow, wait);
          } else {
            revealMainWindow();
          }
        } catch (err) {
          console.warn('[Main] Splash reveal failed:', err.message);
          revealMainWindow();
        }
      })();
    }

    // 2. 后台执行硬件检测和设备校验（不阻塞窗口显示）
    (async () => {
      try {
        // 等待 NPU 检测完成（需要渲染进程处理 WebNN IPC）
        const { npuAvailable } = await detectAllHardware();
        console.log(`[Main] Hardware detection complete: NPU ${npuAvailable ? 'available' : 'not available'}`);

        const settings = loadSettings();
        const deviceMode = settings.deviceMode || (settings.deviceId !== undefined && settings.deviceId !== null ? 'manual' : 'smart');

        if (deviceMode === 'manual' || deviceMode === 'advanced') {
          const gpuInfo = await ensureGPUInfo();
          const dmlDevices = getCachedDMLDevices() || [];
          const allDevices = [...dmlDevices];
          for (const c of gpuInfo) {
            if (!allDevices.find(d => d.name === c.model)) {
              const vramBytes = (c.memoryTotal || c.vram || 0) * 1024 * 1024;
              const deviceType = classifyDeviceFromName(c.model, vramBytes);
              allDevices.push({ name: c.model, deviceType, isDiscrete: deviceType === 'discrete-gpu', vramBytes, source: 'systeminformation' });
            }
          }

          if (npuAvailable && !allDevices.some(d => d.deviceType === 'npu')) {
            allDevices.push({
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

          if (deviceMode === 'manual') {
            const preferredId = settings.preferredDeviceId ?? settings.deviceId;
            const preferredType = settings.preferredDeviceType;

            // NPU devices are validated at pipeline init via probe — don't switch at startup
            if (preferredType === 'npu') {
              console.log('[Main] NPU device selected, skipping startup validation (will verify via probe at inference time)');
            } else {
              const found = preferredId !== undefined && preferredId !== null
                ? allDevices.find(d => d.dxgiAdapterNumber === preferredId)
                : null;

              if (!found && !mainWindow.isDestroyed()) {
                const deviceName = `deviceId=${preferredId}`;
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
            }
          } else if (deviceMode === 'advanced' && settings.modelDeviceMapping) {
            // NPU mappings are validated at pipeline init — don't switch at startup
            console.log('[Main] Advanced mode, skipping NPU mapping startup validation (will verify via probe at inference time)');
          }
        }
      } catch (err) {
        console.warn('[Main] Device validation failed:', err.message);
      }
    })();
  });

  // GPU 预加载（WMI 快速路径，不需要渲染进程）
  startGPUPreload();
  ensureGPUInfo().then(controllers => {
    return enumerateDMLDevices(getModelDir(), controllers);
  }).then(devices => {
    setCachedDMLDevices(devices);
    setSettingsCachedDMLDevices(devices);
    console.log(`[Main] GPU device preload complete: ${devices.length}  device(s)`);
  }).catch(err => {
    console.warn('[Main] GPU device preload failed:', err.message);
  });
  // Model检查延后执行，不阻塞窗口显示
  checkAndDownloadModels().catch(err => {
    console.warn('[Main] Model check failed:', err.message);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch(err => {
  console.error('[Main] Application init failed:', err);
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
registerSplashIpc();
