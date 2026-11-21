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
    this.queue = Promise.resolve();
    this.lastChunkAtMs = 0;
    this.chunkSeen = false;
    this.streamStarted = false;
    this.streamDisabled = false;
    this.inferenceDone = false;

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

  // ---------- 生命周期 ----------

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (_current === this) _current = null;
    this._teardownAudio();
    if (this.chunkCleanup) {
      safeCleanup('fragmentPlayback.chunkCleanup', this.chunkCleanup);
      this.chunkCleanup = null;
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
          const btn = document.getElementById('btn-play-fragment');
          if (btn) setLabel(btn, t('fragment.waitingForInference'), { icon: 'stop' });
        } else {
          updateFragmentPlayButton();
          if (getFragmentIsPlaying() && !getFragmentPlayheadRaf()) playheadTick();
        }
      },
      watchdogMarginSec: 0.3,
      onFinish: () => this._maybeFinish(),
    });
  }

  /** chunk 入口：串行化（回调体内有 await，并发会让后块基于旧状态排程）。 */
  pushChunk(chunkInfo) {
    this.queue = this.queue
      .then(() => this._handleChunk(chunkInfo))
      .catch((e) => console.warn('[FragmentPlayback] chunk queue error:', e && e.message));
    return this.queue;
  }

  /** 等待已入队 chunk 全部处理完（invoke 回执后调用）。 */
  drain() { return this.queue; }

  async _handleChunk(chunkInfo) {
    if (!this.isCurrent || this.finished || this.streamDisabled) return;
    if (!chunkInfo) return;
    this.chunkSeen = true;
    if (!chunkInfo.audio || chunkInfo.audio.length === 0) return;

    const ctx = await _ctxForChunk(this);
    if (!ctx || !this.isCurrent || this.finished || this.streamDisabled) return;

    const sampleRate = getSampleRate();
    // 首个 chunk 之前先等 suspend 落地：in-flight 期间时钟仍在走，
    // 此刻读 currentTime 会把"控制消息还没送到"算成迟到而裁掉音频头。
    if (this.scheduler) await this.scheduler.awaitSuspendSettled();
    if (!this.isCurrent || this.finished || this.streamDisabled) return;

    if (!this.timeline) {
      const notes = getClippedNotes();
      const firstNoteStartSec = notes.length > 0 ? (firstNoteStart(notes) / _bpm()) * 60 : 0;
      this.timeline = new StreamTimeline({
        startPositionSec: this.startPositionSec,
        firstNoteStartSec,
      });
    }

    const plan = this.timeline.plan(chunkInfo, sampleRate, ctx.currentTime);
    this.lastChunkAtMs = Date.now();

    if (plan.startedNow) {
      this.streamStarted = true;
      const anchor = this.timeline.anchorCtxTime;
      const fades = buildNoteFades();
      if (fades.length > 0) {
        this.fadeGain = ctx.createGain();
        const master = getFragmentGainNode();
        this.fadeGain.connect(master || ctx.destination);
        scheduleFades(this.fadeGain, ctx, fades, this.startPositionSec, anchor);
      }
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

    if (plan.action === 'drop') {
      console.log(`[FragPlay] chunk dropped | session=${this.id} reason=${plan.reason} offset=${chunkInfo.sampleOffset ?? '-'} end=${chunkInfo.sampleEnd ?? '-'} t=${Date.now()}`);
      if (chunkInfo.isLast && this.scheduler) this.scheduler.markLastReceived();
      this._maybeFinish();
      return;
    }

    // 前沿必须在 resumeFromWait 之前更新：解冻后重启的循环用新前沿判定，
    // 否则刚解冻又被旧前沿冻结 → 首段之后整段静音。
    if (this.scheduler) this.scheduler.updateBufferFrontier(plan.contentEndSec);

    const segments = plan.segments && plan.segments.length > 0
      ? plan.segments
      : [{ skipSamples: plan.skipSamples, when: plan.when, offsetSec: plan.offsetSec, durationSec: plan.durationSec }];

    // 一个块可能被已排程区间切成多段（乱序/重叠），逐段排 —— 少排一段就是丢一句。
    for (const seg of segments) {
      const startSample = seg.skipSamples;
      // 按"该段完整长度"切片，迟到量只在 start(when, offset) 里扣一次。
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
      if (this.fadeGain) source.connect(this.fadeGain);
      else {
        const master = getFragmentGainNode();
        source.connect(master || ctx.destination);
      }
      source.start(seg.when, seg.offsetSec);

      if (!this.isCurrent) {
        safeCleanup('fragmentPlayback.lateSrc.stop', () => { source.onended = null; source.stop(); });
        return;
      }
      const sched = this.scheduler;
      if (sched) sched.addSource();
      const idx = this.sources.length;
      this.sources.push(source);
      source.onended = () => {
        if (sched) sched.sourceEnded();
        if (this.sources[idx] === source) this.sources[idx] = null;
        this._maybeFinish();
      };
    }

    console.log(`[FragPlay] chunk scheduled | session=${this.id} seg=${chunkInfo.chunkIndex ?? '-'} offset=${chunkInfo.sampleOffset ?? '-'} end=${chunkInfo.sampleEnd ?? '-'} lateSec=${plan.offsetSec.toFixed(4)} durSec=${plan.durationSec.toFixed(3)} parts=${segments.length} started=${plan.startedNow} isLast=${!!chunkInfo.isLast} t=${Date.now()}`);

    if (this.scheduler && this.scheduler.isWaiting) {
      await this.scheduler.resumeFromWait();
      if (this.isCurrent && getFragmentIsPlaying() && !getFragmentPlayheadRaf()) playheadTick();
    }

    if (chunkInfo.isLast && this.scheduler) {
      console.log(`[FragPlay] LAST CHUNK RECEIVED | session=${this.id} offset=${chunkInfo.sampleOffset ?? '-'} end=${chunkInfo.sampleEnd ?? '-'} t=${Date.now()}`);
      this.scheduler.markLastReceived();
    }
    this._maybeFinish();
  }

  setInferenceDone() {
    this.inferenceDone = true;
    if (!this.scheduler) return Promise.resolve();
    return this.scheduler.setInferenceDone();
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
    if (!this.streamStarted) return;
    const sched = this.scheduler;
    if (!sched) return;
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
    if (sched.isWaiting && sched.inferenceDone) {
      sched.resumeFromWait().then(() => {
        if (this.isCurrent && getFragmentIsPlaying() && !getFragmentPlayheadRaf()) playheadTick();
      });
      return;
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
}