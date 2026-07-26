# 优化启动速度 v2

## Summary

延续上一会话的启动优化工作。上一会话已应用 4 项改动（`chcp` 异步化、轻量 require 延后、`ort.all.min.js` 懒加载、STEP 4 `setImmediate` 包装），改动已在工作区但**尚未提交**（`git status` 显示 `src/main.js`、`src/index.html`、`src/inference/webnn/ortSetup.js` 三个文件 modified）。

本次基于对启动链路的二次审计，识别出 **5 个新的高价值优化点**，其中 **1 个是上一会话引入的回归 bug**（`app:getVersion` IPC 延迟注册导致版本号闪烁），**1 个是 splash 黑屏问题**（splash 创建后主线程立即被 STEP 1.5+2+3 阻塞，splash 的 `did-finish-load` 事件无法及时派发，导致 100-200ms 的"纯色矩形"期）。

最终一并提交所有改动（含上一会话的 Changes 1-4）。

## Current State Analysis

### 已在工作区但未提交的改动（baseline，不再修改）

| 文件 | 改动 | 状态 |
|------|------|------|
| `src/main.js` | Change 1: `chcp` 改 `exec`；Change 2: 顶层 require 改 `let` 占位 + STEP 1.5 内赋值；Change 4: `did-finish-load` 精简 + STEP 4 `setImmediate` | modified |
| `src/index.html` | Change 3: 移除同步 `<script src="./ort.all.min.js">` | modified |
| `src/inference/webnn/ortSetup.js` | Change 3: 新增 `loadOrtScript()` 动态注入 | modified |

### 启动链路二次审计发现的 5 个新问题

| ID | 问题 | 影响 | 受影响模式 |
|----|------|------|------------|
| G2 | `app:getVersion` IPC 处理器在 STEP 4 才注册（`registerSettingsIpc()` 内），渲染进程在 `did-finish-load` 立即调用 → 调用挂起 200-500ms → 版本号显示 `v-` 闪烁 | **回归 bug**，上一会话 STEP 4 延后引入 | dev + packaged |
| B2 | splash 创建后立即执行 STEP 1.5（13 个 `require`）+ STEP 2（CSP/locale）+ STEP 3（`createWindow`），主线程被阻塞 50-150ms，期间 splash 的 `did-finish-load` 事件无法派发 → 用户看到纯色矩形而非品牌 splash | 100-200ms "黑矩形" | packaged |
| C3/C4/C5 | `audioIpc.js`、`modelDownload.js`、`updateIpc.js` 在 STEP 1.5 顶层 require，分别拉入 `AudioOutputManager`（→ `child_process`/`fs`）、`modelManager.js`（→ `https`/`http`/`os`/`stream/promises`/`child_process`/`url`）、`updateChecker.js`（→ 同 modelManager 的重依赖） | 30-100ms 多余 require 在关键路径上 | dev + packaged |
| E3 | 所有 `BrowserWindow` 的 `webPreferences` 未设 `spellcheck: false`，Chromium 在每个渲染进程启动时加载拼写检查字典 | 10-50ms/渲染进程 | dev + packaged |
| J2 | 未通过 `app.commandLine.appendSwitch('disable-features', ...)` 禁用未使用的 Chromium 子系统（Translate、MediaRouter、DialMediaRouteProvider、Extensions 等） | 20-100ms | dev + packaged |

### 验证过的关键事实

1. **渲染进程启动期只调用 2 个 IPC**（已 grep `src/renderer/index.js` + `src/renderer/ipHandlers.js` + `src/themes/themeInit.js`）：
   - `app:getVersion`（G2 回归，需修）
   - `theme:bootstrap` / `theme:get` / `theme:onChanged`（在 `themeIpc.js`，已在 STEP 1.5 注册，✓）
2. **渲染进程启动期不调用** `audio:*`、`model:download:*`、`update:*`、`svs:*`、`extractF0:*`、`extractMidi:*`、`resmgr:*`（已 grep `src/renderer/`，仅 `ipcHandlers.js:227` 一处 `console.warn` 引用 chunk audio，非 IPC 调用）→ 可以安全延后注册这些 IPC
3. **`app:getVersion` 处理器实现极简**（`src/main/settingsIpc.js:177-179`）：仅 `return require('electron').app.getVersion();`，无重依赖
4. **`settingsIpc.js` 顶层重依赖来源**（`src/main/settingsIpc.js:1-8`）：`../inference/pipeline`（→ `onnxruntime-node`）、`./svsIpc`、`./pitchMidiIpc` — 这些是 `registerSettingsIpc` 必须延后的根因；但 `app:getVersion` 处理器本身不需要它们
5. **splash 已用 `show: true` + `backgroundColor: '#14141f'`**（`src/main/splashManager.js:99,106`），纯色矩形立即绘制；但 SVG 需要 `did-finish-load` 派发后才绘制
6. **`createWindow` 调用 `buildAppMenu`**，后者用 `t()`（来自 `./locale`），所以 `loadMainLocale()` 必须在 `createWindow` 之前

## Proposed Changes

### Change 1: 修复 G2 回归 — `app:getVersion` 提前注册

**文件:** `src/main.js`、`src/main/settingsIpc.js`

**What:** 
- 在 `src/main/settingsIpc.js` 中删除 `app:getVersion` 处理器（line 177-179）
- 在 `src/main.js` 的 STEP 1.5 末尾直接注册一个独立的 `app:getVersion` 处理器：

```js
// Register app:getVersion early — renderer calls it at did-finish-load
// and the handler is trivial (just app.getVersion()). Previously it was
// inside registerSettingsIpc() which is deferred to STEP 4 because
// settingsIpc.js transitively requires onnxruntime-node. Moving it here
// eliminates the 200-500ms "v-" flicker in the version badge.
ipcMain.handle('app:getVersion', async () => app.getVersion());
```

**Why:** `app:getVersion` 处理器无重依赖，但当前被 `registerSettingsIpc()` 的重 require 链拖累。渲染进程 `src/renderer/index.js:30` 在模块加载时立即调用，导致版本号显示延迟 200-500ms。

**How:** 直接在 main.js STEP 1.5 注册独立处理器，从 settingsIpc.js 移除。`app` 已在 main.js 顶部 import。

**Risk:** 极低。`app.getVersion()` 是 Electron 标准 API，无副作用。需确保不重复注册（`ipcMain.handle` 重复注册会抛异常）—— `registerSettingsIpc()` 仍在 STEP 4 调用，但不再注册 `app:getVersion`。

---

### Change 2: 修复 B2 — splash 创建后 yield 一次事件循环

**文件:** `src/main.js`

**What:** 将 STEP 1.5 + STEP 2 + STEP 3 + `did-finish-load` 监听器 + STEP 4 `setImmediate` 包装进一个 `initMainSteps()` 函数，在 `createSplashWindow()` 之后用 `setImmediate(initMainSteps)` 调度（packaged 模式）或直接调用（dev 模式）：

```js
if (showSplash) {
  createSplashWindow();
  // Yield once so the splash's did-finish-load event can be delivered
  // and the SVG can paint BEFORE STEP 1.5+2+3 block the main thread
  // for ~50-150ms. Without this yield, the user sees a dark rectangle
  // (the splash's backgroundColor) for 100-200ms before the branded
  // SVG appears.
  setImmediate(initMainSteps);
} else {
  // Dev mode: no splash, no yield — start main steps immediately.
  initMainSteps();
}

function initMainSteps() {
  // STEP 1.5: light requires + light IPC register
  // STEP 2: CSP / protocol / loadMainLocale
  // STEP 3: createWindow({ show: false })
  // did-finish-load listener registration
  // STEP 4: setImmediate(() => { heavy requires + heavy IPC + GPU detection })
}
```

**Why:** splash 的 `did-finish-load` 事件在 splash 渲染进程加载完成时由 Chromium 入队，但必须等主线程 yield 后才能派发。当前 `createSplashWindow()` 后立即执行 STEP 1.5（13 个 `require` + 9 个 `register*Ipc`）+ STEP 2 + STEP 3，主线程被阻塞 50-150ms，期间 splash 的 `did-finish-load` 卡在队列里，SVG 无法绘制 → 用户看到 100-200ms 的纯色矩形。

**How:** 
- 把当前 `app.whenReady().then(() => { ... })` 内 STEP 1.5 ~ STEP 4 的代码整体移入 `initMainSteps()` 函数
- `showSplash` 分支用 `setImmediate(initMainSteps)`，否则直接调用
- dev 模式无 splash，直接调用避免无谓的 5ms 延迟

**Risk:** 低。`setImmediate` 仅延迟一个事件循环 tick（~5ms），换来 splash SVG 提前 100-200ms 显示。需确认 `initMainSteps` 内不依赖闭包外的中间状态（当前所有变量都是 `app.whenReady` 闭包内定义的，移入嵌套函数后作用域不变）。

---

### Change 3: 延后 audioIpc / modelDownload / updateIpc 到 STEP 4

**文件:** `src/main.js`

**What:** 将以下三组从 STEP 1.5 移到 STEP 4 的 `setImmediate` 块内（与其他重 IPC 注册并列）：

```js
// 从 STEP 1.5 移除：
({ registerAudioIpc, resetAudioManagers: _resetAudio } = require('./main/audioIpc'));
resetAudioManagers = _resetAudio;
({ checkAndDownloadModels, registerModelDownloadIpc } = require('./main/modelDownload'));
({ registerUpdateIpc, cleanupInstallerTempFiles } = require('./main/updateIpc'));
// 以及对应的 register 调用：
registerAudioIpc();
registerModelDownloadIpc();
registerUpdateIpc();
```

移到 STEP 4 `setImmediate` 内，紧邻 `registerSettingsIpc()` 等重 IPC 注册。

**Why:** 
- `audioIpc.js` 顶层 `require('../audio/audioOutputManager')` → 拉 `child_process`/`fs`/`path`（10-30ms）
- `modelDownload.js` 顶层 `require('../modelManager')` → 拉 `https`/`http`/`os`/`stream/promises`/`child_process`/`url`（20-50ms）
- `updateIpc.js` 顶层 `require('./updateChecker')` → 同 modelManager 的重依赖（10-30ms，部分被 modelDownload 缓存）
- 渲染进程启动期不调用 `audio:*`/`model:download:*`/`update:*`（已验证）→ 可安全延后

**How:** 
- 注意 `cleanupInstallerTempFiles('all')` 当前在 STEP 4 内调用（`main.js:516`），依赖 `updateIpc` 的导出 → 移动后仍在同一 `setImmediate` 块内，无需额外调整
- 注意 `checkAndDownloadModels()` 当前在 STEP 4 内调用（`main.js:523`），依赖 `modelDownload` 的导出 → 同上
- 注意 `resetAudioManagers` 在 `before-quit` 处理器中被引用 → 当前已有 `let resetAudioManagers = () => {};` 占位符（`main.js:123`），STEP 4 赋值前若 `before-quit` 触发则调用空函数，安全
- 注意 `registerSplashIpc()` 必须留在 STEP 1.5（splash 渲染进程在 `did-finish-load` 时立即调用 `splash:getBuildInfo` + `splash:getIconDataUrl`）

**Risk:** 中。需确认无任何渲染进程在 `did-finish-load` 时立即调用 `audio:*`/`model:download:*`/`update:*`（已 grep 验证，仅 `ipcHandlers.js:227` 一处 `console.warn` 引用 chunk audio，非 IPC 调用）。

---

### Change 4: 所有 BrowserWindow 添加 `spellcheck: false`

**文件:** `src/main/windowManager.js`、`src/main/splashManager.js`

**What:** 在所有 `new BrowserWindow({...})` 的 `webPreferences` 中添加 `spellcheck: false`。

需修改的 `BrowserWindow` 构造点（按文件）：
- `src/main/windowManager.js`：`createWindow`（mainWindow）、`openSettingsWindow`、`openResourceManagerWindow`、`openModelDownloadWindow`、`openUpdateNotificationWindow`、`openFragmentEditor`、`openSingerCreatorWindow`、`openAudioPreprocessWindow`（共 8 处）
- `src/main/splashManager.js`：`createSplashWindow`（1 处）

```js
webPreferences: {
  preload: XXX_PRELOAD_WEBPACK_ENTRY,
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: false,
  spellcheck: false,  // <-- 新增：禁用拼写检查，省 10-50ms/渲染进程
},
```

**Why:** Chromium 默认在每个渲染进程启动时加载拼写检查字典（Hunspell），即使应用无文本输入框也会初始化。SXSEditor 是音频编辑器，无文本编辑场景（仅少量 `<input>` 用于 BPM/数值输入，不需要拼写检查）。禁用可省 10-50ms/渲染进程。

**How:** 全局 `webPreferences.spellcheck: false`。Electron 官方文档明确支持此选项。

**Risk:** 极低。应用内无依赖拼写检查的功能。

---

### Change 5: 禁用未使用的 Chromium 子系统

**文件:** `src/main.js`

**What:** 在 `src/main.js` 顶部（`app.commandLine.appendSwitch('enable-features', ...)` 附近）添加：

```js
// Disable unused Chromium subsystems to speed up browser-process init.
// Each disabled feature avoids loading its service implementation at startup.
app.commandLine.appendSwitch('disable-features', [
  'Translate',                    // 内置翻译服务（应用内不需要）
  'MediaRouter',                   // Cast/媒体路由发现
  'DialMediaRouteProvider',        // Dial 协议媒体路由
  'Extensions',                    // 扩展系统（Electron 应用不用）
  'AutofillServerCommunication',   // 自动填充服务器通信
  'CertificateVerifier',           // 证书验证器后台任务（应用不做 HTTPS 服务器）
].join(','));
// Disable background throttling & renderer backgrounding so audio playback
// keeps running smoothly when the window is occluded/minimized.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
```

**Why:** Chromium 在浏览器进程启动时会初始化一系列子系统（翻译、Cast 发现、扩展、自动填充等），即使用户不会用到。禁用这些 feature flag 可省 20-100ms 的浏览器进程初始化时间。`disable-background-timer-throttling` 等三项确保音频播放不被后台节流（音频编辑器的常见痛点）。

**How:** `app.commandLine.appendSwitch` 必须在 `app.whenReady()` 之前调用（当前 `enable-features` 已在 line 38 调用，新加的紧随其后）。

**Risk:** 低。`Translate`/`MediaRouter`/`DialMediaRouteProvider`/`Extensions`/`AutofillServerCommunication`/`CertificateVerifier` 都是 SXSEditor 不使用的功能。`disable-background-timer-throttling` 等是音频应用的常见优化。需测试确保不影响：
- 主窗口渲染
- 模型下载（用 `https` + `net.fetch`，不依赖上述 feature）
- 自动更新检查（同上）

---

### Final Step: 测试 + 提交 + 推送

**What:** 
1. 运行 `npm test` 确保 1213 个测试全通过
2. 运行 `npm run lint`（预期仍有 2 个 pre-existing errors 在 `src/inference/webnn/diffusion.js:209-210`，与本优化无关，由 commit `8f01f09` 引入）
3. 暂存本次涉及的文件：
   ```
   git add src/main.js src/index.html src/inference/webnn/ortSetup.js src/main/windowManager.js src/main/splashManager.js src/main/settingsIpc.js
   ```
4. 提交（英文 message，遵守 workspace rule 1/2/11）：
   ```
   optimize startup v2: fix app:getVersion regression, yield for splash paint, defer audio/model/update IPC, disable spellcheck & unused Chromium features
   ```
5. 推送到远程（workspace rule 10）

**Why:** 遵守 workspace rules 4（破坏性修改前备份）、6（测试通过后 git 备份）、10（确认功能完成后提交到远程）。

**注意:** 不要 `git add -A` —— 工作区还有 `src/fragmentEditor/audioPlayback.js` 的未提交改动（与启动优化无关，是上一会话遗留的 diffStep chunking 实验）。

## Assumptions & Decisions

### Assumptions
1. 上一会话的 Changes 1-4 已通过测试（1213 passing），作为本次 baseline 不再修改
2. `app.getVersion()` 在 `app.whenReady()` 后立即可用，无需等待其他初始化
3. splash 渲染进程加载时间 < 100ms（splash.html 仅 28 行 inline CSS + 1 个 div，splash.js 极简），`setImmediate` yield 后 `did-finish-load` 会在下一个 tick 派发
4. 渲染进程启动期不调用 `audio:*`/`model:download:*`/`update:*` IPC（已 grep 验证）

### Decisions
1. **不重构 settingsIpc.js 的重依赖**（如把 `require('../inference/pipeline')` 改为 handler 内懒加载）—— 风险高、改动面大，超出本次优化范围。仅提取 `app:getVersion` 这一个无依赖处理器。
2. **不动 STEP 4 的重 require 链本身**（onnxruntime-node 加载 200-500ms 是 native addon 本质开销，无法在 JS 层优化）。重点改为确保 IPC 处理器在重 require 之前注册（Change 1）+ splash 能在重 require 之前绘制（Change 2）。
3. **不做 V8 code cache / startup snapshot 配置**（J1）—— Forge 的 FusesPlugin 不直接支持，需要自定义构建步骤，ROI 低，跳过。
4. **不动 babel-loader 配置**（K1）—— 涉及 webpack 构建配置变更，可能影响产物大小和兼容性，超出本次范围。
5. **不拆分 preload.js**（L2）—— 当前 9 个渲染窗口中只有 mainWindow 在启动关键路径上，其他窗口的 preload 开销不在启动期体现。

## Verification Steps

1. `npm test` —— 必须 1213 passing（与 baseline 一致）
2. `npm run lint` —— 预期 2 errors / 257 warnings（与 baseline 一致，error 均为 pre-existing 在 `diffusion.js`）
3. **手动测试 dev 模式**：`npm start`
   - 观察 splash 是否立即显示（dev 模式无 splash，主窗口应立即可见）
   - 观察主窗口版本号是否立即显示（无 `v-` 闪烁）
   - 观察主题是否快速应用（无长时间未主题化空白）
   - 打开 DevTools Console，检查无 IPC 调用超时警告
4. **手动测试 packaged 模式**：`npm run package:lite`（workspace rule 7）
   - 启动应用，观察 splash 品牌图标是否在 < 200ms 内出现（而非纯色矩形）
   - splash 消失后主窗口立即显示版本号和主题
   - 测试音频播放、模型下载、自动更新检查（确认被延后的 IPC 在用户交互时正常工作）
5. `git --no-pager diff --stat` 确认改动范围符合预期
6. 测试通过后提交 + 推送

## Files Modified (Summary)

| 文件 | 改动概述 |
|------|----------|
| `src/main.js` | Change 1: 注册 `app:getVersion`；Change 2: `initMainSteps()` + `setImmediate` yield；Change 3: 移 audioIpc/modelDownload/updateIpc 到 STEP 4；Change 5: 添加 `disable-features` switches |
| `src/main/settingsIpc.js` | Change 1: 删除 `app:getVersion` 处理器（3 行） |
| `src/main/windowManager.js` | Change 4: 8 处 `BrowserWindow` 加 `spellcheck: false` |
| `src/main/splashManager.js` | Change 4: 1 处 `BrowserWindow` 加 `spellcheck: false` |

未修改但已在工作区的 baseline 文件（与本次新改动一起提交）：
- `src/index.html`（上一会话 Change 3）
- `src/inference/webnn/ortSetup.js`（上一会话 Change 3）

## Expected Impact

| 问题 | 修复前 | 修复后 |
|------|--------|--------|
| G2 版本号闪烁 | 200-500ms `v-` 闪烁 | 立即显示版本号 |
| B2 splash 黑矩形 | 100-200ms 纯色矩形 | splash SVG 在 < 50ms 内绘制 |
| C3/C4/C5 重 require 在关键路径 | 30-100ms 多余 require | 移到 STEP 4，不阻塞 splash/createWindow |
| E3 spellcheck 初始化 | 10-50ms/渲染进程 | 0ms |
| J2 Chromium 子系统初始化 | 20-100ms | 0-10ms |

**总体预期：** dev 模式启动到主窗口可见减少 ~100-300ms；packaged 模式 splash 品牌化提前 ~100-200ms，主窗口版本号立即显示。
