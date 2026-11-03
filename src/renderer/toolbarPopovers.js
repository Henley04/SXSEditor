/**
 * 顶栏的两个弹出层：拍号（4/4）与"更多操作"（⋯）。
 *
 * 定位与开合的通用逻辑在 utils/popoverMenu.js（分片编辑器里的"导出 ▾"
 * 用的是同一套，避免两处各写一份坐标计算）。这里只保留拍号徽标的同步。
 */
import { installPopoverMenus } from '../utils/popoverMenu.js';

/**
 * @returns {() => void} 清理函数（窗口关闭时调用；正常运行期间不需要）
 */
export function installToolbarPopovers() {
  const cleanupMenus = installPopoverMenus([
    [document.getElementById('btn-timesig'), document.getElementById('timesig-popover')],
    [document.getElementById('btn-toolbar-more'), document.getElementById('toolbar-more-panel')],
  ]);

  const cleanups = [];

  // 拍号徽标跟随输入变化。工程载入这类**程序性**赋值不会触发 input 事件，
  // 由 projectManager.syncProjectControls() 直接改 #timesig-display。
  const num = document.getElementById('time-sig-num');
  const den = document.getElementById('time-sig-den');
  const display = document.getElementById('timesig-display');
  const syncTimesig = () => {
    if (!display || !num || !den) return;
    display.textContent = `${num.value || 4}/${den.value || 4}`;
  };
  if (num && den && display) {
    num.addEventListener('input', syncTimesig);
    den.addEventListener('input', syncTimesig);
    cleanups.push(() => num.removeEventListener('input', syncTimesig));
    cleanups.push(() => den.removeEventListener('input', syncTimesig));
    syncTimesig();
  }

  return () => {
    for (const fn of cleanups.splice(0).reverse()) fn();
    cleanupMenus();
  };
}
