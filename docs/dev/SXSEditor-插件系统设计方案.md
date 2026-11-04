# SXSEditor 全应用插件系统 —— 设计方案

> **状态**：M1（纵向切片）已实现并提交（`a7109d8`、`36be137`），并通过真实 Electron
> 窗口的端到端验证（§9.1，2026-11-02）；**M2（贡献面）已实现并通过同样的实链路走查
> （§9.2，2026-11-03）**；**M3（模型调用面）五段全部落地，并通过实机走查（§12，
> 2026-11-04）**，含二进制结果、`synthesis.backend` 迁移与 `postWaveform` hook；
> **M4（数据面）四段全部落地**：第 1 段是打开链路、对话框过滤器与投递（§9.3）；
> 第 2 段是 `codec.write` 保存链路、扩展域 `ext`（声明/数据分离）与往返保真（§9.4）；
> 第 3 段是插件音素在分片编辑器里的只读呈现（§9.5）；第 4 段是 `ext.curve` 的绘制、
> `ext.render` 的工程级意图、`contributes.exporters` 成品导出、旁挂文件与 Windows
> 插件扩展名关联（§9.6，2026-11-04）；**M5（智能面）第 1–3 段落地**：`contributes.automation`
> 的方法进 MCP（§9.7），`--cli plugin list|methods|call|automation` —— 命令行默认
> 转发现有实例的 `/automation`，与 agent 看到的能力表、权限门、审计完全一致（§9.8），
> 以及**插件密钥** `permissions.secrets`（每插件隔离、读写分权、审计只记 key、
> `encrypted` 如实报告，§9.9，2026-11-05）。M5 剩余（跨插件 service、方法的长任务
> 形态）与 M6 未开始。
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
| `export.audio` | main + runtime | 声明 `exporters`（id/ext/label/mime）+ 代码 | 从导出对话框格式表消失；进行中导出拒绝新请求（本版无 `AbortSignal`） |
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

**M4 新增（三段均已落地）**

```
src/main/plugins/PluginDataPlane.js      文件 ↔ 插件 codec ↔ 校验过的工程文档（open/save）
src/shared/projectFormat.js              validateProjectDocument（跨进程数据的唯一入口）
src/shared/pluginExt.js                  extSchema / ext 的声明与数据分离、规模上限
src/shared/pluginPhonemes.js             插件音素 → 可绘制的形态（归一化 / 命名空间 / 反查）
src/main/atomicWrite.js                  原子写盘（宿主 JSON 与插件字节共用一份）
src/shared/pluginCurve.js                曲线字段的取值与声明修饰（绘制/求值唯一来源）
src/shared/pluginRenderIntent.js         工程级渲染意图（extSchema.render → pipeline）
plugins/example-sv2/                     示例：接管 .sv2（read/write 对称）+ .pcm 导出器
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
| `src/renderer/projectManager.js` | 拆出 `applyProjectDocument(doc, path)`；打开先问插件；`_writeProjectTo` 按扩展名分派保存（自动保存也走它） | ✅ M4-1/2/3 |
| `src/shared/projectFormat.js` | `validateProjectDocument(doc)`（规模/深度/原型污染/ext 各层） | ✅ M4-1/2 |
| `src/shared/pluginPhonemes.js` | `readPhonemeField` / `normalizePhonemeList` / `isHostPhonemeName` | ✅ M4-3 |
| `src/shared/pluginCurve.js` | `normalizeCurvePoints` / `sampleCurve` / `collectCurves` | ✅ M4-4 |
| `src/shared/pluginRenderIntent.js` | `buildRenderIntent` / `missingRenderPlugins` | ✅ M4-4 |
| `src/main/plugins/PipelineHooks.js` | `setRenderIntent` + 白名单/调序 | ✅ M4-4 |
| `src/renderer/exportDialog.js` | 格式下拉、扩展名跟随、插件导出分支、warnings 展示 | ✅ M4-4 |
| `src/main/settings.js` / `settingsIpc.js` / `settings.html` | `pluginFileAssociations` 开关（默认关） | ✅ M4-4 |
| `src/fragmentEditor/canvasRenderer.js` | `getPhonemeBarLayout` / `getExternalPhonemes` / 外部音素带绘制 | ✅ M4-3 |
| `src/main/plugins/PluginDataPlane.js` | `saveDocument`（权限 → 校验 → codec.write → 原子写 → 审计） | ✅ M4-2 |
| `src/renderer/mcpAutomation.js` | `project.saveTo` 按扩展名分派，可导出插件格式 | ✅ M4-2 |
| `src/main/dialogIpc.js` / `fileAssociation.js` | 过滤器与文件关联来自 registry；插件扩展名的系统关联（ProgId 前缀 + 清理 + 开关） | ✅ M4-1/4 |
| `src/inference/pipeline/index.js` | 插入 `_runModelHooks(stage, …)` | ✅ M3（postWaveform） |
| `src/settings.js` | 动态 sidebar + schema 渲染的 section（`panel` 指向给"打开插件面板"按钮） | ✅ M2 |
| `src/i18n/index.js` | `registerPluginMessages(id, dict)`，键前缀 `plugin.<id>.` | ✅ M2 |
| `src/renderer/{index,timelineRenderer,eventHandlers}.js` | 挂宿主、`app:state-changed` 广播、三处右键入口 | ✅ M2 |
| `src/pluginManager/*` | 贡献计数 + 快捷键区块（总开关 / 组合 / 仲裁结果） | ✅ M2 |
| `src/renderer/mcpAutomation.js` | ~~动态命令表~~ → **改在桥接层派发**：插件方法跑在 utilityProcess，不需要窗口；未注册方法在 `dispatch` 前就被拒（§9.7） | ✅ M5 修正 |

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

### 9.3 M4 第 1 段端到端验证（2026-11-04）

这一段只做「打开」：插件声明的文件格式出现在对话框里 → 选中 → 路由到插件 codec →
文档过校验 → 装进编辑器。保存/导出留到第 2 段（`codec.write` 与 `export.audio`），
因为"导入"和"回写"对宿主状态的语义完全不同：导入来的内容**没有可回写的原生路径**，
保存必须另存为 `.sxsproj`。先把这条语义跑通，比同时做两个方向更安全。

手段沿用 §9.1/§9.2（`xvfb` + CDP 9222 + `electron-forge start`）。投递走**真实的
second-instance 路径**：起第二个实例带文件参数，由第一个实例的 `second-instance`
处理器 `classify()` 后放进 pending 槽，渲染层取走后 `loadProject()`。

| 场景 | 结果 |
|---|---|
| 插件加载 | `registry.stats()` 里 `fileType: 1`；投影中 `example-sv2.fileTypes = [{ext:'.sv2', role:'open', label:{en,zh-CN}}]` |
| 对话框过滤器 | `pluginHost.fileFilters('open')` → `[{name:'SV2 Project', extensions:['sv2']}]`；`fileFilters('save')` → `[]`（该插件只声明了 open） |
| 打开 `demo.sv2`（2 轨 5 音符） | BPM 96、2 个歌手轨道、2 个分片（0–4 拍 / 4–6 拍）、5 个音符；时间轴正常绘制；状态栏变为 `SV2 · demo.sv2` |
| 导入语义 | `currentProjectFilePath === null`、`isDirty === false` —— 保存会走"另存为"，不会把 sxsproj 的 JSON 写进 `.sv2` |
| 审计 | `file-open` 一条：`{ext:'.sv2', ok:true, bytes:525, singers:2, fragments:2, warnings:0}` |
| 坏文件（`format:'other'`） | 提示 `The plugin could not open this file: Not an SV2 project (missing "format": "sv2")`；当前工程**未被改动**（BPM 仍 96，2 个分片） |
| 停用插件后投递 `.sv2` | `classify()` 不再认这个扩展名，投递根本不会发生（不弹"打开失败"）；`fileFilters('open')` 变回 `[]` |
| 重新启用 | 立刻可再次打开同文件（fileAssociation 快照随 registry 变更重推） |
| 内置 `.sxsproj` | 走宿主管线，`filePath` 被正常写入（不是导入语义），2 个分片内容一致 |
| 从 `.sxsp` 安装 | `plugin:pack` 打包 → 卸载 → 物删目录 + 撤 4 项贡献 + 过滤器变 `[]` → `installFromPath` 装回 → 过滤器立刻恢复、`demo.sv2` 再次打开成功 |
| 单测 | `projectFormatDocument` 15 / `pluginDataPlane` 13 / `dialogFilters` 7 |

这一轮抓到并修掉的问题：

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 打开一个"合法 JSON 但不是工程"的文件，当前工程被**静默清空** | 内置管线只判 `typeof obj === 'object'`，随后三个 `if (obj.project/singers/fragments)` 全部跳过，最后还 `markClean()`。插件格式被停用后正好走到这条路上（`{"format":"sv2"}` 是合法 JSON） | 加"三个字段至少有一个"的判定，否则报 `projectNotAProject` |
| 2 | 提示框里中英混杂：`The plugin could not open this file: 插件解码失败：...` | 宿主那句走 i18n，插件与 `PluginDataPlane` 的细节是写死的中文 | 宿主细节文案走 `tr(zh,en)`；插件侧用 `ctx.plugin.locale` 决定自己的那半句（示例插件演示这一点） |
| 3 | `.sv2` 从对话框选中后 `file:authorizePath` 直接拒绝 | `AUTHORIZABLE_EXTENSIONS` 是写死的 Set，只含内置素材 | 改成"内置 + registry 快照"，插件卸载后自动失效 |

**结论**：数据面的骨架（声明 → 过滤器 → 路由 → 跨进程解码 → 校验 → 装载）成立，
且三处"边界"都落在该落的地方：扩展名归属只在主进程判、文档校验在跨进程返回值上、
读盘授权独立于路由。第 2 段做保存/导出时可以复用同一条 `PluginDataPlane`。

### 9.4 M4 第 2 段端到端验证（2026-11-04）

这一段做「回写」：`codec.write`、扩展域 `ext`、以及往返保真。

#### 为什么先做 ext，再做 write

回写的难点不是"把音符写出去"，而是**用户原文件里插件不认识的部分怎么办**。
SV2 / Vocaloid 的信息模型与编辑器不是子集也不是超集，而是三种不同目标函数下的投影：

| 层 | 与外部格式的关系 | 处理 |
|---|---|---|
| L1 乐谱（音高/时值/歌词） | 真子集（缺音素等） | 精确保真 |
| L2 表达（力度/气声/张力…） | 交叉 | 通道化，映射由插件声明 |
| L3 引擎参数（VEL/DYN/BRE、宿主 DSP） | 互不相交 | 不映射，进 `ext` 原样带回 |

没有 ext，write 就只能"从模型重新生成"，插件不认识的字段在第一次保存时被静默抹掉。
所以 ext 必须先于 write 存在。

#### 关键决定

| 决定 | 为什么 |
|---|---|
| **声明与数据分离**：`document.extSchema`（声明）+ 各层 `ext`（数据） | 数据跟着层走（note 上有音素），声明跟着文档走。混在一起会让 5000 个音符各揣一份 schema |
| **宿主只认 6 个 `kind`**（phonemes/text/number/enum/toggle/curve） | 宿主不需要理解"这个音素合不合法"，只需要知道"怎么显示、能不能改" |
| **`editable:false` = 只读呈现** | 音素是引擎方言，宿主无从校验。让它可编辑只会制造无效值 |
| **保存只看目标扩展名** | 不看"文档来源"：新建工程也能直接导出 .sv2，另存为 .sxsproj 之后就按 JSON 走 |
| **warnings 必须往上传** | "3 个通道被量化" / "颤音未写入"不告诉用户，等于静默丢数据 |
| **写盘复用 `writeFileAtomic`** | 两条保存路径共用一份原子写，避免"一边补了 fsync、另一边没有" |
| **`ext` 不是塞原文件的地方** | 单条 512KB / 全文档 8MB，超了丢弃并告警。不认识的部分请结构化 |

#### 实机走查

手段同前（xvfb + CDP + 真实 second-instance 投递）。测试文件带 `meta`（中文）、
两个带 `phonemes` 的音符、两条轨道。

| 场景 | 结果 |
|---|---|
| 插件声明 `role: both` | `fileFilters('open')` 与 `fileFilters('save')` 都出现 `SV2 Project` |
| 打开 `demo2.sv2` | BPM 96 / 2 轨（Lead、Harmony）/ 2 分片（0–4、4–6）/ 5 音符；`filePath` 为真实路径（不再是 null） |
| 导出到 `rt.sv2` | `meta` 三段（含中文）、两个音符的 `phonemes`、轨道结构全部逐字保留；`warnings: []` |
| 保存为 `.sxsproj` | `extSchema`、`document.ext`、`note.ext` 都在文件里 |
| `.sxsproj` 重新加载 → 再导出 `.sv2` | `meta` 与 `phonemes` 仍然完整 —— **ext 与"来源插件"解耦**生效 |
| 改 BPM 100 → Ctrl+S | 插件回写原文件，`bpm: 100`、`meta` 保留；`demo2.sv2.bak` 是旧版本 |
| 审计 | 三次 `file-save`：`{ext:'.sv2', ok:true, bytes:1093, warnings:0, singers:2, fragments:2}` |
| 音素微调 + 颤音 | 导出返回两条 warning（中/英随 locale），文件照常写出 |
| 单测 | `pluginExt` 16 / `pluginSave` 15 |

#### 这一轮抓到并修掉的问题

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | `.sv2 → .sxsproj → .sv2` 之后 `meta` 与音素全丢 | ext 原先挂在 `projectImportSource` 上，而它只在"从插件打开"时设置；`loadFrom` 一份 .sxsproj 时 `fromPlugin=false`，ext 直接没接住 | 拆出独立的 `state.projectExt = { schema, root }`，与来源解耦 |
| 2 | `ext` 里超过 10 万字符的值被静默截断（变成合法但损坏的数据） | 工程文档的 `stringLength` 上限套到了 ext 子树上 | `cloneJson` 识别 `ext` 键，该子树不截断，长度交给 ext 的字节上限判定 |
| 3 | `codec.write` 返回的 `Uint8Array` 到主进程变成 `{__typed, data}` | 运行时统一过 `safe()`，它把 TypedArray 摊成对象 | 加入 `NO_SAFE_METHODS`（与 `pipeline.hook`、`codec.read` 同类） |
| 4 | `saveProject` 固定写 JSON 字符串，插件格式会被写坏 | 它只认 `currentProjectFilePath` 然后 `saveFile(JSON)` | 抽出 `_writeProjectTo`，按目标扩展名分派；MCP 的 `project.saveTo` 共用同一判定 |

**结论**：数据面形成闭环（声明 → 过滤器 → 路由 → 解码 → 校验 → 编辑 → 编码 → 写盘），
且"不认识的东西"有一条明确的通道可以活着回来。剩下的是把 `ext` 的声明真正接到
界面上（音素只读呈现）与 `export.audio`。

### 9.5 M4 第 3 段端到端验证（2026-11-04）

这一段做「呈现」：把 `extSchema.note.phonemes` 真正接到分片编辑器的音素面板上。

#### 为什么是两条带，不是一条

宿主自己的音素是**推导出来的**（`lyric` → 音素表），它决定合成；插件带来的音素是
**别人家坐标系里的同一件事**。合并成一个数组看起来"信息更全"，实际是灾难：

- 用户改一个音素的时长，改的是谁家的？两者没有一一对应关系（`["tS"]` 可能对应
  宿主的一个音素，也可能对应两个）。
- 宿主对不认识的符号（`tS`、`sil`）无法定出时长比例，等宽铺开只是权宜；
  把它混进可拖拽的数组会让人以为"拖了有效"，而合成根本不看它。

所以面板分成上下两层：上层是宿主音素条（彩色、有音量包络、可拖），下层是外部
音素带（灰、只读、等宽切分）。视觉上互不从属，用户一眼知道哪条能改。

#### 关键决定

| 决定 | 为什么 |
|---|---|
| **等宽切分外部音素** | 插件没有给出时长比例，宿主也不能替它编一个。等宽是"我只知道顺序"的诚实表达 |
| **宿主不认识的名字画虚线框** | `en_/jp_/zh_/yue_` 命名空间内画实心灰块，其余（`tS`、`sil`）只画虚线框 —— 后者连"看起来像宿主音素"都不该 |
| **`editable:true` 也不给编辑** | 写回要经过插件的语义校验，宿主代劳只会造出插件不认的值。当前一律只读，`editable` 只影响提示语 |
| **一条 note 只呈现第一个声明的插件** | 两家插件同时声明音素时，界面没有"并列显示两家"的位置。取第一个并在带子右端标出来源 |
| **布局抽成 `getPhonemeBarLayout`** | 渲染与命中检测各算一遍是"点在带子上却选中了宿主音素"的老来源 |
| **逐帧结果用 WeakMap 缓存** | 绘制是 16ms 路径，`readPhonemeField` 每次都要遍历 ext 键 + 字段表 |
| **`extSchema` 挂在 project payload 上带进分片编辑器** | 它本来就是文档属性，主进程转发时不需要认识它；另开一个 IPC 字段等于让主进程替渲染层解释插件 |

#### 实机走查

手段同前（xvfb + CDP + 真实 second-instance 投递）。测试文件 4 个音符：
`["l","a"]`（全外部）、`["en_AA1","tS"]`（混合）、`["s","a"]`、无音素。

| 场景 | 结果 |
|---|---|
| 打开 `ext-phon.sv2` → 双击分片 → Phoneme 面板 | 上排 4 段宿主音素条（la/ah/sa/ma + 音量包络），下排灰色带：`l` `a` / `en_AA1` `tS` / `s` `a` / 第 4 条留空 |
| 边框样式 | `en_AA1` 实心浅灰块（宿主命名空间内），`l`/`a`/`tS`/`s` 虚线框（宿主不认识的方言） |
| 标题行 | 左侧 `Phoneme`，右侧 `外部音素只读`；带子右端 `外部 · example-sv2` |
| 点宿主音素条 | 该格出现选中框与包络控制点（原有行为不变） |
| 点外部音素带 | 选中态清除并重绘 —— 带子不接受任何指针交互 |
| 悬停外部带 | 光标保持默认（不是 `ew-resize` / `crosshair`） |
| 内置工程（无 `extSchema`） | 面板高度与 M4 之前完全一致，没有灰带、没有"只读"字样 |
| 改 BPM / 拖动音符（触发 400ms 自动保存） | `.sv2` 仍是 `"format": "sv2"`，`phonemes` 三处逐字保留 |
| 单测 | `pluginPhonemes` 19（归一化 / 命名空间 / 反查） |

#### 这一轮抓到并修掉的问题

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | **自动保存把 `.sv2` 写成一坨 SXSEditor JSON**，下次插件读它报"不是 SV2 工程" | `_commitAutoSave` 绕过 `_writeProjectTo`，直接 `serializeProject` + `saveFile`；M4-2 只覆盖了 Ctrl+S 与 MCP 两条路径 | 自动保存改走同一分派；插件警告在自动保存时静默（存入 `state.projectSaveWarnings`），手动保存照常弹 —— 否则拖一个音符弹一次 |
| 2 | 点面板空白 / 外部带后高亮不消失，看起来"点不掉" | `handlePhonemeMouseDown` 清了状态却没重绘，等下一次性渲染才消失 | 清除选中后若之前有选中则 `render()` |

**结论**：`ext` 从"能存能取"变成"能看见"。用户打开一份别家的工程，能对照看到
两套音素体系，而不是只看到宿主自己解释出来的那一套。剩余：`ext.curve` /
`ext.render` 的运行时接线（声明已能通过校验，尚未参与绘制与音频后处理）。

**M3 模型与推理面**：模型调用面（§12，端点/绑定/网关/授权/MCP 工具）、`synthesis.backend`
迁移、二进制结果、`postWaveform` hook —— 均已落地。剩 v1 adapter（`compat/v1Adapter.js`）
与 `preEncoder` / `postMel` 两个 stage。
**M4 数据面**：四段全部落地（§9.3 打开、§9.4 保存与扩展域、§9.5 音素呈现、
§9.6 曲线/渲染意图/导出器/旁挂/系统关联）。`ext.render` 的语义有单测覆盖，
但本机没有模型文件，**没有一次带声音的端到端验证**（见 §9.6"没验到的部分"）。
**M5 智能面**：`automation.method` 进 MCP **已落地**（§9.7），命令行入口
`--cli plugin` **已落地**（§9.8），插件密钥 `permissions.secrets` **已落地**（§9.9：
每插件一个加密文件、读写分权、审计只记 key、`encrypted` 如实报告，作者指南见
[`plugins-secrets.md`](plugins-secrets.md)）。剩余：跨插件 service 提供/消费、插件
方法的长任务形态 —— 落地"一句话 → 一句唱"（`llm.provider` 已并入 M3 的模型调用面）。
**M6 硬化**：签名校验、marketplace 接口（只留接口）、三平台验证、a11y/主题。

### 9.6 M4 第 4 段端到端验证（2026-11-04）

**这一轮要把 `ext` 从"存得住"推到"用得上"**：曲线要画出来、渲染意图要能到
pipeline、成品要能交给插件编码、一次保存要能写多个文件、插件扩展名要能进系统。

| # | 做了什么 | 关键决策 |
|---|---|---|
| 1 | `ext.curve` 绘制 | 曲线画在**音符矩形内**（按音符高度归一），不画进参数 lane —— lane 上的东西用户会以为能拖，而拖了不会有任何效果 |
| 2 | `ext.render` 工程级意图 | `extSchema[*].render` 折成 `{stage: {pluginId: order}}` 推到主进程。**有声明时该 stage 变白名单**：工程说了"我的声音靠谁处理"，就不该让别的插件偷偷插进来；没声明时保持现状（装了就跑） |
| 3 | `contributes.exporters` | 成品格式独立于工程格式：入参是交错浮点采样，出参是字节。扩展名必须与声明一致（否则改个后缀就能让插件往任意后缀写字节） |
| 4 | 旁挂文件 | `codec.write` 可返回 `files: [{name, bytes}]`。名字只能是纯文件名，与主文件同名、带分隔符、点开头一律拒绝 |
| 5 | Windows 插件扩展名关联 | 独立开关（默认关），ProgId 固定前缀 `SXSEditor.Plugin.`，靠前缀枚举做清理 —— 孤儿项唯一可靠的解法。开发模式（未打包）永不执行 |

新增文件：

```
src/shared/pluginCurve.js          曲线取值：归一 / 求值 / 声明修饰（linear/step/smooth）
src/shared/pluginRenderIntent.js   extSchema.render → pipeline 执行器的意图快照
test/pluginCurve.test.js           23
test/pluginRenderIntent.test.js    16
test/pluginExporters.test.js       19
test/pluginSidecar.test.js          9
```

#### 走查（xvfb + CDP + 真实 second-instance）

| 场景 | 结果 |
|---|---|
| 打开带 `dynamics` 的 `.sv2`（4 个音符：升降曲线 / 波浪 / 水平 / 无数据） | 前三条音符内部出现灰色虚线，形状与数据一致；第四条没有线 |
| 打开不带任何曲线的 `.sv2` | 音符内部干净，无任何折线 |
| 导出对话框 | "格式"下拉出现 `WAV (built-in encoder)` 与 `PCM 16-bit (example) · .pcm`，切换后路径扩展名自动从 `.wav` 变成 `.pcm` |
| `pluginHost.exportAudio()`（绕过合成，直接给采样） | `{ok:true, bytes:19200}` = 4800 帧 × 2 声道 × 2 字节；warnings 带回"裸 PCM 不含格式信息" |
| PCM 内容 | 前 12 个采样的左右声道一致，峰值 16384（= 0.5 × 32767），正弦未被截断 |
| 导出器与扩展名不符（`.wav` 用 pcm16） | `INVALID_REQUEST: Exporter pcm16 writes .pcm, target is .wav`，文件未创建 |
| `pluginHost.setRenderIntent()` / `null` | 均返回 `{ok:true}`（通道通；语义由单测覆盖） |
| MCP `project.save` 往返 | `.sv2` 重新写出：bpm 96→98 生效，`meta` / `phonemes` / `dynamics` 逐字保留 |

#### 这一轮抓到并修掉的问题

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | Agent 用 MCP `project.replace` / `loadFrom` 载入一份带 `extSchema` 的工程，再保存时插件数据全丢 | `replace()` 只搬 `project/singers/fragments`，`ext` 与 `extSchema` 不在它的视野里；且不推渲染意图 | `replace()` 里一并写 `state.projectExt` 并调 `syncRenderIntent()`（`projectManager` 导出这个函数） |

#### 没验到的部分（写在明处）

本机没有模型文件（`svs:init` 报 `Model file does not exist`），所以：

- **导出对话框的完整流程**只验到"选了格式、路径对了、IPC 能编码写盘"，
  没有跑过一次"合成 → 重采样 → 插件编码"的完整链路；
- `ext.render` 的白名单效果没有一次带声音的验证，只有 `PipelineHooks` 单测
  （顺序改变真的改变处理结果那一条）。

Windows 注册表相关代码在本机（Linux）不会执行，只能验证 ProgId 的生成与反解；
`reg add/query/delete` 的实际行为需要在 Windows 安装版上再过一遍。

### 9.7 M5 第 1 段端到端验证：插件方法进 MCP（2026-11-05）

**这一段要回答的是**：插件把命令交给自动化面之后，agent 看到的能力表到底由谁决定，
以及一次调用经过哪些进程。答案必须在实机上验证，因为中间横着三层（桥接层校验 →
插件服务 → utilityProcess），任何一层没接上，"能看到方法"和"能调用成功"就是两件事。

| # | 做了什么 | 关键决策 |
|---|---|---|
| 1 | 方法名 = 完整命令 id（`<pluginId>.<localId>`） | 用裸 `localId` 会让两个插件都声明的 `export` 互相顶掉，"谁装得晚谁赢"在自动化里是灾难：同一句 agent 脚本在别人机器上会调到另一个实现 |
| 2 | 校验期三条硬规则 | ① 必须指向本插件已声明的命令（否则安装能过、调用才 404）；② `methods` 非空必须有 `permissions.automation: ['expose']`；③ 拼出的名字不得等于内置方法（`project` 插件 + `get` 命令就会撞 `project.get`） |
| 3 | **在桥接层派发，不经渲染层** | 设计草案（§7 表格）原本写的是"渲染层动态命令表"。实际实现改在主进程：桥接层是所有调用的唯一闸门，未注册的方法在 `dispatch` 之前就被拒；而插件方法跑在 utilityProcess 里，本来就不需要窗口 —— 转发给渲染层会让"主窗口存在"变成前提，恰恰违背无界面自动化 |
| 4 | `setPluginAutomation(provider)` 注入函数而非快照 | 插件随时装卸，桥接层每次请求现取 `list()`；否则装完插件要重启才出现 |
| 5 | `/schema` 与 `capabilities` 合并插件条目，带 `source: plugin:<id>` | agent 必须能回答"这个方法是谁给的"，否则一个陌生方法名等于黑盒 |
| 6 | 用户级开关（管理器勾选框） | manifest 权限是**作者**在安装前声明，这个开关是**用户**事后说"不要"。只有前者，用户要么接受要么卸载；只有后者，作者能从用户没看过的权限清单里偷偷暴露。关掉只影响自动化面，不影响插件自己的菜单 |
| 7 | `headless: false` 的命令不导出 | 作者说了"这条命令需要有人看着界面"（例如弹向导），自动化调用它只会卡在没人点的对话框上 |
| 8 | 审计 | 每次调用写 `automation-invoke`（方法、成败、错误码、耗时）；开关变更写 `automation` |
| 9 | stdio 网关补拉 `/schema` | 网关的工具表来自本地 schema（静态），插件方法是运行期事实。`tools/list` 时按 30s 窗口拉一次；`tools/call` 未命中时强制补拉一次再重试 —— 客户端不回 `tools/list` 直接调也成立 |

新增/改动文件：

```
src/shared/pluginAutomation.js        方法命名、公开条目投影、插件错误码 → MCP 错误码
src/shared/pluginManifest.js          validateAutomation 交叉校验命令 / 权限 / 内置同名
src/main/plugins/PluginRegistry.js    'automation' 贡献表 + 快照行
src/main/plugins/PluginService.js     listAutomationMethods / runAutomationMethod / setAutomationExpose
src/main/mcpBridge.js                 setPluginAutomation / publicSchema / target:'plugin' 派发
src/main.js                           注入 provider
scripts/sxseditor-mcp.js              tools/list 合并插件工具（+ miss 时补拉）
src/pluginManager/index.js|.css       自动化块：开关 + 方法清单 + 状态
src/shared/ipcChannels.js|preload|windowCapabilities  plugin-host:set-automation（仅管理器）
plugins/example-sv2/*                 示例：stats 命令（返回处理计数，参数 includeLast）
test/pluginAutomation.test.js         26（校验 / 命名 / 注册表 / 桥接）
```

#### 走查（xvfb + CDP 9222 + 主进程 Inspector 9229 + 真实 second-instance）

| 场景 | 结果 |
|---|---|
| `POST /automation {method:"capabilities"}` | `features.pluginMethods: 1`，methods 里出现 `example-sv2.stats` |
| `GET /schema` | 该条目 `target: "plugin"`、`source: "plugin:example-sv2"`、`long: true`、`params` 为开放 object |
| 调用 `example-sv2.stats` | `{read:0,written:0,lastFile:"",uptimeMs:6}` —— 6ms 说明它刚刚 fork 出插件进程，是真在 utilityProcess 里跑的 |
| 传 `{includeLast:false}` | `lastFile` 变 `null`：参数原样到达插件，宿主没有按内置 schema 过滤 |
| second-instance 投递 `auto.sv2` 后再调 | `{read:1,lastFile:"auto.sv2"}`，同时 `project.get` 返回 bpm 96 / Lead —— 插件解码与自动化调用看到的是同一份插件状态 |
| 未暴露的方法名 | `UNKNOWN_METHOD`，hint 指向 `capabilities` 而不是 `/schema` |
| 管理器卡片 | "External automation" + 勾选框 + 方法行 `example-sv2.stats` / 绿色 `exposed`；无方法的插件显示"未声明任何自动化方法" |
| 在管理器里取消勾选 | `/schema` 里条目消失、`capabilities.pluginMethods: 0`、直接调用变 `UNKNOWN_METHOD` |
| 重新勾选 | 方法立即恢复，调用成功 |
| 停用整个插件 | 方法同样消失；重新启用后恢复（插件进程重启，计数归零） |
| stdio 网关 `tools/list` | 69 个工具，含 `sxs_example-sv2_stats`，描述带 `[plugin:example-sv2]` |
| stdio 网关直接 `tools/call`（不先 list） | 补拉后调用成功，返回 `{read:1,lastFile:"auto.sv2"}` |
| 审计 | `logs/plugins-audit.jsonl` 有 `automation-invoke`（含 ms/ok/code）与两次 `automation` 开关记录；`mcp-audit.log` 有对应 method 行 |

#### 这一轮抓到并修掉的问题

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | stdio 网关：`tools/list` 里能看到插件工具，`tools/call` 却 `UNKNOWN_TOOL` | `route()` 只查本地静态表；合并只发生在 `tools/list` 分支 | 未命中时强制补拉一次 `/schema` 再重试（方法名 miss 是唯一"表该更新"的可靠信号） |
| 2 | 管理器"External automation"标题折成两行，方法行挤在标签列里 | 复用了 `.pm-row-label`（普通行里固定 92px 宽） | 标题列在该块内改为自适应宽 + 方法行独立样式（等宽、底框、状态靠右） |

#### 没做的部分（M5 剩余）

- `--cli plugin` 子命令：把同一批方法暴露给命令行（当前只有 MCP 两个入口）；
- 跨插件 service 提供/消费（manifest 已校验 `services.provides`，实现为零）；
- secrets 的加密存储与权限门（`permissions.secrets` 已有词表，未接线）；
- 插件方法的长任务形态：现在按命令超时 60s 掐断，尚未支持 `async: true` 提交成 job
  （桥接层的 job 通道本身支持，插件侧没有配合的"进度/取消"语义）。

### 9.8 M5 第 2 段：`--cli plugin`（2026-11-05）

**这一段要回答的是**：命令行入口和 MCP 是什么关系。答案不是"再实现一遍"，而是
**CLI 是一个不需要配 token 的 MCP 客户端** —— 它默认把命令转给已运行实例的
`/automation`，走同一个 `dispatch`、同一套权限门、同一份审计。

| # | 做了什么 | 关键决策 |
|---|---|---|
| 1 | `plugin list`：磁盘列 + live 列并排 | 左边是"装了哪些插件"（磁盘事实），右边是"现在真的能调什么"（运行时事实）。只报一个都会骗人：停在磁盘上看不到"用户关了开关"，只看运行态又看不到"为什么没装" |
| 2 | `plugin methods` | live 模式读 `/schema` 里 `target: "plugin"` 的条目，与 agent 看到的能力表逐字一致；无实例时 init 一个临时服务走 `listAutomationMethods`，保持单一定义来源 |
| 3 | `plugin call <pluginId>.<commandId>` | live 模式 POST `/automation`；`--params` 收 JSON，`-` 从 stdin 读；`--json` 单行输出、人类提示全走 stderr，保证可管道 |
| 4 | **默认转发，而不是自己起一套** | 插件方法是运行期能力。两个进程共用同一个 `userData`：`loadAll` 结束时都会 `writeRegistry`，互相覆盖；审计里也会出现两份无法区分来源的 `automation-invoke`。转发还顺带保证了"CLI 看到的就是 GUI 看到的" |
| 5 | `--local` 才起临时实例，且必须自报家门 | 无 GUI 的 CI / 调试需要它。但它的插件状态是新的（`stats.read` 从 0 开始），所以输出里明写"temporary local instance — plugin state is not shared with the GUI" |
| 6 | `plugin automation <id> on\|off` 直接写 store，不起服务 | 改一个布尔值不值得 fork 每个插件的进程；而且 `PluginService.init()` 的 `loadAll` 会先读一遍磁盘，再把内存快照写回去，容易把刚写的值覆盖掉 |
| 7 | 开关写盘后**不假装生效** | 运行实例用的是自己的内存投影，改文件不会让它重新读盘。命令输出"已写入；运行中的实例需要重载插件或重启后生效"，并用实机证明了这句话（见走查） |
| 8 | 审计带 `via: 'cli'` | GUI 里点的开关与脚本写的开关必须能分开 —— 出问题时第一个要回答的就是"谁改的" |
| 9 | 显式 `SXSEDITOR_MCP_ENDPOINT` 只认它 | 否则把环境变量指向一个"故意不存在"的文件时，会继续去读用户真实的 endpoint 并悄悄连上 GUI。测试与脚本都需要"确定连不到"的能力 |

新增/改动文件：

```
src/main/cliPlugin.js        list / methods / call / automation（端点发现、转发、临时实例）
src/main/cli.js              子命令分发、--plugin/--params/--json/--local、位置参数、HELP_TEXT
test/cliPlugin.test.js       11（磁盘快照 / 转发 / 开关写盘）
docs/dev/plugins-automation.md  作者视角的命令行用法
```

#### 走查（xvfb + 真实 GUI 实例 + 真实 second-instance）

| 场景 | 结果 |
|---|---|
| 无实例 `plugin list` | `4 on disk, no running instance (disk state only)`，每行 `automation:--` / `automation:on` |
| 无实例 `plugin methods` | 1 条 `example-sv2.stats`，末尾标注 `(temporary local instance …)` |
| 无实例 `plugin call --params '{"includeLast":false}' --json` | `{"ok":true,"result":{"read":0,…,"lastFile":null,"uptimeMs":2}}`，exit 0 |
| 有实例 `plugin list` | `live instance on port 45027 (pid …)`，该行 `live: example-sv2.stats` |
| 连续两次 `call`（live） | `uptimeMs` 6 → 3881 → 11317 连续增长：三次调用落在**同一个**插件进程里，不是每次新 fork |
| second-instance 投递 `auto.sv2` 后 `call` | `{"read":1,"lastFile":"auto.sv2"}`，同时 GUI 主窗口正常 —— CLI 与启动文件走的是同一份插件状态 |
| 不存在的方法 | `[ERROR] UNKNOWN_METHOD: Unknown method example-sv2.nope`，exit 1 |
| 方法名缺插件前缀 | 发请求前就拒绝，exit 2（`lastRequest` 为空，单测断言） |
| `automation example-sv2 off` | `example-sv2: automation off — 已写入；运行中的实例（:45027）需要重载插件或重启后生效。`；审计多一条 `{expose:false, via:"cli"}` |
| 关闭后立刻 live 调用 | 仍然成功（`read:1`，`uptimeMs:21693`）—— 证明第 7 条的提示是真的，不是免责声明 |
| 关闭后 `--local` 调用 | `PERMISSION_DENIED: 用户已在插件管理器里关闭 example-sv2 的自动化调用`，exit 1 —— 磁盘状态确实变了，下次启动就会被挡住 |
| `automation on` 后 `--local` | 恢复可调；用 `--params -` 从 stdin 传参，`lastFile` 变 `null` |

#### 这一轮抓到并修掉的问题

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | `list` 的 live 列把 `project.get` 也算成插件方法 | `capabilities.methods` 是**全部**方法名，按"带点"筛内置方法也会命中 | 改读 `/schema` 的 `target === 'plugin'`（权威标记） |
| 2 | `plugin automation` 写盘后又变回原值 | 用 `PluginService.init()` 写盘：`loadAll()` 先读磁盘旧值，`setAutomationExpose` 再读一次写回，两个快照互相覆盖 | 改为直接走 `PluginStateStore` 的读改写，不启动服务 |
| 3 | 单测里所有插件都判成 `invalid` | mocha 下 `require('electron')` 得到的是可执行文件路径字符串，取不到 `app.getVersion()`，engines 校验拿到 `undefined` | 抽出 `hostAppVersion()` 并对测试暴露钩子（与 `store._setRootForTests` 同形） |

#### 没做的部分

- `plugin install/uninstall/enable/disable` 没进 CLI：安装要解包、要确认权限，属于交互式
  操作，不适合做成一行命令；需要脚本化时走 MCP 也没有对应方法（M6 的 marketplace 再谈）；
- CLI 本地调用与 MCP 调用在 `automation-invoke` 里不带入口标记（只有开关变更带 `via`）。
  要区分入口，MCP 侧看 `mcp-audit.log`，CLI 本地侧只能靠时间戳 —— 够用，但不算完备。

### 9.9 M5 第 3 段：插件密钥（2026-11-05）

**这一段要回答的是**：插件要存一个 token 时应该放哪。在此之前只有两个选择：
`ctx.state`（明文 JSON，随备份/日志/用户文件夹四处跑）和 `ctx.settings`（用户
在设置页看得见、改得了）。两者都不适合凭据，于是作者只能自己 `require('node:fs')`
去写文件 —— 每人都要重新实现一遍加密、权限位与落盘。

| # | 做了什么 | 关键决策 |
|---|---|---|
| 1 | 每个插件一个文件 `plugin-data/<id>/secrets.enc` | 不用一张大表：卸载时"删不删数据"、备份、只清某个插件的密钥，都要按插件粒度操作。一张表会让一次误删波及所有人 |
| 2 | 把模型端点的 `safeSecrets` 抽成 `src/main/secretsStore.js`，原文件变 re-export | 加密、0600、tmp→rename、"降级时必须说出来"这四件事一旦有两份实现就会漂移，而漂移的方向通常是"某一边忘了标记明文" |
| 3 | 读与写是**两个**权限 | 只读的展示面板没有理由能覆盖用户的 token。`secrets.get/keys` 要 `read`，`set/delete` 要 `write` |
| 4 | `encrypted` 是事实而不是承诺 | Linux 无 keyring 时 `safeStorage` 不可用：宿主仍然存（否则作者只能写明文 state），但返回值、文件头、`ctx.secrets.keys()` 都会带 `encrypted:false`。让用户知道，比让用户以为安全要好 |
| 5 | 审计只记 key 名与动作 | `secret` 事件含 `{action, key, created|existed, encrypted}`，**不含值**。能回答"谁在什么时候改了哪个密钥"，答不出"值是什么"——后者不该由日志承担 |
| 6 | 上限 64 key × 8KB（UTF-8 字节） | 密钥不是数据库。超过这个量级说明插件在拿它当存储用；早拒比晚崩好 |
| 7 | 目录显式 `chmod 700` | `mkdirSync(mode:0o700)` 只对**新建**目录生效；而 `plugin-data/<id>` 是 installer 用默认 umask 建的（755）。不改的话同机其他用户能列出"这个插件存了密钥文件" |
| 8 | 单条解密失败不拖垮整个文件 | 换机、重装、从备份恢复 userData 都会让旧密文解不开。跳过该条并 warn，其余条目照常可用 |
| 9 | 卸载时清缓存，`keepData` 时保留文件 | 重新安装同一 id 必须从磁盘重读（`invalidate`），否则会拿到上一份内存里的旧密钥 |

新增/改动文件：

```
src/main/secretsStore.js             加密存储（models 与 plugins 共用），新增 keys/has/size
src/main/models/safeSecrets.js       改为 re-export（调用点与测试路径不变）
src/main/plugins/PluginSecrets.js    每插件归属、键值校验、上限、invalidate/clear
src/main/plugins/PluginService.js    secrets.get/set/delete/keys 四个 host 分支 + 权限门 + 审计
src/main/plugins/runtime/pluginRuntimeEntry.js   ctx.secrets
plugins/example-secrets/*            示例：save / reveal / clear（可被自动化调用）
test/pluginSecrets.test.js           18（校验 / 存储 / 隔离 / 权限门 / 审计）
docs/dev/plugins-secrets.md          作者指南
```

#### 走查（xvfb + 真实 utilityProcess，经 `--cli plugin call --local`）

| 场景 | 结果 |
|---|---|
| `example-secrets.save --params '{"value":"sk-walkthrough-2026"}'` | `{key:"demo.token", created:true, bytes:19, encrypted:false}` |
| 落盘文件 | `{"version":1,"encrypted":false,"data":{"demo.token":"sk-walkthrough-2026"}}`，模式 **600**；目录从 755 收紧为 **700** |
| 新进程 `example-secrets.reveal` | `{present:true, token:"sk-walkthrough-2026", keys:["demo.token"], encrypted:false}` —— 跨进程从磁盘读回，不是内存 |
| 审计 | 一条 `secret {action:"set", key:"demo.token", created:true, encrypted:false}`；`grep` 明文值命中 **0** 次 |
| `example-secrets.clear` 后再 reveal | 文件变 `{"data":{}}`，`present:false`、`keys:[]` |
| 无 `secrets` 权限的插件调 `ctx.secrets.get` | 跨进程返回 `{ok:false, code:"PERMISSION_DENIED", message:"缺少权限 secrets:read"}`；审计多一条 `secret-denied` |
| 非法 key `../x` / 9KB 值 | `INVALID_REQUEST`，且不创建文件（单测断言） |

本机是 Linux + Xvfb，没有可用密钥环，因此 `encrypted:false` 是**预期的真实结果**；
Windows（DPAPI）与 macOS（Keychain）下的密文路径由单测里的假 `safeStorage` 覆盖，
没有在本机验证。

#### 边界（写在明处）

- **这不是沙箱**。插件仍可 `require('node:fs')` 读别人的 `secrets.enc`；加密可用时
  读到的是密文，不可用时就是明文。`ctx.secrets` 防的是"意外泄漏到日志/界面/工程
  文件/备份"，不是"恶意插件偷看"。真正的边界是 utilityProcess + 安装时的权限告知。
- **管理器界面还没有密钥视图**：现在只能在插件自己的 UI 里看到 `keys()` 的数量，
  或从命令行查。用户级"清除这个插件的密钥"按钮属于 M6 的权限界面。
- **示例插件把 token 回显在返回值里**，只为让命令行验证往返；真实插件不该这么做
  （文档里已用加粗写了这一条）。

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

当时未接线的部分（第 5 段已补齐）：`tts` / `asr` / `midi` / `accompaniment` 的二进制
结果、`local-process` 的真实后端（`synthesis.backend` 迁移）。

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

**第 4 段已落地（2026-11-04）**：

```
docs/dev/plugins-models.md            作者文档：task 契约 / ctx.models / 声明 / 错误码 / 禁自建 HTTP
plugins/example-models/               示例插件：ask（流式）+ probeNet（故意违规看封锁）
src/main/plugins/runtime/netGuard.js  插件进程出站封锁
```

- `contributes.models` 从"接受但不生效"变成真校验：`consumes`（≤8，必须是已知 task）、
  `preferred`（≤16，`endpoint` 与 `provider` 至少给一个）。声明了却漏
  `permissions.models: ['consume']` 直接拒绝 —— 权限清单是给用户看的，不能与实际行为脱节。
- `preferredBy` 此前是个空功能（`setPreferences` 全仓没人调用，★ 永远不出现）。
  改为 `setPreferenceSource` 惰性供数：插件随时可能被停用/卸载，缓存一份必然过期。
- 出站封锁是**防误用**：`Module._load` 拦 `http/https/http2/net/tls/dgram/dns/undici`，
  全局 `fetch` / `WebSocket` / `EventSource` 单独覆盖（Node 18+ 的 fetch 走内置 undici，
  只拦 require 拦不住）。错误码 `PLUGIN_NET_BLOCKED`，消息里直接给出改法。
  真正的边界仍是架构：插件拿不到 `baseUrl` 与密钥。

实机验证：插件安装后 `pendingContributions` 为空、`contributes.models` 齐全；
`ask` 返回结果并写进状态栏；`probeNet` 的 `require('node:https')` 与 `fetch` 都被拦；
把端点 `provider` 改成 `openai` 后，Chat 绑定行出现 ★ 且 tooltip 写明推荐原因。

**第 5 段已落地（2026-11-04）—— 把承诺兑现成可用的东西**：

```
src/main/models/ModelGateway.js       二进制结果收集与交付（内联 / 落盘）
src/main/models/ModelHandleStore.js   新增 stat()：读之前先知道多大
src/main/models/adapters/openaiCompatible.js  /audio/speech、/audio/transcriptions
src/main/models/synthesisBackend.js   v1 歌声后端 → local-process 的 singing
src/main/plugins/PipelineHooks.js     postWaveform hook 执行器 + 熔断
plugins/example-hook/                 hook 最小示例（淡入 + -3dB）
```

**二进制结果**（此前 `output === 'binary'` 的五个 task 实际不可用）：

- 二进制分片**不进** 16ms 文本合并窗口 —— `Buffer.join('')` 是不可逆的损坏。改为
  全收，结束时一次性交付：`≤256KB` 内联成 `done.binary = { base64, size, mime, sha256 }`，
  超过则 `handles.put()` 落盘，`done.handle` 给 capability token。
- 不分块下发的理由：内联与句柄是两条完全不同的调用方代码路径，中途切换比一次性
  交付更难用。进度改用 `progress { received, mime }`，200ms 节流。
- 新增 `RESULT_TOO_LARGE`（单次 128MB 上限）：截断的音频比报错难查得多 —— 听起来
  "差不多对"，实际少了几秒。
- 二进制输入（`asr`）走句柄：`input: { handle }`。`stat()` 先取大小用于确认弹窗与
  上限判断，**授权通过之后**才 `read()` 读盘 —— 未授权的调用不该让宿主先把 64MB
  读进内存再说"不给"。
- 内联不豁免审计：`_finish` 里记 `bytes` + `sha256`，落盘再加 `fileRef`。

**`synthesis.backend` 迁移**：v1 的歌声后端（`pluginHost.synthesize` 返回 pcm）被包装
成 `local-process` 的 `singing` 实现，投影成 `builtin:singing.<pluginId>` 端点。从此
歌声、TTS、MIDI 走**同一条**调用面：同一套授权、超时、审计、取消。pcm 统一编成
32bit float WAV（`leadingSamples` 补零，多声道交错），不留 Float32Array 跨进程。
插件列表为空时**不做孤儿清理** —— 那可能只是还没加载，删掉就连带绑定一起没了。

**pipeline hook**：`contributes.pipeline` 此前是"接受但不生效"（注册表已登记，
但没有执行器）。现在 `postWaveform` + `kind: 'js'` 真能跑：

- 从**注册表**读 hook 而不是从 manifest 读。停用/重载过程中 manifest 还在 record 上，
  但贡献表已撤销 —— 按 manifest 读会去调一个不存在的插件，表现为每次合成多等一次超时。
- hook 失败不拖垮合成：跳过并记日志，连续 3 次熔断，插件重载后恢复。
- 长度必须不变：改样本数 = 时间轴错位，拒绝并记失败。
- 只对整段合成生效。多分片流式是边合成边推，末端再处理会让"听到的"与"导出的"不一致。
- 返回值不过 `safe()`：那里会把 TypedArray 摊成数组并截断到 100 万项，音频会被静默截短。

实机验证（xvfb + CDP + 假 OpenAI 兼容端点）：
`model.invoke { task: 'tts' }` → 32KB WAV 内联（sha256 与审计一致）；12 秒音频
（384KB）→ `handle`，`model.read { saveAs }` 落盘 384044 字节、RIFF 头正确；
同一句柄作 `asr` 的输入 → 返回假转写文本（多分段总量 384309 字节）；
`example-hook` 安装后 `registry.stats().hook === 1`，`admin().pipelineHooks` 显示
`{ pluginId: 'example-hook', hook: 'soften', stage: 'postWaveform', disabled: false }`。

仍待做：`contributes.pipeline` 的 `kind: 'model'` 与 `preEncoder` / `postMel` 两个
stage（需要张量留在推理进程里）；`contributes.models.provides`（插件注册自己的端点）。

## 13. 参考

- v1 契约（歌声后端）：[`plugins.md`](plugins.md)
- v2 模型调用（插件作者视角）：[`plugins-models.md`](plugins-models.md)
- 实施过程中的取舍记录：[`SXSEditor-实施记录.md`](SXSEditor-实施记录.md)
- 界面走查清单：`/workspace/SXSEditor-界面走查清单.md`（仓库外）
