const { app, BrowserWindow, ipcMain, dialog, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Fix Windows console encoding for Chinese log output.
// Fire-and-forget async exec: spawning cmd.exe synchronously costs ~50-200ms
// on the critical path before splash appears. The encoding switch takes
// effect ~100ms later; the early startup window has essentially no Chinese
// log output, so the delay is acceptable.
if (process.platform === 'win32') {
  try { require('child_process').exec('chcp 65001', { stdio: ['ignore', 'ignore', 'ignore'] }, () => {}); } catch (_) {}
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

// 禁用未使用的 Chromium 子系统以加速浏览器进程初始化。
// 每个 disabled feature 都避免在启动时加载其服务实现，省 20-100ms。
// 这些功能 SXSEditor 均不使用：内置翻译、Cast 发现、Dial 媒体路由、
// 扩展系统、自动填充服务器通信、证书验证器后台任务。
app.commandLine.appendSwitch('disable-features', [
  'Translate',
  'MediaRouter',
  'DialMediaRouteProvider',
  'Extensions',
  'AutofillServerCommunication',
  'CertificateVerifier',
].join(','));
// Disable background throttling & renderer backgrounding so audio playback
// keeps running smoothly when the window is occluded/minimized. Audio
// editors commonly need this to prevent glitched playback during background
// operation.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

if (require('electron-squirrel-startup')) {
  app.quit();
}

// ---- CLI 调试模式 ----
// 检测 --cli 标志，进入命令行调试模式（跳过 GUI/窗口/IPC 注册）。
// agent 可通过 `electron . --cli <command>` 验证功能并查看日志。
if (process.argv.includes('--cli')) {
  // CLI 模式不获取单实例锁（agent 可能并行触发多个命令）
  const { runCli } = require('./main/cli');
  app.whenReady().then(async () => {
    let exitCode = 0;
    try {
      exitCode = await runCli(process.argv.slice(2));
    } catch (e) {
      process.stderr.write(`[CLI FATAL] ${e.stack || e.message}\n`);
      exitCode = 1;
    }
    // app.exit() 立即退出，不触发 before-quit 清理（CLI 命令自行 dispose 管线）
    try { app.exit(exitCode); } catch (_) { process.exit(exitCode); }
  }).catch((err) => {
    process.stderr.write(`[CLI FATAL] app.whenReady failed: ${err.stack || err.message}\n`);
    app.exit(1);
  });
  // 阻止后续 GUI 启动代码执行（CLI 模式只走 whenReady 分支）
  module.exports = {};
  return;
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// ---- Only splashManager is required at top level (needed for createSplashWindow) ----
// All other light modules (windowManager, locale, settings, gpuInfo, etc.)
// are deferred to inside app.whenReady() AFTER createSplashWindow() so they
// don't block the critical path to "splash visible". They're declared as
// `let` here and assigned in STEP 1.5 below.
const {
  createSplashWindow,
  closeSplashWindow,
  getSplashReadyAt,
  waitForSplashReady,
  registerSplashIpc,
} = require('./main/splashManager');

// ---- Light module placeholders (assigned in STEP 1.5 inside app.whenReady) ----
let createWindow, getMainWindow, buildAppMenu, registerWindowIpc;
let loadMainLocale, t;
let loadSettings, saveSettingsFile, setSettingsCachedDMLDevices;
let authorizePath, isPathAllowed;
let getModelDir;
let classifyDeviceFromName, startGPUPreload, ensureGPUInfo, detectAllHardware;
let checkAndDownloadModels, registerModelDownloadIpc;
let registerThemeIpc;
let registerSingerIpc;
let registerAudioIpc;
let registerDialogIpc;
let registerWebnnIpc;
let registerUpdateIpc, cleanupInstallerTempFiles;

// ---- Heavy module exports (assigned inside app.whenReady, AFTER splash) ----
// These modules transitively load onnxruntime-node (a native addon that
// takes hundreds of ms to load). Deferring their require() until after
// the splash window is created lets the splash appear immediately at
// app startup, while the heavy loads run in parallel with the main
// window's renderer loading.
let enumerateDMLDevices;
let registerSvsIpc;
let registerPitchMidiIpc;
let registerSettingsIpc;
let registerResourceManagerIpc;
let setCachedDMLDevices;
let getCachedDMLDevices;
// `reset*` functions are referenced by the before-quit handler, which
// may theoretically fire before whenReady completes (e.g. user quits
// during startup). Initialize them as no-ops so the handler is always
// safe to call; the real implementations are assigned in whenReady.
let resetSvsPipeline = () => {};
let resetRmvpe = () => {};
let resetBasicPitch = () => {};
let resetRosvot = () => {};
let resetAudioManagers = () => {};

app.on('second-instance', () => {
  // Lazy require: getMainWindow is in windowManager which is loaded in
  // STEP 1.5 inside app.whenReady(). By the time a second instance can
  // fire this event, STEP 1.5 has completed, but using lazy require keeps
  // the handler safe even if it fires during the brief init window.
  const { getMainWindow: getMainWindowLazy } = require('./main/windowManager');
  const mainWindow = getMainWindowLazy();
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

  // Splash screen is shown only in packaged builds. In dev mode the
  // main window is shown immediately — devs don't need the splash and
  // forcing it would slow down iteration.
  const showSplash = !isDev;
  // Minimum visible duration of the splash, measured from when the
  // splash's SVG actually painted. Set to 0 so the splash never
  // artificially delays startup — the main window is revealed as soon
  // as the splash has painted (see waitForSplashReady below).
  const MIN_SPLASH_MS = 0;

  // ========================================================================
  // STEP 1: Show the splash window IMMEDIATELY.
  //
  // This is the very first thing we do inside whenReady so the user sees
  // *something* (the splash's dark background + SVG) the moment Electron
  // is ready, before any heavy module loading, CSP setup, locale loading,
  // or file cleanup runs. The splash window paints its backgroundColor
  // synchronously on creation, so it's visible even before did-finish-load
  // fires for the splash itself.
  // ========================================================================
  if (showSplash) {
    createSplashWindow();
    // Yield once so the splash's did-finish-load event can be delivered
    // and the SVG can paint BEFORE STEP 1.5+2+3 block the main thread
    // for ~50-150ms. Without this yield, the user sees a dark rectangle
    // (the splash's backgroundColor) for 100-200ms before the branded
    // SVG appears. In dev mode (no splash) we call initMainSteps()
    // directly to avoid the ~5ms setImmediate overhead.
    setImmediate(initMainSteps);
  } else {
    initMainSteps();
  }

  function initMainSteps() {
  // ========================================================================
  // STEP 1.5: Require light modules + register light IPC handlers.
  //
  // These modules are NOT transitively loading onnxruntime-node, but their
  // sequential require chain (~50-100ms cumulative) was previously on the
  // critical path BEFORE app.whenReady() fired, delaying splash appearance.
  // Moving them here — AFTER createSplashWindow() — lets the splash paint
  // first in packaged mode. In dev mode (no splash) the cost is the same
  // as before, just shifted slightly later within whenReady.
  // ========================================================================
  ({
    createWindow,
    getMainWindow,
    buildAppMenu,
    registerWindowIpc,
  } = require('./main/windowManager'));
  ({ loadMainLocale, t } = require('./main/locale'));
  ({ loadSettings, saveSettingsFile, setCachedDMLDevices: setSettingsCachedDMLDevices } = require('./main/settings'));
  ({ authorizePath, isPathAllowed } = require('./main/security'));
  ({ getModelDir } = require('./main/modelDir'));
  ({
    classifyDeviceFromName,
    startGPUPreload,
    ensureGPUInfo,
    detectAllHardware,
  } = require('./main/gpuInfo'));
  ({ registerThemeIpc } = require('./main/themeIpc'));
  ({ registerSingerIpc } = require('./main/singerIpc'));
  ({ registerDialogIpc } = require('./main/dialogIpc'));
  ({ registerWebnnIpc } = require('./main/webnnIpc'));
  // audioIpc, modelDownload, updateIpc are deferred to STEP 4 because they
  // transitively load heavy Node built-ins (child_process, https, http, os,
  // stream/promises) via AudioOutputManager and modelManager. The renderer
  // does not call audio:*/model:download:*/update:* IPC at startup, so
  // deferring their registration is safe.

  // Register light IPC handlers now that their modules are loaded.
  // Heavy IPC handlers (registerSettingsIpc, registerSvsIpc,
  // registerPitchMidiIpc, registerResourceManagerIpc, registerAudioIpc,
  // registerModelDownloadIpc, registerUpdateIpc) are registered in
  // STEP 4 after their heavy transitive deps (onnxruntime-node,
  // AudioOutputManager, modelManager) are loaded.
  registerWindowIpc();
  registerDialogIpc();
  registerThemeIpc();
  registerSingerIpc();
  registerWebnnIpc();
  registerSplashIpc();

  // Register app:getVersion early — the renderer calls it immediately at
  // did-finish-load (src/renderer/index.js:30) to populate the version badge.
  // Previously this handler lived inside registerSettingsIpc(), which is
  // deferred to STEP 4 because settingsIpc.js transitively requires
  // onnxruntime-node (a native addon that takes 200-500ms to load). The
  // handler itself is trivial (just app.getVersion()) and has no heavy
  // deps, so registering it here eliminates the 200-500ms "v-" flicker
  // in the version badge that was introduced by the STEP 4 deferral.
  ipcMain.handle('app:getVersion', async () => app.getVersion());

  // ========================================================================
  // STEP 2: Fast setup (registrations only, no heavy I/O).
  // CSP + protocol handler + locale. These are all synchronous
  // registrations or fast file reads and don't materially delay the
  // main window creation that follows.
  // ========================================================================
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
    // Use path.sep to avoid prefix confusion (e.g. /home/user vs /home/userevil).
    const allowedRoot = path.resolve(modelDir);
    if (resolvedPath !== allowedRoot && !resolvedPath.startsWith(allowedRoot + path.sep)) {
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

  // loadMainLocale() must run before createWindow() because createWindow()
  // calls buildAppMenu(), which uses t() for menu labels.
  loadMainLocale();

  // ========================================================================
  // STEP 3: Create the main window (hidden) so its renderer starts loading
  // IN PARALLEL with the heavy requires in STEP 4. The renderer runs in a
  // separate process, so its loading progresses even while the main thread
  // is blocked by synchronous require() calls below.
  // ========================================================================
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
  //
  // This listener is registered BEFORE the setImmediate(Step 4) call below
  // so it never misses did-finish-load even if the renderer finishes loading
  // before Step 4 runs. The listener body only reveals the main window and
  // kicks off the auto-update check — both of which are independent of the
  // heavy modules loaded in Step 4. GPU/DML device detection has been moved
  // INTO Step 4's setImmediate block, because it depends on
  // enumerateDMLDevices / setCachedDMLDevices / getCachedDMLDevices, which
  // are assigned by Step 4's heavy require() calls.
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

    // 2. Auto update check (once per 24h, packaged only).
    //    Independent of Step 4 modules — only uses updateChecker (light)
    //    and windowManager (loaded in STEP 1.5).
    (async () => {
      try {
        const { shouldAutoCheck, checkAllUpdates, recordCheckTime, shouldShowNotification } = require('./main/updateChecker');
        const { openUpdateNotificationWindow } = require('./main/windowManager');
        const isPackaged = app.isPackaged;
        const settings = loadSettings();
        if (!shouldAutoCheck(settings, isPackaged)) return;
        const channel = settings.updateChannel || 'release';
        const result = await checkAllUpdates(channel);
        // Only record check time on success (no app error). If the check failed
        // (e.g. rate limited, network error), skip recording so the next launch
        // can retry instead of waiting 24h.
        if (!result.app.error) {
          await recordCheckTime();
        }
        const freshSettings = loadSettings();
        if (shouldShowNotification(result.app, result.models, freshSettings, false)) {
          openUpdateNotificationWindow(result);
        }
      } catch (err) {
        console.warn('[Main] Auto update check failed:', err.message);
      }
    })();
  });

  // ========================================================================
  // STEP 4: Heavy module loading + IPC registration + GPU detection.
  //
  // These require() calls load onnxruntime-node (a native addon) and its
  // transitive dependencies, which can take hundreds of milliseconds.
  //
  // Wrapped in setImmediate so the did-finish-load event (which is queued
  // when the renderer finishes loading) can be delivered to the listener
  // above BEFORE this heavy synchronous block runs. Otherwise the heavy
  // require() chain would block the event loop and delay did-finish-load
  // delivery —推迟主窗口 show() 直到 Step 4 完成，浪费数百毫秒。
  //
  // Safety: the renderer does not invoke any heavy IPC (svs:init,
  // settings:getDMLDevices, etc.) immediately after did-finish-load —
  // those calls are triggered by user interaction, which happens far
  // later than this setImmediate. Verified in src/renderer/index.js:
  // post-did-finish-load work is just getAppVersion + initWindowTheme +
  // hydrateIcons + updateProjectSettings + refreshAll (all light IPC).
  // ========================================================================
  setImmediate(() => {
    ({ enumerateDMLDevices } = require('./inference/pipeline'));
    ({
      registerSvsIpc,
      resetSvsPipeline,
    } = require('./main/svsIpc'));
    ({
      registerPitchMidiIpc,
      resetRmvpe,
      resetBasicPitch,
      resetRosvot,
    } = require('./main/pitchMidiIpc'));
    ({
      registerSettingsIpc,
      setCachedDMLDevices,
      getCachedDMLDevices,
    } = require('./main/settingsIpc'));
    ({ registerResourceManagerIpc } = require('./main/resourceManagerIpc'));
    // audioIpc/modelDownload/updateIpc were moved here from STEP 1.5 to
    // avoid loading their heavy transitive deps (AudioOutputManager →
    // child_process/fs; modelManager → https/http/os/stream-promises/
    // child_process/url; updateChecker → same as modelManager) on the
    // critical path before createWindow(). The renderer does not call
    // audio:*/model:download:*/update:* IPC at startup.
    ({ registerAudioIpc, resetAudioManagers } = require('./main/audioIpc'));
    ({ checkAndDownloadModels, registerModelDownloadIpc } = require('./main/modelDownload'));
    ({ registerUpdateIpc, cleanupInstallerTempFiles } = require('./main/updateIpc'));

    // Register the heavy IPC handlers now that their modules are loaded.
    // These must be registered before the renderer invokes them (which
    // happens on user interaction, far after this setImmediate runs).
    registerSettingsIpc();
    registerSvsIpc();
    registerPitchMidiIpc();
    registerResourceManagerIpc();
    registerAudioIpc();
    registerModelDownloadIpc();
    registerUpdateIpc();

    // 后台执行一次性硬件检测和设备校验（原位于 did-finish-load 回调，
    // 移到此处因为它依赖 enumerateDMLDevices / setCachedDMLDevices 等
    // Step 4 重型模块的导出）。GPU 探测仅在应用完全启动后开始一次，
    // 完成后结果缓存复用，运行时不再重复检查。
    (async () => {
      try {
        // 启动一次性 GPU 信息加载（worker 两阶段：WMI 快速 → systeminformation 完整）
        startGPUPreload();
        // 等待 NPU 检测完成（需要渲染进程处理 WebNN IPC）
        const { npuAvailable } = await detectAllHardware();
        console.log(`[Main] Hardware detection complete: NPU ${npuAvailable ? 'available' : 'not available'}`);

        // DML 设备枚举（一次性，结果缓存复用，运行时不再重复探测）
        const controllers = await ensureGPUInfo();
        try {
          const devices = await enumerateDMLDevices(getModelDir(), controllers);
          setCachedDMLDevices(devices);
          setSettingsCachedDMLDevices(devices);
          console.log(`[Main] GPU device detection complete: ${devices.length}  device(s)`);
        } catch (err) {
          console.warn('[Main] GPU device preload failed:', err.message);
        }

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
            } else if (preferredId === undefined || preferredId === null) {
              // manual 模式但未选具体设备（preferredDeviceId 为 null/undefined）—
              // 这是不一致状态（通常由旧版本 smart/advanced 模式下保存的 null 覆盖导致），
              // silently 切换到 smart 模式，不弹 "deviceId=null not found" 误导性对话框。
              console.warn('[Main] Manual mode but preferredDeviceId is null/undefined, silently switching to smart mode');
              const newSettings = { ...settings, deviceMode: 'smart' };
              delete newSettings.preferredDeviceId;
              delete newSettings.preferredDeviceType;
              await saveSettingsFile(newSettings);
            } else {
              const found = allDevices.find(d => d.dxgiAdapterNumber === preferredId);

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

    // Clean up leftover installer .exe files from a previous in-app update.
    // Deferred to here so it doesn't delay the splash window appearing.
    // By the time the app launches again, the previous install flow has
    // finished (success or cancel), so the temp installer is no longer needed.
    // Using 'all' here reclaims disk immediately instead of waiting 7 days.
    try {
      cleanupInstallerTempFiles('all');
    } catch (err) {
      console.warn('[Main] Installer temp cleanup failed:', err.message);
    }

    // GPU 硬件探测已合并到上方 setImmediate 内（应用完全启动后一次性执行并缓存复用）。
    // Model检查延后执行，不阻塞窗口显示
    checkAndDownloadModels().catch(err => {
      console.warn('[Main] Model check failed:', err.message);
    });
  });
  } // end of initMainSteps()

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

// W1: before-quit cleanup must run asynchronously. resetAudioManagers() →
// AudioOutputManager.destroy() → worker.kill() sends a signal that terminates
// the native audio worker asynchronously; if the app exits immediately the
// OS reclaims device handles lazily. We prevent the default quit, run the
// cleanup, and give it a bounded grace period (1500ms) so a hung worker
// cannot block exit forever, then force-exit. A guard prevents re-entry
// when before-quit fires multiple times.
let _isQuitting = false;
app.on('before-quit', (event) => {
  if (_isQuitting) return;
  _isQuitting = true;
  event.preventDefault();
  const cleanup = async () => {
    try {
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
    } catch (err) {
      console.warn('[Main] before-quit cleanup error:', err.message);
    }
  };
  // Race the cleanup against a bounded timeout so a hung worker does not
  // keep the app alive indefinitely.
  Promise.race([
    cleanup(),
    new Promise(resolve => setTimeout(resolve, 1500)),
  ]).then(() => {
    app.exit(0);
  });
});

// Light IPC handlers used to be registered here at top-level, but they
// have been moved into STEP 1.5 inside app.whenReady() (after
// createSplashWindow) so the splash window appears first in packaged
// mode. See STEP 1.5 above for the actual registrations.
