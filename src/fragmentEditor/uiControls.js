import { t } from '../i18n/index.js';
import { setLabel } from '../icons/iconHelper.js';
import { showAlertDialog } from '../alertDialog.js';
import { history } from './history.js';
import {
  getCurrentParamMode, setCurrentParamMode,
  // 自然度自检需要 BPM（缺这个 import 会让自检面板静默不工作）
  getCurrentProject,
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
  getPostprocessDefaults, getPostprocessCurves,
  getActiveTimbreParam, setActiveTimbreParam,
  getSelectedTimbreAnchors,
  getTimbreDragAnchorIdx,
  invalidateTimbreCache,
} from './state.js';
import {
  POSTPROCESS_GROUPS, POSTPROCESS_PARAM_LIST, POSTPROCESS_PRESETS, POSTPROCESS_PARAMS,
  formatParamValue, quantizeParamValue,
} from './postprocessParams.js';
import { getTimbreDefault, getTimbreKeyframes } from './postprocessAccess.js';
import { attachHoverTip, hideHoverTip, installHoverTipGlobalDismiss } from './paramTooltip.js';
import { scheduleAutoSave, saveFragmentData } from './projectIO.js';
import { AUTO_PITCH_DEFAULTS, paramsForPreset, resolvePitchRanges } from '../shared/autoPitchCurve.js';
import { analyzeNaturalness } from '../shared/naturalness.js';
import {
  render, resizeCanvases, resolvePhonemesFromPipeline, clonePitchCurveState,
  applyPitchCurveSnapshot, genNoteId,
  // 自然度自检要采样**实际**曲线（含自动层/手动覆盖/颤音）
  getPitchAtTime, getClippedNotes,
} from './canvasRenderer.js';
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
  if (!btnPlayFragment) return;
  // 顺序很重要：流式播放期间 isSynthesizing 仍为 true（合成还没结束、还要继续
  // 收 chunk），但声音已经在放了。必须先按"播放中"呈现（可点 = 停止），否则
  // 按钮在整个合成期间都显示"合成中"且禁用 —— 用户既停不下来、也切不了位置，
  // 只能等整段推理跑完（"按播放没反应"的直接原因）。
  if (getFragmentIsPlaying()) {
    setLabel(btnPlayFragment, t('fragment.stop'), { icon: 'stop' });
    btnPlayFragment.disabled = false;
  } else if (getFragmentIsSynthesizing()) {
    setLabel(btnPlayFragment, t('fragment.synthesizing'), { icon: 'play' });
    btnPlayFragment.disabled = true;
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

  setupAutoPitchUi();
  setupNaturalnessUi();

  const btnPitchReset = document.getElementById('btn-pitch-reset');
  if (btnPitchReset) {
    btnPitchReset.addEventListener('click', () => {
      const oldSnapshot = clonePitchCurveState();
      getPitchCurve().anchorPoints = [];
      getPitchCurve().brushSegments = [];
      // 派生段也是手动资产：Reset 语义是"清除所有手动内容，回到自动层"
      getPitchCurve().bakedSegments = [];
      invalidatePitchCurveCache();
      const newSnapshot = clonePitchCurveState();
      history.push({
        undo() { applyPitchCurveSnapshot(oldSnapshot); },
        redo() { applyPitchCurveSnapshot(newSnapshot); }
      });
      render();
      scheduleAutoSave();
    });
  }

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

  const btnClose = document.getElementById('btn-close');
  if (btnClose) {
    btnClose.addEventListener('click', () => {
      stopFragmentPlayback();
      const autoSaveTimer = getAutoSaveTimer();
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        setAutoSaveTimer(null);
      }
      saveFragmentData();
      window.close();
    });
  }

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

  if (btnPlayFragment) {
    btnPlayFragment.addEventListener('click', async () => {
      if (getNotes().length === 0) {
        showAlertDialog(t('fragment.noNotesToPlay'));
        return;
      }
      // 播放中优先按"停止"处理：流式播放期间合成仍在进行（isSynthesizing=true），
      // 旧顺序会在这里直接 return，按钮看似可点却毫无反应。
      if (getFragmentIsPlaying()) {
        stopFragmentPlayback();
        setFragmentCurrentTime(0);
        // 停止时重置播放起始位置，下次点击播放从头开始。
        // 用户可再次拖拽 playhead 设置新的起始位置。
        setFragmentPlayStartPosition(0);
        render();
        return;
      }
      if (getFragmentIsSynthesizing()) return;
      await playFragment();
    });
  }

  if (btnExportFragment) {
    btnExportFragment.addEventListener('click', async () => {
      if (getNotes().length === 0) {
        showAlertDialog(t('fragment.noNotesToExport'));
        return;
      }
      await exportFragment();
    });
  }

  if (btnExportFragmentMidi) {
    btnExportFragmentMidi.addEventListener('click', exportFragmentMidi);
  }

  const btnImportMidi = document.getElementById('btn-import-midi');
  if (btnImportMidi) btnImportMidi.addEventListener('click', async () => {
    try {
      const result = await window.electronAPI.importMidi();
      if (!result.success) {
        if (!result.canceled) {
          showAlertDialog(t('fragment.midiImportFailed') + ': ' + (result.error || t('fragment.unknownError')));
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

/**
 * 检查器读数的取值来源（写回目标仍是 _selectedTimbreAnchorIndex，见 _applyParamValue）：
 *   1. 该参数选中了唯一锚点 → 该锚点的数值；
 *   2. 否则若正在拖动该参数的某个锚点（Ctrl+点选取消选中后仍可拖动）→ 拖动的那个；
 *   3. 否则 → 该参数的全局默认值（无锚点时的常量）。
 * 2 必须存在：canvas 的拖动反馈选中的是 dragIdx，若这里退回默认值，
 * 拖动时面板会显示一个和曲线无关的数字。
 */
function _inspectorAnchorIndex(paramId) {
  const idx = _selectedTimbreAnchorIndex(paramId);
  if (idx >= 0) return idx;
  if (paramId !== getActiveTimbreParam()) return -1;
  const dragIdx = getTimbreDragAnchorIdx();
  if (dragIdx < 0) return -1;
  return getTimbreKeyframes(paramId)[dragIdx] ? dragIdx : -1;
}

/** 某参数在检查器里应当显示的数值（锚点值或默认值）。 */
function _inspectorValue(paramId) {
  const idx = _inspectorAnchorIndex(paramId);
  return idx >= 0 ? getTimbreKeyframes(paramId)[idx].value : getTimbreDefault(paramId);
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

/**
 * 悬浮提示卡的内容：参数名 + 分组/范围/默认值 + 作用说明 + 曲线操作提示。
 * 用函数而不是快照，切语言或数值变化后重新悬浮就能拿到最新文案。
 */
function _paramTipContent(param) {
  const group = POSTPROCESS_GROUPS.find(g => g.id === param.group);
  const parts = [];
  if (group) parts.push(t(group.labelKey));
  parts.push(`${t('fragment.ppTipRange')} ${formatParamValue(param.id, param.min, t)}–${formatParamValue(param.id, param.max, t)}`);
  parts.push(`${t('fragment.ppTipDefault')} ${formatParamValue(param.id, param.def, t)}`);
  return {
    title: t(param.labelKey),
    meta: parts.join(' · '),
    desc: `${t(param.descKey)}\n${t('fragment.ppTipAnchorHint')}`,
  };
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
    label.dataset.group = group.id;
    label.textContent = t(group.labelKey);
    attachHoverTip(label, () => ({ title: t(group.labelKey), desc: t(group.descKey) }));
    host.appendChild(label);
    for (const param of POSTPROCESS_PARAM_LIST.filter(p => p.group === group.id)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pp-chip';
      btn.dataset.param = param.id;
      btn.textContent = t(param.labelKey);
      // 不用原生 title：延迟 ~1s 且不跟随主题，改为 .pp-tip 悬浮卡。
      attachHoverTip(btn, () => _paramTipContent(param));
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
    title.dataset.group = group.id;
    title.textContent = t(group.labelKey);
    attachHoverTip(title, () => ({ title: t(group.labelKey), desc: t(group.descKey) }));
    host.appendChild(title);

    for (const param of POSTPROCESS_PARAM_LIST.filter(p => p.group === group.id)) {
      const row = document.createElement('div');
      row.className = 'pp-row';
      row.dataset.param = param.id;

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'pp-row-label';
      label.dataset.param = param.id;
      label.textContent = t(param.labelKey);
      attachHoverTip(label, () => _paramTipContent(param));
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
      attachHoverTip(slider, () => _paramTipContent(param));
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
      attachHoverTip(val, () => _paramTipContent(param));

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

  // 悬浮卡的兜底隐藏（滚动 / 失焦 / Esc / 改窗口大小）只注册一次。
  installHoverTipGlobalDismiss();

  // 底部 lane 的"音色"标签：说明这条 lane 的用法（每个参数一条曲线）。
  const timbreTab = document.querySelector('.param-lane-tab[data-lane="Timbre"]');
  attachHoverTip(timbreTab, () => ({
    title: t('fragment.laneTimbre'),
    desc: t('fragment.laneTimbreDesc'),
  }));

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
    // 「自定义」不是一个可套用的预设，只是"当前取值不属于任何预设"时的显示状态
    // （此前不匹配时下拉保持上一次的高亮，面板显示"标准"但实际值已被改过）。
    // disabled 使其不可被主动选中，change 处理器里的 find() 也会因此拿不到它而 return。
    const customOpt = document.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = t('fragment.ppPresetCustom');
    customOpt.disabled = true;
    presetSelect.appendChild(customOpt);
    presetSelect.value = 'off';
    attachHoverTip(presetSelect, () => ({
      title: t('fragment.ppPreset'),
      desc: t('fragment.ppPresetDesc'),
    }));
    presetSelect.addEventListener('change', () => {
      const preset = POSTPROCESS_PRESETS.find(p => p.id === presetSelect.value);
      if (!preset) return;
      const before = _snapshotPostprocess();
      // 预设替换**整组**状态：默认值 + 清空全部自动化锚点。
      // 旧行为只写默认值、保留曲线锚点 —— 锚点优先级高于默认值，导致"选了预设
      // 但音频没变"；且重开工程时下拉按默认值高亮该预设、曲线却是旧状态，
      // 与保存内容自相矛盾（预设显示"无"但曲线仍在）。撤销栈可恢复。
      const defaults = getPostprocessDefaults();
      const curves = getPostprocessCurves();
      for (const [paramId, value] of Object.entries(preset.values)) {
        if (defaults[paramId] !== undefined) defaults[paramId] = quantizeParamValue(paramId, value);
      }
      for (const paramId of Object.keys(curves)) {
        curves[paramId] = { keyframes: [] };
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
/**
 * 语言就绪 / 切换后重刷"动态生成"的音色文案。
 *
 * 子标签、检查器行、预设下拉是 setupPostprocessUi() 里用 t() 现场拼出来的，
 * 而它比 initI18n() 先跑（index.js），那时 locale 还是模块默认的 'en'；
 * applyLocale() 又只认带 data-i18n 的静态节点 —— 于是这些控件会永远停在
 * 英文。这里按注册表把文本全部重写一遍；悬浮卡内容本来就是每次显示重算，
 * 只需把已弹出的那张收掉。
 */
export function refreshPostprocessLabels() {
  const groupLabel = (id) => {
    const g = POSTPROCESS_GROUPS.find(x => x.id === id);
    return g ? t(g.labelKey) : null;
  };
  const paramLabel = (id) => {
    const p = POSTPROCESS_PARAMS[id];
    return p ? t(p.labelKey) : null;
  };

  for (const el of document.querySelectorAll('.pp-group-label[data-group], .pp-row-group[data-group]')) {
    const text = groupLabel(el.dataset.group);
    if (text) el.textContent = text;
  }
  for (const el of document.querySelectorAll('.pp-chip[data-param], .pp-row-label[data-param]')) {
    const text = paramLabel(el.dataset.param);
    if (text) el.textContent = text;
  }

  // 预设下拉的 option 文本
  const presetSelect = document.getElementById('pp-preset-select');
  if (presetSelect) {
    for (const opt of Array.from(presetSelect.options)) {
      const preset = POSTPROCESS_PRESETS.find(p => p.id === opt.value);
      if (preset) opt.textContent = t(preset.labelKey);
    }
  }

  // 读数里的单位（帧 / σ）与手动/自动标签也随语言变化
  syncPostprocessUi();
  // 正在显示的那张悬浮卡是旧语言渲染的，收掉让它下次悬浮重新生成
  hideHoverTip();
}

export function syncPostprocessUi() {
  const activeParam = getActiveTimbreParam();
  document.querySelectorAll('.pp-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.param === activeParam);
  });

  document.querySelectorAll('.pp-slider').forEach(slider => {
    const paramId = slider.dataset.param;
    if (!paramId) return;
    const value = _inspectorValue(paramId);
    if (document.activeElement !== slider) {
      slider.value = String(value);
    }
    _syncValueLabel(paramId, value);
  });

  _syncModeTag(activeParam);

  // 预设下拉：默认值恰好等于某个预设时高亮它，否则回落到「自定义」——
  // 不回落的话选了预设再动任一滑块，下拉仍高亮该预设，面板与实际取值不符。
  const presetSelect = document.getElementById('pp-preset-select');
  if (presetSelect && document.activeElement !== presetSelect) {
    const defaults = getPostprocessDefaults();
    const match = POSTPROCESS_PRESETS.find(preset =>
      Object.entries(preset.values).every(([id, v]) => Math.abs((defaults[id] ?? 0) - v) < 1e-6));
    presetSelect.value = match ? match.id : 'custom';
  }
}

/**
 * 只刷新单个参数的检查器读数（曲线拖动 / 增删锚点这类高频路径）。
 *
 * 整面板 syncPostprocessUi() 会遍历全部滑块并重算预设高亮；拖锚点时每帧都跑一遍
 * 没有必要，而且在拖动中重写所有滑块只会让读数闪。这里只动受影响的那一行。
 */
export function syncTimbreParamValue(paramId) {
  if (!paramId) return;
  const value = _inspectorValue(paramId);
  const slider = document.querySelector(`.pp-slider[data-param="${paramId}"]`);
  // 用户正在拖这个滑块时不回写，避免和输入打架
  if (slider && document.activeElement !== slider) slider.value = String(value);
  _syncValueLabel(paramId, value);
  if (paramId === getActiveTimbreParam()) _syncModeTag(paramId);
}

/**
 * 自动音高曲线的开关 / 预设 / 高级参数面板。
 *
 * 设计约束（设计方案 §3 契约 C1–C8）：
 *   · 不做任何"拦截式"交互：改参数只影响自动层，手动资产原样保留；
 *   · 每一次改动都进撤销栈（快照含 auto + bakedSegments）；
 *   · 参数面板里没有任何只读/联动锁死的项，改任何一项都会自动切到 "custom"。
 */
export function setupAutoPitchUi() {
  const enabledEl = document.getElementById('auto-pitch-enabled');
  const presetEl = document.getElementById('auto-pitch-preset');
  const btnParams = document.getElementById('btn-auto-pitch-params');
  const panel = document.getElementById('auto-pitch-panel');
  const btnClose = document.getElementById('btn-auto-pitch-close');
  const glideOwnEl = document.getElementById('auto-glide-ownership');
  const inputs = Array.from(document.querySelectorAll('[data-auto-param]'));
  if (!enabledEl || !presetEl || !panel) return null;

  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  const setPath = (obj, path, val) => {
    const ks = path.split('.');
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) {
      if (!o[ks[i]] || typeof o[ks[i]] !== 'object') o[ks[i]] = {};
      o = o[ks[i]];
    }
    o[ks[ks.length - 1]] = val;
  };

  function ensureAuto() {
    const pc = getPitchCurve();
    if (!pc.auto) {
      pc.auto = { enabled: false, preset: 'natural', version: 1, params: { ...AUTO_PITCH_DEFAULTS } };
    } else if (!pc.auto.params) {
      pc.auto.params = { ...AUTO_PITCH_DEFAULTS };
    }
    if (!pc.auto.params.autoVibrato) {
      pc.auto.params.autoVibrato = { ...AUTO_PITCH_DEFAULTS.autoVibrato };
    }
    return pc.auto;
  }

  function sync() {
    const auto = getPitchCurve().auto;
    enabledEl.checked = !!(auto && auto.enabled);
    presetEl.value = auto && auto.preset ? auto.preset : 'natural';
    const params = (auto && auto.params) || AUTO_PITCH_DEFAULTS;
    for (const inp of inputs) {
      const v = getPath(params, inp.dataset.autoParam);
      if (typeof v === 'number') inp.value = String(Number(v.toFixed(3)));
    }
    if (glideOwnEl) glideOwnEl.value = params.glideOwnership || 'auto';
  }

  function commit(mutator) {
    const before = clonePitchCurveState();
    const auto = ensureAuto();
    mutator(auto);
    auto.version = (auto.version || 0) + 1;
    invalidatePitchCurveCache();
    const after = clonePitchCurveState();
    history.push({
      undo() { applyPitchCurveSnapshot(before); sync(); render(); },
      redo() { applyPitchCurveSnapshot(after); sync(); render(); },
    });
    render();
    scheduleAutoSave();
    sync();
  }

  enabledEl.addEventListener('change', () => {
    commit((a) => { a.enabled = enabledEl.checked; });
  });

  presetEl.addEventListener('change', () => {
    commit((a) => {
      const id = presetEl.value;
      a.preset = id;
      a.enabled = id !== 'off';
      a.params = paramsForPreset(id);
    });
  });

  if (btnParams) btnParams.addEventListener('click', () => { panel.hidden = !panel.hidden; sync(); });
  if (btnClose) btnClose.addEventListener('click', () => { panel.hidden = true; });

  for (const inp of inputs) {
    inp.addEventListener('change', () => {
      const num = Number(inp.value);
      if (!Number.isFinite(num)) { sync(); return; }
      const path = inp.dataset.autoParam;
      commit((a) => {
        setPath(a.params, path, num);
        // 改任一参数即离开预设，避免"选了预设又偷偷改了一项"的语义混乱
        a.preset = 'custom';
      });
    });
  }

  if (glideOwnEl) {
    glideOwnEl.addEventListener('change', () => {
      commit((a) => { a.params.glideOwnership = glideOwnEl.value; });
    });
  }

  // 分片数据载入后刷新控件（ipcHandlers 载入完成时派发）
  document.addEventListener('sxse:fragment-loaded', sync);
  sync();
  return { sync };
}

/**
 * 自然度自检面板。
 *
 * 与"参数面板"的分工：参数面板控制**生成规则**（改了立刻听得到），自检面板
 * 测量**实际输出**（改完再测）。两者都读同一份曲线，所以自检结果自动包含
 * 手动覆盖与颤音 —— 它评的是"最终听到的东西"，不是"参数好不好看"。
 *
 * 只在用户点击时运行：单个音符采样 200 点，300 音符 ≈ 6 万次求值，
 * 放渲染循环里会拖慢拖拽。
 */
export function setupNaturalnessUi() {
  const btn = document.getElementById('btn-nat-run');
  const rows = document.getElementById('nat-rows');
  const scoreTag = document.getElementById('nat-score-tag');
  if (!btn || !rows) return null;

  const render = () => {
    const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
    const notes = getClippedNotes();
    if (notes.length === 0) {
      rows.innerHTML = `<div class="nat-row"><span class="nat-label">${t('fragment.natNoNotes')}</span></div>`;
      if (scoreTag) scoreTag.textContent = '--';
      return;
    }
    const ranges = resolvePitchRanges(notes);
    const result = analyzeNaturalness({
      pitchAt: (beat) => getPitchAtTime(beat),
      notes,
      bpm,
      ranges,
    });

    if (scoreTag) {
      scoreTag.textContent = String(result.score);
      scoreTag.style.color = result.score >= 80 ? '#4ade80'
        : result.score >= 50 ? '#facc15' : '#f87171';
    }

    const frag = document.createDocumentFragment();
    for (const item of result.items) {
      const row = document.createElement('div');
      row.className = `nat-row ${item.status}`;
      const label = document.createElement('span');
      label.className = 'nat-label';
      label.textContent = t('fragment.' + item.label);
      const value = document.createElement('span');
      value.className = 'nat-value';
      value.textContent = item.value === null
        ? '—'
        : `${typeof item.value === 'number' ? item.value.toFixed(1) : item.value} ${item.unit}`;
      const target = document.createElement('span');
      target.className = 'nat-target';
      target.textContent = item.target;
      row.append(label, value, target);
      frag.appendChild(row);
    }
    rows.innerHTML = '';
    rows.appendChild(frag);
  };

  btn.addEventListener('click', render);
  // 打开分片后先算一次，避免用户看到空面板以为坏了
  document.addEventListener('sxse:fragment-loaded', render);
  render();
  return { render };
}
