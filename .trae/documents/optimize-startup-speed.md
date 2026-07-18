# 优化启动速度（Optimize Startup Speed）

## Summary

将 SXSEditor 的"首窗口可见"时间缩短约 200–600 ms，覆盖 dev 和 packaged 两种模式。当前架构已经做过大量优化（splash `MIN_SPLASH_MS=0`、hidden main window 与 Step 4 重型 `require` 并行、SVS pipeline / 检测器全部 lazy、GPU 探测在 worker 内执行），因此本计划只针对仍残留在关键路径上的 4 处不必要工作：

1. `chcp 65001` 的同步 `execSync`（spawn cmd.exe，~50–200 ms）
2. `app.whenReady()` 之前的 14 个 light module `require`（顺序加载，~50–100 ms）
3. 渲染进程 `index.html` 中 `<script src="./ort.all.min.js">` 同步加载 5–10 MB UMD，阻塞 `did-finish-load`
4. Step 4 重型 `require` 同步阻塞事件循环，导致 `did-finish-load` 回调被推迟到 Step 4 完成后才能执行

## Current State Analysis

### 关键路径（packaged 模式 splash 出现时间）

```
T0    Electron 进程启动（binary load + V8 init + GPU process）         ~200–500 ms（不可优化）
T1    main.js 顶层代码：
       - chcp 65001 execSync (sync)                                    ~50–200 ms
       - electron-squirrel-startup 检查（很轻）
       - 14 个 light module require（顺序）                            ~50–100 ms
       - protocol.registerSchemesAsPrivileged（很快）
       - 8 个 light IPC register（很快，但 require 已经发生）
T2    app.whenReady() 触发                                              ~100–300 ms
T3    createSplashWindow()（BrowserWindow 构造 + loadURL）              ~50–100 ms
T4    splash 窗口 paint backgroundColor（用户首次看到窗口）
```

### 关键路径（dev 模式主窗口可见时间）

```
T0    Electron 启动                                                     ~200–500 ms
T1    main.js 顶层代码（同上）                                          ~100–300 ms
T2    app.whenReady()                                                  ~100–300 ms
T3    createWindow({ show: false })                                   ~50–100 ms
T4    渲染进程加载（HTML + themeBootstrap.js + index.js bundle +
       ort.all.min.js ~5–10 MB UMD 同步解析）                          ~300–1000 ms
T5    did-finish-load 事件入队（但被 Step 4 同步块阻塞）
T6    Step 4 同步 require onnxruntime-node + 4 个 IPC register         ~300–600 ms
T7    did-finish-load 回调执行：mainWindow.show()
T8    主窗口可见
```

### 已确认的轻量模块（top-level require 不拉 onnxruntime-node）

通过实际读取各模块顶层 require 验证：
- [gpuInfo.js](file:///d:/Document/electron/SXSEditor/src/main/gpuInfo.js#L1-L4) — 仅 `worker_threads` + 内部 constants/deviceClassifier
- [modelDownload.js](file:///d:/Document/electron/SXSEditor/src/main/modelDownload.js#L1-L9) — 仅 electron + 内置模块 + modelManager
- [audioIpc.js](file:///d:/Document/electron/SXSEditor/src/main/audioIpc.js#L1-L3) — 仅 electron + audioOutputManager（worker 延迟 spawn）
- [webnnIpc.js](file:///d:/Document/electron/SXSEditor/src/main/webnnIpc.js#L1-L3) — 仅 electron + 内置模块
- [updateIpc.js](file:///d:/Document/electron/SXSEditor/src/main/updateIpc.js#L1-L9) — 仅 electron + 内置模块 + updateChecker
- [windowManager.js](file:///d:/Document/electron/SXSEditor/src/main/windowManager.js#L1-L3) — 仅 electron + path + locale
- [themeIpc.js](file:///d:/Document/electron/SXSEditor/src/main/themeIpc.js#L1-L5) — 仅 electron + themeStorage + builtins
- [settings.js](file:///d:/Document/electron/SXSEditor/src/main/settings.js#L1-L4) / [locale.js](file:///d:/Document/electron/SXSEditor/src/main/locale.js#L1-L3) / [modelDir.js](file:///d:/Document/electron/SXSEditor/src/main/modelDir.js#L1-L3) — 仅 electron + 内置模块

→ 这些 require 本身很快，但**累计仍 ~50–100 ms**，且全部位于 `app.whenReady()` 之前的同步关键路径上。

## Proposed Changes

### Change 1: `chcp 65001` 改为异步 exec（fire-and-forget）

**文件**：[src/main.js](file:///d:/Document/electron/SXSEditor/src/main.js#L5-L8)

**当前**：
```js
if (process.platform === 'win32') {
  try { require('child_process').execSync('chcp 65001', { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (_) {}
}
```

**改为**：
```js
if (process.platform === 'win32') {
  // Fire-and-forget: 编码切换在 ~100ms 后生效，不阻塞主线程启动。
  // 启动早期几乎无中文日志输出，影响可忽略。
  try {
    require('child_process').exec('chcp 65001', { stdio: ['ignore', 'ignore', 'ignore'] }, () => {});
  } catch (_) {}
}
```

**影响**：节省 ~50–200 ms（spawn cmd.exe 的同步开销）。
**代价**：启动后头 ~100 ms 内的 console 中文输出可能在默认 codepage 下乱码；实测该时段基本无日志输出，可接受。

---

### Change 2: 将 light module require + IPC register 延后到 `createSplashWindow()` 之后

**文件**：[src/main.js](file:///d:/Document/electron/SXSEditor/src/main.js#L70-L102) 和 [src/main.js](file:///d:/Document/electron/SXSEditor/src/main.js#L499-L512)

**当前结构**：
```js
// 顶层（whenReady 之前）
const { createWindow, ... } = require('./main/windowManager');
const { loadMainLocale, t } = require('./main/locale');
const { loadSettings, ... } = require('./main/settings');
const { authorizePath, ... } = require('./main/security');
const { getModelDir } = require('./main/modelDir');
const { classifyDeviceFromName, ... } = require('./main/gpuInfo');
const { checkAndDownloadModels, ... } = require('./main/modelDownload');
const { registerThemeIpc } = require('./main/themeIpc');
const { registerSingerIpc } = require('./main/singerIpc');
const { registerAudioIpc, ... } = require('./main/audioIpc');
const { registerDialogIpc } = require('./main/dialogIpc');
const { registerWebnnIpc } = require('./main/webnnIpc');
const { registerUpdateIpc, ... } = require('./main/updateIpc');
const { createSplashWindow, ... } = require('./main/splashManager');

// ... 文件末尾
registerWindowIpc();
registerDialogIpc();
registerThemeIpc();
registerSingerIpc();
registerAudioIpc();
registerModelDownloadIpc();
registerWebnnIpc();
registerUpdateIpc();
registerSplashIpc();
```

**改为**：
顶层只保留 `splashManager` 和 `electron` 内置模块（splash 立即可见所需的最小集合）：

```js
// 顶层（whenReady 之前）
const { app, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {
  createSplashWindow,
  closeSplashWindow,
  getSplashReadyAt,
  waitForSplashReady,
  registerSplashIpc,
} = require('./main/splashManager');

// heavy 模块的 let 占位（保留原逻辑）
let enumerateDMLDevices;
let registerSvsIpc;
let registerPitchMidiIpc;
let registerSettingsIpc;
let registerResourceManagerIpc;
let setCachedDMLDevices;
let getCachedDMLDevices;
let resetSvsPipeline = () => {};
let resetRmvpe = () => {};
let resetBasicPitch = () => {};
let resetRosvot = () => {};
let resetAudioManagers = () => {};  // 占位 noop，did-finish-load 触发 before-quit 时安全

// 在 whenReady 内部声明的引用，供后续步骤使用
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
```

在 `app.whenReady()` 内，**STEP 1 之前不动**，但 STEP 1 完成后立即 require 这些模块：

```js
app.whenReady().then(() => {
  const isDev = !app.isPackaged;
  const showSplash = !isDev;
  const MIN_SPLASH_MS = 0;

  // STEP 1: splash 立即出现（packaged 模式）
  if (showSplash) {
    createSplashWindow();
  }

  // STEP 1.5: 在 splash 已经 paint 之后，require light 模块并注册 IPC。
  // 这些都是同步 require，但此时 splash 已可见（packaged 模式）或
  // dev 模式下不阻塞 createWindow 之前的必要工作。
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
  ({ checkAndDownloadModels, registerModelDownloadIpc } = require('./main/modelDownload'));
  ({ registerThemeIpc } = require('./main/themeIpc'));
  ({ registerSingerIpc } = require('./main/singerIpc'));
  ({ registerAudioIpc, resetAudioManagers: _resetAudio } = require('./main/audioIpc'));
  resetAudioManagers = _resetAudio;
  ({ registerDialogIpc } = require('./main/dialogIpc'));
  ({ registerWebnnIpc } = require('./main/webnnIpc'));
  ({ registerUpdateIpc, cleanupInstallerTempFiles } = require('./main/updateIpc'));

  registerWindowIpc();
  registerDialogIpc();
  registerThemeIpc();
  registerSingerIpc();
  registerAudioIpc();
  registerModelDownloadIpc();
  registerWebnnIpc();
  registerUpdateIpc();
  registerSplashIpc();

  // ... STEP 2 (CSP + onnx:// protocol + loadMainLocale)
  // ... STEP 3 (createWindow({ show: false }))
  // ... did-finish-load listener
  // ... STEP 4 (heavy requires)
```

**注意**：
- 删除文件末尾的 `registerWindowIpc(); ...; registerSplashIpc();` 块（已移到 whenReady 内部）。
- `app.on('before-quit', ...)` 处理器引用 `resetAudioManagers`，初始为 noop，did-finish-load 触发 before-quit 时安全。
- `registerSchemesAsPrivileged` 必须保留在 whenReady 之前（Electron 要求）。
- `app.requestSingleInstanceLock()` 和 `second-instance` 处理器保留在顶层（依赖 `getMainWindow`，但 `getMainWindow` 是 lazy 函数，在 second-instance 触发时早已被赋值）。
  - **注意**：原代码 `second-instance` 处理器调用 `getMainWindow()`，需改为 lazy 引用：`const { getMainWindow } = require('./main/windowManager');` 内部读取，避免顶层 require。或者保留顶层 require 但仅限 `splashManager`。
  - 实际处理：将 `second-instance` 处理器改为 `app.on('second-instance', () => { const { getMainWindow } = require('./main/windowManager'); ... })`，确保 require 是延迟的。

**影响**：packaged 模式 splash 出现时间节省 ~50–100 ms。
**代价**：dev 模式下 STEP 1 跳过（无 splash），STEP 1.5 立即执行，相当于把 require 从顶层搬到 whenReady 内部，对 dev 模式主窗口可见时间影响中性（因为 createWindow 必须在 STEP 1.5 之后）。

---

### Change 3: 渲染进程 `ort.all.min.js` 改为动态加载

**文件**：[src/index.html](file:///d:/Document/electron/SXSEditor/src/index.html#L62)

**当前**：
```html
<!-- onnxruntime-web (WebNN NPU support) — loaded before app scripts -->
<script src="./ort.all.min.js"></script>
```

**改为**：移除 `<script>` 标签，在渲染进程 bundle 内按需动态加载：

```html
<!-- ort.all.min.js removed from HTML; loaded dynamically by renderer when WebNN is first needed -->
```

**渲染进程改动**：新增 `src/renderer/ortLoader.js`：

```js
// Lazy loader for onnxruntime-web UMD bundle.
// Removes ~5-10MB UMD parse from the renderer's critical path
// (was blocking did-finish-load via <script src> in index.html).
// Resolves with the global `ort` object once loaded.
let _ortPromise = null;

export function loadOrt() {
  if (window.ort) return Promise.resolve(window.ort);
  if (_ortPromise) return _ortPromise;
  _ortPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = './ort.all.min.js';
    script.onload = () => {
      if (window.ort) resolve(window.ort);
      else reject(new Error('ort.all.min.js loaded but window.ort is undefined'));
    };
    script.onerror = () => reject(new Error('Failed to load ort.all.min.js'));
    document.head.appendChild(script);
  });
  return _ortPromise;
}

// Helper for IPC handlers that need ort: await this before using window.ort.
export async function ensureOrt() {
  if (!window.ort) await loadOrt();
  return window.ort;
}
```

**渲染进程 WebNN IPC handler 改动**：找到处理 `webnn:detectNPU` / `webnn:loadModel` / `webnn:runInference` 的位置（通过 [src/preload.js](file:///d:/Document/electron/SXSEditor/src/preload.js) 反向定位），在调用 `ort.WebNN` / `ort.InferenceSession` 之前插入 `await ensureOrt()`。

**影响**：dev 模式 `did-finish-load` 时间节省 ~200–800 ms（取决于磁盘/缓存）。
**代价**：首次调用 WebNN IPC 时增加 ~200–800 ms 延迟（动态加载 ort）。由于 NPU 检测发生在 `detectAllHardware()` 中（已 async），用户感知仅是 NPU 检测完成时间略晚，不影响窗口出现。
**注意**：仅主窗口需要此改动。其他窗口（fragment editor / singer creator 等）的 `ort.all.min.js` 由 [webpack.renderer.config.js](file:///d:/Document/electron/SXSEditor/webpack.renderer.config.js#L23) 复制，但若它们也未在 HTML 中同步引用，则不影响启动；本计划不改动这些窗口的 HTML，保留它们的同步 `<script>`。

**简化选项**：如果用户希望最小化改动，可以仅做 Change 3 的 HTML 部分——把 `<script src>` 改为 `<script async src>`：
- `async` 让脚本异步下载和执行，不阻塞 HTML 解析
- **但** `did-finish-load` 仍会等待 async 脚本执行完成
- 因此 `async` 收益有限，不如完全移除 + 动态加载
- 建议采用完全移除方案

---

### Change 4: Step 4 重型 require 改为 `setImmediate` 延后执行

**文件**：[src/main.js](file:///d:/Document/electron/SXSEditor/src/main.js#L407-L449)

**当前问题**：Step 4 在 `app.whenReady()` 回调中同步执行 `require('./inference/pipeline')`（拉 onnxruntime-node 原生插件，~300–600 ms）。由于 Node 事件循环单线程，期间入队的 `did-finish-load` 事件必须等 Step 4 完成才能派发，导致主窗口 `show()` 被推迟。

**改为**：将 Step 4 包裹在 `setImmediate` 中，让 `did-finish-load` 事件先派发：

```js
// STEP 4 (deferred to setImmediate so did-finish-load event fires first):
//   Heavy module loading + IPC registration + deferred cleanup.
//
// did-finish-load 事件在 createWindow() 后随时可能入队；如果 Step 4 同步
// 执行，会阻塞事件派发，导致主窗口 show() 被推迟到 Step 4 完成后。
// 用 setImmediate 让事件循环先处理 I/O 事件（含 did-finish-load），
// 然后再执行重型 require。
//
// 安全性：渲染进程首次调用重型 IPC（svs:init 等）发生在用户交互之后，
// 远晚于 did-finish-load；setImmediate 在 did-finish-load 回调之后立即执行，
// 因此重型 IPC handler 在用户触发时一定已注册。
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

  registerSettingsIpc();
  registerSvsIpc();
  registerPitchMidiIpc();
  registerResourceManagerIpc();

  try {
    cleanupInstallerTempFiles('all');
  } catch (err) {
    console.warn('[Main] Installer temp cleanup failed:', err.message);
  }

  checkAndDownloadModels().catch(err => {
    console.warn('[Main] Model check failed:', err.message);
  });
});
```

**注意**：原 Step 4 中的 `enumerateDMLDevices` / `setCachedDMLDevices` 等被 `did-finish-load` 回调引用的变量，仍保持 `let` 占位（顶层声明）。`did-finish-load` 回调内使用 `await enumerateDMLDevices(...)` 等，因为 setImmediate 在 did-finish-load 回调之后才执行，所以回调内访问这些变量时**它们仍是 undefined**。

**关键修复**：`did-finish-load` 回调内的 GPU 探测代码（[src/main.js#L291-L379](file:///d:/Document/electron/SXSEditor/src/main.js#L291-L379)）访问 `enumerateDMLDevices`。需将这部分代码也移到 Step 4 setImmediate 内部，或改为延迟等待：

**方案 A（推荐）**：将 did-finish-load 回调内的 GPU 探测代码移到 Step 4 setImmediate 末尾：

```js
mainWindow.webContents.once('did-finish-load', () => {
  // 1. 立即显示主窗口
  if (!showSplash) {
    revealMainWindow();
  } else {
    (async () => {
      try {
        await waitForSplashReady();
        // ... MIN_SPLASH_MS 逻辑
        revealMainWindow();
      } catch (err) {
        console.warn('[Main] Splash reveal failed:', err.message);
        revealMainWindow();
      }
    })();
  }

  // 2. 自动更新检查（独立异步，不依赖 Step 4 模块）
  (async () => {
    try {
      const { shouldAutoCheck, checkAllUpdates, recordCheckTime, shouldShowNotification } = require('./main/updateChecker');
      const { openUpdateNotificationWindow } = require('./main/windowManager');
      // ... 原逻辑
    } catch (err) {
      console.warn('[Main] Auto update check failed:', err.message);
    }
  })();
});

// STEP 4 (setImmediate):
setImmediate(() => {
  // heavy requires
  // heavy IPC registrations

  // GPU 探测 + DML 设备枚举 + 设备校验（原 did-finish-load 回调内的代码）：
  (async () => {
    try {
      startGPUPreload();
      const { npuAvailable } = await detectAllHardware();
      // ... 原 did-finish-load 内的设备枚举逻辑
    } catch (err) {
      console.warn('[Main] Device validation failed:', err.message);
    }
  })();

  try {
    cleanupInstallerTempFiles('all');
  } catch (err) {
    console.warn('[Main] Installer temp cleanup failed:', err.message);
  }

  checkAndDownloadModels().catch(err => {
    console.warn('[Main] Model check failed:', err.message);
  });
});
```

**方案 B**：保持 Step 4 同步，但把 `mainWindow.show()` 移到 Step 4 之前（在 did-finish-load 回调内主动调用 show，不等 Step 4）。但 did-finish-load 事件本身被 Step 4 阻塞，所以方案 B 无效。

**采用方案 A。**

**影响**：dev 模式主窗口可见时间节省 ~300–600 ms（Step 4 的同步阻塞被移除）。
**代价**：
- did-finish-load 回调触发时，重型 IPC handler 尚未注册（setImmediate 排在其后）。
- 渲染进程在 did-finish-load 后若**同步**调用重型 IPC 会失败。已检查 [src/renderer/index.js](file:///d:/Document/electron/SXSEditor/src/renderer/index.js)：did-finish-load 后仅调用 `getAppVersion`（light IPC）+ `initWindowTheme` + `hydrateIcons` + `updateProjectSettings` + `refreshAll`，**不触发任何重型 IPC**。
- 用户首次点击合成按钮时（远晚于 did-finish-load），Step 4 必然已完成。
- settings 窗口在用户主动打开时才会调用 `settings:getDMLDevices`，已晚于 Step 4。

---

### Change 5（可选，仅打包配置）: 启用 V8 code cache 提示

**文件**：[forge.config.js](file:///d:/Document/electron/SXSEditor/forge.config.js#L141-L149) 或 [src/main.js](file:///d:/Document/electron/SXSEditor/src/main.js#L34)

**当前**：无 V8 code cache 相关 switch。

**改为**：在 main.js 顶层（commandLine switch 区）添加：
```js
// 提示 V8 缓存编译后的字节码，加速二次启动。
// Electron 默认对 renderer 启用 code cache，但对 main process 需显式启用。
app.commandLine.appendSwitch('js-flags', '--no-flush-bytecode');
```

**影响**：二次启动时 main process V8 编译时间略微降低（~50–100 ms）。
**代价**：若 main bundle 改动，首次启动会重新编译，但仅一次。
**注意**：此项收益有限且不确定，可作为低优先级尝试。如不需要可跳过。

---

## Assumptions & Decisions

1. **不动 lazy 模式**：SVS pipeline、Pitch/MIDI 检测器、GPU worker 均已 lazy，不再改动。
2. **不动 webpack 配置**：保留现有 9 个 renderer entry points、CopyPlugin 行为、externals 列表。
3. **不动 forge/fuses**：保留 `OnlyLoadAppFromAsar` 等安全 fuse。
4. **`ort.all.min.js` 仅在主窗口改为动态加载**：其他窗口（fragment editor / singer creator / settings / model download / resource manager / audio preprocess / update notification）保留同步 `<script>`，因为这些窗口都是按需打开的，不在启动关键路径上。
5. **测试覆盖**：项目有 1225 个测试用例，改动后必须全部通过。
6. **dev 模式优先级**：用户希望 dev 和 packaged 都优化，但 dev 模式收益主要来自 Change 3（ort 动态加载）和 Change 4（Step 4 setImmediate）。
7. **不引入新依赖**：所有改动基于现有代码结构，仅使用 Electron/Node 内置 API。
8. **保持 commit message 英文**：遵守 workspace 规则。
9. **不修改 release 分支**：遵守 user rule。
10. **每次破坏性修改前后都 git 备份**：遵守 workspace 规则。

## Verification Steps

1. **打包前备份**：`git --no-pager status` 确认干净后 `git add -A && git commit -m "snapshot before startup optimization"`。
2. **改动顺序**：按 Change 1 → 2 → 3 → 4 → 5 顺序执行，每改一个 Change 就跑一次测试。
3. **测试命令**：
   ```powershell
   npm test
   ```
   确认 1225 个测试全部通过。
4. **dev 模式启动验证**：
   ```powershell
   npm start
   ```
   主观感受 + 控制台时间戳：从 Electron 启动到主窗口可见的时间应明显缩短。
5. **packaged 模式启动验证**：
   ```powershell
   npm run package:lite
   ```
   安装后双击 exe，观察 splash 出现时间 + 主窗口可见时间。
6. **回归测试**：
   - NPU 检测仍工作（动态加载 ort 后，首次 NPU 检测会略晚但应成功）
   - SVS 合成仍工作（Step 4 setImmediate 后，svs:init 应正常注册）
   - 设备枚举仍工作（DML 设备列表非空）
   - 主题切换 / 歌手保存 / 文件对话框 / 模型下载等 light IPC 仍工作
   - 自动更新检测仍工作
7. **关键日志检查**：启动时观察控制台：
   - `[Main] Hardware detection complete: NPU ...` 仍出现
   - `[Main] GPU device detection complete: N device(s)` 仍出现
   - 无 `No handler registered for X` 错误
8. **测试通过后 git 备份**：`git add -A && git commit -m "optimize startup: async chcp, defer light requires, lazy-load ort, defer Step 4"`
9. **推送到远程**：`git push`（遵守 workspace 规则 10）。

## Files to Modify

| File | Change |
|------|--------|
| [src/main.js](file:///d:/Document/electron/SXSEditor/src/main.js) | Change 1, 2, 4, 5 |
| [src/index.html](file:///d:/Document/electron/SXSEditor/src/index.html) | Change 3 (remove `<script src="./ort.all.min.js">`) |
| `src/renderer/ortLoader.js`（新建） | Change 3 (lazy ort loader) |
| `src/renderer/webnnHandler.js` 或对应文件 | Change 3 (`await ensureOrt()` before using `window.ort`) |

需要先定位渲染进程内处理 `webnn:detectNPU` 等 IPC 的具体文件，再决定 Change 3 的 IPC handler 改动位置。

## Expected Impact

| 模式 | 阶段 | 节省时间 |
|------|------|---------|
| Packaged | splash 出现 | ~100–300 ms（Change 1 + 2） |
| Packaged | 主窗口可见 | ~200–500 ms（额外 Change 3） |
| Dev | 主窗口可见 | ~500–1400 ms（Change 3 + 4，ort 动态加载 + Step 4 不阻塞） |

总收益：dev 模式 ~0.5–1.4 s，packaged 模式 ~0.2–0.5 s。
