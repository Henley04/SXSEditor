const { expect } = require('chai');

const {
  hzToCents,
  centsToHz,
  buildVoicedRuns,
  savitzkyGolayCoefficients,
  savitzkyGolayFilter,
  medianFilterFrames,
  findPitchJumps,
  cubicBezierY,
  applyBezierTransitions,
  applyF0Postprocess,
} = require('../src/fragmentEditor/f0Smoothing');

const SR = 24000;
const HOP = 480; // 20ms / 帧

function rampF0(frames, startHz, centsPerFrame) {
  const f0 = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    f0[i] = startHz * Math.pow(2, (i * centsPerFrame) / 1200);
  }
  return f0;
}

describe('f0Smoothing (F0 中值 / Savitzky-Golay / 贝塞尔过渡)', () => {
  describe('cents 转换', () => {
    it('往返无损', () => {
      for (const hz of [55, 220, 440, 880, 1760]) {
        expect(centsToHz(hzToCents(hz))).to.be.closeTo(hz, 1e-9);
      }
    });
  });

  describe('buildVoicedRuns', () => {
    it('把 0 帧切分为静音边界', () => {
      const f0 = new Float32Array([0, 220, 220, 0, 0, 330, 0]);
      expect(buildVoicedRuns(f0)).to.deep.equal([
        { start: 1, end: 3 },
        { start: 5, end: 6 },
      ]);
    });
  });

  describe('Savitzky-Golay', () => {
    it('window=7/order=3 的系数与教科书一致', () => {
      const k = savitzkyGolayCoefficients(7, 3);
      const expected = [-2, 3, 6, 7, 6, 3, -2].map((v) => v / 21);
      for (let i = 0; i < 7; i++) expect(k[i]).to.be.closeTo(expected[i], 1e-9);
    });

    it('系数和为 1（直流增益为 1）', () => {
      for (const [w, o] of [[5, 2], [7, 3], [9, 3], [11, 5]]) {
        const k = savitzkyGolayCoefficients(w, o);
        const sum = Array.from(k).reduce((a, b) => a + b, 0);
        expect(sum).to.be.closeTo(1, 1e-9);
      }
    });

    it('线性斜坡（等 cents 步进）被完整保留', () => {
      const f0 = rampF0(41, 220, 10);
      const out = savitzkyGolayFilter(f0, { window: 7, order: 3 });
      for (let i = 4; i < 37; i++) {
        expect(hzToCents(out[i])).to.be.closeTo(hzToCents(f0[i]), 1e-6);
      }
    });

    it('抑制帧间抖动：交替锯齿的方差显著下降', () => {
      const frames = 60;
      const f0 = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        f0[i] = 220 * Math.pow(2, ((i % 2 === 0 ? 25 : -25)) / 1200);
      }
      const out = savitzkyGolayFilter(f0, { window: 7, order: 3 });
      const variance = (arr) => {
        const cents = Array.from(arr, hzToCents);
        const mean = cents.reduce((a, b) => a + b, 0) / cents.length;
        return cents.reduce((a, b) => a + (b - mean) ** 2, 0) / cents.length;
      };
      expect(variance(out)).to.be.lessThan(variance(f0) * 0.1);
    });

    it('不跨越静音段，也不把 0 变成非 0', () => {
      const f0 = new Float32Array(20);
      f0.fill(220, 2, 8);
      f0.fill(330, 12, 18);
      const out = savitzkyGolayFilter(f0, { window: 7, order: 3 });
      expect(out[0]).to.equal(0);
      expect(out[10]).to.equal(0);
      expect(out[19]).to.equal(0);
      expect(out[4]).to.be.greaterThan(0);
    });
  });

  describe('中值滤波', () => {
    it('消除孤立尖峰', () => {
      const f0 = new Float32Array(21).fill(220);
      f0[10] = 660;
      const out = medianFilterFrames(f0, 5);
      expect(out[10]).to.be.closeTo(220, 1e-6);
    });

    it('窗口 < 3 时不做任何修改', () => {
      const f0 = new Float32Array(21).fill(220);
      f0[10] = 660;
      const out = medianFilterFrames(f0, 1);
      expect(out[10]).to.equal(660);
    });

    it('窗口内跳过静音帧，避免把音符起音拉低', () => {
      const f0 = new Float32Array(9);
      f0.fill(440, 4, 9); // 前 4 帧静音
      const out = medianFilterFrames(f0, 5);
      expect(out[4]).to.be.closeTo(440, 1e-6);
    });

    it('支持逐帧窗口数组', () => {
      const f0 = new Float32Array(21).fill(220);
      f0[10] = 660;
      const windows = new Float32Array(21).fill(0);
      for (let i = 5; i <= 15; i++) windows[i] = 5;
      const out = medianFilterFrames(f0, windows, 9);
      expect(out[10]).to.be.closeTo(220, 1e-6);
      // 窗口为 0 的帧保持原值
      expect(out[0]).to.equal(220);
    });
  });

  describe('findPitchJumps', () => {
    it('识别音程跳变点', () => {
      const f0 = new Float32Array(20).fill(220);
      f0.fill(330, 10);
      const jumps = findPitchJumps(f0);
      expect(jumps).to.have.length(1);
      expect(jumps[0].index).to.equal(10);
    });
    it('渐变滑音不算跳变', () => {
      const f0 = rampF0(40, 220, 10); // 每帧 10 音分
      expect(findPitchJumps(f0)).to.have.length(0);
    });
    it('静音边界不算跳变', () => {
      const f0 = new Float32Array(20);
      f0.fill(220, 0, 10);
      f0.fill(330, 10, 20);
      f0.fill(0, 0, 3);
      const jumps = findPitchJumps(f0);
      expect(jumps).to.have.length(1); // 只有 9→10 这一处（3 之前是静音，跳过）
      expect(jumps[0].index).to.equal(10);
    });
  });

  describe('三次贝塞尔', () => {
    it('端点精确', () => {
      expect(cubicBezierY(0, 0, 100, 100, 50)).to.be.closeTo(0, 1e-9);
      expect(cubicBezierY(1, 0, 100, 100, 50)).to.be.closeTo(50, 1e-9);
    });
    it('x 单调 → y 单调上升（控制点不越过区间时）', () => {
      const ys = [];
      for (let i = 0; i <= 10; i++) ys.push(cubicBezierY(i / 10, 0, 20, 80, 100));
      for (let i = 1; i < ys.length; i++) expect(ys[i]).to.be.greaterThan(ys[i - 1]);
    });
  });

  describe('applyBezierTransitions', () => {
    it('把阶跃替换为先过冲再回落的过渡', () => {
      const frames = 120;
      const f0 = new Float32Array(frames).fill(220);
      f0.fill(330, 60);
      const out = applyBezierTransitions(f0, {
        getStrength: () => 100,
        getDurationMs: () => 160,
        sampleRate: SR,
        hopSize: HOP,
      });
      // 目标音高
      const targetCents = hzToCents(330);
      // 过渡区内出现过冲（超过目标）
      let maxCents = -Infinity;
      for (let i = 40; i < 80; i++) maxCents = Math.max(maxCents, hzToCents(out[i]));
      expect(maxCents).to.be.greaterThan(targetCents);
      // 过渡结束后回到目标
      expect(hzToCents(out[110])).to.be.closeTo(targetCents, 1e-6);
      // 过渡区起点仍为原音高
      expect(hzToCents(out[50])).to.be.closeTo(hzToCents(220), 1e-6);
    });

    it('强度为 0 时完全不处理（保留机械跳变）', () => {
      const f0 = new Float32Array(60).fill(220);
      f0.fill(330, 30);
      const out = applyBezierTransitions(f0, {
        getStrength: () => 0,
        getDurationMs: () => 200,
        sampleRate: SR,
        hopSize: HOP,
      });
      expect(Array.from(out)).to.deep.equal(Array.from(f0));
    });

    it('过渡跨过静音段时不会把 0 变成有声', () => {
      const f0 = new Float32Array(60);
      f0.fill(220, 0, 25);
      f0.fill(330, 30, 60);
      const out = applyBezierTransitions(f0, {
        getStrength: () => 100,
        getDurationMs: () => 300,
        sampleRate: SR,
        hopSize: HOP,
      });
      for (let i = 25; i < 30; i++) expect(out[i]).to.equal(0);
    });
  });

  describe('applyF0Postprocess', () => {
    it('全部参数为 0 时结果与输入数值一致', () => {
      const f0 = rampF0(40, 220, 5);
      const zeros = new Float32Array(40);
      const out = applyF0Postprocess(f0, { smooth: zeros, median: zeros, glide: zeros, glideMs: zeros }, { sampleRate: SR, hopSize: HOP });
      expect(Array.from(out)).to.deep.equal(Array.from(f0));
    });

    it('开启平滑后抖动被压低，静音帧仍为 0', () => {
      const frames = 60;
      const f0 = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        f0[i] = 220 * Math.pow(2, ((i % 2 === 0 ? 30 : -30)) / 1200);
      }
      f0.fill(0, 0, 3);
      const smooth = new Float32Array(frames).fill(80);
      const zeros = new Float32Array(frames);
      const out = applyF0Postprocess(f0, { smooth, median: zeros, glide: zeros, glideMs: zeros }, { sampleRate: SR, hopSize: HOP });
      expect(out[0]).to.equal(0);
      expect(out[2]).to.equal(0);
      expect(Math.abs(hzToCents(out[30]) - hzToCents(220))).to.be.lessThan(15);
    });

    it('空输入原样返回', () => {
      expect(applyF0Postprocess(new Float32Array(0), null, {})).to.have.length(0);
    });
  });
});

describe('findPitchJumps 颤音免疫（回归）', () => {
  // 背景：旧实现用"相邻帧 > 25 音分"判跳变，正常颤音（5.5Hz ±40 音分）的
  // 帧间斜率即可达 ~34 音分/帧，导致颤音被贝塞尔过渡逐周期揉平（实测 6 秒
  // 误报 71 次、颤音峰峰值 80→66 音分）。现改为"50 音分初筛 + 远离两侧
  // 中值台阶 ≥75 音分确认"，颤音必须完全免疫。
  const mkVibrato = (vibHz, depthCents, frames = 300) => {
    const f0 = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      f0[i] = 440 * Math.pow(2, (Math.sin(2 * Math.PI * vibHz * i / 50) * depthCents) / 1200);
    }
    return f0;
  };

  for (const [hz, depth] of [[5.5, 40], [6.5, 60], [7, 80], [6, 100]]) {
    it(`颤音 ${hz}Hz ±${depth} 音分不产生任何"跳变"`, () => {
      expect(findPitchJumps(mkVibrato(hz, depth))).to.have.length(0);
    });
    it(`颤音 ${hz}Hz ±${depth} 音分在 50% 过冲下逐帧不变`, () => {
      const f0 = mkVibrato(hz, depth);
      const out = applyBezierTransitions(f0, {
        getStrength: () => 50,
        getDurationMs: () => 140,
        sampleRate: SR,
        hopSize: HOP,
      });
      const cents = Array.from(out, hzToCents);
      const orig = Array.from(f0, hzToCents);
      const meanErr = cents.reduce((a, v, i) => a + Math.abs(v - orig[i]), 0) / cents.length;
      expect(meanErr, '颤音不应被过渡改写').to.be.lessThan(0.5);
      const range = (a) => Math.max(...a) - Math.min(...a);
      expect(range(cents)).to.be.closeTo(range(orig), 1);
    });
  }

  it('半音级跳变仍被检出（不吃掉真实的音程台阶）', () => {
    const f0 = new Float32Array(60).fill(220);
    f0.fill(330, 30);
    const jumps = findPitchJumps(f0);
    expect(jumps).to.have.length(1);
    expect(jumps[0].index).to.equal(30);
    expect(jumps[0].cents).to.be.greaterThan(700); // 220→330 ≈ 702 音分
  });

  it('连续两个音程台阶都检出', () => {
    const f0 = new Float32Array(120).fill(220);
    f0.fill(330, 40);
    f0.fill(440, 80);
    const jumps = findPitchJumps(f0);
    expect(jumps.map((j) => j.index)).to.deep.equal([40, 80]);
  });
});
