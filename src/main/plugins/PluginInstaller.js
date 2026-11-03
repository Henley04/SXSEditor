'use strict';
/**
 * 插件的发现、安装与卸载。
 *
 * 安装 = 解包 → 校验 → 落盘 → 原子替换。任何一步失败都不留下半装状态：
 * 所有写入先落在 `plugins/.staging/<uuid>`，通过校验后才 rename 到最终目录。
 *
 * 安全边界（与 pluginZip 的分工）：
 *   · pluginZip 负责"包内路径是否合法"（绝对路径 / `..` / 符号链接 / 体积）；
 *   · 这里负责"落盘路径是否仍在目标目录内"（resolve 后前缀比较），双保险。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { PACKAGE } = require('../../shared/pluginApi.js');
const { readZip } = require('../../shared/pluginZip.js');
const { validateManifest, isLegacyManifest } = require('../../shared/pluginManifest.js');
const store = require('./PluginStateStore.js');

function safeDirName(name) {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);
}

/** 读取某个目录的 manifest（不校验）。 */
function readManifestFile(dir) {
  const file = path.join(dir, PACKAGE.manifest);
  if (!fs.existsSync(file)) return { ok: false, error: `缺少 ${PACKAGE.manifest}` };
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, error: `${PACKAGE.manifest} 不是合法 JSON：${err.message}` };
  }
}

/**
 * 扫描插件根目录，返回每个子目录的原始 manifest。
 * 跳过 `.` 开头的目录（staging / versions）与符号链接。
 */
function scanPlugins() {
  const { plugins } = store.ensureDirs();
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(plugins, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) continue;
    const dir = path.join(plugins, entry.name);
    let real = dir;
    try {
      real = fs.realpathSync(dir);
      const realRoot = fs.realpathSync(plugins);
      if (!real.startsWith(realRoot + path.sep)) {
        console.warn(`[plugins] 跳过软链或越界目录：${entry.name}`);
        continue;
      }
    } catch (_) {
      continue;
    }
    const manifest = readManifestFile(real);
    out.push({
      dirName: entry.name,
      dir: real,
      manifest: manifest.ok ? manifest.value : null,
      error: manifest.ok ? '' : manifest.error,
    });
  }
  return out;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 校验包内 checksums.json（可选）。缺失即跳过，管理器里标注"未签名/未校验"。 */
function verifyChecksums(entries) {
  const file = entries.find((e) => e.path === PACKAGE.checksums);
  if (!file) return { ok: true, skipped: true };
  let manifest;
  try {
    manifest = JSON.parse(file.data.toString('utf8'));
  } catch (_) {
    return { ok: false, error: `${PACKAGE.checksums} 不是合法 JSON` };
  }
  const files = manifest && manifest.files;
  if (!files || typeof files !== 'object') return { ok: true, skipped: true };
  const byPath = new Map(entries.map((e) => [e.path, e]));
  for (const [p, expected] of Object.entries(files)) {
    const entry = byPath.get(p);
    if (!entry) return { ok: false, error: `校验清单引用了不存在的文件：${p}` };
    const actual = sha256(entry.data);
    if (String(expected).toLowerCase() !== actual) {
      return { ok: false, error: `文件校验失败：${p}` };
    }
  }
  return { ok: true, skipped: false };
}

function writeEntries(targetDir, entries) {
  const root = path.resolve(targetDir);
  for (const entry of entries) {
    const dest = path.resolve(root, entry.path);
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      throw new Error(`拒绝写入目标目录之外：${entry.path}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.data);
  }
}

function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err && (err.code === 'EXDEV' || err.code === 'EPERM')) {
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

/**
 * 从目录安装/覆盖（开发者模式：直接把文件夹丢进 plugins/ 也会走这条校验）。
 */
function installFromDirectory(sourceDir, options = {}) {
  const manifestRes = readManifestFile(sourceDir);
  if (!manifestRes.ok) return { ok: false, error: manifestRes.error };
  const manifest = manifestRes.value;

  if (isLegacyManifest(manifest)) {
    return { ok: false, error: 'apiVersion=1 的插件请直接放进 plugins/ 目录（由 legacy host 管理），不支持通过安装器安装' };
  }

  // dirName 默认取源目录名（开发者直接把文件夹丢进 plugins/ 的场景）。
  // 从 .sxsp 安装时必须显式传入 manifest.id：那时的源目录是 `.staging/<id>-<时间戳>-<随机>`，
  // 拿它当 dirName 会让 validateManifest 报"manifest.id 与目录名不一致"——
  // 而那条校验本来是为了抓"文件夹被改名了"的人为错误，不适用于暂存目录。
  const dirName = options.dirName || path.basename(sourceDir);
  const checked = validateManifest(manifest, { dirName, appVersion: options.appVersion });
  if (!checked.ok) return { ok: false, error: checked.error };

  const target = path.join(store.paths().plugins, checked.value.id);
  if (path.resolve(target) !== path.resolve(sourceDir)) {
    // 覆盖安装：旧目录先挪到 .versions，失败可回滚
    if (fs.existsSync(target)) moveDir(target, path.join(store.paths().versions, checked.value.id, `${Date.now()}`));
    moveDir(sourceDir, target);
  }

  const registry = store.readRegistry();
  store.setPluginState(registry, checked.value.id, {
    enabled: true,
    quarantined: false,
    source: options.source || 'folder',
    installedAt: Date.now(),
    updatedAt: Date.now(),
    permissionsHash: checked.value.permissionsHash,
  });
  store.writeRegistry(registry);
  store.audit('install', checked.value.id, { version: checked.value.version, source: options.source || 'folder' });
  return { ok: true, id: checked.value.id, version: checked.value.version, manifest: checked.value, dir: target };
}

/**
 * 从 `.sxsp` 安装。
 * @param {string} filePath
 * @param {{appVersion?:string}} options
 */
function installFromPackage(filePath, options = {}) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, error: `读取安装包失败：${err.message}` };
  }

  let entries;
  try {
    const zip = readZip(buf, {
      maxEntries: PACKAGE.maxEntries,
      maxTotalBytes: PACKAGE.maxTotalBytes,
      maxSingleFileBytes: PACKAGE.maxSingleFileBytes,
    });
    entries = zip.entries;
  } catch (err) {
    return { ok: false, error: `安装包无效：${err.message}` };
  }

  const manifestEntry = entries.find((e) => e.path === PACKAGE.manifest);
  if (!manifestEntry) return { ok: false, error: `安装包缺少 ${PACKAGE.manifest}` };

  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch (err) {
    return { ok: false, error: `${PACKAGE.manifest} 不是合法 JSON：${err.message}` };
  }
  if (isLegacyManifest(manifest)) {
    return { ok: false, error: '暂不支持安装 apiVersion=1 的插件包' };
  }

  // 目录名由 manifest.id 决定：安装器不能信任包内已有的目录层级
  const checked = validateManifest(manifest, { dirName: manifest.id, appVersion: options.appVersion });
  if (!checked.ok) return { ok: false, error: checked.error };

  const checks = verifyChecksums(entries);
  if (!checks.ok) return { ok: false, error: checks.error };

  const p = store.ensureDirs();
  const staging = path.join(p.staging, `${checked.value.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    writeEntries(staging, entries.filter((e) => e.path !== PACKAGE.checksums && e.path !== PACKAGE.signature));
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: `解包失败：${err.message}` };
  }

  // 解包内容必须真的能被"按目录安装"复用一遍：避免两条路径的校验漂移
  const installed = installFromDirectory(staging, {
    appVersion: options.appVersion,
    source: 'package',
    dirName: checked.value.id,
  });
  if (!installed.ok) {
    fs.rmSync(staging, { recursive: true, force: true });
    return installed;
  }
  // installFromDirectory 已经 rename 走，staging 目录可能已不存在
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  return { ...installed, checksumVerified: !checks.skipped };
}

/**
 * 卸载：删安装目录（可选保留用户数据），清状态与授权。
 * 注意：这里**不负责**运行时拆除（kill 进程、撤 UI、重建菜单）—— 那是 PluginService 的事，
 * 卸载顺序必须是「先拆运行时，再删文件」，否则正在跑的插件会读到半删的目录。
 */
function uninstall(id, options = {}) {
  if (!safeDirName(id)) return { ok: false, error: `插件 id 不合法：${id}` };
  const p = store.paths();
  const dir = path.join(p.plugins, id);
  let removedDir = false;
  let fileError = '';
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removedDir = true;
    } catch (err) {
      // 走到这里说明贡献已撤、运行时已停，只是文件被占用（Windows 上插件
      // 加载过的 .dll/.node 常被映射住）。此时再把异常抛出去，等于让一次
      // "已经卸载成功"的操作报失败，还跳过了后面的泄漏断言。
      // 正确做法是如实报告"目录残留"，下次启动扫描时它会被当成未启用插件。
      fileError = String((err && err.message) || err);
      console.warn(`[plugins] 删除 ${id} 的安装目录失败:`, fileError);
    }
  }

  if (!options.keepData) {
    try {
      fs.rmSync(path.join(p.data, id), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[plugins] 清理 ${id} 的用户数据失败:`, err && err.message);
    }
  }

  const registry = store.readRegistry();
  store.removePluginState(registry, id);
  store.writeRegistry(registry);

  const grants = store.readGrants();
  if (grants.grants && grants.grants[id]) {
    delete grants.grants[id];
    store.writeGrants(grants);
  }

  store.audit('uninstall', id, { removedDir, keepData: !!options.keepData, fileError: fileError || undefined });
  return { ok: true, removedDir, fileError: fileError || undefined };
}

/** 插件自己的可写目录（不存在则创建）。 */
function ensureDataDir(id) {
  const dir = path.join(store.paths().data, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  scanPlugins,
  readManifestFile,
  installFromPackage,
  installFromDirectory,
  uninstall,
  ensureDataDir,
  verifyChecksums,
  _internal: { writeEntries, moveDir, safeDirName },
};
