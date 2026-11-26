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
  // 自动颤音（曲线层的派生量，渲染可见；F0 路径在后处理之后叠加，见 §6.3）
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
  // ---- 表达概率（§15）--------------------------------------------------
  // 真人不是"每个长音都颤、每个跳进都过冲、每个音尾都下滑"。这四个概率是
  // 逐音符确定性抽签的**基准值**，实际值还会乘上音高/时长/乐句位置等
  // 上下文系数（见 buildNoteTraits）——所以 0.8 不等于"80% 的音符照做"，
  // 长音、句尾、高音的实际命中率会明显高于短音、句首、低音。
  vibratoProbability: 0.82,
  overshootProbability: 0.55,
  prepProbability: 0.40,
  releaseProbability: 0.65,
  /** 'phrase' = 只在乐句尾/后接休止/长音收尾处下滑；'always' = 每个音符尾都下滑 */
  releaseScope: 'phrase',
  /** 非乐句尾时，音符至少多长才允许轻微下滑（拍） */
  releaseMinBeats: 2,
  // ---- 连奏 / 断奏（§15）------------------------------------------------
  /** 与下一音的间隙 ≤ 该值视为连奏（负值 = 重叠） */
  legatoGapBeats: 0.12,
  /** 与下一音的间隙 ≥ 该值视为断奏 */
  staccatoGapBeats: 0.45,
  /** 间隙 ≥ 该值视为乐句分界 */
  phraseGapBeats: 1.2,
  /** 级进（1 半音）在连奏时的微滑时长；0 = 不滑 */
  microGlideMs: 45,
  // ---- 逐音符变化幅度（§15）---------------------------------------------
  /** 0 = 每个音符参数完全一致（机械但可预测）；100 = 幅度/速率随机幅度最大 */
  variation: 60,
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
    vibratoProbability: 0.85, overshootProbability: 0.38, prepProbability: 0.28,
    releaseProbability: 0.5, variation: 45,
    autoVibrato: { ...AUTO_PITCH_DEFAULTS.autoVibrato, depth: 18, rate: 5.0 },
  },
  natural: {},
  power: {
    attackMs: 40, attackCents: -90,
    overshootRatio: 0.35, overshootMaxCents: 70,
    prepCents: -20, glideMs: 60, glideMinSemitones: 2,
    releaseCents: -35, jitterCents: 10,
    vibratoProbability: 0.9, overshootProbability: 0.8, prepProbability: 0.55,
    releaseProbability: 0.78, variation: 70,
    autoVibrato: { ...AUTO_PITCH_DEFAULTS.autoVibrato, depth: 30, rate: 6.2, drift: 10 },
  },
  ballad: {
    attackMs: 100, attackCents: -50,
    overshootRatio: 0.20, overshootMaxCents: 30,
    prepCents: -12, glideMs: 140, glideMinSemitones: 1,
    releaseCents: -30, jitterCents: 4,
    vibratoProbability: 0.9, overshootProbability: 0.5, prepProbability: 0.35,
    releaseProbability: 0.82, variation: 65,
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
  vibratoProbability: [0, 1], overshootProbability: [0, 1],
  prepProbability: [0, 1], releaseProbability: [0, 1],
  releaseMinBeats: [0, 8],
  legatoGapBeats: [0, 1], staccatoGapBeats: [0, 2], phraseGapBeats: [0, 4],
  microGlideMs: [0, 150],
  variation: [0, 100],
  quantize: [0, 1],
  crossfadeMs: [0, 100],
  mergeGapBeats: [0, 4],
};

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** 枚举型参数的合法取值。与 normalizeAutoConfig 里的校验保持一致。 */
const AUTO_PARAM_ENUMS = {
  glideUnit: ['beats', 'ms'],
  glideCurve: ['linear', 'bezier', 'exp'],
  jitterSource: ['singer', 'synth'],
  jitterStage: ['pre', 'post'],
  releaseScope: ['phrase', 'always'],
  glideOwnership: ['auto', 'post', 'both'],
};

/**
 * 清洗"参数补丁"：丢掉非法的枚举值与非数值。
 *
 * 为什么需要单独一步：`normalizeAutoConfig` 拿不到"改动前的值"，非法枚举
 * 只能回落到**全局默认值**。于是 `{releaseScope:'bogus'}` 会把用户原来的
 * `'always'` 悄悄改回 `'phrase'`——看起来像"什么都没发生"，实际丢了设置。
 * 补丁层先剔掉非法键，非法输入就是**无操作**，旧值原样保留。
 */
export function sanitizeAutoParamPatch(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'autoVibrato') {
      if (v && typeof v === 'object') out.autoVibrato = { ...v };
      continue;
    }
    const enums = AUTO_PARAM_ENUMS[k];
    if (enums) {
      if (enums.includes(v)) out[k] = v;
      continue;
    }
    if (k in AUTO_PITCH_PARAM_RANGES) {
      if (Number.isFinite(Number(v))) out[k] = Number(v);
      continue;
    }
    // seed 走整数语义；其余未知键直接丢弃（避免脏字段被写进工程）
    if (k === 'seed' && Number.isFinite(Number(v))) out[k] = Math.floor(Number(v));
  }
  return out;
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
  if (p.releaseScope === 'phrase' || p.releaseScope === 'always') out.releaseScope = p.releaseScope;
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
  const merged = {
    ...AUTO_PITCH_DEFAULTS,
    ...patch,
    // 必须深拷贝：浅拷贝会让预设与 AUTO_PITCH_DEFAULTS.autoVibrato 共享同一个
    // 对象，UI 里改一次"自动颤音深度"就把全局默认值改了（新工程、重置、
    // 归一化兜底全都跟着变，而且撤销也回不来）。
    autoVibrato: { ...AUTO_PITCH_DEFAULTS.autoVibrato, ...(patch.autoVibrato || {}) },
  };
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

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 字符串 → 32 位整数（FNV-1a）。note.id 非数字时用它做种子。 */
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/**
 * 音符指纹：**只取 id**（没有 id 时退化为 起点/音高/时长）。
 *
 * 为什么不用 start/pitch：拖拽音符横向移动时 start 变化会让"抽签"结果整体
 * 重掷一次，颤音/过冲会在拖拽过程中忽有忽无。用 id 保证"同一个音符"
 * 的人味特征在编辑过程中稳定，改音高只会改变上下文系数（连续变化）。
 */
function noteKey(note) {
  if (note && note.id !== undefined && note.id !== null) {
    const raw = String(note.id);
    const num = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(num)) return num | 0;
    return hashString(raw);
  }
  return hashString(`${note ? note.start : 0}|${note ? note.pitch : 0}|${note ? note.duration : 0}`);
}

/** 乐句尾标记：歌词以标点结尾时视为断句（歌词是逐音节，标点只在句末出现）。 */
function endsPhrase(lyric) {
  const s = String(lyric || '').trim();
  if (!s) return false;
  return /[，。、！？；：,.!?;:]$/.test(s);
}

/**
 * 把轨道/分片标识折成数值 salt。
 *
 * 用途：同一份 MIDI 复制到两条轨（和声/叠唱）时，note.id 可能一模一样，
 * 若抖动与颤音相位只按 note.id 派生，两条轨会**完全同步**地抖 —— 比不抖更假。
 * 把 salt 混进种子后，每条轨的人味互不相关，但同一条轨内仍是确定的。
 */
export function saltFromKey(key) {
  if (Number.isFinite(key)) return key | 0;
  return hashString(String(key === undefined || key === null ? '' : key));
}

// ==================== 每音符"人味"档案 ====================

/**
 * 一个音符的确定性表达特征。
 *
 * 这一层的存在是为了避免"参数化机械"：如果每个长音都颤、每个 ≥2 半音跳进
 * 都过冲、每个音尾都下滑，参数再精细也还是同一个模板复制 N 遍。真人歌唱的
 * 差异来自**条件**（音高/时长/乐句位置/前后音关系/连奏断奏），这里把这些
 * 条件折算成"是否做 + 做多少"的系数。
 *
 * 全部由 (seed, 轨道 salt, note.id) 派生 → 同一工程同一结果，撤销/重做/导出
 * 可复现，不需要把随机结果写进工程文件。
 */
const DEFAULT_TRAIT = {
  onset: 'start',
  gapAfter: Infinity,
  phrase: 0,
  isPhraseEnd: false,
  isPhraseStart: true,
  gateVibrato: false,
  gateOvershoot: false,
  gatePrep: false,
  gateRelease: false,
  releaseScale: 0,
  depthScale: 1,
  rateScale: 1,
  attackScale: 1,
  jitterScale: 1,
  overshootScale: 1,
  vibratoStartShift: 0,
  phase0: 0,
  seed: 0,
};

/**
 * 为整条音符序列建立特征表。
 *
 * @param {object} ctx { sortedNotes, auto, bpm, seedSalt? }
 * @returns {Map<object, object>} note 对象 → 特征
 */
export function buildNoteTraits(ctx) {
  const notes = Array.isArray(ctx && ctx.sortedNotes) ? ctx.sortedNotes : [];
  const auto = (ctx && ctx.auto) || null;
  const parameters = (auto && auto.params) || AUTO_PITCH_DEFAULTS;
  const seed = Number.isFinite(parameters.seed) ? parameters.seed | 0 : 0;
  const salt = Number.isFinite(ctx && ctx.seedSalt) ? ctx.seedSalt | 0 : 0;
  const map = new Map();
  const n = notes.length;
  if (n === 0) return map;

  // 前后"发声"音符索引：一次扫描，避免逐音符 indexOf（O(n²)）
  const prevV = new Array(n).fill(-1);
  const nextV = new Array(n).fill(-1);
  let pv = -1;
  for (let i = 0; i < n; i++) { prevV[i] = pv; if (!isUnvoiced(notes[i])) pv = i; }
  let nv = -1;
  for (let i = n - 1; i >= 0; i--) { nextV[i] = nv; if (!isUnvoiced(notes[i])) nv = i; }

  let phrase = -1;
  for (let i = 0; i < n; i++) {
    const note = notes[i];
    if (!note) continue;
    const p = resolveAutoParams(auto, note);
    const prevEl = i > 0 ? notes[i - 1] : null;
    const gapPrev = prevEl ? note.start - (prevEl.start + prevEl.duration) : Infinity;
    if (!prevEl || isUnvoiced(prevEl) || gapPrev >= p.phraseGapBeats) phrase += 1;
    if (phrase < 0) phrase = 0;

    if (isUnvoiced(note)) {
      map.set(note, { ...DEFAULT_TRAIT, phrase });
      continue;
    }

    const prev = prevV[i] >= 0 ? notes[prevV[i]] : null;
    const next = nextV[i] >= 0 ? notes[nextV[i]] : null;
    const gapAfter = next ? next.start - (note.start + note.duration) : Infinity;
    const gapBefore = prev ? note.start - (prev.start + prev.duration) : Infinity;
    const interval = prev ? note.pitch - prev.pitch : 0;
    const nextInterval = next ? next.pitch - note.pitch : 0;
    const durBeats = note.duration || 0;

    // 起音侧的连奏/断奏：决定"这个音是滑进来还是重新起音"，与结尾无关。
    // 早先把 ×结尾× 的间隙当成 articulation 用，导致句尾的长音被判成
    // "isolated"、起音不再弱化 —— 方向错了。
    const onset = !prev ? 'start'
      : gapBefore <= p.legatoGapBeats ? 'legato'
        : gapBefore >= p.staccatoGapBeats ? 'detached'
          : 'normal';

    const isPhraseEnd = !next || gapAfter >= p.phraseGapBeats || endsPhrase(note.lyric);
    const isPhraseStart = !prev || gapBefore >= p.phraseGapBeats;

    const s = (seed ^ noteKey(note) ^ Math.imul(salt + 1, 40503)) | 0;
    const varAmt = clamp01((Number.isFinite(p.variation) ? p.variation : 60) / 100);

    // 概率 1 = 一定做（上下文系数不再压它），否则用户把滑块拉到 100% 还会
    // 有四分之一的音"没反应"，会以为坏了。上下文系数只在 0<p<1 时起作用。
    const gateBy = (rnd, userProb, ctxFactor = 1) => {
      if (userProb >= 1) return true;
      if (userProb <= 0) return false;
      return rnd < clamp01(userProb * ctxFactor);
    };

    // ---- 是否做 ----
    const av = p.autoVibrato || AUTO_PITCH_DEFAULTS.autoVibrato;
    const minD = Math.max(0.25, av.minDurationBeats);
    // 越长的音越可能带颤音（真人短音常是直声，长音才展开）
    const durF = 0.72 + 0.55 * clamp01((durBeats - minD) / Math.max(0.5, minD * 3));
    // 高音区颤音更常见（换声区以上几乎必颤），低音区更克制
    const pitchF = 0.86 + 0.30 * clamp01(((note.pitch || 60) - 50) / 34);
    const posF = isPhraseEnd ? 1.15 : 1.02;
    const ctxF = durF * pitchF * posF;
    const gateVibrato = av.enabled && durBeats >= av.minDurationBeats
      && gateBy(hash01(s, 101), p.vibratoProbability, ctxF);

    // 跳进越大、越靠近句首（重音）越可能过冲
    const ovCtx = (0.55 + 0.45 * clamp01(Math.abs(interval) / 7)) * (isPhraseStart ? 1.1 : 1);
    const gateOvershoot = gateBy(hash01(s, 809), p.overshootProbability, ovCtx);

    const prepCtx = 0.65 + 0.35 * clamp01(Math.abs(nextInterval) / 5);
    // 概率=1 仍要求"确实有下一个音"（gateBy 只看概率，不代替语义判断）
    const gatePrep = !!next && gateBy(hash01(s, 907), p.prepProbability, prepCtx);

    const gateRelease = gateBy(hash01(s, 1009), p.releaseProbability);

    // ---- 做多少 ----
    const phraseScale = 1 + varAmt * 0.30 * (hash01(
      (seed ^ Math.imul(salt + 1, 7717)) | 0,
      1200 + phrase,
    ) * 2 - 1);
    const depthScale = Math.max(0, (1 + varAmt * 0.45 * (hash01(s, 211) * 2 - 1)) * phraseScale);
    const rateScale = Math.max(0.75, Math.min(1.25, 1 + varAmt * 0.16 * (hash01(s, 307) * 2 - 1)));
    const attackScale = Math.max(0, 1 + varAmt * 0.35 * (hash01(s, 401) * 2 - 1));
    const jitterScale = Math.max(0, 1 + varAmt * 0.40 * (hash01(s, 503) * 2 - 1));
    const overshootScale = Math.max(0, 1 + varAmt * 0.40 * (hash01(s, 811) * 2 - 1));

    // ---- 句尾下滑的作用域（§15.2）----
    // 每个连续音符尾都下滑会变成"每个音都波浪"，所以默认只在：
    //   乐句尾 > 后接休止 > 长音收尾（且幅度大幅衰减）
    let releaseScale = 0;
    if (gateRelease) {
      if (p.releaseScope === 'always') releaseScale = 1;
      else if (isPhraseEnd) releaseScale = 1;
      else if (gapAfter >= 0.25) releaseScale = 0.7;
      else if (durBeats >= p.releaseMinBeats) releaseScale = 0.32;
    }

    map.set(note, {
      onset,
      gapAfter,
      phrase,
      isPhraseEnd,
      isPhraseStart,
      gateVibrato,
      gateOvershoot,
      gatePrep,
      gateRelease,
      releaseScale,
      depthScale,
      rateScale,
      attackScale,
      jitterScale,
      overshootScale,
      vibratoStartShift: (hash01(s, 701) * 2 - 1) * 0.04,
      // 相位按 (轨道, 音符) 派生：多轨同度叠唱时不会整整齐齐地一起抖
      phase0: hash01(s, 601) * Math.PI * 2,
      seed: s,
    });
  }
  return map;
}

/** 取音符特征：优先用调用方预建的表，其次在 ctx 上惰性建一次。 */
function traitsFor(ctx, note, options) {
  if (options && options.traits) {
    const t = options.traits.get(note);
    if (t) return t;
  }
  if (!ctx) return DEFAULT_TRAIT;
  if (!ctx.__traits) ctx.__traits = buildNoteTraits(ctx);
  return ctx.__traits.get(note) || DEFAULT_TRAIT;
}

/**
 * 该音符的颤音是不是用户手动设置的（手动优先，自动层不再叠加）。
 *
 * 来源标记（§15.3）：
 *   · `source:'manual'` —— 用户在右键菜单里动过（**包括把开关关掉**，
 *     关掉也是一次显式决定，不能被 auto 重新打开）；
 *   · `source:'auto'` / `auto:true` —— 早期版本写入的自动填充，可按派生量覆盖；
 *   · 无标记 —— 旧工程，按是否 enabled 判断（enabled=true 视为手动）。
 */
export function isManualVibrato(note) {
  const v = note && note.vibrato;
  if (!v) return false;
  if (v.source === 'auto' || v.auto === true) return false;
  if (v.source === 'manual') return true;
  return v.enabled === true;
}

// ==================== 慢变调制（颤音速率/幅度）====================

/**
 * 确定性"慢变噪声"：2–3 个不可公约频率的正弦叠加。
 *
 * 为什么不用固定 drift：`rate*(1 + 0.06*t)` 是一条平滑的加速曲线，听两小节
 * 就能预测。真人颤音是**周期到周期**都不完全一样（速率、幅度都在慢变），
 * 所以这里用低频随机调制，频率与相位由 seed 派生 → 可复现但不可预测。
 */
function driftComps(seed, count, fLo, fHi) {
  const out = [];
  for (let k = 0; k < count; k++) {
    out.push({
      a: 0.6 / (k + 1),
      f: fLo + (fHi - fLo) * hash01(seed, 11 + k),
      ph: hash01(seed, 31 + k) * Math.PI * 2,
    });
  }
  return out;
}

/** 慢变噪声当前值（|值| ≤ 0.9）。 */
function driftNoise(t, comps) {
  let s = 0;
  for (const c of comps) s += c.a * Math.sin(2 * Math.PI * c.f * t + c.ph);
  return s;
}

/**
 * 慢变噪声的积分（从 0 起算，∫₀ = 0）。
 * 用于"瞬时速率被调制"时的相位：phase = 2π·rate·(t + drift·∫n)，
 * 这样速率变化不会造成相位跳变（每周期接得上，不会听到"咔"）。
 */
function driftIntegral(t, comps) {
  let s = 0;
  for (const c of comps) {
    const w = 2 * Math.PI * c.f;
    s += c.a * (Math.cos(c.ph) - Math.cos(w * t + c.ph)) / w;
  }
  return s;
}

// ==================== 自动颤音 ====================

/**
 * 某音符在某时刻的自动颤音偏移（半音）。0 = 该时刻不颤。
 *
 * 与手动 `note.vibrato` 的关系（§15.3）：
 *   · 手动颤音存在时这里恒为 0 —— 自动层永不覆盖用户资产；
 *   · 自动颤音是**派生量**，不写回 note.vibrato。UI 用
 *     `resolveAutoVibratoForNote()` 读"影子参数"显示，用户一动就转成手动。
 */
export function autoVibratoOffset(note, ageSec, durSec, cfg, tr) {
  const av = cfg || AUTO_PITCH_DEFAULTS.autoVibrato;
  const t = tr || DEFAULT_TRAIT;
  if (!av || !av.enabled || !(av.depth > 0)) return 0;
  if (!(durSec > 0) || !t.gateVibrato) return 0;
  if (isManualVibrato(note)) return 0;

  const startFrac = clamp01((Number.isFinite(av.start) ? av.start : 0.25) + (t.vibratoStartShift || 0));
  const lenFrac = clamp01(Number.isFinite(av.length) ? av.length : 0.75);
  const startSec = startFrac * durSec;
  const endSec = Math.min(durSec * 0.995, startSec + lenFrac * durSec);
  if (ageSec < startSec || ageSec > endSec) return 0;

  const pos = (ageSec - startSec) / Math.max(1e-6, endSec - startSec);
  const fadeIn = clamp01(Number.isFinite(av.fadeIn) ? av.fadeIn : 0.35);
  let env = 1;
  if (fadeIn > 0 && pos < fadeIn) env = pos / fadeIn;
  // 收尾淡出：颤音区提前于音符结束，硬切会有"抖到一半停住"的突变
  const fadeOut = 0.15;
  if (pos > 1 - fadeOut) env = Math.min(env, (1 - pos) / fadeOut);
  if (env <= 0) return 0;

  const tt = ageSec - startSec;
  const rate = Math.max(0.5, (av.rate || 5.5) * (t.rateScale || 1));
  // 速率慢变：每 2–4 个周期方向/幅度都会变（0.5–1.4Hz 调制）
  const drift = clamp01((Number.isFinite(av.drift) ? av.drift : 0) / 100);
  const rateComps = driftComps(t.seed, 2, 0.5, 1.4);
  const phase = (t.phase0 || 0) + 2 * Math.PI * rate * (tt + drift * driftIntegral(tt, rateComps));
  // 幅度慢变 + 逐周期起伏（后者频率跟颤音同量级，形成"这一下深一点"
  // 的周期差异，而不是整体音量包络）
  const depthDrift = clamp01((Number.isFinite(av.depthDrift) ? av.depthDrift : 0) / 100);
  const depthComps = driftComps((t.seed + 7717) | 0, 2, rate / 3.2, rate / 2.2);
  const depthMod = 1 + depthDrift * driftNoise(tt, depthComps);
  const depth = Math.max(0, av.depth * (t.depthScale || 1) * depthMod);
  return (depth / 100) * env * Math.sin(phase);
}

/**
 * 自动颤音的"影子参数"——给 UI 显示用。
 *
 * 返回值不是工程字段：它是按当前音符条件算出来、**如果用户不干预就会生效**
 * 的那组颤音参数。用户在右键菜单里动任一滑块 → 写入 note.vibrato
 * 且 source='manual'，从此该音符由手动层接管（auto 不再叠加）。
 *
 * @returns {null|{enabled:boolean, depth:number, rate:number, start:number,
 *                 length:number, fadeIn:number, auto:true, prob:number}}
 */
export function resolveAutoVibratoForNote(ctx, note) {
  const auto = ctx && ctx.auto;
  if (!auto || !auto.enabled || !note) return null;
  const p = resolveAutoParams(auto, note);
  const cfg = p.autoVibrato || AUTO_PITCH_DEFAULTS.autoVibrato;
  if (!cfg || !cfg.enabled) return null;
  const tr = traitsFor(ctx, note);
  const rate = Math.max(0.5, (cfg.rate || 5.5) * (tr.rateScale || 1));
  const startFrac = clamp01((Number.isFinite(cfg.start) ? cfg.start : 0.25) + (tr.vibratoStartShift || 0));
  return {
    enabled: !!tr.gateVibrato,
    depth: Math.round(Math.max(0, cfg.depth * (tr.depthScale || 1)) * 10) / 10,
    rate: Math.round(rate * 10) / 10,
    start: startFrac,
    length: Number.isFinite(cfg.length) ? cfg.length : 0.75,
    fadeIn: Number.isFinite(cfg.fadeIn) ? cfg.fadeIn : 0.35,
    auto: true,
  };
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
  const includeVibrato = options.includeVibrato !== false;
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
  const tr = traitsFor(ctx, note, options);

  let v = note.pitch;

  // ---- 1) 滑音：只在音程 >= glideMinSemitones 时启用，过渡完全落在新音符内部
  //        （从 prev.pitch 滑向 note.pitch），避免跨音符求值顺序问题。
  //        连奏 + 级进（1 半音）走微滑：完全不做滑音会让快歌/叙事曲的换音
  //        变成"硬切"，而按大跳进的 90ms 滑音又会糊成一片。
  const glideSec = glideSeconds(p, bpm);
  const legato = tr.onset === 'legato';
  const detached = tr.onset === 'detached';
  let useGlide = false;
  let gSec = 0;
  // 断奏起音（上一个音已经停了很久）不滑：那不是"过渡"，是重新起音
  if (prev && !detached && p.glideOwnership !== 'post') {
    const absInterval = Math.abs(interval);
    if (absInterval >= p.glideMinSemitones && glideSec > 0) {
      useGlide = true;
      gSec = glideSec;
    } else if (legato && absInterval >= 1 && p.microGlideMs > 0) {
      useGlide = true;
      gSec = p.microGlideMs / 1000;
    }
  }
  // 短音符上的 90ms 滑音会盖满整个音符，听起来像"整段都在滑"
  if (gSec > 0) gSec = Math.min(gSec, durSec * 0.6);
  if (useGlide && gSec > 0 && ageSec < gSec) {
    const u = ageSec / gSec;
    v = note.pitch - interval * (1 - bezierEase(u));
  }

  // ---- 2) 起音上滑：仅在没有滑音时生效（否则会从低音二次下滑）。
  //        连奏里起音本来就弱（前一个音的余音还在响），只用 35% 幅度；
  //        断奏反而需要更清楚的"咬字"，保持原幅度。
  const attackSecRaw = p.attackMs / 1000;
  const attackScale = useGlide ? 0 : (legato ? tr.attackScale * 0.35 : tr.attackScale);
  const attackSec = Math.min(attackSecRaw, durSec * 0.35);
  if (attackScale > 0 && attackSec > 0 && ageSec < attackSec) {
    v += ((p.attackCents * attackScale) / 100) * (1 - ageSec / attackSec);
  }

  // ---- 3) 起音过冲：音程比例 + 上限，指数衰减。
  //        起点必须落在**滑音结束之后** —— 否则滑音还在往上爬时就叠加过冲，
  //        两者在时间上互相抵消（实测 7 半音跳进时过冲从 40 音分掉到 10 音分）。
  //        不是每个跳进都过冲（tr.gateOvershoot），幅度也逐音符浮动。
  const overSec = Math.min(p.overshootMs / 1000, durSec * 0.5);
  const overAge = ageSec - gSec;
  // 太短的音符没有展开过冲的时间（< 0.35 拍的装饰音上过冲会变成"怪音"）
  if (tr.gateOvershoot && (note.duration || 0) >= 0.35 && overSec > 0 && overAge >= 0 && overAge < overSec) {
    const amp = Math.min(p.overshootMaxCents, Math.abs(interval) * 100 * p.overshootRatio)
      * tr.overshootScale / 100;
    if (amp > 0) v += amp * Math.exp((-3 * overAge) / overSec);
  }

  // ---- 4) 预备（跳进前朝反方向）+ 句尾下滑：二者互斥，预备优先
  const remSec = durSec - ageSec;
  const nextInterval = next ? next.pitch - note.pitch : 0;
  const prepSec = Math.min(p.prepMs / 1000, durSec * 0.25);
  // 连奏时把"微预备"下放到级进（1 半音）；幅度 35%，只是让换音有个"预期"
  const prepMin = legato ? Math.min(1, p.prepMinSemitones) : p.prepMinSemitones;
  const prepAmp = (legato && Math.abs(nextInterval) < p.prepMinSemitones) ? 0.35 : 1;
  // 预备只对"马上就要到的音"有意义：后接长休止时提前压低毫无意义
  const prepReach = next ? (next.start - (note.start + note.duration)) <= p.staccatoGapBeats : false;
  const usePrep = tr.gatePrep && next && prepReach
    && Math.abs(nextInterval) >= prepMin && prepSec > 0 && remSec < prepSec;
  if (usePrep) {
    const dir = nextInterval > 0 ? -1 : 1;   // 与即将到来的跳进方向相反
    const w = 1 - remSec / prepSec;
    v += (dir * Math.abs(p.prepCents) * prepAmp / 100) * bezierEase(w);
  } else if (tr.releaseScale > 0 && p.releaseRatio > 0 && p.releaseCents !== 0) {
    // §15.2：release 只在"乐句尾 / 后接休止 / 长音收尾"生效（见 buildNoteTraits），
    // 不再是无条件每个音符尾 -25¢ —— 那会让整段听起来一直在上下摆。
    const relSec = Math.min(p.releaseRatio * durSec, durSec * 0.4);
    if (relSec > 0 && remSec < relSec) {
      v += ((p.releaseCents * tr.releaseScale) / 100) * (1 - remSec / relSec);
    }
  }

  // ---- 5) 抖动：宽带随机（5ms 一格）+ 低频游移。
  //        jitterStage='post' 时曲线层不加，改由 applyJitterToF0 在后处理之后
  //        叠加 —— 否则会被音色面板的中值/SG 平滑削掉（实测只剩 51%）。
  if (includeJitter && p.jitterCents > 0) {
    v += _jitterSemitones(p, note, ageSec, tr);
  }

  // ---- 6) 自动颤音（派生量，不写 note.vibrato）
  //        是否颤由 tr.gateVibrato 决定（长度/音高/乐句位置 + 概率），
  //        怎么颤由 autoVibratoOffset 决定（速率与幅度慢变，周期之间不重复）。
  if (includeVibrato) {
    v += autoVibratoOffset(note, ageSec, durSec, p.autoVibrato, tr);
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

// ==================== 抖动 ====================

/**
 * 单音符在某时刻的抖动偏移（半音）。
 *
 * 三处去相关（§15.4）：
 *   1. **音符**：种子 = (全局 seed, 轨道 salt, note.id)，不是全局同一序列——
 *      否则长曲里每小节的抖动图案会重复，多轨叠唱时还会完全同步。
 *   2. **音高**：低音区的音分抖动天然更大（同样的 Hz 波动在低音上折合更多音分）。
 *   3. **起音**：声带还没稳定起振的头 30ms 不抖。
 */
function _jitterSemitones(p, note, ageSec, tr) {
  if (!(p.jitterCents > 0)) return 0;
  const t = tr || DEFAULT_TRAIT;
  const s = t.seed || (p.seed | 0);

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

  // 音高缩放：60 号音附近 = 1，低八度约 +12%，高八度约 -12%
  const pitchScale = Math.max(0.65, Math.min(1.15,
    1.12 - ((note && note.pitch ? note.pitch : 60) - 50) / 90));
  // 起振保护：前 30ms 线性进入
  const onset = Math.min(1, Math.max(0, ageSec / 0.03));

  // jitterCents 的定义：逐点抖动的**标准差量级**（均匀分布 std ≈ 0.577×幅度），
  // 所以 6¢ 的默认值对应"每帧随机 ±6¢"，落在真人 3–10¢ 的区间内。
  return (p.jitterCents / 100) * (t.jitterScale || 1) * pitchScale * onset * (rnd + drift);
}

/**
 * 把自动层的"后置"成分（抖动 / 颤音）叠加到已生成的 F0 上。
 *
 * 为什么必须后置：音色面板的 f0Smooth(SG) 会把抖动削掉约一半、f0Median 削掉
 * 37–52%，5.5Hz 颤音也会掉 6%（实测）。放到滤波之后，两者就不再互相抵消：
 * 后处理负责"信号清洁"，自动曲线负责"表现力"。
 *
 * 自动颤音同样走这里（§6.3 / §15.3）：它不写 note.vibrato，所以既不会被
 * 用户误当成"自己设过的颤音"，也不会因为逐音符刷新而覆盖用户的手动参数。
 *
 * @param {Float32Array} f0 Hz，0=清音
 * @param {object} ctx { auto, bpm, sortedNotes, seedSalt? }
 * @param {{sampleRate:number, hopSize:number}} fmt
 * @param {{jitter?:boolean, vibrato?:boolean}} [opts] 默认两者都叠加
 * @returns {Float32Array} 新数组
 */
export function applyExpressionToF0(f0, ctx, fmt, opts = {}) {
  const { auto, bpm, sortedNotes } = ctx || {};
  if (!f0 || f0.length === 0) return f0;
  if (!auto || !auto.enabled) return f0;
  const { sampleRate, hopSize } = fmt || {};
  if (!(sampleRate > 0) || !(hopSize > 0)) return f0;
  const doJitter = opts.jitter !== false;
  const doVibrato = opts.vibrato !== false;
  if (!doJitter && !doVibrato) return f0;

  const traits = buildNoteTraits(ctx);
  const out = new Float32Array(f0);
  for (let i = 0; i < out.length; i++) {
    if (!(out[i] > 0)) continue;
    const beat = ((i * hopSize) / sampleRate / 60) * bpm;
    const note = findNoteAtBeat(sortedNotes, beat);
    if (!note || isUnvoiced(note)) continue;
    const p = resolveAutoParams(auto, note);
    const tr = traits.get(note) || DEFAULT_TRAIT;
    const ageSec = ((beat - note.start) / bpm) * 60;
    let semis = 0;
    if (doJitter && p.jitterCents > 0 && p.jitterStage !== 'pre') {
      semis += _jitterSemitones(p, note, ageSec, tr);
    }
    if (doVibrato) {
      semis += autoVibratoOffset(note, ageSec, (note.duration / bpm) * 60, p.autoVibrato, tr);
    }
    if (semis !== 0) out[i] *= Math.pow(2, semis / 12);
  }
  return out;
}

/** 只叠自动抖动（兼容旧调用点）。 */
export function applyJitterToF0(f0, ctx, fmt) {
  return applyExpressionToF0(f0, ctx, fmt, { jitter: true, vibrato: false });
}

/** 只叠自动颤音。 */
export function applyVibratoToF0(f0, ctx, fmt) {
  return applyExpressionToF0(f0, ctx, fmt, { jitter: false, vibrato: true });
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
  const includeVibrato = ctx.includeVibrato !== false;
  const autoCtx = { sortedNotes, auto, bpm, ranges, seedSalt: ctx.seedSalt };
  // 特征表只建一次：渲染每帧要取值几千次，逐次建表会直接掉帧
  autoCtx.__traits = buildNoteTraits(autoCtx);
  const traits = autoCtx.__traits;
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
    const autoV = autoPitchAt(autoCtx, beat, { includeJitter, includeVibrato, traits });
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
    autoAt: (beat) => autoPitchAt(autoCtx, beat, { includeJitter, includeVibrato, traits }),
    coverage,
    coverageAt: (beat) => coverageAt(coverage, beat),
    sortedNotes,
    autoCfg: auto,
    traits,
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
