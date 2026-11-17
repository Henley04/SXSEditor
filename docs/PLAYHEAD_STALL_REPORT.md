# SXSEditor 分片编辑器 · 播放卡顿与播放头错位 — 调查报告

| | |
|---|---|
| 目标仓库 | Henley04/SXSEditor |
| 触发环境 | 后台 CUDA 训练 + nvcodec 录屏 |
| 调查日期 | 2026-11-18 |
| 基线 commit | `3a321d3` (master) |
| 方法 | 源码审计 + 虚拟时钟受控复现 |

## 结论先行

这是**两个相互独立、但都被"极端负载"放大的问题**，叠加出现：

**问题 1 · 错位**　播放头由时钟推演，声音由设备缓冲出队。二者本靠 `outputLatency` 对齐，但该值在 Chromium 中运行期不随负载更新，且上限被钳到 0.5s。CUDA 训练 + nvcodec 抢占 GPU/CPU 导致实际输出延迟激增时，补偿量锁死不变 → 播放头稳定跑在声音前面。受控复现：额外 150ms 延迟 → 播放头超前 150ms。

**问题 2 · 卡顿/内容缺失**　流式播放的 underrun 保护用 `AudioContext.suspend()/resume()` 冻结/恢复时钟，但这是**异步**操作。GPU 争用下该控制消息延迟从 8ms 涨到 300–500ms，在"已标记 waiting、但设备尚未真正冻结"的窗口内，chunk 到达被误判为迟到并错误裁头 → 每个接缝丢一小段音频 → 静音缝 + 播放头卡住。受控复现：500ms 控制延迟 → 6 处静音缝共 2.02s、播放头卡住 6 次、内容缺失 2.02s。

正常条件下（控制延迟 ≤10ms、输出延迟 ≤60ms）代码表现**完全正确**——仓库自带的虚拟时钟测试 11 个场景全部通过（zero drift / zero gap / zero repeat）。问题只在突破这些隐含假设的极端负载下暴露，这解释了为什么开发者测不出来、而用户在"训练+录屏"时能复现。

## 一、播放架构：两套时钟，四个时间域

分片编辑器有两条播放路径，播放头位置来源完全不同——这是理解错位的起点。

**路径 A · WebAudio 共享模式（默认）— 播放头 = 可听时钟**
`getAudibleElapsedSec(ctx, start) = ctx.currentTime − outputLatency`。用 `requestAnimationFrame` 逐帧更新。文件：`fragmentEditor/audioPlayback.js:765`

**路径 B — WASAPI 独占模式 — 播放头 = 墙钟**
`performance.now()` 推进，补偿一个固定下界 `bufferSize/sampleRate`（≤0.2s）。文件：`fragmentEditor/audioPlayback.js:1000`

> 关键设计意图（源码注释原文）："播放头必须按'耳朵听到的位置'走，而不是渲染线程的 currentTime"。为此项目专门建立了 `shared/audioOutputClock.js`，用 `outputLatency` 把渲染时间换算成可听时间。这个设计在正常负载下是对的——问题出在它对**延迟的假设**。

```
① 推理 (GPU)                ② 排程                     ③ 渲染时钟              ④ 设备出队
逐 chunk 合成 PCM      →   source.start(          →   ctx.currentTime /   →   缓冲经 WASAPI
sampleOffset 标记绝对位置      startTime + 内容位置差)      墙钟 → 播放头             到喇叭 = 实际听到
```

播放头在 **③** 更新，声音在 **④** 才产生。**② 与 ④ 之间的时间差就是 outputLatency**。错位 = ③ 的推演速度 ≠ ④ 的实际出队速度。

## 二、问题 1 根因：`outputLatency` 在负载下"锁死"

### 代码事实

`src/shared/audioOutputClock.js`

```js
export const MAX_OUTPUT_LATENCY_SEC = 0.5;   // 超过按异常→钳到0.5
const LATENCY_SMOOTHING = 0.2;               // EMA，~5帧收敛

export function estimateOutputLatencySec(ctx) {
  if (Number.isFinite(ctx.outputLatency) && ctx.outputLatency > 0)
    return _clampLatency(ctx.outputLatency);   // ← 只读 ctx.outputLatency
  ...
}
```

补偿量完全依赖 `ctx.outputLatency`。但在 Chromium 中，该属性在 AudioContext 创建 / 设备切换时确定，**运行期系统负载导致的缓冲堆积不会反映进来**。独占模式更脆弱——它根本没有 AudioContext，只能用一个固定下界补偿（1024/48000 ≈ 21ms）。

### 受控复现结果

模拟：播放 30s，第 5s 起叠加"CUDA 训练 + nvcodec 录屏"造成的音频输出延迟 ramp，播放头按源码逻辑推演，对比听众实际听到的位置。

| 额外实际输出延迟 | 共享模式播放头超前 | 独占模式播放头超前 |
|---|---|---|
| 0 ms（正常） | 0 ms | −1 ms |
| 30 ms | +30 ms | +29 ms |
| 60 ms | +60 ms | +59 ms |
| 100 ms | +100 ms | +99 ms |
| 150 ms | +150 ms | +149 ms |
| 300 ms | +300 ms | +299 ms |
| 600 ms | +600 ms（受 0.5s 钳制影响） | +599 ms |

**为什么"极端"才明显**：正常态输出延迟 20–120ms，偏差在 1px 量级肉眼近乎不可见。nvcodec 录屏（NVENC 编码 + 屏幕捕获占 GPU/PCIe）叠加 CUDA 训练满载 GPU 时，音频线程被抢占、设备缓冲排空变慢，实际延迟轻松突破 150–300ms，错位变得肉眼可见——正是用户描述的现象。

## 三、问题 2 根因：`suspend` 异步窗口内的"迟到裁头"误判

### 完整因果链（已由 SIM_DEBUG 逐事件证实）

分片编辑器是**边合成边播**：GPU 每产出一块 PCM 就排程播放。当播放头追上已交付音频前沿（underrun），调度器冻结 AudioContext 等待下一块。关键在 `suspend()` 是异步的。

```
31.028  underrun 触发 → ctx.suspend() 发出，scheduler 标记
        _contextSuspended=true / isWaiting=true
　　⋯⋯ GPU 争用下，控制消息排队 300ms，
        此期间 ctx.state 仍是 'running'，ctx.currentTime 继续走 ⋯⋯
31.328  chunk#1 到达 → 进入回调
        lateSec = ctx.currentTime − wantCtxTime = 0.074（本应为 0）
        → source.start(when, 0.074) 裁掉头部 74ms 音频
31.328  ctx.resume() 被调用两次（resumeFromWait + 自愈路径竞态）
```

根因代码（`fragmentEditor/audioPlayback.js:1316-1344`）：

```js
const wantCtxTime = startTime + (contentFromSec - playFrom);
const lateSec = Math.max(0, ctx.currentTime - wantCtxTime);  // ← 时钟在 suspend in-flight 期间多走了 300ms
...
source.start(wantCtxTime + lateSec, lateSec);  // ← offset 裁头，造成内容永久丢失
```

正常延迟 8ms 时，多走的 8ms 落在 0.3s 安全余量（`watchdogMarginSec=0.3`）内，不触发裁头。GPU 争用把延迟推到 300ms+，**超出余量，每个 chunk 接缝都被裁掉一小段**。

### 受控复现结果（基于仓库自带模拟脚本，仅改 `controlDelayMs`）

`scripts/sim_fragment_playback.js` 现内置三个同源场景（K / K-EXTREME / K-EXT2），实测指标表：

| 场景 | 静音缝 | 内容缺失 | 播放头卡住 | 声画错位 | 结果 |
|---|---|---|---|---|---|
| 场景 K（8ms，仓库自带） | 0 | 0 | 0 | 0 | PASS |
| K-EXTREME（300ms） | 6 / 0.82s | 0.82s | 0 | 0.26s | **FAIL** |
| K-EXT2（500ms） | 6 / 2.02s | 2.02s | 6 次 / 0.35s | 0.26s | **FAIL** |

逐 chunk 的裁头位置（`lossSpans`，单位秒）：

```
K-EXTREME 300ms:  [10,10.07] [19,19.05] [28,28.19] [37,37.24] [46,46.2] [55,55.06]
K-EXT2     500ms:  [10,10.27] [19,19.25] [28,28.39] [37,37.44] [46,46.4] [55,55.26]
```

裁头量随控制延迟线性增长：300ms 延迟下每块丢 54–242ms；500ms 下丢 270–440ms，并触发播放头卡住。这与"播放卡顿 + 播放头与实际错位"完全吻合。

复现命令：

```bash
node scripts/sim_fragment_playback.js              # 全部场景
node scripts/sim_fragment_playback.js K-EXTREME    # 只跑 300ms 控制延迟
SIM_DEBUG=1 node scripts/sim_fragment_playback.js K-EXT2   # 逐事件时序
```

## 四、为什么开发者没发现

- **测试用固定 latency**　模拟脚本 `OUTPUT_LATENCY = 0.02` 恒定，无法暴露延迟激增
- **测试用极小控制延迟**　场景 K 仅 `controlDelayMs: 8`，落在 0.3s 安全余量内
- **虚拟时钟无 GPU 争用**　推理耗时是设定值，没有真实 GPU 调度抖动与缓冲堆积

仓库近期提交（`3b6ffb9` / `f6a072b` / `67df307` / `6eb933c`）已系统性修过"顺序调度改绝对调度""可听时钟""自愈循环"等历史 bug，说明作者对这块很熟悉。本次问题是**剩余的最后一层边界假设：延迟幅度本身**。

## 五、修复建议

### P0 · 直接消除问题 2（裁头误判）

**方案 A（根治竞态）**：在 `wantCtxTime` 计算前，先让 chunk 回调等待 suspend in-flight 完成。当前 `handleStreamingChunk` 已 `await _getFragmentCtxForChunk()`，但它只在 `ctx.state === 'suspended' && !waiting` 时 resume，**没有 await `scheduler._suspendInFlight`**。应增加：`if (scheduler._suspendInFlight) await scheduler._suspendInFlight`，确保时钟真正冻结后再算 `lateSec`。

**方案 B（更稳）**：迟到裁头阈值加入控制延迟余量——把 `lateSec` 的判定基准从"当前 `ctx.currentTime`"改为"读取 `bufferEndSec` 对应前沿时刻"，与 scheduler 用同一基准；只有当内容确实早于前沿才裁头，而非因 suspend 未落地产生的假迟到。

**方案 C（消竞态）**：合并重复 resume——`resumeFromWait` 与 `updateFragmentPlayhead` 的自愈 resume 加互斥（复用 `_ctxResumeInFlight` 思路），避免双倍控制消息与状态抖动。

### P1 · 缓解问题 1（输出延迟动态化）

- **共享模式**：不要只信 `ctx.outputLatency`。维护一个运行时**可增长**的延迟下界：监测 `source.start(when)` 的 `when` 与实际 `onended` 偏差，或用 AudioWorklet 测量渲染队列深度。当检测到持续 underrun/缓冲堆积时，上调补偿值（保留 EMA 平滑防抖），让播放头跟着实际出声走。
- **独占模式**：把固定 `bufferSize/sampleRate` 下界改为自适应——从 worker 的 PCM 写入时间戳与设备 finish 事件差值估计真实延迟。GPU 高负载时该差值会显著大于 21ms。

### P2 · 可观测性与测试

1. 暴露一个隐藏开关（如 `SXSE_DIAG=1`）打印每帧 playhead / audible / 估计延迟 / underrun 次数，便于用户自证。
2. 扩展虚拟时钟脚本：新增"控制延迟 300/500ms"和"动态输出延迟"场景进 CI 回归，把本次两个 FAIL 场景固化为测试。（**已完成**：`K-EXTREME` / `K-EXT2` 已并入 `scripts/sim_fragment_playback.js`，当前 master 上二者稳定 FAIL，可作为修复验收基准。）
3. 检测到持续高延迟时，UI 给出"设备繁忙，播放可能不同步"提示，而非静默错位。
