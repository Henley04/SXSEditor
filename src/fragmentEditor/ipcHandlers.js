import { t } from '../i18n/index.js';
import {
  getFragmentIsSynthesizing,
  getFragmentIsExporting,
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
  getPendingBoundsUpdate, setPendingBoundsUpdate,
  getCurrentFragment,
  getCurrentProject,
  getEnvelopes,
  getScrollY, setScrollY,
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
import { render, resizeCanvases, computeInitialScrollY, convertExistingBrushSegmentsToAnchorPoints, resolvePhonemesFromPipeline } from './canvasRenderer.js';
import { scheduleAutoSave, saveFragmentData } from './projectIO.js';
import { updateParamModeButtons } from './uiControls.js';
import { HistoryManager } from '../editor/historyManager.js';

export function setupIpcHandlers() {
  const _ipcCleanups = getIpcCleanups();

  const cleanupProgress = window.electronAPI.onFragmentSVSProgress((progress) => {
    // 区分播放预览和导出：各自只更新对应的按钮，避免互相覆盖。
    // 之前回调同时更新两个按钮，播放时导出按钮也被改成"导出 X%"，
    // 而导出时因 fragmentIsSynthesizing=false 两个按钮都不更新。
    if (getFragmentIsSynthesizing()) {
      const btnPlayFragment = document.getElementById('btn-play-fragment');
      if (btnPlayFragment) btnPlayFragment.textContent = t('fragment.synthesizingProgress', { progress });
    } else if (getFragmentIsExporting()) {
      const btnExportFragment = document.getElementById('btn-export-fragment');
      if (btnExportFragment) btnExportFragment.textContent = t('fragment.exportingProgress', { progress });
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
      } else {
        // currentFragment 尚未就绪（分片编辑器刚打开、handleFragmentData 还没跑完），
        // 缓存最新的边界更新，待 handleFragmentData 完成后回放，避免静默丢弃。
        setPendingBoundsUpdate({ fragmentId, startTime, duration });
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

  // Center the vertical view on existing notes, or the middle pitch if empty
  setScrollY(computeInitialScrollY());
  render();

  // 回放在 currentFragment 就绪前到达的 fragmentBoundsChanged，确保主页面对分片
  // 长度/结尾的修改不会因为时序竞态被丢失。
  const pendingBounds = getPendingBoundsUpdate();
  if (pendingBounds) {
    setPendingBoundsUpdate(null);
    const cf = getCurrentFragment();
    if (cf && cf.id === pendingBounds.fragmentId) {
      if (pendingBounds.startTime !== undefined) cf.startTime = pendingBounds.startTime;
      if (pendingBounds.duration !== undefined) cf.duration = pendingBounds.duration;
      render();
    }
  }

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
