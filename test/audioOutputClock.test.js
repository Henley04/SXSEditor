/**
 * shared/audioOutputClock —— 播放头/时间码的"可听位置"换算。
 *
 * 关键回归点（对应"播放进度条和实际播放位置轻微错位"）：
 *   - 有 outputLatency 时必须扣掉它，否则指示器稳定跑在声音前面；
 *   - outputLatency 缺失/为 0 时退化到 baseLatency，仍不可知才返回 0（不补偿）；
 *   - 异常读数（NaN/负数/超过上限）不得把播放头甩飞；
 *   - 设备延迟抖动要平滑，不能逐帧跳动；
 *   - 起播瞬间可听位置是负值 → 必须截到 0（此刻确实还没声音）。
 */
const { expect } = require('chai');
const {
  MAX_OUTPUT_LATENCY_SEC,
  estimateOutputLatencySec,
  getOutputLatencySec,
  getAudibleContextTime,
  getAudibleElapsedSec,
  _resetOutputLatencyCache,
} = require('../src/shared/audioOutputClock.js');

function makeCtx({ currentTime = 10, outputLatency, baseLatency } = {}) {
  return { currentTime, outputLatency, baseLatency };
}

describe('shared/audioOutputClock', () => {
  describe('estimateOutputLatencySec', () => {
    it('无 context → 0（不补偿）', () => {
      expect(estimateOutputLatencySec(null)).to.equal(0);
      expect(estimateOutputLatencySec(undefined)).to.equal(0);
    });

    it('优先取 outputLatency（含设备缓冲）', () => {
      const ctx = makeCtx({ outputLatency: 0.032, baseLatency: 0.005 });
      expect(estimateOutputLatencySec(ctx)).to.be.closeTo(0.032, 1e-9);
    });

    it('outputLatency 为 0/缺失时退化到 baseLatency', () => {
      expect(estimateOutputLatencySec(makeCtx({ outputLatency: 0, baseLatency: 0.011 })))
        .to.be.closeTo(0.011, 1e-9);
      expect(estimateOutputLatencySec(makeCtx({ baseLatency: 0.011 })))
        .to.be.closeTo(0.011, 1e-9);
    });

    it('两者都不可知 → 0', () => {
      expect(estimateOutputLatencySec(makeCtx({}))).to.equal(0);
      expect(estimateOutputLatencySec(makeCtx({ outputLatency: NaN, baseLatency: NaN }))).to.equal(0);
    });

    it('负值与超上限读数被夹紧（不把播放头甩飞）', () => {
      expect(estimateOutputLatencySec(makeCtx({ outputLatency: -0.2 }))).to.equal(0);
      expect(estimateOutputLatencySec(makeCtx({ outputLatency: 99 })))
        .to.equal(MAX_OUTPUT_LATENCY_SEC);
    });
  });

  describe('getOutputLatencySec（平滑）', () => {
    it('首次调用直接采用实测值', () => {
      const ctx = makeCtx({ outputLatency: 0.024 });
      _resetOutputLatencyCache(ctx);
      expect(getOutputLatencySec(ctx)).to.be.closeTo(0.024, 1e-9);
    });

    it('单帧跳变不会让延迟瞬间跳过去（EMA）', () => {
      const ctx = makeCtx({ outputLatency: 0.02 });
      _resetOutputLatencyCache(ctx);
      expect(getOutputLatencySec(ctx)).to.be.closeTo(0.02, 1e-9);

      ctx.outputLatency = 0.06;
      const afterOneFrame = getOutputLatencySec(ctx);
      expect(afterOneFrame).to.be.greaterThan(0.02);
      // 0.2 的 EMA：0.02 + (0.06-0.02)*0.2 = 0.028
      expect(afterOneFrame).to.be.closeTo(0.028, 1e-9);

      for (let i = 0; i < 60; i++) getOutputLatencySec(ctx);
      expect(getOutputLatencySec(ctx)).to.be.closeTo(0.06, 1e-3);
    });

    it('设备延迟瞬时归零时按 EMA 缓慢回落，不跳变', () => {
      const ctx = makeCtx({ outputLatency: 0.04 });
      _resetOutputLatencyCache(ctx);
      getOutputLatencySec(ctx);
      ctx.outputLatency = 0;
      expect(getOutputLatencySec(ctx)).to.be.closeTo(0.032, 1e-9);
    });

    it('不同 context 独立平滑（WeakMap 隔离）', () => {
      const a = makeCtx({ outputLatency: 0.01 });
      const b = makeCtx({ outputLatency: 0.05 });
      _resetOutputLatencyCache(a);
      _resetOutputLatencyCache(b);
      getOutputLatencySec(a);
      expect(getOutputLatencySec(b)).to.be.closeTo(0.05, 1e-9);
    });
  });

  describe('getAudibleContextTime', () => {
    it('= currentTime - 输出延迟', () => {
      const ctx = makeCtx({ currentTime: 12.5, outputLatency: 0.03 });
      _resetOutputLatencyCache(ctx);
      expect(getAudibleContextTime(ctx)).to.be.closeTo(12.47, 1e-9);
    });

    it('延迟不可知时与 currentTime 相等（旧行为）', () => {
      const ctx = makeCtx({ currentTime: 3 });
      _resetOutputLatencyCache(ctx);
      expect(getAudibleContextTime(ctx)).to.equal(3);
    });
  });

  describe('getAudibleElapsedSec', () => {
    it('正常播放中 = 可听时间 - 播放基准', () => {
      const ctx = makeCtx({ currentTime: 10.5, outputLatency: 0.04 });
      _resetOutputLatencyCache(ctx);
      expect(getAudibleElapsedSec(ctx, 10)).to.be.closeTo(0.46, 1e-9);
    });

    it('起播瞬间（声音还没到喇叭）截到 0，不出现负时间码', () => {
      const ctx = makeCtx({ currentTime: 10.01, outputLatency: 0.04 });
      _resetOutputLatencyCache(ctx);
      expect(getAudibleElapsedSec(ctx, 10)).to.equal(0);
    });

    it('无 context / 基准非法 → 0', () => {
      expect(getAudibleElapsedSec(null, 10)).to.equal(0);
      expect(getAudibleElapsedSec(makeCtx({}), NaN)).to.equal(0);
    });
  });
});
