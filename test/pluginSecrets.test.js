const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/**
 * 插件密钥（M5 第 3 段）。
 *
 * 这一层的断言集中在**不该发生的事**上：
 *   · 没有声明 secrets 权限的插件读不到、也写不了；
 *   · 只读权限不能覆盖用户的 token；
 *   · 值不能被写进审计（审计能回答"改了哪个 key"，不能回答"值是什么"）；
 *   · 超过上限时拒绝，而不是把密钥存储当数据库用。
 */

// ---------------------------------------------------------------- 纯校验
const { PluginSecrets, LIMITS, checkKey, checkValue } = require('../src/main/plugins/PluginSecrets');
const { createSafeStorageSecrets } = require('../src/main/secretsStore');

describe('pluginSecrets — 键值校验', function () {
  it('接受字母/数字/点/下划线/连字符', function () {
    for (const k of ['token', 'cloud.apiKey', 'a_b-c', 'A1']) {
      expect(checkKey(k).ok, k).to.equal(true);
    }
  });

  it('拒绝空串、斜杠、前导符号、超长', function () {
    for (const k of ['', '/etc/passwd', '.hidden', '-x', 'a/b', 'x'.repeat(65)]) {
      expect(checkKey(k).ok, k).to.equal(false);
    }
  });

  it('值必须是字符串，且按 UTF-8 字节计长度', function () {
    expect(checkValue('abc').ok).to.equal(true);
    expect(checkValue(123).ok).to.equal(false);
    expect(checkValue(null).ok).to.equal(false);
    // 8192 字节：一个中文字符 3 字节，2731 个就超了
    expect(checkValue('中'.repeat(2731)).ok).to.equal(false);
    expect(checkValue('中'.repeat(2730)).ok).to.equal(true);
  });
});

// ---------------------------------------------------------------- 存储层

describe('secretsStore', function () {
  let dir;
  beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-secret-')); });
  afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

  it('没有 safeStorage 时以明文落盘，并如实报 encrypted:false', function () {
    const file = path.join(dir, 'plain.enc');
    const s = createSafeStorageSecrets({ file, safeStorage: null, logger: { warn() {} } });
    s.set('token', 'sk-plain');
    expect(s.get('token')).to.equal('sk-plain');
    expect(s.isEncrypted()).to.equal(false);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.encrypted).to.equal(false);
    expect(onDisk.data.token).to.equal('sk-plain');
  });

  it('有 safeStorage 时磁盘上没有明文，重新构造能解回来', function () {
    const file = path.join(dir, 'enc.enc');
    // 假加密：反转字节 + base64。只要"明文不出现在文件里"与"能解回"成立即可，
    // 不需要模拟真实 DPAPI/Keychain。
    const safe = {
      isEncryptionAvailable: () => true,
      // 输入字符串 → Buffer；存储层会再 base64 一次，读取时还原成同一个 Buffer。
      encryptString: (v) => Buffer.from([...Buffer.from(v, 'utf8')].reverse()),
      decryptString: (b) => Buffer.from([...b].reverse()).toString('utf8'),
    };
    const s = createSafeStorageSecrets({ file, safeStorage: safe, logger: { warn() {} } });
    s.set('token', 'sk-secret-value');
    expect(s.isEncrypted()).to.equal(true);
    expect(fs.readFileSync(file, 'utf8')).to.not.contain('sk-secret-value');

    const again = createSafeStorageSecrets({ file, safeStorage: safe, logger: { warn() {} } });
    expect(again.get('token')).to.equal('sk-secret-value');
  });

  it('单条解密失败不拖垮整个文件', function () {
    const file = path.join(dir, 'broken.enc');
    const safe = {
      isEncryptionAvailable: () => true,
      encryptString: (v) => Buffer.from(v),
      decryptString: (b) => {
        if (b.toString() === 'bad') throw new Error('bad payload');
        return b.toString();
      },
    };
    // good = base64('hello')；bad = base64('bad')，解密器见到 'bad' 就抛
    fs.writeFileSync(file, JSON.stringify({
      version: 1, encrypted: true, data: { good: 'aGVsbG8=', bad: 'YmFk' },
    }));
    const s = createSafeStorageSecrets({ file, safeStorage: safe, logger: { warn() {} } });
    expect(s.get('good')).to.equal('hello');
    expect(s.has('bad')).to.equal(false);
  });

  it('keys() 排序，size() 与 has() 一致', function () {
    const s = createSafeStorageSecrets({ file: path.join(dir, 'k.enc'), safeStorage: null, logger: { warn() {} } });
    s.set('b', '1'); s.set('a', '2');
    expect(s.keys()).to.deep.equal(['a', 'b']);
    expect(s.size()).to.equal(2);
    expect(s.has('a')).to.equal(true);
    expect(s.delete('a')).to.equal(true);
    expect(s.delete('a')).to.equal(false);
  });
});

// ---------------------------------------------------------------- 每插件隔离

describe('PluginSecrets', function () {
  let dir;
  let secrets;
  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-psecret-'));
    secrets = new PluginSecrets({ dir, safeStorage: null, logger: { warn() {} } });
  });
  afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

  it('get 区分"不存在"(null) 与"空串"', function () {
    expect(secrets.get('demo', 'token')).to.deep.equal({ ok: true, value: null });
    secrets.set('demo', 'token', '');
    expect(secrets.get('demo', 'token')).to.deep.equal({ ok: true, value: '' });
  });

  it('两个插件的密钥互不可见', function () {
    secrets.set('a', 'token', 'A');
    secrets.set('b', 'token', 'B');
    expect(secrets.get('a', 'token').value).to.equal('A');
    expect(secrets.get('b', 'token').value).to.equal('B');
  });

  it('第 65 个 key 被拒；覆盖已有 key 不算新增', function () {
    for (let i = 0; i < LIMITS.maxKeys; i++) {
      expect(secrets.set('demo', `k${i}`, 'v').ok, `k${i}`).to.equal(true);
    }
    const overflow = secrets.set('demo', 'one-too-many', 'v');
    expect(overflow.ok).to.equal(false);
    expect(overflow.code).to.equal('LIMIT_EXCEEDED');

    // 覆盖不受上限影响
    const again = secrets.set('demo', 'k0', 'v2');
    expect(again.ok).to.equal(true);
    expect(again.created).to.equal(false);
    expect(secrets.get('demo', 'k0').value).to.equal('v2');
  });

  it('超长值被拒，且不会留下半个 key', function () {
    const r = secrets.set('demo', 'big', 'x'.repeat(LIMITS.maxValueBytes + 1));
    expect(r.ok).to.equal(false);
    expect(secrets.keys('demo').keys).to.deep.equal([]);
  });

  it('invalidate 之后从磁盘重读（重装场景）', function () {
    secrets.set('demo', 'token', 'old');
    // 模拟另一个实例/插件自己改了文件
    const file = secrets.file('demo');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.data.token = 'new';
    fs.writeFileSync(file, JSON.stringify(data));
    expect(secrets.get('demo', 'token').value).to.equal('old');
    secrets.invalidate('demo');
    expect(secrets.get('demo', 'token').value).to.equal('new');
  });

  it('clear 删掉文件与缓存', function () {
    secrets.set('demo', 'token', 'x');
    expect(fs.existsSync(secrets.file('demo'))).to.equal(true);
    expect(secrets.clear('demo').ok).to.equal(true);
    expect(fs.existsSync(secrets.file('demo'))).to.equal(false);
    expect(secrets.get('demo', 'token').value).to.equal(null);
  });
});

// ---------------------------------------------------------------- 权限门
describe('PluginService — secrets 权限门与审计', function () {
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

  // PluginService 在**构造期**读 app.isPackaged、在 init 时经 ipcSafe **惰性**
  // require ipcMain，两处都必须命中桩，所以不能只包住 require。
  installStub();
  const { PluginService } = require('../src/main/plugins/PluginService');
  restoreStub();

  const store = require('../src/main/plugins/PluginStateStore');
  const { validateManifest } = require('../src/shared/pluginManifest');

  let root;
  let service;

  function addPlugin(id, secretsPerms) {
    const manifest = validateManifest({
      apiVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      main: 'main.js',
      engines: { app: '>=2.0.0' },
      permissions: { secrets: secretsPerms, fs: ['pluginData'] },
      contributes: { commands: [{ id: 'noop', title: 'Noop' }] },
    }, { dirName: id, appVersion: '9.9.9' });
    expect(manifest.ok, manifest.error).to.equal(true);
    service.registry.addPlugin({ id, manifest: manifest.value, dir: root, state: {} });
    return manifest.value;
  }

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-svcsecret-'));
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

  it('没有 secrets 权限：读写都被拒，并被审计', async function () {
    addPlugin('noperm', []);
    let err;
    try { await service._handleHostCall('noperm', 'secrets.set', { key: 'token', value: 'x' }); }
    catch (e) { err = e; }
    expect(err && err.code).to.equal('PERMISSION_DENIED');

    const denied = store.readAudit().filter((e) => e.event === 'secret-denied');
    expect(denied).to.have.length(1);
    expect(denied[0].detail).to.deep.equal({ action: 'set', key: 'token' });
  });

  it('只有 read：能读不能写', async function () {
    addPlugin('reader', ['read']);
    expect(await service._handleHostCall('reader', 'secrets.get', { key: 'token' })).to.equal(null);
    let err;
    try { await service._handleHostCall('reader', 'secrets.set', { key: 'token', value: 'x' }); }
    catch (e) { err = e; }
    expect(err && err.code).to.equal('PERMISSION_DENIED');
  });

  it('写入成功时审计只记 key，不记值', async function () {
    addPlugin('writer', ['read', 'write']);
    const r = await service._handleHostCall('writer', 'secrets.set', { key: 'cloud.apiKey', value: 'sk-do-not-log-me' });
    expect(r.ok).to.equal(true);
    expect(r.created).to.equal(true);

    const lines = fs.readFileSync(store.paths().audit, 'utf8');
    expect(lines).to.contain('"key":"cloud.apiKey"');
    expect(lines).to.not.contain('sk-do-not-log-me');

    const entry = store.readAudit().filter((e) => e.event === 'secret');
    expect(entry).to.have.length(1);
    expect(entry[0].detail.action).to.equal('set');
  });

  it('keys 只回名字；delete 幂等并审计 existed', async function () {
    addPlugin('rw', ['read', 'write']);
    await service._handleHostCall('rw', 'secrets.set', { key: 'a', value: '1' });
    await service._handleHostCall('rw', 'secrets.set', { key: 'b', value: '2' });
    const k = await service._handleHostCall('rw', 'secrets.keys', {});
    expect(k.keys).to.deep.equal(['a', 'b']);

    expect(await service._handleHostCall('rw', 'secrets.delete', { key: 'a' })).to.deep.equal({ ok: true, existed: true });
    expect(await service._handleHostCall('rw', 'secrets.delete', { key: 'a' })).to.deep.equal({ ok: true, existed: false });
  });

  it('非法 key 与超长值都被拒，不会落盘', async function () {
    addPlugin('rw2', ['read', 'write']);
    let err;
    try { await service._handleHostCall('rw2', 'secrets.set', { key: '../x', value: 'v' }); }
    catch (e) { err = e; }
    expect(err && err.code).to.equal('INVALID_REQUEST');

    err = null;
    try { await service._handleHostCall('rw2', 'secrets.set', { key: 'big', value: 'x'.repeat(9000) }); }
    catch (e) { err = e; }
    expect(err && err.code).to.equal('INVALID_REQUEST');
    expect(fs.existsSync(service.secrets.file('rw2'))).to.equal(false);
  });
});
