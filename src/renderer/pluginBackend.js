/**
 * 插件后端的渲染进程数据层：后端判定、插件清单缓存、轨道标签描述、参数规整。
 *
 * 这里**不碰 DOM**（UI 在 pluginTrackDialog.js / timelineRenderer.js），只回答
 * "这条轨道用什么后端唱歌"以及"插件清单里有没有它"这两个问题。
 *
 * 插件清单（pluginAPI.list()）是异步 IPC，但它决定时间轴上要显示什么名字，
 * 因此这里做了一份进程内缓存：
 *   · ensurePluginCatalog() 幂等，多次调用共用一个 Promise；
 *   · 失败也会落一份空清单，避免每次重绘都重发 IPC 打满主进程；
 *   · 插件数据（name/description）一律视为外部输入，显示前先 truncateText()。
 */

import { t } from '../i18n/index.js';
import { getSingerBackend } from '../editor/trackManager.js';
import {
  resolvePluginParams,
  validateParamSchemaEntry,
  isBuiltinBackend,
} from '../shared/pluginContract.js';

/** 插件名 / 描述等外部文本的最大展示长度（防止恶意超长串撑爆布局）。 */
const MAX_NAME_LEN = 48;
const MAX_DESC_LEN = 160;

/** @type {{plugins:object[], pluginsDir:string, errors:object[]}|null} */
let _catalog = null;
/** @type {Promise<object>|null} */
let _catalogPromise = null;
/** key = `${pluginId}\u0000${kindId || ''}` */
const _voiceCache = new Map();

function getPluginApi() {
  return typeof window !== 'undefined' && window.electronAPI ? window.electronAPI.pluginAPI : null;
}

/**
 * 截断外部（插件提供的）文本。超长时保留尾部省略号，非字符串一律转字符串。
 * @param {unknown} text
 * @param {number} max
 */
export function truncateText(text, max = MAX_NAME_LEN) {
  const str = typeof text === 'string' ? text : String(text ?? '');
  if (str.length <= max) return str;
  return str.slice(0, Math.max(1, max - 1)) + '…';
}

/** 清单是否已就绪（含"加载失败但已尝试过"的空清单）。 */
export function hasPluginCatalog() {
  return _catalog !== null;
}

/** 当前清单快照（未就绪返回 null）。 */
export function getPluginCatalog() {
  return _catalog;
}

/** 丢弃缓存（reload 后下次调用会重新拉）。 */
export function invalidatePluginCatalog() {
  _catalog = null;
  _catalogPromise = null;
  _voiceCache.clear();
}

/**
 * 拉取插件清单（幂等）。插件系统不可用时返回空清单而不是抛错——
 * UI 不能因为插件宿主没起来就打不开。
 * @param {boolean} [force] true = 丢弃缓存重新拉
 * @returns {Promise<{plugins:object[], pluginsDir:string, errors:object[]}>}
 */
export function ensurePluginCatalog(force = false) {
  if (force) invalidatePluginCatalog();
  if (_catalog) return Promise.resolve(_catalog);
  if (_catalogPromise) return _catalogPromise;

  const api = getPluginApi();
  if (!api || typeof api.list !== 'function') {
    // 没有插件通道（旧版 preload / 单测环境）：视作"零插件"，不再重试。
    _catalog = { plugins: [], pluginsDir: '', errors: [], unavailable: true };
    return Promise.resolve(_catalog);
  }

  _catalogPromise = Promise.resolve(api.list())
    .then((res) => {
      const plugins = res && Array.isArray(res.plugins) ? res.plugins : [];
      _catalog = {
        plugins,
        pluginsDir: typeof res?.pluginsDir === 'string' ? res.pluginsDir : '',
        errors: Array.isArray(res?.errors) ? res.errors : [],
      };
      _catalogPromise = null;
      return _catalog;
    })
    .catch((err) => {
      console.warn('[plugins] 插件清单加载失败：', err && err.message ? err.message : err);
      _catalog = { plugins: [], pluginsDir: '', errors: [], failed: true };
      _catalogPromise = null;
      return _catalog;
    });
  return _catalogPromise;
}

/** 热重载插件并刷新缓存。 */
export async function reloadPluginCatalog() {
  const api = getPluginApi();
  if (!api || typeof api.reload !== 'function') {
    invalidatePluginCatalog();
    return ensurePluginCatalog();
  }
  invalidatePluginCatalog();
  const res = await api.reload();
  const plugins = res && Array.isArray(res.plugins) ? res.plugins : [];
  _catalog = {
    plugins,
    pluginsDir: typeof res?.pluginsDir === 'string' ? res.pluginsDir : '',
    errors: Array.isArray(res?.errors) ? res.errors : [],
  };
  return _catalog;
}

/** 按 id 取插件（未就绪/不存在返回 null）。 */
export function findPlugin(pluginId) {
  if (!_catalog || !pluginId) return null;
  return _catalog.plugins.find((p) => p.id === pluginId) || null;
}

/** 按插件 id + 轨道种类 id 取 trackKind。 */
export function findTrackKind(pluginId, kindId) {
  const plugin = findPlugin(pluginId);
  if (!plugin || !Array.isArray(plugin.trackKinds)) return null;
  if (!kindId) return plugin.trackKinds.length === 1 ? plugin.trackKinds[0] : null;
  return plugin.trackKinds.find((k) => k.id === kindId) || null;
}

/**
 * 扁平列出所有可创建轨道的插件 trackKind（按插件名 + kind 名排序）。
 * @returns {Array<{plugin:object, kind:object}>}
 */
export function listTrackKinds() {
  if (!_catalog) return [];
  const out = [];
  for (const plugin of _catalog.plugins) {
    if (!Array.isArray(plugin.trackKinds)) continue;
    for (const kind of plugin.trackKinds) out.push({ plugin, kind });
  }
  out.sort((a, b) => `${a.plugin.name}${a.kind.name}`.localeCompare(`${b.plugin.name}${b.kind.name}`));
  return out;
}

/**
 * 拉取某插件某轨道种类的音色列表（带缓存，失败返回空数组）。
 * @param {string} pluginId
 * @param {string} [kindId]
 * @returns {Promise<object[]>}
 */
export async function fetchVoices(pluginId, kindId) {
  const key = `${pluginId}\u0000${kindId || ''}`;
  if (_voiceCache.has(key)) return _voiceCache.get(key);
  const api = getPluginApi();
  const plugin = findPlugin(pluginId);
  // 插件没声明 voices 能力就不打扰主进程，直接空列表。
  if (!api || !plugin || !plugin.capabilities || plugin.capabilities.voices !== true) {
    _voiceCache.set(key, []);
    return [];
  }
  try {
    const res = await api.getVoices(pluginId, kindId || null);
    const voices = res && res.success && Array.isArray(res.voices) ? res.voices : [];
    _voiceCache.set(key, voices);
    return voices;
  } catch (err) {
    console.warn('[plugins] 音色列表加载失败：', err && err.message ? err.message : err);
    _voiceCache.set(key, []);
    return [];
  }
}

/** 取已缓存的音色（未拉取过返回 null）。 */
export function getCachedVoices(pluginId, kindId) {
  return _voiceCache.get(`${pluginId}\u0000${kindId || ''}`) || null;
}

/** 按 id 在已缓存音色里找名字（找不到返回 null）。 */
export function findVoiceName(pluginId, kindId, voiceId) {
  const voices = getCachedVoices(pluginId, kindId);
  if (!voices || !voiceId) return null;
  const hit = voices.find((v) => v.id === voiceId);
  return hit ? hit.name : null;
}

/**
 * 按 paramSchema + defaults 计算轨道的默认参数（与 host 侧同一套逻辑）。
 * @param {object} kind
 * @param {object} [overrides]
 */
export function resolveKindParams(kind, overrides) {
  return resolvePluginParams(kind?.paramSchema || [], kind?.defaults || {}, overrides);
}

/**
 * 把一个原始输入值规整到 paramSchema 条目声明的取值范围内。
 * 范围规则与 validateParamSchemaEntry() 严格一致（min/max、enum 的 options），
 * 插件自己给的值也重新过一遍，避免手改工程文件塞进越界值。
 * @param {object} entry paramSchema 条目
 * @param {unknown} raw
 */
export function coerceParamValue(entry, raw) {
  if (!entry || typeof entry !== 'object') return raw;
  switch (entry.type) {
    case 'boolean':
      return raw === true || raw === 'true';
    case 'integer':
    case 'number': {
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        return Number.isFinite(entry.default) ? entry.default : 0;
      }
      const value = entry.type === 'integer' ? Math.round(num) : num;
      let out = value;
      if (Number.isFinite(entry.min)) out = Math.max(entry.min, out);
      if (Number.isFinite(entry.max)) out = Math.min(entry.max, out);
      return out;
    }
    case 'enum': {
      const options = Array.isArray(entry.options) ? entry.options : [];
      if (options.length === 0) return null;
      return options.includes(raw) ? raw : options[0];
    }
    case 'string':
    case 'file':
    case 'voice':
      return typeof raw === 'string' ? raw : (raw === undefined || raw === null ? '' : String(raw));
    default:
      return raw;
  }
}

/** paramSchema 条目是否可渲染（顺手过滤掉插件声明错的条目）。 */
export function isRenderableParam(entry) {
  return validateParamSchemaEntry(entry) === null;
}

/**
 * 描述一条轨道的后端，供时间轴标签使用。
 *
 * 内置后端固定返回既有的品牌标识 'SXS INFERENCE'（不是 i18n 键，不要翻译）。
 * 插件后端返回 trackKind 的 name（插件自定义），并把插件名/音色放进 detail。
 *
 * @param {object} singer
 * @returns {{label:string, detail:string, missing:boolean}}
 */
export function describeTrackBackend(singer) {
  const backend = getSingerBackend(singer);
  if (isBuiltinBackend(backend.type)) {
    // 既有品牌标识：保持原样，不做 i18n、不改文案。
    return { label: 'SXS INFERENCE', detail: '', missing: false };
  }
  if (backend.type !== 'plugin') {
    return { label: 'SXS INFERENCE', detail: '', missing: false };
  }

  const pluginId = backend.pluginId || '';
  const kindId = backend.kindId || '';

  // 清单还没拉到（首帧 / IPC 未完成）：先用 kindId 顶着，等清单到达后重绘。
  if (!hasPluginCatalog()) {
    return { label: truncateText(kindId || pluginId || t('main.plugin.unknownKind'), MAX_NAME_LEN), detail: '', missing: false };
  }

  const kind = findTrackKind(pluginId, kindId);
  if (!kind) {
    // 插件被删了：保留 backend 字段，只提示缺失 —— 不静默降级成内置后端。
    return {
      label: t('main.plugin.missingShort'),
      detail: t('main.plugin.missingDetail', {
        pluginId: truncateText(pluginId || '?', 32),
        kindId: truncateText(kindId || '?', 32),
      }),
      missing: true,
    };
  }

  const plugin = findPlugin(pluginId);
  const detailParts = [];
  if (plugin) {
    detailParts.push(t('main.plugin.byPlugin', {
      name: truncateText(plugin.name || pluginId, 32),
      version: typeof plugin.version === 'string' ? plugin.version : '',
    }));
  }
  if (backend.voiceId) {
    detailParts.push(t('main.plugin.voiceOf', {
      voice: truncateText(findVoiceName(pluginId, kindId, backend.voiceId) || backend.voiceId, 32),
    }));
  }
  return {
    label: truncateText(kind.name || kind.id, MAX_NAME_LEN),
    detail: detailParts.join(' · '),
    missing: false,
  };
}

export { MAX_NAME_LEN, MAX_DESC_LEN };
