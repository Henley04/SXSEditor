'use strict';
/**
 * 分片编辑器首次缩放卡顿：音高曲线采样网格的像素级抽稀。
 *
 * 从 F0 导入的曲线可能有数万个锚点。缩小时它们都落在可见窗内，旧实现会把
 * 每个锚点都塞进采样数组并排序 —— 第一次缩小往往就是一次明显的卡顿。
 * `minAnchorSpacing` 让同一像素列上的锚点只保留一个，把采样量封顶在
 * 可见像素数量级，同时不改变默认行为（不传该参数时所有锚点仍并入）。
 */

const { expect } = require('chai');
const { buildPitchCurveSampleTimes } = require('../src/fragmentEditor/automationCurve');

const base = { startBeat: 0, endBeat: 20, width: 800, interval: 0.02 };

function denseAnchors(count, span) {
  return Array.from({ length: count }, (_, i) => ({
    time: (i / Math.max(1, count - 1)) * span,
    value: 60,
  }));
}

describe('buildPitchCurveSampleTimes — 缩放时的锚点抽稀', function () {
  it('不传 minAnchorSpacing 时保持"所有可见锚点都并入"', function () {
    const anchors = denseAnchors(3000, 20);
    const ts = buildPitchCurveSampleTimes({ ...base, sortedAnchors: anchors });
    const set = new Set(ts);
    for (const a of anchors) expect(set.has(a.time)).to.equal(true);
  });

  it('像素级抽稀后采样点数量显著下降，但视口边界不变', function () {
    const anchors = denseAnchors(5000, 20);
    // 20 拍 / 800px = 0.025 拍/像素，半像素 = 0.0125 拍
    const ts = buildPitchCurveSampleTimes({
      ...base,
      sortedAnchors: anchors,
      minAnchorSpacing: 0.0125,
    });
    expect(ts[0]).to.be.closeTo(-1, 1e-9);
    expect(ts[ts.length - 1]).to.be.closeTo(21, 1e-9);
    // 均匀网格 800 点 + 抽稀锚点最多 ~1600 点，远小于 5000
    expect(ts.length).to.be.lessThan(2600);
    // 结果仍然严格升序、无重复
    for (let i = 1; i < ts.length; i++) expect(ts[i]).to.be.greaterThan(ts[i - 1]);
  });

  it('间距足够大时锚点仍全部并入（放大场景不受影响）', function () {
    const anchors = denseAnchors(20, 20); // 约 1 拍一个
    const ts = buildPitchCurveSampleTimes({
      ...base,
      sortedAnchors: anchors,
      minAnchorSpacing: 0.0125,
    });
    const set = new Set(ts);
    for (const a of anchors) expect(set.has(a.time)).to.equal(true);
  });
});
