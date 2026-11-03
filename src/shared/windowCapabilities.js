'use strict';

/**
 * 窗口身份与高危能力裁剪（主进程/预加载共享，CJS）。
 *
 * 为什么要有这个文件：preload 被 10 个窗口共用，需要"知道自己在哪个窗口里"
 * 才能做最小权限裁剪。最初的做法是拿 URL 里的 html 文件名当窗口标识，但
 * forge 的 webpack 插件给每个渲染入口生成的产物**一律叫 index.html**：
 *
 *   /main_window/index.html
 *   /settings_window/index.html
 *   /plugin_manager_window/index.html
 *
 * 于是正则 `\/([\w-]+)\.html$` 对所有窗口都返回 `index` —— 裁剪表里的
 * `settings` / `pluginmanager` 永远匹配不上，而 `index`（主窗口）恰好是权限
 * 最宽的那一档，等于**所有窗口都拿到了主窗口的全集**。这比不裁剪更糟：它看起来
 * 有防护，实际一条都没生效。
 *
 * 所以标识改为按**目录段**（即入口名）解析，并且把映射表放在这里，让单测能拿
 * forge.config.js 的 entryPoints 与这张表互相校验，防止入口改名后再次静默失效。
 */

// 渲染入口名 → 稳定的窗口标识。改名时必须同步这里，单测会拦住漏改。
const ENTRY_WINDOW_IDS = Object.freeze({
  main_window: 'index',
  fragment_editor_window: 'fragmenteditor',
  singer_creator_window: 'singercreator',
  singer_market_window: 'singermarket',
  audio_preprocess_window: 'audiopreprocess',
  settings_window: 'settings',
  model_download_window: 'modeldownload',
  resource_manager_window: 'resourcemanager',
  update_notification_window: 'updatenotification',
  plugin_manager_window: 'pluginmanager',
});

// 兜底：直接用 `xxx.html` 打开单个页面的场景（调试/预览服务器），文件名即标识。
const HTML_STEM_WINDOW_IDS = Object.freeze({
  index: 'index',
  fragmenteditor: 'fragmenteditor',
  singercreator: 'singercreator',
  singermarket: 'singermarket',
  audiopreprocess: 'audiopreprocess',
  settings: 'settings',
  modeldownload: 'modeldownload',
  resourcemanager: 'resourcemanager',
  updatenotification: 'updatenotification',
  pluginmanager: 'pluginmanager',
});

/**
 * 从 location.pathname 解析窗口标识。
 * @param {string} pathname 形如 `/settings_window/index.html` 或 `file:///.../renderer/settings_window/index.html` 的 path 部分
 * @returns {string|null} 识别不出时返回 null（调用方按"不裁剪"处理）
 */
function windowIdFromPath(pathname) {
  const clean = String(pathname || '').split(/[?#]/)[0].replace(/\\/g, '/');
  if (!clean) return null;
  const trailingSlash = clean.endsWith('/');
  const segs = clean.split('/').filter(Boolean);
  if (!segs.length) return null;
  const last = segs[segs.length - 1].toLowerCase();

  // 目录结尾（`/settings_window/`）：最后一段就是入口名
  if (trailingSlash) return ENTRY_WINDOW_IDS[last] || null;

  if (segs.length >= 2) {
    const dir = segs[segs.length - 2].toLowerCase();
    if (ENTRY_WINDOW_IDS[dir]) return ENTRY_WINDOW_IDS[dir];
    // 目录不认识 → 是个没登记的入口。forge 给所有入口产出的都是 index.html，
    // 文件名在这里没有信息量，认不出就交回 null（调用方不裁剪，不会误伤）
    return null;
  }

  // 单段：直接打开某个 html（调试 / 预览服务器），文件名即标识
  const m = last.match(/^([a-z0-9_-]+)\.html?$/);
  if (m) return HTML_STEM_WINDOW_IDS[m[1]] || ENTRY_WINDOW_IDS[m[1]] || null;
  return ENTRY_WINDOW_IDS[last] || null;
}

// 能力路径（支持一层嵌套，如 pluginAPI.synthesize）→ 允许使用它的窗口
const HIGH_RISK_METHOD_WINDOWS = Object.freeze([
  { path: ['saveFile'], windows: ['index', 'fragmenteditor', 'singercreator', 'audiopreprocess', 'settings', 'singermarket'] },
  { path: ['saveSettings'], windows: ['index', 'settings'] },
  { path: ['openExternal'], windows: ['index', 'settings', 'updatenotification', 'singermarket'] },
  { path: ['showItemInFolder'], windows: ['index', 'settings', 'singermarket'] },
  // 插件合成：只有主窗口与分片编辑器会真正驱动第三方歌声后端
  { path: ['pluginAPI', 'synthesize'], windows: ['index', 'fragmenteditor'] },
  // 插件系统 v2：跑命令 / 面板 RPC 只允许在会渲染插件 UI 的窗口
  { path: ['pluginHost', 'runCommand'], windows: ['index', 'fragmenteditor', 'pluginmanager'] },
  { path: ['pluginHost', 'panelRpc'], windows: ['index', 'fragmenteditor'] },
  { path: ['pluginHost', 'install'], windows: ['index', 'pluginmanager'] },
  { path: ['pluginHost', 'installFromPath'], windows: ['index', 'pluginmanager'] },
  { path: ['pluginHost', 'uninstall'], windows: ['index', 'pluginmanager'] },
  { path: ['pluginHost', 'setEnabled'], windows: ['index', 'pluginmanager'] },
  // 设置值 / 快捷键开关：只有设置窗口能改设置，只有管理器能改快捷键总开关
  { path: ['pluginHost', 'settingsSet'], windows: ['settings'] },
  { path: ['pluginHost', 'setKeybindings'], windows: ['pluginmanager'] },
  // 取 iframe 地址：浮层只在主窗口；打开面板可由设置页/管理器发起
  { path: ['pluginHost', 'overlayUrl'], windows: ['index'] },
  { path: ['pluginHost', 'openPanel'], windows: ['index', 'settings', 'pluginmanager'] },
  // 工程写入的应答只属于真正持有工程文档的两个窗口
  { path: ['pluginHost', 'sendProjectApplyResult'], windows: ['index', 'fragmenteditor'] },
  // 模型端点/绑定/授权只在设置页改：插件与面板没有理由写这张表
  { path: ['models', 'snapshot'], windows: ['settings'] },
  { path: ['models', 'upsertEndpoint'], windows: ['settings'] },
  { path: ['models', 'removeEndpoint'], windows: ['settings'] },
  { path: ['models', 'bind'], windows: ['settings'] },
  { path: ['models', 'unbind'], windows: ['settings'] },
  { path: ['models', 'setDefault'], windows: ['settings'] },
  { path: ['models', 'grant'], windows: ['settings'] },
  { path: ['models', 'revoke'], windows: ['settings'] },
  { path: ['models', 'setSettings'], windows: ['settings'] },
  { path: ['models', 'audit'], windows: ['settings'] },
  // 确认窗在主窗口：它才是插件调用真正发生的地方
  { path: ['models', 'consentReply'], windows: ['index'] },
  // 系统投递的文件只属于主窗口：它会读盘、还会新建预处理窗口
  { path: ['takePendingOpenFile'], windows: ['index'] },
  { path: ['openSingerFileAt'], windows: ['index'] },
]);

/**
 * 被裁剪的方法替换成"抛明确错误"的函数，而不是 undefined ——
 * 万一白名单漏了，会立刻在控制台看到"哪个窗口缺哪个能力"。
 */
function denyCapability(name, windowId) {
  return function () {
    throw new Error(`[preload] 当前窗口（${windowId || 'unknown'}）未授权调用 ${name}()`);
  };
}

/**
 * 就地裁剪 api 对象。
 * @param {object} api 待裁剪的 API 对象
 * @param {string|null} windowId 窗口标识；null 表示识别不出 → 不裁剪（保守）
 * @returns {object} 同一个 api 引用
 */
function applyWindowCapabilityRedaction(api, windowId) {
  if (!windowId || !api) return api;
  for (const entry of HIGH_RISK_METHOD_WINDOWS) {
    if (entry.windows.includes(windowId)) continue;
    let holder = api;
    for (let i = 0; i < entry.path.length - 1; i++) {
      holder = holder && holder[entry.path[i]];
      if (!holder) break;
    }
    if (!holder) continue;
    const key = entry.path[entry.path.length - 1];
    const name = entry.path.join('.');
    if (typeof holder[key] === 'function') holder[key] = denyCapability(name, windowId);
  }
  return api;
}

module.exports = {
  ENTRY_WINDOW_IDS,
  HTML_STEM_WINDOW_IDS,
  HIGH_RISK_METHOD_WINDOWS,
  windowIdFromPath,
  denyCapability,
  applyWindowCapabilityRedaction,
};
