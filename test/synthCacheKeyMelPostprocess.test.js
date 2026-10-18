/**
 * 合成缓存键必须感知 melPostprocess（频谱后处理曲线）。
 *
 * 背景：melPostprocess 直接改写 vocoder 输入的 mel，但 computeSynthCacheKey
 * 没有把它纳入哈希 —— "只改曲线"会命中旧缓存返回改前音频，且渲染层会把
 * 旧音频打上新签名，之后一直复用。这里钉死：载荷任一部分变化 → 键变化。
 */
const { expect } = require('chai');
const { AudioSegmentation } = require('../src/inference/pipeline/audioSegmentation.js');

function payload(overrides = {}) {
  return {
    frames: 101,
    sigmaT: new Float32Array(101).fill(1.2),
    sigmaF: new Float32Array(101).fill(0.6),
    blend: new Float32Array(101).fill(45),
    boundaries: Uint32Array.from([50]),
    startBeat: 2,
    bpm: 120,
    ...overrides,
  };
}

describe('computeSynthCacheKey 感知 melPostprocess', () => {
  const seg = new AudioSegmentation();
  const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 2 }];
  const baseOpts = { nSteps: 32, cfg: 3.0, cfgRescale: 0.7 };

  it('未启用（无 melPostprocess）时键与旧行为一致并含 mpoff', () => {
    const key = seg.computeSynthCacheKey(notes, 120, baseOpts);
    expect(key).to.contain('_mpoff');
  });

  it('载荷相同 → 键相同；任一部分变化 → 键变化', () => {
    const k1 = seg.computeSynthCacheKey(notes, 120, { ...baseOpts, melPostprocess: payload() });
    const k2 = seg.computeSynthCacheKey(notes, 120, { ...baseOpts, melPostprocess: payload() });
    expect(k1).to.equal(k2);

    const variants = {
      sigmaT: payload({ sigmaT: new Float32Array(101).fill(2.0) }),
      sigmaF: payload({ sigmaF: new Float32Array(101).fill(0.8) }),
      blend: payload({ blend: new Float32Array(101).fill(70) }),
      boundaries: payload({ boundaries: Uint32Array.from([25]) }),
      frames: payload({ frames: 120, sigmaT: new Float32Array(120).fill(1.2) }),
      startBeat: payload({ startBeat: 4 }),
      bpm: payload({ bpm: 90 }),
    };
    for (const [name, p] of Object.entries(variants)) {
      const k = seg.computeSynthCacheKey(notes, 120, { ...baseOpts, melPostprocess: p });
      expect(k, `变化 ${name} 后缓存键必须不同`).to.not.equal(k1);
    }
  });

  it('启用与关闭的键不同', () => {
    const off = seg.computeSynthCacheKey(notes, 120, baseOpts);
    const on = seg.computeSynthCacheKey(notes, 120, { ...baseOpts, melPostprocess: payload() });
    expect(on).to.not.equal(off);
  });
});

describe('computeMelCacheKey 与 melPostprocess 无关（mel 级缓存合约）', () => {
  const seg = new AudioSegmentation();
  const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 2 }];
  const baseOpts = { nSteps: 32, cfg: 3.0, cfgRescale: 0.7 };

  it('音色曲线（melPostprocess）任一部分变化 → mel 键不变、音频键变化', () => {
    const melOff = seg.computeMelCacheKey(notes, 120, baseOpts);
    const melOn = seg.computeMelCacheKey(notes, 120, { ...baseOpts, melPostprocess: payload() });
    expect(melOn).to.equal(melOff);

    const variants = {
      sigmaT: payload({ sigmaT: new Float32Array(101).fill(2.0) }),
      sigmaF: payload({ sigmaF: new Float32Array(101).fill(0.8) }),
      blend: payload({ blend: new Float32Array(101).fill(70) }),
      boundaries: payload({ boundaries: Uint32Array.from([25]) }),
    };
    for (const [name, p] of Object.entries(variants)) {
      const opts = { ...baseOpts, melPostprocess: p };
      expect(seg.computeMelCacheKey(notes, 120, opts), `变化 ${name} 后 mel 键必须不变`).to.equal(melOff);
      expect(seg.computeSynthCacheKey(notes, 120, opts), `变化 ${name} 后音频键必须不同`).to.not.equal(
        seg.computeSynthCacheKey(notes, 120, baseOpts)
      );
    }
  });

  it('音频键 = mel 键 + mp 段（构成合约）', () => {
    const opts = { ...baseOpts, melPostprocess: payload() };
    const synth = seg.computeSynthCacheKey(notes, 120, opts);
    expect(synth).to.equal(`${seg.computeMelCacheKey(notes, 120, opts)}_mp${seg.computeMelPostprocessHash(opts)}`);
  });

  it('音高曲线变化 → mel 键变化（音高作用于 diffstep，必须重新推理）', () => {
    const a = seg.computeMelCacheKey(notes, 120, { ...baseOpts, pitchCurveF0: [100, 110, 120] });
    const b = seg.computeMelCacheKey(notes, 120, { ...baseOpts, pitchCurveF0: [100, 110, 125] });
    expect(b).to.not.equal(a);
  });

  it('segment 级 mel 键与音频键同样满足"与 melPostprocess 无关"', () => {
    const k1 = seg.computeSegmentMelKey(notes, 120, baseOpts, 4, 0, 10);
    const k2 = seg.computeSegmentMelKey(notes, 120, { ...baseOpts, melPostprocess: payload() }, 4, 0, 10);
    expect(k2).to.equal(k1);
    const s1 = seg.computeSegmentCacheKey(notes, 120, baseOpts, 4, 0, 10);
    const s2 = seg.computeSegmentCacheKey(notes, 120, { ...baseOpts, melPostprocess: payload() }, 4, 0, 10);
    expect(s2).to.not.equal(s1);
  });
});
