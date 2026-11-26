# 分片编辑器流式推理 · 序列排序与兜底修复报告

| | |
|---|---|
| 目标仓库 | Henley04/SXSEditor |
| 基线 commit | `cb6eec8e4104fbda09747ec221478e1c07b85f43` (master) |
| 修复日期 | 2026-11-19 |
| 参考实现 | kizuna-ai-lab/sokuji `ModernAudioPlayer`（PR #174）、moq `AudioRingBuffer`（parking playhead）、@jadujoel/web-audio-clip-node（AudioWorklet playhead） |

## 一、参考实现核实结论

- sokuji 的 `ModernAudioPlayer.js` **并未删除**，而是在 PR #174（Audio Pipeline Redesign）中被大规模重构：新增 AudioWorklet ring buffer、中断处理、诊断信息。当前 main 分支文件结构再次变动，但 PR #174 的 patch 完整保留了实现。
- 用户提供的 `_handleSequencedAudio` / `_processBufferedSequences` / `_setSequenceGapTimeout` / `_forceProcessBufferedSequences` 与 PR #174 patch（第 756–825 行）逐字一致，确认可靠。
- 三数据结构：`lastSequenceNumbers`、`outOfOrderBuffers`、`sequenceGapTimeout`（100ms）。
- moq 的 "parking the playhead"：seek 不销毁缓冲/时间线，而是跳跃式重锚消费指针、丢弃目标之前的分块、保留之后的分块。
- clip-node 的 `StreamingClipNode`：AudioWorklet 中以采样为单位的可写 playhead，三线程分离（主线程 fetch / Worker 解码 / AudioWorklet 出声），下一个 128 采样量子即可从新位置输出。

## 二、关键架构差异（为什么不直接照搬）

| 维度 | sokuji | SXSEditor |
|---|---|---|
| chunk 来源 | 网络实时流（WebSocket） | 本地 GPU 推理（worker → IPC） |
| 序号语义 | 整数 `sequenceNumber`，+1 即下一个 | 绝对采样区间 `{sampleOffset, sampleEnd}`，长度可变（vocoder 分块 + 静音 gap + segment overlap） |
| 播放模型 | 顺序拼接 + 可写 playhead | 绝对位置调度 `source.start(when, offset)` + `StreamingScheduler` 的 suspend/resume underrun 保护 |
| 乱序成因 | 网络抖动/丢包 | 多段发射顺序、缓存命中分支、superseded/cancel 竞态、IPC 与 invoke 返回走不同通道 |

直接用整数序号会破坏 SXSEditor 已验证的绝对位置坐标模型，并推翻已修复的竞态逻辑（见原调查报告第三节）。因此采用**适配式自研**。

## 三、修复内容

### 3.1 新增 `src/shared/sequencedChunkQueue.js`（零依赖）

把 sokuji 三态逻辑适配到采样区间，用「采样前沿 frontier」代替整数序号：

1. **正好接续**（`start <= frontier + tol`）→ 立即交付，随后冲刷缓冲里的连续块（对应 `_processBufferedSequences`）。
2. **超前/缺口**（`start > frontier + tol`）→ 暂存到 `outOfOrderBuffers`（Map: sampleOffset → chunk），启动 gap 超时。
3. **重复/过时**（`end <= frontier + tol`）→ 丢弃；若携带 `isLast`，仅透传标记不重播音频。

**缺口超时兜底**（100ms）：按 sampleOffset 排序强制交付所有暂存块，跳跃式把 frontier 更新到最后一块的 sampleEnd —— 承认缺口不可弥补、让播放继续，不永久卡死（对应 `_forceProcessBufferedSequences`）。`finish()` 在推理完成时同样排空。

**`rebase(targetSample)`**：实现 moq parking —— 跳跃重锚 frontier，丢弃目标之前的块、保留之后的块，供"流式 seek 复用已缓冲 chunk"场景（当前架构 seek 走整段缓存重播，该能力以 API + 单测形式保留）。

### 3.2 修改 `src/fragmentEditor/audioPlayback.js`

- 在 chunk 入口与真正消费之间插入有序队列：IPC 回调先 `_chunkQueue.push(chunkInfo)`，队列判定可交付后才进入串行 `chunkQueue → handleStreamingChunk`。
- `handleStreamingChunk` 的绝对位置排程、`awaitSuspendSettled`、lateSec 裁头等已验证逻辑**完全不动**。
- 首块初始化、watchdog、播放头 rAF、underrun 检测等**完全不动**。
- 会话重建时 `_resetChunkQueue(0)`；停止时清空队列（含未触发的 gap 定时器）；推理完成后 `_chunkQueue.finish()` 排空残余。

## 四、修复收益

| 问题 | 修复前 | 修复后 |
|---|---|---|
| chunk 乱序到达 | 依赖"收到即排程"，乱序块被按前沿裁头丢弃 → 内容缺失 | 暂存并按采样序交付，缺口补齐后连续冲刷 |
| 重复/过时 chunk | 靠 deliveredEnd 重叠裁剪，重复 isLast 可能漏/重 | 队列显式去重，`isLast` 标记只透传一次 |
| 单块丢失 | 前沿卡住 → 播放头在静音等待中冻结，无超时 | 100ms 后强制排序交付、跳跃前沿，播放继续 |
| isLast 乱序先到 | 可能提前触发收尾判定 | isLast 参与排序，始终最后交付 |

## 五、验证

- `node scripts/test_sequenced_chunk_queue.js`：**42 passed, 0 failed**（三态、去重、超时、rebase、finish、无区间退化）。
- `node scripts/test_stream_chunk_integration.js`：**16 passed, 0 failed**（乱序+重复+过时无丢包、丢块超时兜底、isLast 乱序、随机乱序压力下的单调性）。
- 改造后 `audioPlayback.js` 通过语法检查（Babel/CJS 解析）。

> 说明：完整虚拟时钟模拟器 `scripts/sim_fragment_playback.js` 依赖 jsdom/@babel，本环境 npm 网络不可用未能运行；但本次改动不触及 simulator 覆盖的调度/播放头逻辑，且新增逻辑由上述零依赖测试完整覆盖。

## 六、Web Audio 低延迟（第一项 · 2026-11-19 追加）

**核实结论：此前未实现 Web Audio 层低延迟。** 第一~五节的交付解决的是「可靠性（序列排序/去重/超时兜底）」与「延迟补偿（audioOutputClock 把播放头对齐到人耳位置）」——两者都不改变「推理出块 → 喇叭出声」的绝对延迟。本次按约定落地最低风险的第一步。

### 改动：实时播放 AudioContext 增加 `latencyHint: 'interactive'`

| 文件 | 行 | 用途 |
|---|---|---|
| `src/fragmentEditor/audioPlayback.js` | 567 | 分片编辑器流式播放上下文（核心链路） |
| `src/renderer/audioPlayback.js` | 1190 | 主播放器（人声 / 伴奏）上下文 |

- **语义**：请求浏览器/系统选用最小输出缓冲。Windows WASAPI 及多数内核可把 `outputLatency` 从默认 100–200ms 压到几十 ms 级；Electron/Chromium 上实际收益取决于设备与驱动，不保证。
- **安全性**：`latencyHint` 与既有 `sampleRate` 不冲突，采样率指定保持不变；旧内核不识别该选项会安全忽略，不抛错。
- **回退**：删除 `latencyHint: 'interactive'` 即可，无其他副作用。

### 明确未改的 AudioContext（避免误伤）

`fragmentOperations.js:160`、`projectManager.js:229`、`mcpAutomation.js:390` 的 `new AudioContext()` 仅用于 `decodeAudioData` 后即 `close()`；`audioLoader.js:80` 是 `OfflineAudioContext`。这些都不是实时播放上下文，加 `latencyHint` 无收益且可能干扰解码采样率，保持原样。

### 边界说明

`latencyHint` 只是「请求」而非保证；真正的确定性低延迟仍需第二项（AudioWorklet + ring buffer）或第三项（clip-node 式 playhead）。`audioOutputClock.js` 的延迟补偿不受影响——它读的是 `ctx.outputLatency` 实测值，缓冲变小后读数自然变小，播放头会自动跟上。

验证：两文件语法检查通过；队列单测 42/42、集成测试 16/16 无回归。

## 七、流式时序细粒度日志（2026-11-19 追加）

为端到端排查「Seg 推理完成 → 开始播放 → 播放完成」时序，在推理侧与播放侧共加 15 条英文日志。统一前缀 + 绝对毫秒时间戳 `t=`（跨进程可对齐）：

| 前缀 | 进程 | 含义 |
|---|---|---|
| `[SegInfer][FRAG]` | 主进程 | 分片预览：单 segment 推理完成 / chunk 发射 |
| `[SegInfer][MAIN]` | 主进程 | 主页面 multi-stream：chunk 发射 / 整体推理完成 |
| `[FragPlay]` | 分片渲染进程 | 分片播放：起播 / chunk 排程 / 末块 / 推理返回 / 完成 |
| `[MainPlay]` | 主渲染进程 | 主页面播放：起播 / Seg 流完成 / chunk 排程 / 全部块 / 推理返回 / 完成 |

关键事件（均可直接 grep）：`segment inference done`、`chunk emitted`、`PLAYBACK START`、`SEG STREAM DONE`、`LAST CHUNK RECEIVED` / `ALL SEGS RECEIVED`、`INFERENCE RETURNED`、`PLAYBACK FINISHED`。日志只新增 `console.log`，复用已声明变量，不引入新依赖、不改变任何调度逻辑。

完整日志点（15 处）：
- `src/inference/pipeline/index.js:3252 / :3312 / :4007 / :4285`
- `src/fragmentEditor/audioPlayback.js:382 / :1337 / :1415 / :1433 / :1507`
- `src/renderer/audioPlayback.js:463 / :817 / :841 / :943 / :951 / :979`

典型时序（分片）：`[SegInfer][FRAG] segment inference done` → `chunk emitted` → `[FragPlay] PLAYBACK START` → `chunk scheduled` → `LAST CHUNK RECEIVED` → `INFERENCE RETURNED` → `PLAYBACK FINISHED`。

## 八、有序队列的两处缺陷修复 + 模拟器全量验证（2026-11-20 追加）

第五节当时因 npm 网络不可用未能运行完整模拟器。本次在可运行环境补跑，并对新增队列做了针对性审查，修掉两处缺陷。

### 8.1 `reset()` 没有真正取消未触发的 gap 定时器

`reset()` 原先只把 `_gapTimer = null`，没调 `_clearTimer`。句柄丢了、定时器还活着：停止→重播时，旧会话的兜底定时器会在新会话里到期，强制冲刷新会话的缓冲并跳跃前沿。第三节"停止时清空队列（含未触发的 gap 定时器）"的描述在修复前并不成立。`finish()` 走 `_clearGapTimer()` 是对的，只有 `reset()` 漏了。

修复：`reset()` 开头调用 `this._clearGapTimer()`。回归用例 T9（注入式虚拟定时器，断言 `pending() === 0`）。

### 8.2 会话守卫排在 `_chunkQueue.push()` 之后

`streamingFinished` / `mySession !== _playSessionSeq` 两道守卫在 `handleStreamingChunk` 内部，而 `push()` 在 IPC 监听器里、守卫之前。`stopStreamingPlayback` 自己的注释就写明"监听器虽已移除，但已派发的回调仍可能到达"——这正是它防的场景。

实测后果比"前沿污染"更重：`_chunkConsumer` 是模块级变量、每轮会话重新赋值，队列的 `onChunk` 在调用时才读它。因此旧会话监听器推进的块会被**新会话的 consumer 真正排程播放**（旧会话的守卫根本没机会执行），同时前沿被推进，新会话真正的首块随后被判为 `duplicate` 整块丢弃。

修复：把两道守卫提到监听器里 `push()` 之前。回归用例见 `test/fragmentStreamingPlayback.test.js`（"旧会话已在途的 chunk 不得污染有序队列"）——修复前该用例在"旧会话的块不得排程"处失败（实际排出了 1 个 source）。

### 8.3 模拟器全量验证

`scripts/sim_fragment_playback.js` 与 `cb6eec8` 逐字节相同，17 个工况（A–J、K、K-EXTREME 300ms、K-EXT2 500ms、L 停止→重播、M 突增、N 回落、O 1200ms）全部通过，判定 `OK：无静音缝 / 无重复 / 无漂移 / 播放头连续`。剥掉新增 `[FragPlay]` 日志行后，输出与 `54c5344`、与 `cb6eec8` 均**逐字节相同**——本次修复不改变任何已覆盖工况的行为。

队列分支普查（preload 包装 `push`，不改仓库文件）：

```
[QUEUE-PROBE] push 分支计数 = {"consumed":94}
[QUEUE-PROBE] 非空强制冲刷次数 = 0
```

94 个 chunk 全部走"正好接续"，`buffered` / `duplicate` / `empty` 各 0 次。原因在发射器：`_createSegmentStreamEmitter`（`src/inference/pipeline/index.js`）的 `frontier` 是单调游标，`emitChunk` 发完立即 `frontier += audio.length`，`tryEmit` 遇到未完成 segment 即 `break`，isLast 另有 1 样本兜底。**内置管线的 chunk 在构造上就是连续、单调、无重叠、无重复的**，单一 IPC 通道保序。

结论：有序队列在内置链路上是直通（pass-through），它兜的是网络流式场景的乱序/丢包，而本地 GPU 管线已在上游结构性排除这些故障。它的价值在于插件后端可能发出非连续区间时的保险，以及 `rebase()` 为将来"流式 seek 复用已缓冲 chunk"预留的能力；**它不修复调查报告里实际复现的播放头卡顿根因**（那由 `cb6eec8` 的自适应冻结提前量解决，本次未动）。8.1 / 8.2 两处缺陷在内置链路上属潜伏（分支 2 从不触发），但一旦有非连续区间输入即成为活缺陷。

### 8.4 验证汇总

| 项目 | 结果 |
|---|---|
| `scripts/test_sequenced_chunk_queue.js` | 50 passed, 0 failed（原 42 + T9 的 8 条断言） |
| `scripts/test_stream_chunk_integration.js` | 16 passed, 0 failed |
| `test/fragmentStreamingPlayback.test.js` | 9 passing（原 8 + 1 条跨会话回归） |
| `audioOutputClock` / `exclusivePlaybackRecovery` / `zzRendererPlaybackSupersede` | 14 / 7 / 3 passing |
| `scripts/sim_fragment_playback.js` | 17 工况全过，与基线逐字节相同 |
| eslint | 0 errors（1 条 `gapSamples` unused warning 为既有代码，未在本次改动范围内） |

`multiSegmentStreamEmitter` / `streamingSynthesis` 两个 mocha 文件因沙箱无法安装 `onnxruntime-node` 而加载失败，基线同样失败，非本次回归。

## 九、与本地播放会话重构合并后的定位（2026-11-21）

合并 `origin/master`（本报告 1–8 节）与本地 `refactor(fragment-editor): single-owner playback session + timeline` 后，分片编辑器的播放路径改为：

- **唯一时间真源** `src/fragmentEditor/playbackTimeline.js`：锚点只在第一个真正发声的 chunk 上建立，内容位置 = 起播点 + (ctx 时间 − 锚点)。
- **唯一状态所有者** `src/fragmentEditor/playbackSession.js`：一次播放 = 一个 Session，所有异步续体先判 `sess.isCurrent`。
- 因此 8.2 的"旧会话 chunk 污染前沿"问题在新架构下由闭包 + 会话守卫直接消解（`test/fragmentStreamingPlayback.test.js` 的跨会话回归用例在新实现上通过）。

**有序队列的去留**：`src/shared/sequencedChunkQueue.js` 保留（零依赖 + 50 条单测 + 集成脚本），但**不再挂在播放主路径**。原因是本报告 8.3 已实测：内置链路的 chunk 在构造上连续、单调、无重叠，队列 94/94 全部直通；而按序交付的 100ms 缺口等待会平白增加起播延迟。

队列原本兜的"乱序"边界情况，改为在 `StreamTimeline` 内用**已排程区间账本**（`coveredRanges`）解决，零额外延迟：

| 情况 | 旧单一前沿 | 区间账本（现实现） |
|---|---|---|
| 重复块（整段已被覆盖） | 丢弃 | 丢弃（同） |
| 重叠块（多 segment 15ms overlap） | 裁头 | 裁头（同） |
| 乱序：后段先到、前段后到 | 前段被误判 duplicate **整块丢失** | 前段按自己的绝对时刻回填 |
| 一个块被已排区间从中间切开 | 只播第一段，后半段丢失 | 逐段排程（`plan.segments`） |

**低延迟输出**：两条路径都采纳 `latencyHint: 'interactive'`（主窗口 `getAudioContext()`、分片编辑器 `getFragmentAudioContextInternal()`）。播放头按"耳朵听到的位置"走（`shared/audioOutputClock.js`），输出缓冲越小，拖播放头与起播的跟手度越好。

**诊断日志**：保留 `[FragPlay] / [SegInfer][FRAG] / [SegInfer][MAIN] / [MainPlay]` 前缀与 `t=<epoch ms>` 绝对时间戳，便于跨进程对齐时间线。分片侧日志迁移到 `playbackSession.js`（会话 id 取代旧 `mySession`），并新增 `chunk dropped | reason=` 一条，用于定位 before-start / duplicate / late。
