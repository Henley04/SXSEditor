/**
 * 音色 / 后处理曲线的读取与采样（编辑器 state 层）。
 *
 * 这一层只负责把编辑器全局 state（postprocess 曲线 + 版本号缓存）接到
 * shared/postprocessCurves.js 的纯采样函数上；载荷与逐帧参数的全部数学
 * 都在共享模块里，主窗口播放/导出路径（renderer/f0Utils.js、
 * renderer/audioPlayback.js）直接传 fragment.postprocess 复用同一实现。
 *
 * 时间轴约定（与管线保持一致）：
 *   - F0 数组的第 i 帧对应**分片内绝对时间** i·hop/采样率（第 0 帧 = 分片起点）。
 *   - mel 数组的第 i 帧对应**第一个音符起点 + i·hop/采样率**：管线生成音频时
 *     从第一个音符开始，不包含首音符之前的静音（见 index.js 中 firstNoteStartBeat 注释）。
 *   载荷携带 startBeat/bpm，re-base 路径的换算由主进程 computeMelFrameOffset 完成。
 */

import { POSTPROCESS_PARAMS, clampParamValue } from './postprocessParams.js';
import { sortAnchors, buildEffectiveValues, evalSortedCurve } from './automationCurve.js';
import {
  buildF0PostprocessParams,
  buildMelPostprocessPayload as buildMelPayloadShared,
  hasF0PostprocessEffect as hasF0Shared,
  hasSpectralPostprocessEffect as hasSpecShared,
  hasParamEffect,
  serializePostprocessForSignature as serializeShared,
} from '../shared/postprocessCurves.js';
import {
  getPostprocess,
  getPostprocessDefaults,
  getPostprocessCurves,
  getTimbreVersion,
} from './state.js';

const _curveCache = new Map(); // paramId -> { version, sorted, eff }

/** 取某参数的锚点数组（原始顺序，索引与选中集合一致）。 */
export function getTimbreKeyframes(paramId) {
  const curves = getPostprocessCurves();
  const curve = curves ? curves[paramId] : null;
  return curve && Array.isArray(curve.keyframes) ? curve.keyframes : [];
}

/** 取某参数曲线缓存的（已排序锚点 + 有效数值）。 */
export function getTimbreCurveCache(paramId) {
  const version = getTimbreVersion();
  const cached = _curveCache.get(paramId);
  if (cached && cached.version === version) return cached;
  const curves = getPostprocessCurves();
  const curve = curves ? curves[paramId] : null;
  const sorted = sortAnchors(curve ? curve.keyframes : []);
  const entry = { version, sorted, eff: buildEffectiveValues(sorted) };
  _curveCache.set(paramId, entry);
  return entry;
}

/** 某参数在指定拍位置的有效取值：有锚点走曲线，否则用全局默认值。 */
export function getTimbreValueAt(paramId, beat) {
  const { sorted, eff } = getTimbreCurveCache(paramId);
  if (sorted.length > 0) {
    const v = evalSortedCurve(sorted, eff, Math.max(0, beat));
    if (v !== null) return clampParamValue(paramId, v);
  }
  return getTimbreDefault(paramId);
}

export function getTimbreDefault(paramId) {
  const defaults = getPostprocessDefaults();
  const raw = defaults ? defaults[paramId] : undefined;
  return raw === undefined ? POSTPROCESS_PARAMS[paramId]?.def ?? 0 : raw;
}

/** 该参数是否存在"会改变音频"的取值（默认值或任一锚点非关闭态）。 */
export function paramHasEffect(paramId) {
  return hasParamEffect(getPostprocess(), paramId);
}

export function hasF0PostprocessEffect() {
  return hasF0Shared(getPostprocess());
}

export function hasSpectralPostprocessEffect() {
  return hasSpecShared(getPostprocess());
}

export function isPostprocessActive() {
  return hasF0PostprocessEffect() || hasSpectralPostprocessEffect();
}

/**
 * 构建 F0 后处理所需的逐帧参数（时间基准 = 分片起点）。
 * @returns {{smooth:Float32Array, median:Float32Array, glide:Float32Array, glideMs:Float32Array, active:boolean}}
 */
export function buildF0ParamArrays(frames, bpm, sampleRate, hopSize) {
  return buildF0PostprocessParams(getPostprocess(), frames, bpm, sampleRate, hopSize);
}

/**
 * 构建传给主进程的 mel 后处理载荷（时间基准 = 第一个音符起点）。
 * @param {Array} notes 参与合成的音符（已裁剪）
 * @returns {object|null} { frames, sigmaT, sigmaF, blend, boundaries, startBeat, bpm } / null（未启用）
 */
export function buildMelPostprocessPayload(notes, bpm, sampleRate, hopSize) {
  return buildMelPayloadShared(getPostprocess(), notes, bpm, sampleRate, hopSize);
}

/** 序列化后的曲线快照（用于 undo/redo 与签名哈希）。 */
export function serializePostprocessForSignature() {
  return serializeShared(getPostprocess());
}
