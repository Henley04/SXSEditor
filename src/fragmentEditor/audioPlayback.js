import { encodeWav, applyEnvelopesToAudio } from '../audio/wavEncoder.js';
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
  for (const src of streamingSources) {
    try { src.onended = null; src.stop(); } catch (_) {}
  }
  streamingSources = [];
  if (streamingCleanup) {
    try { streamingCleanup(); } catch (_) {}
    streamingCleanup = null;
  }
  streamingFinished = false;
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

  const audioData = getFragmentAudioData();
  if (audioData) {
    const duration = audioData.length / getSampleRate();
    if (getFragmentCurrentTime() >= duration) {
      stopFragmentPlayback();
      setFragmentCurrentTime(0);
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

  if (volumeEnv && volumeEnv.keyframes && volumeEnv.keyframes.length > 0) {
    const now = ctx.currentTime;
    const sortedKfs = [...volumeEnv.keyframes].sort((a, b) => a.time - b.time);
    envGainNode.gain.setValueAtTime(sortedKfs[0].value, now);
    for (let i = 0; i < sortedKfs.length; i++) {
      const kf = sortedKfs[i];
      const timeSec = (kf.time / bpm) * 60;
      if (timeSec <= audioDuration) {
        envGainNode.gain.linearRampToValueAtTime(kf.value, now + timeSec);
      }
    }
    const lastKf = sortedKfs[sortedKfs.length - 1];
    const lastTimeSec = (lastKf.time / bpm) * 60;
    if (lastTimeSec < audioDuration) {
      envGainNode.gain.linearRampToValueAtTime(lastKf.value, now + audioDuration);
    }
  }

  if (panEnv && panEnv.keyframes && panEnv.keyframes.length > 0) {
    const now = ctx.currentTime;
    const sortedKfs = [...panEnv.keyframes].sort((a, b) => a.time - b.time);
    panNode.pan.setValueAtTime(sortedKfs[0].value, now);
    for (let i = 0; i < sortedKfs.length; i++) {
      const kf = sortedKfs[i];
      const timeSec = (kf.time / bpm) * 60;
      if (timeSec <= audioDuration) {
        panNode.pan.linearRampToValueAtTime(kf.value, now + timeSec);
      }
    }
    const lastKf = sortedKfs[sortedKfs.length - 1];
    const lastTimeSec = (lastKf.time / bpm) * 60;
    if (lastTimeSec < audioDuration) {
      panNode.pan.linearRampToValueAtTime(lastKf.value, now + audioDuration);
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
    updateFragmentPlayButton();
    render();
  };
  source.start();
  setFragmentAudioSource(source);
  setFragmentIsPlaying(true);
  setFragmentPlaybackStartTime(ctx.currentTime);
  setFragmentPlaybackOffset(0);
  setFragmentCurrentTime(0);
  updateFragmentPlayhead();
  updateFragmentPlayButton();
}

async function playFragmentExclusive() {
  stopFragmentPlayback();

  try {
    const settings = getFragmentAudioSettings();
    const audioData = getFragmentAudioData();
    const options = {
      deviceId: settings?.audioOutputDevice ?? -1,
      sampleRate: settings?.audioSampleRate ?? getSampleRate(),
      channels: 1,
      bitDepth: settings?.audioBitDepth ?? 'float32',
      bufferSize: settings?.audioBufferSize ?? 1024,
      exclusiveMode: true,
      volume: settings?.audioVolume ?? 1.0,
      offset: 0,
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
    setFragmentPlaybackOffset(0);
    setFragmentCurrentTime(0);

    const removeEndedListener = window.electronAPI.onAudioEnded(() => {
      setFragmentIsPlaying(false);
      const raf = getFragmentPlayheadRaf();
      if (raf) {
        cancelAnimationFrame(raf);
        setFragmentPlayheadRaf(null);
      }
      setFragmentCurrentTime(0);
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
  if (audioData.length >= expectedSamples) return audioData;
  const padded = new Float32Array(expectedSamples);
  padded.set(audioData);
  return padded;
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
      if (streamingSources.length === 0) {
        streamingNextStart = ctx.currentTime + 0.05; // 50ms 延迟避免调度抖动
        setFragmentIsPlaying(true);
        setFragmentPlaybackStartTime(ctx.currentTime + 0.05);
        setFragmentPlaybackOffset(0);
        setFragmentCurrentTime(0);
        updateFragmentPlayButton();
      }
      source.start(streamingNextStart);
      streamingNextStart += chunkInfo.audio.length / getSampleRate();

      // 最后一个 chunk：标记流式结束，更新 UI
      source.onended = () => {
        if (chunkInfo.isLast && !streamingFinished) {
          streamingFinished = true;
          setFragmentIsPlaying(false);
          const raf = getFragmentPlayheadRaf();
          if (raf) { cancelAnimationFrame(raf); setFragmentPlayheadRaf(null); }
          setFragmentCurrentTime(0);
          updateFragmentPlayButton();
          render();
        }
      };
      streamingSources.push(source);
    } catch (e) {
      console.warn('[FragmentAudio] Streaming chunk playback failed:', e.message);
    }
  });

  try {
    if (!getPipelineInitialized()) {
      await initPipeline();
    }

    await loadFragmentAudioSettings();

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
        autoShift: document.getElementById('autoShiftCheck').checked,
        nSteps: previewOpts.nSteps,
        cfg: previewOpts.cfg,
        cfgRescale: previewOpts.cfgRescale,
      },
    });
    setFragmentAudioData(padAudioToFragmentDuration(audioData));

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
    showAlertDialog(t('fragment.synthesisFailed') + ': ' + error.message);
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
    showAlertDialog(t('fragment.exportFailed') + ': ' + error.message);
  } finally {
    setFragmentIsExporting(false);
    btnExportFragment.disabled = false;
    btnExportFragment.textContent = originalText;
  }
}
