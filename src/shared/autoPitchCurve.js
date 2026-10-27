/**
 * 自动音高曲线引擎 —— 纯函数、无 DOM、无 state。
 *
 * 设计要点（详见《SXSEditor 自动音高曲线设计方案》）：
 *   1. 自动曲线是**派生量**：由「音符 + 参数」实时计算，不落锚点。
 *      因此改音符自动跟随、工程文件只存十几个参数（而非 4500 个锚点）。
 *   2. 手动层（锚点/笔刷/派生段）通过**作用域**（coverage）覆盖自动层：
 *      作用域内用手动求值，作用域外用自动；两者边界做 crossfade。
 *   3. auto 只负责「有音符语义」的表现力（起音/过冲/预备/滑音/句尾/颤音填充/抖动）；
 *      「无音符语义」的信号清洁（中值/SG 平滑）留给音色面板的 F0 后处理。
 *
 * 该模块被两条消费路径共同 import（分片编辑器 buildPitchCurveF0Data、主窗口
 * buildFragmentPitchCurveF0）—— 不要在任何一条路径里再复刻一份数学。
 */

import {
  sortAnchors,
  buildEffectiveValues,
  evalSortedCurve,
} from '../fragmentEditor/automationCurve.js';

// ==================== 参数与预设 ====================

/**
 * 自动曲线默认参数（"Natural" 预设）。
 * 数值依据：真人颤音 3–9Hz / 15–30 音分、起音过冲 10–25 音分、
 * 换音过渡 60–140ms、句尾下滑 15–35 音分（设计方案 §4）。
 */
export const AUTO_PITCH_DEFAULTS = {
  // 起音
  attackMs: 60,
  attackCents: -60,
  // 过冲与预备
  // 过冲 = 音程 × ratio，上限 cap。真人歌唱的过冲约 3–4% 音程：
  // 7 半音跳进 ~25 音分、5 半音 ~20、3 半音 ~12，都落在"10–25 音分"的
  // 自然区间；原来的 ratio 0.25 会让任何 ≥2 半音的跳进直接顶到上限（40），
  // 听起来像刻意滑上去再拉回来。
  overshootRatio: 0.04,
  overshootMaxCents: 25,
  overshootMs: 120,
  prepCents: -15,
  prepMs: 30,
  prepMinSemitones: 2,
  // 滑音
  glideMs: 90,
  glideUnit: 'ms',
  glideAutoScale: true,
  glideMinSemitones: 2,
  glideCurve: 'bezier',
  // 句尾
  releaseRatio: 0.15,
  releaseCents: -25,
  // 抖动
  jitterCents: 6,
  jitterSource: 'synth',
  jitterStage: 'post',
  seed: 0,
  // 自动颤音填充（写入 note.vibrato，不是私有层）
  autoVibrato: {
    enabled: true,
    minDurationBeats: 1.5,
    depth: 22,
    rate: 5.5,
    drift: 6,
    depthDrift: 8,
    start: 0.25,
    length: 0.75,
    fadeIn: 0.35,
  },
  // 其它
  quantize: 0,
  crossfadeMs: 25,
  glideOwnership: 'auto',
  mergeGapBeats: 0.5,
};

/** 预设：只写需要覆盖的字段，其余继承默认值。 */
export const AUTO_PITCH_PRESETS = {
  off: { _disabled: true },
  soft: {
    attackMs: 80, attackCents: -40,
    overshootRatio: 0.15, overshootMaxCents: 25,
    prepCents: -10, glideMs: 120, glideMinSemitones: 3,
    releaseCents: -15, jitterCents: 3,
    autoVibrato: { ...AUTO_PITCH_DEFAULTS.autoVibrato, depth: 18, rate: 5.0 },
  },
  natural: {},
  power: {
    attackMs: 40, attackCents: -90,
    overshootRatio: 0.35, overshootMaxCents: 70,
    prepCents: -20, glideMs: 60, glideMinSemitones: 2,
    releaseCents: -35, jitterCents: 10,
    autoVibrato: { ...AUTO_PITCH_DEFAULTS.autoVibrato, depth: 30, rate: 6.2, drift: 10 },
  },
  ballad: {
    attackMs: 100, attackCents: -50,
    overshootRatio: 0.20, overshootMaxCents: 30,
    prepCents: -12, glideMs: 140, glideMinSemitones: 1,
    releaseCents: -30, jitterCents: 4,
    autoVibrato: { ...AUTO_PITCH_DEFAULTS.autoVibrato, depth: 24, rate: 5.2, drift: 4 },
  },
};

export const AUTO_PITCH_PRESET_IDS = ['off', 'soft', 'natural', 'power', 'ballad'];

// 各参数的合法区间（归一化时夹紧，UI 也用它做滑块范围）
export const AUTO_PITCH_PARAM_RANGES = {
  attackMs: [0, 200], attackCents: [-200, 50],
  overshootRatio: [0, 0.6], overshootMaxCents: [0, 120], overshootMs: [30, 300],
  prepCents: [-60, 0], prepMs: [0, 80], prepMinSemitones: [0, 12],
  glideMs: [0, 300], glideMinSemitones: [0, 12],
  releaseRatio: [0, 0.5], releaseCents: [-100, 0],
  jitterCents: [0, 25],
  quantize: [0, 1],
  crossfadeMs: [0, 100],
  mergeGapBeats: [0, 4],
};

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** 归一化 auto 配置：合并默认值 + 夹紧 + 校验枚举。旧工程缺字段时等价于"关闭"。 */
export function normalizeAutoConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : null;
  if (!src) return { enabled: false, preset: 'natural', version: 1, params: { ...AUTO_PITCH_DEFAULTS } };
  const p = src.params && typeof src.params === 'object' ? src.params : {};
  const out = { ...AUTO_PITCH_DEFAULTS };
  for (const [k, range] of Object.entries(AUTO_PITCH_PARAM_RANGES)) {
    out[k] = clampNum(p[k], range[0], range[1], AUTO_PITCH_DEFAULTS[k]);
  }
  // 枚举
  if (p.glideUnit === 'beats' || p.glideUnit === 'ms') out.glideUnit = p.glideUnit;
  if (p.glideCurve === 'linear' || p.glideCurve === 'bezier' || p.glideCurve === 'exp') out.glideCurve = p.glideCurve;
  if (p.jitterSource === 'singer' || p.jitterSource === 'synth') out.jitterSource = p.jitterSource;
  if (p.jitterStage === 'pre' || p.jitterStage === 'post') out.jitterStage = p.jitterStage;
  if (p.glideOwnership === 'auto' || p.glideOwnership === 'post' || p.glideOwnership === 'both') {
    out.glideOwnership = p.glideOwnership;
  }
  if (Number.isFinite(Number(p.seed))) out.seed = Math.floor(Number(p.seed));
  // 自动颤音（嵌套）
  const av = p.autoVibrato && typeof p.autoVibrato === 'object' ? p.autoVibrato : {};
  out.autoVibrato = {
    enabled: av.enabled !== false && AUTO_PITCH_DEFAULTS.autoVibrato.enabled,
    minDurationBeats: clampNum(av.minDurationBeats, 0.25, 8, AUTO_PITCH_DEFAULTS.autoVibrato.minDurationBeats),
    depth: clampNum(av.depth, 0, 100, AUTO_PITCH_DEFAULTS.autoVibrato.depth),
    rate: clampNum(av.rate, 1, 12, AUTO_PITCH_DEFAULTS.autoVibrato.rate),
    drift: clampNum(av.drift, 0, 30, AUTO_PITCH_DEFAULTS.autoVibrato.drift),
    depthDrift: clampNum(av.depthDrift, 0, 40, AUTO_PITCH_DEFAULTS.autoVibrato.depthDrift),
    start: clampNum(av.start, 0, 1, AUTO_PITCH_DEFAULTS.autoVibrato.start),
    length: clampNum(av.length, 0, 1, AUTO_PITCH_DEFAULTS.autoVibrato.length),
    fadeIn: clampNum(av.fadeIn, 0, 1, AUTO_PITCH_DEFAULTS.autoVibrato.fadeIn),
  };
  const preset = AUTO_PITCH_PRESET_IDS.includes(src.preset) ? src.preset : 'custom';
  return {
    enabled: src.enabled === true,
    preset,
    version: Number.isFinite(Number(src.version)) ? Number(src.version) : 1,
    params: out,
  };
}

/** 取某个预设的完整参数（用于"应用预设"）。 */
export function paramsForPreset(presetId) {
  const patch = AUTO_PITCH_PRESETS[presetId] || {};
  const merged = { ...AUTO_PITCH_DEFAULTS, ...patch };
  if (patch.autoVibrato) merged.autoVibrato = { ...AUTO_PITCH_DEFAULTS.autoVibrato, ...patch.autoVibrato };
  delete merged._disabled;
  return merged;
}

/** 该预设是否等于"关闭"。 */
export function isPresetOff(presetId) {
  return presetId === 'off';
}

/**
 * 解析某音符实际生效的参数：音符级 autoPitch 覆盖 > 分片 auto.params。
 * @param {object} auto 归一化后的 auto 配置
 * @param {object} note
 */
export function resolveAutoParams(auto, note) {
  const base = (auto && auto.params) || AUTO_PITCH_DEFAULTS;
  const o = note && note.autoPitch;
  if (!o || typeof o !== 'object') return base;
  if (o.preset && AUTO_PITCH_PRESETS[o.preset]) {
    return { ...paramsForPreset(o.preset), ...(o.params || {}) };
  }
  return { ...base, ...(o.params || {}) };
}

// ==================== 音符定位 ====================

/** 二分查找包含 beat 的音符（notes 需按 start 升序）。 */
export function findNoteAtBeat(sortedNotes, beat) {
  if (!sortedNotes || sortedNotes.length === 0) return null;
  let lo = 0;
  let hi = sortedNotes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const note = sortedNotes[mid];
    if (beat < note.start) hi = mid - 1;
    else if (beat >= note.start + note.duration) lo = mid + 1;
    else return note;
  }
  return null;
}

/** 休止 / 换气 / 音高缺失：不生成自动曲线。 */
function isUnvoiced(note) {
  if (!note) return true;
  if (!(note.pitch > 0)) return true;
  const lyric = String(note.lyric || '').trim();
  return lyric === '<AP>' || lyric === '<SP>';
}

/** 前一个"发声"音符（用于滑音/预备的音程判断）。 */
function prevVoicedNote(sortedNotes, note) {
  const idx = sortedNotes.indexOf(note);
  for (let i = idx - 1; i >= 0; i--) {
    if (!isUnvoiced(sortedNotes[i])) return sortedNotes[i];
  }
  return null;
}

/** 后一个"发声"音符。 */
function nextVoicedNote(sortedNotes, note) {
  const idx = sortedNotes.indexOf(note);
  for (let i = idx + 1; i < sortedNotes.length; i++) {
    if (!isUnvoiced(sortedNotes[i])) return sortedNotes[i];
  }
  return null;
}

// ==================== 数学辅助 ====================

/** 三次贝塞尔（与 f0Smoothing.cubicBezierY 同形，避免 shared → fragmentEditor 的方向依赖反转）。 */
function bezierEase(u) {
  const t = u <= 0 ? 0 : u >= 1 ? 1 : u;
  return t * t * (3 - 2 * t);
}

/** 确定性伪随机 [0,1)：同一 (seed, salt) 永远得到同一序列。 */
function hash01(seed, salt) {
  let x = (Math.imul(seed | 0, 374761393) + Math.imul(salt | 0, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** 滑音时长（秒）：glideAutoScale 时按速度缩放（快歌收紧、慢歌放宽）。 */
function glideSeconds(p, bpm) {
  const raw = p.glideUnit === 'beats' ? (p.glideMs / 1000) * (bpm / 60) : p.glideMs / 1000;
  if (!p.glideAutoScale) return Math.max(0, raw);
  const scale = bpm < 80 ? 1.5 : bpm > 140 ? 0.6 : 1;
  return Math.max(0, raw * scale);
}

// ==================== 单帧自动音高 ====================

/**
 * 某时刻的自动音高（MIDI 绝对音高）。返回 null 表示"无自动覆盖"，
 * 由调用方回退到 note.pitch（保持既有行为）。
 *
 * @param {object} ctx
 * @param {Array} ctx.sortedNotes 已按 start 升序的音符
 * @param {object} ctx.auto 归一化后的 auto 配置
 * @param {number} ctx.bpm
 * @param {{min:number,max:number}} ctx.ranges 模型训练音域
 * @param {number} beat
 * @returns {number|null}
 */
export function autoPitchAt(ctx, beat, options = {}) {
  const { sortedNotes, auto, bpm, ranges } = ctx;
  const includeJitter = options.includeJitter !== false;
  if (!auto || !auto.enabled) return null;
  const note = findNoteAtBeat(sortedNotes, beat);
  if (!note || isUnvoiced(note)) return null;
  const p = resolveAutoParams(auto, note);
  if (isPresetOff(auto.preset) && !(note.autoPitch && note.autoPitch.preset)) return null;

  const durSec = (note.duration / bpm) * 60;
  const ageSec = ((beat - note.start) / bpm) * 60;
  if (!(durSec > 0)) return null;
  const prev = prevVoicedNote(sortedNotes, note);
  const next = nextVoicedNote(sortedNotes, note);
  const interval = prev ? note.pitch - prev.pitch : 0;

  let v = note.pitch;

  // ---- 1) 滑音：只在音程 >= glideMinSemitones 时启用，过渡完全落在新音符内部
  //        （从 prev.pitch 滑向 note.pitch），避免跨音符求值顺序问题。
  const glideSec = glideSeconds(p, bpm);
  // glideOwnership='post' 时换音过渡交给音色面板的 f0Glide，自动层不重复做
  const useGlide = p.glideOwnership !== 'post'
    && prev && Math.abs(interval) >= p.glideMinSemitones && glideSec > 0;
  if (useGlide && ageSec < glideSec) {
    const u = ageSec / glideSec;
    v = note.pitch - interval * (1 - bezierEase(u));
  }

  // ---- 2) 起音上滑：仅在没有滑音时生效（否则会从低音二次下滑）
  const attackSec = p.attackMs / 1000;
  if (!useGlide && attackSec > 0 && ageSec < attackSec) {
    v += (p.attackCents / 100) * (1 - ageSec / attackSec);
  }

  // ---- 3) 起音过冲：音程比例 + 上限，指数衰减。
  //        起点必须落在**滑音结束之后** —— 否则滑音还在往上爬时就叠加过冲，
  //        两者在时间上互相抵消（实测 7 半音跳进时过冲从 40 音分掉到 10 音分）。
  const overSec = p.overshootMs / 1000;
  const overAge = ageSec - (useGlide ? glideSec : 0);
  if (overSec > 0 && overAge >= 0 && overAge < overSec) {
    const amp = Math.min(p.overshootMaxCents, Math.abs(interval) * 100 * p.overshootRatio) / 100;
    if (amp > 0) v += amp * Math.exp((-3 * overAge) / overSec);
  }

  // ---- 4) 预备（跳进前朝反方向）+ 句尾下滑：二者互斥，预备优先
  const remSec = durSec - ageSec;
  const nextInterval = next ? next.pitch - note.pitch : 0;
  const prepSec = p.prepMs / 1000;
  const usePrep = next && Math.abs(nextInterval) >= p.prepMinSemitones && prepSec > 0 && remSec < prepSec;
  if (usePrep) {
    const dir = nextInterval > 0 ? -1 : 1;   // 与即将到来的跳进方向相反
    const w = 1 - remSec / prepSec;
    v += (dir * Math.abs(p.prepCents) / 100) * bezierEase(w);
  } else if (p.releaseRatio > 0 && p.releaseCents !== 0) {
    const relSec = p.releaseRatio * durSec;
    if (relSec > 0 && remSec < relSec) {
      v += (p.releaseCents / 100) * (1 - remSec / relSec);
    }
  }

  // ---- 5) 抖动：两路低频正弦叠加（比逐帧白噪声更接近真人慢抖动）。
  //        jitterStage='post' 时曲线层不加，改由 applyJitterToF0 在后处理之后
  //        叠加 —— 否则会被音色面板的中值/SG 平滑削掉（实测只剩 51%）。
  if (includeJitter && p.jitterCents > 0) {
    v += _jitterSemitones(p, note, ageSec);
  }

  // ---- 6) 自动颤音
  //       长音没有颤音是"机械感"的最大来源。这里只在 note 本身**没有**启用
  //       逐音符颤音时叠加，避免与 computeVibratoOffset 双重叠加 ——
  //       两条路径互斥，用户手设的颤音永远优先。
  //       注意：不改写 note.vibrato（那是用户资产），完全由参数派生。
  const av = p.autoVibrato || AUTO_PITCH_DEFAULTS.autoVibrato;
  const vibratoOn = av.enabled && durSec * (bpm / 60) >= av.minDurationBeats
    && !(note.vibrato && note.vibrato.enabled);
  if (vibratoOn && av.depth > 0) {
    // 渐入：起音/滑音还没结束时不上颤音（否则会和滑音打架）
    const fadeIn = Number.isFinite(av.fadeIn) ? av.fadeIn : 0.35;
    const ramp = Math.min(1, Math.max(0, (ageSec - fadeIn) / 0.5));
    if (ramp > 0) {
      // rateDrift：真人颤音在周期末尾常略加快。用"相位 = 2π·rate·t·(1+drift·t/dur)"
      // 表达，等价于速率从 rate 线性增长到 rate·(1+drift)，不需要改相位累加器。
      const drift = (Number.isFinite(av.drift) ? av.drift : 0) / 100;
      const tNorm = durSec > 0 ? Math.min(1, ageSec / durSec) : 0;
      const phase = 2 * Math.PI * av.rate * ageSec * (1 + drift * tNorm);
      v += (av.depth / 100) * ramp * Math.sin(phase);
    }
  }

  // ---- 7) 半音吸附 + 音域夹紧
  if (p.quantize > 0) v = Math.round(v / p.quantize) * p.quantize;
  if (ranges && Number.isFinite(ranges.min) && Number.isFinite(ranges.max)) {
    v = Math.max(ranges.min, Math.min(ranges.max, v));
  }
  return v;
}

/**
 * 采样一段自动曲线（用于拖动派生）。
 * @returns {Array<{time:number,pitch:number}>}
 */
export function buildAutoCurve(ctx, fromBeat, toBeat, stepBeats = 0.05) {
  const out = [];
  const step = Math.max(1e-4, stepBeats);
  for (let t = fromBeat; t <= toBeat + 1e-9; t += step) {
    const v = autoPitchAt(ctx, t);
    if (v !== null) out.push({ time: t, pitch: v });
  }
  return out;
}

// ==================== 手动作用域 ====================

/**
 * 计算手动层的作用域（区间并集，按 mergeGapBeats 合并）。
 *
 * 规则（设计方案 §3.2）：
 *   · 手动锚点 → 所在音符区间 ∪ 锚点凸包（单锚点退化为所在音符）
 *   · 笔刷段   → 段自身区间
 *   · 派生段   → 段自身区间
 *
 * @param {object} pitchCurve
 * @param {Array} sortedNotes 已排序音符
 * @param {{mergeGapBeats?:number}} [opts]
 * @returns {Array<{start:number,end:number,kind:string}>}
 */
export function computeManualCoverage(pitchCurve, sortedNotes, opts = {}) {
  const mergeGap = Number.isFinite(opts.mergeGapBeats) ? opts.mergeGapBeats : AUTO_PITCH_DEFAULTS.mergeGapBeats;
  const pc = pitchCurve || {};
  const raw = [];

  for (const seg of pc.brushSegments || []) {
    const pts = seg && seg.points;
    if (pts && pts.length >= 2) raw.push({ start: pts[0].time, end: pts[pts.length - 1].time, kind: 'brush' });
  }
  for (const seg of pc.bakedSegments || []) {
    if (seg && Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start) {
      raw.push({ start: seg.start, end: seg.end, kind: seg.origin || 'baked' });
    }
  }
  const anchors = (pc.anchorPoints || []).filter((a) => a && Number.isFinite(a.time));
  if (anchors.length > 0) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const a of anchors) { if (a.time < lo) lo = a.time; if (a.time > hi) hi = a.time; }
    raw.push({ start: lo, end: hi, kind: 'anchor' });
    // 锚点所在音符区间：让"点一下就把这个音变成手动"成立
    for (const a of anchors) {
      const n = findNoteAtBeat(sortedNotes, a.time);
      if (n) raw.push({ start: n.start, end: n.start + n.duration, kind: 'anchor' });
    }
  }

  raw.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of raw) {
    if (!(r.end >= r.start)) continue;
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + mergeGap) {
      last.end = Math.max(last.end, r.end);
      if (!last.kind.split('+').includes(r.kind)) last.kind += '+' + r.kind;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** beat 是否落在某个作用域内（返回命中的区间或 null）。 */
export function coverageAt(coverage, beat) {
  if (!coverage || coverage.length === 0) return null;
  for (const r of coverage) {
    if (beat >= r.start && beat <= r.end) return r;
  }
  return null;
}

/** 作用域边界的过渡权重：0 = 完全自动，1 = 完全手动（边界内侧 25ms 线性过渡）。 */
export function boundaryWeight(coverage, beat, bpm, crossfadeMs) {
  if (!coverage || coverage.length === 0 || !(crossfadeMs > 0)) return 1;
  const fadeBeats = (crossfadeMs / 1000) * (bpm / 60);
  const r = coverageAt(coverage, beat);
  if (!r) return 0;
  const dIn = Math.min(beat - r.start, r.end - beat);
  if (dIn >= fadeBeats) return 1;
  return Math.max(0, dIn / fadeBeats);
}

// ==================== 手动求值 ====================

/**
 * 手动层求值（锚点 → 笔刷 → 派生段）。无手动内容返回 null。
 *
 * 注意：锚点存在时，**区间外延续首/末锚点值**（F4 修复），不再回落到 note.pitch。
 * 这与 renderer/f0Utils 与 fragmentEditor/canvasRenderer 的行为保持一致。
 */
export function evalManualAt(pitchCurve, beat) {
  const pc = pitchCurve;
  if (!pc) return null;

  const anchors = pc.anchorPoints || [];
  if (anchors.length > 0) {
    const sorted = sortAnchors(anchors);
    const eff = buildEffectiveValues(sorted, 'pitch');
    const firstT = sorted[0].time;
    const lastT = sorted[sorted.length - 1].time;
    if (beat >= firstT && beat <= lastT) {
      const v = evalSortedCurve(sorted, eff, beat);
      if (v !== null && Number.isFinite(v)) return v;
    }
    const brush = evalBrushAt(pc, beat);
    if (brush !== null) return brush;
    return beat < firstT ? eff[0] : eff[eff.length - 1];
  }

  const brush = evalBrushAt(pc, beat);
  if (brush !== null) return brush;

  return evalBakedAt(pc, beat);
}

function evalBrushAt(pc, beat) {
  for (const seg of pc.brushSegments || []) {
    const pts = seg && seg.points;
    if (!pts || pts.length < 2) continue;
    if (beat >= pts[0].time && beat <= pts[pts.length - 1].time) {
      for (let i = 0; i < pts.length - 1; i++) {
        if (beat >= pts[i].time && beat <= pts[i + 1].time) {
          const span = pts[i + 1].time - pts[i].time;
          const t = span > 0 ? (beat - pts[i].time) / span : 0;
          return pts[i].pitch + t * (pts[i + 1].pitch - pts[i].pitch);
        }
      }
    }
  }
  return null;
}

function evalBakedAt(pc, beat) {
  for (const seg of pc.bakedSegments || []) {
    const pts = seg && seg.points;
    if (!pts || pts.length === 0) continue;
    if (beat < seg.start || beat > seg.end) continue;
    if (pts.length === 1) return pts[0].pitch;
    const sorted = sortAnchors(pts);
    const eff = buildEffectiveValues(sorted, 'pitch');
    const v = evalSortedCurve(sorted, eff, beat);
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

// ==================== 统一求值入口 ====================

/**
 * 曲线层音高（不含颤音 —— 颤音仍由调用方叠加，保持既有结构）。
 *
 * 优先级：手动（作用域内）> 自动 > null（调用方回退 note.pitch）
 * 边界：作用域边界 25ms 内做 自动↔手动 线性 crossfade，避免阶跃。
 *
 * @param {object} ctx { pitchCurve, auto, sortedNotes, bpm, ranges, coverage }
 * @param {number} beat
 * @returns {number|null}
 */
export function resolveCurvePitchAt(ctx, beat) {
  const { pitchCurve, auto, bpm, coverage } = ctx;
  const inCoverage = coverageAt(coverage, beat);
  const manual = inCoverage ? evalManualAt(pitchCurve, beat) : null;
  const autoV = autoPitchAt(ctx, beat);

  if (manual !== null && autoV !== null) {
    const w = boundaryWeight(coverage, beat, bpm, (auto && auto.params && auto.params.crossfadeMs) ?? 25);
    return autoV * (1 - w) + manual * w;
  }
  if (manual !== null) return manual;
  return autoV;
}

// ==================== 自动颤音填充 ====================

/**
 * 为长音符自动补 `note.vibrato`（不改已启用颤音的音符）。
 * 返回实际改动的音符数 —— 调用方据此决定是否 bump notesVersion / 触发保存。
 *
 * 为什么写进 note.vibrato 而不是 auto 私有层：现有颤音已是每音符可编辑参数，
 * 复用后用户能逐音符改、能撤销、能导出，且不会与合成路径产生第二套叠加。
 *
 * @param {Array} notes 原地修改
 * @param {object} auto 归一化后的 auto 配置
 * @param {(note:object)=>boolean} [shouldSkip]
 * @returns {number} 改动数量
 */
export function applyAutoVibrato(notes, auto, shouldSkip) {
  const cfg = auto && auto.params && auto.params.autoVibrato;
  if (!auto || !auto.enabled || !cfg || !cfg.enabled) return 0;
  let changed = 0;
  for (const note of notes || []) {
    if (!note || isUnvoiced(note)) continue;
    if (shouldSkip && shouldSkip(note)) continue;
    if (note.duration < cfg.minDurationBeats) continue;
    if (note.vibrato && note.vibrato.enabled) continue;   // 用户已启用，尊重
    note.vibrato = {
      enabled: true,
      depth: cfg.depth,
      rate: cfg.rate,
      start: cfg.start,
      length: cfg.length,
      fadeIn: cfg.fadeIn,
      rateDrift: cfg.drift,
      depthDrift: cfg.depthDrift,
      auto: true,       // 标记来源，便于 UI 区分"自动填充"与"用户设置"
    };
    changed++;
  }
  return changed;
}

/**
 * 单音符在某时刻的抖动偏移（半音）。
 * 每音符用 (seed, note.id) 派生相位/频率 → 撤销/重做与导出可复现。
 */
function _jitterSemitones(p, note, ageSec) {
  if (!(p.jitterCents > 0)) return 0;
  const salt = typeof note.id === 'number' ? note.id : String(note.id).length;
  const s = (p.seed | 0) + salt * 7919;

  // ---- 高频抖动（jitter 的本义）：声带逐周期随机，约 5ms 一格 ----
  // 必须是**宽带随机**而不是慢正弦：原来的实现只有 3–6Hz 两路正弦，与颤音
  // 落在同一频段，既测不出来（自检用高通分离时会被当成颤音减掉），听感上也
  // 只是"音高在飘"而不是"声音有颗粒感"。用 (seed, 网格) 派生 → 导出/撤销可复现。
  const grid = Math.floor(ageSec * 200); // 5ms
  const rnd = hash01(s + grid * 131, 7) * 2 - 1; // -1..1

  // ---- 低频漂移：气息导致的缓慢游移（权重小，保留"不是机器"的底噪）----
  const f1 = 3.1 + hash01(s, 1) * 1.8;
  const f2 = 5.7 + hash01(s, 2) * 2.2;
  const ph1 = hash01(s, 3) * Math.PI * 2;
  const ph2 = hash01(s, 4) * Math.PI * 2;
  const drift = 0.12 * Math.sin(2 * Math.PI * f1 * ageSec + ph1)
    + 0.08 * Math.sin(2 * Math.PI * f2 * ageSec + ph2);

  // jitterCents 的定义：逐点抖动的**标准差量级**（均匀分布 std ≈ 0.577×幅度），
  // 所以 6¢ 的默认值对应"每帧随机 ±6¢"，落在真人 3–10¢ 的区间内。
  return (p.jitterCents / 100) * (rnd + drift);
}

/**
 * 把自动抖动叠加到已生成的 F0 上（**后处理之后**调用）。
 *
 * 为什么需要：音色面板的 f0Smooth(SG) 会把抖动削掉约一半、f0Median 削掉 37–52%
 * （实测）。把抖动放到滤波之后，两者就不再互相抵消：
 * 后处理负责"信号清洁"，自动曲线负责"表现力"。
 *
 * @param {Float32Array} f0 Hz，0=清音
 * @param {object} ctx 同 autoPitchAt
 * @param {{sampleRate:number, hopSize:number}} fmt
 * @returns {Float32Array} 新数组
 */
export function applyJitterToF0(f0, ctx, fmt) {
  const { auto, bpm, sortedNotes } = ctx;
  if (!f0 || f0.length === 0) return f0;
  if (!auto || !auto.enabled) return f0;
  const { sampleRate, hopSize } = fmt || {};
  if (!(sampleRate > 0) || !(hopSize > 0)) return f0;
  const out = new Float32Array(f0);
  for (let i = 0; i < out.length; i++) {
    if (!(out[i] > 0)) continue;
    const beat = ((i * hopSize) / sampleRate / 60) * bpm;
    const note = findNoteAtBeat(sortedNotes, beat);
    if (!note || isUnvoiced(note)) continue;
    const p = resolveAutoParams(auto, note);
    if (!(p.jitterCents > 0)) continue;
    const ageSec = ((beat - note.start) / bpm) * 60;
    const semis = _jitterSemitones(p, note, ageSec);
    if (semis !== 0) out[i] *= Math.pow(2, semis / 12);
  }
  return out;
}

/**
 * 预构建的求值器 —— 热路径（渲染每帧数千次、F0 构建每帧一次）必须用它，
 * 不要每帧调用 resolveCurvePitchAt（那会重复排序锚点、重算强度有效值）。
 *
 * 一次构建、多次求值：
 *   · 锚点排序 + 强度有效值 + 笔刷/派生段索引；
 *   · 手动作用域（coverage）；
 *   · 音符数组排序。
 *
 * @param {object} ctx { pitchCurve, auto, sortedNotes?, notes?, bpm, ranges }
 * @returns {{pitchAt:(beat:number)=>number|null, manualAt:(beat:number)=>number|null,
 *            autoAt:(beat:number)=>number|null, coverage:Array, coverageAt:(beat:number)=>object|null}}
 */
export function createPitchResolver(ctx) {
  const pc = ctx.pitchCurve || {};
  const bpm = ctx.bpm;
  const auto = ctx.auto || (pc.auto ? pc.auto : null);
  const sortedNotes = ctx.sortedNotes
    || (ctx.notes ? ctx.notes.slice().sort((a, b) => a.start - b.start || b.duration - a.duration) : []);
  const ranges = ctx.ranges || null;

  // 锚点预排序 + 强度有效值（只算一次）
  const rawAnchors = pc.anchorPoints || [];
  const sortedAnchors = rawAnchors.length > 0 ? sortAnchors(rawAnchors) : [];
  const effAnchors = sortedAnchors.length > 0 ? buildEffectiveValues(sortedAnchors, 'pitch') : null;

  // 派生段预排序
  const bakedSegs = (pc.bakedSegments || [])
    .filter((seg) => seg && Array.isArray(seg.points) && seg.points.length > 0 && seg.end > seg.start)
    .map((seg) => {
      const pts = sortAnchors(seg.points);
      return { ...seg, pts, eff: buildEffectiveValues(pts, 'pitch') };
    })
    .sort((a, b) => a.start - b.start);

  const includeJitter = ctx.includeJitter !== false;
  const autoCtx = { sortedNotes, auto, bpm, ranges };
  const mergeGap = auto && auto.params ? auto.params.mergeGapBeats : AUTO_PITCH_DEFAULTS.mergeGapBeats;
  const coverage = computeManualCoverage(pc, sortedNotes, { mergeGapBeats: mergeGap });
  const crossfadeMs = auto && auto.params ? auto.params.crossfadeMs : AUTO_PITCH_DEFAULTS.crossfadeMs;

  function manualAt(beat) {
    if (sortedAnchors.length > 0) {
      const firstT = sortedAnchors[0].time;
      const lastT = sortedAnchors[sortedAnchors.length - 1].time;
      if (beat >= firstT && beat <= lastT) {
        const v = evalSortedCurve(sortedAnchors, effAnchors, beat);
        if (v !== null && Number.isFinite(v)) return v;
      }
      const brush = evalBrushAt(pc, beat);
      if (brush !== null) return brush;
      // F4：区间外延续首/末锚点值，不回落到 note.pitch
      return beat < firstT ? effAnchors[0] : effAnchors[effAnchors.length - 1];
    }
    const brush = evalBrushAt(pc, beat);
    if (brush !== null) return brush;
    for (const seg of bakedSegs) {
      if (beat < seg.start || beat > seg.end) continue;
      const v = evalSortedCurve(seg.pts, seg.eff, beat);
      if (v !== null && Number.isFinite(v)) return v;
    }
    return null;
  }

  function pitchAt(beat) {
    const cov = coverageAt(coverage, beat);
    const manual = cov ? manualAt(beat) : null;
    const autoV = autoPitchAt(autoCtx, beat, { includeJitter });
    if (manual !== null && autoV !== null) {
      const w = boundaryWeight(coverage, beat, bpm, crossfadeMs);
      return autoV * (1 - w) + manual * w;
    }
    if (manual !== null) return manual;
    return autoV;
  }

  return {
    pitchAt,
    manualAt,
    autoAt: (beat) => autoPitchAt(autoCtx, beat, { includeJitter }),
    coverage,
    coverageAt: (beat) => coverageAt(coverage, beat),
    sortedNotes,
    autoCfg: auto,
  };
}

/** 按音符语言解析模型训练音域（base [28,88] / ja [48,84]）。 */
export function resolvePitchRanges(notes) {
  let hasJapanese = false;
  for (const note of notes || []) {
    const lyric = note.lyric || '';
    if (!lyric) continue;
    if (lyric.startsWith('jp_') || lyric.includes('jp_') || /[\u3041-\u30ff]/.test(lyric)) {
      hasJapanese = true;
      continue;
    }
    const norm = lyric.replace(/[<>]/g, '').toUpperCase();
    if (norm === 'SP' || norm === 'AP') continue;
    if (/[a-zA-Z]/.test(lyric)) return { min: 28, max: 88, ja: false };
  }
  return hasJapanese ? { min: 48, max: 84, ja: true } : { min: 28, max: 88, ja: false };
}
