/**
 * pitchCurve 的默认值与归一化 —— 纯函数，主进程/渲染进程/分片编辑器共用。
 *
 * 为什么需要它（审查报告 F2 的同类问题 + 设计方案 §9）：
 *   旧代码在 `fragmentEditor/ipcHandlers.js` 里用**三字段白名单**重建 pitchCurve
 *   （`{ enabled, anchorPoints, brushSegments }`）。任何新字段（auto / bakedSegments）
 *   一旦不在白名单里，打开一次分片编辑器就会在 500ms 自动保存后**永久丢失**，
 *   用户完全无感。这里改用"合并式归一化"：
 *     · 显式列出的字段做类型收敛与夹紧；
 *     · **未识别的字段原样保留**（前向兼容，下一版加字段不会再踩同一个坑）。
 */

import { normalizeAutoConfig, AUTO_PITCH_DEFAULTS } from './autoPitchCurve.js';

const ANCHOR_SMOOTHNESS_DEFAULT = 30;
const ANCHOR_STRENGTH_DEFAULT = 100;

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** 单个锚点/派生段点的归一化（非法项返回 null）。 */
function normalizePoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const time = Number(raw.time);
  const pitch = Number(raw.pitch);
  if (!Number.isFinite(time) || !Number.isFinite(pitch)) return null;
  return {
    ...raw,
    time: Math.max(0, time),
    pitch,
    strength: clamp(raw.strength ?? ANCHOR_STRENGTH_DEFAULT, 0, 100, ANCHOR_STRENGTH_DEFAULT),
    smoothness: clamp(raw.smoothness ?? 0, 0, 100, 0),
  };
}

function normalizeAnchors(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    const p = normalizePoint(a);
    if (p) out.push(p);
  }
  return out;
}

function normalizeBrushSegments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const seg of list) {
    const pts = Array.isArray(seg && seg.points) ? seg.points : null;
    if (!pts || pts.length < 2) continue;
    const points = [];
    for (const pt of pts) {
      const time = Number(pt && pt.time);
      const pitch = Number(pt && pt.pitch);
      if (Number.isFinite(time) && Number.isFinite(pitch)) points.push({ time: Math.max(0, time), pitch });
    }
    if (points.length >= 2) out.push({ ...seg, points });
  }
  return out;
}

function normalizeBakedSegments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  let seq = 0;
  for (const seg of list) {
    if (!seg || typeof seg !== 'object') continue;
    const start = Number(seg.start);
    const end = Number(seg.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const points = normalizeAnchors(seg.points).sort((a, b) => a.time - b.time);
    if (points.length === 0) continue;
    out.push({
      ...seg,
      id: typeof seg.id === 'string' && seg.id ? seg.id : `bk_${Date.now().toString(36)}_${seq++}`,
      start,
      end,
      origin: seg.origin === 'f0-import' || seg.origin === 'auto-drag' ? seg.origin : 'auto-drag',
      points,
    });
  }
  return out;
}

/**
 * 新建分片用的默认 pitchCurve。
 * @param {{autoDefault?:boolean}} [opts] autoDefault=true 用于"新建分片"（开箱即用）；
 *        加载旧工程时必须为 false —— 旧工程听感要逐位不变。
 */
export function createDefaultPitchCurve(opts = {}) {
  const autoDefault = opts.autoDefault === true;
  return {
    enabled: true,
    auto: {
      enabled: autoDefault,
      preset: 'natural',
      version: 1,
      params: { ...AUTO_PITCH_DEFAULTS, autoVibrato: { ...AUTO_PITCH_DEFAULTS.autoVibrato } },
    },
    anchorPoints: [],
    brushSegments: [],
    bakedSegments: [],
  };
}

/**
 * 合并式归一化：补默认 + 夹紧 + 丢弃非法项 + **保留未知字段**。
 *
 * @param {object|null} raw 工程里的 pitchCurve
 * @param {{autoDefault?:boolean}} [opts] 仅当 raw 里完全没有 auto 字段时生效
 *        （加载工程 → false；新建分片 → true）
 */
export function normalizePitchCurve(raw, opts = {}) {
  const src = raw && typeof raw === 'object' ? raw : null;
  const autoDefault = opts.autoDefault === true;
  if (!src) return createDefaultPitchCurve({ autoDefault });

  const hasAuto = src.auto && typeof src.auto === 'object';
  const auto = hasAuto
    ? normalizeAutoConfig(src.auto)
    : { ...createDefaultPitchCurve({ autoDefault }).auto };

  return {
    ...src,                                  // ← 保留未知字段（前向兼容）
    enabled: src.enabled !== false,
    auto,
    anchorPoints: normalizeAnchors(src.anchorPoints),
    brushSegments: normalizeBrushSegments(src.brushSegments),
    bakedSegments: normalizeBakedSegments(src.bakedSegments),
  };
}

/** 该 pitchCurve 是否含任何手动内容（用于"自动/手动/混合"徽标）。 */
export function hasManualContent(pitchCurve) {
  if (!pitchCurve) return false;
  return (pitchCurve.anchorPoints?.length ?? 0) > 0
    || (pitchCurve.brushSegments?.length ?? 0) > 0
    || (pitchCurve.bakedSegments?.length ?? 0) > 0;
}
