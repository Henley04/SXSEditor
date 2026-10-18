import { t } from '../i18n/index.js';
import { setLabel } from '../icons/iconHelper.js';
import { showAlertDialog } from '../alertDialog.js';
import { history } from './history.js';
import {
  getCurrentParamMode, setCurrentParamMode,
  getPitchCurve,
  getFragmentIsSynthesizing,
  getFragmentIsPlaying,
  getFragmentIsAutoInferring,
  getAutoSaveTimer, setAutoSaveTimer,
  getNotes, setNotes,
  getSelectedNoteIds, setSelectedNoteIds,
  getSelectedAnchorIndices,
  setFragmentCurrentTime,
  setFragmentPlayStartPosition,
  setBrushSmoothing,
  invalidatePitchCurveCache,
  getParamPanelCollapsed, setParamPanelCollapsed,
  getParamPanelMode, setParamPanelMode,
  getPostprocess, setPostprocess,
  getPostprocessDefaults,
  getActiveTimbreParam, setActiveTimbreParam,
  getSelectedTimbreAnchors,
  invalidateTimbreCache,
} from './state.js';
import {
  POSTPROCESS_GROUPS, POSTPROCESS_PARAM_LIST, POSTPROCESS_PRESETS,
  formatParamValue, quantizeParamValue,
} from './postprocessParams.js';
import { getTimbreDefault, getTimbreKeyframes } from './postprocessAccess.js';
import { scheduleAutoSave, saveFragmentData } from './projectIO.js';
import { render, resizeCanvases, resolvePhonemesFromPipeline, clonePitchCurveState, applyPitchCurveSnapshot, genNoteId } from './canvasRenderer.js';
import { playFragment, stopFragmentPlayback, exportFragment } from './audioPlayback.js';
import { exportFragmentMidi } from './midiExport.js';


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
  // 音色 lane 的参数子标签只在音色 lane 展开时显示
  const subtabs = document.getElementById('param-subtabs');
  if (subtabs) {
    subtabs.style.display = getParamPanelMode() === 'Timbre' ? 'flex' : 'none';
  }
  syncPostprocessUi();
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
    setLabel(btnPlayFragment, t('fragment.synthesizing'), { icon: 'play' });
    btnPlayFragment.disabled = true;
  } else if (getFragmentIsPlaying()) {
    setLabel(btnPlayFragment, t('fragment.stop'), { icon: 'stop' });
    btnPlayFragment.disabled = false;
  } else if (getFragmentIsAutoInferring()) {
    // 后台自动推理进行中：仅提示，不禁用按钮——用户仍可随时手动播放或编辑。
    setLabel(btnPlayFragment, t('fragment.autoInferring'), { icon: 'play' });
    btnPlayFragment.disabled = false;
  } else {
    setLabel(btnPlayFragment, t('fragment.play'), { icon: 'play' });
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
  setupPostprocessUi();
  // Toolbar param buttons: MIDI, Pitch
  ['MIDI', 'Pitch'].forEach(mode => {
    const btn = document.getElementById(`btn-param-${mode}`);
    if (btn) {
      btn.addEventListener('click', () => {
        setCurrentParamMode(mode);
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

  // Param mode dropdown — switches the BOTTOM panel lane (VOL/PAN/Phoneme/Timbre).
  // The top toolbar mode (MIDI/Pitch) is independent and must be preserved.
  const paramModeSelect = document.getElementById('param-mode-select');
  if (paramModeSelect) {
    paramModeSelect.addEventListener('change', () => {
      const mode = paramModeSelect.value;
      setParamPanelMode(mode);
      // Auto-expand panel if collapsed
      if (getParamPanelCollapsed()) {
        setParamPanelCollapsed(false);
      }
      if (mode === 'Phoneme') resolvePhonemesFromPipeline();
      // NOTE: do NOT call setCurrentParamMode/updateParamModeButtons here —
      // those track the top toolbar (MIDI/Pitch) and must stay untouched.
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
  const btnExportFragmentMidi = document.getElementById('btn-export-fragment-midi');

  btnPlayFragment.addEventListener('click', async () => {
    if (getNotes().length === 0) {
      showAlertDialog(t('fragment.noNotesToPlay'));
      return;
    }
    if (getFragmentIsSynthesizing()) return;
    if (getFragmentIsPlaying()) {
      stopFragmentPlayback();
      setFragmentCurrentTime(0);
      // 停止时重置播放起始位置，下次点击播放从头开始。
      // 用户可再次拖拽 playhead 设置新的起始位置。
      setFragmentPlayStartPosition(0);
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

  if (btnExportFragmentMidi) {
    btnExportFragmentMidi.addEventListener('click', exportFragmentMidi);
  }

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

// ==================== 音色 / 后处理面板 ====================
// 检查器里的滑块编辑"当前参数"的数值：
//   · 该参数在音色 lane 里选中了唯一锚点 → 编辑该锚点的数值
//   · 否则编辑该参数的全局默认值（曲线为空时的常量）
// 这样面板既能做精确输入，又不会和曲线锚点打架。

function _snapshotPostprocess() {
  return JSON.parse(JSON.stringify(getPostprocess()));
}

function _applyPostprocessSnapshot(snapshot) {
  setPostprocess(JSON.parse(JSON.stringify(snapshot)));
  invalidateTimbreCache();
  syncPostprocessUi();
  render();
}

function _selectedTimbreAnchorIndex(paramId) {
  const sel = getSelectedTimbreAnchors();
  if (!sel || sel.size !== 1) return -1;
  if (paramId !== getActiveTimbreParam()) return -1;
  const idx = [...sel][0];
  const anchors = getTimbreKeyframes(paramId);
  return anchors[idx] ? idx : -1;
}

function _applyParamValue(paramId, rawValue) {
  const value = quantizeParamValue(paramId, rawValue);
  const idx = _selectedTimbreAnchorIndex(paramId);
  if (idx >= 0) {
    getTimbreKeyframes(paramId)[idx].value = value;
  } else {
    const defaults = getPostprocessDefaults();
    defaults[paramId] = value;
  }
  invalidateTimbreCache();
  render();
  scheduleAutoSave();
}

/** 生成音色 lane 的参数子标签（每个参数一条独立曲线）。 */
function _buildParamSubtabs() {
  const host = document.getElementById('param-subtabs');
  if (!host || host.dataset.built === '1') return;
  host.dataset.built = '1';
  host.innerHTML = '';
  for (const group of POSTPROCESS_GROUPS) {
    const label = document.createElement('span');
    label.className = 'pp-group-label';
    label.textContent = t(group.labelKey);
    host.appendChild(label);
    for (const param of POSTPROCESS_PARAM_LIST.filter(p => p.group === group.id)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pp-chip';
      btn.dataset.param = param.id;
      btn.textContent = t(param.labelKey);
      btn.title = t(param.descKey);
      btn.addEventListener('click', () => {
        setActiveTimbreParam(param.id);
        getSelectedTimbreAnchors().clear();
        syncPostprocessUi();
        render();
      });
      host.appendChild(btn);
    }
  }
}

/** 生成检查器的参数滑块行（按分组排列，与 lane 子标签一一对应）。 */
function _buildInspectorRows() {
  const host = document.getElementById('pp-inspector-rows');
  if (!host || host.dataset.built === '1') return;
  host.dataset.built = '1';
  host.innerHTML = '';

  for (const group of POSTPROCESS_GROUPS) {
    const title = document.createElement('div');
    title.className = 'pp-row-group';
    title.textContent = t(group.labelKey);
    host.appendChild(title);

    for (const param of POSTPROCESS_PARAM_LIST.filter(p => p.group === group.id)) {
      const row = document.createElement('div');
      row.className = 'pp-row';
      row.dataset.param = param.id;

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'pp-row-label';
      label.textContent = t(param.labelKey);
      label.title = t(param.descKey);
      label.addEventListener('click', () => {
        setActiveTimbreParam(param.id);
        getSelectedTimbreAnchors().clear();
        syncPostprocessUi();
        render();
      });

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'pp-slider';
      slider.dataset.param = param.id;
      slider.min = String(param.min);
      slider.max = String(param.max);
      slider.step = String(param.step);
      slider.value = String(param.def);
      slider.setAttribute('aria-label', t(param.labelKey));
      // 撤销：input 实时预览（第一次 input 时记快照），change（松手/失焦）提交
      // 一次历史，Ctrl+Z 可整体回退这次拖动 —— 与预设下拉、锚点编辑一致。
      let sliderSnapshot = null;
      slider.addEventListener('input', () => {
        if (sliderSnapshot === null) sliderSnapshot = _snapshotPostprocess();
        // 显示量化后的取值（奇数窗口参数 2→3 等），滑块读数与实际窗口一致
        const q = quantizeParamValue(param.id, parseFloat(slider.value));
        _applyParamValue(param.id, q);
        _syncValueLabel(param.id, q);
        _syncModeTag(param.id);
      });
      slider.addEventListener('change', () => {
        if (sliderSnapshot === null) return;
        const before = sliderSnapshot;
        sliderSnapshot = null;
        const after = _snapshotPostprocess();
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        history.push({
          undo() { _applyPostprocessSnapshot(before); },
          redo() { _applyPostprocessSnapshot(after); },
        });
      });

      const val = document.createElement('span');
      val.className = 'pp-row-val';
      val.dataset.param = param.id;
      val.textContent = formatParamValue(param.id, param.def, t);

      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(val);
      host.appendChild(row);
    }
  }
}

function _syncValueLabel(paramId, value) {
  const val = document.querySelector(`.pp-row-val[data-param="${paramId}"]`);
  if (val) val.textContent = formatParamValue(paramId, value, t);
}

function _syncModeTag(paramId) {
  const tag = document.getElementById('pp-mode-tag');
  if (!tag) return;
  const anchors = getTimbreKeyframes(paramId);
  tag.textContent = anchors.length > 0 ? t('fragment.ppAuto') : t('fragment.ppManual');
}

export function setupPostprocessUi() {
  _buildParamSubtabs();
  _buildInspectorRows();

  const presetSelect = document.getElementById('pp-preset-select');
  if (presetSelect && presetSelect.dataset.built !== '1') {
    presetSelect.dataset.built = '1';
    presetSelect.innerHTML = '';
    for (const preset of POSTPROCESS_PRESETS) {
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = t(preset.labelKey);
      presetSelect.appendChild(opt);
    }
    presetSelect.value = 'off';
    presetSelect.addEventListener('change', () => {
      const preset = POSTPROCESS_PRESETS.find(p => p.id === presetSelect.value);
      if (!preset) return;
      const before = _snapshotPostprocess();
      const defaults = getPostprocessDefaults();
      for (const [paramId, value] of Object.entries(preset.values)) {
        if (defaults[paramId] !== undefined) defaults[paramId] = quantizeParamValue(paramId, value);
      }
      invalidateTimbreCache();
      const after = _snapshotPostprocess();
      history.push({
        undo() { _applyPostprocessSnapshot(before); },
        redo() { _applyPostprocessSnapshot(after); },
      });
      syncPostprocessUi();
      render();
      scheduleAutoSave();
    });
  }

  syncPostprocessUi();
}

/**
 * 把 state 里的取值同步到子标签 / 滑块（不写回 state，纯展示）。
 * 正在拖动的滑块（document.activeElement）跳过，避免和用户操作打架。
 */
export function syncPostprocessUi() {
  const activeParam = getActiveTimbreParam();
  document.querySelectorAll('.pp-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.param === activeParam);
  });

  const anchorIdx = _selectedTimbreAnchorIndex(activeParam);
  document.querySelectorAll('.pp-slider').forEach(slider => {
    const paramId = slider.dataset.param;
    if (!paramId) return;
    const anchors = getTimbreKeyframes(paramId);
    const idx = paramId === activeParam ? anchorIdx : -1;
    const value = idx >= 0 ? anchors[idx].value : getTimbreDefault(paramId);
    if (document.activeElement !== slider) {
      slider.value = String(value);
    }
    _syncValueLabel(paramId, value);
  });

  _syncModeTag(activeParam);

  // 预设下拉：默认值恰好等于某个预设时高亮它
  const presetSelect = document.getElementById('pp-preset-select');
  if (presetSelect && document.activeElement !== presetSelect) {
    const defaults = getPostprocessDefaults();
    const match = POSTPROCESS_PRESETS.find(preset =>
      Object.entries(preset.values).every(([id, v]) => Math.abs((defaults[id] ?? 0) - v) < 1e-6));
    if (match) presetSelect.value = match.id;
  }
}
