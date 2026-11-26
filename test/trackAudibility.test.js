'use strict';
/**
 * 轨道可听性（Mute / Solo）判定。
 *
 * 规则只有这一套，播放、导出、播放缓存签名三处共用：
 *   1. 静音优先 —— 静音的轨道永远不发声，即使同时被独奏；
 *   2. 有独奏则只放独奏；
 *   3. 独奏时伴奏一并静音（"只留这一条"才成立）。
 *
 * 这三条一旦分叉，症状是"导出比播放多一条轨"或"静音后按播放还是旧声音"，
 * 都属于难以从现象反推的类型，所以逐条钉死。
 */
const { expect } = require('chai');

let mod;
before(async () => {
  mod = await import('../src/shared/trackAudibility.js');
});

const track = (id, extra = {}) => ({ id, type: 'singer', mute: false, solo: false, ...extra });

describe('trackAudibility — 基础规则', () => {
  it('默认全部可听', () => {
    const tracks = [track('a'), track('b')];
    const aud = mod.computeAudibility(tracks);
    expect(aud.anySolo).to.equal(false);
    expect(aud.audible(tracks[0])).to.equal(true);
    expect(aud.audible(tracks[1])).to.equal(true);
  });

  it('静音只影响自己', () => {
    const tracks = [track('a', { mute: true }), track('b')];
    const aud = mod.computeAudibility(tracks);
    expect(aud.audible(tracks[0])).to.equal(false);
    expect(aud.audible(tracks[1])).to.equal(true);
  });

  it('独奏只留独奏轨', () => {
    const tracks = [track('a'), track('b', { solo: true }), track('c')];
    const aud = mod.computeAudibility(tracks);
    expect(aud.anySolo).to.equal(true);
    expect(aud.audible(tracks[0])).to.equal(false);
    expect(aud.audible(tracks[1])).to.equal(true);
    expect(aud.audible(tracks[2])).to.equal(false);
  });

  it('多条独奏同时发声', () => {
    const tracks = [track('a', { solo: true }), track('b', { solo: true }), track('c')];
    const aud = mod.computeAudibility(tracks);
    expect(aud.audible(tracks[0])).to.equal(true);
    expect(aud.audible(tracks[1])).to.equal(true);
    expect(aud.audible(tracks[2])).to.equal(false);
  });

  it('静音优先于独奏：既静音又独奏的轨道不发声', () => {
    const tracks = [track('a', { mute: true, solo: true }), track('b')];
    const aud = mod.computeAudibility(tracks);
    expect(aud.audible(tracks[0])).to.equal(false);
    // b 没被独奏，但有独奏存在 → b 也不响：整体静音，符合"静音优先"的一致语义
    expect(aud.audible(tracks[1])).to.equal(false);
  });

  it('独奏人声轨时伴奏一并静音', () => {
    const tracks = [
      track('v1', { solo: true }),
      track('acc', { type: 'accompaniment' }),
    ];
    const aud = mod.computeAudibility(tracks);
    expect(aud.audible(tracks[0])).to.equal(true);
    expect(aud.audible(tracks[1]), '独奏时伴奏必须一起静音').to.equal(false);
  });

  it('伴奏可以单独静音 / 单独独奏', () => {
    const muted = [track('v1'), track('acc', { type: 'accompaniment', mute: true })];
    expect(mod.computeAudibility(muted).audible(muted[1])).to.equal(false);

    const soloAcc = [track('v1'), track('acc', { type: 'accompaniment', solo: true })];
    const aud = mod.computeAudibility(soloAcc);
    expect(aud.audible(soloAcc[1])).to.equal(true);
    expect(aud.audible(soloAcc[0])).to.equal(false);
  });

  it('byId 与 audible() 结论一致', () => {
    const tracks = [track('a', { solo: true }), track('b', { mute: true }), track('c')];
    const aud = mod.computeAudibility(tracks);
    for (const t of tracks) {
      expect(aud.byId.get(t.id)).to.equal(aud.audible(t));
    }
  });

  it('容忍脏数据（null / 非数组 / 缺 id）', () => {
    expect(mod.hasAnySolo(null)).to.equal(false);
    expect(mod.hasAnySolo([null, undefined])).to.equal(false);
    expect(mod.isTrackAudible(null, false)).to.equal(false);
    const aud = mod.computeAudibility([null, { mute: true, solo: false }]);
    expect(aud.audible({ mute: true })).to.equal(false);
    expect(aud.audible({ mute: false })).to.equal(true);
  });
});

describe('trackAudibility — 分片过滤', () => {
  const singers = [
    track('v1'),
    track('v2', { mute: true }),
    track('v3', { solo: true }),
    track('acc', { type: 'accompaniment' }),
  ];
  const fragments = [
    { id: 'f1', singerId: 'v1' },
    { id: 'f2', singerId: 'v2' },
    { id: 'f3', singerId: 'v3' },
    { id: 'f4', singerId: 'acc' },
    { id: 'f5', singerId: 'ghost' },
  ];

  it('按可听性过滤（有独奏时只剩独奏轨的分片；孤儿分片不可听）', () => {
    const kept = mod.filterAudibleFragments(fragments, singers).map((f) => f.id);
    expect(kept, 'v3 是唯一独奏轨；v1/v2 静音或无独奏、acc 伴奏、ghost 无轨道').to.deep.equal(['f3']);
  });

  it('无独奏时只排除静音轨', () => {
    const list = [track('v1'), track('v2', { mute: true })];
    const kept = mod.filterAudibleFragments([{ id: 'f1', singerId: 'v1' }, { id: 'f2', singerId: 'v2' }], list)
      .map((f) => f.id);
    expect(kept).to.deep.equal(['f1']);
  });

  it('孤儿分片（轨道已删）算不可听，与播放/签名的结论一致', () => {
    const kept = mod.filterAudibleFragments([{ id: 'f5', singerId: 'ghost' }], [track('v1')]);
    expect(kept).to.deep.equal([]);
  });

  it('接受 Map 形式的轨道集合', () => {
    const map = new Map(singers.map((s) => [s.id, s]));
    expect(mod.filterAudibleFragments(fragments, map).map((f) => f.id)).to.deep.equal(['f3']);
  });
});
