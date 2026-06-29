import { getCanvasColors, invalidateCanvasThemeCache } from '../themes/canvasTheme.js';
import {
  PIANO_KEY_WIDTH, NOTE_HEIGHT, BEAT_WIDTH, HEADER_HEIGHT, PARAM_CURVE_HEIGHT,
  BLACK_KEYS, PITCH_CURVE_SAMPLE_INTERVAL,
  PHONEME_COLORS,
} from './constants.js';
import {
  getScrollX, getScrollY, getZoomX,
  getCurrentParamMode,
  getNotes,
  getSelectedNoteIds,
  getSelectedAnchorIndices,
  getPitchCurve,
  getPitchDragAnchorIdx,
  getCurrentBrushStroke,
  getIsBoxSelecting,
  getBoxSelectStart, getBoxSelectEnd,
  getFragmentIsPlaying,
  getFragmentCurrentTime,
  getCurrentProject,
  getSelectedPhonemeNoteId,
  getSelectedPhonemeIndex,
  getPhonemeDragState,
  getHoveredNoteId,
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

export function timeToX(beats) {
  return beats * BEAT_WIDTH * getZoomX() - getScrollX();
}

export function xToTime(x) {
  return (x + getScrollX()) / (BEAT_WIDTH * getZoomX());
}

export function pitchToY(pitch) {
  const pianoAreaTop = HEADER_HEIGHT;
  const showParamArea = isParamAreaVisible();
  const pianoAreaBottom = canvas.parentElement.clientHeight - (showParamArea ? PARAM_CURVE_HEIGHT : 0);
  const maxPitch = 127;
  return pianoAreaTop + (maxPitch - pitch) * NOTE_HEIGHT - getScrollY();
}

export function yToPitch(y) {
  const pianoAreaTop = HEADER_HEIGHT;
  const showParamArea = isParamAreaVisible();
  const pianoAreaBottom = canvas.parentElement.clientHeight - (showParamArea ? PARAM_CURVE_HEIGHT : 0);
  if (y >= pianoAreaBottom) return 0;
  if (y <= pianoAreaTop) return 127;
  const maxPitch = 127;
  return Math.round(maxPitch - (y + getScrollY() - pianoAreaTop) / NOTE_HEIGHT);
}

export function yToPitchContinuous(y) {
  const pianoAreaTop = HEADER_HEIGHT;
  const showParamArea = isParamAreaVisible();
  const pianoAreaBottom = canvas.parentElement.clientHeight - (showParamArea ? PARAM_CURVE_HEIGHT : 0);
  if (y >= pianoAreaBottom) return 0;
  if (y <= pianoAreaTop) return 127;
  const maxPitch = 127;
  return maxPitch - (y + getScrollY() - pianoAreaTop) / NOTE_HEIGHT;
}

export function snapBeats(beats) {
  const grid = 1 / 4;
  return Math.round(beats / grid) * grid;
}

export function findNoteAt(x, y) {
  const notes = getNotes();
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i];
    const rx = Math.round(timeToX(note.start));
    const ry = Math.round(pitchToY(note.pitch));
    const rw = Math.round(note.duration * BEAT_WIDTH * getZoomX());
    const rh = Math.round(NOTE_HEIGHT);
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
      return { note, nx: rx, ny: ry, nw: rw, nh: rh };
    }
  }
  return null;
}

export function _getParamCurveAreaTop() {
  return canvas.parentElement.clientHeight - PARAM_CURVE_HEIGHT;
}

export function _getParamCurveAreaBottom() {
  return canvas.parentElement.clientHeight;
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
  const inactiveIds = getInactiveNoteIds(notes);
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
  const notes = getNotes();
  for (const n of notes) {
    if (n.id === excludeId) continue;
    if (n.pitch !== pitch) continue;
    const nEnd = n.start + n.duration;
    if (start < nEnd && end > n.start) return true;
  }
  return false;
}

/**
 * 计算未激活（被遮挡）的 note id 集合。
 * 规则：同一时间点只能有一个 note 被激活，按数组顺序（先后顺序）决定激活的 note。
 * 后面的 note 如果与前面任意已激活 note 时间重叠（跨 pitch），则标记为未激活。
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

export function clampNotePosition(noteId, pitch, start, duration) {
  const notes = getNotes();
  const end = start + duration;
  for (const n of notes) {
    if (n.id === noteId) continue;
    if (n.pitch !== pitch) continue;
    const nEnd = n.start + n.duration;
    if (start < nEnd && end > n.start) {
      if (start >= n.start && start < nEnd) {
        start = nEnd;
      } else if (end > n.start && end <= nEnd) {
        start = n.start - duration;
      }
    }
  }
  return Math.max(0, start);
}

export function generateAutoPitchPoints() {
  const notes = getNotes();
  if (notes.length === 0) return [];
  const sortedNotes = [...notes].sort((a, b) => a.start - b.start);
  const points = [];
  for (let i = 0; i < sortedNotes.length; i++) {
    const note = sortedNotes[i];
    points.push({ time: note.start, pitch: note.pitch });
    points.push({ time: note.start + note.duration, pitch: note.pitch, breakAfter: true });
  }
  return points;
}

export function isPitchCurveCustomized() {
  const pitchCurve = getPitchCurve();
  return pitchCurve.anchorPoints.length > 0 || pitchCurve.brushSegments.length > 0;
}

export function getSortedAnchorPoints() {
  const pitchCurve = getPitchCurve();
  if (getSortedAnchorPointsCacheVersion() !== getPitchCurveVersion()) {
    setSortedAnchorPointsCache([...pitchCurve.anchorPoints].sort((a, b) => a.time - b.time));
    setSortedAnchorPointsCacheVersion(getPitchCurveVersion());
  }
  return getSortedAnchorPointsCache();
}

export function getPitchAtTime(time) {
  const pitchCurve = getPitchCurve();
  if (!pitchCurve.enabled) return null;

  if (pitchCurve.anchorPoints.length > 0) {
    const sorted = getSortedAnchorPoints();
    if (time < sorted[0].time || time > sorted[sorted.length - 1].time) {
      // outside anchor range, fall through to brush/auto
    } else {
      for (let i = 0; i < sorted.length - 1; i++) {
        if (time >= sorted[i].time && time <= sorted[i + 1].time) {
          const t = (sorted[i + 1].time - sorted[i].time) > 0
            ? (time - sorted[i].time) / (sorted[i + 1].time - sorted[i].time)
            : 0;
          const smoothness = (sorted[i].smoothness || 0) / 100;
          const smoothT = smoothness > 0 ? t * t * (3 - 2 * t) : t;
          return sorted[i].pitch + smoothT * (sorted[i + 1].pitch - sorted[i].pitch);
        }
      }
      return sorted[sorted.length - 1].pitch;
    }
  }

  for (const seg of pitchCurve.brushSegments) {
    if (seg.points.length < 2) continue;
    if (time >= seg.points[0].time && time <= seg.points[seg.points.length - 1].time) {
      for (let i = 0; i < seg.points.length - 1; i++) {
        if (time >= seg.points[i].time && time <= seg.points[i + 1].time) {
          const t = (seg.points[i + 1].time - seg.points[i].time) > 0
            ? (time - seg.points[i].time) / (seg.points[i + 1].time - seg.points[i].time)
            : 0;
          return seg.points[i].pitch + t * (seg.points[i + 1].pitch - seg.points[i].pitch);
        }
      }
    }
  }

  const autoPoints = generateAutoPitchPoints();
  if (autoPoints.length === 0) return null;
  for (let i = 0; i < autoPoints.length - 1; i++) {
    if (time >= autoPoints[i].time && time <= autoPoints[i + 1].time) {
      if (autoPoints[i].breakAfter) continue;
      const t = (autoPoints[i + 1].time - autoPoints[i].time) > 0
        ? (time - autoPoints[i].time) / (autoPoints[i + 1].time - autoPoints[i].time)
        : 0;
      return autoPoints[i].pitch + t * (autoPoints[i + 1].pitch - autoPoints[i].pitch);
    }
  }
  return null;
}

export function findAnchorPointAt(x, y) {
  const pitchCurve = getPitchCurve();
  if (pitchCurve.anchorPoints.length === 0) return -1;
  for (let i = 0; i < pitchCurve.anchorPoints.length; i++) {
    const ap = pitchCurve.anchorPoints[i];
    const px = timeToX(ap.time);
    const py = pitchToY(ap.pitch);
    const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
    if (dist <= 8) return i;
  }
  return -1;
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
  if (trimmed === '<SP>' || trimmed === '<AP>') return [{ name: '<SP>', display: 'SP' }];
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
    console.warn('音素解析失败:', err);
  }
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
  const adjustments = phonemes.map((ph, i) => ({
    id: i,
    name: ph.name,
    display: ph.display,
    offsetRatio: 0,
    durationRatio: 1 / phonemes.length,
    volumePoints: [
      { t: 0, v: 0.3 },
      { t: 0.1, v: 1.0 },
      { t: 0.85, v: 1.0 },
      { t: 1.0, v: 0.3 },
    ],
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

  const visibleNotes = notes.filter(note => {
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
  const notes = getNotes();
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
      const px = timeToX(ap.time);
      const py = pitchToY(ap.pitch);
      const isSelected = selectedAnchorIndices.has(i) || i === pitchDragAnchorIdx;

      ctx.fillStyle = isSelected ? c.fgPrimary : c.pitchPoint;
      ctx.beginPath();
      ctx.arc(px, py, isSelected ? 7 : 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = isSelected ? c.accent : c.shadowColor;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.stroke();

      if (isSelected) {
        ctx.strokeStyle = c.accentLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, 12, 0, Math.PI * 2);
        ctx.stroke();
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

let _renderRaf = 0;
export function render() {
  if (_renderRaf) return;
  _renderRaf = requestAnimationFrame(() => { _renderRaf = 0; _doRender(); });
}
function _doRender() {
  const w = canvas.parentElement.clientWidth;
  const h = canvas.parentElement.clientHeight;
  const c = getCanvasColors();
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = c.bgElevated;
  ctx.fillRect(0, 0, w, h);

  const currentProject = getCurrentProject();
  const beatsPerMeasure = currentProject ? currentProject.timeSignature[0] : 4;
  const startBeat = xToTime(0);
  const endBeat = xToTime(w);

  const currentParamMode = getCurrentParamMode();
  const showParamArea = isParamAreaVisible();
  const pianoAreaBottom = showParamArea ? _getParamCurveAreaTop() : h;

  ctx.lineWidth = 0.5;
  for (let b = Math.floor(startBeat); b <= Math.ceil(endBeat); b++) {
    const x = timeToX(b);
    if (x < 0) continue;
    const isMeasure = (b % beatsPerMeasure === 0);
    ctx.strokeStyle = isMeasure ? c.gridLineMeasure : c.gridLineMajor;
    ctx.beginPath();
    ctx.moveTo(x, HEADER_HEIGHT);
    ctx.lineTo(x, pianoAreaBottom);
    ctx.stroke();
    if (isMeasure) {
      ctx.fillStyle = c.timeText;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(Math.floor(b / beatsPerMeasure) + 1), x, HEADER_HEIGHT - 6);
    }
  }

  const startPitch = yToPitch(h);
  const endPitch = yToPitch(HEADER_HEIGHT);
  for (let p = Math.max(0, startPitch); p <= Math.min(127, endPitch); p++) {
    const y = pitchToY(p);
    const isBlack = BLACK_KEYS.has(p % 12);
    ctx.strokeStyle = isBlack ? c.gridLineMajor : c.gridLineMinor;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const notes = getNotes();
  const selectedNoteIds = getSelectedNoteIds();
  const currentFragment = getCurrentFragment();
  const inactiveNoteIds = getInactiveNoteIds(notes);

  for (const note of notes) {
    const x = timeToX(note.start);
    const y = pitchToY(note.pitch);
    const nw = note.duration * BEAT_WIDTH * getZoomX();
    const nh = NOTE_HEIGHT;
    if (x + nw < 0 || x > w) continue;

    const isSelected = selectedNoteIds.has(note.id);
    const isPitchMode = currentParamMode === 'Pitch';
    const isInactive = inactiveNoteIds.has(note.id);
    // 未激活的重叠 note 用灰色，否则用主题色
    ctx.fillStyle = isInactive ? c.fgDisabled : c.accent;
    ctx.globalAlpha = isSelected ? 1.0 : (isPitchMode ? 0.4 : 0.8);
    ctx.fillRect(x, y, nw, nh);
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = isSelected ? c.noteSelectedBg : c.noteBorder;
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.strokeRect(x, y, nw, nh);

    if (nw > 16) {
      ctx.fillStyle = c.noteText;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(note.lyric || '', x + 3, y + nh / 2);
    }

    ctx.fillStyle = c.selectionBg;
    ctx.fillRect(x + nw - 3, y + 2, 2, nh - 4);

    // 未激活 note 右上角标注感叹号
    if (isInactive) {
      ctx.fillStyle = c.warning;
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('!', x + nw - 4, y + 1);
    }
  }

  // 鼠标悬停在未激活 note 上时显示提示
  const hoveredId = getHoveredNoteId();
  if (hoveredId !== null && inactiveNoteIds.has(hoveredId)) {
    const hoveredNote = notes.find(n => n.id === hoveredId);
    if (hoveredNote) {
      const hx = timeToX(hoveredNote.start);
      const hy = pitchToY(hoveredNote.pitch);
      const hw = hoveredNote.duration * BEAT_WIDTH * getZoomX();
      const tipText = '此 MIDI 与另一同时刻 MIDI 重叠，未被激活';
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
  if (!getFragmentIsPlaying() && getFragmentCurrentTime() <= 0) return;

  const currentProject = getCurrentProject();
  const bpm = currentProject ? currentProject.bpm : 120;
  const beat = (getFragmentCurrentTime() / 60) * bpm;
  const x = timeToX(beat);

  if (x < 0 || x > w) return;

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
    render();
  });
}
