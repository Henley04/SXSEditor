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
  function update() {
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
    setFragmentExclusiveRaf(requestAnimationFrame(update));
  }

  setFragmentExclusiveRaf(requestAnimationFrame(update));
}

export async function playFragment() {
  setFragmentIsSynthesizing(true);
  updateFragmentPlayButton();
  try {
    if (!getPipelineInitialized()) {
      await initPipeline();
    }

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
    setFragmentAudioData(audioData);

    await loadFragmentAudioSettings();
    setFragmentUseExclusiveMode(getFragmentAudioSettings()?.audioOutputMode === 'exclusive');

    if (getFragmentUseExclusiveMode()) {
      await playFragmentExclusive();
    } else {
      await playFragmentShared();
    }
  } catch (error) {
    console.error(t('fragment.synthesisFailed') + ':', error);
    showAlertDialog(t('fragment.synthesisFailed') + ': ' + error.message);
  } finally {
    setFragmentIsSynthesizing(false);
    updateFragmentPlayButton();
  }
}

export async function exportFragment() {
  const btnExportFragment = document.getElementById('btn-export-fragment');
  const originalText = btnExportFragment.textContent;
  btnExportFragment.disabled = true;
  btnExportFragment.textContent = t('fragment.exporting');
  try {
    if (!getPipelineInitialized()) {
      await initPipeline();
    }

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
    const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
    const envelopes = getEnvelopes();
    const stereoData = applyEnvelopesToAudio(audioData, getSampleRate(), bpm, envelopes.volume, envelopes.pan);
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
    btnExportFragment.disabled = false;
    btnExportFragment.textContent = originalText;
  }
}
