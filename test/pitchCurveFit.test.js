/**
 * 阶段 2：F0 → 锚点的"求值域拟合"（shared/pitchCurveFit.js）。
 *
 * 旧算法（RDP + 固定 strength=80/smoothness）的误差模型假设曲线穿过锚点，
 * 与真实求值（eff 拉向基线 + easeSegment 缓动）不符。这里用合成信号钉死：
 *   · 直线 / 滑音 / S 曲线：max 误差 ≤ 容差，且点数远少于分桶候选数；
 *   · 5.5Hz 颤音：自相关检出区域、按 ~1/4 周期保点、幅度不被抹平
 *     （颤音是例外区，不做参数优化，误差界为线性插值的弦高而非拟合容差）；
 *   · 噪声 + 倍频毛刺（经中值/SG 滤波后）：strength 搜索压掉毛刺，误差 ≤ 容差；
 *   · effAt 公式与真源 buildEffectiveValues 逐位一致（拟合器的数学前提）；
 *   · f0DataToSlipSegments：25 音分硬阈值 → "拟合误差超过容差的区间"。
 */
const { expect } = require('chai');
const {
  fitPitchCurveAnchors,
  anchorFitError,
  detectVibratoRegions,
} = require('../src/shared/pitchCurveFit.js');
const {
  f0DataToPitchCurveAnchorPoints,
  f0DataToSlipSegments,
} = require('../src/renderer/f0Utils.js');
const { medianFilterFrames, savitzkyGolayFilter } = require('../src/fragmentEditor/f0Smoothing.js');
const { buildEffectiveValues, evalSortedCurve } = require('../src/fragmentEditor/automationCurve.js');

const BPM = 120;
const BD = 60 / BPM; // 每拍秒数
const FPS = 50;      // 24kHz / 480 hop

/** 合成逐帧参考：fn(t 秒) → MIDI 半音；time 单位 = 拍。 */
function mkRef(fn, sec) {
  const ref = [];
  for (let i = 0; i < sec * FPS; i++) {
    const t = i / FPS;
    ref.push({ time: t / BD, pitch: fn(t) });
  }
  return ref;
}

/** 与 f0Utils 相同的 40ms 分桶（候选锚点）。 */
function bucketize(ref, bucketSec = 0.04) {
  const bb = bucketSec / BD;
  const m = new Map();
  for (const f of ref) {
    const k = Math.floor(f.time / bb);
    let b = m.get(k);
    if (!b) { b = { s: 0, t: 0, c: 0 }; m.set(k, b); }
    b.s += f.pitch; b.t += f.time; b.c++;
  }
  return [...m.values()].map((b) => ({ time: b.t / b.c, pitch: b.s / b.c })).sort((a, b) => a.time - b.time);
}

/** 参考 → f0Data（秒 / Hz），供 f0Utils 适配器测试。 */
function refToF0Data(ref) {
  return ref.map((f) => ({ time: f.time * BD, f0: 440 * Math.pow(2, (f.pitch - 69) / 12) }));
}

const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

describe('pitchCurveFit — 求值域拟合', () => {
  it('直线：2 个锚点即可，误差 ≈ 0', () => {
    const ref = mkRef(() => 60, 4);
    const points = bucketize(ref);
    const r = fitPitchCurveAnchors({ points, reference: ref, bpm: BPM, toleranceCents: 6 });
    expect(r.anchors.length).to.be.at.most(4);
    expect(r.maxErrCents).to.be.at.most(6);
    expect(r.maxErrCents).to.be.at.most(0.01);
  });

  it('线性滑音：误差 ≤ 容差，点数远少于候选', () => {
    const ref = mkRef((t) => (t < 2 ? 60 + 3.5 * t : 67), 4);
    const points = bucketize(ref);
    const r = fitPitchCurveAnchors({ points, reference: ref, bpm: BPM, toleranceCents: 6 });
    expect(r.maxErrCents).to.be.at.most(6);
    expect(r.anchors.length).to.be.at.most(10);
    expect(r.anchors.length).to.be.below(points.length / 5);
  });

  it('S 曲线（smoothstep 换音）：误差 ≤ 容差', () => {
    const ref = mkRef((t) => 60 + 4 * smoothstep(t - 1), 4);
    const points = bucketize(ref);
    const r = fitPitchCurveAnchors({ points, reference: ref, bpm: BPM, toleranceCents: 6 });
    expect(r.maxErrCents).to.be.at.most(6);
    expect(r.anchors.length).to.be.below(points.length / 4);
    // smoothness 应由搜索选出非零值（S 形过渡不是折线）
    expect(r.anchors.some((a) => a.smoothness > 0)).to.equal(true);
  });

  it('5.5Hz 颤音：检出区域、~1/4 周期保点、幅度保留 ≥ 75%', () => {
    const depth = 0.3; // ±30 音分
    const fn = (t) => 60 + depth * Math.sin(2 * Math.PI * 5.5 * t);
    const ref = mkRef(fn, 2);
    const points = bucketize(ref);
    const r = fitPitchCurveAnchors({ points, reference: ref, bpm: BPM, toleranceCents: 6 });
    expect(r.vibratoRegions.length).to.be.at.least(1);
    expect(r.vibratoRegions[0].rate).to.be.within(4.5, 6.5);
    // 保点间隔 ≤ 1.5 × 1/4 周期（桶距 40ms ≈ 1/4 周期 45ms）
    const quarter = BPM / (60 * 5.5 * 4);
    const inRegion = r.anchors.filter((a) => a.time >= r.vibratoRegions[0].start && a.time <= r.vibratoRegions[0].end);
    for (let i = 1; i < inRegion.length; i++) {
      expect(inRegion[i].time - inRegion[i - 1].time).to.be.at.most(quarter * 1.5);
    }
    // 颤音锚点不做参数优化：strength=100 / smoothness=0
    for (const a of inRegion.slice(1, -1)) {
      expect(a.strength).to.equal(100);
    }
    // 幅度不被抹平：真源求值的峰峰值 ≥ 75% 参考峰峰值
    const sorted = r.anchors.slice().sort((a, b) => a.time - b.time);
    const eff = buildEffectiveValues(sorted, 'pitch');
    let lo = Infinity, hi = -Infinity;
    for (const f of ref) {
      const v = evalSortedCurve(sorted, eff, f.time);
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    expect(hi - lo).to.be.at.least(2 * depth * 0.75);
    // 颤音例外区误差界 = 弦高（1−cos(π/4) ≈ 0.293×幅度）+ 分桶衰减裕量
    expect(r.maxErrCents).to.be.at.most(depth * 100 * 0.45);
    // 等距抽样砍峰的反例守护：保点数应接近桶数，而不是被预算抽稀
    expect(inRegion.length).to.be.at.least(points.length * 0.7);
  });

  it('纯颤音检测：无调制 / 慢漂移不误报', () => {
    expect(detectVibratoRegions(mkRef(() => 60, 2), BPM)).to.deep.equal([]);
    expect(detectVibratoRegions(mkRef((t) => 60 + t, 2), BPM)).to.deep.equal([]);
  });

  it('噪声 + 倍频毛刺（滤波后参考）：strength 压毛刺，误差 ≤ 容差', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const n = 4 * FPS;
    const hz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let midi = 60 + (rnd() - 0.5) * 0.1;
      if (i % 37 === 0) midi += (rnd() > 0.5 ? 1 : -1) * 1.5;
      hz[i] = 440 * Math.pow(2, (midi - 69) / 12);
    }
    let filtered = medianFilterFrames(hz, 5, 9);
    filtered = savitzkyGolayFilter(filtered, { window: 7, order: 3 });
    const ref = [];
    for (let i = 0; i < n; i++) {
      if (filtered[i] > 0) ref.push({ time: (i / FPS) / BD, pitch: 69 + 12 * Math.log2(filtered[i] / 440) });
    }
    const points = bucketize(ref);
    const r = fitPitchCurveAnchors({ points, reference: ref, bpm: BPM, toleranceCents: 6 });
    expect(r.maxErrCents).to.be.at.most(6);
    expect(r.anchors.length).to.be.at.most(10);
  });

  it('点数预算：maxAnchors 生效且首尾保留', () => {
    const ref = mkRef((t) => 60 + 2 * Math.sin(2 * Math.PI * 0.7 * t) + 0.5 * Math.sin(2 * Math.PI * 1.9 * t), 8);
    const points = bucketize(ref);
    const r = fitPitchCurveAnchors({ points, reference: ref, bpm: BPM, toleranceCents: 2, maxAnchors: 20 });
    expect(r.anchors.length).to.be.at.most(20);
    expect(r.anchors[0].time).to.equal(points[0].time);
    expect(r.anchors[r.anchors.length - 1].time).to.equal(points[points.length - 1].time);
  });

  it('点数预算：颤音保点使预算不可达时保真优先（不删崩滑音）', () => {
    // 前 2s 换音滑音 + 后 2s 颤音；预算 10 远小于颤音保点数
    const fn = (t) => {
      if (t < 1) return 60;
      if (t < 1.5) return 60 + 4 * smoothstep((t - 1) / 0.5);
      if (t < 2) return 64;
      return 64 + 0.3 * Math.sin(2 * Math.PI * 5.5 * t);
    };
    const ref = mkRef(fn, 4);
    const points = bucketize(ref);
    const r = fitPitchCurveAnchors({ points, reference: ref, bpm: BPM, toleranceCents: 6, maxAnchors: 10 });
    expect(r.anchors.length).to.be.above(10); // 软上限：颤音保点优先
    expect(r.maxErrCents).to.be.at.most(15); // 误差不被贪心删点放大到滑音量级
  });

  it('effAt 数学前提：与真源 buildEffectiveValues 逐位一致', () => {
    // 拟合器内部的 O(1) effAt 公式在这里复刻，与真源比对钉死
    const effAt = (pts, i) => {
      if (i <= 0 || i >= pts.length - 1) return pts[i].pitch;
      const st = pts[i].strength;
      if (!(st < 100)) return pts[i].pitch;
      const prev = pts[i - 1], next = pts[i + 1];
      const span = next.time - prev.time;
      if (!(span > 0)) return pts[i].pitch;
      const w = (pts[i].time - prev.time) / span;
      const base = prev.pitch + (next.pitch - prev.pitch) * w;
      return base + (pts[i].pitch - base) * (st / 100);
    };
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pts = [];
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += 0.05 + rnd() * 0.3;
      pts.push({ time: t, pitch: 55 + rnd() * 15, strength: Math.round(rnd() * 100), smoothness: 0 });
    }
    const eff = buildEffectiveValues(pts, 'pitch');
    for (let i = 0; i < pts.length; i++) {
      expect(eff[i]).to.be.closeTo(effAt(pts, i), 1e-12);
    }
  });

  it('空输入 / 全清音返回空', () => {
    expect(fitPitchCurveAnchors({ points: [], reference: [], bpm: BPM }).anchors).to.deep.equal([]);
    expect(f0DataToPitchCurveAnchorPoints([], BPM)).to.deep.equal([]);
    expect(f0DataToPitchCurveAnchorPoints([{ time: 0, f0: 0 }, { time: 0.02, f0: 0 }], BPM)).to.deep.equal([]);
  });
});

describe('f0Utils 适配 — f0DataToPitchCurveAnchorPoints（求值域拟合）', () => {
  it('滑音 f0Data：锚点带搜索出的 strength/smoothness，真源误差 ≤ 容差', () => {
    const ref = mkRef((t) => 60 + 4 * smoothstep(t - 1), 4);
    const notes = [{ start: 0, duration: 4, pitch: 60 }, { start: 4, duration: 4, pitch: 64 }];
    const anchors = f0DataToPitchCurveAnchorPoints(refToF0Data(ref), BPM, { notes });
    expect(anchors.length).to.be.at.least(2);
    // 不再是固定 strength=80 / 密度 smoothness
    expect(anchors.every((a) => a.strength === 80)).to.equal(false);
    const err = anchorFitError(anchors, ref);
    expect(err.maxErrCents).to.be.at.most(7); // 滤波对 smoothstep 影响 < 1 音分
  });

  it('toleranceCents 选项生效：更小容差 → 更多锚点', () => {
    const ref = mkRef((t) => 60 + 2 * Math.sin(2 * Math.PI * 0.7 * t) + 0.5 * Math.sin(2 * Math.PI * 1.9 * t), 8);
    const f0Data = refToF0Data(ref);
    const loose = f0DataToPitchCurveAnchorPoints(f0Data, BPM, { toleranceCents: 20 });
    const tight = f0DataToPitchCurveAnchorPoints(f0Data, BPM, { toleranceCents: 4 });
    expect(tight.length).to.be.above(loose.length);
  });
});

describe('f0DataToSlipSegments — 拟合误差超容差的区间（替代 ±25 音分硬阈值）', () => {
  const notes = [{ start: 0, duration: 8, pitch: 60 }];

  it('平直演唱（容差内）：不生成派生段', () => {
    const ref = mkRef(() => 60.02, 4); // +2 音分，容差内
    const { segments } = f0DataToSlipSegments(refToF0Data(ref), BPM, notes);
    expect(segments).to.deep.equal([]);
  });

  it('滑音偏离音符：生成派生段且只覆盖偏离区间', () => {
    // 60 →（1s 内滑到 64）→ 滑回 60，其余平直
    const fn = (t) => {
      if (t < 1) return 60;
      if (t < 2) return 60 + 4 * (t - 1);
      if (t < 3) return 64 - 4 * (t - 2);
      return 60;
    };
    const ref = mkRef(fn, 4);
    const { segments, anchors, keptRatio } = f0DataToSlipSegments(refToF0Data(ref), BPM, notes);
    expect(segments.length).to.be.at.least(1);
    expect(keptRatio).to.be.above(0);
    expect(keptRatio).to.be.below(1);
    for (const s of segments) {
      expect(s.origin).to.equal('f0-import');
      expect(s.points.length).to.be.at.least(2);
      expect(s.start).to.be.at.most(s.end);
    }
    expect(anchors.length).to.be.at.least(2);
  });

  it('小偏差（10 音分）也被保留：阈值跟随容差而非 25 音分', () => {
    const ref = mkRef((t) => (t >= 1 && t < 2 ? 60.1 : 60), 4); // +10 音分区间
    const { segments } = f0DataToSlipSegments(refToF0Data(ref), BPM, notes);
    expect(segments.length).to.be.at.least(1);
    // 显式覆盖阈值仍可关掉它
    const off = f0DataToSlipSegments(refToF0Data(ref), BPM, notes, { slipThresholdCents: 50 });
    expect(off.segments).to.deep.equal([]);
  });
});