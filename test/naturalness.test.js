import { expect } from 'chai';
import { analyzeNaturalness, NAT_STATUS } from '../src/shared/naturalness.js';
import {
  autoPitchAt,
  normalizeAutoConfig,
  AUTO_PITCH_DEFAULTS,
} from '../src/shared/autoPitchCurve.js';

/**
 * 自然度自检的回归护栏。
 *
 * 这些数值不是"好看的数字"，而是把设计方案 §7 的真人歌唱统计区间钉成断言：
 * 参数默认值一旦被改成"听起来还行但其实很机械"的组合，这里会先失败，
 * 不用等到用户听出来。
 */
describe('naturalness analyse', () => {
  const bpm = 120;
  const ranges = { min: 28, max: 88 };

  function makeCtx(notes, paramsOverride = {}) {
    const auto = normalizeAutoConfig({
      enabled: true,
      preset: 'natural',
      params: { ...AUTO_PITCH_DEFAULTS, ...paramsOverride },
    });
    return { sortedNotes: notes, auto, bpm, ranges };
  }

  /**
   * "每个音都做"的确定性参数。
   *
   * 自动曲线默认带概率闸门（不是每个长音都颤、不是每个跳进都过冲），
   * 断言"深度/速率/过冲的数值对不对"时必须把闸门打开，否则断言的是
   * 抽签结果而不是算法。
   */
  const ALWAYS = {
    vibratoProbability: 1,
    overshootProbability: 1,
    prepProbability: 1,
    releaseProbability: 1,
    variation: 0,
  };

  /**
   * 完整曲线 = 自动层（**已含自动颤音**）。
   * 传 vibrato 时在自动层之上**再叠一层**，用于测"用户手设颤音"的情形；
   * 不传就是纯自动曲线的默认表现。
   */
  function makePitchAt(auto, notes, vibrato = null) {
    const ctx = { sortedNotes: notes, auto, bpm, ranges };
    return (beat) => {
      const base = autoPitchAt(ctx, beat);
      if (base === null) return null;
      if (!vibrato) return base;
      const n = notes.find((x) => beat >= x.start && beat < x.start + x.duration);
      if (!n) return base;
      const age = beat - n.start;
      const ramp = Math.min(1, Math.max(0, (age - vibrato.delayBeats) / 0.5));
      return base + (vibrato.depthCents / 100) * ramp
        * Math.sin(2 * Math.PI * vibrato.rate * (age / bpm) * 60);
    };
  }

  const item = (result, id) => result.items.find((x) => x.id === id);

  it('无音符时返回空结果，不抛错', () => {
    const r = analyzeNaturalness({ pitchAt: () => null, notes: [], bpm });
    expect(r.items).to.be.an('array').that.is.empty;
    expect(r.score).to.equal(0);
  });

  it('完全平直的曲线会被判为"没有颤音"且"死平段过多"', () => {
    const notes = [
      { id: 1, pitch: 60, start: 0, duration: 2, lyric: 'la' },
      { id: 2, pitch: 60, start: 2, duration: 2, lyric: 'la' },
    ];
    // 只用音符音高，不叠加任何起伏：这是"机械感"的极端样本
    const r = analyzeNaturalness({
      pitchAt: (beat) => {
        const n = notes.find((x) => beat >= x.start && beat < x.start + x.duration);
        return n ? n.pitch : null;
      },
      notes,
      bpm,
      ranges,
    });
    expect(item(r, 'vibrato').status).to.equal(NAT_STATUS.BAD);
    expect(item(r, 'flat').status).to.equal(NAT_STATUS.BAD);
    expect(item(r, 'flat').value).to.be.greaterThan(80);
    expect(r.score).to.be.lessThan(50);
  });

  it('自动曲线（22¢/5.5Hz 颤音，闸门全开）→ 深度与速率都落在真人区间', () => {
    const notes = [
      { id: 1, pitch: 60, start: 0, duration: 2, lyric: 'la' },
      { id: 2, pitch: 67, start: 2, duration: 2, lyric: 'la' },
      { id: 3, pitch: 64, start: 4, duration: 2, lyric: 'la' },
      // 第二个跳进（64→60）让"过冲比例"这一项有统计意义（1 个跳进只给 info）
      { id: 4, pitch: 60, start: 6, duration: 2, lyric: 'la' },
    ];
    const auto = makeCtx(notes, ALWAYS).auto;
    const pitchAt = makePitchAt(auto, notes); // 不额外叠加：验的是 auto 自己的颤音
    const r = analyzeNaturalness({ pitchAt, notes, bpm, ranges });

    const depth = item(r, 'vibrato');
    expect(depth.value).to.be.within(12, 33);
    expect(depth.status).to.equal(NAT_STATUS.GOOD);

    const rate = item(r, 'vibratoRate');
    expect(rate.value).to.be.within(3, 9);
    expect(rate.status).to.equal(NAT_STATUS.GOOD);

    // 7 半音跳进应有可测的过冲，且不夸张
    const over = item(r, 'overshoot');
    expect(over.value).to.be.within(8, 30);
    expect(over.status).to.equal(NAT_STATUS.GOOD);
  });

  it('默认参数（带概率闸门）下，长音不是"个个都颤"但覆盖率仍在真人区间', () => {
    // 12 个同长度长音：默认 vibratoProbability=0.82 × 上下文系数
    const notes = [];
    for (let i = 0; i < 12; i++) {
      notes.push({ id: 100 + i, pitch: 60 + (i % 5), start: i * 2, duration: 2, lyric: 'la' });
    }
    const auto = makeCtx(notes).auto;
    const ctx = { sortedNotes: notes, auto, bpm, ranges };
    const r = analyzeNaturalness({
      pitchAt: (b) => autoPitchAt(ctx, b),
      notes,
      bpm,
      ranges,
    });
    const cov = item(r, 'vibratoCoverage');
    expect(cov).to.exist;
    // 覆盖 45%–98%：既不是 0（全直声）也不是 100%（每个都颤 → 机械）
    expect(cov.value).to.be.within(45, 98);
    expect(cov.value).to.be.lessThan(100);
    // 同一个音符重复求值结果完全一致（确定性）
    const a1 = autoPitchAt(ctx, 1.3);
    const a2 = autoPitchAt(ctx, 1.3);
    expect(a1).to.equal(a2);
  });

  it('颤音过深 / 过浅会被判档区分开', () => {
    const notes = [{ id: 1, pitch: 60, start: 0, duration: 2, lyric: 'la' }];

    // 直接改 autoVibrato.depth（auto 自带颤音，不需要在采样器里再叠加）
    const shallow = analyzeNaturalness({
      pitchAt: makePitchAt(makeCtx(notes, { ...ALWAYS, autoVibrato: { depth: 4 } }).auto, notes),
      notes,
      bpm,
      ranges,
    });
    expect(item(shallow, 'vibrato').status).to.equal(NAT_STATUS.BAD);

    const deep = analyzeNaturalness({
      pitchAt: makePitchAt(makeCtx(notes, { ...ALWAYS, autoVibrato: { depth: 90 } }).auto, notes),
      notes,
      bpm,
      ranges,
    });
    expect(item(deep, 'vibrato').status).to.equal(NAT_STATUS.BAD);
  });

  it('关闭抖动后抖动指标明显下降（说明它测的是曲线本身，不是固定常数）', () => {
    const notes = [{ id: 1, pitch: 60, start: 0, duration: 2, lyric: 'la' }];
    const withJitter = analyzeNaturalness({
      pitchAt: makePitchAt(makeCtx(notes).auto, notes),
      notes,
      bpm,
      ranges,
    });
    const noJitter = analyzeNaturalness({
      pitchAt: makePitchAt(makeCtx(notes, { jitterCents: 0 }).auto, notes),
      notes,
      bpm,
      ranges,
    });
    expect(item(withJitter, 'jitter').value).to.be.greaterThan(item(noJitter, 'jitter').value);
  });

  it('音域越界会计数（半音超出 ranges 的音符）', () => {
    const notes = [
      { id: 1, pitch: 60, start: 0, duration: 1, lyric: 'la' },
      { id: 2, pitch: 96, start: 1, duration: 1, lyric: 'la' }, // 超出 28..88
    ];
    const auto = makeCtx(notes).auto;
    const r = analyzeNaturalness({
      pitchAt: makePitchAt(auto, notes),
      notes,
      bpm,
      ranges,
    });
    expect(item(r, 'range').value).to.equal(1);
  });
});
