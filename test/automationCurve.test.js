const { expect } = require('chai');

const {
  ANCHOR_STRENGTH_DEFAULT,
  clampStrength,
  easeSegment,
  sortAnchors,
  buildEffectiveValues,
  evalSortedCurve,
  evalAnchors,
  insertAnchor,
  snapshotAnchors,
} = require('../src/fragmentEditor/automationCurve');

describe('automationCurve (锚点强度 / 平滑过渡)', () => {
  const make = (points) => points.map(([time, value, strength, smoothness]) => ({
    time, value, strength, smoothness,
  }));

  describe('clampStrength', () => {
    it('缺省/非法值回落到 100（旧工程不带 strength 字段时行为不变）', () => {
      expect(clampStrength(undefined)).to.equal(ANCHOR_STRENGTH_DEFAULT);
      expect(clampStrength(null)).to.equal(ANCHOR_STRENGTH_DEFAULT);
      expect(clampStrength('abc')).to.equal(ANCHOR_STRENGTH_DEFAULT);
      expect(clampStrength(NaN)).to.equal(100);
    });
    it('钳制到 0..100', () => {
      expect(clampStrength(-30)).to.equal(0);
      expect(clampStrength(180)).to.equal(100);
      expect(clampStrength(42)).to.equal(42);
    });
  });

  describe('easeSegment', () => {
    it('smoothness 0 → 线性', () => {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        expect(easeSegment(t, 0)).to.be.closeTo(t, 1e-12);
      }
    });
    it('smoothness 100 → smoothstep，且端点不变', () => {
      expect(easeSegment(0, 100)).to.be.closeTo(0, 1e-12);
      expect(easeSegment(1, 100)).to.be.closeTo(1, 1e-12);
      expect(easeSegment(0.5, 100)).to.be.closeTo(0.5, 1e-12);
      // 缓入：t=0.25 时小于线性
      expect(easeSegment(0.25, 100)).to.be.lessThan(0.25);
    });
  });

  describe('强度语义', () => {
    it('强度 100 时有效值与原始值一致（逐点等于线性插值）', () => {
      const anchors = make([[0, 60, 100, 0], [1, 72, 100, 0], [2, 60, 100, 0]]);
      const sorted = sortAnchors(anchors);
      const eff = buildEffectiveValues(sorted);
      expect(Array.from(eff)).to.deep.equal([60, 72, 60]);
      expect(evalSortedCurve(sorted, eff, 0.5)).to.be.closeTo(66, 1e-9);
      expect(evalSortedCurve(sorted, eff, 1)).to.be.closeTo(72, 1e-9);
    });

    it('强度 0 时锚点被完全忽略，曲线退化为两侧锚点连线', () => {
      const anchors = make([[0, 60, 100, 0], [1, 90, 0, 0], [2, 60, 100, 0]]);
      const sorted = sortAnchors(anchors);
      const eff = buildEffectiveValues(sorted);
      // 中点 1 处的基线 = 60 + (60-60)*0.5 = 60
      expect(eff[1]).to.be.closeTo(60, 1e-9);
      expect(evalSortedCurve(sorted, eff, 1)).to.be.closeTo(60, 1e-9);
    });

    it('强度 50 时锚点只被拉走一半', () => {
      const anchors = make([[0, 0, 100, 0], [1, 100, 50, 0], [2, 0, 100, 0]]);
      const sorted = sortAnchors(anchors);
      const eff = buildEffectiveValues(sorted);
      // 基线在 t=1 处 = 0，锚点值 100，强度 50 → 50
      expect(eff[1]).to.be.closeTo(50, 1e-9);
    });

    it('首尾锚点没有两侧邻居，强度不生效', () => {
      const anchors = make([[0, 10, 0, 0], [1, 50, 0, 0], [2, 90, 0, 0]]);
      const sorted = sortAnchors(anchors);
      const eff = buildEffectiveValues(sorted);
      expect(eff[0]).to.equal(10);
      expect(eff[2]).to.equal(90);
    });

    it('支持自定义 valueKey（音高曲线用 pitch 字段）', () => {
      const anchors = [
        { time: 0, pitch: 60, strength: 100, smoothness: 0 },
        { time: 1, pitch: 70, strength: 0, smoothness: 0 },
        { time: 2, pitch: 60, strength: 100, smoothness: 0 },
      ];
      const eff = buildEffectiveValues(anchors, 'pitch');
      expect(eff[1]).to.be.closeTo(60, 1e-9);
    });
  });

  describe('evalSortedCurve 边界', () => {
    it('无锚点返回 null', () => {
      expect(evalSortedCurve([], new Float64Array(0), 0)).to.equal(null);
    });
    it('单锚点返回常数', () => {
      const anchors = sortAnchors(make([[1, 64, 100, 0]]));
      expect(evalSortedCurve(anchors, buildEffectiveValues(anchors), 0)).to.equal(64);
      expect(evalSortedCurve(anchors, buildEffectiveValues(anchors), 99)).to.equal(64);
    });
    it('区间外保持端点值', () => {
      const anchors = sortAnchors(make([[1, 60, 100, 0], [2, 70, 100, 0]]));
      const eff = buildEffectiveValues(anchors);
      expect(evalSortedCurve(anchors, eff, 0)).to.equal(60);
      expect(evalSortedCurve(anchors, eff, 5)).to.equal(70);
    });
    it('evalAnchors 对未排序输入同样正确', () => {
      const anchors = make([[2, 60, 100, 0], [0, 60, 100, 0]]);
      expect(evalAnchors(anchors, 1)).to.be.closeTo(60, 1e-9);
    });
  });

  describe('insertAnchor / snapshotAnchors', () => {
    it('同一时刻已存在锚点时复用索引并更新数值', () => {
      const anchors = make([[1, 60, 100, 0]]);
      const res = insertAnchor(anchors, 1, 72);
      expect(res.created).to.equal(false);
      expect(res.index).to.equal(0);
      expect(anchors[0].value).to.equal(72);
      expect(anchors.length).to.equal(1);
    });
    // F13：smoothness 缺省必须是 0（线性），与下面的 snapshotAnchors 用例、
    // 以及 pitchCurveState.normalizePoint 保持同一口径。原来这里是 30，
    // 导致"经 insertAnchor 新建"和"经 snapshot 复制"的同一条曲线缓动不同。
    it('新增锚点带默认强度 100 / 平滑 0（与 snapshotAnchors 同口径）', () => {
      const anchors = [];
      const res = insertAnchor(anchors, 2.5, 40);
      expect(res.created).to.equal(true);
      expect(anchors[0].strength).to.equal(100);
      expect(anchors[0].smoothness).to.equal(0);
    });
    it('snapshotAnchors 补齐缺省字段并复制（不与原对象共享引用）', () => {
      const anchors = [{ time: 0, value: 1 }];
      const snap = snapshotAnchors(anchors);
      expect(snap[0]).to.deep.equal({ time: 0, value: 1, strength: 100, smoothness: 0 });
      snap[0].value = 99;
      expect(anchors[0].value).to.equal(1);
    });
  });
});
