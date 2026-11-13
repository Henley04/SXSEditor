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
const { createJsonFileCache } = require('../persistentCache');

const PROVIDERS_TTL_MS = 12 * 60 * 60 * 1000;   // 12h
const READY_EPS_TTL_MS = 24 * 60 * 60 * 1000;   // 24h

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
 * 已解析的可注册 EP 库（libraryPath）缓存。
 * 缓存命中要求：指纹一致、未过期、且每个 libraryPath 仍然存在。
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

async function flush() {
  return _store.flush();
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
  getFingerprint,
  fingerprintKey,
  flush,
  clear,
  _resetForTest,
};
