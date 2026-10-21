import { SAMPLE_RATE, SVS_HOP_SIZE } from './constants.js';
import { buildF0PostprocessParams, hasF0PostprocessEffect } from '../shared/postprocessCurves.js';
import { applyF0Postprocess } from '../fragmentEditor/f0Smoothing.js';
// 锚点"强度 / 平滑"的唯一数学真源。该模块是无 DOM、无 state 的纯叶子模块，
// 且本文件已依赖的 shared/postprocessCurves.js 同样 import 它 —— 渲染包早就
// 包含它，这里直接复用而非再复刻一份（复刻正是强度被丢掉的根因，见
// _getPitchAtTimeForFragment 注释）。
import { buildEffectiveValues, evalSortedCurve } from '../fragmentEditor/automationCurve.js';

// 复用分片编辑器 buildPitchCurveF0Data + getPitchAtTime + generateAutoPitchPoints 的逻辑，
// 但接受 fragment 参数（不依赖分片编辑器全局 state）。
// 主页面逐 fragment 合成时调用，确保与分片编辑器播放的 f0 轨迹完全一致：
// 锚点求值（强度 / 平滑）直接走 shared 真源 automationCurve.js，不再本地复刻。
export function buildFragmentPitchCurveF0(fragment, clippedNotes, bpm) {
  if (!fragment || !fragment.pitchCurve || !fragment.pitchCurve.enabled) return null;
  const pc = fragment.pitchCurve;
  const hasCustom = pc.anchorPoints.length > 0 || pc.brushSegments.length > 0;
  if (!clippedNotes || clippedNotes.length === 0) return null;
  const sortedNotes = clippedNotes.slice().sort((a, b) => a.start - b.start || b.duration - a.duration);
  const hasVibrato = sortedNotes.some(n => n.vibrato && n.vibrato.enabled);
  // F0 后处理（中值 / Savitzky-Golay / 贝塞尔过渡）即使没有手绘音高曲线也必须生效，
  // 否则用户在"音色"lane 里开的平滑只对改过音高的分片有效（与分片编辑器一致）。
  const ppActive = hasF0PostprocessEffect(fragment.postprocess || null);
  if (!hasCustom && !hasVibrato && !ppActive) return null;

  const fragDuration = fragment.duration || Infinity;
  const lastNote = sortedNotes[sortedNotes.length - 1];
  const totalBeats = Math.min(lastNote.start + lastNote.duration, fragDuration);
  const totalSeconds = (totalBeats / bpm) * 60;
  const totalFrames = Math.floor(totalSeconds * SAMPLE_RATE / SVS_HOP_SIZE);

  // 预排序 anchor points（与分片编辑器 getSortedAnchorPoints 一致）
  const sortedAnchors = [...pc.anchorPoints].sort((a, b) => a.time - b.time);
  // 强度生效后的数值序列：强度 < 100 的锚点被拉向前后邻居连线（强度语义见
  // automationCurve.js）。缺省 / 100 时与原始值逐点相同，旧工程音频不变。
  // 与分片编辑器 _getEffectivePitchValues 同一函数，保证两条路径逐位一致。
  const effAnchors = buildEffectiveValues(sortedAnchors, 'pitch');

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
    let pitch = _getPitchAtTimeForFragment(pc, sortedAnchors, effAnchors, autoPoints, frameBeat, autoPointsUsable);
    // 纯 MIDI 回退（与编辑器 getPitchAtTime 的 activeNote 回退一致）：
    // autoPoints 全部 breakAfter 时上面的函数恒返回 null，若无此回退，
    // "纯 MIDI 分片 + 开 F0 后处理"会产出全零 F0 → 整段静音。
    if (pitch === null) pitch = note.pitch;
    if (note.vibrato && note.vibrato.enabled) {
      pitch += _computeVibratoOffset(note, frameBeat, bpm);
    }
    if (pitch !== null && pitch > 0) {
      f0Array[i] = 440 * Math.pow(2, (pitch - 69) / 12);
    } else {
      f0Array[i] = 0;
    }
  }

  // F0 后处理：与分片编辑器 buildPitchCurveF0Data 相同的三步链（中值→SG→贝塞尔），
  // 逐帧参数来自 fragment.postprocess 曲线，保证主窗口播放/导出与分片编辑器听感一致。
  if (ppActive && totalFrames > 0) {
    const params = buildF0PostprocessParams(fragment.postprocess || null, totalFrames, bpm, SAMPLE_RATE, SVS_HOP_SIZE);
    if (params.active) {
      return applyF0Postprocess(f0Array, params, { sampleRate: SAMPLE_RATE, hopSize: SVS_HOP_SIZE });
    }
  }
  return f0Array;
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

// 等价于分片编辑器 getPitchAtTime，但不依赖全局 state。
// 锚点分支直接委托 shared 真源 automationCurve.evalSortedCurve：
//   · buildEffectiveValues 已把"强度 < 100 的锚点"拉向前后邻居连线；
//   · evalSortedCurve 内部按左端锚点 smoothness 做 smoothstep 缓动。
// 两者与分片编辑器 canvasRenderer.getPitchAtTime 走同一函数，因此主窗口
// 播放 / 导出 / MCP 自动化与分片编辑器的 F0 逐位一致 —— 强度修改不再被
// 静默丢弃（修复前这里只复刻了 smoothness，强度改了曲线完全不变）。
function _getPitchAtTimeForFragment(pc, sortedAnchors, effAnchors, autoPoints, time, autoPointsUsable) {
  if (!pc.enabled) return null;

  if (sortedAnchors.length > 0) {
    if (time < sortedAnchors[0].time || time > sortedAnchors[sortedAnchors.length - 1].time) {
      // outside anchor range, fall through to brush/auto
    } else {
      const v = evalSortedCurve(sortedAnchors, effAnchors, time);
      // 非有限值（理论上只有 time 为 NaN 时出现）保持旧兜底：取末锚点音高
      if (v !== null && Number.isFinite(v)) return v;
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

/**
 * @internal 仅由 test/rendererPostprocessParity.test.js 引用（同源复刻守护），
 * 生产代码请用 buildFragmentPitchCurveF0。
 */
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

  // 每个分片缓存"已排序锚点 + 强度生效后数值"（与 buildFragmentPitchCurveF0 一致，
  // 真源同为 automationCurve.buildEffectiveValues）——强度 < 100 的锚点在此被拉向
  // 前后邻居连线，主窗口路径与分片编辑器逐位一致。
  const sortedAnchorsCache = new Map();
  for (const frag of pitchCurveFrags) {
    const pc = frag.pitchCurve;
    if (pc.anchorPoints.length > 0 && !sortedAnchorsCache.has(frag.id)) {
      const sorted = [...pc.anchorPoints].sort((a, b) => a.time - b.time);
      sortedAnchorsCache.set(frag.id, { sorted, eff: buildEffectiveValues(sorted, 'pitch') });
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
        const { sorted, eff } = sortedAnchorsCache.get(frag.id);
        if (localBeat < sorted[0].time || localBeat > sorted[sorted.length - 1].time) {
          // outside anchor range, skip
        } else {
          // 强度 + 平滑统一走 shared 真源（与分片编辑器 getPitchAtTime 同函数）
          const v = evalSortedCurve(sorted, eff, localBeat);
          if (v !== null && Number.isFinite(v)) pitch = v;
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
