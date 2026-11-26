/**
 * 工具栏贡献点：把插件的按钮插到顶栏，位置固定在内置"工程"组与右侧低频区之间。
 *
 * 插到最右（version 旁边）会与"歌手市场/更多"抢位置；插到最左又会顶开播放控件。
 * 固定位置换来的是可预期：用户装十个插件，播放/加载/导出的位置都不会动。
 */

import { createIcon } from '../../icons/iconHelper.js';
import { pickLocalized, evalWhen, currentLocale, reportCommandFailure } from './pluginText.js';

const MIN_ITEMS_FOR_GROUP = 1;

export function installPluginToolbar(options) {
  const { slot, divider, runCommand, getContext } = options;
  /** 上一次渲染用的 (插件 id, 条目 id, 语言) 序列，避免状态未变时重建 DOM */
  let signature = '';

  function itemButton(plugin, item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toolbar-plugin-btn';
    button.dataset.pluginId = plugin.id;
    button.dataset.pluginItem = item.id;
    const label = pickLocalized(item.title, currentLocale()) || plugin.name || item.localId;
    button.title = label;
    button.setAttribute('aria-label', label);

    const icon = item.icon ? createIcon(item.icon, { size: 16 }) : null;
    if (icon) button.appendChild(icon);
    const text = document.createElement('span');
    text.className = 'toolbar-plugin-label';
    text.textContent = label;
    button.appendChild(text);

    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await runCommand(item.command);
        if (result && result.ok === false) reportCommandFailure(result);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  /**
   * @param {Array<object>} plugins 投影里的插件列表
   */
  function update(plugins) {
    if (!slot) return;
    const locale = currentLocale();
    const ctx = typeof getContext === 'function' ? getContext() : {};

    const visible = [];
    for (const plugin of plugins || []) {
      for (const item of plugin.toolbar || []) {
        if (!evalWhen(item.when, ctx)) continue;
        visible.push({ plugin, item });
      }
    }

    const nextSignature = `${locale}|${visible.map(({ plugin, item }) => `${plugin.id}:${item.id}`).join(',')}`;
    if (nextSignature === signature) return;
    signature = nextSignature;

    slot.textContent = '';
    // 按 group 排序但保持组内声明顺序：组名只是分隔依据，不是排序键，
    // 否则两个插件会按字母序交错，按钮位置在安装第三个插件时突然全变。
    const groups = new Map();
    for (const entry of visible) {
      const key = entry.item.group || 'plugins';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }

    let index = 0;
    for (const entries of groups.values()) {
      if (index > 0) {
        const sep = document.createElement('div');
        sep.className = 'toolbar-divider toolbar-plugin-divider';
        slot.appendChild(sep);
      }
      for (const { plugin, item } of entries) {
        slot.appendChild(itemButton(plugin, item));
      }
      index++;
    }

    const hasAny = visible.length >= MIN_ITEMS_FOR_GROUP;
    slot.hidden = !hasAny;
    if (divider) divider.hidden = !hasAny;
  }

  function dispose() {
    if (slot) slot.textContent = '';
    if (divider) divider.hidden = true;
    signature = '';
  }

  return { update, dispose };
}
