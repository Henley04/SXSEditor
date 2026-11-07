const { expect } = require('chai');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const signature = require('../src/shared/pluginSignature.js');
const { createZip } = require('../src/shared/pluginZip.js');
const store = require('../src/main/plugins/PluginStateStore.js');
const trust = require('../src/main/plugins/PluginTrustStore.js');
const installer = require('../src/main/plugins/PluginInstaller.js');

/**
 * M6：签名与完整性。
 *
 * 这里刻意用**真的密钥对**（Ed25519 生成很快），而不是桩：签名这件事，
 * 一旦用假实现测过就等于没测——真正会出问题的是"字节怎么进签名"。
 */

const TEST_ID = 'com.example.signed';

function manifest(overrides = {}) {
  return {
    apiVersion: 2,
    id: TEST_ID,
    name: 'Signed Plugin',
    version: '1.2.3',
    description: 'signature fixture',
    main: 'main.js',
    engines: { app: '>=1.0.0' },
    permissions: {},
    contributes: { commands: [{ id: 'ping', title: 'Ping' }] },
    ...overrides,
  };
}

function baseFiles() {
  return [
    { path: 'manifest.json', data: JSON.stringify(manifest(), null, 2) },
    { path: 'main.js', data: 'module.exports = { commands: { ping: async () => 1 } };' },
  ];
}

function checksumsFor(files) {
  const filesMap = {};
  for (const f of files) filesMap[f.path] = signature.sha256hex(f.data);
  return { algorithm: 'sha256', files: filesMap };
}

function buildPackage({ keys = null, privateKey = null, tamper = null, extraFile = null, dropChecksum = null } = {}) {
  const files = baseFiles();
  const checksums = checksumsFor(files);
  if (dropChecksum) delete checksums.files[dropChecksum];

  const out = [
    ...files,
    { path: 'checksums.json', data: Buffer.from(JSON.stringify(checksums, null, 2), 'utf8') },
  ];
  if (privateKey) {
    const sig = signature.signChecksums({ checksums, privateKey, publisher: keys && keys.publisher });
    out.push({ path: 'signature.json', data: Buffer.from(JSON.stringify(sig, null, 2), 'utf8') });
  }
  if (extraFile) out.push({ path: extraFile, data: 'module.exports = require("./main.js");' });
  if (tamper) {
    const target = out.find((f) => f.path === tamper);
    target.data = Buffer.from(String(target.data) + '\n// patched after signing\n', 'utf8');
  }
  return out;
}

describe('plugin signature — 规范文本与签名', function () {
  this.timeout(20000);

  let keyPair;
  before(function () {
    keyPair = crypto.generateKeyPairSync('ed25519');
  });

  it('清单文本：按路径排序、哈希小写、行尾固定', function () {
    const text = signature.canonicalList({
      'b.js': 'B'.repeat(64).toLowerCase(),
      'a.js': 'A'.repeat(64).toLowerCase(),
    });
    expect(text).to.equal(`sxsp-signature-v1\n${
      'a'.repeat(64)}  a.js\n${'b'.repeat(64)}  b.js\n`);
  });

  it('keyId 由公钥派生，且与私钥一一对应', function () {
    const pem = signature.publicKeyPem(keyPair.privateKey);
    const id = signature.keyIdFor(pem);
    expect(id).to.match(/^ed25519-[0-9a-f]{16}$/);
    expect(signature.keyIdFor(keyPair.publicKey)).to.equal(id);
    // 另一把密钥必须给出不同的 id
    const other = crypto.generateKeyPairSync('ed25519');
    expect(signature.keyIdFor(other.publicKey)).to.not.equal(id);
  });

  it('非 Ed25519 密钥直接拒绝（不是"验不过"，是根本不该签）', function () {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => signature.signChecksums({
      checksums: { files: {} },
      privateKey: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    })).to.throw(/只支持 ed25519/);
  });

  it('签名 → 验签通过，并带出 keyId / publisher / digest', function () {
    const files = baseFiles();
    const checksums = checksumsFor(files);
    const sig = signature.signChecksums({ checksums, privateKey: keyPair.privateKey, publisher: 'Example Studio' });
    const keyId = signature.keyIdFor(keyPair.publicKey);
    expect(sig.keyId).to.equal(keyId);
    expect(sig.publisher).to.equal('Example Studio');
    expect(sig.digest).to.equal(
      signature.sha256hex(Buffer.from(signature.canonicalList(checksums.files), 'utf8')),
    );

    const result = signature.verifyPackage(
      [...files, { path: 'checksums.json', data: Buffer.from(JSON.stringify(checksums)) },
        { path: 'signature.json', data: Buffer.from(JSON.stringify(sig)) }],
      { keys: { [keyId]: { publicKey: signature.publicKeyPem(keyPair.privateKey) } } },
    );
    expect(result.ok, result.message).to.equal(true);
    expect(result.status).to.equal(signature.SIGNATURE_STATUS.VERIFIED);
    expect(result.publisher).to.equal('Example Studio');
  });

  it('改了文件内容 → INVALID（不是"未签名"）', function () {
    const files = baseFiles();
    const checksums = checksumsFor(files);
    const sig = signature.signChecksums({ checksums, privateKey: keyPair.privateKey });
    const keyId = signature.keyIdFor(keyPair.publicKey);
    const tampered = files.map((f) => (f.path === 'main.js'
      ? { path: f.path, data: Buffer.from('module.exports = { pwned: true };') }
      : f));
    const result = signature.verifyPackage(
      [...tampered, { path: 'checksums.json', data: Buffer.from(JSON.stringify(checksums)) },
        { path: 'signature.json', data: Buffer.from(JSON.stringify(sig)) }],
      { keys: { [keyId]: { publicKey: signature.publicKeyPem(keyPair.privateKey) } } },
    );
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal(signature.SIGNATURE_STATUS.INVALID);
    expect(result.message).to.include('不一致');
  });

  it('包里多一个清单没列的文件 → INVALID（这条曾是真漏洞）', function () {
    const files = baseFiles();
    const checksums = checksumsFor(files);
    const sig = signature.signChecksums({ checksums, privateKey: keyPair.privateKey });
    const keyId = signature.keyIdFor(keyPair.publicKey);
    const result = signature.verifyPackage(
      [...files, { path: 'checksums.json', data: Buffer.from(JSON.stringify(checksums)) },
        { path: 'signature.json', data: Buffer.from(JSON.stringify(sig)) },
        // 典型攻击：签名照旧，往包里塞一个会被落盘、但清单里没有的 main.js 覆盖
        { path: 'sneak.js', data: Buffer.from('evil') }],
      { keys: { [keyId]: { publicKey: signature.publicKeyPem(keyPair.privateKey) } } },
    );
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal(signature.SIGNATURE_STATUS.INVALID);
    expect(result.message).to.include('未列入校验清单');
  });

  it('清单少列一个已存在文件 → INVALID（清单本身被裁过）', function () {
    const files = baseFiles();
    const checksums = checksumsFor(files);
    delete checksums.files['main.js'];
    const sig = signature.signChecksums({ checksums, privateKey: keyPair.privateKey });
    const keyId = signature.keyIdFor(keyPair.publicKey);
    const result = signature.verifyPackage(
      [...files, { path: 'checksums.json', data: Buffer.from(JSON.stringify(checksums)) },
        { path: 'signature.json', data: Buffer.from(JSON.stringify(sig)) }],
      { keys: { [keyId]: { publicKey: signature.publicKeyPem(keyPair.privateKey) } } },
    );
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal(signature.SIGNATURE_STATUS.INVALID);
  });

  it('keyId 与公钥不匹配 → INVALID（防止借用已信任的名字）', function () {
    const files = baseFiles();
    const checksums = checksumsFor(files);
    const sig = signature.signChecksums({ checksums, privateKey: keyPair.privateKey });
    const forged = { ...sig, keyId: 'ed25519-0000000000000000' };
    const result = signature.verifyPackage(
      [...files, { path: 'checksums.json', data: Buffer.from(JSON.stringify(checksums)) },
        { path: 'signature.json', data: Buffer.from(JSON.stringify(forged)) }],
      { keys: { 'ed25519-0000000000000000': { publicKey: signature.publicKeyPem(keyPair.privateKey) } } },
    );
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal(signature.SIGNATURE_STATUS.INVALID);
    expect(result.message).to.include('不匹配');
  });

  it('未知密钥 → UNKNOWN_KEY，并带回公钥供用户核对', function () {
    const files = baseFiles();
    const checksums = checksumsFor(files);
    const sig = signature.signChecksums({ checksums, privateKey: keyPair.privateKey, publisher: '某工作室' });
    const result = signature.verifyPackage(
      [...files, { path: 'checksums.json', data: Buffer.from(JSON.stringify(checksums)) },
        { path: 'signature.json', data: Buffer.from(JSON.stringify(sig)) }],
      { keys: {} },
    );
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal(signature.SIGNATURE_STATUS.UNKNOWN_KEY);
    expect(result.pendingKey.keyId).to.equal(signature.keyIdFor(keyPair.publicKey));
    expect(result.pendingKey.publicKey).to.include('BEGIN PUBLIC KEY');
    expect(result.pendingKey.publisher).to.equal('某工作室');
  });

  it('策略：未签名包在 requireSignature 下被拒，关掉则放行', function () {
    const files = baseFiles();
    const entries = [...files, {
      path: 'checksums.json',
      data: Buffer.from(JSON.stringify(checksumsFor(files))),
    }];
    const strict = signature.verifyPackage(entries, { requireSignature: true });
    expect(strict.ok).to.equal(false);
    expect(strict.status).to.equal(signature.SIGNATURE_STATUS.REQUIRED);

    const loose = signature.verifyPackage(entries, { requireSignature: false });
    expect(loose.ok).to.equal(true);
    expect(loose.status).to.equal(signature.SIGNATURE_STATUS.UNSIGNED);
  });

  it('有签名但没清单 → INVALID（签名没有覆盖任何东西）', function () {
    const files = baseFiles();
    const sig = signature.signChecksums({
      checksums: checksumsFor(files),
      privateKey: keyPair.privateKey,
    });
    const result = signature.verifyPackage(
      [...files, { path: 'signature.json', data: Buffer.from(JSON.stringify(sig)) }],
      { keys: {} },
    );
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal(signature.SIGNATURE_STATUS.INVALID);
    expect(result.message).to.include('checksums.json');
  });
});

describe('plugin signature — 安装链路', function () {
  this.timeout(30000);

  let root;
  let keyPair;
  let keyId;

  before(function () {
    keyPair = crypto.generateKeyPairSync('ed25519');
    keyId = signature.keyIdFor(keyPair.publicKey);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxsp-sign-'));
    store._setRootForTests(root);
    store.ensureDirs();
    trust.addKey({
      publicKey: signature.publicKeyPem(keyPair.privateKey),
      name: 'Test Publisher',
    });
  });

  after(function () {
    store._setRootForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writePackage(name, entries) {
    const file = path.join(root, `${name}.sxsp`);
    fs.writeFileSync(file, createZip(entries));
    return file;
  }

  it('信任库：同一把公钥重复添加是更新而不是重复项', function () {
    const pem = signature.publicKeyPem(keyPair.privateKey);
    const again = trust.addKey({ publicKey: pem, name: 'Renamed' });
    expect(again.ok).to.equal(true);
    expect(again.replaced).to.equal(true);
    const view = trust.list();
    expect(view.keys.filter((k) => k.keyId === keyId)).to.have.length(1);
    expect(view.keys.find((k) => k.keyId === keyId).name).to.equal('Renamed');
  });

  it('签名包：装得进去，签名状态落进 registry', function () {
    const pkg = writePackage('signed', buildPackage({ privateKey: keyPair.privateKey, keys: { publisher: 'Test Publisher' } }));
    const result = installer.installFromPackage(pkg, { appVersion: '1.0.0' });
    expect(result.ok, result.error).to.equal(true);
    expect(result.signature).to.equal('verified');

    const state = store.getPluginState(store.readRegistry(), TEST_ID);
    expect(state.signature.status).to.equal('verified');
    expect(state.signature.keyId).to.equal(keyId);
    expect(state.signature.publisher).to.equal('Test Publisher');
  });

  it('重验：安装目录没动 → 一致', function () {
    const result = installer.verifyInstalled(TEST_ID);
    expect(result.ok, result.message).to.equal(true);
    expect(result.status).to.equal('ok');
  });

  it('重验：改一个文件 → 报差异', function () {
    const main = path.join(root, 'plugins', TEST_ID, 'main.js');
    const original = fs.readFileSync(main);
    fs.writeFileSync(main, Buffer.concat([original, Buffer.from('\n// local edit\n')]));
    try {
      const result = installer.verifyInstalled(TEST_ID);
      expect(result.ok).to.equal(false);
      expect(result.status).to.equal('modified');
      expect(result.mismatched).to.include('main.js');
    } finally {
      fs.writeFileSync(main, original);
    }
  });

  it('篡改包：拒绝，且不留半装目录', function () {
    const pkg = writePackage('tampered', buildPackage({
      privateKey: keyPair.privateKey,
      tamper: 'main.js',
    }));
    const before = fs.existsSync(path.join(root, 'plugins', TEST_ID));
    const result = installer.installFromPackage(pkg, { appVersion: '1.0.0' });
    expect(result.ok).to.equal(false);
    // 篡改文件会先被清单哈希抓到（错误更具体）；篡改清单本身才会走到验签失败。
    expect(result.code).to.be.oneOf(['CHECKSUM_FAILED', 'SIGNATURE_INVALID']);
    expect(fs.existsSync(path.join(root, 'plugins', TEST_ID))).to.equal(before);
  });

  it('未知密钥：拒绝并给出 pendingKey，同时写下 install-rejected 审计', function () {
    const other = crypto.generateKeyPairSync('ed25519');
    const pkg = writePackage('unknown-key', buildPackage({
      privateKey: other.privateKey,
      keys: { publisher: 'Nobody' },
    }));
    const result = installer.installFromPackage(pkg, { appVersion: '1.0.0' });
    expect(result.ok).to.equal(false);
    expect(result.code).to.equal('SIGNATURE_UNKNOWN_KEY');
    expect(result.pendingKey.publicKey).to.include('BEGIN PUBLIC KEY');
    expect(result.packagePath).to.equal(pkg);

    const audit = store.readAudit(50).filter((e) => e.event === 'install-rejected');
    expect(audit.length).to.be.greaterThan(0);
    expect(audit[audit.length - 1].detail.signature).to.equal('unknown-key');
  });

  it('策略开启后：未签名包被拒，签名包仍可装', function () {
    trust.setRequireSignature(true);
    try {
      const unsigned = writePackage('unsigned', buildPackage());
      const denied = installer.installFromPackage(unsigned, { appVersion: '1.0.0' });
      expect(denied.ok).to.equal(false);
      expect(denied.code).to.equal('SIGNATURE_REQUIRED');

      const signed = writePackage('signed-2', buildPackage({ privateKey: keyPair.privateKey }));
      const ok = installer.installFromPackage(signed, { appVersion: '1.0.0' });
      expect(ok.ok, ok.error).to.equal(true);
    } finally {
      trust.setRequireSignature(false);
    }
  });

  it('未签名包（策略关闭）：装机成功但状态是 unsigned', function () {
    const pkg = writePackage('unsigned-2', buildPackage());
    const result = installer.installFromPackage(pkg, { appVersion: '1.0.0' });
    expect(result.ok, result.error).to.equal(true);
    const state = store.getPluginState(store.readRegistry(), TEST_ID);
    expect(state.signature.status).to.equal('unsigned');
  });

  it('未列入清单的文件：连未签名包也拒绝（清单存在就必须说全）', function () {
    const pkg = writePackage('extra', buildPackage({ extraFile: 'sneak.js' }));
    const result = installer.installFromPackage(pkg, { appVersion: '1.0.0' });
    expect(result.ok).to.equal(false);
    expect(result.error).to.include('未列入校验清单');
  });
});

describe('plugin signature — 内置官方密钥默认受信任', function () {
  this.timeout(20000);

  const official = require('../src/shared/officialKeys.js');

  it('内置公钥能被解析，且 keyId 稳定', function () {
    const keys = official.officialKeys();
    expect(keys).to.have.length.greaterThan(0);
    for (const key of keys) {
      expect(key.keyId).to.match(/^ed25519-[0-9a-f]{16}$/);
      expect(key.publicKey).to.include('BEGIN PUBLIC KEY');
      expect(key.official).to.equal(true);
    }
  });

  it('信任库视图：官方密钥在列且标记官方，不落盘', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxsp-official-'));
    store._setRootForTests(root);
    try {
      store.ensureDirs();
      const view = trust.list();
      const officialIds = official.officialKeys().map((k) => k.keyId);
      for (const id of officialIds) {
        const entry = view.keys.find((k) => k.keyId === id);
        expect(entry, id).to.be.ok;
        expect(entry.official).to.equal(true);
        expect(entry.source).to.equal('builtin');
      }
      // 只是在视图里出现，不代表写进了用户信任库
      const state = trust.read();
      for (const id of officialIds) expect(state.keys[id]).to.equal(undefined);
      // 不可移除
      expect(trust.removeKey(officialIds[0]).ok).to.equal(false);
    } finally {
      store._setRootForTests(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keyMap 含官方指纹 → 官方签名的包无需用户确认', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxsp-official-map-'));
    store._setRootForTests(root);
    try {
      store.ensureDirs();
      const map = trust.keyMap();
      for (const key of official.officialKeys()) {
        expect(map[key.keyId]).to.be.ok;
        expect(map[key.keyId].official).to.equal(true);
      }
    } finally {
      store._setRootForTests(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('冒充官方：改 keyId 或换公钥都会被拒，内置公钥不等于信任任意包', function () {
    const attacker = crypto.generateKeyPairSync('ed25519');
    const officialId = official.officialKeys()[0].keyId;
    const files = baseFiles();
    const checksums = checksumsFor(files);
    const sig = signature.signChecksums({ checksums, privateKey: attacker.privateKey, publisher: official.OFFICIAL_PUBLISHER });

    // (1) 只把 keyId 改成官方指纹 —— 与包里公钥不匹配
    const forgedId = { ...sig, keyId: officialId };
    const r1 = signature.verifyPackage(
      [...files, { path: 'checksums.json', data: Buffer.from(JSON.stringify(checksums)) },
        { path: 'signature.json', data: Buffer.from(JSON.stringify(forgedId)) }],
      { keys: trust.keyMap() },
    );
    expect(r1.ok).to.equal(false);
    expect(r1.status).to.equal(signature.SIGNATURE_STATUS.INVALID);

    // (2) 同时把公钥换成官方公钥 —— 签名是攻击者私钥做的，验不过
    const forgedAll = { ...sig, keyId: officialId, publicKey: official.officialKeys()[0].publicKey };
    const r2 = signature.verifyPackage(
      [...files, { path: 'checksums.json', data: Buffer.from(JSON.stringify(checksums)) },
        { path: 'signature.json', data: Buffer.from(JSON.stringify(forgedAll)) }],
      { keys: trust.keyMap() },
    );
    expect(r2.ok).to.equal(false);
    expect(r2.status).to.equal(signature.SIGNATURE_STATUS.INVALID);
  });
});
