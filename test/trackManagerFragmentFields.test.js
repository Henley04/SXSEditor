/**
 * 分片持久化字段保留回归。
 *
 * 背景：trackManager.createFragment() 是显式字段白名单对象，漏登记的字段会在
 * 工程 load→addFragment 时被静默丢弃。postprocess（音色/后处理曲线）曾因此
 * 丢失：编辑器打开后回退全默认，首次自动保存再把默认值写回，等于用默认值
 * 覆盖用户曲线。kanjiGroups 同病。这里把两个字段钉死在白名单里。
 */
const { expect } = require('chai');
const { TrackManager } = require('../src/editor/trackManager.js');

describe('trackManager fragment 持久化字段保留', () => {
  let tm;
  beforeEach(() => {
    tm = new TrackManager();
    tm.addSinger({ id: 's1', name: 'singer' });
  });

  it('addFragment 保留 postprocess（音色 / 后处理曲线）', () => {
    const saved = {
      id: 'f1',
      singerId: 's1',
      postprocess: {
        defaults: { f0Smooth: 50, specSmoothT: 1.2 },
        curves: { f0Smooth: { keyframes: [{ time: 1, value: 60, strength: 80, smoothness: 30 }] } },
      },
    };
    const frag = tm.addFragment(saved);
    expect(frag.postprocess, 'postprocess 必须保留，否则工程重开丢曲线').to.deep.equal(saved.postprocess);
  });

  it('addFragment 保留 kanjiGroups', () => {
    const groups = [{ id: 'g1', kanji: '夢', noteIds: ['n1'] }];
    const frag = tm.addFragment({ id: 'f2', singerId: 's1', kanjiGroups: groups });
    expect(frag.kanjiGroups).to.deep.equal(groups);
  });

  it('没有这些字段时补默认值（postprocess=null / kanjiGroups=[]）', () => {
    const frag = tm.addFragment({ id: 'f3', singerId: 's1' });
    expect(frag.postprocess).to.equal(null);
    expect(frag.kanjiGroups).to.deep.equal([]);
  });

  it('复制分片（再次 addFragment）也保留 postprocess', () => {
    const src = tm.addFragment({
      id: 'f4',
      singerId: 's1',
      postprocess: { defaults: { f0Glide: 35 }, curves: {} },
    });
    const copy = tm.addFragment({ ...src, id: 'f5' });
    expect(copy.postprocess).to.deep.equal(src.postprocess);
  });
});
