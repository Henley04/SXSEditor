import { state, dom, trackManager } from './state.js';
import { SAMPLE_RATE } from './constants.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { buildFragmentPitchCurveF0 } from './f0Utils.js';
import { formatTime } from './uiControls.js';
import { drawPlayheadLine, clearPlayheadLine } from './timelineRenderer.js';

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
      } else if (state.isPlaying && !state.useExclusiveMode && _sharedUpdateFn && !state.playheadRaf) {
        state.playheadRaf = requestAnimationFrame(_sharedUpdateFn);
      }
    }
  });
}

export async function ensurePipelineInitialized() {
  if (state.pipelineInitialized) return;
  if (state.pipelineInitPromise) {
    await state.pipelineInitPromise;
    return;
  }
  state.pipelineInitPromise = window.electronAPI.initSVSPipeline();
  try {
    await state.pipelineInitPromise;
    state.pipelineInitialized = true;
  } catch (err) {
    state.pipelineInitPromise = null;
    throw err;
  }
}

export async function playAll() {
  // 重入保护：防止连续调用导致前一次 finally 提前把 isSynthesizing 置 false，
  // 使后续进度回调失效（进度百分比偶发不显示的根因之一）。
  if (state.isSynthesizing) return;
  state.isSynthesizing = true;
  dom.btnPlay.disabled = true;
  dom.btnPlay.textContent = t('main.synthesizing');

  // 注册推理进度监听：更新按钮文本显示百分比（与分片编辑器对齐）
  let playProgressCleanup = null;
  try {
    playProgressCleanup = window.electronAPI.onSVSProgress((progress) => {
      if (state.isSynthesizing) {
        dom.btnPlay.textContent = t('main.synthesizingProgress', { progress });
      }
    });
  } catch (_) {}

  try {
    await loadAudioSettings();

    const fragments = trackManager.getFragments();
    const singers = trackManager.getSingers();
    const singerMap = new Map();
    singers.forEach(s => singerMap.set(s.id, s));

    // 收集所有有 notes 的 fragments，按 startTime 排序后逐个合成。
    // 复用分片编辑器的逻辑：每个 fragment 用相对 notes（clippedNotes）
    // + 该 fragment 自己的 pitchCurve（buildFragmentPitchCurveF0），
    // 确保与分片编辑器播放结果完全一致。
    const allFragments = fragments
      .filter(f => f.notes && f.notes.length > 0)
      .sort((a, b) => a.startTime - b.startTime);

    if (allFragments.length === 0) {
      showAlertDialog(t('main.noFragmentsToPlay'));
      return;
    }

    let globalFirstStart = Infinity;
    let globalLastEnd = 0;
    for (const f of allFragments) {
      if (f.startTime < globalFirstStart) globalFirstStart = f.startTime;
      const fragEnd = f.startTime + f.duration;
      if (fragEnd > globalLastEnd) globalLastEnd = fragEnd;
    }

    await ensurePipelineInitialized();

    const inferenceOpts = getPreviewInferenceOptions();

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
        options: {
          f0Envelope: null,
          pitchCurveF0,
          refAudioWavBuffer: singer?.wavBuffer || null,
          autoShift: dom.autoShiftCheck.checked,
          nSteps: inferenceOpts.nSteps,
          cfg: inferenceOpts.cfg,
          cfgRescale: inferenceOpts.cfgRescale,
        },
      });

      // padding 到 fragment 时长，确保混音时长对齐
      const expectedSamples = Math.ceil((fragDuration / state.project.bpm) * 60 * SAMPLE_RATE);
      let paddedAudio = audioData;
      if (audioData.length < expectedSamples) {
        paddedAudio = new Float32Array(expectedSamples);
        paddedAudio.set(audioData);
      }
      audioResults.push({
        audioData: paddedAudio,
        startTimeBeat: fragment.startTime,
      });

      completedFrags++;
      const overallProgress = (completedFrags / totalFrags) * 100;
      const currentSeconds = (overallProgress / 100) * totalSeconds;
      dom.timeDisplay.textContent = t('main.synthesizingShort') + ': ' + formatTime(currentSeconds) + ' / ' + formatTime(totalSeconds);
    }

    const maxEndBeat = globalLastEnd;
    const totalSamples = Math.ceil(((maxEndBeat / state.project.bpm) * 60) * SAMPLE_RATE);
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

    state.currentAudioData = mixedAudio;

    dom.timeDisplay.textContent = formatTime(0);
    state.playbackPauseOffset = 0;
    await startAudioPlayback(0);

  } catch (error) {
    console.error('Synthesis failed:', error);
    showAlertDialog(t('main.synthesisFailed') + ': ' + error.message);
    dom.timeDisplay.textContent = formatTime(0);
  } finally {
    state.isSynthesizing = false;
    dom.btnPlay.textContent = t('main.play');
    dom.btnPlay.disabled = false;
    if (playProgressCleanup) { try { playProgressCleanup(); } catch (_) {} playProgressCleanup = null; }
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
  if (state.audioContext.state === 'suspended') {
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
  } catch (e) {
    state.audioSettings = {};
  }
}

export function getPreviewInferenceOptions() {
  return {
    nSteps: state.audioSettings?.previewDiffSteps ?? 16,
    cfg: state.audioSettings?.previewCfgStrength ?? 3.0,
    cfgRescale: state.audioSettings?.previewCfgRescale ?? 0.75,
    npuDiffBatchSize: 1,
    npuVocoderBatchSize: 1,
  };
}

export function getExportInferenceOptions() {
  return {
    nSteps: state.audioSettings?.exportDiffSteps ?? 32,
    cfg: state.audioSettings?.exportCfgStrength ?? 3.0,
    cfgRescale: state.audioSettings?.exportCfgRescale ?? 0.75,
    npuDiffBatchSize: 1,
    npuVocoderBatchSize: 1,
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
      state.audioContext.setSinkId(sinkId).catch(err => {
      // TODO: translate garbled log
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

export function startSharedPlayback(offset) {
  stopAudioSource();

  const context = getAudioContext();
  const audioBuffer = context.createBuffer(1, state.currentAudioData.length, SAMPLE_RATE);
  const channelData = audioBuffer.getChannelData(0);
  channelData.set(state.currentAudioData);

  state.currentAudioBuffer = audioBuffer;

  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(state.gainNode);

  source.onended = () => {
    if (state.isPlaying) {
      state.isPlaying = false;
      state.playbackPauseOffset = 0;
      stopPlayheadAnimation();
      dom.timeDisplay.textContent = formatTime(0);
    }
  };

  source.start(0, offset);
  state.currentAudioSource = source;
  state.isPlaying = true;
  state.playbackStartTime = context.currentTime - offset;
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
    state.playbackStartTime = Date.now() / 1000 - offset;
    state.playbackPauseOffset = offset;

    const removeEndedListener = window.electronAPI.onAudioEnded(() => {
      if (state.isPlaying) {
        state.isPlaying = false;
        state.playbackPauseOffset = 0;
        stopExclusivePlayback();
        stopPlayheadAnimation();
        dom.timeDisplay.textContent = formatTime(0);
      }
    });

    startExclusivePlayheadAnimation(removeEndedListener);
  } catch (err) {
      // TODO: translate garbled log
    state.useExclusiveMode = false;
    startSharedPlayback(offset);
  }
}

export function startExclusivePlayheadAnimation(removeEndedListener) {
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
      state.isPlaying = false;
      state.playbackPauseOffset = 0;
      stopExclusivePlayback();
      stopPlayheadAnimation();
      dom.timeDisplay.textContent = formatTime(0);
      clearPlayheadLine();
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
  window.electronAPI.audioStop().catch(err => {
    console.warn('[Audio] Failed to stop exclusive playback:', err);
  });
}

export function pausePlayback() {
  if (!state.isPlaying) {
    return;
  }

  if (state.useExclusiveMode) {
    const elapsed = Date.now() / 1000 - state.playbackStartTime;
    state.playbackPauseOffset = elapsed;
    stopExclusivePlayback();
    state.isPlaying = false;
    stopPlayheadAnimation();
    dom.timeDisplay.textContent = t('main.paused') + ': ' + formatTime(elapsed);
  } else {
    if (!state.currentAudioSource) return;
    const context = getAudioContext();
    const elapsed = context.currentTime - state.playbackStartTime;
    state.playbackPauseOffset = elapsed;
    stopAudioSource();
    state.isPlaying = false;
    stopPlayheadAnimation();
    dom.timeDisplay.textContent = t('main.paused') + ': ' + formatTime(elapsed);
  }
}

export function stopPlayback() {
  if (state.useExclusiveMode) {
    stopExclusivePlayback();
  }
  stopAudioSource();
  state.isPlaying = false;
  state.playbackPauseOffset = 0;
  stopPlayheadAnimation();
  state.currentAudioData = null;
  state.currentAudioBuffer = null;
}

export function stopAudioSource() {
  if (state.currentAudioSource) {
    try {
      state.currentAudioSource.onended = null;
      state.currentAudioSource.stop();
    } catch (e) {
    }
    state.currentAudioSource = null;
  }
  if (state.playheadRaf) {
    cancelAnimationFrame(state.playheadRaf);
    state.playheadRaf = null;
  }
}

export function startPlayheadAnimation() {
  _ensureVisibilityHandler();
  function updatePlayhead() {
    _sharedUpdateFn = updatePlayhead;
    if (!state.isPlaying) return;

    const context = getAudioContext();
    const elapsed = context.currentTime - state.playbackStartTime;

    if (state.currentAudioBuffer) {
      const duration = state.currentAudioBuffer.duration;
      if (elapsed >= duration) {
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
  const fragments = trackManager.getFragments();
  if (fragments.length === 0) {
    showAlertDialog(t('main.noFragmentsToExport'));
    return;
  }

  const originalText = dom.btnExport.textContent;
  dom.btnExport.disabled = true;
  dom.btnExport.textContent = t('main.exporting');
  dom.timeDisplay.textContent = t('main.preparing');

  // 注册推理进度监听：更新导出按钮文本显示百分比
  let exportProgressCleanup = null;
  try {
    exportProgressCleanup = window.electronAPI.onSVSProgress((progress) => {
      dom.btnExport.textContent = t('main.exportingProgress', { progress });
    });
  } catch (_) {}

  try {
    const singers = trackManager.getSingers();
    const singerMap = new Map();
    singers.forEach(s => singerMap.set(s.id, s));

    // 收集所有有 notes 的 fragments，按 startTime 排序后逐个合成。
    // 与 playAll 一致：每个 fragment 用相对 notes（clippedNotes）
    // + 该 fragment 自己的 pitchCurve（buildFragmentPitchCurveF0），
    // 确保与分片编辑器播放/导出结果完全一致。
    const allFragments = fragments
      .filter(f => f.notes && f.notes.length > 0)
      .sort((a, b) => a.startTime - b.startTime);

    if (allFragments.length === 0) {
      showAlertDialog(t('main.noNotesToExport'));
      return;
    }

    await ensurePipelineInitialized();
    await loadAudioSettings();

    const exportInferenceOpts = getExportInferenceOptions();

    let audioResults = [];
    let maxDuration = 0;

    for (const fragment of allFragments) {
      const singer = singerMap.get(fragment.singerId);
      if (!singer) continue;

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
        options: {
          refAudioWavBuffer: singer?.wavBuffer || null,
          pitchCurveF0,
          autoShift: dom.autoShiftCheck.checked,
          nSteps: exportInferenceOpts.nSteps,
          cfg: exportInferenceOpts.cfg,
          cfgRescale: exportInferenceOpts.cfgRescale,
        },
      });

      // padding 到 fragment 时长，确保混音时长对齐
      const expectedSamples = Math.ceil((fragDuration / state.project.bpm) * 60 * SAMPLE_RATE);
      let paddedAudio = audioData;
      if (audioData.length < expectedSamples) {
        paddedAudio = new Float32Array(expectedSamples);
        paddedAudio.set(audioData);
      }
      audioResults.push({
        audioData: paddedAudio,
        startTimeBeat: fragment.startTime,
      });

      const fragEndSec = (fragDuration / state.project.bpm) * 60;
      if (fragEndSec > maxDuration) maxDuration = fragEndSec;
    }

    dom.timeDisplay.textContent = t('main.encodingWav');

    const totalSamples = Math.ceil(maxDuration * SAMPLE_RATE);
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

    const { encodeWav } = await import('../audio/wavEncoder.js');
    const wavData = encodeWav(mixedAudio, SAMPLE_RATE);

    dom.timeDisplay.textContent = t('main.savingFile');

    const result = await window.electronAPI.showSaveDialog({
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    });

    if (!result.canceled && result.filePath) {
      await window.electronAPI.saveFile(result.filePath, wavData);
      dom.timeDisplay.textContent = formatTime(maxDuration);
    }

  } catch (err) {
    console.error('Synthesis failed:', err);
    showAlertDialog(t('main.exportFailed') + ': ' + (err.message || ''));
    dom.timeDisplay.textContent = t('main.exportFailed');
  } finally {
    dom.btnExport.disabled = false;
    dom.btnExport.textContent = originalText;
    if (exportProgressCleanup) { try { exportProgressCleanup(); } catch (_) {} exportProgressCleanup = null; }
  }
}
