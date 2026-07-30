import { showAlertDialog } from '../alertDialog.js';
import { HistoryManager } from '../editor/historyManager.js';
import { initPipeline } from './pipeline.js';
import {
  BEAT_WIDTH, NOTE_HEIGHT, HEADER_HEIGHT, PARAM_CURVE_HEIGHT, PARAM_MODES,
} from './constants.js';
import {
  getNotes, setNotes,
  getSnapGrid,
  getSelectedNoteIds, setSelectedNoteIds,
  getSelectedAnchorIndices, setSelectedAnchorIndices,
  getDragMode, setDragMode,
  getDragStartX, setDragStartX,
  getDragStartY, setDragStartY,
  getDragStartMouseTime, setDragStartMouseTime,
  getDragStartMousePitch, setDragStartMousePitch,
  getDragNoteStart, setDragNoteStart,
  getDragNoteStarts, setDragNoteStarts,
  getScrollX, setScrollX,
  getScrollY, setScrollY,
  getZoomX, setZoomX,
  getIsBoxSelecting, setIsBoxSelecting,
  getBoxSelectStart, setBoxSelectStart,
  getBoxSelectEnd, setBoxSelectEnd,
  getPitchDragAnchorIdx, setPitchDragAnchorIdx,
  getPitchDragStartValue, setPitchDragStartValue,
  getPitchDragStartTime, setPitchDragStartTime,
  getPitchDragAnchorStarts, setPitchDragAnchorStarts,
  getPitchSmoothDragAnchorStarts, setPitchSmoothDragAnchorStarts,
  getPitchSmoothDragMoved, setPitchSmoothDragMoved,
  getPitchSmoothDragRightClickPos, setPitchSmoothDragRightClickPos,
  getContextMenuAnchorIdx, setContextMenuAnchorIdx,
  getIsBrushDrawing, setIsBrushDrawing,
  getCurrentBrushStroke, setCurrentBrushStroke,
  getBrushSmoothing,
  getDragOperation, setDragOperation,
  getPitchCurveSnapshotBeforeDrag, setPitchCurveSnapshotBeforeDrag,
  getEnvelopeSnapshotBeforeDrag, setEnvelopeSnapshotBeforeDrag,
  getPhonemeDragState, setPhonemeDragState,
  getSelectedPhonemeNoteId, setSelectedPhonemeNoteId,
  getSelectedPhonemeIndex, setSelectedPhonemeIndex,
  getHoveredNoteId, setHoveredNoteId,
  setActiveNoteId,
  setActiveAnchorIdx,
  setActivePhonemeKey,
  bumpNotesVersion,
  getParamEnvelopeDrag, setParamEnvelopeDrag,
  getActiveInlineInput, setActiveInlineInput,
  getActiveInlineEditNote, setActiveInlineEditNote,
  getLyricEditOldValue, setLyricEditOldValue,
  getLyricEditNoteId, setLyricEditNoteId,
  getCurrentParamMode, setCurrentParamMode,
  getPitchCurve,
  getCurrentProject,
  getFragmentIsPlaying,
  getFragmentCurrentTime,
  getFragmentPlayStartPosition, setFragmentPlayStartPosition,
  getCurrentFragment,
  invalidatePitchCurveCache,
  getAutoSaveTimer, setAutoSaveTimer,
  getEnvelopes,
  getParamPanelCollapsed, setParamPanelCollapsed,
  getParamPanelMode, setParamPanelMode,
  getKanjiGroups, setKanjiGroups,
} from './state.js';
import {
  canvas, ctx,
  timeToX, xToTime, pitchToY, yToPitch, yToPitchContinuous,
  snapBeats, findNoteAt, findKanjiGroupAt, findPlayheadAt, getPlayheadX,
  _getParamCurveAreaTop, _getParamCurveAreaBottom, _getParamCurveYRange,
  _valueToParamY,
  deepClone, clonePitchCurveState, applyPitchCurveSnapshot,
  cloneEnvelopeState, applyEnvelopeSnapshot,
  genNoteId, hasNoteOverlap, hasNoteOverlapMulti, clampNotePosition,
  findAnchorPointAt,
  convertBrushStrokeToAnchorPoints,
  getPhonemeAdjustments, getPhonemeStartX, normalizePhonemeRatios,
  tokenizeLyric, resolvePhonemesFromPipeline,
  render, resizeCanvases,
  _getCanvasRendererNotesIndex,
} from './canvasRenderer.js';
import { computeMultiDragResult, findAdjacentBoundary } from './notesIndex.js';
import {
  autoDetectKanjiGroups, cleanupKanjiGroups,
  findGroupByNoteId, splitKanjiNoteToKana, mergeKanaGroupToKanji,
  isSingleKanji, isTimeRangeWithinAnyGroup, getAllGroupedNoteIds,
} from './kanjiGroupUtils.js';
import { stopFragmentPlayback, playFragment, exportFragment, seekFragmentPlayback } from './audioPlayback.js';
import { scheduleAutoSave, saveFragmentData } from './projectIO.js';
import { updateFragmentPlayButton, updateParamModeButtons, updateParamPanelState, showShortcutsPanel, hideShortcutsPanel } from './uiControls.js';

const history = new HistoryManager();

export { history };

// 缓存 canvas 的 bounding rect，避免每个 mousemove 事件都触发 layout read。
// 在 scroll/resize/drag 结束时通过 _invalidateCanvasRect() 失效。
let _canvasRectCache = null;
function _getCanvasRect() {
  if (!_canvasRectCache) {
    _canvasRectCache = canvas.getBoundingClientRect();
  }
  return _canvasRectCache;
}
function _invalidateCanvasRect() {
  _canvasRectCache = null;
}

function getMousePos(e) {
  const rect = _getCanvasRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function applyNoteDrag(pos) {
  const dragMode = getDragMode();
  if (dragMode !== 'move' && dragMode !== 'resize') return false;

  const selectedNoteIds = getSelectedNoteIds();
  const notes = getNotes();

  if (dragMode === 'move' && selectedNoteIds.size > 1) {
    const dxBeats = xToTime(pos.x) - getDragStartMouseTime();
    const dyPitch = Math.round(yToPitchContinuous(pos.y) - getDragStartMousePitch());
    // 构建 O(1) note 查询表，避免每帧对每个选中 note 做 O(n) 数组扫描
    const noteMap = {};
    for (const n of notes) {
      if (selectedNoteIds.has(n.id)) noteMap[n.id] = n;
    }
    // 1. 先计算所有选中 notes 的原始新位置（未截断到 0）
    const rawPlanned = [];
    for (const id of selectedNoteIds) {
      const note = noteMap[id];
      const start = getDragNoteStarts().get(id);
      if (note && start) {
        const rawStart = snapBeats(start.start + dxBeats);
        const newPitch = Math.max(0, Math.min(127, start.pitch + dyPitch));
        rawPlanned.push({ note, rawStart, newPitch, duration: note.duration });
      }
    }
    if (rawPlanned.length === 0) {
      render();
      return true;
    }
    // 2. 若最左 note 越界（rawStart < 0），整体平移使最左 note 落到 0，
    //    保持选中 notes 之间的相对位置不变，避免 Math.max(0, ...) 单独截断
    //    导致相对位置错乱、产生新重叠或视觉错位。
    let minRawStart = Infinity;
    for (const p of rawPlanned) {
      if (p.rawStart < minRawStart) minRawStart = p.rawStart;
    }
    const shift = minRawStart < 0 ? -minRawStart : 0;
    // 3. 计算最终新位置（已保证 >= 0）并检测与非选中 notes 的重叠。
    //    分组假名不受重叠限制，允许自由移动（重叠警告仍由 getInactiveNoteIds 渲染）。
    //    批量化：用 computeMultiDragResult 一次性算所有非 grouped 选中 notes 与
    //    障碍的重叠情况，O((k+n) log k) 而非 O(k·log n)。
    const nonGroupedSelected = new Set();
    const newPositions = new Map();
    for (const p of rawPlanned) {
      const newStart = p.rawStart + shift;
      const isGroupedKana = findGroupByNoteId(p.note.id, getKanjiGroups()) !== null;
      if (!isGroupedKana) {
        nonGroupedSelected.add(p.note.id);
        newPositions.set(p.note.id, {
          start: newStart,
          pitch: p.newPitch,
          duration: p.duration,
        });
      }
    }
    let blocked = false;
    if (nonGroupedSelected.size > 0) {
      const idx = _getCanvasRendererNotesIndex();
      const r = computeMultiDragResult(idx, nonGroupedSelected, newPositions);
      blocked = r.blocked;
    }
    if (!blocked) {
      for (const p of rawPlanned) {
        const newStart = p.rawStart + shift;
        p.note.start = newStart;
        p.note.pitch = p.newPitch;
      }
    }
    render();
    return true;
  }

  const note = notes.find(n => n.id === [...selectedNoteIds][0]);
  if (!note) return true;

  if (dragMode === 'move') {
    const dxBeats = xToTime(pos.x) - getDragStartMouseTime();
    const dyPitch = Math.round(yToPitchContinuous(pos.y) - getDragStartMousePitch());
    let newStart = Math.max(0, snapBeats(getDragNoteStart().start + dxBeats));
    const newPitch = Math.max(0, Math.min(127, getDragNoteStart().pitch + dyPitch));
    // Grouped kana notes: allow free movement (no snap/clamp/overlap block)
    // so users can position them freely; overlap warning still renders via getInactiveNoteIds.
    const isGroupedKana = findGroupByNoteId(note.id, getKanjiGroups()) !== null;
    if (isGroupedKana) {
      note.start = newStart;
      note.pitch = newPitch;
    } else {
      // Magnetic boundary snap: if newStart is within 4px of an adjacent
      // note's start or end at this pitch, snap to that boundary. Lets the
      // user feel when notes "click" together; bypasses grid snap.
      const idx = _getCanvasRendererNotesIndex();
      const pxPerBeat = BEAT_WIDTH * getZoomX();
      if (pxPerBeat > 0) {
        const snapBeatsWindow = 4 / pxPerBeat;
        const excludeSet = new Set([note.id]);
        const snappedStart = findAdjacentBoundary(idx, excludeSet, newPitch, newStart, snapBeatsWindow);
        if (snappedStart !== newStart && snappedStart >= 0) {
          newStart = snappedStart;
        }
      }
      newStart = clampNotePosition(note.id, newPitch, newStart, note.duration);
      if (!hasNoteOverlap(note.id, newPitch, newStart, newStart + note.duration)) {
        note.start = newStart;
        note.pitch = newPitch;
      }
    }
  } else if (dragMode === 'resize') {
    const dxBeats = xToTime(pos.x) - getDragStartMouseTime();
    // Resize minimum = one snap grid cell, so the result always lands on a
    // grid line and stays >= the smallest editable unit.
    const minDuration = getSnapGrid();
    let newDuration = Math.max(minDuration, snapBeats(getDragNoteStart().duration + dxBeats));
    const isGroupedKana = findGroupByNoteId(note.id, getKanjiGroups()) !== null;
    if (isGroupedKana || !hasNoteOverlap(note.id, note.pitch, note.start, note.start + newDuration)) {
      // Magnetic snap for resize: snap the trailing edge to the nearest
      // adjacent note boundary at this pitch (start or end of neighbor).
      const idx = _getCanvasRendererNotesIndex();
      const pxPerBeat = BEAT_WIDTH * getZoomX();
      if (pxPerBeat > 0) {
        const snapBeatsWindow = 4 / pxPerBeat;
        const excludeSet = new Set([note.id]);
        const proposedEnd = note.start + newDuration;
        const snappedEnd = findAdjacentBoundary(idx, excludeSet, note.pitch, proposedEnd, snapBeatsWindow);
        if (snappedEnd !== proposedEnd && snappedEnd > note.start) {
          const snappedDur = snappedEnd - note.start;
          if (snappedDur >= minDuration && !hasNoteOverlap(note.id, note.pitch, note.start, snappedEnd)) {
            newDuration = snappedDur;
          }
        }
      }
      note.duration = newDuration;
    }
  }
  render();
  return true;
}

function applyPitchAnchorDrag(pos) {
  if (getDragMode() !== 'pitch-anchor' || getPitchDragAnchorIdx() < 0) return false;

  const dxBeats = xToTime(pos.x) - getDragStartMouseTime();
  const dyPitch = yToPitchContinuous(pos.y) - getDragStartMousePitch();
  const selectedAnchorIndices = getSelectedAnchorIndices();
  const pitchCurve = getPitchCurve();
  if (selectedAnchorIndices.size > 1 && getPitchDragAnchorStarts().size > 0) {
    for (const idx of selectedAnchorIndices) {
      const ap = pitchCurve.anchorPoints[idx];
      const start = getPitchDragAnchorStarts().get(idx);
      if (ap && start) {
        ap.time = Math.max(0, start.time + dxBeats);
        ap.pitch = Math.max(0, Math.min(127, start.pitch + dyPitch));
      }
    }
  } else {
    const ap = pitchCurve.anchorPoints[getPitchDragAnchorIdx()];
    if (ap) {
      ap.time = Math.max(0, getPitchDragStartTime() + dxBeats);
      ap.pitch = Math.max(0, Math.min(127, getPitchDragStartValue() + dyPitch));
    }
  }
  invalidatePitchCurveCache();
  render();
  return true;
}

// 右键拖拽调节 smoothness：水平移动（右增左减）+ 垂直移动（上增下减），
// 两轴合并使用，1px ≈ 1 单位（总范围 0~100）。
// 同时作用于所有选中的锚点，便于批量调整。
function applyPitchSmoothnessDrag(pos) {
  if (getDragMode() !== 'pitch-smoothness') return false;
  const starts = getPitchSmoothDragAnchorStarts();
  if (starts.size === 0) return false;

  const dx = pos.x - getDragStartX();
  const dy = pos.y - getDragStartY();
  // 移动阈值：超过 2px 才视为真实拖拽，避免误触发
  if (!getPitchSmoothDragMoved() && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
    setPitchSmoothDragMoved(true);
  }
  if (!getPitchSmoothDragMoved()) return true;

  // dx 正向（右）增加，dy 负向（上）增加
  const delta = dx - dy;
  const pitchCurve = getPitchCurve();
  for (const [idx, start] of starts) {
    const ap = pitchCurve.anchorPoints[idx];
    if (!ap) continue;
    const next = Math.max(0, Math.min(100, Math.round(start.smoothness + delta)));
    ap.smoothness = next;
  }
  invalidatePitchCurveCache();
  render();
  return true;
}

function _pitchSmoothnessDragHasChange(startSnapshot) {
  if (!startSnapshot) return false;
  const starts = getPitchSmoothDragAnchorStarts();
  const pitchCurve = getPitchCurve();
  for (const [idx, start] of starts) {
    const ap = pitchCurve.anchorPoints[idx];
    if (!ap) continue;
    if ((ap.smoothness ?? 0) !== (start.smoothness ?? 0)) return true;
  }
  return false;
}

function _finalizePitchSmoothnessDrag(commitHistory) {
  const startSnapshot = getPitchCurveSnapshotBeforeDrag();
  setDragMode(null);
  getPitchSmoothDragAnchorStarts().clear();
  setPitchSmoothDragMoved(false);
  setPitchSmoothDragRightClickPos(null);

  if (commitHistory && startSnapshot) {
    const newSnapshot = clonePitchCurveState();
    history.push({
      undo() { applyPitchCurveSnapshot(startSnapshot); },
      redo() { applyPitchCurveSnapshot(newSnapshot); }
    });
    scheduleAutoSave();
  } else {
    // 未发生改动 → 还原 snapshot 以保持 history 干净
    setPitchCurveSnapshotBeforeDrag(null);
  }
}

// ==================== Pitch Anchor Context Menu ====================
function showPitchContextMenu(clientX, clientY, anchorIdx) {
  const menu = document.getElementById('pitch-anchor-context-menu');
  if (!menu) return;
  const pitchCurve = getPitchCurve();
  if (anchorIdx < 0 || !pitchCurve.anchorPoints[anchorIdx]) {
    hidePitchContextMenu();
    return;
  }
  setContextMenuAnchorIdx(anchorIdx);

  // 同步滑块与数值显示为当前锚点的 smoothness
  const ap = pitchCurve.anchorPoints[anchorIdx];
  const currentValue = Math.max(0, Math.min(100, Math.round(ap.smoothness ?? 0)));
  const slider = document.getElementById('pitch-ctx-smoothness-slider');
  const valueLabel = document.getElementById('pitch-ctx-smoothness-value');
  if (slider) slider.value = String(currentValue);
  if (valueLabel) valueLabel.textContent = String(currentValue);
  _updatePresetActiveState(currentValue);

  // 计算菜单位置，避免溢出窗口
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = clientX;
  let y = clientY;
  // 预先测量宽度（display:none 时无法测量，临时显示再读）
  menu.style.visibility = 'hidden';
  menu.style.display = 'flex';
  const measured = menu.getBoundingClientRect();
  const w = measured.width;
  const h = measured.height;
  menu.style.visibility = '';
  if (x + w > vw - 4) x = Math.max(4, vw - w - 4);
  if (y + h > vh - 4) y = Math.max(4, vh - h - 4);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.setAttribute('aria-hidden', 'false');

  // 为打开菜单时记录 snapshot，便于滑块/预设调整后入 history
  setPitchCurveSnapshotBeforeDrag(clonePitchCurveState());
}

function hidePitchContextMenu() {
  const menu = document.getElementById('pitch-anchor-context-menu');
  if (menu) {
    menu.style.display = 'none';
    menu.setAttribute('aria-hidden', 'true');
  }
  if (getContextMenuAnchorIdx() >= 0) {
    setContextMenuAnchorIdx(-1);
  }
  setPitchCurveSnapshotBeforeDrag(null);
}

function _updatePresetActiveState(currentValue) {
  const menu = document.getElementById('pitch-anchor-context-menu');
  if (!menu) return;
  const presets = menu.querySelectorAll('.pitch-ctx-preset');
  presets.forEach(btn => {
    const v = parseInt(btn.getAttribute('data-smoothness') || '-1', 10);
    btn.classList.toggle('active', v === currentValue);
  });
}

function _applySmoothnessToAnchor(anchorIdx, newValue, commitHistory) {
  const pitchCurve = getPitchCurve();
  const ap = pitchCurve.anchorPoints[anchorIdx];
  if (!ap) return;
  const value = Math.max(0, Math.min(100, Math.round(newValue)));
  if ((ap.smoothness ?? 0) === value) return;
  ap.smoothness = value;
  invalidatePitchCurveCache();
  _updatePresetActiveState(value);
  const valueLabel = document.getElementById('pitch-ctx-smoothness-value');
  const slider = document.getElementById('pitch-ctx-smoothness-slider');
  if (valueLabel) valueLabel.textContent = String(value);
  if (slider) slider.value = String(value);
  render();
  if (commitHistory) {
    const startSnapshot = getPitchCurveSnapshotBeforeDrag();
    if (startSnapshot) {
      const newSnapshot = clonePitchCurveState();
      history.push({
        undo() { applyPitchCurveSnapshot(startSnapshot); },
        redo() { applyPitchCurveSnapshot(newSnapshot); }
      });
      scheduleAutoSave();
      // 一次完整修改后重置 snapshot，避免后续调整被合并到同一条历史
      setPitchCurveSnapshotBeforeDrag(clonePitchCurveState());
    } else {
      scheduleAutoSave();
    }
  } else {
    scheduleAutoSave();
  }
}

function _setupPitchContextMenuListeners() {
  const menu = document.getElementById('pitch-anchor-context-menu');
  if (!menu) return;

  const slider = document.getElementById('pitch-ctx-smoothness-slider');
  if (slider) {
    // input 事件实时更新（不入 history），change 事件提交一次 history
    slider.addEventListener('input', () => {
      const anchorIdx = getContextMenuAnchorIdx();
      if (anchorIdx < 0) return;
      const value = parseInt(slider.value, 10);
      const pitchCurve = getPitchCurve();
      const ap = pitchCurve.anchorPoints[anchorIdx];
      if (!ap) return;
      ap.smoothness = Math.max(0, Math.min(100, value));
      invalidatePitchCurveCache();
      _updatePresetActiveState(ap.smoothness);
      const valueLabel = document.getElementById('pitch-ctx-smoothness-value');
      if (valueLabel) valueLabel.textContent = String(ap.smoothness);
      render();
    });
    slider.addEventListener('change', () => {
      const anchorIdx = getContextMenuAnchorIdx();
      if (anchorIdx < 0) return;
      _applySmoothnessToAnchor(anchorIdx, parseInt(slider.value, 10), true);
    });
  }

  const presets = menu.querySelectorAll('.pitch-ctx-preset');
  presets.forEach(btn => {
    btn.addEventListener('click', () => {
      const anchorIdx = getContextMenuAnchorIdx();
      if (anchorIdx < 0) return;
      const value = parseInt(btn.getAttribute('data-smoothness') || '0', 10);
      _applySmoothnessToAnchor(anchorIdx, value, true);
    });
  });

  const deleteBtn = document.getElementById('pitch-ctx-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      const anchorIdx = getContextMenuAnchorIdx();
      if (anchorIdx < 0) return;
      const pitchCurve = getPitchCurve();
      const selectedAnchorIndices = getSelectedAnchorIndices();
      // 优先删除所有选中锚点（与旧右键删除行为一致），否则仅删除当前锚点
      const indicesToDelete = selectedAnchorIndices.size > 0
        ? [...selectedAnchorIndices].sort((a, b) => b - a)
        : [anchorIdx];
      const oldSnapshot = clonePitchCurveState();
      for (const idx of indicesToDelete) {
        pitchCurve.anchorPoints.splice(idx, 1);
      }
      invalidatePitchCurveCache();
      selectedAnchorIndices.clear();
      const newSnapshot = clonePitchCurveState();
      history.push({
        undo() { applyPitchCurveSnapshot(oldSnapshot); },
        redo() { applyPitchCurveSnapshot(newSnapshot); }
      });
      hidePitchContextMenu();
      render();
      scheduleAutoSave();
    });
  }

  // 点击菜单外部关闭
  document.addEventListener('mousedown', (e) => {
    if (getContextMenuAnchorIdx() < 0) return;
    if (menu.contains(e.target)) return;
    hidePitchContextMenu();
  }, true);

  // 阻止菜单自身弹出浏览器默认右键菜单
  menu.addEventListener('contextmenu', (e) => e.preventDefault());

  // Esc 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && getContextMenuAnchorIdx() >= 0) {
      hidePitchContextMenu();
    }
  });

  // 窗口失焦时关闭
  window.addEventListener('blur', () => {
    if (getContextMenuAnchorIdx() >= 0) hidePitchContextMenu();
  });
}

// ---- Kanji group context menu ----
// _kanjiCtxState tracks the current kanji context menu target.
// null = no menu open; otherwise { groupId, noteId } where:
//   - groupId: the kanji group being right-clicked (for "Set as Chinese")
//   - noteId: the right-clicked note ID (for pitch reference), or null if right-clicked on bracket/label
//   - kanjiNoteId: the single kanji note being right-clicked (for "Set as Japanese"), or null
let _kanjiCtxState = null;

function showKanjiContextMenu(x, y, groupId, noteId, kanjiNoteId) {
  const menu = document.getElementById('kanji-group-context-menu');
  if (!menu) return;
  _kanjiCtxState = { groupId, noteId, kanjiNoteId };

  // Show/hide menu items based on context
  const setChineseBtn = document.getElementById('kanji-ctx-set-chinese');
  const setJapaneseBtn = document.getElementById('kanji-ctx-set-japanese');
  if (groupId) {
    // Right-clicked on a kana group → can set as Chinese (merge)
    if (setChineseBtn) setChineseBtn.style.display = '';
    if (setJapaneseBtn) setJapaneseBtn.style.display = 'none';
  } else if (kanjiNoteId) {
    // Right-clicked on a single kanji note → can set as Japanese (split)
    if (setChineseBtn) setChineseBtn.style.display = 'none';
    if (setJapaneseBtn) setJapaneseBtn.style.display = '';
  }

  menu.style.display = 'block';
  menu.style.visibility = 'hidden';
  const menuRect = menu.getBoundingClientRect();
  let menuX = x;
  let menuY = y;
  if (menuX + menuRect.width > window.innerWidth) menuX = window.innerWidth - menuRect.width - 4;
  if (menuY + menuRect.height > window.innerHeight) menuY = window.innerHeight - menuRect.height - 4;
  menu.style.left = menuX + 'px';
  menu.style.top = menuY + 'px';
  menu.style.visibility = 'visible';
}

function hideKanjiContextMenu() {
  const menu = document.getElementById('kanji-group-context-menu');
  if (menu) menu.style.display = 'none';
  _kanjiCtxState = null;
}

/** Merge a kana group back into a single Chinese kanji note. */
function _applySetKanjiChinese(groupId, rightClickedNoteId) {
  const groups = getKanjiGroups();
  const notes = getNotes();
  const group = groups.find(g => g.id === groupId);
  if (!group) return;

  const result = mergeKanaGroupToKanji(group, notes, rightClickedNoteId, genNoteId);
  if (!result) return;

  // Capture old state for undo
  const oldNotes = deepClone(notes);
  const oldGroups = deepClone(groups);

  // Remove kana notes
  const idsToRemove = new Set(result.kanaNoteIds);
  for (let i = notes.length - 1; i >= 0; i--) {
    if (idsToRemove.has(notes[i].id)) notes.splice(i, 1);
  }
  // Add the new kanji note at the correct position (sorted by start time)
  const insertIdx = notes.findIndex(n => n.start > result.newNote.start);
  if (insertIdx === -1) {
    notes.push(result.newNote);
  } else {
    notes.splice(insertIdx, 0, result.newNote);
  }
  // Remove the group
  const groupIdx = groups.findIndex(g => g.id === groupId);
  if (groupIdx !== -1) groups.splice(groupIdx, 1);

  history.push({
    undo() {
      const curNotes = getNotes();
      const curGroups = getKanjiGroups();
      curNotes.length = 0;
      curNotes.push(...deepClone(oldNotes));
      curGroups.length = 0;
      curGroups.push(...deepClone(oldGroups));
      render();
    },
    redo() {
      const curNotes = getNotes();
      const curGroups = getKanjiGroups();
      curNotes.length = 0;
      curNotes.push(...deepClone(notes));
      curGroups.length = 0;
      curGroups.push(...deepClone(groups));
      render();
    }
  });

  hideKanjiContextMenu();
  resolvePhonemesFromPipeline();
  render();
  scheduleAutoSave();
}

/** Split a single kanji note into a kana group (set as Japanese). */
function _applySetKanjiJapanese(noteId) {
  const notes = getNotes();
  const groups = getKanjiGroups();
  const note = notes.find(n => n.id === noteId);
  if (!note) return;

  const result = splitKanjiNoteToKana(note, genNoteId);
  if (!result) {
    showAlertDialog(`汉字 "${note.lyric}" 不在日语字典中，无法转换为假名。\n\nKanji "${note.lyric}" is not in the Japanese dictionary and cannot be converted to kana.`);
    return;
  }

  // Capture old state for undo
  const oldNotes = deepClone(notes);
  const oldGroups = deepClone(groups);

  // Replace the kanji note with kana notes
  const noteIdx = notes.findIndex(n => n.id === noteId);
  if (noteIdx !== -1) {
    notes.splice(noteIdx, 1, ...result.kanaNotes);
  }
  // Clear kanjiForceChinese flag if set (it's now Japanese)
  // (the old note is gone, new kana notes don't have the flag)
  groups.push(result.group);

  history.push({
    undo() {
      const curNotes = getNotes();
      const curGroups = getKanjiGroups();
      curNotes.length = 0;
      curNotes.push(...deepClone(oldNotes));
      curGroups.length = 0;
      curGroups.push(...deepClone(oldGroups));
      render();
    },
    redo() {
      const curNotes = getNotes();
      const curGroups = getKanjiGroups();
      curNotes.length = 0;
      curNotes.push(...deepClone(notes));
      curGroups.length = 0;
      curGroups.push(...deepClone(groups));
      render();
    }
  });

  hideKanjiContextMenu();
  resolvePhonemesFromPipeline();
  render();
  scheduleAutoSave();
}

function _setupKanjiContextMenuListeners() {
  const menu = document.getElementById('kanji-group-context-menu');
  if (!menu) return;

  const setChineseBtn = document.getElementById('kanji-ctx-set-chinese');
  if (setChineseBtn) {
    setChineseBtn.addEventListener('click', () => {
      if (!_kanjiCtxState || !_kanjiCtxState.groupId) return;
      _applySetKanjiChinese(_kanjiCtxState.groupId, _kanjiCtxState.noteId);
    });
  }

  const setJapaneseBtn = document.getElementById('kanji-ctx-set-japanese');
  if (setJapaneseBtn) {
    setJapaneseBtn.addEventListener('click', () => {
      if (!_kanjiCtxState || !_kanjiCtxState.kanjiNoteId) return;
      _applySetKanjiJapanese(_kanjiCtxState.kanjiNoteId);
    });
  }

  // Click outside closes
  document.addEventListener('mousedown', (e) => {
    if (!_kanjiCtxState) return;
    if (menu.contains(e.target)) return;
    hideKanjiContextMenu();
  }, true);

  // Prevent browser default context menu on the menu itself
  menu.addEventListener('contextmenu', (e) => e.preventDefault());

  // Esc closes
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _kanjiCtxState) {
      hideKanjiContextMenu();
    }
  });

  // Window blur closes
  window.addEventListener('blur', () => {
    if (_kanjiCtxState) hideKanjiContextMenu();
  });
}

function finalizeDragOperation() {
  const dragOperation = getDragOperation();
  if (!dragOperation) return;
  // 拖拽可能就地修改了 notes（move/resize/add/delete），失效 inactive/oob 缓存
  bumpNotesVersion();

  switch (dragOperation.type) {
    case 'noteAdd': {
      const notes = getNotes();
      const note = notes.find(n => n.id === dragOperation.noteId);
      if (note) {
        const noteClone = { ...note };
        history.push({
          undo() {
            const idx = notes.findIndex(n => n.id === noteClone.id);
            if (idx !== -1) notes.splice(idx, 1);
            getSelectedNoteIds().delete(noteClone.id);
          },
          redo() {
            notes.push({ ...noteClone });
            getSelectedNoteIds().clear();
            getSelectedNoteIds().add(noteClone.id);
          }
        });
      }
      break;
    }
    case 'notesDelete': {
      if (dragOperation.deletedNotes && dragOperation.deletedNotes.length > 0) {
        const deletedNotes = dragOperation.deletedNotes;
        const deletedIndices = dragOperation.deletedIndices;
        history.push({
          undo() {
            const notes = getNotes();
            for (let i = 0; i < deletedNotes.length; i++) {
              notes.splice(deletedIndices[i], 0, { ...deletedNotes[i] });
            }
            setSelectedNoteIds(new Set(deletedNotes.map(n => n.id)));
          },
          redo() {
            const notes = getNotes();
            for (const dn of deletedNotes) {
              const idx = notes.findIndex(n => n.id === dn.id);
              if (idx !== -1) notes.splice(idx, 1);
            }
            getSelectedNoteIds().clear();
          }
        });
      }
      break;
    }
    case 'anchorsDelete': {
      const snapshotBefore = getPitchCurveSnapshotBeforeDrag();
      if (snapshotBefore) {
        const oldSnapshot = snapshotBefore;
        const newSnapshot = clonePitchCurveState();
        history.push({
          undo() { applyPitchCurveSnapshot(oldSnapshot); },
          redo() { applyPitchCurveSnapshot(newSnapshot); }
        });
      }
      break;
    }
    case 'notesMove': {
      if (dragOperation.moveData && dragOperation.moveData.length > 0) {
        const moveData = dragOperation.moveData;
        const notes = getNotes();
        history.push({
          undo() {
            for (const md of moveData) {
              const n = notes.find(nn => nn.id === md.noteId);
              if (n) { n.start = md.oldStart; n.pitch = md.oldPitch; }
            }
          },
          redo() {
            for (const md of moveData) {
              const n = notes.find(nn => nn.id === md.noteId);
              if (n) { n.start = md.newStart; n.pitch = md.newPitch; }
            }
          }
        });
      }
      break;
    }
    case 'noteMove': {
      const notes = getNotes();
      const note = notes.find(n => n.id === dragOperation.noteId);
      if (note && (note.start !== dragOperation.oldStart || note.pitch !== dragOperation.oldPitch)) {
        const newStart = note.start;
        const newPitch = note.pitch;
        const noteId = dragOperation.noteId;
        const oldStart = dragOperation.oldStart;
        const oldPitch = dragOperation.oldPitch;
        history.push({
          undo() {
            const n = notes.find(nn => nn.id === noteId);
            if (n) { n.start = oldStart; n.pitch = oldPitch; }
          },
          redo() {
            const n = notes.find(nn => nn.id === noteId);
            if (n) { n.start = newStart; n.pitch = newPitch; }
          }
        });
      }
      break;
    }
    case 'noteResize': {
      const notes = getNotes();
      const note = notes.find(n => n.id === dragOperation.noteId);
      if (note && note.duration !== dragOperation.oldDuration) {
        const newDuration = note.duration;
        const noteId = dragOperation.noteId;
        const oldDuration = dragOperation.oldDuration;
        history.push({
          undo() {
            const n = notes.find(nn => nn.id === noteId);
            if (n) { n.duration = oldDuration; }
          },
          redo() {
            const n = notes.find(nn => nn.id === noteId);
            if (n) { n.duration = newDuration; }
          }
        });
      }
      break;
    }
    case 'pitchAnchorMove':
    case 'pitchAnchorsMove':
    case 'pitchAnchorAdd': {
      const snapshotBefore = getPitchCurveSnapshotBeforeDrag();
      if (snapshotBefore) {
        const oldSnapshot = snapshotBefore;
        const newSnapshot = clonePitchCurveState();
        history.push({
          undo() { applyPitchCurveSnapshot(oldSnapshot); },
          redo() { applyPitchCurveSnapshot(newSnapshot); }
        });
      }
      break;
    }
    case 'pitchBrush': {
      const snapshotBefore = getPitchCurveSnapshotBeforeDrag();
      if (snapshotBefore) {
        const oldSnapshot = snapshotBefore;
        const newSnapshot = clonePitchCurveState();
        history.push({
          undo() { applyPitchCurveSnapshot(oldSnapshot); },
          redo() { applyPitchCurveSnapshot(newSnapshot); }
        });
      }
      break;
    }
    case 'envelopeKeyframeMove':
    case 'envelopeKeyframeAdd': {
      const snapshotBefore = getEnvelopeSnapshotBeforeDrag();
      if (snapshotBefore) {
        const envKey = dragOperation.envKey;
        const oldSnapshot = snapshotBefore;
        const newSnapshot = cloneEnvelopeState(envKey);
        history.push({
          undo() { applyEnvelopeSnapshot(envKey, oldSnapshot); },
          redo() { applyEnvelopeSnapshot(envKey, newSnapshot); }
        });
      }
      break;
    }
  }

  setDragOperation(null);
  setPitchCurveSnapshotBeforeDrag(null);
  setEnvelopeSnapshotBeforeDrag(null);
}

function finalizeBoxSelection() {
  const boxSelectStart = getBoxSelectStart();
  const boxSelectEnd = getBoxSelectEnd();
  const x1 = Math.min(boxSelectStart.x, boxSelectEnd.x);
  const y1 = Math.min(boxSelectStart.y, boxSelectEnd.y);
  const x2 = Math.max(boxSelectStart.x, boxSelectEnd.x);
  const y2 = Math.max(boxSelectStart.y, boxSelectEnd.y);

  if (x2 - x1 < 3 && y2 - y1 < 3) return;

  const pitchCurve = getPitchCurve();
  const selectedAnchorIndices = getSelectedAnchorIndices();
  const selectedNoteIds = getSelectedNoteIds();
  const notes = getNotes();

  if (getCurrentParamMode() === 'Pitch' && pitchCurve.enabled) {
    for (let i = 0; i < pitchCurve.anchorPoints.length; i++) {
      const ap = pitchCurve.anchorPoints[i];
      const px = timeToX(ap.time);
      const py = pitchToY(ap.pitch);
      if (px >= x1 && px <= x2 && py >= y1 && py <= y2) {
        selectedAnchorIndices.add(i);
      }
    }
  }

  for (const note of notes) {
    const nx = timeToX(note.start);
    const ny = pitchToY(note.pitch);
    const nw = note.duration * BEAT_WIDTH * getZoomX();
    const nh = NOTE_HEIGHT;
    if (nx < x2 && nx + nw > x1 && ny < y2 && ny + nh > y1) {
      selectedNoteIds.add(note.id);
    }
  }
}

function handlePitchMouseDown(e, pos) {
  setPitchCurveSnapshotBeforeDrag(clonePitchCurveState());
  if (e.shiftKey) {
    setIsBrushDrawing(true);
    const time = xToTime(pos.x);
    const pitch = yToPitchContinuous(pos.y);
    setCurrentBrushStroke({
      points: [{ time: Math.max(0, time), pitch: Math.max(0, Math.min(127, pitch)) }],
    });
    setDragMode('pitch-brush');
    setDragOperation({ type: 'pitchBrush' });
  } else if (e.button === 1) {
    setIsBoxSelecting(true);
    setBoxSelectStart({ x: pos.x, y: pos.y });
    setBoxSelectEnd({ x: pos.x, y: pos.y });
    if (!e.shiftKey && !e.ctrlKey) {
      getSelectedNoteIds().clear();
      getSelectedAnchorIndices().clear();
    }
  } else {
    const anchorIdx = findAnchorPointAt(pos.x, pos.y);
    const selectedAnchorIndices = getSelectedAnchorIndices();
    const pitchCurve = getPitchCurve();
    if (anchorIdx >= 0) {
      if (e.ctrlKey || e.metaKey) {
        if (selectedAnchorIndices.has(anchorIdx)) {
          selectedAnchorIndices.delete(anchorIdx);
        } else {
          selectedAnchorIndices.add(anchorIdx);
        }
      } else if (e.shiftKey) {
        selectedAnchorIndices.add(anchorIdx);
      } else {
        if (!selectedAnchorIndices.has(anchorIdx)) {
          selectedAnchorIndices.clear();
          selectedAnchorIndices.add(anchorIdx);
        }
      }
      setPitchDragAnchorIdx(anchorIdx);
      setActiveAnchorIdx(anchorIdx); // 按压反馈
      setPitchDragStartTime(pitchCurve.anchorPoints[anchorIdx].time);
      setPitchDragStartValue(pitchCurve.anchorPoints[anchorIdx].pitch);
      getPitchDragAnchorStarts().clear();
      for (const idx of selectedAnchorIndices) {
        const ap = pitchCurve.anchorPoints[idx];
        if (ap) getPitchDragAnchorStarts().set(idx, { time: ap.time, pitch: ap.pitch });
      }
      setDragStartX(pos.x);
      setDragStartY(pos.y);
      setDragStartMouseTime(xToTime(pos.x));
      setDragStartMousePitch(yToPitchContinuous(pos.y));
      setDragMode('pitch-anchor');
      setDragOperation({ type: selectedAnchorIndices.size > 1 ? 'pitchAnchorsMove' : 'pitchAnchorMove' });
    } else {
      selectedAnchorIndices.clear();
      const time = xToTime(pos.x);
      const pitch = yToPitchContinuous(pos.y);
      const clampedPitch = Math.max(0, Math.min(127, pitch));
      pitchCurve.anchorPoints.push({
        time: Math.max(0, time),
        pitch: clampedPitch,
        smoothness: getBrushSmoothing(),
      });
      invalidatePitchCurveCache();
      setPitchDragAnchorIdx(pitchCurve.anchorPoints.length - 1);
      setActiveAnchorIdx(getPitchDragAnchorIdx()); // 按压反馈
      selectedAnchorIndices.add(getPitchDragAnchorIdx());
      setPitchDragStartTime(time);
      setPitchDragStartValue(clampedPitch);
      setDragStartX(pos.x);
      setDragStartY(pos.y);
      setDragStartMouseTime(xToTime(pos.x));
      setDragStartMousePitch(yToPitchContinuous(pos.y));
      setDragMode('pitch-anchor');
      setDragOperation({ type: 'pitchAnchorAdd' });
      scheduleAutoSave();
    }
  }
  render();
}

function handlePhonemeMouseDown(e, pos) {
  const areaTop = _getParamCurveAreaTop();
  const areaBottom = _getParamCurveAreaBottom();
  const barPadding = 6;
  const labelH = 16;
  const barTop = areaTop + labelH;
  const barBottom = areaBottom - barPadding;
  const barHeight = barBottom - barTop;
  const notes = getNotes();

  for (const note of notes) {
    const noteStartX = timeToX(note.start);
    const noteEndX = timeToX(note.start + note.duration);
    const noteWidth = noteEndX - noteStartX;
    if (noteWidth < 4) continue;
    if (pos.x < noteStartX - 4 || pos.x > noteEndX + 4) continue;
    if (pos.y < barTop || pos.y > barBottom) continue;

    const adjustments = getPhonemeAdjustments(note);
    if (!adjustments || adjustments.length === 0) continue;

    const boundaries = [];
    let bx = noteStartX;
    for (let i = 0; i < adjustments.length - 1; i++) {
      bx += noteWidth * adjustments[i].durationRatio;
      boundaries.push({ x: bx, index: i + 1 });
    }

    const BOUNDARY_ZONE = 10;
    for (const bnd of boundaries) {
      if (Math.abs(pos.x - bnd.x) < BOUNDARY_ZONE) {
        setSelectedPhonemeNoteId(note.id);
        setSelectedPhonemeIndex(bnd.index);
        // 用户开始拖拽音素边界，显式提交 adjustments 到 note，
        // 标记为"已自定义"，使后续 MouseMove/渲染读到同一份数据。
        note.phonemeAdjustments = adjustments;
        setPhonemeDragState({
          noteId: note.id,
          phonemeIndex: bnd.index,
          type: 'boundary',
          startX: pos.x,
          origRatioL: adjustments[bnd.index - 1].durationRatio,
          origRatioR: adjustments[bnd.index].durationRatio,
        });
        getSelectedNoteIds().clear();
        getSelectedNoteIds().add(note.id);
        render();
        return;
      }
    }

    let x = noteStartX;
    for (let i = 0; i < adjustments.length; i++) {
      const adj = adjustments[i];
      const phWidth = noteWidth * adj.durationRatio;
      const boundaryX = x + phWidth;

      if (pos.x >= x && pos.x < boundaryX) {
        setSelectedPhonemeNoteId(note.id);
        setSelectedPhonemeIndex(i);
        // 用户即将与该音素交互（锁定/音量拖拽），显式提交 adjustments，
        // 确保后续修改持久化到 note 上，渲染与 MouseMove 读到同一份数据。
        note.phonemeAdjustments = adjustments;
        if (e.button === 2) {
          adj.locked = !adj.locked;
          if (!adjustments.some(a => a.locked)) adjustments[0].locked = true;
          scheduleAutoSave();
          render();
          return;
        }

        const pts = adj.volumePoints || [];
        let closestIdx = -1;
        let closestDist = Infinity;
        for (let p = 0; p < pts.length; p++) {
          const px = x + pts[p].t * phWidth;
          const py = barTop + (1 - pts[p].v) * barHeight;
          const dist = Math.hypot(pos.x - px, pos.y - py);
          if (dist < closestDist && dist < 12) {
            closestDist = dist;
            closestIdx = p;
          }
        }

        if (closestIdx >= 0) {
          setPhonemeDragState({
            noteId: note.id,
            phonemeIndex: i,
            type: 'volume-point',
            pointIndex: closestIdx,
            startX: pos.x,
            startY: pos.y,
            origT: pts[closestIdx].t,
            origV: pts[closestIdx].v,
          });
        } else {
          setPhonemeDragState({
            noteId: note.id,
            phonemeIndex: i,
            type: 'volume-curve',
            startX: pos.x,
            startY: pos.y,
            origPoints: pts.map(p => ({ ...p })),
          });
        }
        getSelectedNoteIds().clear();
        getSelectedNoteIds().add(note.id);
        render();
        return;
      }
      x = boundaryX;
    }
  }
  setSelectedPhonemeNoteId(null);
  setSelectedPhonemeIndex(-1);
}

function handlePhonemeMouseMove(pos) {
  const phonemeDragState = getPhonemeDragState();
  if (!phonemeDragState) return;

  const notes = getNotes();
  const note = notes.find(n => n.id === phonemeDragState.noteId);
  if (!note) { setPhonemeDragState(null); return; }

  const adjustments = getPhonemeAdjustments(note);
  const noteWidth = timeToX(note.start + note.duration) - timeToX(note.start);

  if (phonemeDragState.type === 'boundary') {
    const dx = pos.x - phonemeDragState.startX;
    const dRatio = dx / noteWidth;
    const i = phonemeDragState.phonemeIndex;
    const newL = Math.max(0.05, phonemeDragState.origRatioL + dRatio);
    const newR = Math.max(0.05, phonemeDragState.origRatioR - dRatio);
    adjustments[i - 1].durationRatio = newL;
    adjustments[i].durationRatio = newR;
    render();
  } else if (phonemeDragState.type === 'volume-point') {
    const adj = adjustments[phonemeDragState.phonemeIndex];
    const pts = adj.volumePoints;
    const pi = phonemeDragState.pointIndex;
    const areaTop = _getParamCurveAreaTop();
    const labelH = 16;
    const barPadding = 6;
    const barTop = areaTop + labelH;
    const barBottom = _getParamCurveAreaBottom() - barPadding;
    const barHeight = barBottom - barTop;
    const newV = Math.max(0, Math.min(1, 1 - (pos.y - barTop) / barHeight));
    pts[pi].v = newV;
    if (pi > 0 && pi < pts.length - 1) {
      const phStartX = timeToX(note.start) + noteWidth * getPhonemeStartX(adj, adjustments, note.start, note.duration);
      const phWidth = noteWidth * adj.durationRatio;
      const newT = Math.max(pts[pi - 1].t + 0.01, Math.min(pts[pi + 1].t - 0.01, (pos.x - phStartX) / phWidth));
      pts[pi].t = newT;
    }
    render();
  } else if (phonemeDragState.type === 'volume-curve') {
    const adj = adjustments[phonemeDragState.phonemeIndex];
    const dy = phonemeDragState.startY - pos.y;
    const areaTop = _getParamCurveAreaTop();
    const labelH = 16;
    const barPadding = 6;
    const barTop = areaTop + labelH;
    const barBottom = _getParamCurveAreaBottom() - barPadding;
    const barHeight = barBottom - barTop;
    const dVol = dy / barHeight;
    for (let p = 0; p < adj.volumePoints.length; p++) {
      adj.volumePoints[p].v = Math.max(0, Math.min(1, phonemeDragState.origPoints[p].v + dVol));
    }
    render();
  }
}

function handlePhonemeMouseUp() {
  const phonemeDragState = getPhonemeDragState();
  if (phonemeDragState) {
    const notes = getNotes();
    const note = notes.find(n => n.id === phonemeDragState.noteId);
    if (note) {
      normalizePhonemeRatios(getPhonemeAdjustments(note));
      note.phonemeAdjustments = getPhonemeAdjustments(note);
      scheduleAutoSave();
    }
    setPhonemeDragState(null);
    render();
  }
}

function handleParamEnvelopeMouseDown(pos) {
  const panelMode = getParamPanelMode();
  const envKey = panelMode === 'VOL' ? 'volume' : 'pan';
  const envelopes = getEnvelopes();
  const envelope = envelopes[envKey];
  if (!envelope) return;

  setEnvelopeSnapshotBeforeDrag(cloneEnvelopeState(envKey));

  for (let i = 0; i < envelope.keyframes.length; i++) {
    const kf = envelope.keyframes[i];
    const px = timeToX(kf.time);
    const py = _valueToParamY(kf.value);
    const dist = Math.sqrt((pos.x - px) ** 2 + (pos.y - py) ** 2);
    if (dist <= 8) {
      setParamEnvelopeDrag({ envKey, index: i, startX: pos.x, startY: pos.y, origTime: kf.time, origValue: kf.value });
      setDragMode('param-envelope');
      setDragOperation({ type: 'envelopeKeyframeMove', envKey });
      return;
    }
  }

  const time = xToTime(pos.x);
  const { min, max } = _getParamCurveYRange();
  const value = min + (1 - (pos.y - _getParamCurveAreaTop()) / PARAM_CURVE_HEIGHT) * (max - min);
  const clampedValue = Math.max(min, Math.min(max, value));
  envelope.keyframes.push({ time: Math.max(0, time), value: clampedValue, smoothness: 30 });
  envelope.keyframes.sort((a, b) => a.time - b.time);
  setDragOperation({ type: 'envelopeKeyframeAdd', envKey });
  render();
  scheduleAutoSave();
}

function startInlineEdit(note, hit) {
  const activeInlineInput = getActiveInlineInput();
  if (activeInlineInput) {
    if (activeInlineInput.parentElement) activeInlineInput.remove();
    setActiveInlineInput(null);
    setActiveInlineEditNote(null);
  }

  setActiveInlineEditNote(note);
  setLyricEditNoteId(note.id);
  setLyricEditOldValue(note.lyric || '');

  const container = canvas.parentElement;
  const containerRect = container.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();

  const offsetX = canvasRect.left - containerRect.left;
  const offsetY = canvasRect.top - containerRect.top;

  const inputX = offsetX + hit.nx + 2;
  const inputY = offsetY + hit.ny;
  const inputW = Math.max(40, hit.nw - 4);
  const inputH = hit.nh;

  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 256;
  input.value = note.lyric || '';
  input.style.cssText = `
    position: absolute;
    left: ${inputX}px;
    top: ${inputY}px;
    width: ${inputW}px;
    height: ${inputH}px;
    background: var(--bg-input);
    border: 1px solid var(--accent);
    border-radius: 2px;
    color: var(--fg-primary);
    font-size: 11px;
    font-family: sans-serif;
    padding: 0 2px;
    outline: none;
    z-index: 1000;
    box-sizing: border-box;
  `;

  container.style.position = 'relative';
  container.appendChild(input);
  setActiveInlineInput(input);

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });

  let finished = false;

  const finish = (save) => {
    if (finished) return;
    finished = true;

    if (save) {
      const newLyric = input.value;
      if (newLyric !== note.lyric) {
        const oldLyric = getLyricEditOldValue();
        const noteId = getLyricEditNoteId();
        const tokens = tokenizeLyric(newLyric);

        // Capture old lyrics BEFORE modifying any notes
        const notes = getNotes();
        const noteIdx = notes.findIndex(n => n.id === noteId);
        const oldLyrics = [{ id: noteId, lyric: oldLyric }];
        if (tokens.length > 1 && noteIdx !== -1) {
          for (let t = 1; t < tokens.length; t++) {
            const nextIdx = noteIdx + t;
            if (nextIdx < notes.length) {
              oldLyrics.push({ id: notes[nextIdx].id, lyric: notes[nextIdx].lyric });
            }
          }
        }

        if (tokens.length <= 1) {
          note.lyric = newLyric;
          note.phonemeAdjustments = null;
        } else {
          if (noteIdx !== -1) {
            note.lyric = tokens[0];
            note.phonemeAdjustments = null;
            for (let t = 1; t < tokens.length; t++) {
              const nextIdx = noteIdx + t;
              if (nextIdx < notes.length) {
                notes[nextIdx].lyric = tokens[t];
                notes[nextIdx].phonemeAdjustments = null;
              }
            }
          } else {
            note.lyric = newLyric;
            note.phonemeAdjustments = null;
          }
        }

        history.push({
          undo() {
            for (const { id, lyric } of oldLyrics) {
              const n = notes.find(nn => nn.id === id);
              if (n) { n.lyric = lyric; n.phonemeAdjustments = null; }
            }
          },
          redo() {
            const n = notes.find(nn => nn.id === noteId);
            if (n) { n.lyric = newLyric; n.phonemeAdjustments = null; }
            if (tokens.length > 1 && noteIdx !== -1) {
              for (let t = 1; t < tokens.length; t++) {
                const nextIdx = noteIdx + t;
                if (nextIdx < notes.length) {
                  notes[nextIdx].lyric = tokens[t];
                  notes[nextIdx].phonemeAdjustments = null;
                }
              }
            }
          }
        });

        // Auto-detect kanji groups: if the fragment has kana, split any new
        // kanji notes into kana. Push a separate history entry so the user
        // can undo the auto-split independently from the lyric edit.
        const kanjiGroups = getKanjiGroups();
        const beforeNotes = deepClone(notes);
        const beforeGroups = deepClone(kanjiGroups);
        if (autoDetectKanjiGroups(notes, kanjiGroups, genNoteId)) {
          history.push({
            undo() {
              const curNotes = getNotes();
              const curGroups = getKanjiGroups();
              curNotes.length = 0;
              curNotes.push(...deepClone(beforeNotes));
              curGroups.length = 0;
              curGroups.push(...deepClone(beforeGroups));
              render();
            },
            redo() {
              const curNotes = getNotes();
              const curGroups = getKanjiGroups();
              curNotes.length = 0;
              curNotes.push(...deepClone(notes));
              curGroups.length = 0;
              curGroups.push(...deepClone(kanjiGroups));
              render();
            }
          });
        }
      }
    }
    if (input.parentElement) input.remove();
    setActiveInlineInput(null);
    setActiveInlineEditNote(null);
    render();
    if (save) { scheduleAutoSave(); resolvePhonemesFromPipeline(); }
  };

  input.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });

  input.addEventListener('blur', () => {
    finish(true);
  });
}

export function setupEventListeners() {
  canvas.addEventListener('mousedown', (e) => {
    // mousedown 前布局可能已变化（inspector resize / param panel toggle / window resize），
    // 失效 rect 缓存以确保本次拖拽使用最新的 canvas 位置。
    _invalidateCanvasRect();
    const pos = getMousePos(e);

    if (e.button === 1) {
      e.preventDefault();
      setIsBoxSelecting(true);
      setBoxSelectStart({ x: pos.x, y: pos.y });
      setBoxSelectEnd({ x: pos.x, y: pos.y });
      if (!e.shiftKey && !e.ctrlKey) {
        getSelectedNoteIds().clear();
        getSelectedAnchorIndices().clear();
      }
      render();
      return;
    }

    // 左键点击播放头或 header 区域 → 拖拽设置播放起始位置
    if (e.button === 0) {
      const canvasH = canvas.clientHeight;
      // 1. 直接点击在现有 playhead 上
      const onPlayhead = findPlayheadAt(pos.x, pos.y, canvasH);
      // 2. 点击 header 区域（时间轴）→ 移动 playhead 到点击位置
      const onHeader = pos.y <= HEADER_HEIGHT;
      if (onPlayhead || onHeader) {
        const beats = xToTime(pos.x);
        const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
        const newStartTime = Math.max(0, (beats / bpm) * 60);
        setFragmentPlayStartPosition(newStartTime);

        if (getFragmentIsPlaying()) {
          // 播放中拖拽 → 跳转到新位置
          seekFragmentPlayback(newStartTime);
        } else {
          setDragMode('playhead');
          render();
        }
        return;
      }
    }

    // 右键按下：在 Pitch 模式下点击锚点时进入 smoothness 拖拽模式；
    // 鼠标松开时若未发生明显位移则触发 context menu。
    if (e.button === 2) {
      hidePitchContextMenu();
      const currentParamMode = getCurrentParamMode();
      const pitchCurve = getPitchCurve();
      if (currentParamMode === 'Pitch' && pitchCurve.enabled) {
        // 当底部面板展开为 Phoneme 时，底部区域右键交给音素面板，避免误吞。
        if (!getParamPanelCollapsed() && getParamPanelMode() === 'Phoneme') {
          const areaTop = _getParamCurveAreaTop();
          if (pos.y >= areaTop) return;
        }
        const anchorIdx = findAnchorPointAt(pos.x, pos.y);
        if (anchorIdx >= 0) {
          const selectedAnchorIndices = getSelectedAnchorIndices();
          if (!selectedAnchorIndices.has(anchorIdx)) {
            selectedAnchorIndices.clear();
            selectedAnchorIndices.add(anchorIdx);
          }
          const starts = new Map();
          for (const idx of selectedAnchorIndices) {
            const ap = pitchCurve.anchorPoints[idx];
            if (ap) starts.set(idx, { smoothness: ap.smoothness ?? 0 });
          }
          setPitchSmoothDragAnchorStarts(starts);
          setPitchSmoothDragMoved(false);
          setPitchSmoothDragRightClickPos({ x: e.clientX, y: e.clientY, canvasX: pos.x, canvasY: pos.y });
          setDragStartX(pos.x);
          setDragStartY(pos.y);
          setDragMode('pitch-smoothness');
          setActiveAnchorIdx(anchorIdx); // 按压反馈
          setPitchCurveSnapshotBeforeDrag(clonePitchCurveState());
          render();
          return;
        }
      }
      // Kanji group right-click: check bracket/label hit, then kana note in group,
      // then single kanji note (not in group).
      const currentParamMode2 = getCurrentParamMode();
      if (currentParamMode2 !== 'Pitch') {
        // 1. Check if right-clicking on a kanji group bracket/label
        const groupHit = findKanjiGroupAt(pos.x, pos.y);
        if (groupHit) {
          e.preventDefault();
          showKanjiContextMenu(e.clientX, e.clientY, groupHit.group.id, null, null);
          return;
        }
        // 2. Check if right-clicking a note that belongs to a kanji group
        const noteHit = findNoteAt(pos.x, pos.y);
        if (noteHit) {
          const group = findGroupByNoteId(noteHit.note.id, getKanjiGroups());
          if (group) {
            e.preventDefault();
            showKanjiContextMenu(e.clientX, e.clientY, group.id, noteHit.note.id, null);
            return;
          }
          // 3. Check if right-clicking a single kanji note (not in a group)
          if (isSingleKanji(noteHit.note.lyric)) {
            e.preventDefault();
            showKanjiContextMenu(e.clientX, e.clientY, null, null, noteHit.note.id);
            return;
          }
        }
      }
      // 其他情况交由 contextmenu 事件处理（保留默认右键菜单或自定义菜单）。
      return;
    }

    const currentParamMode = getCurrentParamMode();
    const pitchCurve = getPitchCurve();

    // Bottom panel area takes precedence when the panel is expanded — this lets
    // top=Pitch and bottom=Phoneme/VOL/PAN coexist without the pitch handler
    // intercepting clicks meant for the parameter lane below.
    if (!getParamPanelCollapsed()) {
      const panelMode = getParamPanelMode();
      const areaTop = _getParamCurveAreaTop();
      if (pos.y >= areaTop) {
        if (panelMode === 'VOL' || panelMode === 'PAN') {
          handleParamEnvelopeMouseDown(pos);
          return;
        }
        if (panelMode === 'Phoneme') {
          handlePhonemeMouseDown(e, pos);
          return;
        }
      }
    }

    if (currentParamMode === 'Pitch' && pitchCurve.enabled) {
      handlePitchMouseDown(e, pos);
      return;
    }

    const hit = findNoteAt(pos.x, pos.y);
    const selectedNoteIds = getSelectedNoteIds();

    if (hit) {
      // 记录鼠标按住的 note，用于绘制按压反馈（阴影 + 轻微放大）
      setActiveNoteId(hit.note.id);
      if (e.ctrlKey || e.metaKey) {
        if (selectedNoteIds.has(hit.note.id)) {
          selectedNoteIds.delete(hit.note.id);
        } else {
          selectedNoteIds.add(hit.note.id);
        }
      } else if (e.shiftKey) {
        selectedNoteIds.add(hit.note.id);
      } else {
        if (!selectedNoteIds.has(hit.note.id)) {
          selectedNoteIds.clear();
          selectedNoteIds.add(hit.note.id);
        }
      }

      if (hit.onResizeEdge) {
        setDragMode('resize');
        setDragOperation({ type: 'noteResize', noteId: hit.note.id, oldDuration: hit.note.duration });
      } else {
        setDragMode('move');
        getDragNoteStarts().clear();
        for (const id of selectedNoteIds) {
          const n = getNotes().find(nn => nn.id === id);
          if (n) getDragNoteStarts().set(id, { start: n.start, pitch: n.pitch, duration: n.duration });
        }
        setDragNoteStart({ start: hit.note.start, pitch: hit.note.pitch, duration: hit.note.duration });
        if (selectedNoteIds.size <= 1) {
          setDragOperation({ type: 'noteMove', noteId: hit.note.id, oldStart: hit.note.start, oldPitch: hit.note.pitch });
        } else {
          setDragOperation({ type: 'notesMove', moveData: [] });
        }
      }
      setDragStartX(pos.x);
      setDragStartY(pos.y);
      setDragStartMouseTime(xToTime(pos.x));
      setDragStartMousePitch(yToPitchContinuous(pos.y));
    } else {
      if (!e.ctrlKey && !e.shiftKey) {
        selectedNoteIds.clear();
      }
      const beats = snapBeats(xToTime(pos.x));
      const pitch = yToPitch(pos.y);
      const clampedPitch = Math.max(0, Math.min(127, pitch));
      const newDuration = 1 / 4;
      if (hasNoteOverlap(null, clampedPitch, beats, beats + newDuration)) {
        render();
        return;
      }
      // Block creating new notes within a kanji group's time span
      if (isTimeRangeWithinAnyGroup(beats, beats + newDuration, getNotes(), getKanjiGroups())) {
        render();
        return;
      }
      const newNote = {
        id: genNoteId(),
        pitch: clampedPitch,
        start: Math.max(0, beats),
        duration: newDuration,
        lyric: 'la',
      };
      getNotes().push(newNote);
      bumpNotesVersion(); // 新增 note，失效 inactive/oob 缓存
      selectedNoteIds.clear();
      selectedNoteIds.add(newNote.id);
      setActiveNoteId(newNote.id); // 按住新建 note 时也显示按压反馈
      setDragMode('resize');
      setDragStartX(pos.x);
      setDragStartMouseTime(xToTime(pos.x));
      setDragStartMousePitch(yToPitchContinuous(pos.y));
      setDragNoteStart({ start: newNote.start, pitch: newNote.pitch, duration: newNote.duration });
      setDragOperation({ type: 'noteAdd', noteId: newNote.id });
      scheduleAutoSave();
      resolvePhonemesFromPipeline();
    }
    render();
  });

  canvas.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });

  canvas.addEventListener('mousemove', (e) => {
    const pos = getMousePos(e);

    if (getIsBoxSelecting()) {
      setBoxSelectEnd({ x: pos.x, y: pos.y });
      render();
      return;
    }

    const dragMode = getDragMode();

    // 播放头拖拽：实时更新起始位置
    if (dragMode === 'playhead') {
      const beats = xToTime(pos.x);
      const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
      const newStartTime = Math.max(0, (beats / bpm) * 60);
      setFragmentPlayStartPosition(newStartTime);
      render();
      return;
    }

    if (dragMode === 'pitch-smoothness') {
      applyPitchSmoothnessDrag(pos);
      return;
    }

    if (dragMode === 'pitch-anchor' && getPitchDragAnchorIdx() >= 0) {
      applyPitchAnchorDrag(pos);
      return;
    }

    if (dragMode === 'pitch-brush' && getIsBrushDrawing() && getCurrentBrushStroke()) {
      const time = xToTime(pos.x);
      const pitch = yToPitchContinuous(pos.y);
      const currentBrushStroke = getCurrentBrushStroke();
      const lastPt = currentBrushStroke.points[currentBrushStroke.points.length - 1];
      const dt = Math.abs(time - lastPt.time);
      if (dt > 0.005) {
        currentBrushStroke.points.push({
          time: Math.max(0, time),
          pitch: Math.max(0, Math.min(127, pitch)),
        });
      }
      render();
      return;
    }

    if (dragMode === 'param-envelope' && getParamEnvelopeDrag()) {
      const paramEnvelopeDrag = getParamEnvelopeDrag();
      const { envKey, index, startX, startY, origTime, origValue } = paramEnvelopeDrag;
      const envelopes = getEnvelopes();
      const envelope = envelopes[envKey];
      if (!envelope || index >= envelope.keyframes.length) return;
      const dxTime = (pos.x - startX) / (BEAT_WIDTH * getZoomX());
      const { min, max } = _getParamCurveYRange();
      const dyValue = -((pos.y - startY) / PARAM_CURVE_HEIGHT) * (max - min);
      envelope.keyframes[index].time = Math.max(0, origTime + dxTime);
      envelope.keyframes[index].value = Math.max(min, Math.min(max, origValue + dyValue));
      render();
      return;
    }

    if (getPhonemeDragState()) {
      handlePhonemeMouseMove(pos);
      return;
    }

    if (!dragMode) {
      const currentParamMode = getCurrentParamMode();
      const pitchCurve = getPitchCurve();
      // 播放头悬停时显示 ew-resize 光标
      const canvasH = canvas.clientHeight;
      if (findPlayheadAt(pos.x, pos.y, canvasH) || pos.y <= HEADER_HEIGHT) {
        canvas.style.cursor = 'ew-resize';
        return;
      }
      // Bottom panel area takes precedence (see mousedown handler) — check the
      // phoneme lane first so cursor reflects phoneme interactions even when
      // the top toolbar is in Pitch mode.
      if (!getParamPanelCollapsed() && getParamPanelMode() === 'Phoneme') {
        const areaTop = _getParamCurveAreaTop();
        const areaBottom = _getParamCurveAreaBottom();
        if (pos.y >= areaTop && pos.y <= areaBottom) {
          const BOUNDARY_ZONE = 10;
          const notes = getNotes();
          for (const note of notes) {
            const noteStartX = timeToX(note.start);
            const noteEndX = timeToX(note.start + note.duration);
            if (pos.x < noteStartX - BOUNDARY_ZONE || pos.x > noteEndX + BOUNDARY_ZONE) continue;
            const adjustments = getPhonemeAdjustments(note);
            if (!adjustments || adjustments.length === 0) continue;
            let bx = noteStartX;
            for (let i = 0; i < adjustments.length - 1; i++) {
              bx += (noteEndX - noteStartX) * adjustments[i].durationRatio;
              if (Math.abs(pos.x - bx) < BOUNDARY_ZONE) {
                canvas.style.cursor = 'ew-resize';
                return;
              }
            }
            canvas.style.cursor = 'crosshair';
            return;
          }
          canvas.style.cursor = 'default';
          return;
        }
      }
      if (currentParamMode === 'Pitch' && pitchCurve.enabled) {
        if (e.shiftKey) {
          canvas.style.cursor = 'crosshair';
        } else {
          const anchorIdx = findAnchorPointAt(pos.x, pos.y);
          canvas.style.cursor = anchorIdx >= 0 ? 'grab' : 'crosshair';
        }
        return;
      }
      const hit = findNoteAt(pos.x, pos.y);
      if (hit) {
        canvas.style.cursor = (pos.x >= hit.nx + hit.nw - 6) ? 'ew-resize' : 'move';
      } else {
        canvas.style.cursor = 'default';
      }
      // 更新 hoveredNoteId，变化时触发重绘以显示/隐藏 tooltip
      const newHoveredId = hit ? hit.note.id : null;
      if (newHoveredId !== getHoveredNoteId()) {
        setHoveredNoteId(newHoveredId);
        render();
      }
      return;
    }

    if (dragMode === 'move' || dragMode === 'resize') {
      applyNoteDrag(pos);
      return;
    }

    render();
  });

  canvas.addEventListener('mouseup', (e) => {
    // 清除鼠标按压反馈状态（无论后续分支是否 early return，按压都已结束）
    setActiveNoteId(null);
    setActiveAnchorIdx(-1);
    setActivePhonemeKey(null);

    if (getIsBoxSelecting()) {
      setIsBoxSelecting(false);
      finalizeBoxSelection();
      render();
      return;
    }

    // 播放头拖拽结束
    if (getDragMode() === 'playhead') {
      setDragMode(null);
      render();
      return;
    }

    // 右键松开：若未发生明显位移则弹出 context menu，否则提交 smoothness 修改历史。
    if (e.button === 2 && getDragMode() === 'pitch-smoothness') {
      const moved = getPitchSmoothDragMoved();
      const startSnapshot = getPitchCurveSnapshotBeforeDrag();
      const hadChange = startSnapshot && _pitchSmoothnessDragHasChange(startSnapshot);
      if (!moved || !hadChange) {
        // 没有真实改动 → 弹出右键菜单
        const rightClickPos = getPitchSmoothDragRightClickPos();
        const anchorIdx = getSelectedAnchorIndices().size > 0
          ? Math.min(...getSelectedAnchorIndices())
          : -1;
        _finalizePitchSmoothnessDrag(false);
        if (rightClickPos) {
          showPitchContextMenu(rightClickPos.x, rightClickPos.y, anchorIdx);
        }
      } else {
        _finalizePitchSmoothnessDrag(true);
      }
      return;
    }

    if (getPhonemeDragState()) {
      handlePhonemeMouseUp();
      return;
    }

    if (getDragMode() === 'pitch-brush' && getIsBrushDrawing() && getCurrentBrushStroke()) {
      if (getCurrentBrushStroke().points.length >= 2) {
        convertBrushStrokeToAnchorPoints(getCurrentBrushStroke());
      }
      setCurrentBrushStroke(null);
      setIsBrushDrawing(false);
      render();
    }

    if (getDragMode() === 'pitch-anchor') {
      if (getDragOperation() && getDragOperation().type === 'pitchAnchorsMove' && getPitchDragAnchorStarts().size > 0) {
        const moveData = [];
        for (const idx of getSelectedAnchorIndices()) {
          const ap = getPitchCurve().anchorPoints[idx];
          const start = getPitchDragAnchorStarts().get(idx);
          if (ap && start && (ap.time !== start.time || ap.pitch !== start.pitch)) {
            moveData.push({ moved: true });
          }
        }
        if (moveData.length === 0) {
          setDragOperation(null);
          setPitchCurveSnapshotBeforeDrag(null);
        }
      }
      setPitchDragAnchorIdx(-1);
      getPitchDragAnchorStarts().clear();
    }

    if (getDragMode() === 'move' && getSelectedNoteIds().size > 1 && getDragOperation() && getDragOperation().type === 'notesMove') {
      const moveData = [];
      for (const id of getSelectedNoteIds()) {
        const note = getNotes().find(n => n.id === id);
        const start = getDragNoteStarts().get(id);
        if (note && start && (note.start !== start.start || note.pitch !== start.pitch)) {
          moveData.push({
            noteId: id,
            oldStart: start.start,
            oldPitch: start.pitch,
            newStart: note.start,
            newPitch: note.pitch,
          });
        }
      }
      const dragOp = getDragOperation();
      dragOp.moveData = moveData;
      if (moveData.length === 0) {
        setDragOperation(null);
      }
    }

    if (getDragMode() === 'param-envelope') {
      const panelMode = getParamPanelMode();
      const envKey = panelMode === 'VOL' ? 'volume' : 'pan';
      const envelopes = getEnvelopes();
      const envelope = envelopes[envKey];
      if (envelope) {
        envelope.keyframes.sort((a, b) => a.time - b.time);
      }
      setParamEnvelopeDrag(null);
    }

    finalizeDragOperation();

    if (getDragMode()) {
      scheduleAutoSave();
    }

    setDragMode(null);
    getDragNoteStarts().clear();
  });

  canvas.addEventListener('mouseleave', () => {
    // 清除按压反馈状态
    setActiveNoteId(null);
    setActiveAnchorIdx(-1);
    setActivePhonemeKey(null);
    if (getIsBoxSelecting()) {
      setIsBoxSelecting(false);
      finalizeBoxSelection();
    }
    // 播放头拖拽中离开 canvas → 结束拖拽
    if (getDragMode() === 'playhead') {
      setDragMode(null);
    }
    if (getDragMode() === 'pitch-brush' && getIsBrushDrawing() && getCurrentBrushStroke()) {
      if (getCurrentBrushStroke().points.length >= 2) {
        convertBrushStrokeToAnchorPoints(getCurrentBrushStroke());
      }
      setCurrentBrushStroke(null);
      setIsBrushDrawing(false);
      render();
    }
    // 右键 smoothness 拖拽期间鼠标离开 canvas → 提交当前修改并清理状态
    if (getDragMode() === 'pitch-smoothness') {
      const startSnapshot = getPitchCurveSnapshotBeforeDrag();
      const hadChange = startSnapshot && _pitchSmoothnessDragHasChange(startSnapshot);
      _finalizePitchSmoothnessDrag(!!hadChange);
    }
    finalizeDragOperation();
    setDragMode(null);
    setPitchDragAnchorIdx(-1);
    getPitchDragAnchorStarts().clear();
    setParamEnvelopeDrag(null);
    getDragNoteStarts().clear();
    if (getHoveredNoteId() !== null) {
      setHoveredNoteId(null);
      render();
    }
  });

  canvas.addEventListener('contextmenu', (e) => {
    // 我们已经在 mousedown/mouseup(button=2) 中处理了右键交互
    // （锚点上：smoothness 拖拽或弹出菜单；空白处：什么都不做）。
    // 这里仅阻止浏览器默认菜单弹出，避免重复触发。
    e.preventDefault();
  });

  canvas.addEventListener('dblclick', (e) => {
    const currentParamMode = getCurrentParamMode();
    if (currentParamMode === 'Pitch') return;

    const pos = getMousePos(e);
    const hit = findNoteAt(pos.x, pos.y);
    if (hit) {
      getSelectedNoteIds().clear();
      getSelectedNoteIds().add(hit.note.id);
      startInlineEdit(hit.note, hit);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (history.canUndo()) {
        history.undo();
        bumpNotesVersion(); // undo 就地改了 notes，失效 inactive/oob 缓存
        render();
        scheduleAutoSave();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey) || (e.key === 'Z' && e.shiftKey))) {
      e.preventDefault();
      if (history.canRedo()) {
        history.redo();
        bumpNotesVersion(); // redo 就地改了 notes，失效 inactive/oob 缓存
        render();
        scheduleAutoSave();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      // Ctrl+S：取消防抖立即推送到主页面（自动保存已开启，此为强制立即同步）
      e.preventDefault();
      const autoSaveTimer = getAutoSaveTimer();
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        setAutoSaveTimer(null);
      }
      saveFragmentData();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      const currentParamMode = getCurrentParamMode();
      const pitchCurve = getPitchCurve();
      if (currentParamMode === 'Pitch' && pitchCurve.enabled) {
        getSelectedAnchorIndices().clear();
        for (let i = 0; i < pitchCurve.anchorPoints.length; i++) {
          getSelectedAnchorIndices().add(i);
        }
      } else {
        getSelectedNoteIds().clear();
        for (const note of getNotes()) {
          getSelectedNoteIds().add(note.id);
        }
      }
      render();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
      e.preventDefault();
      const currentParamMode = getCurrentParamMode();
      if (currentParamMode !== 'Pitch' && getSelectedNoteIds().size > 0) {
        const newIds = new Set();
        const oldNotes = [];
        const notes = getNotes();
        for (const id of getSelectedNoteIds()) {
          const note = notes.find(n => n.id === id);
          if (note) {
            oldNotes.push({ ...note });
          }
        }
        for (const oldNote of oldNotes) {
          const newNote = {
            ...oldNote,
            id: genNoteId(),
            start: oldNote.start + oldNote.duration,
          };
          notes.push(newNote);
          newIds.add(newNote.id);
        }
        if (newIds.size > 0) {
          const addedNotes = [...newIds].map(id => notes.find(n => n.id === id)).map(n => ({ ...n }));
          history.push({
            undo() {
              for (const n of addedNotes) {
                const idx = notes.findIndex(nn => nn.id === n.id);
                if (idx !== -1) notes.splice(idx, 1);
              }
              setSelectedNoteIds(new Set(oldNotes.map(n => n.id)));
            },
            redo() {
              for (const n of addedNotes) {
                notes.push({ ...n });
              }
              setSelectedNoteIds(new Set(newIds));
            }
          });
          setSelectedNoteIds(newIds);
          render();
          scheduleAutoSave();
        }
      }
      return;
    }

    if (e.key === 'Escape') {
      const shortcutsOverlay = document.getElementById('shortcuts-overlay');
      if (shortcutsOverlay && shortcutsOverlay.classList.contains('visible')) {
        hideShortcutsPanel();
        return;
      }
      getSelectedNoteIds().clear();
      getSelectedAnchorIndices().clear();
      render();
      return;
    }

    if (e.key === 'F1') {
      e.preventDefault();
      const shortcutsOverlay = document.getElementById('shortcuts-overlay');
      if (shortcutsOverlay && shortcutsOverlay.classList.contains('visible')) {
        hideShortcutsPanel();
      } else {
        showShortcutsPanel();
      }
      return;
    }

    if (e.key === ' ') {
      e.preventDefault();
      document.getElementById('btn-play-fragment').click();
      return;
    }

    if (e.key === '1') {
      setCurrentParamMode(PARAM_MODES.MIDI);
      setParamPanelCollapsed(true);
      updateParamModeButtons();
      updateParamPanelState();
      resizeCanvases();
      return;
    }
    if (e.key === '2') {
      setCurrentParamMode('Pitch');
      setParamPanelCollapsed(true);
      updateParamModeButtons();
      updateParamPanelState();
      resizeCanvases();
      return;
    }
    if (e.key === '3') {
      setParamPanelMode('VOL');
      setParamPanelCollapsed(false);
      updateParamPanelState();
      resizeCanvases();
      return;
    }
    if (e.key === '4') {
      setParamPanelMode('PAN');
      setParamPanelCollapsed(false);
      updateParamPanelState();
      resizeCanvases();
      return;
    }
    if (e.key === '5') {
      setParamPanelMode('Phoneme');
      setParamPanelCollapsed(false);
      updateParamPanelState();
      resolvePhonemesFromPipeline();
      resizeCanvases();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      const currentParamMode = getCurrentParamMode();
      const pitchCurve = getPitchCurve();
      if (currentParamMode === 'Pitch' && pitchCurve.enabled) {
        const selectedAnchorIndices = getSelectedAnchorIndices();
        if (selectedAnchorIndices.size > 0) {
          const oldSnapshot = clonePitchCurveState();
          const indicesToDelete = [...selectedAnchorIndices].sort((a, b) => b - a);
          for (const idx of indicesToDelete) {
            pitchCurve.anchorPoints.splice(idx, 1);
          }
          invalidatePitchCurveCache();
          selectedAnchorIndices.clear();
          const newSnapshot = clonePitchCurveState();
          history.push({
            undo() { applyPitchCurveSnapshot(oldSnapshot); },
            redo() { applyPitchCurveSnapshot(newSnapshot); }
          });
          setDragOperation({ type: 'anchorsDelete' });
          setPitchCurveSnapshotBeforeDrag(oldSnapshot);
          finalizeDragOperation();
          render();
          scheduleAutoSave();
        }
        return;
      }
      const selectedNoteIds = getSelectedNoteIds();
      if (selectedNoteIds.size > 0) {
        const notes = getNotes();
        const kanjiGroups = getKanjiGroups();
        // Expand selection: if a selected note is in a kanji group, select all
        // notes in that group (deleting any kana = deleting the whole kanji)
        const expandedIds = new Set(selectedNoteIds);
        const deletedGroupIds = [];
        for (const id of selectedNoteIds) {
          const group = findGroupByNoteId(id, kanjiGroups);
          if (group) {
            for (const gid of group.noteIds) expandedIds.add(gid);
            if (!deletedGroupIds.includes(group.id)) deletedGroupIds.push(group.id);
          }
        }
        const deletedNotes = [];
        const deletedIndices = [];
        for (const id of expandedIds) {
          const idx = notes.findIndex(n => n.id === id);
          if (idx !== -1) {
            deletedNotes.push({ ...notes[idx] });
            deletedIndices.push(idx);
          }
        }
        const sortedForDelete = [...deletedIndices].sort((a, b) => b - a);
        for (const idx of sortedForDelete) {
          notes.splice(idx, 1);
        }
        // Remove deleted groups
        const deletedGroups = deletedGroupIds
          .map(gid => {
            const g = kanjiGroups.find(gg => gg.id === gid);
            const idx = kanjiGroups.indexOf(g);
            if (idx !== -1) kanjiGroups.splice(idx, 1);
            return g ? { group: deepClone(g), index: idx } : null;
          })
          .filter(Boolean);
        const oldSelectedIds = new Set(selectedNoteIds);
        selectedNoteIds.clear();
        const undoOrder = deletedIndices
            .map((idx, i) => ({ idx, note: deletedNotes[i] }))
            .sort((a, b) => a.idx - b.idx);
        history.push({
          undo() {
            for (const { idx, note } of undoOrder) {
              notes.splice(idx, 0, { ...note });
            }
            // Restore deleted groups
            for (const dg of deletedGroups) {
              if (dg.index >= 0 && dg.index <= kanjiGroups.length) {
                kanjiGroups.splice(dg.index, 0, deepClone(dg.group));
              } else {
                kanjiGroups.push(deepClone(dg.group));
              }
            }
            setSelectedNoteIds(new Set(oldSelectedIds));
            render();
          },
          redo() {
            for (const dn of deletedNotes) {
              const idx = notes.findIndex(n => n.id === dn.id);
              if (idx !== -1) notes.splice(idx, 1);
            }
            for (const dg of deletedGroups) {
              const idx = kanjiGroups.findIndex(g => g.id === dg.group.id);
              if (idx !== -1) kanjiGroups.splice(idx, 1);
            }
            selectedNoteIds.clear();
            render();
          }
        });
        render();
        scheduleAutoSave();
      }
      return;
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? 12 : 1;
      const timeStep = e.shiftKey ? 1 : 1 / 4;

      const currentParamMode = getCurrentParamMode();
      const pitchCurve = getPitchCurve();
      const selectedAnchorIndices = getSelectedAnchorIndices();

      if (currentParamMode === 'Pitch' && pitchCurve.enabled && selectedAnchorIndices.size > 0) {
        const oldSnapshot = clonePitchCurveState();
        for (const idx of selectedAnchorIndices) {
          const ap = pitchCurve.anchorPoints[idx];
          if (ap) {
            if (e.key === 'ArrowUp') ap.pitch = Math.min(127, ap.pitch + step);
            else if (e.key === 'ArrowDown') ap.pitch = Math.max(0, ap.pitch - step);
            else if (e.key === 'ArrowLeft') ap.time = Math.max(0, ap.time - timeStep);
            else if (e.key === 'ArrowRight') ap.time = Math.max(0, ap.time + timeStep);
          }
        }
        invalidatePitchCurveCache();
        const newSnapshot = clonePitchCurveState();
        history.push({
          undo() { applyPitchCurveSnapshot(oldSnapshot); },
          redo() { applyPitchCurveSnapshot(newSnapshot); }
        });
        render();
        scheduleAutoSave();
        return;
      }

      const selectedNoteIds = getSelectedNoteIds();
      if (selectedNoteIds.size > 0) {
        const moveData = [];
        let blocked = false;
        const planned = [];
        const notes = getNotes();
        // 多选时使用排除所有选中 notes 的重叠检测，避免相邻选中 notes 的"假重叠"
        // 导致键盘多选移动被错误 blocked（与鼠标多选拖动同一根因）。
        const checkOverlap = selectedNoteIds.size > 1
          ? (id, pitch, start, end) => hasNoteOverlapMulti(selectedNoteIds, pitch, start, end)
          : (id, pitch, start, end) => hasNoteOverlap(id, pitch, start, end);
        for (const id of selectedNoteIds) {
          const note = notes.find(n => n.id === id);
          if (note) {
            let newPitch = note.pitch;
            let newStart = note.start;
            if (e.key === 'ArrowUp') newPitch = Math.min(127, note.pitch + step);
            else if (e.key === 'ArrowDown') newPitch = Math.max(0, note.pitch - step);
            else if (e.key === 'ArrowLeft') newStart = Math.max(0, snapBeats(note.start - timeStep));
            else if (e.key === 'ArrowRight') newStart = Math.max(0, snapBeats(note.start + timeStep));
            // 分组假名不受重叠限制，允许自由移动
            const isGroupedKana = findGroupByNoteId(id, getKanjiGroups()) !== null;
            if (!isGroupedKana && checkOverlap(id, newPitch, newStart, newStart + note.duration)) {
              blocked = true;
              break;
            }
            planned.push({ note, oldStart: note.start, oldPitch: note.pitch, newStart, newPitch });
          }
        }
        if (!blocked) {
          for (const p of planned) {
            p.note.start = p.newStart;
            p.note.pitch = p.newPitch;
            moveData.push({ noteId: p.note.id, oldStart: p.oldStart, oldPitch: p.oldPitch, newStart: p.newStart, newPitch: p.newPitch });
          }
        }
        history.push({
          undo() {
            for (const md of moveData) {
              const n = notes.find(nn => nn.id === md.noteId);
              if (n) { n.start = md.oldStart; n.pitch = md.oldPitch; }
            }
          },
          redo() {
            for (const md of moveData) {
              const n = notes.find(nn => nn.id === md.noteId);
              if (n) { n.start = md.newStart; n.pitch = md.newPitch; }
            }
          }
        });
        render();
        scheduleAutoSave();
      }
      return;
    }
  });

  // rAF 合并 wheel 事件：trackpad 缩放/滚动会每秒触发数十次 wheel，
  // 每次都同步 render() 会掉帧。这里将同一帧内的多次 wheel 合并为一次 render。
  let _wheelRaf = 0;
  let _pendingWheel = null;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // 缓存最后一次 wheel 的鼠标位置（zoom 需要用）
    _pendingWheel = e;
    if (_wheelRaf) return;
    _wheelRaf = requestAnimationFrame(() => {
      _wheelRaf = 0;
      const ev = _pendingWheel;
      _pendingWheel = null;
      if (!ev) return;
      const isZoom = ev.ctrlKey || ev.metaKey;

      if (isZoom) {
        const oldZoomX = getZoomX();
        const delta = ev.deltaY > 0 ? 0.9 : 1.1;
        const newZoomX = Math.max(0.25, Math.min(4, oldZoomX * delta));
        setZoomX(newZoomX);

        const pos = getMousePos(ev);
        // Compute mouseBeats using OLD zoom/scroll (the actual beat under cursor before zoom),
        // then set scroll so the same beat stays under the cursor after zoom.
        // NOTE: Must use oldZoomX here — xToTime() would use the already-updated newZoomX,
        // giving a wrong beat and causing the note to "disconnect" from the mouse.
        const oldScrollX = getScrollX();
        const mouseBeats = (pos.x + oldScrollX) / (BEAT_WIDTH * oldZoomX);
        const newScrollX = mouseBeats * BEAT_WIDTH * newZoomX - pos.x;
        setScrollX(Math.max(0, newScrollX));

        // No special drag handling needed: since mouseBeats is preserved across the zoom,
        // dxBeats (xToTime(pos) - dragStartMouseTime) stays the same, and the note
        // naturally remains anchored to the mouse on the next mousemove.
      } else if (ev.shiftKey) {
        setScrollX(getScrollX() + ev.deltaY);
        setScrollX(Math.max(0, getScrollX()));
      } else {
        setScrollY(getScrollY() + ev.deltaY);
        const maxScrollY = Math.max(0, 128 * NOTE_HEIGHT + HEADER_HEIGHT + PARAM_CURVE_HEIGHT - canvas.parentElement.clientHeight);
        setScrollY(Math.max(0, Math.min(maxScrollY, getScrollY())));
      }

      render();
    });
  }, { passive: false });

  _setupPitchContextMenuListeners();
  _setupKanjiContextMenuListeners();
}
