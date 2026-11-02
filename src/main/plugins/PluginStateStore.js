'use strict';
/**
 * 插件目录、状态与审计的落盘层。
 *
 * 目录约定（全部相对 userData，见 pluginApi.PATHS）：
 *   plugins/<id>/            安装目录（只读语义，插件只能读，不许写自己）
 *   plugins/.staging/        安装临时区，成功后原子 rename
 *   plugins/.versions/<id>/  历史版本，用于回滚
 *   plugins-state/registry.json  启用状态 / 来源 / 权限指纹
 *   plugins-state/grants.json    用户授权记录（与 registry 分开：卸载插件不该丢授权历史）
 *   plugin-data/<id>/        插件自己的可写目录（卸载时可选择保留）
 *   logs/plugins-audit.jsonl 审计流水
 *
 * 所有写操作都是"临时文件 + rename"，与 configStore 的约定一致。
 */
const fs = require('node:fs');
const path = require('node:path');

let _electronApp = null;
// 测试用：把 userData 根改到临时目录。生产路径不走这里（默认 null）。
let _rootOverride = null;
function appModule() {
  if (_electronApp !== null) return _electronApp;
  try {
    _electronApp = require('electron').app || false;
  } catch (_) {
    _electronApp = false;
  }
  return _electronApp;
}

function userDataDir() {
  if (_rootOverride) return _rootOverride;
  const app = appModule();
  if (app && typeof app.getPath === 'function') {
    try {
      return app.getPath('userData');
    } catch (_) { /* 测试环境未 ready */ }
  }
  return path.join(require('node:os').tmpdir(), 'sxseditor-fallback-userdata');
}

/**
 * 仅供测试：把整棵插件目录树指向一个隔离的临时根。
 *
 * 没有这个钩子，安装/卸载类用例就只能写到真实的 userData（会污染开发机、
 * 还会让用例之间互相看到对方的插件），或者一律不测 —— 后者等于把"卸载是否
 * 真的删了文件"这条最重要的断言留空。
 * @param {string|null} dir 传 null 恢复默认
 */
function _setRootForTests(dir) {
  _rootOverride = dir || null;
}

function paths() {
  const base = userDataDir();
  return {
    userData: base,
    plugins: path.join(base, 'plugins'),
    staging: path.join(base, 'plugins', '.staging'),
    versions: path.join(base, 'plugins', '.versions'),
    state: path.join(base, 'plugins-state'),
    data: path.join(base, 'plugin-data'),
    logs: path.join(base, 'logs'),
    registry: path.join(base, 'plugins-state', 'registry.json'),
    grants: path.join(base, 'plugins-state', 'grants.json'),
    audit: path.join(base, 'logs', 'plugins-audit.jsonl'),
  };
}

function ensureDirs() {
  const p = paths();
  for (const dir of [p.plugins, p.staging, p.state, p.data, p.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : fallback;
  } catch (err) {
    console.warn(`[plugins] 读取 ${path.basename(file)} 失败，使用默认值:`, err && err.message);
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 读取启用状态与来源。结构：{ version:1, plugins: { [id]: {...} } } */
function readRegistry() {
  const data = readJson(paths().registry, null);
  if (!data || typeof data !== 'object' || !data.plugins || typeof data.plugins !== 'object') {
    return { version: 1, plugins: {} };
  }
  return { version: 1, plugins: data.plugins };
}

function writeRegistry(registry) {
  writeJsonAtomic(paths().registry, { version: 1, plugins: registry.plugins || {} });
}

function getPluginState(registry, id) {
  const entry = (registry.plugins || {})[id];
  return {
    enabled: entry ? entry.enabled !== false : true,
    quarantined: !!(entry && entry.quarantined),
    quarantineReason: (entry && entry.quarantineReason) || '',
    crashes: (entry && entry.crashes) || 0,
    leaks: (entry && entry.leaks) || 0,
    source: (entry && entry.source) || 'folder',
    installedAt: (entry && entry.installedAt) || 0,
    updatedAt: (entry && entry.updatedAt) || 0,
    permissionsHash: (entry && entry.permissionsHash) || '',
    automationExpose: entry ? entry.automationExpose !== false : true,
  };
}

function setPluginState(registry, id, patch) {
  const current = registry.plugins[id] || {};
  registry.plugins[id] = { ...current, ...patch };
  return registry.plugins[id];
}

function removePluginState(registry, id) {
  delete registry.plugins[id];
}

// ---------------------------------------------------------------- 授权
function readGrants() {
  const data = readJson(paths().grants, null);
  return data && typeof data === 'object' && data.grants ? data : { version: 1, grants: {} };
}

function writeGrants(grants) {
  writeJsonAtomic(paths().grants, { version: 1, grants: grants.grants || {} });
}

function getGrant(grants, id) {
  return (grants.grants || {})[id] || null;
}

function setGrant(grants, id, value) {
  grants.grants[id] = value;
}

// ---------------------------------------------------------------- 审计
/**
 * 追加一行审计。失败不抛：审计写不进去不能阻断安装/卸载本身。
 * @param {string} event install|uninstall|grant|deny|kill|crash|leak|reload
 */
function audit(event, pluginId, detail) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      pluginId: pluginId || null,
      detail: detail || null,
    });
    const p = paths();
    fs.mkdirSync(p.logs, { recursive: true });
    fs.appendFileSync(p.audit, `${line}\n`, 'utf8');
  } catch (err) {
    console.warn('[plugins] audit write failed:', err && err.message);
  }
}

/** 读最近 n 条审计，供管理器"日志"页展示。 */
function readAudit(limit = 200) {
  try {
    const file = paths().audit;
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch (_) { return { raw: line }; }
    });
  } catch (_) {
    return [];
  }
}

module.exports = {
  userDataDir,
  paths,
  ensureDirs,
  readRegistry,
  writeRegistry,
  getPluginState,
  setPluginState,
  removePluginState,
  readGrants,
  writeGrants,
  getGrant,
  setGrant,
  audit,
  readAudit,
  readJson,
  writeJsonAtomic,
  _setRootForTests,
};
