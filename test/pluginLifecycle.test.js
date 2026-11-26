const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { createZip } = require('../src/shared/pluginZip');

/**
 * 插件生命周期（M1 验收线）。
 *
 * 这里跑的是**真的 PluginService**，不是拆开的分件测试：
 *   安装 .sxsp → 目录落盘 → 注册表装载 → 菜单出现 → 卸载 → 泄漏断言 → 文件消失
 *
 * 之所以能在纯 Node 里跑：PluginService 对 electron 的依赖只有 app / ipcMain /
 * dialog / BrowserWindow / utilityProcess，全部可以打桩；插件 runtime 是
 * utilityProcess（本文件不启动它，命令派发由 M2 的用例覆盖）。
 */

const TEST_ID = 'com.example.demo';

function manifest(overrides = {}) {
  return {
    apiVersion: 2,
    id: TEST_ID,
    name: 'Demo Plugin',
    version: '1.0.0',
    description: 'lifecycle fixture',
    main: 'main.js',
    engines: { app: '>=1.0.0' },
    permissions: { ui: ['menu', 'panel'], automation: ['expose'] },
    contributes: {
      commands: [{ id: 'hello', title: 'Hello' }],
      panels: [{ id: 'main', title: 'Demo Panel', entry: 'panel/index.html', apiScopes: ['state.get'] }],
    },
    ...overrides,
  };
}

function buildPackage(extraFiles = []) {
  return createZip([
    { path: 'manifest.json', data: JSON.stringify(manifest(), null, 2) },
    { path: 'main.js', data: 'module.exports = { commands: {} };' },
    { path: 'panel/index.html', data: '<!doctype html><html><body>demo</body></html>' },
    ...extraFiles,
  ]);
}

describe('plugin lifecycle (M1 slice)', function () {
  this.timeout(30000);

  const electronStub = {
    app: {
      getPath: () => path.join(os.tmpdir(), 'sxseditor-plugin-lifecycle'),
      getVersion: () => '1.0.0',
      getLocale: () => 'en',
      isPackaged: false,
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

  let root;
  let store;
  let service;
  let registry;
  let pkgPath;

  const originalLoad = Module._load;
  before(function () {
    Module._load = function (request) {
      if (request === 'electron') return electronStub;
      return originalLoad.apply(this, arguments);
    };

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxsp-lifecycle-'));
    store = require('../src/main/plugins/PluginStateStore.js');
    store._setRootForTests(root);

    const { PluginService } = require('../src/main/plugins/PluginService.js');
    service = new PluginService();
    service.init({ getMainWindow: () => null, locale: 'en' });
    registry = service.registry;

    pkgPath = path.join(root, 'demo.sxsp');
    fs.writeFileSync(pkgPath, buildPackage());
  });

  after(function () {
    try { service && service.disposeAll(); } catch (_) { /* ignore */ }
    try { store && store._setRootForTests(null); } catch (_) { /* ignore */ }
    Module._load = originalLoad;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('初始状态：没有任何插件，菜单片段仍然可用', function () {
    expect(service.snapshot().plugins).to.have.length(0);
    const fragment = service.getMenuFragment();
    expect(fragment).to.be.an('object');
    expect(fragment.submenu.length).to.be.greaterThan(2);
  });

  it('安装 .sxsp：目录落盘、注册表装载、审计留痕', async function () {
    const result = await service.installFromPackage(pkgPath);
    expect(result.ok, result.error).to.equal(true);
    expect(result.id).to.equal(TEST_ID);

    // 1. 文件真的落到 plugins/<id>/
    const dir = path.join(root, 'plugins', TEST_ID);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).to.equal(true);
    expect(fs.existsSync(path.join(dir, 'panel', 'index.html'))).to.equal(true);
    // staging 目录不许残留
    expect(fs.readdirSync(path.join(root, 'plugins', '.staging'))).to.have.length(0);

    // 2. 注册表装载了它的贡献
    const snap = service.snapshot();
    expect(snap.plugins).to.have.length(1);
    expect(snap.plugins[0].status).to.equal('loaded');
    expect(snap.plugins[0].commands[0].id).to.equal(`${TEST_ID}.hello`);
    expect(snap.plugins[0].panels[0].id).to.equal(`${TEST_ID}.main`);

    // 3. 审计里有 install 记录
    const log = service.getLog(50);
    expect(log.some((e) => e.event === 'install' && e.pluginId === TEST_ID)).to.equal(true);
  });

  it('菜单出现该插件的命令项与面板项', function () {
    const fragment = service.getMenuFragment();
    const sub = fragment.submenu;
    const pluginMenu = sub.find((item) => item.label === 'Demo Plugin');
    expect(pluginMenu, '插件子菜单缺失').to.be.an('object');
    const labels = pluginMenu.submenu.map((i) => i.label);
    expect(labels).to.include('Hello');
    expect(labels.some((l) => l && l.includes('Demo Panel'))).to.equal(true);
    // 每个子菜单项都必须有 click，且不能是 undefined（原生菜单点了没反应最难查）
    for (const item of pluginMenu.submenu) {
      if (item.type === 'separator') continue;
      expect(item.click, `菜单项 ${item.label} 没有 click`).to.be.a('function');
    }
  });

  it('卸载：贡献清零、进程为 0、DOM 为 0、文件消失、目录干净', async function () {
    const before = await service.probe.snapshot(TEST_ID);
    expect(before.ownContributions).to.be.greaterThan(0);

    const result = await service.uninstall(TEST_ID, { keepData: false });
    expect(result.ok, result.error).to.equal(true);
    expect(result.removedContributions).to.be.greaterThan(0);

    // 文件确实删了
    expect(fs.existsSync(path.join(root, 'plugins', TEST_ID))).to.equal(false);
    // 注册表回到零
    const stats = registry.stats();
    for (const [key, value] of Object.entries(stats)) {
      expect(value, `${key} 未归零`).to.equal(0);
    }
    expect(service.snapshot().plugins).to.have.length(0);

    // 泄漏断言：五项必须全 0
    const verdict = await service.probe.assertClean(before, TEST_ID);
    expect(verdict.ok, JSON.stringify(verdict.deltas)).to.equal(true);
    expect(verdict.deltas.ownContributions).to.equal(0);
    expect(verdict.deltas.runtimeAlive).to.equal(0);
    expect(verdict.deltas.pendingRpc).to.equal(0);
    expect(verdict.deltas.dom).to.equal(0);
    expect(verdict.deltas.ipc).to.equal(0);
  });

  it('泄漏探针不是恒真：留下一个贡献就会被抓到', async function () {
    // 重新装一遍，然后"忘记"撤掉一个贡献，模拟只撤了一半的卸载
    const reinstall = await service.installFromPackage(pkgPath);
    expect(reinstall.ok, reinstall.error).to.equal(true);

    const before = await service.probe.snapshot(TEST_ID);
    registry.removePlugin(TEST_ID);
    registry.register('command', `${TEST_ID}.stale`, { pluginId: TEST_ID, localId: 'stale' });

    const verdict = await service.probe.assertClean(before, TEST_ID);
    expect(verdict.ok).to.equal(false);
    expect(verdict.deltas.ownContributions).to.be.greaterThan(0);

    // 清理，避免影响后续用例
    registry.removePlugin(TEST_ID);
    await service.uninstall(TEST_ID, { keepData: false });
  });

  it('keepData 时保留 plugin-data，默认则删除', async function () {
    expect((await service.installFromPackage(pkgPath)).ok).to.equal(true);
    const dataDir = path.join(root, 'plugin-data', TEST_ID);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), '{"k":1}');

    await service.uninstall(TEST_ID, { keepData: true });
    expect(fs.existsSync(dataDir)).to.equal(true);

    expect((await service.installFromPackage(pkgPath)).ok).to.equal(true);
    await service.uninstall(TEST_ID, { keepData: false });
    expect(fs.existsSync(dataDir)).to.equal(false);
  });

  it('停用只撤贡献、保留条目；再启用恢复贡献', async function () {
    expect((await service.installFromPackage(pkgPath)).ok).to.equal(true);

    const disabled = await service.setEnabled(TEST_ID, false);
    expect(disabled.ok).to.equal(true);

    // 关键：停用后插件仍出现在列表里，否则管理器里没有"启用"按钮可按
    const snap = service.snapshot();
    expect(snap.plugins).to.have.length(1);
    expect(snap.plugins[0].status).to.equal('disabled');
    expect(snap.plugins[0].commands).to.have.length(0);
    expect(registry.stats().command).to.equal(0);
    // 管理器的启停按钮读的是 admin 投影里的 state.enabled。如果这里仍是扫描时的
    // true，卡片会一直显示"停用"，用户再也点不回"启用"（M2 实机踩过）。
    const admin = service.adminSnapshot();
    expect(admin.plugins[0].state.enabled).to.equal(false);
    // 菜单里不该再出现它的子菜单
    const fragment = service.getMenuFragment();
    expect(fragment.submenu.some((i) => i.label === 'Demo Plugin')).to.equal(false);

    const enabled = await service.setEnabled(TEST_ID, true);
    expect(enabled.ok).to.equal(true);
    const after = service.snapshot();
    expect(after.plugins[0].status).to.equal('loaded');
    expect(after.plugins[0].commands).to.have.length(1);

    await service.uninstall(TEST_ID, { keepData: false });
  });

  it('拒绝非法包：缺 manifest / 目录穿越 / 非法 id', async function () {
    const bad = path.join(root, 'bad.sxsp');

    fs.writeFileSync(bad, createZip([{ path: 'main.js', data: 'x' }]));
    let r = await service.installFromPackage(bad);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/manifest/);

    // 目录穿越：zip 层就该拒绝，installer 不该写任何文件
    expect(() => createZip([{ path: '../escape.js', data: 'x' }])).to.throw(/非法条目路径/);

    // 包内 id 是"目录名的来源"，所以它不可能与目录名不一致（那条校验只在
    // 文件夹安装时才有意义）；包这一侧真正要挡的是 id 本身非法。
    fs.writeFileSync(bad, createZip([
      { path: 'manifest.json', data: JSON.stringify(manifest({ id: '../evil' })) },
      { path: 'main.js', data: 'x' },
    ]));
    r = await service.installFromPackage(bad);
    expect(r.ok).to.equal(false);

    // 失败路径不能在 plugins/ 下留任何目录
    const left = fs.readdirSync(path.join(root, 'plugins')).filter((n) => !n.startsWith('.'));
    expect(left).to.have.length(0);
  });
});
