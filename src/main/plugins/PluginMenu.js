'use strict';
/**
 * Plugins 顶级菜单的模板片段。
 *
 * 与 File/Edit 的做法一致：只产出纯数据（template array），由 windowManager 负责
 * `Menu.buildFromTemplate`。这样"插件贡献 → 菜单"是纯函数，重建成本可忽略，
 * 卸载时也不需要做增量 patch —— 整体重建永远不会留下幽灵项。
 */
const { t, getLocale } = require('../locale');

/** 从 { en, 'zh-CN' } 里按当前语言取标题，缺省回退 en。 */
function pickTitle(title, locale) {
  if (!title) return '';
  if (typeof title === 'string') return title;
  return title[locale] || title[locale.split('-')[0]] || title.en || Object.values(title)[0] || '';
}

/**
 * @param {object} options
 * @param {import('./PluginRegistry').PluginRegistry} options.registry
 * @param {(commandId:string)=>void} options.runCommand
 * @param {(pluginId:string, panelId:string)=>void} options.openPanel
 * @param {()=>void} options.openManager
 * @param {()=>void} options.installFromFile
 * @param {()=>void} options.reloadAll
 * @param {()=>void} options.openFolder
 * @param {()=>void} options.openLog
 */
function buildPluginsMenu(options) {
  const {
    registry, runCommand, openPanel, openManager, installFromFile, reloadAll, openFolder, openLog,
  } = options;
  const locale = getLocale();

  const submenu = [
    { label: t('menu.pluginsManage'), click: () => openManager() },
    { label: t('menu.pluginsInstall'), click: () => installFromFile() },
    { label: t('menu.pluginsReload'), click: () => reloadAll() },
  ];

  const plugins = registry ? registry.listPlugins().filter((p) => p.status === 'loaded') : [];
  // 有命令或面板的插件才需要一个子菜单 —— 两者都没有的插件在管理器里可见即可
  const interactive = plugins.filter((p) => (
    p.manifest.contributes.commands.length > 0 || p.manifest.contributes.panels.length > 0
  ));
  if (interactive.length) {
    submenu.push({ type: 'separator' });
    for (const plugin of interactive) {
      const items = plugin.manifest.contributes.commands
        .filter((cmd) => registry.get('command', cmd.id))
        .map((cmd) => ({
          label: pickTitle(cmd.title, locale) || cmd.localId,
          // 命令是否可用由服务层判定（runtime 可能没起来），这里只做派发
          click: () => runCommand(cmd.id),
        }));

      const panels = plugin.manifest.contributes.panels || [];
      if (panels.length) {
        if (items.length) items.push({ type: 'separator' });
        for (const panel of panels) {
          // panel.title 与 cmd.title 同构（{ en, 'zh-CN' } 或 string），
          // 这里必须走 pickTitle —— 直接模板插值会得到 "[object Object]"。
          const panelLabel = pickTitle(panel.title, locale);
          items.push({
            label: `${t('menu.pluginsOpenPanel')}${panelLabel ? ` · ${panelLabel}` : ''}`,
            click: () => openPanel(plugin.id, panel.localId),
          });
        }
      }

      submenu.push({ label: plugin.manifest.name, submenu: items });
    }
  }

  submenu.push({ type: 'separator' });
  submenu.push({ label: t('menu.pluginsOpenFolder'), click: () => openFolder() });
  submenu.push({ label: t('menu.pluginsLog'), click: () => openLog() });

  return { label: t('menu.plugins'), submenu };
}

module.exports = { buildPluginsMenu, pickTitle };
