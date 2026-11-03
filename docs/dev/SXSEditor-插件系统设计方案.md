# SXSEditor 全应用插件系统 —— 设计方案

> **状态**：M1（纵向切片）已实现并提交（`a7109d8`、`36be137`），并通过真实 Electron
> 窗口的端到端验证（§9.1，2026-11-02）；**M2（贡献面）已实现并通过同样的实链路走查
> （§9.2，2026-11-03）**；**M3（模型调用面）第 1–3 段已落地并通过实机走查（§12，
> 2026-11-04），第 4 段（作者文档 + 示例插件）待做**；M4–M6 未开始。
> **定位**：这是一份**设计决策记录**，不是使用说明。面向插件作者的用户文档见
> [`plugins.md`](plugins.md)（v1 歌声后端契约）与插件管理器内的权限说明。
> **写作目的**：把「为什么这么设计」固定下来。后续每个里程碑都要能对着 §5 的可逆性
> 规则和 §11 的待定项做验收，避免二次大范围返工。

---

## 0. 结论先行

- **已有内核可复用**：`pluginHost.js` + `pluginWorker.js` + `pluginContract.js`（约 3k 行）
  已经实现了 manifest 校验、worker 隔离、返回值护栏、超时/取消。它不是从零开始，
  缺的是「界面 / 数据 / 计算 / 分发」四层与「卸载可逆」。
- **核心不是加功能，是加一层注册表 + 一层可处置性契约**。所有能力都从
  `PluginRegistry` 发放，登记项一律返回 `Disposable`，宿主永远能在插件不配合时自己删干净。
- **API 要小**：首批冻结 6 个原语（`command` / `panel` / `ort` / `project codec` /
  `llm` / `service`），"几乎任何事"由原语组合出来，而不是给每个功能开专用接口。
  这是控制维护面的关键。

## 1. 架构总览

```
┌─ main ───────────────────────────────────────────────┐
│ PluginService ── PluginRegistry（唯一权威）           │
│   ├ PluginInstaller  (.sxsp 校验/解压/原子替换/回滚)  │
│   ├ PluginRuntimeManager (utilityProcess × N)        │
│   ├ PluginPermissions (授权/审计/隔离名单)            │
│   ├ PluginMenu → rebuildAppMenu()                    │
│   └ PluginProtocol (plugin:// + nonce + 路径 jail)    │
└──────────┬──────────────────────────┬────────────────┘
           │ ipcMain / MessagePort    │ utilityProcess IPC
┌──────────▼──────────┐    ┌──────────▼─────────────────┐
│ renderer (9 窗口)    │    │ plugin runtime (每插件一个) │
│ PluginSurfaceRegistry│    │ ctx.api.* / ORT / fs / llm  │
│  ├ toolbar/status    │    │ 只能通过 host 注入的入口做事 │
│  ├ settings section  │    └────────────────────────────┘
│  └ iframe(plugin://) │
└──────────┬───────────┘
     postMessage（受限 method 白名单）
```

**注册状态的唯一真源在 main**。renderer 与 runtime 只持有投影；重载时 main 推全量
`plugin-host:sync`，两侧重建，不持久化。

消息统一形状 `{v:2, id, kind:'req'|'res'|'evt', method, params|result|error}`，
超时、取消、卸载后的 pending 一律 reject `PLUGIN_UNLOADED`。

## 2. Manifest v2 与包格式

```json
{
  "id": "com.example.sv2", "name": "SV2 Project Support", "version": "1.0.0",
  "apiVersion": 2, "engines": { "app": ">=2.1.0 <3.0.0" },
  "main": "main.js",
  "permissions": {
    "fs": ["pluginData", "userPicked:read"],
    "ort": ["cpu", "dml"], "net": ["api.example.com"],
    "project": ["read", "write"],
    "ui": ["menu", "panel", "toolbar", "statusBar", "contextMenu", "overlay", "settings"]
  },
  "contributes": {
    "commands":  [{ "id": "open", "title": { "en": "Open SV2…", "zh-CN": "打开 SV2…" } }],
    "menus":     [{ "path": "plugins/com.example.sv2", "command": "open" }],
    "panels":    [{ "id": "editor", "title": "SV2", "entry": "panel/index.html",
                    "apiScopes": ["project.read", "project.apply", "files.pick"] }],
    "fileTypes": [{ "ext": ".sv2", "role": "open", "filters": ["SV2 Project"] }],
    "toolbar":   [{ "command": "open", "title": "SV2", "icon": "file", "group": "project" }],
    "statusBar": [{ "id": "state", "text": "@idle", "alignment": "right",
                    "command": "open", "when": "projectOpen" }],
    "contextMenus": [{ "id": "open-in-sv2", "context": "fragment", "command": "open" }],
    "timelineOverlays": [{ "id": "grid", "entry": "overlay/index.html",
                           "anchor": "canvas", "height": 96, "when": "hasFragments" }],
    "keybindings": [{ "command": "open", "key": "Mod+Alt+O", "mac": "Cmd+Alt+O" }],
    "i18n": { "idle": { "en": "SV2 ready", "zh-CN": "SV2 就绪" } },
    "settings":  [{ "id": "general", "title": "SV2", "fields": [
                     { "key": "charset", "type": "select",
                       "options": [{ "value": "utf8", "label": "UTF-8" },
                                   { "value": "shift_jis", "label": "Shift_JIS" }] }]}],
    "pipeline":  { "hooks": [{ "stage": "postMel", "kind": "model",
                               "model": "models/declick.onnx", "order": 100 }] },
    "services":  { "provides": [{ "id": "sv2.codec", "version": "1.0.0" }] },
    "automation":{ "methods": ["open"] }
  }
}
```

- `apiVersion` 保持整数（2）；`engines.app` 用极简 semver 范围求值（不引第三方依赖）。
- `.sxsp` = zip：`manifest.json` / `main.js` / `panel/` / `locales/` / `assets/` /
  `checksums.json`（逐文件 sha256）/ `signature.json`（预留）。拒绝绝对路径、`..`、
  符号链接、超限条目与压缩炸弹；解析后校验实际解压长度 === 声明长度。
- 安装 → `<userData>/plugins/.staging/<uuid>` → 校验 → 原子 rename →
  记录 `plugins-state/registry.json`。旧版存 `.versions/<id>/<ver>` 以便回滚。
  用户数据固定 `plugin-data/<id>/`，与安装目录分离。
- 卸载：停 → 泄漏断言 → 删安装目录 → 询问"保留用户数据"→ 清 grants / 菜单 /
  快捷键 / 动态 MCP 方法 / 文件关联（Windows 写注册表的部分走 `pendingOps.json`，
  下次启动生效）。

## 3. 贡献点目录

| 贡献点 | 注册层 | 形态 | 撤销动作 |
|---|---|---|---|
| `project.open/save/import/export` | main 登记，runtime 编解码 | 声明 `fileTypes` + 代码 | 摘 dialog filter、文件关联分类、路由表项 |
| `export.audio` | main + runtime | 声明格式 + 代码 | 同上；进行中导出 `AbortSignal` 中止 |
| `menu.item` | main（native Menu） | 声明式 | 标记 dirty → `rebuildAppMenu()`（整体重建，不做增量 patch） |
| `toolbar.button` | renderer | 声明式 + command（`group` 分段，组内保持声明序） | 移除节点 + 解绑监听 |
| `panel` / `editor` | main 发 URL，renderer 挂 iframe | 声明式 | 销毁 iframe、关闭 port、nonce 失效 |
| `settings.section` | renderer | 声明式（`fields` 表单，或 `panel` 指向已注册面板） | 删节点 + 侧栏项 + 恢复 active |
| `contextMenu.item` | renderer | 声明式 | 解绑委托 |
| `statusBar.item` | renderer | 声明式占位 + 命令式改文本（`ctx.ui.status`） | 删节点 + 退订 + 清运行期文本 |
| `timeline.overlay` | renderer | 声明式（`plugin://` iframe + `when`） | 销毁 iframe + 作废 mint 的 URL |
| `command` / `keybinding` | main registry | 声明式 + 三方仲裁（见 §11.4） | 删命令、回滚快捷键冲突表 |
| `palette.intent` | main + renderer | 声明式（示例语句 + command） | 删意图表项 |
| `i18n` | renderer（字典注册）+ main（manifest 校验） | 声明式扁平字典，键前缀 `plugin.<id>.` | 注销字典 + 清 `_tCache`；文案回退为字面量 |
| `pipeline.preEncoder` / `postMel` / `postWaveform` | 见 §3.1 | 声明式（model）/ 命令式（js） | 从 stage 链移除，重建执行计划 |
| `synthesis.backend` | main（复用 trackKinds） | 声明式 | 从 `findTrackKind` 结果消失 |
| `ort.runner` | runtime，宿主注入 ORT | 命令式 | kill 进程即释放 session |
| `llm.provider` | runtime + main 路由 | 声明式元数据 + 代码 | 删 provider，关流式订阅 |
| `hardware.diagnostics` | main 采集 | 只读 API | 无持久注册 |
| `service.provide/consume` | main 中介 | 声明式 | 注销端点，消费方收 `SERVICE_GONE` |
| `automation.method` | main 并入 MCP schema | 声明式 | 动态表删除，`mcpBridge` 立即不可见 |
| `notification` / `clipboard` / `secrets` | host API | 命令式 | 无持久注册；secrets 按策略清除 |

### 3.1 pipeline hook 的两种实现（重要取舍）

- **`kind: "model"`（默认，快）**：插件只声明 ONNX 与输入输出映射，宿主让
  **svsWorker 内已有的 ORT** 执行，张量不出进程。适合"接一个 MIDI 生成 / 去咔哒 /
  后置 EQ 模型"。
- **`kind: "js"`（慢，可关）**：在插件 runtime 里用 JS 处理，只对 `postWaveform`
  默认开放（Float32 用 transferList，4MB 毫秒级）。`preEncoder`/`postMel` 的 JS hook
  需要用户在插件管理器里显式开启"高开销 hook"，并受每 stage 总超时与熔断保护。

不做「每帧回调插件」这种设计——跨进程一次就是一帧的预算。

## 4. 权限模型

**在 runtime 的 host API 边界执行，是护栏不是安全边界**（插件仍可 `require('fs')`）。
这一点必须写进安装弹窗与文档，不许含糊。

| 组 | 粒度 | 执行点 |
|---|---|---|
| `fs` | `pluginData` / `userPicked:read\|write` / `models` | `runtimeFs` 路径归一化 + `isInside()` |
| `net` | 域名 allowlist | `runtimeNet`，空 allowlist = 全拒 |
| `ort` | `cpu` / `dml` / `webnn` | `ortRunner.buildSessionOptions()` |
| `project` | `read` / `write` | `project.apply` 操作白名单（复用 `mcpAutomation` 的 op 形状） |
| `ui` | `menu` / `panel` / `toolbar` / `statusBar` / `contextMenu` / `overlay` / `settings`（单数名，与 `contributes` 的复数键一一对应） | registry 登记时校验：声明了某个界面贡献却没申请对应权限，整条 manifest 拒绝装载 |
| `automation.expose` | 默认开启；可在管理器逐插件关闭 | 动态方法表；每次外部调用（MCP / CLI）写审计，含调用方标识 |
| `secrets` / `clipboard` / `notification` | 读写分权 | host API |

授权存 `plugins-state/grants.json`（含 `permissionsHash`，权限集变化必须重新弹窗）；
审计写 `logs/plugins-audit.jsonl`（install / uninstall / grant / deny / kill / leak）。
`process.spawn` 不提供，检测到子进程即 quarantine。

## 5. 可逆性（本方案的核心）

`src/shared/pluginDisposable.js`：`Disposable`、`DisposableStore`（LIFO 逆序、幂等、
dispose 后再 add 立即释放）、`AbortBucket`（每插件一个 `AbortController`，统一挂
DOM 监听与 rAF）。

每个插件一个 `PluginSession`，根 store 下挂子 store：`ipc` / `menu` / `renderer` /
`runtime` / `timers` / `services` / `watchers`。任何注册都返回 `{ token, dispose }`；
`dispose` 三件事：从 registry 删、调底层移除、写审计。

- **IPC**：**没有**每插件动态通道。插件 runtime 走 utilityProcess 的 MessagePort，
  只剩一组固定的 `plugin-host:*` 通道。这从根上消除了"卸载时忘了 removeHandler"
  这一类 bug。
- **菜单**：`PluginRegistry` 维护 `menuRevision`，任何菜单贡献变更只调
  `rebuildAppMenu()`（整体重建，不做增量 patch，根除幽灵菜单项）。
- **renderer**：`PluginSurfaceRegistry` 用 `Map<key, disposer>`；插件节点一律带
  `data-plugin-id`。
- **iframe**：`frame.remove()` + 清 `src` + nonce 失效 + 关闭面板时把 pending RPC
  全部 resolve 成 `PANEL_CLOSED`。
- **runtime**：`child.kill()`，pending RPC 全部 reject；`stop()` 先 dispose 再 kill。

### 5.1 泄漏探针（`PluginLeakProbe`，dev/test 断言，prod 记日志）

| 计数项 | 采集 | 断言 |
|---|---|---|
| ipc handler | 宿主包装器自增自减 | 卸载前后差 0 |
| Menu 项 | 递归计数 + label 集合 | 差 0 |
| `[data-plugin-id]` 节点 | 各窗口 DOM 查询 | 0 |
| 自有贡献 | `registry.stats()` 绝对值 | 0 |
| pending RPC | `pending.size` | 0 |
| utilityProcess | `runtimeManager.sessions` | 0 |
| 定时器 / objectURL / fsWatcher | 包装器计数（M2 起） | 0 |

**插件忘记 dispose 怎么办**：卸载后等 500 ms 采样，非零即 `PLUGIN_LEAK`（附
contribution id），宿主强制清理（注册表在 main，永远删得掉）；连续两次泄漏 →
`quarantined`，管理器显示原因，下次启动不自动加载。

> **实现教训（M1 踩过）**：探针最初用 before/after **差值**，于是每次卸载都误报
> 残留——撤销贡献本来就该让计数变小。现在断言的是**绝对后置条件**（自有贡献 /
> 进程 / pending RPC / DOM 全为 0），只有进程级计数器（ipc handler）才取差值。
> `test/pluginLifecycle.test.js` 里有一条"故意留一个贡献"的用例，证明探针不是恒真。

## 6. 兼容 v1

`pluginContract.js` 改为 `CURRENT_API_VERSION = 2`、`SUPPORTED = [1, 2]`，新增
`src/main/plugins/compat/v1Adapter.js`：`trackKinds` → `synthesis.backend`，
`synthesize/ getVoices` 原样暴露，`worker_threads` 换 utilityProcess 但 host 对象形状
不变，`plugin:` 通道与 `pluginAPI` 命名空间保持。v1 支持整个 2.x，管理器标注 Legacy，
3.0 移除，提前一个小版本告警。

## 7. 文件布局

**已落地（M1）**

```
src/shared/pluginApi.js               冻结的 v2 常量 / 限制 / 权限组 / 错误码
src/shared/pluginManifest.js          v2 清单校验（逐贡献点 + 极简 semver）
src/shared/pluginProtocol.js          消息编解码 + 深度受限 sanitizer
src/shared/pluginZip.js               无依赖 zip 读写（拒绝绝对路径/../软链/超限）
src/shared/pluginDisposable.js        Disposable / Store / AbortBucket
src/main/plugins/PluginService.js     编排：init / 生命周期 / 卸载顺序
src/main/plugins/PluginRegistry.js    贡献点唯一权威
src/main/plugins/PluginInstaller.js   .sxsp 校验 / staging / 原子替换 / 回滚目录
src/main/plugins/PluginRuntimeManager.js  utilityProcess 生命周期
src/main/plugins/PluginStateStore.js  registry/grants/audit/state 落盘（tmp+rename）
src/main/plugins/PluginMenu.js        Plugins 菜单片段
src/main/plugins/PluginProtocol.js    plugin:// handler、nonce、CSP、路径 jail
src/main/plugins/PluginLeakProbe.js   计数与断言
src/main/plugins/PluginIpcV2.js       11 条静态通道 + project.apply 往返
src/main/plugins/runtime/pluginRuntimeEntry.js  utilityProcess 入口 + ctx
src/main/plugins/runtime/{ortRunner,sandbox}.js  ORT / 路径沙箱
src/renderer/plugins/pluginPanelHost.js      右侧面板 + postMessage 桥 + 主题下发
src/renderer/plugins/projectApplyBridge.js   project.apply → 主窗口工程写入
src/pluginManager.html + src/pluginManager/{index.js,pluginManager.css}
plugins/example-hello/                 命令 + 面板 + 桥模板
scripts/package-plugin.js             npm run plugin:pack（zip + checksums）
```

**M2 新增（已落地）**

```
src/shared/pluginKeys.js                 快捷键规范化/匹配（主进程与渲染层共用）
src/shared/windowCapabilities.js         窗口标识 + preload 高危能力裁剪表
src/main/plugins/PluginKeybindings.js    快捷键三方仲裁（唯一仲裁点）
src/renderer/plugins/pluginHost.js       投影 / 事件总线 / 五个贡献面的编排
src/renderer/plugins/contribution{Toolbar,Status,Overlay,ContextMenu,Keybindings}.js
src/renderer/plugins/pluginText.js       本地化取值 / @key 解析 / when 求值
src/renderer/plugins/pluginToast.js      通知条
src/renderer/platformInfo.js             平台判定（Mod 显示成 Ctrl 还是 Cmd）
plugins/example-hello/overlay/           示例浮层
```

**待落地（M3–M5）**

```
src/main/plugins/compat/v1Adapter.js
src/main/plugins/PluginPermissions.js   （当前并入 Service/StateStore）
src/main/plugins/runtime/{fs,net,llmBridge,projectCodec,audio}.js
```

**修改点（精确到文件）**

| 文件 | 改动 | 状态 |
|---|---|---|
| `src/main.js` | `registerSchemesAsPrivileged` 加 `plugin`；CSP 加 `frame-src plugin:`；初始化 `PluginService`；`before-quit` 释放 | ✅ |
| `src/main/windowManager.js` | 菜单插入片段 + `rebuildAppMenu()` + `openPluginManagerWindow()` | ✅ |
| `src/shared/ipcChannels.js` | 新增 `Plugin Host v2` 组（M1 15 条 + M2 5 条：设置读写 / 快捷键开关 / 浮层 URL / 打开面板） | ✅ |
| `src/preload.js` | `pluginHost` 命名空间；能力裁剪表移到 `src/shared/windowCapabilities.js`（窗口标识按入口目录名解析，测试与 forge 入口互锁） | ✅ M2 修正 |
| `src/main/locale.js` | 菜单 7 个键 | ✅ |
| `forge.config.js` / `webpack.*.config.js` | `plugin_manager_window` 入口；runtime 目录裸拷贝 | ✅ |
| `scripts/check-ipc-channels.js` | 无裸字符串通道 | ✅ 未改（静态常量已识别） |
| `src/main/svsIpc.js` | 删除 `registerPluginIpc()` 调用 | ⬜ M3 |
| `src/renderer/projectManager.js` | 拆 `loadProjectFromDocument(doc)` | ⬜ M4 |
| `src/shared/projectFormat.js` | `validateProjectDocument(doc)` | ⬜ M4 |
| `src/main/dialogIpc.js` / `fileAssociation.js` | 过滤器与文件关联来自 registry | ⬜ M4 |
| `src/inference/pipeline/index.js` | 插入 `_runModelHooks(stage, …)` | ⬜ M3 |
| `src/settings.js` | 动态 sidebar + schema 渲染的 section（`panel` 指向给"打开插件面板"按钮） | ✅ M2 |
| `src/i18n/index.js` | `registerPluginMessages(id, dict)`，键前缀 `plugin.<id>.` | ✅ M2 |
| `src/renderer/{index,timelineRenderer,eventHandlers}.js` | 挂宿主、`app:state-changed` 广播、三处右键入口 | ✅ M2 |
| `src/pluginManager/*` | 贡献计数 + 快捷键区块（总开关 / 组合 / 仲裁结果） | ✅ M2 |
| `src/renderer/mcpAutomation.js` | 动态命令表 + `source: plugin:<id>` | ⬜ M5 |

> utilityProcess 的入口复用现有「裸拷贝 + 按路径 require」模式（与 `svsWorker.js`
> 同构）。M1 已验证 `.webpack/main/plugin-runtime/` 落位正确；
> `test/copyWebpackClosure.test.js` 是这条约定的守卫。

## 8. Plugins 菜单

```
Plugins
├─ Manage Plugins…            → openPluginManagerWindow()
├─ Install from File…         → 文件对话框 → .sxsp
├─ Reload All
├─ ───────
├─ SV2 Project Support ▸      → 该插件的命令
├─ MIDI ORT ▸
└─ Open Plugins Folder / Developer Log
```

管理器窗口（`plugin_manager_window`，900×720，独立 BrowserWindow）：列表（启用/禁用、
版本、权限、来源、状态）、安装/卸载/更新、审计与错误日志、"保留用户数据？"选项、
Legacy 标记。M2 起每个插件卡片还带贡献计数（命令/面板/工具栏/状态栏/右键/浮层）与
快捷键区块（总开关 + 每个组合的仲裁结果）。

### 8.1 M2 界面贡献点速查（插件作者视角）

| 贡献键 | 字段 | 约束 |
|---|---|---|
| `toolbar` | `id` `command` `title` `icon?` `group?` `when?` | `icon` 走内置图标名（小写/数字/连字符）；`group` 只决定分段，组内按声明序 |
| `statusBar` | `id` `text` `tooltip?` `alignment?` `command?` `when?` | `alignment` = `left` / `right`；`text` 可写 `@key` 引用 `i18n` 字典；运行期用 `ctx.ui.status()` 覆盖 |
| `contextMenus` | `id` `context` `title` `command` `when?` | `context` = `fragment` / `singer` / `canvas` |
| `timelineOverlays` | `id` `title` `entry` `anchor?` `height?` `width?` `pointerEvents?` `when?` | `entry` 必须在插件目录内；`anchor` = `canvas`；默认 `pointerEvents: none`，只有需要交互才置 `auto` |
| `keybindings` | `command` `key` `mac?` `when?` | `key` 允许 `CmdOrCtrl` / `Ctrl` / `Cmd` / `Alt` / `Shift` 组合，裸字母数字被拒（只放行 F1–F24）；`mac` 覆盖 macOS 组合 |
| `settings` | `id` `title` `fields[]` 或 `panel` | 字段类型 `boolean` / `number` / `string` / `select` / `multiline`；`select` 的 `options` 必须是 `{value,label}` 数组；**不再支持 `entry`**（设置窗口没有面板那套 postMessage 闸门），要内嵌界面就 `panel` 指向已注册面板 |
| `i18n` | `{ "<locale>": { "<key>": "text" } }` | 扁平字典，键 `[A-Za-z0-9_.-]{1,64}`，总条目 ≤ 400；宿主注册为 `plugin.<pluginId>.<key>` |

`when` 是**封闭集合**的布尔子句（`projectOpen` / `hasFragments` / `hasSelection` /
`playing` / `idle`，可 `!` 取反、`&&` 连接），不是任意表达式 —— 校验层直接拒绝未知
标识符，避免插件把"我猜的上下文名"写进去然后永远不显示。

运行期侧对应三组 API：

- `ctx.ui.status(id, text)`：改自己状态栏条目的文本；`null` 清除。只能改**自己**的条目。
- `ctx.settings.get(key)` / `ctx.settings.all()` / `ctx.onSettingsChanged(cb)`：读用户在
  设置页填的值，改完立刻收到通知（宿主推 `settings.changed`）。
- `ctx.notify(message, level?)`：界面右上角通知条；`message` 可用 `@key` 引用字典。

## 9. 里程碑

**M1 纵向切片（验收线）— 已完成**
安装 `.sxsp` → 菜单出现 → 命令可执行 → iframe 面板 → 在 runtime 用 `ctx.ort` 加载
插件目录下的 ONNX（无 session 白名单、无 dummy 表、DML→CPU 回退）→ 结果经
`project.apply` 写入工程 → 卸载。
验收：泄漏探针各项归零；重启后无菜单/面板/进程/文件残留（`plugin-data` 按选择保留）；
`npm run test:ci` 不回归。**结果：2153 passing / 7 failing（均为既有 Windows 专属
`onnxruntime.dll`），lint 0 error。**

### 9.1 M1 端到端验证（2026-11-02）

**为什么补这一步**：M1 的验收此前只跑 `npm run test:ci`，而单测是在纯 Node 里直接
require 各模块，**既不启动 Electron，也不创建窗口、utilityProcess、`plugin://`
协议和原生菜单**。于是 12 个缺陷全部漏过：代码「逻辑正确」，装进应用却一条链路都
走不通。结论写在这里当作规则——**插件系统的验收必须有一次真实窗口里的全链路走查**。

做法：`xvfb-run` + `--remote-debugging-port=9222`（渲染层 CDP）+ `--inspect=9229`
（主进程 Inspector）。主进程侧直接读 `Menu.getApplicationMenu()`、调菜单项 `click()`；
渲染层侧执行 JS 断言 DOM 与工程状态；`scrot` 截原生菜单栏。命令与面板的真实链路
（面板按钮 → RPC → runtime → 主进程 → 渲染层 → 工程）全部走通。

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 冷启动后菜单里没有 Plugins；0 插件时连入口都没有 | `buildAppMenuDeferred()` 早于 `pluginService.init()`，构建时 `initialized=false` 跳过片段；init 不触发 `onDidChange` | `init` 后无条件 `rebuildAppMenu()`（`src/main.js`） |
| 2 | 菜单显示 `Open Panel… · [object Object]` | `pluginManifest.js` 对 panel/setting 用 `String(title)`，而 v2 的 title 是 `{en,'zh-CN'}` 对象（command 却走 `localizedTitle`） | 三处统一走 `localizedTitle`；菜单与 `openPanel` 用 `pickTitle` 解析 |
| 3 | 所有命令 `PLUGIN_TIMEOUT`（30s） | `utilityProcess.fork` 时设了 `ELECTRON_RUN_AS_NODE=1`，Electron 以纯 Node 启动，`--type=utility` 变成非法选项：`bad option: --type=utility` | 删除该变量；要隔离的是继承来的 `ELECTRON_*`，不是打开它 |
| 4 | 面板 iframe 空白，`chrome-error://chromewebdata` | 宿主开了 `COEP: require-corp`（为 SharedArrayBuffer），`plugin://` 响应没有 CORP 头 → `ERR_BLOCKED_BY_RESPONSE` | 协议层补 `Cross-Origin-Resource-Policy: cross-origin`（不是 CSP 问题） |
| 5 | 面板每一条 RPC 都 `NOT_FOUND` | 示例插件导出 `panels.rpc`（通用 dispatcher），框架只认 `panels[panelId].rpc` 与 `onPanelRpc` | runtime 三种写法都接受，越具体越优先；示例注释同步 |
| 6 | 泄漏探针的 `dom` 维度恒为 0 | 面板宿主从未打 `data-plugin-id`，探针数不到 iframe/抽屉 | 打开时打标记、`teardownFrame` 清除；实插一个残留节点验证探针报 `dom:1` |
| 7 | 插件日志/进度事件全丢；崩溃不进审计 | `_onMessage`/`_onExit` 读 `session.onEvent/onExit`，但 `start()` 从未把 manager 级回调接到 session 上 | `start()` 内用转发闭包接线（支持后设置） |
| 8 | 崩溃计数永远 1，`maxCrashes` 隔离不可达；且正常停用也被记成崩溃 | 计数读 `record.state`（addPlugin 时的快照，永不更新）；`stop()` 的 kill 同样触发 `exit` | 从落盘状态读并回写；session 加 `stopping` 标志，主动停止不计崩溃 |
| 9 | 卸载后 DOM 里残留空 `<aside>` 抽屉 | `closePanel()` 只 `hidden`，容器复用 | 卸载/停用路径 `closePanel({destroy:true})`，容器移除 |
| 10 | 卸载可能抛异常留下半卸载状态 | `installer.uninstall` 的 `rmSync` 未捕获（Windows 上 .dll 被映射时必现） | 捕获并返回 `fileError`/`removedDir:false`，如实报告而非抛错 |
| 11 | 同毫秒两次 `project.apply` 会丢掉一个响应 | 请求 id 用 `Date.now()`，`_pending` 键冲突 | `nextProjectApplyId()` 加进程内自增序号 |
| 12 | `panel.timeoutMs` 写了不生效 | `pluginApi` 注释承诺可覆盖，但校验层没保留该字段 | 校验时夹紧保留，`panelRpc` 读取 |

另有两条**不改代码、只记事实**：

- `RUNTIME_LIMITS.maxLeaks` 目前没有消费方（卸载时插件记录已删，无可累计对象），
  已在常量注释里标明「M2 接到停用/重载路径再生效」。
- 覆盖安装会把旧版本挪进 `plugins/.versions/` 且无清理策略，属已知取舍（回滚用），
  M6 硬化时再定保留份数。

**验证清单（每次改动插件内核都要重跑）**

| 检查 | 期望 |
|---|---|
| 冷启动（0 插件） | 菜单有 Plugins，含 Manage/Install/Reload/Open Folder/Log |
| 安装 `.sxsp` | 菜单出现插件子菜单；`Open Panel… · <本地化标题>` |
| 执行命令 | 返回结果；`project.apply` 后主窗口 `#bpm-input` 同步变化 |
| 打开面板 | iframe `src=plugin://…`；标题为本地化字符串；无 `chrome-error` |
| 面板 RPC | 已声明能力可用；未声明能力 `PERMISSION_DENIED` |
| 泄漏探针 | 正常卸载无 `leak` 审计；人为留节点时报 `dom:1` |
| 崩溃 | `kill -9` 后出现 `crash` 审计；再调用命令自动重启 |
| 停用/启用 | 停用后菜单子项消失、投影贡献为 0、记录仍在；管理器按钮变 `Enable`；启用后恢复 |
| 快捷键（M2） | 默认关闭时按组合无反应；管理器开启后触发命令；撞宿主/撞插件的组合始终不触发 |
| 设置分区（M2） | `boolean/number/string/select` 四种控件按 schema 渲染；改值提示"已保存"且 runtime 收到 `settings.changed` |
| 界面贡献归零（M2） | 停用后工具栏按钮、状态栏条目、浮层 iframe、右键项、快捷键同时消失，无残留节点 |
| 卸载 | 菜单/iframe/`[data-plugin-id]`/抽屉/进程/目录全部归零 |

**M2 贡献面 — 已完成**
toolbar / statusBar / contextMenus / timelineOverlays / keybindings / settings / i18n
七个贡献点（palette 归入 M5，与 intent 一起做）+ 管理器 UI 完整化。

落地要点：

- **权威只在主进程**：`PluginRegistry` 持有贡献表，渲染层只接收投影（snapshot）。
  投影**从贡献表读、不从 manifest 读**——否则停用/卸载后界面还留着按钮，点下去
  `NOT_FOUND`。
- **插入位置**：工具栏固定在"工程组"与右侧低频区之间的独立槽位，按 `group` 分段
  且组内保持声明序（不按字母排，否则装第三个插件时按钮会整体跳位）；状态栏分左右
  两槽；浮层插在画布与播放指针之间（`z-index:1`、`pointer-events:none`）；右键项
  追加在宿主项之后，无插件项时不加分隔线。
- **快捷键三方仲裁**（见 §11.4）：默认关闭 → 撞宿主永不绑定 → 插件间同组合双方都不绑。
  渲染层只认投影里 `status === 'active'` 的条目，不重复判定，避免"界面说没绑、按下去
  却触发"。

### 9.2 M2 端到端验证（2026-11-03）

沿用 §9.1 的手段（`xvfb-run` + CDP 9222 + Inspector 9229），逐条走过：

| 场景 | 结果 |
|---|---|
| 冷启动（插件已安装且启用） | 工具栏出现 `♪ Hello`、状态栏出现 `Hello ×0`，**无需手动重载窗口** |
| 管理器贡献计数 | Commands 2 / Panels 1 / Toolbar 1 / Status bar 1 / Context menu 1 / Overlays 1 |
| 快捷键默认关闭 | 按 `Ctrl+Shift+H` 无任何反应（符合"默认关闭"） |
| 管理器打开快捷键开关 | 行状态变 `Active`；按下后通知条「Hello #7 · 当前 BPM 120」+ 状态栏计数递增 |
| 设置分区 | 侧栏出现「Example: Hello Panel · Greeting / Advanced」；`text/number/checkbox/select` 四种控件按 schema 渲染，改问候语提示 `Saved` |
| 设置 → 运行时 | 改完问候语后再按快捷键，通知条变成「你好 ×9」（`settings.changed` 送达 runtime） |
| `settings.panel` 指向 | 「Advanced」分区的 *Open plugin panel* 打开 `plugin://example-hello/panel/index.html?n=…` |
| 浮层 `when` | 空工程 + `when:hasFragments` → 0 个 frame、layer 保持 hidden；临时置 `when:null` 重载 → iframe 挂载、插件自绘徽标显示 `overlay 475×654`；还原后归零 |
| 停用 | 工具栏空、状态栏隐藏、面板 iframe 关闭、快捷键不再触发；管理器卡片转为 `Disabled` 且按钮变 `Enable` |
| 启用 | 全部恢复（工具栏/状态栏/快捷键 `Active`），计数器从 0 重新计 |
| 单测（插件四件套） | `pluginCore` 29 / `pluginContributions` 20 / `pluginLifecycle` 8 / `windowCapabilities` 13，共 70 passing |
| 全量回归 `npm run test:ci` | **2186 passing / 7 failing**（7 条仍是既有 Windows 专属：NPU PnP ×3、WinML `ortBridge` ×4） |
| 静态检查 | `npx eslint src/ test/ scripts/` **0 error**（103 warning 为既有）；`node scripts/check-ipc-channels.js` 234 常量全被引用 |

这一轮抓到并修掉的缺陷（全部是"单测绿、进窗口就错"的类型）：

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 设置页/管理器的 `settingsSet`、`setKeybindings` 全部报"当前窗口未授权" | preload 的窗口标识取自 URL 里的 html 文件名，而 forge 给所有入口产出的都叫 `index.html` → 所有窗口都被认成 `index`（权限最宽的那档），裁剪表里的 `settings` / `pluginmanager` 永不匹配。等于**最小权限从未生效** | 新增 `src/shared/windowCapabilities.js`：按入口目录段解析 + 兜底文件名；映射表与 `forge.config.js` 的 entryPoints 用单测互锁 |
| 2 | 停用后管理器按钮仍是「停用」，插件再也启不回来 | `setEnabled` 只把 `enabled:false` 写进磁盘，`record.state` 仍是扫描时的 `enabled:true` 副本；管理器据此算 `enabled` | 停用时同步写 `record.state`；管理器改以 `status === 'disabled'` 为准（磁盘与运行态不一致时按运行态走） |
| 3 | 冷启动后工具栏空着，手动重载窗口才出现 | 插件在窗口还没订阅前就加载完，那次广播无人接收；随后渲染层的 `list()` 拿到的还是加载中的空投影，而加载结束不再广播 | 主进程在 `did-finish-load` 补发一次投影（把"窗口就绪"当订阅握手）；渲染层按 `revision` 单调丢弃迟到的旧投影 |
| 4 | 状态栏文字停在 `×0`，运行时更新不生效 | `installPluginHost` 只做了首次 `list()`，从未 `onSync()` 订阅，运行期 `ui.status` 触发的推送全丢 | 补订阅并在 dispose 里退订 |
| 5 | 状态栏显示 `@greetIdle` 原文 | 静态 `text` 也写成 `@key`，但只有 `runtimeText` 走了字典解析 | 统一"先取 raw（运行期文本或本地化静态文案），再整体过 `resolvePluginText`" |
| 6 | 窄窗口（≤760px）下插件按钮只剩一个音符图标 | `@media (max-width:760px) #toolbar button{font-size:0}` 把所有按钮文字清零。内置按钮靠图标能认出来，插件按钮不能 | `.toolbar-plugin-btn` 用更高优先级把字号还回去，`max-width` 收到 72px 优先截断 |
| 7 | 管理器把 `Mod+Shift+H` 直接印给人看 | 规范形里的 `Mod` 是抽象修饰键，用户手上只有 Ctrl 或 ⌘ | 新增 `formatChordForDisplay()`（展示用，不参与匹配）+ `src/renderer/platformInfo.js` 统一平台判定 |
| 8 | 设置区若内嵌 iframe（`settings.entry`）会绕开 `apiScopes` 闸门 | 设置窗口没有面板那套 postMessage 桥 | 校验层直接拒绝 `entry`，只允许 `fields` 或 `panel` 指向已注册面板 + "打开插件面板"按钮 |

**M2 结论**：贡献点这条链路（manifest 校验 → 注册表 → 仲裁 → 投影 → DOM → 命令回主进程）
已经能只靠投影驱动，停用/卸载/重载都表现为"下一次投影就什么都不剩"。剩下的是 M3 起的
推理/数据/智能面。

**M3 模型与推理面**：模型调用面（§12，端点/绑定/网关/授权/MCP 工具，先行落地）、
`synthesis.backend` 迁移、v1 adapter、三种 pipeline hook。
**M4 数据面**：工程格式 open/save/import/export、导出器、文件关联、dialog filter。
**M5 智能面**：`automation.method` 进 MCP、`--cli plugin`、跨插件 service、secrets ——
落地"一句话 → 一句唱"（`llm.provider` 已并入 M3 的模型调用面）。
**M6 硬化**：签名校验、marketplace 接口（只留接口）、三平台验证、a11y/主题。

## 10. 风险与取舍

| 风险 | 缓解 |
|---|---|
| hook 跨进程拷贝 | 默认走 `kind:"model"` 在 svsWorker 内执行，张量不出进程；JS hook 只对 waveform 开放 |
| iframe 主题/i18n/a11y | 加载与 `localeChanged` 时推 tokens + 字典；强制 `title`、焦点陷阱；`sandbox="allow-scripts"` 无 same-origin，故不给 localStorage，改用 `ctx.state` |
| API 表面积膨胀 | 只增不改；6 个原语组合，不为单点功能开新接口；`apiVersion` 整数 + `engines` |
| 插件崩溃 | `exit` → pending reject + 标记 crashed + 可重启；连续 3 次 quarantine |
| hook 顺序冲突 | `order` 数值 + 同值按 pluginId 稳定排序；每 stage 总超时 + 熔断 |
| `plugin://` 与 CSP | standard+secure、nonce、路径 jail、`connect-src 'none'`、禁 popup/导航；宿主 CSP 只开 `frame-src plugin:` |
| 测试负担 | `test/fixtures/plugins/{good,leaky,crasher}` + `test/pluginLifecycle.test.js` 统一断言；CI 增加 smoke |
| 权限非沙箱 | 安装弹窗与文档明示；审计 + kill switch；签名留接口 |

**明确不做**：插件商店后端、强制签名、插件热更新（只做 reload）、每插件独立渲染
进程、跨大版本二进制兼容。

## 11. 已定决策与剩余待确认

已定（随本方案生效）：

1. 插件管理器为**独立窗口** `plugin_manager_window`（照 `openResourceManagerWindow`
   写），菜单 `Manage Plugins…` 直接开窗。
2. 插件命令**默认对外暴露**给 MCP / CLI。补偿措施：安装弹窗把 `automation` 单列
   说明；每次外部调用写审计（插件 id + 方法 + 调用方）；管理器提供逐插件关闭开关；
   MCP schema 里标注 `source: plugin:<id>`，便于 agent 与用户辨认。
3. UI 隔离用 **iframe + postMessage**（`plugin://` 协议，`sandbox="allow-scripts"`，
   无 `allow-same-origin`），计算隔离用**每插件独立 utilityProcess**，
   分发用**本地安装 + 预留市场**（`.sxsp` zip，签名留占位）。
4. **M2 快捷键冲突策略（原 §11 待定项，已于 M2 决定）**：三方仲裁，任一不过就不绑：
   1. **默认关闭**。快捷键是全局副作用，装插件不应该改变用户的按键行为。管理器逐插件
      提供"启用本插件快捷键"开关，默认 off；关着的时候投影里 `status` 全是 `disabled`，
      渲染层不注册任何监听。
   2. **撞宿主永不绑定**。宿主侧的组合（原生菜单 `accelerator` + Chromium 编辑/窗口手势：
      `Mod+Z/Y/Shift+Z/X/C/V/A/S/Shift+S/F/P/W/Q`）一律判 `conflict/host`，不给"后装覆盖
      先装"的机会 —— 让插件把 `Mod+S` 抢走之后，用户存盘就静默失败了。
   3. **插件之间同组合双方都不绑**。不按安装时间、不按字母序排优先级：先到的赢会让"装
      第二个插件把第一个插件搞坏"变成不可复现的问题。两边都判 `conflict/plugin`，管理器
      显示冲突方 id，让插件作者去换键。
   规范化与匹配共用 `src/shared/pluginKeys.js`（`Mod+Meta+Ctrl+Alt+Shift` 固定顺序、
   按 `event.code` 归一），仲裁只在 `src/main/plugins/PluginKeybindings.js` 一处做。

剩余待确认（实施时可随里程碑决定）：

- 是否提供"导出已安装插件为 .sxsp"（便于分享，成本极低）。
- 冲突的一对插件是否需要"让用户手动指定谁优先"（当前是双方都不绑，简单但保守）。

## 12. 模型调用面（M3 规格，2026-11-04 定稿）

### 12.0 定位

原来的 `llm.provider` 只设想"接一个大模型"。实际需求是**所有生成式能力统一入口**：
LLM、MIDI 生成、伴奏生成、歌声合成、TTS/ASR，本地与云端一视同仁。核心约束三条：

1. **调用方只认 task，不认厂商**。插件说"我要 accompaniment"，不关心背后是本地 ONNX 还是云端 HTTP。
2. **出站收归宿主**。密钥不出主进程；所有 HTTP 由主进程代发；插件拿不到 baseUrl 与凭据。
3. **授权落在端点上**。用户能理解"允许这个插件访问我的 OpenAI"，理解不了"允许访问 task=midi"。

`llm` 贡献点更名为 `models`（`llm` 从未生效，无兼容负担）；`API_VERSION` 保持 2。

### 12.1 领域模型

```
Task        调用方视角的能力：chat / completion / embed / midi / accompaniment / singing / tts / asr
   ↓ 由 Binding 解析
Binding     某 task 用哪个 endpoint：{ task, endpointId, model?, isDefault }
   ↓
Endpoint    一个网络位置 + 一把钥匙，ACL 客体：
            { id, owner, provider, adapter, baseUrl, title, locality, auth, models, createdAt }
   ↓
owner       谁注册的（卸载级联用）：builtin | plugin | user
provider    哪家服务（scope 分组用）：openai | anthropic | ollama | custom | 插件自定义
adapter     协议怎么说话：openai-compatible | anthropic | local-process（封闭集合）
locality    device | lan | cloud（决定是否免确认，见 §12.5）
```

- **endpoint 没有 `tasks` 字段**。一个连接被 `chat` 和 `embed` 同时绑定就是两条 binding，不在端点侧打勾。
- **同一 baseUrl 不同 key = 两个 endpoint**，因为钥匙挂在 endpoint 上。
- **一个 task 可有多条 binding**，其中一条 `isDefault`；没有默认就报 `NEED_ENDPOINT`，**绝不自动挑第一个**（端点之间价差可能两个数量级，兜底等于替用户花钱）。
- **task 与 endpoint 冲突不静默回退**：显式给 endpointId 但它不支持该 task → `INVALID_REQUEST`。
- **endpoint id 格式** `<owner>:<ownerId>.<localId>`，如 `builtin:singing.rvc`、`plugin:com.example.midi.gen`、`user:local.7f3a`。
- **`synthesis.backend` 不并入**，注册时投影成 `builtin:singing.<backendId>`（`adapter: local-process`），调用方仍按 task 找过来。

**基础 task 封闭，子能力开放**：加一个基础 task 需要宿主发版（每个 task 对应一套编解码 + 校验描述符，放在 `src/main/models/tasks/<task>.js`）；端点可声明自由字符串 `subtasks`（如 `midi.inpaint`），只用于路由粗筛与展示，不改变契约。

### 12.2 调用协议：统一流式

```js
invoke({ task, endpointId?, model?, input, clientRequestId? }) → handle { id, cancel() }
事件：start → chunk* → (progress*) → done | error | cancelled
```

| 规则 | 内容 |
|---|---|
| 终止事件 | **恰好一个**。流关闭后再发任何事件 → 网关断流 + `PROTOCOL_VIOLATION` + 该次结果作废 |
| cancelled vs error | `cancel()` → `cancelled`；超时、上游失败 → `error`。二者审计与重试语义不同，不可混用 |
| idleTimeout | 默认 60s 无事件判超时；**端点可覆写**（MIDI/音频常几十秒无输出）；判 `error(TIMEOUT)` |
| maxDuration | 全局 10 分钟硬上限；**端点只能调小不能调大**，否则插件声明 24h 就把硬上限架空 |
| chunk 合并 | 宿主按 16ms 聚合再下发，终止前强制 flush（首字延迟最多多一帧） |
| 背压 | 调用方每收 N 个 chunk 回 `ack`；在途未确认超过 32 chunk / 1MB 即暂停生产 |
| 可暂停通道 | HTTP 流 → 真背压（`response.pause()`） |
| 不可暂停通道 | 本地原子推理 → 缓冲到上限**失败**，`BACKPRESSURE_OVERFLOW`（`retryable:false`，`hint:'consumer_too_slow'`），不静默丢弃 |
| invokeOnce | SDK 语法糖，内部同一条流，但**在进程内聚合**，不把中间 chunk 推过 MessagePort，因此不受背压窗口约束（仍受总时长与内存上限约束） |
| 缓冲上限 | 宿主强制，端点可声明 `suggestedBufferLimit`，实际取 `min(建议, 宿主上限)` |
| 去重 | `subject + clientRequestId`，5 分钟窗口；在途返同一 handle，已完成返同一结果；**cancelled / failed 不缓存**（否则一次抖动后重试永远拿到失败） |

### 12.3 二进制与句柄

```js
handle = { id, subject, jobId, sha256, size, mime, expiresAt, mac }
```

- **句柄是不可伪造的 capability，不是可猜的 jobId + 路径**。引用里不含真实路径，`ctx.files.read(handle)` 校验 `mac + subject + sha256 + size` 通过才返回内容。
- **≤256KB 内联**：走 `binary_inline` chunk，受同一背压窗口管理，不落盘；**内联不豁免审计**（记 subject/jobId/size/sha256）。
- **>256KB 落盘**：`userData/model-cache/<jobId>/`，LRU GC + 总量上限；引用带 `expiresAt`。
- **读取权按 subject 判，fs 权限不参与**：

| 读取方 | 句柄归属 | 结果 |
|---|---|---|
| 插件 A | A 自己（本次或历史） | 允许，即使无 `fs` 权限 |
| 插件 A | 插件 B / host | `PERMISSION_DENIED` |
| 面板 iframe | 同插件 | 允许（继承插件身份） |
| MCP token | 该 token 发起 | 允许 |
| host | 任意 | 允许 |
| 任何 | 已 GC | `HANDLE_EXPIRED`（与拒绝区分，审计语义不同） |

### 12.4 授权模型

```
ACL 记录 = (subject, endpointId) → { decision, scope, fingerprint, grantedAt }
  decision    = allow | deny | ask（无记录时等效 ask）
  scope       = once | session | always
  fingerprint = hash(baseUrl + provider + adapter)
```

- **默认 ask**。allow 太松（装个插件就交出付费端点），deny 太硬（每个插件都要先去设置页手配，用户会放弃）。
- **粒度 subject × endpoint**。运行时弹窗**永远单端点**，不允许"允许访问全部 OpenAI 端点"——用户在弹窗里的注意力只够判断一件事。
- **持久化三档**，默认按钮落在 `session` 而非 `always`（减少手滑永久授权）。
- **指纹变化即失效**：`baseUrl` / `provider` / `adapter` 任一变化 → 旧记录作废，重新确认。否则端点从 `api.example.com` 换成 `api.evil.com` 还能沿用上次授权。
- **subject 级开关只能往严走**：可把某插件/某 token 的整体默认改成 `deny`（连问都不问，直接拒）；不能设成"全部 allow"。

**首次确认弹窗**：

```
⚠ 「歌词助手」想要使用模型
   端点    我的 DeepSeek（provider: deepseek）
   任务    chat
   将发送  约 1.2 KB 文本（当前分片的歌词）
   将接收  流式文本
   [ 拒绝 ] [ 仅本次 ] [ 本次运行 ] [ 始终允许 ]
```

- **"将发送"必须量化**（字节数 + 内容类别）。做不到量化就不弹窗、直接拒绝——不允许"未知数据发往未知地址"。
- **模态、阻塞该次调用**；**30s 无响应视为拒绝**，审计记 `CONSENT_TIMEOUT`（与用户主动拒绝区分）。
- **连击合并**：同一 subject 500ms 内连续 ask 多个端点 → 合成一个弹窗，逐项勾选，**默认全不勾**，不提供"全部允许"。
- **后台不抢焦点**：主窗口无焦点时不弹模态，改通知条 + 托盘提示；30s 从"用户看到窗口"起算。

**MCP 预授权**（设置 → 模型 → 访问控制）：

```
☑ 本地端点免确认（插件与 MCP 共用，默认开）
☐ 跳过所有确认（危险；token 级；勾选后下方置灰；二次确认 + 常驻警示）
已授权：[我的 Ollama] [内网 Llama] [+ 添加]     ← 与 always ACL 是同一份数据
```

- **bypass 只跳过确认，不跳过审计**：每次调用仍记录 subject / endpoint / task / 字节数 / 结果。
- **加严要确认、放松不用**：勾选"跳过所有确认"要二次确认，取消不需要。
- **"跳过所有确认"只对该 MCP token 生效**，不影响插件（否则用户为自己的脚本顺手勾上，所有插件一并免确认）。
- 该 token 的调用在审计里标 `bypass: all`，便于事后追账。

### 12.5 本地判定与免确认

| 端点来源 | locality | 免确认 |
|---|---|---|
| `local-process`（进程内推理） | device | 自动 |
| HTTP + `127.0.0.1` / `localhost` / `::1` | device | 自动 |
| HTTP + 私网 IP（10/8、172.16/12、192.168/16、fc00::/7） | **cloud** | 需用户勾"视作本地" |
| HTTP + 公网 | cloud | 需授权 |

内网服务器不自动信任：那台机器可能计费、可能是共享集群，得由用户声明。手动标记处写明代价：*"标记为本地后，该端点的调用将不再询问。若它实际计费，你不会收到提示。"*

**插件作者规范**：本地模型优先 `local-process`；必须走 HTTP 的（ollama / llama.cpp server / ComfyUI）注册成端点并声明 `locality`，**不允许在插件进程内自己发请求**（见 §12.7）。

### 12.6 四类调用方

| 调用方 | 入口 | 鉴权主体 |
|---|---|---|
| 插件 runtime | `ctx.models.invoke/list` | `plugin:<id>` |
| 面板 iframe | `apiScopes: ['model.invoke']` → 宿主 postMessage 桥 | 同插件（身份取自面板注册表，不信 iframe 自报） |
| MCP 客户端 | 工具 `model.list` / `model.invoke` | `mcp:<tokenId>` |
| 宿主自身 | 命令面板 / 自动化 / 智能功能 | `host` |

**面板双闸门**：必须同时满足（a）面板声明 `model.invoke`；（b）所属插件对该 endpoint 的 ACL 通过。审计标 `via:'panel'`。

**能力发现 `list(task)`** 返回最小充分集，**不含 baseUrl / 凭据 / 失败详情**：

```js
{ id, title, owner, provider, tasks, subtasks, models, locality, ready, requiresConsent, preferredBy }
```

可见性：自己注册的（完整）、ACL=allow（脱敏）、**ACL=ask（可见，标 `requiresConsent`）**、ACL=deny（不可见）、其他插件的端点（可见，脱敏）。

**MCP token scope 只有三种形态**，不做前缀通配：

```
models: '*'
models: ['provider:openai', ...]              // 只匹配 owner ∈ {builtin,user} 的端点
models: ['endpoint:user:local.7f3a', ...]
```

`provider:` 必须做来源隔离：插件注册的端点无论声明什么 provider，**一律只能 `endpoint:` 精确授权**——否则插件冒用 `provider:'openai'` 就能蹭用户对 OpenAI 的信任。`provider` 变更视为新 scope，已有授权不继承。

`host` 主体：与插件走同一条审计管道（主体标 `host`），**跳过插件级 ACL**（无 pluginId，不该被插件配额/net 白名单误杀），但**保留端点可用性检查**（用户禁用某端点则宿主也不能用）；**独立配额桶**，不与插件共享。

### 12.7 与既有安全模型的关系

| 既有机制 | 关系 |
|---|---|
| `permissions.net` | 插件注册端点**不需要** net（出站全在宿主侧）；net 只用于插件自己的资源访问。两套不互相污染 |
| `permissions.secrets` | 只管插件自己数据目录下的命名空间；**端点凭据在宿主 safeStorage 区，任何插件权限组合都读不到** |
| `permissions.llm` → `models` | 改为 `models: ['consume', 'provide']`：consume = 调用他人端点，provide = 注册自己的端点 |
| 面板 `apiScopes` | 新增 `model.invoke` / `model.list`，与插件 ACL 双闸门叠加 |

**C 方案的收口是"防误用"，不是安全边界**（`runtime/sandbox.js` 自己声明"这不是沙箱"）：

- runtime 入口劫持 `Module._load`，拦 `node:http` / `node:https` / `node:net` / `node:tls` / `node:dns` / `undici` → 抛 `UNSUPPORTED`（提示改用 `ctx.models.invoke`）+ 审计 `net_bypass_attempt`
- 挡不住刻意的 `process.binding` / 动态 import / WASI；价值在于让普通作者走对路、让恶意行为变成"需要刻意动作"从而可追责、让用户在日志里看见谁不守规矩
- 安装权限清单与文档明示"该插件可自由访问网络"，不制造"已经被关住"的错觉

### 12.8 错误码与实施切片

新增错误码：

```
NEED_ENDPOINT        该 task 没有默认端点，且调用方未指定
CONSENT_REQUIRED     需要用户确认（弹窗已发起）
CONSENT_TIMEOUT      30s 未响应，视为拒绝
TIMEOUT              idleTimeout 或 maxDuration 触发
BACKPRESSURE_OVERFLOW 消费方太慢（retryable:false, hint:'consumer_too_slow'）
PROTOCOL_VIOLATION   终止事件后仍有事件
HANDLE_EXPIRED       句柄已 GC
ADAPTER_UNSUPPORTED  宿主不认识该 adapter（端点登记为 unsupported，不影响其他端点）
ENDPOINT_UNAVAILABLE 端点被用户禁用或凭据缺失
```

四段实施，每段独立提交、独立验证：

| 段 | 内容 | 验证 |
|---|---|---|
| 1. 内核 | EndpointStore / BindingStore、Gateway（流 / cancel / 双超时 / 背压 / 去重 / handle）、Audit、ACL | 纯 Node 单测，不依赖窗口 |
| 2. 接入 | `ctx.models.*`、面板 `model.invoke`、MCP `model.list` / `model.invoke` + token scope、host 主体 | 单测 + 真实窗口对本地假端点 |
| 3. UI | 设置页三块（端点 / 任务绑定 / 访问控制）、确认弹窗、审计面板、管理器显示来源 | 实机走查：首次调用 → 弹窗 → 允许 → 撤销 → 再拒 |
| 4. 文档 + 示例 | 作者文档（task 契约、endpoint 声明、locality、禁止自建 HTTP）、示例插件真跑一次 `chat` 或 `midi` | 打包安装跑通 |

**第 1 段已落地（2026-11-04）**，纯 Node 可测，不依赖窗口：

```
src/shared/modelContract.js          task 集合 / adapter↔task / locality 判定 / 错误码 / 限额
src/main/models/ModelEndpointStore.js 端点与绑定持久化（元数据与密钥分文件）
src/main/models/ModelAcl.js          (subject, endpoint) 判定 / 指纹失效 / once-session-always
src/main/models/ModelGateway.js      统一流 / 双超时 / 背压 / 去重 / 终止事件唯一
src/main/models/ModelHandleStore.js  capability 句柄（mac + subject + sha256）+ LRU GC
src/main/models/ModelAudit.js        元数据审计（不记内容，bypass 留痕）
src/main/models/adapters/            openai-compatible / anthropic / local-process
```

`test/modelContract.test.js`（19）+ `test/modelGateway.test.js`（20）覆盖：
locality 四档判定、ACL 指纹失效与 once 消费、终止事件唯一、cancel 与 error 的区分、
端点 idle 覆写、去重命中与失败不缓存、可暂停/不可暂停两条背压路径、审计不含输入内容。

**第 2 段已落地（2026-11-04）**：

| 调用方 | 入口 | 状态 |
|---|---|---|
| 插件 runtime | `ctx.models.list / invoke / invokeOnce` | ✅ 事件按 `streamKey` 认领，每分片回 `models.ack` |
| 面板 iframe | `apiScopes: ['models.invoke']` → 现有 `panel.rpc` 桥 | ✅ 闸门是 panel scope + `permissions.models`；最终由插件 runtime 代发，审计主体为插件 |
| MCP 客户端 | `model.list` / `model.invoke` + token `models` scope | ✅ 三形态、来源隔离、`*` 需单独配置 |
| 宿主自身 | `subject = 'host'` | ✅ 跳过插件级 ACL（用户就是操作者），端点可用性仍有效 |

- 面板不直连网关：所有 `panel.rpc` 都经插件 runtime，双闸门天然成立（面板 scope +
  插件权限）。代价是审计里看不出"这次是面板发起的"，需要时再看是否加 `via` 标记。
- MCP 是请求-响应，`model.invoke` 在网关侧聚合后返回；长生成用 `async:true` 提交成
  job（`def.long`）。聚合模式每个分片都会回 ack —— 不回的话 32 个分片后生产方会被
  背压暂停，最终表现成一个莫名其妙的总时长超时。
- 主 token 默认 `models: ['*']`（否则用户第一次用会莫名 FORBIDDEN），真正的花钱动作
  仍要过 ACL 首次确认；配置文件里没写 `models` 的额外 token 默认**不能用**模型。

仍未接线：`tts` / `asr` / `midi` / `accompaniment` 的二进制结果（要把
`ModelHandleStore` 接进 adapter 的 chunk 路径）、`local-process` 的真实后端
（等 `synthesis.backend` 迁移）。

**第 3 段已落地（2026-11-04）**：

```
src/main/models/ModelIpc.js          设置页通道 + 确认请求投递（30s 兜底清理）
src/renderer/plugins/modelConsent.js 确认窗：来源 / 端点 / 发送量 / 接收形态 + 倒计时
src/settings.html|js|css             模型端点、访问控制两块 + .model-* 样式
```

实机走查（xvfb + CDP + 127.0.0.1 上的假 OpenAI 兼容端点）跑通了完整闭环：
首次调用弹窗 → 「本次运行」→ 流式聚合为 `假端点回复` → 访问控制出现 session 授权
→ 撤销 → 再次调用重新弹窗 → 拒绝 → 全窗口失焦后 1ms 判拒。

走查暴露的三个问题，均已修：

- **确认请求投错了窗口**。原实现投给「当前聚焦窗口」，用户开着设置页时请求被送到
  一个没有监听器的窗口：界面上什么都不出现，30 秒后静默失败。改为恒投主窗口，
  「人在不在」单独判（任一窗口可见且聚焦）；没人在场直接判拒并记 `CONSENT_UNATTENDED`。
- **一次拒绝留下两条审计**。网关与 IPC 各判一次 30s 超时。判定权收归网关，IPC 只
  负责投递与清理（兜底定时器晚 2s，不写审计）。
- **设置页快照缺 `baseUrl`**。`publicView` 是给调用方看的脱敏视图，设置页沿用它，
  导致编辑端点时地址栏为空 —— 只改个名字会被「必须是 http(s) 地址」打回，或保存时
  把地址抹掉。新增 `settingsView` 补回连接细节，`listForCaller` 仍走 `publicView`。

另修：模型域错误码此前落到 `McpError` 的白名单外，一律塌成 `INTERNAL/500`
（`PERMISSION_DENIED`、`BACKPRESSURE_OVERFLOW` 全看不出区别）。现按语义映射到
`FORBIDDEN` / `RATE_LIMITED` / `PRECONDITION_FAILED` 等，原始码保留在
`details.modelCode`。动态文案一并接入 i18n（`models.*` 95 条，中英对齐）。

## 13. 参考

- v1 契约（歌声后端）：[`plugins.md`](plugins.md)
- 实施过程中的取舍记录：[`SXSEditor-实施记录.md`](SXSEditor-实施记录.md)
- 界面走查清单：`/workspace/SXSEditor-界面走查清单.md`（仓库外）
