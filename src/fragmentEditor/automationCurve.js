/**
 * 通用锚点自动化曲线求值。
 *
 * 音高曲线（pitchCurve.anchorPoints）与音色 / 后处理曲线（timbreCurves[paramId].keyframes）
 * 共用这一套数学，避免两条曲线在"强度 / 平滑"语义上出现分歧。
 *
 * 锚点结构：
 *   {
 *     time: number,        // 时间轴位置（拍，与音符 start/duration 同一坐标系）
 *     value: number,       // 锚点数值（音高=.pitch，音色/后处理=参数原生单位）
 *     strength?: number,   // 锚点强度 0..100，缺省 ANCHOR_STRENGTH_DEFAULT(100)
 *     smoothness?: number, // 平滑过渡 0..100，缺省 0（线性）
 *   }
 *
 * 强度语义（本次新增）：
 *   强度 = 该锚点对曲线的"拉力"。
 *   - 100：曲线精确经过锚点（历史行为，未设置 strength 时的默认值，因此旧工程音频不变）。
 *   - 0  ：曲线完全忽略该锚点，退化为前后两锚点连线在该时刻的插值。
 *   实现上用"直线基线"做参照：基线 = 前一个锚点与后一个锚点连成的直线在该时刻的取值，
 *   实际参与插值的值 = 基线 + (锚点值 - 基线) × 强度。首/尾锚点没有两侧邻居，强度不生效。
 *
 * 平滑语义：
 *   0 = 段内线性；100 = 完整 smoothstep（t²(3-2t)）缓入缓出。沿用左端锚点的 smoothness，
 *   与历史 getPitchAtTime / _interpolateEnvelope 的行为保持一致。
 */

export const ANCHOR_STRENGTH_DEFAULT = 100;
// F13：缺省必须与 snapshotAnchors()/pitchCurveState 的 0 一致。
// 原来是 30，导致"经 insertAnchor 创建"与"经 snapshot 复制"的锚点在**同一条
// 曲线上**缓动不同 —— 同一份数据两种解释。用户手绘锚点显式传
// getBrushSmoothing()（画笔平滑，默认 30），不需要这个缺省代劳。
export const ANCHOR_SMOOTHNESS_DEFAULT = 0;

export function clampStrength(v) {
  if (v === null || v === undefined || v === '') return ANCHOR_STRENGTH_DEFAULT;
  const n = Number(v);
  if (!Number.isFinite(n)) return ANCHOR_STRENGTH_DEFAULT;
  return Math.max(0, Math.min(100, n));
}

export function clampSmoothness(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** 段内缓动：smoothness 0 → 线性，100 → smoothstep。 */
export function easeSegment(t, smoothness) {
  const s = clampSmoothness(smoothness) / 100;
  if (s <= 0) return t;
  const smoothStep = t * t * (3 - 2 * t);
  return t + (smoothStep - t) * s;
}

/** 按 time 升序返回新数组（不修改入参）。 */
export function sortAnchors(anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) return [];
  return [...anchors].sort((a, b) => a.time - b.time);
}

/**
 * 计算"应用强度后"的有效数值序列（与传入的已排序锚点一一对应）。
 * 返回值是 Float64Array，长度 = 锚点数。长度 < 3 时强度无意义，原样返回。
 * @param {Array} sorted 已排序锚点
 * @param {string} [valueKey] 数值字段名（音高曲线用 'pitch'，其它曲线用 'value'）
 */
export function buildEffectiveValues(sorted, valueKey = 'value') {
  const n = sorted.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = sorted[i][valueKey];
  if (n < 3) return out;
  for (let i = 1; i < n - 1; i++) {
    const strength = clampStrength(sorted[i].strength ?? ANCHOR_STRENGTH_DEFAULT);
    if (strength >= 100) continue;
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const span = next.time - prev.time;
    if (!(span > 0)) continue;
    const w = (sorted[i].time - prev.time) / span;
    const prevV = prev[valueKey];
    const nextV = next[valueKey];
    const baseline = prevV + (nextV - prevV) * w;
    out[i] = baseline + (sorted[i][valueKey] - baseline) * (strength / 100);
  }
  return out;
}

/**
 * 在已排序锚点 + 有效数值上求值。
 * @param {Array} sorted 已按 time 升序的锚点
 * @param {Float64Array|number[]} eff 有效数值（buildEffectiveValues 的结果）
 * @param {number} time
 * @returns {number|null} 无锚点时返回 null
 */
export function evalSortedCurve(sorted, eff, time) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return eff[0];
  if (time <= sorted[0].time) return eff[0];
  if (time >= sorted[n - 1].time) return eff[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid].time <= time) lo = mid;
    else hi = mid;
  }
  const span = sorted[hi].time - sorted[lo].time;
  const t = span > 0 ? (time - sorted[lo].time) / span : 0;
  const st = easeSegment(t, sorted[lo].smoothness ?? 0);
  return eff[lo] + (eff[hi] - eff[lo]) * st;
}

/** 便捷封装：一次性对未排序锚点求值（内部排序 + 计算有效值，O(n log n)，勿在渲染循环里用）。 */
export function evalAnchors(anchors, time) {
  const sorted = sortAnchors(anchors);
  if (sorted.length === 0) return null;
  return evalSortedCurve(sorted, buildEffectiveValues(sorted), time);
}

/**
 * 统一的数据结构快照（用于 undo/redo 与缓存键）。
 */
export function snapshotAnchors(anchors) {
  if (!Array.isArray(anchors)) return [];
  return anchors.map((a) => ({
    time: a.time,
    value: a.value,
    strength: clampStrength(a.strength ?? ANCHOR_STRENGTH_DEFAULT),
    smoothness: clampSmoothness(a.smoothness ?? 0),
  }));
}

/**
 * 在曲线时间轴上插入锚点。若同一点已存在（±epsilon）则复用该索引并更新数值。
 * @returns {{index:number, created:boolean}}
 */
export function insertAnchor(anchors, time, value, opts = {}) {
  const t = Math.max(0, Number(time) || 0);
  const eps = opts.epsilon ?? 1e-4;
  for (let i = 0; i < anchors.length; i++) {
    if (Math.abs(anchors[i].time - t) <= eps) {
      anchors[i].value = value;
      if (opts.strength !== undefined) anchors[i].strength = clampStrength(opts.strength);
      if (opts.smoothness !== undefined) anchors[i].smoothness = clampSmoothness(opts.smoothness);
      return { index: i, created: false };
    }
  }
  anchors.push({
    time: t,
    value,
    strength: clampStrength(opts.strength ?? ANCHOR_STRENGTH_DEFAULT),
    smoothness: clampSmoothness(opts.smoothness ?? ANCHOR_SMOOTHNESS_DEFAULT),
  });
  return { index: anchors.length - 1, created: true };
}
