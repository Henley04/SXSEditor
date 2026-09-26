/**
 * 应用文档（docs/）的定位与打开。
 *
 * 背景：文档站点（https://henley04.github.io/SXSEditor/）的内容就是仓库里的
 * docs/ 目录。以前帮助菜单里的文档入口一律跳线上，离线时不可用；现在 docs/
 * 随应用一起分发（forge 通过 packagerConfig.extraResource 复制到
 * resources/docs），因此：
 *
 *   - 应用内的文档入口（用户帮助文档 / 开发者文档）优先打开本地副本
 *     （file:// + 系统默认浏览器），离线可用、版本与当前安装包一致；
 *   - 线上版本保留为独立入口（帮助菜单的「在线文档」），用于查看最新版；
 *   - 本地副本缺失（例如 lite 包或目录被删）时自动回退到线上地址。
 */
const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** 线上文档站点根地址（GitHub Pages，由 docs/ 发布而来）。 */
const ONLINE_DOCS_BASE_URL = 'https://henley04.github.io/SXSEditor/';

/** 常用文档入口（相对 docs/ 根目录）。 */
const DOC_ENTRIES = {
  home: 'index.html',
  quickStart: 'user/quick-start.html',
  devBuild: 'dev/build.html',
  appUpdates: 'user/app-updates.html',
  modelUpdates: 'user/model-updates.html',
};

let _docsRoot = undefined;

/**
 * 返回随应用分发的本地文档根目录；不存在时返回 null。
 *
 * 候选位置（按优先级）：
 *   1. <resources>/docs        —— 打包后（extraResource 复制的目标）
 *   2. <app>/docs              —— 开发模式（app.getAppPath() 即项目根目录）
 *   3. <resources>/app.asar 同级 docs —— 未走 extraResource 的历史布局
 */
function getDocsRoot() {
  if (_docsRoot !== undefined) return _docsRoot;
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'docs'));
  }
  try {
    const appPath = app.getAppPath();
    if (appPath) {
      candidates.push(path.join(appPath, 'docs'));
      candidates.push(path.join(path.dirname(appPath), 'docs'));
    }
  } catch (_) { /* app 尚未就绪 */ }

  _docsRoot = null;
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, 'index.html'))) {
        _docsRoot = dir;
        break;
      }
    } catch (_) { /* 忽略不可读路径 */ }
  }
  return _docsRoot;
}

/** 供测试/诊断使用：清掉缓存的文档根目录。 */
function resetDocsRootCache() {
  _docsRoot = undefined;
}

/**
 * 解析本地文档文件绝对路径，文件不存在时返回 null。
 * @param {string} relativePath 相对 docs/ 根目录的路径，例如 'user/faq.html'
 */
function resolveLocalDoc(relativePath) {
  const root = getDocsRoot();
  if (!root) return null;
  const rel = String(relativePath || DOC_ENTRIES.home)
    .replace(/^[\\/]+/, '')
    .replace(/\\/g, '/');
  // 拒绝目录穿越（文档相对路径均来自本模块常量或可信调用方）
  if (rel.split('/').includes('..')) return null;
  const abs = path.join(root, rel);
  try {
    return fs.existsSync(abs) ? abs : null;
  } catch (_) {
    return null;
  }
}

/** 线上文档地址。 */
function onlineDocUrl(relativePath) {
  const rel = String(relativePath || '')
    .replace(/^[\\/]+/, '')
    .replace(/\\/g, '/');
  return ONLINE_DOCS_BASE_URL + rel;
}

/**
 * 打开文档：本地优先，缺失时回退线上。
 *
 * @param {string} relativePath 相对 docs/ 的路径
 * @returns {Promise<{success: boolean, source?: 'local'|'online', target?: string, error?: string}>}
 */
async function openDoc(relativePath) {
  const local = resolveLocalDoc(relativePath);
  if (local) {
    try {
      await shell.openExternal(pathToFileURL(local).href);
      return { success: true, source: 'local', target: local };
    } catch (err) {
      // 本地打开失败（例如没有关联程序）时继续尝试线上版本
      console.warn('[Docs] Open local doc failed, falling back to online:', err.message);
    }
  }
  const url = onlineDocUrl(relativePath);
  try {
    await shell.openExternal(url);
    return { success: true, source: 'online', target: url };
  } catch (err) {
    console.warn('[Docs] Open online doc failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 打开线上文档（不查本地），用于「在线文档」入口。
 * @param {string} [relativePath] 相对 docs/ 的路径，留空打开文档站首页
 */
async function openOnlineDoc(relativePath) {
  const url = onlineDocUrl(relativePath || '');
  try {
    await shell.openExternal(url);
    return { success: true, source: 'online', target: url };
  } catch (err) {
    console.warn('[Docs] Open online doc failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 把线上文档地址转换为本地优先的打开目标（用于渲染进程传来的文档链接）。
 * 命中线上站点前缀时走 openDoc（本地优先），否则按普通外链处理。
 */
async function openDocUrlOrExternal(url) {
  if (typeof url === 'string' && url.startsWith(ONLINE_DOCS_BASE_URL)) {
    return openDoc(url.slice(ONLINE_DOCS_BASE_URL.length));
  }
  try {
    await shell.openExternal(url);
    return { success: true, source: 'online', target: url };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  ONLINE_DOCS_BASE_URL,
  DOC_ENTRIES,
  getDocsRoot,
  resetDocsRootCache,
  resolveLocalDoc,
  onlineDocUrl,
  openDoc,
  openOnlineDoc,
  openDocUrlOrExternal,
};
