/**
 * winmlDetectionCache.js — Windows ML EP 探测结果的跨重启缓存。
 *
 * 探测链路的成本（按耗时排序）：
 *   1. `locateBootstrapDll` 在 Edge / PowerToys / WindowsApps 下做深度目录遍历；
 *   2. `ExecutionProviderCatalog` 初始化（dynwinrt + WinAppSDK bootstrap）；
 *   3. 逐个 provider 调 EnsureReadyAsync / canLoadLibrary 验证插件 DLL 可加载。
 *
 * 这些结果在"EP 包没更新、系统没升级、应用没换版本"时完全不变。把它们按
 * 指纹（Electron 版本 / OS build / 架构）落到 userData，下次启动直接复用：
 *   · bootstrap 路径：只要文件仍存在就复用；
 *   · provider 列表（设置页下拉）：TTL 内直接返回，过期则先返回旧值、后台刷新；
 *   · 已就绪 EP 库（worker 快照）：校验每个 libraryPath 仍存在，TTL 内复用。
 *
 * 任何条目失配/文件消失都返回 null，调用方走原有完整探测，不影响正确性。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJsonFileCache } = require('../persistentCache');

const PROVIDERS_TTL_MS = 12 * 60 * 60 * 1000;   // 12h
const READY_EPS_TTL_MS = 24 * 60 * 60 * 1000;   // 24h
// "这个 provider DLL 加载不起来"结论的有效期。比 readyEps 长很多是有意的：
// 旧 ABI 的 EP 包（如 ORT 1.24 时代的 EP.1.8）通常会一直留在机器上，
// 单纯等它过期只会让用户每次启动重新付一遍 LoadLibrary 的钱。
const UNLOADABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

function getOsBuild() {
  try {
    if (typeof os.build === 'number') return os.build;
    const release = os.release && os.release();
    const m = String(release || '').match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  } catch (_) {
    return 0;
  }
}

/** 影响 EP ABI / 可选包的环境指纹。 */
function getFingerprint() {
  return {
    arch: process.arch,
    electron: process.versions && process.versions.electron ? process.versions.electron : '',
    node: process.versions ? process.versions.node : '',
    osBuild: getOsBuild(),
  };
}

function fingerprintKey() {
  const fp = getFingerprint();
  return `${fp.arch}|${fp.electron}|${fp.osBuild}`;
}

const _store = createJsonFileCache('winml-detection-cache.json', {
  format: 1,
  merge: (diskData, localData) => ({ ...diskData, ...(localData || {}) }),
});

function configureCacheDir(dir) {
  _store.configureDir(dir);
}

/** bootstrap DLL 路径：文件仍存在即复用（路径本身已包含版本信息）。 */
function getCachedBootstrapPath() {
  if (!_store.getDir()) return null;
  const entry = _store.load().data.bootstrap;
  const p = entry && typeof entry.path === 'string' ? entry.path : '';
  if (!p) return null;
  try {
    if (!fs.statSync(p).isFile()) return null;
  } catch (_) {
    return null;
  }
  return p;
}

function setCachedBootstrapPath(path) {
  if (!path) return;
  _store.update((data) => {
    data.bootstrap = { path, savedAt: Date.now() };
    return true;
  });
}

/**
 * 设置页用的 provider 列表缓存。
 * @returns {{list:Array<{name:string, readyState:number}>, fresh:boolean}|null}
 */
function getCachedProviders() {
  if (!_store.getDir()) return null;
  const entry = _store.load().data.providers;
  if (!entry || !Array.isArray(entry.list)) return null;
  if (entry.fingerprint !== fingerprintKey()) return null;
  if (!entry.list.every((p) => p && typeof p.name === 'string')) return null;
  const fresh = Date.now() - (entry.savedAt || 0) <= PROVIDERS_TTL_MS;
  return {
    list: entry.list.map((p) => ({ name: p.name, readyState: Number(p.readyState) || 0 })),
    fresh,
  };
}

function setCachedProviders(list) {
  if (!Array.isArray(list)) return;
  _store.update((data) => {
    data.providers = {
      fingerprint: fingerprintKey(),
      savedAt: Date.now(),
      list: list.map((p) => ({ name: p.name, readyState: Number(p.readyState) || 0 })),
    };
    return true;
  });
}

/**
 * EP 库路径的可信根。
 *
 * 缓存文件在可写的 userData 里，而里面的 libraryPath 会被直接注册成 EP 并
 * LoadLibrary。能写 userData 基本已有用户级权限，但没必要让一个被同步工具/
 * 旧版本残留污染的 JSON 决定"加载哪个 DLL"。因此只接受系统、应用、用户目录
 * 下的路径；自定义安装位置可用 SXS_EP_TRUST_DIRS（path.delimiter 分隔）追加。
 */
function _trustedEpRoots() {
  const list = [];
  const push = (value) => {
    if (typeof value !== 'string' || !value) return;
    try {
      const resolved = path.resolve(value);
      list.push(process.platform === 'win32' ? resolved.toLowerCase() : resolved);
    } catch (_) { /* 非法路径忽略 */ }
  };
  push(process.env.LOCALAPPDATA);
  push(process.env.APPDATA);
  push(process.env.ProgramData);
  push(process.env.ProgramFiles);
  push(process.env['ProgramFiles(x86)']);
  push(os.homedir());
  push(process.resourcesPath);
  try { push(path.dirname(process.execPath)); } catch (_) { /* 非 Electron 环境 */ }
  for (const extra of String(process.env.SXS_EP_TRUST_DIRS || '').split(path.delimiter)) {
    push(extra);
  }
  return [...new Set(list)];
}

/**
 * 缓存里的 libraryPath 是否可信。
 * 不满足就当缓存未命中 —— 调用方走完整探测重新解析，不会因此报错。
 */
function _isTrustedEpLibraryPath(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  if (candidate.includes('\0')) return false;
  if (!candidate.toLowerCase().endsWith('.dll')) return false;
  if (!path.isAbsolute(candidate)) return false;
  let resolved;
  try {
    resolved = path.resolve(candidate);
  } catch (_) {
    return false;
  }
  const roots = _trustedEpRoots();
  // 无法判定（极少见：既没有系统目录也没有 homedir）时保持旧行为。
  if (roots.length === 0) return true;
  const probe = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return roots.some((root) => probe === root || probe.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

/**
 * 已解析的可注册 EP 库（libraryPath）缓存。
 * 缓存命中要求：指纹一致、未过期、且每个 libraryPath 仍存在。
 * @param {string} gateKey 后端门控键（DML/WinML 切换后不应复用）
 * @returns {Array<{name:string, libraryPath:string}>|null}
 */
function getCachedReadyEps(gateKey) {
  if (!_store.getDir() || !gateKey) return null;
  const entry = _store.load().data.readyEps;
  if (!entry || entry.gateKey !== gateKey || entry.fingerprint !== fingerprintKey()) return null;
  if (!Array.isArray(entry.list) || entry.list.length === 0) return null;
  if (Date.now() - (entry.savedAt || 0) > READY_EPS_TTL_MS) return null;
  for (const item of entry.list) {
    if (!item || typeof item.name !== 'string' || typeof item.libraryPath !== 'string') return null;
    if (!_isTrustedEpLibraryPath(item.libraryPath)) return null;
    try {
      if (!fs.statSync(item.libraryPath).isFile()) return null;
    } catch (_) {
      return null;
    }
  }
  return entry.list.map((item) => ({ name: item.name, libraryPath: item.libraryPath }));
}

function setCachedReadyEps(gateKey, list) {
  if (!gateKey || !Array.isArray(list) || list.length === 0) return;
  _store.update((data) => {
    data.readyEps = {
      gateKey,
      fingerprint: fingerprintKey(),
      savedAt: Date.now(),
      list: list.map((item) => ({ name: item.name, libraryPath: item.libraryPath })),
    };
    return true;
  });
}

/**
 * provider DLL 的"探测指纹"：size + mtime。
 *
 * 只用路径做键不安全：MSIX 包被升级时路径可能不变（同版本重建），而文件
 * 变了就必须重新探测。取不到 stat 时返回 null —— 调用方既不写也不读负缓存，
 * 宁可多探测一次，也不要拿一个无法判断版本的结论去阻止加载。
 */
function _fileSignature(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return `${st.size}-${Math.round(st.mtimeMs)}`;
  } catch (_) {
    return null;
  }
}

function _unloadableKey(libraryPath) {
  const p = String(libraryPath || '');
  if (!p) return '';
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * 宿主 onnxruntime-node 的版本（"这个 provider DLL 能不能加载"的最强相关项）。
 *
 * 负缓存必须带上它：应用升级 ORT（ABI 1.27 → 1.28）后，同一份 provider DLL
 * 的可加载性可能整个反转，而文件本身的 size/mtime 不会变。取不到就返回空串，
 * 此时不做版本校验（宁可多探一次，也不要误判成"永远加载不了"）。
 */
let _hostOrtVersionCache;
function _hostOrtVersion() {
  if (_hostOrtVersionCache !== undefined) return _hostOrtVersionCache;
  try {
    _hostOrtVersionCache = String(require('onnxruntime-node/package.json').version || '');
  } catch (_) {
    _hostOrtVersionCache = '';
  }
  return _hostOrtVersionCache;
}

/**
 * 该 provider DLL 是否已被判定"加载不起来"（同一文件指纹 + 同一宿主 ORT 版本内）。
 *
 * 为什么需要：旧 ABI 的 EP 包（ORT 1.24 的 EP.1.8）在宿主 ORT 1.27 上
 * `LoadLibrary` 会先把 TensorRT/CUDA 初始化跑一遍再以 1114 失败，实测单次
 * 3.5–18 s。结论在文件与宿主都不变时是恒定的，没必要每次启动（或每次
 * readyEps 缓存过期）都重付一遍。
 *
 * @param {string} libraryPath
 * @returns {boolean}
 */
function isKnownUnloadable(libraryPath) {
  if (!_store.getDir()) return false;
  const key = _unloadableKey(libraryPath);
  if (!key) return false;
  if (_unloadableRevoked()) return false;
  const sig = _fileSignature(libraryPath);
  if (!sig) return false;
  const map = _store.load().data.unloadable;
  const rec = map && typeof map === 'object' ? map[key] : null;
  if (!rec || rec.sig !== sig) return false;
  const host = _hostOrtVersion();
  if (host && rec.host && rec.host !== host) return false;
  if (Date.now() - (rec.savedAt || 0) > UNLOADABLE_TTL_MS) return false;
  return true;
}

/**
 * 记录一次"provider DLL 加载不起来"。文件指纹取不到时直接放弃记录。
 * @param {string} libraryPath
 * @returns {boolean} 是否写入
 */
function reportUnloadable(libraryPath) {
  const key = _unloadableKey(libraryPath);
  const sig = key ? _fileSignature(libraryPath) : null;
  if (!sig) return false;
  const host = _hostOrtVersion();
  _store.update((data) => {
    const map = (data.unloadable && typeof data.unloadable === 'object') ? data.unloadable : {};
    const now = Date.now();
    const next = {};
    // 顺手清理过期条目，避免负缓存无限增长（机器上装过多个 EP 版本时常见）
    for (const [k, v] of Object.entries(map)) {
      if (v && now - (v.savedAt || 0) <= UNLOADABLE_TTL_MS) next[k] = v;
    }
    next[key] = host ? { sig, host, savedAt: now } : { sig, savedAt: now };
    data.unloadable = next;
    return true;
  });
  return true;
}

/**
 * 撤销某条负缓存（探测成功的同一个 DLL 必须立刻恢复可加载）。
 * 目前只在测试与显式重探时使用。
 * @param {string} libraryPath
 */
function clearUnloadable(libraryPath) {
  const key = _unloadableKey(libraryPath);
  if (!key) return;
  _store.update((data) => {
    const map = data.unloadable;
    if (!map || !map[key]) return false;
    delete map[key];
    return true;
  });
}

/** 调试开关：SXS_WINML_REPROBE=1 时忽略负缓存（排查"装了新包仍不生效"）。 */
function _unloadableRevoked() {
  return process.env.SXS_WINML_REPROBE === '1';
}

async function flush() {
  return _store.flush();
}

/** 同步落盘：before-quit 等退出路径用。 */
function flushSync() {
  return _store.flushSync();
}

async function clear() {
  return _store.clear();
}

function _resetForTest(dir) {
  _store.resetMemory();
  if (dir) _store.configureDir(dir);
  else _store.clearDirOverride();
}

module.exports = {
  configureCacheDir,
  getCachedBootstrapPath,
  setCachedBootstrapPath,
  getCachedProviders,
  setCachedProviders,
  getCachedReadyEps,
  setCachedReadyEps,
  isKnownUnloadable,
  reportUnloadable,
  clearUnloadable,
  getFingerprint,
  fingerprintKey,
  flush,
  flushSync,
  clear,
  _isTrustedEpLibraryPath,
  _resetForTest,
};
