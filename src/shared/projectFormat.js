/**
 * .sxsproj 格式版本与兼容性判定 —— 纯函数，供主窗口/CLI/MCP 共用。
 *
 * 背景（设计方案 §9）：版本号原先硬编码在两处（serializeProject 写 '1.1.0'、
 * loadProject 读 [1,1,0]），改一处忘另一处会把所有新工程误判成"版本过高/过低"。
 * 这里收敛成常量 + 单一判定函数，并补两个字段：
 *   · minReader —— "能正确读写该文件的最低版本"。低于它会**静默丢数据**
 *     （例如旧版不认识 auto 层，重存即丢），比单纯的 version 更能表达风险。
 *   · features  —— 能力清单。读到未知特性时提示但不阻断（前向兼容）。
 */

import { normalizeExtSchema, normalizeExtData, summarizeExt, EXT_LIMITS } from './pluginExt.js';

/** 当前写入的工程格式版本。新增可选字段 → minor+1；改语义/删字段 → major+1。 */
export const PROJECT_FORMAT_VERSION = '1.3.0';
export const PROJECT_FORMAT_PARTS = [1, 3, 0];

/**
 * 低于此版本读写本文件会丢字段。
 *
 * 仍是 1.2.0：1.2.0 的读者能完整读出自动曲线（锚点/作用域/全部核心参数），
 * 只会在重存时丢掉 1.3.0 新增的"自然度"参数（概率闸门/连奏判定/逐音变化），
 * 这些字段缺失时等价于默认值 —— 听感变化有限，所以降级加载、不硬拦。
 */
export const PROJECT_MIN_READER = '1.2.0';

/** 本版本写入的能力清单。 */
export const PROJECT_FEATURES = ['autoPitchCurve', 'autoPitchNaturalness'];

/** 解析 "1.2.0" → [1,2,0]；非法/空串返回 null。 */
export function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const raw = v.trim();
  if (!raw) return null;
  const parts = raw.split('.').map((s) => Number(s));
  if (parts.length === 0 || parts.length > 3) return null;
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  while (parts.length < 3) parts.push(0);
  return parts;
}

/** a > b（逐段比较）。任一方非法返回 false。 */
export function isVersionGreater(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

/**
 * 判定一个工程头部的兼容性。
 *
 * @param {{version?:string, minReader?:string, features?:string[]}} obj
 * @param {string} [currentVersion]
 * @returns {{action:'ok'|'confirm'|'reject', reason:string, version:string,
 *            unknownFeatures:string[]}}
 *   · reject  —— major 更高，或 minReader 高于当前版本（会算错/丢数据）
 *   · confirm —— major 相同、minor 更高（旧代码会忽略新字段，重存即丢）
 *   · ok      —— 可正常加载（更低的版本走降级加载）
 */
export function checkProjectHeader(obj, currentVersion = PROJECT_FORMAT_VERSION) {
  const cur = parseVersion(currentVersion) || PROJECT_FORMAT_PARTS;
  const curStr = cur.join('.');
  const version = (obj && typeof obj.version === 'string') ? obj.version : '';
  const pv = parseVersion(version);

  const known = new Set(PROJECT_FEATURES);
  const unknownFeatures = Array.isArray(obj && obj.features)
    ? obj.features.filter((f) => typeof f === 'string' && !known.has(f))
    : [];

  if (!pv) {
    // 没有版本号 = 很旧的工程；按"降级加载"处理，不阻断
    return { action: 'ok', reason: 'no-version', version: version || '0.0.0', unknownFeatures };
  }

  // minReader 优先于 version：文件明确声明"低于它重存会丢数据"
  if (typeof obj.minReader === 'string' && isVersionGreater(obj.minReader, curStr)) {
    return { action: 'reject', reason: 'min-reader', version, unknownFeatures };
  }
  if (pv[0] > cur[0]) {
    return { action: 'reject', reason: 'major', version, unknownFeatures };
  }
  if (pv[0] === cur[0] && pv[1] > cur[1]) {
    return { action: 'confirm', reason: 'minor', version, unknownFeatures };
  }
  if (pv[0] < cur[0] || (pv[0] === cur[0] && pv[1] < cur[1])) {
    return { action: 'ok', reason: 'lower', version, unknownFeatures };
  }
  return { action: 'ok', reason: 'same', version, unknownFeatures };
}

// ---------------------------------------------------------------------------
// 插件产出的工程文档
// ---------------------------------------------------------------------------

/**
 * 工程文档的规模上限。
 *
 * 这不是"性能保护"而是**安全边界**：文档由第三方插件的 codec 生成，跨进程克隆
 * 之后会直接进入渲染层的 state。没有上限时，一个 bug（或恶意）插件返回
 * `{ fragments: new Array(1e8) }` 就能让宿主在 addFragment 循环里卡死；返回
 * 深层嵌套对象则可能在递归克隆时爆栈。上限都按"真实工程远远够用"取值。
 */
export const PROJECT_DOC_LIMITS = Object.freeze({
  singers: 256,
  fragments: 5000,
  notesPerFragment: 20000,
  arrayLength: 50000,
  stringLength: 100000,
  depth: 12,
  /** 克隆后 JSON 序列化的字节上限（100MB，不含嵌入式音频）。 */
  bytes: 100 * 1024 * 1024,
  /**
   * 嵌入式音频（base64）的合计上限。
   *
   * 伴奏轨本来就是一整首歌的 WAV：44.1kHz/16bit 立体声约 10MB 每分钟，
   * base64 再涨 4/3 —— 和"工程数据"根本不是一个量级，所以单独预算，不挤占
   * `bytes`。256MB 够两三条十分钟级的伴奏；再多就意味着插件在拿工程当音频
   * 容器用，那不是导入该干的事。
   */
  embeddedAudioBytes: 256 * 1024 * 1024,
});

/**
 * 原型污染键。数据来自插件，`{"__proto__": {...}}` 在 JSON.parse 之后是自有键，
 * 但一经 Object.assign / 展开就会改写原型链。这里在克隆阶段直接丢弃。
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 嵌入式音频的键名。
 *
 * `wavBase64` 天生是百万字符级的字符串：按 `stringLength` 截断等于把 WAV 剪成
 * 一段能装进工程、但解出来是噪音的废字节 —— 用户看到的是"伴奏导进来了，播放
 * 却是爆音"。这类载荷不按字符串长度管，改由 `embeddedAudioBytes` 统一预算，
 * 超限就整份拒绝（明确失败），绝不截断（静默损坏）。
 */
const EMBEDDED_AUDIO_KEYS = new Set(['wavBase64']);

const TIME_SIGNATURE_DENOMS = new Set([1, 2, 4, 8, 16, 32]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';
}

/**
 * 把插件给的对象收敛成"可安全进入宿主"的纯 JSON 结构。
 *
 * 三条规则：
 *   · 非 JSON 类型（函数、Symbol、Map、TypedArray、Date）一律丢弃 —— 它们本来就
 *     过不了跨进程的结构化克隆，或者进来之后语义已经变了；
 *   · 超出深度/长度上限的部分截断并记一条 warning，不整体拒绝；
 *   · 危险键直接跳过。
 *
 * `ext` 子树例外：那里是插件自己的数据，字符串被截断等于"看起来合法但内容已损坏"，
 * 比整条丢掉更危险。所以 ext 下不截断字符串，长度由 `normalizeExtData` 按字节判定。
 * 嵌入式音频（`wavBase64`）同理不截断，由 `embeddedAudioBytes` 单独预算。
 *
 * 返回 undefined 表示"这一项不该存在"，调用方据此跳过数组元素或对象字段。
 */
function cloneJson(value, depth, warnings, label, keepLongStrings = false) {
  if (depth > PROJECT_DOC_LIMITS.depth) {
    warnings.push(`${label} 嵌套超过 ${PROJECT_DOC_LIMITS.depth} 层，已截断`);
    return undefined;
  }
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') {
    if (!keepLongStrings && value.length > PROJECT_DOC_LIMITS.stringLength) {
      return value.slice(0, PROJECT_DOC_LIMITS.stringLength);
    }
    return value;
  }
  // NaN / Infinity 不是合法 JSON：序列化时会变成 null，不如在这里就当作缺失
  if (t === 'number') return Number.isFinite(value) ? value : undefined;
  if (t === 'boolean') return value;
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') return undefined;

  if (Array.isArray(value)) {
    const limit = Math.min(value.length, PROJECT_DOC_LIMITS.arrayLength);
    if (value.length > limit) warnings.push(`${label} 长度超过 ${limit}，已截断`);
    const out = [];
    for (let i = 0; i < limit; i++) {
      const item = cloneJson(value[i], depth + 1, warnings, `${label}[${i}]`, keepLongStrings);
      if (item !== undefined) out.push(item);
    }
    return out;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        warnings.push(`${label} 含被忽略的键 ${key}`);
        continue;
      }
      const childKeepLong = keepLongStrings || key === 'ext' || EMBEDDED_AUDIO_KEYS.has(key);
      const item = cloneJson(value[key], depth + 1, warnings, `${label}.${key}`, childKeepLong);
      if (item !== undefined) out[key] = item;
    }
    return out;
  }
  return undefined;
}

function normalizeTimeSignature(raw, warnings) {
  const fallback = [4, 4];
  if (!Array.isArray(raw) || raw.length !== 2) return fallback;
  const n = Number(raw[0]);
  const d = Number(raw[1]);
  if (!Number.isInteger(n) || n < 1 || n > 32) {
    warnings.push(`拍号分子 ${JSON.stringify(raw[0])} 非法，按 4/4 处理`);
    return fallback;
  }
  if (!TIME_SIGNATURE_DENOMS.has(d)) {
    warnings.push(`拍号分母 ${JSON.stringify(raw[1])} 非法，按 4/4 处理`);
    return fallback;
  }
  return [n, d];
}

/**
 * 嵌入式音频所在的全部位置：伴奏轨（`embeddedAudioData`）与歌手的参考音频
 * （`embeddedSingerData`）。两者的载荷都是 base64 WAV，预算与统计口径一致。
 */
function embeddedAudioBags(singers) {
  const bags = [];
  for (const s of singers) {
    if (!s || typeof s !== 'object') continue;
    if (s.embeddedAudioData && typeof s.embeddedAudioData === 'object') bags.push(s.embeddedAudioData);
    if (s.embeddedSingerData && typeof s.embeddedSingerData === 'object') bags.push(s.embeddedSingerData);
  }
  return bags.filter((bag) => typeof bag.wavBase64 === 'string' && bag.wavBase64.length > 0);
}

/** 嵌入音频合计字符数（base64 是 ASCII，一个字符一个字节）。 */
function embeddedAudioBytes(singers) {
  return embeddedAudioBags(singers).reduce((sum, bag) => sum + bag.wavBase64.length, 0);
}

/**
 * 临时清空嵌入音频，返回恢复函数。
 * 只用于体积统计，绝不能拿清理后的对象去干别的事。
 */
function stripEmbeddedAudio(singers) {
  const saved = embeddedAudioBags(singers).map((bag) => [bag, bag.wavBase64]);
  for (const [bag] of saved) bag.wavBase64 = '';
  return () => {
    for (const [bag, value] of saved) bag.wavBase64 = value;
  };
}

/**
 * 校验并归一化「插件产出的工程文档」。
 *
 * 两类调用方：`PluginDataPlane`（插件 codec 解码出的文档）与测试。返回值里的
 * `document` 是**全新的克隆**，调用方可以放心把它交给 trackManager —— 不会与
 * 插件进程里的对象共享引用，也不会带着原型链上的东西进来。
 *
 * 宽容 vs 严格：manifest 校验是"非法即拒绝"，因为插件作者能立刻改；这里是用户
 * 手上已有的文件，整体拒绝等于"文件打不开"，所以坏项丢弃 + warning，能开多少开多少。
 *
 * @param {unknown} raw
 * @returns {{ok:true, document:object, warnings:string[]}
 *          |{ok:false, error:string, warnings:string[]}}
 */
export function validateProjectDocument(raw) {
  const warnings = [];
  if (!isPlainObject(raw)) {
    return { ok: false, error: '工程文档必须是对象', warnings };
  }

  const project = isPlainObject(raw.project) ? raw.project : {};
  const bpmRaw = Number(project.bpm);
  const bpm = Number.isFinite(bpmRaw) && bpmRaw >= 20 && bpmRaw <= 400 ? bpmRaw : 120;
  if (bpm !== bpmRaw) warnings.push(`BPM ${JSON.stringify(project.bpm)} 超出 20–400，按 120 处理`);
  const timeSignature = normalizeTimeSignature(project.timeSignature, warnings);

  const singersIn = Array.isArray(raw.singers) ? raw.singers : [];
  if (!Array.isArray(raw.singers) && raw.singers !== undefined) {
    warnings.push('singers 不是数组，已忽略');
  }
  if (singersIn.length > PROJECT_DOC_LIMITS.singers) {
    warnings.push(`歌手轨道 ${singersIn.length} 条，超过上限 ${PROJECT_DOC_LIMITS.singers}，多余部分已丢弃`);
  }
  const singers = [];
  const singerIds = new Set();
  for (let i = 0; i < Math.min(singersIn.length, PROJECT_DOC_LIMITS.singers); i++) {
    const s = cloneJson(singersIn[i], 0, warnings, `singers[${i}]`);
    if (!isPlainObject(s)) {
      warnings.push(`singers[${i}] 不是对象，已跳过`);
      continue;
    }
    if (typeof s.id !== 'string' || !s.id) {
      s.id = `plugin-singer-${i + 1}`;
      warnings.push(`singers[${i}] 缺少 id，已补为 ${s.id}`);
    }
    if (singerIds.has(s.id)) {
      warnings.push(`歌手 id ${s.id} 重复，已跳过`);
      continue;
    }
    singerIds.add(s.id);
    // 扩展数据跟着层走：轨道可以带插件私有的音色引用之类。
    // 空的 ext 直接删掉 —— 留着空对象会让"有没有扩展"的判断变成"看键存不存在"以外的第二套逻辑。
    const singerExt = normalizeExtData(s.ext, warnings, `singers[${i}].ext`);
    if (Object.keys(singerExt).length) s.ext = singerExt;
    else delete s.ext;
    singers.push(s);
  }

  const fragmentsIn = Array.isArray(raw.fragments) ? raw.fragments : [];
  if (!Array.isArray(raw.fragments) && raw.fragments !== undefined) {
    warnings.push('fragments 不是数组，已忽略');
  }
  if (fragmentsIn.length > PROJECT_DOC_LIMITS.fragments) {
    warnings.push(`分片 ${fragmentsIn.length} 个，超过上限 ${PROJECT_DOC_LIMITS.fragments}，多余部分已丢弃`);
  }
  const fragments = [];
  for (let i = 0; i < Math.min(fragmentsIn.length, PROJECT_DOC_LIMITS.fragments); i++) {
    const f = cloneJson(fragmentsIn[i], 0, warnings, `fragments[${i}]`);
    if (!isPlainObject(f)) {
      warnings.push(`fragments[${i}] 不是对象，已跳过`);
      continue;
    }
    const start = Number(f.startTime);
    f.startTime = Number.isFinite(start) && start >= 0 ? start : 0;
    if (f.startTime !== start) warnings.push(`fragments[${i}].startTime 非法，按 0 处理`);
    const duration = Number(f.duration);
    f.duration = Number.isFinite(duration) && duration > 0 ? duration : 4;
    if (f.duration !== duration) warnings.push(`fragments[${i}].duration 非法，按 4 拍处理`);

    if (typeof f.id !== 'string' || !f.id) f.id = `plugin-fragment-${i + 1}`;
    if (typeof f.name === 'string' && f.name.length > 200) f.name = f.name.slice(0, 200);
    if (typeof f.singerId !== 'string' || !f.singerId) f.singerId = null;
    if (!Array.isArray(f.notes)) f.notes = [];
    if (f.notes.length > PROJECT_DOC_LIMITS.notesPerFragment) {
      warnings.push(`fragments[${i}].notes 超过 ${PROJECT_DOC_LIMITS.notesPerFragment} 个，多余部分已丢弃`);
      f.notes = f.notes.slice(0, PROJECT_DOC_LIMITS.notesPerFragment);
    }
    if (f.singerId && singerIds.size > 0 && !singerIds.has(f.singerId)) {
      // 不丢弃：把分片留在一个"孤儿轨道"上，用户仍能看到内容并手动改挂；
      // 静默删除才是真正丢数据。
      warnings.push(`fragments[${i}] 引用了不存在的轨道 ${f.singerId}`);
    }

    const fragExt = normalizeExtData(f.ext, warnings, `fragments[${i}].ext`);
    if (Object.keys(fragExt).length) f.ext = fragExt;
    else delete f.ext;

    // note 级 ext 只处理真的带了的音符。上限是 5000 分片 × 20000 音符，
    // 无条件遍历一遍等于给每个工程加一次无意义的全扫描。
    for (let k = 0; k < f.notes.length; k++) {
      const n = f.notes[k];
      if (!n || typeof n !== 'object' || !n.ext) continue;
      const noteExt = normalizeExtData(n.ext, warnings, `fragments[${i}].notes[${k}].ext`);
      if (Object.keys(noteExt).length) n.ext = noteExt;
      else delete n.ext;
    }

    fragments.push(f);
  }

  const document = {
    version: typeof raw.version === 'string' && raw.version ? raw.version : PROJECT_FORMAT_VERSION,
    project: { bpm, timeSignature },
    singers,
    fragments,
  };

  // 扩展域的声明放在文档级：它跟着"这份文件"走，不跟着插件的安装状态走。
  // 同一个插件处理 .sv2 和 .vsqx 时方言不同，schema 只能由 codec 在打开时给出。
  const extSchema = normalizeExtSchema(raw.extSchema, warnings);
  if (Object.keys(extSchema).length) document.extSchema = extSchema;
  const rootExt = normalizeExtData(raw.ext, warnings, 'ext');
  if (Object.keys(rootExt).length) document.ext = rootExt;

  // 嵌入式音频（伴奏）单独预算，且不参与下面的 JSON 体积统计。
  const audioBytes = embeddedAudioBytes(singers);
  if (audioBytes > PROJECT_DOC_LIMITS.embeddedAudioBytes) {
    return {
      ok: false,
      error: `工程内嵌音频合计 ${Math.round(audioBytes / 1024 / 1024)}MB，超过上限 ${PROJECT_DOC_LIMITS.embeddedAudioBytes / 1024 / 1024}MB`,
      warnings,
    };
  }

  let bytes = 0;
  try {
    // 把音频载荷临时摘掉再统计：否则光是给 50MB 的 base64 做一次 stringify
    // 就要多分配一份同样大的字符串，只为得到一个"减去载荷后"的数字。
    const restore = stripEmbeddedAudio(singers);
    try {
      bytes = JSON.stringify(document).length;
    } finally {
      restore();
    }
  } catch (err) {
    return { ok: false, error: `工程文档无法序列化：${err.message}`, warnings };
  }
  if (bytes > PROJECT_DOC_LIMITS.bytes) {
    return { ok: false, error: `工程文档过大（${bytes} 字节）`, warnings };
  }

  // 单条合格不代表合起来合格。这里拒绝而不是截断：总量超限意味着插件在往
  // 工程里灌非工程数据，截断会让"保存后还剩什么"变得不可预测。
  const extStats = summarizeExt(document);
  if (extStats.truncated) {
    return {
      ok: false,
      error: `扩展数据合计超过 ${EXT_LIMITS.totalBytes} 字节`,
      warnings,
    };
  }
  return { ok: true, document, warnings, extStats };
}
