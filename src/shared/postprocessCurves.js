/**
 * 音色 / 后处理曲线的**纯**采样与载荷构建。
 *
 * 这里不读任何全局 state：postprocess 状态对象 `{ defaults, curves }` 一律由
 * 调用方传入。两条消费路径共用同一套数学：
 *   - 分片编辑器（fragmentEditor/postprocessAccess.js 读编辑器 state 后委托到这里）
 *   - 主窗口播放/导出（renderer/audioPlayback.js 直接传 fragment.postprocess）
 *
 * 依赖的两个模块（postprocessParams / automationCurve）都是无 DOM、无 state 的
 * 纯叶子模块，因此本模块可以安全进入主窗口渲染包。
 *
 * 时间轴约定（与推理管线一致）：
 *   - F0 数组第 i 帧对应分片内绝对时间 i·hop/采样率（第 0 帧 = 分片起点，拍 0）。
 *   - mel 载荷第 i 帧对应**第一个音符起点**（startBeat）+ i·hop/采样率；
 *     载荷同时携带 startBeat / bpm，管线用 computeMelFrameOffset 把任何
 *     re-base 路径（多段 / 多 region / 单音符 padding）换算回真实时间。
 */

import {
  POSTPROCESS_PARAM_LIST,
  clampParamValue,
  isParamActive,
  quantizeParamValue,
} from '../fragmentEditor/postprocessParams.js';
import {
  sortAnchors,
  buildEffectiveValues,
  evalSortedCurve,
  snapshotAnchors,
} from '../fragmentEditor/automationCurve.js';

/** 逐参数的（已排序锚点 + 有效数值）一次性预算，避免每帧重算。 */
function buildCurveCaches(state) {
  const caches = {};
  const curves = state && state.curves ? state.curves : {};
  for (const p of POSTPROCESS_PARAM_LIST) {
    const curve = curves[p.id];
    const keyframes = curve && Array.isArray(curve.keyframes) ? curve.keyframes : [];
    const sorted = sortAnchors(keyframes);
    caches[p.id] = { sorted, eff: buildEffectiveValues(sorted) };
  }
  return caches;
}

function getParamDefault(state, paramId) {
  const defaults = state && state.defaults ? state.defaults : null;
  const raw = defaults ? defaults[paramId] : undefined;
  return raw === undefined ? POSTPROCESS_PARAM_LIST.find((p) => p.id === paramId)?.def ?? 0 : raw;
}

/** 某参数在指定拍的有效取值：有锚点走曲线（夹紧到注册表值域），否则用默认值。 */
export function sampleParamAt(state, caches, paramId, beat) {
  // caches 缺省时按需构建（一次性调用可传 null；热路径应传 buildCurveCaches 的结果）
  const cache = caches ? caches[paramId] : buildCurveCaches(state)[paramId];
  if (cache && cache.sorted.length > 0) {
    const v = evalSortedCurve(cache.sorted, cache.eff, Math.max(0, beat));
    if (v !== null) return clampParamValue(paramId, v);
  }
  return clampParamValue(paramId, getParamDefault(state, paramId));
}

/** 该参数是否存在"会改变音频"的取值（默认值或任一锚点非关闭态）。 */
export function hasParamEffect(state, paramId) {
  if (isParamActive(paramId, getParamDefault(state, paramId))) return true;
  const curves = state && state.curves ? state.curves : {};
  const curve = curves[paramId];
  if (!curve || !Array.isArray(curve.keyframes)) return false;
  return curve.keyframes.some((kf) => isParamActive(paramId, kf.value));
}

export function hasF0PostprocessEffect(state) {
  return hasParamEffect(state, 'f0Smooth')
    || hasParamEffect(state, 'f0Median')
    || hasParamEffect(state, 'f0Glide');
}

export function hasSpectralPostprocessEffect(state) {
  return hasParamEffect(state, 'specBlend')
    || hasParamEffect(state, 'specSmoothT')
    || hasParamEffect(state, 'specSmoothF');
}

export function isPostprocessActive(state) {
  return hasF0PostprocessEffect(state) || hasSpectralPostprocessEffect(state);
}

/**
 * 规范化外部传入的 postprocess 状态（工程载入 / IPC）：
 * 逐参数合并到注册表默认值上，全部数值夹紧到注册表值域，
 * 锚点经 snapshotAnchors 规范（strength/smoothness 夹紧、value 按参数夹紧）。
 * 旧工程没有该字段时返回全默认（所有处理关闭，音频与旧版本一致）。
 */
export function normalizePostprocessState(raw) {
  const merged = { defaults: {}, curves: {} };
  const incoming = raw && typeof raw === 'object' ? raw : null;
  const savedDefaults = incoming && incoming.defaults ? incoming.defaults : {};
  const savedCurves = incoming && incoming.curves ? incoming.curves : {};
  for (const p of POSTPROCESS_PARAM_LIST) {
    const saved = Number(savedDefaults[p.id]);
    // quantizeParamValue = 夹紧 + 步进/奇数量化（中值窗口 4→5 等），载入值与
    // UI 写入路径完全同构，读数即实际窗口
    merged.defaults[p.id] = Number.isFinite(saved) ? quantizeParamValue(p.id, saved) : p.def;
    const kfs = savedCurves[p.id] && Array.isArray(savedCurves[p.id].keyframes)
      ? savedCurves[p.id].keyframes
      : [];
    merged.curves[p.id] = {
      keyframes: snapshotAnchors(kfs).map((a) => ({ ...a, value: quantizeParamValue(p.id, a.value) })),
    };
  }
  return merged;
}

/**
 * 构建 F0 后处理所需的逐帧参数（时间基准 = 分片起点，拍 0）。
 * @returns {{smooth:Float32Array, median:Float32Array, glide:Float32Array, glideMs:Float32Array, active:boolean}}
 */
export function buildF0PostprocessParams(state, frames, bpm, sampleRate, hopSize) {
  const n = Math.max(0, Math.floor(frames) || 0);
  const out = {
    smooth: new Float32Array(n),
    median: new Float32Array(n),
    glide: new Float32Array(n),
    glideMs: new Float32Array(n),
    active: false,
  };
  if (n === 0 || !(bpm > 0) || !(sampleRate > 0) || !(hopSize > 0)) return out;
  if (!hasF0PostprocessEffect(state)) return out;
  const caches = buildCurveCaches(state);
  const framesPerSecond = sampleRate / hopSize;
  for (let i = 0; i < n; i++) {
    const beat = (i / framesPerSecond) * (bpm / 60);
    out.smooth[i] = sampleParamAt(state, caches, 'f0Smooth', beat);
    out.median[i] = sampleParamAt(state, caches, 'f0Median', beat);
    out.glide[i] = sampleParamAt(state, caches, 'f0Glide', beat);
    out.glideMs[i] = sampleParamAt(state, caches, 'f0GlideMs', beat);
  }
  out.active = true;
  return out;
}

/**
 * 构建传给主进程的 mel 后处理载荷（时间基准 = 第一个音符起点）。
 * 载荷携带 startBeat / bpm，主进程据其对齐任何 re-base 的 mel 时间轴。
 *
 * @returns {object|null} { frames, sigmaT, sigmaF, blend, boundaries, startBeat, bpm } / null（未启用）
 */
export function buildMelPostprocessPayload(state, notes, bpm, sampleRate, hopSize) {
  if (!hasSpectralPostprocessEffect(state)) return null;
  if (!Array.isArray(notes) || notes.length === 0) return null;
  if (!(bpm > 0) || !(sampleRate > 0) || !(hopSize > 0)) return null;

  let firstBeat = Infinity;
  let lastBeat = 0;
  for (const note of notes) {
    if (note.start < firstBeat) firstBeat = note.start;
    const end = note.start + note.duration;
    if (end > lastBeat) lastBeat = end;
  }
  if (!Number.isFinite(firstBeat)) return null;

  const framesPerSecond = sampleRate / hopSize;
  const totalSeconds = ((lastBeat - firstBeat) / bpm) * 60;
  const frames = Math.max(1, Math.ceil(totalSeconds * framesPerSecond) + 1);

  const caches = buildCurveCaches(state);
  const sigmaT = new Float32Array(frames);
  const sigmaF = new Float32Array(frames);
  const blend = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const beat = firstBeat + (i / framesPerSecond) * (bpm / 60);
    sigmaT[i] = sampleParamAt(state, caches, 'specSmoothT', beat);
    sigmaF[i] = sampleParamAt(state, caches, 'specSmoothF', beat);
    blend[i] = sampleParamAt(state, caches, 'specBlend', beat);
  }

  // 过渡边界：每个音符起点（不含分片首音符）→ mel 帧索引
  const boundarySet = new Set();
  for (const note of notes) {
    const rel = (note.start - firstBeat) / bpm * 60 * framesPerSecond;
    const frame = Math.round(rel);
    if (frame > 0 && frame < frames) boundarySet.add(frame);
  }
  const boundaries = Uint32Array.from([...boundarySet].sort((a, b) => a - b));

  return { frames, sigmaT, sigmaF, blend, boundaries, startBeat: firstBeat, bpm };
}

/** 序列化后的曲线快照（用于 undo/redo 与签名哈希）。 */
export function serializePostprocessForSignature(state) {
  const caches = buildCurveCaches(state);
  const parts = [];
  for (const p of POSTPROCESS_PARAM_LIST) {
    const { sorted, eff } = caches[p.id];
    parts.push(`${p.id}=${getParamDefault(state, p.id)}`);
    for (let i = 0; i < sorted.length; i++) {
      parts.push(`${sorted[i].time.toFixed(4)}:${eff[i].toFixed(3)}:${sorted[i].smoothness ?? 0}`);
    }
  }
  return parts.join('|');
}

/**
 * 自动曲线与 `f0Glide` 的重合处理（设计方案 §6.2）。
 *
 * 背景：`f0Glide` 与自动曲线的 glide+overshoot 都做"换音过渡与过冲"，
 * 叠加会双重过冲（7 半音跳进时两处相加可超过一个半音，听感跑调）。
 * 而 `f0Glide` 自身的过冲还严重打折：名义 245 音分，实测 90ms/100% 只有 33 音分，
 * ≤50% 时几乎为 0（三次贝塞尔控制点把过冲稀释了）。
 *
 * 因此默认让"有音符语义"的自动曲线接管换音过渡：
 *   · glideOwnership = 'auto'（默认）→ 本函数把 f0Glide 置零
 *   · 'both' → 保留叠加（给想要夸张滑音的用户）
 *   · 'post' → 自动曲线侧不产生 glide（在 autoPitchCurve 里处理），由后处理接管
 *
 * @param {object} params buildF0PostprocessParams 的结果
 * @param {object|null} auto 归一化后的 auto 配置
 * @returns {object} 同一个 params（就地修改，调用方持有引用）
 */
export function applyGlideOwnership(params, auto) {
  if (!params || !params.glide) return params;
  const mode = auto && auto.params ? auto.params.glideOwnership : null;
  if (mode !== 'auto') return params;
  params.glide.fill(0);
  let hasMedian = false;
  for (let i = 0; i < params.median.length; i++) {
    if (params.median[i] >= 3) { hasMedian = true; break; }
  }
  let hasSmooth = false;
  for (let i = 0; i < params.smooth.length; i++) {
    if (params.smooth[i] > 0) { hasSmooth = true; break; }
  }
  params.active = hasMedian || hasSmooth;
  return params;
}
