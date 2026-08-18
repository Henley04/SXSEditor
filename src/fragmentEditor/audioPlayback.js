// B2: wavEncoder.js is now CommonJS — use require instead of ESM import.
const { encodeWav, applyEnvelopesToAudio } = require('../audio/wavEncoder.js');
import { showAlertDialog } from '../alertDialog.js';
import { t } from '../i18n/index.js';
import { initPipeline, getFragmentPreviewInferenceOptions, getFragmentExportInferenceOptions } from './pipeline.js';
import {
  getSampleRate,
  getFragmentAudioContext, setFragmentAudioContext,
  getFragmentAudioSource, setFragmentAudioSource,
  getFragmentAudioData, setFragmentAudioData,
  getFragmentIsPlaying, setFragmentIsPlaying,
  getFragmentIsSynthesizing, setFragmentIsSynthesizing,
  getFragmentIsExporting, setFragmentIsExporting,
  getFragmentPlaybackStartTime, setFragmentPlaybackStartTime,
  getFragmentPlaybackOffset, setFragmentPlaybackOffset,
  getFragmentPlayheadRaf, setFragmentPlayheadRaf,
  getFragmentCurrentTime, setFragmentCurrentTime,
  getFragmentGainNode, setFragmentGainNode,
  getFragmentUseExclusiveMode, setFragmentUseExclusiveMode,
  getFragmentExclusiveRaf, setFragmentExclusiveRaf,
  getFragmentAudioSettings, setFragmentAudioSettings,
  getFragmentPlayStartPosition, setFragmentPlayStartPosition,
  getFragmentAudioDataSignature, setFragmentAudioDataSignature,
  getPipelineInitialized,
  getWavFileBuffer,
  getCurrentProject,
  getCurrentFragment,
  getEnvelopes,
} from './state.js';
import { getClippedNotes, buildPitchCurveF0Data, render } from './canvasRenderer.js';
import { updateFragmentPlayButton } from './uiControls.js';

/**
 * 构建导出用的 per-note 渐入/渐出列表（与 wavEncoder.applyEnvelopesToAudio 对接）。
 * 跳过 fadeIn=0 且 fadeOut=0 的 note，节省计算。
 * 时间单位：start/duration 用 beats，fadeIn/fadeOut 用秒。
 */
function _buildNoteFadesForExport() {
  const notes = getClippedNotes();
  const out = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const fadeInSec = (n.fadeIn && n.fadeIn > 0) ? n.fadeIn / 1000 : 0;
    const fadeOutSec = (n.fadeOut && n.fadeOut > 0) ? n.fadeOut / 1000 : 0;
    if (fadeInSec <= 0 && fadeOutSec <= 0) continue;
    out.push({
      startBeat: n.start,
      durationBeats: n.duration,
      fadeInSec,
      fadeOutSec,
    });
  }
  return out;
}

/**
 * 计算实时播放时 per-note 渐入/渐出的 WebAudio 自动化调度参数。
 * 返回 [{ atSec, rampEndSec, fromGain, toGain }] 列表，由调用方 setValueAtTime /
 * linearRampToValueAtTime 应用到 fadeGainNode。
 * 仅包含 fadeIn>0 或 fadeOut>0 的 note。
 *
 * 重要：fadeOut 后增益会停留在 0，导致后续无 fadeIn 的音符静音。
 * 调用方 _scheduleFadeAutomation 会在每个 fadeOut ramp 结束后插入恢复事件
 * (setValueAtTime(1, rampEndSec)) 把增益拉回 1。
 */
function _buildNoteFadesForRealtime(bpm) {
  const notes = getClippedNotes();
  const out = [];
  const secondsPerBeat = 60 / bpm;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const noteStartSec = n.start * secondsPerBeat;
    const noteEndSec = noteStartSec + n.duration * secondsPerBeat;
    if (n.fadeIn && n.fadeIn > 0) {
      const fadeInSec = n.fadeIn / 1000;
      out.push({
        atSec: noteStartSec,
        rampEndSec: noteStartSec + fadeInSec,
        fromGain: 0,
        toGain: 1,
      });
    }
    if (n.fadeOut && n.fadeOut > 0) {
      const fadeOutSec = n.fadeOut / 1000;
      out.push({
        atSec: Math.max(noteStartSec, noteEndSec - fadeOutSec),
        rampEndSec: noteEndSec,
        fromGain: 1,
        toGain: 0,
      });
    }
  }
  return out;
}

/**
 * 将 fade 事件调度到 fadeGainNode 上。
 *
 * 修复 fadeOut 静音 bug：fadeOut ramp 把增益降到 0 后，如果后续音符没有 fadeIn，
 * 增益会一直保持 0，导致后续音符完全静音。解决方案是在每个 fadeOut ramp 结束后
 * 立即调度 setValueAtTime(1, rampEndSec) 把增益恢复为 1。
 *
 * 事件顺序保证：WebAudio 同一时刻的事件按调度顺序处理。fadeOut 的 restore 事件
 * 在 fadeOut ramp 之后调度，若下一个 fadeIn 的 setValueAtTime(0, noteStartSec)
 * 在 restore 之后调度且 noteStartSec === rampEndSec，则 gain 最终为 0（fadeIn 正确）。
 * 若后续无 fadeIn，gain 保持 1（正确）。
 *
 * 注意：重叠音符场景下，单增益节点无法同时表达多个音符的独立 fade。
 * 导出路径 (wavEncoder) 对重叠音符的 fade gain 做乘积，实时路径用单增益曲线，
 * 两者行为在重叠时不同。非重叠 SVS 场景（正常情况）两者一致。
 */
function _scheduleFadeAutomation(fadeGainNode, ctx, fades, startOffset) {
  if (!fades || fades.length === 0) return;
  const now = ctx.currentTime;
  fadeGainNode.gain.setValueAtTime(1, now);
  // 按 atSec 排序，确保 restore 事件与后续 fadeIn 事件的调度顺序正确
  const sorted = [...fades].sort((a, b) => a.atSec - b.atSec);
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    // 仅调度 startOffset 之后的事件；起播位置之前的自动化直接跳过
    if (f.rampEndSec <= startOffset) continue;
    const atSec = Math.max(f.atSec, startOffset);
    const fromGain = f.atSec <= startOffset
      // 起播位置落在 fade 内：估算起播点处的 gain
      ? (f.toGain - f.fromGain) * Math.max(0, Math.min(1, (startOffset - f.atSec) / Math.max(0.0001, f.rampEndSec - f.atSec))) + f.fromGain
      : f.fromGain;
    fadeGainNode.gain.setValueAtTime(fromGain, now + (atSec - startOffset));
    fadeGainNode.gain.linearRampToValueAtTime(f.toGain, now + (f.rampEndSec - startOffset));
    // fadeOut 结束后恢复增益为 1，防止后续音符静音
    if (f.toGain === 0) {
      fadeGainNode.gain.setValueAtTime(1, now + (f.rampEndSec - startOffset));
    }
  }
}

/**
 * 对单声道音频就地应用 per-note fade（用于独占模式，该模式不经 WebAudio 图）。
 * 逻辑与 wavEncoder.applyEnvelopesToAudio 的 fade 部分一致：每个音符在自己的
 * 采样区间内施加 fadeIn/fadeOut 包络，区间外保持 1。重叠音符的 gain 做乘积。
 * 返回新的 Float32Array（不修改输入）。
 */
function _applyFadesToMonoAudio(audioData, bpm) {
  const notes = getClippedNotes();
  const fades = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const fadeInSec = (n.fadeIn && n.fadeIn > 0) ? n.fadeIn / 1000 : 0;
    const fadeOutSec = (n.fadeOut && n.fadeOut > 0) ? n.fadeOut / 1000 : 0;
    if (fadeInSec <= 0 && fadeOutSec <= 0) continue;
    fades.push({
      startBeat: n.start,
      durationBeats: n.duration,
      fadeInSec,
      fadeOutSec,
    });
  }
  if (fades.length === 0) return audioData;

  const sampleRate = getSampleRate();
  const numSamples = audioData.length;
  const out = new Float32Array(numSamples);
  out.set(audioData);
  const secondsPerBeat = 60 / bpm;
  for (let f = 0; f < fades.length; f++) {
    const nf = fades[f];
    const noteStartSec = nf.startBeat * secondsPerBeat;
    const noteDurSec = nf.durationBeats * secondsPerBeat;
    const noteEndSec = noteStartSec + noteDurSec;
    const startSample = Math.max(0, Math.floor(noteStartSec * sampleRate));
    const endSample = Math.min(numSamples, Math.ceil(noteEndSec * sampleRate));
    const fadeInSamples = Math.max(1, Math.floor(nf.fadeInSec * sampleRate));
    const fadeOutSamples = Math.max(1, Math.floor(nf.fadeOutSec * sampleRate));
    for (let i = startSample; i < endSample; i++) {
      let g = 1;
      if (nf.fadeInSec > 0 && i < startSample + fadeInSamples) {
        g = (i - startSample) / fadeInSamples;
      }
      if (nf.fadeOutSec > 0 && i > endSample - fadeOutSamples) {
        const fo = Math.max(0, (endSample - i) / fadeOutSamples);
        if (fo < g) g = fo;
      }
      if (g < 0) g = 0;
      if (g > 1) g = 1;
      out[i] *= g;
    }
  }
  return out;
}

// 流式播放状态（vocoder chunk 边合成边播放）
// streamingSources: 已调度的 AudioBufferSourceNode 列表（按顺序）
// streamingCleanup: chunk 监听器 cleanup 函数
// streamingFadeGainNode: 流式播放共享的 fade 增益节点，所有 chunk source 经它
//   连接到 master gain。首个 chunk 到达时创建并调度 fade 自动化，使流式播放
//   也应用 per-note fade（与 playFragmentShared 一致）。
let streamingSources = [];
let streamingCleanup = null;
let streamingNextStart = 0;
let streamingFinished = false;
let streamingFadeGainNode = null;

// Buffer underrun protection (ported from renderer/audioPlayback.js).
// When inference is slower than realtime playback, the playhead catches up
// to the furthest received audio. Without protection, the playhead keeps
// advancing through silence and/or chunks are scheduled at wrong times.
// These variables track the buffer frontier and waiting state to pause
// the playhead until the next chunk arrives, then auto-resume.
let _streamingStarted = false;            // true after first chunk initializes playback
let _streamingBufferEndSec = 0;          // Furthest chunk end in playhead seconds
let _streamingInferenceDone = false;     // synthesizeFragmentSVS IPC returned
let _streamingWaitingForInference = false;
let _streamingIsLastReceived = false;    // isLast chunk has been received
let _streamingActiveSourceCount = 0;     // Currently-playing source count
let _streamingFirstChunkAudioOffset = 0; // playStartPosition > firstNoteStartSec 时需跳过的前导音频秒数

/**
 * 检查流式播放是否已完成（isLast 已收到且无活跃 source）。
 * 用于 onended 回调和跳过整个 chunk（无 source 创建）两种场景。
 */
function _checkStreamingComplete() {
  if (_streamingIsLastReceived &&
      _streamingActiveSourceCount <= 0 &&
      !streamingFinished) {
    streamingFinished = true;
    setFragmentIsPlaying(false);
    const raf = getFragmentPlayheadRaf();
    if (raf) { cancelAnimationFrame(raf); setFragmentPlayheadRaf(null); }
    setFragmentCurrentTime(0);
    setFragmentPlayStartPosition(0);
    updateFragmentPlayButton();
    render();
  }
}

// visibilitychange handler: pause rAF-driven UI updates when tab hidden
// (audio playback continues via WebAudio/WASAPI in background).
// Registered once per module; update fns stored for resume.
let _visibilityHandlerRegistered = false;
let _exclusiveUpdateFn = null;
let _sharedUpdateFn = null;

function _ensureVisibilityHandler() {
  if (_visibilityHandlerRegistered) return;
  _visibilityHandlerRegistered = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const exclusiveRaf = getFragmentExclusiveRaf();
      if (exclusiveRaf) {
        cancelAnimationFrame(exclusiveRaf);
        setFragmentExclusiveRaf(null);
      }
      const sharedRaf = getFragmentPlayheadRaf();
      if (sharedRaf) {
        cancelAnimationFrame(sharedRaf);
        setFragmentPlayheadRaf(null);
      }
    } else {
      if (getFragmentIsPlaying() && getFragmentUseExclusiveMode() && _exclusiveUpdateFn && !getFragmentExclusiveRaf()) {
        setFragmentExclusiveRaf(requestAnimationFrame(_exclusiveUpdateFn));
      } else if (getFragmentIsPlaying() && !getFragmentUseExclusiveMode() && _sharedUpdateFn && !getFragmentPlayheadRaf()) {
        setFragmentPlayheadRaf(requestAnimationFrame(_sharedUpdateFn));
      }
    }
  });
}

function stopStreamingPlayback() {
  // 与主页面 stopPlayback 语义一致：设 streamingFinished=true 拦截已在事件队列中
  // 排队的 onChunkAudio 回调（IPC 监听器虽已移除，但已派发的回调仍可能到达）。
  // playFragment 开头会显式重置为 false 启动新一轮流式合成。
  streamingFinished = true;
  _streamingStarted = false;
  _streamingBufferEndSec = 0;
  _streamingInferenceDone = false;
  _streamingWaitingForInference = false;
  _streamingIsLastReceived = false;
  _streamingActiveSourceCount = 0;
  _streamingFirstChunkAudioOffset = 0;
  for (const src of streamingSources) {
    if (!src) continue;  // 已 onended 释放的中间 chunk 跳过
    try { src.onended = null; src.stop(); } catch (_) {}
  }
  streamingSources = [];
  if (streamingCleanup) {
    try { streamingCleanup(); } catch (_) {}
    streamingCleanup = null;
  }
  // 断开并释放流式 fade 增益节点
  if (streamingFadeGainNode) {
    try { streamingFadeGainNode.disconnect(); } catch (_) {}
    streamingFadeGainNode = null;
  }
}

export async function getFragmentAudioContextInternal() {
  let ctx = getFragmentAudioContext();
  if (!ctx || ctx.state === 'closed') {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: getSampleRate() });
    setFragmentAudioContext(ctx);
    const gainNode = ctx.createGain();
    gainNode.connect(ctx.destination);
    setFragmentGainNode(gainNode);
    await applyFragmentAudioSettings();
  }
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
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

async function applyFragmentAudioSettings() {
  const settings = getFragmentAudioSettings();
  if (!settings) return;

  const gainNode = getFragmentGainNode();
  if (gainNode && settings.audioVolume !== undefined) {
    gainNode.gain.value = settings.audioVolume;
  }

  const ctx = getFragmentAudioContext();
  if (ctx && settings.audioOutputDevice !== undefined && settings.audioOutputDevice !== -1) {
    const sinkId = String(settings.audioOutputDevice);
    if (ctx.setSinkId && typeof ctx.setSinkId === 'function') {
      try {
        await ctx.setSinkId(sinkId);
      } catch (err) {
        console.warn('[FragmentAudio] 设置输出设备失败:', err.message);
      }
    }
  }
}

export function stopFragmentPlayback() {
  // 清理流式播放（边合成边播的 chunk sources）
  stopStreamingPlayback();
  const source = getFragmentAudioSource();
  if (source) {
    try {
      source.onended = null;
      source.stop();
    } catch (_e) {}
    setFragmentAudioSource(null);
  }
  stopFragmentExclusivePlayback();
  setFragmentIsPlaying(false);
  const raf = getFragmentPlayheadRaf();
  if (raf) {
    cancelAnimationFrame(raf);
    setFragmentPlayheadRaf(null);
  }
  updateFragmentPlayButton();
}

/**
 * 播放中拖拽 playhead 时跳转到新位置。
 * 不重新合成：直接复用已缓存的 fragmentAudioData，从 newStartTime 开始播放。
 * 需要先停止当前播放（source.stop / audioStop），再用现有 audioData 重启。
 */
export async function seekFragmentPlayback(newStartTime) {
  // 停止当前播放（不重置 playStartPosition）
  stopStreamingPlayback();
  const source = getFragmentAudioSource();
  if (source) {
    try { source.onended = null; source.stop(); } catch (_e) {}
    setFragmentAudioSource(null);
  }
  stopFragmentExclusivePlayback();
  setFragmentIsPlaying(false);
  const raf = getFragmentPlayheadRaf();
  if (raf) {
    cancelAnimationFrame(raf);
    setFragmentPlayheadRaf(null);
  }

  // 设置新的起始位置
  setFragmentPlayStartPosition(newStartTime);

  // 复用已缓存的 audioData 重启播放
  const audioData = getFragmentAudioData();
  if (!audioData || audioData.length === 0) return;

  if (getFragmentUseExclusiveMode()) {
    await playFragmentExclusive();
  } else {
    await playFragmentShared();
  }
}

function stopFragmentExclusivePlayback() {
  const raf = getFragmentExclusiveRaf();
  if (raf) {
    cancelAnimationFrame(raf);
    setFragmentExclusiveRaf(null);
  }
  window.electronAPI.audioStop().catch(() => {});
}

export function updateFragmentPlayhead() {
  _ensureVisibilityHandler();
  _sharedUpdateFn = updateFragmentPlayhead;
  if (!getFragmentIsPlaying()) return;
  const ctx = getFragmentAudioContext();
  if (!ctx) return;

  const elapsed = ctx.currentTime - getFragmentPlaybackStartTime();
  setFragmentCurrentTime(getFragmentPlaybackOffset() + elapsed);

  // Buffer underrun detection: when the playhead reaches the furthest
  // received audio position (_streamingBufferEndSec) and inference is not
  // yet complete, freeze the playhead and show "waiting for inference".
  // This prevents the playhead from advancing through silence when chunks
  // arrive slower than realtime playback. When the next chunk arrives, the
  // chunk callback will reset _streamingWaitingForInference and resume.
  if (_streamingStarted && !_streamingInferenceDone && !_streamingWaitingForInference) {
    if (getFragmentCurrentTime() >= _streamingBufferEndSec) {
      _streamingWaitingForInference = true;
      // Freeze playhead at buffer frontier (not at elapsed which has
      // already advanced past the received audio into silence)
      setFragmentCurrentTime(_streamingBufferEndSec);
      const raf = getFragmentPlayheadRaf();
      if (raf) { cancelAnimationFrame(raf); setFragmentPlayheadRaf(null); }
      render();
      return;
    }
  }

  // 流式播放期间跳过 duration 检查：
  // setFragmentAudioData 在 synthesizeFragmentSVS 返回后才更新，流式期间
  // getFragmentAudioData 返回上一次合成的旧 audioData，旧 duration 可能短于
  // 当前流式时长，导致 currentTime >= duration 误判并提前 stopFragmentPlayback。
  // 流式结束由 source.onended 计数判定触发，不依赖此处的 duration 检查。
  const audioData = getFragmentAudioData();
  if (audioData && !_streamingStarted) {
    const duration = audioData.length / getSampleRate();
    if (getFragmentCurrentTime() >= duration) {
      stopFragmentPlayback();
      setFragmentCurrentTime(0);
      setFragmentPlayStartPosition(0);
    }
  }

  render();

  setFragmentPlayheadRaf(requestAnimationFrame(updateFragmentPlayhead));
}

async function playFragmentShared() {
  const ctx = await getFragmentAudioContextInternal();
  const audioData = getFragmentAudioData();
  const audioBuffer = ctx.createBuffer(1, audioData.length, getSampleRate());
  audioBuffer.getChannelData(0).set(audioData);
  stopFragmentPlayback();
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;

  const envGainNode = ctx.createGain();
  const fadeGainNode = ctx.createGain();
  const panNode = ctx.createStereoPanner();

  const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
  const audioDuration = audioData.length / getSampleRate();
  const envelopes = getEnvelopes();
  const volumeEnv = envelopes.volume;
  const panEnv = envelopes.pan;

  // 播放起始位置（秒），由用户拖拽 playhead 设置
  const startOffset = Math.min(getFragmentPlayStartPosition(), audioDuration - 0.01);

  if (volumeEnv && volumeEnv.keyframes && volumeEnv.keyframes.length > 0) {
    const now = ctx.currentTime;
    const sortedKfs = [...volumeEnv.keyframes].sort((a, b) => a.time - b.time);
    // 从 startOffset 处的包络值开始
    const startVal = _interpolateEnvValue(sortedKfs, startOffset);
    envGainNode.gain.setValueAtTime(startVal, now);
    for (let i = 0; i < sortedKfs.length; i++) {
      const kf = sortedKfs[i];
      const timeSec = (kf.time / bpm) * 60;
      if (timeSec > startOffset && timeSec <= audioDuration) {
        envGainNode.gain.linearRampToValueAtTime(kf.value, now + (timeSec - startOffset));
      }
    }
    const lastKf = sortedKfs[sortedKfs.length - 1];
    const lastTimeSec = (lastKf.time / bpm) * 60;
    if (lastTimeSec < audioDuration) {
      envGainNode.gain.linearRampToValueAtTime(lastKf.value, now + (audioDuration - startOffset));
    }
  }

  // Per-note 渐入/渐出（与导出时 wavEncoder.applyEnvelopesToAudio 一致）：
  // fadeGainNode 接在 envGainNode 之后、panNode 之前，作为片段级音量包络之外的
  // per-note amplitude 调制。仅当某 note 启用 fade 时才调度自动化，否则保持 1。
  // _scheduleFadeAutomation 会在每个 fadeOut 后恢复增益为 1，防止后续音符静音。
  const fades = _buildNoteFadesForRealtime(bpm);
  if (fades.length > 0) {
    _scheduleFadeAutomation(fadeGainNode, ctx, fades, startOffset);
  }

  if (panEnv && panEnv.keyframes && panEnv.keyframes.length > 0) {
    const now = ctx.currentTime;
    const sortedKfs = [...panEnv.keyframes].sort((a, b) => a.time - b.time);
    const startVal = _interpolateEnvValue(sortedKfs, startOffset);
    panNode.pan.setValueAtTime(startVal, now);
    for (let i = 0; i < sortedKfs.length; i++) {
      const kf = sortedKfs[i];
      const timeSec = (kf.time / bpm) * 60;
      if (timeSec > startOffset && timeSec <= audioDuration) {
        panNode.pan.linearRampToValueAtTime(kf.value, now + (timeSec - startOffset));
      }
    }
    const lastKf = sortedKfs[sortedKfs.length - 1];
    const lastTimeSec = (lastKf.time / bpm) * 60;
    if (lastTimeSec < audioDuration) {
      panNode.pan.linearRampToValueAtTime(lastKf.value, now + (audioDuration - startOffset));
    }
  }

  const gainNode = getFragmentGainNode();
  source.connect(envGainNode).connect(fadeGainNode).connect(panNode).connect(gainNode);
  source.onended = () => {
    setFragmentIsPlaying(false);
    const raf = getFragmentPlayheadRaf();
    if (raf) {
      cancelAnimationFrame(raf);
      setFragmentPlayheadRaf(null);
    }
    setFragmentCurrentTime(0);
    setFragmentPlayStartPosition(0);
    updateFragmentPlayButton();
    render();
  };
  // source.start(when, offset) — offset 是音频缓冲区内的时间偏移
  source.start(0, Math.max(0, startOffset));
  setFragmentAudioSource(source);
  setFragmentIsPlaying(true);
  setFragmentPlaybackStartTime(ctx.currentTime);
  setFragmentPlaybackOffset(startOffset);
  setFragmentCurrentTime(startOffset);
  updateFragmentPlayhead();
  updateFragmentPlayButton();
}

/**
 * 线性插值计算 envelope 在指定时间的值（用于播放起始偏移处的包络初始化）。
 * sortedKfs 必须已按 time 升序排序。time 单位为秒。
 */
function _interpolateEnvValue(sortedKfs, timeSec) {
  if (!sortedKfs || sortedKfs.length === 0) return 1;
  if (sortedKfs.length === 1) return sortedKfs[0].value;
  if (timeSec <= sortedKfs[0].time) return sortedKfs[0].value;
  if (timeSec >= sortedKfs[sortedKfs.length - 1].time) return sortedKfs[sortedKfs.length - 1].value;
  for (let i = 0; i < sortedKfs.length - 1; i++) {
    if (timeSec >= sortedKfs[i].time && timeSec <= sortedKfs[i + 1].time) {
      const t = (timeSec - sortedKfs[i].time) / (sortedKfs[i + 1].time - sortedKfs[i].time);
      return sortedKfs[i].value + t * (sortedKfs[i + 1].value - sortedKfs[i].value);
    }
  }
  return sortedKfs[sortedKfs.length - 1].value;
}

async function playFragmentExclusive() {
  stopFragmentPlayback();

  try {
    const settings = getFragmentAudioSettings();
    const rawAudioData = getFragmentAudioData();
    const audioDuration = rawAudioData.length / getSampleRate();
    // 播放起始位置（秒），由用户拖拽 playhead 设置
    const startOffset = Math.min(getFragmentPlayStartPosition(), audioDuration - 0.01);
    // 独占模式不经 WebAudio 图，无法用 gain 自动化应用 per-note fade。
    // 在传入 audioPlay 前对音频数据预乘 fade gain（与导出路径逻辑一致）。
    const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
    const audioData = _applyFadesToMonoAudio(rawAudioData, bpm);
    const options = {
      deviceId: settings?.audioOutputDevice ?? -1,
      sampleRate: settings?.audioSampleRate ?? getSampleRate(),
      sourceSampleRate: getSampleRate(),
      channels: 1,
      bitDepth: settings?.audioBitDepth ?? 'float32',
      bufferSize: settings?.audioBufferSize ?? 1024,
      exclusiveMode: true,
      volume: settings?.audioVolume ?? 1.0,
      offset: Math.max(0, startOffset),
    };

    const result = await window.electronAPI.audioPlay(audioData, options);

    if (!result.success) {
      console.warn('[FragmentAudio] WASAPI 独占模式失败，回退到共享模式:', result.error);
      setFragmentUseExclusiveMode(false);
      await playFragmentShared();
      return;
    }

    setFragmentIsPlaying(true);
    setFragmentPlaybackStartTime(performance.now());
    setFragmentPlaybackOffset(startOffset);
    setFragmentCurrentTime(startOffset);

    const removeEndedListener = window.electronAPI.onAudioEnded(() => {
      setFragmentIsPlaying(false);
      const raf = getFragmentPlayheadRaf();
      if (raf) {
        cancelAnimationFrame(raf);
        setFragmentPlayheadRaf(null);
      }
      setFragmentCurrentTime(0);
      setFragmentPlayStartPosition(0);
      updateFragmentPlayButton();
      render();
    });

    updateFragmentExclusivePlayhead(removeEndedListener);
    updateFragmentPlayButton();
  } catch (err) {
    console.error('[FragmentAudio] 独占模式启动失败，回退到共享模式:', err);
    setFragmentUseExclusiveMode(false);
    await playFragmentShared();
  }
}

function updateFragmentExclusivePlayhead(removeEndedListener) {
  _ensureVisibilityHandler();
  function update() {
    _exclusiveUpdateFn = update;
    if (!getFragmentIsPlaying()) {
      if (removeEndedListener) removeEndedListener();
      return;
    }

    const elapsed = (performance.now() - getFragmentPlaybackStartTime()) / 1000 + getFragmentPlaybackOffset();
    const audioData = getFragmentAudioData();
    const duration = audioData ? audioData.length / getSampleRate() : 0;

    if (elapsed >= duration) {
      setFragmentIsPlaying(false);
      setFragmentCurrentTime(0);
      setFragmentPlayStartPosition(0);
      stopFragmentExclusivePlayback();
      const raf = getFragmentPlayheadRaf();
      if (raf) {
        cancelAnimationFrame(raf);
        setFragmentPlayheadRaf(null);
      }
      updateFragmentPlayButton();
      render();
      if (removeEndedListener) removeEndedListener();
      return;
    }

    setFragmentCurrentTime(elapsed);
    render();
    setFragmentExclusiveRaf(requestAnimationFrame(update));
  }

  _exclusiveUpdateFn = update;
  setFragmentExclusiveRaf(requestAnimationFrame(update));
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
    ? Math.floor((clippedNotes[0].start / bpm) * 60 * getSampleRate())
    : 0;
  const requiredLength = Math.max(expectedSamples, firstNoteOffsetSample + audioData.length);
  if (requiredLength <= audioData.length && firstNoteOffsetSample === 0) return audioData;
  const padded = new Float32Array(requiredLength);
  padded.set(audioData, firstNoteOffsetSample);
  return padded;
}

/**
 * 计算当前 fragment 合成输入的签名（notes + 选项）。
 * 与服务端 computeSynthCacheKey 覆盖的字段一致：notes 内容、bpm、pitchCurveF0、
 * refAudioWavBuffer 长度、autoShift、nSteps、cfg、cfgRescale、singerId。
 * 用于判断 fragmentAudioData 是否可复用，避免重复 IPC 合成调用。
 * 注意：签名不包含 playStartPosition — 起始位置变化不影响音频内容。
 */
function _computeFragmentAudioSignature() {
  const notes = getClippedNotes();
  const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
  const previewOpts = getFragmentPreviewInferenceOptions();
  const pitchCurveF0 = buildPitchCurveF0Data();
  const refAudioWavBuffer = getWavFileBuffer();
  const autoShiftEl = document.getElementById('autoShiftCheck');
  const autoShift = autoShiftEl ? autoShiftEl.checked : false;
  const singerId = getCurrentFragment()?.singerId || null;

  // notes hash — 与服务端 computeSynthCacheKey 保持一致的字段拼接
  let notesHash = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    let s = `${n.lyric || ''}|${n.pitch}|${n.start}|${n.duration}|${n.isSlur ? 1 : 0}|${n.isContinuation ? 1 : 0}`;
    if (n.phonemeAdjustments) {
      for (const adj of n.phonemeAdjustments) {
        s += `|dr:${adj.durationRatio}|or:${adj.offsetRatio || 0}`;
        if (adj.volumePoints) {
          for (const vp of adj.volumePoints) {
            s += `:${vp.t}:${vp.v}`;
          }
        }
      }
    }
    // 颤音字段进入签名：颤音改变 F0，必须重新合成
    if (n.vibrato && n.vibrato.enabled) {
      s += `|vib:${n.vibrato.enabled ? 1 : 0}:${n.vibrato.depth}:${n.vibrato.rate}:${n.vibrato.start}:${n.vibrato.length}:${n.vibrato.fadeIn}`;
    }
    for (let j = 0; j < s.length; j++) {
      notesHash = ((notesHash << 5) - notesHash + s.charCodeAt(j)) | 0;
    }
  }

  // pitchCurveF0 hash
  let f0Hash = 0;
  if (pitchCurveF0) {
    const step = Math.max(1, Math.floor(pitchCurveF0.length / 4000));
    for (let i = 0; i < pitchCurveF0.length; i += step) {
      f0Hash = ((f0Hash << 5) - f0Hash + (Math.floor(pitchCurveF0[i] * 1000) | 0)) | 0;
    }
  }

  // refAudioWavBuffer hash — 仅用长度，避免对大 buffer 做完整哈希
  const refHash = refAudioWavBuffer
    ? (refAudioWavBuffer.byteLength || refAudioWavBuffer.length || 0)
    : 0;

  return `${notesHash}_${bpm}_${f0Hash}_${refHash}_${previewOpts.nSteps}_${previewOpts.cfg}_${previewOpts.cfgRescale}_${autoShift}_${singerId || 'noid'}_${previewOpts.diffStepChunk ? 1 : 0}_${previewOpts.diffStepChunkFrames || 500}_${previewOpts.diffStepOverlapFrames !== undefined ? previewOpts.diffStepOverlapFrames : 50}`;
}

export async function playFragment() {
  // 重入保护：防止连续调用导致前一次 finally 提前把 fragmentIsSynthesizing
  // 置 false，使后续进度回调失效（进度百分比偶发不显示的根因之一）。
  if (getFragmentIsSynthesizing() || getFragmentIsExporting()) return;
  setFragmentIsSynthesizing(true);
  updateFragmentPlayButton();
  // 清理上一次流式播放状态
  stopStreamingPlayback();
  streamingFinished = false;
  streamingSources = [];
  streamingNextStart = 0;
  _streamingStarted = false;
  _streamingBufferEndSec = 0;
  _streamingInferenceDone = false;
  _streamingWaitingForInference = false;
  _streamingIsLastReceived = false;
  _streamingActiveSourceCount = 0;
  _streamingFirstChunkAudioOffset = 0;

  try {
    if (!getPipelineInitialized()) {
      await initPipeline();
    }

    await loadFragmentAudioSettings();

    // 缓存优化：计算当前合成输入签名，若与上次相同且已有 fragmentAudioData，
    // 直接复用缓存音频从 playStartPosition 开始播放，跳过 IPC 合成调用。
    // 这样即使起始位置不同，只要 notes/options 未变就能秒播。
    const currentSignature = _computeFragmentAudioSignature();
    const cachedAudio = getFragmentAudioData();
    const canReuseCache = cachedAudio && cachedAudio.length > 0 &&
                         getFragmentAudioDataSignature() === currentSignature;

    if (canReuseCache) {
      // 复用缓存：无需注册 chunk 监听，直接整段播放
      setFragmentUseExclusiveMode(getFragmentAudioSettings()?.audioOutputMode === 'exclusive');
      if (getFragmentUseExclusiveMode()) {
        await playFragmentExclusive();
      } else {
        await playFragmentShared();
      }
      return;
    }

    // 注册 chunk 监听：vocoder 每完成一个 chunk 即开始播放（边合成边播）
    // chunk 顺序由 IPC 保证（按发送顺序触发），无需额外排序
    streamingCleanup = window.electronAPI.onFragmentSVSChunkAudio(async (chunkInfo) => {
      try {
        if (!chunkInfo || !chunkInfo.audio || chunkInfo.audio.length === 0) return;
        if (streamingFinished) return;
        const ctx = await getFragmentAudioContextInternal();
        if (streamingFinished) return; // re-check after async: may have been stopped

        // 第一个 chunk 初始化播放：计算首音符偏移和播放起始位置
        // chunk 音频从 filledNotes[0].start（首音符起点）开始，pipeline 已截掉前导休止符。
        // 需要让播放头从 playStartPosition 开始移动，而非直接跳到 firstNoteStartSec。
        if (!_streamingStarted) {
          _streamingStarted = true;
          const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
          const clippedNotes = getClippedNotes();
          const firstNoteStartSec = clippedNotes.length > 0
            ? (clippedNotes[0].start / bpm) * 60
            : 0;
          const playStartPosition = getFragmentPlayStartPosition();

          // chunk 音频从 firstNoteStartSec 开始，播放头从 playStartPosition 开始：
          // - playStartPosition < firstNoteStartSec：延迟 chunk 播放，让播放头先走完
          //   前导静音段，到达 firstNoteStartSec 时音频正好开始。
          // - playStartPosition > firstNoteStartSec：跳过 chunk 内前导音频（下方处理）。
          let chunkDelaySec = 0;
          if (playStartPosition < firstNoteStartSec) {
            chunkDelaySec = firstNoteStartSec - playStartPosition;
          } else if (playStartPosition > firstNoteStartSec) {
            _streamingFirstChunkAudioOffset = playStartPosition - firstNoteStartSec;
          }
          streamingNextStart = ctx.currentTime + 0.05 + chunkDelaySec;

          // per-note fade：atSec 是相对 fragment 起点的绝对时间，
          // startOffset 传 playStartPosition 使起播位置之前的 fade 事件被跳过。
          const fades = _buildNoteFadesForRealtime(bpm);
          if (fades.length > 0) {
            streamingFadeGainNode = ctx.createGain();
            const masterGain = getFragmentGainNode();
            if (masterGain) streamingFadeGainNode.connect(masterGain);
            else streamingFadeGainNode.connect(ctx.destination);
            _scheduleFadeAutomation(streamingFadeGainNode, ctx, fades, playStartPosition);
          }
          setFragmentIsPlaying(true);
          setFragmentPlaybackStartTime(ctx.currentTime + 0.05);
          setFragmentPlaybackOffset(playStartPosition);
          setFragmentCurrentTime(playStartPosition);
          updateFragmentPlayButton();
          // 启动 playhead rAF 动画循环
          updateFragmentPlayhead();
        }

        // 处理 playStartPosition > firstNoteStartSec：跳过 chunk 前导音频
        let chunkAudio = chunkInfo.audio;
        if (_streamingFirstChunkAudioOffset > 0) {
          const skipSec = Math.min(_streamingFirstChunkAudioOffset, chunkAudio.length / getSampleRate());
          const skipSamples = Math.floor(skipSec * getSampleRate());
          if (skipSamples >= chunkAudio.length) {
            // 整个 chunk 都在跳过范围内：不创建 source，减少剩余偏移后跳过此 chunk
            _streamingFirstChunkAudioOffset -= chunkAudio.length / getSampleRate();
            // 仍需处理 isLast 标记
            if (chunkInfo.isLast) {
              _streamingIsLastReceived = true;
              _checkStreamingComplete();
            }
            return;
          }
          chunkAudio = chunkAudio.subarray(skipSamples);
          _streamingFirstChunkAudioOffset = 0;
        }

        const audioBuffer = ctx.createBuffer(1, chunkAudio.length, getSampleRate());
        audioBuffer.getChannelData(0).set(chunkAudio);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        const effectiveChunkDuration = chunkAudio.length / getSampleRate();

        // Buffer underrun protection: if the previous chunk's scheduled end
        // has already passed (inference was slower than realtime playback),
        // clamp streamingNextStart to currentTime + 0.05 to avoid scheduling
        // this chunk in the past (which Web Audio clamps to currentTime,
        // causing overlapping playback). Also reset the playhead time base
        // so the playhead jumps to the current chunk's position.
        if (streamingNextStart < ctx.currentTime + 0.01) {
          // Adjust playbackStartTime so the playhead aligns with this chunk's
          // start position (streamingNextStart relative to fragment playback).
          const offsetFromPlayStart = streamingNextStart - getFragmentPlaybackStartTime();
          setFragmentPlaybackStartTime(ctx.currentTime + 0.05 - offsetFromPlayStart);
          streamingNextStart = ctx.currentTime + 0.05;
          // Resume playhead animation if it was frozen by underrun detection
          if (_streamingWaitingForInference) {
            _streamingWaitingForInference = false;
            updateFragmentPlayhead();
          }
        }

        // Resume playhead if it was frozen by underrun detection but this
        // chunk's scheduled time is still in the future (no clamping needed).
        if (_streamingWaitingForInference) {
          _streamingWaitingForInference = false;
          setFragmentPlaybackStartTime(ctx.currentTime - _streamingBufferEndSec + getFragmentPlaybackOffset());
          updateFragmentPlayhead();
        }

        // Update buffer frontier (furthest audio end in playhead seconds)
        const chunkEndSec = (getFragmentPlaybackOffset() + (streamingNextStart - getFragmentPlaybackStartTime())) + effectiveChunkDuration;
        if (chunkEndSec > _streamingBufferEndSec) {
          _streamingBufferEndSec = chunkEndSec;
        }

        // chunk source 经 streamingFadeGainNode（如有）连接到 master gain，
        // 使流式播放也应用 per-note fade。无 fade 时直接连 master gain。
        if (streamingFadeGainNode) {
          source.connect(streamingFadeGainNode);
        } else {
          const gainNode = getFragmentGainNode();
          if (gainNode) source.connect(gainNode);
          else source.connect(ctx.destination);
        }
        source.start(streamingNextStart);
        streamingNextStart += effectiveChunkDuration;

        // Unified onended: decrement active source count and release reference.
        // When isLast has been received AND all sources have ended, mark
        // streaming complete. This is more robust than relying solely on the
        // isLast chunk's onended — if a non-last chunk (longer audio) is still
        // playing when the isLast chunk ends, we correctly wait for it.
        _streamingActiveSourceCount++;
        if (chunkInfo.isLast) {
          _streamingIsLastReceived = true;
        }
        const sourceIdx = streamingSources.length;
        streamingSources.push(source);
        source.onended = () => {
          _streamingActiveSourceCount--;
          if (streamingSources[sourceIdx] === source) {
            streamingSources[sourceIdx] = null;
          }
          _checkStreamingComplete();
        };
      } catch (e) {
        console.warn('[FragmentAudio] Streaming chunk playback failed:', e.message);
      }
    });

    const pitchCurveF0 = buildPitchCurveF0Data();
    const pitchCurveF0Serializable = pitchCurveF0 || null;

    const previewOpts = getFragmentPreviewInferenceOptions();

    const audioData = await window.electronAPI.synthesizeFragmentSVS({
      notes: getClippedNotes(),
      bpm: getCurrentProject() ? getCurrentProject().bpm : 120,
      options: {
        f0Envelope: null,
        pitchCurveF0: pitchCurveF0Serializable,
        refAudioWavBuffer: getWavFileBuffer() || null,
        singerId: getCurrentFragment()?.singerId || null,
        autoShift: document.getElementById('autoShiftCheck').checked,
        nSteps: previewOpts.nSteps,
        cfg: previewOpts.cfg,
        cfgRescale: previewOpts.cfgRescale,
        diffStepChunk: previewOpts.diffStepChunk,
        diffStepChunkFrames: previewOpts.diffStepChunkFrames,
        diffStepOverlapFrames: previewOpts.diffStepOverlapFrames,
        cfgScheduleMode: previewOpts.cfgScheduleMode,
        cfgStrengthStart: previewOpts.cfgStrengthStart,
        cfgScheduleKeyframes: previewOpts.cfgScheduleKeyframes,
        dynamicThresholdEnabled: previewOpts.dynamicThresholdEnabled,
        dynamicThresholdPercentile: previewOpts.dynamicThresholdPercentile,
      },
    });
    setFragmentAudioData(padAudioToFragmentDuration(audioData));
    // 合成成功后更新签名，后续播放可复用此缓存
    setFragmentAudioDataSignature(currentSignature);

    // 标记推理完成：后续不再触发 buffer underrun 等待
    _streamingInferenceDone = true;

    // 若合成返回时正在等待推理（最后一批 chunk 已收到但 playhead 仍冻结），
    // 恢复播放：调整 playbackStartTime 使 playhead 从 buffer 前沿继续。
    if (_streamingWaitingForInference && _streamingStarted) {
      _streamingWaitingForInference = false;
      const ctx = getFragmentAudioContext();
      if (ctx) {
        setFragmentPlaybackStartTime(ctx.currentTime - _streamingBufferEndSec + getFragmentPlaybackOffset());
        updateFragmentPlayhead();
      }
    }

    // 移除 chunk 监听（避免内存泄漏），但保留已调度的 source 继续播放。
    // 注意：必须在 _streamingInferenceDone 设置之后移除，否则 underrun 检测
    // 仍会等待（推理未完成标记）。
    if (streamingCleanup) {
      try { streamingCleanup(); } catch (_) {}
      streamingCleanup = null;
    }

    // 如果流式播放从未启动（如缓存命中或单 chunk 未触发回调），回退到整段播放。
    // 使用 _streamingStarted 而非 streamingSources.length 判断，避免异步竞态：
    // chunk 回调可能还在 await getFragmentAudioContextInternal() 中尚未 push source，
    // 但 _streamingStarted 已在第一个 chunk 到达时设置为 true。
    if (!_streamingStarted) {
      setFragmentUseExclusiveMode(getFragmentAudioSettings()?.audioOutputMode === 'exclusive');
      if (getFragmentUseExclusiveMode()) {
        await playFragmentExclusive();
      } else {
        await playFragmentShared();
      }
    }
  } catch (error) {
    console.error(t('fragment.synthesisFailed') + ':', error);
    // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
    showAlertDialog(t('fragment.synthesisFailedDetail', { detail: error.message }));
    stopStreamingPlayback();
  } finally {
    setFragmentIsSynthesizing(false);
    updateFragmentPlayButton();
  }
}

export async function exportFragment() {
  // 重入保护：与 playFragment 互斥，避免合成/导出并发导致状态错乱
  if (getFragmentIsSynthesizing() || getFragmentIsExporting()) return;
  const btnExportFragment = document.getElementById('btn-export-fragment');
  const originalText = btnExportFragment.textContent;
  btnExportFragment.disabled = true;
  btnExportFragment.textContent = t('fragment.exporting');
  setFragmentIsExporting(true);
  try {
    if (!getPipelineInitialized()) {
      await initPipeline();
    }

    await loadFragmentAudioSettings();

    const pitchCurveF0 = buildPitchCurveF0Data();
    const pitchCurveF0Serializable = pitchCurveF0 || null;

    const exportOpts = getFragmentExportInferenceOptions();

    const audioData = await window.electronAPI.synthesizeFragmentSVS({
      notes: getClippedNotes(),
      bpm: getCurrentProject() ? getCurrentProject().bpm : 120,
      options: {
        f0Envelope: null,
        pitchCurveF0: pitchCurveF0Serializable,
        refAudioWavBuffer: getWavFileBuffer() || null,
        singerId: getCurrentFragment()?.singerId || null,
        autoShift: document.getElementById('autoShiftCheck').checked,
        nSteps: exportOpts.nSteps,
        cfg: exportOpts.cfg,
        cfgRescale: exportOpts.cfgRescale,
      },
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
    // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
    showAlertDialog(t('fragment.exportFailedDetail', { detail: error.message }));
  } finally {
    setFragmentIsExporting(false);
    btnExportFragment.disabled = false;
    btnExportFragment.textContent = originalText;
  }
}
