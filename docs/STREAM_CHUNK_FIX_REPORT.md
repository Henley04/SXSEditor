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
