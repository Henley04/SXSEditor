import { state, dom, trackManager } from './state.js';
import { SAMPLE_RATE } from './constants.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { convertF0DataToPitchCurve, computePitchCurveF0 } from './f0Utils.js';
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

    const fragmentsBySinger = new Map();
    fragments.forEach(f => {
      if (!fragmentsBySinger.has(f.singerId)) {
        fragmentsBySinger.set(f.singerId, []);
      }
      fragmentsBySinger.get(f.singerId).push(f);
    });

    const singerIds = [...fragmentsBySinger.keys()];
    if (singerIds.length === 0) {
      showAlertDialog(t('main.noFragmentsToPlay'));
      return;
    }

    let globalFirstStart = Infinity;
    let globalLastEnd = 0;
    const singerDataMap = new Map();

    for (const singerId of singerIds) {
      const singer = singerMap.get(singerId);
      const singerFragments = fragmentsBySinger.get(singerId)
        .sort((a, b) => a.startTime - b.startTime);

      const singerNotes = [];
      for (const fragment of singerFragments) {
        if (fragment.notes && fragment.notes.length > 0) {
          const fragEnd = fragment.startTime + fragment.duration;
          const convertedNotes = [];
          for (const note of fragment.notes) {
            const noteStart = note.start + fragment.startTime;
            const noteEnd = noteStart + note.duration;
            if (noteStart >= fragEnd) continue;
            if (noteEnd > fragEnd) {
              convertedNotes.push({
                ...note,
                start: noteStart,
                duration: fragEnd - noteStart,
              });
            } else {
              convertedNotes.push({
                ...note,
                start: noteStart,
                duration: note.duration,
              });
            }
          }
          singerNotes.push(...convertedNotes);

          const fragmentEnd = fragEnd;
          if (fragment.startTime < globalFirstStart) globalFirstStart = fragment.startTime;
          if (fragmentEnd > globalLastEnd) globalLastEnd = fragmentEnd;
        }
      }

      if (singerNotes.length === 0) continue;

      singerNotes.sort((a, b) => a.start - b.start);

      const pitchCurveF0 = computePitchCurveF0(singerFragments, singerNotes, state.project.bpm);

      let singerPitchCurveF0 = pitchCurveF0;
      if (!singerPitchCurveF0 && singer?.f0Data && singer.f0Data.length > 0) {
        const lastNote = singerNotes[singerNotes.length - 1];
        const totalBeatsAll = lastNote.start + lastNote.duration;
        const totalSecondsAll = (totalBeatsAll / state.project.bpm) * 60;
        const converted = convertF0DataToPitchCurve(singer.f0Data, totalSecondsAll);
        if (converted) {
          singerPitchCurveF0 = Array.from(converted);
        }
      }

      singerDataMap.set(singerId, {
        notes: singerNotes,
        singer,
        pitchCurveF0: singerPitchCurveF0,
        refAudioWavBuffer: singer?.wavBuffer || null,
      });
    }

    if (singerDataMap.size === 0) {
      showAlertDialog(t('main.noNotesToPlay'));
      return;
    }

    await ensurePipelineInitialized();

    const inferenceOpts = getPreviewInferenceOptions();

    const totalSeconds = ((globalLastEnd - globalFirstStart) / state.project.bpm) * 60;
    const totalSingers = singerDataMap.size;
    let completedSingers = 0;

    const audioResults = [];

    for (const [singerId, data] of singerDataMap) {
      const audioData = await window.electronAPI.synthesizeSVS({
        notes: data.notes,
        bpm: state.project.bpm,
        options: {
          f0Envelope: null,
          pitchCurveF0: data.pitchCurveF0,
          refAudioWavBuffer: data.refAudioWavBuffer,
          autoShift: dom.autoShiftCheck.checked,
          nSteps: inferenceOpts.nSteps,
          cfg: inferenceOpts.cfg,
          cfgRescale: inferenceOpts.cfgRescale,
        },
      });

      const firstNoteStart = data.notes[0].start;
      const lastNote = data.notes[data.notes.length - 1];
      const expectedSamples = Math.ceil(((lastNote.start + lastNote.duration) / state.project.bpm) * 60 * SAMPLE_RATE);
      let paddedAudio = audioData;
      if (audioData.length < expectedSamples) {
        paddedAudio = new Float32Array(expectedSamples);
        paddedAudio.set(audioData);
      }
      audioResults.push({
        audioData: paddedAudio,
        startTimeBeat: firstNoteStart,
      });

      completedSingers++;
      const overallProgress = (completedSingers / totalSingers) * 100;
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
    const allNotesBySinger = {};

    for (const singer of singers) {
      const singerFragments = fragments.filter(f => f.singerId === singer.id);
      if (singerFragments.length === 0) continue;

      const notes = [];
      for (const fragment of singerFragments) {
        if (fragment.notes && fragment.notes.length > 0) {
          const fragEnd = fragment.startTime + fragment.duration;
          for (const note of fragment.notes) {
            const noteStart = note.start + fragment.startTime;
            const noteEnd = noteStart + note.duration;
            if (noteStart >= fragEnd) continue;
            if (noteEnd > fragEnd) {
              notes.push({
                ...note,
                start: noteStart,
                duration: fragEnd - noteStart,
              });
            } else {
              notes.push({
                ...note,
                start: noteStart,
                duration: note.duration,
              });
            }
          }
        }
      }

      if (notes.length > 0) {
        allNotesBySinger[singer.id] = {
          notes: notes.sort((a, b) => a.start - b.start),
          singer,
        };
      }
    }

    const singerIds = Object.keys(allNotesBySinger);
    if (singerIds.length === 0) {
      showAlertDialog(t('main.noNotesToExport'));
      return;
    }

    await ensurePipelineInitialized();
    await loadAudioSettings();

    const exportInferenceOpts = getExportInferenceOptions();

    let audioResults = [];
    let maxDuration = 0;

    for (const singerId of singerIds) {
      const { notes, singer } = allNotesBySinger[singerId];

      const refAudioWavBuffer = singer.wavBuffer || null;

      const singerFragments2 = fragments.filter(f => f.singerId === singerId);
      const exportPitchCurveF0 = computePitchCurveF0(singerFragments2, notes, state.project.bpm);

      let finalPitchCurveF0 = exportPitchCurveF0;
      if (!finalPitchCurveF0 && singer.f0Data && singer.f0Data.length > 0) {
        const exportTotalBeats = notes.reduce((max, note) => Math.max(max, note.start + note.duration), 0);
        const totalSecondsExport = (exportTotalBeats / state.project.bpm) * 60;
        const converted = convertF0DataToPitchCurve(singer.f0Data, totalSecondsExport);
        if (converted) {
          finalPitchCurveF0 = converted;
        }
      }

      const audioData = await window.electronAPI.synthesizeSVS({
        notes,
        bpm: state.project.bpm,
        options: {
          refAudioWavBuffer,
          pitchCurveF0: finalPitchCurveF0,
          autoShift: dom.autoShiftCheck.checked,
          nSteps: exportInferenceOpts.nSteps,
          cfg: exportInferenceOpts.cfg,
          cfgRescale: exportInferenceOpts.cfgRescale,
        },
      });

      const firstNoteStart = notes[0].start;
      const lastNote = notes[notes.length - 1];
      const endBeat = lastNote.start + lastNote.duration;
      maxDuration = Math.max(maxDuration, (endBeat / state.project.bpm) * 60);

      const expectedSamples = Math.ceil((endBeat / state.project.bpm) * 60 * SAMPLE_RATE);
      let paddedAudio = audioData;
      if (audioData.length < expectedSamples) {
        paddedAudio = new Float32Array(expectedSamples);
        paddedAudio.set(audioData);
      }

      audioResults.push({
        audioData: paddedAudio,
        startTimeBeat: firstNoteStart,
      });
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
