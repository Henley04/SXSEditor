const { expect } = require('chai');

const {
  normalizeCurvePoints,
  sampleCurve,
  applyCurveSpec,
  resolveCurveSpec,
  collectCurves,
  CURVE_MAX_POINTS,
} = require('../src/shared/pluginCurve.js');
const { normalizeExtSchema } = require('../src/shared/pluginExt.js');

/**
 * 插件曲线的取值层。
 *
 * 这一层只回答三个问题：
 *   · 插件给的东西能不能变成一条线（形态宽容 + 越界丢弃）；
 *   · 某个位置的值是多少（linear / step / smooth）；
 *   · 声明的 quantize / clamp 怎么叠上去（只影响读，不改原始数据）。
 *
 * 最要紧的断言是"越界的 t 丢弃而不是夹边"：夹边会把音符外的数据画成贴边
 * 竖线，看起来像一条有效自动化 —— 那比看不见更糟。
 */
describe('pluginCurve — 点的归一化', () => {
  it('接受 [[t,v],...] / { points } / [{t,v}] 三种形态', () => {
    const a = normalizeCurvePoints([[0, 1], [1, 0]]);
    const b = normalizeCurvePoints({ points: [[0, 1], [1, 0]] });
    const c = normalizeCurvePoints({ points: [{ t: 0, v: 1 }, { t: 1, v: 0 }] });
    expect(a).to.deep.equal([{ t: 0, v: 1 }, { t: 1, v: 0 }]);
    expect(b).to.deep.equal(a);
    expect(c).to.deep.equal(a);
  });

  it('按 t 升序重排（插件不必自己保证顺序）', () => {
    const pts = normalizeCurvePoints([[0.8, 3], [0.2, 1], [0.5, 2]]);
    expect(pts.map((p) => p.t)).to.deep.equal([0.2, 0.5, 0.8]);
  });

  it('t 超出 [0,1] 的点丢弃，不夹到边界', () => {
    const pts = normalizeCurvePoints([[-0.5, 9], [0, 1], [0.5, 2], [1.5, 9], [1, 3]]);
    expect(pts).to.deep.equal([{ t: 0, v: 1 }, { t: 0.5, v: 2 }, { t: 1, v: 3 }]);
  });

  it('非有限数（NaN / Infinity）丢弃', () => {
    const pts = normalizeCurvePoints([[0, 1], [0.5, NaN], [0.7, Infinity], [1, 2]]);
    expect(pts).to.deep.equal([{ t: 0, v: 1 }, { t: 1, v: 2 }]);
  });

  it('少于两个点返回 null —— 画不出线', () => {
    expect(normalizeCurvePoints([[0, 1]])).to.equal(null);
    expect(normalizeCurvePoints([])).to.equal(null);
    expect(normalizeCurvePoints(null)).to.equal(null);
    expect(normalizeCurvePoints('nope')).to.equal(null);
    expect(normalizeCurvePoints({ points: [] })).to.equal(null);
  });

  it('点数量有硬上限', () => {
    const many = [];
    for (let i = 0; i < CURVE_MAX_POINTS + 500; i++) many.push([i / (CURVE_MAX_POINTS + 499), i]);
    const pts = normalizeCurvePoints(many);
    expect(pts.length).to.equal(CURVE_MAX_POINTS);
  });
});

describe('pluginCurve — 求值', () => {
  const pts = [{ t: 0, v: 0 }, { t: 0.5, v: 10 }, { t: 1, v: 0 }];

  it('linear 在两点间线性插值', () => {
    expect(sampleCurve(pts, 0.25, 'linear')).to.be.closeTo(5, 1e-9);
    expect(sampleCurve(pts, 0.75, 'linear')).to.be.closeTo(5, 1e-9);
  });

  it('step 取左侧点的值（阶跃）', () => {
    expect(sampleCurve(pts, 0.49, 'step')).to.equal(0);
    expect(sampleCurve(pts, 0.51, 'step')).to.equal(10);
  });

  it('smooth 在节点处与 linear 同值，中点偏移更缓', () => {
    expect(sampleCurve(pts, 0.5, 'smooth')).to.be.closeTo(10, 1e-9);
    // 在 0/0.5 段的中点，smoothstep 的 0.5 处仍是线性中点
    expect(sampleCurve(pts, 0.25, 'smooth')).to.be.closeTo(5, 1e-9);
    // 四分之一位置：smooth 比 linear 更靠近起点（曲线呈 S 形）
    expect(sampleCurve(pts, 0.125, 'smooth')).to.be.lessThan(sampleCurve(pts, 0.125, 'linear'));
  });

  it('超出端点时保持端点值（不外推）', () => {
    expect(sampleCurve(pts, -1, 'linear')).to.equal(0);
    expect(sampleCurve(pts, 2, 'linear')).to.equal(0);
  });

  it('空曲线 / 非数字位置返回 null', () => {
    expect(sampleCurve([], 0.5)).to.equal(null);
    expect(sampleCurve(pts, NaN)).to.equal(null);
  });

  it('重复 t（竖直段）不产生 NaN', () => {
    const vertical = [{ t: 0, v: 0 }, { t: 0.5, v: 1 }, { t: 0.5, v: 5 }, { t: 1, v: 0 }];
    const v = sampleCurve(vertical, 0.5, 'linear');
    expect(Number.isFinite(v)).to.equal(true);
  });
});

describe('pluginCurve — 声明修饰', () => {
  it('quantize 按步长取整', () => {
    expect(applyCurveSpec(2.4, { quantize: 1 })).to.equal(2);
    expect(applyCurveSpec(2.6, { quantize: 1 })).to.equal(3);
    expect(applyCurveSpec(2.44, { quantize: 0.5 })).to.equal(2.5);
  });

  it('clamp 夹到声明范围', () => {
    expect(applyCurveSpec(-5, { clamp: [0, 10] })).to.equal(0);
    expect(applyCurveSpec(50, { clamp: [0, 10] })).to.equal(10);
  });

  it('quantize 先于 clamp：先取整再夹，避免越界值被量化回来', () => {
    expect(applyCurveSpec(10.7, { quantize: 1, clamp: [0, 10] })).to.equal(10);
  });

  it('字段级 interp 覆盖 schema 级，但 clamp 不被字段取消', () => {
    const schemaEntry = { curve: { interp: 'smooth', clamp: [0, 100] } };
    const spec = resolveCurveSpec(schemaEntry, { curve: { interp: 'step' } });
    expect(spec.interp).to.equal('step');
    expect(spec.clamp).to.deep.equal([0, 100]);
  });

  it('字段级 quantize 覆盖 schema 级', () => {
    const spec = resolveCurveSpec({ curve: { quantize: 1 } }, { curve: { quantize: 0.25 } });
    expect(spec.quantize).to.equal(0.25);
  });

  it('非法 interp 回落到 linear', () => {
    const spec = resolveCurveSpec({ curve: { interp: 'bogus' } }, null);
    expect(spec.interp).to.equal('linear');
  });
});

describe('pluginCurve — 从 ext 收集', () => {
  const warnings = [];
  const schema = normalizeExtSchema({
    'example-demo': {
      note: {
        tension: { kind: 'curve', label: '张力' },
        vibrato: { kind: 'curve', curve: { interp: 'step' } },
        phonemes: { kind: 'phonemes', editable: false },
        other: { kind: 'number' },
      },
      curve: { interp: 'smooth', clamp: [0, 1] },
    },
  }, warnings);

  it('只收 kind=curve 且真的有数据的字段', () => {
    const curves = collectCurves(
      { 'example-demo': { tension: [[0, 0], [1, 1]], phonemes: ['l', 'a'], other: 3 } },
      schema,
      'note',
    );
    expect(curves.map((c) => c.field)).to.deep.equal(['tension']);
    expect(curves[0].label).to.equal('张力');
    expect(curves[0].spec.interp).to.equal('smooth');
  });

  it('字段级 interp 生效，且保留原始值以便原样回写', () => {
    const raw = [[0, 0], [1, 1]];
    const curves = collectCurves({ 'example-demo': { vibrato: raw } }, schema, 'note');
    expect(curves[0].spec.interp).to.equal('step');
    expect(curves[0].value).to.equal(raw);
  });

  it('没声明 schema / 没数据 / 只有坏数据时返回空数组', () => {
    expect(collectCurves({}, schema, 'note')).to.deep.equal([]);
    expect(collectCurves({ 'example-demo': {} }, schema, 'note')).to.deep.equal([]);
    expect(collectCurves({ 'example-demo': { tension: [[0, 1]] } }, schema, 'note')).to.deep.equal([]);
    expect(collectCurves({ 'x': { tension: [[0, 1], [1, 0]] } }, schema, 'note')).to.deep.equal([]);
  });

  it('同一 note 上多个插件 / 多个曲线字段都收', () => {
    const schema2 = normalizeExtSchema({
      a: { note: { c: { kind: 'curve' } } },
      b: { note: { d: { kind: 'curve' } } },
    }, []);
    const curves = collectCurves({ a: { c: [[0, 0], [1, 1]] }, b: { d: [[0, 1], [1, 0]] } }, schema2, 'note');
    expect(curves.map((x) => `${x.pluginId}.${x.field}`).sort()).to.deep.equal(['a.c', 'b.d']);
  });

  it('未声明 editable 视为只读', () => {
    const curves = collectCurves({ 'example-demo': { tension: [[0, 0], [1, 1]] } }, schema, 'note');
    expect(curves[0].editable).to.equal(false);
  });
});
