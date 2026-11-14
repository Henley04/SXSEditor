'use strict';
/**
 * Synthesizer V `.svp` 双世代（SV1 / SV2）识别、字段模型与写回决策。
 *
 * 为什么需要这个文件
 * ------------------
 * SV1 与 SV2 都是 `.svp`（纯 JSON），但 **version 数字不是标签，而是两套不同
 * schema 的世代标记**：改个数字不等于转换格式。依据 Dreamtonics 官方手册
 * 「另存为（与 1.10.0 兼容）…不包含版本 2 专用的参数」、LibreSVIP 的完整
 * Pydantic schema 与 SV1 v153 / SV2 v196 实测考据：
 *
 *   · SV1：group.parameters.pitchDelta（相对基础音高的 cent）、note.attributes.dur
 *     （音素相对时长乘数）、note.instantMode、pitchTakes / timbreTakes、无 note/ref uuid；
 *     老工程可能以 NUL 结尾并把多份工程串联在一处。
 *   · SV2：group.pitchControls（分段**绝对** MIDI 音高表达板）、
 *     note.attributes.phonemes[].leftOffset（秒，相对 note onset）、note.takes、
 *     note.uuid / ref.uuid、group.vocalModes / musicalScale、
 *     parameters.mouthOpening / toneShift、root.instantModeEnabled / projectMixer、
 *     mixer.fxParams / fxPresetName；单份工程不以 NUL 结尾。
 *
 * 因此「世代」必须靠**特征字段探测**，不能只看 version 数字（本项目历史样本里
 * 存在 version:200 的纯 SV1 骨架）。version 数字只用于：① 记录 sourceVersion
 * 原值，② 主动切档时写开源实现约定的兼容目标值（100 / 135 / 182）。
 *
 * 完整建模的边界
 * --------------
 * 宿主核心工程模型没有 mouthOpening / pitchControls / takes / leftOffset /
 * vocalModes / uuid 等等价字段，编辑器把 ext 当只读旁证、合成管线不消费。
 * 所以这里的「完整建模」是**插件层**的：read 把 SV2 专有字段按原结构完整收进
 * 快照、write 按世代完整重建；宿主有等价的（pitchControls → 绝对音高曲线）
 * 才做双向映射；其余结构化保真回写（不丢键），绝不新造宿主用不上的空控件。
 *
 * 依据：Dreamtonics 官方手册 https://sv2.docs.dreamtonics.com/zh/project 、
 * LibreSVIP (Apache/MIT 系) plugins/svp/model.py 与 synthv_generator.py、
 * UtaFormatix3 (Apache-2.0) Svp.kt，以及公开的 SV1/SV2 格式考据。
 * 本文件的解析/序列化代码为独立重写。
 */

const SVP_GENERATION = Object.freeze({ SV1: 'sv1', SV2: 'sv2' });

/**
 * 开源实现（LibreSVIP SVProjectVersionCompatibility）约定的兼容目标版本号。
 * 这些是**兼容目标值**，不是本机安装的真实版号：真实 SV1 可能写 153、
 * SV2 可能写 196。「沿用源版本」一律原样写回 sourceVersion 原值，不套这里的值。
 */
const SVP_VERSION = Object.freeze({
  SV2: 182,          // ≥ 2.0
  SV1_COMPAT: 135,   // 1.10.0–1.11.2（官方「与 1.10.0 兼容」档）
  SV1_LEGACY: 100,   // ≤ 1.9.0
});

/** codec.write 允许的 svpVersion 取值（主进程 handler 也按这份白名单校验）。 */
const SVP_TARGETS = Object.freeze(['keep', 'sv2', 'sv1']);

/** 源工程无 version 字段时的兜底：取最老的 SV1 兼容值（LibreSVIP SVProject 默认）。 */
const DEFAULT_SOURCE_VERSION = SVP_VERSION.SV1_LEGACY;

// ---------------------------------------------------------------------------
// 世代探测：只用结构特征，不看 version 数字
// ---------------------------------------------------------------------------

/** group 级 SV2 专有键（对象/数组需非空才算命中，避免空默认值误判）。 */
const GROUP_SV2_KEYS = ['pitchControls', 'vocalModes', 'musicalScale'];
/** parameters 级 SV2 专有键。 */
const PARAM_SV2_KEYS = ['mouthOpening', 'toneShift'];
/** mixer 级 SV2 专有键。 */
const MIXER_SV2_KEYS = ['fxPresetName', 'fxParams'];
/** ref 级 SV2 专有对象键（SV1 ref 也有 voice/database/pitchTakes，不能当 SV2 特征）。 */
const REF_SV2_KEYS = ['takes'];
/** 顶层 SV2 专有键。 */
const ROOT_SV2_KEYS = ['projectMixer'];

/** 键是否为「有意义」的 SV2 特征（空数组/空对象/空串不算）。 */
function meaningful(value) {
  if (value === undefined || value === null || value === false || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** 扫描一份工程里出现的 SV2 特征标记（去重、稳定排序），供探测与降级告警共用。 */
function scanSv2Markers(raw) {
  const found = new Set();
  const root = raw && typeof raw === 'object' ? raw : {};

  for (const k of ROOT_SV2_KEYS) {
    if (meaningful(root[k])) found.add(`root.${k}`);
  }

  const inspectGroup = (g) => {
    if (!g || typeof g !== 'object') return;
    for (const k of GROUP_SV2_KEYS) {
      if (meaningful(g[k])) found.add(`group.${k}`);
    }
    const p = g.parameters;
    if (p && typeof p === 'object') {
      for (const k of PARAM_SV2_KEYS) {
        if (p[k] !== undefined && p[k] !== null) found.add(`parameters.${k}`);
      }
    }
    const notes = Array.isArray(g.notes) ? g.notes : [];
    for (const n of notes) {
      if (!n || typeof n !== 'object') continue;
      if (typeof n.uuid === 'string' && n.uuid) found.add('note.uuid');
      if (meaningful(n.takes)) found.add('note.takes');
      if (meaningful(n.systemAttributes)) found.add('note.systemAttributes');
      const phonemes = n.attributes && n.attributes.phonemes;
      if (Array.isArray(phonemes)
        && phonemes.some((ph) => ph && typeof ph === 'object' && ph.leftOffset !== undefined)) {
        found.add('attributes.phonemes.leftOffset');
      }
    }
  };

  const inspectRef = (r) => {
    if (!r || typeof r !== 'object') return;
    if (typeof r.uuid === 'string' && r.uuid) found.add('ref.uuid');
    for (const k of REF_SV2_KEYS) {
      if (meaningful(r[k])) found.add(`ref.${k}`);
    }
  };

  const tracks = Array.isArray(root.tracks) ? root.tracks : [];
  for (const t of tracks) {
    if (!t || typeof t !== 'object') continue;
    inspectGroup(t.mainGroup);
    const mixer = t.mixer;
    if (mixer && typeof mixer === 'object') {
      for (const k of MIXER_SV2_KEYS) {
        if (meaningful(mixer[k])) found.add(`mixer.${k}`);
      }
    }
    inspectRef(t.mainRef);
    for (const r of Array.isArray(t.groups) ? t.groups : []) inspectRef(r);
  }
  for (const g of Array.isArray(root.library) ? root.library : []) inspectGroup(g);

  return [...found].sort();
}

/**
 * 判定世代 + 记录源版本/容器事实。
 *
 * 命中任一 SV2 结构特征即判 SV2；否则一律按 SV1（保守：SV1 字段是子集，
 * 历史自造样本 version:200 但纯 SV1 骨架也应判 SV1）。version 数字**不参与**
 * 世代判定，只作为 sourceVersion 原值记录。
 *
 * @param {object} raw pickProject 取出的那一份工程对象
 * @param {Buffer|Uint8Array} [bytes] 原始字节，用于判断 NUL 结尾与串联份数
 * @returns {{generation:'sv1'|'sv2', sourceVersion:number, trailingNul:boolean,
 *            chunkCount:number, markers:string[]}}
 */
function detectGeneration(raw, bytes) {
  const markers = scanSv2Markers(raw);
  const generation = markers.length ? SVP_GENERATION.SV2 : SVP_GENERATION.SV1;
  const sourceVersion = Number.isFinite(Number(raw && raw.version))
    && Number(raw.version) > 0 ? Number(raw.version) : DEFAULT_SOURCE_VERSION;

  let trailingNul = false;
  let chunkCount = 1;
  if (bytes) {
    let text;
    try {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      text = new TextDecoder('utf-8').decode(buf);
    } catch (_) {
      text = '';
    }
    trailingNul = /\u0000\s*$/.test(text);
    chunkCount = Math.max(1, text.split('\u0000').filter((c) => c.trim()).length);
  }
  return { generation, sourceVersion, trailingNul, chunkCount, markers };
}

// ---------------------------------------------------------------------------
// 写回决策：沿用源版本 / 切到 SV2 / 切到 SV1 兼容
// ---------------------------------------------------------------------------

/**
 * 把 codec.write 的请求值归一成一份写回决策。
 *
 * · 'keep'（或未提供）：就地 Ctrl+S 与不弹窗路径 —— 沿用**源世代 + sourceVersion
 *   原值 + 源容器约定**，做到原样写回。
 * · 'sv2'：写 182 + SV2 schema；从 SV1 升上来不算降级。
 * · 'sv1'：写 135 + SV1 schema；从 SV2 降下来要逐类列丢失项。
 *
 * NUL 约定：NUL 是「一个文件里串联多份工程历史」的分隔机制，不是世代标志；
 * 单份工程带不带 NUL 外部软件都能打开。因此容器一律**按源保真**、不主动 append
 * 伪造历史（这既符合「按原行为保存」，也不会把 SV1 沿用源版本写出的文件突然
 * 变成带尾 NUL 而破坏既有读回）。
 *
 * @param {object|null} meta collectSvpMeta 的快照（非本插件导入时为 null）
 * @param {string} [requested] 'keep' | 'sv2' | 'sv1'
 * @returns {{generation, version, trailingNul, requested, isDowngrade,
 *            isUpgrade, sourceGeneration, losses:Array<{zh:string,en:string}>}}
 */
function resolveWriteTarget(meta, requested) {
  const req = SVP_TARGETS.includes(requested) ? requested : 'keep';
  const sourceGeneration = (meta && meta.generation) || SVP_GENERATION.SV1;
  const sourceVersion = (meta && Number(meta.sourceVersion)) || DEFAULT_SOURCE_VERSION;
  const trailingNul = !!(meta && meta.trailingNul);

  let generation = sourceGeneration;
  let version = sourceVersion;
  if (req === 'sv2') {
    generation = SVP_GENERATION.SV2;
    version = SVP_VERSION.SV2;
  } else if (req === 'sv1') {
    generation = SVP_GENERATION.SV1;
    version = SVP_VERSION.SV1_COMPAT;
  }

  const isDowngrade = generation === SVP_GENERATION.SV1
    && sourceGeneration === SVP_GENERATION.SV2;
  const isUpgrade = generation === SVP_GENERATION.SV2
    && sourceGeneration === SVP_GENERATION.SV1;
  const losses = isDowngrade ? downgradeLosses(meta) : [];

  return {
    generation, version, trailingNul, requested: req,
    isDowngrade, isUpgrade, sourceGeneration, losses,
  };
}

/**
 * SV2 → SV1 降级时逐类列出会丢失/折叠的 SV2 专有参数。
 * 只列源工程里**实际出现**的类别，不空喊「可能有损失」。
 * @param {object|null} meta
 * @returns {Array<{zh:string,en:string}>}
 */
const LOSS_GROUPS = [
  {
    keys: ['group.pitchControls'],
    zh: '音高表达板（pitchControls，分段绝对音高）折叠为 pitchDelta 相对曲线',
    en: 'pitch controls (segmented absolute pitch) folded into a relative pitchDelta curve',
  },
  {
    keys: ['note.takes', 'ref.takes', 'note.pitchTakes', 'note.timbreTakes'],
    zh: '多版本 take / retake（含随机种子与 duration retake）',
    en: 'takes / retakes (random seeds and duration retakes)',
  },
  {
    keys: ['group.vocalModes', 'group.musicalScale'],
    zh: 'vocal modes 与调式（musicalScale）',
    en: 'vocal modes and musical scale',
  },
  {
    keys: ['parameters.mouthOpening', 'parameters.toneShift'],
    zh: '口型（mouthOpening）与移调（toneShift）参数曲线',
    en: 'mouth opening and tone shift parameter curves',
  },
  {
    keys: ['note.uuid', 'ref.uuid', 'note.systemAttributes'],
    zh: '音符/引用 UUID 与 systemAttributes',
    en: 'note/ref UUIDs and system attributes',
  },
  {
    keys: ['attributes.phonemes.leftOffset'],
    zh: '音素时序（phonemes[].leftOffset，秒）',
    en: 'phoneme timing (leftOffset in seconds)',
  },
  {
    keys: ['mixer.fxParams', 'mixer.fxPresetName', 'root.projectMixer'],
    zh: '效果器参数与工程级混音设置（fxParams / projectMixer）',
    en: 'effect parameters and project-level mixer (fxParams / projectMixer)',
  },
];

function downgradeLosses(meta) {
  const markers = new Set((meta && meta.sv2Markers) || []);
  const out = [];
  for (const group of LOSS_GROUPS) {
    if (group.keys.some((k) => markers.has(k))) {
      out.push({ zh: group.zh, en: group.en });
    }
  }
  // 顶层 SV2 字段（renderConfig / instantModeEnabled / uuid 等）若存在也如实提示。
  const rootExtras = (meta && meta.rootExtras) || {};
  const rootKeys = ['projectMixer', 'renderConfig', 'instantModeEnabled', 'uuid']
    .filter((k) => Object.prototype.hasOwnProperty.call(rootExtras, k));
  if (rootKeys.length) {
    out.push({
      zh: `顶层 SV2 字段 ${rootKeys.join(' / ')}`,
      en: `top-level SV2 fields ${rootKeys.join(' / ')}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 有界结构化深克隆：替代 smallValue 的精简标量快照，保证未知/专有键不丢
// ---------------------------------------------------------------------------

const CLONE_LIMITS = Object.freeze({
  MAX_NODES: 20000, MAX_DEPTH: 12, MAX_STRING: 100000,
  MAX_ARRAY: 20000, MAX_KEYS: 256,
});
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 深克隆任意 JSON 值，按节点数/深度/字符串/键数封顶，避免把异常工程塞爆 ext。
 * 数组用 null 占位保持长度（noteExtras 要按索引对齐，不能因跳过而改变长度）。
 * @param {*} value
 * @returns {{value:*, truncated:boolean}}
 */
function cloneBounded(value) {
  let nodes = 0;
  let truncated = false;
  const walk = (v, depth) => {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string') {
      if (v.length > CLONE_LIMITS.MAX_STRING) { truncated = true; return v.slice(0, CLONE_LIMITS.MAX_STRING); }
      return v;
    }
    if (t === 'number') return Number.isFinite(v) ? v : null;
    if (t === 'boolean') return v;
    if (t !== 'object') return undefined; // 函数/符号/BigInt：JSON 里本来就没有
    if (++nodes > CLONE_LIMITS.MAX_NODES || depth > CLONE_LIMITS.MAX_DEPTH) {
      truncated = true;
      return undefined;
    }
    if (Array.isArray(v)) {
      const n = Math.min(v.length, CLONE_LIMITS.MAX_ARRAY);
      if (v.length > CLONE_LIMITS.MAX_ARRAY) truncated = true;
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        const c = walk(v[i], depth + 1);
        out[i] = c === undefined ? null : c;
      }
      return out;
    }
    const keys = Object.keys(v);
    if (keys.length > CLONE_LIMITS.MAX_KEYS) truncated = true;
    const out = {};
    for (const k of keys.slice(0, CLONE_LIMITS.MAX_KEYS)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      const c = walk(v[k], depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  };
  const cloned = walk(value, 0);
  return { value: cloned === undefined ? null : cloned, truncated };
}

// ---------------------------------------------------------------------------
// 世代过滤：SV1 目标世代要把快照里的 SV2 专有键摘掉（并已在告警里逐类列出）
// ---------------------------------------------------------------------------

/** 各层级里 SV1 不该出现的键（group.uuid 是 SV1 合法字段，不在其列）。 */
const SV2_ONLY = Object.freeze({
  note: ['uuid', 'takes', 'systemAttributes', 'musicalType'],
  noteAttributes: ['phonemes'],           // 含 leftOffset（SV1 用 dur）
  ref: ['uuid', 'takes'],
  group: ['pitchControls', 'vocalModes', 'musicalScale'],
  parameters: ['mouthOpening', 'toneShift'],
  mixer: ['fxPresetName', 'fxParams'],
  root: ['projectMixer', 'instantModeEnabled', 'renderConfig', 'uuid'],
});

function omitKeys(obj, keys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

/**
 * 按目标世代过滤结构化快照：SV2 原样返回；SV1 摘掉各处 SV2 专有键。
 * 返回的是浅层新对象（不改原 meta），字段值本身已是深克隆结果，安全共享。
 *
 * 快照结构（由 collectSvpMeta 产出，结构在此收口，两边必须一致）：
 *   rootExtras: {顶层除 version/time/library/tracks 之外的键}
 *   tracks[i]:  { scalars, mixer, mainRef, groupRefs[] }
 *   groups[i]:  [ { saved, parameterExtras, sourcePitchDelta, noteExtras[] } ]
 *   libraryExtras[i]: { saved, parameters, notes }   // 未被宿主导入的库组，整块保真
 *
 * @param {object|null} meta
 * @param {'sv1'|'sv2'} generation
 */
function stripForGeneration(meta, generation) {
  const empty = { rootExtras: {}, tracks: [], groups: [], libraryExtras: [] };
  if (!meta) return empty;
  const sv1 = generation === SVP_GENERATION.SV1;
  const rootExtras = sv1 ? omitKeys(meta.rootExtras, SV2_ONLY.root) : (meta.rootExtras || {});
  const tracks = (Array.isArray(meta.tracks) ? meta.tracks : []).map((t) => {
    if (!sv1) return t || {};
    return {
      ...(t || {}),
      mixer: omitKeys(t && t.mixer, SV2_ONLY.mixer),
      mainRef: omitKeys(t && t.mainRef, SV2_ONLY.ref),
      groupRefs: (Array.isArray(t && t.groupRefs) ? t.groupRefs : [])
        .map((r) => omitKeys(r, SV2_ONLY.ref)),
    };
  });
  const stripGroup = (g) => {
    if (!sv1) return g || {};
    const stripped = {
      ...(g || {}),
      saved: omitKeys(g && g.saved, SV2_ONLY.group),
      parameterExtras: omitKeys(g && g.parameterExtras, SV2_ONLY.parameters),
      noteExtras: (Array.isArray(g && g.noteExtras) ? g.noteExtras : []).map((n) => {
        const base = omitKeys(n, SV2_ONLY.note);
        if (base && base.attributes && typeof base.attributes === 'object') {
          base.attributes = omitKeys(base.attributes, SV2_ONLY.noteAttributes);
        }
        return base;
      }),
    };
    return stripped;
  };
  const groups = (Array.isArray(meta.groups) ? meta.groups : [])
    .map((list) => (Array.isArray(list) ? list : []).map(stripGroup));
  // libraryExtras 是「未被宿主导入」的整块库组（saved / parameters / notes），
  // 与 groups[] 的「按宿主分片对齐」结构不同，过滤规则也要分开写。
  const stripNote = (n) => {
    const base = omitKeys(n, SV2_ONLY.note);
    if (base && base.attributes && typeof base.attributes === 'object') {
      base.attributes = omitKeys(base.attributes, SV2_ONLY.noteAttributes);
    }
    return base;
  };
  const libraryExtras = (Array.isArray(meta.libraryExtras) ? meta.libraryExtras : [])
    .map((g) => {
      if (!sv1) return g || {};
      const item = g || {};
      return {
        ...item,
        saved: omitKeys(item.saved, SV2_ONLY.group),
        parameters: omitKeys(item.parameters, SV2_ONLY.parameters),
        notes: (Array.isArray(item.notes) ? item.notes : []).map(stripNote),
      };
    });
  return { rootExtras, tracks, groups, libraryExtras };
}

// ---------------------------------------------------------------------------
// pitchControls ↔ 宿主音高曲线（唯一「宿主有等价」的 SV2 专有参数）
// ---------------------------------------------------------------------------

/**
 * 按**绝对拍**取当前音符的基础 MIDI 音高：notes[].startBeat 与 pitchControls
 * 换算出的 beat 都是绝对拍（parseSvp 已把 ref.blickOffset 加进去）。
 * 注意与 score.js 里的同名函数区分 —— 那边收的是分片内相对时间。
 */
function makeBasePitchLookup(notes) {
  const sorted = (Array.isArray(notes) ? notes : [])
    .filter((n) => n && Number.isFinite(Number(n.pitch)))
    .slice().sort((a, b) => (Number(a.startBeat) || 0) - (Number(b.startBeat) || 0));
  let index = 0;
  return (beat) => {
    if (!sorted.length) return 60;
    while (index + 1 < sorted.length
      && (Number(sorted[index + 1].startBeat) || 0) <= beat + 1e-6) index++;
    return Number(sorted[index].pitch) || 60;
  };
}

/** points 既可能是扁平 [x,y,...]（考据），也可能是 [{offset,value},...]（LibreSVIP）。 */
function pitchControlPoints(pc) {
  const raw = Array.isArray(pc && pc.points) ? pc.points : [];
  const out = [];
  if (!raw.length) return out;
  if (typeof raw[0] === 'number') {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      out.push({ offset: Number(raw[i]) || 0, value: Number(raw[i + 1]) || 0 });
    }
  } else {
    for (const p of raw) {
      if (p && typeof p === 'object') {
        out.push({ offset: Number(p.offset) || 0, value: Number(p.value) || 0 });
      }
    }
  }
  return out;
}

/**
 * SV2 pitchControls（分段绝对 MIDI 音高）→ 宿主 pitchOffsets（相对基础音高的半音）。
 *
 * 考据：点的绝对音高 = pc.pitch + point.value + ref.pitchOffset；位置 =
 * pc.pos + point.offset（blick）。宿主曲线是「相对当前音符」的偏移，所以要减去
 * 当时音符的基础音高。**有损**：分段结构与基础音高语义无法无损映射，调用方须告警。
 *
 * @returns {{offsets:Array<{beat:number,semitones:number}>, segments:number, lossy:boolean}}
 */
function parsePitchControls(group, ref, notes, blickPerBeat, roundTime) {
  const pcs = Array.isArray(group && group.pitchControls) ? group.pitchControls : [];
  if (!pcs.length) return { offsets: [], segments: 0, lossy: false };
  const blickOffset = Number(ref && ref.blickOffset) || 0;
  const pitchOffset = Number(ref && ref.pitchOffset) || 0;
  const baseAt = makeBasePitchLookup(notes);
  const byBeat = new Map();
  let segments = 0;
  for (const pc of pcs) {
    if (!pc || typeof pc !== 'object') continue;
    segments += 1;
    const basePos = Number(pc.pos) || 0;
    const basePitch = Number(pc.pitch) || 0;
    for (const point of pitchControlPoints(pc)) {
      const beat = (basePos + point.offset + blickOffset) / blickPerBeat;
      const absolute = basePitch + point.value + pitchOffset;
      const semitones = absolute - pitchOffset - baseAt(beat);
      byBeat.set(roundTime(beat), semitones);
    }
  }
  const startBeat = blickOffset / blickPerBeat;
  if (byBeat.size && Math.min(...byBeat.keys()) > startBeat) byBeat.set(roundTime(startBeat), 0);
  const offsets = [...byBeat.entries()]
    .map(([beat, semitones]) => ({ beat, semitones }))
    .sort((a, b) => a.beat - b.beat);
  return { offsets, segments, lossy: true };
}

/**
 * 宿主 pitchOffsets → SV2 pitchControls（重建为一段 curve）。
 *
 * 与 parsePitchControls 对称：绝对音高 = 基础音高 + 半音偏移。SV2 的 pos/offset
 * 是 blick、value 是相对该段基音的半音。真实 SV2 会按 -100 断点分段，这里重建为
 * **一段连续 curve**（合法但会重组分段结构），属有损，调用方须告警。
 *
 * @returns {Array<object>}
 */
function buildPitchControls(part, blickPerBeat, roundTime) {
  const offsets = Array.isArray(part && part.pitchOffsets) ? part.pitchOffsets : [];
  if (!offsets.length) return [];
  const notes = Array.isArray(part.notes) ? part.notes : [];
  const baseAt = makeBasePitchLookup(notes);
  const startBeat = Number(part.startBeat) || 0;
  const points = [];
  let pos = null;
  let basePitch = 0;
  for (const o of offsets) {
    const beat = Number(o.beat) || 0;
    // baseAt 查的是绝对拍（见 makeBasePitchLookup），不能用相对拍去查；
    // pos/offset 才是相对 group 起点的 blick。
    const absolute = baseAt(beat) + (Number(o.semitones) || 0);
    const blick = Math.round((beat - startBeat) * blickPerBeat);
    if (pos === null) { pos = blick; basePitch = absolute; }
    points.push({
      offset: blick - pos,
      value: Math.round((absolute - basePitch) * 1000) / 1000,
    });
  }
  if (pos === null || !points.length) return [];
  void roundTime;
  return [{
    type: 'curve',
    id: '1',
    pos,
    pitch: Math.round(basePitch * 1000) / 1000,
    points,
  }];
}

module.exports = {
  SVP_GENERATION,
  SVP_VERSION,
  SVP_TARGETS,
  DEFAULT_SOURCE_VERSION,
  GROUP_SV2_KEYS,
  PARAM_SV2_KEYS,
  MIXER_SV2_KEYS,
  REF_SV2_KEYS,
  ROOT_SV2_KEYS,
  SV2_ONLY,
  scanSv2Markers,
  detectGeneration,
  resolveWriteTarget,
  downgradeLosses,
  cloneBounded,
  stripForGeneration,
  makeBasePitchLookup,
  parsePitchControls,
  buildPitchControls,
};
