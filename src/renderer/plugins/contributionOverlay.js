/**
 * 时间轴浮层贡献点。
 *
 * 用途：插件在时间轴上画自己的东西（节拍网格、音高辅助线、对齐标记），而不必把
 * 整个时间轴重画一遍。实现方式是**沙箱 iframe 覆盖在画布上**，与面板同一套隔离：
 * sandbox 只有 allow-scripts、没有 same-origin，读不到宿主 DOM，也没有网络。
 *
 * 两个刻意的限制：
 *   · `pointerEvents` 默认 none —— 浮层盖在画布上，默认必须"透明地让点击穿过去"，
 *     否则用户会发现时间轴突然点不动了，还很难归因到"装了个插件"；
 *   · 不提供 canvas 上下文注入 —— 插件画在自己的文档里，宿主不共享画布坐标系。
 *     需要对齐时用 `when` 与宿主提供的视口信息（welcome 消息里的 viewport）。
 */

import { pickLocalized, evalWhen, currentLocale } from './pluginText.js';
import { hostTheme } from './pluginPanelHost.js';

export function installPluginOverlays(options) {
  const { layer, getContext, resolveUrl } = options;
  /** pluginId:overlayId → { frame, signature, token } */
  const mounted = new Map();
  let disposed = false;

  function remove(entry, key) {
    try { entry.frame.remove(); } catch (_) { /* ignore */ }
    mounted.delete(key);
  }

  function viewportFor() {
    const container = layer && layer.parentElement;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  }

  function postWelcome(frame) {
    try {
      frame.contentWindow.postMessage({
        v: 2,
        kind: 'welcome',
        locale: currentLocale(),
        theme: hostTheme(),
        viewport: viewportFor(),
      }, '*');
    } catch (_) { /* iframe 还没就绪 */ }
  }

  function mount(plugin, item) {
    const key = `${plugin.id}:${item.id}`;
    const frame = document.createElement('iframe');
    frame.className = 'plugin-overlay-frame';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', '');
    frame.title = pickLocalized(item.title, currentLocale()) || `${plugin.name}`;
    frame.dataset.pluginId = plugin.id;
    frame.dataset.pluginItem = item.id;
    if (item.width) {
      frame.style.width = `${item.width}px`;
      frame.style.right = 'auto';
    }
    frame.style.height = `${item.height}px`;
    frame.style.pointerEvents = item.pointerEvents === 'auto' ? 'auto' : 'none';
    frame.addEventListener('load', () => postWelcome(frame));

    const entry = { frame, signature: '', token: 0 };
    mounted.set(key, entry);
    layer.appendChild(frame);

    entry.token += 1;
    const token = entry.token;
    Promise.resolve(resolveUrl(plugin.id, item.localId)).then((result) => {
      // 期间插件被卸载/浮层被撤掉 → 丢弃这次晚到的 URL，不要往已移除的 iframe 里塞
      if (disposed || mounted.get(key) !== entry || entry.token !== token) return;
      if (result && result.ok && result.url) entry.frame.src = result.url;
      else remove(entry, key);
    }).catch(() => remove(entry, key));
    return entry;
  }

  function update(plugins) {
    if (!layer) return;
    const ctx = typeof getContext === 'function' ? getContext() : {};
    const desired = new Map();
    for (const plugin of plugins || []) {
      for (const item of plugin.overlays || []) {
        if (!evalWhen(item.when, ctx)) continue;
        desired.set(`${plugin.id}:${item.id}`, { plugin, item });
      }
    }

    for (const [key, entry] of [...mounted]) {
      if (!desired.has(key)) remove(entry, key);
    }
    for (const [key, { plugin, item }] of desired) {
      const existing = mounted.get(key);
      if (!existing) {
        mount(plugin, item);
        continue;
      }
      const signature = `${item.height}|${item.width || ''}|${item.pointerEvents}`;
      if (existing.signature !== signature) {
        existing.frame.style.height = `${item.height}px`;
        existing.frame.style.width = item.width ? `${item.width}px` : '';
        existing.frame.style.right = item.width ? 'auto' : '0';
        existing.frame.style.pointerEvents = item.pointerEvents === 'auto' ? 'auto' : 'none';
      }
      existing.signature = signature;
    }
    layer.hidden = desired.size === 0;
  }

  /** 视口变化 → 通知已挂载的浮层（只发消息，不重建 iframe，避免闪烁）。 */
  function notifyViewport() {
    const viewport = viewportFor();
    for (const { frame } of mounted.values()) {
      try {
        frame.contentWindow.postMessage({ v: 2, kind: 'evt', event: 'viewport', payload: viewport }, '*');
      } catch (_) { /* ignore */ }
    }
  }

  function dispose() {
    disposed = true;
    for (const [key, entry] of [...mounted]) remove(entry, key);
    if (layer) layer.hidden = true;
  }

  return { update, notifyViewport, dispose };
}
