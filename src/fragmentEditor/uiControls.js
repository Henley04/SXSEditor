import { t } from '../i18n/index.js';
import { HistoryManager } from '../editor/historyManager.js';
import { showAlertDialog } from '../alertDialog.js';
import {
  getCurrentParamMode, setCurrentParamMode,
  getPitchCurve,
  getFragmentIsSynthesizing,
  getFragmentIsPlaying,
  getAutoSaveTimer, setAutoSaveTimer,
  getNotes, setNotes,
  getSelectedNoteIds, setSelectedNoteIds,
  getSelectedAnchorIndices,
  setFragmentCurrentTime,
  setBrushSmoothing,
  invalidatePitchCurveCache,
  getParamPanelCollapsed, setParamPanelCollapsed,
  getParamPanelMode, setParamPanelMode,
} from './state.js';
import { scheduleAutoSave, saveFragmentData } from './projectIO.js';
import { render, resizeCanvases, resolvePhonemesFromPipeline, clonePitchCurveState, applyPitchCurveSnapshot, genNoteId } from './canvasRenderer.js';
import { playFragment, stopFragmentPlayback, exportFragment } from './audioPlayback.js';

const history = new HistoryManager();

export function updateParamModeButtons() {
  const modes = ['MIDI', 'Pitch'];
  const currentParamMode = getCurrentParamMode();
  modes.forEach(mode => {
    const btn = document.getElementById(`btn-param-${mode}`);
    if (btn) {
      const isActive = currentParamMode === mode;
      if (isActive) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  });

  const pitchTools = document.getElementById('pitch-tools');
  const pitchDivider = document.getElementById('pitch-tools-divider');
  const pitchCurve = getPitchCurve();
  if (currentParamMode === 'Pitch') {
    if (!pitchCurve.enabled) {
      pitchCurve.enabled = true;
      scheduleAutoSave();
    }
    if (pitchTools) pitchTools.style.display = 'flex';
    if (pitchDivider) pitchDivider.style.display = '';
  } else {
    if (pitchTools) pitchTools.style.display = 'none';
    if (pitchDivider) pitchDivider.style.display = 'none';
  }

  updatePitchToolButtons();
}

export function updateParamPanelState() {
  const toggle = document.getElementById('btn-param-toggle');
  const select = document.getElementById('param-mode-select');
  if (toggle) {
    toggle.classList.toggle('collapsed', getParamPanelCollapsed());
  }
  if (select) {
    select.value = getParamPanelMode();
  }
  // Sync horizontal tab active state
  const tabs = document.querySelectorAll('.param-lane-tab');
  tabs.forEach(tab => {
    if (tab.classList.contains('disabled')) {
      tab.classList.remove('active');
    } else {
      tab.classList.toggle('active', tab.dataset.lane === select?.value);
    }
  });
}

function updatePitchToolButtons() {
  const resetBtn = document.getElementById('btn-pitch-reset');
  const pitchCurve = getPitchCurve();
  if (resetBtn) {
    if (pitchCurve.enabled) {
      resetBtn.classList.remove('disabled-mode');
    } else {
      resetBtn.classList.add('disabled-mode');
    }
  }
}

export function updateFragmentPlayButton() {
  const btnPlayFragment = document.getElementById('btn-play-fragment');
  if (getFragmentIsSynthesizing()) {
    btnPlayFragment.textContent = t('fragment.synthesizing');
    btnPlayFragment.disabled = true;
  } else if (getFragmentIsPlaying()) {
    btnPlayFragment.textContent = t('fragment.stop');
    btnPlayFragment.disabled = false;
  } else {
    btnPlayFragment.textContent = t('fragment.play');
    btnPlayFragment.disabled = false;
  }
}

export function showShortcutsPanel() {
  const shortcutsOverlay = document.getElementById('shortcuts-overlay');
  if (shortcutsOverlay) shortcutsOverlay.classList.add('visible');
}

export function hideShortcutsPanel() {
  const shortcutsOverlay = document.getElementById('shortcuts-overlay');
  if (shortcutsOverlay) shortcutsOverlay.classList.remove('visible');
}

export function setupUiControls() {
  // Toolbar param buttons: MIDI, Pitch
  ['MIDI', 'Pitch'].forEach(mode => {
    const btn = document.getElementById(`btn-param-${mode}`);
    if (btn) {
      btn.addEventListener('click', () => {
        setCurrentParamMode(mode);
        setParamPanelCollapsed(true);
        updateParamModeButtons();
        updateParamPanelState();
        resizeCanvases();
      });
    }
  });

  // Param panel toggle button
  const btnToggle = document.getElementById('btn-param-toggle');
  if (btnToggle) {
    btnToggle.addEventListener('click', () => {
      setParamPanelCollapsed(!getParamPanelCollapsed());
      updateParamPanelState();
      resizeCanvases();
    });
  }

  // Param mode dropdown
  const paramModeSelect = document.getElementById('param-mode-select');
  if (paramModeSelect) {
    paramModeSelect.addEventListener('change', () => {
      const mode = paramModeSelect.value;
      setCurrentParamMode(mode);
      setParamPanelMode(mode);
      // Auto-expand panel if collapsed
      if (getParamPanelCollapsed()) {
        setParamPanelCollapsed(false);
      }
      if (mode === 'Phoneme') resolvePhonemesFromPipeline();
      updateParamModeButtons();
      updateParamPanelState();
      resizeCanvases();
    });
  }

  document.getElementById('btn-pitch-reset').addEventListener('click', () => {
    const oldSnapshot = clonePitchCurveState();
    getPitchCurve().anchorPoints = [];
    getPitchCurve().brushSegments = [];
    invalidatePitchCurveCache();
    const newSnapshot = clonePitchCurveState();
    history.push({
      undo() { applyPitchCurveSnapshot(oldSnapshot); },
      redo() { applyPitchCurveSnapshot(newSnapshot); }
    });
    render();
    scheduleAutoSave();
  });

  const brushSmoothingSlider = document.getElementById('brush-smoothing');
  const brushSmoothingLabel = document.getElementById('brush-smoothing-label');
  if (brushSmoothingSlider) {
    brushSmoothingSlider.addEventListener('input', () => {
      setBrushSmoothing(parseInt(brushSmoothingSlider.value, 10));
      if (brushSmoothingLabel) {
        brushSmoothingLabel.textContent = parseInt(brushSmoothingSlider.value, 10);
      }
    });
  }

  // 保存按钮已移除：分片编辑器现在采用 500ms 防抖自动保存（scheduleAutoSave），
  // 编辑后自动同步到主页面并触发主页面 autoSaveProject()，无需手动保存。
  // Ctrl+S 快捷键仍保留为"立即保存"（取消防抖立即推送），见 eventHandlers.js。

  document.getElementById('btn-close').addEventListener('click', () => {
    stopFragmentPlayback();
    const autoSaveTimer = getAutoSaveTimer();
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      setAutoSaveTimer(null);
    }
    saveFragmentData();
    window.close();
  });

  const shortcutsOverlay = document.getElementById('shortcuts-overlay');
  const btnShortcuts = document.getElementById('btn-shortcuts');
  const btnCloseShortcuts = document.getElementById('btn-close-shortcuts');

  if (btnShortcuts) btnShortcuts.addEventListener('click', showShortcutsPanel);
  if (btnCloseShortcuts) btnCloseShortcuts.addEventListener('click', hideShortcutsPanel);
  if (shortcutsOverlay) {
    shortcutsOverlay.addEventListener('click', (e) => {
      if (e.target === shortcutsOverlay) hideShortcutsPanel();
    });
  }

  const btnPlayFragment = document.getElementById('btn-play-fragment');
  const btnExportFragment = document.getElementById('btn-export-fragment');

  btnPlayFragment.addEventListener('click', async () => {
    if (getNotes().length === 0) {
      showAlertDialog(t('fragment.noNotesToPlay'));
      return;
    }
    if (getFragmentIsSynthesizing()) return;
    if (getFragmentIsPlaying()) {
      stopFragmentPlayback();
      setFragmentCurrentTime(0);
      render();
      return;
    }
    await playFragment();
  });

  btnExportFragment.addEventListener('click', async () => {
    if (getNotes().length === 0) {
      showAlertDialog(t('fragment.noNotesToExport'));
      return;
    }
    await exportFragment();
  });

  document.getElementById('btn-import-midi').addEventListener('click', async () => {
    try {
      const result = await window.electronAPI.importMidi();
      if (!result.success) {
        if (!result.canceled) {
          showAlertDialog(t('fragment.midiImportFailed') + ': ' + (result.error || '未知错误'));
        }
        return;
      }
      const oldNotes = getNotes().map(n => ({ ...n }));
      const oldSelectedNoteIds = new Set(getSelectedNoteIds());
      setNotes(result.notes.map((n) => ({
        id: genNoteId(),
        pitch: n.pitch,
        start: n.start,
        duration: n.duration,
        lyric: n.lyric || '',
        noteType: n.noteType,
      })));
      getSelectedNoteIds().clear();
      getSelectedAnchorIndices().clear();
      const newNotes = getNotes().map(n => ({ ...n }));
      history.push({
        undo() {
          setNotes(oldNotes.map(n => ({ ...n })));
          setSelectedNoteIds(new Set(oldSelectedNoteIds));
        },
        redo() {
          setNotes(newNotes.map(n => ({ ...n })));
          getSelectedNoteIds().clear();
          getSelectedAnchorIndices().clear();
        }
      });
      render();
      scheduleAutoSave();
      resolvePhonemesFromPipeline();
    } catch (err) {
      showAlertDialog(t('fragment.midiImportFailed') + ': ' + err.message);
    }
  });
}
