import { t } from '../i18n/index.js';
import { PARAM_MODES } from '../editor/pianoRoll.js';
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
} from './state.js';
import { scheduleAutoSave, saveFragmentData } from './projectIO.js';
import { render, resolvePhonemesFromPipeline, clonePitchCurveState, applyPitchCurveSnapshot, genNoteId } from './canvasRenderer.js';
import { playFragment, stopFragmentPlayback, exportFragment } from './audioPlayback.js';

const history = new HistoryManager();

export function updateParamModeButtons() {
  const modes = ['MIDI', 'Pitch', 'VOL', 'PAN', 'Phoneme'];
  const currentParamMode = getCurrentParamMode();
  modes.forEach(mode => {
    const btn = document.getElementById(`btn-param-${mode}`);
    if (btn) {
      const isActive = currentParamMode === mode || (mode === 'Pitch' && currentParamMode === 'Pitch');
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
  document.querySelectorAll('[id^="btn-param-"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.id.replace('btn-param-', '');
      if (mode === 'Pitch') {
        setCurrentParamMode('Pitch');
      } else {
        setCurrentParamMode(PARAM_MODES[mode] || mode);
      }
      updateParamModeButtons();
      if (getCurrentParamMode() === 'Phoneme') resolvePhonemesFromPipeline();
      render();
    });
  });

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

  document.getElementById('btn-save').addEventListener('click', () => {
    const autoSaveTimer = getAutoSaveTimer();
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      setAutoSaveTimer(null);
    }
    saveFragmentData();
    const btnSave = document.getElementById('btn-save');
    const origText = btnSave.textContent;
    btnSave.textContent = t('fragment.saved');
    setTimeout(() => { btnSave.textContent = origText; }, 1500);
  });

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
    } catch (err) {
      showAlertDialog(t('fragment.midiImportFailed') + ': ' + err.message);
    }
  });
}
