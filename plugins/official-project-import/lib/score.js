'use strict';
/**
 * 把各格式解析出的"中间谱面"落成宿主的工程文档。
 *
 * 三个格式（vsqx / vpr / svp）的差异只在"怎么读"，读出来之后的映射完全一致，
 * 所以这里承担了导入链路里最大的一块复用：拍号/速度、轨道→歌手、分片、
 * 音符清洗、音高曲线采样。各格式的 reader 只需要产出：
 *
 *   { bpm, timeSignature: {numerator, denominator}, tracks: [{
 *       name, color,
 *       parts: [{
 *         name, startBeat, durationBeat,
 *         notes: [{ startBeat, durationBeat, pitch, lyric }],
 *         pitchOffsets: [{ beat, semitones }],   // 绝对拍位置，可为空
 *       }],
 *   }], warnings: [] }
 *
 * 所有时间在 reader 里就已经换算成"拍"（quarter note）。
 */

const TIME_EPSILON = 1e-6;
const MAX_ANCHORS = 2000;
const MIN_ANCHOR_STEP = 1 / 16;
const MAX_PITCH = 127;

function roundTime(v) {
  return Math.round(v * 480) / 480;
}

function roundPitch(v) {
  return Math.round(v * 1000) / 1000;
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** 0xAARRGGBB / "0xFF7C9CFF" / "#7c9cff" → "#7c9cff"；无法识别时返回 undefined。 */
function normalizeColor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    const m = /^(?:0x|#)?([0-9a-fA-F]{6,8})$/.exec(text);
    if (m) return `#${m[1].slice(-6).toLowerCase()}`;
  }
  return undefined;
}

function safeLyric(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, 24);
}

/**
 * 音符清洗：排序、裁掉与后一个音符重叠的尾巴（宿主编辑器假定音符不重叠）、
 * 丢掉非法/零长度音符，并分配片段内唯一 id。
 */
function normalizeNotes(rawNotes, partStartBeat) {
  const list = [];
  for (const raw of Array.isArray(rawNotes) ? rawNotes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const pitch = Number(raw.pitch);
    const start = Number(raw.startBeat) - partStartBeat;
    const duration = Number(raw.durationBeat);
    if (!Number.isFinite(pitch) || pitch < 0 || pitch > MAX_PITCH) continue;
    if (!Number.isFinite(start) || start < -TIME_EPSILON) continue;
    if (!Number.isFinite(duration) || duration <= TIME_EPSILON) continue;
    list.push({
      start: Math.max(0, start),
      duration,
      pitch: Math.round(pitch),
      lyric: safeLyric(raw.lyric, 'la'),
    });
  }
  list.sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const note = list[i];
    const next = list[i + 1];
    let duration = note.duration;
    if (next) duration = Math.min(duration, next.start - note.start);
    if (duration <= TIME_EPSILON) continue;
    out.push({
      id: out.length + 1,
      pitch: note.pitch,
      start: roundTime(note.start),
      duration: roundTime(duration),
      lyric: note.lyric,
    });
  }
  return out;
}

/** 音符起点为阶跃函数的"基础音高"查询器（调用方按时间递增访问）。 */
function makeBasePitchLookup(notes) {
  let index = 0;
  return (relativeBeat) => {
    if (!notes.length) return null;
    while (index + 1 < notes.length && notes[index + 1].start <= relativeBeat + TIME_EPSILON) index++;
    const current = notes[index];
    if (relativeBeat < current.start && index === 0) return current.pitch;
    return current.pitch;
  };
}

/** 线性插值；超出两端时取端点值。points 需按 beat 升序。 */
function interpolateOffset(points, beat) {
  if (!points.length) return 0;
  if (beat <= points[0].beat) return points[0].semitones;
  if (beat >= points[points.length - 1].beat) return points[points.length - 1].semitones;
  let low = 0;
  let high = points.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (points[mid].beat <= beat) low = mid;
    else high = mid;
  }
  const a = points[low];
  const b = points[high];
  const span = b.beat - a.beat;
  if (span <= TIME_EPSILON) return b.semitones;
  const ratio = (beat - a.beat) / span;
  return a.semitones + (b.semitones - a.semitones) * ratio;
}

/**
 * 采样成宿主可编辑的音高锚点（片段内相对时间 + 绝对 MIDI 音高）。
 *
 * 没有音高偏移数据时返回 null：让宿主用自己的自动音高曲线，比给一条
 * 完全平直的假曲线更接近源工程的听感。
 */
function buildAnchors(part, notes, fragmentStart, fragmentDuration) {
  const offsets = Array.isArray(part.pitchOffsets) ? part.pitchOffsets : [];
  if (!offsets.length || !notes.length) return null;

  const step = Math.max(MIN_ANCHOR_STEP, fragmentDuration / MAX_ANCHORS);
  const basePitchAt = makeBasePitchLookup(notes);
  const anchors = [];
  for (let t = 0; t <= fragmentDuration + TIME_EPSILON; t += step) {
    const base = basePitchAt(t);
    if (base === null) continue;
    const pitch = base + interpolateOffset(offsets, fragmentStart + t);
    anchors.push({ time: roundTime(t), pitch: roundPitch(pitch) });
  }
  if (anchors.length && anchors[anchors.length - 1].time < fragmentDuration - TIME_EPSILON) {
    const base = basePitchAt(fragmentDuration);
    if (base !== null) {
      anchors.push({
        time: roundTime(fragmentDuration),
        pitch: roundPitch(base + interpolateOffset(offsets, fragmentStart + fragmentDuration)),
      });
    }
  }
  return anchors.length >= 2 ? anchors : null;
}

/**
 * @param {object} score 见文件头
 * @returns {object} 宿主工程文档
 */
function buildDocument(score) {
  const singers = [];
  const fragments = [];
  let fragmentSeq = 0;

  for (const track of score.tracks) {
    const parts = (track.parts || []).filter((part) => Array.isArray(part.notes) && part.notes.length);
    if (!parts.length) continue;

    const trackIndex = singers.length;
    const trackName = String(track.name || `Track ${trackIndex + 1}`).slice(0, 60);
    const singerId = `import-track-${trackIndex + 1}`;
    singers.push({
      id: singerId,
      type: 'singer',
      trackName,
      singerName: trackName,
      ...(track.color ? { color: track.color } : {}),
    });

    for (const part of parts) {
      const start = Math.max(0, roundTime(Number(part.startBeat) || 0));
      const notes = normalizeNotes(part.notes, Number(part.startBeat) || 0);
      if (!notes.length) continue;

      const lastEnd = notes.reduce((max, n) => Math.max(max, n.start + n.duration), 0);
      const duration = Math.max(roundTime(Number(part.durationBeat) || 0), roundTime(lastEnd), 1);

      fragmentSeq++;
      const fragment = {
        id: `import-fragment-${fragmentSeq}`,
        singerId,
        startTime: start,
        duration,
        name: String(part.name || trackName).slice(0, 60),
        notes,
      };

      const anchors = buildAnchors(part, notes, start, duration);
      if (anchors) {
        fragment.pitchCurve = { enabled: true, anchorPoints: anchors };
        fragment.pitchMode = 'manual';
      }
      fragments.push(fragment);
    }
  }

  const bpm = clamp(Number(score.bpm) || 120, 20, 400);
  const ts = score.timeSignature || {};
  const numerator = clamp(Math.round(Number(ts.numerator) || 4), 1, 32);
  const denominator = clamp(Math.round(Number(ts.denominator) || 4), 2, 32);

  return {
    version: '1.3.0',
    project: { bpm: Math.round(bpm * 100) / 100, timeSignature: [numerator, denominator] },
    singers,
    fragments,
  };
}

module.exports = {
  TICKS_PER_BEAT: 480,
  BLICK_PER_BEAT: 705600000,
  buildDocument,
  normalizeNotes,
  normalizeColor,
  interpolateOffset,
  roundTime,
  clamp,
};
