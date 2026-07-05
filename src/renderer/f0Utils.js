import { SAMPLE_RATE, SVS_HOP_SIZE } from './constants.js';

// 复用分片编辑器 buildPitchCurveF0Data + getPitchAtTime + generateAutoPitchPoints 的逻辑，
// 但接受 fragment 参数（不依赖分片编辑器全局 state）。
// 主页面逐 fragment 合成时调用，确保与分片编辑器播放的 f0 轨迹完全一致。
export function buildFragmentPitchCurveF0(fragment, clippedNotes, bpm) {
  if (!fragment || !fragment.pitchCurve || !fragment.pitchCurve.enabled) return null;
  const pc = fragment.pitchCurve;
  const hasCustom = pc.anchorPoints.length > 0 || pc.brushSegments.length > 0;
  if (!hasCustom) return null;
  if (!clippedNotes || clippedNotes.length === 0) return null;

  const fragDuration = fragment.duration || Infinity;
  const lastNote = clippedNotes[clippedNotes.length - 1];
  const totalBeats = Math.min(lastNote.start + lastNote.duration, fragDuration);
  const totalSeconds = (totalBeats / bpm) * 60;
  const totalFrames = Math.floor(totalSeconds * SAMPLE_RATE / SVS_HOP_SIZE);

  // 预排序 anchor points（与分片编辑器 getSortedAnchorPoints 一致）
  const sortedAnchors = [...pc.anchorPoints].sort((a, b) => a.time - b.time);

  // 预生成 autoPoints（与分片编辑器 generateAutoPitchPoints 一致），基于 clippedNotes
  // 起始点和末端都标记 breakAfter: true，note 内部不做线性插值，避免强制拟合 Midi 音高平线。
  const autoPoints = [];
  for (const note of clippedNotes) {
    autoPoints.push({ time: note.start, pitch: note.pitch, breakAfter: true });
    autoPoints.push({ time: note.start + note.duration, pitch: note.pitch, breakAfter: true });
  }

  const f0Array = new Float32Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    const frameTimeSec = (i * SVS_HOP_SIZE) / SAMPLE_RATE;
    const frameBeat = (frameTimeSec / 60) * bpm;
    const inNote = clippedNotes.some(n => frameBeat >= n.start && frameBeat < n.start + n.duration);
    if (!inNote) {
      f0Array[i] = 0;
      continue;
    }
    const pitch = _getPitchAtTimeForFragment(pc, sortedAnchors, autoPoints, frameBeat);
    if (pitch !== null && pitch > 0) {
      f0Array[i] = 440 * Math.pow(2, (pitch - 69) / 12);
    } else {
      f0Array[i] = 0;
    }
  }
  return f0Array;
}

// 等价于分片编辑器 getPitchAtTime，但不依赖全局 state
function _getPitchAtTimeForFragment(pc, sortedAnchors, autoPoints, time) {
  if (!pc.enabled) return null;

  if (sortedAnchors.length > 0) {
    if (time < sortedAnchors[0].time || time > sortedAnchors[sortedAnchors.length - 1].time) {
      // outside anchor range, fall through to brush/auto
    } else {
      for (let i = 0; i < sortedAnchors.length - 1; i++) {
        if (time >= sortedAnchors[i].time && time <= sortedAnchors[i + 1].time) {
          const t = (sortedAnchors[i + 1].time - sortedAnchors[i].time) > 0
            ? (time - sortedAnchors[i].time) / (sortedAnchors[i + 1].time - sortedAnchors[i].time)
            : 0;
          const smoothness = (sortedAnchors[i].smoothness || 0) / 100;
          const smoothT = smoothness > 0 ? t * t * (3 - 2 * t) : t;
          return sortedAnchors[i].pitch + smoothT * (sortedAnchors[i + 1].pitch - sortedAnchors[i].pitch);
        }
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
            const st = sm > 0 ? t * t * (3 - 2 * t) : t;
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
      let found = false;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const note = sortedNotes[mid];
        if (frameBeat >= note.start && frameBeat < note.start + note.duration) {
          pitch = note.pitch;
          found = true;
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
