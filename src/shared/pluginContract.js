/**
 * SXSEditor 歌声后端插件契约（v1）——纯常量与校验，不依赖 Electron / Node API。
 *
 * 这个文件被两侧共享：
 *   · 主进程（src/main/pluginHost.js）用它校验 manifest 与插件导出对象；
 *   · 渲染进程用它做 UI 层的类型判断（不需要 require 插件代码）。
 *
 * ## 设计取向：为什么插件默认跑在 worker 线程里？
 *
 * 早期版本把插件 `require()` 进主进程本线程（现称 **in-process 模式**），理由是
 * 歌声后端是延迟敏感热路径——30 秒片段在 44100Hz 下单声道就有 1.3M 个 float，
 * 若能同进程传引用就不需要任何序列化。这个理由只对了一半：
 *
 *   · **数据**确实不该序列化：主进程持有的 `notes` / `options`（含 refAudioWavBuffer、
 *     pitchCurveF0 等 Float32Array）仍应以零拷贝方式交给插件——worker 模式下走
 *     `postMessage(value, transferList)`，ArrayBuffer 的所有权整体转移而不是克隆，
 *     4MB 的 pitchCurveF0 实测往返在毫秒级（见 verify 脚本 §4）。
 *   · **执行**必须离开主进程事件循环：插件里一个同步忙等（while(Date.now()-t<2000)）
 *     会让主进程 setTimeout 永不触发，`Promise.race` 超时形同虚设（审计实测：2s
 *     忙等在 300ms 超时下照样 success）。单线程内没有任何手段能抢占同步代码，
 *     唯一能真正掐断它的是 `worker.terminate()`——所以它成了默认项。
 *
 * 因此宿主提供两种执行模式，插件看到的 host / request 形状完全相同：
 *
 *   1. `worker`（默认）：插件在 worker_threads 里执行，超时即 `terminate()`，
 *      真正的抢占；宿主自动重建 worker 并重跑 initialize，连续超时达上限才
 *      把插件标记为 failed。
 *   2. `inprocess`：必须在 manifest 里显式声明，且通过宿主侧白名单 + 警告日志。
 *      ★ 诚实边界：此模式下**同步阻塞无法被抢占**，超时只能等同步代码自己返回。
 *      留给确实需要主进程资源（如自定义 WebNN/WebGPU 上下文）的插件，代价自负。
 *
 * 无论哪种模式，调用 `synthesize` / `getVoices` 之前都必须先 `initialize`，宿主侧对每个调用都做了：
 *   · 生命周期护栏（dispose 后一律拒绝）
 *   · 返回值校验（pcm 类型/有限值/长度上限、sampleRate 取值范围）
 *   · 异常隔离（插件抛错不会崩宿主，错误脱敏后上报）
 * 插件目录只允许从 `<userData>/plugins` 加载，且必须先经安全层授权。
 */

export const PLUGIN_API_VERSION = 1;

/** 单次插件调用（synthesize / prepare）的默认超时（毫秒）。 */
export const PLUGIN_CALL_TIMEOUT_MS = 120000;

/** 单个插件允许声明的最大轨道种类数，防止恶意/破损 manifest 撑爆 UI。 */
export const PLUGIN_MAX_TRACK_KINDS = 32;

/** 单音色单插件允许返回的最大音色数。 */
export const PLUGIN_MAX_VOICES = 4096;

/** 插件 id 的合法字符集：反向域名风格，避免与内置后端混淆。 */
const PLUGIN_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** trackKind id 允许的字符。 */
const KIND_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,62}[A-Za-z0-9])?$/;

/** 内置分片编辑器可复用的子面板（供 `editor.mode === 'midi-partial'` 使用）。 */
export const MIDI_EDITOR_PANELS = Object.freeze([
  'pianoRoll',   // 钢琴卷帘（音符）
  'phoneme',     // 音素 / 歌词
  'pitch',       // 音高曲线
  'envelope',    // 音量 / 声像包络
  'params',      // 侧边参数面板
]);

/** 插件轨道的编辑器模式。 */
export const TRACK_EDITOR_MODES = Object.freeze(['plugin', 'midi', 'midi-partial']);

/** 插件自定义参数支持的数据类型（决定渲染层画什么控件）。 */
export const PARAM_TYPES = Object.freeze([
  'number', 'integer', 'boolean', 'string', 'enum', 'file', 'voice',
]);

/**
 * 插件可声明的能力开关。
 * - synthesize:      实现 synthesize()，可作为合成后端
 * - blockPlayback:   允许在播放前阻滞（用于推理/拼接耗时长的后端）
 * - streaming:       支持分片推送音频（host.emitAudio）
 * - voices:          实现 getVoices()，提供音色列表
 */
export const DEFAULT_CAPABILITIES = Object.freeze({
  synthesize: false,
  blockPlayback: false,
  streaming: false,
  voices: false,
});

/**
 * 合成结果的字段约定（全部可选，缺省值由 host 填平）：
 *
 *   {
 *     // 音频。单声道或按 channels 交错存放的 Float32Array。
 *     // streaming 插件可以返回 null 并改用 host.emitAudio(chunk) 推送。
 *     pcm: Float32Array | Float32Array[] | null,
 *     channels: number,        // 1 = 单声道；>1 时 pcm 为交错数据
 *     sampleRate: number,      // 缺省用宿主工程的采样率
 *     leadingSamples: number,  // pcm[0] 相对请求起点需要前置补零的样本数
 *     diagnostics: object,     // 任意诊断信息，会转交给 UI 的插件输出通道
 *   }
 */

/**
 * 校验插件 id。
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidPluginId(id) {
  return typeof id === 'string' && PLUGIN_ID_RE.test(id) && id !== 'builtin' && id !== 'sxs';
}

/**
 * 校验轨道种类 id。
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidKindId(id) {
  return typeof id === 'string' && KIND_ID_RE.test(id);
}

/**
 * 校验 semver 风格的版本字符串（宽松：允许 `1.2.3`、`1.2.3-beta.1`，不允许空串）。
 * @param {unknown} v
 * @returns {boolean}
 */
export function isValidVersion(v) {
  return typeof v === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v);
}

/**
 * 是否内置后端（不走插件通道）。
 * @param {unknown} backendType
 * @returns {boolean}
 */
export function isBuiltinBackend(backendType) {
  return backendType === 'sxs' || backendType == null;
}

/**
 * 解析 Single|bool 的能力声明，补齐缺省。
 * @param {unknown} caps
 * @returns {{synthesize:boolean, blockPlayback:boolean, streaming:boolean, voices:boolean}}
 */
export function normalizeCapabilities(caps) {
  const out = { ...DEFAULT_CAPABILITIES };
  if (!caps || typeof caps !== 'object') return out;
  for (const key of Object.keys(DEFAULT_CAPABILITIES)) {
    if (typeof caps[key] === 'boolean') out[key] = caps[key];
  }
  return out;
}

/**
 * 校验单个 paramSchema 条目。
 * @param {unknown} p
 * @returns {string|null} 错误信息，合法时返回 null
 */
export function validateParamSchemaEntry(p) {
  if (!p || typeof p !== 'object') return 'paramSchema entry must be an object';
  if (!isValidParamKey(p.key)) return 'paramSchema.key must be a non-empty string';
  if (!PARAM_TYPES.includes(p.type)) return `paramSchema.type '${p.type}' is not supported`;
  if (p.type === 'enum') {
    if (!Array.isArray(p.options) || p.options.length === 0) return 'enum params require non-empty options';
  }
  if (p.type === 'number' || p.type === 'integer') {
    if (p.min !== undefined && typeof p.min !== 'number') return 'min must be a number';
    if (p.max !== undefined && typeof p.max !== 'number') return 'max must be a number';
  }
  return null;
}

function isValidParamKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length <= 64 && !k.includes('.') && !k.includes('$');
}

/**
 * 校验并规范化一个 trackKind 声明。
 * @param {unknown} kind
 * @param {string} pluginId
 * @returns {{ok:true, value:object}|{ok:false, error:string}}
 */
export function validateTrackKind(kind, pluginId) {
  if (!kind || typeof kind !== 'object') return { ok: false, error: 'trackKind must be an object' };
  if (!isValidKindId(kind.id)) return { ok: false, error: `invalid trackKind.id: ${kind.id}` };
  const name = typeof kind.name === 'string' && kind.name.trim() ? kind.name.trim() : kind.id;

  // ---- 编辑器 modes：决定插件轨道长什么样 ----
  //   plugin        → 轨道形式完全由插件规定（自带面板）
  //   midi          → 直接复用内置 MIDI 分片编辑器（全部子面板）
  //   midi-partial  → 复用内置编辑器的**部分**子面板，由 use/hide 指定
  const editor = kind.editor && typeof kind.editor === 'object' ? kind.editor : {};
  const mode = TRACK_EDITOR_MODES.includes(editor.mode) ? editor.mode : 'plugin';
  if (mode === 'plugin' && !editor.panel) {
    return { ok: false, error: `trackKind '${kind.id}': editor.mode='plugin' requires editor.panel` };
  }
  let usePanels = null;
  if (mode === 'midi-partial') {
    if (!Array.isArray(editor.use) || editor.use.length === 0) {
      return { ok: false, error: `trackKind '${kind.id}': 'midi-partial' requires non-empty editor.use` };
    }
    for (const p of editor.use) {
      if (!MIDI_EDITOR_PANELS.includes(p)) {
        return { ok: false, error: `trackKind '${kind.id}': unknown midi panel '${p}'` };
      }
    }
    usePanels = [...editor.use];
  }

  if (kind.paramSchema !== undefined) {
    if (!Array.isArray(kind.paramSchema)) return { ok: false, error: 'paramSchema must be an array' };
    if (kind.paramSchema.length > 128) return { ok: false, error: 'too many paramSchema entries' };
    for (const p of kind.paramSchema) {
      const err = validateParamSchemaEntry(p);
      if (err) return { ok: false, error: `trackKind '${kind.id}': ${err}` };
    }
  }

  return {
    ok: true,
    value: {
      id: kind.id,
      pluginId,
      // 渲染层用它替换原来硬编码的 'SXS INFERENCE' 标签
      name,
      description: typeof kind.description === 'string' ? kind.description : '',
      editor: {
        mode,
        panel: editor.panel ? sanitizePanel(editor.panel, pluginId) : null,
        use: usePanels,
        hide: Array.isArray(editor.hide) ? editor.hide.filter(p => MIDI_EDITOR_PANELS.includes(p)) : [],
        // midi / midi-partial 是否允许编辑（false = 只读预览，由插件生成内容）
        readOnly: editor.readOnly === true,
      },
      paramSchema: Array.isArray(kind.paramSchema) ? kind.paramSchema : [],
      defaults: kind.defaults && typeof kind.defaults === 'object' ? { ...kind.defaults } : {},
    },
  };
}

/**
 * 收紧 panel 声明：只允许相对路径本地面板，禁止 http(s) 远端 URL 与绝对路径，
 * 避免插件把任意外部页面塞进应用窗口（锚点与 javascript: 等协议一并拒绝）。
 * @param {object} panel
 * @param {string} pluginId
 */
function sanitizePanel(panel, pluginId) {
  const relPath = typeof panel.relativePath === 'string' ? panel.relativePath : '';
  if (!relPath) return { type: 'none', relativePath: '' };
  // 归一化后必须仍在插件目录内，且不得指向 http(s):// 或 jar: 等外部协议
  const cleaned = relPath.replace(/\\/g, '/');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(cleaned) || cleaned.startsWith('/') || cleaned.startsWith('../')) {
    console.warn(`[plugins] '${pluginId}' declared an unsafe panel path '${relPath}', ignoring`);
    return { type: 'none', relativePath: '' };
  }
  return { type: 'local', relativePath: cleaned };
}

/**
 * 按 paramSchema + defaults 计算某次调用的最终插件参数。
 * 纯函数，渲染层与 host 都用同一份逻辑，避免两边不一致。
 *
 * @param {Array} schema
 * @param {object} defaults
 * @param {object} [overrides]
 * @returns {object}
 */
export function resolvePluginParams(schema, defaults, overrides) {
  const out = { ...defaults };
  for (const entry of schema || []) {
    if (!(entry.key in out)) {
      out[entry.key] = entry.default !== undefined ? entry.default : defaultForType(entry.type);
    }
  }
  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined || v === null) continue;
      // 只接受 schema 里声明过的键，其余（可能是旧版本残留）直接丢弃，
      // 防止插件之外的代码向插件塞未声明数据。
      if ((schema || []).some(e => e.key === k)) out[k] = v;
    }
  }
  return out;
}

function defaultForType(type) {
  switch (type) {
    case 'boolean': return false;
    case 'number':
    case 'integer': return 0;
    case 'enum': return null;
    default: return '';
  }
}

export {
  PLUGIN_ID_RE,
  KIND_ID_RE,
};
