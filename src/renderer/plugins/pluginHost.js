/**
 * 插件界面贡献点的宿主编排（主窗口）。
 *
 * M2 的七个贡献面里，这个文件负责把"投影 → DOM"接起来：
 *   toolbar / statusBar / contextMenus / timelineOverlays / keybindings
 *   （settings 与 palette 在各自窗口里；菜单在原生 Menu，由主进程重建）
 *
 * 三条原则：
 *   1. **一切以 sync 投影为准**：不在渲染层保留"我注册了什么"，插件被停用/卸载后
 *      下一次投影就什么都不剩，不会出现"界面还在、点一下报 NOT_FOUND"；
 *   2. **没有插件时零开销**：没收到投影就不建 DOM；容器初始 `hidden`；
 *   3. **不判权限**：投影里给什么就渲染什么，权限与冲突仲裁全在主进程。
 */

import { installPluginToolbar } from './contributionToolbar.js';
import { installPluginStatusBar } from './contributionStatus.js';
import { installPluginOverlays } from './contributionOverlay.js';
import { installPluginContextMenus } from './contributionContextMenu.js';
import { installPluginKeybindings } from './contributionKeybindings.js';
import { showPluginToast } from './pluginToast.js';
import { resolvePluginText } from './pluginText.js';
import { registerPluginMessages, unregisterPluginMessages } from '../../i18n/index.js';

/**
 * @param {{getContext?: () => object}} [options]
 * @returns {() => void} dispose
 */
export function installPluginHost(options = {}) {
  const api = window.electronAPI?.pluginHost;
  if (!api || typeof api.onSync !== 'function') {
    console.warn('[plugin-host] 未安装：pluginHost API 不可用');
    return () => {};
  }

  /** @type {{revision:number, plugins:object[]}} */
  let snapshot = { revision: -1, plugins: [] };
  const getContext = typeof options.getContext === 'function' ? options.getContext : () => ({});

  const toolbar = installPluginToolbar({
    slot: document.getElementById('plugin-toolbar-slot'),
    divider: document.getElementById('plugin-toolbar-divider'),
    runCommand: (id) => api.runCommand(id),
    getContext,
  });

  const status = installPluginStatusBar({
    bar: document.getElementById('status-bar'),
    left: document.getElementById('status-bar-left'),
    right: document.getElementById('status-bar-right'),
    runCommand: (id) => api.runCommand(id),
    getContext,
  });

  const overlays = installPluginOverlays({
    layer: document.getElementById('plugin-overlay-layer'),
    getContext,
    resolveUrl: (pluginId, overlayId) => api.overlayUrl(pluginId, overlayId),
  });

  const disposeContextMenus = installPluginContextMenus({
    getPlugins: () => snapshot.plugins,
    getContext,
    runCommand: (id) => api.runCommand(id),
  });

  const disposeKeybindings = installPluginKeybindings({
    getPlugins: () => snapshot.plugins,
    getContext,
    runCommand: (id) => api.runCommand(id),
  });

  // ---------------------------------------------------------------- 渲染
  function applyPluginMessages() {
    for (const plugin of snapshot.plugins || []) {
      if (plugin.status === 'loaded' && plugin.i18n && Object.keys(plugin.i18n).length) {
        registerPluginMessages(plugin.id, plugin.i18n);
      } else {
        unregisterPluginMessages(plugin.id);
      }
    }
  }

  function render() {
    toolbar.update(snapshot.plugins);
    status.update(snapshot.plugins);
    overlays.update(snapshot.plugins);
  }

  function onSync(next) {
    if (!next || !Array.isArray(next.plugins)) return;
    // 丢弃迟到的旧投影：list() 的应答与 sync 推送是两条独立通道，冷启动时
    // "加载完成前的那份空投影"可能后到，一旦渲染就会把已经画好的工具栏清空，
    // 表现为"插件在跑、界面空着"。revision 由 registry 单调递增，只认新不认旧。
    if (Number.isFinite(next.revision) && Number.isFinite(snapshot.revision)
      && next.revision < snapshot.revision) return;
    snapshot = next;
    applyPluginMessages();
    render();
  }

  // ---------------------------------------------------------------- 事件
  // 插件日志与进度：日志留在控制台（管理器有完整审计），通知走界面上的轻量条。
  const offEvent = typeof api.onEvent === 'function'
    ? api.onEvent((data) => {
      if (!data || data.event !== 'notify') return;
      const payload = data.payload || {};
      const raw = String(payload.message || '');
      // 插件可以用 '@key' 引用自己的字典（contributes.i18n），由宿主按当前语言解析。
      // 直接写文本也行 —— 不是所有提示都值得为它维护一份翻译。
      showPluginToast(resolvePluginText(data.pluginId, raw), payload.level);
    })
    : null;

  // 画布尺寸变化 → 浮层重算视口（不重建 iframe）
  let resizeObserver = null;
  const overlayLayer = document.getElementById('plugin-overlay-layer');
  if (overlayLayer && typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => overlays.notifyViewport());
    if (overlayLayer.parentElement) resizeObserver.observe(overlayLayer.parentElement);
  }
  window.addEventListener('resize', overlays.notifyViewport);

  // 宿主状态变化（选择、播放、工程开关）→ 重新求值 when。
  // 由 timelineRenderer.refreshAll() 统一派发，避免每个贡献点自己挂一堆监听。
  window.addEventListener('app:state-changed', render);

  // 语言切换：manifest 里的本地化标题与插件字典都要重新取
  const onLocale = () => { applyPluginMessages(); render(); };
  document.addEventListener('localeChanged', onLocale);

  // 首次拉取：不依赖"主进程一定会在窗口就绪前推一次"，否则冷启动后要等一次
  // 插件状态变化才看得到工具栏。
  const offSync = api.onSync((data) => onSync(data));
  api.list().then((data) => { if (data) onSync(data); }).catch(() => {});

  return () => {
    try { disposeContextMenus(); } catch (_) { /* ignore */ }
    try { disposeKeybindings(); } catch (_) { /* ignore */ }
    try { offSync(); } catch (_) { /* ignore */ }
    try { offEvent && offEvent(); } catch (_) { /* ignore */ }
    window.removeEventListener('resize', overlays.notifyViewport);
    window.removeEventListener('app:state-changed', render);
    document.removeEventListener('localeChanged', onLocale);
    if (resizeObserver) resizeObserver.disconnect();
    overlays.dispose();
    status.dispose();
    toolbar.dispose();
    for (const plugin of snapshot.plugins || []) unregisterPluginMessages(plugin.id);
  };
}
