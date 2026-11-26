const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const sinon = require('sinon');

const { validateManifest } = require('../src/shared/pluginManifest');
const { HOST_CALL_METHODS } = require('../src/shared/pluginApi');
const sourcePolicy = require('../src/main/plugins/PluginSourcePolicy');

/**
 * 插件发起的安装：强制用户确认是唯一放行闸门。
 *
 * 这里跑真的 PluginService + 真的 PluginSourcePolicy + 真的确认对话框代码，
 * 只把「包内容」与「落盘」打桩 —— 断言的重点是：批量只弹一次、拒绝整批不落盘、
 * 自更新降级被挡住、非市场来源被标注、缺权限直接拒绝。
 */
const CALLER = 'com.example.caller';

function callerManifest(overrides = {}) {
  const m = {
    apiVersion: 2,
    id: CALLER,
    name: 'Caller',
    version: '1.0.0',
    main: 'main.js',
    engines: { app: '>=1.0.0' },
    permissions: {},
    ...overrides,
  };
  const r = validateManifest(m, { dirName: CALLER, appVersion: '1.5.0' });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('插件发起安装 — 强制用户确认', function () {
  this.timeout(30000);

  const electronStub = {
    app: {
      getPath: () => path.join(os.tmpdir(), 'sxseditor-plugin-install-consent'),
      getVersion: () => '1.5.0',
      getLocale: () => 'en',
      isPackaged: false,
    },
    ipcMain: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
    dialog: {
      showOpenDialog: () => ({ canceled: true, filePaths: [] }),
      showMessageBox: () => ({ response: 0 }),
    },
    shell: { openPath() {} },
    Menu: { getApplicationMenu: () => null, buildFromTemplate: () => ({}) },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    utilityProcess: { fork() { throw new Error('本用例不启动插件进程'); } },
    protocol: { handle() {}, registerSchemesAsPrivileged() {} },
  };

  let root;
  let store;
  let service;
  let installer;
  let pluginMarket;
  let consent;
  let localPackage;
  let msgBox;
  let install;

  const originalLoad = Module._load;

  before(function () {
    Module._load = function (request) {
      if (request === 'electron') return electronStub;
      return originalLoad.apply(this, arguments);
    };
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxsp-consent-'));
    store = require('../src/main/plugins/PluginStateStore.js');
    store._setRootForTests(root);
    installer = require('../src/main/plugins/PluginInstaller.js');
    pluginMarket = require('../src/main/plugins/PluginMarket.js');
    consent = require('../src/main/plugins/PluginInstallConsent.js');
    const { PluginService } = require('../src/main/plugins/PluginService.js');
    service = new PluginService();
    service.init({ getMainWindow: () => null, locale: 'en' });

    localPackage = path.join(root, 'dep.sxsp');
    fs.writeFileSync(localPackage, Buffer.alloc(32));
  });

  after(function () {
    sinon.restore();
    try { service && service.disposeAll(); } catch (_) { /* ignore */ }
    try { store && store._setRootForTests(null); } catch (_) { /* ignore */ }
    Module._load = originalLoad;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(function () {
    sinon.restore();
    service.registry = new (require('../src/main/plugins/PluginRegistry.js').PluginRegistry)();
    service.runtimes = { onEvent: null, onExit: null, stopAll() {}, disposeAll() {} };
    service.mainWindowGetter = () => null;
    service.registry.addPlugin({
      id: CALLER,
      manifest: callerManifest({ permissions: { plugins: ['inspect', 'installMarket'] } }),
      dir: root,
      state: {},
    });

    // 市场预览按请求的 pluginId 回一个"索引里就是这一版"的结果。
    sinon.stub(pluginMarket, 'preview').callsFake(async (_src, id) => ({
      ok: true,
      source: { id: 'src-1' },
      entry: { id, version: '1.0.0' },
      warnings: [],
      packagePath: path.join(root, `${id}.sxsp`),
      preview: { signature: { status: 'unsigned' } },
    }));

    // 包预览按缓存文件名推断 id。单独用例可覆盖这个 behavior。
    sinon.stub(installer, 'previewPackage').callsFake((packagePath) => {
      const id = path.basename(String(packagePath), '.sxsp');
      return {
        ok: true,
        preview: {
          id, name: id, version: '1.0.0',
          permissions: {}, permissionsHash: `h-${id}`,
          installable: true,
          signature: { status: 'unsigned', keyId: '' },
        },
      };
    });
    install = sinon.stub(installer, 'installFromPackage').returns({ ok: true });
    sinon.stub(service, 'reloadAll').resolves();
    msgBox = sinon.stub(electronStub.dialog, 'showMessageBox').resolves({ response: 1 });
  });

  /** 让包预览固定返回指定 id / version（自更新与版本冲突用例用）。 */
  function previewAs(id, version) {
    installer.previewPackage.restore();
    sinon.stub(installer, 'previewPackage').returns({
      ok: true,
      preview: {
        id, name: id, version,
        permissions: {}, permissionsHash: `h-${id}-${version}`,
        installable: true,
        signature: { status: 'unsigned', keyId: '' },
      },
    });
  }

  function marketAs(id, version) {
    pluginMarket.preview.restore();
    sinon.stub(pluginMarket, 'preview').callsFake(async () => ({
      ok: true,
      source: { id: 'src-1' },
      entry: { id, version },
      warnings: [],
      packagePath: path.join(root, `${id}.sxsp`),
      preview: { signature: { status: 'unsigned' } },
    }));
  }

  it('批量只弹一次框，detail 里逐条列出全部目标', async function () {
    const r = await service.installMany(CALLER, [
      { pluginId: 'audio.cpp' },
      { pluginId: 'llama.cpp' },
    ]);

    expect(r.ok, JSON.stringify(r)).to.equal(true);
    expect(r.installed).to.have.length(2);
    expect(msgBox.callCount).to.equal(1);
    const detail = msgBox.firstCall.args[1].detail;
    expect(detail).to.include('audio.cpp');
    expect(detail).to.include('llama.cpp');
    expect(detail).to.include(CALLER);
    expect(msgBox.firstCall.args[1].defaultId).to.equal(0);
    expect(msgBox.firstCall.args[1].cancelId).to.equal(0);
  });

  it('拒绝时整批不落盘，逐条写 install-rejected 审计', async function () {
    msgBox.resolves({ response: 0 });
    const r = await service.installMany(CALLER, [
      { pluginId: 'audio.cpp' }, { pluginId: 'llama.cpp' },
    ]);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal('USER_DECLINED');
    expect(install.called).to.equal(false);
    const log = service.getLog(50);
    const rejected = log.filter((e) => e.event === 'install-rejected' && e.detail && e.detail.reason === 'user-declined');
    expect(rejected).to.have.length(2);
  });

  it('自更新降级被拒，且不弹框、不落盘', async function () {
    service.registry.addPlugin({
      id: CALLER,
      manifest: callerManifest({
        version: '2.0.0',
        permissions: { plugins: ['installMarket', 'selfUpdate'] },
      }),
      dir: root, state: {},
    });
    marketAs(CALLER, '1.0.0');
    previewAs(CALLER, '1.0.0');

    const r = await service.installMany(CALLER, [{ pluginId: CALLER, version: '1.0.0' }]);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal('SELF_DOWNGRADE');
    expect(install.called).to.equal(false);
    expect(msgBox.called).to.equal(false);
    const log = service.getLog(50);
    expect(log.some((e) => e.event === 'install-rejected' && e.detail && e.detail.reason === 'self-downgrade')).to.equal(true);
  });

  it('自更新未指定版本被拒（无法判断新旧，禁止重放旧包）', async function () {
    service.registry.addPlugin({
      id: CALLER,
      manifest: callerManifest({ permissions: { plugins: ['installMarket', 'selfUpdate'] } }),
      dir: root, state: {},
    });
    marketAs(CALLER, '1.0.0');
    previewAs(CALLER, '1.0.0');

    const r = await service.installMany(CALLER, [{ pluginId: CALLER }]);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/必须指定版本号/);
  });

  it('已安装且满足时跳过，不重复装同一个运行时', async function () {
    service.registry.addPlugin({
      id: 'audio.cpp',
      manifest: { version: '1.0.0', permissionsHash: 'h-audio.cpp' },
      dir: root, state: {},
    });
    const r = await service.installMany(CALLER, [{ pluginId: 'audio.cpp' }]);
    expect(r.ok).to.equal(true);
    expect(r.skipped).to.have.length(1);
    expect(r.installed).to.have.length(0);
    expect(install.called).to.equal(false);
    expect(msgBox.called).to.equal(false);
  });

  it('指定版本但包里不是这一版 → 整批拒绝', async function () {
    const r = await service.installMany(CALLER, [{ pluginId: 'audio.cpp', version: '2.0.0' }]);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal('VERSION_MISMATCH');
    expect(install.called).to.equal(false);
  });

  it('不可安装的包（校验失败）不进入确认框', async function () {
    installer.previewPackage.restore();
    sinon.stub(installer, 'previewPackage').returns({
      ok: true,
      preview: {
        id: 'audio.cpp', name: 'audio.cpp', version: '1.0.0',
        permissions: {}, permissionsHash: 'h', installable: false,
        blockCode: 'CHECKSUM_FAILED', blockMessage: '校验清单不匹配',
        signature: { status: 'unsigned', keyId: '' },
      },
    });
    const r = await service.installMany(CALLER, [{ pluginId: 'audio.cpp' }]);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal('CHECKSUM_FAILED');
    expect(msgBox.called).to.equal(false);
  });

  it('非市场来源需要单独权限，确认框里显式标注', async function () {
    service.registry.addPlugin({
      id: CALLER,
      manifest: callerManifest({ permissions: { plugins: ['installPath'] } }),
      dir: root, state: {},
    });
    previewAs('local.dep', '1.0.0');

    const r = await service.installMany(CALLER, [{ path: localPackage }]);
    expect(r.ok, JSON.stringify(r)).to.equal(true);
    expect(msgBox.firstCall.args[1].detail).to.include('非市场来源');
  });

  it('缺 installUrl 权限直接拒绝，不发网络请求', async function () {
    const err = await service.installMany(CALLER, [
      { url: 'https://example.com/dep.sxsp' },
    ]).catch((e) => e);
    expect(err.code).to.equal('PERMISSION_DENIED');
    expect(err.message).to.include('installUrl');
  });

  it('http 直链在归一化阶段就被拒（不进入下载）', function () {
    const r = sourcePolicy.normalizeInstallSpec(
      { url: 'http://example.com/dep.sxsp' },
      { plugins: ['installUrl'] }, CALLER,
    );
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/https/);
  });

  it('系统目录里的本地包被拒', function () {
    const r = sourcePolicy.normalizeInstallSpec(
      { path: '/etc/passwd.sxsp' },
      { plugins: ['installPath'] }, CALLER,
    );
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal('FORBIDDEN');
  });

  it('单次批量超上限被拒', function () {
    const specs = Array.from({ length: sourcePolicy.MAX_BATCH + 1 }, () => ({ pluginId: 'audio.cpp' }));
    const r = sourcePolicy.normalizeInstallBatch(specs, { plugins: ['installMarket'] }, CALLER);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/最多/);
  });

  it('hostCall 未知方法被第二道白名单挡住', async function () {
    expect(HOST_CALL_METHODS).to.include('plugins.installMany');
    const err = await service._handleHostCall(CALLER, 'installFromPackage', {}).catch((e) => e);
    expect(err.code).to.equal('UNSUPPORTED');
  });

  it('声明依赖不会触发安装：纯查询不碰 installFromPackage', function () {
    const r = service.resolvePluginDependencies(CALLER);
    expect(r.deps).to.be.an('array');
    expect(install.called).to.equal(false);
  });

  it('确认对话框拿不到显示环境时 fail-closed', async function () {
    msgBox.rejects(new Error('no display'));
    const r = await consent.confirmInstallBatch({ callerId: CALLER, targets: [] });
    expect(r.confirmed).to.equal(false);
  });
});
