const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PluginDataPlane,
  FILE_ERR,
  MAX_WRITE_BYTES,
} = require('../src/main/plugins/PluginDataPlane.js');
const { authorizePath } = require('../src/main/security.js');

/**
 * 数据面 —— 保存链路（M4 第 2 段）。
 *
 * 这一层的职责边界很容易搞错，所以断言都围绕"谁负责什么"：
 *   · 扩展名归属：只有声明了 role=save/both 的插件能被选中；
 *   · 文档合法性：交给插件**之前**校验，脏数据不能经插件之手写进用户文件；
 *   · 字节形态：插件可以回 Uint8Array / ArrayBuffer / string / number[]，
 *     但回了别的东西（或回了 UTF-16 乱码般的数字数组）必须拒绝，不能"写进去了但文件是废的"；
 *   · 写盘时机：任何一步失败都不能碰原文件。
 */

const DOC = {
  project: { bpm: 96, timeSignature: [4, 4] },
  singers: [{ id: 's1', singerName: 'Lead' }],
  fragments: [{ id: 'f1', singerId: 's1', duration: 2, notes: [{ pitch: 60, start: 0, duration: 1, lyric: 'la' }] }],
};

function makeRegistry(entries, plugins) {
  return {
    list: (type) => (type === 'fileType' ? entries : []),
    getPlugin: (id) => plugins[id] || null,
  };
}

function makePlugin(id, permissions) {
  return {
    id,
    status: 'loaded',
    manifest: {
      name: `Plugin ${id}`,
      permissions: permissions || { fs: ['pluginData', 'userPicked:read', 'userPicked:write'] },
    },
  };
}

const bothEntry = { ext: '.sv2', role: 'both', pluginId: 'p1', filters: [], label: { en: 'SV2' } };

describe('PluginDataPlane — 保存到插件格式', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-save-'));
    file = path.join(dir, 'out.sv2');
    authorizePath(file);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makePlane(options = {}) {
    const calls = [];
    const plane = new PluginDataPlane({
      registry: makeRegistry(options.entries || [bothEntry], options.plugins || { p1: makePlugin('p1') }),
      call: options.call || (async (pluginId, method, params) => {
        calls.push({ pluginId, method, params });
        return { bytes: '{"format":"sv2"}' };
      }),
      logger: { warn() {}, info() {} },
      locale: () => 'zh-CN',
    });
    return { plane, calls };
  }

  it('只声明 open 的插件不能写', async () => {
    const { plane } = makePlane({ entries: [{ ...bothEntry, role: 'open' }] });
    const r = await plane.saveDocument(file, DOC);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal(FILE_ERR.NOT_HANDLED);
    expect(fs.existsSync(file)).to.equal(false);
  });

  it('没有接管任何扩展名 → FILE_NOT_HANDLED', async () => {
    const { plane } = makePlane({ entries: [] });
    const r = await plane.saveDocument(file, DOC);
    expect(r.code).to.equal(FILE_ERR.NOT_HANDLED);
  });

  it('缺少 userPicked:write → PERMISSION_DENIED', async () => {
    const { plane, calls } = makePlane({
      plugins: { p1: makePlugin('p1', { fs: ['userPicked:read'] }) },
    });
    const r = await plane.saveDocument(file, DOC);
    expect(r.code).to.equal('PERMISSION_DENIED');
    expect(calls).to.have.length(0);
    expect(fs.existsSync(file)).to.equal(false);
  });

  it('路径未授权 → PERMISSION_DENIED，且不调用插件', async () => {
    const { plane, calls } = makePlane();
    const stranger = path.join(os.tmpdir(), `nope-${Date.now()}.sv2`);
    const r = await plane.saveDocument(stranger, DOC);
    expect(r.code).to.equal('PERMISSION_DENIED');
    expect(calls).to.have.length(0);
  });

  it('文档非法 → 拒绝且不碰原文件', async () => {
    const { plane, calls } = makePlane();
    fs.writeFileSync(file, 'ORIGINAL');
    const r = await plane.saveDocument(file, 42);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal(FILE_ERR.INVALID_DOCUMENT);
    expect(calls).to.have.length(0);
    expect(fs.readFileSync(file, 'utf8')).to.equal('ORIGINAL');
  });

  it('Uint8Array 原样写盘，原文件转为 .bak', async () => {
    const payload = Buffer.from('{"format":"sv2","bpm":96}', 'utf8');
    const { plane } = makePlane({ call: async () => ({ bytes: new Uint8Array(payload) }) });
    fs.writeFileSync(file, 'ORIGINAL');
    const r = await plane.saveDocument(file, DOC);
    expect(r.ok).to.equal(true);
    expect(r.bytes).to.equal(payload.length);
    expect(fs.readFileSync(file)).to.deep.equal(payload);
    expect(fs.readFileSync(`${file}.bak`, 'utf8')).to.equal('ORIGINAL');
  });

  it('字符串按 UTF-8 编码（中文不能变成乱码）', async () => {
    const { plane } = makePlane({ call: async () => ({ bytes: '{"name":"测试"}' }) });
    const r = await plane.saveDocument(file, DOC);
    expect(r.ok).to.equal(true);
    expect(fs.readFileSync(file, 'utf8')).to.equal('{"name":"测试"}');
  });

  it('ArrayBuffer 与 number[] 都能收敛成字节', async () => {
    const text = 'abc';
    const buf = new TextEncoder().encode(text);
    const { plane: p1 } = makePlane({ call: async () => ({ bytes: buf.buffer }) });
    expect((await p1.saveDocument(file, DOC)).ok).to.equal(true);
    expect(fs.readFileSync(file, 'utf8')).to.equal(text);

    const { plane: p2 } = makePlane({ call: async () => ({ bytes: Array.from(buf) }) });
    expect((await p2.saveDocument(file, DOC)).ok).to.equal(true);
    expect(fs.readFileSync(file, 'utf8')).to.equal(text);
  });

  it('数字数组里出现非字节值 → 拒绝，不写盘', async () => {
    const { plane } = makePlane({ call: async () => ({ bytes: [0x41, 1000, 0x43] }) });
    const r = await plane.saveDocument(file, DOC);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal(FILE_ERR.INVALID_OUTPUT);
    expect(fs.existsSync(file)).to.equal(false);
  });

  it('插件返回不可识别的东西 → INVALID_OUTPUT', async () => {
    for (const bad of [null, undefined, 42, { data: [1, 2] }]) {
      const { plane } = makePlane({ call: async () => ({ bytes: bad }) });
      const r = await plane.saveDocument(file, DOC);
      expect(r.code).to.equal(FILE_ERR.INVALID_OUTPUT);
    }
  });

  it('插件抛错 → 错误码透传，文件不动', async () => {
    const { plane } = makePlane({
      call: async () => { throw Object.assign(new Error('boom'), { code: 'INVALID_REQUEST' }); },
    });
    fs.writeFileSync(file, 'ORIGINAL');
    const r = await plane.saveDocument(file, DOC);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal('INVALID_REQUEST');
    expect(fs.readFileSync(file, 'utf8')).to.equal('ORIGINAL');
  });

  it('插件取消 → CANCELLED', async () => {
    const { plane } = makePlane({ call: async () => ({ cancelled: true }) });
    const r = await plane.saveDocument(file, DOC);
    expect(r.code).to.equal(FILE_ERR.CANCELLED);
  });

  it('warnings 原样上传（"没写进去什么"必须让用户看见）', async () => {
    const { plane } = makePlane({
      call: async () => ({ bytes: 'x', warnings: ['2 个音符的音素微调未写入', 42, ''] }),
    });
    const r = await plane.saveDocument(file, DOC);
    expect(r.warnings).to.deep.equal(['2 个音符的音素微调未写入']);
  });

  it('传给插件的文档是校验过的克隆，且带 ext', async () => {
    const seen = [];
    const { plane } = makePlane({
      call: async (_pluginId, _method, params) => { seen.push(params); return { bytes: 'x' }; },
    });
    const withExt = {
      ...DOC,
      ext: { 'a.b': { meta: { title: 'hello' } } },
      extSchema: { 'a.b': { note: { phonemes: { kind: 'phonemes' } } } },
    };
    await plane.saveDocument(file, withExt);
    const sent = seen[0].document;
    expect(sent.ext['a.b'].meta.title).to.equal('hello');
    expect(sent.extSchema['a.b'].note.phonemes.kind).to.equal('phonemes');
    // 与入参不共享引用
    expect(sent).to.not.equal(withExt);
    expect(sent.fragments[0]).to.not.equal(withExt.fragments[0]);
  });

  it('超出写出上限 → TOO_LARGE，不写盘', async () => {
    const { plane } = makePlane({
      call: async () => ({ bytes: new Uint8Array(MAX_WRITE_BYTES + 1) }),
    });
    fs.writeFileSync(file, 'ORIGINAL');
    const r = await plane.saveDocument(file, DOC);
    expect(r.code).to.equal(FILE_ERR.TOO_LARGE);
    expect(fs.readFileSync(file, 'utf8')).to.equal('ORIGINAL');
  });
});
