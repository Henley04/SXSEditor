/**
 * 状态栏贡献点。
 *
 * 状态栏是主窗口最底部的一条细栏（M2 新增）。它只承载"只读状态 + 一个可点的动作"：
 * 插件能在这里显示"索引 3/10"，点了可以打开自己的面板 —— 但**不**承载开关、
 * 输入框这类交互控件，否则底部会变成第二个工具栏，且 24px 高度里放不下可用的表单。
 *
 * 文案有两个来源，优先级明确：
 *   1. 插件运行期通过 `ui.status` 推送的文本（本次运行有效，不落盘）；
 *   2. manifest 里声明的静态文案。
 */

import { pickLocalized, evalWhen, currentLocale, reportCommandFailure, resolvePluginText } from './pluginText.js';

export function installPluginStatusBar(options) {
  const { left, right, bar, runCommand, getContext } = options;
  let signature = '';

  function buildItem(plugin, item, locale) {
    // 静态文案也可能写成 `@key`（同一词条在不同语言下走插件字典），
    // 运行时文案与静态文案都过一遍解析，避免两套规则
    const raw = item.runtimeText || pickLocalized(item.text, locale) || plugin.name;
    const text = resolvePluginText(plugin.id, raw);
    const node = document.createElement(item.command ? 'button' : 'span');
    node.className = 'status-bar-item';
    node.dataset.pluginId = plugin.id;
    node.dataset.pluginItem = item.id;
    if (item.command) {
      node.type = 'button';
      node.addEventListener('click', async () => {
        node.disabled = true;
        try {
          // 状态栏点击失败不值得打断用户：结果交给通知条，按钮恢复可用
          const result = await runCommand(item.command);
          if (result && result.ok === false) reportCommandFailure(result);
        } finally {
          node.disabled = false;
        }
      });
    }
    const tooltip = item.tooltip ? pickLocalized(item.tooltip, locale) : '';
    if (tooltip) {
      node.title = tooltip;
      node.setAttribute('aria-label', tooltip);
    }

    const dot = document.createElement('span');
    dot.className = 'status-bar-dot';
    dot.setAttribute('aria-hidden', 'true');
    node.appendChild(dot);
    const label = document.createElement('span');
    label.className = 'status-bar-text';
    label.textContent = text;
    node.appendChild(label);
    return node;
  }

  function update(plugins) {
    if (!bar || !left || !right) return;
    const locale = currentLocale();
    const ctx = typeof getContext === 'function' ? getContext() : {};

    const items = [];
    for (const plugin of plugins || []) {
      for (const item of plugin.statusBar || []) {
        if (!evalWhen(item.when, ctx)) continue;
        items.push({ plugin, item });
      }
    }

    const nextSignature = `${locale}|${items.map(({ plugin, item }) => `${plugin.id}:${item.id}:${item.runtimeText || ''}`).join(',')}`;
    if (nextSignature === signature) return;
    signature = nextSignature;

    left.textContent = '';
    right.textContent = '';
    for (const { plugin, item } of items) {
      const target = item.alignment === 'left' ? left : right;
      target.appendChild(buildItem(plugin, item, locale));
    }
    // 两侧都空时整条隐藏：没有插件时不该多出一条 24px 的空栏
    bar.hidden = items.length === 0;
  }

  function dispose() {
    if (left) left.textContent = '';
    if (right) right.textContent = '';
    if (bar) bar.hidden = true;
    signature = '';
  }

  return { update, dispose };
}
