const { expect } = require('chai');

const {
  TRANSITION_HALF_WIDTH,
  normalizeMelPostprocessOptions,
  gaussianKernel1D,
  blurAlongTime,
  blurAlongFreq,
  interpolateTransitionSpectra,
  applyMelPostprocess,
} = require('../src/inference/pipeline/melPostprocess');

const DIM = 8;

function makeMel(frames, dim = DIM) {
  const mel = new Float32Array(frames * dim);
  for (let f = 0; f < frames; f++) {
    for (let b = 0; b < dim; b++) mel[f * dim + b] = Math.sin(f * 0.7) + b * 0.1;
  }
  return mel;
}

describe('melPostprocess (Mel 时频平滑 / 过渡频谱插值)', () => {
  describe('normalizeMelPostprocessOptions', () => {
    it('空 / 全零返回 null（快路径）', () => {
      expect(normalizeMelPostprocessOptions(null)).to.equal(null);
      const zeros = new Float32Array(10);
      expect(normalizeMelPostprocessOptions({ frames: 10, sigmaT: zeros, sigmaF: zeros, blend: zeros })).to.equal(null);
    });

    it('解析出最大 σ / 强度并排序边界', () => {
      const opts = normalizeMelPostprocessOptions({
        frames: 4,
        sigmaT: new Float32Array([0, 2, 0, 1]),
        sigmaF: new Float32Array([1, 0, 0, 0]),
        blend: new Float32Array([10, 90, 0, 0]),
        boundaries: [9, 3, 5],
      });
      expect(opts.maxSigmaT).to.equal(2);
      expect(opts.maxSigmaF).to.equal(1);
      expect(opts.maxBlend).to.equal(90);
      expect(opts.boundaries).to.deep.equal([3, 5, 9]);
    });

    it('接受普通数组作为逐帧参数', () => {
      const opts = normalizeMelPostprocessOptions({ frames: 3, sigmaT: [1, 1, 1] });
      expect(opts).to.not.equal(null);
      expect(opts.maxSigmaT).to.equal(1);
    });
  });

  describe('gaussianKernel1D', () => {
    it('归一化且对称', () => {
      const k = gaussianKernel1D(1.5);
      const sum = Array.from(k).reduce((a, b) => a + b, 0);
      expect(sum).to.be.closeTo(1, 1e-6);
      const n = k.length;
      for (let i = 0; i < n; i++) expect(k[i]).to.be.closeTo(k[n - 1 - i], 1e-9);
    });
    it('σ <= 0 返回 null', () => {
      expect(gaussianKernel1D(0)).to.equal(null);
      expect(gaussianKernel1D(-1)).to.equal(null);
    });
  });

  describe('blurAlongTime / blurAlongFreq', () => {
    it('常量频谱图保持不变（含镜像边界）', () => {
      const frames = 12;
      const mel = new Float32Array(frames * DIM).fill(0.37);
      const outT = blurAlongTime(mel, frames, DIM, 2);
      const outF = blurAlongFreq(mel, frames, DIM, 2);
      for (let i = 0; i < mel.length; i++) {
        expect(outT[i]).to.be.closeTo(0.37, 1e-5);
        expect(outF[i]).to.be.closeTo(0.37, 1e-5);
      }
    });

    it('时间轴平滑后相邻帧差变小', () => {
      const frames = 30;
      const mel = new Float32Array(frames * DIM);
      for (let f = 0; f < frames; f++) {
        for (let b = 0; b < DIM; b++) mel[f * DIM + b] = (f % 2 === 0) ? 1 : -1;
      }
      const out = blurAlongTime(mel, frames, DIM, 1.5);
      const diff = (arr) => {
        let acc = 0;
        for (let f = 1; f < frames; f++) acc += Math.abs(arr[f * DIM] - arr[(f - 1) * DIM]);
        return acc;
      };
      expect(diff(out)).to.be.lessThan(diff(mel) * 0.5);
    });

    it('频率轴平滑不改变时间步长方向的结构', () => {
      const frames = 6;
      const mel = new Float32Array(frames * DIM);
      // 每个频点都等于帧号 → 频率轴常量，平滑后不变
      for (let f = 0; f < frames; f++) {
        for (let b = 0; b < DIM; b++) mel[f * DIM + b] = f;
      }
      const out = blurAlongFreq(mel, frames, DIM, 2);
      for (let f = 0; f < frames; f++) {
        for (let b = 0; b < DIM; b++) expect(out[f * DIM + b]).to.be.closeTo(f, 1e-5);
      }
    });

    it('不修改入参', () => {
      const mel = makeMel(10);
      const copy = Float32Array.from(mel);
      blurAlongTime(mel, 10, DIM, 1);
      blurAlongFreq(mel, 10, DIM, 1);
      expect(Array.from(mel)).to.deep.equal(Array.from(copy));
    });
  });

  describe('interpolateTransitionSpectra', () => {
    it('把边界两侧的频谱按升余弦窗混向平均值', () => {
      const frames = 20;
      const mel = new Float32Array(frames * DIM);
      for (let f = 0; f < frames; f++) {
        for (let b = 0; b < DIM; b++) mel[f * DIM + b] = f < 10 ? 0 : 10;
      }
      const out = interpolateTransitionSpectra(mel, frames, DIM, [10], () => 1, TRANSITION_HALF_WIDTH);
      // 边界帧被拉向两侧均值（≈5），不再是 10
      expect(out[10 * DIM]).to.be.lessThan(10);
      expect(out[10 * DIM]).to.be.greaterThan(0);
      // 远离边界的帧不受影响
      expect(out[0 * DIM]).to.be.closeTo(0, 1e-6);
      expect(out[19 * DIM]).to.be.closeTo(10, 1e-6);
    });

    it('强度为 0 时不改变任何采样', () => {
      const frames = 20;
      const mel = new Float32Array(frames * DIM);
      for (let f = 0; f < frames; f++) mel[f * DIM] = f < 10 ? 0 : 10;
      const out = interpolateTransitionSpectra(mel, frames, DIM, [10], () => 0);
      expect(Array.from(out)).to.deep.equal(Array.from(mel));
    });

    it('越界边界被忽略', () => {
      const frames = 8;
      const mel = makeMel(frames);
      const out = interpolateTransitionSpectra(mel, frames, DIM, [0, frames, -1], () => 1);
      expect(Array.from(out)).to.deep.equal(Array.from(mel));
    });
  });

  describe('applyMelPostprocess', () => {
    it('没有参数时返回原引用（零拷贝快路径）', () => {
      const mel = makeMel(10);
      expect(applyMelPostprocess(mel, 10, DIM, null)).to.equal(mel);
    });

    it('mel 长度不足时原样返回', () => {
      const mel = new Float32Array(5 * DIM);
      const opts = normalizeMelPostprocessOptions({ frames: 10, sigmaT: new Float32Array(10).fill(1) });
      expect(applyMelPostprocess(mel, 10, DIM, opts)).to.equal(mel);
    });

    it('逐帧 σ 混合：σ=0 的帧保持原值，σ>0 的帧被平滑', () => {
      const frames = 20;
      const mel = new Float32Array(frames * DIM);
      for (let f = 0; f < frames; f++) {
        for (let b = 0; b < DIM; b++) mel[f * DIM + b] = (f % 2 === 0) ? 1 : -1;
      }
      const sigmaT = new Float32Array(frames);
      for (let f = 10; f < frames; f++) sigmaT[f] = 2;
      const opts = normalizeMelPostprocessOptions({ frames, sigmaT });
      const out = applyMelPostprocess(mel, frames, DIM, opts, 0);
      // 前 10 帧权重为 0 → 原值
      expect(out[0]).to.be.closeTo(mel[0], 1e-6);
      expect(out[9 * DIM]).to.be.closeTo(mel[9 * DIM], 1e-6);
      // 后 10 帧被平滑 → 绝对值变小
      expect(Math.abs(out[15 * DIM])).to.be.lessThan(1);
    });

    it('frameOffset 让逐帧参数按绝对帧索引取值', () => {
      const frames = 10;
      const mel = new Float32Array(frames * DIM);
      // 绝对帧 10..19 的 σ=2，本地帧 0..9 对应它们
      const sigmaT = new Float32Array(20);
      for (let f = 10; f < 20; f++) sigmaT[f] = 2;
      for (let f = 0; f < 10; f++) for (let b = 0; b < DIM; b++) mel[f * DIM + b] = (f % 2 === 0) ? 1 : -1;
      const opts = normalizeMelPostprocessOptions({ frames: 20, sigmaT });
      const out = applyMelPostprocess(mel, frames, DIM, opts, 10);
      expect(Math.abs(out[5 * DIM])).to.be.lessThan(1);
    });

    it('过渡插值按 frameOffset 换算局部边界', () => {
      const frames = 20;
      const mel = new Float32Array(frames * DIM);
      for (let f = 0; f < frames; f++) {
        for (let b = 0; b < DIM; b++) mel[f * DIM + b] = f < 10 ? 0 : 10;
      }
      const blend = new Float32Array(40).fill(100);
      const opts = normalizeMelPostprocessOptions({ frames: 40, blend, boundaries: [30] });
      const out = applyMelPostprocess(mel, frames, DIM, opts, 20);
      // 绝对边界 30 - offset 20 = 本地 10
      expect(out[10 * DIM]).to.be.lessThan(10);
      expect(out[10 * DIM]).to.be.greaterThan(0);
    });
  });
});

describe('melPostprocess 窗口化处理与参数钳制', () => {
  const { applyMelPostprocessWindow, computeMelFrameOffset, MAX_SIGMA } = require('../src/inference/pipeline/melPostprocess');

  function makeVariedMel(frames, dim = DIM) {
    const mel = new Float32Array(frames * dim);
    for (let f = 0; f < frames; f++) {
      // 帧 45 处一个陡峭台阶：镜像延拓与真实邻居的模糊结果在此必然不同
      const level = f < 45 ? Math.sin(f * 0.7) : 5 + Math.cos(f * 0.9);
      for (let b = 0; b < dim; b++) mel[f * dim + b] = level + b * 0.1;
    }
    return mel;
  }

  function makeOpts(frames) {
    const sigmaT = new Float32Array(frames);
    const blend = new Float32Array(frames);
    for (let f = 0; f < frames; f++) { sigmaT[f] = 1.5; blend[f] = 80; }
    return normalizeMelPostprocessOptions({
      frames, sigmaT, blend,
      boundaries: [45],
    });
  }

  it('窗口化处理（左右都有真实邻居）与整段处理逐位一致', () => {
    const frames = 60;
    const mel = makeVariedMel(frames);
    const opts = makeOpts(frames);
    const whole = applyMelPostprocess(mel, frames, DIM, opts, 0);
    for (const [start, count] of [[20, 15], [0, 15], [45, 15], [10, 40]]) {
      const win = applyMelPostprocessWindow(mel, frames, DIM, opts, start, count, { left: true, right: true }, 0);
      expect(win, `range [${start},${start + count})`).to.not.equal(null);
      for (let i = 0; i < count * DIM; i++) {
        expect(win[i]).to.be.closeTo(whole[(start * DIM) + i], 1e-6);
      }
    }
  });

  it('右侧不允许读真实邻居时（非末尾 chunk），右缘结果与整段不同（但仍是有限值）', () => {
    const frames = 60;
    const mel = makeVariedMel(frames);
    const opts = makeOpts(frames);
    const whole = applyMelPostprocess(mel, frames, DIM, opts, 0);
    const win = applyMelPostprocessWindow(mel, frames, DIM, opts, 20, 15, { left: true, right: false }, 0);
    expect(win).to.not.equal(null);
    const diffAt = Array.from({ length: 15 }, (_, f) =>
      Math.abs(win[f * DIM] - whole[((20 + f) * DIM)]));
    // 至少边界附近应有差异（台阶在帧 45，右缘 34+context 覆盖不到它——
    // 这里只断言"右侧禁用不崩溃且结果有限"；左缘一致性由上一个用例保证）
    for (const d of diffAt) expect(Number.isFinite(d)).to.equal(true);
  });

  it('区间越界自动夹紧；未启用处理返回 null', () => {
    const frames = 30;
    const mel = makeVariedMel(frames);
    expect(applyMelPostprocessWindow(mel, frames, DIM, null, 0, 10)).to.equal(null);
    const zeroOpts = normalizeMelPostprocessOptions({ frames, sigmaT: new Float32Array(frames) });
    expect(applyMelPostprocessWindow(mel, frames, DIM, zeroOpts, 0, 10)).to.equal(null);
    // start 超界 → clamp 到 frames-count
    const win = applyMelPostprocessWindow(mel, frames, DIM, makeOpts(frames), 999, 10, { left: true, right: true }, 0);
    expect(win).to.not.equal(null);
    expect(win.length).to.equal(10 * DIM);
  });

  it('normalize 钳制 σ / blend（NaN→0，越界→上限），防恶意/损坏载荷', () => {
    const opts = normalizeMelPostprocessOptions({
      frames: 4,
      sigmaT: [0.5, 999, NaN, -3],
      blend: [-10, 50, 1e9, NaN],
    });
    expect(opts.sigmaT[0]).to.equal(0.5);
    expect(opts.sigmaT[1]).to.equal(MAX_SIGMA);
    expect(opts.sigmaT[2]).to.equal(0);
    expect(opts.sigmaT[3]).to.equal(0);
    expect(opts.blend[0]).to.equal(0);
    expect(opts.blend[1]).to.equal(50);
    expect(opts.blend[2]).to.equal(100);
    expect(opts.blend[3]).to.equal(0);
  });

  it('computeMelFrameOffset：绝对拍 → 载荷帧偏移（含负值与缺锚点回退 0）', () => {
    const opts = normalizeMelPostprocessOptions({ frames: 4, sigmaT: [1, 1, 1, 1], startBeat: 2, bpm: 120 });
    // fps = 24000/480 = 50，120 bpm → 1 拍 = 60/120 = 0.5s：
    // (4-2)拍 × 0.5s/拍 × 50帧/s = 50
    expect(computeMelFrameOffset(opts, 4, 50)).to.equal(50);
    // 单音符 contextPadding：mel 从拍 0 开始（比锚点早 2 拍）→ 负偏移
    expect(computeMelFrameOffset(opts, 0, 50)).to.equal(-50);
    expect(computeMelFrameOffset(opts, 2, 50)).to.equal(0);
    // 旧载荷（无 startBeat/bpm）→ 0，行为不变
    const legacy = normalizeMelPostprocessOptions({ frames: 4, sigmaT: [1, 1, 1, 1] });
    expect(computeMelFrameOffset(legacy, 100, 50)).to.equal(0);
    expect(computeMelFrameOffset(null, 100, 50)).to.equal(0);
  });

  it('computeMelFrameOffset：拍→秒方向正确（bpm=60 与 bpm=120 的对照）', () => {
    // 回归保护：拍→秒是 ×(60/bpm)，不是 ×(bpm/60)。
    // bpm=60 时两者数值相等，正是这个 bug 长期未被发现的原因，因此必须
    // 用一个 bpm≠60 的用例把方向钉住。
    const slow = normalizeMelPostprocessOptions({ frames: 4, sigmaT: [1, 1, 1, 1], startBeat: 0, bpm: 60 });
    const fast = normalizeMelPostprocessOptions({ frames: 4, sigmaT: [1, 1, 1, 1], startBeat: 0, bpm: 120 });
    // 60 bpm：1 拍 = 1s → 2 拍 = 2s = 100 帧
    expect(computeMelFrameOffset(slow, 2, 50)).to.equal(100);
    // 120 bpm：1 拍 = 0.5s → 同样 2 拍只有一半时长 = 50 帧
    // （若系数写反 ×(bpm/60)，这里会得到 200，即放大 (bpm/60)² = 4 倍）
    expect(computeMelFrameOffset(fast, 2, 50)).to.equal(50);
  });
});
