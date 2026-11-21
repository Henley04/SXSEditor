'use strict';
/**
 * 缓存键拆分的性能重构守护测试。
 *
 * 背景：computeMelCacheKey 里的 reference WAV / F0 曲线 / prompt cond 哈希很贵，
 * 但它们只取决于 bpm + options，与 notes 无关。拆分前：
 *   · 缓存命中检查把 synth/mel 两个键各算一遍（2× 昂贵哈希）；
 *   · 长音频 N 个 segment 在首个 chunk 前，对每个 segment 又各算 synth/mel 两遍（2N×）。
 * 这两处正是「缓存命中可见延迟 / 分片启动延迟」的来源。
 *
 * 拆分后：computeNotesHash(notes) + computeOptionKeyPart(bpm,options) 拼出完整 mel 键，
 * computeCacheKeyParts() 一次返回 synth/mel 两键，_computeSegmentKeyBatch() 批量建段键。
 *
 * 约束：所有派生键必须与拆分前**逐字节一致**，否则老缓存会命中错误音频。
 * 下方金值取自拆分前的实现（由 /tmp/gen_golden.cjs 生成并 diff 验证）。
 */
const { expect } = require('chai');
const { AudioSegmentation } = require('../src/inference/pipeline/audioSegmentation.js');
const { OnnxSVSPipeline } = require('../src/inference/pipeline/index.js');
const { computePromptCondSignature } = require('../src/shared/promptCondSignature.js');

const GOLDEN = {
  empty: {
    mel: '0_120_0_0_0_p0_0_0_0_0_32_3_0.75_false_0_base_noid_dc0_0_0_ss0_pcmanual_pmbase_bebuiltin_jpm4',
    synth: '0_120_0_0_0_p0_0_0_0_0_32_3_0.75_false_0_base_noid_dc0_0_0_ss0_pcmanual_pmbase_bebuiltin_jpm4_mpoff',
  },
  basic: {
    mel: '-861480846_120_0_0_0_p0_0_0_0_0_32_3_0.75_false_0_base_noid_dc0_0_0_ss0_pcmanual_pmbase_bebuiltin_jpm4',
    synth: '-861480846_120_0_0_0_p0_0_0_0_0_32_3_0.75_false_0_base_noid_dc0_0_0_ss0_pcmanual_pmbase_bebuiltin_jpm4_mpoff',
  },
  full: {
    mel: '1713188348_137.5_204989941_-1968941887_2007683831_p-1775776066_804296314_-1735048818_-926723977_80_30_3.5_0.8_true_2_ja_s1_dc1_500_50_ss1_pcscore_pmfp16_beplugin:p:k_jpm4_rt12345',
    synth: '1713188348_137.5_204989941_-1968941887_2007683831_p-1775776066_804296314_-1735048818_-926723977_80_30_3.5_0.8_true_2_ja_s1_dc1_500_50_ss1_pcscore_pmfp16_beplugin:p:k_jpm4_rt12345_mp10:0.5000:120:1226524137:1834319480:135440533:-759547432',
  },
};

function makeCases() {
  return [
    { name: 'empty', notes: [], bpm: 120, opts: {} },
    { name: 'basic', notes: [{ start: 0, duration: 1, lyric: 'a', pitch: 60 }], bpm: 120, opts: {} },
    {
      name: 'full',
      notes: [
        { start: 0, duration: 1, lyric: 'a', pitch: 60, isSlur: true, noteType: 3,
          phonemeAdjustments: [{ durationRatio: 1.2, offsetRatio: 0.1, volumePoints: [{ t: 0, v: 1 }, { t: 1, v: 0.8 }] }] },
        { start: 1, duration: 0.5, lyric: 'い', pitch: 67, noteType: 0 },
      ],
      bpm: 137.5,
      opts: {
        f0Envelope: { keyframes: [{ time: 0, value: 0.1 }, { time: 1, value: 0.9 }] },
        pitchCurveF0: new Float32Array([100, 220.5, -1, 0, 440]),
        refAudioWavBuffer: new Uint8Array([0, 1, 2, 255, 128, 64]),
        refSingerData: { text: 'ab', f0: '200', time: [0, 1] },
        refMidiNotes: [{ lyric: 'a', pitch: 60, start: 0, duration: 1, isSlur: false, noteType: 0 }],
        refF0Data: [{ f0: 200, time: 0 }, { f0: 210, time: 0.02 }],
        maxPromptFrames: 80, nSteps: 30, cfg: 3.5, cfgRescale: 0.8, autoShift: true, pitchShift: 2,
        language: 'ja', singerId: 's1', diffStepChunk: true, diffStepChunkFrames: 500,
        diffStepOverlapFrames: 50, smartSegmentation: true, pitchControl: 'score',
        modelPrecision: 'fp16', backend: { type: 'plugin', pluginId: 'p', kindId: 'k' }, retakeNonce: 12345,
        melPostprocess: { frames: 10, startBeat: 0.5, bpm: 120, sigmaT: [0.1, 0.2], sigmaF: [1, 2], blend: [0.5], boundaries: [0, 1] },
      },
    },
  ];
}

describe('缓存键拆分 — 黄金值逐字节一致', () => {
  const seg = new AudioSegmentation();

  for (const c of makeCases()) {
    it(`${c.name}: computeMelCacheKey / computeSynthCacheKey 与拆分前一致`, () => {
      expect(seg.computeMelCacheKey(c.notes, c.bpm, c.opts)).to.equal(GOLDEN[c.name].mel);
      expect(seg.computeSynthCacheKey(c.notes, c.bpm, c.opts)).to.equal(GOLDEN[c.name].synth);
    });
  }

  it('恒等式: notesHash + optionKeyPart === computeMelCacheKey（所有用例）', () => {
    for (const c of makeCases()) {
      const assembled = `${seg.computeNotesHash(c.notes)}${seg.computeOptionKeyPart(c.bpm, c.opts)}`;
      expect(assembled).to.equal(seg.computeMelCacheKey(c.notes, c.bpm, c.opts));
    }
  });

  it('computeCacheKeyParts 一次返回的两键与分别计算一致', () => {
    for (const c of makeCases()) {
      const parts = seg.computeCacheKeyParts(c.notes, c.bpm, c.opts);
      expect(parts.melKey).to.equal(seg.computeMelCacheKey(c.notes, c.bpm, c.opts));
      expect(parts.synthKey).to.equal(seg.computeSynthCacheKey(c.notes, c.bpm, c.opts));
      expect(parts.synthKey).to.equal(`${parts.melKey}_mp${parts.mpHash}`);
    }
  });

  it('promptSignature 仍是共享实现（键拆分没有绕开统一口径）', () => {
    const c = makeCases()[2];
    const sig = computePromptCondSignature(c.opts.refSingerData, c.opts.refMidiNotes, c.opts.refF0Data, c.opts.maxPromptFrames);
    expect(seg.computeOptionKeyPart(c.bpm, c.opts)).to.contain(`_p${sig}_`);
  });
});

describe('缓存键拆分 — pipeline 级批量段键', () => {
  let p;
  beforeEach(() => {
    p = new OnnxSVSPipeline('/fake/model/dir/');
    p._currentQDriftEnabled = true;
    p._diffusion.getNoiseSeed = () => 42;
  });

  const makeOpts = () => ({
    pitchCurveF0: new Float32Array([100, 220.5, 0]),
    refAudioWavBuffer: new Uint8Array([1, 2, 3, 255]),
    refSingerData: { text: 'ab', f0: '200', time: [0, 1] },
    refMidiNotes: [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }],
    refF0Data: [{ f0: 200, time: 0 }, { f0: 210, time: 0.02 }],
    maxPromptFrames: 80, nSteps: 30, cfg: 3.5, singerId: 's1',
    modelPrecision: 'fp16', backend: { type: 'plugin', pluginId: 'p', kindId: 'k' }, retakeNonce: 7,
    melPostprocess: { frames: 10, startBeat: 0.5, bpm: 120, sigmaT: [0.1], sigmaF: [1], blend: [0.5], boundaries: [0, 1] },
  });

  it('_computeCacheKeyPair 两键与旧分别计算逐字节一致', () => {
    const opts = makeOpts();
    const notes = [{ start: 0, duration: 1, lyric: 'a', pitch: 60 }];
    const pair = p._computeCacheKeyPair(notes, 137.5, opts);
    expect(pair.synthKey).to.equal(p._computeSynthCacheKey(notes, 137.5, opts));
    expect(pair.melKey).to.equal(p._computeMelCacheKey(notes, 137.5, opts));
  });

  it('_computeSegmentKeyBatch 每个段键与旧逐段计算逐字节一致', () => {
    const opts = makeOpts();
    const segments = [
      { notes: [{ start: 0, duration: 1, lyric: 'a', pitch: 60, phonemeAdjustments: [{ durationRatio: 1.1, volumePoints: [{ t: 0, v: 1 }] }] }], startBeat: 0 },
      { notes: [{ start: 1, duration: 0.5, lyric: 'い', pitch: 67, noteType: 3, isSlur: true }], startBeat: 3.25 },
      { notes: [{ start: 2, duration: 2, lyric: '', pitch: 0 }], startBeat: 7 },
    ];
    const shifts = [2, -3, 0];
    const bpm = 137.5;
    const ptFrameCount = 50;
    const batch = p._computeSegmentKeyBatch(segments, bpm, opts, shifts, ptFrameCount);
    expect(batch).to.have.lengthOf(segments.length);
    for (let i = 0; i < segments.length; i++) {
      expect(batch[i].synthKey).to.equal(
        p._computeSegmentCacheKey(segments[i].notes, bpm, opts, segments[i].startBeat, shifts[i], ptFrameCount));
      expect(batch[i].melKey).to.equal(
        p._computeSegmentMelKey(segments[i].notes, bpm, opts, segments[i].startBeat, shifts[i], ptFrameCount));
    }
  });

  it('不同段（notes 不同）产生不同键；相同选项哈希只依赖 bpm+options', () => {
    const opts = makeOpts();
    const seg = p._audioSegmentation;
    const n1 = [{ start: 0, duration: 1, lyric: 'a', pitch: 60 }];
    const n2 = [{ start: 0, duration: 1, lyric: 'b', pitch: 60 }];
    expect(seg.computeNotesHash(n1)).to.not.equal(seg.computeNotesHash(n2));
    // optionKeyPart 与 notes 无关：同一 bpm+options 恒返回同一段
    expect(seg.computeOptionKeyPart(120, opts)).to.equal(seg.computeOptionKeyPart(120, opts));
    expect(seg.computeOptionKeyPart(120, opts)).to.not.equal(seg.computeOptionKeyPart(130, opts));
  });
});
