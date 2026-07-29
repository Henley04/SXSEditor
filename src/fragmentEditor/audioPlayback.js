// B2: wavEncoder.js is now CommonJS — use require instead of ESM import.
const { encodeWav, applyEnvelopesToAudio } = require('../audio/wavEncoder.js');
import { showAlertDialog } from '../alertDialog.js';
import { t } from '../i18n/index.js';
import { initPipeline, getFragmentPreviewInferenceOptions, getFragmentExportInferenceOptions } from './pipeline.js';
import {
  getSampleRate, setSampleRate,
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
  getNotes,
  getSelectedNoteIds,
  getSelectedAnchorIndices,
  getPitchCurve,
  getDragMode, setDragMode,
  getPitchCurveSnapshotBeforeDrag, setPitchCurveSnapshotBeforeDrag,
  getEnvelopeSnapshotBeforeDrag, setEnvelopeSnapshotBeforeDrag,
  getPhonemeDragState,
  getParamEnvelopeDrag, setParamEnvelopeDrag,
  getPitchDragAnchorIdx, setPitchDragAnchorIdx,
  getPitchDragAnchorStarts,
  getIsBrushDrawing, setIsBrushDrawing,
  getCurrentBrushStroke, setCurrentBrushStroke,
  getDragNoteStarts,
  getDragOperation, setDragOperation,
} from './state.js';
import { getClippedNotes, buildPitchCurveF0Data, render } from './canvasRenderer.js';
import { updateFragmentPlayButton, updateParamModeButtons } from './uiControls.js';

// 流式播放状态（vocoder chunk 边合成边播放）
// streamingSources: 已调度的 AudioBufferSourceNode 列表（按顺序）
// streamingCleanup: chunk 监听器 cleanup 函数
let streamingSources = [];
let streamingCleanup = null;
let streamingNextStart = 0;
let streamingFinished = false;

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
  for (const src of streamingSources) {
    if (!src) continue;  // 已 onended 释放的中间 chunk 跳过
    try { src.onended = null; src.stop(); } catch (_) {}
  }
  streamingSources = [];
  if (streamingCleanup) {
    try { streamingCleanup(); } catch (_) {}
    streamingCleanup = null;
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
  } catch (e) {
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
    } catch (e) {}
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
    try { source.onended = null; source.stop(); } catch (e) {}
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

  // 流式播放期间跳过 duration 检查：
  // setFragmentAudioData 在 synthesizeFragmentSVS 返回后才更新，流式期间
  // getFragmentAudioData 返回上一次合成的旧 audioData，旧 duration 可能短于
  // 当前流式时长，导致 currentTime >= duration 误判并提前 stopFragmentPlayback。
  // 流式结束由末 chunk source.onended 触发，不依赖此处的 duration 检查。
  const audioData = getFragmentAudioData();
  if (audioData && streamingSources.length === 0) {
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
  source.connect(envGainNode).connect(panNode).connect(gainNode);
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
    const audioData = getFragmentAudioData();
    const audioDuration = audioData.length / getSampleRate();
    // 播放起始位置（秒），由用户拖拽 playhead 设置
    const startOffset = Math.min(getFragmentPlayStartPosition(), audioDuration - 0.01);
    const options = {
      deviceId: settings?.audioOutputDevice ?? -1,
      sampleRate: settings?.audioSampleRate ?? getSampleRate(),
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

  return `${notesHash}_${bpm}_${f0Hash}_${refHash}_${previewOpts.nSteps}_${previewOpts.cfg}_${previewOpts.cfgRescale}_${autoShift}_${singerId || 'noid'}`;
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
        const audioBuffer = ctx.createBuffer(1, chunkInfo.audio.length, getSampleRate());
        audioBuffer.getChannelData(0).set(chunkInfo.audio);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        const gainNode = getFragmentGainNode();
        if (gainNode) source.connect(gainNode);
        else source.connect(ctx.destination);

        // 第一个 chunk 立即播放，后续 chunk 接续前一个结束时间
        // chunk 的音频对应 audioData[0..]，即 filledNotes[0].start 起点的音频
        // （pipeline 已在 _synthesizeImpl 末尾截掉前导休止符）。playhead 需要从
        // firstNoteStartSec 开始，使 currentTime 与 canvas 中 note.start 的 beat
        // 坐标对齐，避免"歌声比 MIDI 更早出现"的偏移。
        if (streamingSources.length === 0) {
          streamingNextStart = ctx.currentTime + 0.05; // 50ms 延迟避免调度抖动
          const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
          const clippedNotes = getClippedNotes();
          const firstNoteStartSec = clippedNotes.length > 0
            ? (clippedNotes[0].start / bpm) * 60
            : 0;
          setFragmentIsPlaying(true);
          setFragmentPlaybackStartTime(ctx.currentTime + 0.05);
          setFragmentPlaybackOffset(firstNoteStartSec);
          setFragmentCurrentTime(firstNoteStartSec);
          updateFragmentPlayButton();
          // 启动 playhead rAF 动画循环：与主页面 startPlayheadAnimation、
          // playFragmentShared 末尾的 updateFragmentPlayhead 调用对齐。
          // 缺失此调用会导致流式播放期间音频正常播放但 playhead 不移动、
          // 画布不重绘，用户感知为“流式播放未生效”。
          updateFragmentPlayhead();
        }
        source.start(streamingNextStart);
        streamingNextStart += chunkInfo.audio.length / getSampleRate();

        // source.onended：非末 chunk 从 streamingSources 移除并释放引用，
        // 末 chunk 标记流式结束并更新 UI。
        // 长流式合成（如 100 个 chunk）时中间 chunk 的 AudioBuffer 内存能及时回收。
        const sourceIdx = streamingSources.length;
        streamingSources.push(source);
        if (chunkInfo.isLast) {
          source.onended = () => {
            if (!streamingFinished) {
              streamingFinished = true;
              setFragmentIsPlaying(false);
              const raf = getFragmentPlayheadRaf();
              if (raf) { cancelAnimationFrame(raf); setFragmentPlayheadRaf(null); }
              setFragmentCurrentTime(0);
              setFragmentPlayStartPosition(0);
              updateFragmentPlayButton();
              render();
            }
          };
        } else {
          source.onended = () => {
            if (streamingSources[sourceIdx] === source) {
              streamingSources[sourceIdx] = null;
            }
          };
        }
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
      },
    });
    setFragmentAudioData(padAudioToFragmentDuration(audioData));
    // 合成成功后更新签名，后续播放可复用此缓存
    setFragmentAudioDataSignature(currentSignature);

    // 合成完成：缓存完整 audioData 用于后续播放/导出
    // 流式播放不中断，让它播完已调度的 chunk
    // 移除 chunk 监听（避免内存泄漏），但保留已调度的 source 继续播放
    if (streamingCleanup) {
      try { streamingCleanup(); } catch (_) {}
      streamingCleanup = null;
    }

    // 如果流式播放未启动（如缓存命中或单 chunk 未触发回调），回退到整段播放
    if (streamingSources.length === 0) {
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
    const stereoData = applyEnvelopesToAudio(paddedAudio, getSampleRate(), bpm, envelopes.volume, envelopes.pan);
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
