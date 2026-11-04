const { expect } = require('chai');

const { validateProjectDocument, PROJECT_DOC_LIMITS } = require('../src/shared/projectFormat.js');

/**
 * 插件产出的工程文档校验。
 *
 * 这层的定位是"安全边界 + 宽容归一化"：manifest 校验是非法即拒（作者能改），
 * 这里是坏项丢弃、能开多少开多少（用户手上的文件改不了）。所以断言的重点是
 * "坏数据不会以危险形态进入宿主"，而不是"每个错误都变成拒绝"。
 */
describe('projectFormat — validateProjectDocument', () => {
  it('拒绝非对象', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      const r = validateProjectDocument(bad);
      expect(r.ok).to.equal(false);
      expect(r.error).to.be.a('string');
    }
  });

  it('空对象也能得到一份可用的最小文档', () => {
    const r = validateProjectDocument({});
    expect(r.ok).to.equal(true);
    expect(r.document.project).to.deep.equal({ bpm: 120, timeSignature: [4, 4] });
    expect(r.document.singers).to.deep.equal([]);
    expect(r.document.fragments).to.deep.equal([]);
    expect(r.document.version).to.match(/^\d+\.\d+\.\d+$/);
  });

  it('BPM 越界回落到 120 并留 warning', () => {
    const r = validateProjectDocument({ project: { bpm: 5000 } });
    expect(r.document.project.bpm).to.equal(120);
    expect(r.warnings.join()).to.match(/BPM/);
  });

  it('拍号非法回落到 4/4', () => {
    const r = validateProjectDocument({ project: { timeSignature: [3, 5] } });
    expect(r.document.project.timeSignature).to.deep.equal([4, 4]);
    const r2 = validateProjectDocument({ project: { timeSignature: '4/4' } });
    expect(r2.document.project.timeSignature).to.deep.equal([4, 4]);
  });

  it('返回的是克隆：改动结果不影响输入', () => {
    const input = {
      singers: [{ id: 's1', singerName: 'A' }],
      fragments: [{ id: 'f1', singerId: 's1', name: 'seg', notes: [{ pitch: 60 }] }],
    };
    const r = validateProjectDocument(input);
    expect(r.ok).to.equal(true);
    r.document.singers[0].singerName = '改了';
    r.document.fragments[0].notes[0].pitch = 1;
    expect(input.singers[0].singerName).to.equal('A');
    expect(input.fragments[0].notes[0].pitch).to.equal(60);
  });

  it('丢弃原型污染键', () => {
    const payload = JSON.parse('{"fragments":[{"id":"f1","__proto__":{"polluted":true}}]}');
    const r = validateProjectDocument(payload);
    expect(r.ok).to.equal(true);
    // 注意不能断言 `not.have.property('__proto__')`：每个对象都能通过原型链读到它，
    // 这里要看的是"有没有被写成自有键"。
    expect(Object.prototype.hasOwnProperty.call(r.document.fragments[0], '__proto__')).to.equal(false);
    expect({}.polluted).to.equal(undefined);
    expect(r.warnings.join()).to.match(/__proto__/);
  });

  it('丢弃非 JSON 值（NaN / 函数 / TypedArray）', () => {
    const r = validateProjectDocument({
      singers: [{ id: 's1', gain: NaN, cb: () => 1, buf: new Float32Array(4), ok: 1 }],
    });
    expect(r.ok).to.equal(true);
    const s = r.document.singers[0];
    expect(s).to.not.have.property('gain');
    expect(s).to.not.have.property('cb');
    expect(s).to.not.have.property('buf');
    expect(s.ok).to.equal(1);
  });

  it('分片缺 id 时补一个稳定 id，duration 非法时按 4 拍', () => {
    const r = validateProjectDocument({
      fragments: [{ singerId: 's1', duration: -2 }, { singerId: 's1' }],
    });
    expect(r.document.fragments.map((f) => f.id)).to.deep.equal(['plugin-fragment-1', 'plugin-fragment-2']);
    for (const f of r.document.fragments) expect(f.duration).to.equal(4);
  });

  it('startTime 负数归零、notes 非数组归空', () => {
    const r = validateProjectDocument({ fragments: [{ singerId: 's1', startTime: -8, notes: 'nope' }] });
    const f = r.document.fragments[0];
    expect(f.startTime).to.equal(0);
    expect(f.notes).to.deep.equal([]);
  });

  it('孤儿 singerId 保留（看得见比静默丢弃好）', () => {
    const r = validateProjectDocument({
      singers: [{ id: 's1' }],
      fragments: [{ id: 'f1', singerId: 'missing' }],
    });
    expect(r.ok).to.equal(true);
    expect(r.document.fragments[0].singerId).to.equal('missing');
    expect(r.warnings.join()).to.match(/不存在的轨道/);
  });

  it('数量超上限时截断而不是整体拒绝', () => {
    const fragments = Array.from({ length: PROJECT_DOC_LIMITS.fragments + 10 }, (_, i) => ({
      id: `f${i}`, singerId: 's1', duration: 1,
    }));
    const r = validateProjectDocument({ singers: [{ id: 's1' }], fragments });
    expect(r.ok).to.equal(true);
    expect(r.document.fragments).to.have.lengthOf(PROJECT_DOC_LIMITS.fragments);
    expect(r.warnings.join()).to.match(/超过上限/);
  });

  it('重复歌手 id 只留第一个', () => {
    const r = validateProjectDocument({ singers: [{ id: 'a', singerName: '1' }, { id: 'a', singerName: '2' }] });
    expect(r.document.singers).to.have.lengthOf(1);
    expect(r.document.singers[0].singerName).to.equal('1');
  });

  it('超深嵌套被截断而不是爆栈', () => {
    let deep = { v: 1 };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    const r = validateProjectDocument({ singers: [{ id: 's1', meta: deep }] });
    expect(r.ok).to.equal(true);
    // 深度受限后最内层会缺失，但不应该抛栈溢出
    expect(JSON.stringify(r.document)).to.be.a('string');
  });

  it('长字符串被截断', () => {
    const long = 'x'.repeat(PROJECT_DOC_LIMITS.stringLength + 100);
    const r = validateProjectDocument({ fragments: [{ id: 'f', singerId: 's1', name: long }] });
    expect(r.document.fragments[0].name).to.have.lengthOf(200);
  });

  it('version 透传合法值，非法值用当前版本', () => {
    expect(validateProjectDocument({ version: '1.2.0' }).document.version).to.equal('1.2.0');
    expect(validateProjectDocument({ version: 3 }).document.version).to.match(/^\d+\.\d+\.\d+$/);
  });
});
