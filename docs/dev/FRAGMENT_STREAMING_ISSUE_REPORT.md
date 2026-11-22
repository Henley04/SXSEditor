# 分片编辑器分块流式推理问题报告

- 基线：`master` @ `6492507`
- 审查对象：分片编辑器 `fragment-svs:synthesize` → 分块推理 → IPC → WebAudio 播放全链路
- 生成日期：2026-11-23
- 方法：完整源码静态核对 + Node `worker_threads` 缓冲区转移实测 + `StreamTimeline` 时间轴模拟 + 定向回归测试
- 关联 PR：[#39 fix: preserve chunk coordinates across worker PCM transfers](https://github.com/Henley04/SXSEditor/pull/39)

## 1. 结论摘要

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| 已修复 | 2 | Transferable 导致 `frontier` 归零；缓存重放分离 LRU 条目 |
| 确认成立 | 9 | 会导致静音、丢块、提前结束、偶发卡住或诊断失真 |
| 部分成立 | 3 | 现象存在，但原建议的修复方式需要修正 |
| 不成立 | 2 | 首块“完全迟到”不可达；`_planChunks` 空分支是精简包摘录造成的假象 |

**主因判断：** 22 秒空区与后段人声消失由已修复的 Transferable `frontier` 问题直接解释。SOTA 提出的 #1、#3、#4 是独立正确性问题，但不是该症状的必要条件：

- #1 需要 `source.start()` / buffer 创建抛异常才会触发；
- #3 需要 seq 缺口才会触发，而 Transferable 问题下 seq 仍然连续；
- #4 只影响末尾长度，不会制造中间 22 秒静音。

## 2. 已修复问题

### F1. Worker 转移 PCM 后 `frontier` 归零（主因）

**位置：** [src/inference/pipeline/index.js](file:///workspace/src/inference/pipeline/index.js#L3315-L3347)、[src/inference/svsWorker.js](file:///workspace/src/inference/svsWorker.js#L149-L155)

**机制：**

1. `_createSegmentStreamEmitter().emitChunk()` 在调用 `onChunkAudio()` 前计算 `sampleEnd`；
2. Worker 桥接层在视图独占 buffer 时执行 `postMessage(message, [audio.buffer])`；
3. Node `worker_threads` 在 `postMessage` 返回前同步分离发送侧 `ArrayBuffer`，`audio.length` 变为 `0`；
4. 旧代码在回调后执行 `frontier += audio.length`，实际加 `0`，前沿永远停在首块。

**实测：**

```text
[worker] after postMessage audio.length= 0 byteLength= 0
[main]   received length= 4 sample0= 1
```

**播放端后果：**

- 后续所有块以 `sampleOffset: 0` 发出；
- 补零块从 0 覆盖到后段起点，写入 `coveredRanges`；
- 后段真实 PCM 从 0 发出，被判定为 duplicate；
- 末段还会被 `wantLen = totalSamplesRel - frontier` 从 0 补齐到整条时间轴，最终排程到的是补零样本。

**修复：** 回调前保存 `sampleOffset` / `sampleEnd`，回调后用保存的 `sampleEnd` 推进 `frontier` 和写日志；不取消 Worker 零拷贝。

**回归测试：** [test/multiSegmentStreamEmitter.test.js](file:///workspace/test/multiSegmentStreamEmitter.test.js)

- 22 秒长休止：偏移连续、补零块长度精确、Seg3 PCM 保留；
- 连续多段：第二段从 4s 开始，而不是 0；
- 使用 `structuredClone(info, { transfer: [info.audio.buffer] })` 复现真实分离。

### F2. 缓存重放分离 LRU 缓存条目

**位置：** [src/inference/pipeline/index.js](file:///workspace/src/inference/pipeline/index.js#L1171-L1204)

**机制：** `_emitCachedAudioAsChunks()` 旧实现传 `audio.subarray(off, end)`。当缓存音频 ≤ 2 秒时，单块视图 `byteOffset === 0` 且 `byteLength === buffer.byteLength`，Worker 会转移整个底层 buffer，导致：

- LRU `_synthCacheMap` 中的缓存数组被分离；
- 当前 `_synthesizeImpl` 返回的 `cachedAudio` 也变成空数组；
- 后续缓存命中返回 `length === 0` 的音频。

实测：1.5s / 2s 缓存重放后 `cached.length === 0`；2.5s 及以上因首块不是整 buffer 视图，不会分离。

**修复：** 仅当视图独占整个 buffer 时，传 `view.slice()` 私有副本；部分视图保持零拷贝。

**回归测试：** [test/cachedChunkReplay.test.js](file:///workspace/test/cachedChunkReplay.test.js)

## 3. 待修复问题

### 3.1 P0：直接影响播放正确性

#### #1 播放锚点在 `source.start()` 成功前写入

**结论：部分确认。**

- [plan()](file:///workspace/src/fragmentEditor/playbackTimeline.js#L162-L189) 在确认 source 启动前写 `this.anchorCtxTime`；
- `source.start()` / `createBuffer` / `connect` 抛异常时，锚点已经生效，但没有任何声音源启动；
- 后续块会按无效锚点排程。

**对原建议的修正：** 延迟锚定的方向正确，但 SOTA 的补丁不完整。[_processChunk()](file:///workspace/src/fragmentEditor/playbackSession.js#L808-L822) 在循环内、`commit()` 之前调用 `_activatePlaybackUi()`；而 [_activatePlaybackUi()](file:///workspace/src/fragmentEditor/playbackSession.js#L385-L402) 依赖 `timeline.started`。如果 `plan()` 不再写 anchor，该调用会提前返回，导致：

- 播放按钮/播放头不启动；
- `scheduler.activate()` 不执行；
- watchdog 不启动。

**正确修复：**

1. `plan()` 只返回候选 `anchorCtxTime`；
2. `commit()` 在至少一个 `source.start()` 成功后写 anchor；
3. 把 `_activatePlaybackUi()` 移到 `commit()` 之后；
4. 首块 fade 使用 `plan.anchorCtxTime` 候选值；若所有 source 都失败，断开 fadeGain 且不 commit。

**测试：** 让 `source.start()` 抛异常，断言 `started === false`、`anchorCtxTime === null`、`coveredRanges` 不变。

#### #2 “首块完全迟到”会留下错误 started 状态

**结论：不成立（按当前实现）。**

- 整块在起播点之前：`parts.length === 0`，在锚定前 return，不会写 anchor；
- 首块跨过起播点：`anchor = ctxNow + lead`，`part.start >= startPositionSec`，因此 `wantCtxTime >= anchor`，`lateSec` 恒为 0，不会出现 `segments.length === 0`。

真正可复现的是 **`source.start()` 抛异常**，属于 #1。测试应覆盖启动失败，而不是“完全迟到”。

#### #3 `deliveryComplete` 未参与收尾判定

**结论：确认。**

- [_handleStreamEnd()](file:///workspace/src/fragmentEditor/playbackSession.js#L451-L468) 正确计算 `deliveryComplete`；
- [_maybeFinish()](file:///workspace/src/fragmentEditor/playbackSession.js#L963-L981) 只检查 `deliveryDone`；
- [checkStalledFinish()](file:///workspace/src/fragmentEditor/playbackSession.js#L984-L1004) 也不检查，1.5 秒后仍可 finish。

因此 seq 缺口存在时，仍可能把不完整音频当成正常结束。

**对原建议的修正：** 只加 `(!deliveryDone || !deliveryComplete) return` 会让会话永久停在播放态，而且 watchdog 仍会 finish。必须同时处理：

- `_maybeFinish` 与 `checkStalledFinish` 的 gap 门控；
- gap 时切换到完整 buffer 兜底；
- 兜底起点用当前可听位置，而不是原始 `startPositionSec`，避免重复播放；
- 或仅在 `!streamStarted` 时允许整段兜底，已开播则 finish 并显式记录 gap。

**测试：** 构造 seq 1、2、4 + `STREAM_END(lastSeq=4)`，断言不会走正常 finish，且兜底从当前可听位置继续。

#### #4 末段可能超出 `totalSamplesRel`

**结论：确认，已复现。**

[代码](file:///workspace/src/inference/pipeline/index.js#L3376-L3387) 只在 `wantLen > audio.length` 时补零，`audio.length > wantLen` 时不裁剪。

```text
total=240000，末段 audio=240480
最终 sampleEnd=240480 > total
```

**建议修复：**

```js
const wantLen = Math.max(0, totalSamplesRel - frontier);
if (audio.length > wantLen) audio = audio.slice(0, wantLen);
else if (audio.length < wantLen) { /* 补零 */ }
```

并在 `emitChunk()` 前统一保护：

```js
if (frontier + audio.length > totalSamplesRel) {
  audio = audio.slice(0, Math.max(0, totalSamplesRel - frontier));
}
```

注意空末段补 1 样本承载 `isLast` 的路径也可能让 `sampleEnd = total + 1`，需要明确规则。

#### #5 非末段音频越界会裁掉后段头部

**结论：部分确认，但原建议的裁剪上限错误。**

- 2 秒重叠是设计：保留前段整段、裁掉后段头部、接头做渐变；
- `_synthesizeSegment()` 的音频通常等于段时长，不存在“额外上下文”覆盖后段；
- 但 vocoder 取整可能让前段多出几百个样本，`frontier` 越过 `meta.relEnd`，导致后段头部被多裁。

实测：前段多 480 样本时：

```text
chunk0 [0, 96480]，chunk1 [96480, 192000]，长度 95520
```

**修正：** 上限应是 `meta.relEnd`，不是 `min(meta.relEnd, nextStart)`。后者会删掉设计中的前段重叠尾，改变接缝策略。

```js
const maxLen = Math.max(0, meta.relEnd - frontier);
if (audio.length > maxLen) audio = audio.slice(0, maxLen);
```

#### #6 `seqCursorSec` 对混合协议不安全

**结论：确认（低严重度）。**

[_contentRange()](file:///workspace/src/fragmentEditor/playbackTimeline.js#L88-L103) 只在 `!hasSampleRange` 时推进 cursor。带范围块之后的第一个无范围块会从旧 cursor（通常是 0）开始，被判 duplicate。

**建议：** 所有块都执行 `this.seqCursorSec = Math.max(this.seqCursorSec, relEndSec)`；同一 identified 流中出现混合范围时记录异常状态。

### 3.2 P1：偶发卡住、错误收尾与取消误伤

#### #7 resume 失败仍清除 waiting

**结论：确认。**

- [_resumeContext()](file:///workspace/src/shared/streamingScheduler.js#L323-L355) 吞掉 `ctx.resume()` 异常且无返回值；
- [resumeFromWait()](file:///workspace/src/shared/streamingScheduler.js#L172-L192) 无条件清 `_waitingForInference` 并回调 `onWaitStateChange(false)`。

结果可能是：AudioContext 仍 suspended，调度器却认为已恢复，后续 chunk 继续排程。

**修复：** `_resumeContext()` 返回 `!this._contextSuspended`，覆盖三个提前返回路径；`resumeFromWait()` 仅在成功时清 waiting 和回调。调用方检查返回值，失败时保持 waiting 让 watchdog 重试。

#### #8 Worker 取消拒绝所有 pending

**结论：确认，但原建议的精确取消不完整。**

[svsWorkerClient.cancelActiveSynthesis()](file:///workspace/src/main/svsWorkerClient.js#L144-L159) 当前：

```js
for (const { reject } of this.pending.values()) reject(err);
this.pending.clear();
```

会误伤 `init`、`loadModel`、`status` 等非合成请求。

**修正：** 需要同时处理两件事：

1. `pending` 条目记录 `command`，只拒绝 `synthesize` / `synthesizeMultiStreaming`；
2. `activeSynthId` 是最后提交的 synth，不一定是正在运行的那个。需要跟踪 running synth id（例如 worker 首次 progress/chunk 时确认），或对所有 synth pending 发送 cancel，而不是只对 `activeSynthId`。

#### #10 `STREAM_END` 无法区分完成、失败与取消

**结论：确认。**

[svsIpc.sendStreamEnd()](file:///workspace/src/main/svsIpc.js#L978-L989) 在 [finally](file:///workspace/src/main/svsIpc.js#L1112-L1118) 中无条件发送，字段只有：

```js
{ streamId, lastSeq, transportFailed }
```

接收端无法区分正常完成、合成失败、取消、Worker 崩溃、部分 chunk。

**建议：** 增加 `complete` / `failed` / `cancelled` / `firstFailedSeq`；renderer 在 `complete !== true` 时不把 END 当作完整成功交付。

#### #12 未启动的计划不能提前更新账本

**结论：部分确认。**

- `coveredRanges` 已由 `plan(reserve:false)` + 仅 `commit(startedSegs)` 保护，这部分是正确的；
- anchor 在 `plan()` 中提前写入，属于 #1；
- SOTA 说“`source.start()` 成功但随后连接失败”顺序不对：`connect()` 在 `start()` 之前；
- 真正的边界是：`createBuffer` / `connect` 抛异常会绕过 `commit`，已经启动的前序段不会登记，留下“有声但 coveredRanges 空洞”。

**建议：** 用 `try/finally` 包住逐段排程，异常时也提交已成功启动的 `startedSegs`；失败段不登记。

#### #14 最终发射长度没有统一断言

**结论：确认（中低严重度）。**

[_createSegmentStreamEmitter()](file:///workspace/src/inference/pipeline/index.js#L3399-L3409) 只返回 `segmentDone`，无法检查最终 `frontier`。

**建议：** 暴露 `frontier` / `finished`，在完成后校验：

- 正常路径：`frontier === totalSamplesRel`；
- 空末段补 1 样本承载 `isLast` 的路径：允许明确的 `+1` 规则或改为把 `isLast` 挂到前一块；
- 其他偏差直接抛错，不要静默。

### 3.3 P2：诊断与可观测性

#### #11 首个发送失败序号未记录

**结论：确认（低）。**

当前只记 `streamSendFailed = true`；日志里虽有失败 seq，但 END 消息没有 `firstFailedSeq`，无法确认失败位置与后续是否继续发送。

**建议：** 增加 `firstFailedSeq` 并放入 END；同时记录“失败后是否继续尝试”。

#### #13 多 segment 的 `chunkIndex` 重复

**结论：确认（低），已复现。**

```text
chunkIndex: [0, 1, 1]
```

补零块与真实音频块共用 `nextTimeIdx`。播放端不按 `chunkIndex` 去重，因此不直接造成静音，但会误导重叠/丢块排查。

**建议：** 维护独立 `emittedChunkIndex`，`segmentIndex` 单独传递。

### 3.4 不成立项

#### #9 `_planChunks()` 的 `chunkEnd` 空分支

**结论：不成立。**

这是精简审查包的非线性摘录造成的假象。精简包本节已标注 1384-1402 被省略；[实际代码](file:///workspace/src/inference/pipeline/diffusion.js#L1381-L1405) 三个分支完整：

```js
if (isLast) chunkEnd = totalFrames;
else if (canSearch) { /* F0 边界搜索 */ }
else chunkEnd = defaultChunkEnd;
```

## 4. 修复优先级

### P0

1. #1 延迟锚点（含 `_activatePlaybackUi()` 顺序修正）
2. #3 `deliveryComplete` 收尾门控 + gap 兜底
3. #4 末段裁剪/全局长度上限
4. #7 resume 失败保持 waiting
5. #8 精确取消（按 command + running id）
6. #10 END 明确携带完成/失败/取消状态

### P1

7. #5 非末段上限改为 `meta.relEnd`
8. #6 `seqCursorSec` 始终推进
9. #12 异常时提交已启动段
10. #14 最终 frontier 断言

### P2

11. #11 `firstFailedSeq`
12. #13 独立 `chunkIndex`

### 不处理

- #2：按当前实现不可达；改为覆盖 `source.start()` 失败场景。
- #9：摘录假象，无代码问题。

## 5. 回归测试矩阵

| 场景 | 断言 |
| --- | --- |
| 冷缓存、多 segment、22s 空区 | 每块 offset 等于前块 end；Seg3 PCM 非零 |
| 连续多段 | 第二段 offset = 4s，不是 0 |
| 真实 Worker Transferable | `frontier` 不受 `audio.buffer` 分离影响 |
| 首块 `source.start()` 抛异常 | 不写 `anchorCtxTime`、`coveredRanges`、`scheduledCount` |
| seq 缺口 | 不允许正常 finish；gap 兜底从当前可听位置继续 |
| AudioContext resume 失败 | 保持 waiting，不回调 `onWaitStateChange(false)` |
| 末段过长 / 过短 / 为空 | `sampleEnd <= totalSamplesRel`；空末段 `isLast` 规则明确 |
| 前段多出 480 样本 | 只裁到 `meta.relEnd`，后段头部不被多裁 |
| 混合有范围/无范围 chunk | 无范围块不回到 0，不判 duplicate |
| 用户取消 | 只取消目标 synth；`init` / `loadModel` pending 不被拒绝 |
| synthesis 抛错 | END 携带 `complete:false`，不按正常交付 |
| 长休止 | 补零块长度精确，`chunkIndex` 单调 |

## 6. 验证记录

- 定向测试：`npx mocha ... multiSegmentStreamEmitter.test.js cachedChunkReplay.test.js` → **16 passing**
- 相关播放/管线测试：`fragmentStreamingPlayback`、`fragmentStreamProtocol`、`fragmentPlaybackSession`、`fragmentPlaybackTimeline`、`wsola`、`diffusionChunked` → **58 passing**
- ESLint（修改文件）→ **0 error**，仅既有 unused 警告
- Node 24.1.0 `worker_threads` 实测：`postMessage` + transfer 后发送侧 `length=0/byteLength=0`
- `StreamTimeline` 模拟：正确块序覆盖 `0–30.15s`；bug 块序在 `26.15–30.15s` 排到补零样本

## 7. 范围说明

本报告覆盖分片编辑器单分片预览路径；以下内容未展开：

- 主窗口 `synthesizeMultiStreaming` 的全局时间交错路径与 `streamManifest/streamLast` 协议；
- 主窗口 `renderer/audioPlayback.js` 的流式播放实现；
- 插件后端、远程 API 后端、导出 WAV、独占模式内部实现。
