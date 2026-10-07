import { SAMPLE_RATE, SVS_HOP_SIZE } from './constants.js';

// 复用分片编辑器 buildPitchCurveF0Data + getPitchAtTime + generateAutoPitchPoints 的逻辑，
// 但接受 fragment 参数（不依赖分片编辑器全局 state）。
// 主页面逐 fragment 合成时调用，确保与分片编辑器播放的 f0 轨迹完全一致。
export function buildFragmentPitchCurveF0(fragment, clippedNotes, bpm) {
  if (!fragment || !fragment.pitchCurve || !fragment.pitchCurve.enabled) return null;
  const pc = fragment.pitchCurve;
  const hasCustom = pc.anchorPoints.length > 0 || pc.brushSegments.length > 0;
  if (!clippedNotes || clippedNotes.length === 0) return null;
  const sortedNotes = clippedNotes.slice().sort((a, b) => a.start - b.start || b.duration - a.duration);
  const hasVibrato = sortedNotes.some(n => n.vibrato && n.vibrato.enabled);
  if (!hasCustom && !hasVibrato) return null;

  const fragDuration = fragment.duration || Infinity;
  const lastNote = sortedNotes[sortedNotes.length - 1];
  const totalBeats = Math.min(lastNote.start + lastNote.duration, fragDuration);
  const totalSeconds = (totalBeats / bpm) * 60;
  const totalFrames = Math.floor(totalSeconds * SAMPLE_RATE / SVS_HOP_SIZE);

  // 预排序 anchor points（与分片编辑器 getSortedAnchorPoints 一致）
  const sortedAnchors = [...pc.anchorPoints].sort((a, b) => a.time - b.time);

  // 预生成 autoPoints（与分片编辑器 generateAutoPitchPoints 一致），基于 clippedNotes
  // 起始点和末端都标记 breakAfter: true，note 内部不做线性插值，避免强制拟合 Midi 音高平线。
  const autoPoints = [];
  for (const note of sortedNotes) {
    autoPoints.push({ time: note.start, pitch: note.pitch, breakAfter: true });
    autoPoints.push({ time: note.start + note.duration, pitch: note.pitch, breakAfter: true });
  }

  // 上述 autoPoints 全部标记 breakAfter，而 _getPitchAtTimeForFragment 的 autoPoints
  // 分支在 breakAfter 时直接 continue，永不 return ⇒ 该分支恒返回 null。
  // 预先判定一次，避免每帧空跑 O(P) 次迭代。
  // 等价性：只有下标 i < len-1 且 !breakAfter 的点才可能 return 非 null，
  // 线性版本在所有点都 breakAfter 时同样恒返回 null，故短路不改变任何返回值。
  const autoPointsUsable = autoPoints.some((p, i) => i < autoPoints.length - 1 && !p.breakAfter);

  const f0Array = new Float32Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    const frameTimeSec = (i * SVS_HOP_SIZE) / SAMPLE_RATE;
    const frameBeat = (frameTimeSec / 60) * bpm;
    const note = _findNoteAtBeat(sortedNotes, frameBeat);
    if (!note) {
      f0Array[i] = 0;
      continue;
    }
    let pitch = _getPitchAtTimeForFragment(pc, sortedAnchors, autoPoints, frameBeat, autoPointsUsable);
    if (note.vibrato && note.vibrato.enabled) {
      if (pitch === null) pitch = note.pitch;
      pitch += _computeVibratoOffset(note, frameBeat, bpm);
    }
    if (pitch !== null && pitch > 0) {
      f0Array[i] = 440 * Math.pow(2, (pitch - 69) / 12);
    } else {
      f0Array[i] = 0;
    }
  }
  return f0Array;
}

/**
 * 在按 time 升序排列的点数组中，二分查找包含 time 的区间左端索引。
 * 语义等价于线性 `for (i) if (time >= pts[i].time && time <= pts[i + 1].time) return i`：
 * 返回第一个满足该条件的 i；长度 < 2 或 time 落在 [pts[0].time, pts[last].time] 之外时返回 -1。
 * 等价性关键：取「首个 pts[j].time >= time」的 j 再减 1。对 i < j - 1 必有
 * pts[i + 1].time <= pts[j - 1].time < time，故 [j-1, j] 正是线性扫描命中的第一个区间；
 * 重复 time 时也一致（[0,1,1,2] 查 1：线性取 i=0，此处 j=1 返回 0）。
 * 若改用常见的 lower-bound（最后一个 <= time）写法，重复 time 时结果会不同。
 * 与 fragmentEditor/canvasRenderer.js 的 _bisectSegmentIndex 同构（此处刻意复制而非
 * 跨模块 import，避免渲染层模块被拉进 f0 计算路径）。
 *
 * NaN 等价性：NaN（以及 ±Infinity）参与任何 <、>、>= 比较结果都是 false，于是
 *   · 线性扫描：所有区间条件都不成立，循环走完自然返回 -1（不抛错）；
 *   · 二分（不早退时）：范围检查同样失效，j 保持初值 n，最终返回 n - 1，
 *     调用方再去取 pts[n] 就会 TypeError。
 * 因此这里对非有限 time 显式返回 -1，并在循环后兜住 j === n（pts 里混入 NaN
 * time 的唯一场景），保证新旧实现在 NaN 下都不抛错且返回同一个值。
 */
function _bisectSegmentIndex(pts, time) {
  const n = pts.length;
  if (n < 2) return -1;
  if (!Number.isFinite(time)) return -1;
  if (time < pts[0].time || time > pts[n - 1].time) return -1;
  let lo = 0;
  let hi = n - 1;
  let j = n;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].time >= time) { j = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  // j === n 只在 pts 内含 NaN time 时出现（所有 >= 比较都为 false），与线性
  // 扫描一致返回 -1，避免调用方访问 pts[n] 越界。
  if (j === n) return -1;
  const i = j === 0 ? 0 : j - 1;
  // 用线性扫描的同一个条件复检命中区间：pts 里混入 NaN time 时，二分仍能算出
  // 一个下标（比较结果全为 false），但线性扫描不会命中任何区间。复检失败就
  // 返回 -1，保证两者一致且调用方不会越界。
  if (!(time >= pts[i].time && time <= pts[i + 1].time)) return -1;
  return i;
}

function _findNoteAtBeat(notes, beat) {
  let lo = 0;
  let hi = notes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const note = notes[mid];
    if (beat < note.start) hi = mid - 1;
    else if (beat >= note.start + note.duration) lo = mid + 1;
    else return note;
  }
  return null;
}

function _computeVibratoOffset(note, beat, bpm) {
  const v = note.vibrato;
  if (!v || !v.enabled || note.duration <= 0) return 0;
  const start = note.start + v.start * note.duration;
  const length = v.length * note.duration;
  if (length <= 0 || beat < start || beat > start + length) return 0;
  const pos = (beat - start) / length;
  const env = v.fadeIn > 0 && pos < v.fadeIn ? pos / v.fadeIn : 1;
  const seconds = ((beat - start) / bpm) * 60;
  return (v.depth / 100) * Math.sin(2 * Math.PI * v.rate * seconds) * env;
}

// 等价于分片编辑器 getPitchAtTime，但不依赖全局 state
function _getPitchAtTimeForFragment(pc, sortedAnchors, autoPoints, time, autoPointsUsable) {
  if (!pc.enabled) return null;

  if (sortedAnchors.length > 0) {
    if (time < sortedAnchors[0].time || time > sortedAnchors[sortedAnchors.length - 1].time) {
      // outside anchor range, fall through to brush/auto
    } else {
      // 等价性：sortedAnchors 已按 time 升序（buildFragmentPitchCurveF0:22 显式 sort），
      // _bisectSegmentIndex 与上面的线性扫描在区间内返回同一个 i（见其注释），
      // 故 t / smoothness / 插值公式的输入逐位相同；未命中/长度不足时同样落到
      // 下面的 return last.pitch（n===1 时线性循环不执行，二分返回 -1，行为一致）。
      const i = _bisectSegmentIndex(sortedAnchors, time);
      if (i >= 0) {
        const t = (sortedAnchors[i + 1].time - sortedAnchors[i].time) > 0
          ? (time - sortedAnchors[i].time) / (sortedAnchors[i + 1].time - sortedAnchors[i].time)
          : 0;
        const smoothness = (sortedAnchors[i].smoothness || 0) / 100;
        const smoothStepT = t * t * (3 - 2 * t);
        const smoothT = t + (smoothStepT - t) * smoothness;
        return sortedAnchors[i].pitch + smoothT * (sortedAnchors[i + 1].pitch - sortedAnchors[i].pitch);
      }
      return sortedAnchors[sortedAnchors.length - 1].pitch;
    }
  }

  for (const seg of pc.brushSegments) {
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

  if (!autoPointsUsable) return null;
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

export function convertF0DataToPitchCurve(f0Data, totalSeconds) {
  if (!f0Data || f0Data.length === 0) return null;
  const totalFrames = Math.floor(totalSeconds * SAMPLE_RATE / SVS_HOP_SIZE);
  const f0Arr = new Float32Array(totalFrames);
  const frameDuration = SVS_HOP_SIZE / SAMPLE_RATE;
  for (let i = 0; i < totalFrames; i++) {
    const frameTime = i * frameDuration;
    let lo = 0;
    let hi = f0Data.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (f0Data[mid].time <= frameTime) lo = mid;
      else hi = mid;
    }
    const f0Lo = f0Data[lo];
    const f0Hi = f0Data[hi];
    if (f0Lo && f0Hi && f0Lo.f0 > 0 && f0Hi.f0 > 0 && hi !== lo) {
      const t = (frameTime - f0Lo.time) / (f0Hi.time - f0Lo.time);
      f0Arr[i] = f0Lo.f0 + t * (f0Hi.f0 - f0Lo.f0);
    } else if (f0Lo && f0Lo.f0 > 0) {
      f0Arr[i] = f0Lo.f0;
    } else {
      f0Arr[i] = 0;
    }
  }
  return f0Arr;
}

export function computePitchCurveF0(singerFragments, allNotes, bpm) {
  const pitchCurveFrags = singerFragments.filter(f => f.pitchCurve && f.pitchCurve.enabled &&
    (f.pitchCurve.anchorPoints.length > 0 || f.pitchCurve.brushSegments.length > 0));

  if (pitchCurveFrags.length === 0) return null;
  if (allNotes.length === 0) return null;

  const lastNote = allNotes[allNotes.length - 1];
  const totalBeatsAll = lastNote.start + lastNote.duration;
  const totalSecondsAll = (totalBeatsAll / bpm) * 60;
  const totalFrames = Math.floor(totalSecondsAll * SAMPLE_RATE / SVS_HOP_SIZE);
  const f0Arr = new Float32Array(totalFrames);

  const sortedAnchorsCache = new Map();
  for (const frag of pitchCurveFrags) {
    const pc = frag.pitchCurve;
    if (pc.anchorPoints.length > 0 && !sortedAnchorsCache.has(frag.id)) {
      sortedAnchorsCache.set(frag.id, [...pc.anchorPoints].sort((a, b) => a.time - b.time));
    }
  }

  // Pre-compute fragment frame ranges
  const fragFrameRanges = [];
  for (const frag of pitchCurveFrags) {
    const fragStartBeat = frag.startTime || 0;
    const fragEndBeat = fragStartBeat + (frag.duration || 0);
    const fragStartSec = (fragStartBeat / bpm) * 60;
    const fragEndSec = (fragEndBeat / bpm) * 60;
    const startFrame = Math.floor(fragStartSec * SAMPLE_RATE / SVS_HOP_SIZE);
    const endFrame = frag.duration ? Math.floor(fragEndSec * SAMPLE_RATE / SVS_HOP_SIZE) : totalFrames;
    fragFrameRanges.push({ frag, startFrame, endFrame });
  }

  // Pre-sort notes by start beat for binary search
  const sortedNotes = allNotes.slice().sort((a, b) => a.start - b.start);

  for (let i = 0; i < totalFrames; i++) {
    const frameTimeSec = (i * SVS_HOP_SIZE) / SAMPLE_RATE;
    const frameBeat = (frameTimeSec / 60) * bpm;
    let pitch = null;

    for (const { frag, startFrame, endFrame } of fragFrameRanges) {
      if (i < startFrame || i >= endFrame) continue;

      const pc = frag.pitchCurve;
      const fragStartBeat = frag.startTime || 0;
      const localBeat = frameBeat - fragStartBeat;

      if (pitch === null && pc.anchorPoints.length > 0) {
        const sorted = sortedAnchorsCache.get(frag.id);
        if (localBeat < sorted[0].time || localBeat > sorted[sorted.length - 1].time) {
          // outside anchor range, skip
        } else {
          // Binary search for anchor point segment
          let lo = 0, hi = sorted.length - 1;
          while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid].time <= localBeat) lo = mid;
            else hi = mid;
          }
          if (localBeat >= sorted[lo].time && localBeat <= sorted[hi].time) {
            const t = (sorted[hi].time - sorted[lo].time) > 0
              ? (localBeat - sorted[lo].time) / (sorted[hi].time - sorted[lo].time) : 0;
            const sm = (sorted[lo].smoothness || 0) / 100;
            const smoothStepT = t * t * (3 - 2 * t);
            const st = t + (smoothStepT - t) * sm;
            pitch = sorted[lo].pitch + st * (sorted[hi].pitch - sorted[lo].pitch);
          }
        }
      }

      if (pitch === null) {
        for (const seg of pc.brushSegments) {
          if (seg.points.length >= 2 && localBeat >= seg.points[0].time && localBeat <= seg.points[seg.points.length - 1].time) {
            for (let j = 0; j < seg.points.length - 1; j++) {
              if (localBeat >= seg.points[j].time && localBeat <= seg.points[j + 1].time) {
                const t = (seg.points[j + 1].time - seg.points[j].time) > 0
                  ? (localBeat - seg.points[j].time) / (seg.points[j + 1].time - seg.points[j].time) : 0;
                pitch = seg.points[j].pitch + t * (seg.points[j + 1].pitch - seg.points[j].pitch);
                break;
              }
            }
            break;
          }
        }
      }

      if (pitch !== null) break;
    }

    if (pitch === null) {
      // Binary search in sorted notes
      let lo = 0, hi = sortedNotes.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const note = sortedNotes[mid];
        if (frameBeat >= note.start && frameBeat < note.start + note.duration) {
          pitch = note.pitch;
          break;
        }
        if (note.start + note.duration <= frameBeat) {
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
    }

    if (pitch !== null && pitch > 0) {
      f0Arr[i] = 440 * Math.pow(2, (pitch - 69) / 12);
    } else {
      f0Arr[i] = 0;
    }
  }
  return Array.from(f0Arr);
}

export function f0DataToPitchCurveAnchorPoints(f0Data, bpm) {
  if (!f0Data || f0Data.length === 0) return [];

  const beatDuration = 60 / bpm;
  const anchorInterval = 0.08;
  const anchorPoints = [];

  let currentBeat = -1;
  let pitchSum = 0;
  let pitchCount = 0;

  for (const frame of f0Data) {
    if (!frame.f0 || frame.f0 <= 0) continue;

    const pitch = 69 + 12 * Math.log2(frame.f0 / 440);
    if (pitch < 24 || pitch > 108) continue;

    const beat = frame.time / beatDuration;
    const anchorBeat = Math.floor(beat / anchorInterval) * anchorInterval;

    if (anchorBeat !== currentBeat) {
      if (currentBeat >= 0 && pitchCount > 0) {
        anchorPoints.push({
          time: currentBeat,
          pitch: pitchSum / pitchCount,
          smoothness: 30,
        });
      }
      currentBeat = anchorBeat;
      pitchSum = pitch;
      pitchCount = 1;
    } else {
      pitchSum += pitch;
      pitchCount += 1;
    }
  }

  if (currentBeat >= 0 && pitchCount > 0) {
    anchorPoints.push({
      time: currentBeat,
      pitch: pitchSum / pitchCount,
      smoothness: 30,
    });
  }

  return anchorPoints;
}
