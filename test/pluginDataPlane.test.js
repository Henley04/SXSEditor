const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PluginDataPlane, FILE_ERR, MAX_OPEN_BYTES } = require('../src/main/plugins/PluginDataPlane.js');
const { authorizePath } = require('../src/main/security.js');

/**
 * 数据面路由与失败分支。
 *
 * 这里不启动真进程：`call` 是注入的，测的是"宿主这一侧"的判断 ——
 * 谁接管这个扩展名、有没有读权限、路径在不在白名单、文件多大、插件回的东西
 * 能不能进 state。插件进程那一侧的行为由实机走查覆盖。
 */

const DOC = {
  project: { bpm: 96, timeSignature: [4, 4] },
  singers: [{ id: 's1', singerName: 'Lead' }],
  fragments: [{ id: 'f1', singerId: 's1', duration: 2, notes: [{ pitch: 60, start: 0, duration: 1 }] }],
};

function makeRegistry(entries, plugins) {
  return {
    list: (type) => (type === 'fileType' ? entries : []),
    getPlugin: (id) => plugins[id] || null,
  };
}

function makePlugin(id, overrides = {}) {
  return {
    id,
    status: 'loaded',
    manifest: {
      name: `Plugin ${id}`,
      permissions: { fs: ['pluginData', 'userPicked:read'], project: ['read'], ...(overrides.permissions || {}) },
    },
    ...overrides,
  };
}

describe('PluginDataPlane — 打开插件格式', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-dataplane-'));
    file = path.join(dir, 'song.sv2');
    fs.writeFileSync(file, JSON.stringify({ format: 'sv2', bpm: 96 }));
    authorizePath(file);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const entry = { ext: '.sv2', role: 'open', pluginId: 'p1', filters: [], label: { en: 'SV2' } };

  function makePlane({ entries = [entry], plugins = { p1: makePlugin('p1') }, call } = {}) {
    const calls = [];
    const plane = new PluginDataPlane({
      registry: makeRegistry(entries, plugins),
      call: call || (async (pluginId, method, params) => {
        calls.push({ pluginId, method, params });
        return { document: DOC };
      }),
      logger: { warn() {}, info() {} },
      locale: () => 'zh-CN',
    });
    return { plane, calls };
  }

  it('没有插件接管 → FILE_NOT_HANDLED', async () => {
    const { plane } = makePlane({ entries: [] });
    const r = await plane.openDocument(file);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal(FILE_ERR.NOT_HANDLED);
  });

  it('接管插件被停用 → 当作没人接管', async () => {
    const { plane, calls } = makePlane({
      plugins: { p1: makePlugin('p1', { status: 'disabled' }) },
    });
    const r = await plane.openDocument(file);
    expect(r.code).to.equal(FILE_ERR.NOT_HANDLED);
    expect(calls).to.have.lengthOf(0);
  });

  it('缺少 fs:userPicked:read → PERMISSION_DENIED，且不读盘', async () => {
    const { plane, calls } = makePlane({
      plugins: { p1: makePlugin('p1', { permissions: { fs: ['pluginData'] } }) },
    });
    const r = await plane.openDocument(file);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal('PERMISSION_DENIED');
    expect(calls).to.have.lengthOf(0);
  });

  it('文件不存在 → FILE_NOT_FOUND', async () => {
    const { plane } = makePlane();
    const r = await plane.openDocument(path.join(dir, 'nope.sv2'));
    expect(r.code).to.equal(FILE_ERR.NOT_FOUND);
  });

  it('超过大小上限 → FILE_TOO_LARGE（用稀疏文件，不真写 64MB）', async () => {
    const big = path.join(dir, 'big.sv2');
    const fd = fs.openSync(big, 'w');
    fs.ftruncateSync(fd, MAX_OPEN_BYTES + 1);
    fs.closeSync(fd);
    authorizePath(big);
    const { plane } = makePlane();
    const r = await plane.openDocument(big);
    expect(r.code).to.equal(FILE_ERR.TOO_LARGE);
  });

  it('路径未授权 → PERMISSION_DENIED（路由不构成读盘授权）', async () => {
    const { plane } = makePlane();
    const other = path.join(os.tmpdir(), `sxs-unauthed-${Date.now()}.sv2`);
    fs.writeFileSync(other, '{}');
    try {
      const r = await plane.openDocument(other);
      expect(r.code).to.equal('PERMISSION_DENIED');
    } finally {
      fs.rmSync(other, { force: true });
    }
  });

  it('正常路径：字节原样送给插件，文档经校验后返回', async () => {
    const { plane, calls } = makePlane();
    const r = await plane.openDocument(file);
    expect(r.ok).to.equal(true);
    expect(r.pluginId).to.equal('p1');
    expect(r.document.fragments).to.have.lengthOf(1);
    expect(calls).to.have.lengthOf(1);
    expect(calls[0].method).to.equal('codec.read');
    expect(calls[0].params.ext).to.equal('.sv2');
    expect(Buffer.from(calls[0].params.bytes).toString('utf8')).to.equal(fs.readFileSync(file, 'utf8'));
  });

  it('声明 companionExts 时，同目录白名单素材随 codec.read 一起传入', async () => {
    const wav = path.join(dir, 'backing.wav');
    fs.writeFileSync(wav, Buffer.from('RIFFfake'));
    const withCompanion = { ...entry, companionExts: ['.wav'] };
    const { plane, calls } = makePlane({ entries: [withCompanion] });
    const r = await plane.openDocument(file);
    expect(r.ok).to.equal(true);
    expect(calls[0].params.files).to.have.lengthOf(1);
    expect(calls[0].params.files[0].name).to.equal('backing.wav');
    expect(Buffer.from(calls[0].params.files[0].bytes).toString('latin1')).to.equal('RIFFfake');
  });

  it('未声明 companionExts 时不扫描目录（普通工程不该被翻目录）', async () => {
    fs.writeFileSync(path.join(dir, 'backing.wav'), Buffer.from('RIFFfake'));
    const { plane, calls } = makePlane();
    const r = await plane.openDocument(file);
    expect(r.ok).to.equal(true);
    expect(calls[0].params.files).to.deep.equal([]);
  });

  it('伴生文件只收白名单扩展名、纯文件名，跳过隐藏文件与子目录', async () => {
    fs.writeFileSync(path.join(dir, 'backing.wav'), Buffer.from('a'));
    fs.writeFileSync(path.join(dir, 'cover.png'), Buffer.from('b'));
    fs.writeFileSync(path.join(dir, '.hidden.wav'), Buffer.from('c'));
    fs.mkdirSync(path.join(dir, 'sub.wav'));
    const withCompanion = { ...entry, companionExts: ['.wav'] };
    const { plane, calls } = makePlane({ entries: [withCompanion] });
    await plane.openDocument(file);
    expect(calls[0].params.files.map((f) => f.name)).to.deep.equal(['backing.wav']);
  });

  it('插件抛错 → 错误码透传，不变成 500', async () => {
    const { plane } = makePlane({
      call: async () => { throw Object.assign(new Error('不是 SV2'), { code: 'INVALID_REQUEST' }); },
    });
    const r = await plane.openDocument(file);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal('INVALID_REQUEST');
    expect(r.message).to.match(/不是 SV2/);
  });

  it('插件返回非法文档 → INVALID_DOCUMENT', async () => {
    const { plane } = makePlane({ call: async () => ({ document: 'not-an-object' }) });
    const r = await plane.openDocument(file);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal(FILE_ERR.INVALID_DOCUMENT);
  });

  it('插件取消 → FILE_CANCELLED', async () => {
    const { plane } = makePlane({ call: async () => ({ cancelled: true }) });
    const r = await plane.openDocument(file);
    expect(r.code).to.equal(FILE_ERR.CANCELLED);
  });

  it('同扩展名两个插件：先注册者胜，另一个记进 shadowed', () => {
    const entries = [
      { ext: '.sv2', role: 'open', pluginId: 'p1', filters: [], label: null },
      { ext: '.sv2', role: 'open', pluginId: 'p2', filters: [], label: null },
    ];
    const { plane } = makePlane({
      entries,
      plugins: { p1: makePlugin('p1'), p2: makePlugin('p2') },
    });
    expect(plane.resolve('.sv2').pluginId).to.equal('p1');
    const list = plane.listFileTypes();
    expect(list).to.have.lengthOf(1);
    expect(list[0].shadowed.map((s) => s.pluginId)).to.deep.equal(['p2']);
  });

  it('首个插件停用后，第二个接管', async () => {
    const entries = [
      { ext: '.sv2', role: 'open', pluginId: 'p1', filters: [], label: null },
      { ext: '.sv2', role: 'open', pluginId: 'p2', filters: [], label: null },
    ];
    const { plane } = makePlane({
      entries,
      plugins: { p1: makePlugin('p1', { status: 'disabled' }), p2: makePlugin('p2') },
    });
    expect(plane.resolve('.sv2').pluginId).to.equal('p2');
  });

  it('fileFilters 按角色过滤，并把 label 交给本地化取值', () => {
    const entries = [
      { ext: '.sv2', role: 'open', pluginId: 'p1', filters: [], label: { en: 'SV2', 'zh-CN': 'SV2 工程' } },
      { ext: '.svo', role: 'save', pluginId: 'p1', filters: [], label: null },
    ];
    const { plane } = makePlane({ entries });
    const open = plane.fileFilters('open', (label) => (label && label['zh-CN']) || '');
    expect(open).to.deep.equal([{ name: 'SV2 工程', extensions: ['sv2'] }]);
    const save = plane.fileFilters('save', (label, fallback) => (label && label.en) || fallback);
    expect(save).to.deep.equal([{ name: 'SVO (Plugin p1)', extensions: ['svo'] }]);
  });
});
