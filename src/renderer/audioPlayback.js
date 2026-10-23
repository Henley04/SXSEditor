import { state, dom, trackManager } from './state.js';
import { SAMPLE_RATE, SVS_HOP_SIZE } from './constants.js';
import { buildMelPostprocessPayload } from '../shared/postprocessCurves.js';
import { t } from '../i18n/index.js';
import { TRANSPORT, getTransportState, setTransport, setTransportProgress, clearTransportStatus } from './transport.js';
import { setLabel } from '../icons/iconHelper.js';
import { showAlertDialog } from '../alertDialog.js';
import { resolveQDriftDefault } from '../inference/pipeline/qdrift/defaults.js';
import { buildFragmentPitchCurveF0 } from './f0Utils.js';
import { formatTime } from './uiControls.js';
import { drawPlayheadLine, drawPausedPlayheadAt, clearPlayheadLine } from './timelineRenderer.js';
import { StreamingScheduler } from '../shared/streamingScheduler.js';
import { registerAccompanimentGain, clearAccompanimentGains } from './accompanimentMixer.js';
// 播放头/时间码必须按"耳朵听到的位置"走，而不是渲染线程的 currentTime
// （输出设备缓冲会让声音晚 20–120 ms 到喇叭 → 指示器稳定跑在声音前面）。
import { getAudibleElapsedSec, getAudibleContextTime } from '../shared/audioOutputClock.js';
import { getSingerBackend, normalizeBackend } from '../editor/trackManager.js';
import { clearPluginBlockingOverlay } from './pluginBlockingOverlay.js';
// 2.4: 渲染进程此前没有统一的异常兜底策略，静默 catch 占全库 44.8%。
// 清理型副作用（disconnect / stop / 退订）统一走 safeCleanup，失败留痕但不打断主流程。
import safeCallModule from '../shared/safeCall.js';

const { safeCleanup, safeCallAsync } = safeCallModule;

// ==================== 插件后端接线 ====================

/**
 * 参与演唱的分片是否全部交由插件后端负责。
 *
 * 全部是插件轨道时不必初始化内置 SVS pipeline —— 用户没下载 SXS 模型、或模型
 * 加载失败，都不该连带挡住插件轨道的播放/导出。一旦混入内置轨道就照旧初始化。
 *
 * @param {Array} allFragments
 * @param {Map<string, object>} singerMap
 * @returns {boolean}
 */
function allFragmentsUsePluginBackend(allFragments, singerMap) {
  if (!allFragments || allFragments.length === 0) return false;
  return allFragments.every((fragment) => {
    const singer = singerMap.get(fragment.singerId);
    return !!singer && getSingerBackend(singer).type === 'plugin';
  });
}

/**
 * 把 singer 的后端声明挂到合成 options 上（options.backend）。
 *
 * 约定见 src/main/svsIpc.js 的 _resolvePluginBackend()：只要 options.backend.type
 * === 'plugin'，主进程就把这一个 options 引用整体交给插件，不再走内置 pipeline。
 *
 * 两条纪律：
 *   · **内置轨道不留痕**：{type:'sxs'} 时压根不写 backend 字段 —— 少一个字段的请求
 *     与本次改动之前逐字节等价，内置链路不会有任何行为差异，也不必担心哪些未知
 *     字段被下游误读。
 *   · **其余参数一个都不许删**：需求要求"给模型传递的参数都要能传递给插件"，主进程
 *     侧的透传已经实现，渲染侧只负责追加 backend，不挑字段、不裁剪。
 *
 * 返回值是同一份 options（就地追加），方便直接嵌进调用点的对象字面量。
 *
 * @param {object} options 合成参数（f0Envelope / pitchCurveF0 / nSteps / …）
 * @param {object} [singer] 该分片所属轨道
 * @returns {object} options 本身
 */
function attachPluginBackend(options, singer) {
  if (!singer || !options) return options;
  // normalizeBackend() 顺带做了一份防御性浅拷贝：主进程把同一个 options 引用交给
  // 插件，插件理论上能改写它，这种改写不能透回 singer.backend（那是工程数据）。
  const backend = normalizeBackend(getSingerBackend(singer));
  if (backend.type === 'plugin') options.backend = backend;
  return options;
}

// ==================== Accompaniment helpers ====================

/**
 * Get all accompaniment tracks that have loaded audio buffers.
 * @returns {Array} Singer objects with type === 'accompaniment' and audioBuffer set
 */
function getAccompanimentTracks() {
  return trackManager.getSingers().filter(s => s.type === 'accompaniment' && (s.audioChannels?.length || s.audioBuffer));
}

/**
 * Calculate the maximum end sample across all accompaniment tracks.
 * @param {number} bpm - Project BPM
 * @returns {number} Maximum end sample position
 */
function getAccompanimentMaxEndSample(bpm) {
  let maxEndSample = 0;
  for (const track of getAccompanimentTracks()) {
    const startSample = Math.round((track.accompanimentStartTime || 0) / bpm * 60 * SAMPLE_RATE);
    const sourceLength = track.audioChannels?.[0]?.length || track.audioBuffer.length;
    const endSample = startSample + Math.ceil(sourceLength * SAMPLE_RATE / (track.audioSampleRate || SAMPLE_RATE));
    if (endSample > maxEndSample) maxEndSample = endSample;
  }
  return maxEndSample;
}

function _interpolateVolumeEnvelope(envelope, beat) {
  const kfs = envelope?.keyframes;
  if (!kfs || kfs.length === 0) return 1;
  if (kfs.length === 1 || beat <= kfs[0].time) return kfs[0].value;
  if (beat >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;
  let lo = 0, hi = kfs.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (kfs[mid].time <= beat) lo = mid; else hi = mid;
  }
  const span = kfs[hi].time - kfs[lo].time;
  const t = span > 0 ? (beat - kfs[lo].time) / span : 0;
  const smoothness = (kfs[lo].smoothness || 0) / 100;
  const smooth = t + ((t * t * (3 - 2 * t)) - t) * smoothness;
  return kfs[lo].value + smooth * (kfs[hi].value - kfs[lo].value);
}

function _applyFragmentVolumeEnvelope(audio, fragment, bpm) {
  const envelope = fragment?.envelopes?.volume;
  if (!envelope?.keyframes?.length) return audio;
  const out = new Float32Array(audio.length);
  const beatInc = bpm / (60 * SAMPLE_RATE);
  let beat = 0;
  for (let i = 0; i < audio.length; i++, beat += beatInc) {
    out[i] = audio[i] * _interpolateVolumeEnvelope(envelope, beat);
  }
  return out;
}

// visibilitychange handler: pause rAF-driven UI updates when tab hidden
// (audio playback continues via WebAudio/WASAPI in background).
// Registered once per module; update fns stored for resume.
let _visibilityHandlerRegistered = false;
let _exclusiveUpdateFn = null;
let _sharedUpdateFn = null;

// 独占模式 onAudioEnded 退订函数的模块级持有。旧实现只在 rAF 闭包内拿到它，
// stop/pause/seek 会先 cancel rAF，导致退订永不执行——每次播放泄漏一个
// IPC 监听器。所有拆除路径都经过 stopExclusivePlayback()，在那里统一退订。
let _exclusiveRemoveEndedListener = null;
function _detachExclusiveEndedListener() {
  if (_exclusiveRemoveEndedListener) {
    safeCleanup('audioPlayback.detachExclusiveEndedListener', _exclusiveRemoveEndedListener);
    _exclusiveRemoveEndedListener = null;
  }
}

function _onVisibilityChange() {
  if (document.hidden) {
    if (state.exclusivePlaybackRaf) {
      cancelAnimationFrame(state.exclusivePlaybackRaf);
      state.exclusivePlaybackRaf = null;
    }
    if (state.playheadRaf) {
      cancelAnimationFrame(state.playheadRaf);
      state.playheadRaf = null;
    }
  } else {
    if (state.isPlaying && state.useExclusiveMode && _exclusiveUpdateFn && !state.exclusivePlaybackRaf) {
      state.exclusivePlaybackRaf = requestAnimationFrame(_exclusiveUpdateFn);
    } else if (state.isPlaying && !state.useExclusiveMode && _sharedUpdateFn && !state.playheadRaf && !(_scheduler && _scheduler.isWaiting)) {
      // 等待推理期间不重启 rAF：underrun 冻结时 playheadRaf 已被取消，
      // 若此处复活循环，其 getAudioContext() 调用会在挂起的 context 上
      // 触发意外 resume，导致伴奏在人声等待缺口中继续播放。
      state.playheadRaf = requestAnimationFrame(_sharedUpdateFn);
    }
  }
}

function _onBeforeUnloadForVisibility() {
  if (_visibilityHandlerRegistered) {
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    _visibilityHandlerRegistered = false;
  }
}

// Streaming playback state (main page Play All with diffStepChunk).
// Shared infrastructure (AudioContext suspend/resume, watchdog, underrun detection,
// source counting) is handled by StreamingScheduler (src/shared/streamingScheduler.js).
// Renderer-specific state:
let _streamingActive = false;
let _streamingFirstChunkOffsetSec = 0;  // First chunk's global position (for coordinate conversion)
let _streamingAccEndSec = 0;            // Furthest accompaniment end in playhead seconds

// 播放会话代数：取消后用户可能立刻再点播放，新会话会把 state.synthesisCancelled
// 重置为 false。只靠那个布尔量，旧会话的检查点会误判成"没被取消"而继续跑。
// 每次 playAll 自增，旧会话发现自己不是最新一代就直接退出。
let _playGeneration = 0;

// ==================== 伴奏实时控制 ====================
// 伴奏此前被 _buildPlaybackChannels() 预混进人声缓冲，音量在混音那一刻就固化了，
// 于是拖动音量滑块必须重新合成/重新播放才听得到变化（DAW 里这是即时生效的）。
//
// 现在播放路径不再预混伴奏，而是给每轨建独立的 BufferSource → GainNode，
// 并在这里保留 GainNode 引用：滑块 input 时直接 setTargetAtTime 改增益，
// 无需重启播放。导出路径仍然预混（离线渲染没有实时性要求）。
const _accSources = new Set(); // 播放期伴奏 source，停止时统一清理

function _clearAccompanimentNodes() {
  for (const src of _accSources) {
    safeCleanup('audioPlayback.accSrc.stop', () => { src.onended = null; src.stop(); });
  }
  _accSources.clear();
  clearAccompanimentGains();
}

/**
 * 播放期调度所有伴奏轨（独立 source，便于实时调音量）。
 *
 * @param {AudioContext} ctx
 * @param {AudioNode} destination 通常是 state.gainNode
 * @param {number} baseCtxTime "offsetSec 那一刻"对应的 ctx.currentTime
 * @param {number} offsetSec 从时间轴的哪一秒开始播放
 * @param {number} maxDurationSec 最多播放多久（与人声长度对齐，避免人声结束后伴奏孤零零继续）
 */
function _scheduleAccompaniment(ctx, destination, baseCtxTime, offsetSec, maxDurationSec) {
  _clearAccompanimentNodes();
  const bpm = state.project.bpm;
  for (const track of getAccompanimentTracks()) {
    const chans = track.audioChannels?.length ? track.audioChannels : (track.audioBuffer ? [track.audioBuffer] : []);
    if (!chans.length || !chans[0]?.length) continue;

    const buf = ctx.createBuffer(chans.length, chans[0].length, track.audioSampleRate || SAMPLE_RATE);
    for (let ch = 0; ch < chans.length; ch++) buf.getChannelData(ch).set(chans[ch]);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = Number.isFinite(track.accompanimentVolume) ? track.accompanimentVolume : 1;
    src.connect(gain).connect(destination);

    const accStartSec = (track.accompanimentStartTime || 0) / bpm * 60;

    // 时间轴 → ctx 时间的映射：时间轴 T 对应 baseCtxTime + (T - offsetSec)。
    // 于是伴奏内容位置 0（时间轴 accStartSec）应对应的 ctx 时刻是：
    const contentZeroAt = baseCtxTime + (accStartSec - offsetSec);

    // 若该时刻已过（暂停后从中间恢复、或拖拽播放头到伴奏已开始之后），
    // 应从伴奏内容的"已经过去多久"处开始播。
    //
    // 注意：这里**只能有一个来源**。此前写成
    //   bufOffset = max(0, offsetSec - accStartSec); bufOffset += safeNow - when;
    // 而 safeNow - when ≈ offsetSec - accStartSec，等于把同一段延迟算了两遍，
    // 表现为"暂停一次后伴奏跳过与已播时长等长的一段，并永久领先播放头"。
    const safeNow = ctx.currentTime + 0.005;
    const startAt = contentZeroAt > safeNow ? contentZeroAt : safeNow;
    const bufOffset = Math.max(0, startAt - contentZeroAt);
    if (bufOffset >= buf.duration) continue;

    // 剩余可播时长：maxDurationSec 是"从 offsetSec 起还能播多久"，
    // 晚启动了 (startAt - baseCtxTime) 秒，就要从这份预算里扣掉。
    let playDur = buf.duration - bufOffset;
    if (Number.isFinite(maxDurationSec) && maxDurationSec > 0) {
      const remaining = maxDurationSec - Math.max(0, startAt - baseCtxTime);
      if (remaining <= 0) continue;
      playDur = Math.min(playDur, remaining);
    }
    if (playDur <= 0) continue;

    src.start(startAt, bufOffset, playDur);

    registerAccompanimentGain(track.id, gain);
    _accSources.add(src);
    src.onended = () => { _accSources.delete(src); };
  }
}
// Per-stream delivered end (streamKey -> {end, done}). Multi-stream playback
// (interleaved fragments / long-rest-split regions) paces the playhead by the
// MINIMUM delivered end across active streams: the clock must never run past
// a stream's undelivered range, or that stream's chunks arrive "late" and
// force shifted playback (overlap/drift) or head-trimming (content loss).
let _streamingStreamEnds = new Map();

let _scheduler = null;

function _createScheduler() {
  _scheduler = new StreamingScheduler({
    getCtx: () => state.audioContext,
    getElapsed: () => {
      const ctx = state.audioContext;
      return ctx ? ctx.currentTime - state.playbackStartTime : 0;
    },
    // 统一的等待进入钩子（rAF / watchdog / chunk 迟到竞态三条路径共用）。
    // watchdog 路径原本没有 onEnterWait，进入等待时 rAF 循环不会被取消，
    // 恢复时 startPlayheadAnimation 会叠加启动第二个循环（重复绘制 +
    // stopPlayheadAnimation 只能取消其中一个的泄漏）。
    onWaitStateChange: (waiting) => {
      if (!waiting) return;
      if (state.playheadRaf) {
        cancelAnimationFrame(state.playheadRaf);
        state.playheadRaf = null;
      }
      dom.timeDisplay.textContent = t('main.waitingForInference');
      setTransportProgress(t('main.waitingForInference'), null);
      // watchdog 带 0.3s 提前量时冻结点在 buffer 前沿之前，
      // 播放头画在当前（即将冻结的）位置而非前沿，避免恢复后回跳。
      const waitCtx = state.audioContext;
      const waitElapsed = waitCtx
        ? Math.max(0, getAudibleContextTime(waitCtx) - state.playbackStartTime)
        : 0;
      drawPlayheadLine(waitElapsed);
    },
    // watchdog 兜底检测带 0.3s 提前量（>= 250ms tick 周期 + suspend 延迟），
    // 使冻结发生在 buffer 前沿之前：恢复时晚到 chunk 的原始调度时间仍在
    // 未来，按原位置无缝衔接，不产生错位/重叠（chunk 到达时若仍过冲，
    // 由调度处的 lateSec 裁头逻辑兜底）。
    watchdogMarginSec: 0.3,
    // 多流 pacing：前沿取各活跃流已交付末端的最小值（见 _streamingStreamEnds）。
    getPacingFrontier: () => {
      let minEnd = Infinity;
      for (const s of _streamingStreamEnds.values()) {
        if (!s.done && s.end < minEnd) minEnd = s.end;
      }
      return minEnd;
    },
    onFinish: _finishStreamingPlayback,
  });
}

/**
 * 检测流式播放 buffer underrun：当 playhead 到达已收到音频的最远位置
 * （buffer 前沿）且推理尚未完成时，进入"等待推理"状态。
 * 冻结共享 AudioContext（暂停所有 source 与伴奏，避免伴奏跑过人声缺口），
 * 取消 playhead rAF（后续由下一 chunk 回调或 watchdog 恢复）。
 * 返回 true 表示已进入等待状态，调用方需在本次循环中返回停止。
 */
function _enterStreamingWaitIfUnderrun(ctx, elapsed) {
  if (!_streamingActive || !_scheduler) return false;
  return _scheduler.checkUnderrun(elapsed, () => {
    if (state.playheadRaf) {
      cancelAnimationFrame(state.playheadRaf);
      state.playheadRaf = null;
    }
    dom.timeDisplay.textContent = t('main.waitingForInference');
    drawPlayheadLine(_scheduler.bufferEndSec);
    setTransportProgress(t('main.waitingForInference'), null);
  });
}

// 流式播放自然完成：所有已调度 source（人声 chunk + 伴奏）均已结束。
// 提取为独立函数供人声 chunk 与伴奏 source 的 onended 共用，避免重复逻辑。
function _finishStreamingPlayback() {
  state.streamingFinished = true;
  state.isPlaying = false;
  // 流式路径不经过 stopAudioSource，需在这里清掉伴奏增益表，
  // 否则暂停/播完后 _gains 里仍是已停止的节点（滑块拖了"有值但无声"）。
  clearAccompanimentGains();
  state.playbackPauseOffset = 0;
  state.streamingSources = [];
  _streamingActive = false;
  if (_scheduler) _scheduler.deactivate();
  stopPlayheadAnimation();
  dom.timeDisplay.textContent = formatTime(0);
  clearPlayheadLine();
  setTransport(TRANSPORT.IDLE);
}

function _ensureVisibilityHandler() {
  if (_visibilityHandlerRegistered) return;
  _visibilityHandlerRegistered = true;
  document.addEventListener('visibilitychange', _onVisibilityChange);
  window.addEventListener('beforeunload', _onBeforeUnloadForVisibility, { once: true });
}

export async function ensurePipelineInitialized() {
  if (state.pipelineInitialized) return;
  if (state.pipelineInitPromise) {
    await state.pipelineInitPromise;
    return;
  }

  // 首次初始化要把 9 个 ONNX 模型读进显存，冷启动时可达数秒。此前这一步完全
  // 没有反馈：用户点了播放，界面只显示"合成中 0%"直到模型加载完才开始推理。
  // 现在把它作为独立阶段暴露出来，并带百分比 + ETA。
  let loadCleanup = null;
  let sawLoadProgress = false;
  try {
    loadCleanup = window.electronAPI.onSVSLoadProgress?.((p) => {
      sawLoadProgress = true;
      setTransportProgress(t('main.loadingModels'), p && p.percent);
    });
  } catch (_) {}
  setTransport(TRANSPORT.LOADING);
  setTransportProgress(t('main.loadingModels'), 0);

  // 兜底：WinML worker 路径与 WebNN 路径目前不上报细粒度进度，如果 1.5s 内
  // 没有任何样本，就退化成"不确定进度"（只显示阶段名），而不是让用户盯着
  // 一个永远停在 0% 的数字。
  const stallTimer = setTimeout(() => {
    if (!sawLoadProgress) setTransportProgress(t('main.loadingModels'), NaN);
  }, 1500);

  state.pipelineInitPromise = window.electronAPI.initSVSPipeline();
  try {
    await state.pipelineInitPromise;
    state.pipelineInitialized = true;
  } catch (err) {
    state.pipelineInitPromise = null;
    throw err;
  } finally {
    clearTimeout(stallTimer);
    if (loadCleanup) safeCleanup('audioPlayback.loadProgressCleanup', loadCleanup);
    // 只有在仍处于 LOADING 时才恢复：若用户在加载期间点了取消/停止，
    // stopPlayback 已经把状态改成 IDLE，这里不能把它拽回去。
    if (getTransportState() === TRANSPORT.LOADING) {
      setTransport(state.isSynthesizing ? TRANSPORT.SYNTHESIZING : TRANSPORT.IDLE);
    }
    clearTransportStatus();
  }
}

/**
 * 放弃当前这一轮合成会话，为"从新位置重来"让路。
 *
 * 与 stopPlayback() 的三点区别（都是必须的）：
 *   1. **不动 playbackPauseOffset** —— 用户刚拖到/暂停的位置就是新一轮的起点，
 *      stopPlayback 会把它清成 0，于是"按 Play 从头重播"（seek 位置被吞）；
 *   2. 不打回 IDLE —— 调用方（playAll）紧接着就会接上新一轮合成；
 *   3. 清空 currentAudioData/Channels/Buffer —— 旧音频与新一轮的输入不一致，
 *      留着会被 btnPlay 的"有缓存就续播"分支当成可播音频。
 *
 * 必须真的去取消主进程的推理：不取消的话，新请求排在 _withSynthMutex 的队列
 * 后面，要等旧任务自己跑完（长工程可能几十秒），用户看到的仍然是"按了没反应"。
 * 取消是协作式的（安全点退出，worker 保持存活），见 svsWorkerClient。
 */
function _abandonActiveSession() {
  // LOADING（模型加载）阶段不能发 cancel：主进程侧会落到"无活跃任务 →
  // resetSvsPipeline()"的分支，把正在初始化的 lazy 实例作废，下次播放要重头加载。
  if (state.pipelineInitialized && window.electronAPI?.cancelSVSSynthesis) {
    window.electronAPI.cancelSVSSynthesis().catch(() => {});
  }
  state.synthesisCancelled = true;
  state.streamingFinished = true;
  _streamingActive = false;
  for (const src of state.streamingSources) {
    if (!src) continue;
    safeCleanup('audioPlayback.src.stop', () => { src.onended = null; src.stop(); });
  }
  state.streamingSources = [];
  if (_scheduler) _scheduler.deactivate();
  // stopAudioSource 一并停掉伴奏 source 与播放头 rAF
  stopAudioSource();
  state.isPlaying = false;
  state.currentAudioData = null;
  state.currentAudioChannels = null;
  state.currentAudioBuffer = null;
}

export async function playAll() {
  // 已有一轮推理在跑时，用户按 Play 的语义是"现在就从当前起点播"，不是"忽略我"。
  // 旧实现直接 `if (state.isSynthesizing) return;` —— 而流式播放中被拖拽暂停后
  // 传输条已经是 PAUSED（Play 可点、文案是"播放"），点下去却什么都不发生，
  // 用户只能拿 Stop/取消推理把它杀掉重来（而那条路会把起点清成 0）。
  if (state.isSynthesizing) {
    // 模型加载中（LOADING）不能中断：取消会让主进程作废正在初始化的实例。
    if (getTransportState() === TRANSPORT.LOADING) return;
    _abandonActiveSession();
  }
  // 重入保护：防止连续调用导致前一次 finally 提前把 isSynthesizing 置 false，
  // 使后续进度回调失效（进度百分比偶发不显示的根因之一）。
  state.isSynthesizing = true;
  state.synthesisCancelled = false;
  const myGeneration = ++_playGeneration;
  // 进度不再占用 Play 按钮（那会让按钮在"播放/合成中/取消"三种语义间跳变），
  // 改为在按钮右侧的进度区显示；Play 在此期间保持可点 = 取消推理。
  setTransport(TRANSPORT.SYNTHESIZING);
  setTransportProgress(t('main.synthesizingShort'), 0);

  // 取消检查点：state.synthesisCancelled 此前只被写、从不被读，导致点了取消
  // 之后推理继续跑、最后照样开始播放（声音自己响起来）。下面在每段长 await
  // 之后检查一次，保证取消能在若干个 yield 点内生效。
  const throwIfCancelled = () => {
    // 代际不一致 = 已有更新的播放会话接管，本次必须退出
    if (!state.synthesisCancelled && myGeneration === _playGeneration) return;
    const err = new Error('Synthesis cancelled');
    err.code = 'CANCELLED';
    throw err;
  };

  // 注册推理进度监听：更新右侧进度区的百分比与 ETA
  let playProgressCleanup = null;
  try {
    playProgressCleanup = window.electronAPI.onSVSProgress((progress) => {
      if (state.isSynthesizing) setTransportProgress(t('main.synthesizingShort'), progress);
    });
  } catch (_) {}

  try {
    await loadAudioSettings();
    throwIfCancelled();

    const fragments = trackManager.getFragments();
    const singers = trackManager.getSingers();
    const singerMap = new Map();
    singers.forEach(s => singerMap.set(s.id, s));

    // 收集所有有 notes 的 fragments，按 startTime 排序后逐个合成。
    // 排除伴奏轨道的分片（伴奏轨道不应有分片，但防御性过滤）。
    const allFragments = fragments
      .filter(f => f.notes && f.notes.length > 0 && singerMap.get(f.singerId)?.type !== 'accompaniment')
      .sort((a, b) => a.startTime - b.startTime);

    const accTracks = getAccompanimentTracks();

    if (allFragments.length === 0 && accTracks.length === 0) {
      showAlertDialog(t('main.noFragmentsToPlay'));
      return;
    }

    // 仅有伴奏轨道无分片音符：直接播放伴奏，跳过推理。
    // 传零"人声"底噪给 _buildPlaybackChannels，由它唯一负责混音
    // （含重采样、声道映射、accompanimentVolume）。旧实现先用
    // mixAccompanimentIntoArray 混一次（无重采样/无增益），随后
    // _buildPlaybackChannels 又混一次，导致伴奏 +6dB 发虚。
    if (allFragments.length === 0 && accTracks.length > 0) {
      const accMaxSamples = getAccompanimentMaxEndSample(state.project.bpm);
      const silentVocal = new Float32Array(accMaxSamples);
      state.currentAudioData = silentVocal;
      state.currentAudioChannels = _buildPlaybackChannels(silentVocal, state.project.bpm, false);
      state.currentAudioBuffer = null;
      dom.timeDisplay.textContent = formatTime(state.playbackPauseOffset);
      if (state.playbackPauseOffset > 0) {
        drawPausedPlayheadAt(state.playbackPauseOffset);
      }
      await startAudioPlayback(state.playbackPauseOffset);
      return;
    }

    let globalFirstStart = Infinity;
    let globalLastEnd = 0;
    for (const f of allFragments) {
      if (f.startTime < globalFirstStart) globalFirstStart = f.startTime;
      const fragEnd = f.startTime + f.duration;
      if (fragEnd > globalLastEnd) globalLastEnd = fragEnd;
    }

    // 全插件工程：跳过内置 pipeline 初始化（没下载 SXS 模型也能唱）。
    if (!allFragmentsUsePluginBackend(allFragments, singerMap)) {
      await ensurePipelineInitialized();
    }

    const inferenceOpts = getPreviewInferenceOptions();

    if (inferenceOpts.diffStepChunk) {
      // === 流式合成路径 ===
      // 启用分块时使用 synthesizeMultiStreaming：按全局时间顺序交错推理各分片的 chunk，
      // 边推理边推送音频，实现多分片时间交错流式播放。
      // 示例：T1chunk1 → T2chunk1 → T1chunk2 → T2chunk2
      const multiFragments = [];
      for (const fragment of allFragments) {
        const singer = singerMap.get(fragment.singerId);
        if (!singer) continue;
        const fragDuration = fragment.duration;
        const clippedNotes = [];
        for (const note of fragment.notes) {
          if (note.start >= fragDuration) continue;
          const noteEnd = note.start + note.duration;
          if (noteEnd > fragDuration) {
            clippedNotes.push({ ...note, duration: fragDuration - note.start });
          } else {
            clippedNotes.push(note);
          }
        }
        if (clippedNotes.length === 0) continue;
        const pitchCurveF0 = buildFragmentPitchCurveF0(fragment, clippedNotes, state.project.bpm);
        multiFragments.push({
          notes: clippedNotes,
          startTimeBeat: fragment.startTime,
          durationBeats: fragment.duration,
          // synthesizeMultiStreaming 是**逐分片**路由的（每个分片单独交给插件合成
          // 后按 startTimeBeat 混音），因此必须逐个分片带上自己轨道的 backend，
          // 不能整批沿用第一个分片的。混合多后端会被引擎拒绝，属预期行为。
          options: attachPluginBackend({
            f0Envelope: null,
            pitchCurveF0,
            refAudioWavBuffer: singer?.wavBuffer || null,
            refMidiNotes: singer?.midiNotes || null,
            refF0Data: singer?.f0Data || null,
            singerId: singer?.id || null,
            autoShift: dom.autoShiftCheck.checked,
            nSteps: inferenceOpts.nSteps,
            cfg: inferenceOpts.cfg,
            cfgRescale: inferenceOpts.cfgRescale,
            diffStepChunk: true,
            diffStepChunkFrames: inferenceOpts.diffStepChunkFrames,
            diffStepOverlapFrames: inferenceOpts.diffStepOverlapFrames,
            cfgScheduleMode: inferenceOpts.cfgScheduleMode,
            cfgStrengthStart: inferenceOpts.cfgStrengthStart,
            cfgScheduleKeyframes: inferenceOpts.cfgScheduleKeyframes,
            dynamicThresholdEnabled: inferenceOpts.dynamicThresholdEnabled,
            dynamicThresholdPercentile: inferenceOpts.dynamicThresholdPercentile,
            // 频谱后处理（音色 → 频谱曲线）：随该 fragment 的 postprocess 下发，
            // 主窗口播放/导出与分片编辑器听感一致（未启用时为 null，零开销）。
            melPostprocess: buildMelPostprocessPayload(
              fragment.postprocess || null,
              clippedNotes,
              state.project.bpm,
              SAMPLE_RATE,
              SVS_HOP_SIZE,
            ),
          }, singer),
        });
      }

      if (multiFragments.length === 0) {
        showAlertDialog(t('main.noFragmentsToPlay'));
        return;
      }

      // 流式播放状态：仅在 playbackPauseOffset === 0 时启用流式播放。
      // 若用户已拖拽 playhead 设置了起始位置，则等合成完成后从该位置整段播放。
      const canStreamPlayback = state.playbackPauseOffset === 0;
      let streamingChunkCleanup = null;
      let streamingStarted = false;
      state.streamingSources = [];
      state.streamingFinished = false;

      // 重置 streaming scheduler 状态
      _streamingActive = false;
      _streamingFirstChunkOffsetSec = 0;
      _streamingAccEndSec = 0;
      _streamingStreamEnds = new Map();
      _createScheduler();

      if (canStreamPlayback) {
        _streamingActive = true;
        // 启动后台 watchdog：窗口最小化时 rAF 挂起，需用定时器兜底
        // 检测 buffer underrun，保证等待推理在后台同样生效。
        _scheduler.activate();
        streamingChunkCleanup = window.electronAPI.onSVSChunkAudio(async (chunkInfo) => {
          try {
            if (!chunkInfo || !chunkInfo.audio || chunkInfo.audio.length === 0) return;
            if (state.streamingFinished) return;

            const ctx = getAudioContext();
            const audioBuffer = ctx.createBuffer(1, chunkInfo.audio.length, SAMPLE_RATE);
            audioBuffer.getChannelData(0).set(chunkInfo.audio);
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(state.gainNode);

            const chunkStartSec = chunkInfo.sampleOffset / SAMPLE_RATE;
            const chunkEndSec = chunkInfo.sampleEnd / SAMPLE_RATE;

            // 更新该流的已交付末端（pacing 前沿 = 各活跃流的 min，见 _createScheduler）。
            // streamKey/streamLast/streamManifest 由主进程随 chunk 下发；旧版主进程
            // 无此字段时全部落在 'default' 流上，等价于旧的 max-end 前沿行为。
            if (Array.isArray(chunkInfo.streamManifest)) {
              for (const m of chunkInfo.streamManifest) {
                if (m && m.key != null && !_streamingStreamEnds.has(String(m.key))) {
                  // 未开始交付的流：把 pacing 前沿钉在其首 chunk 起点之前，
                  // 保证它的首 chunk 到达时永远"准时"（不裁头、不移位）。
                  _streamingStreamEnds.set(String(m.key), {
                    end: (m.firstStartSample || 0) / SAMPLE_RATE,
                    done: false,
                  });
                }
              }
            }
            const streamKey = chunkInfo.streamKey != null ? String(chunkInfo.streamKey) : 'default';
            let streamState = _streamingStreamEnds.get(streamKey);
            if (!streamState) {
              streamState = { end: chunkStartSec, done: false };
              _streamingStreamEnds.set(streamKey, streamState);
            }
            if (chunkEndSec > streamState.end) streamState.end = chunkEndSec;
            if (chunkInfo.streamLast) streamState.done = true;
            // 所有计算使用全局秒（项目时间线上的绝对位置）：
            // playhead 在 drawPlayheadLine 中也以全局秒绘制，与 MIDI note 的
            // global beat 位置对齐。pipeline 已将 chunk 的 sampleOffset 调整为
            // fragStartSample + firstNoteOffsetSample + segSampleOffset + ...，
            // 即首 chunk 的全局位置就是首音符的全局位置，playhead 直接从该位置开始。

            // 第一个 chunk：初始化时间基准。
            // playbackStartTime = startCtxTime + 0.05 - chunkStartSec，使得首 chunk
            // 在 startCtxTime+0.05 发声时，elapsed = chunkStartSec，playhead 跳到
            // 首音符的全局位置（而非 0），与 MIDI note 对齐。
            if (!streamingStarted) {
              streamingStarted = true;
              _streamingFirstChunkOffsetSec = chunkStartSec;
              state.playbackStartTime = ctx.currentTime + 0.05;
              state.playbackPauseOffset = 0;
              state.isPlaying = true;
              setTransport(TRANSPORT.PLAYING);
              clearTransportStatus();
              startPlayheadAnimation();

              // Schedule accompaniment tracks as independent BufferSources
              // alongside the streaming vocal chunks. They connect to the same
              // gainNode and are cleaned up via state.streamingSources.
              // 伴奏也计入活跃 source 计数与播放前沿：完成判定需等待伴奏结束，
              // 避免伴奏长于人声时人声一结束就提前终止播放并孤立伴奏 source，
              // 导致伴奏无法被暂停/停止。
              for (const accTrack of accTracks) {
                const accChannels = accTrack.audioChannels?.length ? accTrack.audioChannels : [accTrack.audioBuffer];
                const accBuffer = ctx.createBuffer(accChannels.length, accChannels[0].length, accTrack.audioSampleRate || SAMPLE_RATE);
                for (let ch = 0; ch < accChannels.length; ch++) accBuffer.getChannelData(ch).set(accChannels[ch]);
                const accSource = ctx.createBufferSource();
                accSource.buffer = accBuffer;
                const accGain = ctx.createGain();
                accGain.gain.value = Number.isFinite(accTrack.accompanimentVolume) ? accTrack.accompanimentVolume : 1;
                accSource.connect(accGain).connect(state.gainNode);
                // 登记给音量滑块：流式路径同样支持播放中实时调音量
                registerAccompanimentGain(accTrack.id, accGain);
                const accStartSec = (accTrack.accompanimentStartTime || 0) / state.project.bpm * 60;
                const accScheduleTime = state.playbackStartTime + accStartSec;
                const safeNow = ctx.currentTime + 0.01;
                if (accScheduleTime < safeNow) {
                  // The first MIDI chunk may begin after timeline zero. Start the
                  // accompaniment at the matching offset, not from its head.
                  const offset = Math.max(0, safeNow - accScheduleTime);
                  if (offset >= accBuffer.duration) continue;
                  accSource.start(safeNow, offset);
                } else {
                  accSource.start(accScheduleTime);
                }
                const accEndSec = accStartSec + accBuffer.duration;
                if (accEndSec > _streamingAccEndSec) _streamingAccEndSec = accEndSec;
                _scheduler.addSource();
                const accSourceIdx = state.streamingSources.length;
                state.streamingSources.push(accSource);
                accSource.onended = () => {
                  _scheduler.sourceEnded();
                  if (state.streamingSources[accSourceIdx] === accSource) {
                    state.streamingSources[accSourceIdx] = null;
                  }
                };
              }
            }

            // 更新 buffer 前沿（已收到音频的最远全局位置）
            if (chunkEndSec > _scheduler.bufferEndSec) {
              _scheduler.bufferEndSec = chunkEndSec;
            }

            // 检测 chunk 是否到达过晚（调度时间已过去）。
            // 这可能发生在 rAF underrun 检测尚未触发的竞态条件下。
            // 若到达过晚且推理未完成，进入等待状态，由下方恢复逻辑重新调度。
            const prelimScheduleTime = state.playbackStartTime + chunkStartSec;
            const minTime = ctx.currentTime + 0.01;
            if (prelimScheduleTime < minTime && !_scheduler.inferenceDone && !_scheduler.isWaiting) {
              // 进入等待状态：scheduler 内部 suspend AudioContext
              _scheduler.checkUnderrun(Infinity, () => {
                if (state.playheadRaf) {
                  cancelAnimationFrame(state.playheadRaf);
                  state.playheadRaf = null;
                }
                setTransportProgress(t('main.waitingForInference'), null);
              });
            }

            // 如果正在等待推理，恢复播放。AudioContext.currentTime 在 suspend
            // 期间与所有 source 一起冻结，因此 playbackStartTime 仍是有效的
            // 共享时钟基准（伴奏、先前 chunk、播放头都按它继续走）。
            if (_scheduler.isWaiting) {
              await _scheduler.resumeFromWait();
              // 恢复后必须清掉"等待推理…"，否则它会一直挂在右侧直到停止播放
              // （setTransport(PLAYING) 在状态未变化时不会动进度区）。
              clearTransportStatus();
              startPlayheadAnimation();
            }

            // 调度 chunk：在其全局位置发声。
            // scheduleTime = playbackStartTime + chunkStartSec
            // 这样多分片同时段的 chunk 会叠加播放（而非顺序播放）。
            //
            // Underrun 恢复后 chunk 的原始调度时间可能已经过去（冻结点落在
            // buffer 前沿之后）。此时不能只把开播时间钳到"现在"——那会让人声
            // 整体晚于共享时钟 δ 秒，而后续 chunk 仍按原始时间轴位置调度，
            // 与晚到 chunk 的尾部重叠 δ 秒（"等待推理后人声错位+重叠"的根因）。
            // 正确做法：钳到当前时间的同时，按迟到量 δ 裁掉 chunk 头部内容
            // （source.start(when, offset) 的 offset），使内容位置始终等于
            // 共享时钟位置（与伴奏/播放头/先前 chunk 严格对齐），且 chunk
            // 仍在原定结束时刻结束——与后续 chunk 无缝衔接、零重叠。
            const chunkStartCtxTime = state.playbackStartTime + chunkStartSec;
            const startCtxTime = Math.max(chunkStartCtxTime, ctx.currentTime + 0.01);
            const lateSec = Math.max(0, startCtxTime - chunkStartCtxTime);
            const chunkDurSec = audioBuffer.duration;
            if (lateSec >= chunkDurSec) {
              // 整个 chunk 已过期：内容无可播部分，丢弃（buffer 前沿已覆盖
              // 其范围；播放头会经过一小段静音，直到下一个 chunk）。
              safeCleanup('audioPlayback.source.disconnect', () => source.disconnect());
              if (chunkInfo.isLast) {
                _scheduler.markLastReceived();
              }
            } else {
              source.start(startCtxTime, lateSec);

              // 统一的 onended：递减活跃 source 计数，释放引用，
              // 当 isLast 已收到且所有 source 均结束时标记流式完成。
              // 这比仅依赖 isLast chunk 的 onended 更健壮——
              // 若非末 chunk 因音频更长而晚于 isLast chunk 结束，也能正确等待。
              _scheduler.addSource();
              if (chunkInfo.isLast) {
                _scheduler.markLastReceived();
              }

              const sourceIdx = state.streamingSources.length;
              state.streamingSources.push(source);
              source.onended = () => {
                _scheduler.sourceEnded();
                if (state.streamingSources[sourceIdx] === source) {
                  state.streamingSources[sourceIdx] = null;
                }
              };
            }
          } catch (e) {
            console.warn('[Audio] Streaming chunk playback failed:', e.message);
          }
        });
      }

      try {
        const mixedAudio = await window.electronAPI.synthesizeMultiStreaming({
          fragments: multiFragments,
          bpm: state.project.bpm,
        });

        // 被新一轮播放取代的旧会话：推理可能刚好跑完（取消没赶上），这时绝不能
        // 覆盖共享状态 —— currentAudioData / 时间基准都属于新会话。
        throwIfCancelled();

        // The main process may replay a cached stream much faster than realtime.
        // Let queued svs:chunk-audio IPC messages run before removing the listener.
        await new Promise(resolve => setTimeout(resolve, 0));
        // 合成完成：移除 chunk 监听器
        if (streamingChunkCleanup) { safeCleanup('audioPlayback.streamingChunkCleanup', streamingChunkCleanup); streamingChunkCleanup = null; }

        state.currentAudioData = mixedAudio;
        // Always rebuild the complete playback mix. On cache-fast replays the IPC
        // result can arrive before all chunk events are rendered; this provides a
        // correct accompaniment-inclusive fallback and fixes silent accompaniment
        // on the second play.
        state.currentAudioChannels = _buildPlaybackChannels(mixedAudio, state.project.bpm, false);
        state.currentAudioBuffer = null; // 流式播放无整段 buffer，置空避免 playhead 动画误判

        // 标记推理完成：后续不再触发 buffer underrun 等待
        await _scheduler.setInferenceDone();

        // 若合成返回时正在等待推理（最后一批 chunk 已收到但 playhead 仍冻结），
        // 恢复播放：只需重启 rAF 即可。不重置 playbackStartTime——
        // underrun 冻结只取消了 rAF，未改变 playbackStartTime（recovery 1 已在
        // chunk 到达时设为正确值）。重置 playbackStartTime 会使 elapsed 跳到
        // buffer 末尾，与仍在播放的 source 时间基准脱节，导致 playhead 越过
        // 正在播放的音频提前结束或进入静音区。
        if (streamingStarted) {
          // setInferenceDone already called resumeFromWait if waiting
          startPlayheadAnimation();
        }

        if (!streamingStarted) {
          // 流式未启动（offset > 0 或无 chunk 到达）：回退到整段播放。
          // 必须复位 _streamingActive：否则 startPlayheadAnimation 的流式兜底块
          // 仍会生效（_scheduler.inferenceDone 已为真、前沿为 0），播放头会在
          // 0.5s 后被误判为“已播完”而停止，音频却仍在出声。
          _streamingActive = false;
          dom.timeDisplay.textContent = formatTime(state.playbackPauseOffset);
          if (state.playbackPauseOffset > 0) {
            drawPausedPlayheadAt(state.playbackPauseOffset);
          }
          await startAudioPlayback(state.playbackPauseOffset);
        } else if (!_streamingActive) {
          // 流式播放已结束（所有 chunk 已播完）
          dom.timeDisplay.textContent = formatTime(0);
        }
        // 否则流式播放仍在进行，playhead 动画已在运行，不重置 timeDisplay
      } catch (error) {
        if (streamingChunkCleanup) { safeCleanup('audioPlayback.streamingChunkCleanup', streamingChunkCleanup); streamingChunkCleanup = null; }
        // 只有"最新一代"才能清理共享的流式状态：被取代的旧会话如果在这里停掉
        // streamingSources / 停用 _scheduler，会把新一轮刚排好的 chunk 一起杀掉
        // （表现为新一轮播放刚开个头就静音）。
        if (myGeneration === _playGeneration) {
          // 停止已调度的流式 source
          state.streamingFinished = true;
          _streamingActive = false;
          if (_scheduler) _scheduler.deactivate();
          for (const src of state.streamingSources) {
            if (!src) continue;
            safeCleanup('audioPlayback.src.stop', () => { src.onended = null; src.stop(); });
          }
          state.streamingSources = [];
        }
        throw error;
      }
    } else {
      // === 顺序合成路径（未启用分块） ===
      const totalSeconds = ((globalLastEnd - globalFirstStart) / state.project.bpm) * 60;
      const totalFrags = allFragments.length;
      let completedFrags = 0;

      const audioResults = [];

      for (const fragment of allFragments) {
        const singer = singerMap.get(fragment.singerId);
        if (!singer) { completedFrags++; continue; }

        // clippedNotes：相对 fragment 的 notes，截断到 fragment.duration（与分片编辑器 getClippedNotes 一致）
        const fragDuration = fragment.duration;
        const clippedNotes = [];
        for (const note of fragment.notes) {
          if (note.start >= fragDuration) continue;
          const noteEnd = note.start + note.duration;
          if (noteEnd > fragDuration) {
            clippedNotes.push({ ...note, duration: fragDuration - note.start });
          } else {
            clippedNotes.push(note);
          }
        }
        if (clippedNotes.length === 0) { completedFrags++; continue; }

        // 该 fragment 的 pitchCurveF0（与分片编辑器 buildPitchCurveF0Data 等价）
        const pitchCurveF0 = buildFragmentPitchCurveF0(fragment, clippedNotes, state.project.bpm);

        const audioData = await window.electronAPI.synthesizeSVS({
          notes: clippedNotes,
          bpm: state.project.bpm,
          options: attachPluginBackend({
            f0Envelope: null,
            pitchCurveF0,
            refAudioWavBuffer: singer?.wavBuffer || null,
            refMidiNotes: singer?.midiNotes || null,
            refF0Data: singer?.f0Data || null,
            singerId: singer?.id || null,
            autoShift: dom.autoShiftCheck.checked,
            nSteps: inferenceOpts.nSteps,
            cfg: inferenceOpts.cfg,
            cfgRescale: inferenceOpts.cfgRescale,
            diffStepChunk: false,
            diffStepChunkFrames: inferenceOpts.diffStepChunkFrames,
            diffStepOverlapFrames: inferenceOpts.diffStepOverlapFrames,
            cfgScheduleMode: inferenceOpts.cfgScheduleMode,
            cfgStrengthStart: inferenceOpts.cfgStrengthStart,
            cfgScheduleKeyframes: inferenceOpts.cfgScheduleKeyframes,
            dynamicThresholdEnabled: inferenceOpts.dynamicThresholdEnabled,
            dynamicThresholdPercentile: inferenceOpts.dynamicThresholdPercentile,
            // 频谱后处理（音色 → 频谱曲线）：随该 fragment 的 postprocess 下发，
            // 主窗口播放/导出与分片编辑器听感一致（未启用时为 null，零开销）。
            melPostprocess: buildMelPostprocessPayload(
              fragment.postprocess || null,
              clippedNotes,
              state.project.bpm,
              SAMPLE_RATE,
              SVS_HOP_SIZE,
            ),
          }, singer),
        });

        // padding 到 fragment 时长，并在前面填充 firstNoteOffsetSample 个零样本：
        // synthesizeSVS 返回的 audioData[0] 对应 filledNotes[0].start（首音符起点
        // 相对 fragment），而非 fragment 起点。前置零样本使 paddedAudio[0] 对齐到
        // fragment 起点，与下游 startSample = fragment.startTime→sample 的混音逻辑
        // 协作，最终将 audioData[0] 放置在首音符的全局位置，与 MIDI note 对齐。
        const expectedSamples = Math.ceil((fragDuration / state.project.bpm) * 60 * SAMPLE_RATE);
        const firstNoteOffsetSample = Math.floor((clippedNotes[0].start / state.project.bpm) * 60 * SAMPLE_RATE);
        const requiredLength = Math.max(expectedSamples, firstNoteOffsetSample + audioData.length);
        const paddedAudio = new Float32Array(requiredLength);
        paddedAudio.set(audioData, firstNoteOffsetSample);
        const envelopedAudio = _applyFragmentVolumeEnvelope(paddedAudio, fragment, state.project.bpm);
        audioResults.push({
          audioData: envelopedAudio,
          startTimeBeat: fragment.startTime,
        });

        completedFrags++;
        const overallProgress = (completedFrags / totalFrags) * 100;
        const currentSeconds = (overallProgress / 100) * totalSeconds;
        // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
        dom.timeDisplay.textContent = t('main.synthesizingProgressTime', { current: formatTime(currentSeconds), total: formatTime(totalSeconds) });
      }

      const maxEndBeat = globalLastEnd;
      const vocalTotalSamples = Math.ceil(((maxEndBeat / state.project.bpm) * 60) * SAMPLE_RATE);
      // Account for accompaniment tracks that may extend beyond vocal fragments
      const accMaxSamples = getAccompanimentMaxEndSample(state.project.bpm);
      const totalSamples = Math.max(vocalTotalSamples, accMaxSamples);
      const mixedAudio = new Float32Array(totalSamples);

      for (const result of audioResults) {
        const startSample = Math.round((result.startTimeBeat / state.project.bpm * 60) * SAMPLE_RATE);
        const samplesToMix = result.audioData.length;
        for (let i = 0; i < samplesToMix; i++) {
          const targetIndex = startSample + i;
          if (targetIndex < totalSamples) {
            mixedAudio[targetIndex] += result.audioData[i];
          }
        }
      }

      // 推理可能耗时数秒：落地前再确认一次没有被取消，避免"取消后声音仍响起"
      throwIfCancelled();
      state.currentAudioData = mixedAudio;
      state.currentAudioChannels = _buildPlaybackChannels(mixedAudio, state.project.bpm, false);

      // 不重置 playbackPauseOffset：若用户在合成前已通过拖拽 playhead 设置了起始位置，
      // 则从该位置开始播放。stopPlayback / 自然结束时已重置为 0。
      dom.timeDisplay.textContent = formatTime(state.playbackPauseOffset);
      if (state.playbackPauseOffset > 0) {
        drawPausedPlayheadAt(state.playbackPauseOffset);
      }
      await startAudioPlayback(state.playbackPauseOffset);
    }

  } catch (error) {
    // 已被新一轮播放取代：错误一律静默。用户按 Play / 拖拽播放头时取消是主动行为，
    // 不该弹"合成失败"；而且此刻 state.synthesisCancelled 已被新会话重置为 false，
    // 只靠那个布尔量判断会把主动取消误报成失败。
    if (myGeneration !== _playGeneration) {
      if (playProgressCleanup) { safeCleanup('audioPlayback.playProgressCleanup', playProgressCleanup); playProgressCleanup = null; }
      return;
    }
    // 用户主动取消不是"合成失败"：不弹错误框，安静回到空闲。
    if (state.synthesisCancelled || error?.code === 'CANCELLED') {
      console.log('[Audio] synthesis cancelled by user');
    } else {
      console.error('Synthesis failed:', error);
      // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
      showAlertDialog(t('main.synthesisFailedDetail', { detail: error.message }));
    }
    dom.timeDisplay.textContent = formatTime(0);
  } finally {
    // 只有最新一代才能改动共享状态：被取消的旧会话可能在新会话已经开始后
    // 才走到 finally，无条件复位会把新会话的 isSynthesizing 清掉。
    if (myGeneration !== _playGeneration) {
      if (playProgressCleanup) { safeCleanup('audioPlayback.playProgressCleanup', playProgressCleanup); playProgressCleanup = null; }
      return;
    }
    state.isSynthesizing = false;
    if (state.synthesisCancelled) {
      // 取消后必须落到 IDLE：此前没有任何地方复位，Play 会一直是可点但无反应
      setTransport(TRANSPORT.IDLE);
    } else {
      // 合成结束后状态由 isPlaying 派生：流式路径此刻通常已在播（PLAYING），
      // 整段路径刚 startAudioPlayback 过也是 PLAYING；失败且无缓存音频时回到 IDLE
      // （PAUSED 会让 Stop 可点却没有可停内容）。
      const hasAudio = !!(state.currentAudioData && state.currentAudioData.length > 0);
      setTransport(state.isPlaying ? TRANSPORT.PLAYING : (hasAudio ? TRANSPORT.PAUSED : TRANSPORT.IDLE));
    }
    if (playProgressCleanup) { safeCleanup('audioPlayback.playProgressCleanup', playProgressCleanup); playProgressCleanup = null; }
  }
}

export function getAudioContext() {
  if (!state.audioContext || state.audioContext.state === 'closed') {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    if (state.audioContext.sampleRate !== SAMPLE_RATE) {
      console.warn(`[Audio] AudioContext actual sample rate: ${state.audioContext.sampleRate}Hz, target: ${SAMPLE_RATE}Hz, will auto-resample`);
    }
    state.gainNode = state.audioContext.createGain();
    state.gainNode.connect(state.audioContext.destination);
    applyAudioSettings();
  }
  // 流式推理等待期间 context 是被 _pauseStreamingForInference 有意挂起的，
  // 此处绝不能自动 resume——否则任何在等待窗口内调用本函数的代码
  // （如 visibilitychange 恢复的 rAF tick）都会解冻伴奏，使其在人声
  // 缺口期间继续播放，造成人声/伴奏永久错位。
  if (state.audioContext.state === 'suspended' && !(_scheduler && _scheduler._contextSuspended)) {
    state.audioContext.resume().catch(err => {
      console.warn('[Audio] AudioContext resume failed:', err);
    });
  }
  return state.audioContext;
}

export async function loadAudioSettings() {
  try {
    state.audioSettings = await window.electronAPI.getSettings();
    state.useExclusiveMode = state.audioSettings?.audioOutputMode === 'exclusive';
  } catch (_e) {
    state.audioSettings = {};
  }
}

export function getPreviewInferenceOptions() {
  return {
    nSteps: state.audioSettings?.previewDiffSteps ?? state.audioSettings?.exportDiffSteps ?? 32,
    cfg: state.audioSettings?.previewCfgStrength ?? 3.0,
    cfgRescale: state.audioSettings?.previewCfgRescale ?? 0.7,
    sampler: state.audioSettings?.previewSampler ?? state.audioSettings?.exportSampler ?? 'stork2',
    // Q-Drift 漂移校正（预览开关；未显式设置时按模型精度推断）
    qdrift: resolveQDriftDefault(state.audioSettings, 'previewEnableQDrift'),
    npuDiffBatchSize: 1,
    npuVocoderBatchSize: 1,
    diffStepChunk: state.audioSettings?.previewDiffStepChunkEnabled === true,
    diffStepChunkFrames: state.audioSettings?.previewDiffStepChunkFrames ?? 500,
    diffStepOverlapFrames: state.audioSettings?.previewDiffStepOverlapFrames ?? 50,
    // Task 11: CFG schedule (preview mirrors). Falls back to top-level keys.
    cfgScheduleMode: state.audioSettings?.previewCfgScheduleMode ?? state.audioSettings?.cfgScheduleMode ?? 'linear',
    cfgStrengthStart: state.audioSettings?.previewCfgStrengthStart ?? state.audioSettings?.cfgStrengthStart ?? null,
    cfgScheduleKeyframes: state.audioSettings?.previewCfgScheduleKeyframes ?? state.audioSettings?.cfgScheduleKeyframes ?? null,
    // Dynamic thresholding (preview path)
    dynamicThresholdEnabled: state.audioSettings?.previewDynamicThresholdEnabled === true,
    dynamicThresholdPercentile: Number.isFinite(state.audioSettings?.previewDynamicThresholdPercentile) ? state.audioSettings.previewDynamicThresholdPercentile : 0.995,
  };
}

export function getExportInferenceOptions() {
  return {
    nSteps: state.audioSettings?.exportDiffSteps ?? 32,
    cfg: state.audioSettings?.exportCfgStrength ?? 3.0,
    cfgRescale: state.audioSettings?.exportCfgRescale ?? 0.7,
    sampler: state.audioSettings?.exportSampler ?? 'stork2',
    // Q-Drift 漂移校正（导出开关；未显式设置时按模型精度推断）
    qdrift: resolveQDriftDefault(state.audioSettings, 'exportEnableQDrift'),
    npuDiffBatchSize: 1,
    npuVocoderBatchSize: 1,
    // Task 11: CFG schedule (export mirrors). Falls back to top-level keys.
    cfgScheduleMode: state.audioSettings?.exportCfgScheduleMode ?? state.audioSettings?.cfgScheduleMode ?? 'linear',
    cfgStrengthStart: state.audioSettings?.exportCfgStrengthStart ?? state.audioSettings?.cfgStrengthStart ?? null,
    cfgScheduleKeyframes: state.audioSettings?.exportCfgScheduleKeyframes ?? state.audioSettings?.cfgScheduleKeyframes ?? null,
    // Dynamic thresholding (export path)
    dynamicThresholdEnabled: state.audioSettings?.exportDynamicThresholdEnabled === true,
    dynamicThresholdPercentile: Number.isFinite(state.audioSettings?.exportDynamicThresholdPercentile) ? state.audioSettings.exportDynamicThresholdPercentile : 0.995,
  };
}

export function applyAudioSettings() {
  if (!state.audioSettings) return;

  if (state.gainNode && state.audioSettings.audioVolume !== undefined) {
    state.gainNode.gain.value = state.audioSettings.audioVolume;
  }

  if (state.audioContext && state.audioSettings.audioOutputDevice !== undefined && state.audioSettings.audioOutputDevice !== -1) {
    const sinkId = String(state.audioSettings.audioOutputDevice);
    if (state.audioContext.setSinkId && typeof state.audioContext.setSinkId === 'function') {
      state.audioContext.setSinkId(sinkId).catch((err) => {
        console.warn('Unable to switch the audio output device:', err);
      });
    }
  }
}

export async function startAudioPlayback(offset) {
  if (!state.currentAudioData || state.currentAudioData.length === 0) {
    return;
  }

  await loadAudioSettings();
  state.useExclusiveMode = state.audioSettings?.audioOutputMode === 'exclusive';

  if (state.useExclusiveMode) {
    await startExclusivePlayback(offset);
  } else {
    startSharedPlayback(offset);
  }
}

/**
 * 把（可能多声道的）人声混成播放用声道数组。
 *
 * @param {Float32Array} vocalMono
 * @param {number} bpm
 * @param {boolean} [includeAccompaniment=true] 是否把伴奏轨混进来。
 *   播放路径传 **false** —— 伴奏改为独立的 BufferSource + GainNode 调度，
 *   这样音量才能实时改变（见 _scheduleAccompaniment）。导出路径保持 true，
 *   离线渲染一次性混好即可。
 */
function _buildPlaybackChannels(vocalMono, bpm, includeAccompaniment = true) {
  const tracks = includeAccompaniment ? getAccompanimentTracks() : [];
  const maxChannels = Math.max(2, ...tracks.map(t => t.audioChannels?.length || 1));
  const result = Array.from({ length: maxChannels }, () => new Float32Array(vocalMono.length));
  for (let ch = 0; ch < maxChannels; ch++) result[ch].set(vocalMono);
  for (const track of tracks) {
    const src = track.audioChannels?.length ? track.audioChannels : [track.audioBuffer];
    const start = Math.round((track.accompanimentStartTime || 0) / bpm * 60 * SAMPLE_RATE);
    for (let ch = 0; ch < maxChannels; ch++) {
      const input = src[Math.min(ch, src.length - 1)];
      const srcRate = track.audioSampleRate || SAMPLE_RATE;
      const gain = Number.isFinite(track.accompanimentVolume) ? track.accompanimentVolume : 1;
      const outputLength = Math.ceil(input.length * SAMPLE_RATE / srcRate);
      for (let i = 0; i < outputLength && start + i < result[ch].length; i++) {
        const pos = i * srcRate / SAMPLE_RATE;
        const i0 = Math.floor(pos);
        const i1 = Math.min(input.length - 1, i0 + 1);
        const frac = pos - i0;
        result[ch][start + i] += (input[i0] + (input[i1] - input[i0]) * frac) * gain;
      }
    }
  }
  return result;
}

export function startSharedPlayback(offset) {
  stopAudioSource();

  const context = getAudioContext();
  const channels = state.currentAudioChannels?.length ? state.currentAudioChannels : [state.currentAudioData];
  const audioBuffer = context.createBuffer(channels.length, channels[0].length, SAMPLE_RATE);
  for (let ch = 0; ch < channels.length; ch++) audioBuffer.getChannelData(ch).set(channels[ch]);

  state.currentAudioBuffer = audioBuffer;

  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(state.gainNode);

  // 记录播放启动时刻，用于 onended 触发时判断是否"刚启动就结束"
  // （用户拖拽到接近末尾时 source 会几乎立即结束，此时不应重置位置到 0，
  // 否则 playhead 会从拖拽位置跳回开头）
  const playbackStartWallTime = performance.now();

  source.onended = () => {
    if (!state.isPlaying) return;
    const realElapsed = (performance.now() - playbackStartWallTime) / 1000;
    state.isPlaying = false;
    if (realElapsed < 0.2) {
      // 播放刚启动就结束（用户拖拽到接近末尾）：保留当前位置，不重置到 0
      if (state.playheadRaf) {
        cancelAnimationFrame(state.playheadRaf);
        state.playheadRaf = null;
      }
      dom.timeDisplay.textContent = formatTime(state.playbackPauseOffset);
      drawPausedPlayheadAt(state.playbackPauseOffset);
      // 播放头停在当前位置 → 暂停态（Play 可点 = 继续）
      setTransport(TRANSPORT.PAUSED);
    } else {
      // 自然播放结束：重置到 0
      state.playbackPauseOffset = 0;
      stopPlayheadAnimation();
      dom.timeDisplay.textContent = formatTime(0);
      clearPlayheadLine();
      // 必须显式回 IDLE：PLAYING 下 Play 是 disabled 的，漏掉这一步会让
      // 播完之后 Play 永久变灰、Pause 亮着却因 isPlaying=false 空转。
      setTransport(TRANSPORT.IDLE);
    }
  };

  // 时间基准必须与 source 真正开始发声的时刻对齐：先取基准、再用 start(when)
  // 精确落在该时刻。start(0) 只保证"下一个渲染量子"（24 kHz 下 ≈5 ms），
  // 基准取 start 之后的 currentTime 会让播放头从一开始就略微超前。
  const startAt = context.currentTime;
  source.start(startAt, offset);
  // 伴奏独立调度（不预混）：滑块拖动时 setAccompanimentVolume 直接改 GainNode
  const vocalDurSec = (state.currentAudioData?.length || 0) / SAMPLE_RATE;
  _scheduleAccompaniment(context, state.gainNode, startAt, offset, Math.max(0, vocalDurSec - offset));
  state.currentAudioSource = source;
  state.isPlaying = true;
  setTransport(TRANSPORT.PLAYING);
  clearTransportStatus();
  state.playbackStartTime = startAt - offset;
  state.playbackPauseOffset = offset;

  startPlayheadAnimation();
}

export async function startExclusivePlayback(offset) {
  stopAudioSource();
  stopExclusivePlayback();

  try {
    const options = {
      deviceId: state.audioSettings?.audioOutputDevice ?? -1,
      sampleRate: state.audioSettings?.audioSampleRate ?? SAMPLE_RATE,
      sourceSampleRate: SAMPLE_RATE,
      channels: 1,
      bitDepth: state.audioSettings?.audioBitDepth ?? 'float32',
      bufferSize: state.audioSettings?.audioBufferSize ?? 1024,
      exclusiveMode: true,
      volume: state.audioSettings?.audioVolume ?? 1.0,
      offset: offset,
    };

    const result = await window.electronAPI.audioPlay(state.currentAudioData, options);

    if (!result.success) {
      console.warn('[Audio] WASAPI exclusive mode failed, falling back to shared:', result.error);
      state.useExclusiveMode = false;
      startSharedPlayback(offset);
      return;
    }

    state.isPlaying = true;
    setTransport(TRANSPORT.PLAYING);
    clearTransportStatus();
    state.playbackStartTime = Date.now() / 1000 - offset;
    state.playbackPauseOffset = offset;
    // 记录播放启动时刻，用于 onAudioEnded 触发时判断是否"刚启动就结束"
    // （用户拖拽到接近末尾时音频几乎立即结束，此时不应重置位置到 0，
    // 否则 playhead 会从拖拽位置跳回开头）
    const playbackStartWallTime = Date.now();

    // Drop any listener leaked by a previous interrupted session before
    // registering the new one.
    _detachExclusiveEndedListener();
    _exclusiveRemoveEndedListener = window.electronAPI.onAudioEnded(() => {
      if (!state.isPlaying) return;
      const realElapsed = (Date.now() - playbackStartWallTime) / 1000;
      state.isPlaying = false;
      stopExclusivePlayback();
      if (realElapsed < 0.2) {
        // 播放刚启动就结束（用户拖拽到接近末尾）：保留当前位置，不重置到 0
        if (state.exclusivePlaybackRaf) {
          cancelAnimationFrame(state.exclusivePlaybackRaf);
          state.exclusivePlaybackRaf = null;
        }
        dom.timeDisplay.textContent = formatTime(state.playbackPauseOffset);
        drawPausedPlayheadAt(state.playbackPauseOffset);
        setTransport(TRANSPORT.PAUSED);
      } else {
        // 自然播放结束：重置到 0
        state.playbackPauseOffset = 0;
        stopPlayheadAnimation();
        dom.timeDisplay.textContent = formatTime(0);
        clearPlayheadLine();
        setTransport(TRANSPORT.IDLE);
      }
    });

    startExclusivePlayheadAnimation(_detachExclusiveEndedListener, playbackStartWallTime);
  } catch (err) {
    console.warn('Exclusive audio playback failed; using shared playback:', err);
    state.useExclusiveMode = false;
    startSharedPlayback(offset);
  }
}

export function startExclusivePlayheadAnimation(removeEndedListener, playbackStartWallTime) {
  _ensureVisibilityHandler();
  function updatePlayhead() {
    _exclusiveUpdateFn = updatePlayhead;
    if (!state.isPlaying) {
      if (removeEndedListener) removeEndedListener();
      return;
    }

    const elapsed = Date.now() / 1000 - state.playbackStartTime;
    const duration = state.currentAudioData ? state.currentAudioData.length / SAMPLE_RATE : 0;

    if (elapsed >= duration) {
      // 兜底检查：rAF 检测到 elapsed >= duration（onAudioEnded IPC 可能未及时触发）
      // 同样应用"刚启动就结束"保护，避免拖拽到接近末尾时跳回开头
      const realElapsed = playbackStartWallTime ? (Date.now() - playbackStartWallTime) / 1000 : elapsed;
      state.isPlaying = false;
      stopExclusivePlayback();
      if (realElapsed < 0.2) {
        if (state.exclusivePlaybackRaf) {
          cancelAnimationFrame(state.exclusivePlaybackRaf);
          state.exclusivePlaybackRaf = null;
        }
        dom.timeDisplay.textContent = formatTime(state.playbackPauseOffset);
        drawPausedPlayheadAt(state.playbackPauseOffset);
        setTransport(TRANSPORT.PAUSED);
      } else {
        state.playbackPauseOffset = 0;
        stopPlayheadAnimation();
        dom.timeDisplay.textContent = formatTime(0);
        clearPlayheadLine();
        setTransport(TRANSPORT.IDLE);
      }
      if (removeEndedListener) removeEndedListener();
      return;
    }

    dom.timeDisplay.textContent = formatTime(elapsed);
    drawPlayheadLine(elapsed);
    state.exclusivePlaybackRaf = requestAnimationFrame(updatePlayhead);
  }

  _exclusiveUpdateFn = updatePlayhead;
  state.exclusivePlaybackRaf = requestAnimationFrame(updatePlayhead);
}

export function stopExclusivePlayback() {
  if (state.exclusivePlaybackRaf) {
    cancelAnimationFrame(state.exclusivePlaybackRaf);
    state.exclusivePlaybackRaf = null;
  }
  // Unsubscribe the onAudioEnded IPC listener here: stop/pause/seek all route
  // through this function, whereas the rAF that used to own the unsubscribe
  // has already been cancelled on those paths (listener leak).
  _detachExclusiveEndedListener();
  window.electronAPI.audioStop().catch(err => {
    console.warn('[Audio] Failed to stop exclusive playback:', err);
  });
}

export function pausePlayback() {
  if (!state.isPlaying) {
    return;
  }

  // 流式播放暂停：停止所有流式 source，记录当前位置
  if (state.streamingSources && state.streamingSources.length > 0) {
    const context = getAudioContext();
    // 暂停位置取"听到的位置"：续播时从该位置重新调度，视觉与听觉才一致。
    const elapsed = getAudibleElapsedSec(context, state.playbackStartTime);
    state.playbackPauseOffset = Math.max(0, elapsed);
    state.streamingFinished = true;
    _streamingActive = false;
    for (const src of state.streamingSources) {
      if (!src) continue;  // 已 onended 释放的中间 chunk 跳过
      safeCleanup('audioPlayback.src.stop', () => { src.onended = null; src.stop(); });
    }
    state.streamingSources = [];
    state.isPlaying = false;
    clearAccompanimentGains();
    if (_scheduler) _scheduler.deactivate();
    if (state.playheadRaf) {
      cancelAnimationFrame(state.playheadRaf);
      state.playheadRaf = null;
    }
    dom.timeDisplay.textContent = t('main.pausedTime', { time: formatTime(elapsed) });
    drawPausedPlayheadAt(elapsed);
    setTransport(TRANSPORT.PAUSED);
    return;
  }

  if (state.useExclusiveMode) {
    const elapsed = Date.now() / 1000 - state.playbackStartTime;
    state.playbackPauseOffset = elapsed;
    stopExclusivePlayback();
    state.isPlaying = false;
    // 仅取消 rAF，不清除 playhead 视觉——保留显示"已暂停位置"的虚线播放头
    if (state.exclusivePlaybackRaf) {
      cancelAnimationFrame(state.exclusivePlaybackRaf);
      state.exclusivePlaybackRaf = null;
    }
    dom.timeDisplay.textContent = t('main.pausedTime', { time: formatTime(elapsed) });
    drawPausedPlayheadAt(elapsed);
    setTransport(TRANSPORT.PAUSED);
  } else {
    if (!state.currentAudioSource) return;
    const context = getAudioContext();
    const elapsed = getAudibleElapsedSec(context, state.playbackStartTime);
    state.playbackPauseOffset = elapsed;
    stopAudioSource();
    state.isPlaying = false;
    // stopAudioSource 已 cancel rAF，但不会清除画布；这里手动绘制暂停态播放头
    dom.timeDisplay.textContent = t('main.pausedTime', { time: formatTime(elapsed) });
    drawPausedPlayheadAt(elapsed);
    setTransport(TRANSPORT.PAUSED);
  }
}

export function stopPlayback() {
  // 解除推理等待冻结（等待在途 suspend 落地后再 resume，避免冻结泄漏）
  if (_scheduler) _scheduler.deactivate();
  if (state.isSynthesizing) {
    state.synthesisCancelled = true;
    // 只在管线已就绪（确实在推理）时才通知主进程取消。
    // 模型加载（LOADING）阶段调 cancelSVSSynthesis 会落到主进程
    // "无活跃任务 → resetSvsPipeline()" 的分支，把正在初始化的 lazy 实例
    // 作废；下次播放要从头 _doInit()，表现为"取消一次，加载时间翻倍"。
    if (state.pipelineInitialized) {
      window.electronAPI.cancelSVSSynthesis().catch(() => {});
    }
    // 立即放开重入锁：否则 IDLE 下 Play 是可点的，但 playAll 的 guard 会
    // 静默 return，用户看到的是"点了没反应"。旧会话会在最近的检查点退出。
    state.isSynthesizing = false;
  }
  // 停止流式播放
  if (state.streamingSources && state.streamingSources.length > 0) {
    state.streamingFinished = true;
    _streamingActive = false;
    for (const src of state.streamingSources) {
      if (!src) continue;  // 已 onended 释放的中间 chunk 跳过
      safeCleanup('audioPlayback.src.stop', () => { src.onended = null; src.stop(); });
    }
    state.streamingSources = [];
  }
  if (_scheduler) _scheduler.deactivate();
  // 播放被中止：插件可能还挂着阻滞浮层（它的 end 事件依赖插件走完整条流程），
  // 这里兜底收掉，避免 UI 停在阻滞态。正常路径（无插件）是 no-op。
  clearPluginBlockingOverlay('playback-stopped');
  if (state.useExclusiveMode) {
    stopExclusivePlayback();
  }
  stopAudioSource();
  state.isPlaying = false;
  state.playbackPauseOffset = 0;
  stopPlayheadAnimation();
  state.currentAudioData = null;
  state.currentAudioBuffer = null;
  dom.timeDisplay.textContent = formatTime(0);
  setTransport(TRANSPORT.IDLE);
  clearTransportStatus();
}

/**
 * 实时跳转到新的播放位置（不重新合成）。
 * 复用已缓存的 state.currentAudioData，从 newOffset 开始播放。
 * 播放中拖拽 playhead 时调用，避免重新合成的延迟。
 *
 * 如果未在播放，仅更新 playbackPauseOffset 和暂停态播放头视觉，
 * 等用户点击 Play 时从该位置开始。
 */
export async function seekPlayback(newOffset) {
  // 流式播放中拖拽 playhead：停止流式播放，记录位置。
  // 合成仍在后台进行，完成后 state.currentAudioData 会被设置，用户可从该位置按 Play 继续播放。
  if (state.streamingSources && state.streamingSources.length > 0) {
    state.streamingFinished = true;
    _streamingActive = false;
    for (const src of state.streamingSources) {
      if (!src) continue;  // 已 onended 释放的中间 chunk 跳过
      safeCleanup('audioPlayback.src.stop', () => { src.onended = null; src.stop(); });
    }
    state.streamingSources = [];
    state.isPlaying = false;
    if (_scheduler) _scheduler.deactivate();
    if (state.playheadRaf) {
      cancelAnimationFrame(state.playheadRaf);
      state.playheadRaf = null;
    }
    state.playbackPauseOffset = Math.max(0, newOffset);
    setTransport(TRANSPORT.PAUSED);
    drawPausedPlayheadAt(state.playbackPauseOffset);
    dom.timeDisplay.textContent = formatTime(state.playbackPauseOffset);
    return;
  }

  const audioData = state.currentAudioData;
  if (!audioData || audioData.length === 0) {
    // 没有缓存的音频：仅记录用户选择的位置，等合成后从这里开始
    state.playbackPauseOffset = Math.max(0, newOffset);
    drawPausedPlayheadAt(state.playbackPauseOffset);
    dom.timeDisplay.textContent = formatTime(state.playbackPauseOffset);
    return;
  }

  // 限制到 [0, duration - margin)，余量 50ms 防止拖拽到接近末尾时 source 立即结束
  const duration = audioData.length / SAMPLE_RATE;
  const margin = duration > 0.1 ? 0.05 : duration * 0.5;
  const clamped = Math.max(0, Math.min(duration - margin, newOffset));

  // 停止当前播放（保留 currentAudioData，不 null）
  if (state.useExclusiveMode) {
    if (state.exclusivePlaybackRaf) {
      cancelAnimationFrame(state.exclusivePlaybackRaf);
      state.exclusivePlaybackRaf = null;
    }
    window.electronAPI.audioStop().catch(() => {});
  } else {
    stopAudioSource();
  }
  state.isPlaying = false;

  // 设置新的起始位置
  state.playbackPauseOffset = clamped;

  // 从新位置重新启动播放
  await startAudioPlayback(clamped);
}

/**
 * 返回当前播放位置（秒）。
 * 播放中：根据 playbackStartTime 实时计算；
 * 未播放：返回 state.playbackPauseOffset（用户拖拽/暂停保留的位置）。
 * 用于事件处理器的 hit-test 与 tooltip 显示。
 */
export function getCurrentPlaybackSeconds() {
  if (state.isPlaying) {
    if (state.useExclusiveMode) {
      return Math.max(0, Date.now() / 1000 - state.playbackStartTime);
    }
    if (state.audioContext) {
      // hit test / tooltip 用的是"用户看到并听到的位置"，与播放头同一基准。
      return getAudibleElapsedSec(state.audioContext, state.playbackStartTime);
    }
    return 0;
  }
  return state.playbackPauseOffset || 0;
}

export function stopAudioSource() {
  // 伴奏是独立 source，必须在这里一并停掉——否则暂停/停止后人声停了、
  // 伴奏还在响（它在播放期是独立调度的，不再隶属 currentAudioSource）。
  _clearAccompanimentNodes();
  if (state.currentAudioSource) {
    try {
      state.currentAudioSource.onended = null;
      state.currentAudioSource.stop();
    } catch (_e) {
    }
    state.currentAudioSource = null;
  }
  if (state.playheadRaf) {
    cancelAnimationFrame(state.playheadRaf);
    state.playheadRaf = null;
  }
}

export function startPlayheadAnimation() {
  // 幂等保护：已有 rAF 循环在跑时不叠加启动。双循环会导致播放头重复绘制，
  // 且 stopPlayheadAnimation 只能取消 state.playheadRaf 存的最后一个 id，
  // 另一个循环永久泄漏（等待推理恢复路径可能命中此竞态）。
  if (state.playheadRaf) return;
  _ensureVisibilityHandler();
  function updatePlayhead() {
    _sharedUpdateFn = updatePlayhead;
    if (!state.isPlaying) {
      // 必须把这个"已退出但 id 还留着"的句柄清掉：startPlayheadAnimation 的
      // 幂等保护只看 state.playheadRaf 是否非空，残留一个死 id 会让之后每一次
      // 启动都被 short-circuit —— 声音在放、播放头却一直不动。
      // （典型触发：流式播放中暂停 → 推理跑完 → 这里被 startPlayheadAnimation
      //   重新拉起 → 立刻因 !isPlaying 退出，句柄留在 state 上。）
      state.playheadRaf = null;
      return;
    }

    const context = getAudioContext();
    // 两个时钟域，不可混用（混用 = 补偿量重复计入，人声真的与时间轴错开）：
    //   renderedElapsed —— 渲染域位置：chunk 对齐、underrun 前沿、结束判定用。
    //   elapsed         —— 可听域位置：只有播放头与时间码用（见 audioOutputClock）。
    const renderedElapsed = context.currentTime - state.playbackStartTime;
    const elapsed = getAudibleElapsedSec(context, state.playbackStartTime);

    // 流式播放 buffer underrun 检测：
    // 当 playhead 到达已收到音频的最远位置（buffer 前沿）且推理尚未完成时，
    // 暂停 playhead 并显示"等待推理"，直到下一个 chunk 到达后自动恢复。
    // 这解决了"分段1播完但分段2未推理完"时 playhead 继续前进穿过静音区的问题。
    // 窗口最小化时 rAF 会被挂起，由 _ensureStreamingWatchdog 兜底检测。
    if (_enterStreamingWaitIfUnderrun(context, renderedElapsed)) return;

    // 流式播放兜底停止：推理已完成且 playhead 越过播放前沿后，
    // 说明所有已调度的 source 已播完（或 onended 清理未触发）。
    // 此时无音频可播，必须停止 rAF，否则 playhead 持续在静音区前进。
    // 0.5s 容差防止 chunk 边界抖动导致误停。
    // 播放前沿取 {人声 chunk 前沿, 伴奏结束位置} 的最大值，避免伴奏长于
    // 人声时在人声结束后就提前停止（会截断仍在播放的伴奏）。
    // 仅在流式调度器存在时访问其字段；非流式路径（_scheduler === null）不进入此分支，
    // 否则首帧会抛 TypeError 且 playheadRaf 残留，导致后续启动被幂等保护短路。
    if (_streamingActive && _scheduler) {
      const totalFrontierSec = Math.max(_scheduler.bufferEndSec, _streamingAccEndSec);
      if (_scheduler.inferenceDone && renderedElapsed >= totalFrontierSec + 0.5) {
        if (!state.streamingFinished) {
          state.streamingFinished = true;
          state.isPlaying = false;
          state.playbackPauseOffset = 0;
          _streamingActive = false;
          for (const src of (state.streamingSources || [])) {
            if (!src) continue;
            safeCleanup('audioPlayback.src.stop', () => { src.onended = null; src.stop(); });
          }
          state.streamingSources = [];
          stopPlayheadAnimation();
          dom.timeDisplay.textContent = formatTime(0);
          setTransport(TRANSPORT.IDLE);
          clearPlayheadLine();
        }
        return;
      }
    }

    if (state.currentAudioBuffer) {
      const duration = state.currentAudioBuffer.duration;
      if (renderedElapsed >= duration) {
        stopPlayback();
        dom.timeDisplay.textContent = formatTime(0);
        clearPlayheadLine();
        return;
      }
    }

    dom.timeDisplay.textContent = formatTime(elapsed);
    drawPlayheadLine(elapsed);
    state.playheadRaf = requestAnimationFrame(updatePlayhead);
  }

  _sharedUpdateFn = updatePlayhead;
  state.playheadRaf = requestAnimationFrame(updatePlayhead);
}

export function stopPlayheadAnimation() {
  if (state.playheadRaf) {
    cancelAnimationFrame(state.playheadRaf);
    state.playheadRaf = null;
  }
  clearPlayheadLine();
}

export async function exportAll() {
  // 导出流程现在由导出对话框驱动：
  // 1. 打开对话框让用户配置精度/参数/输出位置
  // 2. 对话框保存设置后调用 runExportJob 执行合成
  // 3. 对话框负责显示进度、保存文件、打开导出位置
  const { openExportDialog } = await import('./exportDialog.js');
  await openExportDialog();
}

/**
 * 执行导出合成任务（由导出对话框调用）。
 * 遍历所有有音符的分片，逐个合成并混音，返回混音后的音频数据。
 *
 * @param {Object} opts - 导出选项
 * @param {number} opts.nSteps - 扩散步数
 * @param {number} opts.cfg - CFG 引导强度
 * @param {number} opts.cfgRescale - CFG Rescale 系数
 * @param {boolean} opts.autoShift - 是否启用 Auto Shift
 * @param {Function} [opts.onFragmentProgress] - 单分片推理进度回调 (progress: 0-100)
 * @param {Function} [opts.onOverallProgress] - 总体进度回调 (progress: 0-100)
 * @param {Function} [opts.onStatus] - 状态文本回调 (statusKey: string, params?: object)
 * @returns {Promise<{mixedAudio: Float32Array, maxDuration: number, fragmentCount: number}>}
 */
export async function runExportJob(opts) {
  const {
    nSteps,
    cfg,
    cfgRescale,
    sampler,
    autoShift,
    smartSegmentation,
    cfgScheduleMode,
    cfgStrengthStart,
    cfgScheduleKeyframes,
    dynamicThresholdEnabled,
    dynamicThresholdPercentile,
    onFragmentProgress,
    onOverallProgress,
    onStatus,
  } = opts;

  const fragments = trackManager.getFragments();
  const accTracks = getAccompanimentTracks();
  if (fragments.length === 0 && accTracks.length === 0) {
    throw new Error(t('main.exportDialog.noFragments'));
  }

  const singers = trackManager.getSingers();
  const singerMap = new Map();
  singers.forEach(s => singerMap.set(s.id, s));

  // 收集所有有 notes 的 fragments，按 startTime 排序后逐个合成。
  // 与 playAll 一致：每个 fragment 用相对 notes（clippedNotes）
  // + 该 fragment 自己的 pitchCurve（buildFragmentPitchCurveF0），
  // 确保与分片编辑器播放/导出结果完全一致。
  const allFragments = fragments
    .filter(f => {
      // Exclude fragments belonging to accompaniment tracks (no SVS synthesis)
      const singer = singerMap.get(f.singerId);
      if (singer && singer.type === 'accompaniment') return false;
      return f.notes && f.notes.length > 0;
    })
    .sort((a, b) => a.startTime - b.startTime);

  if (allFragments.length === 0) {
    // Allow export if there are accompaniment tracks (audio-only export)
    if (getAccompanimentTracks().length === 0) {
      throw new Error(t('main.exportDialog.noNotes'));
    }
  }

  if (onStatus) onStatus('progressPreparing');

  // 与 playAll 同一策略：全插件工程不初始化内置 pipeline。
  if (!allFragmentsUsePluginBackend(allFragments, singerMap)) {
    await ensurePipelineInitialized();
  }
  await loadAudioSettings();

  const totalFragments = allFragments.length;
  let audioResults = [];
  let maxDuration = 0;

  // 注册推理进度监听：转换为单分片进度
  let fragmentProgressCleanup = null;
  if (onFragmentProgress) {
    try {
      fragmentProgressCleanup = window.electronAPI.onSVSProgress((progress) => {
        onFragmentProgress(progress);
        // 同时计算总体进度：(已完成分片数 + 当前分片进度) / 总分片数
        if (onOverallProgress) {
          const overall = ((audioResults.length + progress / 100) / totalFragments) * 100;
          onOverallProgress(Math.min(99, overall));
        }
      });
    } catch (_) {}
  }

  try {
    for (const fragment of allFragments) {
      const singer = singerMap.get(fragment.singerId);
      if (!singer) {
        // 跳过找不到歌手的分片，但仍计入进度
        if (onOverallProgress) {
          const overall = ((audioResults.length + 1) / totalFragments) * 100;
          onOverallProgress(Math.min(99, overall));
        }
        continue;
      }

      // clippedNotes：相对 fragment 的 notes，截断到 fragment.duration（与分片编辑器 getClippedNotes 一致）
      const fragDuration = fragment.duration;
      const clippedNotes = [];
      for (const note of fragment.notes) {
        if (note.start >= fragDuration) continue;
        const noteEnd = note.start + note.duration;
        if (noteEnd > fragDuration) {
          clippedNotes.push({ ...note, duration: fragDuration - note.start });
        } else {
          clippedNotes.push(note);
        }
      }
      if (clippedNotes.length === 0) continue;

      const pitchCurveF0 = buildFragmentPitchCurveF0(fragment, clippedNotes, state.project.bpm);

      const audioData = await window.electronAPI.synthesizeSVS({
        notes: clippedNotes,
        bpm: state.project.bpm,
        options: attachPluginBackend({
          refAudioWavBuffer: singer?.wavBuffer || null,
          refMidiNotes: singer?.midiNotes || null,
          refF0Data: singer?.f0Data || null,
          singerId: singer?.id || null,
          pitchCurveF0,
          autoShift,
          smartSegmentation,
          nSteps,
          cfg,
          cfgRescale,
          sampler,
          cfgScheduleMode: opts.cfgScheduleMode,
          cfgStrengthStart: opts.cfgStrengthStart,
          cfgScheduleKeyframes: opts.cfgScheduleKeyframes,
          dynamicThresholdEnabled: opts.dynamicThresholdEnabled,
          dynamicThresholdPercentile: opts.dynamicThresholdPercentile,
          // qdrift 必须显式透传：exportDialog 已把 exportEnableQDrift 映射到 opts.qdrift，
          // 逐字段列举时遗漏会让「导出全部」静默丢失 Q-Drift 校正。
          // 这里不展开 ...opts，避免把 onFragmentProgress/onOverallProgress/onStatus
          // 等函数字段经 IPC 传给推理层（不可结构化克隆）。
          qdrift: opts.qdrift === true,
          // 频谱后处理（音色 → 频谱曲线）：必须与 playAll 的两处一致下发，
          // 否则「导出全部」会静默丢弃 specBlend / specSmoothT / specSmoothF，
          // 导出音频与主窗口播放、分片编辑器预览听感不一致。
          melPostprocess: buildMelPostprocessPayload(
            fragment.postprocess || null,
            clippedNotes,
            state.project.bpm,
            SAMPLE_RATE,
            SVS_HOP_SIZE,
          ),
        }, singer),
      });

      // padding 到 fragment 时长，并在前面填充 firstNoteOffsetSample 个零样本：
      // synthesizeSVS 返回的 audioData[0] 对应 filledNotes[0].start（首音符起点
      // 相对 fragment），而非 fragment 起点。前置零样本使 paddedAudio[0] 对齐到
      // fragment 起点，与下游 startSample = fragment.startTime→sample 的混音逻辑
      // 协作，最终将 audioData[0] 放置在首音符的全局位置，与 MIDI note 对齐。
      const expectedSamples = Math.ceil((fragDuration / state.project.bpm) * 60 * SAMPLE_RATE);
      const firstNoteOffsetSample = Math.floor((clippedNotes[0].start / state.project.bpm) * 60 * SAMPLE_RATE);
      const requiredLength = Math.max(expectedSamples, firstNoteOffsetSample + audioData.length);
      const paddedAudio = new Float32Array(requiredLength);
      paddedAudio.set(audioData, firstNoteOffsetSample);
      audioResults.push({
        audioData: paddedAudio,
        startTimeBeat: fragment.startTime,
      });

      // 与 playAll 的 globalLastEnd 一致：结束位置 = 分片起点 + 相对时长，
      // 否则起点靠后的分片会被静默截断丢弃。
      const fragEndSec = ((fragment.startTime + fragDuration) / state.project.bpm) * 60;
      if (fragEndSec > maxDuration) maxDuration = fragEndSec;

      // 完成一个分片后更新总体进度（onSVSProgress 只在推理过程中触发，
      // 这里补充分片完成后的进度跃迁）
      if (onOverallProgress) {
        const overall = (audioResults.length / totalFragments) * 100;
        onOverallProgress(Math.min(99, overall));
      }
    }
  } finally {
    if (fragmentProgressCleanup) {
      safeCleanup('audioPlayback.fragmentProgressCleanup', fragmentProgressCleanup);
      fragmentProgressCleanup = null;
    }
  }

  if (onStatus) onStatus('progressEncoding');

  const accMaxSamples = getAccompanimentMaxEndSample(state.project.bpm);
  const totalSamples = Math.max(Math.ceil(maxDuration * SAMPLE_RATE), accMaxSamples);
  const mixedAudio = new Float32Array(totalSamples);

  for (const result of audioResults) {
    const startSample = Math.round((result.startTimeBeat / state.project.bpm * 60) * SAMPLE_RATE);
    const samplesToMix = result.audioData.length;

    for (let i = 0; i < samplesToMix; i++) {
      const targetIndex = startSample + i;
      if (targetIndex < totalSamples) {
        mixedAudio[targetIndex] += result.audioData[i];
      }
    }
  }

  const mixedChannels = _buildPlaybackChannels(mixedAudio, state.project.bpm);
  const interleaved = new Float32Array(totalSamples * mixedChannels.length);
  for (let i = 0; i < totalSamples; i++) {
    for (let ch = 0; ch < mixedChannels.length; ch++) interleaved[i * mixedChannels.length + ch] = mixedChannels[ch][i];
  }

  if (onOverallProgress) onOverallProgress(100);

  return {
    mixedAudio: interleaved,
    numChannels: mixedChannels.length,
    maxDuration,
    fragmentCount: audioResults.length,
  };
}
