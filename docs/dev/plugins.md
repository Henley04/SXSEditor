# SXSEditor 歌声后端插件系统（主进程侧 · 契约 v1）

> **面向读者**：本文是面向插件作者的**完整技术规格**，与网页版
> [`plugins.html`](plugins.html)（导航 → 开发者指南 → 插件后端）内容同源。
> 网页版是这个功能面向公众的正式文档入口；若只关心如何安装和使用插件，请看
> 用户指南的「插件后端」页。
>
> 适用范围：`src/main/pluginHost.js`（宿主内核）、`src/main/pluginIpc.js`（IPC 层）、
> `src/shared/pluginContract.js`（**契约唯一真源**，校验常量与纯函数）、
> `plugins/example-concat/`（可直接运行的模板插件）。
>
> 目标：让 SoulX-Singer 以外的模型后端（以及传统拼接方案）以插件形式接入，
> 且**所有原本会传给模型的参数都能原样传给插件**。

---

## 0. 设计取向：插件默认跑在 worker 线程里

### 历史原因（仍然成立的一半）

歌声后端是延迟敏感的热路径：30 秒片段在 44100Hz 单声道就是 1.3M 个 float。早期
版本据此把插件 `require()` **直载进主进程本线程**，让 `request.options` 与内置
pipeline 收到的 options 成为同一个对象引用，`refAudioWavBuffer` / `pitchCurveF0` /
`refF0Data` 这些 Float32Array 不克隆、不过 IPC。

这个理由只对了一半：**数据**确实不该序列化，但**执行**必须离开主进程事件循环。

### 为什么必须改（P0 的实测依据）

插件里有同步忙等时：

```js
const t = Date.now();
while (Date.now() - t < 2000) { /* 一个普通的自写函数 */ }
```

这段同步代码会**独占主进程事件循环**，宿主的 `setTimeout` 到点了也拿不到执行权，
于是 `Promise.race([call, timeout])` 里的超时分支永远不跑 —— 审计实测：2s 忙等的
插件在 300ms 超时下照样返回 success。单线程内部**没有任何手段**能抢占同步代码，
唯一能真正掐断它的是从外部杀掉整条线程：`worker.terminate()`。

> 因此现在的默认模式是 `worker`。这不是"更好的隔离习惯"，是超时护栏能不能兑现的
> 分水岭。

### 两种执行模式

| 模式 | 启用方式 | 超时是否真能抢占 | 适用 |
|------|----------|------------------|------|
| `worker`（**默认**） | manifest 不用写，或显式 `"executionMode": "worker"` | ✅ 到点钟 `terminate()` 直接杀线程 | 绝大多数插件 |
| `inprocess` | manifest 必须显式声明，**且**通过宿主侧 `inprocessWhitelist`（记 warn 日志） | ❌ 见下方诚实边界 | 确实需要主进程才有的资源（如自定义 WebNN/WebGPU 上下文）的插件 |

> ### ⚠️ 诚实的边界：`inprocess` 模式下的同步阻塞**无法被抢占**
>
> `inprocess` 模式用 `Promise.race + setTimeout` 做超时，而它只能拦住**异步等待**
> （插件在 await 一个永不 resolve 的 Promise）。插件只要跑一段同步忙等 / 死循环，
> 主进程的定时器就永远不会到点，超时在它结束前不会有任何作用 —— 窗口冻结会持续
> 到插件自己返回为止。
>
> 也就是说：**此模式下文档里任何"超时保护"的说法都不成立**。选它的插件作者需要
> 自己保证不在主线程上跑不可控长度的同步代码。宿主会在加载时打一条 warn 日志，
> 把这条边界写进运行现场，而不是只在文档里提一句。

### worker 模式的实际代价（都已实测）

* **大数组零拷贝**：请求里的 Float32Array 与返回的 `pcm` 走 `postMessage` 的
  **transfer list**，ArrayBuffer 所有权转移而非克隆 —— 转移后请求侧的 TypedArray
  变成 detached（`byteLength === 0`），这正是"没有发生复制"的判据。4MB 实测在
  毫秒级，多层两种模式下同一插件的结果逐样本一致。
* **函数不能跨线程**：`options.onProgress` / `onChunkAudio` / `refF0Extractor`
  这类函数留在主进程，插件侧拿到**同名的回调代理**，插件调 `host.emitProgress(50)`
  → worker postMessage → 主进程调用真函数。插件看到的调用签名完全不变，**不需要
  也不能**根据模式写分支。
* **不可克隆的值（Symbol 等）**在跨线程编码时被换成一个 skip 标记并在日志里记录
  位置，而不是让整次调用抛错。

代价由 worker 一侧承担，收益是：宿主不再与插件共享事件循环。

---

## 1. 目录结构

```
<userData>/plugins/            # 插件根目录（pluginHost 加载前会 authorizePath 授权）
└── <pluginId>/                # 目录名必须等于 manifest.id
    ├── manifest.json          # 必填
    └── index.js               # manifest.main 指定的入口（CommonJS）
```

仓库内 `plugins/example-concat/` 是模板插件，**不会**被应用自动加载——把它整个
目录复制到 `<userData>/plugins/` 下才会被发现（或用 `pluginAPI.openPluginsFolder()`
打开目录后手动放入，再 `pluginAPI.reload()`）。

---

## 2. manifest.json

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 反向域名风格 `[a-z0-9][a-z0-9._-]*`，**不得**为 `builtin` / `sxs`，且必须与目录名一致 |
| `name` | string | ✅ | 显示名 |
| `version` | string | ✅ | `x.y.z`（允许 `-beta.1` 后缀） |
| `apiVersion` | number | ✅ | 必须为 `1`，否则**直接拒绝加载** |
| `main` | string | ✅ | 入口 js，**相对路径**（绝对路径 / URL / `..` 一律拒绝） |
| `executionMode` | string | ➖ | `"worker"`（**默认**）或 `"inprocess"`；写别的值按非法 manifest 拒绝。`"inprocess"` 还须通过宿主侧 `inprocessWhitelist`，否则**降级为 worker** 并记 warn（详见 §0 的诚实边界） |
| `capabilities` | object | ✅ | `{synthesize, blockPlayback, streaming, voices}`，缺失项按 `false` 补齐 |
| `trackKinds` | array | ➖ | 轨道种类声明，最多 `PLUGIN_MAX_TRACK_KINDS`(32) 条，逐条走 `validateTrackKind` |
| `description` | string | ➖ | |
| `author` | string | ➖ | |

校验失败不会崩主进程：失败原因会写进主进程日志，并通过 `plugin:list` /
`plugin:reload` 的 `errors[]` 返回给 UI。

```json
{
  "id": "example-concat",
  "name": "示例拼接后端",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "index.js",
  "capabilities": { "synthesize": true, "blockPlayback": true, "streaming": false, "voices": true }
}
```

---

## 3. 入口模块导出（契约 v1）

```js
module.exports = {
  id, name, version, apiVersion: 1,
  capabilities: { synthesize, blockPlayback, streaming, voices },
  trackKinds: [ /* validateTrackKind 校验过的声明 */ ],
  async initialize(ctx),    // 可选；失败则该插件 state='failed'，不可被调用
  async getVoices(kindId),  // capabilities.voices=true 时必填 -> [{id, name, tags?, sampleRate?}]
  async synthesize(request, host) -> SynthResult,
  async dispose(),          // 可选；热重载 / 宿主关闭时调用
};
```

**宿主侧的宽容与严格**：

* `capabilities.synthesize=true` 但没有 `synthesize()` → **拒绝加载**；
* `capabilities.voices=true` 但没有 `getVoices()` → 只降级 `voices=false` 并告警；
* 模块导出的 `trackKinds` 优先于 manifest 的声明（模块是运行时真源）；
* `initialize` 缺省视为成功；`dispose` 缺省视为空操作。

### 3.1 `ctx`（initialize 的唯一参数）

| 字段 | 说明 |
|------|------|
| `pluginDir` | 插件目录绝对路径（已 `authorizePath` 授权） |
| `hostVersion` | 宿主（应用）版本 |
| `log(level, msg)` | `debug` / `info` / `warn` / `error`，统一 `[plugins] [id]` 前缀 |
| `getSetting(key)` | 读主进程设置项 |

---

## 4. `request` / `host` / `SynthResult`

### 4.1 `request`（合成入参）

| 字段 | 类型 | 说明 |
|------|------|------|
| `kindId` | string\|null | 轨道种类 id（取自 trackKinds） |
| `pluginId` | string | 插件 id |
| `trackId` | string\|null | 调用方轨道标识 |
| `notes` | Array | 音符数组，与内置 pipeline 同构：`{start(拍), duration(拍), pitch(MIDI, 0=休止), lyric}` |
| `bpm` | number | |
| `options` | object | ★ **完整 options，同一引用**。含 svsIpc 注入的 `language` / `onProgress` / `refF0Extractor`，以及渲染进程传来的 `refAudioWavBuffer` / `pitchCurveF0` / `refF0Data` 等 Float32Array |
| `params` | object | 插件自定义参数，由 `resolvePluginParams(paramSchema, defaults, overrides)` 计算；**只保留 schema 声明过的键** |
| `voiceId` | string\|null | |
| `sampleRate` | number | 工程采样率（缺省 44100） |
| `scratch` | Float32Array | 可选，调用方预分配的缓冲，插件可写入以避免分配 |
| `abortSignal` | AbortSignal | 取消时 abort |

> ⚠️ **引用共享的代价**：插件可以改写 `request.options`。因此 svsIpc 一旦命中
> 插件分支就**立刻 return，绝不再把同一个 options 交给内置 pipeline**。
> 若将来要"插件 + 内置"双路并行，调用方必须自行浅拷贝。

### 4.2 `host`（宿主回调 = 插件的输出通道）

| 方法 | 说明 |
|------|------|
| `emitProgress(p)` | 0..100，节流（50ms，首帧与 100 必发）后推 `plugin:progress` |
| `emitAudio(chunk)` | 流式推送 `{pcm: Float32Array, channels, sampleRate, startTimeSec, isLast}` → `plugin:audio` |
| `log(level, msg)` | 写主进程日志 |
| `blockPlayback({title, message, cancellable})` | 返回 ticket 或 `null`（见 §6） |
| `isCancelled()` | ticket 被取消 或 `abortSignal` 已 abort 时为 true |
| `diagnostics(obj)` | 任意诊断对象 → `plugin:diagnostics` |

> **worker 模式下这些回调代理怎么工作**：函数无法跨线程，所以 `host.*` 在 worker 里
> 是同名代理，插件照常 `host.emitProgress(50)`，代理把 `{callId, method, args}`
> postMessage 回主进程，主进程调用真函数。`blockPlayback()` 返回的 ticket 也是代理：
> `ticket.id` 由主进程在调用前预分配（所以插件拿到的是**同步**值），`update()` /
> `end()` 同样是消息。`isCancelled()` 是异步查询，在 await 点刷新。
>
> 因此插件**不要依赖 `host.*` 的返回值**（代理那里没有有意义的返回值），也不要根据
> 自己跑在哪种模式里写分支 —— 两种模式暴露的形状是一致的。

### 4.3 `SynthResult`

```js
{
  pcm: Float32Array | Float32Array[] | null,  // null 仅 streaming 插件可用
  channels: number,       // >1 时 pcm 为交错数据（数组形态则表示按声道分离）
  sampleRate: number,     // 必须是 8000..768000 的整数
  leadingSamples: number, // pcm[0] 相对请求起点需前置补零的样本数
  diagnostics: object,
}
```

结果不合法时宿主直接拒绝，返回 `{success:false, error}`，**不会**把脏数据放进混音
链路。校验项（`normalizeSynthResult` / `emitAudio` 共用同一套）：

| 校验 | 规则 | 为什么 |
|------|------|--------|
| `pcm` 类型 | 必须是 `Float32Array`（或逐声道的 `Float32Array[]`） | 内置链路只吃 Float32 |
| `pcm` 有限值 | **逐个样本**扫 NaN / ±Infinity | 一个 NaN 会让整段导出变成爆音/静音块，而 NaN 很容易从插件的除零里滑出来（详见 §5.4 的性能取舍） |
| `pcm` 长度上限 | 单声道 ≤ `sampleRate × 3600`（1 小时），且总字节 ≤ 256 MiB | 旧实现连 512MB 的返回值也照收；正常歌声片段远达不到这个量 |
| `sampleRate` | 必须是 8000..768000 的**有限整数** | `NaN` 不再静默回落成缺省值，而是直接拒绝 |
| `leadingSamples` | 非负整数 | 前置补零不能为负 |

> `sampleRate` / `leadingSamples` 先于 `pcm` 校验：时长上限要用 `sampleRate` 把
> 样本数换算成秒，顺序反了就只能先按字节兜底拦。

---

## 5. 调用护栏（全部在 `pluginHost.js` 内）

1. **生命周期**：`state !== 'ready'`（未 initialize / initialize 失败 / 已 dispose）一律拒绝；
2. **超时**（两种模式的语义不同，请勿混淆）：
   * **worker 模式（默认）**：到点直接 `worker.terminate()` —— 这是唯一的真抢占，
     忙碌循环的插件会被即时掐断（实测 5s 忙等在 1s 超时下 1003ms 返回）。之后宿主
     重建 worker 并重跑 `initialize`（单次超时可能只是超时值给小了，不该一棍子打死）；
     **连续**超时达到 `MAX_CONSECUTIVE_TIMEOUTS`(3) 次才把插件标成 `failed` 不再拉起。
   * **inprocess 模式**：`Promise.race + setTimeout` 只能拦住插件在 await 一个永不
     resolve 的 Promise。**同步忙等 / 死循环无法被抢占**，窗口会一直冻到插件自己返回。
     这是该模式已知且不可修的限制，选它等于接受它（§0）。
3. **异常隔离**：插件抛错只记日志，返回 `{success:false, error:{code, message}}`；
   错误经 `safeHandle` 脱敏后才过 IPC，**不会**带出插件内部堆栈；
4. **结果校验**：见 §4.3；
5. **能力校验**：未声明 `capabilities.synthesize` 不能合成，未声明
   `blockPlayback` 不能创建 ticket；
6. **路径护栏**：入口 `main` 必须落在插件目录内（`realpath` 后比较，挡掉 `..`、
   绝对路径、符号链接逃逸）；插件根目录与入口文件加载前都调用 `authorizePath()`；
   插件要读模型 / 素材文件时走 `host.checkPathAllowed()` → `isPathAllowed()`，
   **不通过即报错，且不允许放宽现有白名单**；
7. **故障域隔离**：单个插件加载 / initialize / 合成失败，只把它自己标成
   `failed`，其它插件照常可用；
8. **热重载**：`reloadPlugins()` = dispose 全部 → 重新扫描加载；
   worker 模式下旧的插件代码随 `terminate()` 一起消失，in-process 模式则靠清
   `require.cache`（worker 模式没有这一步，也不需要有）；两模式都会收掉所有残留
   ticket；
9. **ticket 推送节流**：一次 `update()` 以前是一条 IPC。宿主现在按仓库既有风格
   节流：**最小间隔 100ms 且进度变化 ≥ 2%**，进度到 100 / 取消 / 结束**必发**
   （状态每次都立刻更新，被节流掉的只是"推送"这一动作）。
   实测：400 次 `ticket.update()` → 推送 51 次（0→100 每 2% 一帧 + 终态，即理论上限）；
   模板插件 400 音符的实测量从 403 次降到 35 次。

### 5.4 有限值全量扫描的性能取舍

`pcm` 里的 NaN / ±Infinity 不能放过：它们会一路写进导出 WAV，表现为成片的爆音或
静音块，而且极难追溯到插件。可选方案只有两个——抽样还是全量。

| 方案 | 实测成本 | 漏检 |
|------|----------|------|
| 抽样（每 N 个取 1 个） | 约为全量的 1/N | **会漏**：孤立的一个 NaN（除零、log(0)）落在未抽到的位置时照样导出损坏音频 |
| **全量扫描（采用）** | 1.0 MiB ≈ 0.59ms；4.0 MiB ≈ 3.15ms；16.0 MiB ≈ 12.57ms（≈3ms / 百万样本） | 0 |

绝对值放在上下文里看就知道了：合成 16MiB（约 3 分钟）音频本身耗时以秒计，再往
下还有 ONNX 推理与 vocoder；几毫秒的线性扫描可以忽略。热循环里不做任何函数调用
（用 `v !== v` 判 NaN、直接与 ±Infinity 比较），也不额外分配内存。因此取全量。

单次合成数据量超过 `FINITE_SCAN_WARN_ELEMENTS`(8M 元素 / 32MiB) 时宿主会打一条
warn，便于发现异常的插件行为——这只是提示，不改变校验结果。

---

## 6. 阻滞播放（blockPlayback）

插件在"准备音源 / 预处理"这类必须在播放前完成的耗时步骤上，可以用 ticket 让
UI 显示阻塞信息与进度：

```js
const ticket = host.blockPlayback({ title: '正在拼接音源', message: '装载拼接单元…', cancellable: true });
ticket.update({ message: '拼接中…', progress: 40 });
ticket.end();  // 必须调用
```

* `ticket` 为 `null` 表示插件未声明 `capabilities.blockPlayback`，调用被拒绝并记日志；
* 主进程事件：`plugin:blocking-start` / `-update` / `-end`，载荷
  `{ticketId, pluginId, title, message, progress, cancellable, reason, cancelled}`；
* `cancellable: true` 时 UI 可调用 `pluginAPI.cancelTicket(ticketId)`，宿主置位后
  插件通过 `host.isCancelled()` / `request.abortSignal` 感知；
* **超时兜底**：
  1. 一次 `synthesize` 调用返回（成功 / 失败 / 超时）后，宿主自动 `end()` 本次调用
     创建的所有 ticket —— 插件忘记 `end()` 也不会把 UI 永久卡死；
  2. 另有 10 分钟 watchdog（`ticketWatchdogMs` 可注入）兜住"插件在后台另起异步
     任务"的情况；
  3. `reloadPlugins()` / `dispose()` 也会收掉全部残留 ticket；
* 单次调用最多 `MAX_TICKETS_PER_CALL`(8) 个 ticket。

---

## 7. 与 SVS 管线的接线（参数透传落点）

`src/main/svsIpc.js` 的三个 handler 都支持在 `options` 里声明插件后端：

```js
options.backend = { type: 'plugin', pluginId: 'example-concat', kindId: 'concat-basic', params: { waveform: 'pulse' } };
```

| handler | 插件分支行为 | 返回形态 |
|---------|--------------|----------|
| `svs:synthesize` | 构造完 `opts`（含注入的 `language` / `onProgress` / `refF0Extractor`）后把**同一个 `opts`** 交给插件，**直接 return**，不调用内置 pipeline | `Float32Array` |
| `fragment-svs:synthesize` | 同上 | `{data: Float32Array}` |
| `svs:synthesizeMultiStreaming` | **逐分片按各自声明的后端分组**：插件分片交给对应插件、内置分片交给内置 pipeline，各组结果都在 beat 0 起算的同一条时间轴上叠加。分组按 `pluginId + kindId`，多后端混排不再报"无法混合" | `Float32Array` |

> **为什么必须逐分片路由**：旧实现拿 `fragments[0]` 的后端决定**整批**走向，于是
> "插件轨 + 内置轨"混排的工程里，要么内置分片被整批塞给插件（静默产出错误结果），
> 要么直接硬报错。分组渲染还带来两个附带修正：· 语言判定改用**内置分片**的首个音符
> （旧实现取 `fragments[0]`，第一条轨是插件轨时会用它决定管线语言）；· 各组的 0→100
> 进度按分片段数占比缩放，UI 进度条不再回跳。声明了插件后端但插件不可用的分片会
> 明确报错（错误信息带 `trackId`），绝不静默回落。

插件返回的 `{pcm, channels, sampleRate, leadingSamples}` 由 `pluginIpc.toBuiltinAudio()`
压成内置链路的同款单声道 Float32Array（`leadingSamples` 由宿主补零，多声道取第一
声道），**渲染层无需区分后端**。

渲染层也可以绕过 SVS 通道直接调用插件（用于预览 / 面板自测）：`pluginAPI.synthesize(request)`。

---

## 8. IPC 接口（`src/shared/ipcChannels.js`）

| 常量 | 通道 | 方向 | 说明 |
|------|------|------|------|
| `PLUGIN_LIST` | `plugin:list` | R→M | `{success, pluginsDir, plugins[], errors[]}` |
| `PLUGIN_RELOAD` | `plugin:reload` | R→M | 热重载 |
| `PLUGIN_GET_VOICES` | `plugin:getVoices` | R→M | `{pluginId, kindId}` → `{success, voices[]}` |
| `PLUGIN_SYNTHESIZE` | `plugin:synthesize` | R→M | 单次合成 |
| `PLUGIN_GET_PLUGINS_DIR` | `plugin:getPluginsDir` | R→M | 插件目录（走 `isPathAllowed`） |
| `PLUGIN_OPEN_PLUGINS_FOLDER` | `plugin:openPluginsFolder` | R→M | 先 `isPathAllowed` 再 `shell.openPath` |
| `PLUGIN_CANCEL_TICKET` | `plugin:cancelTicket` | R→M | 取消 `cancellable` 的 ticket |
| `PLUGIN_BLOCKING_START/UPDATE/END` | `plugin:blocking-*` | M→R | 阻滞播放生命周期 |
| `PLUGIN_PROGRESS` / `PLUGIN_AUDIO` / `PLUGIN_DIAGNOSTICS` | `plugin:progress` / `plugin:audio` / `plugin:diagnostics` | M→R | 插件输出通道 |

全部 handler 用 `safeHandle` 注册（与仓库其它 IPC 一致：异常在主进程记全量，
过 IPC 的只有脱敏后的 message）。

渲染层入口见 `src/preload.js` 的 `window.electronAPI.pluginAPI`（`list` / `reload` /
`getVoices` / `synthesize` / `getPluginsDir` / `openPluginsFolder` / `cancelTicket` /
`onBlockingStart|Update|End` / `onProgress` / `onAudio` / `onDiagnostics`）。

> 注：`registerPluginIpc()` 目前由 `registerSvsIpc()` 末尾调用（`main.js` 暂由其它
> 改动占用）。`main.js` 解锁后可移到 STEP 4 的 `registerSvsIpc()` 旁边单独一行。

---

## 9. 写一个自己的插件（最短路径）

1. `cp -r plugins/example-concat <userData>/plugins/my-backend`，把目录名与
   `manifest.json` 的 `id` 一起改成 `my-backend`；
2. 在 `synthesize()` 里换成你自己的推理 / 拼接逻辑（可以 `require` 自己的依赖，
   插件目录内的一切都由插件自己负责）；
3. 需要"播放前必须完成"的准备步骤 → 用 `host.blockPlayback()`；
4. 需要给用户可调参数 → 在 `trackKinds[].paramSchema` 里声明（宿主用
   `resolvePluginParams` 把 UI 的值算成 `request.params`，未声明的键会被丢弃）；
5. `pluginAPI.reload()` 生效，无需重启应用。

**不要**做的事：不要改 `request.options` 后指望内置 pipeline 还能用它；不要在
热路径上 `structuredClone` / `JSON.parse(JSON.stringify())` 大对象；不要声明
`apiVersion` 以外的版本号（会被拒绝）；不要在 `initialize` 里做分钟级的加载而不
用 `blockPlayback` 告诉用户（UI 会看起来像卡死）。

### 9.1 回归冒烟（`scripts/plugin-smoke.js`）

改完宿主或契约后跑一次：

```bash
node scripts/plugin-smoke.js     # 不需要 electron，也不需要 node_modules
```

26 项断言，覆盖插件发现/加载、音色、`request.options` 同一引用透传、阻滞 ticket
的 start/update/end 配平、**同步忙等插件能否被超时真实抢占**（构造一个忙等 5 秒的
插件，在 1 秒超时下必须被 `worker.terminate()` 杀掉）、含 NaN 的 PCM 必须被拒、
以及 `midi-partial` 轨道种类能否被识别与合成。

其中「忙等抢占」是唯一能证明超时不是 `Promise.race` 假超时的用例——如果哪天有人把
默认执行模式改回 `inprocess`，这条会立刻变红。

---

## 10. 宿主可注入参数（`createPluginHost`）

| 参数 | 默认 | 用途 |
|------|------|------|
| `pluginsDir` | `<userData>/plugins` | **可注入**，纯 Node 单测 / 自定义目录 |
| `security` | `./security` | 路径授权层 |
| `callTimeoutMs` | `PLUGIN_CALL_TIMEOUT_MS` | 调用超时（worker 模式下 = 多久后 `terminate()`） |
| `inprocessWhitelist` | 空 | 允许用 `executionMode: 'inprocess'` 的插件 id / 目录名集合；不在名单里的一律降级为 worker 并记 warn |
| `ticketWatchdogMs` | 10 分钟 | ticket 兜底寿命 |
| `hostVersion` / `getSetting` / `log` / `now` | 见实现 | 便于测试与定制 |

---

## 11. worker 消息协议（`pluginHost.js` ⇄ `pluginWorker.js`）

宿主与 worker 之间只传**可结构化克隆**的值，外加 transfer list 里的 ArrayBuffer。
协议的全部消息如下（同一个 worker 内可以有多个在飞的 `call`，用 `callId` 区分）。

| 方向 | `type` | 载荷 | 说明 |
|------|--------|------|------|
| M→W | `init` | `{entry}` | 让 worker `require(record.entry)`；主进程**从不** require 插件代码 |
| W→M | `meta` | `{ok, meta?\|error?}` | init 应答，`meta` = `{id, name, version, apiVersion, capabilities, trackKinds, has:{initialize,getVoices,synthesize,dispose}}`；主进程据此做契约校验 |
| M→W | `call` | `{callId, method, args, ticketPool}` | 调用插件方法；同 worker 内可并行多个在飞调用 |
| W→M | `result` | `{callId, ok, value?\|error?}` | 调用应答（`value` 已过 wire 编码并带 transfer list） |
| W→M | `callback` | `{cbId, reqId, args}` | 插件调用了某个主进程真函数（options 里的 `refF0Extractor` 等）的代理 |
| M→W | `callback-result` | `{reqId, ok, value?\|error?}` | 主进程执行完真函数后的回值（代理处 await 的就是它） |
| W→M | `host` | `{callId, kind, ...}` | 插件调用了某个 `host.*` 代理（见下表） |
| M→W | `cancel` | `{callId}` | 协作式取消：置位后 worker 侧 `host.isCancelled()` / `abortSignal` 生效 |
| W→M | `failed` | `{error}` | worker 内出现未捕获异常 → 主进程 `terminate()` 并让在飞调用失败 |

`host` 消息的 `kind` 取值（主进程看到 event 后做什么）：

| kind | 载荷 | 主进程动作 |
|------|------|-----------|
| `progress` | `{callId, value}` | → IPC `plugin:progress` |
| `audio` | `{callId, value}` | **先跑一次 pcm 校验**（流式通道不是校验后门），再 → `plugin:audio` |
| `log` | `{callId, level, message}` | 主进程日志（`[plugins] [id]` 前缀） |
| `diagnostics` | `{callId, value}` | → IPC `plugin:diagnostics` |
| `ticket-start` | `{callId, ticketId, spec}` | 建 ticket；`ticketId` 来自调用前预分配的池，所以插件侧是**同步**拿到的 |
| `ticket-update` | `{callId, ticketId, patch}` | 立即更新状态，**IPC 推送按 100ms + 2% 节流** |
| `ticket-end` | `{callId, ticketId}` | 收尾（必发，不节流） |

### 跨线程编解码（`wire`）

`pluginWorker.js` 同时是 worker 入口和主进程侧的编解码库：

| 值 | 编码结果 | 备注 |
|----|----------|------|
| TypedArray / ArrayBuffer | 放进 **transfer list**（零拷贝） | SharedArrayBuffer 上的视图按普通克隆，不转移 |
| function | `{__pluginWire:'fn', cbId, name}` | 真函数留在主进程，worker 侧生成代理 |
| `host` | `{__pluginWire:'host'}` | worker 侧换成 §4.2 那套代理对象 |
| AbortSignal | `{__pluginWire:'abort', aborted, reason}` | worker 侧换成信号代理 |
| Symbol / 不可克隆的宿主对象 | `{__pluginWire:'skip'}` | 记一条日志说明丢弃位置，**不让整次调用失败** |
| 深层嵌套 > `MAX_WIRE_DEPTH`(24) 或节点数 > `MAX_WIRE_NODES`(200000) | 报错终止 | 防御性上限，正常调用远达不到 |

> `options` 里的**空普通对象**（如 `options: {}`）必须能原样过去——早期版本把"没有键
> 的对象"误判成不可克隆而丢弃，导致插件侧首帧崩溃。现在只对 Map / Set / Error /
> 类实例这类非普通对象判 skip。

---

## 12. 已知未修 / 边界

| 项 | 现状 | 原因 |
|----|------|------|
| `inprocess` 模式的同步阻塞 | 无法抢占（§0） | 单线程里没有抢占同步代码的机制，`terminate()` 只能作用于另一条线程 |
| worker 模式下的 Node 权限 | worker 内仍是完整 Node（`require` / `fs` / 子进程均可） | 真正的收敛要走 `node:worker_threads` 的 `execArgv` / permission model 或独立进程 + 最小 IPC 面，属于宿主之外的另一层改造；路径授权（`isPathAllowed`）已挡住"读任意文件"这条最常见的路 |
| ticket / 进度的"实际可见性" | 依赖 UI 是否监听对应 IPC | 宿主侧节流只保证不刷屏 |
