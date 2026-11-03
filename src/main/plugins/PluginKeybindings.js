'use strict';
/**
 * 插件快捷键的仲裁（主进程侧，唯一判定点）。
 *
 * 为什么要有仲裁，而且必须在主进程：
 *   · 冲突是**跨插件**的，渲染层只看得到投影、看不到"另一个插件也声明了同一个键"；
 *   · 宿主自己的快捷键有一部分不在 DOM 里（原生菜单的 accelerator），只有主进程
 *     能枚举；渲染层无论怎么扫都扫不全，会漏掉"插件抢了 Cmd+S"这种最严重的情况。
 *
 * 三条规则（对应设计文档 §11 的待确认项）：
 *   1. 插件快捷键**默认不生效**，用户必须在管理器里为这个插件打开开关 ——
 *      安装一个插件就悄悄改变全局按键行为是不可接受的；
 *   2. 与宿主已占用组合冲突 → 永不绑定（不提供"插件优先"），管理器里显示原因；
 *   3. 两个都已启用的插件声明同一组合 → **两边都不绑定**，而不是按 id 或安装顺序
 *      偷偷决定赢家。用户关掉其中一个即可解冲突，界面能讲清"为什么现在不生效"。
 */
const { normalizeChord } = require('../../shared/pluginKeys.js');

/**
 * 与平台无关的保留组合。
 *
 * 这些是 Chromium 的编辑行为（撤销/复制/粘贴/全选）与窗口级手势，不挂在应用菜单上，
 * 所以 `Menu.getApplicationMenu()` 枚举不到 —— 但它们确实"已经被占用了"。
 */
const RESERVED_ALWAYS = Object.freeze([
  'Mod+Z', 'Mod+Y', 'Mod+Shift+Z',
  'Mod+X', 'Mod+C', 'Mod+V', 'Mod+A',
  'Mod+S', 'Mod+Shift+S',
  'Mod+F', 'Mod+P', 'Mod+W', 'Mod+Q',
]);

/** 递归收集原生菜单里的 accelerator（含子菜单）。 */
function collectMenuChords(menu, out = new Set()) {
  if (!menu || !Array.isArray(menu.items)) return out;
  for (const item of menu.items) {
    if (!item) continue;
    if (typeof item.accelerator === 'string') {
      const chord = normalizeChord(item.accelerator);
      if (chord) out.add(chord);
      // Electron 允许 `CmdOrCtrl` 与 `CommandOrControl`，normalizeChord 已收敛为 Mod；
      // 但 mac 上 Mod 实际是 Cmd，这里再补一个等价写法，避免"菜单写 Cmd+S、插件写
      // Mod+S"被判成不冲突。
      if (chord.startsWith('Mod+')) out.add(`Meta+${chord.slice(4)}`);
    }
    if (item.submenu) collectMenuChords(item.submenu, out);
  }
  return out;
}

/**
 * 计算某个插件在某平台上的有效组合。
 * @param {{chord:string, mac:string|null}} binding
 */
function chordForPlatform(binding, platform) {
  if (platform === 'darwin' && binding.mac) return binding.mac;
  return binding.chord;
}

/**
 * @param {object} options
 * @param {import('./PluginRegistry.js').PluginRegistry} options.registry
 * @param {(pluginId:string)=>boolean} options.isEnabled 用户是否为该插件打开了快捷键
 * @param {Set<string>} [options.hostChords] 原生菜单 accelerator
 * @param {string} [options.platform]
 * @returns {{bindings: object[], active: object[], conflicts: object[]}}
 */
function evaluateKeybindings(options) {
  const registry = options.registry;
  const platform = options.platform || process.platform;
  const hostChords = new Set([...RESERVED_ALWAYS, ...(options.hostChords || [])]);
  const isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => false;

  const declared = registry.list('keybinding').map((entry) => {
    const chord = chordForPlatform(entry, platform);
    const enabled = isEnabled(entry.pluginId);
    const blockedByHost = hostChords.has(chord);
    return {
      id: entry.id,
      pluginId: entry.pluginId,
      command: entry.command,
      chord,
      when: entry.when || null,
      enabled: !!enabled,
      status: !enabled ? 'disabled' : (blockedByHost ? 'conflict' : 'candidate'),
      reason: !enabled ? 'disabled' : (blockedByHost ? 'host' : null),
      conflictWith: [],
    };
  });

  // 只在"已启用且未撞宿主"的候选里找插件间冲突；被禁用的条目本来就不生效，
  // 把它们算进冲突会让用户看到一堆与自己无关的红字。
  const byChord = new Map();
  for (const binding of declared) {
    if (binding.status !== 'candidate') continue;
    if (!byChord.has(binding.chord)) byChord.set(binding.chord, []);
    byChord.get(binding.chord).push(binding);
  }
  for (const group of byChord.values()) {
    if (group.length < 2) continue;
    for (const binding of group) {
      binding.status = 'conflict';
      binding.reason = 'plugin';
      binding.conflictWith = group
        .filter((other) => other !== binding)
        .map((other) => other.pluginId);
    }
  }

  const active = declared.filter((b) => b.status === 'candidate');
  const conflicts = declared.filter((b) => b.status === 'conflict');
  return { bindings: declared, active, conflicts };
}

module.exports = {
  RESERVED_ALWAYS,
  collectMenuChords,
  chordForPlatform,
  evaluateKeybindings,
};
