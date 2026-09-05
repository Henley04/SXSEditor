import { getCanvasColors, invalidateCanvasThemeCache } from '../themes/canvasTheme.js';
import {
  PIANO_KEY_WIDTH, NOTE_HEIGHT, BEAT_WIDTH, HEADER_HEIGHT, PARAM_CURVE_HEIGHT,
  BLACK_KEYS, PITCH_CURVE_SAMPLE_INTERVAL,
  PHONEME_COLORS,
} from './constants.js';
import {
  createNotesIndex,
  ensureSorted as ensureNotesSorted,
  hasOverlapAtPitch,
  clampPosition as clampPositionIdx,
  findNoteAtBeat,
  notesInRange,
} from './notesIndex.js';
import {
  getScrollX, getScrollY, getZoomX,
  getCurrentParamMode,
  getNotes,
  getSnapGrid,
  getSelectedNoteIds,
  getSelectedAnchorIndices,
  getPitchCurve,
  getPitchDragAnchorIdx,
  getCurrentBrushStroke,
  getIsBoxSelecting,
  getBoxSelectStart, getBoxSelectEnd,
  getFragmentIsPlaying,
  getFragmentCurrentTime,
  getFragmentPlayStartPosition,
  getCurrentProject,
  getSelectedPhonemeNoteId,
  getSelectedPhonemeIndex,
  getHoveredNoteId,
  getActiveNoteId,
  getActiveAnchorIdx,
  getNotesVersion,
  getActiveInlineInput,
  getActiveInlineEditNote,
  getPitchCurveVersion,
  getSortedAnchorPointsCache, setSortedAnchorPointsCache,
  getSortedAnchorPointsCacheVersion, setSortedAnchorPointsCacheVersion,
  invalidatePitchCurveCache,
  getCurrentFragment,
  getEnvelopes,
  getNextNoteId, setNextNoteId,
  getBrushSmoothing,
  getPhonemeCache,
  getSampleRate,
  getParamPanelCollapsed,
  getParamPanelMode,
  getDragMode,
  getKanjiGroups,
} from './state.js';

const canvas = document.getElementById('piano-roll');
const ctx = canvas.getContext('2d');
const pianoKeysCanvas = document.getElementById('piano-keys');
const pianoKeysCtx = pianoKeysCanvas.getContext('2d');

export { canvas, ctx, pianoKeysCanvas, pianoKeysCtx };

function isParamAreaVisible() {
  if (getParamPanelCollapsed()) return false;
  const mode = getParamPanelMode();
  return mode === 'VOL' || mode === 'PAN' || mode === 'Phoneme';
}

export function dpr() {
  return window.devicePixelRatio || 1;
}

/**
 * 缓存的 parent clientHeight，在 _doRender 顶部读取一次，供 pitchToY/yToPitch 等
 * helper 在同一帧内复用，避免每个音符绘制时重复触发 layout（性能审查 #1 高优先级）。
 * _renderInFlight > 0 时使用缓存值，否则回退到实时 DOM 读取（用于渲染外的 hit-test 等）。
 */
let _cachedParentHeight = 0;
let _renderInFlight = 0;

function _getParentHeight() {
  if (_renderInFlight > 0 && _cachedParentHeight > 0) return _cachedParentHeight;
  return canvas.parentElement.clientHeight;
}

export function timeToX(beats) {
  return beats * BEAT_WIDTH * getZoomX() - getScrollX();
}

export function xToTime(x) {
  return (x + getScrollX()) / (BEAT_WIDTH * getZoomX());
}

export function pitchToY(pitch) {
  const pianoAreaTop = HEADER_HEIGHT;
  const showParamArea = isParamAreaVisible();
  const _pianoAreaBottom = _getParentHeight() - (showParamArea ? PARAM_CURVE_HEIGHT : 0);
  const maxPitch = 127;
  return pianoAreaTop + (maxPitch - pitch) * NOTE_HEIGHT - getScrollY();
}

export function yToPitch(y) {
  const pianoAreaTop = HEADER_HEIGHT;
  const showParamArea = isParamAreaVisible();
  const pianoAreaBottom = _getParentHeight() - (showParamArea ? PARAM_CURVE_HEIGHT : 0);
  if (y >= pianoAreaBottom) return 0;
  if (y <= pianoAreaTop) return 127;
  const maxPitch = 127;
  return Math.round(maxPitch - (y + getScrollY() - pianoAreaTop) / NOTE_HEIGHT);
}

export function yToPitchContinuous(y) {
  const pianoAreaTop = HEADER_HEIGHT;
  const showParamArea = isParamAreaVisible();
  const pianoAreaBottom = _getParentHeight() - (showParamArea ? PARAM_CURVE_HEIGHT : 0);
  if (y >= pianoAreaBottom) return 0;
  if (y <= pianoAreaTop) return 127;
  const maxPitch = 127;
  return maxPitch - (y + getScrollY() - pianoAreaTop) / NOTE_HEIGHT;
}

export function snapBeats(beats) {
  const grid = getSnapGrid();
  return Math.round(beats / grid) * grid;
}

// --- Notes index (sorted array + pitch-bucketed binary search) -------------
// Module-level cache wrapping the live notes array from state. The cache is
// rebuilt automatically when getNotes() returns a new array reference, and
// ensureSorted() also re-validates on every read so external in-place
// mutations (note.start = ..., notes.push(...)) are picked up correctly.
let _notesIdx = null;

/**
 * Get (or rebuild) the notes index for the current state.notes array.
 * @returns {object} notes index
 */
function _getNotesIdx() {
  const notes = getNotes();
  if (!_notesIdx || _notesIdx.notes !== notes) {
    _notesIdx = createNotesIndex(notes);
  } else {
    ensureNotesSorted(_notesIdx);
  }
  return _notesIdx;
}

/**
 * Public accessor for the cached notes index (used by eventHandlers for
 * batched multi-drag overlap checks via computeMultiDragResult).
 */
export function _getCanvasRendererNotesIndex() {
  return _getNotesIdx();
}

/**
 * Reset the cached notes index. Call after setNotes() replaces the array
 * reference, or whenever notes are mutated in a way that changes ordering
 * (the O(n) verification scan in ensureSorted will catch most cases, but
 * explicitly resetting avoids the per-call scan cost).
 */
export function _resetNotesIndex() {
  _notesIdx = null;
}

/**
 * Half-width of the trailing resize hot zone, expressed in BEATS (not pixels).
 *
 * The target pixel width scales with the current snap grid so the hot zone
 * is always a sensible fraction of one grid cell:
 *   targetPx = clamp(halfGridPx, 4, 12)
 * where halfGridPx = (snapGrid * pxPerBeat) / 2.
 *
 * Why scale with grid: at fine grids (1/32) the cell is small, so the hot
 * zone shrinks toward 4px (still grabbable); at coarse grids (1/4) the cell
 * is large, so the hot zone grows toward 12px (easier to grab, but capped
 * so it doesn't swallow the whole note). The [4, 12] clamp is now actually
 * reachable — at zoomX=1, BEAT_WIDTH=80, grid=1/4 → halfGridPx=10 (mid);
 * grid=1/32 → halfGridPx=1.25 → clamped to 4; zoomX=4, grid=1/4 →
 * halfGridPx=40 → clamped to 12.
 *
 * Returns beats so the hot zone scales naturally with zoomX.
 */
function _resizeHotZoneBeats() {
  const pxPerBeat = BEAT_WIDTH * getZoomX();
  if (pxPerBeat <= 0) return 0.06;
  const gridPx = getSnapGrid() * pxPerBeat;
  const targetPx = gridPx / 2;
  const clampedPx = Math.max(4, Math.min(12, targetPx));
  return clampedPx / pxPerBeat;
}

export function findNoteAt(x, y) {
  const notes = getNotes();
  if (notes.length === 0) return null;
  const pitch = yToPitch(y);
  if (pitch <= 0 || pitch > 127) return null;
  const xTime = xToTime(x);
  const idx = _getNotesIdx();
  const r = findNoteAtBeat(idx, xTime, pitch, _resizeHotZoneBeats());
  if (!r) return null;
  const note = r.note;
  const nx = Math.round(timeToX(note.start));
  const ny = Math.round(pitchToY(note.pitch));
  const nw = Math.round(note.duration * BEAT_WIDTH * getZoomX());
  const nh = Math.round(NOTE_HEIGHT);
  return { note, nx, ny, nw, nh, onResizeEdge: r.onResizeEdge };
}

/**
 * 计算播放头当前的 X 坐标（用于 hit-test）。
 * 播放中使用 currentTime，未播放时使用 playStartPosition。
 */
export function getPlayheadX() {
  const currentProject = getCurrentProject();
  const bpm = currentProject ? currentProject.bpm : 120;
  const isPlaying = getFragmentIsPlaying();
  const timeToShow = isPlaying ? getFragmentCurrentTime() : getFragmentPlayStartPosition();
  const beat = (timeToShow / 60) * bpm;
  return timeToX(beat);
}

/**
 * Hit-test for playhead: checks if a point is on the playhead line or its triangle handle.
 * The hit zone is a vertical band of PLAYHEAD_HIT_WIDTH px centered on the playhead X,
 * spanning from HEADER_HEIGHT down to the canvas bottom.
 */
export const PLAYHEAD_HIT_WIDTH = 10;

export function findPlayheadAt(x, y, h) {
  const playheadX = getPlayheadX();
  const timeToShow = getFragmentIsPlaying() ? getFragmentCurrentTime() : getFragmentPlayStartPosition();
  if (timeToShow <= 0 && !getFragmentIsPlaying()) return false;
  if (y < HEADER_HEIGHT - 8 || y > h) return false;
  return Math.abs(x - playheadX) <= PLAYHEAD_HIT_WIDTH / 2;
}

/**
 * Hit-test for kanji group brackets/labels.
 * Returns the group object if the point (x, y) is on a group's bracket line
 * or kanji label, otherwise null.
 */
export function findKanjiGroupAt(x, y) {
  const groups = getKanjiGroups();
  if (!groups || groups.length === 0) return null;
  const notes = getNotes();
  const zoomX = getZoomX();
  const scrollX = getScrollX();
  const beatToPixel = BEAT_WIDTH * zoomX;

  for (const group of groups) {
    const groupNotes = group.noteIds
      .map(id => notes.find(n => n.id === id))
      .filter(Boolean);
    if (groupNotes.length === 0) continue;
    const sorted = [...groupNotes].sort((a, b) => a.start - b.start);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const x1 = first.start * beatToPixel - scrollX;
    const x2 = (last.start + last.duration) * beatToPixel - scrollX;
    const yMin = Math.min(...groupNotes.map(n => pitchToY(n.pitch)));
    const lineY = yMin - 10;
    // Hit area: 6px tall band around the line + kanji label area
    const labelW = 20;
    const midX = (x1 + x2) / 2;
    if (y >= lineY - 8 && y <= lineY + 8) {
      // On the line itself (including label area)
      if (x >= x1 && x <= x2) {
        return { group, rightClickedNoteId: null };
      }
    }
    // Also check a wider area around the label text
    if (x >= midX - labelW && x <= midX + labelW && y >= lineY - 10 && y <= lineY + 10) {
      return { group, rightClickedNoteId: null };
    }
  }
  return null;
}

/**
 * Draw kanji group brackets and labels above kana notes.
 * For each group: a horizontal line from the first kana to the last kana,
 * with the kanji character displayed in the middle.
 */
function _drawKanjiGroups(ctx, c) {
  const groups = getKanjiGroups();
  if (!groups || groups.length === 0) return;
  const notes = getNotes();
  const zoomX = getZoomX();
  const scrollX = getScrollX();
  const beatToPixel = BEAT_WIDTH * zoomX;

  ctx.save();
  for (const group of groups) {
    const groupNotes = group.noteIds
      .map(id => notes.find(n => n.id === id))
      .filter(Boolean);
    if (groupNotes.length < 2) continue;  // Single-note groups don't need a bracket
    const sorted = [...groupNotes].sort((a, b) => a.start - b.start);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const x1 = first.start * beatToPixel - scrollX;
    const x2 = (last.start + last.duration) * beatToPixel - scrollX;
    const yMin = Math.min(...groupNotes.map(n => pitchToY(n.pitch)));
    const lineY = yMin - 10;

    // Skip if entirely off-screen
    if (x2 < 0 || x1 > canvas.width) continue;

    // Draw bracket: horizontal line with small vertical ticks at each end
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x1, lineY);
    ctx.lineTo(x2, lineY);
    // Left tick
    ctx.moveTo(x1, lineY);
    ctx.lineTo(x1, lineY + 4);
    // Right tick
    ctx.moveTo(x2, lineY);
    ctx.lineTo(x2, lineY + 4);
    ctx.stroke();

    // Draw kanji label in the middle
    const midX = (x1 + x2) / 2;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(group.kanji).width + 8;
    const textH = 14;
    // Background pill
    ctx.fillStyle = c.bgElevated;
    ctx.fillRect(midX - textW / 2, lineY - textH / 2, textW, textH);
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(midX - textW / 2, lineY - textH / 2, textW, textH);
    // Kanji text
    ctx.fillStyle = c.accent;
    ctx.fillText(group.kanji, midX, lineY);
  }
  ctx.restore();
}

export function _getParamCurveAreaTop() {
  return _getParentHeight() - PARAM_CURVE_HEIGHT;
}

export function _getParamCurveAreaBottom() {
  return _getParentHeight();
}

export function _getParamCurveYRange() {
  const mode = getParamPanelMode();
  if (mode === 'Phoneme') return { min: 0, max: 1 };
  switch (mode) {
    case 'VOL': return { min: 0, max: 1 };
    case 'PAN': return { min: -1, max: 1 };
    default: return { min: 0, max: 1 };
  }
}

export function _valueToParamY(value) {
  const areaTop = _getParamCurveAreaTop();
  const areaBottom = _getParamCurveAreaBottom();
  const areaHeight = areaBottom - areaTop;
  const { min, max } = _getParamCurveYRange();
  const normalized = (value - min) / (max - min);
  return areaTop + (1 - normalized) * areaHeight;
}

export function _interpolateEnvelope(envelope, time) {
  const kfs = envelope.keyframes;
  const len = kfs.length;
  if (len === 0) return 0.5;
  if (len === 1) return kfs[0].value;
  if (time <= kfs[0].time) return kfs[0].value;
  if (time >= kfs[len - 1].time) return kfs[len - 1].value;
  // Binary search for the segment
  let lo = 0, hi = len - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (kfs[mid].time <= time) lo = mid;
    else hi = mid;
  }
  const t = (time - kfs[lo].time) / (kfs[lo + 1].time - kfs[lo].time);
  const smoothness = kfs[lo].smoothness / 100;
  const smoothT = smoothness > 0 ? t * t * (3 - 2 * t) : t;
  return kfs[lo].value + (kfs[lo + 1].value - kfs[lo].value) * smoothT;
}

export function getClippedNotes() {
  const currentFragment = getCurrentFragment();
  const notes = getNotes();
  // 过滤掉未激活的重叠 note：同一时间点只有第一个 note 参与合成
  const inactiveIds = getCachedInactiveNoteIds(notes);
  const activeNotes = inactiveIds.size > 0 ? notes.filter(n => !inactiveIds.has(n.id)) : notes;
  if (!currentFragment || !currentFragment.duration) return activeNotes;
  const fragDuration = currentFragment.duration;
  const clipped = [];
  for (const note of activeNotes) {
    if (note.start >= fragDuration) continue;
    const noteEnd = note.start + note.duration;
    if (noteEnd > fragDuration) {
      clipped.push({ ...note, duration: fragDuration - note.start });
    } else {
      clipped.push(note);
    }
  }
  return clipped;
}

export function buildPitchCurveF0Data() {
  const pitchCurve = getPitchCurve();
  const notes = getNotes();
  if (!pitchCurve.enabled || notes.length === 0) return null;

  const hasCustom = isPitchCurveCustomized();
  if (!hasCustom) return null;

  const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
  const currentFragment = getCurrentFragment();
  const fragDuration = currentFragment ? currentFragment.duration : Infinity;
  const clippedNotes = getClippedNotes();
  if (clippedNotes.length === 0) return null;
  const lastNote = clippedNotes[clippedNotes.length - 1];
  const totalBeats = Math.min(lastNote.start + lastNote.duration, fragDuration);
  const totalSeconds = (totalBeats / bpm) * 60;
  const hopSize = 480;
  const totalFrames = Math.floor(totalSeconds * getSampleRate() / hopSize);

  const f0Array = new Float32Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    const frameTimeSec = (i * hopSize) / getSampleRate();
    const frameBeat = (frameTimeSec / 60) * bpm;
    const inNote = clippedNotes.some(n => frameBeat >= n.start && frameBeat < n.start + n.duration);
    if (!inNote) {
      f0Array[i] = 0;
      continue;
    }
    const pitch = getPitchAtTime(frameBeat);
    if (pitch !== null && pitch > 0) {
      f0Array[i] = 440 * Math.pow(2, (pitch - 69) / 12);
    } else {
      f0Array[i] = 0;
    }
  }

  return f0Array;
}

export function midiToNoteName(midi) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  return `${names[midi % 12]}${octave}`;
}

export function isCJK(char) {
  const code = char.codePointAt(0) || 0;
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0x20000 && code <= 0x2A6DF) ||
    (code >= 0x3040 && code <= 0x309F) ||
    (code >= 0x30A0 && code <= 0x30FF) ||
    (code >= 0xAC00 && code <= 0xD7AF)
  );
}

export function tokenizeLyric(text) {
  if (!text || text.trim().length === 0) return [];
  const cleaned = text.trim();
  const tokens = [];
  let i = 0;
  while (i < cleaned.length) {
    const char = cleaned[i];
    if (/\s/.test(char)) { i++; continue; }
    if (isCJK(char)) { tokens.push(char); i++; continue; }
    let word = '';
    while (i < cleaned.length && !/\s/.test(cleaned[i]) && !isCJK(cleaned[i])) {
      word += cleaned[i];
      i++;
    }
    if (word) tokens.push(word);
  }
  return tokens;
}

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function clonePitchCurveState() {
  const pitchCurve = getPitchCurve();
  return {
    enabled: pitchCurve.enabled,
    anchorPoints: deepClone(pitchCurve.anchorPoints),
    brushSegments: deepClone(pitchCurve.brushSegments),
  };
}

export function applyPitchCurveSnapshot(snapshot) {
  const pitchCurve = getPitchCurve();
  pitchCurve.enabled = snapshot.enabled;
  pitchCurve.anchorPoints = deepClone(snapshot.anchorPoints);
  pitchCurve.brushSegments = deepClone(snapshot.brushSegments);
  invalidatePitchCurveCache();
}

export function cloneEnvelopeState(envKey) {
  const envelopes = getEnvelopes();
  return deepClone(envelopes[envKey].keyframes);
}

export function applyEnvelopeSnapshot(envKey, snapshot) {
  const envelopes = getEnvelopes();
  envelopes[envKey].keyframes = deepClone(snapshot);
}

export function genNoteId() {
  const id = getNextNoteId();
  setNextNoteId(id + 1);
  return id;
}

export function hasNoteOverlap(excludeId, pitch, start, end) {
  const idx = _getNotesIdx();
  return hasOverlapAtPitch(idx, excludeId !== null ? new Set([excludeId]) : null, pitch, start, end);
}

/**
 * 多选拖动专用重叠检测：排除所有选中的 notes。
 * 在多选拖动场景中，选中 notes 会一起移动，相对位置保持不变，
 * 因此检测新位置与未选中 notes 的重叠时需要排除所有选中 notes。
 * 否则横向移动时当前 note 的新位置会与相邻选中 notes 的旧位置发生"假重叠"，
 * 导致拖动被错误 blocked（"卡住"现象）。
 * @param {Set<number>} excludeIds - 所有选中 notes 的 id 集合
 * @param {number} pitch
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
export function hasNoteOverlapMulti(excludeIds, pitch, start, end) {
  const idx = _getNotesIdx();
  return hasOverlapAtPitch(idx, excludeIds, pitch, start, end);
}

/**
 * 计算未激活（被遮挡）的 note id 集合。
 * 规则：同一时间点只能有一个 note 被激活，按 start 升序（相同 start 时
 * duration 降序）决定激活的 note。后面的 note 如果与前面任意已激活 note
 * 时间重叠（跨 pitch），则标记为未激活。
 *
 * 保留原插入序语义：按 notes 数组顺序（而非排序后顺序）判定激活。
 * 后面的 note 如果与前面任意已激活 note 时间重叠（跨 pitch），则标记为
 * 未激活。这与同 start 多 note 时"先插入者激活"的历史行为一致；如果
 * 改用排序后顺序（start 升序、同 start 时 duration 降序），则同 start
 * 多 note 会变成"更长者激活"，是用户可见的行为变化，故此处不委托给
 * notesIndex.computeInactiveNoteIds（其按排序序处理）。
 * @param {Array} notes
 * @returns {Set<number>} 未激活的 note id 集合
 */
export function getInactiveNoteIds(notes) {
  const inactive = new Set();
  const activeRanges = []; // 已激活 note 的时间区间 [{start, end}]
  for (const n of notes) {
    const nEnd = n.start + n.duration;
    // 检查是否与任意已激活 note 时间重叠
    let overlapped = false;
    for (const r of activeRanges) {
      if (n.start < r.end && nEnd > r.start) {
        overlapped = true;
        break;
      }
    }
    if (overlapped) {
      inactive.add(n.id);
    } else {
      activeRanges.push({ start: n.start, end: nEnd });
    }
  }
  return inactive;
}

// ---- 缓存：getInactiveNoteIds / getOutOfPitchRangeNotes ----
// 这两个计算每帧（非拖拽时）都会调用，getInactiveNoteIds 是 O(n²)。
// 用 notes 引用 + notesVersion 作为缓存键：notes 数组替换或其元素被修改时
// state.js 会自增 notesVersion，从而失效缓存。
let _inactiveCache = { notesRef: null, version: -1, result: null };
let _oobCache = { notesRef: null, version: -1, result: null };

// generateAutoPitchPoints / 激活 note 排序数组的缓存。
// 这两个派生量在 renderPitchCurve 的采样循环里会被 getPitchAtTime 高频调用：
// 未缓存时每次都要跑 O(n²) getInactiveNoteIds + O(n log n) sort，长分段下
// steps(可达数万) × n² 直接卡死主线程。用 notesRef + notesVersion 作键，
// 与 getCachedInactiveNoteIds 同样的失效约定（notes 变化时 bumpNotesVersion）。
let _autoPitchPointsCache = { notesRef: null, version: -1, result: null };
let _activeSortedNotesCache = { notesRef: null, version: -1, result: null };

export function getCachedInactiveNoteIds(notes) {
  const v = getNotesVersion();
  if (_inactiveCache.notesRef !== notes || _inactiveCache.version !== v) {
    _inactiveCache = { notesRef: notes, version: v, result: getInactiveNoteIds(notes) };
  }
  return _inactiveCache.result;
}

export function getCachedOutOfPitchRangeNotes(notes) {
  const v = getNotesVersion();
  if (_oobCache.notesRef !== notes || _oobCache.version !== v) {
    _oobCache = { notesRef: notes, version: v, result: getOutOfPitchRangeNotes(notes) };
  }
  return _oobCache.result;
}

export function invalidateNoteAnalysisCache() {
  _inactiveCache = { notesRef: null, version: -1, result: null };
  _oobCache = { notesRef: null, version: -1, result: null };
  _autoPitchPointsCache = { notesRef: null, version: -1, result: null };
  _activeSortedNotesCache = { notesRef: null, version: -1, result: null };
}

// 各语言模型的训练音高范围（MIDI 半音）。与 index.js 的 _clampAutoShift /
// _clampJpPitchRange 保持一致。
// - 基础模型（多语言）: [28, 88]（E1-E6，vocoder f0 有效范围）
//   注意: SiFiGAN vocoder 上限收紧到 84（C6），在合成时由 _clampAutoShift 处理，
//         UI 使用更宽的 [28, 88] 作为基础模型范围（vocoder 限制是运行时设置，
//         不属于语言训练范围）。
// - 日语模型（JP LoRA）: [48, 84]（C3-C6，JSUT/PJS/GTSinger 训练分布）
//   超出此范围时合成会无条件自动移调（_clampJpPitchRange 在 autoShift 和
//   手动 pitchShift 两条路径都生效）。
export const PITCH_RANGES = {
  base: { min: 28, max: 88, label: '基础模型' },
  ja:   { min: 48, max: 84, label: '日语模型' },
};

/**
 * 检测 notes 会使用的模型语言。
 * 与 src/main/languageDetection.js 的 resolveLanguage 保持一致：
 * - 纯日文（无英文）→ 'ja'（JP LoRA 模型）
 * - 含英文或无日文 → null（base 多语言模型）
 * 因 renderer 使用 ES module 无法直接 require CommonJS，故在此重新实现。
 * @param {Array} notes
 * @returns {'ja' | null}
 */
function _resolveModelLanguage(notes) {
  if (!notes || !Array.isArray(notes)) return null;
  let hasJapanese = false;
  for (const note of notes) {
    const lyric = note.lyric || '';
    if (!lyric) continue;
    if (lyric.startsWith('jp_') || lyric.includes('jp_') || /[ぁ-ゟァ-ヿ]/.test(lyric)) {
      hasJapanese = true;
      continue;
    }
    const norm = lyric.replace(/[<>]/g, '').toUpperCase();
    if (norm === 'SP' || norm === 'AP') continue;
    if (/[a-zA-Z]/.test(lyric)) return null; // 含英文 → base 模型
  }
  return hasJapanese ? 'ja' : null;
}

/**
 * 计算超出当前模型训练音高范围的 note id 集合。
 * 根据 notes 的语言自动选择 base ([28,88]) 或 JP ([48,84]) 范围。
 * 休止符（pitch <= 0）不标记。
 * @param {Array} notes
 * @returns {{ outOfRangeIds: Set<number>, language: ('ja'|null), range: {min, max, label} }}
 */
export function getOutOfPitchRangeNotes(notes) {
  const language = _resolveModelLanguage(notes);
  const range = language === 'ja' ? PITCH_RANGES.ja : PITCH_RANGES.base;
  const outOfRangeIds = new Set();
  for (const n of notes) {
    if (n.pitch == null) continue;
    if (n.pitch <= 0) continue; // 休止符不标记
    if (n.pitch < range.min || n.pitch > range.max) {
      outOfRangeIds.add(n.id);
    }
  }
  return { outOfRangeIds, language, range };
}

// 将 MIDI pitch 转为音名（用于提示文本）。
function _pitchToName(pitch) {
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(pitch / 12) - 1;
  return NAMES[pitch % 12] + octave;
}

export function clampNotePosition(noteId, pitch, start, duration) {
  const idx = _getNotesIdx();
  return clampPositionIdx(idx, noteId, pitch, start, duration);
}

export function generateAutoPitchPoints() {
  const notes = getNotes();
  if (notes.length === 0) return [];
  // 缓存命中：该函数在 renderPitchCurve 采样循环中被 getPitchAtTime 高频调用，
  // 未缓存时每次都重新执行 O(n²) inactive 检测 + O(n log n) 排序，是长分段卡死的主因。
  const v = getNotesVersion();
  if (_autoPitchPointsCache.notesRef === notes && _autoPitchPointsCache.version === v) {
    return _autoPitchPointsCache.result;
  }
  // 未激活的重叠 note 不作为音高曲线锚点
  const inactiveIds = getCachedInactiveNoteIds(notes);
  const activeNotes = inactiveIds.size > 0 ? notes.filter(n => !inactiveIds.has(n.id)) : notes;
  const sortedNotes = [...activeNotes].sort((a, b) => a.start - b.start);
  const points = [];
  for (let i = 0; i < sortedNotes.length; i++) {
    const note = sortedNotes[i];
    // 起始点和末端都标记 breakAfter: true，避免在 note 内部做线性插值产生 Midi 音高平线。
    // 只有锚点/笔刷覆盖的时段才返回具体音高；未覆盖的中间帧返回 null，由 vocoder 回退到 noteFreq。
    points.push({ time: note.start, pitch: note.pitch, breakAfter: true });
    points.push({ time: note.start + note.duration, pitch: note.pitch, breakAfter: true });
  }
  // 返回值仅被只读消费（drawAutoPoints / getPitchAtTime 查找），可安全缓存同一引用。
  _autoPitchPointsCache = { notesRef: notes, version: v, result: points };
  return points;
}

export function isPitchCurveCustomized() {
  const pitchCurve = getPitchCurve();
  if (pitchCurve.anchorPoints.length > 0 || pitchCurve.brushSegments.length > 0) return true;
  // 启用了颤音的 note 也算作"已自定义"，确保 buildPitchCurveF0Data 会生成 F0
  const notes = getNotes();
  for (let i = 0; i < notes.length; i++) {
    if (notes[i].vibrato && notes[i].vibrato.enabled) return true;
  }
  return false;
}

/**
 * 默认颤音参数。首次启用颤音或加载旧项目时使用。
 * depth: 80 cents（半音的 80%），rate: 5.5Hz（典型人声颤音频率），
 * start: 0.2（音符长度 20% 处开始），length: 0.8（持续 80% 音符长度），
 * fadeIn: 0.3（颤音前 30% 渐入）。
 */
export const DEFAULT_VIBRATO = {
  enabled: false,
  depth: 80,
  rate: 5.5,
  start: 0.2,
  length: 0.8,
  fadeIn: 0.3,
};

/** 确保 note 上有完整的 vibrato 字段（向后兼容旧项目）。 */
export function ensureVibrato(note) {
  if (!note.vibrato || typeof note.vibrato !== 'object') {
    note.vibrato = { ...DEFAULT_VIBRATO };
  } else {
    const v = note.vibrato;
    if (typeof v.depth !== 'number') v.depth = DEFAULT_VIBRATO.depth;
    if (typeof v.rate !== 'number') v.rate = DEFAULT_VIBRATO.rate;
    if (typeof v.start !== 'number') v.start = DEFAULT_VIBRATO.start;
    if (typeof v.length !== 'number') v.length = DEFAULT_VIBRATO.length;
    if (typeof v.fadeIn !== 'number') v.fadeIn = DEFAULT_VIBRATO.fadeIn;
    if (typeof v.enabled !== 'boolean') v.enabled = false;
  }
  return note.vibrato;
}

/**
 * 返回激活 note 的排序数组（按 start 升序，相同 start 取较长者）。
 * 缓存以避免 _findActiveNoteAtTime 在采样循环里每次重新 filter+sort。
 * 注意：排序规则与 generateAutoPitchPoints 不同（后者仅按 start），故独立缓存。
 */
function _getActiveSortedNotes() {
  const notes = getNotes();
  if (notes.length === 0) return notes;
  const v = getNotesVersion();
  if (_activeSortedNotesCache.notesRef === notes && _activeSortedNotesCache.version === v) {
    return _activeSortedNotesCache.result;
  }
  const inactiveIds = getCachedInactiveNoteIds(notes);
  const sorted = inactiveIds.size > 0
    ? notes.filter(n => !inactiveIds.has(n.id))
    : notes.slice();
  sorted.sort((a, b) => a.start - b.start || b.duration - a.duration);
  _activeSortedNotesCache = { notesRef: notes, version: v, result: sorted };
  return sorted;
}

/** 查找包含给定 beat 时间且处于激活状态的 note（用于颤音叠加）。 */
function _findActiveNoteAtTime(time) {
  const sorted = _getActiveSortedNotes();
  if (sorted.length === 0) return null;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    if (time >= n.start && time < n.start + n.duration) return n;
  }
  return null;
}

/**
 * 计算指定 note 在 beat 时间 time 处的颤音音高偏移（MIDI 单位）。
 * 颤音区域 = [start * duration, (start + length) * duration]。
 * 渐入段内通过线性包络从 0 升至 1。
 * 相位基于颤音起始点的秒数（保证每次从 0 相位上升）。
 */
export function computeVibratoOffset(note, time) {
  const v = note.vibrato;
  if (!v || !v.enabled) return 0;
  const dur = note.duration;
  if (dur <= 0) return 0;
  const vibStartBeat = note.start + v.start * dur;
  const vibLenBeat = v.length * dur;
  if (vibLenBeat <= 0) return 0;
  const vibEndBeat = vibStartBeat + vibLenBeat;
  if (time < vibStartBeat || time > vibEndBeat) return 0;
  const pos = (time - vibStartBeat) / vibLenBeat; // 0..1
  let env = 1;
  if (v.fadeIn > 0 && pos < v.fadeIn) {
    env = pos / v.fadeIn;
  }
  const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
  // 以颤音起始点为 0 相位，sin 在 0 处为 0、上升段，避免相位跳变
  const vibTimeSec = ((time - vibStartBeat) / bpm) * 60;
  const depthInMidi = v.depth / 100; // cents → semitones → MIDI
  return depthInMidi * Math.sin(2 * Math.PI * v.rate * vibTimeSec) * env;
}

export function getSortedAnchorPoints() {
  const pitchCurve = getPitchCurve();
  if (getSortedAnchorPointsCacheVersion() !== getPitchCurveVersion()) {
    setSortedAnchorPointsCache([...pitchCurve.anchorPoints].sort((a, b) => a.time - b.time));
    setSortedAnchorPointsCacheVersion(getPitchCurveVersion());
  }
  return getSortedAnchorPointsCache();
}

/**
 * 在按 time 升序排列的点数组中，二分查找包含 time 的区间左端索引。
 * 语义等价于线性 `for(i) if (time>=pts[i].time && time<=pts[i+1].time) return i`：
 * 返回第一个满足该条件的 i；不在 [pts[0].time, pts[last].time] 范围或长度<2 时返回 -1。
 * 将原 O(n) 线性扫描降为 O(log n)，在 renderPitchCurve 的采样循环（长分段可达数万步）
 * 中显著降低单次开销。重复 time 时与线性取同一区间（首个包含 time 的区间）。
 */
function _bisectSegmentIndex(pts, time) {
  const n = pts.length;
  if (n < 2) return -1;
  if (time < pts[0].time || time > pts[n - 1].time) return -1;
  // 第一个 pts[j].time >= time（必然存在，因 time <= pts[last].time）
  let lo = 0, hi = n - 1, j = n;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].time >= time) { j = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  // j === 0 表示 time === pts[0].time，线性会匹配区间 [0,1]（t=0），这里返回 0
  return j === 0 ? 0 : j - 1;
}

export function getPitchAtTime(time) {
  const pitchCurve = getPitchCurve();
  if (!pitchCurve.enabled) return null;

  let basePitch = null;

  if (pitchCurve.anchorPoints.length > 0) {
    const sorted = getSortedAnchorPoints();
    if (!(time < sorted[0].time || time > sorted[sorted.length - 1].time)) {
      const i = _bisectSegmentIndex(sorted, time);
      if (i >= 0) {
        const t = (sorted[i + 1].time - sorted[i].time) > 0
          ? (time - sorted[i].time) / (sorted[i + 1].time - sorted[i].time)
          : 0;
        const smoothness = (sorted[i].smoothness || 0) / 100;
        const smoothStepT = t * t * (3 - 2 * t);
        const smoothT = t + (smoothStepT - t) * smoothness;
        basePitch = sorted[i].pitch + smoothT * (sorted[i + 1].pitch - sorted[i].pitch);
      }
      if (basePitch === null) basePitch = sorted[sorted.length - 1].pitch;
    }
  }

  if (basePitch === null) {
    for (const seg of pitchCurve.brushSegments) {
      if (seg.points.length < 2) continue;
      const pts = seg.points;
      if (time >= pts[0].time && time <= pts[pts.length - 1].time) {
        const i = _bisectSegmentIndex(pts, time);
        if (i >= 0) {
          const t = (pts[i + 1].time - pts[i].time) > 0
            ? (time - pts[i].time) / (pts[i + 1].time - pts[i].time)
            : 0;
          basePitch = pts[i].pitch + t * (pts[i + 1].pitch - pts[i].pitch);
        }
        break;
      }
    }
  }

  if (basePitch === null) {
    const activeNote = _findActiveNoteAtTime(time);
    if (activeNote) basePitch = activeNote.pitch;
  }

  if (basePitch === null) {
    const autoPoints = generateAutoPitchPoints();
    if (autoPoints.length > 0) {
      const i = _bisectSegmentIndex(autoPoints, time);
      if (i >= 0 && !autoPoints[i].breakAfter) {
        const t = (autoPoints[i + 1].time - autoPoints[i].time) > 0
          ? (time - autoPoints[i].time) / (autoPoints[i + 1].time - autoPoints[i].time)
          : 0;
        basePitch = autoPoints[i].pitch + t * (autoPoints[i + 1].pitch - autoPoints[i].pitch);
      }
    }
  }

  // 颤音叠加：在锚点/笔刷/自动音高之上加正弦调制。
  // 兼容性说明：
  //   - 若 note 有自定义锚点/笔刷，颤音在它们算出的音高上叠加（保留滑音等表现）。
  //   - 若 note 没有自定义曲线，颤音在 note.pitch 上叠加，并把 basePitch 从 null 提升为
  //     note.pitch，让 buildPitchCurveF0Data 能为该帧生成 F0（否则该帧 F0=0 静音）。
  const note = _findActiveNoteAtTime(time);
  if (note && note.vibrato && note.vibrato.enabled) {
    if (basePitch === null) basePitch = note.pitch;
    basePitch += computeVibratoOffset(note, time);
  }

  return basePitch;
}

export function findAnchorPointAt(x, y) {
  const pitchCurve = getPitchCurve();
  if (pitchCurve.anchorPoints.length === 0) return -1;
  // O(log n + k) lookup: binary search the sorted anchors by time around the
  // click x, then distance-check only the few candidates in the 8px window.
  const sorted = getSortedAnchorPoints();
  // Build object -> original-index map once (O(n)) so the candidate loop
  // below is O(1) per lookup instead of O(n) via indexOf. Previously each
  // candidate did pitchCurve.anchorPoints.indexOf(ap), making the inner loop
  // O(k * n) when several anchors fall in the 8px window.
  const origIndex = new Map();
  for (let i = 0; i < pitchCurve.anchorPoints.length; i++) {
    origIndex.set(pitchCurve.anchorPoints[i], i);
  }
  const zoomX = getZoomX();
  const beatToPixel = BEAT_WIDTH * zoomX;
  if (beatToPixel <= 0) {
    // Degenerate zoom — fall back to linear scan.
    for (let i = 0; i < pitchCurve.anchorPoints.length; i++) {
      const ap = pitchCurve.anchorPoints[i];
      const px = timeToX(ap.time);
      const py = pitchToY(ap.pitch);
      const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
      if (dist <= 8) return i;
    }
    return -1;
  }
  const clickBeat = (x + getScrollX()) / beatToPixel;
  const windowBeats = 8 / beatToPixel; // 8px in beats
  // Binary search first index with time >= clickBeat - windowBeats.
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid].time < clickBeat - windowBeats) lo = mid + 1;
    else hi = mid;
  }
  // Scan forward until time > clickBeat + windowBeats.
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = lo; i < sorted.length; i++) {
    const ap = sorted[i];
    if (ap.time > clickBeat + windowBeats) break;
    const px = timeToX(ap.time);
    const py = pitchToY(ap.pitch);
    const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
    if (dist <= 8 && dist < bestDist) {
      bestDist = dist;
      bestIdx = origIndex.get(ap);
    }
  }
  return bestIdx;
}

export function smoothBrushPoints(points, smoothing) {
  if (points.length < 3 || smoothing <= 0) return points;
  const windowSize = Math.max(1, Math.round(smoothing / 8));
  const sigma = Math.max(0.5, windowSize / 2);
  const result = points.map(p => ({ ...p }));
  for (let i = 0; i < result.length; i++) {
    let sumPitch = 0;
    let weightSum = 0;
    for (let j = -windowSize; j <= windowSize; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < points.length) {
        const weight = Math.exp(-(j * j) / (2 * sigma * sigma));
        sumPitch += points[idx].pitch * weight;
        weightSum += weight;
      }
    }
    result[i].pitch = sumPitch / weightSum;
  }
  return result;
}

export function downsampleBrushPoints(points, interval) {
  if (points.length < 2) return points;
  const result = [points[0]];
  let lastTime = points[0].time;
  for (let i = 1; i < points.length; i++) {
    if (points[i].time - lastTime >= interval) {
      result.push(points[i]);
      lastTime = points[i].time;
    }
  }
  if (result[result.length - 1] !== points[points.length - 1]) {
    result.push(points[points.length - 1]);
  }
  return result;
}

export function convertBrushStrokeToAnchorPoints(stroke) {
  const pitchCurve = getPitchCurve();
  const brushSmoothing = getBrushSmoothing();
  if (!stroke || stroke.points.length < 2) return;

  const smoothed = smoothBrushPoints(stroke.points, brushSmoothing);
  const downsampled = downsampleBrushPoints(smoothed, 0.08);

  const strokeStart = stroke.points[0].time;
  const strokeEnd = stroke.points[stroke.points.length - 1].time;

  pitchCurve.anchorPoints = pitchCurve.anchorPoints.filter(ap =>
    ap.time < strokeStart - 0.01 || ap.time > strokeEnd + 0.01
  );

  pitchCurve.brushSegments = pitchCurve.brushSegments.filter(seg => {
    if (seg.points.length < 2) return true;
    const segStart = seg.points[0].time;
    const segEnd = seg.points[seg.points.length - 1].time;
    return segEnd < strokeStart - 0.01 || segStart > strokeEnd + 0.01;
  });

  for (const pt of downsampled) {
    pitchCurve.anchorPoints.push({
      time: pt.time,
      pitch: pt.pitch,
      smoothness: brushSmoothing,
    });
  }

  pitchCurve.anchorPoints.sort((a, b) => a.time - b.time);
  invalidatePitchCurveCache();
}

export function convertExistingBrushSegmentsToAnchorPoints() {
  const pitchCurve = getPitchCurve();
  const brushSmoothing = getBrushSmoothing();
  for (const seg of pitchCurve.brushSegments) {
    if (seg.points.length < 2) continue;
    const smoothed = smoothBrushPoints(seg.points, brushSmoothing);
    const downsampled = downsampleBrushPoints(smoothed, 0.08);
    for (const pt of downsampled) {
      pitchCurve.anchorPoints.push({
        time: pt.time,
        pitch: pt.pitch,
        smoothness: brushSmoothing,
      });
    }
  }
  pitchCurve.brushSegments = [];
  pitchCurve.anchorPoints.sort((a, b) => a.time - b.time);
  invalidatePitchCurveCache();
}

export function findNoteAtTime(time) {
  const notes = getNotes();
  for (const note of notes) {
    if (time >= note.start && time <= note.start + note.duration) {
      return note;
    }
  }
  return null;
}

export function resolvePhonemes(lyric) {
  const phonemeCache = getPhonemeCache();
  if (!lyric || lyric.trim().length === 0) return [{ name: '<SP>', display: 'SP' }];
  const trimmed = lyric.trim();
  if (trimmed === '<SP>') return [{ name: '<SP>', display: 'SP' }];
  if (trimmed === '<AP>') return [{ name: '<AP>', display: 'AP' }];
  if (phonemeCache.has(trimmed)) return phonemeCache.get(trimmed);
  return [{ name: trimmed, display: trimmed }];
}

const PHONEME_CACHE_MAX = 2000;

export function trimPhonemeCache() {
  const phonemeCache = getPhonemeCache();
  if (phonemeCache.size > PHONEME_CACHE_MAX) {
    const keys = [...phonemeCache.keys()];
    for (let i = 0; i < keys.length - PHONEME_CACHE_MAX + 200; i++) {
      phonemeCache.delete(keys[i]);
    }
  }
}

export async function resolvePhonemesFromPipeline() {
  const notes = getNotes();
  const phonemeCache = getPhonemeCache();
  const uniqueLyrics = [...new Set(notes.map(n => (n.lyric || '').trim()).filter(l => l.length > 0))];
  const toResolve = uniqueLyrics.filter(l => !phonemeCache.has(l));
  if (toResolve.length === 0) return;
  try {
    if (window.electronAPI?.resolvePhonemes) {
      const results = await window.electronAPI.resolvePhonemes(toResolve);
      let changed = false;
      for (let i = 0; i < toResolve.length; i++) {
        const lyric = toResolve[i];
        const phonemes = results[i];
        const isFallback = phonemes.length === 1 && phonemes[0].name === lyric;
        if (!isFallback) {
          phonemeCache.set(lyric, phonemes);
          changed = true;
        }
      }
      trimPhonemeCache();
      if (changed) render();
    }
  } catch (err) {
    console.warn('Phoneme parse failed:', err);
  }
}

/**
 * Default volume envelope for a phoneme, tailored to its phonetic class.
 *
 * Phonetic classes and their envelope shapes:
 *   - Vowels: smooth fade-in/out with sustained peak. Vowels are the sonority
 *     peak of a syllable and should be loud throughout, with gentle edges to
 *     avoid clicks at phoneme boundaries.
 *   - Stops (P/B/T/D/K/G): sharp attack (burst release) then quick decay.
 *     Stops have a brief transient at onset followed by silence/aspiration;
 *     the envelope captures this with a fast rise to t=0.05 and decay by t=0.3.
 *   - Fricatives (S/Z/SH/F/V/HH/...): gradual attack, sustained plateau.
 *     Fricatives require airflow buildup and sustain noise throughout.
 *   - Affricates (CH/JH): stop burst + fricative sustain, so sharp attack
 *     with a longer sustained tail than pure stops.
 *   - Nasals (M/N/NG): soft attack, sustained murmur, soft release. Nasals
 *     have lower intensity than oral sounds, so peak is 0.9 instead of 1.0.
 *   - Approximants (L/R/W/Y): smooth, sustained, no sharp transients.
 *
 * For non-English phonemes (zh_, yue_, jp_) we return the default envelope
 * since their phonetic class isn't easily classified by ARPAbet categories.
 * The default is also used as a fallback for unrecognized phonemes.
 *
 * @param {string} phonemeName - Full phoneme name (e.g., 'en_AA1', 'jp_a', 'yue_gaa1')
 * @returns {Array<{t:number, v:number}>} Volume envelope keyframes
 */
export function getVolumeEnvelopeForPhoneme(phonemeName) {
  // Default envelope — generic fade in/out with sustained peak
  const DEFAULT = [
    { t: 0, v: 0.3 },
    { t: 0.1, v: 1.0 },
    { t: 0.85, v: 1.0 },
    { t: 1.0, v: 0.3 },
  ];
  if (!phonemeName) return DEFAULT;

  // Extract base phoneme (strip language prefix)
  let base = phonemeName;
  if (base.startsWith('en_')) {
    base = base.slice(3);
  } else {
    // zh_, yue_, jp_ phonemes and special tokens use the default envelope
    return DEFAULT;
  }

  // Strip stress digit from vowels for class lookup
  const stressless = base.replace(/[012]$/, '');

  // ARPAbet vowel bases
  const VOWELS = new Set([
    'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY',
    'IH', 'IY', 'OW', 'OY', 'UH', 'UW',
  ]);
  // Stop consonants — burst release
  const STOPS = new Set(['P', 'B', 'T', 'D', 'K', 'G']);
  // Fricatives — sustained noise
  const FRICATIVES = new Set(['S', 'Z', 'SH', 'ZH', 'F', 'V', 'TH', 'DH', 'HH']);
  // Affricates — stop + fricative
  const AFFRICATES = new Set(['CH', 'JH']);
  // Nasals — sustained murmur
  const NASALS = new Set(['M', 'N', 'NG']);
  // Approximants — smooth glide
  const APPROXIMANTS = new Set(['L', 'R', 'W', 'Y']);

  if (VOWELS.has(stressless)) {
    // Vowels: smooth fade in/out, sustained peak at 1.0
    return [
      { t: 0, v: 0.4 },
      { t: 0.15, v: 1.0 },
      { t: 0.8, v: 1.0 },
      { t: 1.0, v: 0.4 },
    ];
  }
  if (STOPS.has(base)) {
    // Stops: sharp attack (burst), quick decay to low level
    return [
      { t: 0, v: 0.0 },
      { t: 0.05, v: 1.0 },
      { t: 0.3, v: 0.5 },
      { t: 1.0, v: 0.3 },
    ];
  }
  if (FRICATIVES.has(base)) {
    // Fricatives: gradual airflow buildup, sustained noise
    return [
      { t: 0, v: 0.2 },
      { t: 0.2, v: 1.0 },
      { t: 0.8, v: 1.0 },
      { t: 1.0, v: 0.3 },
    ];
  }
  if (AFFRICATES.has(base)) {
    // Affricates: stop burst + fricative sustain
    return [
      { t: 0, v: 0.0 },
      { t: 0.05, v: 1.0 },
      { t: 0.7, v: 1.0 },
      { t: 1.0, v: 0.3 },
    ];
  }
  if (NASALS.has(base)) {
    // Nasals: soft attack, sustained murmur (lower peak), soft release
    return [
      { t: 0, v: 0.2 },
      { t: 0.2, v: 0.9 },
      { t: 0.8, v: 0.9 },
      { t: 1.0, v: 0.3 },
    ];
  }
  if (APPROXIMANTS.has(base)) {
    // Approximants: smooth, sustained, no sharp transients
    return [
      { t: 0, v: 0.3 },
      { t: 0.15, v: 0.95 },
      { t: 0.85, v: 0.95 },
      { t: 1.0, v: 0.3 },
    ];
  }
  return DEFAULT;
}

export function getPhonemeAdjustments(note) {
  const phonemes = resolvePhonemes(note.lyric);
  // resolvePhonemes 缓存未命中时返回 fallback [{name: lyric, display: lyric}]（单一音素）。
  // 日语等"一字符多音素"歌词（如"か"→jp_k,jp_a）在异步解析完成前会拿到 fallback，
  // 此时若覆盖已保存的 adjustments 会丢失用户调好的边界比例。检测到 fallback 时
  // 保留已有 adjustments，等 resolvePhonemesFromPipeline 完成后重新 render 对齐。
  const trimmedLyric = (note.lyric || '').trim();
  const isFallback = phonemes.length === 1 && phonemes[0].name === trimmedLyric;
  if (note.phonemeAdjustments && note.phonemeAdjustments.length > 0) {
    const cached = note.phonemeAdjustments;
    if (cached.length === phonemes.length && cached[0].name === phonemes[0].name) {
      for (let i = 0; i < phonemes.length; i++) {
        cached[i].display = phonemes[i].display;
      }
      return cached;
    }
    // fallback 期间不要覆盖已保存的 adjustments
    if (isFallback) {
      return cached;
    }
  }
  // 纯读取：仅计算默认 adjustments 供显示用，不写回 note.phonemeAdjustments。
  // 写回默认值会让合成缓存键（audioSegmentation.computeSynthCacheKey 把
  // phonemeAdjustments 纳入哈希）从 K1(无 adjustments) 变为 K2(默认值)，
  // 导致打开音素菜单后再次播放触发不必要的二次推理。用户实际拖拽/锁定音素时，
  // 由 handlePhonemeMouseDown 显式提交保存，自定义音素排列仍可正常生效。
  //
  // 默认 durationRatio 按 phoneme.weight 比例分配：
  //   - 英文音素：由 main 进程 resolveLyricToPhonemes 用 en_phoneme_durations.json
  //     统计表附带 weight
  //   - 日语音素：由 _attachJapaneseWeights 用 JP_MORA_WEIGHTS 拍时序表附带 weight
  //   - 其他（中文/未解析 fallback）：weight 缺失，回退到平均分布
  // 使 UI 默认分布呈现"元音长、辅音短"，与推理时的 _allocateByStats 趋势一致。
  const weights = phonemes.map(ph => (typeof ph.weight === 'number' && ph.weight > 0) ? ph.weight : 0);
  const weightSum = weights.reduce((s, v) => s + v, 0);
  const hasWeights = weightSum > 0;
  const adjustments = phonemes.map((ph, i) => ({
    id: i,
    name: ph.name,
    display: ph.display,
    offsetRatio: 0,
    durationRatio: hasWeights ? weights[i] / weightSum : 1 / phonemes.length,
    volumePoints: getVolumeEnvelopeForPhoneme(ph.name),
    locked: i === 0,
  }));
  return adjustments;
}

export function getVolumeAtTime(volumePoints, t) {
  if (!volumePoints || volumePoints.length === 0) return 1;
  if (t <= volumePoints[0].t) return volumePoints[0].v;
  if (t >= volumePoints[volumePoints.length - 1].t) return volumePoints[volumePoints.length - 1].v;
  for (let i = 0; i < volumePoints.length - 1; i++) {
    if (t >= volumePoints[i].t && t <= volumePoints[i + 1].t) {
      const ratio = (t - volumePoints[i].t) / (volumePoints[i + 1].t - volumePoints[i].t);
      return volumePoints[i].v + ratio * (volumePoints[i + 1].v - volumePoints[i].v);
    }
  }
  return 1;
}

export function getPhonemeStartX(adj, adjustments) {
  let x = 0;
  for (const a of adjustments) {
    if (a === adj) return x;
    x += a.durationRatio;
  }
  return 0;
}

export function normalizePhonemeRatios(adjustments) {
  const total = adjustments.reduce((s, a) => s + a.durationRatio, 0);
  if (total > 0) {
    for (const a of adjustments) {
      a.durationRatio = a.durationRatio / total;
    }
  }
  return adjustments;
}

export function getVisibleDuration() {
  const w = canvas.clientWidth;
  const visibleBeats = w / (BEAT_WIDTH * getZoomX());
  const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
  const beatsPerSecond = bpm / 60;
  return visibleBeats / beatsPerSecond;
}

export function resizeCanvases() {
  const containerRect = document.getElementById('piano-roll-container').getBoundingClientRect();
  const keysContainerRect = document.getElementById('piano-keys-container').getBoundingClientRect();
  const h = keysContainerRect.height;
  const w = containerRect.width;

  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.floor(w * dpr());
  canvas.height = Math.floor(h * dpr());

  pianoKeysCanvas.style.width = `${PIANO_KEY_WIDTH}px`;
  pianoKeysCanvas.style.height = `${h}px`;
  pianoKeysCanvas.width = Math.floor(PIANO_KEY_WIDTH * dpr());
  pianoKeysCanvas.height = Math.floor(h * dpr());

  pianoKeysCtx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);

  _staticCacheDirty = true;
  render();
}

export function computeInitialScrollY() {
  const notes = getNotes();
  const showParamArea = isParamAreaVisible();
  const pianoAreaHeight = canvas.parentElement.clientHeight - (showParamArea ? PARAM_CURVE_HEIGHT : 0) - HEADER_HEIGHT;
  const centerY = HEADER_HEIGHT + pianoAreaHeight / 2;

  let targetPitch;
  if (notes.length > 0) {
    let minPitch = 127, maxPitch = 0;
    for (const n of notes) {
      if (n.pitch < minPitch) minPitch = n.pitch;
      if (n.pitch > maxPitch) maxPitch = n.pitch;
    }
    targetPitch = (minPitch + maxPitch) / 2;
  } else {
    targetPitch = 127 / 2;
  }

  return HEADER_HEIGHT + (127 - targetPitch) * NOTE_HEIGHT - centerY;
}

function renderPhonemeEditor(ctx, w, h, areaTop, areaBottom, c) {
  const barPadding = 6;
  const labelH = 16;
  const barTop = areaTop + labelH;
  const barBottom = areaBottom - barPadding;
  const barHeight = barBottom - barTop;

  ctx.fillStyle = c.bgElevated;
  ctx.fillRect(0, areaTop, w, areaBottom - areaTop);

  ctx.strokeStyle = c.borderStrong;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, areaTop);
  ctx.lineTo(w, areaTop);
  ctx.stroke();

  ctx.fillStyle = c.fgDisabled;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('Phoneme', w - 4, areaTop + 12);

  for (let v = 0; v <= 1; v += 0.25) {
    const y = barBottom - barHeight * v;
    ctx.strokeStyle = v === 0.5 ? c.gridLineMajor : c.gridLineMinor;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const notes = getNotes();
  const selectedNoteIds = getSelectedNoteIds();
  const selectedPhonemeNoteId = getSelectedPhonemeNoteId();
  const selectedPhonemeIndex = getSelectedPhonemeIndex();
  const inactiveNoteIds = getCachedInactiveNoteIds(notes);

  const visibleNotes = notes.filter(note => {
    // 未激活的重叠 note 不显示音素
    if (inactiveNoteIds.has(note.id)) return false;
    const nx = timeToX(note.start);
    const nw = note.duration * BEAT_WIDTH * getZoomX();
    return nx + nw >= 0 && nx <= w;
  });

  for (const note of visibleNotes) {
    const adjustments = getPhonemeAdjustments(note);
    if (!adjustments || adjustments.length === 0) continue;

    const noteStartX = timeToX(note.start);
    const noteEndX = timeToX(note.start + note.duration);
    const noteWidth = noteEndX - noteStartX;
    if (noteWidth < 4) continue;

    const isSelected = selectedNoteIds.has(note.id);

    ctx.fillStyle = c.bgPanel;
    ctx.fillRect(noteStartX, barTop, noteWidth, barHeight);
    ctx.strokeStyle = isSelected ? c.accent : c.gridLineMajor;
    ctx.lineWidth = 1;
    ctx.strokeRect(noteStartX, barTop, noteWidth, barHeight);

    let x = noteStartX;
    for (let i = 0; i < adjustments.length; i++) {
      const adj = adjustments[i];
      const phWidth = noteWidth * adj.durationRatio;
      const phEnd = x + phWidth;
      const color = PHONEME_COLORS[i % PHONEME_COLORS.length];
      const isPhSelected = selectedPhonemeNoteId === note.id && selectedPhonemeIndex === i;
      const pts = adj.volumePoints || [{ t: 0, v: 1 }, { t: 1, v: 1 }];

      ctx.fillStyle = color;
      ctx.globalAlpha = isPhSelected ? 0.2 : 0.1;
      ctx.fillRect(x + 1, barTop, phWidth - 2, barHeight);
      ctx.globalAlpha = 1.0;

      if (isPhSelected) {
        ctx.strokeStyle = c.fgPrimary;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, barTop, phWidth - 2, barHeight);
      }

      ctx.beginPath();
      ctx.moveTo(x + 1, barBottom);
      for (let s = 0; s <= 1; s += 0.02) {
        const px = x + 1 + s * (phWidth - 2);
        const v = getVolumeAtTime(pts, s);
        const py = barBottom - barHeight * Math.max(0, Math.min(1, v));
        ctx.lineTo(px, py);
      }
      ctx.lineTo(x + phWidth - 1, barBottom);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = isPhSelected ? 0.6 : 0.35;
      ctx.fill();
      ctx.globalAlpha = 1.0;

      ctx.beginPath();
      for (let s = 0; s <= 1; s += 0.02) {
        const px = x + 1 + s * (phWidth - 2);
        const v = getVolumeAtTime(pts, s);
        const py = barBottom - barHeight * Math.max(0, Math.min(1, v));
        if (s === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();

      if (isPhSelected) {
        for (let p = 0; p < pts.length; p++) {
          const pt = pts[p];
          const px = x + 1 + pt.t * (phWidth - 2);
          const py = barBottom - barHeight * Math.max(0, Math.min(1, pt.v));
          ctx.fillStyle = c.fgPrimary;
          ctx.beginPath();
          ctx.arc(px, py, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      if (phWidth > 20) {
        ctx.fillStyle = c.fgPrimary;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = adj.display || adj.name || '';
        ctx.fillText(label, x + phWidth / 2, barTop + 10);
      }

      if (adj.locked) {
        ctx.fillStyle = c.warning;
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('L', x + 3, barTop + 2);
      }

      if (i > 0) {
        ctx.strokeStyle = isPhSelected ? c.fgPrimary : c.fgMuted;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(x, barTop);
        ctx.lineTo(x, barBottom);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = isPhSelected ? c.fgPrimary : c.fgSecondary;
        ctx.beginPath();
        ctx.arc(x, barTop + barHeight / 2, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      x = phEnd;
    }
  }
}

function renderPianoKeys(c) {
  const h = pianoKeysCanvas.parentElement.clientHeight;
  const w = PIANO_KEY_WIDTH;
  pianoKeysCtx.clearRect(0, 0, w, h);
  pianoKeysCtx.fillStyle = c.bgPanel;
  pianoKeysCtx.fillRect(0, 0, w, h);

  const startPitch = yToPitch(h);
  const endPitch = yToPitch(HEADER_HEIGHT);

  for (let p = Math.max(0, startPitch); p <= Math.min(127, endPitch); p++) {
    const y = pitchToY(p);
    const keyH = NOTE_HEIGHT;
    const isBlack = BLACK_KEYS.has(p % 12);

    pianoKeysCtx.fillStyle = isBlack ? c.pianoBlackKey : c.pianoWhiteKey;
    pianoKeysCtx.fillRect(0, y, w, keyH);

    pianoKeysCtx.strokeStyle = c.pianoKeyBorder;
    pianoKeysCtx.lineWidth = 0.5;
    pianoKeysCtx.strokeRect(0, y, w, keyH);

    if (keyH >= 10) {
      pianoKeysCtx.fillStyle = isBlack ? '#cccccc' : '#2a2a3d';
      pianoKeysCtx.font = '10px sans-serif';
      pianoKeysCtx.textAlign = 'right';
      pianoKeysCtx.textBaseline = 'middle';
      pianoKeysCtx.fillText(midiToNoteName(p), w - 4, y + keyH / 2);
    }
  }
}

function renderPitchCurve(c) {
  const pitchCurve = getPitchCurve();
  if (!pitchCurve.enabled) return;

  const w = canvas.parentElement.clientWidth;
  const startBeat = xToTime(0);
  const endBeat = xToTime(w);
  const allNotes = getNotes();
  // 未激活的重叠 note 不在音高曲线中绘制锚点
  const inactiveNoteIds = getCachedInactiveNoteIds(allNotes);
  const notes = inactiveNoteIds.size > 0 ? allNotes.filter(n => !inactiveNoteIds.has(n.id)) : allNotes;
  const selectedAnchorIndices = getSelectedAnchorIndices();
  const pitchDragAnchorIdx = getPitchDragAnchorIdx();
  const currentBrushStroke = getCurrentBrushStroke();

  const hasCustom = isPitchCurveCustomized();
  const autoPoints = generateAutoPitchPoints();

  function drawAutoPoints(style, lineW, dash) {
    if (autoPoints.length === 0) return;
    ctx.strokeStyle = style;
    ctx.lineWidth = lineW;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let drawing = false;
    for (let i = 0; i < autoPoints.length; i++) {
      const pt = autoPoints[i];
      if (pt.time < startBeat - 1 || pt.time > endBeat + 1) {
        if (drawing && pt.breakAfter) drawing = false;
        continue;
      }
      const px = timeToX(pt.time);
      const py = pitchToY(pt.pitch);
      if (!drawing) { ctx.moveTo(px, py); drawing = true; }
      else ctx.lineTo(px, py);
      if (pt.breakAfter) drawing = false;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (!hasCustom) {
    drawAutoPoints(c.pitchAutoPoint, 2, [6, 4]);

    for (const note of notes) {
      const startX = timeToX(note.start);
      const endX = timeToX(note.start + note.duration);
      const y = pitchToY(note.pitch);
      if (endX < 0 || startX > w) continue;

      ctx.fillStyle = c.successSoft;
      ctx.beginPath();
      ctx.arc(startX, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(endX, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    if (currentBrushStroke && currentBrushStroke.points.length >= 2) {
      ctx.strokeStyle = c.warning;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      let first = true;
      for (const pt of currentBrushStroke.points) {
        const px = timeToX(pt.time);
        const py = pitchToY(pt.pitch);
        if (first) { ctx.moveTo(px, py); first = false; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    return;
  }

  drawAutoPoints(c.pitchAutoLine, 1.5, [4, 3]);

  // autoPoints 现在只在 note 起始/末端有拟合点（breakAfter 阻止 note 内部插值），
  // drawAutoPoints 仅做 moveTo 不会画出线段，这里补画拟合点小圆点保持视觉参考。
  ctx.fillStyle = c.pitchAutoLine;
  for (const note of notes) {
    const startX = timeToX(note.start);
    const endX = timeToX(note.start + note.duration);
    const y = pitchToY(note.pitch);
    if (endX < 0 || startX > w) continue;
    ctx.beginPath();
    ctx.arc(startX, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(endX, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (pitchCurve.anchorPoints.length > 0) {
    const sorted = getSortedAnchorPoints();
    const maxTime = Math.max(endBeat, sorted[sorted.length - 1].time) + 2;
    const steps = Math.max(200, Math.floor((maxTime - startBeat) / PITCH_CURVE_SAMPLE_INTERVAL));

    ctx.strokeStyle = c.pitchLine;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let first = true;
    for (let i = 0; i <= steps; i++) {
      const t = startBeat + (i / steps) * (maxTime - startBeat);

      const pitch = getPitchAtTime(t);
      if (pitch === null) continue;
      const px = timeToX(t);
      const py = pitchToY(pitch);
      if (first) { ctx.moveTo(px, py); first = false; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    for (let i = 0; i < pitchCurve.anchorPoints.length; i++) {
      const ap = pitchCurve.anchorPoints[i];
      // 落在未激活 note 时段内的锚点不显示
      if (inactiveNoteIds.size > 0) {
        let inInactive = false;
        for (const n of allNotes) {
          if (inactiveNoteIds.has(n.id) && ap.time >= n.start && ap.time < n.start + n.duration) {
            inInactive = true;
            break;
          }
        }
        if (inInactive) continue;
      }
      const px = timeToX(ap.time);
      const py = pitchToY(ap.pitch);
      const isSelected = selectedAnchorIndices.has(i) || i === pitchDragAnchorIdx;
      const isActive = i === getActiveAnchorIdx(); // 鼠标按住此锚点

      // 按压反馈：放大 + 发光阴影，让用户清楚知道"按下了哪个锚点"。
      if (isActive) {
        ctx.save();
        ctx.shadowColor = c.accent;
        ctx.shadowBlur = 14;
      }
      const radius = isSelected ? 7 : (isActive ? 7 : 6);
      ctx.fillStyle = isSelected ? c.fgPrimary : (isActive ? c.accent : c.pitchPoint);
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = isSelected ? c.accent : (isActive ? c.accent : c.shadowColor);
      ctx.lineWidth = isSelected ? 2.5 : (isActive ? 2.5 : 1.5);
      ctx.stroke();
      if (isActive) {
        ctx.restore();
      }

      if (isSelected) {
        ctx.strokeStyle = c.accentLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, 12, 0, Math.PI * 2);
        ctx.stroke();

        // 在选中锚点旁显示其 smoothness 值，便于右键拖拽时实时观察变化。
        const sm = Math.max(0, Math.min(100, Math.round(ap.smoothness ?? 0)));
        const label = `S${sm}`;
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const labelX = px + 14;
        const labelY = py - 12;
        const padX = 3, padY = 1;
        const metrics = ctx.measureText(label);
        const tw = metrics.width;
        const th = 11;
        // 半透明背景便于阅读
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(labelX - padX, labelY - th / 2 - padY, tw + padX * 2, th + padY * 2);
        ctx.fillStyle = c.accentLine || c.fgPrimary;
        ctx.fillText(label, labelX, labelY);
      }
    }
  }

  if (currentBrushStroke && currentBrushStroke.points.length >= 2) {
    ctx.strokeStyle = c.warning;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    let first = true;
    for (const pt of currentBrushStroke.points) {
      const px = timeToX(pt.time);
      const py = pitchToY(pt.pitch);
      if (first) { ctx.moveTo(px, py); first = false; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

/**
 * 在 note 上叠加颤音 / 渐入渐出的视觉指示，让用户一眼看出哪些 note 启用了效果。
 * - 渐入/渐出：在 note 左/右边缘画半透明三角形（从 0 → 1 / 1 → 0 的增益包络示意）。
 * - 颤音：在 note 左上角画一个小正弦波标记（≈），仅在 note 宽度足够时显示。
 * 颜色采用半透明叠加，避免遮挡 note 本体的歌词与选中态。
 */
function _drawNoteEffectIndicators(ctx, c, note, x, y, w, h) {
  const hasFadeIn = note.fadeIn && note.fadeIn > 0;
  const hasFadeOut = note.fadeOut && note.fadeOut > 0;
  const hasVibrato = note.vibrato && note.vibrato.enabled;

  if (!hasFadeIn && !hasFadeOut && !hasVibrato) return;

  // 渐入/渐出三角形：宽度按 fade 时长占 note 时长的比例缩放（最大不超过 note 宽度的 40%）。
  // fade 时长单位 ms，note 时长单位 beats；通过 bpm 换算成同单位比较。
  const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
  const noteDurSec = (note.duration / bpm) * 60;
  if (hasFadeIn || hasFadeOut) {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    const maxFadeW = w * 0.4;
    if (hasFadeIn) {
      const fadeInSec = note.fadeIn / 1000;
      const ratio = noteDurSec > 0 ? Math.min(1, fadeInSec / noteDurSec) : 1;
      const fw = Math.max(4, Math.min(maxFadeW, w * ratio));
      // 左边缘三角形：从左上角 (x, y) → (x+fw, y+h/2) → (x, y+h)，模拟 0→1 增益
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + fw, y + h / 2);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      ctx.fill();
    }
    if (hasFadeOut) {
      const fadeOutSec = note.fadeOut / 1000;
      const ratio = noteDurSec > 0 ? Math.min(1, fadeOutSec / noteDurSec) : 1;
      const fw = Math.max(4, Math.min(maxFadeW, w * ratio));
      // 右边缘三角形：从 (x+w-fw, y+h/2) → (x+w, y) → (x+w, y+h)，模拟 1→0 增益
      ctx.beginPath();
      ctx.moveTo(x + w - fw, y + h / 2);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // 颤音标记：左上角小正弦波，仅在 note 宽度足够（> 22px）时显示，避免挤占歌词空间。
  // 用 accent 色 + 半透明，与 note 本体形成对比但不过分突兀。
  if (hasVibrato && w > 22) {
    ctx.save();
    ctx.strokeStyle = c.accent;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.2;
    const bx = x + 3;
    const by = y + 3;
    const bw = 12;
    const bh = 5;
    ctx.beginPath();
    // 简化的正弦波：两个半周期，从左到右
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const px = bx + t * bw;
      const py = by + bh / 2 + Math.sin(t * Math.PI * 2) * (bh / 2);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }
}

let _renderRaf = 0;
export function render() {
  if (_renderRaf) return;
  _renderRaf = requestAnimationFrame(() => { _renderRaf = 0; _doRender(); });
}

// Static layer cache (background + grid lines)
let _staticCacheCanvas = null;
let _staticCacheKey = '';
let _staticCacheDirty = true;

export function invalidateStaticCache() {
  _staticCacheDirty = true;
}

function _doRender() {
  const w = canvas.parentElement.clientWidth;
  const h = canvas.parentElement.clientHeight;
  // 缓存 clientHeight 供本帧所有 helper 复用，避免 O(N) 次 layout 读取（性能审查 #1）
  _cachedParentHeight = h;
  _renderInFlight++;
  try {
    _doRenderImpl(w, h);
  } finally {
    _renderInFlight--;
  }
}
function _doRenderImpl(w, h) {
  const c = getCanvasColors();
  const dprVal = dpr();
  const pixelW = Math.floor(w * dprVal);
  const pixelH = Math.floor(h * dprVal);

  const currentProject = getCurrentProject();
  const beatsPerMeasure = currentProject ? currentProject.timeSignature[0] : 4;
  const showParamArea = isParamAreaVisible();
  const pianoAreaBottom = showParamArea ? _getParamCurveAreaTop() : h;

  // Build cache key from state that affects the static layer
  const staticCacheKey = `${w}|${h}|${dprVal}|${getScrollX()}|${getScrollY()}|${getZoomX()}|${beatsPerMeasure}|${showParamArea}|${pianoAreaBottom}|${c.bgElevated}|${c.gridLineMeasure}|${c.gridLineMajor}|${c.gridLineMinor}|${c.timeText}`;

  if (_staticCacheDirty || _staticCacheKey !== staticCacheKey ||
      !_staticCacheCanvas || _staticCacheCanvas.width !== pixelW || _staticCacheCanvas.height !== pixelH) {
    // Rebuild static layer (background + grid lines)
    if (!_staticCacheCanvas || _staticCacheCanvas.width !== pixelW || _staticCacheCanvas.height !== pixelH) {
      _staticCacheCanvas = document.createElement('canvas');
      _staticCacheCanvas.width = pixelW;
      _staticCacheCanvas.height = pixelH;
    }
    const cacheCtx = _staticCacheCanvas.getContext('2d');
    cacheCtx.setTransform(dprVal, 0, 0, dprVal, 0, 0);
    cacheCtx.clearRect(0, 0, w, h);

    // Background
    cacheCtx.fillStyle = c.bgElevated;
    cacheCtx.fillRect(0, 0, w, h);

    // Vertical grid lines (beats)
    const startBeat = xToTime(0);
    const endBeat = xToTime(w);
    cacheCtx.lineWidth = 0.5;
    for (let b = Math.floor(startBeat); b <= Math.ceil(endBeat); b++) {
      const x = timeToX(b);
      if (x < 0) continue;
      const isMeasure = (b % beatsPerMeasure === 0);
      cacheCtx.strokeStyle = isMeasure ? c.gridLineMeasure : c.gridLineMajor;
      cacheCtx.beginPath();
      cacheCtx.moveTo(x, HEADER_HEIGHT);
      cacheCtx.lineTo(x, pianoAreaBottom);
      cacheCtx.stroke();
      if (isMeasure) {
        cacheCtx.fillStyle = c.timeText;
        cacheCtx.font = '11px sans-serif';
        cacheCtx.textAlign = 'center';
        cacheCtx.fillText(String(Math.floor(b / beatsPerMeasure) + 1), x, HEADER_HEIGHT - 6);
      }
    }

    // Horizontal grid lines (pitches)
    const startPitch = yToPitch(h);
    const endPitch = yToPitch(HEADER_HEIGHT);
    for (let p = Math.max(0, startPitch); p <= Math.min(127, endPitch); p++) {
      const y = pitchToY(p);
      const isBlack = BLACK_KEYS.has(p % 12);
      cacheCtx.strokeStyle = isBlack ? c.gridLineMajor : c.gridLineMinor;
      cacheCtx.beginPath();
      cacheCtx.moveTo(0, y);
      cacheCtx.lineTo(w, y);
      cacheCtx.stroke();
    }

    _staticCacheKey = staticCacheKey;
    _staticCacheDirty = false;
  }

  // Draw cached static layer
  ctx.setTransform(dprVal, 0, 0, dprVal, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(_staticCacheCanvas, 0, 0, w, h);

  const currentParamMode = getCurrentParamMode();

  const notes = getNotes();
  const selectedNoteIds = getSelectedNoteIds();
  const currentFragment = getCurrentFragment();
  // 拖拽中跳过无效 note 检测（O(n²)），保持帧率不因碰撞检测而掉帧
  const isDragging = getDragMode() !== null;
  // 使用缓存版本（基于 notesVersion 失效），避免每帧 O(n²) 重算
  const inactiveNoteIds = isDragging ? new Set() : getCachedInactiveNoteIds(notes);
  // 按语言模型检测音高范围外 note（基础模型 [28,88] / 日语模型 [48,84]）
  const { outOfRangeIds: oobNoteIds, range: pitchRange } = getCachedOutOfPitchRangeNotes(notes);
  // 鼠标按住的 note（mousedown 期间），用于绘制按压反馈
  const activeNoteId = getActiveNoteId();

  // 预计算本帧常量，避免每 note 重复 getZoomX/getScrollX 函数调用
  const zoomX = getZoomX();
  const scrollX = getScrollX();
  const _scrollY = getScrollY();
  const beatToPixel = BEAT_WIDTH * zoomX;

  // Viewport culling: only iterate notes whose [start, start+duration)
  // intersects the visible beat range. O(log n + visible) instead of O(n).
  // x = start * beatToPixel - scrollX, so visible x ∈ [0, w] maps to
  // beat ∈ [scrollX / beatToPixel, (w + scrollX) / beatToPixel].
  // 阈值从 64 降到 16：即使是中等规模项目（30~60 notes）也启用裁剪，
  // 避免每帧迭代全部 notes。
  let visibleNotes = notes;
  if (notes.length > 16 && beatToPixel > 0) {
    const viewStartBeat = scrollX / beatToPixel;
    const viewEndBeat = (w + scrollX) / beatToPixel;
    const idx = _getNotesIdx();
    visibleNotes = notesInRange(idx, viewStartBeat, viewEndBeat);
  }

  for (const note of visibleNotes) {
    const x = note.start * beatToPixel - scrollX;
    const y = pitchToY(note.pitch);
    const nw = note.duration * beatToPixel;
    const nh = NOTE_HEIGHT;
    if (x + nw < 0 || x > w) continue;

    const isSelected = selectedNoteIds.has(note.id);
    const isActive = note.id === activeNoteId; // 鼠标按住此 note
    const isPitchMode = currentParamMode === 'Pitch';
    const isInactive = inactiveNoteIds.has(note.id);
    // 音高范围外 note 用灰色（参考重叠 note 的视觉提示）。
    // 注意：oob note 仍参与合成（JP 会自动移调，base 可能影响质量），只是视觉上标注警告。
    const isOob = oobNoteIds.has(note.id);
    const isWarned = isInactive || isOob;

    // 鼠标按住反馈：轻微放大 + 发光阴影，让用户清楚知道"按下了哪个分片音符"。
    // 使用 save/translate/scale 包裹整条 note 绘制，确保 fill+stroke+text+handle
    // 一起缩放，视觉一致。
    if (isActive) {
      ctx.save();
      ctx.shadowColor = c.accent;
      ctx.shadowBlur = 12;
      const cx = x + nw / 2;
      const cy = y + nh / 2;
      ctx.translate(cx, cy);
      ctx.scale(1.04, 1.04);
      ctx.translate(-cx, -cy);
    }

    ctx.fillStyle = isWarned ? c.fgDisabled : c.accent;
    ctx.globalAlpha = isSelected ? 1.0 : (isPitchMode ? 0.4 : (isActive ? 0.95 : 0.8));
    ctx.fillRect(x, y, nw, nh);
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = isSelected ? c.noteSelectedBg : (isActive ? c.accent : c.noteBorder);
    ctx.lineWidth = isSelected ? 2 : (isActive ? 2 : 1);
    ctx.strokeRect(x, y, nw, nh);

    if (nw > 16) {
      ctx.fillStyle = c.noteText;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText((note.isContinuation || note.isSlur || note.noteType === 3) ? '-' : (note.lyric || ''), x + 3, y + nh / 2);
    }

    ctx.fillStyle = c.selectionBg;
    ctx.fillRect(x + nw - 3, y + 2, 2, nh - 4);

    // 警告 note 右上角标注感叹号（重叠未激活 / 音高超范围）
    if (isWarned) {
      ctx.fillStyle = c.warning;
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('!', x + nw - 4, y + 1);
    }

    // 颤音 / 渐入渐出视觉指示（在 note 本体之上叠加，便于一眼看出哪些 note 启用了效果）
    _drawNoteEffectIndicators(ctx, c, note, x, y, nw, nh);

    if (isActive) {
      ctx.restore();
    }
  }

  // 鼠标悬停在警告 note 上时显示提示（重叠未激活 / 音高超范围）
  const hoveredId = getHoveredNoteId();
  if (hoveredId !== null && (inactiveNoteIds.has(hoveredId) || oobNoteIds.has(hoveredId))) {
    const hoveredNote = notes.find(n => n.id === hoveredId);
    if (hoveredNote) {
      const hx = timeToX(hoveredNote.start);
      const hy = pitchToY(hoveredNote.pitch);
      const _hw = hoveredNote.duration * BEAT_WIDTH * getZoomX();
      let tipText;
      if (inactiveNoteIds.has(hoveredId)) {
        tipText = '此 MIDI 与另一同时刻 MIDI 重叠，未被激活';
      } else {
        // 音高超范围：给出具体音名、模型语言和训练范围
        const pitchName = _pitchToName(hoveredNote.pitch);
        const rangeLow = _pitchToName(pitchRange.min);
        const rangeHigh = _pitchToName(pitchRange.max);
        // JP 模型会无条件自动移调（_clampJpPitchRange）；base 模型仅在 autoShift
        // 路径下通过 _clampAutoShift 调整，手动 pitchShift 不保证，措辞需区分。
        if (pitchRange === PITCH_RANGES.ja) {
          tipText = `此 MIDI (${pitchName}) 超出${pitchRange.label}训练音高范围 [${rangeLow}, ${rangeHigh}]，合成时将自动移调`;
        } else {
          tipText = `此 MIDI (${pitchName}) 超出${pitchRange.label}有效音高范围 [${rangeLow}, ${rangeHigh}]，可能影响合成质量`;
        }
      }
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const tipW = ctx.measureText(tipText).width + 10;
      const tipH = 20;
      let tipX = hx;
      let tipY = hy + NOTE_HEIGHT + 4;
      // 边界保护：超出画布右侧时左移
      if (tipX + tipW > w) tipX = w - tipW;
      if (tipY + tipH > canvas.height) tipY = hy - tipH - 4;
      ctx.fillStyle = c.bgOverlay;
      ctx.fillRect(tipX, tipY, tipW, tipH);
      ctx.strokeStyle = c.borderDefault;
      ctx.lineWidth = 1;
      ctx.strokeRect(tipX, tipY, tipW, tipH);
      ctx.fillStyle = c.warning;
      ctx.fillText(tipText, tipX + 5, tipY + 4);
    }
  }

  // Draw kanji group brackets and labels above kana notes
  _drawKanjiGroups(ctx, c);

  if (currentParamMode === 'Pitch') {
    renderPitchCurve(c);
  }

  // 绘制分片边界线
  if (currentFragment && currentFragment.duration) {
    const boundaryX = timeToX(currentFragment.duration);
    if (boundaryX >= 0 && boundaryX <= w) {
      ctx.save();
      ctx.strokeStyle = c.playhead;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(boundaryX, HEADER_HEIGHT);
      ctx.lineTo(boundaryX, pianoAreaBottom);
      ctx.stroke();
      ctx.restore();

      // 在边界线上方标注
      ctx.save();
      ctx.fillStyle = c.playhead;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('END', boundaryX, HEADER_HEIGHT - 2);
      ctx.restore();
    }
  }

  if (getIsBoxSelecting()) {
    const boxSelectStart = getBoxSelectStart();
    const boxSelectEnd = getBoxSelectEnd();
    const x1 = Math.min(boxSelectStart.x, boxSelectEnd.x);
    const y1 = Math.min(boxSelectStart.y, boxSelectEnd.y);
    const x2 = Math.max(boxSelectStart.x, boxSelectEnd.x);
    const y2 = Math.max(boxSelectStart.y, boxSelectEnd.y);
    ctx.fillStyle = c.accentSoft;
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.strokeStyle = c.accentLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.setLineDash([]);
  }

  if (showParamArea) {
    const areaTop = _getParamCurveAreaTop();
    const areaBottom = _getParamCurveAreaBottom();
    ctx.fillStyle = c.bgInput;
    ctx.fillRect(0, areaTop, w, PARAM_CURVE_HEIGHT);

    ctx.strokeStyle = c.borderStrong;
    ctx.beginPath();
    ctx.moveTo(0, areaTop);
    ctx.lineTo(w, areaTop);
    ctx.stroke();

    const panelMode = getParamPanelMode();
    if (panelMode === 'Phoneme') {
      renderPhonemeEditor(ctx, w, h, areaTop, areaBottom, c);
    } else {
      const { min, max } = _getParamCurveYRange();
      ctx.fillStyle = c.fgDisabled;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(max.toFixed(0), 4, areaTop + 12);
      ctx.fillText(min.toFixed(0), 4, areaBottom - 4);
      ctx.textAlign = 'right';
      ctx.fillText(panelMode, w - 4, areaTop + 12);

      const envelopes = getEnvelopes();
      const envKey = panelMode === 'VOL' ? 'volume' : 'pan';
      const envelope = envelopes[envKey];
      if (envelope && envelope.keyframes && envelope.keyframes.length > 0) {
        const startBeat = xToTime(0);
        const endBeat = xToTime(w);
        const maxTime = Math.max(endBeat, ...envelope.keyframes.map(k => k.time)) + 2;
        const steps = Math.max(300, Math.floor((maxTime - startBeat) / 0.02));

        const lineColors = { VOL: c.paramVol, PAN: c.paramPan };
        ctx.strokeStyle = lineColors[panelMode] || c.paramVol;
        ctx.lineWidth = 2;
        ctx.beginPath();

        for (let i = 0; i <= steps; i++) {
          const t = startBeat + (i / steps) * (maxTime - startBeat);
          const value = _interpolateEnvelope(envelope, t);
          const px = timeToX(t);
          const py = _valueToParamY(value);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();

        for (const kf of envelope.keyframes) {
          const px = timeToX(kf.time);
          const py = _valueToParamY(kf.value);
          ctx.fillStyle = lineColors[panelMode] || c.paramVol;
          ctx.beginPath();
          ctx.arc(px, py, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  renderPianoKeys(c);
  drawPlayhead(ctx, w, h, c);
  updateInlineInputPosition();
}

function drawPlayhead(ctxToUse, w, h, c) {
  // 播放中：显示当前播放位置
  // 未播放：显示用户拖拽设置的起始位置（如果有）
  const isPlaying = getFragmentIsPlaying();
  const currentTime = getFragmentCurrentTime();
  const playStartPosition = getFragmentPlayStartPosition();

  if (!isPlaying && currentTime <= 0 && playStartPosition <= 0) return;

  const currentProject = getCurrentProject();
  const bpm = currentProject ? currentProject.bpm : 120;
  // 未播放时显示 playStartPosition，播放中显示 currentTime
  const timeToShow = isPlaying ? currentTime : playStartPosition;
  const beat = (timeToShow / 60) * bpm;
  const x = timeToX(beat);

  if (x < 0 || x > w) return;

  // 未播放时用半透明虚线区分
  ctxToUse.save();
  if (!isPlaying) {
    ctxToUse.globalAlpha = 0.6;
    ctxToUse.setLineDash([4, 3]);
  }

  ctxToUse.strokeStyle = c.playhead;
  ctxToUse.lineWidth = 2;
  ctxToUse.beginPath();
  ctxToUse.moveTo(x, HEADER_HEIGHT);
  ctxToUse.lineTo(x, h);
  ctxToUse.stroke();

  ctxToUse.fillStyle = c.playhead;
  ctxToUse.beginPath();
  ctxToUse.moveTo(x, HEADER_HEIGHT);
  ctxToUse.lineTo(x - 6, HEADER_HEIGHT - 6);
  ctxToUse.lineTo(x + 6, HEADER_HEIGHT - 6);
  ctxToUse.closePath();
  ctxToUse.fill();
  ctxToUse.restore();
}

function updateInlineInputPosition() {
  const activeInlineInput = getActiveInlineInput();
  const activeInlineEditNote = getActiveInlineEditNote();
  if (!activeInlineInput || !activeInlineEditNote) return;

  const note = activeInlineEditNote;
  const container = canvas.parentElement;
  const containerRect = container.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();

  const offsetX = canvasRect.left - containerRect.left;
  const offsetY = canvasRect.top - containerRect.top;

  const nx = timeToX(note.start);
  const ny = pitchToY(note.pitch);
  const nw = note.duration * BEAT_WIDTH * getZoomX();
  const nh = NOTE_HEIGHT;

  const visible = nx + nw >= 0 && nx <= container.clientWidth &&
                  ny + nh >= HEADER_HEIGHT && ny <= container.clientHeight;

  if (visible) {
    activeInlineInput.style.display = '';
    activeInlineInput.style.left = (offsetX + nx + 2) + 'px';
    activeInlineInput.style.top = (offsetY + ny) + 'px';
    activeInlineInput.style.width = Math.max(40, nw - 4) + 'px';
    activeInlineInput.style.height = nh + 'px';
  } else {
    activeInlineInput.style.display = 'none';
  }
}

// Re-render when theme changes
if (typeof window !== 'undefined') {
  window.addEventListener('theme:changed', () => {
    invalidateCanvasThemeCache();
    _staticCacheDirty = true;
    render();
  });
}
