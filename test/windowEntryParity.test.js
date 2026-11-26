/**
 * 渲染入口一致性守卫。
 *
 * 每个 BrowserWindow 都是一个 webpack 渲染入口（html + js + preload）。这个
 * 仓库历史上踩过两次同一类坑：
 *   · 新窗口忘了把 `themes/themeBootstrap.js` 拷到它的输出目录，打包后
 *     <script src="./themes/themeBootstrap.js"> 404，首屏闪一下白/黑（审查项 U2）；
 *   · 入口只加在 forge.config.js、忘了同步 webpack.renderer.config.js 的
 *     拷贝名单 —— 同样是运行时才暴露，`npm start` 下看不出来。
 *
 * 本用例把两者绑在一起：凡是 html 里引了 themeBootstrap 的窗口，CopyPlugin
 * 必须为它准备一份拷贝；凡是入口声明的 html / js / preload 文件，必须真实存在。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');

const forgeConfig = require(path.join(ROOT, 'forge.config.js'));
const rendererConfig = require(path.join(ROOT, 'webpack.renderer.config.js'));

/** 从 CopyPlugin 实例上读回真实 patterns（不解析源码文本，格式变了也不会误判）。 */
function copyPatterns(config) {
  const out = [];
  for (const plugin of config.plugins || []) {
    const patterns = plugin && plugin.patterns;
    if (Array.isArray(patterns)) out.push(...patterns);
  }
  return out;
}

const entryPoints = (() => {
  const plugin = (forgeConfig.plugins || []).find(
    (p) => p && p.config && p.config.renderer && p.config.renderer.entryPoints,
  );
  assert.ok(plugin, 'forge.config.js 里找不到 webpack 的 renderer.entryPoints');
  return plugin.config.renderer.entryPoints;
})();

describe('渲染入口一致性', () => {
  it('每个入口的 html / js / preload 文件都存在', () => {
    const missing = [];
    for (const ep of entryPoints) {
      const files = [ep.html, ep.js, ep.preload && ep.preload.js].filter(Boolean);
      for (const rel of files) {
        const abs = path.join(ROOT, rel);
        if (!fs.existsSync(abs)) missing.push(`${ep.name}: ${rel}`);
      }
    }
    assert.strictEqual(missing.length, 0, '入口引用了不存在的文件：\n  - ' + missing.join('\n  - '));
  });

  it('引了 themeBootstrap.js 的窗口，CopyPlugin 都准备了拷贝', () => {
    const patterns = copyPatterns(rendererConfig);
    const targets = new Set(
      patterns.map((p) => String(p.to || '').split(path.sep).join('/')),
    );

    const problems = [];
    for (const ep of entryPoints) {
      const html = fs.readFileSync(path.join(ROOT, ep.html), 'utf8');
      if (!html.includes('themes/themeBootstrap.js')) continue;
      const expected = path.join(ROOT, `.webpack/renderer/${ep.name}/themes/themeBootstrap.js`)
        .split(path.sep).join('/');
      if (!targets.has(expected)) {
        problems.push(`${ep.name}（${ep.html}）引了 themeBootstrap.js，但没有对应的 CopyPlugin pattern`);
      }
    }
    assert.strictEqual(problems.length, 0, problems.join('\n'));
  });

  it('插件管理器入口已接线（html + js + preload 三件套）', () => {
    const ep = entryPoints.find((e) => e.name === 'plugin_manager_window');
    assert.ok(ep, 'forge.config.js 缺少 plugin_manager_window 入口');
    assert.strictEqual(ep.html, './src/pluginManager.html');
    assert.strictEqual(ep.js, './src/pluginManager/index.js');
    assert.ok(ep.preload && ep.preload.js, 'plugin_manager_window 缺少 preload');

    // 窗口管理器用 `PLUGIN_MANAGER_WINDOW_WEBPACK_ENTRY` 这个全局加载它；
    // 名字对不上时 webpack 会注入一个 undefined，窗口白屏。
    const wm = fs.readFileSync(path.join(ROOT, 'src/main/windowManager.js'), 'utf8');
    assert.ok(
      wm.includes('PLUGIN_MANAGER_WINDOW_WEBPACK_ENTRY'),
      'windowManager 没有使用 PLUGIN_MANAGER_WINDOW_WEBPACK_ENTRY',
    );
    assert.ok(
      wm.includes('PLUGIN_MANAGER_WINDOW_PRELOAD_WEBPACK_ENTRY'),
      'windowManager 没有使用 PLUGIN_MANAGER_WINDOW_PRELOAD_WEBPACK_ENTRY',
    );
  });
});
