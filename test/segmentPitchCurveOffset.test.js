const { expect } = require('chai');
const sinon = require('sinon');
const { OnnxSVSPipeline } = require('../src/inference/pipeline');
const { SAMPLE_RATE, HOP_SIZE, MEL_DIM, COND_DIM } = require('../src/inference/pipeline/constants');

/**
 * 多 segment 合成中 pitchCurveF0 的绝对时间对齐回归测试。
 *
 * 背景（2026-10-18 修复）：分片编辑器预览在分片含 ≥1.5s 长休止（或 >20s）时走
 * synthesize() 多 segment 路径，segmentNotes.start 被 re-base 到 segStart，而
 * pitchCurveF0 是整片段绝对时间序列。OnnxSVSPipeline.notesToSequences 这个转发
 * 包装漏掉了第 6 个参数 pitchCurveOffsetSec —— segment 0 的 offset 恰好是 0
 * （表现正常），后续段全部从曲线第 0 帧取值：手绘音高曲线 / 颤音 / F0 平滑整体
 * 错位，听感为"第一段正常，后面唱的音高是歪的"（歌词正确、音高错误）。
 *
 * 本文件锁两件事：
 *   1. notesToSequences 转发包装必须透传 pitchCurveOffsetSec；
 *   2. synthesize() 多 segment 路径里每个 segment 都按自己的绝对拍位索引曲线。
 */

const BPM = 60; // 1 beat = 1s，便于把秒/拍/帧直接对齐
const FRAME_HZ = SAMPLE_RATE / HOP_SIZE; // 50Hz

function midiToFreq(p) {
  return 440 * Math.pow(2, (p - 69) / 12);
}

/** 构造一个跳过真实模型加载的 pipeline（只跑纯逻辑 + 打桩的重活） */
function buildPipeline() {
  const pipeline = new OnnxSVSPipeline('/fake/model/dir/', {});
  pipeline.initialized = true;
  pipeline.isFP16 = false;
  pipeline.diffStepIsFP16 = false;
  pipeline.vocoderIsFP16 = false;
  pipeline.vocoderType = 'default';
  pipeline.useWebNN = false;
  pipeline.sessionEPs = { diffStep: 'dml', vocoder: 'dml' };
  sinon.stub(pipeline, 'ensureAllModelsLoaded').resolves();
  sinon.stub(pipeline, '_recreateHeavySessionsAfterSynthesis').resolves();
  pipeline._runEncoder = async (sequences, tokenCount, totalFrames, ptFrameCount) =>
    new Float32Array((ptFrameCount + totalFrames) * COND_DIM);
  pipeline._runDiffusionLoop = async () => {};
  return pipeline;
}

describe('多 segment 合成 pitchCurveF0 绝对时间对齐', () => {
  describe('notesToSequences 转发包装透传 pitchCurveOffsetSec', () => {
    it('offset 使 F0 从曲线的绝对帧位置取值（而不是永远取第 0 帧）', () => {
      const pipeline = buildPipeline();
      // 曲线：0-1s=220Hz, 1-2s=880Hz
      const curve = new Float32Array(400);
      curve.fill(220, 0, 50);
      curve.fill(880, 50, 100);
      const notes = [{ pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' }];

      const atZero = pipeline.notesToSequences(notes, BPM, null, curve, 0, 0);
      expect(atZero.f0Hz[0]).to.be.closeTo(220, 1e-3);

      const atOneSec = pipeline.notesToSequences(notes, BPM, null, curve, 0, 1.0);
      expect(atOneSec.f0Hz[0]).to.be.closeTo(880, 1e-3);
      // 帧数与 offset 无关（segment 时长决定）
      expect(atOneSec.f0Hz.length).to.equal(atZero.f0Hz.length);
    });

    it('未传 offset 时行为不变（单段路径逐位兼容）', () => {
      const pipeline = buildPipeline();
      const curve = new Float32Array(400);
      curve.fill(220, 0, 50);
      curve.fill(880, 50, 100);
      const notes = [{ pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' }];
      const seq = pipeline.notesToSequences(notes, BPM, null, curve, 0);
      expect(seq.f0Hz[0]).to.be.closeTo(220, 1e-3);
    });
  });

  describe('synthesize() 多 segment 路径', () => {
    it('长休止切开的两段各自按绝对拍位索引 pitchCurveF0', async () => {
      const pipeline = buildPipeline();
      // 捕获每个 segment 送进 vocoder 的 F0（_synthesizeSegment 在 vocoder 前置入
      // this._currentF0Hz），用于断言逐帧音高
      const segF0 = [];
      pipeline._runVocoderChunked = async function (mel, totalFrames) {
        segF0.push(Array.from(this._currentF0Hz || []));
        return new Float32Array(totalFrames * HOP_SIZE).fill(0.1);
      };

      // 曲线用逐帧递增的斜坡（200Hz + 帧号），任何时间错位都会立刻体现在数值上
      const curve = new Float32Array(50 * 8);
      for (let i = 0; i < curve.length; i++) curve[i] = 200 + i;

      // 乐句 [0,2s] + 长休止 [2s,4s] + 乐句 [4s,6s]（bpm=60，1 beat=1s）
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
        { pitch: 64, start: 1, duration: 1, lyric: 'zh_a2' },
        { pitch: 67, start: 4, duration: 1, lyric: 'zh_a3' },
        { pitch: 72, start: 5, duration: 1, lyric: 'zh_a4' },
      ];

      await pipeline.synthesize(notes, BPM, { nSteps: 2, pitchCurveF0: curve });

      expect(segF0).to.have.lengthOf(2);

      // 段 0：绝对拍 0 起 → 段内第 k 帧 = 曲线第 k 帧
      expect(segF0[0][0]).to.be.closeTo(200, 1e-3);
      expect(segF0[0][50]).to.be.closeTo(250, 1e-3);

      // 段 1：region 首 = 4s - 0.15s（REST_CONTEXT_SEC）= 3.85s
      // 段内第 k 帧的绝对时间 = 3.85 + k/50 s，必须读到该处的曲线值。
      const REST_CONTEXT_FRAMES = Math.round(0.15 * FRAME_HZ); // 8 帧
      const baseFrame = Math.round(3.85 * FRAME_HZ);           // 192
      expect(segF0[1][0]).to.equal(0); // 段首是 150ms 休止 → 强制清音
      // 0.15s 处绝对帧 ≈200 → 曲线 ≈400Hz；offset 被丢弃时会读到 ≈208Hz。
      // 容差 2Hz：absTime 由浮点秒相加后 floor 取帧，边界上允许差 1-2 帧。
      expect(segF0[1][REST_CONTEXT_FRAMES]).to.be.closeTo(200 + baseFrame + REST_CONTEXT_FRAMES, 2);
      expect(segF0[1][REST_CONTEXT_FRAMES + 50]).to.be.closeTo(200 + baseFrame + REST_CONTEXT_FRAMES + 50, 2);
    });

    it('无音高曲线时音高仍取自音符本身（不受 offset 影响）', async () => {
      const pipeline = buildPipeline();
      const segF0 = [];
      pipeline._runVocoderChunked = async function (mel, totalFrames) {
        segF0.push(Array.from(this._currentF0Hz || []));
        return new Float32Array(totalFrames * HOP_SIZE).fill(0.1);
      };
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
        { pitch: 67, start: 4, duration: 1, lyric: 'zh_a3' },
      ];
      await pipeline.synthesize(notes, BPM, { nSteps: 2 });

      expect(segF0).to.have.lengthOf(2);
      expect(segF0[0][0]).to.be.closeTo(midiToFreq(60), 1);
      const REST_CONTEXT_FRAMES = Math.round(0.15 * FRAME_HZ);
      expect(segF0[1][REST_CONTEXT_FRAMES]).to.be.closeTo(midiToFreq(67), 1);
    });
  });
});
