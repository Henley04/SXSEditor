import { t, tOr } from '../i18n/index.js';
import { setLabel } from '../icons/iconHelper.js';
// pitchCurve 归一化：补齐 auto/bakedSegments 默认值，并保留未来字段
import { normalizePitchCurve } from '../shared/pitchCurveState.js';
import {
  getFragmentIsSynthesizing,
  getFragmentIsExporting,
  getFragmentIsPlaying,
  getPitchCurve,
  getNotes,
  getSelectedNoteIds,
  getSelectedAnchorIndices,
  getIpcCleanups,
  getFragmentDataReceived,
  getPendingBoundsUpdate, setPendingBoundsUpdate,
  getCurrentFragment,
  getCurrentProject,
  setScrollY,
  setWavFileBuffer,
  setPitchCurveSnapshotBeforeDrag,
  setEnvelopeSnapshotBeforeDrag,
  setDragOperation,
  setDragMode,
  setLyricEditOldValue,
  setLyricEditNoteId,
  setNextNoteId,
  getPhonemeCache,
  setCurrentParamMode,
  setNotes,
  setEnvelopes,
  setPitchCurve,
  setCurrentFragment,
  setCurrentProject,
  setTrackBackend,
  invalidatePitchCurveCache,
  setFragmentDataReceived,
  getKanjiGroups, setKanjiGroups,
  setPostprocess, invalidateTimbreCache, getSelectedTimbreAnchors,
} from './state.js';
import { PARAM_MODES } from './constants.js';
import { normalizePostprocessState } from '../shared/postprocessCurves.js';
import { render, resizeCanvases, computeInitialScrollY, convertExistingBrushSegmentsToAnchorPoints, resolvePhonemesFromPipeline, genNoteId } from './canvasRenderer.js';
import { updateParamModeButtons, syncPostprocessUi } from './uiControls.js';
import { normalizeTrackBackend } from './pluginEditorMode.js';
import { autoDetectKanjiGroups, cleanupKanjiGroups } from './kanjiGroupUtils.js';
import { showAlertDialog } from '../alertDialog.js';

export function setupIpcHandlers() {
  const _ipcCleanups = getIpcCleanups();

  // int8 旧版 diff_step 模型不兼容弹窗（主进程在 fragment-svs:init 时检测并推送一次）
  if (window.electronAPI?.onSVSDiffStepIncompatible) {
    const cleanupIncompatible = window.electronAPI.onSVSDiffStepIncompatible(() => {
      showAlertDialog(tOr('main.diffStepLegacyInt8Incompatible', 'An incompatible legacy INT8 diff_step model was detected. Please update the model.'));
    });
    if (cleanupIncompatible) _ipcCleanups.push(cleanupIncompatible);
  }

  const cleanupProgress = window.electronAPI.onFragmentSVSProgress((progress) => {
    // 区分播放预览和导出：各自只更新对应的按钮，避免互相覆盖。
    // 之前回调同时更新两个按钮，播放时导出按钮也被改成"导出 X%"，
    // 而导出时因 fragmentIsSynthesizing=false 两个按钮都不更新。
    // 流式播放期间（isPlaying）不要把按钮改回"合成中 X%"：那一轮合成还没结束，
    // 但按钮此刻的语义是"停止"（见 updateFragmentPlayButton），进度条位置由
    // 画布播放头体现；否则按钮文案在"停止/合成中"之间来回跳。
    if (getFragmentIsSynthesizing() && !getFragmentIsPlaying()) {
      const btnPlayFragment = document.getElementById('btn-play-fragment');
      if (btnPlayFragment) setLabel(btnPlayFragment, t('fragment.synthesizingProgress', { progress }), { icon: 'play' });
    } else if (getFragmentIsExporting()) {
      const btnExportFragment = document.getElementById('btn-export-fragment');
      if (btnExportFragment) setLabel(btnExportFragment, t('fragment.exportingProgress', { progress }), { icon: 'download' });
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
  // 轨道后端（内置 {type:'sxs'} 或插件 {type:'plugin', pluginId, kindId}）。
  // 走 getFragmentData 兜底路径时 payload 可能没有 backend 字段（老工程/旧主进程），
  // 这里退化成内置后端而不是报错 —— 形态裁剪由 pluginEditorMode.js 负责。
  setTrackBackend(normalizeTrackBackend(data.backend));
  document.getElementById('fragment-name').textContent = data.fragment.name || t('fragment.fragment');
  // 规范化 notes：为旧项目的 note 补全 vibrato/fadeIn/fadeOut 字段。
  // vibrato 在首次启用时由 ensureVibrato() 补全，这里只确保 fadeIn/fadeOut 有默认值。
  setNotes((data.fragment.notes || []).map(n => ({
    ...n,
    fadeIn: typeof n.fadeIn === 'number' ? n.fadeIn : 0,
    fadeOut: typeof n.fadeOut === 'number' ? n.fadeOut : 0,
  })));
  setEnvelopes(data.fragment.envelopes || {
    volume: { keyframes: [{ time: 0, value: 1, smoothness: 0 }] },
    pan: { keyframes: [{ time: 0, value: 0, smoothness: 0 }] },
  });

  if (data.fragment.pitchCurve) {
    // 合并式归一化（不是三字段白名单重建）：
    // 旧代码只取 enabled/anchorPoints/brushSegments，导致 auto 参数与
    // bakedSegments 在"打开编辑器 → 500ms 自动保存"后被永久抹掉。
    // normalizePitchCurve 会补默认值、夹紧数值，并保留未识别的未来字段。
    setPitchCurve(normalizePitchCurve(data.fragment.pitchCurve));
    if (getPitchCurve().brushSegments.length > 0) {
      convertExistingBrushSegmentsToAnchorPoints();
    }
  } else {
    // 极旧工程没有 pitchCurve 字段：按"无自动曲线"处理，保持听感不变
    setPitchCurve(normalizePitchCurve(null));
  }
  invalidatePitchCurveCache();
  // 通知 UI 刷新自动曲线控件（开关/预设/参数面板）
  try { document.dispatchEvent(new CustomEvent('sxse:fragment-loaded')); } catch (_e) { /* 非 DOM 环境忽略 */ }

  // 音色 / 后处理曲线：旧工程没有该字段 → 退回全默认（所有处理关闭，音频与旧版本一致）。
  // normalizePostprocessState 逐参数合并到注册表默认值上，并把默认值/锚点值全部
  // 夹紧到注册表值域 —— 手改工程或跨版本字段越界时不会把越界 σ/百分比送进管线
  // （σ 越界会让高斯核半径按 3σ 膨胀，最坏情况长时间卡死主进程）。
  setPostprocess(normalizePostprocessState(data.fragment.postprocess || null));
  invalidateTimbreCache();
  getSelectedTimbreAnchors().clear();
  // 检查器是在 setupPostprocessUi() 里按"启动时的空状态"建好的；工程里的
  // 默认值/曲线此刻才载入，不刷新的话右侧面板会一直显示上一个分片的数值。
  syncPostprocessUi();

  setDragOperation(null);
  setDragMode(null);
  setPitchCurveSnapshotBeforeDrag(null);
  setEnvelopeSnapshotBeforeDrag(null);
  getSelectedNoteIds().clear();
  getSelectedAnchorIndices().clear();
  setLyricEditOldValue(null);
  setLyricEditNoteId(null);
  setNextNoteId(getNotes().reduce((max, n) => Math.max(max, (n.id || 0) + 1), 1));

  // 加载已保存的汉字分组，并自动检测：若分片含假名，则将汉字切分为假名
  setKanjiGroups(data.fragment.kanjiGroups || []);
  const _kanjiGroups = getKanjiGroups();
  autoDetectKanjiGroups(getNotes(), _kanjiGroups, genNoteId);
  cleanupKanjiGroups(getNotes(), _kanjiGroups);

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
