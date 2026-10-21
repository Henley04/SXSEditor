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
import { installPluginPlaybackBridge } from './pluginBlockingOverlay.js';

// 首屏关键路径之外的工作（图标水合）延后到空闲帧执行，让主窗口更早呈现。
// 首屏的 i18n 文本替换必须先跑，否则用户会先看到英文再闪成中文。
const deferIdle = (fn) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 300 });
  else setTimeout(fn, 0);
};

// Locale first, then icons. applyLocale must not erase hydrated SVG children.
// i18n 只在这里初始化一次（ipcHandlers.js 不再重复调用）。
initI18n().then(() => {
  applyLocale();
  document.documentElement.lang = getLocale();
  deferIdle(() => hydrateIcons(document));
}).catch((err) => {
  console.error('[Renderer] i18n initialization failed:', err);
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

// 插件播放侧接线：阻滞播放浮层 + progress / diagnostics 输出通道。
// 浮层 DOM 是懒建的（没有插件阻滞事件时零开销），这里只订阅 IPC。
// 句柄交给 state._ipcCleanups：eventHandlers.js 的 beforeunload 已统一回收，
// 播放结束则由 stopPlayback() 调 clearPluginBlockingOverlay() 兜底。
if (state._ipcCleanups) {
  state._ipcCleanups.push(installPluginPlaybackBridge({
    getTimeDisplay: () => dom.timeDisplay,
  }));
}

// Display app version.
// 版本号的唯一真源是 package.json 的 version（由 git tag 经 scripts/check-version.js
// 守卫对齐，打包时再由 scripts/generate-build-info.js 写进 src/build-info.json），
// 主进程 app:getVersion 直接返回 app.getVersion()（即 package.json version）。
// 取不到时不要写死 'v1.0.0' —— 那是第三套来源，真源一变就永久失真；保留 HTML
// 里的 'v-' 占位即可。
(async () => {
  try {
    const version = await window.electronAPI.getAppVersion();
    if (dom.versionDisplay && version) dom.versionDisplay.textContent = `v${version}`;
  } catch (err) {
    console.warn('[Renderer] 读取应用版本失败：', err && err.message ? err.message : err);
  }
})();

console.log('SXSEditor renderer started');
