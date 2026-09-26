/**
 * autoRelayout — 统一的"内容区尺寸变化 → 重新布局"监听。
 *
 * 背景（已知问题）：
 *   停靠式（docked）Chrome DevTools 打开/关闭时，BrowserWindow 的 bounds 不变、
 *   `window` 的 resize 事件也不保证触发，只有 WebContents 的宿主视图被缩放。
 *   结果是页面 canvas 仍按旧尺寸绘制，表现为"开发者工具关闭后页面没有自动
 *   刷新，必须手动操作一下才正常"。
 *
 * 本模块用三条互补的触发源解决：
 *   1. ResizeObserver —— 观察实际容器元素，尺寸一变立刻回调（不依赖 window 事件），
 *      天然覆盖停靠 DevTools、面板折叠、栅格拖拽、系统 DPI 变化等。
 *   2. window 'resize' / 'orientationchange' —— 兜底。
 *   3. 主进程推送的 'app:relayout' IPC —— 覆盖连 ResizeObserver 都拿不到尺寸
 *      变化的极端场景（DevTools 关闭后 Chromium 延迟一帧才重排宿主的情形）。
 *
 * 所有触发源都合并到一次 rAF，避免高频重复布局。
 *
 * @module shared/autoRelayout
 */

/**
 * 安装自动重布局监听。
 *
 * @param {Array<Element|null|undefined>} targets 需要观察的容器元素
 * @param {() => void} onRelayout 尺寸变化后执行的回调（通常是 resizeCanvases/refreshAll）
 * @returns {() => void} 卸载函数，移除所有监听
 */
export function installAutoRelayout(targets, onRelayout) {
  if (typeof window === 'undefined' || typeof onRelayout !== 'function') {
    return () => {};
  }

  const elements = (targets || []).filter(Boolean);
  let raf = 0;
  let disposed = false;

  const flush = () => {
    raf = 0;
    if (disposed) return;
    try {
      onRelayout();
    } catch (err) {
      console.warn('[autoRelayout] callback failed:', err && err.message);
    }
  };

  const schedule = () => {
    if (disposed || raf) return;
    raf = requestAnimationFrame(flush);
  };

  // ---- 1. ResizeObserver（主路径） ----
  let observer = null;
  if (typeof ResizeObserver !== 'undefined' && elements.length > 0) {
    observer = new ResizeObserver(() => schedule());
    for (const el of elements) {
      try { observer.observe(el); } catch (_) {}
    }
  }

  // ---- 2. window 级兜底 ----
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  // 停靠 DevTools 关闭后，Chromium 有时直到下一帧才把新尺寸应用到宿主视图，
  // 这里补一次延迟触发确保最终一致。
  const onVisibility = () => { if (!document.hidden) schedule(); };
  document.addEventListener('visibilitychange', onVisibility);

  // ---- 3. 主进程 IPC 推送 ----
  let offIpc = null;
  if (window.electronAPI?.onRelayout) {
    try {
      offIpc = window.electronAPI.onRelayout(() => {
        // DevTools 关闭时尺寸可能在数帧内才稳定，多推两次保证收敛。
        schedule();
        setTimeout(schedule, 60);
        setTimeout(schedule, 200);
      });
    } catch (_) {}
  }

  return () => {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (observer) {
      try { observer.disconnect(); } catch (_) {}
      observer = null;
    }
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    document.removeEventListener('visibilitychange', onVisibility);
    if (typeof offIpc === 'function') {
      try { offIpc(); } catch (_) {}
    }
  };
}

export default installAutoRelayout;
