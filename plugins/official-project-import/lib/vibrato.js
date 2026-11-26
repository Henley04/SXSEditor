'use strict';
/**
 * Synthesizer V 音符颤音 ↔ 宿主 note.vibrato 的换算。
 *
 * 单位依据 UtaFormatix（Apache-2.0）的
 * core/src/main/kotlin/core/process/pitch/SynthVPitchConversion.kt:
 *   · tF0VbrStart / tF0VbrLeft / tF0VbrRight 是**秒**（相对音符起点 / 渐入 / 渐出）
 *   · dF0Vbr 是**半音**，计算振幅时再乘 0.5
 *   · fF0Vbr 是 Hz，pF0Vbr 是弧度
 *   · 参数缺省时回落 ref.voice 的默认颤音参数，再回落下列常量
 *
 * 宿主（src/fragmentEditor/canvasRenderer.js 的 computeVibratoOffset）是
 * 「相对量」：depth 为音分（/100 得半音振幅）、start / length / fadeIn 均为
 * 0–1 的音符时长占比，颤音区间为 [start*dur, (start+length)*dur]，区间内
 * 前 fadeIn 段线性渐入。两边都以颤音起点为 0 相位，因此 pF0Vbr 与
 * tF0VbrRight（渐出）在宿主里没有等价承载 —— 归入有损项，写回时尽量沿用原值。
 *
 * SV 只把**用户手动改过的**音符参数写进 note.attributes；歌唱模式自动生成的
 * 颤音不会出现在这里。因此只在 attributes 显式含颤音字段时才导入，避免把
 * 默认自动颤音套到每个音符上、与宿主自己的 auto 音高层叠加成双重颤音。
 */

const SVP_DEFAULTS = Object.freeze({
  tF0VbrStart: 0.25,
  tF0VbrLeft: 0.2,
  tF0VbrRight: 0.2,
  dF0Vbr: 1.0,
  fF0Vbr: 5.5,
  pF0Vbr: 0,
});

/** SVP 音符 attributes 里与颤音相关的字段（也是写回时要保留的字段）。 */
const VIBRATO_KEYS = Object.freeze([
  'tF0VbrStart', 'tF0VbrLeft', 'tF0VbrRight', 'dF0Vbr', 'fF0Vbr', 'pF0Vbr',
]);

// 宿主 UI 的可调范围（docs/user/fragment-editor.html「音符效果」章节）。
const HOST_LIMITS = Object.freeze({
  depth: [0, 200],
  rate: [2, 10],
  start: [0, 0.8],
  length: [0.2, 1],
  fadeIn: [0, 1],
});

const MAX_META_NOTES = 64;

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function hasExplicitVibrato(attributes) {
  if (!attributes || typeof attributes !== 'object') return false;
  return VIBRATO_KEYS.some((key) => attributes[key] !== undefined && attributes[key] !== null);
}

/** 回落链：note.attributes → ref.voice 的默认颤音参数 → 常量默认。 */
function pick(attributes, voice, key) {
  const fromNote = attributes ? attributes[key] : undefined;
  if (fromNote !== undefined && fromNote !== null) return finite(fromNote, SVP_DEFAULTS[key]);
  const fromVoice = voice ? voice[key] : undefined;
  if (fromVoice !== undefined && fromVoice !== null) return finite(fromVoice, SVP_DEFAULTS[key]);
  return SVP_DEFAULTS[key];
}

/**
 * SVP attributes → 宿主 note.vibrato。
 *
 * @param {object} attributes note.attributes（可能为 null）
 * @param {object} voice      ref.voice 的默认颤音参数（可能为 null）
 * @param {number} durationSec 音符时长（秒）
 * @returns {{vibrato: object|null, lossy: string[]}}
 *          vibrato 为 null 表示这个音符没有显式颤音，不该写进宿主文档。
 */
function svpToHostVibrato(attributes, voice, durationSec) {
  if (!hasExplicitVibrato(attributes)) return { vibrato: null, lossy: [] };

  const dur = Math.max(Number(durationSec) || 0, 1e-3);
  const depthSemitones = pick(attributes, voice, 'dF0Vbr');
  const startSec = Math.max(pick(attributes, voice, 'tF0VbrStart'), 0);
  const easeInSec = Math.max(pick(attributes, voice, 'tF0VbrLeft'), 0);
  const easeOutSec = Math.max(pick(attributes, voice, 'tF0VbrRight'), 0);
  const phase = pick(attributes, voice, 'pF0Vbr');
  const frequency = pick(attributes, voice, 'fF0Vbr');

  // SVP 振幅 = dF0Vbr × 0.5 半音；宿主 depth/100 是半音振幅 → depth = dF0Vbr × 50。
  const rawDepth = depthSemitones * 50;
  const rawStart = startSec / dur;
  const rawLength = 1 - rawStart;
  const rawFadeIn = easeInSec / Math.max(rawLength * dur, 1e-3);

  const depth = clamp(rawDepth, ...HOST_LIMITS.depth);
  const rate = clamp(frequency, ...HOST_LIMITS.rate);
  const start = clamp(rawStart, ...HOST_LIMITS.start);
  const length = clamp(rawLength, ...HOST_LIMITS.length);
  const fadeIn = clamp(rawFadeIn, ...HOST_LIMITS.fadeIn);

  const lossy = [];
  if (Math.abs(rawDepth - depth) > 1e-6) lossy.push('depth');
  if (Math.abs(frequency - rate) > 1e-6) lossy.push('rate');
  if (Math.abs(rawStart - start) > 1e-6) lossy.push('start');
  if (Math.abs(rawLength - length) > 1e-6) lossy.push('length');
  if (Math.abs(rawFadeIn - fadeIn) > 1e-6) lossy.push('fadeIn');
  // 相位与渐出在宿主没有承载，属于结构性有损（不是数值截断）。
  if (Math.abs(phase) > 1e-6) lossy.push('phase');
  if (easeOutSec > 1e-6) lossy.push('easeOut');

  return {
    vibrato: {
      enabled: depthSemitones > 0 && depth > 0,
      depth: round(depth, 2),
      rate: round(rate, 3),
      start: round(start, 4),
      length: round(length, 4),
      fadeIn: round(fadeIn, 4),
    },
    lossy,
  };
}

/**
 * 宿主 note.vibrato → SVP attributes（写回）。
 *
 * 相位 / 渐出等宿主没有承载的字段，从 originalAttributes 沿用，避免
 * 「宿主里调一次颤音 → 写回 .svp 把源工程的相位抹掉」。
 *
 * @param {object} vibrato
 * @param {number} durationSec
 * @param {object} [originalAttributes] collectSvpMeta 带回的原始属性快照
 * @returns {object|undefined} undefined 表示不需要写 attributes
 */
function hostToSvpAttributes(vibrato, durationSec, originalAttributes) {
  const kept = {};
  if (originalAttributes && typeof originalAttributes === 'object') {
    for (const key of VIBRATO_KEYS) {
      const value = originalAttributes[key];
      if (value !== undefined && value !== null && Number.isFinite(Number(value))) {
        kept[key] = Number(value);
      }
    }
  }
  if (!vibrato || typeof vibrato !== 'object') {
    return Object.keys(kept).length ? kept : undefined;
  }

  // 宿主「关闭颤音」是 enabled=false，但补全的默认对象里 depth 仍是 80；
  // 直接按 depth 换算会把已关闭的颤音写回成开启。SV 里 depth=0 才表示无颤音
  // （attributes 缺省时 SV 会用 voice 默认 dF0Vbr=1 自动加颤音，所以必须显式
  // 写 0，不能删掉 attributes）。
  if (vibrato.enabled === false) {
    kept.dF0Vbr = 0;
    return Object.keys(kept).length ? kept : undefined;
  }

  const dur = Math.max(Number(durationSec) || 0, 1e-3);
  const startSec = clamp(finite(vibrato.start, 0), 0, 1) * dur;
  const vibLenSec = clamp(finite(vibrato.length, 0), 0, 1) * dur;
  const fadeIn = clamp(finite(vibrato.fadeIn, 0), 0, 1);

  kept.dF0Vbr = round(clamp(finite(vibrato.depth, 0), 0, 200) / 50, 4);
  kept.fF0Vbr = round(clamp(finite(vibrato.rate, 5.5), 2, 10), 3);
  kept.tF0VbrStart = round(startSec, 4);
  kept.tF0VbrLeft = round(fadeIn * vibLenSec, 4);
  // tF0VbrRight / pF0Vbr 沿用 kept 里的原值（若有），宿主没有对应字段可写。
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * 判断组级 vibratoEnv 曲线是否「非平凡」。
 * SV 的颤音包络是 0–2 倍的**深度缩放**，全 1.0 表示没有额外调制，可以安全忽略；
 * 出现其它值说明源工程用了随时间的颤音强度变化，宿主 note.vibrato 无法承载。
 * @param {object} parameters group.parameters
 */
function hasNonTrivialVibratoEnv(parameters) {
  const env = parameters && parameters.vibratoEnv;
  const points = env && Array.isArray(env.points) ? env.points : [];
  for (let i = 1; i < points.length; i += 2) {
    const value = Number(points[i]);
    if (Number.isFinite(value) && Math.abs(value - 1) > 1e-3) return true;
  }
  return false;
}

/**
 * 从 group.notes 里抽出精简的颤音属性快照，随文档扩展域带回，供写回时还原
 * 相位 / 渐出等宿主没有承载的字段。只保留标量、限制数量，避免把整份工程
 * 塞进 ext（host 的 cloneJson 有深度与体积上限）。
 */
function collectNoteAttributes(group) {
  const notes = Array.isArray(group && group.notes) ? group.notes : [];
  const out = [];
  for (let i = 0; i < Math.min(notes.length, MAX_META_NOTES); i += 1) {
    const attributes = notes[i] && notes[i].attributes;
    const kept = {};
    if (attributes && typeof attributes === 'object') {
      for (const key of VIBRATO_KEYS) {
        const value = attributes[key];
        if (value === undefined || value === null) continue;
        if (['string', 'number', 'boolean'].includes(typeof value)) kept[key] = value;
      }
    }
    out.push(Object.keys(kept).length ? kept : null);
  }
  return out.some(Boolean) ? out : null;
}

module.exports = {
  SVP_DEFAULTS,
  VIBRATO_KEYS,
  MAX_META_NOTES,
  hasExplicitVibrato,
  hasNonTrivialVibratoEnv,
  svpToHostVibrato,
  hostToSvpAttributes,
  collectNoteAttributes,
};
