const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/**
 * 跨插件 service（M5 第 4 段）。
 *
 * 断言集中在"宿主替双方守的那几条线"：
 *   · 名字必须是 `namespace.name`（裸词会被抢注）；
 *   · 没声明 consumes 的调用到不了提供方；
 *   · 提供方不在时消费方拿到的是 SERVICE_GONE，而不是 INTERNAL；
 *   · 同名提供方冲突有**确定性**胜者（与安装顺序无关）；
 *   · 循环调用被深度截断，不会把两个进程一起拖死。
 */

const {
  isServiceId, isVersionRange, resolveService, findCycles, MAX_CALL_DEPTH,
} = require('../src/shared/pluginServices');
const { validateManifest } = require('../src/shared/pluginManifest');

describe('pluginServices — 纯规则', function () {
  it('service id 必须带命名空间', function () {
    expect(isServiceId('demo.codec')).to.equal(true);
    expect(isServiceId('audio.vad.v2')).to.equal(true);
    for (const bad of ['codec', 'demo.', '.codec', 'Demo.Codec', 'a b.c', '']) {
      expect(isServiceId(bad), bad).to.equal(false);
    }
  });

  it('版本范围与 engines.app 用同一套语法', function () {
    // `^1` 也接受：satisfiesVersion 允许省略次版本（`^1` 等价 `^1.0.0`），
    // 两处必须对同一句话给出同一个答案。
    for (const ok of ['*', '^1.0.0', '^1', '~1.2.0', '>=1.0.0 <3.0.0', '1.2.3', '']) {
      expect(isVersionRange(ok), ok).to.equal(true);
    }
    for (const bad of ['latest', '1.2.3.4', '>= ', 'x.y.z', '^1 || ^2']) {
      expect(isVersionRange(bad), bad).to.equal(false);
    }
  });

  it('解析：没有提供方 / 版本不满足 / 命中', function () {
    const providers = [{ id: 'a.b', version: '1.2.0', pluginId: 'p1', methods: ['m'] }];
    expect(resolveService({ providers, id: 'a.b' }).ok).to.equal(true);
    expect(resolveService({ providers, id: 'a.b', range: '^1.0.0' }).ok).to.equal(true);
    expect(resolveService({ providers, id: 'a.b', range: '^2.0.0' }).ok).to.equal(false);
    expect(resolveService({ providers, id: 'a.b', range: '^2.0.0' }).reason).to.equal('SERVICE_VERSION_MISMATCH');
    expect(resolveService({ providers, id: 'x.y' }).reason).to.equal('SERVICE_NOT_FOUND');
  });

  it('服务错误码翻成 MCP 码：端点消失是"前提不成立"，不是 INTERNAL', function () {
    const { mapPluginErrorCode } = require('../src/shared/pluginAutomation');
    expect(mapPluginErrorCode('SERVICE_GONE')).to.equal('PRECONDITION_FAILED');
    expect(mapPluginErrorCode('SERVICE_RECURSION')).to.equal('CONFLICT');
    expect(mapPluginErrorCode('PLUGIN_QUARANTINED')).to.equal('PRECONDITION_FAILED');
    expect(mapPluginErrorCode('PLUGIN_UNLOADED')).to.equal('PRECONDITION_FAILED');
    // 未知码仍然是 INTERNAL —— 不能把"看不懂"伪装成"前提不成立"
    expect(mapPluginErrorCode('WHATEVER')).to.equal('INTERNAL');
  });

  it('环检测：自环、二元环、无环', function () {
    const self = new Map([['a', ['a']]]);
    const cyc = findCycles(self);
    expect(cyc).to.have.length(1);
    expect(cyc[0]).to.deep.equal(['a', 'a']);

    const pair = new Map([['a', ['b']], ['b', ['a']]]);
    const two = findCycles(pair);
    expect(two).to.have.length(1);
    expect(two[0][0]).to.equal('a');

    const dag = new Map([['a', ['b']], ['b', ['c']], ['c', []]]);
    expect(findCycles(dag)).to.deep.equal([]);
  });
});

describe('pluginManifest — contributes.services 校验', function () {
  const base = (services, perms) => ({
    apiVersion: 2,
    id: 'svc-demo',
    name: 'Svc Demo',
    version: '1.0.0',
    main: 'main.js',
    engines: { app: '>=2.0.0' },
    permissions: perms || { services: ['provide', 'consume'] },
    contributes: { services },
  });

  it('接受 provides + consumes 的完整形状', function () {
    const r = validateManifest(base({
      provides: [{ id: 'demo.math', version: '1.0.0', methods: ['add'] }],
      consumes: [{ id: 'other.clock', range: '^1.0.0' }],
    }), { dirName: 'svc-demo', appVersion: '9.9.9' });
    expect(r.ok, r.error).to.equal(true);
    expect(r.value.contributes.services.provides[0]).to.include({ id: 'demo.math', version: '1.0.0' });
    expect(r.value.contributes.services.consumes[0]).to.include({ id: 'other.clock', range: '^1.0.0', optional: false });
    // services 已经不再算"暂不生效的贡献"
    expect(r.value.pendingContributions).to.not.include('services');
  });

  it('provides 没有 methods 被拒（一个什么都不能调的服务是陷阱）', function () {
    const r = validateManifest(base({ provides: [{ id: 'demo.math' }] }), { dirName: 'svc-demo', appVersion: '9.9.9' });
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/methods/);
  });

  it('裸 id 被拒（必须 namespace.name）', function () {
    const r = validateManifest(base({ provides: [{ id: 'math', methods: ['add'] }] }), { dirName: 'svc-demo', appVersion: '9.9.9' });
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/namespace\.name/);
  });

  it('重复 provides / 重复 consumes 被拒', function () {
    const dup = validateManifest(base({
      provides: [{ id: 'a.b', methods: ['x'] }, { id: 'a.b', methods: ['y'] }],
    }), { dirName: 'svc-demo', appVersion: '9.9.9' });
    expect(dup.ok).to.equal(false);

    const dupc = validateManifest(base({
      consumes: [{ id: 'a.b' }, { id: 'a.b' }],
    }), { dirName: 'svc-demo', appVersion: '9.9.9' });
    expect(dupc.ok).to.equal(false);
  });

  it('声明了 provides/consumes 却没有对应权限 → 拒绝装载', function () {
    const noProvide = validateManifest(base({
      provides: [{ id: 'a.b', methods: ['x'] }],
    }, { services: ['consume'] }), { dirName: 'svc-demo', appVersion: '9.9.9' });
    expect(noProvide.ok).to.equal(false);
    expect(noProvide.error).to.match(/provide/);

    const noConsume = validateManifest(base({
      consumes: [{ id: 'a.b' }],
    }, { services: ['provide'] }), { dirName: 'svc-demo', appVersion: '9.9.9' });
    expect(noConsume.ok).to.equal(false);
    expect(noConsume.error).to.match(/consume/);
  });

  it('未知键被拒（拼写错误不能静默）', function () {
    const r = validateManifest(base({ provide: [{ id: 'a.b', methods: ['x'] }] }), { dirName: 'svc-demo', appVersion: '9.9.9' });
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/未知/);
  });
});

// ---------------------------------------------------------------- 宿主侧
describe('PluginService — 服务注册与调用', function () {
  const electronStub = {
    app: { getVersion: () => '9.9.9', getPath: () => os.tmpdir(), isPackaged: false, on: () => {}, removeListener: () => {}, whenReady: () => Promise.resolve() },
    ipcMain: { handle: () => {}, removeHandler: () => {}, on: () => {}, removeListener: () => {} },
    dialog: { showOpenDialog: () => ({ canceled: true, filePaths: [] }), showMessageBox: () => {} },
    shell: { openPath: () => {} },
    Menu: { getApplicationMenu: () => null, buildFromTemplate: () => ({}) },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    utilityProcess: { fork: () => { throw new Error('本用例不应启动插件进程'); } },
    protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
    safeStorage: null,
  };
  const originalLoad = Module._load;
  function installStub() {
    Module._load = function (request) {
      if (request === 'electron') return electronStub;
      return originalLoad.apply(this, arguments);
    };
  }
  function restoreStub() { Module._load = originalLoad; }

  installStub();
  const { PluginService } = require('../src/main/plugins/PluginService');
  const store = require('../src/main/plugins/PluginStateStore');
  restoreStub();

  let root;
  let service;

  function add(id, services, perms) {
    const manifest = validateManifest({
      apiVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      main: 'main.js',
      engines: { app: '>=2.0.0' },
      permissions: perms || { services: ['provide', 'consume'] },
      contributes: {
        commands: [{ id: 'noop', title: 'Noop' }],
        services,
      },
    }, { dirName: id, appVersion: '9.9.9' });
    expect(manifest.ok, manifest.error).to.equal(true);
    service.registry.addPlugin({ id, manifest: manifest.value, dir: root, state: {} });
    return service.registry.getPlugin(id);
  }

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-svc-'));
    store._setRootForTests(root);
    installStub();
    service = new PluginService();
    service.init({ getMainWindow: () => null, locale: 'zh-CN', models: null });
  });

  afterEach(async function () {
    try { await service.disposeAll(); } catch (_) { /* ignore */ }
    restoreStub();
    store._setRootForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('注册后能被消费方解析到，快照里两边都看得见', function () {
    const provider = add('prov', {
      provides: [{ id: 'demo.clock', version: '1.2.0', methods: ['now'] }],
    });
    const consumer = add('cons', {
      consumes: [{ id: 'demo.clock', range: '^1.0.0' }],
    });
    service._registerContributions(provider);
    service._registerContributions(consumer);
    service._resolveServiceDependencies();

    expect(service.resolveService('demo.clock').provider.pluginId).to.equal('prov');
    const view = service.registry.serviceView('cons');
    expect(view.consumes[0].available).to.equal(true);
    expect(view.consumes[0].provider).to.equal('prov');
    // 满足依赖 → 不该被降级
    expect(service.registry.getPlugin('cons').status).to.equal('loaded');
  });

  it('缺必需依赖 → degraded 且写明缺什么；补上后恢复 loaded', function () {
    const consumer = add('cons', { consumes: [{ id: 'demo.clock' }] });
    service._registerContributions(consumer);
    service._resolveServiceDependencies();
    expect(service.registry.getPlugin('cons').status).to.equal('degraded');
    expect(service.registry.getPlugin('cons').error).to.match(/缺少依赖服务/);

    const provider = add('prov', {
      provides: [{ id: 'demo.clock', version: '1.0.0', methods: ['now'] }],
    });
    service._registerContributions(provider);
    service._resolveServiceDependencies();
    expect(service.registry.getPlugin('cons').status).to.equal('loaded');
    expect(service.registry.getPlugin('cons').error).to.equal('');
  });

  it('optional 依赖缺失不算错', function () {
    const consumer = add('cons', { consumes: [{ id: 'demo.clock', optional: true }] });
    service._registerContributions(consumer);
    service._resolveServiceDependencies();
    expect(service.registry.getPlugin('cons').status).to.equal('loaded');
  });

  it('版本不满足 → degraded，原因写进错误', function () {
    const provider = add('prov', { provides: [{ id: 'demo.clock', version: '2.0.0', methods: ['now'] }] });
    const consumer = add('cons', { consumes: [{ id: 'demo.clock', range: '^1.0.0' }] });
    service._registerContributions(provider);
    service._registerContributions(consumer);
    service._resolveServiceDependencies();
    expect(service.registry.getPlugin('cons').status).to.equal('degraded');
    expect(service.registry.getPlugin('cons').error).to.match(/版本不满足/);
  });

  it('同名服务冲突：id 字典序小的赢，与注册顺序无关', function () {
    const a = add('alpha', { provides: [{ id: 'demo.x', version: '1.0.0', methods: ['m'] }] });
    const z = add('zeta', { provides: [{ id: 'demo.x', version: '9.0.0', methods: ['m'] }] });
    // 故意先注册 zeta
    service._registerContributions(z);
    service._registerContributions(a);
    expect(service.registry.get('service', 'demo.x').pluginId).to.equal('alpha');
    expect(service.registry.getPlugin('zeta').status).to.equal('degraded');
    expect(store.readAudit().some((e) => e.event === 'service-conflict')).to.equal(true);
  });

  it('循环依赖被记录，但不阻止加载', function () {
    const a = add('alpha', {
      provides: [{ id: 'alpha.svc', methods: ['m'] }],
      consumes: [{ id: 'beta.svc' }],
    });
    const b = add('beta', {
      provides: [{ id: 'beta.svc', methods: ['m'] }],
      consumes: [{ id: 'alpha.svc' }],
    });
    service._registerContributions(a);
    service._registerContributions(b);
    service._resolveServiceDependencies();
    expect(service._serviceCycles).to.have.length(1);
    expect(service.registry.getPlugin('alpha').status).to.equal('loaded');
    expect(service.registry.getPlugin('beta').status).to.equal('loaded');
  });

  it('未声明 consumes 的调用被拒，并留审计', async function () {
    const consumer = add('cons', { consumes: [] });
    service._registerContributions(consumer);
    let err;
    try {
      await service.callService('cons', { service: 'demo.clock', method: 'now' });
    } catch (e) { err = e; }
    expect(err && err.code).to.equal('PERMISSION_DENIED');
    const denied = store.readAudit().filter((e) => e.event === 'service-denied');
    expect(denied).to.have.length(1);
    expect(denied[0].detail.reason).to.equal('undeclared');
  });

  it('声明了但提供方不存在 → SERVICE_GONE', async function () {
    const consumer = add('cons', { consumes: [{ id: 'demo.clock' }] });
    service._registerContributions(consumer);
    let err;
    try {
      await service.callService('cons', { service: 'demo.clock', method: 'now' });
    } catch (e) { err = e; }
    expect(err && err.code).to.equal('SERVICE_GONE');
    expect(store.readAudit().some((e) => e.event === 'service-gone')).to.equal(true);
  });

  it('方法没在 provides 里声明 → NOT_FOUND，且不会跨进程', async function () {
    const provider = add('prov', { provides: [{ id: 'demo.clock', methods: ['now'] }] });
    const consumer = add('cons', { consumes: [{ id: 'demo.clock' }] });
    service._registerContributions(provider);
    service._registerContributions(consumer);
    service._resolveServiceDependencies();
    service._call = async () => { throw new Error('不该到达提供方进程'); };
    let err;
    try {
      await service.callService('cons', { service: 'demo.clock', method: 'later' });
    } catch (e) { err = e; }
    expect(err && err.code).to.equal('NOT_FOUND');
  });

  it('调用链过深 → SERVICE_RECURSION', async function () {
    const provider = add('prov', { provides: [{ id: 'demo.clock', methods: ['now'] }] });
    const consumer = add('cons', { consumes: [{ id: 'demo.clock' }] });
    service._registerContributions(provider);
    service._registerContributions(consumer);
    service._resolveServiceDependencies();
    let err;
    try {
      await service.callService('cons', { service: 'demo.clock', method: 'now', depth: MAX_CALL_DEPTH });
    } catch (e) { err = e; }
    expect(err && err.code).to.equal('SERVICE_RECURSION');
  });

  it('正常调用转发到提供方进程，并记计数', async function () {
    const provider = add('prov', { provides: [{ id: 'demo.clock', methods: ['now'] }] });
    const consumer = add('cons', { consumes: [{ id: 'demo.clock' }] });
    service._registerContributions(provider);
    service._registerContributions(consumer);
    service._resolveServiceDependencies();

    let seen = null;
    service._call = async (pluginId, method, params) => {
      seen = { pluginId, method, params };
      return { epochMs: 42 };
    };
    const out = await service.callService('cons', { service: 'demo.clock', method: 'now', args: { a: 1 } });
    expect(out).to.deep.equal({ epochMs: 42 });
    expect(seen.pluginId).to.equal('prov');
    expect(seen.method).to.equal('service.call');
    expect(seen.params).to.include({ service: 'demo.clock', method: 'now', depth: 1 });
    expect(seen.params.caller).to.include({ id: 'cons' });

    const stats = service.serviceStats();
    expect(stats).to.have.length(1);
    expect(stats[0]).to.include({ key: 'demo.clock.now', calls: 1, errors: 0 });
  });

  it('提供方进程退出时把 PLUGIN_UNLOADED 翻成 SERVICE_GONE', async function () {
    const provider = add('prov', { provides: [{ id: 'demo.clock', methods: ['now'] }] });
    const consumer = add('cons', { consumes: [{ id: 'demo.clock' }] });
    service._registerContributions(provider);
    service._registerContributions(consumer);
    service._resolveServiceDependencies();
    service._call = async () => {
      throw Object.assign(new Error('插件进程已退出'), { code: 'PLUGIN_UNLOADED' });
    };
    let err;
    try {
      await service.callService('cons', { service: 'demo.clock', method: 'now' });
    } catch (e) { err = e; }
    expect(err && err.code).to.equal('SERVICE_GONE');
    expect(service.serviceStats()[0].errors).to.equal(1);
  });

  it('停用提供方后，服务从注册表消失、消费方变成不可用', async function () {
    const provider = add('prov', { provides: [{ id: 'demo.clock', methods: ['now'] }] });
    const consumer = add('cons', { consumes: [{ id: 'demo.clock' }] });
    service._registerContributions(provider);
    service._registerContributions(consumer);
    service._resolveServiceDependencies();
    expect(service.resolveService('demo.clock').ok).to.equal(true);

    const provided = service._providedServiceIds(provider);
    service.registry.removeContributions('prov');
    service._broadcastServiceGone('prov', provided);
    expect(service.resolveService('demo.clock').ok).to.equal(false);
    expect(service.registry.serviceView('cons').consumes[0].available).to.equal(false);
  });
});
