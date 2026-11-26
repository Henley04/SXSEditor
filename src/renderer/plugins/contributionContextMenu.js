/**
 * 右键菜单贡献点。
 *
 * 与工具栏/状态栏不同，右键菜单**没有自己的容器**：它必须挂进宿主已经在显示的
 * 那个菜单里，否则用户在画布上右击会看到两个重叠的菜单。所以这里不做"渲染"，
 * 只提供一个 `appendTo(menuEl, area)`：宿主在自己的菜单建好后调用一次，插件项
 * 就以分隔线 + 普通菜单项的形式接在后面。
 *
 * 没有插件项时**什么都不加**（连分隔线也不加）——空的分隔线会让人以为菜单没加载完。
 */

import { pickLocalized, evalWhen, currentLocale, reportCommandFailure } from './pluginText.js';

let provider = null;

/**
 * @param {object} options
 * @param {() => Array<object>} options.getPlugins 当前投影
 * @param {() => object} options.getContext 宿主状态（用于 when）
 * @param {(commandId:string, args?:object) => Promise<any>} options.runCommand
 */
export function installPluginContextMenus(options) {
  provider = {
    getPlugins: options.getPlugins || (() => []),
    getContext: options.getContext || (() => ({})),
    runCommand: options.runCommand || (async () => ({ ok: false })),
  };
  return () => { provider = null; };
}

/** 当前区域下应当显示的插件项（已过 when 过滤）。 */
export function pluginContextItems(area, extraContext) {
  if (!provider) return [];
  const ctx = { ...(provider.getContext() || {}), ...(extraContext || {}) };
  const out = [];
  for (const plugin of provider.getPlugins() || []) {
    for (const item of plugin.contextMenus || []) {
      if (item.context !== area) continue;
      if (!evalWhen(item.when, ctx)) continue;
      out.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        command: item.command,
        title: pickLocalized(item.title, currentLocale()) || plugin.name,
      });
    }
  }
  return out;
}

/**
 * 把插件项追加到宿主菜单。返回是否有追加（宿主可据此决定要不要显示分隔线）。
 *
 * @param {HTMLElement} menuEl
 * @param {'fragment'|'singer'|'canvas'} area
 * @param {{itemClass?:string, extraContext?:object}} [opts]
 */
export function appendPluginContextItems(menuEl, area, opts = {}) {
  if (!menuEl || !provider) return false;
  const items = pluginContextItems(area, opts.extraContext);
  if (!items.length) return false;

  const divider = document.createElement('div');
  divider.className = 'fragment-ctx-divider';
  menuEl.appendChild(divider);

  const itemClass = opts.itemClass || 'fragment-ctx-item';
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = itemClass;
    button.dataset.pluginId = item.pluginId;
    button.textContent = item.title;
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      try { menuEl.remove(); } catch (_) { /* ignore */ }
      const result = await provider.runCommand(item.command);
      if (result && result.ok === false) reportCommandFailure(result);
    });
    menuEl.appendChild(button);
  }
  return true;
}
