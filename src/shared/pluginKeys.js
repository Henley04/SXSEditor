'use strict';
/**
 * 快捷键字符串的规范化与匹配（主进程 / 渲染进程共用）。
 *
 * 为什么要有单独一层：
 *   · manifest 里允许 `CmdOrCtrl` / `CommandOrControl` / `Cmd` 这些 Electron 写法，
 *     而渲染层的 keydown 只能看到 `event.ctrlKey` / `event.metaKey`，两边必须收敛到
 *     同一个字符串才能比较；
 *   · 冲突仲裁、管理器展示、渲染层匹配如果各写一套，必然出现"管理器说没冲突、
 *     实际按下去却触发了两遍"这类只有手测才发现的问题。
 *
 * 规范形：
 *   修饰键按固定顺序 `Mod`, `Ctrl`, `Alt`, `Shift`, `Meta`，最后是键名，用 `+` 连接。
 *   例：`Mod+Shift+K`、`Ctrl+Alt+Delete`、`F5`。
 *
 * `Mod` 是"平台主修饰键"：macOS 上是 Command，其它平台是 Control。插件写
 * `Mod+S` 就能同时适配两边；需要区分时再写 `Cmd` / `Ctrl`。
 */

/** 允许的修饰键别名 → 规范名。 */
const MODIFIER_ALIASES = Object.freeze({
  mod: 'Mod',
  cmdorctrl: 'Mod',
  commandorcontrol: 'Mod',
  cmdorcontrol: 'Mod',
  commandorctrl: 'Mod',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  super: 'Meta',
  win: 'Meta',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
});

/** 修饰键的固定输出顺序（保证同一组合只有一种字符串写法）。 */
const MODIFIER_ORDER = Object.freeze(['Mod', 'Meta', 'Ctrl', 'Alt', 'Shift']);

/** 允许作为"主键"的名字（不含单字符与 F1–F24）。 */
const NAMED_KEYS = Object.freeze([
  'Space', 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Comma', 'Period', 'Slash', 'Backslash', 'Minus', 'Equal',
  'BracketLeft', 'BracketRight', 'Backquote', 'Semicolon', 'Quote',
]);

/** KeyboardEvent.code → 规范键名。用 code 而不是 key：Shift 会把 'k' 变成 'K'、
 *  把 '/' 变成 '?'，按 key 归一化会在不同布局/修饰组合下漂移。 */
const CODE_TO_KEY = Object.freeze({
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Comma: 'Comma',
  Period: 'Period',
  Slash: 'Slash',
  Backslash: 'Backslash',
  Minus: 'Minus',
  Equal: 'Equal',
  BracketLeft: 'BracketLeft',
  BracketRight: 'BracketRight',
  Backquote: 'Backquote',
  Semicolon: 'Semicolon',
  Quote: 'Quote',
});

function normalizeKeyName(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (text.length === 1) {
    const upper = text.toUpperCase();
    if (/[A-Z0-9]/.test(upper)) return upper;
    // 单字符但非字母数字：交给符号别名表（',' '.' '/' 等）
    const symbol = Object.keys(CODE_TO_KEY).find((name) => CODE_TO_KEY[name] === text);
    if (symbol) return CODE_TO_KEY[symbol];
    return null;
  }
  const lower = text.toLowerCase();
  if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return lower.toUpperCase();
  const named = NAMED_KEYS.find((name) => name.toLowerCase() === lower);
  if (named) return named;
  // 允许直接写 Electron 的符号写法
  const fromCode = CODE_TO_KEY[text];
  if (fromCode) return fromCode;
  return null;
}

/**
 * 规范化一个快捷键字符串；非法返回 null（调用方按"这条不绑定"处理）。
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeChord(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  // Electron 也接受 `CommandOrControl+Shift+S`、`Ctrl+Shift+S`；统一按 '+' 切
  const tokens = text.split('+').map((t) => t.trim()).filter(Boolean);
  if (tokens.length < 1 || tokens.length > 5) return null;

  const modifiers = new Set();
  let key = null;
  for (const token of tokens) {
    const alias = MODIFIER_ALIASES[token.toLowerCase()];
    if (alias) {
      modifiers.add(alias);
      continue;
    }
    if (key !== null) return null; // 出现两个主键
    key = normalizeKeyName(token);
    if (!key) return null;
  }
  if (!key) return null;
  // 只有修饰键的组合不是快捷键
  if (modifiers.size === 0) {
    // 允许 F1–F24 与单键媒体键这类无修饰的组合，但拒绝裸字母/数字：
    // 绑定一个裸 'A' 会让插件抢走所有输入框的按键。
    if (!/^F([1-9]|1\d|2[0-4])$/.test(key)) return null;
  }
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.has(m));
  return [...ordered, key].join('+');
}

/**
 * 从 keydown 事件得到规范 chord。
 * @param {KeyboardEvent} event
 * @param {boolean} isMac 平台主修饰键是 Command
 * @returns {string|null}
 */
function chordFromEvent(event, isMac) {
  if (!event) return null;
  const code = String(event.code || '');
  let key = null;
  let letter = /^Key([A-Z])$/.exec(code);
  if (letter) key = letter[1];
  if (!key) {
    const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
    if (digit) key = digit[1];
  }
  if (!key && /^F([1-9]|1\d|2[0-4])$/.test(code)) key = code;
  if (!key && CODE_TO_KEY[code]) key = CODE_TO_KEY[code];
  if (!key) key = normalizeKeyName(event.key);
  if (!key) return null;

  const modifiers = new Set();
  if (isMac ? event.metaKey : event.ctrlKey) modifiers.add('Mod');
  if (isMac && event.ctrlKey) modifiers.add('Ctrl');
  if (!isMac && event.metaKey) modifiers.add('Meta');
  if (event.altKey) modifiers.add('Alt');
  if (event.shiftKey) modifiers.add('Shift');
  if (modifiers.size === 0 && !/^F([1-9]|1\d|2[0-4])$/.test(key)) return null;
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.has(m));
  return [...ordered, key].join('+');
}

/** 是否含平台主修饰键（用来把"纯单键"排除在全局监听之外）。 */
function hasPrimaryModifier(chord) {
  return /(^|\+)(Mod|Ctrl|Meta|Alt)(\+|$)/.test(String(chord || ''));
}

/**
 * 把规范形转成"用户看得懂的键名"，只用于展示，不参与匹配。
 *
 * 规范形里的 `Mod` 是抽象的"平台主修饰键"，直接印给人看会得到
 * `Mod+Shift+H` 这种谁也不知道该按什么的标签 —— 用户手上只有 Ctrl 或 ⌘。
 *
 * @param {string} chord 规范形，如 `Mod+Shift+H`
 * @param {boolean} isMac
 * @returns {string} `Ctrl+Shift+H` 或 `Cmd+Shift+H`
 */
function formatChordForDisplay(chord, isMac) {
  const parts = String(chord || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  return parts.map((part) => {
    if (part === 'Mod') return isMac ? 'Cmd' : 'Ctrl';
    if (part === 'Meta') return isMac ? 'Cmd' : 'Meta';
    return part;
  }).join('+');
}

module.exports = {
  MODIFIER_ALIASES,
  MODIFIER_ORDER,
  NAMED_KEYS,
  normalizeChord,
  normalizeKeyName,
  chordFromEvent,
  hasPrimaryModifier,
  formatChordForDisplay,
};
