/**
 * 插件通知条（主窗口）。
 *
 * 为什么不用系统通知：`ui.notify` 的语义是"插件对当前操作的反馈"（已处理 3/10、
 * 当前 BPM 120），它需要贴着界面出现，而不是跑到系统通知中心。系统级通知留给
 * 真正的后台事件（卸载完成、更新可用），两者混用会让用户分不清"要不要点开看"。
 *
 * 视觉约束：只靠背景、边框与一层很淡的分隔，不加阴影/发光 —— 与工具栏弹出层
 * 保持同一套语言（见 docs 里对 .toolbar-popover 的说明）。
 */

const MAX_VISIBLE = 4;
const LIFETIME_MS = 3600;

let stack = null;

function ensureStack() {
  if (stack && stack.isConnected) return stack;
  stack = document.createElement('div');
  stack.className = 'plugin-toast-stack';
  stack.setAttribute('role', 'status');
  stack.setAttribute('aria-live', 'polite');
  document.body.appendChild(stack);
  return stack;
}

/**
 * @param {string} message
 * @param {'info'|'warn'|'error'} [level]
 */
export function showPluginToast(message, level = 'info') {
  const text = String(message || '').trim();
  if (!text) return;
  const host = ensureStack();

  const node = document.createElement('div');
  node.className = 'plugin-toast';
  if (level === 'warn' || level === 'error') node.classList.add(`is-${level}`);
  node.textContent = text;
  host.appendChild(node);

  // 超过上限时先撤最早的一条：插件短时间内连发通知（循环里逐条 notify）
  // 会把界面铺满，用户既看不清也点不到下面的控件。
  while (host.children.length > MAX_VISIBLE) host.removeChild(host.firstElementChild);

  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 200);
  }, LIFETIME_MS);
}

/** 测试/窗口销毁用：清空并移除容器。 */
export function disposePluginToasts() {
  if (stack) {
    stack.remove();
    stack = null;
  }
}
