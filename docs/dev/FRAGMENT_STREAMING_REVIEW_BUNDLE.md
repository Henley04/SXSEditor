# 分片编辑器 · 分块流式推理 → 播放 全链路代码审查包

> 基线：`6492507`　生成日期：2026-11-22　用途：交给 Astra 6.2 做全面审查
>
> 路径均已按仓库根目录书写；代码为**原样摘录**，未做格式化或改写。
> 行号写在每个小节标题中，便于回到仓库核对；代码块内不嵌行号，可直接复制。

## 0. 审查范围与端到端调用链

本包覆盖**分片编辑器（fragment editor）内按播放键触发的一次分片预览合成**：
从编辑器收集输入、`fragment-svs:synthesize` IPC、主进程 worker 内的分块扩散 + 分块 vocoder、
chunk 经 IPC 回流、渲染端时间轴排程到 WebAudio 出声，直到播放头收尾/停止的完整闭环。

```text
用户点击播放 (uiControls.js)
  └─ audioPlayback.playFragment()
       ├─ createSession("stream") + streamId，订阅 chunk / STREAM_END
       ├─ window.electronAPI.synthesizeFragmentSVS({ notes, bpm, options:{ streamId, ... } })
       │    └─ preload.js ── invokeHeavy ──► main/svsIpc.js  FRAGMENT_SVS_SYNTHESIZE
       │         ├─ opts.onProgress = 100ms/2% 节流
       │         ├─ opts.onChunkAudio = 加 streamId + 单调 seq 后 win.send
       │         ├─ SvsWorkerClient.synthesize() ── worker_threads ──► svsWorker.js
       │         │    └─ OnnxSVSPipeline.synthesize(notes, bpm, opts)
       │         │         └─ _synthesizeImpl
       │         │              ├─ 整段缓存命中 → _emitCachedAudioAsChunks（2s/块）
       │         │              ├─ 单 segment + diffStepChunk → runDiffusionLoopChunked
       │         │              │     └─ onChunkMel → _runVocoderChunkedForSegment
       │         │              │           └─ runVocoderChunked → onChunkComplete(chunk)
       │         │              └─ 多 segment → _createSegmentStreamEmitter
       │         │                    └─ segmentDone() 按时间序门控发射
       │         └─ finally: 先发 FRAGMENT_SVS_STREAM_END(lastSeq)，再回 invoke 结果
       ├─ Session.pushChunk()：协议判定 / streamId 过滤 / seq 去重 / 首块预缓冲
       │    └─ Promise 串行队列 → _processChunk()
       │         ├─ StreamTimeline.plan()：内容区间 − coveredRanges → 排程片段
       │         ├─ ctx.createBufferSource().start(when, offset)
       │         └─ scheduler.updateBufferFrontier() / resumeFromWait()
       ├─ playheadTick()：positionAt(audible) + scheduler.checkUnderrun()
       │    └─ 冻结/解冻 AudioContext；watchdog + source.onended 双保险
       ├─ STREAM_END → _handleStreamEnd()：expectedLastSeq / 连续缺口 / deliveryDone
       └─ drain() → setInferenceDone() → _maybeFinish() → finish()
```

## 1. 三套时间/采样坐标（审查时先对齐）

| 坐标 | 原点 | 使用方 |
| --- | --- | --- |
| 采样坐标 `sampleOffset/sampleEnd` | **首音符起点**（`filledNotes[0].start`），不是分片起点 | 管线 chunk、缓存重放、StreamTimeline._contentRange |
| 内容坐标（分片绝对秒） | 分片起点 | `startPositionSec`、播放头、`coveredRanges`、`deliveredEndSec` |
| 上下文坐标 `AudioContext.currentTime` | AudioContext 创建时刻 | `source.start(when)`、锚点、underrun 前沿 |

播放头显示额外减去 `outputLatency`（audioOutputClock.js），但**调度域不得减**。
编辑器还会用 `padAudioToFragmentDuration()` 给整段兜底音频前置 `firstNoteOffsetSample` 个零，使 `audioData[0]` 对齐分片起点。

## 2. 关键不变量（建议逐条核对实现）

1. **流身份**：一次播放一个 `streamId`；chunk 首块决定 `identified/legacy` 协议，identified 下 streamId 不匹配一律丢弃。
2. **结束屏障**：`STREAM_END(lastSeq)` 在 invoke 回执之前由主进程 `win.send` 发出；END 与 chunk 共用 Session 串行队列，处理完 END 才证明 lastSeq 之前都已处理。
3. **监听所有权**：chunk/END 监听器归 Session 所有，只能随 `dispose()` 摘除，不能在 invoke 回执后提前摘除。
4. **锚点一次性**：`StreamTimeline.anchorCtxTime` 只在第一个真正要发声的 chunk 上建立；起播点之前的整块丢弃且不锚定；锚定后永不重建。
5. **占位账本**：用 `coveredRanges` 区间集合而非单一前沿判断重复/重叠；重叠裁头、重复丢弃、乱序回填。`plan(reserve:false)` 必须在 `source.start()` 成功后才 `commit()`。
6. **underrun 状态机**：`suspend()`/`resume()` 是异步控制消息；`isWaiting` 的清除必须等 resume 真正落地；`inferenceDone` 之后不再冻结，已在等待则立即解冻。
7. **收尾三条件**：推理已结束（回执/isLast）、无活跃 source、播放头越过 `deliveredEndSec`；`inFlightChunkHandlers > 0` 时不允许即时 onended 抢先收尾。
8. **多 segment 门控**：`_createSegmentStreamEmitter` 只在时间序前序 segment 全部发射后发射后序；长休止补零；重叠头裁剪；末段补静音承载 isLast。
9. **vocoder committed 语义**：`runVocoderChunked` 只推送 `[committedSamples, stableEnd)` 且 `stableEnd = chunkEnd − overlap`（末块除外）；推送前应用整条流共享的 `_applyStreamGain`。
10. **扩散 committed 语义**：`_runSingleDiffusionChunk` 非末块 `newCommitted = chunkEnd − overlap`；`runDiffusionLoopChunked` 校验最终 `committedFrames === totalFrames`。
11. **取消精确性**：带 streamId 的 cancel 只命中对应 task；queued 任务直接标记 cancelled；running 任务走 worker 协作取消（AbortController），不 terminate 线程。
12. **缓存重放也要成流**：整段缓存命中时必须 `_emitCachedAudioAsChunks`，否则渲染端会退化到“等 invoke 整段返回再播”。
13. **输入变化作废**：推理途中签名变化，必须丢弃结果、停掉本会话旧音频并置空缓存签名，不能把旧音频标成新缓存。

## 3. 代码清单

| 小节 | 文件 | 类型 | 内容 |
| --- | --- | --- | --- |
| R1 | `src/fragmentEditor/pipeline.js:1-210` | 完整文件 | 编辑器推理初始化与预览/导出参数装配 |
| R2 | `src/fragmentEditor/audioPlayback.js:1-592` | 完整文件 | 合成编排：签名、流式订阅、播放入口、后台推理、取消 |
| R3 | `src/fragmentEditor/playbackSession.js:1-1258` | 完整文件 | 播放会话：chunk 串行队列、排程、underrun、收尾、看门狗 |
| R4 | `src/fragmentEditor/playbackTimeline.js:1-301` | 完整文件 | 流式时间轴：锚点、coveredRanges、迟到裁头、位置换算 |
| R5 | `src/fragmentEditor/autoInference.js:1-144` | 完整文件 | 编辑后自动实时推理（后台分段合成，不流式推送） |
| R6 | `src/fragmentEditor/state.js:4-36` | 摘录 | 播放/合成相关模块级状态 |
| R7 | `src/fragmentEditor/state.js:176-268` | 摘录 | 播放/合成状态访问器（token 所有权） |
| R8 | `src/shared/streamingScheduler.js:1-384` | 完整文件 | underrun 调度器：前沿、suspend/resume、watchdog、完成判定 |
| R9 | `src/shared/audioOutputClock.js:1-92` | 完整文件 | 可听时钟与输出延迟补偿（仅显示域） |
| R10 | `src/shared/sequencedChunkQueue.js:1-237` | 完整文件 | 有序 chunk 队列（当前内置管线主路径未启用，保留给插件/重排） |
| R11 | `src/fragmentEditor/uiControls.js:155-182` | 摘录 | 播放按钮状态机（播放中 > 合成中 > 自动推理 > 空闲） |
| R12 | `src/fragmentEditor/uiControls.js:321-357` | 摘录 | 播放按钮点击：停止 / 取消推理 / 新建播放 |
| R13 | `src/fragmentEditor/eventHandlers.js:2397-2432` | 摘录 | 播放头拖拽：合成中 seek 保留会话并记录 pendingSeek |
| R14 | `src/preload.js:202-239` | 摘录 | preload：分片合成 invoke / chunk / stream-end 订阅 |
| R15 | `src/shared/ipcChannels.js:75-84` | 摘录 | IPC 通道：分片合成入口 |
| R16 | `src/shared/ipcChannels.js:330-338` | 摘录 | IPC 通道：chunk / stream-end 推送 |
| R17 | `src/main/svsIpc.js:81-114` | 摘录 | 主进程：流任务表（streamId -> task）与合成互斥 |
| R18 | `src/main/svsIpc.js:583-598` | 摘录 | 主进程：进度节流发送器 |
| R19 | `src/main/svsIpc.js:874-908` | 摘录 | 主进程：按 streamId 精确取消 |
| R20 | `src/main/svsIpc.js:936-1119` | 摘录 | 主进程：分片合成 handler、chunk 网关、STREAM_END 屏障 |
| R21 | `src/main/svsWorkerClient.js:1-173` | 完整文件 | worker 客户端：事件桥接、ArrayBuffer 移交、协作取消 |
| R22 | `src/inference/svsWorker.js:1-279` | 完整文件 | worker 入口：chunk 事件归一化、协作取消、请求世代号 |
| R23 | `src/inference/pipeline/index.js:1156-1193` | 摘录 | 管线：整段缓存命中时按 2s 重放为 chunk |
| R24 | `src/inference/pipeline/index.js:2436-2572` | 摘录 | 管线：vocoder 包装（mel 后处理偏移、段级 vocoder） |
| R25 | `src/inference/pipeline/index.js:3080-3250` | 摘录 | 管线：多 segment 的段级合成（内部 onChunkAudio=null） |
| R26 | `src/inference/pipeline/index.js:3252-3392` | 摘录 | 管线：多 segment 流式发射器（按时间序门控 + 静音补洞） |
| R27 | `src/inference/pipeline/index.js:3544-3563` | 摘录 | 管线：synthesize 串行入口 |
| R28 | `src/inference/pipeline/index.js:4366-5187` | 完整函数 | 管线：_synthesizeImpl 全量（缓存 → 分段 → 分块流式 → 混合） |
| R29 | `src/inference/pipeline/index.js:739-781` | 摘录 | 管线：非人声区静音（流式 chunk 同样应用） |
| R30 | `src/inference/pipeline/diffusion.js:1279-1631` | 摘录 | 扩散分块：规划、单块推理、循环与 committed 帧 |
| R31 | `src/inference/pipeline/postprocessing.js:40-105` | 摘录 | vocoder 流式推送增益：整条流共享系数 |
| R32 | `src/inference/pipeline/postprocessing.js:1153-1172` | 摘录 | vocoder 输入 mel 有限性守卫 |
| R33 | `src/inference/pipeline/postprocessing.js:1274-1813` | 完整函数 | vocoder 分块：WSOLA 交叉淡化、committed chunk 推送 |
| R34 | `src/inference/pipeline/wsola.js:1-265` | 完整文件 | WSOLA：时域与 mel 域对齐 + Hann OLA |
| R35 | `src/inference/pipeline/audioSegmentation.js:1-30` | 摘录 | 分段常量 |
| R36 | `src/inference/pipeline/audioSegmentation.js:96-176` | 摘录 | 长休止 region 切分（多分片流式用；分片编辑器单分片路径不直接用） |
| R37 | `src/inference/pipeline/audioSegmentation.js:178-336` | 摘录 | 人声段切分：20s 阈值 + 8~20s 段 + 2s overlap |
| R38 | `src/inference/shared/constants.js:13-29` | 摘录 | 共享维度常量（采样率 / hop / mel / vocoder 分块） |
| R39 | `src/inference/pipeline/constants.js:22-33` | 摘录 | pipeline 分段/帧上限常量 |

## 4. 代码

### R1 · 编辑器推理初始化与预览/导出参数装配

文件：`src/fragmentEditor/pipeline.js`　行：`1-210`

````javascript
import {
  setSampleRate,
  getPipelineInitialized, setPipelineInitialized,
  getPipelineInitPromise, setPipelineInitPromise,
  getFragmentAudioSettings,
  getCurrentFragment, getTrackBackend,
} from './state.js';
import { needsBuiltinForFragment } from '../shared/pipelineDecision.js';
import { resolveQDriftDefault } from '../inference/pipeline/qdrift/defaults.js';
import { showConfirmDialog } from '../alertDialog.js';
import { t } from '../i18n/index.js';

// 只提示一次：用户点"取消"之后每次切分片都再弹一遍是很糟的体验，
// 但重启窗口/应用后应该能再提示（模块级变量随窗口重建而重置）。
let _modelMissingNotified = false;

// 加载遮罩上的等待时长。10 秒后再补一句预期范围，避免用户以为卡死。
// 主进程会推 svs:loadProgress（stage/percent/current/total），有事件时以进度条为准，
// 没有时（旧后端 / 无进度实现）仍靠秒数兜底。
let _loadingTicker = null;
function stopLoadingTicker() {
  if (_loadingTicker) {
    clearInterval(_loadingTicker);
    _loadingTicker = null;
  }
}

let _loadingProgressCleanup = null;
let _loadingDetached = false; // 用户点了"先在后台加载"

function setStatusModelText(text, busy = false) {
  const el = document.getElementById('status-model-text');
  if (el) el.textContent = text;
  // 加载中亮强调色指示灯，就绪后回落到默认色（否则"Ready"也顶着一颗高亮灯）
  const led = document.getElementById('status-model-led');
  if (led) led.classList.toggle('led-accent', busy === true);
}

function describeStage(payload) {
  const stage = String(payload.stage || 'model');
  if (stage === 'hardware') return t('fragment.loadStageHardware');
  if (stage === 'resolve') return t('fragment.loadStageResolve');
  const current = Number(payload.current) || 0;
  const total = Number(payload.total) || 0;
  if (total > 0) return t('fragment.loadStageModel', { current, total });
  return t('fragment.loadStageModelBare');
}

function renderLoadProgress(payload) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(payload.percent) || 0)));
  const stageText = describeStage(payload);
  // 状态栏：即使遮罩被收进后台，进度也要一直看得见
  setStatusModelText(`${stageText} · ${percent}%`, true);

  const box = document.getElementById('model-loading-progress');
  const fill = document.getElementById('model-loading-progress-fill');
  const meta = document.getElementById('model-loading-progress-meta');
  if (box) box.hidden = false;
  if (fill) fill.style.width = `${percent}%`;
  if (meta) meta.textContent = `${stageText} · ${percent}%`;
}

function startLoadingTicker() {
  const el = document.getElementById('model-loading-elapsed');
  if (!el) return;
  const startedAt = Date.now();
  const render = () => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    el.textContent = seconds >= 10
      ? t('fragment.loadingElapsedLong', { seconds })
      : t('fragment.loadingElapsed', { seconds });
  };
  render();
  _loadingTicker = setInterval(render, 1000);
}

function bindLoadProgress(overlay) {
  if (!window.electronAPI?.onSVSLoadProgress) return;
  try {
    _loadingProgressCleanup = window.electronAPI.onSVSLoadProgress(renderLoadProgress);
  } catch (err) {
    console.warn('[FragmentEditor] Failed to subscribe to load progress:', err);
  }

  const btn = document.getElementById('btn-loading-background');
  if (btn) {
    btn.addEventListener('click', () => {
      // 没有真正的中止通道（主进程 init 不支持 cancel），所以不做假的"取消"：
      // 收起遮罩让用户先编辑音符，进度改到状态栏继续显示，加载本身不受影响。
      _loadingDetached = true;
      if (overlay) overlay.classList.remove('visible');
      stopLoadingTicker();
      setStatusModelText(t('fragment.loadBackgroundRunning'), true);
    });
  }
}

function unbindLoadProgress() {
  if (typeof _loadingProgressCleanup === 'function') {
    try { _loadingProgressCleanup(); } catch (_) {}
  }
  _loadingProgressCleanup = null;
}

/**
 * 模型缺失的可操作出口。
 *
 * 这里刻意**不**依赖错误里的路径：IPC 边界会把绝对路径替换成 `<path>`
 * （`src/main/ipcSafe.js`），拿它拼文案只会拼出一句没用的 "Model file does not
 * exist: <path>"。改成一句人话 + 一个按钮。
 */
async function notifyModelMissing() {
  try {
    const openDownload = await showConfirmDialog(
      t('fragmentEditor.modelMissingPrompt'),
      { okText: t('fragmentEditor.openModelDownload'), danger: false },
    );
    if (openDownload && window.electronAPI?.modelDownloadOpen) {
      await window.electronAPI.modelDownloadOpen();
    }
  } catch (err) {
    // 对话框本身失败不能盖掉原始错误（那是用户真正需要排障的信息）
    console.warn('[FragmentEditor] Failed to show missing-model notice:', err);
  }
}

export function initPipeline() {
  if (getPipelineInitialized()) return Promise.resolve();
  if (getPipelineInitPromise()) return getPipelineInitPromise();

  // 插件后端轨道不需要内置 ONNX 模型。短路必须早于加载遮罩与
  // getFragmentSVSSampleRate()，否则会连带推"加载模型"进度条、甚至因缺模型
  // 弹下载框。编辑器内三处"未初始化就 initPipeline()"的调用点因此自动不加载。
  if (!needsBuiltinForFragment(getCurrentFragment(), getTrackBackend())) {
    return Promise.resolve();
  }

  const overlay = document.getElementById('model-loading-overlay');
  if (overlay) {
    _loadingDetached = false;
    overlay.classList.add('visible');
    startLoadingTicker();
    bindLoadProgress(overlay);
  }

  const promise = (async () => {
    try {
      setSampleRate(await window.electronAPI.getFragmentSVSSampleRate());
      await window.electronAPI.initFragmentSVSPipeline();
      setPipelineInitialized(true);
      // 加载完成后状态栏回到 Ready，避免一直停在上次的"加载模型 99%"
      setStatusModelText(t('fragment.statusReady'));
      console.log('[FragmentEditor] SVS Pipeline initialized');
    } catch (err) {
      console.error('[FragmentEditor] SVS Pipeline init failed:', err);
      setPipelineInitPromise(null);
      setStatusModelText(t('fragment.loadFailed'), false);
      // 缺模型是可预期状态（首次安装、切了精度、删了目录），不是"程序坏了"。
      // ENOENT 也一并接住：某些路径下 stat 直接抛，消息里没有那句模板文案。
      const msg = String((err && err.message) || '');
      if (!_modelMissingNotified && /Model file does not exist|ENOENT/i.test(msg)) {
        _modelMissingNotified = true;
        notifyModelMissing();
      }
      throw err;
    } finally {
      stopLoadingTicker();
      unbindLoadProgress();
      if (overlay && !_loadingDetached) overlay.classList.remove('visible');
    }
  })();

  setPipelineInitPromise(promise);
  return promise;
}

export function getFragmentPreviewInferenceOptions() {
  const settings = getFragmentAudioSettings();
  return {
    // 模型精度必须随 options 下发：主进程缓存键把精度折进 `pm` 段，缺省为
    // 'base'。主窗口传的是 'fp32'/'fp16'/'int8' —— 分片编辑器不传时两边键
    // 永不相等，同一分片的"全局缓存"一次也用不上（每次播放都整段重推）。
    modelPrecision: settings?.modelPrecision || 'fp32',
    nSteps: settings?.previewDiffSteps ?? 32,
    cfg: settings?.previewCfgStrength ?? 3.0,
    cfgRescale: settings?.previewCfgRescale ?? 0.75,
    // 兜底采样器与主窗口/管线默认值（samplers/index.js DEFAULT_SOLVER）保持一致。
    sampler: settings?.previewSampler ?? 'euler',
    qdrift: resolveQDriftDefault(settings, 'previewEnableQDrift'),
    npuDiffBatchSize: 1,
    npuVocoderBatchSize: 1,
    diffStepChunk: settings?.previewDiffStepChunkEnabled === true,
    diffStepChunkFrames: settings?.previewDiffStepChunkFrames ?? 500,
    diffStepOverlapFrames: settings?.previewDiffStepOverlapFrames ?? 50,
  };
}

export function getFragmentExportInferenceOptions() {
  const settings = getFragmentAudioSettings();
  return {
    modelPrecision: settings?.modelPrecision || 'fp32',
    nSteps: settings?.exportDiffSteps ?? 32,
    cfg: settings?.exportCfgStrength ?? 3.0,
    cfgRescale: settings?.exportCfgRescale ?? 0.75,
    sampler: settings?.exportSampler ?? 'euler',
    qdrift: resolveQDriftDefault(settings, 'exportEnableQDrift'),
    npuDiffBatchSize: 1,
    npuVocoderBatchSize: 1,
  };
}
````

### R2 · 合成编排：签名、流式订阅、播放入口、后台推理、取消

文件：`src/fragmentEditor/audioPlayback.js`　行：`1-592`

````javascript
// B2: wavEncoder.js is now CommonJS — use require instead of ESM import.
const { encodeWav, applyEnvelopesToAudio } = require('../audio/wavEncoder.js');
import safeCallModule from '../shared/safeCall.js';

const { safeCleanup } = safeCallModule;
import { showAlertDialog } from '../alertDialog.js';
import { t } from '../i18n/index.js';
import { setLabel } from '../icons/iconHelper.js';
import { initPipeline, getFragmentPreviewInferenceOptions, getFragmentExportInferenceOptions } from './pipeline.js';
import {
  getSampleRate,
  getFragmentAudioData, setFragmentAudioData,
  getFragmentIsPlaying,
  getFragmentIsSynthesizing,
  beginFragmentSynthesis, finishFragmentSynthesis,
  getFragmentSynthesisId, waitForFragmentPlayheadDragEnd,
  getFragmentIsAutoInferring, setFragmentIsAutoInferring,
  getFragmentIsExporting, setFragmentIsExporting,
  getFragmentCurrentTime, setFragmentCurrentTime,
  getFragmentUseExclusiveMode,
  getFragmentAudioSettings,
  getFragmentPlayStartPosition, setFragmentPlayStartPosition,
  getFragmentAudioDataSignature, setFragmentAudioDataSignature,
  getPipelineInitialized,
  getWavFileBuffer,
  getSingerAnnotation,
  getCurrentProject,
  getCurrentFragment,
  getEnvelopes,
  getTrackBackend,
} from './state.js';
import { getClippedNotes, buildPitchCurveF0Data, isScorePitchMode, render, resetPlayheadFollow } from './canvasRenderer.js';
import { firstNoteStart } from '../shared/activeNotes.js';
// 哈希算法与主进程合成缓存键、主窗口播放签名共用一份（src/shared/hashSignature.js）。
import { hashNumberArray, hashString } from '../shared/hashSignature.js';
import { computePromptCondSignature } from '../shared/promptCondSignature.js';
import { buildMelPostprocessPayload, serializePostprocessForSignature } from './postprocessAccess.js';
import { updateFragmentPlayButton } from './uiControls.js';
// 播放侧的全部状态与行为都在 playbackSession.js（会话独占）。本文件只负责
// 合成编排：缓存签名、IPC 调用、结果落地、导出、后台推理。
import {
  createSession, getCurrentSession, stopPlayback, playheadTick,
  getFragmentAudioContextInternal, loadFragmentAudioSettings,
} from './playbackSession.js';

export { getFragmentAudioContextInternal, loadFragmentAudioSettings, getCurrentSession };
/** 兼容旧调用名：播放头循环现在由会话驱动。 */
export const updateFragmentPlayhead = playheadTick;

// 每次合成一个独立 streamId：chunk / 结束屏障 / cancel 全链路带上它，
// 旧请求的迟到数据就不会被新会话当成自己的音频（IPC channel 是全局共享的）。
let _fragmentStreamSeq = 0;
function nextFragmentStreamId() {
  _fragmentStreamSeq += 1;
  return `frag-${Date.now().toString(36)}-${_fragmentStreamSeq}`;
}

/**
 * 把当前分片的后端声明挂到合成 options 上（options.backend）。
 *
 * 约定见 src/main/svsIpc.js 的 _resolvePluginBackend()：只要 options.backend.type
 * === 'plugin'，主进程就把这一个 options 引用整体交给插件，不再走内置 pipeline。
 *
 * 两条纪律（与 src/renderer/audioPlayback.js 的 attachPluginBackend 保持一致）：
 *   · 内置后端不留痕：{type:'sxs'} 时压根不写 backend 字段，内置链路零差异。
 *   · 其余参数一个都不删：需求要求"给模型的参数都要能传给插件"，这里只追加。
 */
function attachPluginBackend(options) {
  if (!options) return options;
  const backend = getTrackBackend();
  if (backend && backend.type === 'plugin') {
    // 浅拷贝：主进程把同一个 options 引用交给插件，插件改写不能透回
    // 模块级的 trackBackend（那是工程数据）。
    options.backend = { ...backend };
  }
  return options;
}

/**
 * 构建导出用的 per-note 渐入/渐出列表（与 wavEncoder.applyEnvelopesToAudio 对接）。
 * 时间单位：start/duration 用 beats，fadeIn/fadeOut 用秒。
 */
function _buildNoteFadesForExport() {
  const notes = getClippedNotes();
  const out = [];
  for (const n of notes) {
    const fadeInSec = (n.fadeIn && n.fadeIn > 0) ? n.fadeIn / 1000 : 0;
    const fadeOutSec = (n.fadeOut && n.fadeOut > 0) ? n.fadeOut / 1000 : 0;
    if (fadeInSec <= 0 && fadeOutSec <= 0) continue;
    out.push({ startBeat: n.start, durationBeats: n.duration, fadeInSec, fadeOutSec });
  }
  return out;
}

export function stopFragmentPlayback() {
  stopPlayback();
}

/**
 * 取消正在进行的推理（与主页面 stopPlayback 的"合成中取消"语义一致）。
 *
 * 分片编辑器此前只停本地音频、从不通知主进程：用户点停止后 GPU 仍会把整段
 * 推理跑完（长分片几十秒），期间按钮停在"合成中"且不可点，下一次播放被
 * `isSynthesizing` 的守卫静默挡住 —— 也就是"停止停不掉推理"。
 *
 * @returns {boolean} 是否确实取消了在途推理
 */
export function cancelFragmentSynthesis() {
  if (!getFragmentIsSynthesizing()) return false;
  // 模型加载阶段不能发 cancel：主进程会落到"无活跃任务 → resetSvsPipeline()"，
  // 把正在初始化的 lazy 实例作废，下次播放要重新加载（与主页面同一守卫）。
  const sess = getCurrentSession();
  if (getPipelineInitialized() && window.electronAPI?.cancelSVSSynthesis) {
    // 带 streamId：主进程若已在跑新一轮，会忽略这次迟到的取消。
    window.electronAPI.cancelSVSSynthesis(sess?.streamId ? { streamId: sess.streamId } : undefined).catch(() => {});
  }
  // 立即放开重入锁：否则 IDLE 下按钮可点、playFragment 的 guard 却静默 return，
  // 用户看到的是"点了没反应"。旧会话会在最近的检查点（sess.isCurrent）退出。
  // 只有当前 token 的拥有者才允许清合成状态；旧任务迟到结束时不能误清新任务。
  finishFragmentSynthesis(getFragmentSynthesisId());
  // dispose 会话 → 在途 chunk / 收尾 / 兜底播放全部作废
  stopPlayback();
  updateFragmentPlayButton();
  return true;
}

/**
 * 播放中拖拽 playhead 时跳转到新位置。
 * 不重新合成：直接复用已缓存的 fragmentAudioData，从 newStartTime 开始播放。
 */
export async function seekFragmentPlayback(newStartTime) {
  // 用户刚拖动过播放头 = 一次明确的"人在这里"，视口应当跟上（不受 3s 门控）
  resetPlayheadFollow({ reveal: true });

  // 合成进行中的拖拽：不能用旧缓存音频重启播放（与新音符不匹配，且会与合成
  // 完成后的兜底播放叠加成双路音频）。只停掉当前出声并记住新位置，合成完成后
  // 由 playFragment 从该位置整段播放新音频。
  const cur = getCurrentSession();
  if (getFragmentIsSynthesizing()) {
    if (cur && !cur.disposed && cur.kind === 'stream') {
      cur.requestSeekDuringSynthesis(newStartTime);
    } else {
      // 状态不变量已损坏：全局在合成但 owner session 丢失。此时绝不能回落
      // 到可能过期的 fragmentAudioData 播放，否则会播旧版本并与迟到结果叠音。
      setFragmentPlayStartPosition(newStartTime);
      setFragmentCurrentTime(newStartTime);
      cancelFragmentSynthesis();
      render();
    }
    return;
  }

  setFragmentPlayStartPosition(newStartTime);
  const audioData = getFragmentAudioData();
  if (!audioData || audioData.length === 0) {
    // 无可播音频：不能静默返回 —— 播放状态已停但视觉未更新，用户会以为点击无效。
    stopPlayback();
    setFragmentCurrentTime(newStartTime);
    render();
    updateFragmentPlayButton();
    return;
  }

  const exclusive = getFragmentAudioSettings()?.audioOutputMode === 'exclusive';
  const sess = createSession(exclusive ? 'exclusive' : 'full');
  if (exclusive) await sess.playExclusive(audioData);
  else await sess.playFullBuffer(audioData);
}

function padAudioToFragmentDuration(audioData) {
  const fragment = getCurrentFragment();
  if (!fragment || !fragment.duration || !audioData || audioData.length === 0) return audioData;
  const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
  const expectedSamples = Math.ceil((fragment.duration / bpm) * 60 * getSampleRate());
  // synthesizeFragmentSVS 返回的 audioData[0] 对应 filledNotes[0].start（首音符起点
  // 相对 fragment），而非 fragment 起点。前置 firstNoteOffsetSample 个零样本使
  // paddedAudio[0] 对齐到 fragment 起点，这样下游 startOffset / currentTime 都以
  // fragment 起点为参考，与 canvas 中 note.start 的 beat 坐标一致。
  const clippedNotes = getClippedNotes();
  const firstNoteOffsetSample = clippedNotes.length > 0
    ? Math.floor((firstNoteStart(clippedNotes) / bpm) * 60 * getSampleRate())
    : 0;
  const requiredLength = Math.max(expectedSamples, firstNoteOffsetSample + audioData.length);
  if (requiredLength <= audioData.length && firstNoteOffsetSample === 0) return audioData;
  const padded = new Float32Array(requiredLength);
  padded.set(audioData, firstNoteOffsetSample);
  return padded;
}

/**
 * 与服务端 AudioSegmentation.hashArray 语义一致的 FNV-1a 32-bit 哈希。
 * 算法本体在 src/shared/hashSignature.js，三处消费方调同一个函数。
 */
function _hashArrayFNV(arr) {
  return hashNumberArray(arr);
}

/**
 * 下发给管线的音高来源。
 * score 时 pitchCurveF0 已经是 null，这里再带一个显式标记 —— 否则管线分不清
 * "没有曲线"和"要 score"，会把 note.pitch 填成逐音符恒定的平直 F0。
 */
function currentPitchControl() {
  return isScorePitchMode() ? 'score' : 'manual';
}

/**
 * 计算当前 fragment 合成输入的签名（notes + 选项）。
 * 与服务端 computeSynthCacheKey 覆盖的字段一致。
 * 注意：签名不包含 playStartPosition — 起始位置变化不影响音频内容。
 */
export function computeFragmentAudioSignature() {
  const notes = getClippedNotes();
  const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
  const previewOpts = getFragmentPreviewInferenceOptions();
  // 签名只需要"输入变了"的哈希：F0 后处理链的结果已由下方 ppHash 单独覆盖，
  // 这里跳过整条滤波（400ms 自动推理轮询会反复调用本函数）。
  const pitchCurveF0 = buildPitchCurveF0Data({ postprocess: false });
  const refAudioWavBuffer = getWavFileBuffer();
  const autoShiftEl = document.getElementById('autoShiftCheck');
  const autoShift = autoShiftEl ? autoShiftEl.checked : false;
  const singerId = getCurrentFragment()?.singerId || null;

  // notes hash — 与服务端 computeSynthCacheKey 保持一致的字段拼接
  // （含 noteType：3=连音。MIDI 导入的连音音符只带 noteType、没有 isSlur 标志。）
  let notesHash = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    let s = `${n.lyric || ''}|${n.pitch}|${n.start}|${n.duration}|${n.isSlur ? 1 : 0}|${n.isContinuation ? 1 : 0}|t${n.noteType || 0}`;
    if (n.phonemeAdjustments) {
      for (const adj of n.phonemeAdjustments) {
        s += `|dr:${adj.durationRatio}|or:${adj.offsetRatio || 0}`;
        if (adj.volumePoints) {
          for (const vp of adj.volumePoints) s += `:${vp.t}:${vp.v}`;
        }
      }
    }
    if (n.vibrato && n.vibrato.enabled) {
      s += `|vib:${n.vibrato.enabled ? 1 : 0}:${n.vibrato.depth}:${n.vibrato.rate}:${n.vibrato.start}:${n.vibrato.length}:${n.vibrato.fadeIn}`;
    }
    for (let j = 0; j < s.length; j++) {
      notesHash = ((notesHash << 5) - notesHash + s.charCodeAt(j)) | 0;
    }
  }

  const f0Hash = pitchCurveF0 ? _hashArrayFNV(pitchCurveF0) : 0;

  // 音色 / 后处理曲线 hash：频谱后处理不改变 F0，必须单独进签名。
  let ppHash = 0;
  const ppSignature = serializePostprocessForSignature();
  for (let i = 0; i < ppSignature.length; i++) {
    ppHash = ((ppHash << 5) - ppHash + ppSignature.charCodeAt(i)) | 0;
  }

  // refAudioWavBuffer hash — FNV-1a 全量采样 + 长度折叠，与服务端一致。
  let refHash = 0;
  if (refAudioWavBuffer) {
    const refBytes = refAudioWavBuffer instanceof ArrayBuffer
      ? new Uint8Array(refAudioWavBuffer)
      : refAudioWavBuffer;
    refHash = _hashArrayFNV(refBytes);
  }

  const singerAnn = getSingerAnnotation() || {};
  const promptHash = hashString(computePromptCondSignature(
    singerAnn.singerData,
    singerAnn.midiNotes,
    singerAnn.f0Data,
    undefined
  ));

  // 音高来源也必须进签名：manual 空曲线与 score 都产出 pitchCurveF0=null。
  const pitchControl = currentPitchControl();
  // 与主进程 computeSynthCacheKey 的字段集保持一致：采样器 / Q-Drift / 精度 /
  // CFG 曲线 / 动态阈值都会改变输出，漏进签名就会"改了设置却播旧音频"。
  const schedSig = `${previewOpts.cfgScheduleMode || 'constant'}:${previewOpts.cfgStrengthStart ?? ''}:${JSON.stringify(previewOpts.cfgScheduleKeyframes || null)}`;
  const dynSig = previewOpts.dynamicThresholdEnabled ? `1:${previewOpts.dynamicThresholdPercentile}` : '0';
  return `${notesHash}_${bpm}_${f0Hash}_${refHash}_p${promptHash}_${previewOpts.nSteps}_${previewOpts.cfg}_${previewOpts.cfgRescale}_${autoShift}_${singerId || 'noid'}_${previewOpts.diffStepChunk ? 1 : 0}_${previewOpts.diffStepChunkFrames || 500}_${previewOpts.diffStepOverlapFrames !== undefined ? previewOpts.diffStepOverlapFrames : 50}_pp${ppHash}_${pitchControl}_sm${previewOpts.sampler || 'euler'}_qd${previewOpts.qdrift ? 1 : 0}_pm${previewOpts.modelPrecision || 'fp32'}_cs${schedSig}_dt${dynSig}`;
}

/** 合成 options 的公共部分（预览 / 后台推理共用，避免两处字段漂移）。 */
function buildPreviewOptions(previewOpts, extra) {
  return attachPluginBackend({
    f0Envelope: null,
    pitchCurveF0: buildPitchCurveF0Data() || null,
    pitchControl: currentPitchControl(),
    refAudioWavBuffer: getWavFileBuffer() || null,
    refSingerData: (getSingerAnnotation() || {}).singerData || null,
    refMidiNotes: (getSingerAnnotation() || {}).midiNotes || null,
    refF0Data: (getSingerAnnotation() || {}).f0Data || null,
    singerId: getCurrentFragment()?.singerId || null,
    autoShift: document.getElementById('autoShiftCheck').checked,
    nSteps: previewOpts.nSteps,
    cfg: previewOpts.cfg,
    cfgRescale: previewOpts.cfgRescale,
    // 采样器 / Q-Drift / 精度：必须与主窗口同口径下发。它们既改变输出，
    // 也进主进程缓存键 —— 漏传会让两条路径各推一份且缓存互不命中。
    sampler: previewOpts.sampler,
    qdrift: previewOpts.qdrift,
    modelPrecision: previewOpts.modelPrecision,
    diffStepChunk: previewOpts.diffStepChunk,
    diffStepChunkFrames: previewOpts.diffStepChunkFrames,
    diffStepOverlapFrames: previewOpts.diffStepOverlapFrames,
    cfgScheduleMode: previewOpts.cfgScheduleMode,
    cfgStrengthStart: previewOpts.cfgStrengthStart,
    cfgScheduleKeyframes: previewOpts.cfgScheduleKeyframes,
    dynamicThresholdEnabled: previewOpts.dynamicThresholdEnabled,
    dynamicThresholdPercentile: previewOpts.dynamicThresholdPercentile,
    melPostprocess: buildMelPostprocessPayload(
      getClippedNotes(),
      getCurrentProject() ? getCurrentProject().bpm : 120,
      getSampleRate(),
      480,
    ),
    ...extra,
  });
}

/** 按当前输出设置整段播放（缓存命中 / 流式未启动的兜底 / seek 后续播）。 */
async function playWholeBuffer(sess, audioData) {
  const exclusive = getFragmentAudioSettings()?.audioOutputMode === 'exclusive';
  if (exclusive) await sess.playExclusive(audioData);
  else await sess.playFullBuffer(audioData);
}

export async function playFragment() {
  // 重入保护：防止连续调用导致前一次 finally 提前把 fragmentIsSynthesizing
  // 置 false，使后续进度回调失效。
  if (getFragmentIsSynthesizing() || getFragmentIsExporting()) return;
  // 新一轮播放：清掉上一次会话残留的分页动画；若播放头在视口外，第一帧就回填。
  resetPlayheadFollow({ reveal: true });

  // 作废旧会话并开新一轮。会话号即身份：所有异步续体据此判断自己是否过期。
  const sess = createSession('stream');
  sess.streamId = nextFragmentStreamId();
  sess.beginStreaming();
  const startAudio = getFragmentAudioData();
  console.log('[FragPlay] playFragment begin ' + JSON.stringify({
    session: sess.id,
    streamId: sess.streamId,
    playFromSec: sess.startPositionSec,
    hasCachedAudio: !!(startAudio && startAudio.length > 0),
    cachedAudioLength: startAudio ? startAudio.length : 0,
    hasCachedSignature: getFragmentAudioDataSignature() !== null,
  }));
  // 合成状态属于 token，不属于 session：session 被 seek/stop dispose 后，
  // 这个 Promise 仍要在结束时释放自己设置的状态（token 不匹配的新任务除外）。
  beginFragmentSynthesis(sess.streamId);
  updateFragmentPlayButton();

  try {
    if (!getPipelineInitialized()) await initPipeline();
    await loadFragmentAudioSettings();
    if (!sess.isCurrent) return;

    // 缓存优化：签名相同且已有音频 → 直接整段播放，跳过 IPC 合成。
    const currentSignature = computeFragmentAudioSignature();
    const cachedAudio = getFragmentAudioData();
    if (cachedAudio && cachedAudio.length > 0 && getFragmentAudioDataSignature() === currentSignature) {
      await playWholeBuffer(sess, cachedAudio);
      return;
    }

    // chunk 监听归会话所有：直到会话 dispose 才摘除。
    // 旧实现在 invoke 回执后立刻摘监听，而 chunk 与回执走不同 IPC 通道，
    // 仍在队列里的块被永久丢弃 → "前面有声音、后面整段静音"。
    sess.chunkCleanup = window.electronAPI.onFragmentSVSChunkAudio((chunkInfo) => {
      sess.pushChunk(chunkInfo);
    });
    // 结束屏障与 chunk 共用同一条串行队列：END 入队后，drain() 返回即证明
    // lastSeq 之前的所有块都已处理完，才允许把 scheduler 置为 inferenceDone。
    sess.endCleanup = window.electronAPI.onFragmentSVSStreamEnd?.((info) => {
      sess.noteStreamEnd(info);
    }) || null;

    const previewOpts = getFragmentPreviewInferenceOptions();
    const audioData = await window.electronAPI.synthesizeFragmentSVS({
      notes: getClippedNotes(),
      bpm: getCurrentProject() ? getCurrentProject().bpm : 120,
      options: buildPreviewOptions(previewOpts, { streamId: sess.streamId }),
    });
    // 会话已被取消/取代（用户点了停止 / 又开了新一轮）：结果作废。
    if (!sess.isCurrent) return;

    // 推理期间用户改了音符 / 音高曲线 / 音色：这份音频属于**旧输入**。
    // 无条件写签名会把旧音频标成"当前内容"的缓存，之后每次播放都命中它。
    if (computeFragmentAudioSignature() !== currentSignature) {
      console.warn('[FragmentAudio] Inputs changed during synthesis — discarding result');
      setFragmentAudioDataSignature(null);
      // 不能只丢缓存：此时旧输入的 chunk 可能已经在播、甚至有 future source
      // 已排程。必须先停掉本会话的旧音频，否则用户编辑后会继续听到旧音符。
      sess.stopStreamAudio();
      await sess.setInferenceDone();
      return;
    }

    const padded = padAudioToFragmentDuration(audioData);
    setFragmentAudioData(padded);
    setFragmentAudioDataSignature(currentSignature);
    console.log(`[FragPlay] INFERENCE RETURNED | session=${sess.id} streamingStarted=${sess.streamStarted} pendingSeek=${sess.pendingSeek !== null} t=${Date.now()}`);

    // 结束屏障优先：END 在 invoke 回执之前由主进程发出，处理完它的队列项
    // 才证明"最后一块已交付"。不支持 END 的路径（插件 / 老主进程 / 测试桩）
    // 退化为原来的回执语义，但不再把它当作普遍正确的排序保证。
    if (!sess.endSeen) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sess.markLegacyDelivery();
    }
    await sess.drain();
    if (!sess.isCurrent) return;

    // 只有确认交付完成后才标记推理完成：过早置位会让 checkUnderrun 直接
    // 返回 false，尾段 chunk 未到时 source 播完 → 播放头冲进静音区、提前收尾。
    await sess.setInferenceDone();
    if (!sess.isCurrent) return;
    // 交付确认到位后再给收尾判据一次机会（isLast 可能早于 END 到达）。
    sess._maybeFinish();

    // 合成期间用户拖拽了播放头：从新位置整段播放新音频。
    if (sess.pendingSeek !== null) {
      // 若合成恰好在拖拽过程中完成，先等最终位置落定，避免从 mousedown
      // 的旧位置抢先起播（慢速拖动/长按时尤其明显）。
      await waitForFragmentPlayheadDragEnd();
      if (!sess.isCurrent) return;
      const pos = sess.pendingSeek;
      sess.pendingSeek = null;
      sess.startPositionSec = pos;
      setFragmentPlayStartPosition(pos);
      await playWholeBuffer(sess, padded);
      return;
    }

    // 流式从未启动（插件后端 / 单块未触发回调 / 全部块都在起播点之前）：整段兜底。
    // 判据只看当前会话自己的状态 —— 全局 isPlaying 可能被别的播放模式/上一轮
    // 残留占用，拿它当唯一条件会让整段兜底被跳过 → 完全静音。
    if (!sess.streamStarted && sess.isCurrent && !sess.userStopped
        && sess.pendingSeek === null && !sess.hasStartedSources()) {
      await playWholeBuffer(sess, padded);
    }
  } catch (error) {
    if (!sess.isCurrent) return;
    const msg = String((error && error.message) || '');
    // 协作式取消（SYNTHESIS_CANCELLED / 被新请求取代）不是错误。
    if (/cancel|superseded|abort/i.test(msg)) {
      console.log('[FragmentAudio] Synthesis cancelled');
    } else {
      console.error(t('fragment.synthesisFailed') + ':', error);
      showAlertDialog(t('fragment.synthesisFailedDetail', { detail: error.message }));
    }
    stopPlayback();
    setFragmentCurrentTime(0);
    updateFragmentPlayButton();
  } finally {
    // 合成状态按任务 token 释放，而不是按 sess.isCurrent：
    // seek 期间 session 可能被停音频/dispose，但本任务仍需释放自己设置的
    // synthesizing 标志；若新任务已接管则 token 不匹配，不能误清。
    if (finishFragmentSynthesis(sess.streamId)) {
      updateFragmentPlayButton();
    }
  }
}

/**
 * 后台静默合成：只重算音频并写入 fragmentAudioData，不播放、不弹错误对话框。
 * 供"编辑后自动实时推理"（设置项 autoRealtimeInference）使用。
 *
 * 与已有分段缓存的协同：主进程多 segment 路径按 segment 计算缓存键，未改动的
 * segment 直接命中、跳过 diffusion+vocoder。因此这里刻意不清缓存。
 *
 * @param {{priorityTimeSec?: number}} [opts]
 * @returns {Promise<'ok'|'skip'|'error'>}
 */
export async function synthesizeFragmentInBackground(opts = {}) {
  if (getFragmentIsPlaying() || getFragmentIsSynthesizing() || getFragmentIsExporting()) return 'skip';
  if (getFragmentIsAutoInferring()) return 'skip';

  const notes = getClippedNotes();
  if (!notes || notes.length === 0) return 'skip';
  // 只有已经合成过（存在旧预览音频）时"改动"才有意义。
  if (getFragmentAudioDataSignature() === null) return 'skip';

  const currentSignature = computeFragmentAudioSignature();
  if (currentSignature === getFragmentAudioDataSignature()) return 'skip';

  setFragmentIsAutoInferring(true);
  updateFragmentPlayButton();
  try {
    if (!getPipelineInitialized()) await initPipeline();
    await loadFragmentAudioSettings();

    if (getFragmentIsPlaying() || getFragmentIsSynthesizing() || getFragmentIsExporting()) return 'skip';
    if (computeFragmentAudioSignature() !== currentSignature) return 'skip';

    const previewOpts = getFragmentPreviewInferenceOptions();
    const audioData = await window.electronAPI.synthesizeFragmentSVS({
      notes,
      bpm: getCurrentProject() ? getCurrentProject().bpm : 120,
      options: buildPreviewOptions(previewOpts, {
        // 后台推理：主进程不下发流式 chunk，避免无意义的分片间 IPC 拷贝。
        background: true,
        priorityTimeSec: Number.isFinite(opts.priorityTimeSec) ? opts.priorityTimeSec : 0,
      }),
    });

    if (computeFragmentAudioSignature() !== currentSignature) return 'skip';
    if (getFragmentIsPlaying() || getFragmentIsSynthesizing()) return 'skip';

    setFragmentAudioData(padAudioToFragmentDuration(audioData));
    setFragmentAudioDataSignature(currentSignature);
    console.log('[FragmentAudio] Background inference done (preview audio refreshed)');
    return 'ok';
  } catch (error) {
    // 取消/被取代不算推理失败（归为 'error' 会误触发 15 秒冷却）。
    const code = (error && error.code) || '';
    const msg = (error && error.message) || '';
    const isCancelled = code === 'SVS_SUPERSEDED' || code === 'SYNTHESIS_CANCELLED'
      || /superseded|cancelled|canceled|abort/i.test(msg);
    if (isCancelled) return 'skip';
    // 远程 API 的失败必须显式提示：401/403、429、超时、网络不通都是用户能
    // 立刻处理的问题，静默吞掉会让用户以为"合成还在跑"或"没声音"。
    if (/\[API[ \]]/i.test(msg)) {
      try {
        showAlertDialog(t('fragment.synthesisFailedDetail', { detail: msg }));
      } catch (_) { /* 弹窗失败也要保留下面的 warn 日志 */ }
    }
    console.warn('[FragmentAudio] Background inference failed:', error && error.message);
    return 'error';
  } finally {
    setFragmentIsAutoInferring(false);
    updateFragmentPlayButton();
  }
}

export async function exportFragment() {
  if (getFragmentIsSynthesizing() || getFragmentIsExporting()) return;
  const btnExportFragment = document.getElementById('btn-export-fragment');
  const originalText = btnExportFragment.textContent;
  btnExportFragment.disabled = true;
  setLabel(btnExportFragment, t('fragment.exporting'), { icon: 'download' });
  setFragmentIsExporting(true);
  try {
    if (!getPipelineInitialized()) await initPipeline();
    await loadFragmentAudioSettings();

    const exportOpts = getFragmentExportInferenceOptions();
    const audioData = await window.electronAPI.synthesizeFragmentSVS({
      notes: getClippedNotes(),
      bpm: getCurrentProject() ? getCurrentProject().bpm : 120,
      options: attachPluginBackend({
        f0Envelope: null,
        pitchCurveF0: buildPitchCurveF0Data() || null,
        pitchControl: currentPitchControl(),
        refAudioWavBuffer: getWavFileBuffer() || null,
        refSingerData: (getSingerAnnotation() || {}).singerData || null,
        refMidiNotes: (getSingerAnnotation() || {}).midiNotes || null,
        refF0Data: (getSingerAnnotation() || {}).f0Data || null,
        singerId: getCurrentFragment()?.singerId || null,
        autoShift: document.getElementById('autoShiftCheck').checked,
        nSteps: exportOpts.nSteps,
        cfg: exportOpts.cfg,
        cfgRescale: exportOpts.cfgRescale,
        sampler: exportOpts.sampler,
        qdrift: exportOpts.qdrift,
        modelPrecision: exportOpts.modelPrecision,
        melPostprocess: buildMelPostprocessPayload(
          getClippedNotes(),
          getCurrentProject() ? getCurrentProject().bpm : 120,
          getSampleRate(),
          480,
        ),
      }),
    });
    const paddedAudio = padAudioToFragmentDuration(audioData);
    const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
    const envelopes = getEnvelopes();
    const noteFades = _buildNoteFadesForExport();
    const stereoData = applyEnvelopesToAudio(paddedAudio, getSampleRate(), bpm, envelopes.volume, envelopes.pan, noteFades);
    const wavData = encodeWav(stereoData, getSampleRate(), 2);
    const result = await window.electronAPI.showSaveDialog({
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    });
    if (!result.canceled && result.filePath) {
      await window.electronAPI.saveFile(result.filePath, wavData);
    }
  } catch (error) {
    console.error(t('fragment.exportFailed') + ':', error);
    showAlertDialog(t('fragment.exportFailedDetail', { detail: error.message }));
  } finally {
    setFragmentIsExporting(false);
    btnExportFragment.disabled = false;
    setLabel(btnExportFragment, originalText, { icon: 'download' });
  }
````

### R3 · 播放会话：chunk 串行队列、排程、underrun、收尾、看门狗

文件：`src/fragmentEditor/playbackSession.js`　行：`1-1258`

````javascript
/**
 * 分片编辑器播放会话 —— 播放侧**唯一状态所有者**。
 *
 * 背景：流式预览的状态曾经散在 12+ 个模块级变量里（sources / cleanup /
 * finished / fadeGain / timeline / lastChunkAt / chunkSeen / started /
 * scheduler / userStopped / pendingSeek / sessionSeq / 两个 rAF id / 两个心跳）。
 * chunk 回调、scheduler 回调、source.onended、invoke 回执、收尾兜底五条异步
 * 路径都能写它们，且没有统一的会话归属 —— 每修一处，故障就换个出口。
 *
 * 现在的纪律：
 *   1. 一次播放 = 一个 Session 对象。所有播放状态都是它的字段。
 *   2. 模块级只有 `_current`。任何异步续体先判 `sess.isCurrent`，过期即静默退场。
 *   3. 播放头循环 / 看门狗按**会话实际输出方式**（stream / full / exclusive）
 *      决定位置来源与自愈路径，不看设置里的 exclusive 开关 —— 流式预览永远走
 *      WebAudio，设置是 exclusive 时旧代码会拒绝重启共享循环（最小化后卡死）。
 *   4. 收尾只有一条路：`session.finish()`，幂等 + 会话守卫。
 *   5. underrun 冻结不可能死锁：inferenceDone 之后绝不再冻结，已在等待则立即解冻。
 */

import safeCallModule from '../shared/safeCall.js';
import { t } from '../i18n/index.js';
import { setLabel } from '../icons/iconHelper.js';
import { StreamingScheduler } from '../shared/streamingScheduler.js';
import { getAudibleElapsedSec, getOutputLatencySec } from '../shared/audioOutputClock.js';
import { StreamTimeline } from './playbackTimeline.js';
import { firstNoteStart } from '../shared/activeNotes.js';
import {
  getSampleRate,
  getFragmentAudioContext, setFragmentAudioContext,
  getFragmentAudioSource, setFragmentAudioSource,
  getFragmentIsPlaying, setFragmentIsPlaying,
  getFragmentPlaybackStartTime, setFragmentPlaybackStartTime,
  setFragmentPlaybackOffset,
  getFragmentPlayheadRaf, setFragmentPlayheadRaf,
  setFragmentCurrentTime,
  getFragmentGainNode, setFragmentGainNode,
  setFragmentUseExclusiveMode,
  getFragmentExclusiveRaf, setFragmentExclusiveRaf,
  getFragmentAudioSettings, setFragmentAudioSettings,
  getFragmentPlayStartPosition, setFragmentPlayStartPosition,
  getCurrentProject,
  getEnvelopes,
} from './state.js';
import { getClippedNotes, render, tickPlayheadFollow, settlePlayheadFollow } from './canvasRenderer.js';
import { updateFragmentPlayButton } from './uiControls.js';

const { safeCleanup } = safeCallModule;

// ==================== 模块级：当前会话 + 播放头循环 ====================

let _current = null;
let _sessionSeq = 0;

/** 独占输出的 UI 会话号（主进程按它丢弃过期的 play/stop）。 */
let _exclusiveToken = 0;

export function getCurrentSession() { return _current; }

function _nextExclusiveToken() { _exclusiveToken += 1; return _exclusiveToken; }

// 播放头循环活性探针：rAF id 非空 ≠ 回调还会跑（最小化时 Chromium 丢弃已排队
// 的回调且恢复后不补发）。只有"最近真的跑过"才算活着。
const LOOP_STALL_MS = 700;
const WATCHDOG_INTERVAL_MS = 400;
let _lastTickAt = 0;
let _watchdogTimer = null;
let _lastWatchdogTickAt = 0;
let _visibilityBound = false;
let _ctxResumeInFlight = false;

function _cancelLoop() {
  const raf = getFragmentPlayheadRaf();
  if (raf) { cancelAnimationFrame(raf); setFragmentPlayheadRaf(null); }
  const xraf = getFragmentExclusiveRaf();
  if (xraf) { cancelAnimationFrame(xraf); setFragmentExclusiveRaf(null); }
  _lastTickAt = 0;
}

function _loopAlive(now) {
  return _lastTickAt > 0 && (now - _lastTickAt) < LOOP_STALL_MS;
}

/** 循环停摆时重启（隐藏状态下不重启：那时本就该停）。 */
function _resumeLoopIfStalled() {
  if (document.hidden) return false;
  const sess = _current;
  if (!sess || sess.disposed || !getFragmentIsPlaying()) return false;
  // 等待推理时循环是**故意**停的，由 chunk 回调 / finish 恢复。
  if (sess.scheduler && sess.scheduler.isWaiting) return false;
  const raf = sess.kind === 'exclusive' ? getFragmentExclusiveRaf() : getFragmentPlayheadRaf();
  if (raf && _loopAlive(Date.now())) return false;
  _cancelLoop();
  _lastTickAt = Date.now(); // 乐观心跳：避免同毫秒多路同时重启互相 cancel
  _scheduleTick();
  return true;
}

function _scheduleTick() {
  const sess = _current;
  if (!sess || sess.disposed) return;
  const id = requestAnimationFrame(playheadTick);
  if (sess.kind === 'exclusive') setFragmentExclusiveRaf(id);
  else setFragmentPlayheadRaf(id);
}

function _ensureWatchdog() {
  const now = Date.now();
  if (_watchdogTimer && Math.abs(now - _lastWatchdogTickAt) < WATCHDOG_INTERVAL_MS * 3) return;
  if (_watchdogTimer) { clearInterval(_watchdogTimer); _watchdogTimer = null; }
  _lastWatchdogTickAt = now;
  _watchdogTimer = setInterval(() => {
    _lastWatchdogTickAt = Date.now();
    const sess = _current;
    if (!sess || sess.disposed || !getFragmentIsPlaying() || document.hidden) return;
    _resumeLoopIfStalled();
    // 会话级兜底：推理已结束、播放头越过已交付末端且长时间没有新 chunk。
    sess.checkStalledFinish();
  }, WATCHDOG_INTERVAL_MS);
  if (typeof _watchdogTimer?.unref === 'function') _watchdogTimer.unref();
}

function _teardownWatchdog() {
  if (_watchdogTimer) { clearInterval(_watchdogTimer); _watchdogTimer = null; }
  _lastWatchdogTickAt = 0;
}

function _onVisibilityChange() {
  if (document.hidden) { _cancelLoop(); return; }
  _resumeLoops();
}

function _resumeLoops() {
  if (document.hidden) return;
  // 后台期间定时器被节流到 ~1 次/分钟：心跳必然过期，先重建看门狗本身。
  _ensureWatchdog();
  _resumeLoopIfStalled();
}

function _bindVisibility() {
  _ensureWatchdog();
  if (_visibilityBound) return;
  _visibilityBound = true;
  document.addEventListener('visibilitychange', _onVisibilityChange);
  window.addEventListener('focus', _resumeLoops);
  window.addEventListener('pageshow', _resumeLoops);
  window.addEventListener('beforeunload', () => {
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    window.removeEventListener('focus', _resumeLoops);
    window.removeEventListener('pageshow', _resumeLoops);
    _visibilityBound = false;
    _teardownWatchdog();
  }, { once: true });
}

// ==================== AudioContext ====================

export async function getFragmentAudioContextInternal() {
  let ctx = getFragmentAudioContext();
  if (!ctx || ctx.state === 'closed') {
    // latencyHint: 'interactive' 请求最小输出缓冲：播放头按"耳朵听到的位置"走
    // （见 audioOutputClock），输出延迟越小，拖播放头/起播的跟手度越好。
    // 不改 sampleRate —— 内核忽略该选项时会回退默认值，不影响下面的重采样判断。
    ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: getSampleRate(),
      latencyHint: 'interactive',
    });
    setFragmentAudioContext(ctx);
    const gainNode = ctx.createGain();
    gainNode.connect(ctx.destination);
    setFragmentGainNode(gainNode);
    await applyFragmentAudioSettings();
  }
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

export async function loadFragmentAudioSettings() {
  try {
    const settings = await window.electronAPI.getSettings();
    setFragmentAudioSettings(settings);
    setFragmentUseExclusiveMode(settings?.audioOutputMode === 'exclusive');
  } catch (_e) {
    setFragmentAudioSettings({});
  }
}

export async function applyFragmentAudioSettings() {
  const settings = getFragmentAudioSettings();
  if (!settings) return;
  const gainNode = getFragmentGainNode();
  if (gainNode && settings.audioVolume !== undefined) gainNode.gain.value = settings.audioVolume;
  const ctx = getFragmentAudioContext();
  if (ctx && settings.audioOutputDevice !== undefined && settings.audioOutputDevice !== -1) {
    if (ctx.setSinkId && typeof ctx.setSinkId === 'function') {
      try { await ctx.setSinkId(String(settings.audioOutputDevice)); } catch (err) {
        console.warn('[FragmentAudio] 设置输出设备失败:', err.message);
      }
    }
  }
}

/**
 * chunk 排程用的上下文 —— **不**在 underrun 冻结期间偷偷解冻。
 * 解冻一律走 scheduler.resumeFromWait()，否则 scheduler 仍认为在等待，
 * 之后的 resume 变成空操作而 rAF 已停 → 声画脱节。
 */
async function _ctxForChunk(sess) {
  let ctx = getFragmentAudioContext();
  if (!ctx || ctx.state === 'closed') return getFragmentAudioContextInternal();
  const waiting = !!(sess.scheduler && sess.scheduler.isWaiting);
  if (ctx.state === 'suspended' && !waiting) {
    try { await ctx.resume(); } catch (_) { /* 交给排程与 watchdog */ }
  }
  return ctx;
}

// ==================== fade / envelope 辅助 ====================

function _bpm() { return getCurrentProject() ? getCurrentProject().bpm : 120; }

const _delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 首个到达的 chunk 不是时间上最早的一块时，短暂收集更早序号再锚定。
// 只对带 seq 的新协议生效；老路径（插件 / 测试桩）零延迟。
const REORDER_WAIT_MS = 80;
const REORDER_MAX_CHUNKS = 16;

/** 实时播放的 per-note 渐入/渐出调度参数（atSec 为分片绝对秒）。 */
function buildNoteFades() {
  const notes = getClippedNotes();
  const out = [];
  const spb = 60 / _bpm();
  for (const n of notes) {
    const startSec = n.start * spb;
    const endSec = startSec + n.duration * spb;
    if (n.fadeIn && n.fadeIn > 0) {
      const d = n.fadeIn / 1000;
      out.push({ atSec: startSec, rampEndSec: startSec + d, fromGain: 0, toGain: 1 });
    }
    if (n.fadeOut && n.fadeOut > 0) {
      const d = n.fadeOut / 1000;
      out.push({ atSec: Math.max(startSec, endSec - d), rampEndSec: endSec, fromGain: 1, toGain: 0 });
    }
  }
  return out;
}

/**
 * 把 fade 事件挂到增益节点。fadeOut 结束后必须恢复 1，否则后续无 fadeIn 的
 * 音符全程静音。时间原点显式传入，与 chunk 排程共用同一条时间轴。
 */
function scheduleFades(gainNode, ctx, fades, startOffset, originCtxTime) {
  if (!fades || fades.length === 0) return;
  const now = Number.isFinite(originCtxTime) ? originCtxTime : ctx.currentTime;
  gainNode.gain.setValueAtTime(1, now);
  const sorted = [...fades].sort((a, b) => a.atSec - b.atSec);
  for (const f of sorted) {
    if (f.rampEndSec <= startOffset) continue;
    const atSec = Math.max(f.atSec, startOffset);
    const fromGain = f.atSec <= startOffset
      ? (f.toGain - f.fromGain) * Math.max(0, Math.min(1, (startOffset - f.atSec) / Math.max(0.0001, f.rampEndSec - f.atSec))) + f.fromGain
      : f.fromGain;
    gainNode.gain.setValueAtTime(fromGain, now + (atSec - startOffset));
    gainNode.gain.linearRampToValueAtTime(f.toGain, now + (f.rampEndSec - startOffset));
    if (f.toGain === 0) gainNode.gain.setValueAtTime(1, now + (f.rampEndSec - startOffset));
  }
}

/** 独占模式不经 WebAudio 图：fade 预乘进 PCM（与导出路径一致）。 */
function applyFadesToMono(audioData) {
  const notes = getClippedNotes();
  const fades = [];
  for (const n of notes) {
    const fi = (n.fadeIn && n.fadeIn > 0) ? n.fadeIn / 1000 : 0;
    const fo = (n.fadeOut && n.fadeOut > 0) ? n.fadeOut / 1000 : 0;
    if (fi <= 0 && fo <= 0) continue;
    fades.push({ startBeat: n.start, durationBeats: n.duration, fadeInSec: fi, fadeOutSec: fo });
  }
  if (fades.length === 0) return audioData;
  const sr = getSampleRate();
  const out = new Float32Array(audioData.length);
  out.set(audioData);
  const spb = 60 / _bpm();
  for (const f of fades) {
    const s0 = f.startBeat * spb;
    const s1 = s0 + f.durationBeats * spb;
    const i0 = Math.max(0, Math.floor(s0 * sr));
    const i1 = Math.min(out.length, Math.ceil(s1 * sr));
    const fiN = Math.max(1, Math.floor(f.fadeInSec * sr));
    const foN = Math.max(1, Math.floor(f.fadeOutSec * sr));
    for (let i = i0; i < i1; i++) {
      let g = 1;
      if (f.fadeInSec > 0 && i < i0 + fiN) g = (i - i0) / fiN;
      if (f.fadeOutSec > 0 && i > i1 - foN) g = Math.min(g, Math.max(0, (i1 - i) / foN));
      out[i] *= Math.max(0, Math.min(1, g));
    }
  }
  return out;
}

function interpolateEnv(sortedKfs, timeSec) {
  if (!sortedKfs || sortedKfs.length === 0) return 1;
  if (sortedKfs.length === 1) return sortedKfs[0].value;
  if (timeSec <= sortedKfs[0].time) return sortedKfs[0].value;
  const last = sortedKfs[sortedKfs.length - 1];
  if (timeSec >= last.time) return last.value;
  for (let i = 0; i < sortedKfs.length - 1; i++) {
    const a = sortedKfs[i];
    const b = sortedKfs[i + 1];
    if (timeSec >= a.time && timeSec <= b.time) {
      const k = (timeSec - a.time) / (b.time - a.time);
      return a.value + k * (b.value - a.value);
    }
  }
  return last.value;
}

/** 裁头处不是内容起点时补 10ms 余弦渐入，防爆音。 */
function fadeInHead(samples, sampleRate, sec) {
  if (!samples || samples.length === 0) return;
  const n = Math.min(samples.length, Math.max(1, Math.round(sec * sampleRate)));
  for (let i = 0; i < n; i++) samples[i] *= 0.5 * (1 - Math.cos((Math.PI * i) / n));
}

// ==================== 会话 ====================

class Session {
  constructor(kind) {
    this.id = ++_sessionSeq;
    this.kind = kind;                 // 'stream' | 'full' | 'exclusive'
    this.disposed = false;
    this.finished = false;
    this.userStopped = false;
    this.startPositionSec = Math.max(0, getFragmentPlayStartPosition() || 0);

    // 流式
    this.timeline = null;
    this.scheduler = null;
    this.sources = [];
    this.fadeGain = null;
    this.chunkCleanup = null;
    this.endCleanup = null;
    this.queue = Promise.resolve();
    this.lastChunkAtMs = 0;
    this.chunkSeen = false;
    this.streamStarted = false;
    this.streamDisabled = false;
    this.inferenceDone = false;
    // 流身份与显式结束屏障（见 audioPlayback.nextFragmentStreamId / svsIpc）。
    this.streamId = null;
    this.seenSeqs = new Set();
    this.expectedLastSeq = null;
    this.endSeen = false;         // END 事件已到达（同步置位，用来区分"还没到"与"还没处理"）
    this.deliveryDone = false;    // 已处理到 lastSeq / 已确认回执兜底
    this.deliveryComplete = true; // seq 是否连续（缺口时只兜底，不假装完整）
    // 首块乱序预缓冲：必须放在串行队列入口，不能在处理函数内部睡眠
    // （那只会让更早的 seq 排在当前处理之后，等到也用不上）。
    this._initialChunks = new Map();
    this._reorderTimer = null;
    this._reorderFlushed = false;
    this.protocolMode = null;     // 'identified' | 'legacy'，首块到达时一次性决定
    this.inFlightChunkHandlers = 0;
    // 诊断：underrun 等待代数 / source 序号（定位"只进等待、没有解冻"）
    this._waitGeneration = 0;
    this._sourceSeq = 0;

    // 整段 / 独占
    this.fullSource = null;
    this.fullNodes = [];
    this.fullDurationSec = 0;
    this.exclusiveToken = 0;
    this.exclusiveStartWallMs = 0;
    this.removeEndedListener = null;

    // seek（合成中拖拽）：合成完成后从该位置整段播放
    this.pendingSeek = null;
  }

  get isCurrent() { return _current === this && !this.disposed; }

  /** 所有 await 之后统一用这一把守卫：会话身份 + 停止/完成标记。 */
  get isUsable() {
    return this.isCurrent && !this.finished && !this.streamDisabled;
  }

  /** 第一个 source 真正启动成功后才宣告播放开始。 */
  _activatePlaybackUi() {
    if (this.streamStarted || !this.timeline || !this.timeline.started) return;
    this.streamStarted = true;
    const anchor = this.timeline.anchorCtxTime;
    setFragmentIsPlaying(true);
    setFragmentPlaybackStartTime(anchor);
    setFragmentPlaybackOffset(this.startPositionSec);
    setFragmentCurrentTime(this.startPositionSec);
    updateFragmentPlayButton();
    // activate 只武装 watchdog，**不重置**会话状态：invoke 回执可能先于
    // 首块处理到达（冷启动 AudioContext / 缓存 burst），重置会把已经置位的
    // inferenceDone 抹掉 → 末尾 underrun 冻结后无人解冻 → 全程静音 + 卡死。
    if (this.scheduler) this.scheduler.activate();
    _bindVisibility();
    console.log(`[FragPlay] PLAYBACK START | session=${this.id} playFromSec=${this.startPositionSec.toFixed(3)} firstNoteStartSec=${this.timeline.firstNoteStartSec.toFixed(3)} t=${Date.now()}`);
    playheadTick();
  }

  /** 输入在推理途中变化：停掉本会话已排程的旧音频，但不 dispose 会话。 */
  stopStreamAudio() {
    this.streamDisabled = true;
    for (const src of this.sources) {
      if (!src) continue;
      safeCleanup('fragmentPlayback.inputChanged.src.stop', () => { src.onended = null; src.stop(); });
    }
    this.sources = [];
    if (this.fadeGain) {
      safeCleanup('fragmentPlayback.inputChanged.fadeGain.disconnect', () => this.fadeGain.disconnect());
      this.fadeGain = null;
    }
    if (this.scheduler) this.scheduler.deactivate();
    setFragmentIsPlaying(false);
    _cancelLoop();
  }

  /** 本会话是否真的排过/正在排 source（兜底播放不再看全局 isPlaying）。 */
  hasStartedSources() {
    return this.sources.some(Boolean)
      || !!(this.scheduler && this.scheduler.activeSourceCount > 0);
  }

  /**
   * 流结束屏障：由 preload 的 stream-end 回调同步调用，把确认动作放进同一条
   * chunk 队列，保证 lastSeq 之前的块先处理完。
   */
  noteStreamEnd(info) {
    if (!this.isUsable) return;
    if (info && this.streamId && info.streamId && info.streamId !== this.streamId) return;
    this.endSeen = true;
    // END 必须排在预缓冲里所有已收到的 chunk 之后，否则屏障会先于尾部
    // chunk 处理完，drain() 返回时它们还没进 timeline。
    this._flushInitialChunks();
    this.queue = this.queue
      .then(() => this._handleStreamEnd(info))
      .catch((e) => console.warn('[FragmentPlayback] stream-end error:', e && e.message));
    return this.queue;
  }

  /** 没有 END 事件可用时的回执兜底（插件 / 老主进程 / 测试桩）。 */
  markLegacyDelivery() {
    if (this.endSeen) return;
    this.deliveryDone = true;
    this.deliveryComplete = true;
  }

  async _handleStreamEnd(info) {
    if (!this.isUsable) return;
    const lastSeq = info && Number.isFinite(info.lastSeq) ? info.lastSeq : 0;
    this.expectedLastSeq = lastSeq;
    const transportFailed = !!(info && info.transportFailed);
    if (transportFailed) {
      console.warn(`[FragmentPlayback] stream transport failed; lastSeq=${lastSeq} is not authoritative`);
    }
    // 连续序号检查：缺口意味着尾段可能永远到不了，记录但不阻塞收尾，
    // 由上层结合"是否开播"决定整段兜底。
    let contiguous = 0;
    while (this.seenSeqs.has(contiguous + 1)) contiguous += 1;
    this.deliveryComplete = !transportFailed && (lastSeq === 0 || contiguous >= lastSeq);
    if (!this.deliveryComplete) {
      console.warn(`[FragmentPlayback] stream gap: seen contiguous=${contiguous} lastSeq=${lastSeq} stream=${this.streamId}`);
    }
    this.deliveryDone = true;
  }

  // ---------- 生命周期 ----------

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this._reorderTimer) {
      clearTimeout(this._reorderTimer);
      this._reorderTimer = null;
    }
    this._initialChunks.clear();
    if (_current === this) _current = null;
    this._teardownAudio();
    if (this.chunkCleanup) {
      safeCleanup('fragmentPlayback.chunkCleanup', this.chunkCleanup);
      this.chunkCleanup = null;
    }
    if (this.endCleanup) {
      safeCleanup('fragmentPlayback.endCleanup', this.endCleanup);
      this.endCleanup = null;
    }
    if (this.scheduler) this.scheduler.deactivate();
    if (this.removeEndedListener) {
      safeCleanup('fragmentPlayback.detachEnded', this.removeEndedListener);
      this.removeEndedListener = null;
    }
  }

  _teardownAudio() {
    for (const src of this.sources) {
      if (!src) continue;
      safeCleanup('fragmentPlayback.src.stop', () => { src.onended = null; src.stop(); });
    }
    this.sources = [];
    if (this.fadeGain) {
      safeCleanup('fragmentPlayback.fadeGain.disconnect', () => this.fadeGain.disconnect());
      this.fadeGain = null;
    }
    if (this.fullSource) {
      safeCleanup('fragmentPlayback.fullSource.stop', () => { this.fullSource.onended = null; this.fullSource.stop(); });
      this.fullSource = null;
    }
    for (const n of this.fullNodes) safeCleanup('fragmentPlayback.node.disconnect', () => n.disconnect());
    this.fullNodes = [];
    if (this.kind === 'exclusive') this._stopExclusive();
    const src = getFragmentAudioSource();
    if (src) {
      safeCleanup('fragmentPlayback.stateSource.stop', () => { src.onended = null; src.stop(); });
      setFragmentAudioSource(null);
    }
  }

  _stopExclusive() {
    if (this.removeEndedListener) {
      safeCleanup('fragmentPlayback.detachEnded', this.removeEndedListener);
      this.removeEndedListener = null;
    }
    const token = _nextExclusiveToken();
    const p = window.electronAPI.audioStop(token);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  /** 自然结束（幂等 + 会话守卫）。 */
  finish() {
    if (this.finished || this.disposed || !this.isCurrent) return;
    this.finished = true;
    console.log(`[FragPlay] PLAYBACK FINISHED | session=${this.id} kind=${this.kind} deliveredEndSec=${this.timeline ? this.timeline.deliveredEndSec.toFixed(3) : '-'} t=${Date.now()}`);
    this._logDebug('finish state', this._debugSnapshot('finish'));
    setFragmentIsPlaying(false);
    _cancelLoop();
    if (this.scheduler) this.scheduler.deactivate();
    setFragmentCurrentTime(0);
    setFragmentPlayStartPosition(0);
    this.startPositionSec = 0;
    updateFragmentPlayButton();
    render();
  }

  // ---------- 位置 ----------

  /** 播放头位置（分片绝对秒）。latencySec 仅用于显示域。 */
  positionAt(ctxNow, latencySec = 0) {
    if (this.kind === 'exclusive') {
      const elapsed = (performance.now() - this.exclusiveStartWallMs) / 1000;
      return this.startPositionSec + Math.max(0, elapsed);
    }
    if (this.kind === 'stream' && this.timeline && this.timeline.started) {
      return this.timeline.positionAt(ctxNow, latencySec);
    }
    return this.startPositionSec + getAudibleElapsedSec(getFragmentAudioContext(), getFragmentPlaybackStartTime());
  }

  /** 调度域位置（不减输出延迟）：underrun / 结束判定用。 */
  renderPosition(ctxNow) { return this.positionAt(ctxNow, 0); }

  // ---------- 流式 ----------

  beginStreaming() {
    this.scheduler = new StreamingScheduler({
      getCtx: () => getFragmentAudioContext(),
      getElapsed: () => {
        const ctx = getFragmentAudioContext();
        return ctx ? this.renderPosition(ctx.currentTime) : 0;
      },
      onWaitStateChange: (isWaiting) => {
        if (!this.isCurrent) return;
        if (isWaiting) {
          this._waitGeneration += 1;
          this._logDebug('ENTER WAIT', this._debugSnapshot('enter-wait'));
          const btn = document.getElementById('btn-play-fragment');
          if (btn) setLabel(btn, t('fragment.waitingForInference'), { icon: 'stop' });
        } else {
          this._logDebug('RESUME', this._debugSnapshot('resume'));
          updateFragmentPlayButton();
          if (getFragmentIsPlaying() && !getFragmentPlayheadRaf()) playheadTick();
        }
      },
      watchdogMarginSec: 0.3,
      onFinish: () => this._maybeFinish(),
    });
  }

  /**
   * chunk 入口。首块若带 seq 且不是 1，先在队列**外面**做一次性预缓冲：
   * 在串行 handler 内部 sleep 是无效的——更早的 seq 只能排在它后面，等完
   * 也用不上。这里让早期块先进入 staging，flush 时按 seq 排序再统一入队。
   */
  pushChunk(chunkInfo) {
    if (!this.isUsable || !chunkInfo) return;
    // 协议模式由首块一次性决定：带 streamId 后必须严格匹配，不允许无 ID
    // 的迟到 chunk 混进新会话；老协议整轮保持兼容语义。
    if (!this.protocolMode) {
      this.protocolMode = chunkInfo.streamId ? 'identified' : 'legacy';
    }
    if (this.protocolMode === 'identified' && chunkInfo.streamId !== this.streamId) {
      console.warn(`[FragmentPlayback] drop chunk stream=${chunkInfo.streamId} current=${this.streamId}`);
      return;
    }
    const seq = Number(chunkInfo.seq);
    const hasSeq = Number.isSafeInteger(seq) && seq > 0;
    if (hasSeq) {
      if (this.seenSeqs.has(seq)) {
        console.warn(`[FragmentPlayback] duplicate seq=${seq} dropped`);
        return;
      }
      this.seenSeqs.add(seq);
    }

    if (!this._reorderFlushed && this.protocolMode === 'identified' && hasSeq) {
      if (seq === 1) {
        this._initialChunks.set(seq, chunkInfo);
        this._flushInitialChunks();
        return;
      }
      if (this._initialChunks.size < REORDER_MAX_CHUNKS) {
        this._initialChunks.set(seq, chunkInfo);
        if (!this._reorderTimer) {
          this._reorderTimer = setTimeout(() => this._flushInitialChunks(), REORDER_WAIT_MS);
        }
        return;
      }
      this._flushInitialChunks();
    }
    this._enqueueChunk(chunkInfo);
  }

  _flushInitialChunks() {
    if (this._reorderTimer) {
      clearTimeout(this._reorderTimer);
      this._reorderTimer = null;
    }
    if (this._reorderFlushed || this._initialChunks.size === 0) return;
    this._reorderFlushed = true;
    const ordered = [...this._initialChunks.entries()].sort((a, b) => a[0] - b[0]);
    this._initialChunks.clear();
    for (const [, chunk] of ordered) this._enqueueChunk(chunk);
  }

  _enqueueChunk(chunkInfo) {
    this.queue = this.queue
      .then(() => this._handleChunk(chunkInfo))
      .catch((e) => console.warn('[FragmentPlayback] chunk queue error:', e && e.message));
    return this.queue;
  }

  /** 等待已入队 chunk 全部处理完（invoke 回执后调用）。 */
  drain() { return this.queue; }

  async _handleChunk(chunkInfo) {
    this.inFlightChunkHandlers += 1;
    try {
      return await this._processChunk(chunkInfo);
    } finally {
      this.inFlightChunkHandlers -= 1;
      // 队列内即时 onended 被 inFlight 守卫挡下的收尾，在这一刻补做。
      this._maybeFinish();
    }
  }

  async _processChunk(chunkInfo) {
    if (!this.isUsable) return;
    if (!chunkInfo) return;
    // 流归属校验：首块一次性决定协议模式后严格按 streamId 过滤。
    if (this.protocolMode === 'identified' && chunkInfo.streamId !== this.streamId) {
      console.warn(`[FragmentPlayback] drop stale chunk stream=${chunkInfo.streamId} current=${this.streamId}`);
      return;
    }
    if (!chunkInfo.audio || chunkInfo.audio.length === 0) return;
    this.chunkSeen = true;

    const ctx = await _ctxForChunk(this);
    if (!ctx || !this.isUsable) return;

    const sampleRate = getSampleRate();
    // 首个 chunk 之前先等 suspend 落地：in-flight 期间时钟仍在走，
    // 此刻读 currentTime 会把"控制消息还没送到"算成迟到而裁掉音频头。
    if (this.scheduler) await this.scheduler.awaitSuspendSettled();
    if (!this.isUsable) return;

    if (!this.timeline) {
      const notes = getClippedNotes();
      const firstNoteStartSec = notes.length > 0 ? (firstNoteStart(notes) / _bpm()) * 60 : 0;
      this.timeline = new StreamTimeline({
        startPositionSec: this.startPositionSec,
        firstNoteStartSec,
      });
    }

    // 先算方案不记账；source.start() 成功后再 commit，避免失败排程污染账本。
    const plan = this.timeline.plan(chunkInfo, sampleRate, ctx.currentTime, { reserve: false });
    this.lastChunkAtMs = Date.now();

    if (plan.startedNow) {
      // 这里只建立时间基准与 fade 节点；"正式开播"必须等第一个 source
      // start() 成功后才宣告（见 _activatePlaybackUi）。
      const anchor = this.timeline.anchorCtxTime;
      const fades = buildNoteFades();
      if (fades.length > 0) {
        this.fadeGain = ctx.createGain();
        const master = getFragmentGainNode();
        this.fadeGain.connect(master || ctx.destination);
        scheduleFades(this.fadeGain, ctx, fades, this.startPositionSec, anchor);
      }
    }

    if (plan.action === 'drop') {
      this._logDebug('chunk dropped', {
        ...this._debugSnapshot('chunk-dropped'),
        seq: chunkInfo.seq ?? null,
        reason: plan.reason,
        chunkStartSec: plan.contentStartSec,
        chunkEndSec: plan.contentEndSec,
        chunkDurSec: plan.durationSec,
        sampleOffset: chunkInfo.sampleOffset ?? null,
        sampleEnd: chunkInfo.sampleEnd ?? null,
        isLast: !!chunkInfo.isLast,
      });
      if (chunkInfo.isLast && this.scheduler) this.scheduler.markLastReceived();
      this._maybeFinish();
      return;
    }

    const segments = plan.segments && plan.segments.length > 0
      ? plan.segments
      : [{ skipSamples: plan.skipSamples, when: plan.when, offsetSec: plan.offsetSec, durationSec: plan.durationSec }];
    const startedSegs = [];

    // 一个块可能被已排程区间切成多段（乱序/重叠），逐段排 —— 少排一段就是丢一句。
    for (const seg of segments) {
      // 中途失效必须先提交已成功启动的段再退出：直接 return 会留下
      // "音频已播但 coveredRanges 未登记"的空洞，后续重传被判重复。
      if (!this.isUsable) break;
      const startSample = seg.skipSamples;
      // 按"该段完整长度"切片：基础偏移已由 subarray(startSample) 扣掉，
      // source.start 的 offsetSec 只需要再扣迟到量（不能重复扣基础偏移）。
      const fullSec = Number.isFinite(seg.sourceDurationSec) ? seg.sourceDurationSec : seg.durationSec + seg.offsetSec;
      const sliceSamples = Math.min(Math.round(fullSec * sampleRate), chunkInfo.audio.length - startSample);
      if (sliceSamples <= 0) continue;

      const slice = chunkInfo.audio.subarray(startSample, startSample + sliceSamples);
      const buffer = ctx.createBuffer(1, slice.length, sampleRate);
      const dest = buffer.getChannelData(0);
      dest.set(slice);
      if (startSample > 0 || seg.offsetSec > 0) fadeInHead(dest, sampleRate, 0.01);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const sched = this.scheduler;
      const idx = this.sources.length;
      const srcId = ++this._sourceSeq;
      // 生命周期顺序：先挂 onended / 计数 / 登记，再 start()。
      // 极短 buffer 或已过期的 when 可能让 source 立刻结束；若先 start 再挂
      // onended，计数将永久不归零 → _maybeFinish 永不成立、播放卡死。
      source.onended = () => {
        this._logDebug('source ended', {
          session: this.id,
          srcId,
          ctxNow: ctx.currentTime,
          activeSources: sched ? sched.activeSourceCount - 1 : null,
          inferenceDone: this.inferenceDone,
          finished: this.finished,
        });
        if (sched) sched.sourceEnded();
        if (this.sources[idx] === source) this.sources[idx] = null;
        this._maybeFinish();
        // 缓冲刚播完、推理还没送来下一块：这是最后一个"时钟仍停在前沿"的时刻。
        // rAF / 看门狗在窗口被遮挡时会被节流到 ~1 次/分钟，不能作为唯一判据。
        if (!this.finished && sched) sched.onSourcesDrained(() => render());
      };
      if (this.fadeGain) source.connect(this.fadeGain);
      else {
        const master = getFragmentGainNode();
        source.connect(master || ctx.destination);
      }
      if (sched) sched.addSource();
      this.sources.push(source);
      this._logDebug('source start', {
        session: this.id,
        srcId,
        seq: chunkInfo.seq ?? null,
        ctxNow: ctx.currentTime,
        when: seg.when,
        startOffsetSec: seg.offsetSec,
        durationSec: seg.durationSec,
        lateSec: plan.offsetSec,
        activeSources: sched ? sched.activeSourceCount : null,
        waiting: sched ? sched.isWaiting : null,
      });
      try {
        source.start(seg.when, seg.offsetSec);
      } catch (err) {
        // start 失败：回滚计数与登记，不把这段记进 coveredRanges。
        source.onended = null;
        if (sched) sched.sourceEnded();
        if (this.sources[idx] === source) this.sources[idx] = null;
        safeCleanup('fragmentPlayback.source.disconnect', () => source.disconnect());
        console.warn(`[FragmentPlayback] source.start failed: ${err && err.message}`);
        continue;
      }
      startedSegs.push(seg);
      // 至少一个 source 真正发声后才把会话宣告为 playing。
      this._activatePlaybackUi();
    }

    // 只有真正 start() 成功的段才登记占位与前沿。
    if (startedSegs.length > 0) {
      this.timeline.commit(plan, startedSegs);
      const committedEnd = Math.max(...startedSegs.map((s) => s.contentEndSec));
      // 前沿必须在 resumeFromWait 之前更新：解冻后重启的循环用新前沿判定，
      // 否则刚解冻又被旧前沿冻结 → 首段之后整段静音。
      if (this.scheduler && Number.isFinite(committedEnd)) {
        this.scheduler.updateBufferFrontier(committedEnd);
      }
    }

    console.log(`[FragPlay] chunk scheduled | session=${this.id} seg=${chunkInfo.chunkIndex ?? '-'} offset=${chunkInfo.sampleOffset ?? '-'} end=${chunkInfo.sampleEnd ?? '-'} lateSec=${plan.offsetSec.toFixed(4)} durSec=${plan.durationSec.toFixed(3)} parts=${segments.length} started=${plan.startedNow} isLast=${!!chunkInfo.isLast} t=${Date.now()}`);

    if (this.scheduler && this.scheduler.isWaiting) {
      this._logDebug('resume after chunk', {
        session: this.id,
        seq: chunkInfo.seq ?? null,
        waitGen: this._waitGeneration,
        ...this._debugSnapshot('resume-after-chunk'),
      });
      await this.scheduler.resumeFromWait();
      // resumeFromWait 内部有 await：等待期间用户可能停止或已开新一轮。
      // 守卫必须覆盖后面所有状态写入，不能只保护 playheadTick。
      if (!this.isUsable) return;
      if (getFragmentIsPlaying() && !getFragmentPlayheadRaf()) playheadTick();
    }

    if (chunkInfo.isLast && this.scheduler) {
      console.log(`[FragPlay] LAST CHUNK RECEIVED | session=${this.id} offset=${chunkInfo.sampleOffset ?? '-'} end=${chunkInfo.sampleEnd ?? '-'} t=${Date.now()}`);
      this.scheduler.markLastReceived();
    }
    this._maybeFinish();
  }

  setInferenceDone() {
    this.inferenceDone = true;
    this._logDebug('inference done', this._debugSnapshot('inference-done'));
    if (!this.scheduler) return Promise.resolve();
    // scheduler 内部会在 waiting 时解冻；这里再跑一次一致性自检，兜住
    // "解冻已发出但设备没真正恢复 / 前沿与播放头脱节"的残留状态。
    return this.scheduler.setInferenceDone()
      .then(() => this._repairPlaybackConsistency('inference-done'))
      .then(() => {
        this._logDebug('inference done settled', this._debugSnapshot('inference-done-settled'));
      });
  }

  /**
   * 写调试日志。渲染端 console 由主进程 console-message 落盘，对象参数会退化成
   * "[object Object]"，所以这里统一序列化成字符串（日志文件与 DevTools 都可读）。
   */
  _logDebug(tag, obj) {
    let text = '';
    try { text = obj === undefined ? '' : JSON.stringify(obj); } catch (_) { text = String(obj); }
    console.log(`[FragPlay] ${tag} ${text}`);
  }

  /** 一次性快照：静音取证需要的全部会话/调度/上下文状态。 */
  _debugSnapshot(stage) {
    const ctx = getFragmentAudioContext();
    const sched = this.scheduler;
    const ctxNow = ctx ? ctx.currentTime : null;
    const master = getFragmentGainNode();
    return {
      stage,
      session: this.id,
      kind: this.kind,
      current: this.isCurrent,
      disposed: this.disposed,
      finished: this.finished,
      userStopped: this.userStopped,
      streamDisabled: this.streamDisabled,
      streamStarted: this.streamStarted,
      streamId: this.streamId,
      seenSeqs: this.seenSeqs.size,
      expectedLastSeq: this.expectedLastSeq,
      inferenceDone: this.inferenceDone,
      endSeen: this.endSeen,
      deliveryDone: this.deliveryDone,
      ctxState: ctx ? ctx.state : null,
      ctxNow,
      position: ctx && this.kind !== 'exclusive' ? this.renderPosition(ctxNow) : null,
      deliveredEnd: this.timeline ? this.timeline.deliveredEndSec : null,
      anchorCtxTime: this.timeline ? this.timeline.anchorCtxTime : null,
      waiting: sched ? sched.isWaiting : null,
      resuming: sched ? sched.isResuming : null,
      bufferEnd: sched ? sched.bufferEndSec : null,
      schedulerElapsed: sched && sched._getElapsed ? sched._getElapsed() : null,
      marginSec: sched ? sched.requiredUnderrunMarginSec(0) : null,
      activeSources: sched ? sched.activeSourceCount : null,
      liveSources: this.sources.filter(Boolean).length,
      masterGain: master && master.gain ? master.gain.value : null,
      waitGen: this._waitGeneration,
    };
  }

  /**
   * 播放一致性自检（兜底修复，不是主路径）。
   *
   * 不变量：**只要播放头之后还有已交付内容，scheduler 就不允许停在等待态。**
   * 主路径会在 chunk 到达时先 updateBufferFrontier 再 resumeFromWait；一旦
   * 某次 resume 因设备控制消息失败/丢失而回到 suspended，后续不会再有 chunk
   * 来唤醒它 —— 表现为"推理全部完成、播放头却定在长空当里永久无声"。
   *
   * 另外兜住"scheduler 认为不等待，但 AudioContext 实际仍是 suspended"：
   * 此时解冻控制消息永远不会再发，必须按真实 ctx.state 补一次 resume。
   */
  _repairPlaybackConsistency(stage) {
    const sched = this.scheduler;
    const ctx = getFragmentAudioContext();
    if (!sched || !ctx || this.disposed || this.finished || this.streamDisabled) {
      return Promise.resolve();
    }
    const pos = this.renderPosition(ctx.currentTime);
    const end = this.timeline ? this.timeline.deliveredEndSec : 0;
    // 播放头之后还有已交付内容 → 解冻后必须能立刻出声。
    const hasRemaining = end > pos + 0.05;

    if (sched.isWaiting) {
      // 合法等待：推理仍在进行，且没有越过播放头的已交付内容。保持冻结。
      if (!this.inferenceDone && !hasRemaining) return Promise.resolve();
      if (!sched.isResuming) {
        // console.warn 走主进程 console-message（保留源码位置），对象参数会被
        // 压成 [object Object]，所以这里显式序列化。
        console.warn('[FragPlay] repairing stuck scheduler '
          + JSON.stringify({ ...this._debugSnapshot(`repair:${stage}`), hasRemaining }));
      }
      if (hasRemaining) sched.updateBufferFrontier(end);
      return sched.resumeFromWait().then(() => {
        if (this.isCurrent && getFragmentIsPlaying() && !getFragmentPlayheadRaf()) playheadTick();
      });
    }

    // scheduler 不在等待，但设备时钟仍被冻结：补一次 resume（只记录，不重排）。
    if (ctx.state === 'suspended' && this.inferenceDone) {
      console.warn('[FragPlay] repairing suspended context '
        + JSON.stringify(this._debugSnapshot(`repair-ctx:${stage}`)));
      return Promise.resolve(ctx.resume()).catch(() => {});
    }
    return Promise.resolve();
  }

  /**
   * 收尾判据（三条同时满足）：
   *   · 推理已结束（invoke 回执 / isLast）
   *   · 没有仍在排程的 source
   *   · 播放头已越过已交付内容末端
   * 第三条是旧实现缺的：isLast 的块被整块丢弃时 activeSourceCount 可能瞬时为 0，
   * 仅凭计数就收尾会把还在出声的播放头按回 0。
   */
  _maybeFinish() {
    if (!this.isCurrent || this.finished || this.kind !== 'stream') return;
    // 当前 chunk 还在 commit / 前沿更新中时，不允许被即时 onended 抢先收尾。
    if (this.inFlightChunkHandlers > 0) return;
    if (!this.streamStarted) return;
    const sched = this.scheduler;
    if (!sched) return;
    // 新协议下 END 未处理完之前不允许靠 inferenceDone 判定完成：最后几块
    // 可能还在 IPC 队列里。isLast 已收到且 source 全结束时则是安全收尾点。
    if (this.streamId && !this.deliveryDone && !sched.isLastReceived) return;
    if (!sched.inferenceDone && !sched.isLastReceived) return;
    if (sched.activeSourceCount > 0) return;
    const ctx = getFragmentAudioContext();
    if (!ctx) return;
    const pos = this.renderPosition(ctx.currentTime);
    const end = this.timeline ? this.timeline.deliveredEndSec : 0;
    if (pos + 0.02 < end) return;
    this.finish();
  }

  /** 看门狗兜底：onended 丢失 / chunk 队列空转时不能让会话永远挂着。 */
  checkStalledFinish() {
    if (!this.isCurrent || this.finished || this.kind !== 'stream') return;
    const sched = this.scheduler;
    if (!sched) return;
    // 死锁守卫：推理已结束却仍在等待 → 立即解冻（没有任何后续 chunk 会来）。
    // 另外覆盖"播放头之后已有交付内容却仍停在等待"——同样是无人再唤醒的状态。
    if (sched.isWaiting) {
      const ctx = getFragmentAudioContext();
      const hasRemaining = !!(this.timeline && ctx
        && this.timeline.deliveredEndSec > this.renderPosition(ctx.currentTime) + 0.05);
      if (sched.inferenceDone || hasRemaining) {
        this._repairPlaybackConsistency('watchdog').catch(() => {});
        return;
      }
    }
    if (!this.streamStarted || !sched.inferenceDone) return;
    if (Date.now() - this.lastChunkAtMs < 1500) return;
    const ctx = getFragmentAudioContext();
    if (!ctx) return;
    if (this.renderPosition(ctx.currentTime) >= sched.bufferEndSec + 1.0) this.finish();
  }

  // ---------- 整段（WebAudio） ----------

  async playFullBuffer(audioData) {
    const ctx = await getFragmentAudioContextInternal();
    if (!this.isCurrent) return;
    this._teardownAudio();
    this.kind = 'full';
    this.streamDisabled = true;

    const sr = getSampleRate();
    const duration = audioData.length / sr;
    const startOffset = Math.max(0, Math.min(this.startPositionSec, duration - 0.01));
    this.startPositionSec = startOffset;
    this.fullDurationSec = duration;

    const buffer = ctx.createBuffer(1, audioData.length, sr);
    buffer.getChannelData(0).set(audioData);
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const envGain = ctx.createGain();
    const fadeGain = ctx.createGain();
    const panNode = ctx.createStereoPanner();
    this.fullNodes = [envGain, fadeGain, panNode];

    const bpm = _bpm();
    const envelopes = getEnvelopes();
    const now = ctx.currentTime;
    const volumeEnv = envelopes.volume;
    if (volumeEnv && volumeEnv.keyframes && volumeEnv.keyframes.length > 0) {
      const kfs = [...volumeEnv.keyframes].sort((a, b) => a.time - b.time);
      envGain.gain.setValueAtTime(interpolateEnv(kfs, startOffset), now);
      for (const kf of kfs) {
        const timeSec = (kf.time / bpm) * 60;
        if (timeSec > startOffset && timeSec <= duration) {
          envGain.gain.linearRampToValueAtTime(kf.value, now + (timeSec - startOffset));
        }
      }
      const lastSec = (kfs[kfs.length - 1].time / bpm) * 60;
      if (lastSec < duration) envGain.gain.linearRampToValueAtTime(kfs[kfs.length - 1].value, now + (duration - startOffset));
    }
    const fades = buildNoteFades();
    if (fades.length > 0) scheduleFades(fadeGain, ctx, fades, startOffset, now);
    const panEnv = envelopes.pan;
    if (panEnv && panEnv.keyframes && panEnv.keyframes.length > 0) {
      const kfs = [...panEnv.keyframes].sort((a, b) => a.time - b.time);
      panNode.pan.setValueAtTime(interpolateEnv(kfs, startOffset), now);
      for (const kf of kfs) {
        const timeSec = (kf.time / bpm) * 60;
        if (timeSec > startOffset && timeSec <= duration) {
          panNode.pan.linearRampToValueAtTime(kf.value, now + (timeSec - startOffset));
        }
      }
      const lastSec = (kfs[kfs.length - 1].time / bpm) * 60;
      if (lastSec < duration) panNode.pan.linearRampToValueAtTime(kfs[kfs.length - 1].value, now + (duration - startOffset));
    }

    source.connect(envGain).connect(fadeGain).connect(panNode).connect(getFragmentGainNode() || ctx.destination);
    source.onended = () => {
      for (const n of this.fullNodes) safeCleanup('fragmentPlayback.node.disconnect', () => n.disconnect());
      this.fullNodes = [];
      this.finish();
    };
    const startAt = ctx.currentTime;
    source.start(startAt, startOffset);
    this.fullSource = source;
    setFragmentAudioSource(source);
    setFragmentIsPlaying(true);
    setFragmentPlaybackStartTime(startAt);
    setFragmentPlaybackOffset(startOffset);
    setFragmentCurrentTime(startOffset);
    _bindVisibility();
    playheadTick();
    updateFragmentPlayButton();
  }

  // ---------- 独占（decibri 子进程） ----------

  async playExclusive(audioData) {
    this._teardownAudio();
    if (!this.isCurrent) return;
    this.kind = 'exclusive';
    this.streamDisabled = true;
    const token = _nextExclusiveToken();
    this.exclusiveToken = token;

    const settings = getFragmentAudioSettings();
    const sr = getSampleRate();
    const duration = audioData.length / sr;
    const startOffset = Math.max(0, Math.min(this.startPositionSec, duration - 0.01));
    this.startPositionSec = startOffset;
    this.fullDurationSec = duration;

    try {
      const result = await window.electronAPI.audioPlay(applyFadesToMono(audioData), {
        deviceId: settings?.audioOutputDevice ?? -1,
        sampleRate: settings?.audioSampleRate ?? sr,
        sourceSampleRate: sr,
        channels: 1,
        bitDepth: settings?.audioBitDepth ?? 'float32',
        bufferSize: settings?.audioBufferSize ?? 1024,
        exclusiveMode: true,
        volume: settings?.audioVolume ?? 1.0,
        offset: startOffset,
        sessionId: token,
      });
      if (!this.isCurrent || this.exclusiveToken !== token) {
        if (result && result.success) {
          const p = window.electronAPI.audioStop(token);
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
        return;
      }
      if (!result || !result.success) {
        console.warn('[FragmentAudio] WASAPI 独占模式失败，回退到共享模式:', result && result.error);
        setFragmentUseExclusiveMode(false);
        await this.playFullBuffer(audioData);
        return;
      }
      this.exclusiveStartWallMs = performance.now();
      setFragmentIsPlaying(true);
      setFragmentPlaybackStartTime(this.exclusiveStartWallMs);
      setFragmentPlaybackOffset(startOffset);
      setFragmentCurrentTime(startOffset);
      if (this.removeEndedListener) safeCleanup('fragmentPlayback.detachEnded', this.removeEndedListener);
      this.removeEndedListener = window.electronAPI.onAudioEnded(() => {
        if (!this.isCurrent || this.exclusiveToken !== token) return;
        this.finish();
      });
      _bindVisibility();
      playheadTick();
      updateFragmentPlayButton();
    } catch (err) {
      if (!this.isCurrent || this.exclusiveToken !== token) return;
      console.error('[FragmentAudio] 独占模式启动失败，回退到共享模式:', err);
      setFragmentUseExclusiveMode(false);
      await this.playFullBuffer(audioData);
    }
  }

  // ---------- seek ----------

  /** 合成中拖拽：停掉当前出声，记住新位置，合成完成后整段播放。 */
  requestSeekDuringSynthesis(pos) {
    this._teardownAudio();
    this.streamDisabled = true;
    this.pendingSeek = pos;
    this.startPositionSec = pos;
    setFragmentIsPlaying(false);
    _cancelLoop();
    if (this.scheduler) this.scheduler.deactivate();
    setFragmentPlayStartPosition(pos);
    setFragmentCurrentTime(pos);
    render();
  }
}

// ==================== 播放头循环 ====================

export function playheadTick() {
  const sess = _current;
  if (!sess || sess.disposed) return;
  _bindVisibility();
  if (!getFragmentIsPlaying()) return;
  _lastTickAt = Date.now();

  const ctx = getFragmentAudioContext();
  if (sess.kind !== 'exclusive' && !ctx) return;

  // 自愈：不在等推理、也不是用户暂停，上下文却仍 suspended（设备切换 / 窗口
  // 恢复 / suspend 与 resume 竞争留下的悬空状态）→ 补一次 resume。
  if (ctx && sess.kind !== 'exclusive' && ctx.state === 'suspended'
      && !(sess.scheduler && sess.scheduler.isWaiting)
      && !(sess.scheduler && sess.scheduler.isResuming) && !_ctxResumeInFlight) {
    _ctxResumeInFlight = true;
    ctx.resume().catch(() => {}).then(() => { _ctxResumeInFlight = false; }, () => { _ctxResumeInFlight = false; });
  }

  const positionSec = sess.kind === 'exclusive'
    ? sess.positionAt(0, 0)
    : sess.positionAt(ctx.currentTime, getOutputLatencySec(ctx));
  setFragmentCurrentTime(positionSec);
  tickPlayheadFollow(positionSec);

  // underrun（渲染域，不减输出延迟）
  if (sess.kind === 'stream' && sess.streamStarted && sess.scheduler && !sess.scheduler.inferenceDone) {
    sess.scheduler.checkUnderrun(
      sess.renderPosition(ctx.currentTime),
      () => render(),
      sess.scheduler.requiredUnderrunMarginSec(0.05),
    );
  }

  sess.checkStalledFinish();
  if (sess.finished || sess.disposed) return;

  // 整段 / 独占：到达时长即收尾
  if (sess.kind !== 'stream' && sess.fullDurationSec > 0 && positionSec >= sess.fullDurationSec) {
    sess.finish();
    return;
  }

  render();
  _scheduleTick();
}

// ==================== 对外入口 ====================

/** 开新一轮播放：作废旧会话，返回新会话。 */
export function createSession(kind) {
  if (_current) {
    _current.userStopped = true;
    _current.dispose();
  }
  _cancelLoop();
  const sess = new Session(kind);
  _current = sess;
  return sess;
}

/** 用户主动停止 / 暂停。 */
export function stopPlayback() {
  const sess = _current;
  if (sess) {
    console.log('[FragPlay] stopPlayback ' + JSON.stringify({
      session: sess.id,
      kind: sess.kind,
      waiting: sess.scheduler ? sess.scheduler.isWaiting : null,
      waitGen: sess._waitGeneration,
      ctxState: (getFragmentAudioContext() || {}).state ?? null,
    }));
    sess.userStopped = true;
    sess.dispose();
  }
  // 没有会话时也要保证独占输出被停掉（例如上一轮已 finish 但设备仍在出声）
  if (!sess) {
    const token = _nextExclusiveToken();
    const p = window.electronAPI?.audioStop?.(token);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
  setFragmentIsPlaying(false);
  setFragmentAudioSource(null);
  _cancelLoop();
  settlePlayheadFollow();
  updateFragmentPlayButton();
}

/** 仅供测试：清空模块级状态。 */
export function _resetPlaybackSessions() {
  if (_current) _current.dispose();
  _current = null;
  _cancelLoop();
  _teardownWatchdog();
````

### R4 · 流式时间轴：锚点、coveredRanges、迟到裁头、位置换算

文件：`src/fragmentEditor/playbackTimeline.js`　行：`1-301`

````javascript
/**
 * 分片编辑器流式播放的时间轴模型 —— **唯一时间真源**。
 *
 * 背景：流式预览同时存在四套时间坐标，旧实现把它们散在模块级变量里
 * （`_streamingFirstNoteStartSec` / `_streamingPlayFromSec` /
 * `_streamingDeliveredEndSec` / `_streamingSeqCursorSec`），任何一个在错误的
 * 时机被写一次，播放头与声音就永久错开，而且不同路径（缓存命中 / 多段拼接 /
 * 拖动起播）各错各的。这里把换算收进一个对象：
 *
 *   · chunk 采样坐标：`sampleOffset` 相对**首音符起点**（pipeline 约定）
 *   · 内容坐标：分片绝对秒（画布 / 播放头 / 起播位置都用它）
 *   · 上下文坐标：`AudioContext.currentTime`（调度域，声音真正排程的时刻）
 *
 * 三条不变量：
 *   1. 时间基准（anchor）只在**第一个真正要发声**的 chunk 上建立一次。
 *      起播点之前的 chunk 整块丢弃，绝不提前锚定 —— 旧实现一收到第一个 chunk
 *      就锚定，若它整块在起播点之前，后续每块都被算成"迟到"，头部被裁光，
 *      表现为"从中段起播没有声音 / 播放头空跑"。
 *   2. 锚定之后永不重建。迟到只裁头（`offsetSec`），不改 `when` 的斜率。
 *   3. 占位按**已排程区间集合**（`coveredRanges`）判定，不是单一前沿。
 *      重叠块裁头、重复块丢弃、乱序块回填 —— 后段先到时它只占自己的区间，
 *      前段随后到达仍能按原时刻排进去（旧的"单一前沿"会把前段整块误判为重复）。
 *
 * 纯函数式对象：不碰 DOM、不碰 AudioContext，可在单测里直接驱动。
 */

/** 起播提前量：给设备一个渲染量子，避免首块排在过去。 */
export const STREAM_LEAD_SEC = 0.05;

/** 采样级容差（1 样本 ≈ 0.04ms @24k），避免 float 往返把整块判成"有剩余"。 */
const EPS_SEC = 1e-6;

/**
 * @typedef {Object} StreamChunkPlan
 * @property {'schedule'|'drop'} action
 * @property {'empty'|'before-start'|'duplicate'|'late'|'no-audio'} [reason]
 * @property {boolean} startedNow 本次是否刚建立时间基准
 * @property {number} when 排程的上下文时刻（秒）
 * @property {number} offsetSec 从 chunk 音频头部裁掉的秒数（迟到）
 * @property {number} skipSamples 从源音频跳过的采样数（起播点 / 重叠）
 * @property {number} contentStartSec 实际发声内容起点（分片绝对秒）
 * @property {number} contentEndSec chunk 内容末端（分片绝对秒）
 * @property {number} durationSec 剩余可播时长
 * @property {Array<{skipSamples:number,when:number,offsetSec:number,durationSec:number,contentStartSec:number,contentEndSec:number}>} segments
 *   实际要排程的片段（通常一段；块被已排区间切成多段时逐段排，避免静默丢音频）
 * @property {number} [splitParts] 该块被已排程区间切成了几段
 */

export class StreamTimeline {
  /**
   * @param {{startPositionSec?: number, firstNoteStartSec?: number, leadSec?: number}} [opts]
   */
  constructor({ startPositionSec = 0, firstNoteStartSec = 0, leadSec = STREAM_LEAD_SEC } = {}) {
    this.startPositionSec = Math.max(0, Number(startPositionSec) || 0);
    this.firstNoteStartSec = Math.max(0, Number(firstNoteStartSec) || 0);
    this.leadSec = Number.isFinite(leadSec) ? leadSec : STREAM_LEAD_SEC;
    /** 内容位置 startPositionSec 对应的 ctx 时刻；未起播为 null。 */
    this.anchorCtxTime = null;
    /** 已排程内容的最远末端（分片绝对秒）—— 收尾判定 / UI 前沿用。 */
    this.deliveredEndSec = this.startPositionSec;
    /** 已排程内容区间 [{start,end}]，升序且互不重叠（乱序回填 / 去重的判据）。 */
    this.coveredRanges = [];
    /** 无 sampleOffset 时的顺序拼接游标（相对首音符）。 */
    this.seqCursorSec = 0;
    /** 已排程块数 / 丢弃块数 / 迟到块数 / 乱序回填块数（诊断用）。 */
    this.scheduledCount = 0;
    this.droppedCount = 0;
    this.lateCount = 0;
    this.backfillCount = 0;
  }

  /** 时间基准是否已建立（= 是否已经开始出声）。 */
  get started() {
    return this.anchorCtxTime !== null;
  }

  /**
   * 把 chunk 换算成内容区间。
   *
   * 采样位置无效（旧版主进程 / 插件后端不带 sampleOffset）时退化为顺序拼接：
   * 接在已交付内容之后。游标"收到即前进"（含随后被丢弃的块），保证每块只占
   * 一次位，否则后续块会被重复裁头。
   *
   * @param {{sampleOffset?: number, sampleEnd?: number, audio?: Float32Array}} chunkInfo
   * @param {number} sampleRate
   * @returns {{contentStartSec:number, contentEndSec:number, durationSec:number, hasSampleRange:boolean}}
   */
  _contentRange(chunkInfo, sampleRate) {
    const audioLength = chunkInfo && chunkInfo.audio ? chunkInfo.audio.length : 0;
    const rawStart = Number(chunkInfo && chunkInfo.sampleOffset);
    const rawEnd = Number(chunkInfo && chunkInfo.sampleEnd);
    const hasSampleRange = Number.isFinite(rawStart) && Number.isFinite(rawEnd) && rawEnd > rawStart;
    const chunkSec = audioLength / sampleRate;
    const relStartSec = hasSampleRange ? rawStart / sampleRate : this.seqCursorSec;
    const relEndSec = hasSampleRange ? rawEnd / sampleRate : relStartSec + chunkSec;
    if (!hasSampleRange) this.seqCursorSec = relEndSec;
    return {
      contentStartSec: this.firstNoteStartSec + relStartSec,
      contentEndSec: this.firstNoteStartSec + relEndSec,
      durationSec: chunkSec,
      hasSampleRange,
    };
  }

  /**
   * 把已排程区间 [from, to) 记入账本（与相邻区间合并）。
   * 只增不减：区间代表"这段时间轴已经被占用"，与是否真的播完无关。
   *
   * @param {number} from
   * @param {number} to
   */
  _cover(from, to) {
    if (!(to > from)) return;
    const ranges = this.coveredRanges;
    let i = 0;
    while (i < ranges.length && ranges[i].end < from) i++;
    let start = from;
    let end = to;
    let j = i;
    while (j < ranges.length && ranges[j].start <= end) {
      start = Math.min(start, ranges[j].start);
      end = Math.max(end, ranges[j].end);
      j++;
    }
    ranges.splice(i, j - i, { start, end });
    this.deliveredEndSec = Math.max(this.deliveredEndSec, end);
  }

  /**
   * 求 [from, to) 中**尚未被占用**的片段（升序）。
   *
   * 这是"乱序回填"的关键：后段先到时只登记自己的区间，前段随后到达仍能看到
   * 一段空白并原样排进去。若改用单一前沿（旧的 deliveredEndSec），前段会被
   * 整块当成重复丢掉 —— 表现为"偶发缺一句、播放头照走"。
   *
   * @param {number} from
   * @param {number} to
   * @returns {Array<{start:number,end:number}>}
   */
  _uncoveredParts(from, to) {
    const parts = [];
    let cursor = from;
    for (const r of this.coveredRanges) {
      if (r.end <= cursor) continue;
      if (r.start >= to) break;
      if (r.start > cursor) parts.push({ start: cursor, end: Math.min(r.start, to) });
      cursor = Math.max(cursor, r.end);
      if (cursor >= to) break;
    }
    if (cursor < to) parts.push({ start: cursor, end: to });
    return parts;
  }

  /**
   * 规划一个 chunk。
   *
   * @param {{sampleOffset?: number, sampleEnd?: number, audio?: Float32Array}} chunkInfo
   * @param {number} sampleRate
   * @param {number} ctxNow 当前 `ctx.currentTime`
   * @returns {StreamChunkPlan}
   */
  plan(chunkInfo, sampleRate, ctxNow, opts = {}) {
    // reserve=false：先把排程方案算出来但不记账。调用方（_handleChunk）必须
    // 在 source.start() 真正成功后再 commit —— 否则 start 失败也会留下
    // coveredRanges 占位，后续重传被判重复 → 永久静音。单测直接调 plan()
    // 时保持默认 reserve=true，既有契约不变。
    const reserve = opts.reserve !== false;
    const audioLength = chunkInfo && chunkInfo.audio ? chunkInfo.audio.length : 0;
    if (audioLength <= 0) {
      this.droppedCount += 1;
      return this._drop('empty');
    }

    const { contentStartSec, contentEndSec } = this._contentRange(chunkInfo, sampleRate);
    const fromSec = Math.max(contentStartSec, this.startPositionSec);
    const deliveredBeforeSec = this.deliveredEndSec;
    const parts = this._uncoveredParts(fromSec, contentEndSec);

    if (parts.length === 0) {
      // 整块都在起播点之前 / 已被前一块覆盖：丢弃。**不建立时间基准** ——
      // 否则后续块会被按"从首个收到块算起"的迟到量裁头。
      const reason = contentEndSec <= this.startPositionSec + EPS_SEC ? 'before-start' : 'duplicate';
      this.droppedCount += 1;
      return this._drop(reason);
    }

    // 到这里说明这一块"应该出声"（或至少部分落在起播点之后），此刻才锚定。
    const startedNow = !this.started;
    if (startedNow) this.anchorCtxTime = ctxNow + this.leadSec;

    // 一个块被已排程区间切成多段时逐段排程 —— 少排一段就是静默丢一句歌词，
    // 而 WebAudio 完全支持同一块音频按不同 offset 排多个 source。
    const segments = [];
    let scheduledEndSec = 0;
    for (const part of parts) {
      const skipSamples = Math.max(0, Math.round((part.start - contentStartSec) * sampleRate));
      const availableSamples = audioLength - skipSamples;
      if (availableSamples <= 0) continue;
      // 只播到本段末端（被后面的已排区间截断时不能越界播放）。
      const durSec = Math.min(availableSamples / sampleRate, part.end - part.start);
      if (durSec <= EPS_SEC) continue;

      // 内容位置 X 应在 anchor + (X − startPosition) 出声。
      const wantCtxTime = this.anchorCtxTime + (part.start - this.startPositionSec);
      // 迟到只裁头、不移基准：把这部分从头部裁掉，内容位置始终等于播放头位置。
      const lateSec = Math.max(0, ctxNow - wantCtxTime);
      if (lateSec >= durSec - EPS_SEC) {
        this.lateCount += 1;
        continue;
      }
      segments.push({
        skipSamples,
        when: wantCtxTime + lateSec,
        offsetSec: lateSec,
        durationSec: durSec - lateSec,
        // 该段完整长度（未扣迟到）。排程时按它切片、用 offsetSec 表示迟到裁头；
        // 若按 durationSec 切片再传 offsetSec，late 会被扣两次（尾部被吃掉）。
        sourceDurationSec: durSec,
        contentStartSec: part.start,
        contentEndSec: part.start + durSec,
      });
      scheduledEndSec = Math.max(scheduledEndSec, part.start + durSec);
    }

    if (segments.length === 0) {
      this.droppedCount += 1;
      // 丢掉整块但保留基准：基准代表时间轴原点，丢了它下一块会重新锚定，
      // 播放头会凭空回跳。
      return this._drop('late', startedNow);
    }

    if (reserve) this._commitPlan(fromSec, segments, startedNow, deliveredBeforeSec);

    const first = segments[0];
    return {
      action: 'schedule',
      fromSec,
      deliveredBeforeSec,
      startedNow,
      // 以下字段是"第一段"的等价描述（兼容既有调用方 / 测试）。
      when: first.when,
      offsetSec: first.offsetSec,
      skipSamples: first.skipSamples,
      contentStartSec: first.contentStartSec,
      contentEndSec: scheduledEndSec,
      durationSec: first.durationSec,
      segments,
      splitParts: parts.length,
    };
  }

  /** 给 plan(reserve:false) 的调用方补记账：只登记真正启动成功的段。 */
  commit(plan, startedSegments) {
    if (!plan || plan.action !== 'schedule' || !plan.segments) return;
    if (!Array.isArray(startedSegments) || startedSegments.length === 0) return;
    this._commitPlan(plan.fromSec, startedSegments, plan.startedNow, plan.deliveredBeforeSec);
  }

  _commitPlan(fromSec, segments, startedNow, deliveredBeforeSec) {
    let endSec = 0;
    for (const s of segments) {
      // 每段只登记自己的区间：块被切成多段时，中间的空洞不能被一并标记覆盖。
      this._cover(s.contentStartSec, s.contentEndSec);
      endSec = Math.max(endSec, s.contentEndSec);
    }
    if (endSec > 0) this.deliveredEndSec = Math.max(this.deliveredEndSec, endSec);
    this.scheduledCount += 1;
    if (segments.some((s) => s.offsetSec > 0)) this.lateCount += 1;
    // 乱序回填 = 排到了"已交付末端之前"的位置（后段先到、前段后到）。
    if (!startedNow && fromSec + EPS_SEC < deliveredBeforeSec) this.backfillCount += 1;
  }

  _drop(reason, startedNow = false) {
    return {
      action: 'drop',
      reason,
      startedNow,
      when: 0,
      offsetSec: 0,
      skipSamples: 0,
      contentStartSec: 0,
      contentEndSec: 0,
      durationSec: 0,
      segments: [],
    };
  }

  /**
   * 当前应显示的播放位置（分片绝对秒）。
   *
   * @param {number} ctxNow 当前 `ctx.currentTime`
   * @param {number} latencySec 设备输出延迟（人耳位置 = 渲染位置 − 延迟）
   */
  positionAt(ctxNow, latencySec = 0) {
    if (!this.started) return this.startPositionSec;
    const audible = ctxNow - (Number.isFinite(latencySec) ? latencySec : 0);
    return this.startPositionSec + Math.max(0, audible - this.anchorCtxTime);
  }
}

export default StreamTimeline;
````

### R5 · 编辑后自动实时推理（后台分段合成，不流式推送）

文件：`src/fragmentEditor/autoInference.js`　行：`1-144`

````javascript
import {
  getFragmentAudioSettings,
  getFragmentCurrentTime,
  getFragmentAudioDataSignature,
  getDragMode,
  getCurrentFragment,
} from './state.js';
import {
  loadFragmentAudioSettings,
  computeFragmentAudioSignature,
  synthesizeFragmentInBackground,
} from './audioPlayback.js';

// ==================== 编辑后自动实时推理 ====================
//
// 由设置项 `autoRealtimeInference` 控制，默认关闭（见 src/main/settings.js）。
//
// 设计要点：
// 1) 变更检测：轮询比对"当前合成输入签名"与"上次合成成功时的签名"。签名由
//    audioPlayback.computeFragmentAudioSignature() 计算，覆盖 notes 内容
//    （歌词/音高/时值/滑音/音素微调/颤音）、bpm、pitchCurveF0、参考音频、
//    autoShift、singerId 与预览推理参数 —— 即任何会改变输出音频的编辑。
// 2) 防抖：拖拽音符/画笔拉曲线期间不做任何重活，内容稳定 DEBOUNCE_MS 后才触发。
// 3) 分段兼容：真正的"只推理改动分段"由主进程的分片级缓存完成
//    （OnnxSVSPipeline._segCacheMap）：未改动 segment 的缓存键不变 → 直接命中，
//    跳过 diffusion+vocoder。这里刻意不触碰任何清缓存路径。
// 4) 优先次序：把播放进度条位置作为 priorityTimeSec 传给主进程，主进程据此决定
//    多 segment 的推理遍历起点；缺失时退化为"第一个未命中缓存的分段"。

// 签名轮询间隔（ms）。远小于一次推理耗时，用于及时感知"停下来了"。
// 理想做法是在编辑事件里直接标 dirty，但编辑入口分散在 eventHandlers /
// canvasRenderer / uiControls / 自动化接口等多处（无统一 mutation 事件），
// 逐个埋点容易漏；这里保留 400ms 轮询（签名计算只是浅比较，开销可忽略），
// 配合下方 DEBOUNCE_MS 保证停止编辑后约 1.3s 内开始推理。
// 注：曾试过降到 1000ms，但叠加 900ms 防抖后启动延迟可达 1.9s，
// 连续编辑时的"停顿即生成"手感明显变差，故维持 400ms。
const POLL_INTERVAL_MS = 400;
// 内容稳定多久后才真正开始推理（ms）。避免拖拽/连续输入过程中反复触发。
const DEBOUNCE_MS = 900;
// 设置拉取间隔（ms）。设置窗口可能在分片编辑器打开期间随时开关此功能。
const SETTINGS_REFRESH_MS = 3000;
// 推理失败后的冷却时间（ms），避免模型缺失/显存不足时每秒重试。
const ERROR_COOLDOWN_MS = 15000;

let _pollTimer = null;
let _debounceTimer = null;
let _pendingSignature = null;
let _settingsRefreshedAt = 0;
let _blockedUntil = 0;
let _running = false;

function _isEnabled() {
  return getFragmentAudioSettings()?.autoRealtimeInference === true;
}

async function _refreshSettingsIfStale() {
  const now = Date.now();
  if (now - _settingsRefreshedAt < SETTINGS_REFRESH_MS) return;
  _settingsRefreshedAt = now;
  try {
    await loadFragmentAudioSettings();
  } catch (_) {
    // 拉取失败：保持上一次的设置快照，下个周期再试
  }
}

function _scheduleWithDebounce() {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    void _runPending();
  }, DEBOUNCE_MS);
}

async function _runPending() {
  if (_running) return;
  if (Date.now() < _blockedUntil) return;
  if (!_isEnabled() || !getCurrentFragment()) return;
  // 拖拽过程中不抢占 GPU/显存，等下一轮轮询再决策。
  if (getDragMode() !== null) return;

  // 异步间隙里状态可能已变（用户手动播放同步了音频 / 内容又被改动），
  // 一律放弃本次后台推理，让下次检测重新决策。
  const lastSynth = getFragmentAudioDataSignature();
  if (lastSynth === null) return;
  const pending = _pendingSignature;
  if (!pending || pending === lastSynth) return;

  _running = true;
  try {
    // 优先推理播放进度条所在分段：fragmentCurrentTime 是相对分片起点的秒数，
    // 与 pipeline 中 segment 的绝对时间坐标系一致。
    const result = await synthesizeFragmentInBackground({ priorityTimeSec: getFragmentCurrentTime() });
    // 只有真正的推理失败（模型缺失 / 显存不足等）才进入冷却；
    // 'skip' 是主动放弃（用户接管播放、内容又变了等），下一次轮询会自然重试。
    if (result === 'error') {
      _blockedUntil = Date.now() + ERROR_COOLDOWN_MS;
    }
  } finally {
    _running = false;
  }
}

async function _tick() {
  try {
    await _refreshSettingsIfStale();
    if (!_isEnabled()) return;
    if (!getCurrentFragment()) return;

    const sig = computeFragmentAudioSignature();
    // 与已合成版本一致 → 没有需要追赶的改动
    if (sig === getFragmentAudioDataSignature()) return;
    // 同一份内容已在防抖等待中 → 重置计时即可（内容又动了一次）
    if (sig === _pendingSignature && _debounceTimer) return;

    _pendingSignature = sig;
    _scheduleWithDebounce();
  } catch (_) {
    // 签名计算失败（如 DOM 尚未就绪 / fragment 未加载）直接跳过本轮
  }
}

/**
 * 启动自动推理监听。幂等，可重复调用。
 * 建议在分片数据加载完成之后调用；在此之前 getCurrentFragment() 为空会直接空转。
 */
export function startAutoInferenceWatcher() {
  if (_pollTimer) return;
  _settingsRefreshedAt = 0;
  _pollTimer = setInterval(() => { void _tick(); }, POLL_INTERVAL_MS);
}

/** 停止监听（窗口关闭 / 切换分片时调用）。 */
export function stopAutoInferenceWatcher() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  _pendingSignature = null;
}
````

### R6 · 播放/合成相关模块级状态

文件：`src/fragmentEditor/state.js`　行：`4-36`

````javascript
let SAMPLE_RATE = 24000;
let pipelineInitialized = false;
let pipelineInitPromise = null;

let fragmentAudioContext = null;
let fragmentAudioSource = null;
let fragmentAudioData = null;
let fragmentIsPlaying = false;
let fragmentIsSynthesizing = false;
// 合成任务 token：fragmentIsSynthesizing 的所有者。播放 session 被 seek/stop
// dispose 后，该任务仍可能在跑；只有 token 匹配的任务才有权清合成状态。
let fragmentSynthesisId = null;
let fragmentSynthesisProgress = null;
const _playheadDragWaiters = new Set();
let fragmentPlayheadDragging = false;
// 后台自动推理进行中（编辑后自动实时推理）。与 fragmentIsSynthesizing 互斥概念：
// 它不代表用户主动等待的结果，因此不会禁用播放按钮，也不参与 playFragment 的重入保护。
let fragmentIsAutoInferring = false;
let fragmentIsExporting = false;
let fragmentPlaybackStartTime = 0;
let fragmentPlaybackOffset = 0;
let fragmentPlayheadRaf = null;
let fragmentCurrentTime = 0;
let fragmentGainNode = null;
// 用户拖拽 playhead 设置的播放起始位置（秒）。
// playFragment 时从此位置开始播放；0 表示从头播放。
let fragmentPlayStartPosition = 0;
// 上一次合成时 notes 的签名（用于判断 fragmentAudioData 是否可复用）。
// 当 notes 发生变化时置 null，强制下次 playFragment 重新合成。
let fragmentAudioDataSignature = null;
let fragmentUseExclusiveMode = false;
let fragmentExclusiveRaf = null;
let fragmentAudioSettings = null;
````

### R7 · 播放/合成状态访问器（token 所有权）

文件：`src/fragmentEditor/state.js`　行：`176-268`

````javascript
// ---- Getters/Setters ----

export function getSampleRate() { return SAMPLE_RATE; }
export function setSampleRate(v) { SAMPLE_RATE = v; }

export function getPipelineInitialized() { return pipelineInitialized; }
export function setPipelineInitialized(v) { pipelineInitialized = v; }

export function getPipelineInitPromise() { return pipelineInitPromise; }
export function setPipelineInitPromise(v) { pipelineInitPromise = v; }

export function getFragmentAudioContext() { return fragmentAudioContext; }
export function setFragmentAudioContext(v) { fragmentAudioContext = v; }

export function getFragmentAudioSource() { return fragmentAudioSource; }
export function setFragmentAudioSource(v) { fragmentAudioSource = v; }

export function getFragmentAudioData() { return fragmentAudioData; }
export function setFragmentAudioData(v) { fragmentAudioData = v; }

export function getFragmentIsPlaying() { return fragmentIsPlaying; }
export function setFragmentIsPlaying(v) { fragmentIsPlaying = v; }

export function getFragmentIsSynthesizing() { return fragmentIsSynthesizing; }
export function setFragmentIsSynthesizing(v) { fragmentIsSynthesizing = v; }

/** 开始/结束合成任务：id 必须是唯一 token（当前直接用 streamId）。 */
export function beginFragmentSynthesis(id) {
  fragmentSynthesisId = id;
  fragmentIsSynthesizing = true;
  fragmentSynthesisProgress = null;
}
export function finishFragmentSynthesis(id) {
  if (fragmentSynthesisId !== id) return false;
  fragmentSynthesisId = null;
  fragmentIsSynthesizing = false;
  fragmentSynthesisProgress = null;
  return true;
}
export function getFragmentSynthesisId() { return fragmentSynthesisId; }
export function setFragmentSynthesisProgress(v) { fragmentSynthesisProgress = v; }
export function getFragmentSynthesisProgress() { return fragmentSynthesisProgress; }

/** 播放头拖拽状态：合成完成时若仍在拖拽，先等最终位置落定再起播。 */
export function setFragmentPlayheadDragging(v) {
  if (fragmentPlayheadDragging === v) return;
  fragmentPlayheadDragging = v;
  if (!v) {
    for (const resolve of _playheadDragWaiters) resolve();
    _playheadDragWaiters.clear();
  }
}
export function isFragmentPlayheadDragging() { return fragmentPlayheadDragging; }
export function waitForFragmentPlayheadDragEnd() {
  if (!fragmentPlayheadDragging) return Promise.resolve();
  return new Promise((resolve) => _playheadDragWaiters.add(resolve));
}

export function getFragmentIsAutoInferring() { return fragmentIsAutoInferring; }
export function setFragmentIsAutoInferring(v) { fragmentIsAutoInferring = v; }

export function getFragmentIsExporting() { return fragmentIsExporting; }
export function setFragmentIsExporting(v) { fragmentIsExporting = v; }

export function getFragmentPlaybackStartTime() { return fragmentPlaybackStartTime; }
export function setFragmentPlaybackStartTime(v) { fragmentPlaybackStartTime = v; }

export function getFragmentPlaybackOffset() { return fragmentPlaybackOffset; }
export function setFragmentPlaybackOffset(v) { fragmentPlaybackOffset = v; }

export function getFragmentPlayheadRaf() { return fragmentPlayheadRaf; }
export function setFragmentPlayheadRaf(v) { fragmentPlayheadRaf = v; }

export function getFragmentCurrentTime() { return fragmentCurrentTime; }
export function setFragmentCurrentTime(v) { fragmentCurrentTime = v; }

export function getFragmentGainNode() { return fragmentGainNode; }
export function setFragmentGainNode(v) { fragmentGainNode = v; }

export function getFragmentPlayStartPosition() { return fragmentPlayStartPosition; }
export function setFragmentPlayStartPosition(v) { fragmentPlayStartPosition = v; }

export function getFragmentAudioDataSignature() { return fragmentAudioDataSignature; }
export function setFragmentAudioDataSignature(v) { fragmentAudioDataSignature = v; }

export function getFragmentUseExclusiveMode() { return fragmentUseExclusiveMode; }
export function setFragmentUseExclusiveMode(v) { fragmentUseExclusiveMode = v; }

export function getFragmentExclusiveRaf() { return fragmentExclusiveRaf; }
export function setFragmentExclusiveRaf(v) { fragmentExclusiveRaf = v; }

export function getFragmentAudioSettings() { return fragmentAudioSettings; }
export function setFragmentAudioSettings(v) { fragmentAudioSettings = v; }
````

### R8 · underrun 调度器：前沿、suspend/resume、watchdog、完成判定

文件：`src/shared/streamingScheduler.js`　行：`1-384`

````javascript
/**
 * Shared streaming playback scheduler for chunk-based audio inference.
 *
 * Encapsulates:
 * - Buffer frontier tracking (furthest received audio position)
 * - AudioContext suspend/resume for underrun (freezes all sources + context clock)
 * - Watchdog timer for background underrun detection (rAF is suspended when
 *   the window is minimized/tab hidden, but WebAudio continues playing)
 * - Active source counting and completion detection (isLast + all sources ended)
 *
 * Callers (renderer, fragment editor) handle:
 * - Chunk source creation and scheduling (different coordinate systems)
 * - playbackStartTime adjustment during recovery
 * - UI updates (button text, playhead drawing)
 */

// suspend()/resume() 是异步控制消息：从发出到设备真正冻结时钟之间，渲染时钟照常
// 前进。提前量必须覆盖这段延迟，否则冻结点落在 buffer 前沿之后，晚到的 chunk 会
// 被按"迟到量"裁头 —— 每个接缝永久丢掉一段音频（静音缝 + 内容缺失）。
// 正常机器上这段延迟约 8ms，0.3s 提前量绰绰有余；GPU 被训练/nvcodec 抢占时
// 实测可达 300–500ms，固定提前量必然失效（见 docs/PLAYHEAD_STALL_REPORT.md）。
const WATCHDOG_TICK_MS = 250;
const MAX_UNDERRUN_MARGIN_SEC = 2.0;
// 观测到新延迟立即采信（快升）；旧延迟按此系数逐次衰减（缓降），
// 避免一次性尖峰把提前量永久钉死在大值上。
const SUSPEND_LATENCY_DECAY = 0.9;

// 延迟估计按 AudioContext 归属，而不是按 scheduler 实例：控制消息延迟是"这台
// 设备的音频栈在当前系统负载下"的属性，与播放会话无关。挂在实例上时每次重播都
// 要从零学起，第一个接缝必然再丢一次（换设备时 ctx 变化，估计自然作废）。
const _suspendLatencyByCtx = new WeakMap();

export class StreamingScheduler {
  /**
   * @param {Object} opts
   * @param {() => AudioContext} opts.getCtx - Returns the shared AudioContext
   * @param {() => number} opts.getElapsed - Returns current playback position in seconds
   * @param {(isWaiting: boolean) => void} [opts.onWaitStateChange] - Called when underrun wait starts/stops
   * @param {() => void} [opts.onFinish] - Called when all sources ended and isLast received
   * @param {number} [opts.watchdogMarginSec] - Safety margin (seconds) applied to the
   *   watchdog's underrun check. The watchdog ticks periodically (250ms), so by the
   *   time it observes the frontier the playhead has already overshot it. Freezing
   *   with a margin >= tick period means the freeze lands BEFORE the frontier: the
   *   next chunk's original schedule time is still in the future at resume, so
   *   playback continues with zero drift and zero overlap.
   *   This value is the FLOOR of the margin: the effective margin also grows with the
   *   measured AudioContext.suspend() commit latency (see requiredUnderrunMarginSec).
   * @param {() => number} [opts.getPacingFrontier] - Optional pacing frontier in
   *   seconds (defaults to bufferEndSec). Multi-stream playback (interleaved
   *   fragments/regions) MUST return the MINIMUM delivered end across all active
   *   streams: pacing by the max-end frontier lets a fast stream push the playhead
   *   past a slow stream's undelivered range, making the slow stream's chunks
   *   arrive "late" — which forces either shifted playback (overlap/drift) or
   *   head-trimming (content loss). Pacing by the min end keeps every stream
   *   lossless and drift-free; finished streams must be excluded (return Infinity
   *   for them).
   */
  constructor({ getCtx, getElapsed, onWaitStateChange, onFinish, watchdogMarginSec = 0, getPacingFrontier }) {
    this._getCtx = getCtx;
    this._getElapsed = getElapsed;
    this._onWaitStateChange = onWaitStateChange || (() => {});
    this._onFinish = onFinish || (() => {});
    this._watchdogMarginSec = watchdogMarginSec;
    this._getPacingFrontier = getPacingFrontier || null;

    this.bufferEndSec = 0;
    this.inferenceDone = false;
    this.isLastReceived = false;
    this.activeSourceCount = 0;
    // onFinish 的一次性标志：一轮会话只允许触发一次，直到下次 reset()。
    this._finished = false;

    this._active = false;
    this._waitingForInference = false;
    this._contextSuspended = false;
    this._suspendInFlight = null;
    this._resumeInFlight = null;
    // 解冻是一次异步状态转换：在它真正完成前清掉 waiting，会让 rAF/drain
    // 再次 checkUnderrun() 进入新的 suspend，与在途 resume 交错。
    this._resumeTransition = null;
    this._watchdogTimer = null;
  }

  get isWaiting() { return this._waitingForInference; }

  /** 已有一次 resume 正在落地（设备尚未真正解冻）——自愈路径据此不要重复发。 */
  get isResuming() { return !!this._resumeInFlight; }

  /** 当前设备实测的 suspend 控制消息落地延迟（秒）。 */
  _suspendLatencySec() {
    const ctx = this._getCtx();
    return ctx ? (_suspendLatencyByCtx.get(ctx) || 0) : 0;
  }

  /**
   * underrun 冻结提前量（秒）。调用方（rAF / watchdog）都应用它，而不是写死常量：
   * 提前量至少要覆盖 suspend 真正冻结时钟所需的控制消息延迟。
   *
   * @param {number} [allowanceSec] - 调用方自身的检测量化误差（rAF 一帧 ≈ 0.017s，
   *   watchdog 一个 tick = 0.25s）。
   */
  requiredUnderrunMarginSec(allowanceSec = 0) {
    const need = this._suspendLatencySec() + allowanceSec;
    return Math.min(MAX_UNDERRUN_MARGIN_SEC, Math.max(this._watchdogMarginSec, need));
  }

  /**
   * 等 suspend 真正落地（时钟已冻结）。chunk 回调必须在读 ctx.currentTime 计算
   * 迟到量之前调用它：in-flight 期间时钟仍在走，直接读会把"控制消息还没送到"
   * 误判成"内容迟到了"，从而裁掉本来没迟的音频头。
   */
  async awaitSuspendSettled() {
    if (this._suspendInFlight) {
      try { await this._suspendInFlight; } catch (_) {}
    }
  }

  updateBufferFrontier(endSec) {
    if (endSec > this.bufferEndSec) this.bufferEndSec = endSec;
  }

  addSource() { this.activeSourceCount++; }

  sourceEnded() {
    // 下界钳制：onended 重复触发（或跨会话残留 source）不能把计数压成负数，
    // 否则 _checkCompletion 的 "<= 0" 判断会把「还有源在播」误判为「全部结束」。
    if (this.activeSourceCount > 0) this.activeSourceCount--;
    this._checkCompletion();
  }

  markLastReceived() {
    this.isLastReceived = true;
    this._checkCompletion();
  }

  /**
   * Detect buffer underrun: playhead has caught up to the buffer frontier
   * (minus an optional safety margin) and inference is not yet complete.
   * Freezes AudioContext.
   *
   * @param {number} elapsed - Current playback position in seconds
   * @param {() => void} [onEnterWait] - Called when entering wait state (e.g., cancel rAF, update UI)
   * @param {number} [marginSec] - Enter the wait this many seconds BEFORE the
   *   frontier. Freezing early keeps the late chunk's original schedule time in
   *   the future, so recovery needs no content trimming at all. Callers with
   *   coarse detection latency (watchdog tick) should pass a margin >= their
   *   latency; frame-accurate callers (rAF) can pass 0.
   * @returns {boolean} true if wait state was entered (caller must return from its loop)
   */
  checkUnderrun(elapsed, onEnterWait, marginSec = 0) {
    if (this.inferenceDone || this._waitingForInference) return false;
    // 正在解冻时不能启动新的冻结转换，否则 context 最终状态与 waiting 撕裂。
    if (this._resumeTransition || this._resumeInFlight) return false;
    // 尚未收到任何音频：没有可判断的前沿。此时 elapsed 可能来自上一轮
    // 播放遗留的 playbackStartTime（垃圾值），绝不能据此冻结 context，
    // 否则首 chunk 到达前 context 就被挂起，后续调度时序全部错乱。
    if (this.bufferEndSec <= 0) return false;
    const pacingFrontier = this._getPacingFrontier ? this._getPacingFrontier() : this.bufferEndSec;
    if (elapsed < pacingFrontier - marginSec) return false;
    this._waitingForInference = true;
    this._onWaitStateChange(true);
    void this._suspendContext();
    if (onEnterWait) onEnterWait();
    return true;
  }

  /**
   * Called when a chunk arrives after underrun. Resumes AudioContext if it was
   * suspended. Returns true if recovery happened (caller should adjust
   * playbackStartTime and restart rAF).
   */
  async resumeFromWait() {
    if (!this._waitingForInference) return false;
    if (this._resumeTransition) {
      await this._resumeTransition;
      return true;
    }
    const p = (async () => {
      // 先等 suspend 真正落地、context 真正 running，再清 waiting：
      // 否则这中间的 checkUnderrun 会再次进入冻结。
      await this._resumeContext();
      this._waitingForInference = false;
      this._onWaitStateChange(false);
    })();
    this._resumeTransition = p;
    try {
      await p;
    } finally {
      if (this._resumeTransition === p) this._resumeTransition = null;
    }
    return true;
  }

  /**
   * 所有已排程 source 都已播完（由 source.onended 调用）—— underrun 的最后一道
   * 防线，**不依赖 rAF / 定时器**。
   *
   * 为什么必须有：窗口最小化或被完全遮挡时，Chromium 把 rAF 与 250ms 看门狗
   * 一起节流到约 1 次/分钟。若此刻推理还没送来下一块，播放头会在无人冻结的
   * 情况下冲过缓冲前沿；之后到达的每一块都按"迟到"裁头甚至整块丢弃，听感是
   * "从这里开始再也没有声音"，只有点播放头/重播（新建会话重新锚定）才恢复。
   * source.onended 由音频线程在缓冲播完的瞬间触发，不受后台定时器节流影响 ——
   * 它给出最后一个"时钟还停在前沿"的窗口，此时冻结不会丢任何内容。
   *
   * @param {() => void} [onEnterWait] - 进入等待时的 UI 回调（如重绘）
   * @returns {boolean} 是否进入了等待冻结
   */
  onSourcesDrained(onEnterWait) {
    if (!this._active) return false;
    if (this.inferenceDone || this.isLastReceived) return false;
    if (this._waitingForInference) return false;
    if (this.activeSourceCount > 0) return false;
    if (this.bufferEndSec <= 0) return false;
    // onended 任务派发可能略晚于精确的前沿时刻；0.05s 容差保证仍能命中。
    return this.checkUnderrun(this._getElapsed(), onEnterWait, 0.05);
  }

  /**
   * Mark inference as done. No more underrun waits will be triggered.
   * If currently waiting, resumes the context.
   */
  async setInferenceDone() {
    this.inferenceDone = true;
    if (this._waitingForInference) {
      await this.resumeFromWait();
    }
  }

  /**
   * Start the streaming session's watchdog.
   *
   * **Non-destructive**: must NOT reset bufferEndSec / inferenceDone /
   * activeSourceCount. Callers activate on the first chunk that actually
   * sounds, which can be *after* the synthesis invoke already resolved
   * (cold AudioContext creation, cached-audio burst replay). Resetting there
   * wipes the already-set inferenceDone flag, so the final underrun freeze
   * has nobody left to resume it — playback dies before the end and the
   * playhead hangs forever. State is initialised in the constructor and only
   * cleared by an explicit reset() on a brand-new session.
   */
  activate() {
    this._active = true;
    this.startWatchdog();
  }

  /** End the streaming session (pause/stop/seek). Aborts context if suspended. */
  deactivate() {
    this._active = false;
    this._waitingForInference = false;
    this._clearWatchdog();
    if (this._contextSuspended || this._suspendInFlight) {
      void this._abortContext();
    }
  }

  /** Full reset of all state for a new streaming session. */
  reset() {
    this.bufferEndSec = 0;
    this.inferenceDone = false;
    this.isLastReceived = false;
    this.activeSourceCount = 0;
    this._finished = false;
    this._waitingForInference = false;
    this._contextSuspended = false;
    this._suspendInFlight = null;
    this._resumeInFlight = null;
    this._clearWatchdog();
  }

  // ==================== Watchdog ====================

  startWatchdog() {
    if (this._watchdogTimer) return;
    const tick = () => {
      if (!this._active) { this._watchdogTimer = null; return; }
      try {
        const elapsed = this._getElapsed();
        // 提前量含一个 tick 的量化误差：watchdog 看到前沿时播放头已经冲过去了。
        this.checkUnderrun(elapsed, undefined, this.requiredUnderrunMarginSec(WATCHDOG_TICK_MS / 1000));
      } catch (_) {}
      this._watchdogTimer = setTimeout(tick, WATCHDOG_TICK_MS);
    };
    this._watchdogTimer = setTimeout(tick, WATCHDOG_TICK_MS);
  }

  _clearWatchdog() {
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // ==================== AudioContext suspend/resume ====================

  async _suspendContext() {
    if (this._contextSuspended) return;
    const ctx = this._getCtx();
    if (ctx && ctx.state === 'running') {
      this._contextSuspended = true;
      const t0 = Date.now();
      const p = (async () => {
        try {
          await ctx.suspend();
        } catch (err) {
          // suspend 失败必须回退内部标志：否则后续 underrun 会认为已冻结
          // 而永远不再尝试，context 实际仍在 running。
          this._contextSuspended = false;
          console.warn('[StreamingScheduler] Failed to suspend context:', err.message);
          return;
        }
        // 观测"发出 suspend"到"设备真正冻结时钟"之间的控制消息延迟。
        const sec = Math.max(0, Date.now() - t0) / 1000;
        const prev = _suspendLatencyByCtx.get(ctx) || 0;
        _suspendLatencyByCtx.set(ctx, Math.max(sec, prev * SUSPEND_LATENCY_DECAY));
      })();
      this._suspendInFlight = p;
      try { await p; } finally {
        if (this._suspendInFlight === p) this._suspendInFlight = null;
      }
    }
  }

  async _resumeContext() {
    // 合并并发的解冻请求：resumeFromWait 与播放头自愈循环可能同一时刻各发一次
    // resume()，双倍控制消息只会加重排队（极端负载下实测每个接缝出现两次）。
    if (this._resumeInFlight) {
      try { await this._resumeInFlight; } catch (_) {}
      return;
    }
    if (!this._contextSuspended) return;
    if (this._suspendInFlight) {
      try { await this._suspendInFlight; } catch (_) {}
    }
    this._contextSuspended = false;
    const ctx = this._getCtx();
    const p = (async () => {
      if (ctx && ctx.state === 'suspended') {
        try {
          await ctx.resume();
          // 以真实 ctx.state 为准：resume() 返回成功也可能仍未真正恢复。
          this._contextSuspended = ctx.state === 'suspended';
        } catch (err) {
          // 失败时保持 suspended，让 watchdog 还能再试一次。
          this._contextSuspended = true;
          console.warn('[StreamingScheduler] Failed to resume context:', err.message);
        }
      } else {
        this._contextSuspended = ctx ? ctx.state === 'suspended' : false;
      }
    })();
    this._resumeInFlight = p;
    try { await p; } finally {
      if (this._resumeInFlight === p) this._resumeInFlight = null;
    }
  }

  async _abortContext() {
    this._waitingForInference = false;
    this._contextSuspended = false;
    const inflight = this._suspendInFlight;
    this._suspendInFlight = null;
    if (inflight) { try { await inflight; } catch (_) {} }
    // 已有 resume 在落地时不要第二次 resume()：等它，但等待后必须复查真实
    // 状态——resume 抛错或被拒绝时 context 仍可能停在 suspended。
    const resuming = this._resumeInFlight;
    if (resuming) { try { await resuming; } catch (_) {} }
    if (this._resumeTransition) {
      try { await this._resumeTransition; } catch (_) {}
    }
    const ctx = this._getCtx();
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (_) {}
    }
  }

  _checkCompletion() {
    // 一次性标志：onFinish 只允许触发一次，直到下次 reset()（新会话）。
    if (this._finished) return;
    if (this.isLastReceived && this.activeSourceCount <= 0) {
      this._finished = true;
      this._onFinish();
    }
  }
}
````

### R9 · 可听时钟与输出延迟补偿（仅显示域）

文件：`src/shared/audioOutputClock.js`　行：`1-92`

````javascript
/**
 * 音频输出时钟 —— 把 AudioContext 的"渲染时间"换算成"耳朵听到的时间"。
 *
 * Web Audio 的 ctx.currentTime 是渲染线程的位置：位于 currentTime 的声音还要
 * 经过设备缓冲（WASAPI 周期 + Chromium 内部队列）才到达喇叭，Windows 上实测
 * 比 currentTime 晚 20–120 ms；采样率与设备不一致时更长（本项目的 24 kHz 上下文
 * 跑在 48 kHz 设备上，还要过一次重采样）。
 *
 * 播放头/时间码若直接用 currentTime，指示器就会稳定地跑在声音**前面** ——
 * 这正是"播放进度条和实际播放位置轻微错位"的成因。
 * AudioContext.outputLatency 就是为这种音画同步场景准备的：它估计了"现在渲染
 * 的帧何时能被听到"。
 *
 * 使用边界（重要）：
 *   · 只用于**显示与人耳位置**：播放头、时间码、暂停/续播位置、hit test。
 *   · 调度域（source.start(when)、chunk 对齐、underrun 前沿、播放结束判定）
 *     必须继续用 ctx.currentTime，否则补偿量会被重复计入，音频真的与时间轴错开。
 */

/** 延迟估计上限：超过这个值视为异常读数（设备卡死/时钟回退），按 0 处理。 */
export const MAX_OUTPUT_LATENCY_SEC = 0.5;

/**
 * EMA 系数。设备延迟会随缓冲区状态小幅抖动，逐帧直接取新值会让播放头肉眼
 * 可见地跳动（2px 线在缩放后 1 ms ≈ 0.1 px 量级，抖动 20 ms 就是台阶）。
 * 0.2 ≈ 5 帧（~80 ms）收敛到新值，既跟得上设备切换，也不抖。
 */
const LATENCY_SMOOTHING = 0.2;

/** ctx -> 已平滑的延迟（秒）。WeakMap 让 AudioContext 关闭后自动释放。 */
const _latencyCache = new WeakMap();

function _clampLatency(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > MAX_OUTPUT_LATENCY_SEC ? MAX_OUTPUT_LATENCY_SEC : value;
}

/**
 * 未经平滑的输出延迟估计（秒）。
 * 优先 outputLatency（含设备缓冲），退化到 baseLatency（仅渲染图内部，
 * 会低估但比 0 更接近真相），都没有则返回 0（不做补偿）。
 */
export function estimateOutputLatencySec(ctx) {
  if (!ctx) return 0;
  if (Number.isFinite(ctx.outputLatency) && ctx.outputLatency > 0) {
    return _clampLatency(ctx.outputLatency);
  }
  if (Number.isFinite(ctx.baseLatency) && ctx.baseLatency > 0) {
    return _clampLatency(ctx.baseLatency);
  }
  return 0;
}

/** 平滑后的输出延迟估计（秒），同一 ctx 上跨帧共享。 */
export function getOutputLatencySec(ctx) {
  if (!ctx) return 0;
  const raw = estimateOutputLatencySec(ctx);
  const prev = _latencyCache.get(ctx);
  if (prev === undefined) {
    _latencyCache.set(ctx, raw);
    return raw;
  }
  // 设备延迟瞬间跳到 0（例如设备切换的中间态）时不跟随回落，
  // 只按 EMA 慢慢收敛，避免播放头在半秒内来回抽动。
  const next = prev + (raw - prev) * LATENCY_SMOOTHING;
  _latencyCache.set(ctx, next);
  return next;
}

/**
 * 当前"正在播出"的 AudioContext 时间（秒）。
 * 用它替换 ctx.currentTime 即可得到人耳位置；调度代码不要用它。
 */
export function getAudibleContextTime(ctx) {
  if (!ctx) return 0;
  return ctx.currentTime - getOutputLatencySec(ctx);
}

/**
 * 以 playbackStartTime 为基准的可听播放位置（秒），下限截到 0。
 * 起播瞬间 currentTime 还没走完输出延迟，可听位置是负值 —— 显示 0 才对
 * （此刻确实还没声音）。
 */
export function getAudibleElapsedSec(ctx, playbackStartTime) {
  if (!ctx || !Number.isFinite(playbackStartTime)) return 0;
  return Math.max(0, getAudibleContextTime(ctx) - playbackStartTime);
}

/** 仅供测试：清空某个 ctx 的平滑状态。 */
export function _resetOutputLatencyCache(ctx) {
  if (ctx) _latencyCache.delete(ctx);
}
````

### R10 · 有序 chunk 队列（当前内置管线主路径未启用，保留给插件/重排）

文件：`src/shared/sequencedChunkQueue.js`　行：`1-237`

````javascript
/**
 * SequencedChunkQueue —— 分片/流式音频 chunk 的有序交付队列。
 *
 * 当前定位（2026-11 合并后）：**不在分片编辑器的播放主路径上**。
 * 内置管线的 chunk 在构造上连续、单调、无重叠（`_createSegmentStreamEmitter`
 * 的 frontier 单调 + tryEmit break），实测 94/94 全部走"正好接续"，队列是直通；
 * 而按序交付要等缺口 100ms，只会平白增加起播延迟。乱序/切开两种情况已由
 * `src/fragmentEditor/playbackTimeline.js` 的已排程区间账本（coveredRanges）
 * 以零额外延迟覆盖。本模块保留给：插件后端可能发出非连续区间时的可选前置
 * 重排，以及 `rebase()` 为"流式 seek 复用已缓冲 chunk"预留的 parking 能力。
 * 取舍与验证数据见 docs/STREAM_CHUNK_FIX_REPORT.md 第九节。
 *
 * 借鉴 kizuna-ai-lab/sokuji 的 ModernAudioPlayer 序列排序实现，但做了关键适配：
 *   · sokuji 是网络实时流，chunk 带整数 sequenceNumber，序号 +1 即"下一个"；
 *   · 本项目的 chunk 来自本地 GPU 推理，带绝对采样区间 {sampleOffset, sampleEnd}，
 *     chunk 长度可变（vocoder 分块 + 静音 gap + segment overlap），不存在固定 +1。
 *
 * 因此这里用「采样前沿 frontier」代替整数序号，三态语义一一对应：
 *   1) 正好接续  start <= frontier + tol  → 立即交付，随后冲刷缓冲里的连续块；
 *   2) 超前(缺口) start >  frontier + tol  → 暂存 out-of-order + 启动 gap 超时；
 *   3) 重复/过时  end   <= frontier + tol  → 丢弃（整块已被前沿覆盖）。
 *
 * 兜底：gap 超时（默认 100ms）后按 sampleOffset 排序强制交付所有暂存块，并
 * "跳跃式"把 frontier 更新到最后一块的 sampleEnd —— 承认缺口不可弥补、让播放
 * 继续，而不是让播放头永久卡在静音等待（对应 sokuji _forceProcessBufferedSequences）。
 *
 * seek：rebase(target) 采用 moq "parking the playhead" 思想——不销毁缓冲/上下文，
 * 而是跳跃式重锚 frontier 到目标采样位置，丢弃目标之前的块、保留之后的块，
 * 让已到达的"未来"chunk 在 seek 后仍能接续消费。
 *
 * 零依赖：既可被渲染进程 require/import，也可被 Node 直接单测。
 * 计时器可注入（setTimer/clearTimer），便于虚拟时钟确定性测试。
 */

class SequencedChunkQueue {
  /**
   * @param {Object} [opts]
   * @param {(chunkInfo:Object)=>void} opts.onChunk - 有序交付回调（真正消费/排程播放）
   * @param {number} [opts.gapTimeoutMs=100] - 缺口兜底超时（毫秒）
   * @param {number} [opts.toleranceSamples=0] - 采样取整容差（衔接判定用）
   * @param {(info:Object)=>void} [opts.onGap] - 缺口触发诊断回调
   * @param {(chunk:Object, reason:string)=>void} [opts.onDuplicate] - 丢弃重复/过时块回调
   * @param {(chunk:Object, gapSamples:number)=>void} [opts.onOutOfOrder] - 暂存乱序块回调
   * @param {()=>number} [opts.now] - 时钟（毫秒），便于测试
   * @param {(fn:Function, ms:number)=>*} [opts.setTimer] - 定时器设置（注入）
   * @param {(id:*)=>void} [opts.clearTimer] - 定时器清除（注入）
   */
  constructor(opts = {}) {
    this.gapTimeoutMs = Number.isFinite(opts.gapTimeoutMs) ? opts.gapTimeoutMs : 100;
    this.toleranceSamples = Number.isFinite(opts.toleranceSamples) ? opts.toleranceSamples : 0;
    this.onChunk = opts.onChunk || (() => {});
    this.onGap = opts.onGap || (() => {});
    this.onDuplicate = opts.onDuplicate || (() => {});
    this.onOutOfOrder = opts.onOutOfOrder || (() => {});
    this._now = opts.now || (() => Date.now());
    this._setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = opts.clearTimer || ((id) => clearTimeout(id));
    this.reset(0);
  }

  /** 新会话/重播：清空前沿、缓冲与定时器。 */
  reset(frontier = 0) {
    // 未触发的兜底定时器必须真正取消：只把句柄置 null 会让它活到下一轮会话，
    // 到期后强制冲刷新会话的缓冲并跳跃前沿（停止→重播时的跨会话污染）。
    this._clearGapTimer();
    this.frontier = Number.isFinite(frontier) ? frontier : 0;
    this.buffer = new Map();          // sampleOffset -> chunkInfo
    this._finished = false;
    this._stats = {
      received: 0, consumed: 0, duplicate: 0,
      outOfOrder: 0, forced: 0, gaps: 0,
    };
  }

  get size() { return this.buffer.size; }
  get isFinished() { return this._finished; }

  _armGapTimer() {
    if (this._gapTimer != null) this._clearTimer(this._gapTimer);
    this._gapTimer = this._setTimer(() => {
      this._gapTimer = null;
      this._forceFlush('timeout');
    }, this.gapTimeoutMs);
  }

  _clearGapTimer() {
    if (this._gapTimer != null) {
      this._clearTimer(this._gapTimer);
      this._gapTimer = null;
    }
  }

  /**
   * 推入一个 chunk。返回处理分支标识，便于诊断/测试。
   * @param {Object} chunkInfo - { sampleOffset, sampleEnd, audio, isLast, ... }
   */
  push(chunkInfo) {
    if (!chunkInfo || !chunkInfo.audio || chunkInfo.audio.length === 0) return 'empty';
    this._stats.received++;

    const start = Number(chunkInfo.sampleOffset);
    const end = Number(chunkInfo.sampleEnd);
    const hasRange = Number.isFinite(start) && Number.isFinite(end) && end > start;

    // 无采样区间（旧版主进程 / 插件后端）：退化为到达顺序交付，行为与旧实现一致。
    if (!hasRange) {
      this._consume(chunkInfo, NaN);
      return 'consumed';
    }

    const tol = this.toleranceSamples;
    const frontier = this.frontier;

    // 情况 3：重复或过时 —— 整块（含容差）已被前沿覆盖，直接丢弃。
    if (end <= frontier + tol) {
      this._stats.duplicate++;
      this.onDuplicate(chunkInfo, 'stale');
      if (chunkInfo.isLast) this._deliverLastFlag(chunkInfo);
      return 'duplicate';
    }

    // 情况 1：正好接续（允许小段重叠）—— 立即交付，随后冲刷缓冲里的连续块。
    if (start <= frontier + tol) {
      this._consume(chunkInfo, end);
      this._flushContiguous();
      return 'consumed';
    }

    // 情况 2：超前 —— 存在缺口，暂存并启动超时兜底。
    if (this.buffer.has(start)) {
      // 同一采样起点重复到达：保留先到的，避免接缝重复播放。
      this._stats.duplicate++;
      this.onDuplicate(chunkInfo, 'buffered');
      if (chunkInfo.isLast) this._deliverLastFlag(chunkInfo);
      return 'buffered-duplicate';
    }
    this._stats.outOfOrder++;
    this.buffer.set(start, chunkInfo);
    this.onOutOfOrder(chunkInfo, start - frontier);
    this._armGapTimer();
    return 'buffered';
  }

  /** 交付：更新前沿（采样域）并回调真正消费者。 */
  _consume(chunkInfo, end) {
    if (Number.isFinite(end)) this.frontier = Math.max(this.frontier, end);
    this._stats.consumed++;
    this.onChunk(chunkInfo);
  }

  /** 冲刷缓冲：只要下一个块的起点已在前沿之内（含容差），就按序连续交付。 */
  _flushContiguous() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const starts = Array.from(this.buffer.keys()).sort((a, b) => a - b);
      for (const start of starts) {
        const chunk = this.buffer.get(start);
        const end = Number(chunk.sampleEnd);
        if (start <= this.frontier + this.toleranceSamples) {
          this.buffer.delete(start);
          this._consume(chunk, end);
          progressed = true;
        } else {
          break; // 有序数组，后续起点只会更大，等下一次缺口补齐
        }
      }
    }
    if (this.buffer.size === 0) this._clearGapTimer();
  }

  /**
   * 超时/收尾兜底：按 sampleOffset 排序强制交付所有暂存块，跳跃式更新前沿。
   * 缺口区间没有音频可造，表现为客观静音；但播放不会永久卡死。
   */
  _forceFlush(reason) {
    if (this.buffer.size === 0) return;
    const starts = Array.from(this.buffer.keys()).sort((a, b) => a - b);
    this._stats.gaps++;
    this._stats.forced += starts.length;
    this.onGap({ reason, gapFrom: this.frontier, gapTo: starts[0], count: starts.length });
    for (const start of starts) {
      const chunk = this.buffer.get(start);
      this.buffer.delete(start);
      this._consume(chunk, Number(chunk.sampleEnd));
    }
  }

  /** 推理完成：不再等缺口，排空所有暂存块。 */
  finish() {
    this._finished = true;
    this._clearGapTimer();
    this._forceFlush('finish');
  }

  /**
   * parking-style seek：跳跃式重锚前沿到目标采样位置。
   * 丢弃目标之前的块，保留之后的块（缓冲与上下文不销毁），随后尝试接续冲刷；
   * 若仍有缺口则重新启动超时，让"未来"chunk 自然到达后继续。
   * @param {number} targetSample - 目标采样位置（与 sampleOffset 同坐标系）
   */
  rebase(targetSample) {
    const target = Number.isFinite(targetSample) ? targetSample : 0;
    this._clearGapTimer();
    this.frontier = target;
    for (const [start, chunk] of this.buffer) {
      if (Number(chunk.sampleEnd) <= target + this.toleranceSamples) this.buffer.delete(start);
    }
    if (this.buffer.size > 0) {
      this._flushContiguous();
      if (this.buffer.size > 0) this._armGapTimer();
    }
  }

  /**
   * 重复/过时块若携带 isLast，仍需把"最后一块已到达"信号透传出去，
   * 否则依赖 markLastReceived 的收尾判定会漏触发（与 isLast 语义保持一致）。
   */
  _deliverLastFlag(chunkInfo) {
    // 复制一个空音频标记块，仅传递 isLast，避免把重复音频再播一遍。
    this.onChunk({ ...chunkInfo, audio: new Float32Array(0), __lastOnly: true });
  }

  stats() {
    return Object.assign({}, this._stats, {
      frontier: this.frontier,
      buffered: this.buffer.size,
    });
  }
}

// CommonJS 导出（Node 单测 / Electron 主进程 require）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SequencedChunkQueue;
  module.exports.SequencedChunkQueue = SequencedChunkQueue;
}
// ESM 命名导出由 webpack/babel 通过 CommonJS interop 处理；如未来需纯 ESM 可追加 export。
````

### R11 · 播放按钮状态机（播放中 > 合成中 > 自动推理 > 空闲）

文件：`src/fragmentEditor/uiControls.js`　行：`155-182`

````javascript
export function updateFragmentPlayButton() {
  const btnPlayFragment = document.getElementById('btn-play-fragment');
  if (!btnPlayFragment) return;
  // 顺序很重要：流式播放期间 isSynthesizing 仍为 true（合成还没结束、还要继续
  // 收 chunk），但声音已经在放了。必须先按"播放中"呈现（可点 = 停止），否则
  // 按钮在整个合成期间都显示"合成中"且禁用 —— 用户既停不下来、也切不了位置，
  // 只能等整段推理跑完（"按播放没反应"的直接原因）。
  if (getFragmentIsPlaying()) {
    setLabel(btnPlayFragment, t('fragment.stop'), { icon: 'stop' });
    btnPlayFragment.disabled = false;
  } else if (getFragmentIsSynthesizing()) {
    // 推理中（首个 chunk 尚未到达 / 非流式整段合成）：按钮语义与主页面一致 ——
    // 可点即"取消推理"。进度从状态派生，避免 IPC 直接写 DOM 遗留陈旧 100%。
    const progress = getFragmentSynthesisProgress();
    const label = Number.isFinite(progress)
      ? t('fragment.cancelSynthesisProgress', { progress })
      : t('fragment.cancelSynthesis');
    setLabel(btnPlayFragment, label, { icon: 'stop' });
    btnPlayFragment.disabled = false;
  } else if (getFragmentIsAutoInferring()) {
    // 后台自动推理进行中：仅提示，不禁用按钮——用户仍可随时手动播放或编辑。
    setLabel(btnPlayFragment, t('fragment.autoInferring'), { icon: 'play' });
    btnPlayFragment.disabled = false;
  } else {
    setLabel(btnPlayFragment, t('fragment.play'), { icon: 'play' });
    btnPlayFragment.disabled = false;
  }
}
````

### R12 · 播放按钮点击：停止 / 取消推理 / 新建播放

文件：`src/fragmentEditor/uiControls.js`　行：`321-357`

````javascript
  const btnPlayFragment = document.getElementById('btn-play-fragment');
  const btnExportFragment = document.getElementById('btn-export-fragment');
  const btnExportFragmentMidi = document.getElementById('btn-export-fragment-midi');

  if (btnPlayFragment) {
    btnPlayFragment.addEventListener('click', async () => {
      if (getNotes().length === 0) {
        showAlertDialog(t('fragment.noNotesToPlay'));
        return;
      }
      // 诊断：记录每次点击实际走哪条分支（播放中停止 / 合成中取消 / 新建播放）。
      const cachedAudio = getFragmentAudioData();
      console.log('[FragPlay] play button ' + JSON.stringify({
        isPlaying: getFragmentIsPlaying(),
        isSynthesizing: getFragmentIsSynthesizing(),
        isAutoInferring: getFragmentIsAutoInferring(),
        audioLength: cachedAudio ? cachedAudio.length : 0,
        action: (getFragmentIsPlaying() || getFragmentIsSynthesizing()) ? 'stop-or-cancel' : 'play',
      }));
      // 播放中 / 推理中一律按"停止"处理：
      //   · 流式播放期间合成仍在进行（isSynthesizing=true），按钮此刻是"停止"；
      //   · 推理刚开始、首个 chunk 还没到时同样要能取消 —— 旧实现直接 return，
      //     用户只能干等整段推理跑完（与主页面的 Play→取消 行为不一致）。
      if (getFragmentIsPlaying() || getFragmentIsSynthesizing()) {
        // 推理中：取消主进程的推理（内部会一并停掉本地音频）；
        // 只是播放缓存音频（无推理）：走普通停止。
        if (!cancelFragmentSynthesis()) stopFragmentPlayback();
        setFragmentCurrentTime(0);
        // 停止时重置播放起始位置，下次点击播放从头开始。
        // 用户可再次拖拽 playhead 设置新的起始位置。
        setFragmentPlayStartPosition(0);
        render();
        return;
      }
      await playFragment();
    });
  }
````

### R13 · 播放头拖拽：合成中 seek 保留会话并记录 pendingSeek

文件：`src/fragmentEditor/eventHandlers.js`　行：`2397-2432`

````javascript
    // 左键点击播放头或 header 区域 → 拖拽设置播放起始位置
    if (e.button === 0) {
      const canvasH = canvas.clientHeight;
      // 1. 直接点击在现有 playhead 上
      const onPlayhead = findPlayheadAt(pos.x, pos.y, canvasH);
      // 2. 点击 header 区域（时间轴）→ 移动 playhead 到点击位置
      const onHeader = pos.y <= HEADER_HEIGHT;
      if (onPlayhead || onHeader) {
        const beats = xToTime(pos.x);
        const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
        const newStartTime = Math.max(0, (beats / bpm) * 60);
        setFragmentPlayStartPosition(newStartTime);
        // 无论是否播放中，统一进入 playhead 拖拽模式：
        // 旧实现播放中走 seekFragmentPlayback 且不设 dragMode —— mousemove 的
        // playhead 分支永不触发（按住拖动完全不跟手），且每次移动都完整
        // stop/restart 音频源（爆音/卡顿）。现对齐主页面时间轴交互：
        // mousedown 暂停并记住状态，拖拽期间只更新视觉，mouseup 一次性 seek。
        setDragMode('playhead');
        setFragmentPlayheadDragging(true);
        const wasPlaying = getFragmentIsPlaying();
        _wasPlayingBeforePlayheadDrag = wasPlaying;
        if (wasPlaying) {
          const cur = getCurrentSession();
          if (getFragmentIsSynthesizing() && cur && !cur.disposed && cur.kind === 'stream') {
            // 合成尚未结束：只停音频、保留合成 session 并记录 seek 位置。
            // 不能调用 stopFragmentPlayback()，它会 dispose 合成 session，
            // 导致 pendingSeek 丢失、finally 跳过清 synthesizing 而卡在 100%。
            cur.requestSeekDuringSynthesis(newStartTime);
          } else {
            stopFragmentPlayback();
          }
        }
        render();
        return;
      }
    }
````

### R14 · preload：分片合成 invoke / chunk / stream-end 订阅

文件：`src/preload.js`　行：`202-239`

````javascript
  onSVSChunkAudio: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SVS_CHUNK_AUDIO, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SVS_CHUNK_AUDIO, handler);
  },
  onSVSDiffStepIncompatible: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SVS_MODEL_INCOMPATIBLE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SVS_MODEL_INCOMPATIBLE, handler);
  },
  getFragmentSVSSampleRate: () => invokeHeavy('fragment-svs:getSampleRate'),
  initFragmentSVSPipeline: (options) => invokeHeavy('fragment-svs:init', options),
  synthesizeFragmentSVS: async (data) => {
    const result = await invokeHeavy('fragment-svs:synthesize', data);
    if (result.error) {
      throw new Error(result.error);
    }
    return result.data;
  },
  resolvePhonemes: (lyrics) => invokeHeavy('fragment-svs:resolvePhonemes', { lyrics }),
  disposeFragmentSVSPipeline: () => invokeHeavy('fragment-svs:dispose'),
  onFragmentSVSProgress: (callback) => {
    // 保留完整 payload：synthesisId 用于过滤旧任务的迟到进度。
    // 老调用方若只读数字，可继续用 data.progress，不影响兼容。
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.FRAGMENT_SVS_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FRAGMENT_SVS_PROGRESS, handler);
  },
  onFragmentSVSChunkAudio: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.FRAGMENT_SVS_CHUNK_AUDIO, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FRAGMENT_SVS_CHUNK_AUDIO, handler);
  },
  onFragmentSVSStreamEnd: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.FRAGMENT_SVS_STREAM_END, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FRAGMENT_SVS_STREAM_END, handler);
  },
````

### R15 · IPC 通道：分片合成入口

文件：`src/shared/ipcChannels.js`　行：`75-84`

````javascript
  SVS_CHUNK_AUDIO: 'svs:chunk-audio',
  SVS_DISPOSE: 'svs:dispose',
  SVS_CHECK_JP_MODELS: 'svs:checkJpModels',
  FRAGMENT_SVS_GET_SAMPLE_RATE: 'fragment-svs:getSampleRate',
  FRAGMENT_SVS_INIT: 'fragment-svs:init',
  FRAGMENT_SVS_SYNTHESIZE: 'fragment-svs:synthesize',
  FRAGMENT_SVS_DISPOSE: 'fragment-svs:dispose',
  FRAGMENT_SVS_RESOLVE_PHONEMES: 'fragment-svs:resolvePhonemes',
  FRAGMENT_SVS_PROGRESS: 'fragment-svs:progress',

````

### R16 · IPC 通道：chunk / stream-end 推送

文件：`src/shared/ipcChannels.js`　行：`330-338`

````javascript
  FRAGMENT_CLOSE: 'fragment:close',
  FRAGMENT_CLOSE_ALL: 'fragment:closeAll',
  // ---- fragment-svs ----
  FRAGMENT_SVS_CHUNK_AUDIO: 'fragment-svs:chunk-audio',
  // 显式流结束屏障：携带 streamId / lastSeq，renderer 确认处理完最后序号后
  // 才允许把 scheduler 置为 inferenceDone（不能靠 invoke 回执猜 chunk 到齐）。
  FRAGMENT_SVS_STREAM_END: 'fragment-svs:stream-end',
  // ---- main-menu ----
  MAIN_MENU_EXPORT_MIDI_REQUEST: 'main-menu:export-midi-request',
````

### R17 · 主进程：流任务表（streamId -> task）与合成互斥

文件：`src/main/svsIpc.js`　行：`81-114`

````javascript
let _pendingPipelineReset = false;
// 当前持有 mutex 的可取消管线引用：svs:cancel 在 lazy 实例尚未注册
// （pipeline 异步初始化窗口）或已被延迟重置清空时仍能命中正确的 worker。
let _activeCancellable = null;
// 分片预览的流身份。旧会话 dispose 时带 streamId 调 svs:cancel；若此刻在跑的
// 已是新一轮，必须忽略那次取消，否则"停止 A"会把刚启动的 B 一起杀掉。
let _activeFragmentStreamId = null;
// streamId -> {state:'queued'|'running'|'cancelled', cancel}。
// 单一 active ID 只能表达"最后提交者"，无法表示 mutex 队列里排队但尚未
// 执行的请求；取消必须按 streamId 精确命中任务。
const _fragmentStreamTasks = new Map();
function _withSynthMutex(fn, cancellable) {
  const prev = _synthMutex;
  let release;
  _synthBusy++;
  _synthMutex = new Promise((r) => { release = r; });
  const p = prev.then(async () => {
    if (cancellable) _activeCancellable = cancellable;
    try {
      return await fn();
    } finally {
      if (cancellable && _activeCancellable === cancellable) _activeCancellable = null;
    }
  }).finally(() => {
    _synthBusy--;
    if (_synthBusy === 0 && _pendingPipelineReset) {
      _pendingPipelineReset = false;
      console.log('[Main] Executing deferred pipeline reset (synthesis idle)');
      try { resetSvsPipeline(); } catch (_) {}
    }
    release();
  });
  return p;
}
````

### R18 · 主进程：进度节流发送器

文件：`src/main/svsIpc.js`　行：`583-598`

````javascript
// 进度节流发送器：100ms 最小间隔，且进度变化 <2% 时跳过；progress>=100 必发。
// svs:synthesize / svs:synthesizeMultiStreaming / fragment-svs:synthesize 共用，
// 避免 diffusion 每步回调直接 win.send 形成 IPC 风暴。
function _makeThrottledSender(win, channel, extra = null) {
  let lastSentAt = 0;
  let lastValue = -1;
  return (progress) => {
    const now = Date.now();
    if (progress < 100 && now - lastSentAt < 100 && Math.abs(progress - lastValue) < 2) return;
    lastSentAt = now;
    lastValue = progress;
    try {
      if (win && !win.isDestroyed()) win.send(channel, { progress, ...(extra || {}) });
    } catch (_) {}
  };
}
````

### R19 · 主进程：按 streamId 精确取消

文件：`src/main/svsIpc.js`　行：`874-908`

````javascript
  safeHandle(IPC_CHANNELS.SVS_CANCEL, async (_event, options) => {
    const requestedStreamId = options && typeof options.streamId === 'string' ? options.streamId : null;
    if (requestedStreamId) {
      // 携带 streamId 时必须精确命中任务：active 为空或任务尚未执行，
      // 都不能退化成"取消当前在跑的任意合成"。
      const task = _fragmentStreamTasks.get(requestedStreamId);
      if (!task || task.state !== 'running') {
        if (task && task.state === 'queued') task.state = 'cancelled';
        console.log(`[Main] svs:cancel ignored stream ${requestedStreamId} (state=${task ? task.state : 'missing'})`);
        return { success: true, ignoredStaleStream: true };
      }
      try { await task.cancel?.cancelActiveSynthesis?.(); } catch (_) {}
      return { success: true };
    }
    // API 模式没有可取消的本地 pipeline，但要中止在途 HTTP 请求（Fetch AbortController）。
    if (isApiMode()) {
      try { apiModules().inference.cancelAll(); } catch (_) { /* 尚未加载 API 模块 */ }
    }
    // 优先命中当前持有 mutex 的实例（覆盖 lazy 实例尚未注册的初始化窗口，
    // 以及延迟重置清空 getInstance() 后仍在收尾的场景）。
    const target = _activeCancellable || svsPipelineLazy.getInstance();
    console.log(`[Main] svs:cancel active=${!!_activeCancellable} lazyInstance=${!!svsPipelineLazy.getInstance()} busy=${_synthBusy}`);
    if (target && typeof target.cancelActiveSynthesis === 'function') {
      // 协作式取消：只通知 worker 在安全点退出推理，worker 线程保持存活。
      // 不再调用 svsPipelineLazy.reset()（旧逻辑会在 terminate 后重建 worker），
      // 否则会 dispose()→terminate() 打断尚未安全退出的推理，重新引入 GPU 崩溃。
      await target.cancelActiveSynthesis();
      return { success: true };
    }
    // 没有可取消对象且不在合成中：保持旧行为（清理残留状态）。
    if (_synthBusy === 0) {
      resetSvsPipeline();
    }
    return { success: true };
  });
````

### R20 · 主进程：分片合成 handler、chunk 网关、STREAM_END 屏障

文件：`src/main/svsIpc.js`　行：`936-1119`

````javascript
  safeHandle(IPC_CHANNELS.FRAGMENT_SVS_SYNTHESIZE, async (event, { notes, bpm, options }) => {
    // Load japaneseVocalization setting: 'en-phonemes' (default) / 'hybrid' use English phonemes on base model;
    // 'jp-lora' uses JP LoRA models (in development)
    const settingsForLang = loadSettings();
    const japaneseVocalization = settingsForLang.japaneseVocalization || 'en-phonemes';

    // Detect language: en-phonemes / hybrid mode always uses base model (null); jp-lora mode uses original logic
    const language = _resolveLanguage(notes, japaneseVocalization);

    // 参数装配与插件派发一律排在内置管线初始化之前（理由同 svs:synthesize）：
    // 插件后端不依赖内置 ONNX 模型，没装 SoulX-Singer 也要能用第三方后端。
    const win = event.sender;
    const opts = options || {};
    opts.language = language; // 用于缓存 key 区分（避免命中错误模型的结果）
    // 进度也要带 streamId：渲染侧据此过滤旧任务的迟到进度，避免 A 的 100%
    // 覆盖 B 的按钮文案。
    const fragmentStreamId = typeof opts.streamId === 'string' && opts.streamId
      ? opts.streamId
      : null;
    // 进度推送节流：与 svs:synthesize 共用 _makeThrottledSender（100ms / 2% 变化阈值）。
    // 长合成时 diffusion 每步都回调，无节流会形成 IPC 风暴（每秒数百次 win.send +
    // 序列化开销），拖慢主进程与渲染进程。
    opts.onProgress = _makeThrottledSender(
      win,
      IPC_CHANNELS.FRAGMENT_SVS_PROGRESS,
      fragmentStreamId ? { synthesisId: fragmentStreamId } : null,
    );
    // 流式 chunk 音频推送：vocoder 每完成一个 chunk 即推送到 fragment 窗口，实现边合成边播放。
    // background=true（编辑后自动实时推理）时不需要边合成边播，跳过 chunk 推送以免
    // 每帧 Float32Array 白白跨进程序列化；合成结果本身完全一致。
    //
    // 每个 chunk 都带 streamId + 单调 seq，流结束时再发一条 STREAM_END(lastSeq)。
    // 目的有两个：① 旧请求的迟到 chunk 不能被新会话误收（channel 是全局的）；
    // ② renderer 不再靠 `invoke 回执 + setTimeout(0)` 猜"chunk 已全部到齐"。
    // STREAM_END 在 invoke 回执之前发出（同一 win 的消息有序），构成显式屏障。
    let chunkSeq = 0;
    let streamSendFailed = false;
    const isBackground = opts.background === true;
    const fragmentTask = !isBackground && fragmentStreamId
      ? { state: 'queued', cancel: null }
      : null;
    if (fragmentTask) _fragmentStreamTasks.set(fragmentStreamId, fragmentTask);
    const sendStreamEnd = () => {
      if (isBackground || !fragmentStreamId || win.isDestroyed()) return;
      try {
        win.send(IPC_CHANNELS.FRAGMENT_SVS_STREAM_END, {
          streamId: fragmentStreamId,
          lastSeq: chunkSeq,
          transportFailed: streamSendFailed,
        });
      } catch (_) {
        console.warn(`[Main] Failed to send STREAM_END for ${fragmentStreamId}`);
      }
    };
    opts.onChunkAudio = isBackground
      ? null
      : (chunkInfo) => {
        if (win.isDestroyed()) return;
        // 先发送、成功后才提交 seq：否则 send 抛错时 lastSeq 会声明一个
        // renderer 永远收不到的序号，结束屏障永远无法满足。
        const nextSeq = chunkSeq + 1;
        // 诊断：区分"推理侧推出静音"与"渲染端播放静音"。抽样 RMS（步长 64）
        // 足以看出长空当后的块是否真的有内容，开销可忽略。
        let chunkRms = 0;
        const audio = chunkInfo && chunkInfo.audio;
        if (audio && audio.length > 0) {
          const stride = 64;
          let sum = 0;
          let count = 0;
          for (let i = 0; i < audio.length; i += stride) {
            const v = audio[i];
            sum += v * v;
            count += 1;
          }
          chunkRms = count > 0 ? Math.sqrt(sum / count) : 0;
        }
        console.log(`[FragStream] send seq=${nextSeq} offset=${chunkInfo.sampleOffset ?? '-'} end=${chunkInfo.sampleEnd ?? '-'} samples=${audio ? audio.length : 0} rms=${chunkRms.toFixed(6)} isLast=${!!chunkInfo.isLast} stream=${fragmentStreamId}`);
        try {
          win.send(IPC_CHANNELS.FRAGMENT_SVS_CHUNK_AUDIO, {
            ...chunkInfo,
            streamId: fragmentStreamId,
            seq: nextSeq,
          });
          chunkSeq = nextSeq;
        } catch (_) {
          streamSendFailed = true;
          console.warn(`[Main] Failed to send fragment chunk seq=${nextSeq} stream=${fragmentStreamId}`);
        }
      };
    // 注入 RMVPE F0 提取器（仅在 autoShift + refAudio 路径下使用）。
    // 插件路径下 RMVPE 可能未初始化，容错不注入，由插件自己的 F0 逻辑兜底。
    if (opts.autoShift && opts.refAudioWavBuffer) {
      try { opts.refF0Extractor = _makeRmvpeExtractor(); } catch (_) { opts.refF0Extractor = null; }
    }

    // ---- 插件后端透传 ----
    // 与 svs:synthesize 同一套语义：opts 是内置 pipeline 会收到的完整 options，
    // 插件拿到同一引用；命中插件分支直接 return，不再调用内置 pipeline。
    // 返回值仍是 { data }，渲染层无需区分后端。
    const pluginBackend = _resolvePluginBackend(opts);
    if (pluginBackend) {
      const pluginResult = await runPluginBackend({
        backend: pluginBackend,
        notes,
        bpm,
        options: opts,
        sender: win,
        sampleRate: getSampleRate(),
      });
      if (!pluginResult.ok) {
        return { error: `PLUGIN_SYNTHESIS_FAILED: ${pluginResult.error}` };
      }
      return { data: pluginResult.audio };
    }

    // ---- 远程 API 后端 ----
    // 返回 {error} 而不是 throw：preload 的 synthesizeFragmentSVS 会把它转成
    // Error 抛出，渲染层（含后台自动推理路径）据此显式报错。
    if (isApiMode()) {
      const { inference } = apiModules();
      try {
        const data = await inference.synthesize({
          runtime: apiRuntime(),
          notes,
          bpm,
          options: opts,
          onProgress: opts.onProgress,
        });
        return { data };
      } catch (err) {
        console.error('[Main] fragment-svs:synthesize (API) failed:', err.message);
        return { error: err.message };
      }
    }

    // Check if JP models are needed but missing (only in jp-lora mode)
    if (language === 'ja') {
      const settings = loadSettings();
      const precision = settings.modelPrecision || 'fp32';
      const modelDir = getModelDir();
      if (!checkJpModelsExist(modelDir, precision)) {
        // W19: use i18n key instead of hardcoded Chinese error message.
        return { error: 'JP_MODELS_MISSING', message: t('error.jpModelNotDownloaded') };
      }
    }

    let pipeline;
    try {
      pipeline = await ensurePipelineLanguage(language);
    } catch (err) {
      return { error: err.message };
    }

    if (!pipeline) {
      return { error: t('error.fragmentSvsNotInitialized') };
    }

    try {
      // active ID 必须在实际进入 mutex、真正要用 GPU 时才置位；排队中的
      // 请求不能被当成"当前执行者"，否则取消会命中错任务。
      const data = await _withSynthMutex(() => {
        if (fragmentTask && fragmentTask.state === 'cancelled') {
          const err = new Error('Synthesis cancelled');
          err.code = 'SYNTHESIS_CANCELLED';
          throw err;
        }
        if (fragmentTask) {
          fragmentTask.state = 'running';
          fragmentTask.cancel = pipeline;
          _activeFragmentStreamId = fragmentStreamId;
        }
        return pipeline.synthesize(notes, bpm, opts);
      }, pipeline);
      return { data };
    } catch (err) {
      return { error: err.message };
    } finally {
      // 必须在 invoke 回执之前投递结束屏障；win.send 与 handle 的回复同属
      // main→renderer 方向，Electron 保证顺序，renderer 处理回执时 END 已排队。
      sendStreamEnd();
      if (fragmentTask) _fragmentStreamTasks.delete(fragmentStreamId);
      if (_activeFragmentStreamId === fragmentStreamId) _activeFragmentStreamId = null;
    }
  });
````

### R21 · worker 客户端：事件桥接、ArrayBuffer 移交、协作取消

文件：`src/main/svsWorkerClient.js`　行：`1-173`

````javascript
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

function findWorkerScript() {
  const candidates = [
    path.join(__dirname, '..', 'inference', 'svsWorker.js'),
    path.join(__dirname, 'inference', 'svsWorker.js'),
  ];
  return candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
}

class SvsWorkerClient {
  constructor(workerData) {
    this.workerData = workerData;
    this.worker = null;
    this.readyPromise = null;
    this.nextId = 0;
    this.pending = new Map();
    this.activeSynthId = null;
    this.initialized = false;
    this.sessionEPs = {};
    this.loadedModels = new Set();
    this.hardwareInfo = null;
    this.diffStepIsQDIT = false;
    this.diffStepLegacyInt8Incompatible = false;
  }

  _applyState(state) {
    if (!state) return;
    this.initialized = !!state.initialized;
    this.sessionEPs = state.sessionEPs || {};
    this.loadedModels = new Set(state.loadedModels || []);
    this.hardwareInfo = state.hardwareInfo || null;
    this.diffStepIsQDIT = !!state.diffStepIsQDIT;
    this.diffStepLegacyInt8Incompatible = !!state.diffStepLegacyInt8Incompatible;
  }

  async _ensureWorker() {
    if (this.worker && this.readyPromise) { await this.readyPromise; return; }
    const script = findWorkerScript();
    if (!script) throw new Error('svsWorker.js not found');
    let readyResolve, readyReject;
    this.readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const worker = new Worker(script, { workerData: this.workerData });
    this.worker = worker;
    worker.on('message', msg => {
      if (msg.type === 'ready') { readyResolve(); return; }
      const pending = this.pending.get(msg.id);
      if (msg.type === 'event') {
        if (msg.event === 'progress') pending?.onProgress?.(msg.data);
        if (msg.event === 'chunk-audio') pending?.onChunkAudio?.(msg.data);
        return;
      }
      if (!pending) return;
      this.pending.delete(msg.id);
      this._applyState(msg.state);
      if (msg.type === 'result') pending.resolve(msg.result);
      else {
        const err = new Error(msg.error?.message || 'SVS worker failed');
        if (msg.error?.code) err.code = msg.error.code;
        if (msg.error?.stack) err.stack = msg.error.stack;
        pending.reject(err);
      }
    });
    const fail = err => {
      readyReject(err);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.worker = null;
      this.readyPromise = null;
      this.initialized = false;
    };
    worker.once('error', fail);
    worker.once('exit', code => { if (code !== 0) fail(new Error(`SVS worker exited with code ${code}`)); });
    await this.readyPromise;
  }

  // 收集本次调用可移交的 ArrayBuffer（参考音频 WAV）。仅移交独占整个
  // backing store 的视图/ArrayBuffer：Node Buffer 的小尺寸分配可能来自
  // 共享内存池，移交会连带夺走整个池；IPC 反序列化得到的类型化数组始终
  // 独占等长 buffer。这些载荷每次合成只消费一次，移交后不影响调用方重试
  //（重试是一次新的 IPC 调用，渲染进程会重新克隆一份）。
  _collectSynthTransfers(args) {
    const list = [];
    const add = (v) => {
      if (!v) return;
      if (v instanceof ArrayBuffer) {
        list.push(v);
      } else if (ArrayBuffer.isView(v) && v.buffer instanceof ArrayBuffer
        && v.byteOffset === 0 && v.byteLength === v.buffer.byteLength) {
        list.push(v.buffer);
      }
    };
    add(args.options && args.options.refAudioWavBuffer);
    for (const f of args.fragments || []) {
      add(f.options && f.options.refAudioWavBuffer);
    }
    return list;
  }

  async _call(command, args = {}, callbacks = {}) {
    await this._ensureWorker();
    const id = ++this.nextId;
    // 记录合成类命令的请求 ID，用于协同式取消
    if (command === 'synthesize' || command === 'synthesizeMultiStreaming') {
      this.activeSynthId = id;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...callbacks });
      const transferList = (command === 'synthesize' || command === 'synthesizeMultiStreaming')
        ? this._collectSynthTransfers(args) : [];
      this.worker.postMessage({ id, command, args }, transferList);
    });
  }

  init(language) { return this._call('init', { language }); }
  synthesize(notes, bpm, options = {}) {
    const { onProgress, onChunkAudio, refF0Extractor, ...serializable } = options;
    return this._call('synthesize', { notes, bpm, language: options.language, options: {
      ...serializable, __progress: !!onProgress, __chunkAudio: !!onChunkAudio,
    } }, { onProgress, onChunkAudio });
  }
  synthesizeMultiStreaming(fragments, bpm, options = {}) {
    const { onProgress, onChunkAudio, ...serializable } = options;
    const cleanFragments = (fragments || []).map(f => ({
      ...f, options: f.options ? Object.fromEntries(Object.entries(f.options).filter(([, v]) => typeof v !== 'function')) : f.options,
    }));
    return this._call('synthesizeMultiStreaming', { fragments: cleanFragments, bpm, language: options.language, options: {
      ...serializable, __progress: !!onProgress, __chunkAudio: !!onChunkAudio,
    } }, { onProgress, onChunkAudio });
  }
  resolveLyricToPhonemes(lyric) { return this._call('resolvePhonemes', { lyrics: [lyric] }).then(r => r[0]); }
  resolvePhonemes(lyrics, language) { return this._call('resolvePhonemes', { lyrics, language }); }
  swapLanguageModels(language) { return this._call('swapLanguageModels', { language }); }
  swapVocoder(value) { return this._call('swapVocoder', { value }); }
  swapSifiganPrecision(value) { return this._call('swapSifiganPrecision', { value }); }
  loadModel(key) { return this._call('loadModel', { key }); }
  unloadModel(key) { this.loadedModels.delete(key); return this._call('unloadModel', { key }); }
  ensureAllModelsLoaded() { return this._call('ensureAllModelsLoaded'); }
  clearSynthCache() { return this._call('clearSynthCache'); }
  isModelLoaded(key) { return this.loadedModels.has(key); }
  getHardwareInfo() { return this.hardwareInfo; }
  async cancelActiveSynthesis() {
    if (!this.worker) return;
    const targetId = this.activeSynthId;
    console.log(`[SvsWorkerClient] cancelActiveSynthesis: targetId=${targetId} pending=${this.pending.size}`);
    this.activeSynthId = null;
    const err = new Error('Synthesis cancelled');
    err.code = 'SYNTHESIS_CANCELLED';
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    // 协作式取消：向 worker 发送 cancel 命令，让它通过 abort 信号的检查点
    //（diffusion 每步/每块之间）安全退出并抛出 SYNTHESIS_CANCELLED。
    // worker 线程保持存活，避免 worker.terminate() 强杀 GPU 推理导致 D3D device
    // hung → 主进程原生崩溃。
    try {
      this.worker.postMessage({ id: `cancel-${targetId ?? Date.now()}`, command: 'cancel', args: { requestId: targetId ?? undefined } });
    } catch (_) {}
  }

  async dispose() {
    if (!this.worker) return;
    try { await this._call('dispose'); } catch (_) {}
    const worker = this.worker;
    this.worker = null;
    this.readyPromise = null;
    this.initialized = false;
    try { await worker.terminate(); } catch (_) {}
  }
}

module.exports = { SvsWorkerClient, findWorkerScript };
````

### R22 · worker 入口：chunk 事件归一化、协作取消、请求世代号

文件：`src/inference/svsWorker.js`　行：`1-279`

````javascript
const { parentPort, workerData } = require('node:worker_threads');

// float16 补丁由 ortRuntime.getOrt() 在加载 ORT 后统一施加（幂等），见 ortRuntime.js。

// Windows ML 快照注入：worker_threads 里 require('electron') 不可用（退化为
// 路径字符串），settings 模块与 dynwinrt/catalog 在 worker 内都不可靠。
// 主进程在 spawn 时经 workerData 显式下发开关与已就绪的 EP libraryPath 列表，
// 这里在任何 pipeline/winml 模块加载之前挂到 globalThis。
if (workerData && typeof workerData === 'object') {
    // 持久化缓存（dummy 校验 / WinML 探测）在 worker 内拿不到 electron.app，
    // 由主进程把 userData 目录显式下发。
    if (typeof workerData.userDataDir === 'string' && workerData.userDataDir) {
        globalThis.__SXS_USER_DATA_DIR__ = workerData.userDataDir;
    }
    const snapshot = {
        ...(workerData.settingsSnapshot || {}),
        ...(typeof workerData.winmlEnabled === 'boolean' ? { winmlEnabled: workerData.winmlEnabled } : {}),
        ...(workerData.winmlBootstrapDllPath ? { winmlBootstrapDllPath: workerData.winmlBootstrapDllPath } : {}),
    };
    if (Object.keys(snapshot).length > 0) {
        globalThis.__SXS_SETTINGS_SNAPSHOT__ = snapshot;
    }
    if (Array.isArray(workerData.winmlEps)) {
        globalThis.__SXS_WINML_EPS__ = workerData.winmlEps;
    }
    if (typeof workerData.npuAvailable === 'boolean') {
        globalThis.__SXS_NPU_AVAILABLE__ = workerData.npuAvailable;
    }
    if (typeof workerData.openvinoNpuSafe === 'boolean') {
        globalThis.__SXS_OPENVINO_NPU_SAFE__ = workerData.openvinoNpuSafe;
    }
}

const { OnnxSVSPipeline } = require('./pipeline');
const { RmvpePitchDetector } = require('./rmvpePitchDetector');

let pipeline = null;
let rmvpe = null;
let currentLanguage = workerData.language || null;
let queue = Promise.resolve();
// 协作式取消：记录每个合成请求对应的 AbortController，取消时 abort 而非杀线程。
// 合成结束（成功/失败）都会删除自身 id，避免 Map 累积泄漏。
const activeControllers = new Map();
// cancel 可能在 synthesize 的 ensurePipeline() 之前到达（此时 controller 尚未
// 注册）。必须记住"预取消"的目标 id，否则这次取消会永久丢失。
const pendingCancelledIds = new Set();

function abortRequest(requestId) {
  if (requestId != null) {
    const c = activeControllers.get(requestId);
    if (c) { c.abort(); return true; }
    pendingCancelledIds.add(requestId);
    // 防止未知 id 无限累积：只保留最近 256 个待取消目标。
    if (pendingCancelledIds.size > 256) {
      const oldest = pendingCancelledIds.values().next().value;
      pendingCancelledIds.delete(oldest);
    }
    return false;
  }
  // 未提供有效 id 时回退到最近一次请求，保证取消总能命中活跃合成。
  const entries = Array.from(activeControllers.entries());
  if (entries.length === 0) return false;
  activeControllers.get(entries[entries.length - 1][0]).abort();
  return true;
}

/** 注册 controller 时兑现此前到达的取消。 */
function registerController(id, controller) {
  activeControllers.set(id, controller);
  if (pendingCancelledIds.delete(id)) controller.abort();
  return controller;
}

function serializeError(err) {
  return { message: err?.message || String(err), code: err?.code, stack: err?.stack };
}

function snapshot() {
  return {
    initialized: !!pipeline?.initialized,
    sessionEPs: pipeline?.sessionEPs || {},
    hardwareInfo: pipeline?.initialized && typeof pipeline.getHardwareInfo === 'function'
      ? pipeline.getHardwareInfo() : null,
    loadedModels: pipeline?.sessions ? Object.keys(pipeline.sessions) : [],
    // diff_step 模型签名标志：QDIT 新模型 / int8 旧模型不兼容
    diffStepIsQDIT: !!pipeline?.diffStepIsQDIT,
    diffStepLegacyInt8Incompatible: !!pipeline?.diffStepLegacyInt8Incompatible,
  };
}

async function ensurePipeline(language = currentLanguage) {
  if (!pipeline) {
    pipeline = new OnnxSVSPipeline(workerData.modelDir, {
      ...workerData.pipelineOptions,
      languageOverride: language,
    });
    await pipeline.init();
    currentLanguage = language;
  } else if (pipeline.initialized && language !== currentLanguage) {
    await pipeline.swapLanguageModels(language);
    currentLanguage = language;
  }
  return pipeline;
}

async function getRefF0Extractor() {
  return async (audioFloat, sampleRate) => {
    try {
      if (!rmvpe) {
        rmvpe = new RmvpePitchDetector(workerData.baseModelDir || workerData.modelDir, {
          deviceId: workerData.pipelineOptions?.deviceId,
        });
        await rmvpe.init();
      }
      return await rmvpe.extractF0(audioFloat, sampleRate);
    } catch (err) {
      console.warn('[SVS worker] RMVPE reference F0 failed:', err.message);
      return null;
    }
  };
}

function attachCallbacks(id, options = {}) {
  const opts = { ...options };
  if (options.__progress) {
    opts.onProgress = progress => parentPort.postMessage({ type: 'event', id, event: 'progress', data: progress });
  }
  if (options.__chunkAudio) {
    opts.onChunkAudio = data => {
      try {
        // 下游统一按 Float32Array.length 使用；裸 ArrayBuffer 没有 length，
        // 必须在 worker 边界归一化，不能要求每个调用方兼容两种类型。
        const a = data && data.audio;
        let pcm = null;
        if (a instanceof Float32Array) pcm = a;
        else if (a instanceof ArrayBuffer && a.byteLength % 4 === 0) pcm = new Float32Array(a);
        else if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
          const out = new Float32Array(a.length);
          for (let i = 0; i < a.length; i++) out[i] = Number(a[i]) || 0;
          pcm = out;
        }
        if (!pcm) return;
        const message = {
          type: 'event',
          id,
          event: 'chunk-audio',
          data: { ...data, audio: pcm },
        };
        // 仅当视图独占 backing store 时移交，避免误伤共享缓冲池。
        // postMessage 失败不能反向打断整轮合成。
        const ab = pcm.buffer instanceof ArrayBuffer
          && pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
          ? pcm.buffer : null;
        if (ab) parentPort.postMessage(message, [ab]);
        else parentPort.postMessage(message);
      } catch (err) {
        console.warn('[SVS worker] Failed to post chunk audio:', err && err.message);
      }
    };
  }
  delete opts.__progress;
  delete opts.__chunkAudio;
  return opts;
}

async function handle(msg) {
  const { id, command, args = {} } = msg;
  switch (command) {
    case 'init':
      await ensurePipeline(args.language);
      return { success: true };
    case 'synthesize': {
      const p = await ensurePipeline(args.language);
      const options = attachCallbacks(id, args.options);
      const controller = registerController(id, new AbortController());
      options.abortSignal = controller.signal;
      if (controller.signal.aborted) {
        activeControllers.delete(id);
        const err = new Error('Synthesis cancelled before start');
        err.code = 'SYNTHESIS_CANCELLED';
        throw err;
      }
      try {
        if (options.autoShift && options.refAudioWavBuffer) options.refF0Extractor = await getRefF0Extractor();
        return await p.synthesize(args.notes, args.bpm, options);
      } finally {
        activeControllers.delete(id);
      }
    }
    case 'synthesizeMultiStreaming': {
      const p = await ensurePipeline(args.language);
      const options = attachCallbacks(id, args.options);
      const controller = registerController(id, new AbortController());
      options.abortSignal = controller.signal;
      if (controller.signal.aborted) {
        activeControllers.delete(id);
        const err = new Error('Synthesis cancelled before start');
        err.code = 'SYNTHESIS_CANCELLED';
        throw err;
      }
      try {
        for (const fragment of args.fragments || []) {
          if (fragment.options?.autoShift && fragment.options?.refAudioWavBuffer) {
            fragment.options = { ...fragment.options, refF0Extractor: await getRefF0Extractor() };
          }
        }
        return await p.synthesizeMultiStreaming(args.fragments, args.bpm, options);
      } finally {
        activeControllers.delete(id);
      }
    }
    case 'cancel': {
      abortRequest(args.requestId);
      return { success: true };
    }
    case 'resolvePhonemes': {
      const p = await ensurePipeline(args.language);
      return args.lyrics.map(lyric => p.resolveLyricToPhonemes(lyric));
    }
    case 'swapLanguageModels': {
      const p = await ensurePipeline(currentLanguage);
      await p.swapLanguageModels(args.language);
      currentLanguage = args.language;
      return true;
    }
    case 'swapVocoder': return (await ensurePipeline()).swapVocoder(args.value);
    case 'swapSifiganPrecision': return (await ensurePipeline()).swapSifiganPrecision(args.value);
    case 'loadModel': return (await ensurePipeline()).loadModel(args.key);
    case 'unloadModel': return (await ensurePipeline()).unloadModel(args.key);
    case 'ensureAllModelsLoaded': return (await ensurePipeline()).ensureAllModelsLoaded();
    case 'clearSynthCache': return pipeline?.clearSynthCache?.();
    case 'status': return snapshot();
    case 'dispose':
      try { pipeline?.dispose(); } catch (_) {}
      try { rmvpe?.dispose(); } catch (_) {}
      pipeline = null;
      rmvpe = null;
      return { success: true };
    default: throw new Error(`Unknown SVS worker command: ${command}`);
  }
}

// 合成请求世代号：合成类命令入队时记录序号，轮到它执行时若已不是最新世代，
// 直接跳过——快速多次触发时，排队中的陈旧请求不再完整占用一次 GPU 推理。
// cancel 只能 abort 已开始（已有 AbortController）的请求，救不了纯排队请求。
let latestSynthSeq = 0;

parentPort.on('message', msg => {
  // 协作式取消：cancel 必须绕过串行合成队列立即执行，否则它会排在
  // 正在运行的合成之后，永远无法中断当前推理。
  if (msg.command === 'cancel') {
    abortRequest(msg.args?.requestId);
    parentPort.postMessage({ type: 'result', id: msg.id, result: { success: true }, state: snapshot() });
    return;
  }
  const isSynthCommand = msg.command === 'synthesize'
    || msg.command === 'synthesizeMultiStreaming';
  const synthSeq = isSynthCommand ? ++latestSynthSeq : 0;
  queue = queue.then(async () => {
    // 排队期间已有更新的合成请求入队：本请求已过期，跳过 GPU 执行。
    if (isSynthCommand && synthSeq !== latestSynthSeq) {
      parentPort.postMessage({
        type: 'error',
        id: msg.id,
        error: { message: 'Synthesis superseded by a newer request', code: 'SVS_SUPERSEDED' },
        state: snapshot(),
      });
      return;
    }
    try {
      const result = await handle(msg);
      parentPort.postMessage({ type: 'result', id: msg.id, result, state: snapshot() });
    } catch (err) {
      parentPort.postMessage({ type: 'error', id: msg.id, error: serializeError(err), state: snapshot() });
    }
  });
});

parentPort.postMessage({ type: 'ready' });
````

### R23 · 管线：整段缓存命中时按 2s 重放为 chunk

文件：`src/inference/pipeline/index.js`　行：`1156-1193`

````javascript
    /**
     * 把整段缓存音频按固定时长切块，走流式回调"重放"。
     *
     * 为什么需要：整段音频缓存命中时 `_synthesizeImpl` 直接 return，一个 chunk
     * 都不发。渲染层（分片编辑器）据此认为"流式从未启动"，只能等 invoke 把整段
     * Float32Array 跨进程序列化完再整段开播 —— 用户看到的是"明明有缓存，点播放
     * 却既不流式、也要等一下才出声"，而且从中段起播时必须先等整段传输。
     *
     * 缓存音频的语义与实时 chunk 一致：`audio[0]` ↔ 首音符起点，因此
     * sampleOffset 从 0 开始按块递增即可，接收端用同一套绝对位置排程。
     *
     * @param {Float32Array} audio 缓存音频（已按首音符裁齐）
     * @param {function} onChunkAudio
     * @param {number} [chunkSec]
     */
    _emitCachedAudioAsChunks(audio, onChunkAudio, chunkSec = 2) {
        if (!onChunkAudio || !audio || audio.length === 0) return;
        const step = Math.max(1, Math.round(chunkSec * SAMPLE_RATE));
        const total = audio.length;
        let idx = 0;
        for (let off = 0; off < total; off += step, idx++) {
            const end = Math.min(total, off + step);
            try {
                onChunkAudio({
                    chunkIndex: idx,
                    sampleOffset: off,
                    sampleEnd: end,
                    audio: audio.subarray(off, end),
                    totalSamples: total,
                    isLast: end >= total,
                    cached: true,
                });
            } catch (e) {
                console.warn(`[OnnxSVSPipeline] cached chunk emit failed: ${e.message}`);
                return;
            }
        }
    }
````

### R24 · 管线：vocoder 包装（mel 后处理偏移、段级 vocoder）

文件：`src/inference/pipeline/index.js`　行：`2436-2572`

````javascript
    /**
     * 计算"本次 vocoder 输入 mel 的首音符绝对拍"对应的载荷帧偏移。
     * 载荷（options.melPostprocess）锚在分片第一个音符；多段 / 多 region /
     * 单音符 padding 等 re-base 路径的 mel 都从这里换算回真实时间。
     */
    _melPostprocessFrameOffset(absFirstNoteBeat) {
        return computeMelFrameOffset(this._melPostprocessOptions, absFirstNoteBeat, SAMPLE_RATE / HOP_SIZE);
    }

    async _runVocoderChunked(melData, totalFrames, onChunkComplete = null, frameOffset = 0, melCtx = null) {
        // Vocoder is loaded via DML (dynamic shapes), never use static shape padding
        // SiFiGAN 双输入：传入 vocoderType、F0 序列、stats 缺失标志；default vocoder 仅用 mel
        melData = this._postprocessMel(melData, totalFrames, frameOffset, '[Vocoder]', melCtx);
        const chunkFrames = this._resolveVocoderChunkFrames();
        const overlapFramesOverride = this._resolveVocoderOverlapFrames();
        console.log(`[OnnxSVSPipeline] Vocoder EP: ${this.sessionEPs.vocoder || 'unknown'}, vocoderIsFP16=${this.vocoderIsFP16}, isFP16=${this.isFP16}, vocoderType=${this.vocoderType}, resolvedFile=${this._resolvedVocoderFile}`);
        if (!this.sessions.vocoder) {
            console.error('[OnnxSVSPipeline] CRITICAL: sessions.vocoder is missing! Vocoder inference will throw.');
        }

        // 一致性检测：vocoderType 与实际加载的 vocoder 文件必须匹配，否则 mel 处理模式
        // （sifigan 4× 上采样 + f0 输入 vs default 仅 mel）与 session 输入签名不匹配，
        // 会导致音质劣化 + 显存压力错误（sifigan 与 default 使用不同的常驻权重预算）。
        const expectedSifigan = this.vocoderType === 'sifigan';
        const actualIsSifigan = this._resolvedVocoderFile ? this._isSifiganVocoder(this._resolvedVocoderFile) : false;
        if (expectedSifigan !== actualIsSifigan) {
            console.warn(`[OnnxSVSPipeline] WARNING: vocoderType=${this.vocoderType} but loaded vocoder=${this._resolvedVocoderFile} (isSifigan=${actualIsSifigan}). This indicates a fallback occurred. Mel processing may be incorrect.`);
        }

        // 临时释放 diffStep session，让 vocoder 推理独占 GPU 显存。
        // 触发条件：DML 后端 + (用户开启 releaseDiffStepBeforeVocoder || 上一次 vocoder
        //   抛 isVramOOMError 设置的 _dynamicReleaseDiffStepNextSegment) + diffStep 当前已加载。
        // 不释放 vocoder（马上要用），不释放 encoders（体积小）。
        // WebNN 路径跳过（diffStep 在渲染进程，与主进程 vocoder 互不抢占显存）。
        const releasedDiffStep = this._maybeUnloadDiffStepBeforeVocoder();
        if (releasedDiffStep) {
            // session.release() 是同步 API，但 DML 后端 GPU 资源回收是异步的。
            // gpuDrainLong() 实际只让出一个事件循环轮次（setImmediate），不做墙钟等待，
            // 资源顺序由 session.release() 与 ORT 内部同步负责。
            console.log('[OnnxSVSPipeline] Waiting for DML to reclaim diffStep VRAM before vocoder...');
            const t0 = performance.now();
            await gpuDrainLong();
            console.log(`[OnnxSVSPipeline] DML drain complete (${(performance.now() - t0).toFixed(0)}ms), starting vocoder inference`);
        }

        const runVocoder = () => this._postprocessing.runVocoderChunked(
            this.sessions, melData, totalFrames, this.vocoderIsFP16 ?? this.isFP16, false,
            this.vocoderType, this._currentF0Hz, this.sifiganStatsMissing, onChunkComplete, chunkFrames, overlapFramesOverride
        );
        try {
            return await runVocoder();
        } catch (err) {
            // Dynamic OOM recovery: if this is the first OOM in this segment
            // and we did NOT already release diffStep, set the dynamic flag and
            // retry the segment with diffStep released first. After the retry
            // (success or another failure), the finally block clears the flag
            // so behavior reverts to the user setting for the next segment.
            if (isVramOOMError(err) && !releasedDiffStep && !_dynamicReleaseDiffStepNextSegment && this._isDiffStepReleaseEnabled()) {
                console.warn(`[OnnxSVSPipeline] Vocoder OOM caught, retrying segment with diffStep released first: ${err.message}`);
                _dynamicReleaseDiffStepNextSegment = true;
                // 标记 OOM：gpuDrainAdaptive 下次调用仅消费并清除该标志，
                // 不会延长等待时间（实现只做一次 setImmediate yield）。
                markGpuOom();
                // Declare outside try so the finally block can observe it.
                let releasedRetry = false;
                try {
                    releasedRetry = this._maybeUnloadDiffStepBeforeVocoder();
                    if (releasedRetry) {
                        console.log('[OnnxSVSPipeline] Waiting for DML to reclaim diffStep VRAM before vocoder retry...');
                        const r0 = performance.now();
                        await gpuDrainLong();
                        console.log(`[OnnxSVSPipeline] DML drain complete (${(performance.now() - r0).toFixed(0)}ms), starting vocoder retry`);
                    }
                    return await runVocoder();
                } finally {
                    if (releasedRetry) {
                        await this._reloadDiffStepAfterVocoder();
                    }
                    _dynamicReleaseDiffStepNextSegment = false;
                }
            }
            // 非 OOM：vendor EP（TensorRT-RTX）引擎级失败时降级重建会话并重试一次。
            try {
                return await this._retryVocoderOnFallbackEp(err, runVocoder);
            } catch (fallbackErr) {
                if (fallbackErr !== err) {
                    console.error(`[OnnxSVSPipeline] Vocoder fallback retry failed: ${fallbackErr.message}`);
                }
            }
            // Either not an OOM, or already retried: rethrow to caller.
            // If the retry above also threw, we reach here without clearing the
            // dynamic flag — clear it now so the next segment starts clean.
            _dynamicReleaseDiffStepNextSegment = false;
            throw err;
        } finally {
            // Vocoder 推理完成（或抛错）后立即重载 diffStep，保持 session 状态一致：
            // - 多 segment 合成的下一段需要 diffStep
            // - _recreateHeavySessionsAfterSynthesis 期望 diffStep 存在（否则会跳过 release）
            // - 用户关闭 releaseDmlVramAfterSynthesis 时，下次合成依赖 ensureAllModelsLoaded 检测缺失才重载
            //   会让用户感知到"下次合成变慢"，不如在这里主动重载
            if (releasedDiffStep) {
                await this._reloadDiffStepAfterVocoder();
            }
            // Always clear the dynamic flag at the end of a segment (success or
            // failure) so the next segment reverts to the user setting.
            _dynamicReleaseDiffStepNextSegment = false;
        }
    }

    /**
     * 分块流式路径专用：对 mel 片段运行 vocoder 推理。
     * 与 _runVocoderChunked 的区别：
     * 1. 不释放 diffStep（下一个 diffusion chunk 还需要它，释放/重载开销过大）
     * 2. 接受 f0Override 参数（每段 mel 对应不同的 F0 片段）
     * 3. 不做 vocoderType 一致性检测（已在主路径做过，片段路径重复检测浪费）
     */
    async _runVocoderChunkedForSegment(melData, segFrames, f0Override, onChunkComplete, frameOffset = 0, melCtx = null) {
        melData = this._postprocessMel(melData, segFrames, frameOffset, '[VocoderSeg]', melCtx);
        const chunkFrames = this._resolveVocoderChunkFrames();
        const overlapFramesOverride = this._resolveVocoderOverlapFrames();
        const runVocoder = () => this._postprocessing.runVocoderChunked(
            this.sessions, melData, segFrames, this.vocoderIsFP16 ?? this.isFP16, false,
            this.vocoderType, f0Override, this.sifiganStatsMissing, onChunkComplete, chunkFrames, overlapFramesOverride
        );
        try {
            return await runVocoder();
        } catch (err) {
            try {
                return await this._retryVocoderOnFallbackEp(err, runVocoder);
            } catch (fallbackErr) {
                if (fallbackErr !== err) {
                    console.error(`[OnnxSVSPipeline] Segment vocoder fallback retry failed: ${fallbackErr.message}`);
                }
                throw err;
            }
        }
    }
````

### R25 · 管线：多 segment 的段级合成（内部 onChunkAudio=null）

文件：`src/inference/pipeline/index.js`　行：`3080-3250`

````javascript
    async _synthesizeSegment(segmentNotes, bpm, f0Envelope, pitchCurveF0, f0Shift, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange, onChunkAudio = null, segStartBeat = 0, abortSignal = null, melCacheKey = null) {
        throwIfCancelled(abortSignal);
        // 多 segment 路径：segmentNotes.start 是相对 segStart，需要传 segStartBeat
        // 让 notesToSequences 正确索引绝对时间的 pitchCurveF0，否则 f0 错位 → 电流声。
        const pitchCurveOffsetSec = (segStartBeat / bpm) * 60;
        const sequences = this.notesToSequences(segmentNotes, bpm, f0Envelope, pitchCurveF0, f0Shift, pitchCurveOffsetSec);
        let totalFrames = sequences.f0Ids.length;
        const tokenCount = sequences.tokenCount;

        if (totalFrames === 0) {
            return { audio: [], frames: 0 };
        }

        if (totalFrames > MAX_SAFE_FRAMES) {
            console.warn(`[OnnxSVSPipeline] Segment frame count ${totalFrames} exceeds safe limit ${MAX_SAFE_FRAMES}, truncating`);
            sequences.f0Ids = sequences.f0Ids.subarray(0, MAX_SAFE_FRAMES);
            sequences.mel2token = sequences.mel2token.subarray(0, MAX_SAFE_FRAMES);
            totalFrames = MAX_SAFE_FRAMES;
        }

        console.log(`[OnnxSVSPipeline] Segmented synthesis: frames=${totalFrames}, tokens=${tokenCount}, steps=${totalSteps}`);

        // 频谱后处理时间对齐：本次 mel 第 0 帧对应 segmentNotes[0].start（segment
        // 相对坐标），绝对拍 = segStartBeat + 该值；载荷锚在分片首音符（startBeat），
        // 两者之差换算为载荷帧偏移，否则曲线在 segment > 0 时整体平移 regionStart。
        const _melBaseOffset = this._melPostprocessFrameOffset(
            segStartBeat + (segmentNotes.length > 0 ? segmentNotes[0].start : 0)
        );

        // NPU 静态形状模型限制：ptFrameCount+totalFrames 不得超过 NPU_STATIC_SEQ_LEN。
        // 大 ref prompt（>50 帧）时按 Math.min(ptFrameCount,50) 预留 target 会不足预留，
        // 导致 diffstep 拼接 offset overflow；统一用实际 ptFrameCount 预留 target 帧。
        // 启用 INT8 静态形状分段合成时不做整段钳制（避免长片段被丢弃到 2048 帧），
        // 由 _synthesizeStaticShapeSegments 逐段处理 2048 限制。
        const _staticSegChunkEnabled = this.useStaticShapes &&
            (this._currentDiffStepChunkOpts && this._currentDiffStepChunkOpts.enabled === true);
        if (this.useStaticShapes && !_staticSegChunkEnabled) {
            const budget = this._staticSeqBudget();
            if (ptFrameCount + totalFrames > budget) {
                const clamped = this._clampStaticShapeFrames(sequences, ptFrameCount, ptMelData, totalFrames, '[Segment]', budget);
                totalFrames = clamped.totalFrames;
                ptFrameCount = clamped.ptFrameCount;
                ptMelData = clamped.ptMelData;
            }
        }

        // 长度钳制可能缩短了 prompt；同步裁剪 promptSeq，保证 cond 与 mel 等长。
        const promptSeq = this._finalizePromptSeq(this._currentPromptSeq, ptFrameCount);

        // WebNN: encoder+diffusion in renderer, vocoder in main process (DML)
        // 渲染进程运行 encoder+diffusion 返回 mel；主进程 DML 运行 vocoder（支持 SiFiGAN 双输入）
        if (this.useWebNN) {
            onProgress(Math.round(progressStart));
            const t0 = performance.now();
            // Map WebNN progress (0-100) to segment progress range
            const webnnOnProgress = (p) => {
                onProgress(Math.round(progressStart + (p / 100) * progressRange));
            };
            const result = await this._runWebNNSynthesis({
                sequences, tokenCount, totalFrames,
                ptMelData, ptFrameCount,
                promptSeq,
                totalSteps, cfgStrength, cfgRescale,
                npuDiffBatchSize, npuVocoderBatchSize,
                cfgScheduleOpts: this._currentCfgScheduleOpts,
                scoreMode: this._pitchControlMode === 'score',
            }, webnnOnProgress);
            // Forward WebNN warnings (e.g. NPU static shape truncation)
            if (result.warnings && result.warnings.length > 0) {
                for (const w of result.warnings) console.warn(`[OnnxSVSPipeline] ${w}`);
            }
            // Cache F0 (Hz, mel frame rate=50Hz) for SiFiGAN dual-input vocoder
            this._currentF0Hz = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;
            // Vocoder 在主进程 DML 执行（支持 default + SiFiGAN）
            // melCtx 必须带 payloadBase/startFrame：_postprocessMel 走
            // applyMelPostprocessWindow 分支时只认这两个字段，第 4 个形参
            // frameOffset 会被忽略（缺字段 → 偏移按 0 处理，曲线时间轴回到
            // 分片首音符）。见 _postprocessMel 的注释。
            const audioData = await this._runVocoderChunked(result.xtData, totalFrames, onChunkAudio, _melBaseOffset, { fullMel: result.xtData, totalFrames, startFrame: 0, payloadBase: _melBaseOffset, rightFinal: true });
            const ms = performance.now() - t0;
            console.log(`[OnnxSVSPipeline] WebNN synthesis: ${totalFrames}frames, ${totalSteps}steps, ${ms.toFixed(0)}ms`);
            onProgress(Math.round(progressStart + progressRange));
            return { audio: audioData, frames: totalFrames };
        }

        const totalFramesWithPrompt = ptFrameCount + totalFrames;

        // INT8 静态形状 + 分段合成：逐段 encoder+diffstep 直接产出整段 mel，不整段编码。
        let xt;
        if (_staticSegChunkEnabled) {
            const segMel = await this._synthesizeStaticShapeSegments(
                sequences, totalFrames, ptMelData, ptFrameCount,
                totalSteps, cfgStrength, cfgRescale,
                onProgress, progressStart, progressRange, abortSignal, '[Segment]'
            );
            if (segMel) {
                xt = { data: segMel, dims: [1, totalFrames, MEL_DIM] };
                // Task 15: per-frame F0 curve for vocoder boundary selection
                this._currentPitchCurveF0 = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;
            }
        }
        if (!xt) {
            // Task 15: per-frame F0 curve for F0-aware chunked diffusion boundary
            // selection. Slice to totalFrames to match the segment's frame range.
            this._currentPitchCurveF0 = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;

            // mel 级缓存命中：跳过 encoder+diffusion（GPU 重活），仅重跑 vocoder。
            // 触发场景：音色曲线（melPostprocess）修改 —— segment 原始 mel 与上次相同。
            const cachedSegMel = melCacheKey ? this._melCacheGet(melCacheKey) : null;
            if (cachedSegMel && cachedSegMel.frames === totalFrames) {
                xt = { data: cachedSegMel.mel, dims: [1, totalFrames, MEL_DIM] };
                console.log('[OnnxSVSPipeline] >>> SEGMENT MEL CACHE HIT <<< skipping encoder+diffusion (vocoder only)');
            } else {
                const combinedCond = await this._runEncoder(sequences, tokenCount, totalFrames, ptFrameCount, promptSeq);

                // GPU 排空点 1：encoder（6 次推理）→ diffusion 切换前等待 DML 回收 encoder 的 GPU 资源
                await gpuDrainAdaptive();

                xt = this.randomNoise(totalFrames, MEL_DIM);

                await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, progressStart, progressRange, null, abortSignal);

                // 缓存原始 mel（音色曲线后续修改时复用）
                if (melCacheKey) {
                    this._melCachePut(melCacheKey, { mel: xt.data, frames: totalFrames });
                }
            }
        }

        // 诊断：扩散输出（vocoder 输入 mel）统计 - 检查是否包含 NaN/异常值
        // NaN/Inf 致命错误 console.error 始终输出；统计采样 console.log 受 diagnosticMode 控制
        {
            const xtLen = xt.data.length;
            let xtNaN = 0, xtInf = 0;
            for (let i = 0; i < xtLen; i++) {
                const v = xt.data[i];
                if (Number.isNaN(v)) { xtNaN++; continue; }
                if (!Number.isFinite(v)) { xtInf++; }
            }
            if (xtNaN > 0 || xtInf > 0) {
                console.error(`[DiffusionDiag] DIFFUSION OUTPUT HAS NaN/Inf! This will cause vocoder explosion!`);
            }
            if (_readDiagnosticMode()) {
                let xtMin = Infinity, xtMax = -Infinity, xtSum = 0, xtSumSq = 0;
                for (let i = 0; i < xtLen; i++) {
                    const v = xt.data[i];
                    if (Number.isNaN(v) || !Number.isFinite(v)) continue;
                    if (v < xtMin) xtMin = v;
                    if (v > xtMax) xtMax = v;
                    xtSum += v;
                    xtSumSq += v * v;
                }
                const xtMean = xtSum / xtLen;
                const xtStd = Math.sqrt(Math.max(0, xtSumSq / xtLen - xtMean * xtMean));
                console.log(`[DiffusionDiag] OUTPUT xt (vocoder input): frames=${totalFrames}, len=${xtLen}, NaN=${xtNaN}, Inf=${xtInf}, min=${xtMin.toFixed(6)}, max=${xtMax.toFixed(6)}, mean=${xtMean.toFixed(6)}, std=${xtStd.toFixed(6)}`);
            }
        }

        // GPU 排空点 2：diffusion（64 次推理）→ vocoder 切换前等待 DML 回收 diffusion 的 GPU 资源。
        // 这是最关键的排空点：32 步 × 2 次 cond/uncond = 64 次连续 diff_step 推理后，
        // DML 内部资源池累积了大量 transformer 注意力中间张量，不排空直接进 vocoder 会 OOM。
        await gpuDrainAdaptive();

        // Cache F0 (Hz, mel frame rate=50Hz) for SiFiGAN dual-input vocoder; truncated to totalFrames to match mel after NPU/MAX_SAFE truncation. null when unavailable.
        this._currentF0Hz = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;

        // 同上：melCtx 需显式带 payloadBase/startFrame，否则 _melBaseOffset 被丢弃。
        const audioData = await this._runVocoderChunked(xt.data, totalFrames, null, _melBaseOffset, { fullMel: xt.data, totalFrames, startFrame: 0, payloadBase: _melBaseOffset, rightFinal: true });

        return { audio: audioData, frames: totalFrames };
    }
````

### R26 · 管线：多 segment 流式发射器（按时间序门控 + 静音补洞）

文件：`src/inference/pipeline/index.js`　行：`3252-3392`

````javascript
    /**
     * 多 segment 流式发射器（分片编辑器预览专用，synthesize() 多 segment 路径用）。
     *
     * 旧行为：多 segment 路径（分片 >20s 或含 ≥1.5s 长休止被 buildVocalSegments /
     * splitLongRestRegions 切段）完全不推送 chunk —— _synthesizeSegment 的
     * onChunkAudio 传 null，分片编辑器播放预览必须等全部 segment 推理完才开播。
     *
     * 设计约束：渲染端（fragmentEditor/audioPlayback.js handleStreamingChunk）按
     * 到达顺序无缝拼接 chunk，不感知采样偏移。因此主进程必须保证 chunk 严格按
     * 时间顺序、时间轴连续地发射：
     *   - segment 按 startBeat 时间序排序；segment 合成（或缓存命中）完成后入队，
     *     前面的 segment 全部发射完才轮到它。priorityTimeSec 重排 / 分片缓存命中
     *     导致的乱序完成会被缓冲，绝不提前发射未覆盖区间。
     *   - 相邻 region 间的长休止中心（splitLongRestRegions 刻意不送推理的区间，
     *     最终混音里就是 weightSum=0 的静音）补一段静音 chunk，保证播放头时间轴
     *     与最终混音一致。
     *   - 同 region 内 20s 分段有 SEGMENT_OVERLAP_SEC(2s) 重叠（最终混音做交叉
     *     淡化）。顺序流式无法做 OLA 叠加：保留前序 segment 整段、裁掉后续
     *     segment 的重叠头部，接头处两端 15ms 余弦渐变防爆音。流式接缝听感与
     *     最终缓存版略有差异，属预期（重播走缓存即为交叉淡化版本）。
     *   - isLast 只随时间轴上最后一个 chunk 发出（空 segment 收尾时补 1 样本
     *     静音 chunk 承载 isLast），否则渲染端 markLastReceived 永不触发。
     *
     * @param {Array<{startBeat:number,endBeat:number}>} segments - synthesize() 里的 segments
     * @param {number} bpm
     * @param {number} firstNoteStartBeat - filledNotes[0].start（最终 audioData[0] 对应的绝对拍位）
     * @param {number} totalSamples - 多 segment 路径的 finalAudio 总样本数（含前导休止）
     * @param {function} onChunkAudio - synthesize() 的流式推送回调
     * @returns {{segmentDone: (segIdx:number, audio:Float32Array|null) => void}}
     */
    _createSegmentStreamEmitter(segments, bpm, firstNoteStartBeat, totalSamples, onChunkAudio) {
        const firstNoteStartSample = Math.floor((firstNoteStartBeat / bpm) * 60 * SAMPLE_RATE);
        const totalSamplesRel = Math.max(0, totalSamples - firstNoteStartSample);
        const timeOrder = segments.map((_, i) => i)
            .sort((a, b) => segments[a].startBeat - segments[b].startBeat);
        const metas = new Map();
        for (const idx of timeOrder) {
            metas.set(idx, {
                relStart: Math.floor((segments[idx].startBeat / bpm) * 60 * SAMPLE_RATE) - firstNoteStartSample,
                relEnd: Math.floor((segments[idx].endBeat / bpm) * 60 * SAMPLE_RATE) - firstNoteStartSample,
                audio: null,
            });
        }
        // 采样取整误差内视为连续（不补静音），≈21ms
        const CONTIG_EPS = Math.round(0.021 * SAMPLE_RATE);
        const FADE_SAMPLES = Math.max(1, Math.round(0.015 * SAMPLE_RATE));
        let frontier = 0;    // 已发射前沿（相对 firstNoteStart 的采样位置）
        let nextTimeIdx = 0; // timeOrder 中下一个待发射的 segment
        let finished = false;

        const fadeInHead = (audio) => {
            const n = Math.min(FADE_SAMPLES, audio.length);
            for (let i = 0; i < n; i++) {
                audio[i] *= 0.5 * (1 - Math.cos((Math.PI * i) / n));
            }
        };
        const fadeOutTail = (audio) => {
            const n = Math.min(FADE_SAMPLES, audio.length);
            const base = audio.length - n;
            for (let i = 0; i < n; i++) {
                audio[base + i] *= 0.5 * (1 + Math.cos((Math.PI * i) / n));
            }
        };
        const emitChunk = (audio, isLast) => {
            if (!audio || audio.length === 0) return false;
            try {
                onChunkAudio({
                    chunkIndex: nextTimeIdx,
                    sampleOffset: frontier,
                    sampleEnd: frontier + audio.length,
                    audio,
                    totalSamples: totalSamplesRel,
                    isLast,
                });
            } catch (_) {}
            console.log(`[SegInfer][FRAG] chunk emitted | seg=${nextTimeIdx}/${timeOrder.length} offset=${frontier} end=${frontier + audio.length} isLast=${isLast} t=${Date.now()}`);
            frontier += audio.length;
            return true;
        };

        const tryEmit = () => {
            while (!finished && nextTimeIdx < timeOrder.length) {
                const segIdx = timeOrder[nextTimeIdx];
                const meta = metas.get(segIdx);
                if (!meta || !meta.audio) break; // 该 segment 尚未完成，等待
                const isLastSeg = nextTimeIdx === timeOrder.length - 1;
                // 前置静音：region 间长休止中心（与最终混音的零填充区一致）
                const gapSamples = meta.relStart - frontier;
                if (gapSamples > CONTIG_EPS) {
                    emitChunk(new Float32Array(gapSamples), false);
                }
                let audio = meta.audio;
                const trim = Math.max(0, Math.min(frontier - meta.relStart, audio.length));
                if (trim > 0) {
                    // 与前序 segment 的 2s 重叠：裁掉头部，接头做 15ms 渐入
                    audio = audio.slice(trim);
                    fadeInHead(audio);
                } else {
                    // 复制后再施加渐变，避免污染分片缓存里的原始音频
                    audio = audio.slice();
                }
                if (!isLastSeg) {
                    const nextMeta = metas.get(timeOrder[nextTimeIdx + 1]);
                    // 后续 segment 与本段重叠（其头部将被裁剪）→ 本段尾部渐出防爆破
                    if (nextMeta && nextMeta.relStart < meta.relEnd) fadeOutTail(audio);
                }
                if (isLastSeg) {
                    // 末段尾部补静音：vocoder 输出按帧取整，末段音频常比时间轴短几个
                    // 采样（实测 ~241 样本 ≈10ms）。补齐后流式时间轴长度与最终混音
                    // 完全一致，播放头不会在末尾差一截就停。必须并入本 chunk 而不是
                    // 追加一个新 chunk —— 追加的会被渲染端 isLastReceived 之后的守卫丢弃。
                    const wantLen = totalSamplesRel - frontier;
                    if (wantLen > audio.length) {
                        const padded = new Float32Array(wantLen);
                        padded.set(audio, 0);
                        audio = padded;
                    }
                }
                const emitted = emitChunk(audio, isLastSeg);
                meta.audio = null; // 释放引用
                nextTimeIdx++;
                if (isLastSeg && !emitted) {
                    // 最后一个 segment 无音频（全休止 / 空结果）：补 1 样本静音承载 isLast
                    emitChunk(new Float32Array(1), true);
                }
            }
            if (nextTimeIdx >= timeOrder.length) finished = true;
        };

        return {
            segmentDone(segIdx, audio) {
                if (finished) return;
                const meta = metas.get(segIdx);
                if (!meta || meta.audio) return; // 未知 segment / 重复完成
                const samples = (audio && audio.length > 0) ? audio.length : 0;
                console.log(`[SegInfer][FRAG] segment inference done | seg=${segIdx}/${timeOrder.length} samples=${samples} relStart=${meta.relStart} relEnd=${meta.relEnd} t=${Date.now()}`);
                meta.audio = samples > 0 ? audio : new Float32Array(0);
                tryEmit();
            },
        };
    }
````

### R27 · 管线：synthesize 串行入口

文件：`src/inference/pipeline/index.js`　行：`3544-3563`

````javascript
    async synthesize(notes, bpm, options = {}) {
        // 串行化：防止并发 synthesize() 调用导致的 session 重建竞态（见 _synthPromise 注释）。
        // 复用 _initPromise 模式：await 上一条合成（含 _recreateHeavySessionsAfterSynthesis）
        // 完全结束后再启动本条。
        // 注：噪声种子必须在**拿到锁之后**设置（见 _synthesizeImpl 开头）。若在此处设置，
        // 并发时后一条会改掉前一条正在推进的 RNG 状态，固定种子反而失去可复现性。
        if (this._synthPromise) {
            try { await this._synthPromise; } catch (_) {}
        }
        this._synthPromise = this._synthesizeImpl(notes, bpm, options);
        try {
            const audio = await this._synthPromise;
            // postWaveform：交给插件做后处理（去咔嗒 / EQ / 增益）。
            // 放在 _synthPromise 的持有期内 —— hook 也是这次合成的一部分，
            // 下一次合成不该在它跑完前抢走 session。
            return await applyPipelineHooks('postWaveform', audio, { sampleRate: SAMPLE_RATE, bpm });
        } finally {
            this._synthPromise = null;
        }
    }
````

### R28 · 管线：_synthesizeImpl 全量（缓存 → 分段 → 分块流式 → 混合）

文件：`src/inference/pipeline/index.js`　行：`4366-5187`

````javascript
    async _synthesizeImpl(notes, bpm, options = {}) {
        if (!this.initialized) {
            await this.init();
        }
        await this.ensureAllModelsLoaded();
        // 固定噪声种子：必须在锁内（本函数）设置，确保设置后到扩散开始之间
        // 没有另一条合成交替推进 RNG。显式 options.seed（测量用途）优先于设置。
        if (Number.isFinite(options.seed)) {
            this._diffusion.setNoiseSeed(options.seed);
        } else {
            this._applyFixedNoiseSeedSetting();
        }
        // Reset per-call F0 cache so a stale F0 from a previous synthesis cannot leak into SiFiGAN vocoder input
        this._currentF0Hz = null;
        // 每轮合成重置"扩散已产出非有限值"标记：它属于单次任务的状态，
        // 跨任务继承会让上一轮失败把这一轮（可能已经换到 DML）也判死。
        this._diffusion.resetBlacklist();
        // Task 15: reset per-frame F0 curve for F0-aware chunked diffusion.
        this._currentPitchCurveF0 = null;
        // 每次合成入口重置 prompt token 序列，避免上一轮歌手的标注残留。
        this._currentPromptSeq = null;
        const onProgress = options.onProgress || (() => {});
        const abortSignal = options.abortSignal || null;
        throwIfCancelled(abortSignal);
        const f0Envelope = options.f0Envelope || null;
        // score = 不给 f0 条件，音高只由 note_pitch 提供（官方 control="score"）。
        // 每次入口都显式赋值（而不是只在 score 时写），否则上一段的 score 会残留
        // 到下一条请求上，把 manual 分片静默唱成"无 F0"。
        this._pitchControlMode = options.pitchControl === 'score' ? 'score' : 'manual';
        const pitchCurveF0 = this._pitchControlMode === 'score' ? null : (options.pitchCurveF0 || null);
        const refAudioWavBuffer = options.refAudioWavBuffer || null;
        const totalSteps = options.nSteps || DEFAULT_DIFF_STEPS;
        const cfgStrength = options.cfg !== undefined ? options.cfg : CFG_STRENGTH;
        const cfgRescale = options.cfgRescale !== undefined ? options.cfgRescale : CFG_RESCALE;
        const autoShift = options.autoShift || false;
        const pitchShift = options.pitchShift || 0;
        const npuDiffBatchSize = options.npuDiffBatchSize || 4;
        const npuVocoderBatchSize = options.npuVocoderBatchSize || 2;
        const onChunkAudio = options.onChunkAudio || null;
        // 优先推理时间点（秒，相对本次合成的 0 起点）——自动实时推理传入编辑器的
        // 播放进度条位置。0 / 非法值 = 不指定，退化为"第一个改动位置"。
        // 详见多 segment 区的 order 计算注释。
        const priorityTimeSec = Number.isFinite(options.priorityTimeSec) ? options.priorityTimeSec : 0;

        // 求解器名称（透传到 _runDiffusionLoop → diffusion.js）
        this._currentSamplerName = options.sampler || DEFAULT_SOLVER;
        // Q-Drift 漂移校正开关（预览/导出各自独立，由调用方按路径传入）
        this._currentQDriftEnabled = options.qdrift === true;
        // Task 11: CFG 强度曲线调度（透传到 _runDiffusionLoop → diffusion.js）
        this._currentCfgScheduleOpts = {
            mode: options.cfgScheduleMode || 'constant',
            cfgStrengthStart: options.cfgStrengthStart ?? null,
            keyframes: options.cfgScheduleKeyframes ?? null,
        };
        // Dynamic thresholding (Imagen, arXiv:2205.11487): per-frame percentile clipping
        // of CFG-predicted mel before rescale. Prevents over-exposure at high CFG.
        this._currentDynamicThresholdOpts = options.dynamicThresholdEnabled
            ? { enabled: true, percentile: options.dynamicThresholdPercentile ?? 0.995 }
            : null;
        this._currentDiffStepChunkOpts = {
            enabled: options.diffStepChunk === true,
            chunkFrames: options.diffStepChunkFrames || 500,
            overlapFrames: options.diffStepOverlapFrames !== undefined ? options.diffStepOverlapFrames : 50,
        };
        // 频谱后处理（分片编辑器"音色 → 频谱"曲线）：在 vocoder 之前作用于 mel。
        // 无参数时归一化返回 null，后续 _postprocessMel 走零开销快路径。
        this._melPostprocessOptions = normalizeMelPostprocessOptions(options.melPostprocess);

        const filledNotes = this._fillNoteGaps(notes);

        // 一次算出 synth/mel 两个缓存键，共享昂贵的 optionKeyPart（参考音频/F0/prompt 哈希）。
        // 旧实现 computeSynthCacheKey + computeMelCacheKey 各算一遍这段哈希，缓存命中检查
        // 便付出双倍成本 —— 表现为「命中缓存仍有可见延迟」。
        // melKey 不含 melPostprocess（音色曲线只改 vocoder 输入，diffstep 产物与它无关）。
        const { synthKey: cacheKey, melKey } = this._computeCacheKeyPair(notes, bpm, options);
        const cachedAudio = this._synthCacheGet(cacheKey);
        if (cachedAudio) {
            console.warn(`[OnnxSVSPipeline] >>> CACHE HIT <<< key=${cacheKey.substring(0, 32)}... | Returning CACHED audio, vocoder will NOT run! (Clear cache: switch model or restart app)`);
            onProgress(100);
            // 流式消费方（分片编辑器）需要 chunk 才能"边收边播"；整段直接返回
            // 会让它退化成"等完整缓冲再开播"（见 _emitCachedAudioAsChunks 注释）。
            this._emitCachedAudioAsChunks(cachedAudio, onChunkAudio);
            return cachedAudio;
        }
        console.log(`[OnnxSVSPipeline] Cache MISS (key=${cacheKey.substring(0, 32)}...), running full synthesis pipeline`);

        let currentProgress = 0;
        onProgress(currentProgress);

        // targetNotePitches 在 autoShift 与手动 pitchShift 两种模式下都需要：
        // JP pitch 范围保护（_clampJpPitchRange）无论 autoShift 是否启用都生效，
        // 因此提前在外层作用域计算，避免 "targetNotePitches is not defined"。
        const targetNotePitches = [];
        for (const note of filledNotes) {
            if (note.pitch >= 1) targetNotePitches.push(note.pitch);
        }

        let f0Shift = 0;
        if (autoShift && pitchShift === 0) {
            const targetF0 = this.buildF0FrameSequence(filledNotes, bpm, f0Envelope, pitchCurveF0);
            const targetNonZero = [];
            for (let i = 0; i < targetF0.length; i++) {
                if (targetF0[i] > 0) targetNonZero.push(targetF0[i]);
            }

            let refF0 = null;
            if (refAudioWavBuffer) {
                try {
                    // 优先使用外部 RMVPE 提取器（精度更高），失败回退自相关
                    refF0 = await this._extractRefF0WithFallback(refAudioWavBuffer, options.refF0Extractor || null);
                } catch (e) {
                    console.warn('[OnnxSVSPipeline] Reference audio F0 extraction failed:', e.message);
                }
            }

            if (refF0 && refF0.length > 0) {
                const refNonZero = [];
                for (let i = 0; i < refF0.length; i++) {
                    if (refF0[i] > 0) refNonZero.push(refF0[i]);
                }
                if (refNonZero.length > 0 && targetNonZero.length > 0) {
                    const refMedian = this._median(refNonZero);
                    const targetMedian = this._median(targetNonZero);
                    f0Shift = Math.round(Math.log2(refMedian / targetMedian) * 1200 / 100);
                } else if (targetNotePitches.length > 0) {
                    const refNotePitches = await this._extractRefNotePitchesAsync(refAudioWavBuffer);
                    if (refNotePitches && refNotePitches.length > 0) {
                        const refMedianPitch = this._median(refNotePitches);
                        const targetMedianPitch = this._median(targetNotePitches);
                        f0Shift = Math.round(refMedianPitch - targetMedianPitch);
                    }
                }
            } else if (targetNotePitches.length > 0) {
                const refNotePitches = options.refNotePitches || null;
                if (refNotePitches && refNotePitches.length > 0) {
                    const refMedianPitch = this._median(refNotePitches);
                    const targetMedianPitch = this._median(targetNotePitches);
                    f0Shift = Math.round(refMedianPitch - targetMedianPitch);
                }
            }

            // 限制 f0Shift 范围，防止偏移后音高超出模型/vocoder 训练分布导致 OOD。
            // 根因：autoShift 基于全局中位数计算单一 f0Shift，当分片内音高跨度大时，
            //   极端音符偏移后会超出 vocoder f0 有效范围（SiFiGAN 对 f0 敏感，过高
            //   导致激励畸变→口齿不清）或 encoder pitch embedding 训练范围。
            const clampedShift = this._clampAutoShift(f0Shift, targetNotePitches);
            if (clampedShift !== f0Shift) {
                console.log(`[OnnxSVSPipeline] autoShift clamped: ${f0Shift} → ${clampedShift}`);
                f0Shift = clampedShift;
            }
        } else {
            f0Shift = pitchShift;
        }

        // JP pitch 范围保护：无论 autoShift 还是手动 pitchShift 都生效。
        // 根因：JSUT 训练数据全部 pitch=60，JP 专属模块（cond_emb/diff_step/preflow）
        // 只在有限 pitch 范围微调，OOD pitch → cond_embedding 异常 → 音素错乱。
        // 即使 f0Shift=0，如果音符本身超出 [48,84] 也需要 auto-transpose。
        if (this.languageOverride === 'ja' && targetNotePitches && targetNotePitches.length > 0) {
            const jpClamped = this._clampJpPitchRange(f0Shift, targetNotePitches);
            if (jpClamped !== f0Shift) {
                console.log(`[OnnxSVSPipeline] JP pitch range clamped: ${f0Shift} → ${jpClamped} (effective pitch kept in [48,84])`);
                f0Shift = jpClamped;
            }
        }

        let ptMelData = null;
        let ptFrameCount = 0;
        let promptSeq = null;

        if (refAudioWavBuffer) {
            try {
                const melResult = await this._extractRefMelOnnx(refAudioWavBuffer);
                ptMelData = melResult.data;
                ptFrameCount = melResult.frames;
                console.log(`[OnnxSVSPipeline] Reference audio mel: ${ptFrameCount}frames`);
            } catch (err) {
                try {
                    const melResult = await this._extractRefMelAsync(refAudioWavBuffer);
                    ptMelData = melResult.data;
                    ptFrameCount = melResult.frames;
                } catch (err2) {
                    // JS fallback also failed, use zero prompt
                }
            }
            // 用 .sxssinger 的歌词/MIDI/F0 构建 prompt token 序列，并把参考 mel
            // 裁到同一时间窗。无标注时 promptSeq=null，保持旧的 cond=0 行为。
            const promptInfo = this._buildPromptCond(options, ptMelData, ptFrameCount, f0Shift);
            promptSeq = promptInfo.promptSeq;
            ptMelData = promptInfo.ptMelData;
            ptFrameCount = promptInfo.ptFrameCount;
            // Diagnostic cap (CLI --max-prompt-frames): keep the first N prompt
            // frames, matching the qdrift-conds export convention. Used to
            // isolate long-reference-prompt effects on long target sequences.
            if (!promptSeq && Number.isInteger(options.maxPromptFrames) && options.maxPromptFrames > 0
                && ptFrameCount > options.maxPromptFrames) {
                console.log(`[OnnxSVSPipeline] Reference mel capped: ${ptFrameCount} -> ${options.maxPromptFrames}frames (diagnostic)`);
                ptMelData = ptMelData.subarray(0, options.maxPromptFrames * MEL_DIM);
                ptFrameCount = options.maxPromptFrames;
            }
        }

        const segments = this._buildVocalSegments(filledNotes, bpm);
        if (segments.length === 0) {
            onProgress(100);
            return new Float32Array(0);
        }

        if (segments.length === 1) {
            const seg = segments[0];
            let segNotes = seg.notes || filledNotes;

            // 单 note 上下文 padding：单 note 时 fillNoteGaps 不补 rest，导致 token 序列极短
            // （仅 [PAD,BOW,ph,EOW]）、noteTypeSeq 单一、mel2token 无 PAD 静音参考帧。
            // 这对 diffusion/preflow 是 OOD 输入，合成质量差（"意义不明的声音"）。
            // 修复：单 note 时在前后各加 1 拍 rest note，提供 token 多样性与静音参考帧，
            // 合成后截取有效音频。
            let contextPadding = null;
            let pitchCurveOffsetSec = 0;
            if (segNotes.length === 1) {
                const REST_BEATS = 1;
                const originalNote = segNotes[0];
                const restNote = { lyric: '', pitch: 0, start: 0, duration: REST_BEATS };
                const shiftedNote = { ...originalNote, start: REST_BEATS };
                const tailRest = { lyric: '', pitch: 0, start: REST_BEATS + originalNote.duration, duration: REST_BEATS };
                segNotes = [restNote, shiftedNote, tailRest];
                const restFrames = Math.floor((REST_BEATS / bpm) * 60 * SAMPLE_RATE / HOP_SIZE);
                const validFrames = Math.floor((originalNote.duration / bpm) * 60 * SAMPLE_RATE / HOP_SIZE);
                contextPadding = { offsetFrames: restFrames, validFrames };
                // 修复：context padding 将 note 的 start 偏移到 REST_BEATS，需要补偿 pitchCurveOffsetSec
                // 让 notesToSequences 正确索引绝对时间的 pitchCurveF0，否则 f0 错位 → 沙哑声音。
                pitchCurveOffsetSec = ((originalNote.start - REST_BEATS) / bpm) * 60;
                console.log(`[OnnxSVSPipeline] Single-note context padding: +${restFrames} rest frames before/after`);
            }

            // 频谱后处理时间对齐：mel 第 0 帧对应 segNotes[0].start（contextPadding
            // 时是垫入的前置休止 = 拍 0），载荷锚在分片首音符 → 单音符 padding 时
            // 偏移为负（曲线向 0 夹紧，休止区沿用曲线首值）。
            const _melBaseOffset = this._melPostprocessFrameOffset(segNotes.length > 0 ? segNotes[0].start : 0);

            const sequences = this.notesToSequences(segNotes, bpm, f0Envelope, pitchCurveF0, f0Shift, pitchCurveOffsetSec);
            let totalFrames = sequences.f0Ids.length;

            if (totalFrames === 0) {
                return [];
            }

            if (totalFrames > MAX_SAFE_FRAMES) {
                console.warn(`[OnnxSVSPipeline] Frame count ${totalFrames} exceeds safe limit ${MAX_SAFE_FRAMES}, truncating`);
                sequences.f0Ids = sequences.f0Ids.subarray(0, MAX_SAFE_FRAMES);
                sequences.mel2token = sequences.mel2token.subarray(0, MAX_SAFE_FRAMES);
                totalFrames = MAX_SAFE_FRAMES;
            }

            if (!ptMelData || ptFrameCount === 0) {
                ptFrameCount = Math.min(50, Math.max(10, Math.floor(totalFrames * 0.1)));
                ptMelData = new Float32Array(ptFrameCount * MEL_DIM);
            }

            // NPU 静态形状模型限制：ptFrameCount+totalFrames 不得超过 NPU_STATIC_SEQ_LEN。
            // 大 ref prompt（>50 帧）时按 Math.min(ptFrameCount,50) 预留 target 会不足预留，
            // 导致 diffstep 拼接 offset overflow；统一用实际 ptFrameCount 预留 target 帧。
            // 启用静态形状分段合成时跳过整段钳制，由 _synthesizeStaticShapeSegments 逐段承载限制。
            const _staticSegEnabled = this.useStaticShapes &&
                (this._currentDiffStepChunkOpts && this._currentDiffStepChunkOpts.enabled === true);
            if (this.useStaticShapes && !_staticSegEnabled) {
                const budget = this._staticSeqBudget();
                if (ptFrameCount + totalFrames > budget) {
                    const clamped = this._clampStaticShapeFrames(sequences, ptFrameCount, ptMelData, totalFrames, '[Synthesis]', budget);
                    totalFrames = clamped.totalFrames;
                    ptFrameCount = clamped.ptFrameCount;
                    ptMelData = clamped.ptMelData;
                }
            }
            // diff_step 模型容量兜底：prompt+target 总长 <=8192（烘焙 rope 表
            // 行数，超限时 Slice 行数不足会广播失败）。优先只截 prompt，目标乐句
            // 保持整段连续去噪，无拼接边界。
            if (!this.useStaticShapes) {
                const seqClamped = this._clampDiffStepMaxFrames(sequences, ptFrameCount, ptMelData, totalFrames, '[Synthesis]');
                totalFrames = seqClamped.totalFrames;
                ptFrameCount = seqClamped.ptFrameCount;
                ptMelData = seqClamped.ptMelData;
            }

            promptSeq = this._finalizePromptSeq(promptSeq, ptFrameCount);
            this._currentPromptSeq = promptSeq;

            console.log(`[OnnxSVSPipeline] Synthesis params: frames=${totalFrames}, tokens=${sequences.tokenCount}, steps=${totalSteps}, cfg=${cfgStrength}, f0Shift=${f0Shift}`);

            currentProgress = 30;
            onProgress(currentProgress);

            // INT8 静态形状 + 分段合成：逐段 encoder+diffstep 直接产出整段 mel
            let segMel = null;
            if (_staticSegEnabled) {
                segMel = await this._synthesizeStaticShapeSegments(
                    sequences, totalFrames, ptMelData, ptFrameCount,
                    totalSteps, cfgStrength, cfgRescale,
                    (p) => onProgress(Math.round(40 + p * 0.5)), 40, 50, abortSignal, '[Synthesis]'
                );
            }
            let combinedCond = null;
            let xt;
            // mel 级缓存命中：跳过 encoder+diffusion（GPU 重活），仅重跑 vocoder。
            // 触发场景：只改了音色曲线（melPostprocess）——原始 mel 与上次完全相同。
            let melCacheHit = false;
            if (segMel) {
                xt = { data: segMel, dims: [1, totalFrames, MEL_DIM] };
            } else {
                const cachedMel = this._melCacheGet(melKey);
                if (cachedMel && cachedMel.frames === totalFrames) {
                    xt = { data: cachedMel.mel, dims: [1, totalFrames, MEL_DIM] };
                    melCacheHit = true;
                    console.log('[OnnxSVSPipeline] >>> MEL CACHE HIT <<< skipping encoder+diffusion (vocoder only)');
                } else {
                    combinedCond = await this._runEncoder(sequences, sequences.tokenCount, totalFrames, ptFrameCount);
                    // GPU 排空点：encoder→diffusion 切换前等待 DML 回收 encoder 的 GPU 资源
                    await gpuDrainAdaptive();
                    xt = this.randomNoise(totalFrames, MEL_DIM);
                }
            }

            // 提前设置 F0（分块流式路径在 diffusion 期间就需要 F0 片段）
            this._currentF0Hz = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;
            // Task 15: same per-frame F0 curve drives F0-aware chunked diffusion
            // boundary selection in _runDiffusionLoop → runDiffusionLoopChunked.
            this._currentPitchCurveF0 = this._currentF0Hz;
            // 单 segment 路径流式推送：仅在没有 contextPadding 截取时启用，避免 totalSamples 不一致
            const singleSegOnChunk = onChunkAudio && !contextPadding ? onChunkAudio : null;

            // 检测是否走分块流式路径（diffusion chunk + 即时 vocoder）
            const chunkOpts = this._currentDiffStepChunkOpts;
            // _planChunks 内部用 safeChunk = Math.max(50, chunkFrames)，当 safeChunk >=
            // totalFrames 时返回 null（回退到整段 runDiffusionLoop，不触发 onChunkMel）。
            // 若此处仅检查 totalFrames > chunkFrames，当 chunkFrames < 50 且
            // chunkFrames < totalFrames <= 50 时会进入流式路径但 _planChunks 返回 null，
            // 导致 segmentAudios 为空、audioData 全零（静音）。因此条件必须与
            // _planChunks 的 safeChunk 逻辑一致。
            const safeChunkFrames = Math.max(50, Math.floor(chunkOpts?.chunkFrames || 0));
            // mel 命中时不走分块流式扩散：没有 diffusion 要跑，直接整段 vocoder
            //（调用方对"无 chunk 事件"有整段播放回退，见渲染层 _streamingStarted 兜底）。
            const useStreamingChunked = chunkOpts && chunkOpts.enabled && !this.useStaticShapes
                && chunkOpts.chunkFrames > 0 && totalFrames > safeChunkFrames
                && singleSegOnChunk && !melCacheHit; // 流式推送可用时才走此路径

            if (useStreamingChunked) {
                // ===== 分块流式路径：每 diffusion chunk 完成后立即 vocoder 推送音频 =====
                console.log(`[OnnxSVSPipeline] Streaming chunked diffusion+vocoder: totalFrames=${totalFrames}, chunkFrames=${chunkOpts.chunkFrames}, overlap=${chunkOpts.overlapFrames}`);
                const totalSamplesEst = totalFrames * HOP_SIZE;
                const segmentAudios = []; // {frameStart, audio}

                const onChunkMel = async (chunkInfo) => {
                    const { frameStart, frameEnd, melData, isLast } = chunkInfo;
                    const segFrames = frameEnd - frameStart;
                    const segF0 = this._currentF0Hz ? this._currentF0Hz.subarray(frameStart, frameEnd) : null;
                    const sampleOffsetBase = frameStart * HOP_SIZE;
                    // 流式 chunk 与整段结果听感一致：对每个推送的 chunk 应用非人声区域静音。
                    // 旧版只对最终拼装的 audioData 静音（写入缓存），实时播放的 chunk 未静音，
                    // rest 区域的扩散噪声会直接播出（杂音），且与缓存重播的听感不一致。
                    // chunk 边界不会产生额外淡入淡出：跨边界音符的 rawStart<0 / rawEnd>len
                    // 使 _silenceNonVocalRegions 的 fadeIn/fadeOut 判定为 false。
                    const chunkBaseBeat = (filledNotes[0]?.start || 0);
                    const wrappedOnChunk = (info) => {
                        const chunkStartBeat = chunkBaseBeat +
                            ((info.sampleOffset + sampleOffsetBase) / SAMPLE_RATE) * (bpm / 60);
                        this._silenceNonVocalRegions(info.audio, filledNotes, bpm, chunkStartBeat);
                        singleSegOnChunk({
                            chunkIndex: info.chunkIndex,
                            sampleOffset: info.sampleOffset + sampleOffsetBase,
                            sampleEnd: info.sampleEnd + sampleOffsetBase,
                            audio: info.audio,
                            totalSamples: totalSamplesEst,
                            isLast: isLast && info.isLast,
                        });
                    };
                    // 窗口化 mel 后处理：左侧读上一 chunk 已提交的最终 mel，右侧仅在
                    // 最后一个 chunk 启用（此前的帧尚非最终数据，不能当真实邻居）。
                    const segAudio = await this._runVocoderChunkedForSegment(
                        melData, segFrames, segF0, wrappedOnChunk,
                        _melBaseOffset + frameStart,
                        { fullMel: xt.data, totalFrames, startFrame: frameStart, payloadBase: _melBaseOffset, rightFinal: !!isLast },
                    );
                    segmentAudios.push({ frameStart, audio: segAudio });
                };

                await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, 40, 50, onChunkMel, abortSignal);

                // 缓存原始 mel：分块流式扩散也写满整个 xt.data，完成后同样可复用
                if (!melCacheHit && !segMel) {
                    this._melCachePut(melKey, { mel: xt.data, frames: totalFrames });
                }

                // 拼接各段音频为完整 audioData（用于缓存和返回）
                let audioData = new Float32Array(totalSamplesEst);
                for (const { frameStart, audio } of segmentAudios) {
                    const offset = frameStart * HOP_SIZE;
                    const copyLen = Math.min(audio.length, totalSamplesEst - offset);
                    audioData.set(audio.subarray(0, copyLen), offset);
                }
                console.log(`[OnnxSVSPipeline] Streaming chunked complete: ${segmentAudios.length} segments, ${audioData.length} samples`);

                // 单 note 上下文 padding 截取
                if (contextPadding) {
                    const startSample = contextPadding.offsetFrames * HOP_SIZE;
                    const validSamples = contextPadding.validFrames * HOP_SIZE;
                    const endSample = Math.min(startSample + validSamples, audioData.length);
                    audioData = audioData.slice(startSample, endSample);
                }
                this._silenceNonVocalRegions(audioData, filledNotes, bpm, filledNotes[0]?.start || 0);
                const MAX_CACHE_SAMPLES = SAMPLE_RATE * 120;
                if (audioData.length <= MAX_CACHE_SAMPLES) {
                    this._synthCachePut(cacheKey, audioData);
                }
                onProgress(100);
                await this._recreateHeavySessionsAfterSynthesis();
                return audioData;
            }

            // ===== 常规路径：整段 diffusion → 整段 vocoder =====
            // 静态形状分段合成：xt.data 已是完整 mel，跳过 diffusion。
            if (!segMel && !melCacheHit) {
                await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, 40, 50, null, abortSignal);
                // 缓存原始 mel（音色曲线后续修改时复用，跳过 encoder+diffusion）
                this._melCachePut(melKey, { mel: xt.data, frames: totalFrames });
            }

            // 诊断：扩散输出（vocoder 输入 mel）统计 - 检查是否包含 NaN/异常值
            // NaN/Inf 致命错误 console.error 始终输出；统计采样 console.log 受 diagnosticMode 控制
            {
                const xtLen = xt.data.length;
                let xtNaN = 0, xtInf = 0;
                for (let i = 0; i < xtLen; i++) {
                    const v = xt.data[i];
                    if (Number.isNaN(v)) { xtNaN++; continue; }
                    if (!Number.isFinite(v)) { xtInf++; }
                }
                if (xtNaN > 0 || xtInf > 0) {
                    console.error(`[DiffusionDiag] DIFFUSION OUTPUT HAS NaN/Inf! This will cause vocoder explosion!`);
                }
                if (_readDiagnosticMode()) {
                    let xtMin = Infinity, xtMax = -Infinity, xtSum = 0, xtSumSq = 0;
                    for (let i = 0; i < xtLen; i++) {
                        const v = xt.data[i];
                        if (Number.isNaN(v) || !Number.isFinite(v)) continue;
                        if (v < xtMin) xtMin = v;
                        if (v > xtMax) xtMax = v;
                        xtSum += v;
                        xtSumSq += v * v;
                    }
                    const xtMean = xtSum / xtLen;
                    const xtStd = Math.sqrt(Math.max(0, xtSumSq / xtLen - xtMean * xtMean));
                    console.log(`[DiffusionDiag] OUTPUT xt (vocoder input): frames=${totalFrames}, len=${xtLen}, NaN=${xtNaN}, Inf=${xtInf}, min=${xtMin.toFixed(6)}, max=${xtMax.toFixed(6)}, mean=${xtMean.toFixed(6)}, std=${xtStd.toFixed(6)}`);
                }
            }

            // GPU 排空点：diffusion（64 次推理）→ vocoder 切换前等待 DML 回收 GPU 资源
            await gpuDrainAdaptive();

            onProgress(90);
            // 流式 chunk 与整段结果听感一致：对每个推送的 chunk 应用非人声区域静音
            //（与上方分块流式路径、最终 audioData 的静音逻辑对齐）。chunk 是回调专属的
            // 新切片，原地清零安全；跨 chunk 边界的音符不会产生额外淡入淡出。
            const _chunkSilenceBaseBeat = filledNotes[0]?.start || 0;
            const _silencingOnChunk = singleSegOnChunk ? (info) => {
                const chunkStartBeat = _chunkSilenceBaseBeat +
                    (info.sampleOffset / SAMPLE_RATE) * (bpm / 60);
                this._silenceNonVocalRegions(info.audio, filledNotes, bpm, chunkStartBeat);
                singleSegOnChunk(info);
            } : null;
            // 同上：这段是整段一次性 vocoder，startFrame=0、rightFinal=true。
            let audioData = await this._runVocoderChunked(xt.data, totalFrames, _silencingOnChunk, _melBaseOffset, { fullMel: xt.data, totalFrames, startFrame: 0, payloadBase: _melBaseOffset, rightFinal: true });

            // 单 note 上下文 padding：截取有效音频（丢弃前后 rest padding）
            // 注意：外部 totalFrames 始终是 50Hz 帧数（SVS mel 帧率），
            // 即使 SiFiGAN 内部已 4× 上采样，postprocessing 也已统一回 HOP_SIZE 输出长度，
            // 因此这里固定用 HOP_SIZE（480 samples/帧）计算采样位置。
            if (contextPadding) {
                const startSample = contextPadding.offsetFrames * HOP_SIZE;
                const validSamples = contextPadding.validFrames * HOP_SIZE;
                const endSample = Math.min(startSample + validSamples, audioData.length);
                audioData = audioData.slice(startSample, endSample);
            }

            this._silenceNonVocalRegions(audioData, filledNotes, bpm, filledNotes[0]?.start || 0);
            const MAX_CACHE_SAMPLES = SAMPLE_RATE * 120; // 2 分钟
            if (audioData.length <= MAX_CACHE_SAMPLES) {
                this._synthCachePut(cacheKey, audioData);
                console.log('[OnnxSVSPipeline] Audio cached (LRU entries=' +
                    (this._synthCacheMap ? this._synthCacheMap.size : 0) + ')');
            }

            onProgress(100);
            // 合成完成后重建重型 DML session，释放内存池，防止连续推理 OOM
            await this._recreateHeavySessionsAfterSynthesis();
            return audioData;
        }

        const totalBeats = filledNotes.length > 0
            ? Math.max(...filledNotes.map(n => n.start + n.duration))
            : 0;
        const totalSamples = Math.floor((totalBeats / bpm) * 60 * SAMPLE_RATE);
        const finalAudio = new Float32Array(totalSamples);
        const weightSum = new Float32Array(totalSamples);

        // Prompt mel 帧数：与单 segment 路径（_synthesizeImpl 中 `segments.length === 1`
        // 分支里的 ptFrameCount 计算）保持一致，按总帧数 10% 计算，
        // 上限 50 帧、下限 10 帧。旧版多 segment 路径恒为 10 帧，导致长音频（无 ref audio）
        // 扩散 conditioning 信号弱，音色稳定性与发音清晰度下降。
        if (!ptMelData || ptFrameCount === 0) {
            const totalFramesEst = Math.floor(totalSamples / HOP_SIZE);
            ptFrameCount = Math.min(50, Math.max(10, Math.floor(totalFramesEst * 0.1)));
            ptMelData = new Float32Array(ptFrameCount * MEL_DIM);
        }

        // 多 segment 路径：每个 segment 的 encoder 都用同一份 prompt token 序列；
        // _synthesizeSegment 会在自己的长度钳制后按实际 ptFrameCount 再裁一次。
        this._currentPromptSeq = promptSeq;

        const overlapBeats = (SEGMENT_OVERLAP_SEC / 60) * bpm;
        const overlapSamples = Math.floor(SEGMENT_OVERLAP_SEC * SAMPLE_RATE);

        const fadeWindow = new Float32Array(overlapSamples);
        for (let i = 0; i < overlapSamples; i++) {
            fadeWindow[i] = 0.5 * (1 - Math.cos(Math.PI * i / overlapSamples));
        }

        const progressPerSegment = 80 / segments.length;

        // WebNN batch=4: pair segments for simultaneous processing
        const useBatch = this.useWebNN && npuDiffBatchSize >= 4 && segments.length > 1;
        // k = 遍历次序（0..order.length-1），由下方 order 映射回原始 segment 下标。
        let k = 0;

        // Per-segment f0Shift (B2): autoShift 基于全局中位数计算单一 f0Shift，对"主歌低音+
        // 副歌高音"的宽音域片段，单一偏移使主歌偏低/副歌偏高，参考音色匹配度差。
        // 多 segment 路径按各 segment 音符中位数相对全局中位数的偏差调整 f0Shift，使每段
        // 中位数都向参考中位数靠拢。调整量上限 ±5 半音，避免段边界处 f0Shift 跳变过大
        // （相邻段最大差 10 半音，由 SEGMENT_OVERLAP_SEC crossfade 平滑过渡）。
        // 仅在 autoShift 启用且多 segment 时生效；pitchShift 模式（用户指定固定偏移）不改。
        // 保留绝对 MIDI 音高：autoShift 是全局的，不按子段调整。
        // per-seg 调整通道保留为 null（_computeSegF0Shift 见到 null 即返回全局值）。
        const globalTargetMedian = null;

        // 多 segment 路径修复：若 segment 0 的第一个 note 不在 segStartBeat（=0）处开始，
        // 前置一个休止符，使生成的 audio 覆盖从 beat 0 到 endBeat 的完整区间。
        // 否则 segment 0 的 audio 从 notes[0].start 开始但被放置在 finalAudio[0]，
        // 造成左移 firstNoteStart 拍 → 与后续 segment 的 crossfade 时间错位 → 沙哑。
        if (segments.length > 0 && segments[0].notes.length > 0 && segments[0].notes[0].start > 0.01) {
            const firstSeg = segments[0];
            firstSeg.notes.unshift({
                lyric: '',
                pitch: 0,
                start: 0,
                duration: firstSeg.notes[0].start,
            });
            console.log(`[OnnxSVSPipeline] Segment 0 leading rest prepended: ${firstSeg.notes[0].duration.toFixed(2)} beats`);
        }

        // 分片级缓存预计算：长音频编辑时，未改动 segment 的输入（notes/bpm/f0/ref/segF0Shift）
        // 与上次完全相同 → 音频相同，可直接复用缓存跳过 diffusion+vocoder，只重算改动 segment。
        // 此处在前置休止符补齐之后计算键，确保键反映 segment 实际使用的 notes。
        // segF0Shift 与循环内 _computeSegF0Shift 调用使用相同入参，结果一致。
        //
        // 适用范围与优雅降级（结果始终正确，仅命中率下降）：
        //   - 最有效：pitch-only 编辑且 autoShift 关（或全局中位数稳定）→ 仅改动 segment 失效。
        //   - autoShift 开启时，编辑触及全局中位数会使 globalTargetMedian 漂移 → 所有 segment
        //     的 segF0Shift 变化 → _fs 后缀变化 → 全部分片失效（此时输出确实不同，失效正确）。
        //   - 自定义音高曲线（pitchCurveF0 非空）随音符 start/duration 变化 → f0Hash 变化 →
        //     全部分片失效。这两种场景下退化为整曲重算，行为与未引入分片缓存时一致。
        // 每段的 sF0Shift 只算一次，缓存键批量生成共享同一份 optionKeyPart/mp/状态后缀：
        // 旧的逐段 _computeSegmentCacheKey + _computeSegmentMelKey 会为 N 段各做 2 次
        // 昂贵的 reference/F0/prompt 哈希，全压在首个 chunk 前的「分片启动」阶段。
        const segF0Shifts = segments.map(s => this._computeSegF0Shift(f0Shift, globalTargetMedian, s.notes));
        const segKeyParts = this._computeSegmentKeyBatch(segments, bpm, options, segF0Shifts, ptFrameCount);
        const segCacheKeys = new Array(segments.length);
        const segMelCacheKeys = new Array(segments.length);
        const segCachedAudios = new Array(segments.length);
        let segCacheHits = 0;
        for (let i = 0; i < segments.length; i++) {
            const sKey = segKeyParts[i].synthKey;
            segCacheKeys[i] = sKey;
            // mel 级键（不含 melPostprocess）：音色曲线变化时 segment 原始 mel 仍可复用，
            // 跳过该 segment 的 encoder+diffusion，仅重跑 vocoder。
            segMelCacheKeys[i] = segKeyParts[i].melKey;
            const hit = this._segCacheGet(sKey);
            segCachedAudios[i] = hit;
            if (hit) segCacheHits++;
        }
        if (segCacheHits > 0) {
            console.log(`[OnnxSVSPipeline] Segment cache: ${segCacheHits}/${segments.length} hits, skipping synthesis for unchanged segments`);
        }

        // 多 segment 流式推送（分片编辑器预览）：segment 粒度、按时间顺序门控发射。
        // 旧实现本路径 onChunkAudio 全程传 null，分片 >20s 或含长休止时预览必须
        // 等全部推理完才开播。onChunkAudio 仅 fragment-svs:synthesize（非后台）注入，
        // 导出与主页面 svs:synthesize 不受影响。
        const streamEmitter = onChunkAudio
            ? this._createSegmentStreamEmitter(
                segments, bpm,
                filledNotes.length > 0 ? filledNotes[0].start : 0,
                totalSamples, onChunkAudio)
            : null;

        // ===== 分段遍历顺序：优先推理变动处 =====
        // 未命中分片缓存的 segment 即"被用户改动的分段"，也只有它们需要真正跑
        // diffusion+vocoder。重排只改变这些重算分段的产出先后顺序，不改变合成结果：
        // 每个 segment 独立写入 finalAudio 的绝对采样区间，并按 crossfade 权重累加到
        // finalAudio / weightSum —— 逐样本加法满足交换律，且权重只依赖
        // 相邻 segment 的边界（startBeat/endBeat），与遍历顺序无关。
        //
        // 优先级：
        //   1) priorityTimeSec > 0（播放进度条位置）→ 取覆盖该时刻的 segment
        //   2) 否则 → 取第一个未命中缓存的 segment，即时间轴上第一个改动位置
        //
        // order 保存的是 segments 的原始下标：batch 配对、crossfade、f0Shift、
        // 缓存写入一律使用原下标，重排仅体现在遍历次序上。
        const order = [];
        let priorityIdx = -1;
        if (priorityTimeSec > 0) {
            for (let i = 0; i < segments.length; i++) {
                if (priorityTimeSec < (segments[i].endBeat / bpm) * 60) { priorityIdx = i; break; }
            }
            if (priorityIdx < 0) priorityIdx = segments.length - 1;
        } else {
            for (let i = 0; i < segments.length; i++) {
                if (!segCachedAudios[i]) { priorityIdx = i; break; }
            }
        }
        const orderStart = (priorityIdx > 0 && priorityIdx < segments.length) ? priorityIdx : 0;
        for (let i = orderStart; i < segments.length; i++) order.push(i);
        for (let i = 0; i < orderStart; i++) order.push(i);
        if (orderStart > 0) {
            console.log(`[OnnxSVSPipeline] Prioritized segment order: start=${orderStart}` +
                ` (${priorityTimeSec > 0 ? `playhead=${priorityTimeSec.toFixed(2)}s` : 'first dirty segment'})`);
        }

        while (k < order.length) {
            // 段间 GPU 排空：仅让出一个事件循环轮次（setImmediate），不做墙钟等待，
            // 给事件循环/GC 一次调度机会。资源回收顺序由 ORT/DML 内部负责。
            // 首次迭代前 yield 无副作用（仅多一次事件循环调度）。
            if (k > 0) {
                await gpuDrainAdaptive();
            }

            // 遍历次序 k 对应的原始 segment 下标
            const segIdx = order[k];
            const nextSegIdx = (k + 1 < order.length) ? order[k + 1] : -1;
            // pair 合并推理要求两段原始相邻（shared crossfade 依赖 segIdx/segIdx+1），
            // 重排后必须显式校验 nextSegIdx === segIdx + 1 才能成对。
            const canPair = nextSegIdx === segIdx + 1;

            if (useBatch && canPair && !segCachedAudios[segIdx] && !segCachedAudios[segIdx + 1]) {
                // Pair two segments for batch=4 diffusion
                // 仅当两个 segment 均未命中分片缓存时才走 batch 路径；任一命中则落到
                // 下面的单 segment 路径（命中段直接复用缓存，未命中段单独推理）。
                const segA = segments[segIdx];
                const segB = segments[segIdx + 1];
                const pairProgressStart = 10 + k * progressPerSegment;
                const pairProgressRange = progressPerSegment * 2 * 0.9;

                onProgress(Math.round(pairProgressStart));

                // Per-segment f0Shift (B2): 各 segment 独立计算偏移
                const f0ShiftA = this._computeSegF0Shift(f0Shift, globalTargetMedian, segA.notes);
                const f0ShiftB = this._computeSegF0Shift(f0Shift, globalTargetMedian, segB.notes);

                const pairResult = await this._synthesizeSegmentPair(
                    segA.notes, segB.notes, bpm, f0Envelope, pitchCurveF0, f0ShiftA, f0ShiftB,
                    ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale,
                    npuDiffBatchSize, npuVocoderBatchSize,
                    onProgress, pairProgressStart, pairProgressRange,
                    segA.startBeat, segB.startBeat, abortSignal
                );

                // 分片缓存写入：batch 合成的两段都是 miss（见上方条件），结果存入分片缓存
                if (pairResult[0].audio.length > 0) this._segCachePut(segCacheKeys[segIdx], pairResult[0].audio);
                if (pairResult[1].audio.length > 0) this._segCachePut(segCacheKeys[segIdx + 1], pairResult[1].audio);

                // 流式推送：两段完成后入队（发射器内部按时间序门控）
                if (streamEmitter) {
                    streamEmitter.segmentDone(segIdx, pairResult[0].audio);
                    streamEmitter.segmentDone(segIdx + 1, pairResult[1].audio);
                }

                // Write both segments' audio to finalAudio
                for (let si = 0; si < 2; si++) {
                    const seg = segments[segIdx + si];
                    const segResult = pairResult[si];
                    if (segResult.audio.length === 0) continue;

                    const segStartSample = Math.floor((seg.startBeat / bpm) * 60 * SAMPLE_RATE);
                    const segAudio = segResult.audio;
                    const segSamples = segAudio.length;
                    const hasOverlap = (segIdx + si) > 0 && seg.startBeat < segments[segIdx + si - 1].endBeat;

                    for (let i = 0; i < segSamples; i++) {
                        const outIdx = segStartSample + i;
                        if (outIdx >= totalSamples) break;
                        let w = 1.0;
                        if (hasOverlap && i < overlapSamples) w = fadeWindow[i];
                        if (segIdx + si < segments.length - 1 && seg.endBeat > segments[segIdx + si + 1].startBeat) {
                            const remainingSamples = segSamples - i;
                            if (remainingSamples <= overlapSamples) {
                                w = Math.min(w, 1.0 - fadeWindow[overlapSamples - remainingSamples]);
                            }
                        }
                        finalAudio[outIdx] += segAudio[i] * w;
                        weightSum[outIdx] += w;
                    }
                }

                // GPU 排空点 3：多 segment 之间等待 DML 回收上段 vocoder 的 GPU 资源
                if (k < order.length - 1) await gpuDrainAdaptive();
                k += 2;
                continue;
            }

            // Single segment (or last odd segment)
            const seg = segments[segIdx];
            // 进度按遍历次序 k 计算：重排后 segIdx 不再单调，用它会导致进度回退。
            const segProgressStart = 10 + k * progressPerSegment;
            const segProgressRange = progressPerSegment * 0.9;
            const vocoderProgressStart = segProgressStart + segProgressRange;
            const vocoderProgressRange = progressPerSegment * 0.1;

            onProgress(Math.round(segProgressStart));

            // Per-segment f0Shift (B2): 该 segment 独立计算偏移
            const segF0Shift = this._computeSegF0Shift(f0Shift, globalTargetMedian, seg.notes);

            // 分片缓存命中：直接复用上次该 segment 的音频，跳过 diffusion+vocoder。
            // segCachedAudios[segIdx] 在循环前已查表（含 LRU 提升），此处直接取用。
            let segResult;
            const cachedSegAudio = segCachedAudios[segIdx];
            if (cachedSegAudio) {
                console.log(`[OnnxSVSPipeline] >>> SEGMENT CACHE HIT <<< seg=${segIdx} startBeat=${seg.startBeat.toFixed(2)} | skipping diffusion+vocoder for this segment`);
                onProgress(Math.round(segProgressStart + segProgressRange));
                // 下游只消费 segResult.audio（写入 finalAudio），无需 frames；
                // 真实 mel 帧数在 _synthesizeSegment 内部使用，缓存命中路径不涉及。
                segResult = { audio: cachedSegAudio };
            } else {
                segResult = await this._synthesizeSegment(
                    seg.notes, bpm, f0Envelope, pitchCurveF0, segF0Shift,
                    ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale,
                    npuDiffBatchSize, npuVocoderBatchSize,
                    onProgress, segProgressStart, segProgressRange,
                    null, seg.startBeat, abortSignal, segMelCacheKeys[segIdx]
                );
                // 分片缓存写入：miss 后重算的结果存入，供后续未改动场景复用
                if (segResult.audio.length > 0) {
                    this._segCachePut(segCacheKeys[segIdx], segResult.audio);
                }
            }

            // 流式推送：完成后入队（含缓存命中与空结果，发射器内部按时间序门控；
            // 乱序完成时先缓冲，前面的 segment 发射完才轮到本段）
            if (streamEmitter) {
                streamEmitter.segmentDone(segIdx, segResult.audio);
            }

            if (segResult.audio.length === 0) continue;

            const segStartSample = Math.floor((seg.startBeat / bpm) * 60 * SAMPLE_RATE);
            const segAudio = segResult.audio;
            const segSamples = segAudio.length;

            const hasOverlap = segIdx > 0 && seg.startBeat < segments[segIdx - 1].endBeat;

            for (let i = 0; i < segSamples; i++) {
                const outIdx = segStartSample + i;
                if (outIdx >= totalSamples) break;

                let w = 1.0;
                if (hasOverlap && i < overlapSamples) {
                    w = fadeWindow[i];
                }
                if (segIdx < segments.length - 1 && seg.endBeat > segments[segIdx + 1].startBeat) {
                    const remainingSamples = segSamples - i;
                    if (remainingSamples <= overlapSamples) {
                        w = Math.min(w, 1.0 - fadeWindow[overlapSamples - remainingSamples]);
                    }
                }

                finalAudio[outIdx] += segAudio[i] * w;
                weightSum[outIdx] += w;
            }

            onProgress(Math.round(vocoderProgressStart + vocoderProgressRange));
            // GPU 排空点 3：多 segment 之间等待 DML 回收上段 vocoder 的 GPU 资源
            if (k < order.length - 1) await gpuDrainAdaptive();
            k++;
        }

        for (let i = 0; i < totalSamples; i++) {
            if (weightSum[i] > 1e-8) {
                finalAudio[i] /= weightSum[i];
            }
        }

        normalizePeakTo(finalAudio, totalSamples);

        // 多 segment 路径修复：截取从 filledNotes[0].start 开始的紧致 buffer，
        // 使返回值语义与单 segment 一致（audioData[0] ↔ notes[0].start 的音频）。
        // 这样主页面 playAll / exportAll 的 startSample 偏移同时兼容两条路径。
        // （segment 0 的前置休止符已确保 crossfade 在 finalAudio 内正确对齐）
        const firstNoteStartSample = Math.floor((filledNotes[0].start / bpm) * 60 * SAMPLE_RATE);
        const audioData = firstNoteStartSample > 0
            ? finalAudio.subarray(firstNoteStartSample)
            : finalAudio;
        this._silenceNonVocalRegions(audioData, filledNotes, bpm, filledNotes[0]?.start || 0);
        const MAX_CACHE_SAMPLES = SAMPLE_RATE * 120;
        if (audioData.length <= MAX_CACHE_SAMPLES) {
            this._synthCachePut(cacheKey, audioData);
            console.log('[OnnxSVSPipeline] Audio cached (LRU entries=' +
                (this._synthCacheMap ? this._synthCacheMap.size : 0) + ')');
        }

        onProgress(100);
        // 合成完成后重建重型 DML session，释放内存池，防止连续推理 OOM
        await this._recreateHeavySessionsAfterSynthesis();
        return audioData;
    }
````

### R29 · 管线：非人声区静音（流式 chunk 同样应用）

文件：`src/inference/pipeline/index.js`　行：`739-781`

````javascript
    /**
     * Diffusion can produce non-zero rest mel even with pitch/F0=0. Vocos then
     * turns that mel into hiss or breath-like noise. Enforce score silence on
     * the final waveform, after vocoder normalization, with short edge fades.
     */
    _silenceNonVocalRegions(audio, notes, bpm, bufferStartBeat = 0) {
        if (!audio || audio.length === 0 || !notes || notes.length === 0) return audio;
        const secondsPerBeat = 60 / bpm;
        const mergeGapSamples = Math.round(0.04 * SAMPLE_RATE);
        const fadeSamples = Math.max(1, Math.round(0.015 * SAMPLE_RATE));
        const intervals = [];
        for (const note of notes) {
            // 统一使用与 region 切分（AudioSegmentation._isRestNote）相同的休止
            // 判据 —— 旧内联判据把"空歌词的非延音音符"当非休止保留，而 region
            // 切分阶段把它当休止排除：两侧结论相反会导致切分与静音阶段行为
            // 不一致（切段排除了它、静音阶段又保留它，或反过来）。
            if (this._isRestNote(note)) continue;
            const rawStart = Math.round((note.start - bufferStartBeat) * secondsPerBeat * SAMPLE_RATE);
            const rawEnd = Math.round((note.start + note.duration - bufferStartBeat) * secondsPerBeat * SAMPLE_RATE);
            const start = Math.max(0, rawStart);
            const end = Math.min(audio.length, rawEnd);
            if (end <= start) continue;
            const prev = intervals[intervals.length - 1];
            if (prev && start - prev.end <= mergeGapSamples) {
                prev.end = Math.max(prev.end, end);
                prev.fadeOut = prev.fadeOut || rawEnd < audio.length;
            } else {
                intervals.push({ start, end, fadeIn: rawStart > 0, fadeOut: rawEnd < audio.length });
            }
        }
        let cursor = 0;
        for (const interval of intervals) {
            audio.fill(0, cursor, interval.start);
            const fade = Math.min(fadeSamples, Math.floor((interval.end - interval.start) / 2));
            for (let i = 0; i < fade; i++) {
                if (interval.fadeIn) audio[interval.start + i] *= (i + 1) / fade;
                if (interval.fadeOut) audio[interval.end - fade + i] *= (fade - i) / fade;
            }
            cursor = interval.end;
        }
        audio.fill(0, cursor);
        return audio;
    }
````

### R30 · 扩散分块：规划、单块推理、循环与 committed 帧

文件：`src/inference/pipeline/diffusion.js`　行：`1279-1631`

````javascript
    /**
     * 分块扩散推理：将目标帧分块，每块独立运行完整扩散循环后交叉淡入淡出拼接。
     *
     * 注意力复杂度 O(n²)，分块后总计算量 N×(pt+chunk)² 通常小于 (pt+total)²，
     * 对长片段预览有显著加速；代价是块边界处可能产生轻微伪影（由 overlap 交叉淡入淡出缓解）。
     * 每块均以 prompt mel 为前缀，保证音色/风格上下文一致。
     *
     * 仅用于预览路径（由 _runDiffusionLoop 在 previewDiffStepChunkEnabled 时调用）。
     * useStaticShapes（NPU 固定形状）路径不适用分块（每块仍 pad 到 NPU_STATIC_SEQ_LEN，
     * 无计算量收益），调用方应在该路径下跳过分块。
     *
     * @param {Object} sessions
     * @param {{data: Float32Array, dims: number[]}} xt - 噪声容器，分块结果最终写回 xt.data
     * @param {number} totalFrames - 目标帧数（不含 prompt）
     * @param {Float32Array} ptMelData - prompt mel 数据
     * @param {number} ptFrameCount - prompt 帧数
     * @param {Float32Array} combinedCond - 完整条件向量 (ptFrameCount+totalFrames)*COND_DIM
     * @param {number} totalSteps
     * @param {number} cfgStrength
     * @param {number} cfgRescale
     * @param {boolean} isFP16
     * @param {Function} onProgress
     * @param {number} progressStart
     * @param {number} progressRange
     * @param {boolean} useStaticShapes
     * @param {number} chunkFrames - 分块大小（帧）
     * @param {number} overlapFrames - 分块间重叠（帧）
     * @param {Function} [onChunkMel] - 流式回调：每块完成且 mel 已确定后调用，用于立即运行 vocoder
     *   签名: async ({chunkIndex, frameStart, frameEnd, melData, isLast}) => {}
     *   frameStart/frameEnd 为已确定帧在完整 mel 中的绝对位置；melData 为该段 mel 副本
     */

    /**
     * 计算分块边界与 Hann 窗。
     * 返回 null 表示无需分块（chunkFrames >= totalFrames 或 totalFrames <= 0）。
     *
     * Task 15: 当提供 f0Slope（每帧 F0 斜率数组）时，在安全重叠区
     *   [chunkStart + minBeats, chunkStart + maxBeats]
     * 内选择 |f0Slope[boundary]| 最小的位置作为 chunkEnd，避开 F0 斜率突变处
     * （颤音起止、音符转换）切分，减少边界伪影（RDSinger arXiv:2410.21641 启发）。
     * f0Slope 为 null/undefined 或长度不足（out-of-range）时回退到固定 safeChunk
     * 逻辑，行为与改造前完全一致。
     *
     * @param {number} totalFrames
     * @param {number} chunkFrames
     * @param {number} overlapFrames
     * @param {Float32Array|number[]|null} [f0Slope=null] - per-frame F0 slope (f0[i+1]-f0[i])
     * @returns {{specs: Array, overlap: number}|null}
     */
    _planChunks(totalFrames, chunkFrames, overlapFrames, f0Slope = null) {
        // 防御：totalFrames <= 0 时直接返回 null，由调用方短路处理
        if (!Number.isFinite(totalFrames) || totalFrames <= 0) return null;
        const safeChunk = Math.max(50, Math.floor(chunkFrames));
        let safeOverlap = Math.max(0, Math.floor(overlapFrames));
        if (safeOverlap >= safeChunk) safeOverlap = Math.floor(safeChunk / 2);
        // 防死循环钳制：overlap ≥ 0.75×chunk 时，F0 边界搜索下界
        // lo = chunkStart + max(0.75·chunk, chunk − overlap) ≤ framePos，
        // 边界可被选为 framePos 本身 → 状态不变 → while 死循环挂死主进程。
        // 将 overlap 压到 chunk 的 1/4 以下即可结构性地排除该区间。
        if (safeOverlap * 4 >= safeChunk * 3) safeOverlap = Math.floor(safeChunk / 4);
        if (safeChunk >= totalFrames) return null;
        // safeOverlap === 0 时无交叉淡入淡出
        if (safeOverlap < 1) safeOverlap = 0;

        // Task 15: F0-aware boundary selection setup.
        // hasF0 requires f0Slope to cover the full totalFrames range so every
        // candidate boundary index is in-range; otherwise fall back to fixed
        // safeChunk (no behavior change).
        const hasF0 = !!(f0Slope && f0Slope.length >= totalFrames);
        // Safe overlap zone: chunk size may vary by up to ±safeOverlap around
        // safeChunk (clamped to [75%, 125%] of safeChunk to avoid degenerate
        // chunks). When safeOverlap = 0 the zone collapses and no search runs.
        const minBeats = hasF0
            ? Math.max(Math.floor(safeChunk * 0.75), safeChunk - safeOverlap)
            : safeChunk;
        const maxBeats = hasF0
            ? Math.min(safeChunk + safeOverlap, Math.floor(safeChunk * 1.25))
            : safeChunk;
        const canSearch = hasF0 && maxBeats > minBeats;

        const specs = [];
        let framePos = 0;
        let chunkIdx = 0;
        // 兜底：正常情况下每轮 framePos 严格前进。最小前进量：
        //   非 F0 路径 = safeChunk - safeOverlap（固定步长）
        //   F0 搜索路径 ≥ minBeats - safeOverlap（边界下界 chunkStart+minBeats）
        // 超限说明规划异常，强制退出而不是挂死主进程。
        const minAdvance = Math.max(1,
            (canSearch
                ? Math.max(Math.floor(safeChunk * 0.75), safeChunk - safeOverlap)
                : safeChunk) - safeOverlap);
        const maxIters = Math.ceil(totalFrames / minAdvance) + 8;
        let iterCount = 0;
        while (framePos < totalFrames) {
            if (++iterCount > maxIters) {
                console.error(`[DiffusionChunk] _planChunks exceeded maxIters=${maxIters}, aborting plan (totalFrames=${totalFrames}, chunk=${safeChunk}, overlap=${safeOverlap})`);
                break;
            }
            const isFirst = chunkIdx === 0;
            const chunkStart = isFirst ? 0 : Math.max(0, framePos - safeOverlap);
            const defaultChunkEnd = Math.min(chunkStart + safeChunk, totalFrames);
            const isLast = defaultChunkEnd >= totalFrames;
            let chunkEnd;
            if (isLast) {
                chunkEnd = totalFrames;
            } else if (canSearch) {
                // Task 15: search [chunkStart + minBeats, chunkStart + maxBeats]
                // for the boundary with smallest |f0Slope[boundary]|.
                // 结构保证：下界必须严格大于当前进度 framePos，否则边界可能
                // 被选为 framePos 本身 → framePos 不前进 → while 死循环。
                const lo = Math.max(chunkStart + minBeats, chunkStart + 1, framePos + 1);
                const hi = Math.min(chunkStart + maxBeats, totalFrames - 1);
                let bestBoundary = defaultChunkEnd;
                let bestSlope = Infinity;
                for (let b = lo; b <= hi; b++) {
                    if (b < 0 || b >= f0Slope.length) continue;
                    const s = Math.abs(f0Slope[b]);
                    if (s < bestSlope) {
                        bestSlope = s;
                        bestBoundary = b;
                    }
                }
                // lo > hi（搜索区塌缩）时回退到默认边界，保证 chunkEnd > framePos。
                chunkEnd = (lo <= hi) ? bestBoundary : defaultChunkEnd;
            } else {
                chunkEnd = defaultChunkEnd;
            }
            const currentChunkFrames = chunkEnd - chunkStart;
            const finalIsLast = chunkEnd >= totalFrames;
            specs.push({ chunkStart, chunkEnd, currentChunkFrames, isFirst, isLast: finalIsLast });
            if (finalIsLast) break;
            framePos = chunkEnd;
            chunkIdx++;
        }

        return { specs, overlap: safeOverlap };
    }

    /**
     * 执行单个分块的扩散推理（提取噪声 → 完整扩散循环 → Hann 交叉淡入淡出写回）。
     * 可独立调用，供多分片时间交错流式编排器按时间顺序逐块调用。
     *
     * @param {Object} ctx - 分块上下文（由调用方持有，跨块共享 xt.data 状态）
     *   { sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond,
     *     totalSteps, cfgStrength, cfgRescale, isFP16, useStaticShapes, overlap }
     *   chunkOverlapNoiseLevel?: number - 非首块 overlap 前缀的重噪强度 t0 ∈ [0,1]，
     *     默认 0（纯高斯，与整段推理初值一致）；>0 时按 SDEdit 保留部分前块 mel。
     * @param {Object} spec - 分块规格 { chunkStart, chunkEnd, currentChunkFrames, isFirst, isLast }
     * @param {Function} onProgress
     * @param {number} progressStart
     * @param {number} progressRange
     * @returns {Promise<{newCommitted: number}>} 本块完成后新确定的帧数（不含重叠区，末尾块为 chunkEnd）
     */
    async _runSingleDiffusionChunk(ctx, spec, onProgress, progressStart, progressRange) {
        const { sessions, xt, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, useStaticShapes, overlap, cfgScheduleOpts, dynamicThresholdOpts, abortSignal, suppressDoneLog } = ctx;
        const { chunkStart, chunkEnd, currentChunkFrames, isFirst, isLast } = spec;
        const xtOut = xt.data;

        // 协作式取消检查点：进入分块体前检查（runDiffusionLoop 内部每步也会检查）。
        throwIfCancelled(abortSignal);

        // 1. 提取当前块的噪声
        const chunkNoise = new Float32Array(currentChunkFrames * MEL_DIM);
        chunkNoise.set(xtOut.subarray(chunkStart * MEL_DIM, chunkEnd * MEL_DIM));
        // --- 非首块 overlap 前缀重噪（F-04）---
        // 为什么必须重噪：runDiffusionLoop 从 t=0 起积分（sampler 的 tVal=(step+0.5)/totalSteps，
        // step 0 ≈ 0），rectified flow 的 t=0 边界条件是标准高斯噪声（整段推理的初值就是
        // randomNoise()）。而非首块的 chunkStart 落在上一块已提交区域内（_planChunks:
        // chunkStart = framePos - overlap），这块区域在上一块第 4 步写回时已经被替换成
        // 「去噪完成 + WSOLA 交叉淡入淡出后的干净 mel」。把干净 mel 当 t=0 的输入是 OOD：
        // 模型在噪声时刻收到干净信号，速度场预测失真。
        //
        // 更关键的是 CFG 双分支共用同一份 xt：evalDiffStep 里 cond 行
        // `xtInputBuf.set(xtData, ptFrameCount*MEL_DIM)` 与 uncond 行
        // `cfgBatchBuf.set(xtData.subarray(0, totalFrames*MEL_DIM), row1Off)` 都取自
        // subXt.data，因此污染会同时进入两条分支，CFG 无法抑制反而放大偏差。
        // 所以重噪必须作用在**共享来源** chunkNoise 上（这里做），而不是某一分支。
        //
        // 做法（SDEdit 式，rectified flow 线性路径）：xt = (1-t0)·eps + t0·x_prev。
        // 注意不能用 DDPM/VP 的 √(1-t0)/√t0：本模型是 Flow Matching，t=0 是噪声、
        // 权重随 t 线性变化，开方会把噪声占比系统性放大（t0=0.3 时 0.55 vs 0.30）。
        // eps 为本仓库 randomNoise() 生成的标准高斯（内部走 this._rng || Math.random，
        // setNoiseSeed 的确定性仍然生效）。
        // t0 = 0（默认）即纯高斯，与整段推理的初始条件完全一致；t0 ∈ (0,0.3] 时保留少量
        // 前块信息以减小块间跳变，代价是仍轻微偏离 t=0 流形。
        if (!isFirst) {
            const renoiseOv = Math.min(overlap, currentChunkFrames);
            if (renoiseOv > 0) {
                const t0 = Number.isFinite(ctx.chunkOverlapNoiseLevel)
                    ? Math.min(1, Math.max(0, ctx.chunkOverlapNoiseLevel))
                    : 0;
                const ovNoise = this.randomNoise(renoiseOv, MEL_DIM);
                const ovEnd = renoiseOv * MEL_DIM;
                for (let i = 0; i < ovEnd; i++) {
                    chunkNoise[i] = (1 - t0) * ovNoise.data[i] + t0 * chunkNoise[i];
                }
            }
        }
        const subXt = { data: chunkNoise, dims: [1, currentChunkFrames, MEL_DIM] };

        // 2. 构建当前块的条件向量
        const promptCondBytes = ptFrameCount * COND_DIM;
        const chunkTargetCondBytes = currentChunkFrames * COND_DIM;
        const chunkCondStart = (ptFrameCount + chunkStart) * COND_DIM;
        const chunkCondEnd = chunkCondStart + chunkTargetCondBytes;
        const chunkCond = new Float32Array(promptCondBytes + chunkTargetCondBytes);
        chunkCond.set(combinedCond.subarray(0, promptCondBytes), 0);
        chunkCond.set(combinedCond.subarray(chunkCondStart, chunkCondEnd), promptCondBytes);

        // 3. 运行完整扩散循环
        // 子进度直接透传：onProgress 已被外层映射到本 chunk 的 [progressStart, progressStart+progressRange] 区间，
        // 分块调用传 progressCap=100，不截断到 90，避免 32 步 diffusion 期间进度条停滞。
        const chunkOnProgress = (p) => {
            if (onProgress) onProgress(Math.round(p));
        };
        await this.runDiffusionLoop(
            sessions, subXt, currentChunkFrames, ptMelData, ptFrameCount,
            chunkCond, totalSteps, cfgStrength, cfgRescale, isFP16,
            chunkOnProgress, progressStart, progressRange, useStaticShapes, ctx.samplerName, cfgScheduleOpts, dynamicThresholdOpts, abortSignal, suppressDoneLog, 100
        );

        // 4. WSOLA mel 域交叉淡入淡出写回（取代对称 Hann 加权混合）
        if (isFirst) {
            // 首 chunk：无前序数据，直接整段 memcpy
            xtOut.set(subXt.data.subarray(0, currentChunkFrames * MEL_DIM), chunkStart * MEL_DIM);
        } else {
            // WSOLA mel 域交叉淡入淡出：prevTailMel 为已提交的前一 chunk 尾部 mel，
            // currHeadMel 为当前 chunk 头部 mel，按帧用余弦相似度对齐后 Hann OLA，
            // 消除有音高信号在 chunk 边界的 flanging/梳状滤波。
            const actualOv = Math.min(overlap, currentChunkFrames);
            if (actualOv > 0) {
                const prevTailMel = xtOut.subarray(chunkStart * MEL_DIM, (chunkStart + actualOv) * MEL_DIM);
                const currHeadMel = subXt.data.subarray(0, actualOv * MEL_DIM);
                const wsolaMel = wsolaCrossfadeMel(prevTailMel, currHeadMel, actualOv, MEL_DIM);
                xtOut.set(wsolaMel, chunkStart * MEL_DIM);
            }
            // 非重叠区：用 TypedArray.set 走 memcpy，比逐元素快 2-3 倍
            const nonOverlapStart = actualOv * MEL_DIM;
            const nonOverlapLen = (currentChunkFrames - actualOv) * MEL_DIM;
            if (nonOverlapLen > 0) {
                xtOut.set(
                    subXt.data.subarray(nonOverlapStart, nonOverlapStart + nonOverlapLen),
                    (chunkStart + actualOv) * MEL_DIM
                );
            }
        }

        // 5. GPU 排空（仅 setImmediate 让出一轮事件循环，不做墙钟等待）
        await gpuDrainAdaptive();

        // 6. 计算 committed 帧数
        const newCommitted = isLast ? chunkEnd : Math.max(0, chunkEnd - overlap);
        return { newCommitted };
    }

    async runDiffusionLoopChunked(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes, chunkFrames, overlapFrames, onChunkMel = null, samplerName = DEFAULT_SOLVER, pitchCurveF0 = null, cfgScheduleOpts = null, dynamicThresholdOpts = null, abortSignal = null) {
        // Task 15: compute per-frame F0 slope from pitchCurveF0 for F0-aware
        // chunk boundary selection. f0Slope[i] = f0[i+1] - f0[i], with 0 at the
        // last index. When pitchCurveF0 is null/undefined or too short, f0Slope
        // is null and _planChunks falls back to fixed safeChunk (no change).
        let f0Slope = null;
        if (pitchCurveF0 && pitchCurveF0.length >= 2) {
            f0Slope = new Float32Array(pitchCurveF0.length);
            for (let i = 0; i < pitchCurveF0.length - 1; i++) {
                f0Slope[i] = pitchCurveF0[i + 1] - pitchCurveF0[i];
            }
            f0Slope[pitchCurveF0.length - 1] = 0;
        }

        // 分块规划
        const plan = this._planChunks(totalFrames, chunkFrames, overlapFrames, f0Slope);
        if (!plan) {
            // 无需分块，直接整段推理
            return this.runDiffusionLoop(sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, onProgress, progressStart, progressRange, useStaticShapes, samplerName, cfgScheduleOpts, dynamicThresholdOpts, abortSignal);
        }

        const { specs, overlap } = plan;
        const totalChunks = specs.length;
        console.log(`[DiffusionChunk] Chunked diffusion: totalFrames=${totalFrames}, ptFrameCount=${ptFrameCount}, chunkFrames=${chunkFrames}, overlap=${overlap}, steps=${totalSteps}, chunks=${totalChunks}, sampler=${samplerName}`);
        const _chunkedT0 = performance.now();

        const ctx = { sessions, xt, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, isFP16, useStaticShapes, overlap, samplerName, cfgScheduleOpts, dynamicThresholdOpts, abortSignal, suppressDoneLog: true };
        const progressPerChunk = progressRange / totalChunks;
        let committedFrames = 0;

        try {
            for (let ci = 0; ci < totalChunks; ci++) {
                // 协作式取消检查点：块间检查，取消后立即退出分块循环。
                throwIfCancelled(abortSignal);
                const spec = specs[ci];
                console.log(`[DiffusionChunk] chunk ${ci}/${totalChunks}: frames[${spec.chunkStart},${spec.chunkEnd})=${spec.currentChunkFrames}frames`);

                const { newCommitted } = await this._runSingleDiffusionChunk(
                    ctx, spec, onProgress,
                    progressStart + ci * progressPerChunk, progressPerChunk
                );

                // 流式回调：推送已确定的 mel 片段
                if (onChunkMel && newCommitted > committedFrames) {
                    const melStart = committedFrames;
                    const melEnd = newCommitted;
                    const melLen = melEnd - melStart;
                    const melData = new Float32Array(melLen * MEL_DIM);
                    melData.set(xt.data.subarray(melStart * MEL_DIM, melEnd * MEL_DIM));
                    // onChunkMel 负责 vocoder 推理 + 音频写入 + 流式推送，失败时不能静默吞掉，
                    // 否则 committedFrames 仍前进但对应区域保持零值 → 从失败点开始静音。
                    await onChunkMel({
                        chunkIndex: ci,
                        frameStart: melStart,
                        frameEnd: melEnd,
                        melData,
                        isLast: spec.isLast,
                    });
                    committedFrames = newCommitted;
                }
            }
        } catch (err) {
            console.error(`[DiffusionChunk] Chunked diffusion failed: ${err.message}`);
            throw err;
        }

        // 完整性检查：所有 chunk 完成后 committedFrames 必须等于 totalFrames，
        // 否则说明分块规划或提交逻辑有回归，不应悄悄返回带零值的音频。
        if (onChunkMel && committedFrames !== totalFrames) {
            throw new Error(
                `Chunked diffusion consumer incomplete: ` +
                `committed ${committedFrames}/${totalFrames} frames`
            );
        }

        const _elapsed = performance.now() - _chunkedT0;
        const _rtf = (totalFrames * HOP_SIZE / SAMPLE_RATE) / (_elapsed / 1000);
        console.log(`[DiffusionChunk] Chunked diffusion complete: ${totalChunks} chunks, ${totalFrames} frames, ${_elapsed.toFixed(0)}ms, ${_rtf.toFixed(2)}x RTF, ${(totalFrames / (_elapsed/1000)).toFixed(0)} frames/s`);
    }

    /**
     * Generate random Gaussian noise
     */
    randomNoise(frameLen, melDim) {
        const data = new Float32Array(frameLen * melDim);
        const rand = this._rng || Math.random;
        for (let i = 0; i < data.length; i += 2) {
            const u1 = rand();
            const u2 = rand();
            const r = Math.sqrt(-2.0 * Math.log(u1 + 1e-10));
            const theta = 2.0 * Math.PI * u2;
            data[i] = r * Math.cos(theta);
            if (i + 1 < data.length) {
                data[i + 1] = r * Math.sin(theta);
            }
        }
        return { data, dims: [1, frameLen, melDim] };
    }
````

### R31 · vocoder 流式推送增益：整条流共享系数

文件：`src/inference/pipeline/postprocessing.js`　行：`40-105`

````javascript
 * Read enableAntiAliasing flag lazily from settings. Returns false (the spec
 * default — anti-aliasing is opt-in to avoid changing default output
 * characteristics) if settings cannot be loaded.
 * @returns {boolean}
 */
function _readEnableAntiAliasing() {
    try {
        const { loadSettings } = require('../../main/settings');
        return loadSettings().enableAntiAliasing === true;
    } catch (_) {
        return false;
    }
}

/**
 * 流式预览的共享推送增益（取代逐 chunk 独立的 normalizePeakTo）。
 *
 * 为什么不能逐 chunk 独立归一化：normalizePeakTo 只在 peak > 0.95 时缩放，
 * 于是只有"超标"的 chunk 被压、不超标的 chunk 原样保留 —— 段与段之间的相对电平
 * 被系统性改写（实测弱唱 0.40 / 高潮 2.50 / 次高潮 1.20 三段，原始动态 15.9 dB
 * 被压到 7.5 dB）；而推送切点正好落在 WSOLA 重叠区起点（w≈0，前后本应连续），
 * 相邻两次推送用不同缩放系数就会在该点形成阶跃 → 可听的咔哒/电平跳变。
 * 最终 output 不受影响（循环结束后统一 normalizePeakTo + loudnormFinal），
 * 所以症状是"预览与导出听感不一致"。
 *
 * 现在的策略：整条流共享一个增益系数。
 *   - 只在"本段乘上当前增益后仍会超过 TARGET"时才下调增益；
 *   - 下调的那一段用 ~5 ms 升余弦淡入（从 0 升到新增益），把推送切点上的电平
 *     阶跃抹平 → 不产生咔哒；同时整段幅度不超过 TARGET（如果改成"从上一增益
 *     慢慢渐变到新增益"，响段开头的样本仍可能远超 1.0，在设备端硬削波）；
 *   - 增益永不回升（已推送的段无法回溯，回升会在边界上制造向上跳变）。
 * 结果是段内动态完整保留，只有"更响的段出现"这一件事会导致整体下调一次，
 * 且下调点只有 5 ms 的轻微凹陷。
 *
 * @param {Float32Array} buf - 待推送的音频段（原地修改）
 * @param {{gain: number}} state - 跨段共享状态，初始 { gain: 1 }
 */
function _applyStreamGain(buf, state) {
    const TARGET_PEAK = 0.95;
    // 淡入长度：5 ms @ 24 kHz。足够抹掉阶跃的高频能量（咔哒），短到听不出凹陷。
    const FADE_SAMPLES = 120;
    const n = buf.length;
    if (n === 0) return;

    let peak = 0;
    for (let i = 0; i < n; i++) {
        const abs = Math.abs(buf[i]);
        if (abs > peak) peak = abs;
    }

    const prev = state.gain;
    if (peak * prev <= TARGET_PEAK) {
        if (prev !== 1) {
            for (let i = 0; i < n; i++) buf[i] *= prev;
        }
        return;
    }
    const next = TARGET_PEAK / peak;
    const fade = Math.min(n, FADE_SAMPLES);
    for (let i = 0; i < fade; i++) {
        // 升余弦：i=0 权重 0，i=fade 权重 1（淡入只在增益变化的那一段出现）
        buf[i] *= next * 0.5 * (1 - Math.cos(Math.PI * i / fade));
    }
    for (let i = fade; i < n; i++) buf[i] *= next;
    state.gain = next;
}
````

### R32 · vocoder 输入 mel 有限性守卫

文件：`src/inference/pipeline/postprocessing.js`　行：`1153-1172`

````javascript
function guardMelFinite(melData, effectiveTotalFrames, vocoderType) {
    const src = melData instanceof Float32Array ? melData : new Float32Array(melData);
    const total = src.length;
    if (total === 0) return src;
    const { nan, inf } = _countNonFinite(src);
    if (nan === 0 && inf === 0) return src;
    if ((nan + inf) / total >= 0.5) {
        throw new Error(
            `Vocoder input mel is non-finite (NaN=${nan}, Inf=${inf}, total=${total}, frames=${effectiveTotalFrames}, vocoderType=${vocoderType}): ` +
            'upstream diffusion returned NaN/Inf. Usually a vendor-EP (TensorRT-RTX) engine that cannot serve this input shape — ' +
            'check [TRTRTX] session logs / try another inference device.'
        );
    }
    const fixed = new Float32Array(src);
    for (let i = 0; i < fixed.length; i++) {
        if (!Number.isFinite(fixed[i])) fixed[i] = 0;
    }
    console.warn(`[VocoderDiag] MEL INPUT BEFORE VOCODER HAS NaN/Inf (NaN=${nan}, Inf=${inf}, total=${total}, frames=${effectiveTotalFrames}, vocoderType=${vocoderType}) — patched to 0 to keep synthesis usable`);
    return fixed;
}
````

### R33 · vocoder 分块：WSOLA 交叉淡化、committed chunk 推送

文件：`src/inference/pipeline/postprocessing.js`　行：`1274-1813`

````javascript
    /**
     * Run vocoder in chunked mode for long audio（强制串行，支持流式回调）
     *
     * @param {function} [onChunkComplete=null] - chunk 完成回调（流式播放用）
     *        chunkInfo = { chunkIndex, sampleOffset, sampleEnd, audio: Float32Array, totalSamples, isLast }
     *        audio 为该 chunk 贡献的"已确定"音频段（weightSum=1，可直接播放），按顺序拼接即得完整音频。
     */
    async runVocoderChunked(sessions, melData, totalFrames, isFP16, useStaticShapes = false, vocoderType = 'default', f0Data = null, sifiganStatsMissing = false, onChunkComplete = null, chunkFrames = 0, overlapFramesOverride = 0) {
        const _vocoderStartMs = performance.now();
        if (!sessions || !sessions.vocoder) {
            console.error(`[VocoderDiag] CRITICAL: sessions.vocoder is ${sessions ? (sessions.vocoder === undefined ? 'undefined' : 'null') : 'sessions is null'}! Vocoder will throw. sessionEPs=${JSON.stringify(sessions ? Object.keys(sessions) : [])}`);
        }
        if (_readDiagnosticMode()) {
            console.log(`[VocoderDiag] runVocoderChunked START: totalFrames=${totalFrames}, vocoderType=${vocoderType}, isFP16=${isFP16}, melDataLen=${melData.length}`);
        }
        // SiFiGAN mel 帧率（200Hz, hop=120）与 SVS 管线 mel 帧率（50Hz, hop=480）不一致。
        // SiFiGANWrapper 内部 T_audio = T_frames * 120，若直接喂 50Hz mel 会输出 1/4 期望时长。
        // 修复：在 SiFiGAN 路径下将 mel 和 F0 在时间维度 4× 上采样（最近邻），让 SiFiGAN 看到正确帧率。
        // effectiveTotalFrames * SIFIGAN_HOP_SIZE == totalFrames * HOP_SIZE，输出时长与 default vocoder 一致。
        const SIFIGAN_UPSAMPLE_RATIO = vocoderType === 'sifigan' ? (HOP_SIZE / SIFIGAN_HOP_SIZE) : 1;
        let effectiveTotalFrames = totalFrames;
        let effectiveMelData = melData;
        if (SIFIGAN_UPSAMPLE_RATIO > 1) {
            effectiveTotalFrames = totalFrames * SIFIGAN_UPSAMPLE_RATIO;
            // mel 最近邻上采样：每帧重复 SIFIGAN_UPSAMPLE_RATIO 次
            const srcArr = melData instanceof Float32Array ? melData : new Float32Array(melData);
            effectiveMelData = new Float32Array(effectiveTotalFrames * MEL_DIM);
            for (let f = 0; f < totalFrames; f++) {
                const srcOff = f * MEL_DIM;
                for (let r = 0; r < SIFIGAN_UPSAMPLE_RATIO; r++) {
                    const dstOff = (f * SIFIGAN_UPSAMPLE_RATIO + r) * MEL_DIM;
                    effectiveMelData.set(srcArr.subarray(srcOff, srcOff + MEL_DIM), dstOff);
                }
            }
        }
        // 有限性守卫（单 chunk / 多 chunk 两条路径共用）：NaN/Inf mel 送进 EP 只会得到
        // "enqueue failed" 这类无法定位的报错，这里先拦截，详见 guardMelFinite 注释。
        effectiveMelData = guardMelFinite(effectiveMelData, effectiveTotalFrames, vocoderType);

        // vocoder 期望标准化 mel (mean=0, std=1)，与官方 PyTorch soulxsinger.py 一致。
        // 之前的爆炸是 VocosFullWrapper._overlap_add 的 reshape 维度顺序 bug 导致的（已修复）。
        // effectiveMelData 保持扩散模型输出（标准化 mel），不做反标准化。
        const chunkSize = ((chunkFrames && chunkFrames > 0) ? chunkFrames : VOCODER_CHUNK_FRAMES) * SIFIGAN_UPSAMPLE_RATIO;
        // Vocoder 分块重叠帧数：优先使用调用方透传的 overlapFramesOverride（来自
        // settings.vocoderOverlapFrames，范围 8-96），否则回退到 VOCODER_OVERLAP_FRAMES 常量（32）。
        // SiFiGAN 路径下乘以 SIFIGAN_UPSAMPLE_RATIO 以保持与上采样后的 mel 帧率对齐。
        const _baseOverlapFrames = (Number.isFinite(overlapFramesOverride) && overlapFramesOverride >= 8 && overlapFramesOverride <= 96)
            ? Math.floor(overlapFramesOverride)
            : VOCODER_OVERLAP_FRAMES;
        let overlapFrames = _baseOverlapFrames * SIFIGAN_UPSAMPLE_RATIO;
        // 防死循环：overlap 必须小于 chunkSize，否则 framePos = chunkEnd 后
        // 下一块 chunkStart = framePos - overlapFrames 无法前进（姊妹实现
        // diffusion.js 的 _planChunks 有同样的钳制）。最坏情况 overlap 取
        // chunkSize/2，保证每块至少前进 chunkSize/2 ≥ 1 帧。
        if (overlapFrames >= chunkSize) {
            overlapFrames = Math.floor(chunkSize / 2);
        }
        const vocoderHopSize = vocoderType === 'sifigan' ? SIFIGAN_HOP_SIZE : HOP_SIZE;
        const totalSamples = effectiveTotalFrames * vocoderHopSize;
        const output = new Float32Array(totalSamples);
        const t0 = performance.now();
        let floatType = isFP16 ? 'float16' : 'float32';
        // 会话输入契约护栏：mel/f0 张量类型必须与会话声明一致，不能只信 isFP16 标志。
        // W16A32（权重 FP16、输入/激活 FP32）等模型体积与真 FP16 模型相同，检测标志一旦
        // 误判就会给 TRT-RTX 等严格 EP 喂错类型（DML 会隐式插 Cast 掩盖问题，TRT-RTX
        // 直接报 "Unexpected input data type. Actual float16, expected float"）。
        // inputMetadata 在 WinMLSession / onnxruntime-node 上均为数组 [{name,type,shape}]。
        try {
            const rawVocMeta = sessions.vocoder.inputMetadata;
            const vocMeta = Array.isArray(rawVocMeta)
                ? rawVocMeta
                : (rawVocMeta && typeof rawVocMeta === 'object' ? Object.values(rawVocMeta) : []);
            const melContract = vocMeta.find(m => m && m.name === 'mel') || vocMeta[0];
            if (melContract && (melContract.type === 'float16' || melContract.type === 'float32')
                && melContract.type !== floatType) {
                console.warn(`[Vocoder] precision flag isFP16=${isFP16} (${floatType}) conflicts with session mel input ${melContract.type}; feeding ${melContract.type} to match model contract`);
                floatType = melContract.type;
            }
        } catch (_) { /* 无元数据时沿用 isFP16 标志 */ }

        // Yield to event loop to keep window responsive during long DML inference
        // setImmediate 比 setTimeout(0) 快约 4 倍（Windows ~1ms vs ~4ms）
        const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

        const padFloat = (src, len) => {
            if (src.length === len) return src;
            if (src.length > len) return src.subarray(0, len);
            const padded = new Float32Array(len);
            padded.set(src);
            return padded;
        };

        // ---- SiFiGAN 双输入（mel + f0）准备 ----
        // SVS 管线产出 50Hz F0；上采样到 effectiveTotalFrames 与 mel 对齐（SiFiGAN 期望 f0/mel 同帧率）。
        const useSifiganF0 = vocoderType === 'sifigan';
        let effectiveF0 = null;
        if (useSifiganF0) {
            if (f0Data && f0Data.length > 0) {
                const srcArr = f0Data instanceof Float32Array ? f0Data : new Float32Array(f0Data);
                // 先对齐到原始 50Hz totalFrames（防御性线性插值），再 4× 上采样到 effectiveTotalFrames
                const alignedF0 = (srcArr.length === totalFrames) ? srcArr : resizeF0Linear(srcArr, totalFrames);
                if (SIFIGAN_UPSAMPLE_RATIO > 1) {
                    effectiveF0 = new Float32Array(effectiveTotalFrames);
                    const ratio = SIFIGAN_UPSAMPLE_RATIO;
                    // F0 4× 上采样：线性插值（取代最近邻"每帧重复 4 次"）。
                    // 最近邻在 F0 阶跃处产生瞬时跳变，线性插值平滑过渡，消除激励畸变。
                    // mel 上采样保持最近邻（模型训练时即如此），仅 F0 改线性。
                    for (let f = 0; f < totalFrames; f++) {
                        const f0 = alignedF0[f];
                        // 最后一帧无 f+1，clamp 到末尾值（保持常量）。
                        const f1 = (f + 1 < totalFrames) ? alignedF0[f + 1] : f0;
                        for (let r = 0; r < ratio; r++) {
                            const frac = r / ratio;
                            effectiveF0[f * ratio + r] = f0 * (1 - frac) + f1 * frac;
                        }
                    }
                } else {
                    effectiveF0 = alignedF0;
                }
            } else {
                // F0 缺失处理（简化策略）：SiFiGAN 的 f0 是 ONNX 必需输入，无法跳过；
                // 立即报错并提示用户检查 F0 配置，不修改 vocoderType 设置（仅本次推理失败）。
                console.error('[OnnxSVSPipeline] vocoderType=sifigan but F0 missing, falling back to default vocoder for this inference');
                throw new Error('SiFiGAN vocoder requires F0 input but F0 data is missing, please check F0 config (pitchCurveF0 / f0Envelope / notes) or switch to default vocoder');
            }
        }

        // 统计文件缺失已在 _doInit 阶段强制回退默认 vocoder，此处 sifiganStatsMissing 永远为 false。
        // 保留参数仅为接口兼容，运行时不再触发兜底逻辑。

        // 构造 vocoder 输入字典：default → { mel }；sifigan → { mel, f0 }（f0 与 mel 同帧率、同 seq_len）
        const buildVocoderInputs = (melTensor, vocSeqLen, frameOffset, frameCount) => {
            if (!useSifiganF0 || !effectiveF0) {
                return { mel: melTensor };
            }
            // F0 分块：取当前 chunk 对应帧区间，静态形状时 pad 到 vocSeqLen（与 mel 一致）
            let chunkF0;
            if (frameCount >= vocSeqLen) {
                chunkF0 = effectiveF0.subarray(frameOffset, frameOffset + vocSeqLen);
            } else {
                chunkF0 = padFloat(effectiveF0.subarray(frameOffset, frameOffset + frameCount), vocSeqLen);
            }
            const f0Tensor = createFloatTensor(floatType, chunkF0, [1, vocSeqLen, 1]);
            return { mel: melTensor, f0: f0Tensor };
        };

        // 短音频（≤chunkSizeframes ≈ 20.5秒）直接一次性推理，避免分chunks开销
        if (effectiveTotalFrames <= chunkSize) {
            const vocSeqLen = useStaticShapes ? NPU_VOCODER_SEQ_LEN : effectiveTotalFrames;
            const melArr = effectiveMelData instanceof Float32Array ? effectiveMelData : new Float32Array(effectiveMelData);
            const paddedMel = useStaticShapes ? padFloat(melArr, vocSeqLen * MEL_DIM) : melArr;
            const melTensor = createFloatTensor(floatType, paddedMel, [1, vocSeqLen, MEL_DIM]);
            const vocoderInputs = buildVocoderInputs(melTensor, vocSeqLen, 0, effectiveTotalFrames);

            // 诊断：mel 输入的分布统计（标准化 mel，期望 mean≈0 std≈1），受 diagnosticMode 控制。
            // NaN/Inf 检查已统一前移到 guardMelFinite（覆盖单/多 chunk 两条路径），此处不再重复扫描。
            {
                // 采样统计：每 64 个采样取 1 个，避免长音频（如 2000 帧 × 128 = 256000 元素）下全量遍历的开销
                if (_readDiagnosticMode()) {
                    const DIAG_STRIDE = 64;
                    let melMin = Infinity, melMax = -Infinity, melSum = 0, melSumSq = 0;
                    let sampledCount = 0;
                    for (let i = 0; i < paddedMel.length; i += DIAG_STRIDE) {
                        const v = paddedMel[i];
                        if (Number.isNaN(v) || !Number.isFinite(v)) continue;
                        if (v < melMin) melMin = v;
                        if (v > melMax) melMax = v;
                        melSum += v;
                        melSumSq += v * v;
                        sampledCount++;
                    }
                    const melMean = sampledCount > 0 ? melSum / sampledCount : 0;
                    const melStd = sampledCount > 0 ? Math.sqrt(Math.max(0, melSumSq / sampledCount - melMean * melMean)) : 0;
                    console.log(`[VocoderDiag] single-chunk mel stats (sampled 1/${DIAG_STRIDE}): frames=${effectiveTotalFrames}, len=${paddedMel.length}, min=${melMin.toFixed(6)}, max=${melMax.toFixed(6)}, mean=${melMean.toFixed(6)}, std=${melStd.toFixed(6)}`);
                }
            }

            let results;
            try {
                results = await sessions.vocoder.run(vocoderInputs);
            } catch (runErr) {
                disposeTensor(melTensor);
                if (vocoderInputs.f0) disposeTensor(vocoderInputs.f0);
                // OOM / device removed：DML 显存耗尽，抛出带上下文的明确错误，
                // 防止上层误以为合成完毕而播放空声音
                if (isVramOOMError(runErr)) {
                    throw new Error(`Vocoder OOM on single-chunk inference (frames=${effectiveTotalFrames}): ${runErr.message}. Try reducing vocoder chunk frames in settings.`);
                }
                throw runErr;
            }
            await yieldToEventLoop(); // Prevent UI freeze during DML inference
            let outTensor;
            try {
                outTensor = pickVocoderWaveform(results, sessions.vocoder);
            } catch (pickErr) {
                // EP 丢失输出时也要释放本 chunk 输入张量，避免泄漏
                disposeTensor(melTensor);
                if (vocoderInputs.f0) disposeTensor(vocoderInputs.f0);
                throw pickErr;
            }
            const waveform = outputToFloat32(outTensor);
            // 释放单 chunk 的输入和输出张量
            disposeTensor(outTensor);
            disposeTensor(melTensor);
            if (vocoderInputs.f0) disposeTensor(vocoderInputs.f0);
            // 诊断：检查 vocoder 输出
            // NaN/Inf 致命错误 console.error 始终输出；统计采样 console.log 受 diagnosticMode 控制
            {
                let wavNaN = 0, wavInf = 0;
                for (let i = 0; i < waveform.length; i++) {
                    if (Number.isNaN(waveform[i])) wavNaN++;
                    if (!Number.isFinite(waveform[i])) wavInf++;
                }
                const expectedSamples = effectiveTotalFrames * vocoderHopSize;
                if (wavNaN > 0 || wavInf > 0) {
                    console.error(`[VocoderDiag] VOCODER OUTPUT HAS NaN/Inf! NaN=${wavNaN}, Inf=${wavInf - wavNaN}, total=${waveform.length}, expected=${expectedSamples}, frames=${effectiveTotalFrames}, vocoderType=${vocoderType}`);
                }
                if (_readDiagnosticMode()) {
                    let wavZero = 0;
                    for (let i = 0; i < waveform.length; i++) {
                        if (waveform[i] === 0) wavZero++;
                    }
                    console.log(`[VocoderDiag] single-chunk: frames=${effectiveTotalFrames}, vocoderType=${vocoderType}, outputLen=${waveform.length}, expectedLen=${expectedSamples}, NaN=${wavNaN}, zero=${wavZero}/${waveform.length}`);
                }
            }
            // 校验输出：DML 在显存边界可能返回全零/NaN 而不抛错（silent failure）
            validateVocoderOutput(waveform, 0, { silentInputMel: isSilentMel(effectiveMelData) });
            // 诊断：vocoder 输出开头能量分布（排查"第一个 midi 开头缺音"问题）
            // 纯统计采样，受 diagnosticMode 控制
            if (_readDiagnosticMode()) {
                const hopSamples = vocoderHopSize; // 1 mel frame = hopSamples audio samples
                const diagFrames = Math.min(10, Math.floor(waveform.length / hopSamples));
                const parts = [];
                let totalAbs = 0;
                for (let f = 0; f < diagFrames; f++) {
                    let s = 0;
                    const s0 = f * hopSamples;
                    const s1 = Math.min(s0 + hopSamples, waveform.length);
                    for (let i = s0; i < s1; i++) s += waveform[i] * waveform[i];
                    const rms = Math.sqrt(s / Math.max(1, s1 - s0));
                    totalAbs += rms;
                    parts.push(`f${f}=${rms.toFixed(5)}`);
                }
                // 同时统计 mel 开头能量（前 5 帧）
                const melParts = [];
                const melDiagFrames = Math.min(5, effectiveTotalFrames);
                for (let f = 0; f < melDiagFrames; f++) {
                    let s = 0;
                    for (let d = 0; d < MEL_DIM; d++) {
                        const v = paddedMel[f * MEL_DIM + d];
                        s += v * v;
                    }
                    melParts.push(`m${f}=${Math.sqrt(s / MEL_DIM).toFixed(5)}`);
                }
                console.log(`[VocoderDiag] single-chunk: frames=${effectiveTotalFrames}, vocoderType=${vocoderType}, melRMS=[${melParts.join(', ')}], wavRMS=[${parts.join(', ')}]`);
            }
            const copyLen = Math.min(waveform.length, totalSamples);
            output.set(waveform.subarray(0, copyLen));
            normalizePeakTo(output);
            // M7: streaming preview consistency — push the peak-normalized
            // chunk to onChunkComplete BEFORE loudnorm, so the streaming
            // preview receives the same peak-normalized audio as the
            // multi-chunk path (which pushes its segments through the shared
            // _applyStreamGain, with loudnorm applied only to the final merged
            // output). The final returned `output` is loudnorm'd below, matching
            // the multi-chunk path's final loudnormFinal. 单 chunk 只有一次推送，
            // 全局归一化与"共享增益"等价。
            if (onChunkComplete) {
                try {
                    onChunkComplete({
                        chunkIndex: 0,
                        sampleOffset: 0,
                        sampleEnd: copyLen,
                        audio: output.slice(0, copyLen),
                        totalSamples: copyLen,
                        isLast: true,
                    });
                } catch (e) {
                    console.warn('[OnnxSVSPipeline] onChunkComplete callback error:', e.message);
                }
            }
            // EBU R128 响度归一化（−14 LUFS）+ true-peak 限制（−1 dBTP）。
            // 受 enableLoudnormFinal 设置控制（默认 true）；关闭时仅走上面的
            // normalizePeakTo(0.95) 峰值归一化（旧行为）。单 chunk 路径在
            // onChunkComplete 推送后统一应用，与多 chunk 路径保持一致。
            if (_readEnableLoudnormFinal()) {
                loudnormFinal(output, SAMPLE_RATE);
            }
            if (_readDiagnosticMode()) {
                console.log(`[VocoderDiag] runVocoderChunked END (single-chunk): ${(performance.now() - _vocoderStartMs).toFixed(0)}ms, outputLen=${output.length}`);
            }
            return output;
        }

        // 长音频分chunks推理（流式：每 chunk 创建/推理/释放，避免 GPU 张量累积导致 OOM）
        // framePos 语义：下一个 chunk 的"新数据起始位置"（不含与前一个 chunk 的重叠区）。
        //   chunk 0:   chunkStart=0,                 chunkEnd=chunkSize,      framePos→chunkEnd
        //   chunk N:   chunkStart=framePos-overlap,  chunkEnd=chunkStart+chunkSize, framePos→chunkEnd
        //   末尾 chunk（chunkEnd 被 effectiveTotalFrames 截断）：写入后显式 break，
        //     避免旧逻辑 framePos = chunkEnd - overlapFrames 反复回退导致死循环
        // NOTE: the old Hann-OLA era kept a full-length weightSum[] array and
        // divided the output by it at the end. Every write site assigned the
        // exact constant 1 (WSOLA crossfade weights already sum to 1), so the
        // array (up to ~77MB at the 40000-frame cap) and the final full-length
        // pass were pure overhead. Committed regions are tracked via
        // committedSamples instead.

        const fadeSamples = overlapFrames * vocoderHopSize;
        // WSOLA 分块交叉淡入淡出：取代旧的对称 Hann OLA 窗。
        // 旧 fadeWindow 已移除——WSOLA 内部使用互相关搜索最佳对齐后再做 Hann OLA，
        // 消除有音高信号在 chunk 边界的 flanging/梳状滤波。
        // prevChunkTail 在循环中跨 chunk 维护：每个非末尾 chunk 保存其波形尾部
        // (fadeSamples 长)，下个 chunk 用 WSOLA 与自身头部对齐后写回重叠区。
        let prevChunkTail = null;

        // 第一阶段：仅计算所有 chunk 的边界元数据（不创建张量）。
        // 旧版本在此阶段预创建所有 chunk 的 melTensor/f0Tensor 并存入 chunkSpecs，
        // 导致所有 chunk 的 GPU 输入张量同时驻留显存；加上第二阶段每个 chunk 的
        // 输出张量（results['waveform']）未显式释放，chunk 间累积触发 887A0006
        // (GPU device removed)。现改为：第一阶段只存元数据，第二阶段流式创建+释放。
        const chunkSpecs = [];
        let framePos = 0;
        let chunkIdx = 0;
        while (framePos < effectiveTotalFrames) {
            const isFirst = chunkIdx === 0;
            const chunkStart = isFirst ? 0 : Math.max(0, framePos - overlapFrames);
            const chunkEnd = Math.min(chunkStart + chunkSize, effectiveTotalFrames);
            const currentChunkFrames = chunkEnd - chunkStart;
            const isLast = chunkEnd >= effectiveTotalFrames;
            chunkSpecs.push({ chunkStart, chunkEnd, currentChunkFrames, isFirst, isLast });
            if (isLast) break;
            framePos = chunkEnd;
            chunkIdx++;
        }

        // 第二阶段：强制串行执行 vocoder chunk 推理（流式创建/释放张量）。
        // 注意：DML 后端下，同一个 InferenceSession 并发 run() 会向命令队列交叉提交命令流，
        // 触发 DXGI_ERROR_DEVICE_REMOVED (0x887A0006) — GPU 设备因无效命令被驱动移除。
        // 旧版本 VOC_PARALLEL=2 的 Promise.all 并行已移除，所有 chunk 严格按顺序逐个推理。
        //
        // 张量生命周期：每个 chunk 在循环内创建 melTensor/f0Tensor → 推理 → 提取波形 →
        // 立即解除输入/输出张量的 JS 引用（data 置空 + 变量置 null），并额外 yield 一次
        // 给 V8 GC 回收 native 资源。否则 chunk 间累积的 GPU 张量会耗尽显存导致后续 chunk OOM。
        // 流式播放：每完成一个 chunk，通过 onChunkComplete 推送"已确定"的音频段（weightSum=1）。
        //
        // 错误处理：每个 chunk 的 vocoder.run() 都包 try/catch。
        // - OOM / device removed：立即抛出明确错误，阻止后续 chunk 继续浪费 GPU 时间，
        //   同时防止 onChunkComplete 推送部分音频后中段失败导致应用误判合成完毕。
        // - 输出校验：DML 在显存边界可能不抛错而是返回全零/NaN 波形（silent failure），
        //   validateVocoderOutput 拦截此类无效输出。
        const totalChunkCount = chunkSpecs.length;
        let committedSamples = 0;
        // 流式推送的共享增益状态（跨 chunk 保持，见 _applyStreamGain 注释）。
        const streamGain = { gain: 1 };
        for (let i = 0; i < totalChunkCount; i++) {
            const spec = chunkSpecs[i];
            // 流式创建当前 chunk 的输入张量（不预存到 chunkSpecs）。
            // 直接在 effectiveMelData 上取视图：静态形状路径 padFloat 会复制到
            // 定长缓冲；动态 float16 路径 createFloatTensor 内部转换时复制；
            // 动态 float32 路径张量直接包装该视图（run 期间源数据不会被修改），
            // 省去每 chunk 一次全长中间拷贝。
            const melSub = effectiveMelData.subarray(spec.chunkStart * MEL_DIM, spec.chunkEnd * MEL_DIM);
            const vocSeqLen = useStaticShapes ? NPU_VOCODER_SEQ_LEN : spec.currentChunkFrames;
            const paddedChunk = useStaticShapes ? padFloat(melSub, vocSeqLen * MEL_DIM) : melSub;
            const melTensor = createFloatTensor(floatType, paddedChunk, [1, vocSeqLen, MEL_DIM]);
            const vocoderInputs = buildVocoderInputs(melTensor, vocSeqLen, spec.chunkStart, spec.currentChunkFrames);

            let results;
            try {
                results = await sessions.vocoder.run(vocoderInputs);
            } catch (runErr) {
                // 推理失败也要释放当前 chunk 输入张量，避免后续重试时累积
                disposeTensor(melTensor);
                if (vocoderInputs.f0) disposeTensor(vocoderInputs.f0);
                if (isVramOOMError(runErr)) {
                    throw new Error(`Vocoder OOM at chunk ${i}/${totalChunkCount} (frames=${spec.currentChunkFrames}, offset=${spec.chunkStart}): ${runErr.message}. Try reducing vocoder chunk frames in settings.`);
                }
                throw new Error(`Vocoder inference failed at chunk ${i}/${totalChunkCount}: ${runErr.message}`);
            }
            await yieldToEventLoop(); // Prevent UI freeze between vocoder chunks

            let outTensor;
            try {
                outTensor = pickVocoderWaveform(results, sessions.vocoder);
            } catch (pickErr) {
                // EP 丢失输出时也要释放本 chunk 输入张量，避免跨 chunk 泄漏
                disposeTensor(melTensor);
                if (vocoderInputs.f0) disposeTensor(vocoderInputs.f0);
                throw pickErr;
            }
            const waveform = outputToFloat32(outTensor);
            // 立即释放 ONNX 输出张量与输入张量：解除 JS 引用，让 V8 GC 回收 native 资源。
            // DML 后端 GPU 张量依赖 finalizer 异步释放，多个 chunk 累积会导致后续 chunk OOM。
            disposeTensor(outTensor);
            disposeTensor(melTensor);
            if (vocoderInputs.f0) disposeTensor(vocoderInputs.f0);
            results = null;
            // chunk 间 GPU 排空：非末尾 chunk 时调用自适应排空（实际仅 setImmediate
            // 让出一轮事件循环，不做墙钟等待）。OOM 标志由 pipeline/index.js 的
            // OOM catch 通过 markGpuOom() 设置，下一次调用仅消费标志、不延长等待。
            if (i < totalChunkCount - 1) {
                await gpuDrainAdaptive();
            } else {
                await yieldToEventLoop();
            }

            // 校验输出：拦截 DML silent failure（全零/NaN）
            // melSub 是本 chunk 的原始 mel（不含静态形状补零，补零会把「静音」判成有能量）。
            validateVocoderOutput(waveform, i, { silentInputMel: isSilentMel(melSub) });
            // 诊断：首 chunk 输出开头能量分布（排查"第一个 midi 开头缺音"问题）
            // 纯统计采样，受 diagnosticMode 控制
            if (spec.isFirst && _readDiagnosticMode()) {
                const hopSamples = vocoderHopSize;
                const diagFrames = Math.min(10, Math.floor(waveform.length / hopSamples));
                const parts = [];
                for (let f = 0; f < diagFrames; f++) {
                    let s = 0;
                    const s0 = f * hopSamples;
                    const s1 = Math.min(s0 + hopSamples, waveform.length);
                    for (let k = s0; k < s1; k++) s += waveform[k] * waveform[k];
                    parts.push(`f${f}=${Math.sqrt(s / Math.max(1, s1 - s0)).toFixed(5)}`);
                }
                // mel 开头能量（前 5 帧）
                const melParts = [];
                const melDiagFrames = Math.min(5, spec.currentChunkFrames);
                for (let f = 0; f < melDiagFrames; f++) {
                    let s = 0;
                    for (let d = 0; d < MEL_DIM; d++) {
                        const v = paddedChunk[f * MEL_DIM + d];
                        s += v * v;
                    }
                    melParts.push(`m${f}=${Math.sqrt(s / MEL_DIM).toFixed(5)}`);
                }
                // 完整 mel 输入统计（整个 chunk，采样 1/64 降低开销）
                {
                    const DIAG_STRIDE = 64;
                    let melMin = Infinity, melMax = -Infinity, melSum = 0, melSumSq = 0;
                    let sampledCount = 0;
                    const melLen = paddedChunk.length;
                    for (let i2 = 0; i2 < melLen; i2 += DIAG_STRIDE) {
                        const v = paddedChunk[i2];
                        if (v < melMin) melMin = v;
                        if (v > melMax) melMax = v;
                        melSum += v;
                        melSumSq += v * v;
                        sampledCount++;
                    }
                    const melMean = sampledCount > 0 ? melSum / sampledCount : 0;
                    const melStd = sampledCount > 0 ? Math.sqrt(Math.max(0, melSumSq / sampledCount - melMean * melMean)) : 0;
                    console.log(`[VocoderDiag] chunk0 FULL mel stats (sampled 1/${DIAG_STRIDE}): frames=${spec.currentChunkFrames}, len=${melLen}, min=${melMin.toFixed(6)}, max=${melMax.toFixed(6)}, mean=${melMean.toFixed(6)}, std=${melStd.toFixed(6)}`);
                }
                console.log(`[VocoderDiag] chunk0: chunkFrames=${spec.currentChunkFrames}, vocoderType=${vocoderType}, melRMS=[${melParts.join(', ')}], wavRMS=[${parts.join(', ')}]`);
            }
            const writeStart = spec.chunkStart * vocoderHopSize;
            const writeLen = Math.min(waveform.length, totalSamples - writeStart);
            // WSOLA 交叉淡入淡出写回：
            // - 首 chunk 或样本不足：直接整段写入（weight=1）。
            // - 非首 chunk 且 prevChunkTail/currHead 均有足够样本：WSOLA 对齐后写入重叠区
            //   （覆盖前一 chunk 尾部贡献），再写入非重叠区。
            // - 非末 chunk：保存尾部 fadeSamples 样本到 prevChunkTail 供下个 chunk WSOLA。
            const overlapWriteLen = Math.min(fadeSamples, writeLen);
            const canWsola = !spec.isFirst && prevChunkTail && overlapWriteLen > 0 &&
                prevChunkTail.length >= overlapWriteLen && waveform.length >= overlapWriteLen;
            if (canWsola) {
                const currChunkHead = waveform.subarray(0, overlapWriteLen);
                const wsolaResult = wsolaCrossfade(prevChunkTail, currChunkHead, overlapWriteLen, SAMPLE_RATE);
                // 重叠区：逐样本生成的 WSOLA 结果，一次原生 memcpy 写回。
                const overlapCopy = Math.min(overlapWriteLen, totalSamples - writeStart);
                if (overlapCopy > 0) {
                    output.set(wsolaResult.subarray(0, overlapCopy), writeStart);
                }
                // 重叠区之后的稳定区：原生 memcpy（原为逐样本标量循环，
                // 每 chunk 可达约 49 万次赋值）。
                const stableStart = writeStart + overlapWriteLen;
                const stableCopy = Math.min(writeLen - overlapWriteLen, totalSamples - stableStart);
                if (stableCopy > 0) {
                    output.set(waveform.subarray(overlapWriteLen, overlapWriteLen + stableCopy), stableStart);
                }
            } else {
                const copyLen = Math.min(writeLen, totalSamples - writeStart);
                if (copyLen > 0) {
                    output.set(waveform.subarray(0, copyLen), writeStart);
                }
            }
            // 保存尾部供下个 chunk WSOLA 对齐（仅非末尾 chunk 且样本足够）。
            // waveform 是本 chunk 独有的全新数组且之后只读，subarray 视图即可，
            // 无需 slice 复制。
            if (!spec.isLast && fadeSamples > 0 && waveform.length >= fadeSamples) {
                prevChunkTail = waveform.subarray(waveform.length - fadeSamples);
            }

            // 流式推送：推送 [committedSamples, stableEnd]（weightSum=1，overlap crossfade 权重和为 1）
            // - 首 chunk：stableEnd = (isLast ? chunkEnd : chunkEnd - overlapFrames) * vocoderHopSize
            // - 中间 chunk：包含头部 overlap 的 crossfade 结果 + 稳定段（weightSum=1）
            // - 末 chunk：stableEnd = chunkEnd * vocoderHopSize（尾部无 fade）
            // 注意：推送前按"整条流共享一个增益系数"缩放（_applyStreamGain），
            // 而不是每个 chunk 独立归一化 —— 后者会把段间相对电平抹平并在推送切点
            // 制造阶跃（详见 _applyStreamGain 注释）。最终 output 自身不被推送缩放影响，
            // 循环结束后仍统一 normalizePeakTo + loudnormFinal。
            if (onChunkComplete) {
                const stableEndFrames = spec.isLast ? spec.chunkEnd : (spec.chunkEnd - overlapFrames);
                const stableEnd = Math.min(stableEndFrames * vocoderHopSize, totalSamples);
                if (stableEnd > committedSamples) {
                    const chunkAudio = output.slice(committedSamples, stableEnd);
                    _applyStreamGain(chunkAudio, streamGain);
                    try {
                        onChunkComplete({
                            chunkIndex: i,
                            sampleOffset: committedSamples,
                            sampleEnd: stableEnd,
                            audio: chunkAudio,
                            totalSamples,
                            isLast: spec.isLast,
                        });
                    } catch (e) {
                        console.warn('[OnnxSVSPipeline] onChunkComplete callback error:', e.message);
                    }
                    committedSamples = stableEnd;
                }
            }
        }

        normalizePeakTo(output, totalSamples);

        // EBU R128 响度归一化（−14 LUFS）+ true-peak 限制（−1 dBTP）。
        // 受 enableLoudnormFinal 设置控制（默认 true）；关闭时仅走上面的
        // normalizePeakTo(0.95) 峰值归一化（旧行为）。多 chunk 路径在所有
        // chunk 合并归一化后统一应用，避免逐 chunk 响度跳变。
        if (_readEnableLoudnormFinal()) {
            loudnormFinal(output, SAMPLE_RATE);
        }

        const elapsed = performance.now() - t0;
        const logFrames = SIFIGAN_UPSAMPLE_RATIO > 1 ? `${effectiveTotalFrames} (${totalFrames}x${SIFIGAN_UPSAMPLE_RATIO})` : `${totalFrames}`;
        console.log(`[OnnxSVSPipeline] Vocoder chunked: ${logFrames} frames, ${totalChunkCount} chunks (serial, streaming), ${elapsed.toFixed(0)}ms`);
        if (_readDiagnosticMode()) {
            console.log(`[VocoderDiag] runVocoderChunked END (multi-chunk): ${(performance.now() - _vocoderStartMs).toFixed(0)}ms, outputLen=${output.length}`);
        }
        return output;
    }
````

### R34 · WSOLA：时域与 mel 域对齐 + Hann OLA

文件：`src/inference/pipeline/wsola.js`　行：`1-265`

````javascript
/**
 * WSOLA (Waveform Similarity Overlap-Add) crossfade utilities.
 *
 * Replaces symmetric Hann OLA crossfades at vocoder chunk boundaries (time
 * domain) and diffusion chunk boundaries (mel domain). Plain Hann OLA assumes
 * the two segments are already time-aligned; on pitched signals a constant
 * phase/time offset between chunks produces flanging / comb filtering across
 * the overlap. WSOLA first searches for the best local alignment via
 * cross-correlation (time domain) or cosine similarity (mel domain), then
 * applies a Hann-weighted OLA on the aligned segments — eliminating the
 * comb-filter artifacts while keeping the overlap continuous.
 *
 * Both helpers return the crossfaded concatenation of length
 * `prevTail.length + currHead.length - overlapSamples` (the standard
 * "concatenate with overlap" length). When the two inputs are exactly
 * `overlap` long (the common vocoder-chunk case), the result is just the
 * `overlap`-sample crossfaded region.
 */

/**
 * Time-domain WSOLA crossfade.
 *
 * Algorithm:
 *   1. Copy the non-overlapping prefix of prevTail and suffix of currHead
 *      unchanged.
 *   2. Over the overlap region, find ONE global alignment offset via a single
 *      zero-mean normalized cross-correlation search over the FULL overlap
 *      (search window ±searchWindowMs). This is intentionally NOT per-frame
 *      WSOLA: per-frame WSOLA divides the overlap into ~2 ms analysis frames
 *      and can pick *different* offsets per frame on periodic signals (the
 *      periodic cross-correlation has multiple equal peaks, so consecutive
 *      frames may land on different peaks and stitch together a discontinuous
 *      alignedCurr). A global search uses the entire overlap as the
 *      correlation window — the longer window sharpens the peak and produces
 *      ONE consistent offset, so alignedCurr is a contiguous slice of
 *      currHead with no internal discontinuities. This keeps the Hann
 *      crossfade smooth even on pitched (periodic) signals where per-frame
 *      WSOLA breaks down.
 *   3. Build alignedCurr by shifting currHead by the best offset (edge-clamp
 *      samples that fall outside currHead; the Hann window is ~0 at the edges
 *      so the clamp has negligible effect).
 *   4. Apply a Hann crossfade window over the full overlap:
 *      result[i] = prevTail[i] * (1 - w[i]) + alignedCurr[i] * w[i].
 *
 * @param {Float32Array|number[]} prevTail - tail of the previous segment
 * @param {Float32Array|number[]} currHead - head of the current segment
 * @param {number} overlapSamples - number of overlapping samples
 * @param {number} sampleRate - sample rate of the waveforms (Hz)
 * @param {number} [searchWindowMs=4] - global alignment search window (±ms)
 * @returns {Float32Array} crossfaded output, length prevTail.length + currHead.length - overlapSamples
 */
function wsolaCrossfade(prevTail, currHead, overlapSamples, sampleRate, searchWindowMs = 4) {
    const n1 = prevTail.length;
    const n2 = currHead.length;
    const O = Math.max(0, Math.floor(overlapSamples));
    const outLen = n1 + n2 - O;
    const result = new Float32Array(Math.max(0, outLen));
    if (outLen <= 0) return result;

    // Non-overlap prefix from prevTail (unchanged).
    const prefixLen = Math.max(0, n1 - O);
    for (let i = 0; i < prefixLen; i++) result[i] = prevTail[i];
    // Non-overlap suffix from currHead (unchanged).
    const suffixLen = Math.max(0, n2 - O);
    for (let i = 0; i < suffixLen; i++) result[prefixLen + O + i] = currHead[O + i];

    if (O <= 0) return result;
    // Overlap region in prevTail: [prefixLen, prefixLen + O) (its last O samples).
    // Overlap region in currHead: [0, O) (its first O samples).
    const overlapStart = prefixLen;

    // Insufficient samples for WSOLA search — fall back to plain Hann crossfade.
    if (n1 < O || n2 < O) {
        for (let i = 0; i < O; i++) {
            const w = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (O + 1)));
            const prev = (overlapStart + i < n1) ? prevTail[overlapStart + i] : 0;
            const curr = (i < n2) ? currHead[i] : 0;
            result[overlapStart + i] = prev * (1 - w) + curr * w;
        }
        return result;
    }

    const searchSamples = Math.max(1, Math.floor((searchWindowMs || 0) * sampleRate / 1000));

    // Global alignment: a single zero-mean normalized cross-correlation search
    // over the full overlap. Unlike per-frame WSOLA (which divides the overlap
    // into ~2 ms analysis frames and can pick *different* offsets per frame on
    // periodic signals — the periodic cross-correlation has multiple equal
    // peaks, so consecutive frames may land on different peaks and stitch
    // together a discontinuous alignedCurr), a global search uses the entire
    // overlap as the correlation window. The longer window sharpens the peak
    // (more samples ⇒ better selectivity) and, critically, produces ONE
    // consistent offset, so alignedCurr is a contiguous slice of currHead with
    // no internal discontinuities. This keeps the Hann crossfade smooth even
    // on pitched (periodic) signals where per-frame WSOLA breaks down.
    //
    // For each candidate offset the correlation is computed only over the
    // mutually-valid sample range (handles the case where the offset shifts
    // part of the window outside currHead).
    let bestOff = 0;
    let bestCorr = -Infinity;
    for (let off = -searchSamples; off <= searchSamples; off++) {
        const lo = Math.max(0, -off);
        const hi = Math.min(O, n2 - off);
        const len = hi - lo;
        if (len < 8) continue; // need enough overlap for a reliable correlation

        let refMean = 0, candMean = 0;
        for (let i = lo; i < hi; i++) {
            refMean += prevTail[overlapStart + i];
            candMean += currHead[i + off];
        }
        refMean /= len;
        candMean /= len;

        let corr = 0, refVar = 0, candVar = 0;
        for (let i = lo; i < hi; i++) {
            const r = prevTail[overlapStart + i] - refMean;
            const c = currHead[i + off] - candMean;
            corr += r * c;
            refVar += r * r;
            candVar += c * c;
        }
        const denom = Math.sqrt(refVar * candVar);
        // Normalized cross-correlation in [-1, 1]; offset 0 (no shift) is kept
        // when correlations are tied so phase-continuous inputs are untouched.
        const normCorr = denom > 1e-8 ? corr / denom : 0;
        if (normCorr > bestCorr) {
            bestCorr = normCorr;
            bestOff = off;
        }
    }

    // Build alignedCurr by shifting currHead by bestOff. Samples that fall
    // outside currHead (only possible at the edges when bestOff != 0) are
    // edge-clamped; the Hann crossfade window is ~0 there so the clamp has
    // negligible effect on the output.
    const alignedCurr = new Float32Array(O);
    for (let i = 0; i < O; i++) {
        const j = i + bestOff;
        alignedCurr[i] = (j >= 0 && j < n2) ? currHead[j] : currHead[j < 0 ? 0 : n2 - 1];
    }

    // Hann crossfade window over the full overlap (w[i] + w[O-1-i] = 1).
    for (let i = 0; i < O; i++) {
        const w = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (O + 1)));
        result[overlapStart + i] = prevTail[overlapStart + i] * (1 - w) + alignedCurr[i] * w;
    }

    return result;
}

/**
 * Mel-domain WSOLA crossfade.
 *
 * Per-frame alignment using cosine similarity between mel frames, then
 * frame-by-frame Hann OLA crossfade. Mel frames are treated as atomic units
 * (no sub-frame interpolation), matching how the diffusion model produces mel.
 *
 * @param {Float32Array|number[]} prevTail - tail mel of previous chunk (frames*melDim flat)
 * @param {Float32Array|number[]} currHead - head mel of current chunk (frames*melDim flat)
 * @param {number} overlapFrames - number of overlapping mel frames
 * @param {number} melDim - mel feature dimension (e.g. 128)
 * @returns {Float32Array} crossfaded mel, length (prevFrames + currFrames - overlapFrames) * melDim
 */
function wsolaCrossfadeMel(prevTail, currHead, overlapFrames, melDim) {
    const md = Math.max(1, Math.floor(melDim));
    const n1 = Math.floor(prevTail.length / md); // prevTail frames
    const n2 = Math.floor(currHead.length / md); // currHead frames
    const O = Math.max(0, Math.floor(overlapFrames));
    const outFrames = n1 + n2 - O;
    const result = new Float32Array(Math.max(0, outFrames) * md);
    if (outFrames <= 0) return result;

    // Non-overlap prefix from prevTail.
    const prefixFrames = Math.max(0, n1 - O);
    for (let f = 0; f < prefixFrames; f++) {
        for (let d = 0; d < md; d++) result[f * md + d] = prevTail[f * md + d];
    }
    // Non-overlap suffix from currHead.
    const suffixFrames = Math.max(0, n2 - O);
    for (let f = 0; f < suffixFrames; f++) {
        for (let d = 0; d < md; d++) result[(prefixFrames + O + f) * md + d] = currHead[(O + f) * md + d];
    }

    if (O <= 0) return result;
    const overlapStart = prefixFrames; // == n1 - O

    if (n1 < O || n2 < O) {
        // Fallback plain Hann crossfade.
        for (let i = 0; i < O; i++) {
            const w = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (O + 1)));
            for (let d = 0; d < md; d++) {
                const prev = (overlapStart + i < n1) ? prevTail[(overlapStart + i) * md + d] : 0;
                const curr = (i < n2) ? currHead[i * md + d] : 0;
                result[(overlapStart + i) * md + d] = prev * (1 - w) + curr * w;
            }
        }
        return result;
    }

    // Per-frame best alignment via cosine similarity.
    // Search window: ±O/4 frames (clamped to >=1).
    // 单调约束加在对齐源帧索引 j = i + bestOff 上（j 序列单调非减）：
    // 旧实现对每帧独立挑 bestOff，相邻帧挑到不同峰时 j 会回退/跳跃 →
    // 重复或跳过若干帧 → 局部时间伸缩/压缩（±O/4 帧可达 ±240ms 的非单调
    // warp），与文件头 wsolaCrossfade 的时域论证矛盾。j 非减允许 off 每帧
    // 至多回退 1（边界处合法的整体相位校正仍可行），但杜绝来回跳跃。
    const searchFrames = Math.max(1, Math.floor(O / 4));
    const alignedCurr = new Float32Array(O * md);

    let minJ = 0; // 上一帧已选的 j（单调下界）
    for (let i = 0; i < O; i++) {
        const refBase = (overlapStart + i) * md;
        let refNorm = 0;
        for (let d = 0; d < md; d++) refNorm += prevTail[refBase + d] * prevTail[refBase + d];
        refNorm = Math.sqrt(refNorm);

        let bestJ = -1;
        let bestSim = -Infinity;
        for (let j = minJ; j < O && j < n2; j++) {
            const off = j - i;
            if (off < -searchFrames || off > searchFrames) continue;
            const candBase = j * md;
            let dot = 0;
            let candNorm = 0;
            for (let d = 0; d < md; d++) {
                dot += prevTail[refBase + d] * currHead[candBase + d];
                candNorm += currHead[candBase + d] * currHead[candBase + d];
            }
            candNorm = Math.sqrt(candNorm);
            const sim = (refNorm > 1e-8 && candNorm > 1e-8) ? dot / (refNorm * candNorm) : 0;
            if (sim > bestSim) {
                bestSim = sim;
                bestJ = j;
            }
        }
        // 候选窗塌缩的兜底（理论上不可达：minJ 恒为合法帧索引）
        if (bestJ < 0) bestJ = Math.min(minJ, O - 1, n2 - 1);
        minJ = bestJ;
        const srcBase = bestJ * md;
        for (let d = 0; d < md; d++) alignedCurr[i * md + d] = currHead[srcBase + d];
    }

    // Hann OLA crossfade over the overlap frames.
    const xfWin = new Float32Array(O);
    for (let i = 0; i < O; i++) {
        xfWin[i] = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (O + 1)));
    }
    for (let i = 0; i < O; i++) {
        const w = xfWin[i];
        const refBase = (overlapStart + i) * md;
        const alignedBase = i * md;
        for (let d = 0; d < md; d++) {
            result[refBase + d] = prevTail[refBase + d] * (1 - w) + alignedCurr[alignedBase + d] * w;
        }
    }

    return result;
}

module.exports = {
    wsolaCrossfade,
    wsolaCrossfadeMel,
};
````

### R35 · 分段常量

文件：`src/inference/pipeline/audioSegmentation.js`　行：`1-30`

````javascript
const { LONG_AUDIO_THRESHOLD_SEC, SEGMENT_MIN_SEC, SEGMENT_MAX_SEC, SEGMENT_OVERLAP_SEC } = require('./constants');
// 哈希算法与渲染层签名共用一份（src/shared/hashSignature.js）。
// 这里保留 hashArray 方法名：调用点遍布本文件与 index.js，改名没有收益。
const { hashNumberArray } = require('../../shared/hashSignature.js');
const { computePromptCondSignature } = require('../../shared/promptCondSignature.js');

// Only rests >= 1.5 seconds are excluded from inference; 150 ms of rest
// context is kept on both sides of the split so consonant releases and the
// following attack still see an <SP>-like boundary. Shared by
// buildVocalSegments() and splitLongRestRegions().
const LONG_REST_SEC = 1.5;
const REST_CONTEXT_SEC = 0.15;

/**
 * 唯一休止判据（rest = 不参与演唱内容的音符）。
 *
 * 供 AudioSegmentation、Preprocessing 与 index.js 的静音处理共用，避免三处
 * 判据分叉导致"切分排除了它、静音阶段又保留它"的不一致。
 *
 * - pitch <= 0 的音符（fillNoteGaps 合成、MIDI 导入的 0 号音）**始终**是休止，
 *   即使带有 slur/continuation 标记——旧 AudioSegmentation 的判据就是 pitch 优先，
 *   否则 MIDI 导入把 lyric '-' 记为 noteType=3 时会漏掉这类静音段；
 * - slur/continuation（noteType 3 / isSlur / isContinuation）在 pitch>0 时即使
 *   歌词为空也不是休止；
 * - <AP> 是可听见的吸气 token，不是休止；
 * - 显式空歌词（字段存在且为 ''）是休止；缺少 lyric 字段本身不构成休止。
 *
 * @param {Object} note
 * @returns {boolean}
 */
````

### R36 · 长休止 region 切分（多分片流式用；分片编辑器单分片路径不直接用）

文件：`src/inference/pipeline/audioSegmentation.js`　行：`96-176`

````javascript
    /**
     * Split the gap-filled score timeline into inference regions at long
     * rests, keeping absolute note starts.
     *
     * Companion of buildVocalSegments() for the streaming multi-fragment
     * path (synthesizeMultiStreaming). Two deliberate differences:
     *
     * 1. NO re-basing: region notes keep their absolute starts within the
     *    source fragment. The streaming mixer places chunk audio at
     *    (fragment.startTimeBeat + firstNoteStartBeat) and indexes the
     *    absolute-time pitchCurveF0 with offset 0 — both assume absolute
     *    starts. Rebased regions made every region mix at the fragment
     *    start, piling all voices onto each other (severe misalignment).
     *
     * 2. NO >SEGMENT_MAX_SEC overlap split: the streaming path chunks long
     *    sequences itself via its diffusion chunkPlan and mixes with plain
     *    addition (no crossfade), so overlapping segments would be
     *    double-mixed. Only the central part of a >= LONG_REST_SEC rest is
     *    removed from inference; up to REST_CONTEXT_SEC of rest context is
     *    kept on both region edges, and regions never overlap in time.
     *
     * @param {Array} notes - gap-filled notes (fillNoteGaps output)
     * @param {number} bpm
     * @returns {Array<{notes, startBeat, endBeat}>} regions; startBeat/endBeat
     *   are the absolute (fragment-relative) bounds, used for cache identity.
     */
    splitLongRestRegions(notes, bpm) {
        if (!notes || notes.length === 0) return [];
        if (!Number.isFinite(bpm) || bpm <= 0) {
            throw new RangeError('bpm must be a positive finite number');
        }
        const secondsPerBeat = 60 / bpm;
        const longRestBeats = LONG_REST_SEC / secondsPerBeat;
        const restContextBeats = REST_CONTEXT_SEC / secondsPerBeat;
        const isRest = (note) => this._isRestNote(note);

        const sorted = [...notes].sort((a, b) => a.start - b.start);
        for (const note of sorted) {
            if (!Number.isFinite(note.start) || !Number.isFinite(note.duration) || note.duration <= 0) {
                throw new RangeError('notes must have finite start and positive duration');
            }
        }

        const hasLongRest = sorted.some(note => isRest(note) && note.duration >= longRestBeats);
        if (!hasLongRest) {
            const end = sorted[sorted.length - 1].start + sorted[sorted.length - 1].duration;
            return [{ notes: sorted, startBeat: 0, endBeat: end }];
        }

        const regions = [];
        let current = [];
        let pendingHeadRest = null;
        const flush = () => {
            if (current.some(n => !isRest(n))) {
                regions.push({
                    notes: current,
                    startBeat: current[0].start,
                    endBeat: current[current.length - 1].start + current[current.length - 1].duration,
                });
            }
            current = [];
        };
        for (const note of sorted) {
            if (isRest(note) && note.duration >= longRestBeats) {
                const pad = Math.min(restContextBeats, note.duration / 3);
                if (pad > 0) current.push({ ...note, duration: pad });
                flush();
                pendingHeadRest = pad > 0
                    ? { ...note, start: note.start + note.duration - pad, duration: pad }
                    : null;
                continue;
            }
            if (pendingHeadRest) {
                current.push(pendingHeadRest);
                pendingHeadRest = null;
            }
            current.push(note);
        }
        flush();
        return regions;
    }
````

### R37 · 人声段切分：20s 阈值 + 8~20s 段 + 2s overlap

文件：`src/inference/pipeline/audioSegmentation.js`　行：`178-336`

````javascript
    /**
     * Build vocal segments for long audio
     */
    buildVocalSegments(notes, bpm) {
        if (!notes || notes.length === 0) return [{ notes, startBeat: 0, endBeat: 0 }];
        if (!Number.isFinite(bpm) || bpm <= 0) {
            throw new RangeError('bpm must be a positive finite number');
        }

        const sorted = [...notes].sort((a, b) => a.start - b.start);
        for (const note of sorted) {
            if (!Number.isFinite(note.start) || !Number.isFinite(note.duration) || note.duration <= 0) {
                throw new RangeError('notes must have finite start and positive duration');
            }
        }

        const secondsPerBeat = 60 / bpm;
        // Conservative scheduling: only gaps >= 1.5 seconds are removed from
        // model input. Keep 150 ms of rest context on both sides so consonant
        // releases and the following attack still see an <SP>-like boundary.
        const longRestBeats = LONG_REST_SEC / secondsPerBeat;
        const restContextBeats = REST_CONTEXT_SEC / secondsPerBeat;
        const isRest = (note) => this._isRestNote(note);

        const timelineEnd = sorted[sorted.length - 1].start + sorted[sorted.length - 1].duration;
        const timelineSec = timelineEnd * secondsPerBeat;
        const hasLongRest = sorted.some(note => isRest(note) && note.duration >= longRestBeats);
        // Preserve the established short-clip path exactly when there is no
        // expensive long rest to remove.
        if (!hasLongRest && timelineSec <= LONG_AUDIO_THRESHOLD_SEC) {
            return [{ notes, startBeat: 0, endBeat: timelineEnd }];
        }

        // Split the score into active inference regions. The central part of a
        // long rest is intentionally absent, so diffusion and Vocos never run
        // for it. Short rests stay in-region as model timing context.
        const regions = [];
        let current = [];
        let pendingHeadRest = null;
        let skippedLongRest = false;
        const flush = () => {
            if (current.some(n => !isRest(n))) regions.push(current);
            current = [];
        };
        for (const note of sorted) {
            if (isRest(note) && note.duration >= longRestBeats) {
                skippedLongRest = true;
                const pad = Math.min(restContextBeats, note.duration / 3);
                if (pad > 0) current.push({ ...note, duration: pad });
                flush();
                pendingHeadRest = pad > 0
                    ? { ...note, start: note.start + note.duration - pad, duration: pad }
                    : null;
                continue;
            }
            if (pendingHeadRest) {
                current.push(pendingHeadRest);
                pendingHeadRest = null;
            }
            current.push(note);
        }
        flush();

        if (regions.length === 0) return [];

        const overlapBeats = (SEGMENT_OVERLAP_SEC / 60) * bpm;
        const minBeats = (SEGMENT_MIN_SEC / 60) * bpm;
        const maxBeats = (SEGMENT_MAX_SEC / 60) * bpm;
        const segments = [];

        const segmentRegion = (regionNotes) => {
            const regionStart = regionNotes[0].start;
            const regionEnd = regionNotes[regionNotes.length - 1].start
                + regionNotes[regionNotes.length - 1].duration;
            const regionSec = (regionEnd - regionStart) * secondsPerBeat;
            if (regionSec <= LONG_AUDIO_THRESHOLD_SEC) {
                const preserveLegacySingle = regions.length === 1 && !skippedLongRest;
                segments.push({
                    notes: preserveLegacySingle
                        ? regionNotes
                        : regionNotes.map(n => ({ ...n, start: n.start - regionStart })),
                    startBeat: preserveLegacySingle ? 0 : regionStart,
                    endBeat: regionEnd,
                });
                return;
            }

            const restBoundaries = [regionStart];
            const noteEndBoundaries = [];
            for (const note of regionNotes) {
                if (isRest(note)) restBoundaries.push(note.start + note.duration / 2);
                else noteEndBoundaries.push(note.start + note.duration);
            }
            restBoundaries.push(regionEnd);
            restBoundaries.sort((a, b) => a - b);
            noteEndBoundaries.sort((a, b) => a - b);

            let segStart = regionStart;
            while (segStart < regionEnd - 0.01) {
                let segEnd = segStart + maxBeats;
                let reachedEnd = false;
                if (segEnd >= regionEnd - 0.01) {
                    segEnd = regionEnd;
                    reachedEnd = true;
                } else {
                    const target = segStart + (maxBeats + minBeats) / 2;
                    const upper = Math.min(regionEnd, segStart + maxBeats + overlapBeats);
                    const pickNearest = (candidates) => {
                        let best = null;
                        let distance = Infinity;
                        for (const boundary of candidates) {
                            if (boundary <= segStart + minBeats) continue;
                            if (boundary >= upper) break;
                            const candidateDistance = Math.abs(boundary - target);
                            if (candidateDistance < distance) {
                                best = boundary;
                                distance = candidateDistance;
                            }
                        }
                        return best;
                    };
                    segEnd = pickNearest(restBoundaries)
                        ?? pickNearest(noteEndBoundaries)
                        ?? segEnd;
                }

                // 单趟循环替代 filter + map 两趟，少一次中间数组分配。
                // 等价性：判定条件逐字相同、遍历顺序同为下标升序、map 保序，
                // 故结果数组逐元素且顺序完全一致（下游依赖数组序，不重排）。
                // noteEnd 提到局部变量只在判定与裁剪中各用一次，数值不变。
                const segNotes = [];
                for (const n of regionNotes) {
                    const noteEnd = n.start + n.duration;
                    if (!(n.start < segEnd && noteEnd > segStart)) continue;
                    const clippedStart = Math.max(n.start, segStart);
                    const clippedEnd = Math.min(noteEnd, segEnd);
                    segNotes.push({
                        ...n,
                        start: clippedStart - segStart,
                        duration: Math.max(0.01, clippedEnd - clippedStart),
                    });
                }
                if (segNotes.some(n => !isRest(n))) {
                    segments.push({ notes: segNotes, startBeat: segStart, endBeat: segEnd });
                }
                if (reachedEnd) break;
                const nextStart = segEnd - overlapBeats;
                if (nextStart <= segStart + 0.01) break;
                segStart = nextStart;
            }
        };

        for (const region of regions) segmentRegion(region);
        const totalSec = (sorted[sorted.length - 1].start + sorted[sorted.length - 1].duration) * secondsPerBeat;
        if (segments.length > 1 || regions.length > 1) {
            console.log(`[OnnxSVSPipeline] Scheduled ${segments.length} inference segments across ${regions.length} active regions (${totalSec.toFixed(1)}s timeline); long rests skipped`);
        }
        return segments;
    }
````

### R38 · 共享维度常量（采样率 / hop / mel / vocoder 分块）

文件：`src/inference/shared/constants.js`　行：`13-29`

````javascript
export const SAMPLE_RATE = 24000;
export const HOP_SIZE = 480;
export const SIFIGAN_HOP_SIZE = 120;
export const MEL_DIM = 128;
export const EMBED_DIM = 512;
export const COND_DIM = 1024;
export const VOCODER_CHUNK_FRAMES = 1024;
export const VOCODER_OVERLAP_FRAMES = 32;

// ===== NPU 静态形状常量 =====
// NPU 静态形状模型固定序列长度（encoder/diffusion 输入维度）
// 用于 optimized_npu 模型，totalFramesWithPrompt 不能超过此值
export const NPU_STATIC_SEQ_LEN = 2048;
// Vocoder NPU 静态形状（独立于 encoder/diffusion 的 seq_len）
// Vocoder ISTFT Conv 的 Pad 中间张量在 seq_len=2048 时超出 WebNN 2GB 限制
export const NPU_VOCODER_SEQ_LEN = 500;

````

### R39 · pipeline 分段/帧上限常量

文件：`src/inference/pipeline/constants.js`　行：`22-33`

````javascript
const F0_MIN = 32.7031956625;
const CFG_STRENGTH = 3.0;
// 官方 flow_matching.py:262 rescale_cfg = 0.75（infer() 未覆盖）。此前 0.7
// 与官方不一致；统一为 0.75。注意 Q-Drift 合约里的 0.7 是量化校正表的标定
// 值，属于另一套参数，不随此默认值改动（见 qdrift/）。
const CFG_RESCALE = 0.75;
const DEFAULT_DIFF_STEPS = 32;
const LONG_AUDIO_THRESHOLD_SEC = 20;
const SEGMENT_MIN_SEC = 8;
const SEGMENT_MAX_SEC = 20;
const SEGMENT_OVERLAP_SEC = 2;
const MAX_SAFE_FRAMES = 40000;
````

## 5. 测试清单（审查时可对照契约）

| 测试文件 | 覆盖点 |
| --- | --- |
| `test/fragmentStreamingPlayback.test.js` | 播放会话：underrun 解冻、起播锚定、停止/取消、重叠与迟到 chunk |
| `test/fragmentStreamProtocol.test.js` | 流协议：streamId/seq 去重、首块乱序、END 屏障、缺口记录、preload/主进程接线 |
| `test/fragmentPlaybackSession.test.js` | 会话生命周期：回执先到、重复 isLast、遮挡节流、合成中 seek、自愈不误判 |
| `test/fragmentPlaybackTimeline.test.js` | 时间轴：前导静音、中段起播、重叠裁头、迟到裁头、顺序拼接、位置公式 |
| `test/multiSegmentStreamEmitter.test.js` | 多 segment 发射器：乱序完成门控、静音补洞、重叠裁剪、末段 isLast 补齐 |
| `test/cachedChunkReplay.test.js` | 整段缓存重放：2s 切块、偏移连续、回调异常终止 |
| `test/streamingSynthesis.test.js` | 多分片流式合成（主窗口路径）的 chunk 选项与时间轴回归 |
| `test/vocoderChunked.test.js` | vocoder 分块边界：单块/多块/无死循环/全样本写入 |
| `test/diffusionChunked.test.js` | 扩散分块：块规划、overlap 钳制、committed 连续性 |
| `test/wsola.test.js` | WSOLA：输出长度、相位连续、偏移对齐 |
| `test/audioSegmentation.test.js` | 分段器：休止填充、长休止切分、非法 BPM |
| `test/zzRendererPlaybackSupersede.test.js` | 主窗口播放：取消/加载中停止/迟到 chunk 不重启播放头 |

## 6. 明确不在本包范围

- `OnnxSVSPipeline.synthesizeMultiStreaming`（主窗口一次播放多个分片的全局时间交错路径）及其 `streamManifest/streamLast` 协议；
- 主窗口 `src/renderer/audioPlayback.js` 的流式播放实现（与分片编辑器共用 `StreamingScheduler`，但排程/混音策略不同）；
- 插件后端（`options.backend.type === "plugin"`）与远程 API 后端的合成实现；本包只保留主进程对它们的短路分支上下文；
- 导出路径（`exportFragment`）的整段合成、WAV 编码与包络应用；
- 音频设备独占模式（decibri 子进程）的内部实现；分片编辑器流式预览始终走 WebAudio。

---

本文件由仓库源码按上述行号原样抽取生成；若仓库在 `6492507` 之后有改动，请以对应版本的源码为准。
