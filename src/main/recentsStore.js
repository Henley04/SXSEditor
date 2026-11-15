/**
 * recentsStore —— 欢迎页「最近的工程」列表的读写。
 *
 * 为什么放在主进程：列表要跨启动、跨窗口存在，只能落在 userData 下的配置文件里，
 * 而 userData 的读写口径由 ConfigStore 统一（原子写 + 读失败回退默认值）。渲染层
 * 是沙箱化的，也不该由它自己拼路径读文件。
 *
 * 只记"打开过的工程文件"，不记歌手文件 / 伴奏音频：后两者是资源，不是用户下次
 * 想接着做的工作。条目按最近打开时间倒序，最多 MAX_RECENTS 条 —— 欢迎页一屏放得下，
 * 再多的历史对用户没有选择价值，只会把配置文件越写越大。
 */
const path = require('node:path');
const { readJsonConfig, writeJsonConfig } = require('./configStore');

/** 列表上限。超出后最旧的被挤掉。 */
const MAX_RECENTS = 10;

/** 配置文件结构版本：以后换字段时靠它做迁移，而不是猜旧文件长什么样。 */
const RECENTS_FORMAT_VERSION = 1;

const CONFIG_NAME = 'recentProjects';

/**
 * 归一化成去重键。
 *
 * 同一路径写法可以有多种（`C:\a\b.sxsproj` / `c:/a/b.sxsproj` / `./b.sxsproj`），
 * 不归一就会在列表里出现"看起来是两个、其实是同一个"的重复条目。
 * Windows 文件系统大小写不敏感，键也要统一小写；其它平台保持原样，否则会把
 * 真两个文件（`Song.sxsproj` 与 `song.sxsproj`）错当成一个。
 */
function recentKey(filePath) {
  const resolved = path.resolve(String(filePath || '').trim());
  const unified = resolved.replace(/\\/g, '/');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/** 从路径取显示用的文件名（两种分隔符都要认，见 recentKey）。 */
function displayName(filePath) {
  const unified = String(filePath || '').replace(/\\/g, '/');
  return unified.split('/').filter(Boolean).pop() || '';
}

/**
 * 单条记录的结构校验。
 *
 * 配置文件可能被人手改过、被旧版本写过、被同步盘截断过 —— 读的时候一律当"不可信
 * 输入"处理：不合格的丢掉，而不是让欢迎页渲染时抛错。
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const filePath = typeof entry.path === 'string' ? entry.path.trim() : '';
  if (!filePath) return null;
  const openedAt = Number(entry.openedAt);
  return {
    path: filePath,
    // name 用路径现算，不信文件里存的那份：用户重命名后旧名字会一直挂着。
    name: displayName(filePath),
    openedAt: Number.isFinite(openedAt) ? openedAt : 0,
  };
}

/** 读列表（新→旧）。文件不存在 / 损坏时返回空数组。 */
function listRecents() {
  const data = readJsonConfig(CONFIG_NAME, null);
  const items = data && Array.isArray(data.items) ? data.items : [];
  return items
    .map(normalizeEntry)
    .filter(Boolean)
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, MAX_RECENTS);
}

/** 写列表（按时间倒序裁剪到上限）。 */
async function saveRecents(items) {
  return writeJsonConfig(CONFIG_NAME, { version: RECENTS_FORMAT_VERSION, items });
}

/**
 * 记一次"打开过这个工程"。
 *
 * 同一文件重复打开只更新时间并顶到最前，不会堆出 N 条重复。
 * @param {string} filePath
 * @returns {Promise<{ success: boolean, items?: Array, error?: string }>}
 */
async function recordRecent(filePath) {
  const entry = normalizeEntry({ path: filePath, openedAt: Date.now() });
  // normalizeEntry 对"path 不是字符串 / 空白"直接返回 null
  if (!entry) return { success: false, error: 'Invalid project path' };

  const key = recentKey(entry.path);
  const kept = listRecents().filter((it) => recentKey(it.path) !== key);
  const items = [entry, ...kept].slice(0, MAX_RECENTS);
  const ok = await saveRecents(items);
  return ok ? { success: true, items } : { success: false, error: 'Failed to write recents', items };
}

/**
 * 从列表移除一条（打开失败 / 文件已删时的出口）。
 * @param {string} filePath
 */
async function removeRecent(filePath) {
  const key = recentKey(filePath);
  const items = listRecents().filter((it) => recentKey(it.path) !== key);
  const ok = await saveRecents(items);
  return { success: ok, items };
}

/** 清空列表。 */
async function clearRecents() {
  const ok = await saveRecents([]);
  return { success: ok, items: [] };
}

module.exports = {
  MAX_RECENTS,
  RECENTS_FORMAT_VERSION,
  recentKey,
  displayName,
  normalizeEntry,
  listRecents,
  recordRecent,
  removeRecent,
  clearRecents,
};
