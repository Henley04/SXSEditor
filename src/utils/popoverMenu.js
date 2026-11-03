/**
 * 工具栏弹出层的通用装配器。
 *
 * 为什么不用原生 <details> / popover API：
 *   - details 展开会把内容放进文档流，撑高 48px 的工具栏；
 *   - popover 属性在 Electron 42（Chromium 130+）可用，但定位依赖浏览器自己的
 *     "最佳位置"算法，锚点贴着窗口顶边时会往右跑，和工具栏的视觉关系不稳定。
 * 这里统一用 position: fixed + 自己算坐标：行为可预测，也不受 #toolbar 的
 * overflow: hidden 裁剪。
 *
 * 视觉约束：面板只靠边框与背景色分层，不加阴影/发光（见各页面 .toolbar-popover）。
 *
 * @param {Array<[HTMLElement|null, HTMLElement|null]>} pairs 触发按钮与面板
 * @returns {() => void} 清理函数
 */
export function installPopoverMenus(pairs) {
  const list = (pairs || []).filter(([trigger, panel]) => trigger && panel);
  if (!list.length) return () => {};

  const cleanups = [];

  const positionPanel = (trigger, panel) => {
    const rect = trigger.getBoundingClientRect();
    const width = panel.offsetWidth || 180;
    // 右边缘不许出窗：菜单靠右时向左收，而不是被裁掉
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(rect.bottom + 6)}px`;
  };

  const close = (trigger, panel) => {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };

  const closeAll = (exceptPanel) => {
    for (const [trigger, panel] of list) {
      if (panel !== exceptPanel) close(trigger, panel);
    }
  };

  for (const [trigger, panel] of list) {
    const onClick = (event) => {
      event.stopPropagation();
      const willOpen = panel.hidden;
      closeAll(panel);
      if (willOpen) {
        panel.hidden = false;
        positionPanel(trigger, panel);
        trigger.setAttribute('aria-expanded', 'true');
      } else {
        close(trigger, panel);
      }
    };
    trigger.addEventListener('click', onClick);
    cleanups.push(() => trigger.removeEventListener('click', onClick));

    // 点面板内部不关：面板里的按钮自己决定要不要关
    const onInside = (event) => event.stopPropagation();
    panel.addEventListener('click', onInside);
    cleanups.push(() => panel.removeEventListener('click', onInside));
  }

  const onDocClick = (event) => {
    if (!event.target.closest || !event.target.closest('.toolbar-popover-anchor')) closeAll(null);
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape') closeAll(null);
  };
  // fixed 定位不会跟着窗口缩放走：宁可关掉，也不要让它飘在错位置
  const onResize = () => closeAll(null);

  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);
  cleanups.push(() => document.removeEventListener('click', onDocClick));
  cleanups.push(() => document.removeEventListener('keydown', onKeydown));
  cleanups.push(() => window.removeEventListener('resize', onResize));

  return () => { for (const fn of cleanups.splice(0).reverse()) fn(); };
}
