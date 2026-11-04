/**
 * 插件的曲线字段（`kind: 'curve'`）—— 取值、归一、求值。
 *
 * 为什么曲线只画不解
 * ----------------
 * 宿主不知道这条曲线是什么量纲：可能是颤音深度，可能是引擎的"张力"，
 * 也可能是某个方言里的音素级 pitchbend。它能做的只有两件确定的事：
 *
 *   1. 按数据给的 `t`（音符内的相对位置）把折线画出来；
 *   2. 按声明的 `interp` / `quantize` / `clamp` 求某个位置的值。
 *
 * 它不会把曲线塞进宿主的音高/音量通道 —— 那等于替插件猜语义，猜错的后果
 * 是"用户以为改了有效，合成却根本不看"（音素面板当初就踩过这个坑）。
 *
 * 时间基座：`t ∈ [0, 1]`，相对音符长度。不用绝对拍号，是因为音符被拖长时
 * 曲线应当跟着拉伸；用绝对拍会让"改了时值曲线就跑到音符外面"。
 *
 * 热路径约束：这个模块只做数字运算，没有 JSON 深拷贝、没有正则、没有分配
 * 循环体里的对象 —— 它会在每帧、每个可见音符上被调用。
 */

import { CURVE_INTERP } from './pluginExt.js';

/** 单条曲线的采样点上限。超过按"用户不会画出这么密的点"处理。 */
export const CURVE_MAX_POINTS = 4096;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 把插件给的值收敛成 `[{t, v}]`（按 t 升序）。
 *
 * 宽容形态：`{ points: [[t, v], ...] }`、`[[t, v], ...]`、`{ points: [{t, v}] }`。
 * 三种都见过（SV2 的 automation、Vocaloid 的 controller、手写 JSON），
 * 让插件为了"能被画出来"改自己的数据形状没有意义。
 *
 * 超出 `[0,1]` 的 t 直接丢弃而不是夹到边界：夹边会让一段"音符外的数据"
 * 变成贴边的竖线，看起来像是有效的自动化。丢点是"我看不见它"，而夹边是
 * "我看见了但内容是假的"。
 *
 * @returns {{t:number, v:number}[]|null} 少于两个点返回 null（画不出线）
 */
export function normalizeCurvePoints(raw) {
  let arr = null;
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === 'object' && Array.isArray(raw.points)) arr = raw.points;
  if (!arr || arr.length === 0) return null;

  const out = [];
  const limit = Math.min(arr.length, CURVE_MAX_POINTS);
  for (let i = 0; i < limit; i++) {
    const item = arr[i];
    let t;
    let v;
    if (Array.isArray(item)) {
      t = item[0];
      v = item[1];
    } else if (item && typeof item === 'object') {
      t = item.t;
      v = item.v;
    } else {
      continue;
    }
    if (!isFiniteNumber(t) || !isFiniteNumber(v)) continue;
    if (t < 0 || t > 1) continue;
    out.push({ t, v });
  }
  if (out.length < 2) return null;
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * 求某个位置的值。`interp` 由声明决定，宿主只负责求值。
 *
 * @param {{t:number, v:number}[]} points 已排序
 * @param {number} t 0..1
 * @param {'linear'|'step'|'smooth'} interp
 * @returns {number|null}
 */
export function sampleCurve(points, t, interp = 'linear') {
  if (!Array.isArray(points) || points.length === 0) return null;
  if (!isFiniteNumber(t)) return null;
  if (t <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;

  // 二分：曲线可能有几千个点，逐帧线性扫描会变成 O(points × notes)
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const u = (t - a.t) / span;
  if (interp === 'step') return a.v;
  if (interp === 'smooth') {
    // smoothstep：与宿主音高曲线的手感一致，避免插件曲线在节点处出现折角
    const s = u * u * (3 - 2 * u);
    return a.v + (b.v - a.v) * s;
  }
  return a.v + (b.v - a.v) * u;
}

/**
 * 应用声明里的 `quantize` / `clamp`。
 *
 * 放在求值之后而不是数据归一化时：量化是"这条通道的取值粒度"，
 * 只影响宿主怎么读，不改插件写下的原始数据（保存时原样回写）。
 */
export function applyCurveSpec(value, spec) {
  if (!isFiniteNumber(value)) return value;
  let v = value;
  if (spec && isFiniteNumber(spec.quantize) && spec.quantize > 0) {
    v = Math.round(v / spec.quantize) * spec.quantize;
  }
  if (spec && Array.isArray(spec.clamp) && spec.clamp.length === 2) {
    const [lo, hi] = spec.clamp;
    if (isFiniteNumber(lo) && isFiniteNumber(hi) && hi > lo) {
      v = Math.max(lo, Math.min(hi, v));
    }
  }
  return v;
}

/**
 * 合并字段级与 schema 级的曲线声明。
 *
 * 字段能覆盖 `interp`（"这条是阶跃的"），但不该能取消 schema 的 `clamp` ——
 * clamp 是插件对"这条通道的合理范围"的表态，逐字段丢掉它只会让越界值跑到界面上。
 */
export function resolveCurveSpec(schemaEntry, fieldSpec) {
  const base = (schemaEntry && schemaEntry.curve) || null;
  const own = (fieldSpec && fieldSpec.curve) || null;
  const spec = {
    interp: CURVE_INTERP.includes(own && own.interp)
      ? own.interp
      : (CURVE_INTERP.includes(base && base.interp) ? base.interp : 'linear'),
  };
  if (own && isFiniteNumber(own.quantize) && own.quantize > 0) spec.quantize = own.quantize;
  else if (base && isFiniteNumber(base.quantize) && base.quantize > 0) spec.quantize = base.quantize;
  if (own && Array.isArray(own.clamp) && own.clamp.length === 2) spec.clamp = own.clamp.slice();
  else if (base && Array.isArray(base.clamp) && base.clamp.length === 2) spec.clamp = base.clamp.slice();
  return spec;
}

/**
 * 从某一层的 ext 里取出所有已声明的曲线字段。
 *
 * 渲染层拿它画音符上的折线；音频侧拿它做"工程意图"的检查。
 * 与 `findField` 的区别：曲线可以有多条，所以返回数组而不是第一个。
 *
 * @param {object} ext 该层的 ext
 * @param {object} schema document.extSchema
 * @param {'document'|'singer'|'fragment'|'note'} layer
 * @returns {Array<{pluginId:string, field:string, label:string, editable:boolean,
 *   points:{t:number,v:number}[], spec:object, value:any}>}
 */
export function collectCurves(ext, schema, layer) {
  const out = [];
  if (!ext || typeof ext !== 'object' || !schema) return out;
  for (const pluginId of Object.keys(ext)) {
    const entry = schema[pluginId];
    if (!entry || !entry[layer]) continue;
    const bag = ext[pluginId];
    if (!bag || typeof bag !== 'object') continue;
    const fields = entry[layer];
    for (const name of Object.keys(fields)) {
      const spec = fields[name];
      if (!spec || spec.kind !== 'curve') continue;
      const raw = bag[name];
      if (raw === undefined) continue;
      const points = normalizeCurvePoints(raw);
      if (!points) continue;
      out.push({
        pluginId,
        field: name,
        label: spec.label || name,
        editable: spec.editable === true,
        points,
        spec: resolveCurveSpec(entry, spec),
        value: raw,
      });
    }
  }
  return out;
}
