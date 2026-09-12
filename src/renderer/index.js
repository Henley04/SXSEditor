import '../common.css';
import '../index.css';

// Import state and DOM references (initializes trackManager, history, and DOM elements)
import './state.js';

// Import all modules to register event handlers and IPC handlers
import './eventHandlers.js';
import { _invalidateContainerRect } from './eventHandlers.js';
import './ipcHandlers.js';
import { registerMcpAutomation } from './mcpAutomation.js';
registerMcpAutomation();

// Import and run initialization
import { updateProjectSettings } from './projectManager.js';
import { refreshAll, renderFragmentTimeline } from './timelineRenderer.js';
import { state, dom } from './state.js';
import { installAutoRelayout } from '../shared/autoRelayout.js';
import { initWindowTheme } from '../themes/themeInit.js';
import { hydrateIcons } from '../icons/iconHelper.js';
import { initI18n, applyLocale, getLocale } from '../i18n/index.js';

// 首屏关键路径之外的工作（图标水合）延后到空闲帧执行，让主窗口更早呈现。
// 首屏的 i18n 文本替换必须先跑，否则用户会先看到英文再闪成中文。
const deferIdle = (fn) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 300 });
  else setTimeout(fn, 0);
};

// Locale first, then icons. applyLocale must not erase hydrated SVG children.
initI18n().then(() => {
  applyLocale();
  document.documentElement.lang = getLocale();
  deferIdle(() => hydrateIcons(document));
});

// 任何祖先容器滚动都会让缓存的 getBoundingClientRect 失效（捕获阶段监听，
// 覆盖所有滚动容器）。
window.addEventListener('scroll', _invalidateContainerRect, true);

// 内容区尺寸变化自动重排：覆盖停靠式 DevTools 开关（window 'resize' 不触发）、
// 面板折叠、窗口缩放等场景。此前主窗口完全没有 resize 监听，DevTools 关闭后
// canvas 一直按旧尺寸绘制，必须手动操作触发一次渲染才恢复。
installAutoRelayout(
  [dom.fragmentContainer, dom.singerListEl],
  () => {
    // 布局变了 → 缓存的 getBoundingClientRect 失效，否则 hit-test 用旧坐标，
    // 出现「点击位置与预期不符」。
    _invalidateContainerRect();
    renderFragmentTimeline();
  },
);

// Initialize theme before first render so canvas reads correct tokens
initWindowTheme(state._ipcCleanups).then(() => {
  // Initial DOM-to-state synchronization is not a user edit. Marking dirty
  // here made a pristine new project prompt to save immediately on close.
  updateProjectSettings({ markDirty: false });
  refreshAll();
});

// Display app version
(async () => {
  try {
    const version = await window.electronAPI.getAppVersion();
    if (dom.versionDisplay) dom.versionDisplay.textContent = `v${version}`;
  } catch (_) {
    if (dom.versionDisplay) dom.versionDisplay.textContent = 'v1.0.0';
  }
})();

console.log('SXSEditor renderer started');
