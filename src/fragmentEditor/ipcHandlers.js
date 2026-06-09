import { t } from '../i18n/index.js';
import {
  getFragmentIsSynthesizing,
  getFragmentIsPlaying,
  getFragmentAudioSettings,
  getFragmentAudioData,
  getFragmentAudioContext, setFragmentAudioContext,
  getFragmentGainNode, setFragmentGainNode,
  getCurrentParamMode,
  getPitchCurve,
  getAutoSaveTimer, setAutoSaveTimer,
  getNotes,
  getSelectedNoteIds,
  getSelectedAnchorIndices,
  getIpcCleanups,
  getFragmentDataReceived,
  getCurrentFragment,
  getCurrentProject,
  getEnvelopes,
  getWavFileBuffer, setWavFileBuffer,
  getPitchCurveSnapshotBeforeDrag, setPitchCurveSnapshotBeforeDrag,
  getEnvelopeSnapshotBeforeDrag, setEnvelopeSnapshotBeforeDrag,
  getDragOperation, setDragOperation,
  getDragMode, setDragMode,
  getLyricEditOldValue, setLyricEditOldValue,
  getLyricEditNoteId, setLyricEditNoteId,
  getNextNoteId, setNextNoteId,
  getPhonemeCache,
  setSelectedNoteIds,
  setSelectedAnchorIndices,
  setCurrentParamMode,
  setNotes,
  setEnvelopes,
  setPitchCurve,
  setCurrentFragment,
  setCurrentProject,
  invalidatePitchCurveCache,
  setFragmentDataReceived,
} from './state.js';
import { PARAM_MODES } from '../editor/pianoRoll.js';
import { initPipeline } from './pipeline.js';
import { stopFragmentPlayback, loadFragmentAudioSettings } from './audioPlayback.js';
import { render, resizeCanvases, convertExistingBrushSegmentsToAnchorPoints, resolvePhonemesFromPipeline } from './canvasRenderer.js';
import { scheduleAutoSave, saveFragmentData } from './projectIO.js';
import { updateParamModeButtons } from './uiControls.js';
import { HistoryManager } from '../editor/historyManager.js';

export function setupIpcHandlers() {
  const _ipcCleanups = getIpcCleanups();

  const cleanupProgress = window.electronAPI.onFragmentSVSProgress((progress) => {
    const btnPlayFragment = document.getElementById('btn-play-fragment');
    const btnExportFragment = document.getElementById('btn-export-fragment');
    if (getFragmentIsSynthesizing()) {
      btnPlayFragment.textContent = t('fragment.synthesizingProgress', { progress });
      btnExportFragment.textContent = t('fragment.exportingProgress', { progress });
    }
  });
  if (cleanupProgress) _ipcCleanups.push(cleanupProgress);

  if (window.electronAPI?.onLoadFragment) {
    const cleanup = window.electronAPI.onLoadFragment(async (data) => {
      await handleFragmentData(data);
    });
    if (cleanup) _ipcCleanups.push(cleanup);
  }

  if (window.electronAPI?.onFragmentBoundsChanged) {
    const cleanup = window.electronAPI.onFragmentBoundsChanged((data) => {
      const { fragmentId, startTime, duration } = data;
      const currentFragment = getCurrentFragment();
      if (currentFragment && currentFragment.id === fragmentId) {
        if (startTime !== undefined) currentFragment.startTime = startTime;
        if (duration !== undefined) currentFragment.duration = duration;
        render();
      }
    });
    if (cleanup) _ipcCleanups.push(cleanup);
  }

  if (window.electronAPI?.onProjectSettingsChanged) {
    const cleanup = window.electronAPI.onProjectSettingsChanged((data) => {
      const currentProject = getCurrentProject();
      if (currentProject) {
        if (data.bpm !== undefined) currentProject.bpm = data.bpm;
        if (data.timeSignature !== undefined) currentProject.timeSignature = data.timeSignature;
      }
    });
    if (cleanup) _ipcCleanups.push(cleanup);
  }
}

async function handleFragmentData(data) {
  if (!data || getFragmentDataReceived()) return;
  setFragmentDataReceived(true);

  setCurrentFragment(data.fragment);
  setCurrentProject(data.project);
  document.getElementById('fragment-name').textContent = data.fragment.name || t('fragment.fragment');
  setNotes(data.fragment.notes || []);
  setEnvelopes(data.fragment.envelopes || {
    volume: { keyframes: [{ time: 0, value: 1, smoothness: 0 }] },
    pan: { keyframes: [{ time: 0, value: 0, smoothness: 0 }] },
  });

  if (data.fragment.pitchCurve) {
    setPitchCurve({
      enabled: data.fragment.pitchCurve.enabled !== undefined ? data.fragment.pitchCurve.enabled : true,
      anchorPoints: data.fragment.pitchCurve.anchorPoints || [],
      brushSegments: data.fragment.pitchCurve.brushSegments || [],
    });
    if (getPitchCurve().brushSegments.length > 0) {
      convertExistingBrushSegmentsToAnchorPoints();
    }
  } else {
    setPitchCurve({
      enabled: true,
      anchorPoints: [],
      brushSegments: [],
    });
  }
  invalidatePitchCurveCache();

  setDragOperation(null);
  setDragMode(null);
  setPitchCurveSnapshotBeforeDrag(null);
  setEnvelopeSnapshotBeforeDrag(null);
  getSelectedNoteIds().clear();
  getSelectedAnchorIndices().clear();
  setLyricEditOldValue(null);
  setLyricEditNoteId(null);
  setNextNoteId(getNotes().reduce((max, n) => Math.max(max, (n.id || 0) + 1), 1));

  setCurrentParamMode(PARAM_MODES.MIDI);
  updateParamModeButtons();

  if (data.wavBuffer) {
    setWavFileBuffer(data.wavBuffer);
  }

  getPhonemeCache().clear();
  resizeCanvases();
  await resolvePhonemesFromPipeline();
}

export async function loadFragmentFromHash() {
  await new Promise(resolve => setTimeout(resolve, 500));
  if (!getFragmentDataReceived()) {
    const hash = window.location.hash;
    const match = hash.match(/fragmentId=([^&]+)/);
    if (match && window.electronAPI?.getFragmentData) {
      const fragmentId = match[1];
      const data = await window.electronAPI.getFragmentData(fragmentId);
      if (data) {
        await handleFragmentData(data);
      }
    }
  }
}
