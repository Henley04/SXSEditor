const { expect } = require('chai');

const { Disposable, DisposableStore, AbortBucket } = require('../src/shared/pluginDisposable');
const { readZip, createZip, normalizeEntryPath } = require('../src/shared/pluginZip');
const { validateManifest, isLegacyManifest, satisfiesVersion, isValidPluginId } = require('../src/shared/pluginManifest');
const {
  PluginError, makeRequest, makeResult, makeError, makeEvent, isMessage, sanitizeForWire,
} = require('../src/shared/pluginProtocol');

/** 一份最小但完整、可被 validateManifest 接受的 v2 manifest。 */
function goodManifest(overrides = {}) {
  return {
    apiVersion: 2,
    id: 'com.example.demo',
    name: 'Demo Plugin',
    version: '1.0.0',
    description: 'fixture',
    main: 'main.js',
    engines: { app: '>=1.0.0' },
    permissions: { ui: ['menu'] },
    contributes: {
      commands: [{ id: 'hello', title: 'Hello' }],
      panels: [{ id: 'main', title: 'Demo', entry: 'panel/index.html', apiScopes: ['state.get', 'command.run'] }],
    },
    ...overrides,
  };
}

// ===========================================================================
// Disposable / DisposableStore / AbortBucket
// ===========================================================================
describe('pluginDisposable', function () {
  it('Disposable.from 接受函数、{dispose} 与 null', function () {
    let a = 0;
    let b = 0;
    Disposable.from(() => { a++; }).dispose();
    Disposable.from({ dispose() { b++; } }).dispose();
    expect(() => Disposable.from(null).dispose()).to.not.throw();
    expect(() => Disposable.from(undefined).dispose()).to.not.throw();
    expect(a).to.equal(1);
    expect(b).to.equal(1);
  });

  it('Disposable 是幂等的：dispose 两次只跑一次', function () {
    let n = 0;
    const d = new Disposable(() => { n++; });
    d.dispose();
    d.dispose();
    expect(n).to.equal(1);
  });

  it('DisposableStore 按 LIFO 顺序释放', function () {
    const order = [];
    const store = new DisposableStore();
    store.add(() => order.push('a'));
    store.add(() => order.push('b'));
    store.add(() => order.push('c'));
    store.dispose();
    // 逆序：后注册的先撤销（依赖关系是"先建的先存在"）
    expect(order).to.deep.equal(['c', 'b', 'a']);
  });

  it('DisposableStore 已销毁后再 add 会当场释放，不积压', function () {
    let n = 0;
    const store = new DisposableStore();
    store.dispose();
    store.add(() => { n++; });
    // 当场释放，而不是等下一次 dispose（否则晚注册的监听永远没人撤）
    expect(n).to.equal(1);
  });

  it('AbortBucket.listen 在 abort 时摘掉监听', function () {
    const bucket = new AbortBucket();
    const target = new EventTarget();
    let hits = 0;
    bucket.listen(target, 'ping', () => { hits++; });
    target.dispatchEvent(new Event('ping'));
    expect(hits).to.equal(1);

    bucket.dispose();
    target.dispatchEvent(new Event('ping'));
    expect(hits).to.equal(1);
  });

  it('AbortBucket.loop 在 abort 后不再申请下一帧', function () {
    const bucket = new AbortBucket();
    const originalRaf = global.requestAnimationFrame;
    const originalCaf = global.cancelAnimationFrame;
    let scheduled = 0;
    let frames = 0;
    global.requestAnimationFrame = (fn) => { scheduled++; setTimeout(fn, 0); return scheduled; };
    global.cancelAnimationFrame = () => {};

    try {
      bucket.loop(() => { frames++; });
      expect(scheduled).to.equal(1);
      bucket.dispose();
      // dispose 之后即使回调被触发，也不该再排下一帧
      expect(scheduled).to.equal(1);
      expect(frames).to.equal(0);
    } finally {
      global.requestAnimationFrame = originalRaf;
      global.cancelAnimationFrame = originalCaf;
    }
  });
});

// ===========================================================================
// zip
// ===========================================================================
describe('pluginZip', function () {
  it('createZip → readZip 往返，内容与路径一致', function () {
    const zip = createZip([
      { path: 'manifest.json', data: JSON.stringify(goodManifest()) },
      { path: 'panel/index.html', data: '<!doctype html><title>hi</title>' },
    ]);
    const { entries } = readZip(zip);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e.data.toString('utf8')]));
    expect(Object.keys(byPath).sort()).to.deep.equal(['manifest.json', 'panel/index.html']);
    expect(byPath['panel/index.html']).to.contain('hi');
  });

  it('拒绝绝对路径与目录穿越', function () {
    expect(normalizeEntryPath('/etc/passwd')).to.equal(null);
    expect(normalizeEntryPath('C:\\Windows\\win.ini')).to.equal(null);
    expect(normalizeEntryPath('../../evil.js')).to.equal(null);
    expect(normalizeEntryPath('a/../../evil.js')).to.equal(null);
    expect(normalizeEntryPath('./a/b.js')).to.equal('a/b.js');
  });

  it('拒绝写在包内的 .git 目录', function () {
    expect(normalizeEntryPath('.git/config')).to.equal(null);
    expect(normalizeEntryPath('a/.git/HEAD')).to.equal(null);
  });

  it('条目数超限时拒绝（防"小文件炸弹"）', function () {
    const zip = createZip([
      { path: 'a.txt', data: 'a' },
      { path: 'b.txt', data: 'b' },
      { path: 'c.txt', data: 'c' },
    ]);
    expect(() => readZip(zip, { maxEntries: 2 })).to.throw(/条目/);
  });

  it('单文件超限与总大小超限分别拒绝', function () {
    const zip = createZip([{ path: 'big.txt', data: 'x'.repeat(4096) }]);
    expect(() => readZip(zip, { maxSingleFileBytes: 1024 })).to.throw(/单个文件|过大/);
    expect(() => readZip(zip, { maxTotalBytes: 1024 })).to.throw(/总大小|过大/);
  });

  it('非 zip 数据被拒绝而不是静默返回空', function () {
    expect(() => readZip(Buffer.from('not a zip at all, really not'))).to.throw(/zip/i);
  });
});

// ===========================================================================
// manifest
// ===========================================================================
describe('pluginManifest', function () {
  const ctx = { dirName: 'com.example.demo', appVersion: '1.5.0' };

  it('接受合法 manifest 并补齐默认值', function () {
    const r = validateManifest(goodManifest(), ctx);
    expect(r.ok, r.error).to.equal(true);
    const m = r.value;
    expect(m.id).to.equal('com.example.demo');
    // 命令 id 被展开成全局 id
    expect(m.contributes.commands[0].id).to.equal('com.example.demo.hello');
    expect(m.contributes.commands[0].localId).to.equal('hello');
    expect(m.contributes.panels[0].width).to.be.a('number');
    expect(m.permissionsHash).to.be.a('string').and.not.empty;
  });

  it('id 与目录名不一致时拒绝', function () {
    const r = validateManifest(goodManifest(), { ...ctx, dirName: 'other-dir' });
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/目录名/);
  });

  it('拒绝注册 .sxsproj（内置工程格式不允许被接管）', function () {
    const r = validateManifest(goodManifest({
      contributes: {
        commands: [],
        panels: [],
        fileTypes: [{ ext: '.sxsproj', role: 'both' }],
      },
    }), ctx);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/sxsproj/);
  });

  it('拒绝把菜单挂到 plugins 之外的位置', function () {
    const r = validateManifest(goodManifest({
      contributes: {
        commands: [{ id: 'hello', title: 'Hello' }],
        menus: [{ path: 'file', command: 'hello' }],
      },
    }), ctx);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/路径|menu/i);
  });

  it('拒绝面板申请未声明过的能力', function () {
    const r = validateManifest(goodManifest({
      contributes: {
        commands: [],
        panels: [{ id: 'p', title: 'P', entry: 'p.html', apiScopes: ['fs.write', 'definitely.not.a.scope'] }],
      },
    }), ctx);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/未知能力/);
  });

  it('拒绝未知的贡献点（避免拼写错误被静默吞掉）', function () {
    const r = validateManifest(goodManifest({
      contributes: { commands: [], panell: [] },
    }), ctx);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/未知贡献点/);
  });

  it('engines.app 不满足时拒绝', function () {
    const r = validateManifest(goodManifest({ engines: { app: '>=99.0.0' } }), ctx);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/要求宿主/);
  });

  it('未实现的贡献点被记入 pendingContributions 而不是报错', function () {
    const r = validateManifest(goodManifest({
      contributes: {
        commands: [{ id: 'hello', title: 'Hello' }],
        statusBar: [{ id: 'sb', text: 'x' }],
      },
    }), ctx);
    expect(r.ok, r.error).to.equal(true);
    expect(r.value.pendingContributions).to.include('statusBar');
  });

  it('isLegacyManifest 只认 apiVersion===1', function () {
    expect(isLegacyManifest({ apiVersion: 1 })).to.equal(true);
    expect(isLegacyManifest({ apiVersion: 2 })).to.equal(false);
    expect(isLegacyManifest({})).to.equal(false);
    expect(isLegacyManifest(null)).to.equal(false);
  });

  it('isValidPluginId 拒绝路径字符与空段', function () {
    expect(isValidPluginId('com.example.demo')).to.equal(true);
    expect(isValidPluginId('demo-plugin_1')).to.equal(true);
    expect(isValidPluginId('..')).to.equal(false);
    expect(isValidPluginId('a/b')).to.equal(false);
    expect(isValidPluginId('')).to.equal(false);
  });

  it('satisfiesVersion 支持 >=/</^/~ 与精确版本', function () {
    expect(satisfiesVersion('1.5.0', '>=1.0.0')).to.equal(true);
    expect(satisfiesVersion('1.5.0', '>=1.0.0 <2.0.0')).to.equal(true);
    expect(satisfiesVersion('2.1.0', '>=1.0.0 <2.0.0')).to.equal(false);
    expect(satisfiesVersion('1.2.9', '^1.2.0')).to.equal(true);
    expect(satisfiesVersion('2.0.0', '^1.2.0')).to.equal(false);
    expect(satisfiesVersion('1.2.5', '~1.2.0')).to.equal(true);
    expect(satisfiesVersion('1.3.0', '~1.2.0')).to.equal(false);
    expect(satisfiesVersion('1.5.0', '1.5.0')).to.equal(true);
  });
});

// ===========================================================================
// 协议
// ===========================================================================
describe('pluginProtocol', function () {
  it('消息构造与识别保持一致', function () {
    const req = makeRequest('k1', 'command.run', { a: 1 });
    expect(req.v).to.equal(2);
    expect(isMessage(req)).to.equal(true);
    expect(isMessage({ kind: 'req' })).to.equal(false); // 缺 v
    expect(isMessage(null)).to.equal(false);

    expect(makeResult('k1', 42).kind).to.equal('res');
    expect(makeError('k1', new PluginError('NOT_FOUND', 'nope')).error.code).to.equal('NOT_FOUND');
    expect(makeEvent('progress', { p: 1 }).event).to.equal('progress');
  });

  it('PluginError 保留 code', function () {
    const err = new PluginError('TIMEOUT', 'slow');
    expect(err).to.be.instanceOf(Error);
    expect(err.code).to.equal('TIMEOUT');
    expect(err.message).to.equal('slow');
  });

  it('sanitizeForWire 截断超深结构而不抛栈溢出', function () {
    let deep = { v: 1 };
    for (let i = 0; i < 64; i++) deep = { child: deep };
    const out = sanitizeForWire(deep);
    // 只要求"能返回且可序列化"，具体截断深度由实现决定（当前是 8 层）
    expect(out).to.be.an('object');
    expect(() => JSON.stringify(out)).to.not.throw();
  });

  it('sanitizeForWire 把 TypedArray 视图按字节切片（不复制整块 buffer）', function () {
    const base = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const view = base.subarray(2, 5);
    const out = sanitizeForWire({ t: view });
    expect(out.t).to.be.instanceOf(Uint8Array);
    // 3 个 float32 = 12 字节，而不是整块 32 字节
    expect(out.t.length).to.equal(12);
  });

  it('sanitizeForWire 丢弃函数，并把循环引用截断而不是死循环', function () {
    const cyclic = { name: 'x' };
    cyclic.self = cyclic;
    const out = sanitizeForWire({ fn: () => 1, cyclic });
    expect(out.fn).to.equal(undefined);
    // 循环引用不会抛错：靠深度上限截断
    expect(() => JSON.stringify(out)).to.not.throw();
    expect(out.cyclic.name).to.equal('x');
  });
});

// ===========================================================================
// 仓库自带的示例插件（plugins/example-hello）
//
// 它是插件作者最先照抄的那份文件，一旦 schema 演进后忘了同步，作者照着写
// 就会得到一堆校验错误。这条用例把"示例必须永远合法"钉住。
// ===========================================================================
describe('example plugin fixture', function () {
  const fs = require('node:fs');
  const path = require('node:path');

  it('plugins/example-hello/manifest.json 通过当前 schema 校验', function () {
    const dir = path.resolve(__dirname, '..', 'plugins', 'example-hello');
    const file = path.join(dir, 'manifest.json');
    expect(fs.existsSync(file), `缺少 ${file}`).to.equal(true);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = validateManifest(manifest, { dirName: 'example-hello', appVersion: '2.0.2' });
    expect(r.ok, r.error).to.equal(true);
    // 它的面板必须声明能力，否则面板里任何 RPC 都会被 PERMISSION_DENIED
    expect(r.value.contributes.panels[0].apiScopes.length).to.be.greaterThan(0);
    // 主入口必须真实存在，否则插件装上就跑不起来
    expect(fs.existsSync(path.join(dir, r.value.main))).to.equal(true);
    for (const panel of r.value.contributes.panels) {
      expect(fs.existsSync(path.join(dir, panel.entry)), `面板入口缺失：${panel.entry}`).to.equal(true);
    }
  });
});
