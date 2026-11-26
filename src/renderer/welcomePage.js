/**
 * 欢迎页 —— 应用不是通过双击工程文件启动时的首屏。
 *
 * 组成（与 src/index.html 里的 #welcome-page 一一对应）：
 *   · 左上：欢迎语；
 *   · 下方（占满剩余高度）：一个"最近的工程"框，框头三栏 —— 左标题、
 *     中「新建工程」（带新建文件图标）、右「打开工程文件」（带文件夹图标）；
 *     框体是横向三列、纵向多行的表：文件名 / 文件路径 / 上一次打开的时间。
 *
 * 显示与收起：
 *   · 由 renderer/index.js 在启动时决定 —— 取到了系统投递的文件就不显示；
 *   · 任何时候有工程被装载（PROJECT_APPLIED_EVENT）就收起，包括原生菜单
 *     Ctrl+O、MCP 自动化这些不经过本页面的入口；
 *   · 右上角 × 只是把浮层关掉，底下那份空白工程仍在，可以直接开始编辑。
 *
 * 安全：路径与文件名一律走 textContent，绝不拼 innerHTML —— 列表内容来自
 * 磁盘上的配置文件，可能被外部改写过。
 */
import { PROJECT_APPLIED_EVENT } from './constants.js';
import { listRecentProjects, removeRecentProject } from './recentProjects.js';
import { loadProject, createNewProjectFile } from './projectManager.js';
import { refreshAll } from './timelineRenderer.js';

const IDS = {
  page: 'welcome-page',
  list: 'welcome-recent-list',
  empty: 'welcome-empty',
  btnNew: 'welcome-btn-new',
  btnOpen: 'welcome-btn-open',
  btnClose: 'welcome-btn-close',
};

let _installed = false;

function el(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

/**
 * 「上一次打开的时间」：本地时区的 `YYYY-MM-DD HH:mm`。
 *
 * 不做"3 天前"这类相对时间：相对时间依赖"现在"，同一份数据在不同时刻截图/
 * 断言结果都不同，而这一列真正要回答的是"我上次是哪天动过这个工程"。
 * 时间戳缺失或非法（配置文件被手改过）时返回占位符，不显示 1970-01-01。
 */
export function formatOpenedAt(openedAt) {
  const ts = Number(openedAt);
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 文件名兜底：主进程已经按路径算过一次，这里只防它给的是空串。 */
function displayNameOf(item) {
  if (item && typeof item.name === 'string' && item.name) return item.name;
  const unified = String((item && item.path) || '').replace(/\\/g, '/');
  return unified.split('/').filter(Boolean).pop() || '';
}

function makeCell(text, modifier, title) {
  const cell = document.createElement('span');
  cell.className = `welcome-col welcome-col--${modifier}`;
  cell.setAttribute('role', 'cell');
  cell.textContent = text;
  // 三列都会截断，完整内容放 title
  if (title) cell.title = title;
  return cell;
}

function makeRow(item) {
  const row = document.createElement('div');
  row.className = 'welcome-row welcome-row--item';
  row.setAttribute('role', 'row');
  row.tabIndex = 0;
  row.dataset.path = item.path;
  row.appendChild(makeCell(displayNameOf(item), 'name', item.path));
  row.appendChild(makeCell(item.path, 'path', item.path));
  row.appendChild(makeCell(formatOpenedAt(item.openedAt), 'time'));
  return row;
}

/** 重新拉一次列表并渲染。失败（主进程不可用）时退化成空列表而不是报错框。 */
export async function refreshWelcomeRecents() {
  const listEl = el(IDS.list);
  if (!listEl) return;
  const items = await listRecentProjects();
  listEl.replaceChildren(...items.filter((it) => it && typeof it.path === 'string').map(makeRow));
  const emptyEl = el(IDS.empty);
  if (emptyEl) emptyEl.hidden = listEl.childElementCount > 0;
}

export function isWelcomeVisible() {
  const page = el(IDS.page);
  return !!page && !page.hidden;
}

export function showWelcome() {
  const page = el(IDS.page);
  if (!page) return;
  page.hidden = false;
  refreshWelcomeRecents();
}

export function hideWelcome() {
  const page = el(IDS.page);
  if (page) page.hidden = true;
}

/** 点某一行打开对应工程。打不开且文件确实不在了，就把这条历史去掉。 */
async function openRecent(item) {
  const res = await loadProject(item.path);
  if (res && res.loaded) {
    refreshAll();
    return;
  }
  if (res && res.canceled) return;
  const exists = await window.electronAPI?.fileExists?.(item.path);
  if (exists === false) {
    await removeRecentProject(item.path);
    await refreshWelcomeRecents();
  }
}

/**
 * 安装欢迎页的交互。只在主窗口调用一次。
 * @returns {() => void} 卸载函数（交给 state._ipcCleanups）
 */
export function installWelcomePage() {
  if (_installed) return () => {};
  _installed = true;

  const page = el(IDS.page);
  if (!page) return () => {};

  const cleanups = [];
  const on = (target, type, handler) => {
    if (!target) return;
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };

  on(el(IDS.btnNew), 'click', async () => {
    const res = await createNewProjectFile();
    if (res && res.created) refreshAll();
  });
  on(el(IDS.btnOpen), 'click', async () => {
    // 不传路径 = 走原生"打开工程文件"对话框
    const res = await loadProject();
    if (res && res.loaded) refreshAll();
  });
  on(el(IDS.btnClose), 'click', () => hideWelcome());

  // 行是 div[role=row]（不是 button）：单元格里有三段文本，塞进 button 会让
  // 读屏把整行念成一个巨型标签。因此点击与键盘都要自己接。
  on(page, 'click', (event) => {
    const row = event.target && event.target.closest ? event.target.closest('.welcome-row--item') : null;
    if (!row || !page.contains(row)) return;
    openRecent({ path: row.dataset.path, name: '', openedAt: 0 });
  });
  on(page, 'keydown', (event) => {
    if (event.key === 'Escape') {
      hideWelcome();
      return;
    }
    if (event.key !== 'Enter') return;
    const row = event.target && event.target.closest ? event.target.closest('.welcome-row--item') : null;
    if (!row || !page.contains(row)) return;
    event.preventDefault();
    openRecent({ path: row.dataset.path, name: '', openedAt: 0 });
  });

  // 工程一旦被装载就收起：Ctrl+O、MCP、系统双击投递都走这里，
  // 不依赖"动作是从欢迎页发起的"。
  const onApplied = () => hideWelcome();
  document.addEventListener(PROJECT_APPLIED_EVENT, onApplied);
  cleanups.push(() => document.removeEventListener(PROJECT_APPLIED_EVENT, onApplied));

  return () => {
    _installed = false;
    cleanups.forEach((off) => off());
  };
}
