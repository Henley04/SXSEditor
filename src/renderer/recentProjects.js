/**
 * 「最近打开的工程」在渲染层的这一头。
 *
 * 列表的真源是主进程 userData 下的一份配置文件（src/main/recentsStore.js），
 * 这里只负责两件事：
 *   · 谁打开了工程就记一笔（不依赖欢迎页是否存在 —— 欢迎页关掉后历史仍要继续长）；
 *   · 给欢迎页提供读写入口。
 *
 * 为什么靠 document 事件而不是让 projectManager 直接 import 本模块：
 * projectManager 要表达的是"工程换了"这一事实，欢迎页要做的"收起来 + 刷新列表"
 * 是它自己的事；反向依赖会把 projectManager ↔ welcomePage 缠成一个环。本仓库
 * 已有同样的先例（fragmentEditor 的 sxse:fragment-loaded）。
 */
import { PROJECT_APPLIED_EVENT } from './constants.js';

/** 主进程不可用（单测、能力被裁剪）时一律降级成"没有历史"，而不是抛错。 */
function recentsApi() {
  const recents = typeof window !== 'undefined' ? window.electronAPI?.recents : null;
  return recents && typeof recents.list === 'function' ? recents : null;
}

/** 取列表（新→旧）。任何失败都回空数组：欢迎页不该因为读不到历史而开不出来。 */
export async function listRecentProjects() {
  const recents = recentsApi();
  if (!recents) return [];
  try {
    const res = await recents.list();
    return res && Array.isArray(res.items) ? res.items : [];
  } catch (err) {
    console.warn('[recents] Failed to read recent projects:', err && err.message);
    return [];
  }
}

/**
 * 记一笔"这个工程刚被打开"。
 *
 * 不合格的路径（相对路径、空串）由主进程挡；这里连失败都不弹框 —— 历史记录
 * 没写成不影响用户继续工作，弹一个「无法保存最近记录」反而打断。
 */
export async function recordRecentProject(filePath) {
  const recents = recentsApi();
  if (!recents || typeof recents.record !== 'function') return false;
  try {
    const res = await recents.record(filePath);
    return !!res && res.success === true;
  } catch (err) {
    console.warn('[recents] Failed to record recent project:', err && err.message);
    return false;
  }
}

/** 从列表去掉一条（文件已删 / 打不开时给用户的出口）。 */
export async function removeRecentProject(filePath) {
  const recents = recentsApi();
  if (!recents || typeof recents.remove !== 'function') return false;
  try {
    const res = await recents.remove(filePath);
    return !!res && res.success === true;
  } catch (err) {
    console.warn('[recents] Failed to remove recent project:', err && err.message);
    return false;
  }
}

/**
 * 挂上"工程被打开 → 记一笔"的监听。只挂一次（重复安装不会记出重复条目，
 * 但会留下多个无谓的监听器）。
 * @returns {() => void} 卸载函数，交给 state._ipcCleanups 统一回收
 */
let _installed = false;
export function installRecentProjectTracking() {
  if (_installed || typeof document === 'undefined') return () => {};
  _installed = true;
  const onApplied = (event) => {
    const filePath = event && event.detail ? event.detail.filePath : null;
    if (typeof filePath === 'string' && filePath) recordRecentProject(filePath);
  };
  document.addEventListener(PROJECT_APPLIED_EVENT, onApplied);
  return () => {
    _installed = false;
    document.removeEventListener(PROJECT_APPLIED_EVENT, onApplied);
  };
}
