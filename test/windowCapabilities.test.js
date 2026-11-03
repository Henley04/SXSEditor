/**
 * 窗口标识解析 + preload 高危能力裁剪。
 *
 * 这两个东西曾经同时坏掉且完全没有表现：forge 给每个渲染入口产出的 html
 * 都叫 index.html，而标识取自 html 文件名 → 所有窗口都被认成 `index`
 * （主窗口，权限最宽），裁剪表里 `settings` / `pluginmanager` 永远匹配不上。
 * 于是"最小权限"变成"所有窗口都是主窗口"，只是没人发现。
 *
 * 本用例把三件事绑在一起：
 *   1. 解析结果对 dev / 打包 / 带 hash / 直接开 html 四种路径都稳定；
 *   2. 映射表覆盖 forge.config.js 里每一个入口（入口改名/新增会立刻失败）；
 *   3. 裁剪表里出现的窗口标识都真实存在（防 `pluginmanager` 写成 `plugin_manager`）。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const {
  ENTRY_WINDOW_IDS,
  HTML_STEM_WINDOW_IDS,
  HIGH_RISK_METHOD_WINDOWS,
  windowIdFromPath,
  applyWindowCapabilityRedaction,
} = require(path.join(ROOT, 'src/shared/windowCapabilities.js'));

const forgeConfig = require(path.join(ROOT, 'forge.config.js'));
const entryPoints = (() => {
  const plugin = (forgeConfig.plugins || []).find(
    (p) => p && p.config && p.config.renderer && p.config.renderer.entryPoints,
  );
  return plugin ? plugin.config.renderer.entryPoints : [];
})();

const ALL_WINDOW_IDS = new Set([
  ...Object.values(ENTRY_WINDOW_IDS),
  ...Object.values(HTML_STEM_WINDOW_IDS),
]);

describe('窗口标识解析', () => {
  it('dev server 路径取目录段（不是 index.html 的文件名）', () => {
    assert.strictEqual(windowIdFromPath('/main_window/index.html'), 'index');
    assert.strictEqual(windowIdFromPath('/settings_window/index.html'), 'settings');
    assert.strictEqual(windowIdFromPath('/plugin_manager_window/index.html'), 'pluginmanager');
    assert.strictEqual(windowIdFromPath('/fragment_editor_window/index.html'), 'fragmenteditor');
  });

  it('打包后的 file:// 路径同样可用（看到的是 pathname）', () => {
    const p = '/opt/app/resources/app.asar/.webpack/renderer/settings_window/index.html';
    assert.strictEqual(windowIdFromPath(p), 'settings');
  });

  it('查询串 / hash / 反斜杠 / 目录结尾都能解析', () => {
    assert.strictEqual(windowIdFromPath('/plugin_manager_window/index.html?tab=log'), 'pluginmanager');
    assert.strictEqual(windowIdFromPath('/fragment_editor_window/index.html#fragmentId=abc'), 'fragmenteditor');
    assert.strictEqual(windowIdFromPath('\\main_window\\index.html'), 'index');
    assert.strictEqual(windowIdFromPath('/update_notification_window/'), 'updatenotification');
  });

  it('直接打开单个 html 时按文件名兜底', () => {
    assert.strictEqual(windowIdFromPath('/settings.html'), 'settings');
    assert.strictEqual(windowIdFromPath('/pluginManager.html'), 'pluginmanager');
    assert.strictEqual(windowIdFromPath('/index.html'), 'index');
  });

  it('识别不出就返回 null（调用方据此保持全量，不冒险裁剪）', () => {
    assert.strictEqual(windowIdFromPath(''), null);
    assert.strictEqual(windowIdFromPath('/'), null);
    assert.strictEqual(windowIdFromPath('about:blank'), null);
    assert.strictEqual(windowIdFromPath('/unknown_window/index.html'), null);
  });

  it('forge 每个渲染入口都有对应标识', () => {
    assert.ok(entryPoints.length >= 10, '没读到 forge 的 entryPoints');
    const missing = entryPoints.map((e) => e.name).filter((name) => !ENTRY_WINDOW_IDS[name]);
    assert.deepStrictEqual(missing, [], '入口没有登记窗口标识：' + missing.join(', '));
  });
});

describe('preload 高危能力裁剪', () => {
  function fakeApi() {
    const calls = [];
    const rec = (name) => (...args) => { calls.push([name, ...args]); return { ok: true }; };
    return {
      calls,
      api: {
        saveFile: rec('saveFile'),
        saveSettings: rec('saveSettings'),
        openExternal: rec('openExternal'),
        takePendingOpenFile: rec('takePendingOpenFile'),
        pluginAPI: { synthesize: rec('pluginAPI.synthesize') },
        pluginHost: {
          install: rec('pluginHost.install'),
          setEnabled: rec('pluginHost.setEnabled'),
          settingsSet: rec('pluginHost.settingsSet'),
          setKeybindings: rec('pluginHost.setKeybindings'),
          overlayUrl: rec('pluginHost.overlayUrl'),
          openPanel: rec('pluginHost.openPanel'),
        },
      },
    };
  }

  it('裁剪表里的窗口标识都真实存在（防拼写漂移）', () => {
    const unknown = [];
    for (const entry of HIGH_RISK_METHOD_WINDOWS) {
      for (const id of entry.windows) if (!ALL_WINDOW_IDS.has(id)) unknown.push(`${entry.path.join('.')} → ${id}`);
    }
    assert.deepStrictEqual(unknown, [], '裁剪表引用了不存在的窗口标识：\n  - ' + unknown.join('\n  - '));
  });

  it('管理器窗口：可改快捷键总开关，但不能改插件设置 / 不能取浮层地址', () => {
    const { api } = fakeApi();
    applyWindowCapabilityRedaction(api, 'pluginmanager');
    assert.doesNotThrow(() => api.pluginHost.setKeybindings('p', true));
    assert.throws(() => api.pluginHost.settingsSet('p', {}), /未授权调用 pluginHost\.settingsSet/);
    assert.throws(() => api.pluginHost.overlayUrl('p', 'o'), /未授权调用 pluginHost\.overlayUrl/);
    // 管理器不渲染画布，不该拿到系统投递文件 / 浮层地址
    assert.throws(() => api.takePendingOpenFile(), /未授权调用 takePendingOpenFile/);
  });

  it('设置窗口：可写设置，但不能装插件 / 不能改快捷键总开关', () => {
    const { api } = fakeApi();
    applyWindowCapabilityRedaction(api, 'settings');
    assert.doesNotThrow(() => api.pluginHost.settingsSet('p', { a: 1 }));
    assert.throws(() => api.pluginHost.install('x'), /未授权调用 pluginHost\.install/);
    assert.throws(() => api.pluginHost.setKeybindings('p', true), /未授权调用 pluginHost\.setKeybindings/);
  });

  it('更新通知窗口：只留 openExternal，其余归零', () => {
    const { api } = fakeApi();
    applyWindowCapabilityRedaction(api, 'updatenotification');
    assert.doesNotThrow(() => api.openExternal('https://example.com'));
    assert.throws(() => api.saveFile('/tmp/x', 'y'), /未授权调用 saveFile/);
    assert.throws(() => api.pluginAPI.synthesize('x'), /未授权调用 pluginAPI\.synthesize/);
  });

  it('主窗口：全量能力保留', () => {
    const { api } = fakeApi();
    applyWindowCapabilityRedaction(api, 'index');
    for (const fn of [api.saveFile, api.pluginHost.install, api.pluginHost.setEnabled,
      api.pluginHost.overlayUrl, api.takePendingOpenFile]) {
      assert.doesNotThrow(() => fn('x'));
    }
  });

  it('识别不出窗口时不裁剪（保持全量）', () => {
    const { api } = fakeApi();
    const before = api.pluginHost.settingsSet;
    applyWindowCapabilityRedaction(api, null);
    assert.strictEqual(api.pluginHost.settingsSet, before);
  });

  it('被裁掉的方法不是 undefined，而是抛明确错误', () => {
    const { api } = fakeApi();
    applyWindowCapabilityRedaction(api, 'updatenotification');
    assert.strictEqual(typeof api.saveFile, 'function');
    try {
      api.saveFile('/tmp/x', 'y');
      assert.fail('应当抛错');
    } catch (err) {
      assert.match(err.message, /当前窗口（updatenotification）/);
    }
  });
});
