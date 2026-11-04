/**
 * 插件的扩展域（ext）—— 声明与数据分开放。
 *
 * 为什么需要它
 * ------------
 * 编辑器自己的模型只覆盖"能渲染 + 能编辑"的最小闭包：音高、时值、歌词、
 * 几条参数曲线。而 SV2 / Vocaloid 各有自己的方言（音素表、引擎属性、控制器），
 * 这些东西的语义只对某一家引擎成立，一旦塞进核心模型，就等于把某个引擎的
 * 私有名词写进了协议。
 *
 * 但"不认"不等于"丢掉"：用户拿一个 .vsqx 进来，改两个音符再存回去，
 * 那些宿主看不懂的数据必须原样还在。所以需要一块插件可见、宿主不解析的区域。
 *
 * 为什么声明与数据要分开
 * ----------------------
 * 数据是**跟着层走的**（note 上有音素、fragment 上有渲染意图），
 * 声明是**跟着文档走的**（"这份文档里的音素该长什么样"）。
 * 混在一起会让每个 note 都揣一份重复的 schema（5000 个音符 = 5000 份拷贝），
 * 而且一眼看不出"哪些字段是可编辑的"。
 *
 *   document.extSchema = { [pluginId]: { note:{...}, fragment:{...}, render:{...} } }
 *   document.ext / singer.ext / fragment.ext / note.ext = { [pluginId]: <任意 JSON> }
 *
 * 宿主只认 `kind` 这几个词。它不需要知道"这个音素合不合法"——
 * 它只需要知道"这是一串音素、能不能改、改完写回原处"。
 *
 * 与 manifest 的关系：extSchema 由 codec 在**打开时**返回，不是安装时声明。
 * 同一个插件处理 .sv2 和 .vsqx 时方言不同，schema 只能跟着文件走。
 */

/** 扩展域的规模上限。按"真实工程远远够用"取值，超出即丢弃并告警。 */
export const EXT_LIMITS = Object.freeze({
  /** 一份文档最多容纳几个插件的扩展。 */
  plugins: 8,
  /** 单个 schema 的 JSON 字节上限。 */
  schemaBytes: 64 * 1024,
  /** 单条 ext 数据的字节上限（按 JSON 序列化后计）。 */
  entryBytes: 512 * 1024,
  /** 整份文档所有 ext 数据的总字节上限。 */
  totalBytes: 8 * 1024 * 1024,
  /** 每层最多几个字段。 */
  fieldsPerLayer: 32,
  /** 字段名的长度上限。 */
  nameLength: 48,
});

/**
 * 宿主认识的字段类型。
 *
 * `phonemes` 单独一类，而不是归到 `text`：它要按音素边界切分显示、
 * 要能逐段拖时长，和普通文本框的呈现完全不同。
 */
export const EXT_KINDS = Object.freeze(['phonemes', 'text', 'number', 'curve', 'toggle', 'enum']);

/** 可以携带 ext 的四个层级。 */
export const EXT_LAYERS = Object.freeze(['document', 'singer', 'fragment', 'note']);

/** 曲线插值方式。声明式，宿主负责求值 —— 插件代码不进绘制路径。 */
export const CURVE_INTERP = Object.freeze(['linear', 'step', 'smooth']);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 精简版 JSON 克隆。
 *
 * 刻意不复用 `projectFormat.js` 的 `cloneJson`：那边要 import 本模块（校验入口
 * 在这里），反过来 import 就成环了。两者行为只在超深嵌套时有差别，而 ext
 * 另有字节上限兜底 —— 深度攻击在这里会先被字节上限拦住。
 */
function clonePlain(value, warnings, label, depth = 0) {
  const MAX_DEPTH = 12;
  if (depth > MAX_DEPTH) {
    warnings.push(`${label} 嵌套超过 ${MAX_DEPTH} 层，已截断`);
    return undefined;
  }
  if (value === null) return null;
  const t = typeof value;
  // 字符串不在这里截断：ext 里被截断的字符串等于"数据损坏但看起来合法"，
  // 比整条丢弃危险得多。长度由调用方的字节上限判定。
  if (t === 'string') return value;
  if (t === 'number') return Number.isFinite(value) ? value : undefined;
  if (t === 'boolean') return value;
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') return undefined;
  if (Array.isArray(value)) {
    const out = [];
    const limit = Math.min(value.length, 50000);
    for (let i = 0; i < limit; i++) {
      const item = clonePlain(value[i], warnings, `${label}[${i}]`, depth + 1);
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
      const item = clonePlain(value[key], warnings, `${label}.${key}`, depth + 1);
      if (item !== undefined) out[key] = item;
    }
    return out;
  }
  return undefined;
}

/** 字节数（按 UTF-8）。不能用 `s.length` 近似 —— 那会低估中文，让上限形同虚设。 */
function byteSize(value) {
  try {
    const s = JSON.stringify(value);
    // 这个模块会被渲染层间接打包进去（projectManager 用 projectFormat 的常量），
    // 那里没有 Node 的 Buffer，所以两个全局都按需取，不直接引用。
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    if (g.Buffer && typeof g.Buffer.byteLength === 'function') {
      return g.Buffer.byteLength(s, 'utf8');
    }
    if (typeof g.TextEncoder === 'function') {
      return new g.TextEncoder().encode(s).length;
    }
    return s.length;
  } catch (_) {
    return Infinity;
  }
}

function normalizeId(raw) {
  const id = String(raw || '').trim();
  if (!id || id.length > 64) return null;
  // 插件 id 允许点分（com.example.sv2），但不允许空白与控制字符 ——
  // 它会成为 UI 上"这份数据来自谁"的标签。
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null;
  return id;
}

/**
 * 归一化单个字段的声明。
 *
 * @returns {object|null} null 表示"这一项不成立"，调用方丢弃并告警
 */
function normalizeFieldSpec(name, spec, warnings, label) {
  if (!isPlainObject(spec)) {
    warnings.push(`${label}.${name} 不是对象，已忽略`);
    return null;
  }
  const kind = String(spec.kind || '');
  if (!EXT_KINDS.includes(kind)) {
    warnings.push(`${label}.${name}.kind=${JSON.stringify(spec.kind)} 不受支持，已忽略`);
    return null;
  }
  const out = { kind, editable: spec.editable === true };

  if (kind === 'enum') {
    const options = (Array.isArray(spec.options) ? spec.options : [])
      .filter((v) => typeof v === 'string' && v.length > 0 && v.length <= 64)
      .slice(0, 512);
    if (!options.length) {
      warnings.push(`${label}.${name} 是 enum 但没有合法 options，已忽略`);
      return null;
    }
    out.options = options;
  }
  if (kind === 'number') {
    const min = num(spec.min, 0);
    const max = num(spec.max, 1);
    if (max <= min) {
      warnings.push(`${label}.${name} 的 min/max 非法（${min}–${max}），按 0–1 处理`);
      out.min = 0;
      out.max = 1;
    } else {
      out.min = min;
      out.max = max;
    }
    out.step = Math.max(Number.MIN_VALUE, num(spec.step, 1));
    if (typeof spec.unit === 'string' && spec.unit.length <= 12) out.unit = spec.unit;
    out.digits = clamp(Math.round(num(spec.digits, 0)), 0, 4);
  }
  if (kind === 'text' || kind === 'phonemes') {
    out.maxLength = clamp(Math.round(num(spec.maxLength, kind === 'phonemes' ? 200 : 2000)), 1, 100000);
  }
  // 曲线字段的插值方式可以逐字段覆盖，缺省用 schema 级 curve
  if (kind === 'curve' && isPlainObject(spec.curve)) {
    out.curve = normalizeCurve(spec.curve, warnings, `${label}.${name}.curve`);
  }
  if (typeof spec.label === 'string' && spec.label.length <= 80) out.label = spec.label;
  return out;
}

function normalizeCurve(raw, warnings, label) {
  if (!isPlainObject(raw)) {
    warnings.push(`${label} 不是对象，已忽略`);
    return null;
  }
  const out = {};
  const interp = String(raw.interp || 'linear');
  out.interp = CURVE_INTERP.includes(interp) ? interp : 'linear';
  if (out.interp !== interp) {
    warnings.push(`${label}.interp=${JSON.stringify(raw.interp)} 不受支持，按 linear 处理`);
  }
  const quantize = num(raw.quantize, 0);
  if (quantize > 0) out.quantize = quantize;
  if (Array.isArray(raw.clamp) && raw.clamp.length === 2) {
    const lo = num(raw.clamp[0], NaN);
    const hi = num(raw.clamp[1], NaN);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) out.clamp = [lo, hi];
    else warnings.push(`${label}.clamp 非法，已忽略`);
  }
  return out;
}

/**
 * 归一化 extSchema（声明）。
 *
 * 宽容策略与工程文档一致：坏项丢弃 + 告警，不整体拒绝。一个字段的 kind 写错
 * 不该让用户打不开文件 —— 它只是那个字段在界面上显示不出来而已。
 *
 * @param {unknown} raw
 * @param {string[]} warnings
 * @returns {object} 规范化后的 schema（可能为空对象）
 */
export function normalizeExtSchema(raw, warnings = []) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    warnings.push('extSchema 不是对象，已忽略');
    return {};
  }
  const out = {};
  let count = 0;
  for (const rawId of Object.keys(raw)) {
    if (count >= EXT_LIMITS.plugins) {
      warnings.push(`extSchema 超过 ${EXT_LIMITS.plugins} 个插件，其余已丢弃`);
      break;
    }
    const id = normalizeId(rawId);
    if (!id) {
      warnings.push(`extSchema 的键 ${JSON.stringify(rawId)} 不是合法插件 id，已跳过`);
      continue;
    }
    const spec = raw[rawId];
    if (!isPlainObject(spec)) {
      warnings.push(`extSchema.${id} 不是对象，已跳过`);
      continue;
    }
    const entry = {};

    for (const layer of EXT_LAYERS) {
      const fields = spec[layer];
      if (fields === undefined) continue;
      if (!isPlainObject(fields)) {
        warnings.push(`extSchema.${id}.${layer} 不是对象，已忽略`);
        continue;
      }
      const names = Object.keys(fields).slice(0, EXT_LIMITS.fieldsPerLayer);
      if (Object.keys(fields).length > EXT_LIMITS.fieldsPerLayer) {
        warnings.push(`extSchema.${id}.${layer} 字段超过 ${EXT_LIMITS.fieldsPerLayer} 个，其余已丢弃`);
      }
      const table = {};
      for (const name of names) {
        if (!name || name.length > EXT_LIMITS.nameLength) {
          warnings.push(`extSchema.${id}.${layer} 有非法字段名 ${JSON.stringify(name)}，已跳过`);
          continue;
        }
        const field = normalizeFieldSpec(name, fields[name], warnings, `extSchema.${id}.${layer}`);
        if (field) table[name] = field;
      }
      if (Object.keys(table).length) entry[layer] = table;
    }

    if (spec.render !== undefined) {
      if (isPlainObject(spec.render) && typeof spec.render.hook === 'string' && spec.render.hook) {
        entry.render = {
          hook: spec.render.hook.slice(0, 64),
          order: clamp(num(spec.render.order, 0), -1000, 1000),
        };
      } else {
        warnings.push(`extSchema.${id}.render 需要 { hook: string }，已忽略`);
      }
    }

    if (spec.curve !== undefined) {
      const curve = normalizeCurve(spec.curve, warnings, `extSchema.${id}.curve`);
      if (curve) entry.curve = curve;
    }

    if (!Object.keys(entry).length) continue;
    if (byteSize(entry) > EXT_LIMITS.schemaBytes) {
      warnings.push(`extSchema.${id} 超过 ${EXT_LIMITS.schemaBytes} 字节，已丢弃`);
      continue;
    }
    out[id] = entry;
    count++;
  }
  return out;
}

/**
 * 归一化某一层的 ext 数据。
 *
 * 只做"能不能安全搬运"的判断（纯 JSON、大小上限），**不解释内容**。
 * 解释是插件自己的事 —— 宿主连它是不是音素都不需要知道。
 *
 * @param {unknown} raw
 * @param {string[]} warnings
 * @param {string} label 出现在告警里的位置，如 `fragments[0].ext`
 * @returns {object} 规范化后的数据（可能为空对象）
 */
export function normalizeExtData(raw, warnings = [], label = 'ext') {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    warnings.push(`${label} 不是对象，已忽略`);
    return {};
  }
  const out = {};
  let count = 0;
  for (const rawId of Object.keys(raw)) {
    if (count >= EXT_LIMITS.plugins) {
      warnings.push(`${label} 超过 ${EXT_LIMITS.plugins} 个插件，其余已丢弃`);
      break;
    }
    const id = normalizeId(rawId);
    if (!id) {
      warnings.push(`${label} 的键 ${JSON.stringify(rawId)} 不是合法插件 id，已跳过`);
      continue;
    }
    const cloned = clonePlain(raw[rawId], warnings, `${label}.${id}`);
    if (cloned === undefined) {
      warnings.push(`${label}.${id} 不是可序列化的数据，已跳过`);
      continue;
    }
    const size = byteSize(cloned);
    if (!Number.isFinite(size) || size > EXT_LIMITS.entryBytes) {
      warnings.push(`${label}.${id} 超过 ${EXT_LIMITS.entryBytes} 字节，已丢弃`);
      continue;
    }
    out[id] = cloned;
    count++;
  }
  return out;
}

/**
 * 统计整份文档用到的扩展数据。
 *
 * 用途有两个：总大小兜底（单条合格不代表十条合起来合格），以及保存时的提示
 * —— "有 3 组扩展数据不会被写入 .vsqx" 必须让用户看见，不能静默丢弃。
 *
 * @param {object} document
 * @returns {{plugins:string[], bytes:number, notes:number, truncated:boolean}}
 */
export function summarizeExt(document) {
  const plugins = new Set();
  let bytes = 0;
  let notes = 0;
  let truncated = false;

  const take = (ext) => {
    if (!ext || typeof ext !== 'object') return;
    for (const id of Object.keys(ext)) {
      plugins.add(id);
      bytes += byteSize(ext[id]) || 0;
    }
  };

  take(document && document.ext);
  for (const s of (document && document.singers) || []) take(s && s.ext);
  for (const f of (document && document.fragments) || []) {
    take(f && f.ext);
    for (const n of (f && f.notes) || []) {
      if (n && n.ext && Object.keys(n.ext).length) {
        notes++;
        take(n.ext);
      }
    }
  }

  if (bytes > EXT_LIMITS.totalBytes) truncated = true;
  return { plugins: [...plugins], bytes, notes, truncated };
}

/**
 * 某个插件在某层声明了哪些字段。
 *
 * 渲染层用它决定"这条 note 的音素要不要显示、能不能改"。返回空对象表示
 * 该插件在这一层没有声明 —— 那时数据仍然存在，只是宿主不呈现它。
 */
export function fieldsFor(schema, pluginId, layer) {
  if (!schema || !pluginId || !layer) return {};
  const entry = schema[pluginId];
  if (!entry || !entry[layer]) return {};
  return entry[layer];
}

/**
 * 在某一层的 ext 数据里，找出宿主认识的那一类字段。
 *
 * 渲染层不知道"哪个插件提供了音素"——它只知道"某个插件声明了 kind:'phonemes'"。
 * 这个函数把声明反查回具体值，并把可编辑性一起带出来：界面据此决定是正常显示
 * 还是灰掉。
 *
 * 找不到返回 null（不是空对象）：调用方要能区分"没有这类数据"和"有数据但为空"。
 *
 * @param {object} ext 该层的 ext（`{}` / undefined 都行）
 * @param {object} schema document.extSchema
 * @param {'document'|'singer'|'fragment'|'note'} layer
 * @param {string} kind EXT_KINDS 之一
 * @returns {{pluginId:string, field:string, value:any, editable:boolean}|null}
 */
export function findField(ext, schema, layer, kind) {
  if (!ext || typeof ext !== 'object') return null;
  for (const pluginId of Object.keys(ext)) {
    const fields = fieldsFor(schema, pluginId, layer);
    for (const name of Object.keys(fields)) {
      const spec = fields[name];
      if (spec.kind !== kind) continue;
      const bag = ext[pluginId];
      const value = bag && typeof bag === 'object' ? bag[name] : undefined;
      if (value === undefined) continue;
      return { pluginId, field: name, value, editable: spec.editable === true };
    }
  }
  return null;
}
