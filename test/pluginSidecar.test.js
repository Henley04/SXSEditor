const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PluginDataPlane, MAX_SIDECAR_FILES } = require('../src/main/plugins/PluginDataPlane.js');
const { authorizePath } = require('../src/main/security.js');

/**
 * 旁挂文件（`codec.write` 返回的 `files`）。
 *
 * 这一层唯一的职责是"**别让插件把字节放到用户没选的位置**"。所以断言几乎都在
 * 拒绝路径上：`../`、子目录、绝对路径、与主文件同名、点开头（隐藏文件）、超大。
 *
 * 另一条同样重要：旁挂失败**不能**让主文件看起来保存失败。主文件是用户按 Ctrl+S
 * 的直接目标，旁挂是附加品；把附加品的失败升级成"保存失败"，用户会以为编辑丢了。
 */

const DOC = {
  project: { bpm: 96, timeSignature: [4, 4] },
  singers: [{ id: 's1', singerName: 'Lead' }],
  fragments: [{ id: 'f1', singerId: 's1', duration: 2, notes: [{ pitch: 60, start: 0, duration: 1, lyric: 'la' }] }],
};

function makePlugin() {
  return {
    id: 'p1',
    status: 'loaded',
    manifest: { name: 'P1', permissions: { fs: ['userPicked:write'] } },
  };
}

describe('PluginDataPlane — 旁挂文件', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-sidecar-'));
    file = path.join(dir, 'song.sv2');
    authorizePath(file);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function planeWith(files) {
    return new PluginDataPlane({
      registry: {
        list: (type) => (type === 'fileType'
          ? [{ ext: '.sv2', role: 'both', pluginId: 'p1', filters: [], label: { en: 'SV2' } }]
          : []),
        getPlugin: () => makePlugin(),
      },
      call: async () => ({ bytes: '{"format":"sv2"}', files }),
    });
  }

  it('主文件 + 旁挂都写出来', async () => {
    const plane = planeWith([
      { name: 'cover.png', bytes: new Uint8Array([1, 2, 3]) },
      { name: 'notes.txt', bytes: 'hello' },
    ]);
    const res = await plane.saveDocument(file, DOC);
    expect(res.ok).to.equal(true);
    expect(res.files).to.equal(2);
    expect(res.warnings).to.deep.equal([]);
    expect(fs.readFileSync(path.join(dir, 'cover.png'))).to.deep.equal(Buffer.from([1, 2, 3]));
    expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')).to.equal('hello');
  });

  it('`../` 穿越被拒，主文件照常写出', async () => {
    const plane = planeWith([{ name: '../evil.txt', bytes: 'x' }]);
    const res = await plane.saveDocument(file, DOC);
    expect(res.ok).to.equal(true);
    expect(res.files).to.equal(0);
    expect(res.warnings.join()).to.match(/不合法|Invalid/);
    expect(fs.existsSync(path.join(dir, '..', 'evil.txt'))).to.equal(false);
  });

  it('带分隔符的名字被拒（子目录不在授权范围里）', async () => {
    for (const name of ['sub/a.png', 'sub\\a.png', '/etc/passwd', 'C:\\x.txt']) {
      const plane = planeWith([{ name, bytes: 'x' }]);
      const res = await plane.saveDocument(file, DOC);
      expect(res.files, name).to.equal(0);
      expect(res.warnings.length, name).to.be.greaterThan(0);
    }
  });

  it('与主文件同名被拒 —— 否则后写的会覆盖先写的', async () => {
    const plane = planeWith([{ name: 'song.sv2', bytes: 'oops' }]);
    const res = await plane.saveDocument(file, DOC);
    expect(res.files).to.equal(0);
    expect(fs.readFileSync(file, 'utf8')).to.equal('{"format":"sv2"}');
    expect(res.warnings.join()).to.match(/重复|collides/);
  });

  it('同一次返回里重名：第二个被拒', async () => {
    const plane = planeWith([
      { name: 'a.png', bytes: '1' },
      { name: 'A.PNG', bytes: '2' },
    ]);
    const res = await plane.saveDocument(file, DOC);
    expect(res.files).to.equal(1);
    expect(res.warnings.join()).to.match(/重复|collides/);
  });

  it('点开头的隐藏文件被拒', async () => {
    const plane = planeWith([{ name: '.DS_Store', bytes: 'x' }]);
    const res = await plane.saveDocument(file, DOC);
    expect(res.files).to.equal(0);
  });

  it('没有可写字节 / 名字为空 → 跳过并告警', async () => {
    const plane = planeWith([
      { name: '', bytes: 'x' },
      { name: 'ok.txt', bytes: { nope: true } },
    ]);
    const res = await plane.saveDocument(file, DOC);
    expect(res.files).to.equal(0);
    expect(res.warnings.length).to.equal(2);
  });

  it('数量超过上限时截断，已写的保留', async () => {
    const many = [];
    for (let i = 0; i < MAX_SIDECAR_FILES + 3; i++) many.push({ name: `f${i}.bin`, bytes: 'x' });
    const plane = planeWith(many);
    const res = await plane.saveDocument(file, DOC);
    expect(res.ok).to.equal(true);
    expect(res.files).to.equal(MAX_SIDECAR_FILES);
    expect(res.warnings.join()).to.match(/超过|More than/);
    expect(fs.existsSync(path.join(dir, `f${MAX_SIDECAR_FILES - 1}.bin`))).to.equal(true);
    expect(fs.existsSync(path.join(dir, `f${MAX_SIDECAR_FILES}.bin`))).to.equal(false);
  });

  it('没有 files 字段时行为不变（老插件不受影响）', async () => {
    const plane = planeWith(undefined);
    const res = await plane.saveDocument(file, DOC);
    expect(res.ok).to.equal(true);
    expect(res.files).to.equal(0);
    expect(res.warnings).to.deep.equal([]);
  });
});
