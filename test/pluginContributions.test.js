const { expect } = require('chai');

const { normalizeChord, chordFromEvent, hasPrimaryModifier, formatChordForDisplay } = require('../src/shared/pluginKeys');
const { validateManifest } = require('../src/shared/pluginManifest');
const { PluginRegistry } = require('../src/main/plugins/PluginRegistry');
const { evaluateKeybindings, collectMenuChords, RESERVED_ALWAYS } = require('../src/main/plugins/PluginKeybindings');

// ===========================================================================
// 快捷键字符串规范化
// ===========================================================================
describe('pluginKeys', function () {
  it('把各种平台写法收敛到同一规范形', function () {
    expect(normalizeChord('CmdOrCtrl+Shift+K')).to.equal('Mod+Shift+K');
    expect(normalizeChord('CommandOrControl+Shift+K')).to.equal('Mod+Shift+K');
    expect(normalizeChord('cmd+shift+k')).to.equal('Meta+Shift+K');
    expect(normalizeChord('Ctrl+Alt+Delete')).to.equal('Ctrl+Alt+Delete');
    expect(normalizeChord('alt+shift+f5')).to.equal('Alt+Shift+F5');
  });

  it('拒绝裸字母/数字（会把输入框的按键全抢走）', function () {
    expect(normalizeChord('K')).to.equal(null);
    expect(normalizeChord('1')).to.equal(null);
    // F 键允许单独绑定
    expect(normalizeChord('F5')).to.equal('F5');
  });

  it('拒绝无法识别的键名与多主键', function () {
    expect(normalizeChord('Mod+NotAKey')).to.equal(null);
    expect(normalizeChord('Mod+A+B')).to.equal(null);
    expect(normalizeChord('Mod+')).to.equal(null);
    expect(normalizeChord(42)).to.equal(null);
  });

  it('从 keydown 事件提取 chord（按 code 而不是 key）', function () {
    const event = { code: 'KeyK', key: 'K', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true };
    expect(chordFromEvent(event, true)).to.equal('Mod+Shift+K');
    const win = { code: 'KeyK', key: 'k', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true };
    expect(chordFromEvent(win, false)).to.equal('Mod+Shift+K');
    // 无修饰的单键不产生 chord（避免插件拦截普通输入）
    expect(chordFromEvent({ code: 'KeyA', key: 'a' }, false)).to.equal(null);
    expect(chordFromEvent({ code: 'F2', key: 'F2' }, false)).to.equal('F2');
  });

  it('hasPrimaryModifier 能区分裸 F 键与带修饰的组合', function () {
    expect(hasPrimaryModifier('Mod+K')).to.equal(true);
    expect(hasPrimaryModifier('F5')).to.equal(false);
  });

  it('展示形态把抽象的 Mod 换成用户手上有实键', function () {
    // 规范形里的 Mod 直接印出来，用户不知道该按 Ctrl 还是 Cmd
    expect(formatChordForDisplay('Mod+Shift+H', false)).to.equal('Ctrl+Shift+H');
    expect(formatChordForDisplay('Mod+Shift+H', true)).to.equal('Cmd+Shift+H');
    // mac 上显式 Meta 与 Mod 同义，展示也统一成 Cmd
    expect(formatChordForDisplay('Meta+K', true)).to.equal('Cmd+K');
    expect(formatChordForDisplay('Meta+K', false)).to.equal('Meta+K');
    expect(formatChordForDisplay('F5', false)).to.equal('F5');
    expect(formatChordForDisplay('', false)).to.equal('');
  });
});

// ===========================================================================
// manifest v2 的界面贡献点
// ===========================================================================
describe('pluginManifest · M2 贡献点', function () {
  const ctx = { dirName: 'com.example.demo', appVersion: '1.5.0' };

  function manifest(contributes, permissions) {
    return {
      apiVersion: 2,
      id: 'com.example.demo',
      name: 'Demo',
      version: '1.0.0',
      main: 'main.js',
      permissions: permissions || { ui: ['menu', 'panel', 'toolbar', 'statusBar', 'contextMenu', 'overlay', 'settings'] },
      contributes: {
        commands: [
          { id: 'hello', title: 'Hello' },
          { id: 'other', title: 'Other' },
        ],
        ...contributes,
      },
    };
  }

  it('工具栏/状态栏/右键菜单/浮层/快捷键都能被规范化', function () {
    const r = validateManifest(manifest({
      toolbar: [{ id: 'tb', command: 'hello', title: 'Hi', icon: 'music', group: 'demo' }],
      statusBar: [{ id: 'sb', text: 'Ready', command: 'hello', alignment: 'left' }],
      contextMenus: [{ id: 'cm', context: 'fragment', command: 'hello', title: 'Do it' }],
      timelineOverlays: [{ id: 'ov', entry: 'overlay/index.html', height: 9999, pointerEvents: 'auto' }],
      keybindings: [{ command: 'hello', key: 'CmdOrCtrl+Shift+H' }],
    }), ctx);
    expect(r.ok, r.error).to.equal(true);
    const c = r.value.contributes;
    expect(c.toolbar[0].id).to.equal('com.example.demo.tb');
    expect(c.toolbar[0].command).to.equal('com.example.demo.hello');
    expect(c.toolbar[0].group).to.equal('demo');
    expect(c.statusBar[0].alignment).to.equal('left');
    expect(c.contextMenus[0].context).to.equal('fragment');
    // 高度被夹紧到 800，指针事件默认 none（非 auto 一律 none）
    expect(c.timelineOverlays[0].height).to.equal(800);
    expect(c.timelineOverlays[0].pointerEvents).to.equal('auto');
    expect(c.keybindings[0].chord).to.equal('Mod+Shift+H');
    expect(r.value.pendingContributions).to.deep.equal([]);
  });

  it('引用未声明的命令直接拒绝', function () {
    const r = validateManifest(manifest({
      toolbar: [{ id: 'tb', command: 'nope', title: 'Hi' }],
    }), ctx);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/未声明的命令/);
  });

  it('未知的右键区域 / when 条件被拒绝', function () {
    const badArea = validateManifest(manifest({
      contextMenus: [{ id: 'cm', context: 'nowhere', command: 'hello', title: 'x' }],
    }), ctx);
    expect(badArea.ok).to.equal(false);
    expect(badArea.error).to.match(/context 非法/);

    const badWhen = validateManifest(manifest({
      toolbar: [{ id: 'tb', command: 'hello', title: 'x', when: 'projectOpen && whatever' }],
    }), ctx);
    expect(badWhen.ok).to.equal(false);
    expect(badWhen.error).to.match(/未知条件/);
  });

  it('界面贡献必须与 permissions.ui 对得上', function () {
    const r = validateManifest(manifest({
      toolbar: [{ id: 'tb', command: 'hello', title: 'x' }],
    }, { ui: ['menu'] }), ctx);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/permissions\.ui/);
  });

  it('settings 字段被规范化为可渲染的 schema', function () {
    const r = validateManifest(manifest({
      settings: [{
        id: 'general',
        title: 'General',
        fields: [
          { key: 'text', type: 'string', default: 'hi', label: 'Text' },
          { key: 'num', type: 'number', default: 999, min: 0, max: 10, label: 'Num' },
          { key: 'flag', type: 'boolean', default: 1, label: 'Flag' },
          { key: 'mode', type: 'select', default: 'missing', label: 'Mode', options: [
            { value: 'a', label: 'A' }, { value: 'b', label: 'B' },
          ] },
        ],
      }],
    }), ctx);
    expect(r.ok, r.error).to.equal(true);
    const fields = r.value.contributes.settings[0].fields;
    expect(fields[0]).to.include({ key: 'text', type: 'string', default: 'hi' });
    expect(fields[1].default).to.equal(10); // 夹到 max
    expect(fields[2].default).to.equal(false); // 只有 true 才算 true
    expect(fields[3].default).to.equal('a'); // 非法默认值回退到第一项
  });

  it('settings 不接受 entry（设置页不内嵌任意页面）', function () {
    const r = validateManifest(manifest({
      settings: [{ id: 'general', title: 'G', entry: 'settings.html' }],
    }), ctx);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/entry 不受支持/);
  });

  it('settings 指向 panel 时保留全局 id', function () {
    const r = validateManifest(manifest({
      panels: [{ id: 'main', title: 'M', entry: 'p.html', apiScopes: [] }],
      settings: [{ id: 'advanced', title: 'A', panel: 'main' }],
    }), ctx);
    expect(r.ok, r.error).to.equal(true);
    expect(r.value.contributes.settings[0].panelId).to.equal('com.example.demo.main');
  });

  it('i18n 只接受扁平的字符串字典', function () {
    const ok = validateManifest(manifest({
      i18n: { 'zh-CN': { greet: '你好' }, en: { greet: 'Hello' } },
    }), ctx);
    expect(ok.ok, ok.error).to.equal(true);
    expect(ok.value.contributes.i18n.en.greet).to.equal('Hello');

    const bad = validateManifest(manifest({
      i18n: { en: { greet: { nested: 'no' } } },
    }), ctx);
    expect(bad.ok).to.equal(false);
    expect(bad.error).to.match(/必须是字符串/);
  });
});

// ===========================================================================
// 快捷键仲裁
// ===========================================================================
describe('PluginKeybindings', function () {
  function registryWith(entries) {
    const registry = new PluginRegistry();
    for (const entry of entries) {
      registry.addPlugin({
        id: entry.id,
        dir: `/tmp/${entry.id}`,
        state: {},
        manifest: {
          id: entry.id,
          name: entry.id,
          version: '1.0.0',
          description: '',
          author: '',
          homepage: '',
          apiVersion: 2,
          permissions: {},
          permissionsHash: '',
          pendingContributions: [],
          contributes: {
            commands: [], menus: [], panels: [], fileTypes: [], settings: [], toolbar: [],
            statusBar: [], contextMenus: [], timelineOverlays: [], i18n: {},
            pipeline: [], services: [], automation: { methods: [], expose: true },
          },
        },
      });
      for (const binding of entry.bindings || []) {
        registry.register('keybinding', binding.id, { ...binding, pluginId: entry.id });
      }
    }
    return registry;
  }

  it('默认不生效（插件装上不会悄悄改全局按键）', function () {
    const registry = registryWith([{
      id: 'demo',
      bindings: [{ id: 'demo.kb0', command: 'demo.hello', chord: 'Mod+Shift+H', mac: null, when: null }],
    }]);
    const result = evaluateKeybindings({ registry, isEnabled: () => false });
    expect(result.bindings[0].status).to.equal('disabled');
    expect(result.active).to.have.length(0);
  });

  it('与宿主保留组合冲突时永不绑定', function () {
    const registry = registryWith([{
      id: 'demo',
      bindings: [{ id: 'demo.kb0', command: 'demo.hello', chord: 'Mod+S', mac: null, when: null }],
    }]);
    // 即使插件总开关打开，撞上原生菜单的 Cmd+S 也不绑
    const result = evaluateKeybindings({ registry, isEnabled: () => true });
    expect(result.bindings[0].status).to.equal('conflict');
    expect(result.bindings[0].reason).to.equal('host');
  });

  it('两个插件抢同一组合 → 双方都不绑，并报告对方', function () {
    const registry = registryWith([
      { id: 'a', bindings: [{ id: 'a.kb0', command: 'a.x', chord: 'Mod+Alt+P', mac: null, when: null }] },
      { id: 'b', bindings: [{ id: 'b.kb0', command: 'b.x', chord: 'Mod+Alt+P', mac: null, when: null }] },
    ]);
    const result = evaluateKeybindings({ registry, isEnabled: () => true });
    for (const binding of result.bindings) {
      expect(binding.status).to.equal('conflict');
      expect(binding.reason).to.equal('plugin');
    }
    expect(result.active).to.have.length(0);
    expect(result.bindings.find((b) => b.pluginId === 'a').conflictWith).to.deep.equal(['b']);
  });

  it('mac 上优先使用 mac 专用组合', function () {
    const registry = registryWith([{
      id: 'demo',
      bindings: [{ id: 'demo.kb0', command: 'demo.hello', chord: 'Mod+K', mac: 'Meta+Alt+K', when: null }],
    }]);
    const mac = evaluateKeybindings({ registry, isEnabled: () => true, platform: 'darwin' });
    expect(mac.bindings[0].chord).to.equal('Meta+Alt+K');
    const win = evaluateKeybindings({ registry, isEnabled: () => true, platform: 'win32' });
    expect(win.bindings[0].chord).to.equal('Mod+K');
  });

  it('collectMenuChords 递归收集原生 accelerator', function () {
    const menu = {
      items: [
        { accelerator: 'CommandOrControl+S' },
        {
          submenu: {
            items: [{ accelerator: 'CommandOrControl+Shift+S' }],
          },
        },
      ],
    };
    const chords = collectMenuChords(menu);
    expect(chords.has('Mod+S')).to.equal(true);
    expect(chords.has('Mod+Shift+S')).to.equal(true);
    // 渲染层快捷键（撤销/重做）不在菜单里，但必须被视为已占用
    expect(RESERVED_ALWAYS).to.include('Mod+Z');
  });
});

// ===========================================================================
// 投影
// ===========================================================================
describe('PluginRegistry · M2 投影', function () {
  it('把界面贡献投影成渲染层可用的形状', function () {
    const registry = new PluginRegistry();
    registry.addPlugin({
      id: 'demo',
      dir: '/tmp/demo',
      state: {},
      manifest: {
        id: 'demo',
        name: 'Demo',
        version: '1.0.0',
        description: '',
        author: '',
        homepage: '',
        apiVersion: 2,
        permissions: {},
        permissionsHash: '',
        pendingContributions: [],
        contributes: {
          commands: [],
          menus: [],
          panels: [],
          fileTypes: [],
          settings: [{ id: 'demo.g', localId: 'g', title: { en: 'G' }, panelId: null, fields: [] }],
          toolbar: [{ id: 'demo.tb', localId: 'tb', command: 'demo.x', title: { en: 'TB' }, icon: 'music', group: 'demo', when: null }],
          statusBar: [{ id: 'demo.sb', localId: 'sb', command: null, text: { en: 'Ready' }, tooltip: null, alignment: 'right', when: null }],
          contextMenus: [{ id: 'demo.cm', localId: 'cm', context: 'fragment', command: 'demo.x', title: { en: 'Do' }, when: null }],
          timelineOverlays: [{ id: 'demo.ov', localId: 'ov', title: { en: 'OV' }, anchor: 'canvas', height: 96, width: null, pointerEvents: 'none', when: null }],
          keybindings: [{ id: 'demo.kb0', command: 'demo.x', chord: 'Mod+Shift+H', mac: null, when: null }],
          i18n: { en: { ready: 'Ready' } },
          pipeline: [],
          services: [],
          automation: { methods: [], expose: true },
        },
      },
    });
    // 与 PluginService._registerContributions 一致：投影读的是贡献表，不是 manifest
    registry.register('setting', 'demo.g', {
      id: 'demo.g', localId: 'g', title: { en: 'G' }, panelId: null, fields: [], pluginId: 'demo',
    });
    registry.register('toolbar', 'demo.tb', {
      id: 'demo.tb', localId: 'tb', command: 'demo.x', title: { en: 'TB' }, icon: 'music', group: 'demo', when: null, pluginId: 'demo',
    });
    registry.register('statusBar', 'demo.sb', {
      id: 'demo.sb', localId: 'sb', command: null, text: { en: 'Ready' }, tooltip: null, alignment: 'right', when: null, pluginId: 'demo',
    });
    registry.register('contextMenu', 'demo.cm', {
      id: 'demo.cm', localId: 'cm', context: 'fragment', command: 'demo.x', title: { en: 'Do' }, when: null, pluginId: 'demo',
    });
    registry.register('overlay', 'demo.ov', {
      id: 'demo.ov', localId: 'ov', title: { en: 'OV' }, anchor: 'canvas', height: 96, width: null, pointerEvents: 'none', when: null, pluginId: 'demo',
    });
    registry.register('keybinding', 'demo.kb0', {
      id: 'demo.kb0', command: 'demo.x', chord: 'Mod+Shift+H', mac: null, when: null, pluginId: 'demo',
    });

    const snap = registry.snapshot({
      keybindings: new Map([['demo', [{ chord: 'Mod+Shift+H', command: 'demo.x', when: null, status: 'active' }]]]),
      statusText: new Map([['demo.sb', 'Running 3/10']]),
    });
    const plugin = snap.plugins[0];
    expect(plugin.toolbar[0].command).to.equal('demo.x');
    expect(plugin.contextMenus[0].context).to.equal('fragment');
    expect(plugin.overlays[0].height).to.equal(96);
    expect(plugin.statusBar[0].runtimeText).to.equal('Running 3/10');
    expect(plugin.keybindings[0].status).to.equal('active');
    expect(plugin.i18n.en.ready).to.equal('Ready');
    // 停用后投影必须立刻空掉（渲染层据此撤 UI）
    registry.removeContributions('demo');
    const empty = registry.snapshot();
    expect(empty.plugins[0].toolbar).to.deep.equal([]);
    expect(empty.plugins[0].overlays).to.deep.equal([]);
  });
});
