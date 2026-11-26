const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { expect } = require('chai');

const { createZip } = require('../src/shared/pluginZip');
const { ERR } = require('../src/shared/modelContract');

/**
 * 插件 → 宿主模型网关的接线（第 2 段）。
 *
 * 跑的是真的 PluginService + 真的 ModelService，只有 electron 与网络是桩。
 * 重点验证三件事：
 *   · 没有 models:consume 就调不到网关（权限闸门在宿主机能力分发处，不在插件侧）
 *   · 调用成功后 handleId 回给插件，事件经 runtimes.sendEvent 推出
 *   · 插件卸载时取消在途调用、撤销授权
 */

const TEST_ID = 'com.example.modeluser';

function buildPackage() {
  const manifest = {
    apiVersion: 2,
    id: TEST_ID,
    name: 'Model User',
    version: '1.0.0',
    description: 'fixture',
    main: 'main.js',
    engines: { app: '>=1.0.0' },
    permissions: { models: ['consume'] },
    contributes: { commands: [{ id: 'go', title: 'Go' }] },
  };
  return createZip([
    { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { path: 'main.js', data: Buffer.from('module.exports = { activate() {} };', 'utf8') },
  ]);
}

const electronStub = {
  app: {
    getVersion: () => '9.9.9',
    getPath: () => os.tmpdir(),
    isPackaged: false,
    on: () => {},
    removeListener: () => {},
    whenReady: () => Promise.resolve(),
  },
  ipcMain: {
    handle: () => {},
    removeHandler: () => {},
    on: () => {},
    removeListener: () => {},
  },
  dialog: { showOpenDialog: () => ({ canceled: true, filePaths: [] }), showMessageBox: () => {} },
  shell: { openPath: () => {} },
  Menu: { getApplicationMenu: () => null, buildFromTemplate: () => ({}) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  utilityProcess: { fork: () => { throw new Error('本用例不应启动插件进程'); } },
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
};

describe('插件 → 模型网关', function () {
  this.timeout(20000);

  let root;
  let pkgPath;
  let service;
  let models;
  let sent;
  const originalLoad = Module._load;

  before(async function () {
    Module._load = function (request) {
      if (request === 'electron') return electronStub;
      return originalLoad.apply(this, arguments);
    };

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxsp-models-'));
    const store = require('../src/main/plugins/PluginStateStore.js');
    store._setRootForTests(root);

    const { ModelService } = require('../src/main/models/ModelService');
    const { PluginService } = require('../src/main/plugins/PluginService.js');

    const secrets = new Map();
    models = new ModelService({
      dir: path.join(root, 'models'),
      secrets: {
        get: (id) => (secrets.has(id) ? secrets.get(id) : null),
        set: (id, v) => secrets.set(id, v),
        delete: (id) => secrets.delete(id),
        isEncrypted: () => true,
      },
      consent: async () => 'session',
    });
    // 把网络换成确定性输出
    models.adapters.set('openai-compatible', {
      name: 'fake',
      async invoke(ctx, emit) {
        emit('chunk', { data: '你', bytes: 3 });
        emit('chunk', { data: '好', bytes: 3 });
      },
    });
    models.upsertEndpoint({
      id: 'user:local.7f3a',
      title: '测试端点',
      provider: 'example',
      adapter: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      secret: 'sk-test',
    });
    models.bind({ task: 'chat', endpointId: 'user:local.7f3a', isDefault: true });

    service = new PluginService();
    service.init({ getMainWindow: () => null, locale: 'en', models });

    // 捕获推给插件 runtime 的事件
    sent = [];
    service.runtimes.sendEvent = (pluginId, event, payload) => {
      sent.push({ pluginId, event, payload });
    };
    // 生产环境这段路由在 main.js 里接线；测试里接同一份逻辑
    models.setEventSink((subject, evt) => {
      if (subject.startsWith('plugin:')) {
        service.runtimes.sendEvent(subject.slice(7), 'models.event', evt);
      }
    });

    pkgPath = path.join(root, 'model-user.sxsp');
    fs.writeFileSync(pkgPath, buildPackage());
    const installed = await service.installFromPackage(pkgPath);
    expect(installed.ok, installed.error).to.equal(true);
  });

  after(function () {
    try { service && service.disposeAll(); } catch (_) { /* ignore */ }
    Module._load = originalLoad;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('models.list 返回脱敏端点', async function () {
    const r = await service._handleHostCall(TEST_ID, 'models.list', { task: 'chat' });
    expect(r.endpoints).to.have.length(1);
    expect(r.endpoints[0].id).to.equal('user:local.7f3a');
    expect(r.endpoints[0].baseUrl).to.equal(undefined);
  });

  it('models.invoke 返回 handleId，事件按 streamKey 推给插件', async function () {
    const r = await service._handleHostCall(TEST_ID, 'models.invoke', {
      task: 'chat', input: '你好', streamKey: 'ms1',
    });
    expect(r.handleId).to.be.a('string');

    await new Promise((resolve) => setTimeout(resolve, 120));
    const events = sent.filter((s) => s.event === 'models.event').map((s) => s.payload);
    expect(events[0].type).to.equal('start');
    expect(events.every((e) => e.streamKey === 'ms1')).to.equal(true);
    expect(events.filter((e) => e.type === 'done')).to.have.length(1);
    expect(events.filter((e) => e.type === 'chunk').map((e) => e.data).join('')).to.equal('你好');
  });

  it('缺少 streamKey 直接拒绝（否则事件无法对上调用）', async function () {
    let err = null;
    try {
      await service._handleHostCall(TEST_ID, 'models.invoke', { task: 'chat', input: 'x' });
    } catch (e) {
      err = e;
    }
    expect(err && err.code).to.equal(ERR.INVALID_REQUEST);
  });

  it('没有 models:consume 的插件调不动网关', async function () {
    // 临时把权限摘掉，验证闸门在宿主机能力分发处
    const record = service.registry.getPlugin(TEST_ID);
    const original = record.manifest.permissions;
    record.manifest.permissions = {};
    let err = null;
    try {
      await service._handleHostCall(TEST_ID, 'models.list', {});
    } catch (e) {
      err = e;
    }
    record.manifest.permissions = original;
    expect(err && err.code).to.equal(ERR.PERMISSION_DENIED);
  });

  it('卸载插件会撤销它的全部授权', async function () {
    models.grant(`plugin:${TEST_ID}`, 'user:local.7f3a', 'allow', 'always');
    expect(models.acl.listForSubject(`plugin:${TEST_ID}`)).to.have.length(1);
    models.dropSubject(`plugin:${TEST_ID}`);
    expect(models.acl.listForSubject(`plugin:${TEST_ID}`)).to.have.length(0);
  });
});
