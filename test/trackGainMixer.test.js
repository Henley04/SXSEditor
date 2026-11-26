'use strict';
/**
 * trackGainMixer（计划 4.1）：一轨一增益节点的实时 M/S + 伴奏音量。
 */
const { expect } = require('chai');

const {
  registerTrackGain,
  getOrCreateTrackGain,
  clearTrackGains,
  setTrackBaseGain,
  applyAudibility,
  subscribeAudibilityChange,
  hasLiveTracks,
  getAudibleSnapshot,
} = require('../src/renderer/trackGainMixer.js');

/** 记录 setTargetAtTime 调用的假 GainNode。 */
function makeGain() {
  const calls = [];
  return {
    gain: {
      value: 1,
      cancelScheduledValues() {},
      setTargetAtTime(target) { calls.push({ target, at: calls.length }); this.value = target; },
    },
    context: { currentTime: 0 },
    connect() { return this; },
    disconnect() {},
    _calls: calls,
  };
}

function singer(id, extra = {}) {
  return { id, type: 'singer', ...extra };
}
function acc(id, volume = 1, extra = {}) {
  return { id, type: 'accompaniment', accompanimentVolume: volume, ...extra };
}

describe('trackGainMixer — 人声轨 / 伴奏轨增益', () => {
  beforeEach(() => clearTrackGains());

  it('人声轨：可听 target=1，静音 target=0，取消静音恢复 1', () => {
    const g = makeGain();
    registerTrackGain('s1', g, 1);
    applyAudibility([singer('s1')]);
    expect(g.gain.value).to.equal(1);

    applyAudibility([singer('s1', { mute: true })]);
    expect(g.gain.value).to.equal(0);

    applyAudibility([singer('s1')]);
    expect(g.gain.value).to.equal(1);
  });

  it('伴奏轨：可听 target=音量，静音 target=0', () => {
    const g = makeGain();
    registerTrackGain('acc1', g, 0.6);
    applyAudibility([acc('acc1', 0.6)]);
    expect(g.gain.value).to.equal(0.6);

    applyAudibility([acc('acc1', 0.6, { mute: true })]);
    expect(g.gain.value).to.equal(0);
  });

  it('Solo：被 Solo 轨发声，其余人声 + 伴奏静音', () => {
    const g1 = makeGain();
    const g2 = makeGain();
    const ga = makeGain();
    registerTrackGain('s1', g1, 1);
    registerTrackGain('s2', g2, 1);
    registerTrackGain('acc1', ga, 1);
    applyAudibility([singer('s1', { solo: true }), singer('s2'), acc('acc1', 1)]);
    expect(g1.gain.value).to.equal(1);
    expect(g2.gain.value).to.equal(0);
    expect(ga.gain.value).to.equal(0);
  });

  it('Mute 优先于 Solo：同时 mute+solo 的轨静音', () => {
    const g = makeGain();
    registerTrackGain('s1', g, 1);
    applyAudibility([singer('s1', { mute: true, solo: true })]);
    expect(g.gain.value).to.equal(0);
  });

  it('音量滑块在静音状态下只改 base 不解除静音', () => {
    const g = makeGain();
    registerTrackGain('acc1', g, 0.5);
    applyAudibility([acc('acc1', 0.5, { mute: true })]);
    expect(g.gain.value).to.equal(0);

    setTrackBaseGain('acc1', 0.8);
    expect(g.gain.value, '静音滑块不应解除静音').to.equal(0);

    applyAudibility([acc('acc1', 0.8)]);
    expect(g.gain.value).to.equal(0.8);
  });

  it('缓存键相同不重复写增益', () => {
    const g = makeGain();
    registerTrackGain('s1', g, 1);
    const first = applyAudibility([singer('s1')]);
    expect(first.changed).to.equal(true);
    const callCount = g._calls.length;
    const second = applyAudibility([singer('s1')]);
    expect(second.changed).to.equal(false);
    expect(g._calls.length, '键未变不应再写增益').to.equal(callCount);
  });

  it('applyAudibility 变更时通知订阅者（独占模式用）', () => {
    let notifications = 0;
    const unsub = subscribeAudibilityChange(() => { notifications++; });
    registerTrackGain('s1', makeGain(), 1);
    applyAudibility([singer('s1')]);
    expect(notifications).to.equal(1);
    applyAudibility([singer('s1')]); // 缓存命中，不通知
    expect(notifications).to.equal(1);
    applyAudibility([singer('s1', { mute: true })]);
    expect(notifications).to.equal(2);
    unsub();
  });

  it('getOrCreateTrackGain 复用已注册节点', () => {
    let created = 0;
    const factory = () => { created++; return makeGain(); };
    const g1 = getOrCreateTrackGain('s1', factory, 1, true);
    const g2 = getOrCreateTrackGain('s1', factory, 1, true);
    expect(g1).to.equal(g2);
    expect(created).to.equal(1);
  });

  it('getOrCreateTrackGain 以 initialAudible=false 注册时初值为 0（静音轨首 chunk 不漏音）', () => {
    const g = getOrCreateTrackGain('s1', () => makeGain(), 1, false);
    expect(g.gain.value).to.equal(0);
  });

  it('clearTrackGains 清空表', () => {
    registerTrackGain('s1', makeGain(), 1);
    expect(hasLiveTracks()).to.equal(true);
    clearTrackGains();
    expect(hasLiveTracks()).to.equal(false);
    expect(getAudibleSnapshot().size).to.equal(0);
  });
});
