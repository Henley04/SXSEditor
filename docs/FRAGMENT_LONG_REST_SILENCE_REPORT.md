# 分片编辑器「首个长空当后无输出」排查材料

> 供他人接手检查用。整理时间：2026-11-22。
> 工程：`D:/Document/Weixin/xwechat_files/wxid_ro8iw11sgoyd22_fb2c/msg/file/2026-11/xinzuo.sxsproj`
> （与 `D:/Document/waveform/cliper/已导出/xinzuo.sxsproj` 的 MD5 相同：`79531d4280d574002d6c4a86d5032401`）

## 0. 先说结论边界

1. **空当内静音是设计行为**：工程有 6 个有效演唱 region、12 个推理 segment，第一个长休止约 **26.14 秒**（拍 59.67 → 132.83）；`_createSegmentStreamEmitter` 刻意不推理这段，改为发一块等长的零采样 chunk 保持时间轴连续。
2. **空当结束后应当恢复出声**。用当前源码做确定性仿真：emitter 产出 17 块，`StreamTimeline` 全部 `schedule`，0 丢弃、0 迟到，覆盖区间账本连续。因此问题不在“区间账本把后续块吃掉”这一条已被验证的路径上。
3. **推理输出本身在对照环境下正常**：用同一工程跑真实 pipeline（DML、无参考歌手、`ptFrameCount=50`），第一个长空当之后的每一块演唱音频 RMS 为 0.0736–0.1276，只有长休止填充块 RMS=0。说明基础切段/推理/混音不会产生“空当后整段静音”。
4. 用户日志有两处**与当前源码/本地复跑不一致**，接手者必须先核对运行版本与原始日志，否则会建立在错误前提上：
   - 所有 `chunk emitted` 都是 `offset=0 end=0`。当前源码此处打印 `frontier` 与 `frontier+audio.length`；本地用同一工程复跑得到的真实值是 `seg=0 offset=0 end=466080`、`seg=1 offset=466080 end=1093542` 等递增数值。
   - 日志中 seg=4 有 2 条 emitted；当前代码中 seg=3/4 这类重叠段只发 1 块（前一段尾部与前序 frontier 重叠，被裁头后合并发一块）。当前代码各段 emitted 块数为 `1,2,2,1,1,2,2,1,1,1,1,2`，合计 17。
   - 另：日志三个片段的拼接顺序不是严格时间序（第三段开头的 `frames=598` 是 seg9 的扩散，却排在 seg9 的 `segment inference done` 之后）。

## 1. 工程与日志事实

工程参数：BPM 168，单 fragment，`duration=734.25` 拍（约 262.2s），408 个 note（其中 404 个落在 duration 内），`firstNoteStart=5.25` 拍；推理/播放采样率均为 **24000 Hz**。

用真实切段代码 `p._fillNoteGaps()` + `p._buildVocalSegments()` 得到 12 段，与日志里的 `relStart/relEnd` 逐字吻合：

| seg | 拍区间 | relStart | relEnd | 日志 samples | 与上段间隔（采样） |
|-----|--------|----------|--------|--------------|--------------------|
| 0 | 5.250–59.670 | 0 | 466457 | 466080 | — |
| 1 | 132.830–187.670 | 1093542 | 1563599 | 469920 | **627462（26.14s，第一个长空当）** |
| 2 | 192.830–232.750 | 1607828 | 1950000 | 341760 | 44366 |
| 3 | 227.150–264.750 | 1902000 | 2224285 | 322080 | 重叠（负间隔） |
| 4 | 259.150–292.670 | 2176285 | 2463600 | 287040 | 重叠 |
| 5 | 324.830–379.670 | 2739257 | 3209314 | 469920 | 275932（11.50s） |
| 6 | 456.830–496.750 | 3870685 | 4212857 | 341760 | 661508（27.56s） |
| 7 | 491.150–528.750 | 4164857 | 4487142 | 322080 | 重叠 |
| 8 | 523.150–560.750 | 4439142 | 4761428 | 322080 | 重叠 |
| 9 | 555.150–592.750 | 4713428 | 5035714 | 322080 | 重叠 |
| 10 | 587.150–620.670 | 4987714 | 5275028 | 287040 | 重叠 |
| 11 | 684.830–739.250 | 5824971 | 6291428 | 423360 | 550217（22.93s） |

日志时间线：seg0 `t=1795263797718` → seg11 `t=1795263898705`，约 101 秒完成全部推理；每段 RTF 1.44–2.16x，扩散 72–108 frames/s；EP 为 `winml:NvTensorRTRTXExecutionProvider`，`ptFrameCount=1500`（参考歌手 prompt），`isLast=true` 只出现在最后一块。

## 2. 相关代码（按数据流顺序）

### 2.1 长休止切段与 segment 构造
`src/inference/pipeline/audioSegmentation.js:122-176`（`splitLongRestRegions`）与 `:181-336`（`buildVocalSegments`）：>=1.5s 的休止只保留两侧各 150ms 上下文，中间部分**不送推理**；>20s 的 region 再按 2s overlap 切成 segment。日志里的 12 段即由此产生（控制台有 `Scheduled 12 inference segments across 6 active regions (262.2s timeline); long rests skipped`）。

### 2.2 流式 emitter：静音块在这里插入
`src/inference/pipeline/index.js:3282-3392`，关键片段：

```js
// :3295-3299
const CONTIG_EPS = Math.round(0.021 * SAMPLE_RATE);
let frontier = 0;    // 已发射前沿（相对 firstNoteStart 的采样位置）
let nextTimeIdx = 0;

// :3315-3329
const emitChunk = (audio, isLast) => {
    if (!audio || audio.length === 0) return false;
    try {
        onChunkAudio({
            chunkIndex: nextTimeIdx,
            sampleOffset: frontier,
            sampleEnd: frontier + audio.length,
            audio, totalSamples: totalSamplesRel, isLast,
        });
    } catch (_) {}
    console.log(`[SegInfer][FRAG] chunk emitted | seg=${nextTimeIdx}/${timeOrder.length} offset=${frontier} end=${frontier + audio.length} isLast=${isLast} t=${Date.now()}`);
    frontier += audio.length;
    return true;
};

// :3338-3342  ← 首个长空当对应的代码
const gapSamples = meta.relStart - frontier;
if (gapSamples > CONTIG_EPS) {
    emitChunk(new Float32Array(gapSamples), false);
}
// :3344-3348 重叠段裁头
const trim = Math.max(0, Math.min(frontier - meta.relStart, audio.length));
if (trim > 0) { audio = audio.slice(trim); fadeInHead(audio); }
```

`segmentDone()`（`:3382-3390`）按时间序门控：前面的段未完成则不发射，因此块顺序即时间顺序。

### 2.3 主进程转发与结束屏障
`src/main/svsIpc.js:967-1008`：每个 chunk 附带 `streamId` + 单调 `seq`；`:978-988` 在 invoke 回执前发 `FRAGMENT_SVS_STREAM_END{lastSeq,transportFailed}`。

### 2.4 渲染端收块与 WebAudio 排程
- `src/fragmentEditor/audioPlayback.js:355-372`：注册 chunk / END 监听，会话归属过滤。
- `src/fragmentEditor/audioPlayback.js:368-408`：invoke 回执后 `drain()` → `setInferenceDone()` → `_maybeFinish()`。
- `src/fragmentEditor/playbackSession.js:661-801`：`_processChunk()`。关键顺序为 `timeline.plan(...,{reserve:false})` → `source.start()` 成功 → `timeline.commit()` → **`scheduler.updateBufferFrontier(committedEnd)` 必须在 `resumeFromWait()` 之前**（`:775-794`，注释明确写了否则“首段之后整段静音”）。丢弃分支日志在 `:707-712`。
- `src/fragmentEditor/playbackSession.js:817-854`：`_maybeFinish()` 三条件（推理结束 + 无活动 source + 播放头越过已交付末端）与 `checkStalledFinish()` 死锁守卫。

### 2.5 时间轴唯一真源
`src/fragmentEditor/playbackTimeline.js`：
- `:88-103` `_contentRange()`：只有 `sampleEnd > sampleOffset` 才使用绝对采样区间；否则退化为“按到达顺序拼接”的 `seqCursorSec`。
- `:112-127` `_cover()` / `:140-152` `_uncoveredParts()`：区间账本（乱序回填 / 去重）。
- `:162-250` `plan()`：`startedNow` 时建立 `anchorCtxTime`；迟到只裁头不改斜率；一个块被已排区间切开时逐段排。
- `:294-298` `positionAt()`：播放头 = `startPositionSec + (ctxNow - latency - anchor)`。

### 2.6 underrun 冻结/解冻
`src/shared/streamingScheduler.js:150-165`（`checkUnderrun`）、`:172-192`（`resumeFromWait`）、`:208-216`（`onSourcesDrained`）；调用点在 `src/fragmentEditor/playbackSession.js:1041-1047`。长静音块会使 `bufferEndSec` 一次跳到 47.4s，理论上不会触发 underrun；但若播放头/前沿不同源（例如采样率不一致），此处是最容易表现为“冻结后永久静音”的地方。

### 2.7 推理侧对静音的处理（用于区分“播放静音”与“音频本身静音”）
- `src/inference/pipeline/index.js:744-781` `_silenceNonVocalRegions()`：按 note 区间清零非人声采样。
- 注意：单段路径在 `:4849` 调用它，多段 `_synthesizeSegment` 路径**不调用**；混音后的 `weightSum=0` 区域在 `:5159` 后清零。这意味着长休止区间本身必然为零，但 segment 内部的休止上下文可能仍有模型输出。
- `:2441-2443` `_melPostprocessFrameOffset()` 与 `:3102-3107`：多段路径把 mel 后处理载荷从“分片首音符”换算到“当前 segment 首音符”。`pitchCurveOffsetSec` 在 `:3084`。这两处是“长休止之后段”最容易发生时间错位的点。

## 3. 已排除项（有证据）

1. **采样率不一致**：推理 `SAMPLE_RATE=24000`（`src/inference/shared/constants.js`），渲染端 `src/fragmentEditor/state.js:4` 同样为 24000，`getSampleRate()` 取自该变量。
2. **区间账本丢块**：用真实 emitter + 真实 `StreamTimeline` 仿真（输入为日志中的 12 段长度）得到 17 块，全部 `schedule`，`dropped=0`、`late=0`、`coveredRanges=2`、`deliveredEndSec=264.02`。第一个静音块为 `[466080,1093542)`，26.144s，正常排程。
3. **RoPE 2048 帧退化 bug**：当前 `onnx_models/fp16/diff_step_dml.onnx` 与根 `onnx_models/diff_step_dml.onnx` 均含 `rope_cos_table` / `rope_sin_table` 初始化器（已烘焙修复）。但日志 `ptFrameCount=1500`，`1500+979=2479>2048`，若运行机用的是未重烘焙的旧导出（例如 `onnx_models/diff_step_dml.onnx.bak`，该备份**没有** rope 表），仍会复现“尾部能量凹陷/静音”。需核对运行机实际加载的模型文件与 `build-info.json`。
4. **长休止后推理音频非零**（本地实测，`scripts/_probe_xinzuo.js`，DML / 无参考歌手 / fp16 / STORK2 / 32 步，187.5s 完成 12 段）：

```
#1 rel=[19.42,45.56)  rms=0.0000   <- 长休止静音填充（预期）
#1 rel=[45.56,65.14)  rms=0.0961   <- 空当后第一段，正常
#2 rel=[65.14,66.99)  rms=0.0000   <- 休止
#2 rel=[66.99,81.23)  rms=0.1119
#3 rms=0.1045   #4 rms=0.0788   #5 rms=0.0968   #6 rms=0.0845
#7 rms=0.0986   #8 rms=0.1009   #9 rms=0.0933   #10 rms=0.0736
#11 rel=[219.78,242.71) rms=0.0000  #11 末块 rms=0.1276 isLast=true
post-measure34 overall: rms=0.0835 peak=0.8823
```

注意此对照**不含参考歌手 prompt**（`ptFrameCount=50`），而用户日志是 1500；因此它排除的是“切段/静音填充/基础推理路径”，并不排除 TRT-RTX + 长 prompt 的组合问题。

## 4. 重点怀疑点（按优先级，供逐项排除）

### P0 — 先确认日志与运行版本
- 你贴的 `offset=0 end=0` 在当前代码里不可能出现（emitter 的 `frontier` 会累加，且 `audio.length===0` 时在打印前就 return）。请提供**原始未拼接**日志、应用版本/提交号，并确认是否来自另一台机器或旧安装包。
- 如果是旧构建，本文基于当前源码的分析结论只适用于当前版本；应先把旧构建日志与旧源码对照。

### P1 — 静音块或后续块在渲染端被 drop
在 `src/fragmentEditor/playbackSession.js:707-712` 的 `chunk dropped` 日志与 `:786` 的 `chunk scheduled` 日志中，检查第一个长空当之后的几块：
- `reason=before-start/duplicate/late` 分别指向起播点、覆盖账本、迟到裁头；
- `parts` 是否为 0、`started` 是否为 true、`lateSec` 是否异常大；
- `updateBufferFrontier` 是否在 `resumeFromWait` 之前执行（`:775-794`）。

### P2 — underrun 冻结后未解冻 / 提前 finish
抓取 `[FragPlay] PLAYBACK START`、`[FragPlay] PLAYBACK FINISHED`、`[FragPlay] LAST CHUNK RECEIVED` 与 `AudioContext.state`。重点看：seg0 音频（19.4s）播完、26.14s 静音块播完的时刻，`activeSourceCount` 是否已为 0、`inferenceDone` 是否已置位；若两者同时成立且播放头越过 `deliveredEndSec`，`_maybeFinish()` 会直接结束会话，表现为“空当后无输出”。

### P3 — 仅在用户实际配置下推理输出为零
本地 DML/无参考歌手对照已排除通用推理路径（见第 3 节第 4 条）。但用户配置是 **WinML TRT-RTX + `ptFrameCount=1500` 参考歌手**，需在该配置下复测 RMS；若此时第 1 段之后的 chunk RMS≈0，则问题在推理侧而非播放侧，继续查：
- `pitchCurveF0` 的绝对时间索引（`pitchCurveOffsetSec = segStartBeat/bpm*60`）；
- `melPostprocess` 载荷帧偏移（`:3105`），载荷总长仅 13019 帧，最后几段接近尾部，需确认越界时的钳制行为；
- 参考歌手 prompt（`ptFrameCount=1500`）与 TRT-RTX EP 组合；用 `inferenceProvider=dml` 与“无参考歌手”两组对照实验可快速隔离。

### P4 — 多段路径缺少 `_silenceNonVocalRegions`
`_synthesizeSegment` 不像单段路径那样逐段清零非人声区，重叠裁头后接缝处的模型输出可能与静音区突变叠加；这更可能造成爆音/接缝噪声，不是整段无声，但值得顺手核对。

## 5. 建议的检查/复现步骤

1. 用同一份 `xinzuo.sxsproj`，在分片编辑器播放，抓取**完整未折叠**的 `[SegInfer][FRAG]` + `[FragPlay]` + `[StreamingScheduler]` 日志。
2. 记录：应用提交号、EP、是否使用参考歌手、`ptFrameCount`、实际加载的 `diff_step` 模型路径。
3. 三组对照：① EP=TRT-RTX vs DML；② 有参考歌手 vs 无参考歌手；③ 有 melPostprocess vs 关闭。若只有 TRT-RTX 出问题，优先查 P3 的模型导出/RoPE。
4. 若要加临时日志，最小侵入位置：`playbackSession.js:707`（drop reason）与 `:786`（scheduled 的 `lateSec/parts/started`）、`playbackTimeline.js:174`（`contentStart/contentEnd/parts`）、`streamingScheduler.js:150`（`elapsed/frontier/margin/isWaiting`）。

## 6. 附录：本次所做的确定性仿真

用真实 `_createSegmentStreamEmitter` 喂入日志中的 12 段采样长度，再把 17 个输出块喂给真实 `StreamTimeline`（`startPositionSec=0`，`firstNoteStartSec=1.875`），输出摘要：

```
CHUNK count=17 total=6291429
CHUNK 0 seg=0 off=0 end=466080 len=466080 last=false
CHUNK 1 seg=1 off=466080 end=1093542 len=627462 last=false   <- 26.144s 静音填充
CHUNK 2 seg=1 off=1093542 end=1563462 len=469920 last=false
...
CHUNK 16 seg=11 off=5824971 end=6291429 len=466458 last=true
TIMELINE chunk=1 action=schedule reason=- late=0.000 dur=26.144 ...
SUMMARY scheduled=17 dropped=0 late=0 coveredRanges=2 end=264.02
```

说明当前源码在这条数据上把“后续块判为丢弃/迟到”的可能性很低；接手者应优先做 P0/P1/P2 的运行时取证。
