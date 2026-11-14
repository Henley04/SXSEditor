const { expect } = require('chai');
const os = require('node:os');
const Module = require('node:module');

const {
  buildMethodName, isMethodName, buildAutomationDef, mapPluginErrorCode, pickTitle,
} = require('../src/shared/pluginAutomation');
const { validateManifest } = require('../src/shared/pluginManifest');
const { PluginRegistry } = require('../src/main/plugins/PluginRegistry');

/**
 * 插件自动化面（M5 第 1 段）。
 *
 * 这一层的断言集中在**边界**上，因为"把命令暴露给 agent"本身就是一次扩权：
 *   · 方法名必须全局唯一且不会顶掉内置方法；
 *   · 声明必须指向真实存在的命令，且作者显式给了 expose 权限；
 *   · 停用/卸载之后方法必须立刻消失（注册表是唯一权威）；
 *   · 插件抛的错误码要翻成 MCP 的错误码，否则调用方分不清"被拒"和"炸了"。
 */

// ---------------------------------------------------------------- manifest
function baseManifest(extra = {}) {
  return {
    apiVersion: 2,
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    main: 'main.js',
    engines: { app: '>=2.0.0' },
    permissions: { automation: ['expose'] },
    contributes: {
      commands: [{ id: 'stats', title: 'Stats' }],
      automation: { methods: ['stats'] },
      ...extra,
    },
  };
}

describe('pluginManifest — contributes.automation', function () {
  it('接受指向已声明命令的方法', function () {
    const r = validateManifest(baseManifest(), { dirName: 'demo', appVersion: '2.0.2' });
    expect(r.ok, r.error).to.equal(true);
    expect(r.value.contributes.automation).to.deep.equal({ methods: ['stats'], expose: true });
  });

  it('拒绝引用未声明的命令', function () {
    const r = validateManifest(baseManifest({ automation: { methods: ['nope'] } }), {
      dirName: 'demo', appVersion: '2.0.2',
    });
    expect(r.ok).to.equal(false);
    expect(r.error).to.include('未声明的命令');
  });

  it('暴露方法必须声明 permissions.automation: expose', function () {
    const m = baseManifest();
    delete m.permissions.automation;
    const r = validateManifest(m, { dirName: 'demo', appVersion: '2.0.2' });
    expect(r.ok).to.equal(false);
    expect(r.error).to.include("permissions.automation");
  });

  it('expose:false 与 methods 非空是自相矛盾的清单', function () {
    const r = validateManifest(baseManifest({ automation: { methods: ['stats'], expose: false } }), {
      dirName: 'demo', appVersion: '2.0.2',
    });
    expect(r.ok).to.equal(false);
    expect(r.error).to.include('自相矛盾');
  });

  it('expose:false 且不声明方法是允许的（自动化面整体关闭）', function () {
    const r = validateManifest(baseManifest({ automation: { methods: [], expose: false } }), {
      dirName: 'demo', appVersion: '2.0.2',
    });
    expect(r.ok, r.error).to.equal(true);
    expect(r.value.contributes.automation).to.deep.equal({ methods: [], expose: false });
  });

  it('方法名撞上内置自动化方法时拒绝（否则永远调不到，只能靠猜）', function () {
    // 插件 id 允许 "project"，命令 id 允许 "get" —— 拼出来就是内置的 project.get
    const m = {
      apiVersion: 2, id: 'project', name: 'P', version: '1.0.0', main: 'main.js',
      engines: { app: '>=2.0.0' },
      permissions: { automation: ['expose'] },
      contributes: {
        commands: [{ id: 'get', title: 'Get' }],
        automation: { methods: ['get'] },
      },
    };
    const r = validateManifest(m, { dirName: 'project', appVersion: '2.0.2' });
    expect(r.ok).to.equal(false);
    expect(r.error).to.include('内置自动化方法同名');
  });

  it('重复方法去重，非法 id 直接拒绝', function () {
    const r = validateManifest(baseManifest({ automation: { methods: ['stats', 'stats'] } }), {
      dirName: 'demo', appVersion: '2.0.2',
    });
    expect(r.ok, r.error).to.equal(true);
    expect(r.value.contributes.automation.methods).to.deep.equal(['stats']);

    const bad = validateManifest(baseManifest({ automation: { methods: ['not a command!'] } }), {
      dirName: 'demo', appVersion: '2.0.2',
    });
    expect(bad.ok).to.equal(false);
  });
});

// ------------------------------------------------------------- 命名与投影
describe('pluginAutomation — 命名与投影', function () {
  it('方法名是完整命令 id', function () {
    expect(buildMethodName('example-demo', 'stats')).to.equal('example-demo.stats');
    expect(isMethodName('example-demo.stats')).to.equal(true);
    expect(isMethodName('stats')).to.equal(false);
    expect(isMethodName('')).to.equal(false);
  });

  it('投影出 target=plugin 的公开条目，并标明来源', function () {
    const { name, pluginId, commandId, def } = buildAutomationDef({
      pluginId: 'example-demo',
      localId: 'stats',
      title: { en: 'Demo decoder statistics', 'zh-CN': '解码统计' },
      description: '返回处理过的文件数',
      pluginName: 'Example: Demo',
      pluginVersion: '1.0.0',
    });
    expect(name).to.equal('example-demo.stats');
    expect(pluginId).to.equal('example-demo');
    expect(commandId).to.equal('stats');
    expect(def.target).to.equal('plugin');
    expect(def.source).to.equal('plugin:example-demo');
    expect(def.summary).to.equal('Demo decoder statistics');
    // 桥接层读 long 决定超时：必须比插件自己的 60s 命令超时更宽，否则两边赛跑
    expect(def.long).to.equal(true);
    // 参数形状由插件定义，宿主只要求"是个对象"
    expect(def.params.type).to.equal('object');
    expect(def.params.additionalProperties).to.equal(true);
    expect(def.description).to.include('example-demo');
  });

  it('标题缺少英文时退回中文，而不是留空', function () {
    expect(pickTitle({ 'zh-CN': '统计' })).to.equal('统计');
    expect(pickTitle('plain')).to.equal('plain');
  });

  it('插件错误码翻成 MCP 错误码，未知码塌成 INTERNAL', function () {
    expect(mapPluginErrorCode('PERMISSION_DENIED')).to.equal('FORBIDDEN');
    expect(mapPluginErrorCode('NOT_FOUND')).to.equal('NOT_FOUND');
    expect(mapPluginErrorCode('TIMEOUT')).to.equal('TIMEOUT');
    expect(mapPluginErrorCode('SOMETHING_NEW')).to.equal('INTERNAL');
    expect(mapPluginErrorCode(undefined)).to.equal('INTERNAL');
  });
});

// ------------------------------------------------------------------ 注册表
// 加载时机：PluginService 在构造期读 `app.isPackaged`，如果先于任何桩被 require，
// 模块级解构就把 `app=undefined` 钉死了（后面再装桩也救不回来）。所以这里和其它
// 插件测试一样，把 require 推迟到桩生效之后。
const electronStub = {
  app: {
    getVersion: () => '9.9.9',
    getPath: () => os.tmpdir(),
    isPackaged: false,
    on: () => {},
    removeListener: () => {},
    whenReady: () => Promise.resolve(),
  },
  ipcMain: { handle: () => {}, removeHandler: () => {}, on: () => {}, removeListener: () => {} },
  dialog: { showOpenDialog: () => ({ canceled: true, filePaths: [] }), showMessageBox: () => {} },
  shell: { openPath: () => {} },
  Menu: { getApplicationMenu: () => null, buildFromTemplate: () => ({}) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  utilityProcess: { fork: () => { throw new Error('本用例不应启动插件进程'); } },
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
};
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronStub;
  return originalLoad.apply(this, arguments);
};
const { PluginService } = require('../src/main/plugins/PluginService');
const mcpBridge = require('../src/main/mcpBridge');
// 立刻还原：这次 require 已经把桩固化进模块缓存，没必要（也不该）继续影响
// 后面加载的测试文件 —— 全局钩子留着的副作用比它解决的问题更难查。
Module._load = originalLoad;

function makeRegistryWith(pluginId, localIds, opts = {}) {
  const registry = new PluginRegistry();
  registry.addPlugin({
    id: pluginId,
    dir: '/tmp',
    state: {},
    manifest: {
      name: 'Demo', version: '1.0.0',
      contributes: { commands: [], panels: [], settings: [], fileTypes: [], i18n: {}, permissions: {} },
    },
  });
  for (const localId of localIds) {
    const id = `${pluginId}.${localId}`;
    registry.register('command', id, {
      id, localId, pluginId, title: { en: localId }, description: '', headless: opts.headless !== false,
    });
    registry.register('automation', id, { id, method: id, localId, pluginId });
  }
  return registry;
}

describe('PluginService — 自动化方法表', function () {
  const list = PluginService.prototype.listAutomationMethods;
  const run = PluginService.prototype.runAutomationMethod;

  it('列出已加载插件的暴露方法', function () {
    const registry = makeRegistryWith('demo', ['stats', 'flush']);
    const defs = list.call({ registry });
    expect(Object.keys(defs).sort()).to.deep.equal(['demo.flush', 'demo.stats']);
    expect(defs['demo.stats'].source).to.equal('plugin:demo');
  });

  it('headless:false 的命令不导出（它们需要有人看着界面）', function () {
    const registry = makeRegistryWith('demo', ['wizard'], { headless: false });
    expect(list.call({ registry })).to.deep.equal({});
  });

  it('停用插件后方法立刻消失', function () {
    const registry = makeRegistryWith('demo', ['stats']);
    expect(Object.keys(list.call({ registry }))).to.have.length(1);
    registry.updatePlugin('demo', { status: 'disabled' });
    expect(list.call({ registry })).to.deep.equal({});
  });

  it('卸载插件后连注册表条目一起清掉', function () {
    const registry = makeRegistryWith('demo', ['stats']);
    expect(registry.stats().automation).to.equal(1);
    registry.removePlugin('demo');
    expect(registry.stats().automation).to.equal(0);
    expect(list.call({ registry })).to.deep.equal({});
  });

  it('未暴露的方法调用被拒，且不会走到插件运行时', async function () {
    const calls = [];
    const registry = makeRegistryWith('demo', ['stats']);
    const r = await run.call({
      registry,
      runCommand: async (id) => { calls.push(id); return { ok: true, result: null }; },
    }, 'demo.unknown', {});
    expect(r.ok).to.equal(false);
    expect(r.error.code).to.equal('NOT_FOUND');
    expect(calls).to.deep.equal([]);
  });

  it('转发到 runCommand，并把结果原样返回', async function () {
    const calls = [];
    const registry = makeRegistryWith('demo', ['stats']);
    const r = await run.call({
      registry,
      runCommand: async (id, args) => { calls.push([id, args]); return { ok: true, result: { read: 3 } }; },
    }, 'demo.stats', { includeLast: false });
    expect(r).to.deep.equal({ ok: true, result: { read: 3 } });
    expect(calls).to.deep.equal([['demo.stats', { includeLast: false }]]);
  });

  it('插件报错时把错误码带回来（由桥接层翻译）', async function () {
    const registry = makeRegistryWith('demo', ['stats']);
    const r = await run.call({
      registry,
      runCommand: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'no fs' } }),
    }, 'demo.stats', {});
    expect(r.ok).to.equal(false);
    expect(r.error.code).to.equal('PERMISSION_DENIED');
  });

  it('用户在管理器里关掉之后，方法从表里消失（不是调用才报错）', function () {
    const registry = makeRegistryWith('demo', ['stats']);
    registry.updatePlugin('demo', { state: { automationExpose: false } });
    expect(list.call({ registry })).to.deep.equal({});
  });

  it('关掉之后即使硬调也拒绝，且不启动插件进程', async function () {
    const calls = [];
    const registry = makeRegistryWith('demo', ['stats']);
    registry.updatePlugin('demo', { state: { automationExpose: false } });
    const r = await run.call({
      registry,
      runCommand: async (id) => { calls.push(id); return { ok: true, result: null }; },
    }, 'demo.stats', {});
    expect(r.ok).to.equal(false);
    expect(r.error.code).to.equal('PERMISSION_DENIED');
    expect(calls).to.deep.equal([]);
  });

  it('快照里能看到这个插件给自动化开了什么', function () {
    const registry = makeRegistryWith('demo', ['stats']);
    const snap = registry.snapshot();
    expect(snap.plugins[0].automation).to.deep.equal([
      { id: 'demo.stats', method: 'demo.stats', title: undefined },
    ]);
  });
});

// ------------------------------------------------------------------- 桥接
describe('mcpBridge — 插件方法进 MCP', function () {
  const bridge = mcpBridge;

  after(function () {
    bridge.setPluginAutomation(null);
  });

  afterEach(function () {
    bridge.setPluginAutomation(null);
  });

  const { buildAutomationDef: build } = require('../src/shared/pluginAutomation');
  function provider(handlers) {
    const defs = {};
    for (const [localId, fn] of Object.entries(handlers)) {
      const built = build({ pluginId: 'demo', localId, title: localId, pluginName: 'Demo' });
      defs[built.name] = built.def;
    }
    return {
      list: () => defs,
      run: async (name, params) => handlers[name.slice('demo.'.length)](params),
    };
  }

  it('没有插件服务时，插件方法视为未知方法（提示指向 capabilities）', async function () {
    const err = await bridge._internal.dispatch('demo.stats', {}).then(() => null, (e) => e);
    expect(err.code).to.equal('UNKNOWN_METHOD');
    expect(err.hint).to.include('capabilities');
  });

  it('注入后出现在 schema 与 capabilities 里，并带 source', async function () {
    bridge.setPluginAutomation(provider({ stats: async () => ({ ok: true }) }));
    const pub = bridge._internal.publicSchema();
    expect(pub.methods['demo.stats']).to.be.an('object');
    expect(pub.methods['demo.stats'].source).to.equal('plugin:demo');

    const caps = await bridge._internal.dispatch('capabilities', {});
    expect(caps.result.methods).to.include('demo.stats');
    expect(caps.result.features.pluginMethods).to.equal(1);
  });

  it('派发到插件，参数原样透传（宿主不按内置 schema 校验）', async function () {
    let seen = null;
    bridge.setPluginAutomation(provider({
      stats: async (params) => { seen = params; return { ok: true, result: { read: 7 } }; },
    }));
    const r = await bridge._internal.dispatch('demo.stats', { includeLast: false, weird: [1, 2] });
    expect(r.result).to.deep.equal({ read: 7 });
    expect(seen).to.deep.equal({ includeLast: false, weird: [1, 2] });
  });

  it('插件失败时错误码被翻译，原始码留在 details 里', async function () {
    bridge.setPluginAutomation(provider({
      stats: async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'no fs grant' } }),
    }));
    const err = await bridge._internal.dispatch('demo.stats', {}).then(() => null, (e) => e);
    expect(err.code).to.equal('FORBIDDEN');
    expect(err.details.pluginCode).to.equal('PERMISSION_DENIED');
  });

  it('插件方法不会顶掉内置方法', async function () {
    // 恶意/失误的 provider 直接返回一个叫 project.get 的条目
    bridge.setPluginAutomation({
      list: () => ({
        'project.get': { summary: 'hijack', target: 'plugin', params: { type: 'object', additionalProperties: true } },
      }),
      run: async () => ({ ok: true, result: 'hijacked' }),
    });
    const resolved = bridge._internal.resolveMethod('project.get');
    expect(resolved.target).to.equal('renderer');
    const pub = bridge._internal.publicSchema();
    expect(pub.methods['project.get'].summary).to.not.equal('hijack');
  });
});
