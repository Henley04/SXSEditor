import { SAMPLE_RATE, SVS_HOP_SIZE } from './constants.js';
import { buildF0PostprocessParams, hasF0PostprocessEffect, applyGlideOwnership } from '../shared/postprocessCurves.js';
import { applyF0Postprocess, medianFilterFrames, savitzkyGolayFilter } from '../fragmentEditor/f0Smoothing.js';
// 锚点"强度 / 平滑"的唯一数学真源。强度/平滑的求值现在统一走
// shared/autoPitchCurve.createPitchResolver（主窗口与分片编辑器共用），
// 这里保留 autoCurve 的 import 仅供 @internal 的 computePitchCurveF0 使用。
import { buildEffectiveValues, evalSortedCurve } from '../fragmentEditor/automationCurve.js';
import { normalizePitchCurve } from '../shared/pitchCurveState.js';
import {
  createPitchResolver,
  applyExpressionToF0,
  resolvePitchRanges,
  saltFromKey,
} from '../shared/autoPitchCurve.js';
import { lastNoteEnd } from '../shared/activeNotes.js';

// 复用分片编辑器 buildPitchCurveF0Data + getPitchAtTime + generateAutoPitchPoints 的逻辑，
// 但接受 fragment 参数（不依赖分片编辑器全局 state）。
// 主页面逐 fragment 合成时调用，确保与分片编辑器播放的 f0 轨迹完全一致：
// 锚点求值（强度 / 平滑）直接走 shared 真源 automationCurve.js，不再本地复刻。
export function buildFragmentPitchCurveF0(fragment, clippedNotes, bpm) {
  if (!fragment || !fragment.pitchCurve) return null;
  // 归一化兜底：旧工程没有 auto/bakedSegments 字段时补默认（auto 关闭），
  // 保证与 v2.0.2 逐位一致；新建分片则带着 auto 配置进来。
  const pc = normalizePitchCurve(fragment.pitchCurve);
  if (!pc.enabled) return null;
  if (!clippedNotes || clippedNotes.length === 0) return null;

  const sortedNotes = clippedNotes
    .slice()
    .sort((a, b) => a.start - b.start || b.duration - a.duration);
  const hasManual = pc.anchorPoints.length > 0
    || pc.brushSegments.length > 0
    || (pc.bakedSegments && pc.bakedSegments.length > 0);
  const hasVibrato = sortedNotes.some((n) => n.vibrato && n.vibrato.enabled);
  // F0 后处理（中值 / Savitzky-Golay / 贝塞尔过渡）即使没有手绘音高曲线也必须生效，
  // 否则用户在"音色"lane 里开的平滑只对改过音高的分片有效（与分片编辑器一致）。
  const ppActive = hasF0PostprocessEffect(fragment.postprocess || null);
  // 自动层：即使没有任何手动内容也要生成 F0（"开了 auto 就有曲线"）。
  const autoOn = !!(pc.auto && pc.auto.enabled);
  if (!hasManual && !hasVibrato && !ppActive && !autoOn) return null;

  const fragDuration = fragment.duration || Infinity;
  // F2：总时长取 max(start+duration)，不取数组末元素
  const totalBeats = Math.min(lastNoteEnd(sortedNotes), fragDuration);
  const totalSeconds = (totalBeats / bpm) * 60;
  const totalFrames = Math.floor(totalSeconds * SAMPLE_RATE / SVS_HOP_SIZE);

  const ranges = resolvePitchRanges(sortedNotes);
  // 轨道 salt：多轨同度叠唱时抖动/颤音相位必须互不相同，否则"一起抖"比不抖更假
  const seedSalt = saltFromKey(fragment.id !== undefined ? fragment.id : fragment.singerId);
  // jitterStage='post'：曲线层不含抖动，改在后处理之后叠加（避免被平滑削掉）；
  // 自动颤音同理（§6.3）——曲线层不含，后处理之后统一叠加，深度不被 SG 削弱。
  const jitterPost = autoOn && pc.auto.params.jitterStage === 'post';
  const resolver = createPitchResolver({
    pitchCurve: pc,
    auto: pc.auto,
    sortedNotes,
    bpm,
    ranges,
    seedSalt,
    includeJitter: !jitterPost,
    includeVibrato: false,
  });

  const f0Array = new Float32Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    const frameTimeSec = (i * SVS_HOP_SIZE) / SAMPLE_RATE;
    const frameBeat = (frameTimeSec / 60) * bpm;
    const note = _findNoteAtBeat(sortedNotes, frameBeat);
    if (!note) {
      f0Array[i] = 0;
      continue;
    }
    // 统一求值：手动（作用域内）> 自动 > note.pitch 回退。
    // 与分片编辑器 canvasRenderer.getPitchAtTime 走同一个 resolver。
    let pitch = resolver.pitchAt(frameBeat);
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

  // F0 后处理：与分片编辑器 buildPitchCurveF0Data 相同的三步链（中值→SG→贝塞尔）
  let out = f0Array;
  if (ppActive && totalFrames > 0) {
    const params = buildF0PostprocessParams(fragment.postprocess || null, totalFrames, bpm, SAMPLE_RATE, SVS_HOP_SIZE);
    // 重合处理：auto 接管换音过渡时把 f0Glide 置零，避免双重过冲
    applyGlideOwnership(params, autoOn ? pc.auto : null);
    if (params.active) {
      out = applyF0Postprocess(out, params, { sampleRate: SAMPLE_RATE, hopSize: SVS_HOP_SIZE });
    }
  }

  // 自动表达后置：抖动（jitterStage='post'）与自动颤音都在中值/SG/贝塞尔之后
  // 叠加，避免被削掉（实测 SG 会把抖动削到 51%、5.5Hz 颤音削到 94%）。
  if (autoOn && out.length > 0) {
    out = applyExpressionToF0(out, {
      sortedNotes, auto: pc.auto, bpm, ranges, seedSalt,
    }, {
      sampleRate: SAMPLE_RATE,
      hopSize: SVS_HOP_SIZE,
    }, { jitter: jitterPost, vibrato: true });
  }
  return out;
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

/**
 * F0 序列 → 音高曲线锚点。
 *
 * 相对旧实现的四处修正（审查报告 F5/F6/F7）：
 *   1. **分箱单位从"拍"改为"秒"**：旧实现固定 0.08 拍，BPM 60 时每锚点 80ms
 *      （往返最大误差 286 音分）、BPM 240 时 21ms（几乎逐帧复制），同一首歌
 *      换个速度保真度完全不同。现在默认 40ms 一桶，与速度解耦。
 *   2. **时间戳取桶内帧的真实平均时间**（等价于"箱中心"，但更精确）：
 *      旧实现把均值放在箱起点，产生半箱（120BPM 时 20ms）的系统性滞后。
 *   3. **生成前先滤波**：中值去孤立倍频/跳点 → Savitzky-Golay 保形平滑。
 *      旧实现直接把含噪 F0 平均进锚点，且锚点 strength 缺省 100 → 曲线
 *      强制穿过所有噪声（实测降 strength 反而更偏离真值，因为强度不是低通）。
 *   4. **按音符切桶**：换音若跨桶，旧实现会把两个音高平均成中间值（伪滑音）。
 *      传入 notes 后按"音符索引"分组，换音处不再平均。
 *
 * 另外：写入 strength（默认 80）与随密度自适应的 smoothness（旧实现硬编码 30），
 * 并用 RDP 抽稀 + 上限控制锚点数量（旧实现 3 分钟歌曲产出 4500 个锚点 / 260KB）。
 *
 * @param {Array<{time:number,f0:number}>} f0Data 帧序列（秒 / Hz，0=清音）
 * @param {number} bpm 当前工程 BPM（用于把"秒"换算成拍）
 * @param {object} [options]
 * @param {number} [options.bucketSec=0.04] 分桶宽度（秒）
 * @param {number} [options.medianWindow=5] 中值窗口（帧，<3 关闭）
 * @param {number} [options.sgWindow=7] SG 窗口（帧，<5 关闭）
 * @param {number} [options.sgOrder=3] SG 阶数
 * @param {number} [options.strength=80] 锚点强度（0..100）
 * @param {number} [options.maxAnchors=4000] 锚点数量上限
 * @param {number} [options.rdpToleranceCents=6] RDP 抽稀容差（音分）
 * @param {Array} [options.notes] 该分片的音符（启用按音符切桶 + 八度校正）
 * @param {boolean} [options.octaveAlign=true] 与音符中位数比对后做整八度校正
 * @returns {Array<{time:number,pitch:number,strength:number,smoothness:number}>}
 */
export function f0DataToPitchCurveAnchorPoints(f0Data, bpm, options = {}) {
  if (!f0Data || f0Data.length === 0) return [];
  if (!(bpm > 0)) return [];

  const {
    bucketSec = 0.04,
    medianWindow = 5,
    sgWindow = 7,
    sgOrder = 3,
    strength = 80,
    maxAnchors = 4000,
    rdpToleranceCents = 6,
    notes = null,
    octaveAlign = true,
  } = options;

  const beatDuration = 60 / bpm;
  const n = f0Data.length;
  const hz = new Float32Array(n);
  for (let i = 0; i < n; i++) hz[i] = f0Data[i].f0 > 0 ? f0Data[i].f0 : 0;

  // ---- 1) 八度校正：F0 与音符中位数差出整八度时（检测器倍频/半频错误）
  //        整体平移，避免"曲线与音符完全对不上"却毫无提示。
  let octaveShift = 0;
  if (octaveAlign && notes && notes.length > 0) {
    const voicedMidi = [];
    for (let i = 0; i < n; i++) {
      if (hz[i] > 0) voicedMidi.push(69 + 12 * Math.log2(hz[i] / 440));
    }
    if (voicedMidi.length > 0) {
      const med = _median(voicedMidi);
      const noteMed = _median(notes.filter((x) => x.pitch > 0).map((x) => x.pitch));
      if (Number.isFinite(med) && Number.isFinite(noteMed)) {
        const diff = med - noteMed;
        // 只有偏差超过 6 个半音（明显不是演唱偏差）才按整八度校正
        if (Math.abs(diff) >= 6 && Math.abs(diff) <= 30) octaveShift = Math.round(diff / 12);
      }
    }
  }
  if (octaveShift !== 0) {
    const factor = Math.pow(2, -octaveShift);
    for (let i = 0; i < n; i++) if (hz[i] > 0) hz[i] *= factor;
  }

  // ---- 2) 预滤波（0 帧保持 0，两个滤波器都不跨静音段）
  let filtered = hz;
  if (medianWindow >= 3) filtered = medianFilterFrames(filtered, medianWindow, 9);
  if (sgWindow >= 5) filtered = savitzkyGolayFilter(filtered, { window: sgWindow, order: sgOrder });

  // ---- 3) 分桶：按秒定宽 → 换算成拍；键 = 桶序号 + 音符序号（换音不跨桶平均）
  const bucketBeat = Math.max(1e-6, (bucketSec * bpm) / 60);
  const sortedNotes = notes && notes.length
    ? notes.slice().sort((a, b) => a.start - b.start)
    : null;
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const f = filtered[i];
    if (!(f > 0)) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    if (midi < 24 || midi > 108) continue;
    const beat = f0Data[i].time / beatDuration;
    const idx = Math.floor(beat / bucketBeat);
    const noteIdx = sortedNotes ? _noteIndexAt(sortedNotes, beat) : -1;
    const key = idx + '|' + noteIdx;
    let b = buckets.get(key);
    if (!b) { b = { sumPitch: 0, sumTime: 0, cnt: 0 }; buckets.set(key, b); }
    b.sumPitch += midi;
    b.sumTime += f0Data[i].time / beatDuration;   // 真实时间（拍）
    b.cnt += 1;
  }

  let points = [];
  for (const b of buckets.values()) {
    if (b.cnt === 0) continue;
    points.push({ time: b.sumTime / b.cnt, pitch: b.sumPitch / b.cnt });
  }
  points.sort((a, b) => a.time - b.time);
  if (points.length === 0) return [];

  // ---- 4) RDP 抽稀：平稳段合并，滑音/颤音段保留（容差单位：音分）
  if (rdpToleranceCents > 0 && points.length > 2) {
    points = _rdpSimplify(points, rdpToleranceCents);
  }

  // ---- 5) 上限：等距抽样但保留首尾
  if (points.length > maxAnchors) {
    const picked = [];
    const stepIdx = (points.length - 1) / (maxAnchors - 1);
    for (let i = 0; i < maxAnchors; i++) picked.push(points[Math.round(i * stepIdx)]);
    points = picked;
  }

  // ---- 6) smoothness 随密度自适应（桶越密越接近原始数据，缓动应越小）
  const smoothness = bucketSec <= 0.03 ? 10 : bucketSec <= 0.05 ? 20 : 30;
  const clampedStrength = Math.max(0, Math.min(100, strength));

  return points.map((p) => ({
    time: Math.max(0, p.time),
    pitch: p.pitch,
    strength: clampedStrength,
    smoothness,
  }));
}

/** 中位数（空数组返回 NaN）。 */
function _median(arr) {
  if (!arr || arr.length === 0) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 二分查找包含 beat 的音符索引（无则 -1）。 */
function _noteIndexAt(sortedNotes, beat) {
  let lo = 0;
  let hi = sortedNotes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const note = sortedNotes[mid];
    if (beat < note.start) hi = mid - 1;
    else if (beat >= note.start + note.duration) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Ramer–Douglas–Peucker 抽稀（以时间为 x、音分 = pitch×100 为 y 的平面）。
 * 只保留对形状有贡献的点，平稳段被合并成直线。
 */
function _rdpSimplify(points, toleranceCents) {
  const n = points.length;
  if (n < 3) return points;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol = toleranceCents / 100; // 换算成半音（y 轴单位）
  const stack = [[0, n - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const t0 = points[a].time;
    const p0 = points[a].pitch;
    const dt = points[b].time - t0;
    const dp = points[b].pitch - p0;
    let maxDev = -1;
    let maxIdx = -1;
    for (let i = a + 1; i < b; i++) {
      const t = points[i].time;
      const p = points[i].pitch;
      // 点到线段的垂直距离（时间轴退化时退化为纵向距离）
      const proj = dt > 0 ? p0 + (dp * (t - t0)) / dt : p0;
      const dev = Math.abs(p - proj);
      if (dev > maxDev) { maxDev = dev; maxIdx = i; }
    }
    if (maxDev > tol && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([a, maxIdx]);
      stack.push([maxIdx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * F0 → 派生段（"仅滑音"导入）。
 *
 * 为什么不再直接写入几千个 anchorPoints：
 *   · 3 分钟歌曲约 4500 个锚点 / 260KB，用户根本无法手工编辑；
 *   · 平稳段（F0 与 MIDI 基本一致）本来就不需要手动曲线，交给自动层即可；
 *   · 锚点数组会随音符改动失效（曲线锁死在原调），而派生段是显式手动资产。
 *
 * 做法：只保留"明显偏离音符"（默认 > 25 音分）的连续区间，做成若干
 * bakedSegment；其余交给自动曲线。跨版本时"借用真人滑音 + 保留自己的旋律"。
 *
 * @param {Array<{time:number,f0:number}>} f0Data
 * @param {number} bpm
 * @param {Array} notes 该分片音符（用于判定偏离与切桶）
 * @param {object} [options] 透传给 f0DataToPitchCurveAnchorPoints
 * @returns {{segments:Array, anchors:Array, keptRatio:number}}
 */
export function f0DataToSlipSegments(f0Data, bpm, notes, options = {}) {
  const anchors = f0DataToPitchCurveAnchorPoints(f0Data, bpm, { ...options, notes });
  if (anchors.length === 0 || !Array.isArray(notes) || notes.length === 0) {
    return { segments: [], anchors, keptRatio: 0 };
  }
  const threshold = Number.isFinite(options.slipThresholdCents) ? options.slipThresholdCents : 25;
  const sortedNotes = notes.slice().sort((a, b) => a.start - b.start);

  const keep = anchors.map((a) => {
    const n = _noteAtBeat(sortedNotes, a.time);
    if (!n || !(n.pitch > 0)) return false;
    return Math.abs(a.pitch - n.pitch) * 100 > threshold;
  });

  const segments = [];
  let i = 0;
  let keptCount = 0;
  let seq = 0;
  while (i < anchors.length) {
    if (!keep[i]) { i++; continue; }
    let j = i;
    while (j + 1 < anchors.length && keep[j + 1]) j++;
    // 前后各扩一个锚点，让滑音有起落、不是硬切
    const from = Math.max(0, i - 1);
    const to = Math.min(anchors.length - 1, j + 1);
    const pts = anchors.slice(from, to + 1).map((a) => ({
      time: a.time, pitch: a.pitch, strength: a.strength, smoothness: a.smoothness,
    }));
    if (pts.length >= 2) {
      segments.push({
        id: `bk_imp_${seq++}`,
        start: pts[0].time,
        end: pts[pts.length - 1].time,
        origin: 'f0-import',
        points: pts,
      });
      keptCount += j - i + 1;
    }
    i = j + 1;
  }
  return { segments, anchors, keptRatio: keptCount / anchors.length };
}

function _noteAtBeat(sortedNotes, beat) {
  let lo = 0;
  let hi = sortedNotes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const n = sortedNotes[mid];
    if (beat < n.start) hi = mid - 1;
    else if (beat >= n.start + n.duration) lo = mid + 1;
    else return n;
  }
  return null;
}
