'use strict';
/**
 * 内置官方插件（official-project-import）的默认安装链路。
 *
 * 覆盖用户可见的策略，全部跑在真实的 PluginStateStore / PluginInstaller /
 * PluginService 上，只打桩 electron：
 *   · 首次启动从包内源码装到用户插件目录，来源如实记为 builtin / 未签名；
 *   · 已安装不覆盖用户目录里的任何文件；
 *   · 用户停用后重启不强制启用；
 *   · 目录被删而注册表还在时重装，且保留此前的停用选择；
 *   · 服务层（界面/命令行/自动化的公共收口）拒绝卸载内置插件。
 *
 * 为什么用临时插件根：这些断言都是"磁盘事实"，不能污染真实 userData，
 * 也不能依赖机器上是否已经跑过应用。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { expect } = require('chai');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN_SRC = path.join(ROOT, 'plugins', 'official-project-import');
const BUILTIN_ID = 'official-project-import';
// 与 manifest 的 engines.app >= 2.0.0 对齐；用真实版本而不是 '0.0.0'，
// 否则校验会在第一步判死，后面的断言全部测不到真正的安装链路。
const APP_VERSION = '2.0.2';

describe('builtinPlugins — 内置官方插件默认安装', function () {
  this.timeout(30000);

  const electronStub = {
    app: {
      getPath: () => ROOT,
      getVersion: () => APP_VERSION,
      getAppPath: () => ROOT,
      getLocale: () => 'en',
      isPackaged: false,
    },
    ipcMain: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 0 }),
    },
    shell: { openPath() {} },
    Menu: { getApplicationMenu: () => null, buildFromTemplate: () => ({}) },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    utilityProcess: { fork: () => { throw new Error('安装用例不应启动插件进程'); } },
    protocol: { handle() {}, registerSchemesAsPrivileged() {} },
  };

  const originalLoad = Module._load;
  let root;
  let store;
  let builtin;
  let service;

  before(function () {
    Module._load = function (request) {
      if (request === 'electron') return electronStub;
      return originalLoad.apply(this, arguments);
    };
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-builtin-'));
    store = require('../src/main/plugins/PluginStateStore.js');
    store._setRootForTests(root);
    builtin = require('../src/main/plugins/builtinPlugins.js');
  });

  after(function () {
    try { service && service.disposeAll(); } catch (_) { /* 退出路径不抛 */ }
    try { store && store._setRootForTests(null); } catch (_) { /* ignore */ }
    Module._load = originalLoad;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const targetDir = () => path.join(root, 'plugins', BUILTIN_ID);
  const ensure = (extra = {}) => builtin.ensureBuiltinPlugins({
    sourceDir: PLUGIN_SRC, appVersion: APP_VERSION, ...extra,
  });
  const stateOf = () => store.getPluginState(store.readRegistry(), BUILTIN_ID);

  it('能从源码布局定位随包分发的内置插件目录', function () {
    const dir = builtin.resolveBuiltinPluginsDir();
    expect(dir).to.be.a('string');
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).to.equal(true);
    expect(require(path.join(dir, 'manifest.json')).id).to.equal(BUILTIN_ID);
  });

  it('首次启动：装到用户插件目录，来源记为 builtin，暂存目录清空', function () {
    const result = ensure();
    expect(result.ok, result.error).to.equal(true);
    expect(result.installed).to.equal(true);
    expect(result.id).to.equal(BUILTIN_ID);

    expect(fs.existsSync(path.join(targetDir(), 'manifest.json'))).to.equal(true);
    expect(fs.existsSync(path.join(targetDir(), 'lib', 'score.js'))).to.equal(true);

    const state = stateOf();
    expect(state.source).to.equal('builtin');
    expect(state.enabled).to.equal(true);
    // 随应用分发、没有独立签名文件：如实记为未签名，不谎称验签通过。
    expect(state.signature.status).to.equal('unsigned');
    expect(state.signature.origin).to.equal('builtin');

    // staging 是临时复制区，安装完必须清空。
    expect(fs.readdirSync(path.join(root, 'plugins', '.staging'))).to.have.length(0);
    // 安装器内部已写一条 install 审计，装配层不重复留痕。
    const installs = store.readAudit().filter((e) => e.event === 'install' && e.pluginId === BUILTIN_ID);
    expect(installs).to.have.length(1);
  });

  it('已安装时不再覆盖用户目录里的文件', function () {
    fs.writeFileSync(path.join(targetDir(), 'user-marker.txt'), 'keep me');
    const result = ensure();
    expect(result.ok).to.equal(true);
    expect(result.installed).to.equal(false);
    expect(result.reason).to.equal('already-installed');
    expect(fs.readFileSync(path.join(targetDir(), 'user-marker.txt'), 'utf8')).to.equal('keep me');
  });

  it('用户停用后重启：保持停用，不强制重新启用', function () {
    const registry = store.readRegistry();
    store.setPluginState(registry, BUILTIN_ID, { enabled: false });
    store.writeRegistry(registry);

    const result = ensure();
    expect(result.ok).to.equal(true);
    expect(result.installed).to.equal(false);
    expect(stateOf().enabled).to.equal(false);
  });

  it('目录被删但注册表仍在：重装且保留此前的停用状态', function () {
    fs.rmSync(targetDir(), { recursive: true, force: true });
    const result = ensure();
    expect(result.ok, result.error).to.equal(true);
    expect(result.installed).to.equal(true);
    expect(fs.existsSync(path.join(targetDir(), 'manifest.json'))).to.equal(true);
    expect(stateOf().enabled).to.equal(false);
  });

  it('源码清单 id 与内置约定不符时拒绝安装，不落到用户目录', function () {
    const fake = fs.mkdtempSync(path.join(root, 'fake-src-'));
    fs.cpSync(PLUGIN_SRC, fake, { recursive: true });
    const manifestPath = path.join(fake, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    m.id = 'not-the-builtin-plugin';
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));

    const result = builtin.ensureBuiltinPlugins({ sourceDir: fake, appVersion: APP_VERSION });
    expect(result.ok).to.equal(false);
    expect(result.reason).to.equal('id-mismatch');
    expect(fs.existsSync(path.join(root, 'plugins', 'not-the-builtin-plugin'))).to.equal(false);
  });

  it('显式指定的源码目录无效时安全失败，启动入口不抛异常', function () {
    const result = builtin.ensureBuiltinPlugins({
      sourceDir: path.join(root, 'no-such-source'), appVersion: APP_VERSION,
    });
    expect(result.ok).to.equal(false);
    expect(result.installed).to.equal(false);
    // 显式给了目录却读不到清单 → invalid-manifest。`source-not-found` 是另一条
    // 分支：不带 sourceDir 且所有随包候选路径都不存在（精简构建），在仓库内
    // 运行的单测里无法自然构造，由启动入口的降级日志覆盖，这里不伪称覆盖。
    expect(result.reason).to.equal('invalid-manifest');
    // 启动链路上的任何异常都只能记录、不能把应用启动拖挂。
    expect(() => builtin.installBuiltinOnStartup(APP_VERSION)).to.not.throw();
  });

  it('PluginService 拒绝卸载内置插件，文件与注册表都保持原样', async function () {
    const { PluginService } = require('../src/main/plugins/PluginService.js');
    service = new PluginService();
    // 只放进一条带 builtin 来源的记录即可走到守卫：守卫在 probe/运行时/删文件
    // 之前返回，后面的步骤不会触碰，因此不必起整套 init 与插件进程。
    service.registry.addPlugin({
      id: BUILTIN_ID,
      manifest: { name: 'Official Project Import', contributes: {} },
      dir: targetDir(),
      state: { source: 'builtin', enabled: true },
    });

    const result = await service.uninstall(BUILTIN_ID, { keepData: false });
    expect(result.ok).to.equal(false);
    expect(result.error).to.match(/不可卸载/);
    expect(fs.existsSync(path.join(targetDir(), 'manifest.json'))).to.equal(true);
    expect(service.registry.getPlugin(BUILTIN_ID)).to.be.ok;
  });
});
