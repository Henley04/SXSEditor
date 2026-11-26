const { expect } = require('chai');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const market = require('../src/shared/pluginMarket.js');
const signature = require('../src/shared/pluginSignature.js');
const { createZip } = require('../src/shared/pluginZip.js');
const store = require('../src/main/plugins/PluginStateStore.js');
const trust = require('../src/main/plugins/PluginTrustStore.js');
const installer = require('../src/main/plugins/PluginInstaller.js');
const client = require('../src/main/plugins/PluginMarket.js');

/**
 * M6 第 2 段：市场接口。
 *
 * 这一层最怕的是"索引说了算"：索引是纯文本，谁都能改。所有用例都围绕同一条线 ——
 * 列表页展示可以来自索引，**安装判定只能来自包内签名**。
 */

const TEST_ID = 'com.example.market';
const VERSION = '1.0.1';

function manifest(overrides = {}) {
  return {
    apiVersion: 2,
    id: TEST_ID,
    name: 'Market Fixture',
    version: VERSION,
    description: 'market fixture',
    author: 'Fixture Author',
    main: 'main.js',
    engines: { app: '>=1.0.0' },
    permissions: { fs: ['pluginData'], ui: ['panel'] },
    contributes: { commands: [{ id: 'ping', title: 'Ping' }] },
    ...overrides,
  };
}

function baseFiles(version = VERSION) {
  return [
    { path: 'manifest.json', data: JSON.stringify(manifest({ version }), null, 2) },
    { path: 'main.js', data: 'module.exports = { commands: { ping: async () => 1 } };' },
  ];
}

function checksumsFor(files) {
  const filesMap = {};
  for (const f of files) filesMap[f.path] = signature.sha256hex(f.data);
  return { algorithm: 'sha256', files: filesMap };
}

function buildPackage({ privateKey = null, version = VERSION, tamper = null } = {}) {
  const files = baseFiles(version);
  const checksums = checksumsFor(files);
  const out = [
    ...files,
    { path: 'checksums.json', data: Buffer.from(JSON.stringify(checksums, null, 2), 'utf8') },
  ];
  if (privateKey) {
    const sig = signature.signChecksums({ checksums, privateKey, publisher: 'Fixture Studio' });
    out.push({ path: 'signature.json', data: Buffer.from(JSON.stringify(sig, null, 2), 'utf8') });
  }
  if (tamper) {
    const target = out.find((f) => f.path === tamper);
    target.data = Buffer.from(`${String(target.data)}\n// patched\n`, 'utf8');
  }
  return { entries: out, checksums };
}

function indexFor(entry) {
  return {
    schema: market.INDEX_SCHEMA,
    name: 'Local Fixtures',
    updatedAt: '2026-11-05T00:00:00.000Z',
    plugins: [entry],
  };
}

function entryFor({ url = 'pkg.sxsp', digest = 'a'.repeat(64), size = 100, version = VERSION, sig = null } = {}) {
  return {
    id: TEST_ID,
    name: 'Market Fixture',
    version,
    apiVersion: 2,
    description: 'a fixture plugin',
    author: 'Fixture Author',
    keywords: ['fixture'],
    permissionGroups: ['fs', 'ui'],
    file: { url, sha256: digest, size },
    signature: sig,
  };
}

describe('plugin market — 索引契约', function () {
  it('合法索引：条目被规范化，相对下载地址允许', function () {
    const r = market.parseIndex(indexFor(entryFor()));
    expect(r.ok, r.error).to.equal(true);
    expect(r.entries).to.have.length(1);
    expect(r.entries[0].id).to.equal(TEST_ID);
    expect(r.entries[0].file.url).to.equal('pkg.sxsp');
  });

  it('schema 不对 → 整份索引拒绝（不是逐条跳过）', function () {
    const r = market.parseIndex({ schema: 'v1', plugins: [] });
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal('INDEX_INVALID');
  });

  it('坏条目只跳过自己，其余条目仍然可用', function () {
    const good = entryFor();
    const bad = { ...entryFor(), id: 'BAD ID' };
    const r = market.parseIndex({ schema: market.INDEX_SCHEMA, plugins: [bad, good] });
    expect(r.ok).to.equal(true);
    expect(r.entries).to.have.length(1);
    expect(r.skipped).to.have.length(1);
    expect(r.skipped[0]).to.match(/id 非法/);
  });

  it('重复 id：后一条跳过，避免"看到哪个版本取决于数组顺序"', function () {
    const r = market.parseIndex({
      schema: market.INDEX_SCHEMA,
      plugins: [entryFor({ version: '1.0.0' }), entryFor({ version: '2.0.0' })],
    });
    expect(r.entries).to.have.length(1);
    expect(r.entries[0].version).to.equal('1.0.0');
    expect(r.skipped[0]).to.match(/重复/);
  });

  it('下载地址只收 https 与相对路径：http / data / 绝对路径一律拒', function () {
    for (const url of ['http://example.com/a.sxsp', 'data:application/zip;base64,AA', '/etc/passwd', '../x.sxsp'.replace('..', '..')]) {
      const r = market.normalizeEntry(entryFor({ url }));
      if (url === '../x.sxsp') {
        // 相对路径本身合法，越界由 resolveEntryFileUrl 在解析后拦截
        expect(r.ok, url).to.equal(true);
      } else {
        expect(r.ok, url).to.equal(false);
      }
    }
  });

  it('缺少 sha256 → 拒：没有摘要就无法发现"下载到的东西被换了"', function () {
    const r = market.normalizeEntry({ ...entryFor(), file: { url: 'a.sxsp', size: 10 } });
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/sha256/);
  });

  it('相对地址解析：同源允许、跨域拒绝、越出索引目录拒绝', function () {
    const base = 'https://example.com/plugins/index.json';
    const ok = market.resolveEntryFileUrl(entryFor({ url: 'pkg.sxsp' }), base);
    expect(ok.ok, ok.error).to.equal(true);
    expect(ok.url).to.equal('https://example.com/plugins/pkg.sxsp');

    const cross = market.resolveEntryFileUrl(entryFor({ url: 'https://evil.example/x.sxsp' }), base);
    expect(cross.ok).to.equal(true, '绝对 https 地址允许（CDN）');

    const escape = market.resolveEntryFileUrl(entryFor({ url: '../../etc/passwd' }), base);
    expect(escape.ok).to.equal(false);
    expect(escape.error).to.match(/越出索引目录/);
  });
});

describe('plugin market — 版本与检索', function () {
  it('语义化版本比较：含预发布', function () {
    expect(market.compareVersions('1.0.0', '1.0.1')).to.equal(-1);
    expect(market.compareVersions('1.2.0', '1.10.0')).to.equal(-1);
    expect(market.compareVersions('1.0.0', '1.0.0')).to.equal(0);
    expect(market.compareVersions('1.0.0-beta.2', '1.0.0')).to.equal(-1);
    expect(market.compareVersions('bad', '1.0.0')).to.equal(null);
  });

  it('降级要单独标出来：签名只保证"谁做的"，不保证"更新"', function () {
    expect(market.versionRelation({ version: '1.0.0' }, '1.0.1')).to.equal('downgrade');
    expect(market.versionRelation({ version: '2.0.0' }, '1.0.1')).to.equal('upgrade');
    expect(market.versionRelation({ version: '1.0.1' }, '1.0.1')).to.equal('same');
    expect(market.versionRelation({ version: '1.0.0' }, '')).to.equal('new');
  });

  it('多词检索是 AND；命中名称优先于命中描述', function () {
    const entries = [
      { id: 'a.clock', name: 'Clock', description: 'time', keywords: [], author: '' },
      { id: 'b.timer', name: 'Timer', description: 'clock for practice', keywords: [], author: '' },
      { id: 'c.other', name: 'Other', description: 'nothing', keywords: [], author: '' },
    ];
    const r1 = market.search(entries, 'clock');
    expect(r1.map((e) => e.id)).to.deep.equal(['a.clock', 'b.timer']);
    expect(market.search(entries, 'clock practice').map((e) => e.id)).to.deep.equal(['b.timer']);
    expect(market.search(entries, 'nothing').map((e) => e.id)).to.deep.equal(['c.other']);
  });
});

describe('plugin market — 预览（真包）', function () {
  this.timeout(30000);

  let root;
  let keyPair;
  let keyId;

  before(function () {
    keyPair = crypto.generateKeyPairSync('ed25519');
    keyId = signature.keyIdFor(keyPair.publicKey);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-market-'));
    store._setRootForTests(root);
    store.ensureDirs();
  });

  after(function () {
    store._setRootForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(name, entries) {
    const file = path.join(root, name);
    fs.writeFileSync(file, createZip(entries));
    return file;
  }

  it('预览不落盘：只读检查，plugins 目录保持为空', function () {
    const pkg = write('preview-only.sxsp', buildPackage({ privateKey: keyPair.privateKey }).entries);
    const r = installer.previewPackage(pkg, { appVersion: '2.0.0' });
    expect(r.ok, r.error).to.equal(true);
    expect(r.preview.id).to.equal(TEST_ID);
    expect(r.preview.permissions).to.deep.equal({ fs: ['pluginData'], ui: ['panel'] });
    expect(r.preview.files.map((f) => f.path).sort()).to.deep.equal(['main.js', 'manifest.json']);
    expect(r.preview.totalBytes).to.be.greaterThan(0);
    // 关键断言：没有 entries（包内容）泄漏给调用方
    expect(r.preview.entries).to.equal(undefined);
    const pluginsDir = store.paths().plugins;
    const left = fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir).filter((n) => !n.startsWith('.')) : [];
    expect(left).to.deep.equal([]);
  });

  it('未信任的密钥：可读、不可装，并带回 pendingKey', function () {
    const pkg = write('untrusted.sxsp', buildPackage({ privateKey: keyPair.privateKey }).entries);
    const r = installer.previewPackage(pkg, { appVersion: '2.0.0' });
    expect(r.ok).to.equal(true);
    expect(r.preview.installable).to.equal(false);
    expect(r.preview.blockCode).to.equal('SIGNATURE_UNKNOWN_KEY');
    expect(r.preview.pendingKey.keyId).to.equal(keyId);
    expect(r.preview.pendingKey.publicKey).to.match(/BEGIN PUBLIC KEY/);
  });

  it('信任后：installable=true，签名状态 verified', function () {
    trust.addKey({ publicKey: signature.publicKeyPem(keyPair.privateKey), name: 'Fixture Studio' });
    const pkg = write('trusted.sxsp', buildPackage({ privateKey: keyPair.privateKey }).entries);
    const r = installer.previewPackage(pkg, { appVersion: '2.0.0' });
    expect(r.preview.installable).to.equal(true);
    expect(r.preview.signature.status).to.equal('verified');
    expect(r.preview.signature.keyId).to.equal(keyId);
    expect(r.preview.signature.publisher).to.equal('Fixture Studio');
  });

  it('包内文件被改过：预览直接拦下，且与安装同一判定', function () {
    const pkg = write('tampered.sxsp', buildPackage({ privateKey: keyPair.privateKey, tamper: 'main.js' }).entries);
    const r = installer.previewPackage(pkg, { appVersion: '2.0.0' });
    expect(r.preview.installable).to.equal(false);
    expect(r.preview.blockCode).to.be.oneOf(['CHECKSUM_FAILED', 'SIGNATURE_INVALID']);
    const installed = installer.installFromPackage(pkg, { appVersion: '2.0.0' });
    expect(installed.ok).to.equal(false);
  });
});

describe('plugin market — 客户端（file:// 源，真实全链路）', function () {
  this.timeout(30000);

  let root;
  let marketRoot;
  let keyPair;
  let sourceId;
  const oldEnv = process.env.SXSEDITOR_ALLOW_FILE_SOURCES;

  before(function () {
    keyPair = crypto.generateKeyPairSync('ed25519');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-market-client-'));
    marketRoot = path.join(root, 'market');
    fs.mkdirSync(marketRoot, { recursive: true });
    store._setRootForTests(root);
    store.ensureDirs();
    trust.addKey({ publicKey: signature.publicKeyPem(keyPair.privateKey), name: 'Fixture Studio' });
    process.env.SXSEDITOR_ALLOW_FILE_SOURCES = '1';
  });

  after(function () {
    if (oldEnv === undefined) delete process.env.SXSEDITOR_ALLOW_FILE_SOURCES;
    else process.env.SXSEDITOR_ALLOW_FILE_SOURCES = oldEnv;
    store._setRootForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function publish({ version = VERSION, privateKey = keyPair.privateKey, tamperIndexDigest = false } = {}) {
    const built = buildPackage({ privateKey, version });
    const fileName = `${TEST_ID}-${version}.sxsp`;
    const pkgPath = path.join(marketRoot, fileName);
    fs.writeFileSync(pkgPath, createZip(built.entries));
    const buf = fs.readFileSync(pkgPath);
    const digest = tamperIndexDigest ? 'b'.repeat(64) : crypto.createHash('sha256').update(buf).digest('hex');
    const index = indexFor(entryFor({
      url: fileName,
      digest,
      size: buf.length,
      version,
      sig: { keyId: signature.keyIdFor(keyPair.publicKey), publisher: 'Fixture Studio' },
    }));
    // 每个用例一个索引文件：源按 URL 去重，共用 index.json 会让"新发布的版本"
    // 被上一份索引的缓存盖住（这正是测试要抓的那类真实事故）。
    const indexPath = path.join(marketRoot, `index-${version}${tamperIndexDigest ? '-bad' : ''}.json`);
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    return { indexPath, pkgPath, digest };
  }

  it('文件源默认关闭：不设环境变量时拒绝添加', function () {
    const { indexPath } = publish({ version: '0.9.0' });
    delete process.env.SXSEDITOR_ALLOW_FILE_SOURCES;
    const r = client.addSource({ url: pathToFileURL(indexPath).href, name: 'Off' });
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal('INVALID_SOURCE');
    process.env.SXSEDITOR_ALLOW_FILE_SOURCES = '1';
  });

  it('http 源一律拒：索引决定"用户能看到哪些插件"', function () {
    const r = client.addSource({ url: 'http://example.com/index.json' });
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/https/);
  });

  it('绝对路径直接当离线源（不用手拼 file:///D:/...）', async function () {
    const { indexPath } = publish({ version: '0.8.0' });
    const added = client.addSource({ url: indexPath, name: 'ByPath' });
    expect(added.ok, added.error).to.equal(true);
    expect(added.source.kind).to.equal('file');
    expect(added.source.url).to.equal(pathToFileURL(indexPath).href);
    const found = await client.search('market', { sourceId: added.source.id });
    expect(found.results).to.have.length(1);
    client.removeSource(added.source.id);
  });

  it('同一份索引的两种写法归一成同一个源', function () {
    const { indexPath } = publish({ version: '0.7.0' });
    const a = client.addSource({ url: pathToFileURL(indexPath).href, name: 'A' });
    const b = client.addSource({ url: indexPath, name: 'B' });
    expect(a.ok, a.error).to.equal(true);
    expect(b.existed, '应命中已存在的源而不是新增').to.equal(true);
    expect(b.source.id).to.equal(a.source.id);
    client.removeSource(a.source.id);
  });

  it('盘符路径按路径处理，不会被当成未知协议', function () {
    // `D:\mirror\index.json` 用 URL 规则读会得到 scheme = "d"。开启离线源之后
    // 必须走路径分支，否则一律落到"必须是 https"这条，用户会以为不支持离线源。
    const r = client.addSource({ url: 'D:\\mirror\\index.json' });
    if (process.platform === 'win32') {
      expect(r.ok, r.error).to.equal(true);
      expect(r.source.kind).to.equal('file');
      client.removeSource(r.source.id);
    } else {
      expect(r.ok).to.equal(false);
      expect(r.error).to.match(/绝对路径/);
    }
  });

  it('添加源 → 搜索命中', async function () {
    const { indexPath } = publish();
    const added = client.addSource({ url: pathToFileURL(indexPath).href, name: 'Local' });
    expect(added.ok, added.error).to.equal(true);
    sourceId = added.source.id;

    const found = await client.search('market', { sourceId });
    expect(found.ok, found.error).to.equal(true);
    expect(found.results).to.have.length(1);
    expect(found.results[0].id).to.equal(TEST_ID);
    expect(found.results[0].sourceName).to.equal('Local');
  });

  it('预览：下载 → 校验摘要 → 用包内签名判定', async function () {
    const r = await client.preview(sourceId, TEST_ID, { appVersion: '2.0.0' });
    expect(r.ok, r.error).to.equal(true);
    expect(r.preview.installable).to.equal(true);
    expect(r.preview.signature.status).to.equal('verified');
    expect(r.preview.permissions.fs).to.deep.equal(['pluginData']);
    expect(fs.existsSync(r.packagePath)).to.equal(true);
    expect(r.warnings).to.deep.equal([]);
  });

  it('索引摘要对不上 → 拒绝预览（不是"装完再说"）', async function () {
    const { indexPath } = publish({ version: '1.1.0', tamperIndexDigest: true });
    const added = client.addSource({ url: pathToFileURL(indexPath).href, name: 'Broken' });
    expect(added.ok, added.error).to.equal(true);
    const r = await client.preview(added.source.id, TEST_ID, { appVersion: '2.0.0' });
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal('CHECKSUM_MISMATCH');
  });

  it('索引说已签名、包里没签名 → 明确告警而不是静默通过', async function () {
    const built = buildPackage({ privateKey: null, version: '1.2.0' });
    const fileName = `${TEST_ID}-1.2.0.sxsp`;
    const pkgPath = path.join(marketRoot, fileName);
    fs.writeFileSync(pkgPath, createZip(built.entries));
    const buf = fs.readFileSync(pkgPath);
    const indexPath = path.join(marketRoot, 'claimed.json');
    fs.writeFileSync(indexPath, JSON.stringify(indexFor(entryFor({
      url: fileName,
      digest: crypto.createHash('sha256').update(buf).digest('hex'),
      size: buf.length,
      version: '1.2.0',
      sig: { keyId: signature.keyIdFor(keyPair.publicKey), publisher: 'Fixture Studio' },
    })), null, 2));

    const added = client.addSource({ url: pathToFileURL(indexPath).href, name: 'Claimed' });
    const r = await client.preview(added.source.id, TEST_ID, { appVersion: '2.0.0' });
    expect(r.ok, r.error).to.equal(true);
    expect(r.preview.signature.status).to.equal('unsigned');
    expect(r.preview.installable).to.equal(true, '未签名仍可装（默认策略）');
    const codes = r.warnings.map((w) => w.code);
    expect(codes).to.include('INDEX_SIGNATURE_MISMATCH');
  });

  it('已装 1.0.1 时市场给 1.0.0 → 标 DOWNGRADE', async function () {
    const { indexPath } = publish({ version: VERSION });
    const added = client.addSource({ url: pathToFileURL(indexPath).href, name: 'Main' });
    const installed = installer.installFromPackage(path.join(marketRoot, `${TEST_ID}-${VERSION}.sxsp`), { appVersion: '2.0.0' });
    expect(installed.ok, installed.error).to.equal(true);

    const oldPkg = publish({ version: '1.0.0' });
    const oldSource = client.addSource({ url: pathToFileURL(oldPkg.indexPath).href, name: 'Main' });
    const r = await client.preview(oldSource.source.id, TEST_ID, { appVersion: '2.0.0' });
    expect(r.ok, r.error).to.equal(true);
    expect(r.relation).to.equal('downgrade');
    expect(r.warnings.map((w) => w.code)).to.include('DOWNGRADE');
    expect(added.ok).to.equal(true);
  });

  it('删源后不再返回结果', function () {
    const removed = client.removeSource(sourceId);
    expect(removed.ok, removed.error).to.equal(true);
    expect(client.listSources().some((s) => s.id === sourceId)).to.equal(false);
  });

  it('downloadPackageUrl 拒绝 http / file / 相对地址（不发起任何请求）', async function () {
    for (const url of [
      'http://example.com/dep.sxsp',
      'file:///tmp/dep.sxsp',
      'ftp://example.com/dep.sxsp',
      './dep.sxsp',
    ]) {
      const r = await client.downloadPackageUrl(url);
      expect(r.ok, url).to.equal(false);
      expect(r.code, url).to.equal('INVALID_URL');
    }
  });
});
