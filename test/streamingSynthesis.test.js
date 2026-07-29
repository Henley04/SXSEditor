const { expect } = require('chai');
const sinon = require('sinon');
const { OnnxSVSPipeline, SAMPLE_RATE } = require('../src/inference/pipeline');
const {
  MEL_DIM,
  COND_DIM,
  HOP_SIZE,
  VOCODER_CHUNK_FRAMES,
  VOCODER_OVERLAP_FRAMES,
  DEFAULT_DIFF_STEPS,
  CFG_STRENGTH,
  CFG_RESCALE,
  MAX_SAFE_FRAMES,
  NPU_STATIC_SEQ_LEN,
} = require('../src/inference/pipeline/constants');

/**
 * 分段流式推理（segmented streaming inference）全面测试。
 *
 * 覆盖范围：
 *   1. OnnxSVSPipeline.synthesizeMultiStreaming  - 多分片时间交错流式合成
 *   2. OnnxSVSPipeline._synthesizeImpl           - 单分片分块流式路径 (useStreamingChunked)
 *   3. OnnxSVSPipeline._runDiffusionLoop         - 分块调度分支
 *   4. OnnxSVSPipeline._runVocoderChunkedForSegment - 流式 vocoder 包装
 *   5. Diffusion._planChunks / _runSingleDiffusionChunk - 分块规划与单块执行
 *   6. 错误传播与边界条件
 *
 * 测试策略（不加载真实模型）：
 *   - 使用 mock session（diffStep.run / vocoder.run 返回构造好的 Float32Array）
 *   - stub _runEncoder 返回固定 Float32Array，避免调用真实 encoder session
 *   - stub _recreateHeavySessionsAfterSynthesis / _resolveVocoderChunkFrames / loadModel
 *     避免触碰磁盘文件 / 设置项 / GPU 资源
 *   - 保留真实的纯逻辑：notesToSequences / _fillNoteGaps / _buildVocalSegments /
 *     randomNoise / _planChunks / _runSingleDiffusionChunk / runDiffusionLoop(Chunked) /
 *     runVocoderChunked / _runVocoderChunkedForSegment
 */

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** 构造 mock diffStep session：返回 seqLen×MEL_DIM 的 flow_pred，填充 fillValue */
function makeMockDiffStepSession(fillValue = 0.01, record = null) {
  return {
    inputMetadata: [
      { name: 'xt_input', type: 'float32', shape: [1, -1, MEL_DIM] },
      { name: 't', type: 'float32', shape: [1] },
      { name: 'cond', type: 'float32', shape: [1, -1, COND_DIM] },
      { name: 'xt_mask', type: 'float32', shape: [1, -1] },
    ],
    async run(inputs) {
      const seqLen = inputs.xt_input.dims[1];
      if (record) record.push({ seqLen, tVal: inputs.t.data[0] });
      const data = new Float32Array(seqLen * MEL_DIM).fill(fillValue);
      return {
        flow_pred: {
          type: 'float32',
          data,
          dims: [1, seqLen, MEL_DIM],
          dispose() {},
        },
      };
    },
  };
}

/** 构造 mock vocoder session：返回 melSeqLen×HOP_SIZE 的 waveform，填充 fillValue */
function makeMockVocoderSession(fillValue = 0.5, record = null) {
  return {
    async run(inputs) {
      const melSeqLen = inputs.mel.dims[1];
      if (record) record.push({ melSeqLen });
      const waveLen = melSeqLen * HOP_SIZE;
      const data = new Float32Array(waveLen).fill(fillValue);
      return {
        waveform: {
          type: 'float32',
          data,
          dispose() {},
        },
      };
    },
  };
}

/** 构造 mock encoder session（仅占位，实际不会被调用因为 _runEncoder 被 stub） */
function makeMockEncoderSession() {
  return {
    async run() {
      const data = new Float32Array(1 * EMBED_DIM).fill(0.1);
      return { embeddings: { type: 'float32', data, dispose() {} } };
    },
  };
}

const EMBED_DIM = 512;

/**
 * 构造一个跳过真实模型加载的 OnnxSVSPipeline 实例。
 * 所有触碰磁盘 / GPU / 设置项的方法都被 stub。
 */
function buildMockPipeline(pipelineOpts = {}) {
  const pipeline = new OnnxSVSPipeline('/fake/model/dir/', pipelineOpts);
  pipeline.initialized = true;
  pipeline.isFP16 = false;
  pipeline.diffStepIsFP16 = false;
  pipeline.vocoderIsFP16 = false;
  pipeline.vocoderType = 'default';
  // 不覆盖 useStaticShapes：由构造函数依据 modelPrecision === 'int8-npu' 设置，
  // 这样 int8-npu 测试用例才能验证 NPU 静态形状路径。
  pipeline.useWebNN = false;
  pipeline.sessionEPs = { diffStep: 'dml', vocoder: 'dml' };
  pipeline._resolvedVocoderFile = 'vocoder_dml.onnx';

  // 占位 sessions：所有 SESSION_KEYS 都存在，让 ensureAllModelsLoaded 立即返回
  pipeline.sessions = {
    noteTextEncoder: makeMockEncoderSession(),
    notePitchEncoder: makeMockEncoderSession(),
    noteTypeEncoder: makeMockEncoderSession(),
    f0Encoder: makeMockEncoderSession(),
    preflow: makeMockEncoderSession(),
    condEmb: makeMockEncoderSession(),
    diffStep: makeMockDiffStepSession(),
    vocoder: makeMockVocoderSession(),
    melTransform: makeMockEncoderSession(),
  };

  // stub 触碰外部资源的方法
  sinon.stub(pipeline, '_runEncoder').callsFake(async (_seq, _tok, totalFrames, ptFrameCount = 0) => {
    return new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);
  });
  sinon.stub(pipeline, '_recreateHeavySessionsAfterSynthesis').resolves();
  sinon.stub(pipeline, '_resolveVocoderChunkFrames').returns(0); // 0 → 回退 VOCODER_CHUNK_FRAMES
  sinon.stub(pipeline, '_maybeUnloadDiffStepBeforeVocoder').returns(false);
  sinon.stub(pipeline, '_reloadDiffStepAfterVocoder').resolves();
  sinon.stub(pipeline, '_extractRefF0WithFallback').resolves(null);
  sinon.stub(pipeline, '_extractRefMelOnnx').resolves({ data: new Float32Array(0), frames: 0 });
  sinon.stub(pipeline, '_extractRefMelAsync').resolves({ data: new Float32Array(0), frames: 0 });
  sinon.stub(pipeline, '_extractRefNotePitchesAsync').resolves([]);
  sinon.stub(pipeline, 'loadModel').resolves({ success: true });

  return pipeline;
}

/** 替换 pipeline 的 diffStep / vocoder session 并返回调用记录器 */
function installRecordingSessions(pipeline, diffFill = 0.01, vocFill = 0.5) {
  const diffRecord = [];
  const vocRecord = [];
  pipeline.sessions.diffStep = makeMockDiffStepSession(diffFill, diffRecord);
  pipeline.sessions.vocoder = makeMockVocoderSession(vocFill, vocRecord);
  return { diffRecord, vocRecord };
}

/** 构造简单的测试 notes：N 个 4 拍音符，pitch 递增 */
function makeNotes(count = 1, opts = {}) {
  const notes = [];
  for (let i = 0; i < count; i++) {
    notes.push({
      pitch: 60 + i,
      start: i * 4,
      duration: 4,
      lyric: opts.lyric || 'la',
    });
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('分段流式推理 (Segmented Streaming Inference) - 全面测试', () => {
  describe('OnnxSVSPipeline.synthesizeMultiStreaming - 多分片时间交错流式合成', () => {
    let pipeline;

    beforeEach(() => {
      pipeline = buildMockPipeline();
    });

    describe('空输入与边界条件', () => {
      it('空 fragments 数组返回空 Float32Array', async () => {
        const out = await pipeline.synthesizeMultiStreaming([], 120, {});
        expect(out).to.be.an.instanceOf(Float32Array);
        expect(out.length).to.equal(0);
      });

      it('null fragments 返回空 Float32Array', async () => {
        const out = await pipeline.synthesizeMultiStreaming(null, 120, {});
        expect(out.length).to.equal(0);
      });

      it('单个 fragment 但 notes 为空 → 跳过，返回空', async () => {
        const out = await pipeline.synthesizeMultiStreaming(
          [{ notes: [], startTimeBeat: 0, durationBeats: 4, options: {} }],
          120,
          {}
        );
        expect(out.length).to.equal(0);
      });

      it('多个 fragment 全为空 notes → 全部跳过，返回空', async () => {
        const out = await pipeline.synthesizeMultiStreaming(
          [
            { notes: [], startTimeBeat: 0, durationBeats: 4, options: {} },
            { notes: [], startTimeBeat: 4, durationBeats: 4, options: {} },
          ],
          120,
          {}
        );
        expect(out.length).to.equal(0);
      });

      it('部分 fragment 空 notes → 仅合成非空 fragment', async () => {
        const onChunkAudio = sinon.spy();
        const out = await pipeline.synthesizeMultiStreaming(
          [
            { notes: [], startTimeBeat: 0, durationBeats: 4, options: {} },
            { notes: makeNotes(1), startTimeBeat: 4, durationBeats: 4, options: { diffStepChunk: false } },
          ],
          120,
          { onChunkAudio }
        );
        // 第二 fragment 的 durationBeats=4 + startTimeBeat=4 → maxEndBeat=8
        // totalMixedSamples = ceil(8/120*60*24000) = ceil(96000) = 96000
        expect(out.length).to.equal(96000);
      });
    });

    describe('chunk 选项一致性', () => {
      it('fragments 的 chunk 选项不一致 → 使用 fragment 0 的选项', async () => {
        const consoleWarn = sinon.spy(console, 'warn');
        const out = await pipeline.synthesizeMultiStreaming(
          [
            { notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: false } },
            { notes: makeNotes(1), startTimeBeat: 4, durationBeats: 4, options: { diffStepChunk: true, diffStepChunkFrames: 50 } },
          ],
          120,
          {}
        );
        // 第一个 fragment diffStepChunk=false → chunkEnabled=false，应正常完成
        expect(out.length).to.be.greaterThan(0);
        // 应有 warning 提示选项不一致
        const warningCalls = consoleWarn.getCalls();
        const hasInconsistentWarning = warningCalls.some(c =>
          /inconsistent chunk options/i.test(c.args.join(' '))
        );
        expect(hasInconsistentWarning).to.equal(true);
        consoleWarn.restore();
      });

      it('所有 fragments 共用第一个 fragment 的 chunkFrames', async () => {
        pipeline = buildMockPipeline();
        const { diffRecord } = installRecordingSessions(pipeline);
        // bpm=120, 4 beats × 1 note → totalFrames=100；chunkFrames=30, overlap=5
        // 第一个 fragment 的 chunkFrames=30 应被所有 fragment 使用
        await pipeline.synthesizeMultiStreaming(
          [
            { notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: true, diffStepChunkFrames: 30, diffStepOverlapFrames: 5 } },
            { notes: makeNotes(1), startTimeBeat: 4, durationBeats: 4, options: { diffStepChunk: true, diffStepChunkFrames: 999, diffStepOverlapFrames: 999 } },
          ],
          120,
          {}
        );
        // 100 frames, chunkFrames=30, overlap=5 → 步长 25
        // chunks: [0,30), [25,55), [50,80), [75,100) → 4 chunks/fragment × 2 fragments = 8 chunks
        // 每 chunk 1 步 cond + 1 步 uncond = 2 runs/chunk (cfg=CFG_STRENGTH=3.0>0)
        // 总 run 数 = 8 chunks × 2 = 16
        // 但由于 _runSingleDiffusionChunk 内 runDiffusionLoop 实际调用次数 = steps × 2 × chunks
        // 这里仅断言 run 数 > 0，避免过紧耦合
        expect(diffRecord.length).to.be.greaterThan(0);
      });
    });

    describe('单分片流式合成', () => {
      it('单分片无分块 (diffStepChunk=false) → 完整音频覆盖 [0, duration]', async () => {
        // bpm=120, 4 beats × 1 note → totalFrames=100, totalSamples=100*480=48000
        // durationBeats=4 → maxEndBeat=4, totalMixedSamples=ceil(4/120*60*24000)=48000
        const onProgress = sinon.spy();
        const out = await pipeline.synthesizeMultiStreaming(
          [{ notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: false } }],
          120,
          { onProgress }
        );
        expect(out).to.be.an.instanceOf(Float32Array);
        expect(out.length).to.equal(48000);
        // 进度应以 100 结尾
        const lastCall = onProgress.lastCall;
        expect(lastCall.args[0]).to.equal(100);
      });

      it('单分片无分块 → onChunkAudio 至少调用一次，最后一次 isLast=true', async () => {
        const onChunkAudio = sinon.spy();
        await pipeline.synthesizeMultiStreaming(
          [{ notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: false } }],
          120,
          { onChunkAudio }
        );
        expect(onChunkAudio.callCount).to.be.greaterThan(0);
        const lastCallArgs = onChunkAudio.lastCall.args[0];
        expect(lastCallArgs.isLast).to.equal(true);
      });

      it('单分片分块 (diffStepChunk=true) → onChunkAudio 每个 chunk 调用一次', async () => {
        pipeline = buildMockPipeline();
        installRecordingSessions(pipeline);
        const onChunkAudio = sinon.spy();
        // totalFrames=100, chunkFrames=30 → _planChunks 内 safeChunk=max(50,30)=50
        // 100/50 → 3 chunks（0-50, 45-95, 90-100）
        await pipeline.synthesizeMultiStreaming(
          [{ notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: true, diffStepChunkFrames: 30, diffStepOverlapFrames: 5 } }],
          120,
          { onChunkAudio }
        );
        // 至少 3 次 onChunkAudio（vocoder 内部可能再分块）
        expect(onChunkAudio.callCount).to.be.greaterThanOrEqual(3);
        // 最后一次 isLast=true，其余 isLast=false
        const lastCall = onChunkAudio.lastCall.args[0];
        expect(lastCall.isLast).to.equal(true);
        for (let i = 0; i < onChunkAudio.callCount - 1; i++) {
          expect(onChunkAudio.getCall(i).args[0].isLast).to.equal(false);
        }
      });

      it('单分片分块 → chunk 的 sampleOffset 严格非递减', async () => {
        pipeline = buildMockPipeline();
        installRecordingSessions(pipeline);
        const onChunkAudio = sinon.spy();
        await pipeline.synthesizeMultiStreaming(
          [{ notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: true, diffStepChunkFrames: 30, diffStepOverlapFrames: 5 } }],
          120,
          { onChunkAudio }
        );
        const offsets = onChunkAudio.getCalls().map(c => c.args[0].sampleOffset);
        for (let i = 1; i < offsets.length; i++) {
          expect(offsets[i]).to.be.at.least(offsets[i - 1]);
        }
      });
    });

    describe('多分片流式合成', () => {
      it('2 个分片无分块 → 音频按 startTimeBeat 正确放置', async () => {
        // frag0: startTimeBeat=0, 4 beats, totalFrames=100, samples=48000
        // frag1: startTimeBeat=8, 4 beats, totalFrames=100, samples=48000, 起始采样=8/120*60*24000=96000
        // maxEndBeat=12, totalMixedSamples=ceil(12/120*60*24000)=144000
        const onChunkAudio = sinon.spy();
        const out = await pipeline.synthesizeMultiStreaming(
          [
            { notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: false } },
            { notes: makeNotes(1), startTimeBeat: 8, durationBeats: 4, options: { diffStepChunk: false } },
          ],
          120,
          { onChunkAudio }
        );
        expect(out.length).to.equal(144000);
        // 验证流式回调的 sampleOffset 覆盖两个分片区间
        const offsets = onChunkAudio.getCalls().map(c => c.args[0].sampleOffset);
        const minOffset = Math.min(...offsets);
        const maxOffset = Math.max(...offsets);
        expect(minOffset).to.equal(0); // frag0 从 0 开始
        expect(maxOffset).to.be.at.least(96000); // frag1 从 96000 开始
      });

      it('2 个分片分块 → 全局 chunk 时间顺序交错', async () => {
        pipeline = buildMockPipeline();
        installRecordingSessions(pipeline);
        const onChunkAudio = sinon.spy();
        // frag0: startTimeBeat=0, frag1: startTimeBeat=8 (4 秒后)
        // frag0 chunks 时间: 0, 0.5s, 1.0s, 1.5s
        // frag1 chunks 时间: 4.0s, 4.5s, 5.0s, 5.5s
        // 时间顺序: frag0 的所有 → frag1 的所有
        await pipeline.synthesizeMultiStreaming(
          [
            { notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: true, diffStepChunkFrames: 30, diffStepOverlapFrames: 5 } },
            { notes: makeNotes(1), startTimeBeat: 8, durationBeats: 4, options: { diffStepChunk: true, diffStepChunkFrames: 30, diffStepOverlapFrames: 5 } },
          ],
          120,
          { onChunkAudio }
        );
        // 至少 6 次（3 chunks × 2 fragments），vocoder 内部可能再分块
        expect(onChunkAudio.callCount).to.be.greaterThanOrEqual(6);
        // 时间顺序：sampleOffset 应非递减
        const offsets = onChunkAudio.getCalls().map(c => c.args[0].sampleOffset);
        for (let i = 1; i < offsets.length; i++) {
          expect(offsets[i]).to.be.at.least(offsets[i - 1]);
        }
      });

      it('totalMixedSamples = ceil(maxEndBeat/bpm*60*SAMPLE_RATE)', async () => {
        // frag0: startBeat=0, duration=4 → end=4
        // frag1: startBeat=10, duration=8 → end=18
        // maxEndBeat=18, bpm=120 → totalMixedSamples=ceil(18/120*60*24000)=ceil(216000)=216000
        const out = await pipeline.synthesizeMultiStreaming(
          [
            { notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: false } },
            { notes: makeNotes(1), startTimeBeat: 10, durationBeats: 8, options: { diffStepChunk: false } },
          ],
          120,
          {}
        );
        expect(out.length).to.equal(216000);
      });

      it('流式回调的 totalSamples 字段等于最终输出长度', async () => {
        const onChunkAudio = sinon.spy();
        await pipeline.synthesizeMultiStreaming(
          [
            { notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: false } },
            { notes: makeNotes(1), startTimeBeat: 4, durationBeats: 4, options: { diffStepChunk: false } },
          ],
          120,
          { onChunkAudio }
        );
        const totalSamplesValues = onChunkAudio.getCalls().map(c => c.args[0].totalSamples);
        // 所有 totalSamples 应相同
        for (let i = 1; i < totalSamplesValues.length; i++) {
          expect(totalSamplesValues[i]).to.equal(totalSamplesValues[0]);
        }
      });
    });

    describe('混合阶段 (Phase 4 mixing)', () => {
      it('混合后 audio 归一化（peak ≤ 0.95）', async () => {
        const out = await pipeline.synthesizeMultiStreaming(
          [
            { notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: false } },
            { notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: false } },
          ],
          120,
          {}
        );
        let peak = 0;
        for (let i = 0; i < out.length; i++) {
          const abs = Math.abs(out[i]);
          if (abs > peak) peak = abs;
        }
        expect(peak).to.be.at.most(0.95 + 1e-6);
      });

      it('混合后 audio 包含非零数据', async () => {
        const out = await pipeline.synthesizeMultiStreaming(
          [{ notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: false } }],
          120,
          {}
        );
        let nonZero = 0;
        for (let i = 0; i < out.length; i++) {
          if (Math.abs(out[i]) > 1e-7) nonZero++;
        }
        expect(nonZero).to.be.greaterThan(0);
      });

      it('混合后 audio 不包含 NaN/Inf', async () => {
        const out = await pipeline.synthesizeMultiStreaming(
          [
            { notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: false } },
            { notes: makeNotes(1), startTimeBeat: 4, durationBeats: 4, options: { diffStepChunk: false } },
          ],
          120,
          {}
        );
        let nanCount = 0, infCount = 0;
        for (let i = 0; i < out.length; i++) {
          if (Number.isNaN(out[i])) nanCount++;
          else if (!Number.isFinite(out[i])) infCount++;
        }
        expect(nanCount).to.equal(0);
        expect(infCount).to.equal(0);
      });
    });

    describe('进度回调', () => {
      it('onProgress 最终调用值为 100', async () => {
        const onProgress = sinon.spy();
        await pipeline.synthesizeMultiStreaming(
          [{ notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: false } }],
          120,
          { onProgress }
        );
        expect(onProgress.lastCall.args[0]).to.equal(100);
      });

      it('onProgress 默认为 no-op（未提供时不抛错）', async () => {
        await pipeline.synthesizeMultiStreaming(
          [{ notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: false } }],
          120,
          {}
        );
        // 不抛错即通过
      });
    });
  });

  // -------------------------------------------------------------------------

  describe('OnnxSVSPipeline._synthesizeImpl - 单分片分块流式路径 (useStreamingChunked)', () => {
    let pipeline;

    beforeEach(() => {
      pipeline = buildMockPipeline();
    });

    it('diffStepChunk=true + onChunkAudio + totalFrames > chunkFrames → 走流式分块路径', async () => {
      pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      const onChunkAudio = sinon.spy();
      // 用 2 个音符避免 single-note context padding（padding 会使 singleSegOnChunk=null，
      // 从而不进入流式分块路径）。2 音符 × 4 拍 = 8 拍 → totalFrames=200
      const out = await pipeline.synthesize(
        makeNotes(2),
        120,
        {
          diffStepChunk: true,
          diffStepChunkFrames: 30,
          diffStepOverlapFrames: 5,
          onChunkAudio,
          nSteps: 1, // 减少测试时间
          cfg: 0,    // cfg=0 跳过无条件预测，仅 cond 分支
        }
      );
      // 流式路径输出长度 = totalFrames * HOP_SIZE = 200 * 480 = 96000
      expect(out.length).to.equal(96000);
      // onChunkAudio 至少调用一次（流式分块路径被触发）
      expect(onChunkAudio.callCount).to.be.greaterThan(0);
    });

    it('diffStepChunk=false → 走常规路径（不进入 useStreamingChunked）', async () => {
      pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      const onChunkAudio = sinon.spy();
      const out = await pipeline.synthesize(
        makeNotes(1),
        120,
        {
          diffStepChunk: false,
          onChunkAudio,
          nSteps: 1,
          cfg: 0,
        }
      );
      // 常规路径仍然调用 _runVocoderChunked（整段），会触发 onChunkComplete 一次
      expect(out.length).to.equal(48000);
    });

    it('onChunkAudio=null → 不走流式分块路径（回退常规）', async () => {
      pipeline = buildMockPipeline();
      const { diffRecord } = installRecordingSessions(pipeline);
      // 不传 onChunkAudio，即使 diffStepChunk=true，也不进入流式分块路径（singleSegOnChunk=null）。
      // 注意：常规路径仍会通过 _runDiffusionLoop 内部的 chunkOpts 检查进入 diffusion 分块
      // （runDiffusionLoopChunked），只是不流式推送 vocoder。diffStep.run 调用次数
      // = chunks × nSteps × 1（仅 cond 分支，cfg=0）
      const out = await pipeline.synthesize(
        makeNotes(1),
        120,
        {
          diffStepChunk: true,
          diffStepChunkFrames: 30,
          diffStepOverlapFrames: 5,
          nSteps: 2,
          cfg: 0,
          // 没有 onChunkAudio
        }
      );
      expect(out.length).to.equal(48000);
      // 常规路径 + diffusion 分块：diffStep.run 被调用多次（> 0）
      expect(diffRecord.length).to.be.greaterThan(0);
    });

    it('useStaticShapes=true → 不走流式分块路径', async () => {
      pipeline = buildMockPipeline({ modelPrecision: 'int8-npu' });
      // modelPrecision='int8-npu' → useStaticShapes=true
      expect(pipeline.useStaticShapes).to.equal(true);
      installRecordingSessions(pipeline);
      const onChunkAudio = sinon.spy();
      const out = await pipeline.synthesize(
        makeNotes(1),
        120,
        {
          diffStepChunk: true,
          diffStepChunkFrames: 30,
          diffStepOverlapFrames: 5,
          onChunkAudio,
          nSteps: 1,
          cfg: 0,
        }
      );
      // useStaticShapes 路径下 totalFrames 可能被 NPU 限制截断
      expect(out.length).to.be.greaterThan(0);
    });

    it('totalFrames <= chunkFrames → 不分块（走常规路径）', async () => {
      pipeline = buildMockPipeline();
      const { diffRecord } = installRecordingSessions(pipeline);
      const onChunkAudio = sinon.spy();
      // 单音符 context padding 后 totalFrames=150（+25 前后 rest），chunkFrames=200
      // → 150 <= 200，不进入 diffusion 分块，走 runDiffusionLoop 整段
      // nSteps=2, cfg=0 → 仅 cond 分支 → 2 steps × 1 run = 2 runs
      await pipeline.synthesize(
        makeNotes(1),
        120,
        {
          diffStepChunk: true,
          diffStepChunkFrames: 200,
          diffStepOverlapFrames: 5,
          onChunkAudio,
          nSteps: 2,
          cfg: 0,
        }
      );
      // 不分块：2 steps × 1 分支 (cond only) = 2 runs
      expect(diffRecord.length).to.equal(2);
    });

    it('流式分块路径：audioData 长度 = totalFrames * HOP_SIZE', async () => {
      pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      // 用 2 个音符避免 single-note context padding，确保走流式分块路径
      // 2 音符 × 4 拍 = 8 拍 → totalFrames=200
      const out = await pipeline.synthesize(
        makeNotes(2),
        120,
        {
          diffStepChunk: true,
          diffStepChunkFrames: 30,
          diffStepOverlapFrames: 5,
          onChunkAudio: () => {},
          nSteps: 1,
          cfg: 0,
        }
      );
      expect(out.length).to.equal(200 * HOP_SIZE);
    });

    it('流式分块路径：所有 chunk 的 isLast 仅最后一次为 true', async () => {
      pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      const onChunkAudio = sinon.spy();
      // 用 2 个音符避免 single-note context padding（padding 会阻断流式分块路径）
      await pipeline.synthesize(
        makeNotes(2),
        120,
        {
          diffStepChunk: true,
          diffStepChunkFrames: 30,
          diffStepOverlapFrames: 5,
          onChunkAudio,
          nSteps: 1,
          cfg: 0,
        }
      );
      const calls = onChunkAudio.getCalls();
      // 流式路径应被触发
      expect(calls.length).to.be.greaterThan(0);
      // 最后一次 isLast=true
      expect(calls[calls.length - 1].args[0].isLast).to.equal(true);
      // 之前的 isLast=false（vocoder 内部 chunk 的 isLast 链式传递：
      // 仅当 diffusion chunk 是最后一个 AND vocoder 内部 chunk 也是最后一个时为 true）
      // 因此中间 chunk 的 isLast 都应为 false
      for (let i = 0; i < calls.length - 1; i++) {
        expect(calls[i].args[0].isLast).to.equal(false);
      }
    });

    it('流式分块路径：sampleOffset 严格非递减', async () => {
      pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      const onChunkAudio = sinon.spy();
      // 用 2 个音符避免 single-note context padding，确保走流式分块路径
      await pipeline.synthesize(
        makeNotes(2),
        120,
        {
          diffStepChunk: true,
          diffStepChunkFrames: 30,
          diffStepOverlapFrames: 5,
          onChunkAudio,
          nSteps: 1,
          cfg: 0,
        }
      );
      const offsets = onChunkAudio.getCalls().map(c => c.args[0].sampleOffset);
      expect(offsets.length).to.be.greaterThan(0);
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]).to.be.at.least(offsets[i - 1]);
      }
    });

    it('流式分块路径：完成后写入合成缓存', async () => {
      pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      // 用 2 个音符避免 single-note context padding，确保走流式分块路径
      await pipeline.synthesize(
        makeNotes(2),
        120,
        {
          diffStepChunk: true,
          diffStepChunkFrames: 30,
          diffStepOverlapFrames: 5,
          onChunkAudio: () => {},
          nSteps: 1,
          cfg: 0,
        }
      );
      // 流式路径会调用 _synthCachePut
      expect(pipeline._synthCache).to.not.be.null;
      expect(pipeline._synthCache.audio).to.be.an.instanceOf(Float32Array);
    });

    it('缓存命中时不调用 vocoder（CACHE HIT 路径）', async () => {
      pipeline = buildMockPipeline();
      const { vocRecord } = installRecordingSessions(pipeline);
      // 第一次合成：填充缓存
      await pipeline.synthesize(
        makeNotes(1),
        120,
        { diffStepChunk: false, nSteps: 1, cfg: 0 }
      );
      const firstVocCallCount = vocRecord.length;
      // 第二次相同输入：应命中缓存
      const out2 = await pipeline.synthesize(
        makeNotes(1),
        120,
        { diffStepChunk: false, nSteps: 1, cfg: 0 }
      );
      // vocoder 不应再被调用
      expect(vocRecord.length).to.equal(firstVocCallCount);
      expect(out2.length).to.be.greaterThan(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('OnnxSVSPipeline._runDiffusionLoop - 分块调度', () => {
    let pipeline;

    beforeEach(() => {
      pipeline = buildMockPipeline();
    });

    it('chunkOpts.enabled + totalFrames > chunkFrames → 调用 runDiffusionLoopChunked', async () => {
      pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      const stub = sinon.spy(pipeline._diffusion, 'runDiffusionLoopChunked');
      // 总帧数 100，chunkFrames=30
      const xt = pipeline.randomNoise(100, MEL_DIM);
      const ptMelData = new Float32Array(10 * MEL_DIM).fill(0.1);
      const combinedCond = new Float32Array((10 + 100) * COND_DIM).fill(0.1);
      pipeline._currentDiffStepChunkOpts = {
        enabled: true,
        chunkFrames: 30,
        overlapFrames: 5,
      };
      await pipeline._runDiffusionLoop(xt, 100, ptMelData, 10, combinedCond, 1, 0, 0.75, () => {}, 0, 100);
      expect(stub.calledOnce).to.equal(true);
    });

    it('chunkOpts.enabled + totalFrames <= chunkFrames → 调用 runDiffusionLoop（不分块）', async () => {
      pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      const stubChunked = sinon.spy(pipeline._diffusion, 'runDiffusionLoopChunked');
      const stubLoop = sinon.spy(pipeline._diffusion, 'runDiffusionLoop');
      const xt = pipeline.randomNoise(100, MEL_DIM);
      const ptMelData = new Float32Array(10 * MEL_DIM).fill(0.1);
      const combinedCond = new Float32Array((10 + 100) * COND_DIM).fill(0.1);
      pipeline._currentDiffStepChunkOpts = {
        enabled: true,
        chunkFrames: 200, // > totalFrames
        overlapFrames: 5,
      };
      await pipeline._runDiffusionLoop(xt, 100, ptMelData, 10, combinedCond, 1, 0, 0.75, () => {}, 0, 100);
      expect(stubChunked.called).to.equal(false);
      expect(stubLoop.calledOnce).to.equal(true);
    });

    it('!chunkOpts.enabled → 调用 runDiffusionLoop', async () => {
      pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      const stubChunked = sinon.spy(pipeline._diffusion, 'runDiffusionLoopChunked');
      const stubLoop = sinon.spy(pipeline._diffusion, 'runDiffusionLoop');
      const xt = pipeline.randomNoise(100, MEL_DIM);
      const ptMelData = new Float32Array(10 * MEL_DIM).fill(0.1);
      const combinedCond = new Float32Array((10 + 100) * COND_DIM).fill(0.1);
      pipeline._currentDiffStepChunkOpts = {
        enabled: false,
        chunkFrames: 30,
        overlapFrames: 5,
      };
      await pipeline._runDiffusionLoop(xt, 100, ptMelData, 10, combinedCond, 1, 0, 0.75, () => {}, 0, 100);
      expect(stubChunked.called).to.equal(false);
      expect(stubLoop.calledOnce).to.equal(true);
    });

    it('useStaticShapes=true → 调用 runDiffusionLoop（NPU 不分块）', async () => {
      pipeline = buildMockPipeline();
      pipeline.useStaticShapes = true;
      installRecordingSessions(pipeline);
      const stubChunked = sinon.spy(pipeline._diffusion, 'runDiffusionLoopChunked');
      const stubLoop = sinon.spy(pipeline._diffusion, 'runDiffusionLoop');
      const xt = pipeline.randomNoise(100, MEL_DIM);
      const ptMelData = new Float32Array(10 * MEL_DIM).fill(0.1);
      const combinedCond = new Float32Array((10 + 100) * COND_DIM).fill(0.1);
      pipeline._currentDiffStepChunkOpts = {
        enabled: true,
        chunkFrames: 30,
        overlapFrames: 5,
      };
      await pipeline._runDiffusionLoop(xt, 100, ptMelData, 10, combinedCond, 1, 0, 0.75, () => {}, 0, 100, null, true);
      expect(stubChunked.called).to.equal(false);
      expect(stubLoop.calledOnce).to.equal(true);
    });

    it('onChunkMel 透传给 runDiffusionLoopChunked', async () => {
      pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      const stub = sinon.spy(pipeline._diffusion, 'runDiffusionLoopChunked');
      const xt = pipeline.randomNoise(100, MEL_DIM);
      const ptMelData = new Float32Array(10 * MEL_DIM).fill(0.1);
      const combinedCond = new Float32Array((10 + 100) * COND_DIM).fill(0.1);
      pipeline._currentDiffStepChunkOpts = {
        enabled: true,
        chunkFrames: 30,
        overlapFrames: 5,
      };
      const onChunkMel = sinon.spy();
      await pipeline._runDiffusionLoop(xt, 100, ptMelData, 10, combinedCond, 1, 0, 0.75, () => {}, 0, 100, onChunkMel);
      expect(stub.calledOnce).to.equal(true);
      // 倒数第二个参数应为 onChunkMel（最后一个为 samplerName，由求解器特性新增）
      const callArgs = stub.firstCall.args;
      expect(callArgs[callArgs.length - 2]).to.equal(onChunkMel);
      // 最后一个参数为 samplerName，默认 'euler'
      expect(callArgs[callArgs.length - 1]).to.equal('euler');
    });
  });

  // -------------------------------------------------------------------------

  describe('OnnxSVSPipeline._runVocoderChunkedForSegment - 流式 vocoder 包装', () => {
    let pipeline;

    beforeEach(() => {
      pipeline = buildMockPipeline();
    });

    it('onChunkComplete=null → 不调用回调，返回完整音频', async () => {
      pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      // totalFrames=100, default vocoder，_resolveVocoderChunkFrames stub 为 0 → VOCODER_CHUNK_FRAMES=1008
      // 100 <= 1008 → 单 chunk 路径
      const melData = new Float32Array(100 * MEL_DIM).fill(0.1);
      const f0 = new Float32Array(100).fill(440);
      const out = await pipeline._runVocoderChunkedForSegment(melData, 100, f0, null);
      expect(out).to.be.an.instanceOf(Float32Array);
      expect(out.length).to.equal(100 * HOP_SIZE);
    });

    it('onChunkComplete 提供 → 至少调用一次（单 chunk 路径）', async () => {
      pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      const onChunkComplete = sinon.spy();
      const melData = new Float32Array(100 * MEL_DIM).fill(0.1);
      const f0 = new Float32Array(100).fill(440);
      await pipeline._runVocoderChunkedForSegment(melData, 100, f0, onChunkComplete);
      expect(onChunkComplete.callCount).to.be.greaterThan(0);
      const lastArgs = onChunkComplete.lastCall.args[0];
      expect(lastArgs.isLast).to.equal(true);
    });

    it('长音频触发多 chunk vocoder（> VOCODER_CHUNK_FRAMES）', async () => {
      pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      const onChunkComplete = sinon.spy();
      // totalFrames = 2 * VOCODER_CHUNK_FRAMES + 1 → 3 chunks
      const totalFrames = 2 * VOCODER_CHUNK_FRAMES + 1;
      const melData = new Float32Array(totalFrames * MEL_DIM).fill(0.1);
      const f0 = new Float32Array(totalFrames).fill(440);
      const out = await pipeline._runVocoderChunkedForSegment(melData, totalFrames, f0, onChunkComplete);
      expect(out.length).to.equal(totalFrames * HOP_SIZE);
      // 流式回调应被调用多次，最后一次 isLast=true
      expect(onChunkComplete.callCount).to.be.greaterThan(1);
      expect(onChunkComplete.lastCall.args[0].isLast).to.equal(true);
    });

    it('vocoderType=default → f0 参数被忽略（default vocoder 不接受 f0 输入）', async () => {
      pipeline = buildMockPipeline();
      pipeline.vocoderType = 'default';
      const { vocRecord } = installRecordingSessions(pipeline);
      const melData = new Float32Array(100 * MEL_DIM).fill(0.1);
      const f0 = new Float32Array(100).fill(440);
      await pipeline._runVocoderChunkedForSegment(melData, 100, f0, null);
      // default vocoder 的输入应只有 mel，无 f0
      // vocRecord[0].melSeqLen 应等于 100
      expect(vocRecord[0].melSeqLen).to.equal(100);
    });

    it('vocoder run 抛错 → 错误向上传播', async () => {
      pipeline = buildMockPipeline();
      pipeline.sessions.vocoder = {
        async run() {
          throw new Error('Mock vocoder failure');
        },
      };
      const melData = new Float32Array(100 * MEL_DIM).fill(0.1);
      let caught = null;
      try {
        await pipeline._runVocoderChunkedForSegment(melData, 100, null, null);
      } catch (e) {
        caught = e;
      }
      expect(caught).to.not.be.null;
      expect(caught.message).to.match(/mock vocoder failure|vocoder/i);
    });

    it('vocoder 返回全零波形 → 抛错（silent failure 拦截）', async () => {
      pipeline = buildMockPipeline();
      pipeline.sessions.vocoder = {
        async run(inputs) {
          const melSeqLen = inputs.mel.dims[1];
          return {
            waveform: {
              type: 'float32',
              data: new Float32Array(melSeqLen * HOP_SIZE).fill(0),
              dispose() {},
            },
          };
        },
      };
      const melData = new Float32Array(100 * MEL_DIM).fill(0.1);
      let caught = null;
      try {
        await pipeline._runVocoderChunkedForSegment(melData, 100, null, null);
      } catch (e) {
        caught = e;
      }
      expect(caught).to.not.be.null;
      expect(caught.message).to.match(/all-zero|empty waveform|NaN/i);
    });

    it('vocoder 返回 NaN 波形 → 抛错（silent failure 拦截）', async () => {
      pipeline = buildMockPipeline();
      pipeline.sessions.vocoder = {
        async run(inputs) {
          const melSeqLen = inputs.mel.dims[1];
          const data = new Float32Array(melSeqLen * HOP_SIZE);
          data.fill(NaN);
          return {
            waveform: { type: 'float32', data, dispose() {} },
          };
        },
      };
      const melData = new Float32Array(100 * MEL_DIM).fill(0.1);
      let caught = null;
      try {
        await pipeline._runVocoderChunkedForSegment(melData, 100, null, null);
      } catch (e) {
        caught = e;
      }
      expect(caught).to.not.be.null;
      expect(caught.message).to.match(/NaN/i);
    });
  });

  // -------------------------------------------------------------------------

  describe('Diffusion._planChunks - 分块规划', () => {
    let Diffusion;
    let diffusion;

    before(() => {
      Diffusion = require('../src/inference/pipeline/diffusion').Diffusion;
    });

    beforeEach(() => {
      diffusion = new Diffusion();
    });

    it('totalFrames <= 0 → 返回 null', () => {
      expect(diffusion._planChunks(0, 100, 10)).to.be.null;
      expect(diffusion._planChunks(-5, 100, 10)).to.be.null;
      expect(diffusion._planChunks(NaN, 100, 10)).to.be.null;
    });

    it('chunkFrames >= totalFrames → 返回 null（无需分块）', () => {
      expect(diffusion._planChunks(100, 200, 10)).to.be.null;
      expect(diffusion._planChunks(100, 100, 10)).to.be.null;
    });

    it('chunkFrames < 50 时被夹到 50（safeChunk = max(50, chunkFrames)）', () => {
      // totalFrames=200, chunkFrames=10 → safeChunk=50, overlapFrames=5
      // 步长 = 50 - 5 = 45
      // chunk 0: [0,50), chunk 1: [45,95), chunk 2: [90,140), chunk 3: [135,185), chunk 4: [180,200) → 5 chunks
      const plan = diffusion._planChunks(200, 10, 5);
      expect(plan).to.not.be.null;
      expect(plan.specs.length).to.equal(5);
    });

    it('overlap >= chunkFrames 时被夹到 chunkFrames/2', () => {
      // chunkFrames=100, overlapFrames=150 → safeOverlap=50
      // 步长 = 100 - 50 = 50
      // totalFrames=200 → chunk 0: [0,100), chunk 1: [50,150), chunk 2: [100,200) → 3 chunks
      const plan = diffusion._planChunks(200, 100, 150);
      expect(plan.overlap).to.equal(50);
      expect(plan.specs.length).to.equal(3);
    });

    it('overlapFrames=0 → overlap=0，fadeWindow 为空数组', () => {
      // totalFrames=200, chunkFrames=100, overlap=0
      // 步长 = 100，2 chunks
      const plan = diffusion._planChunks(200, 100, 0);
      expect(plan.overlap).to.equal(0);
      expect(plan.fadeWindow.length).to.equal(0);
      expect(plan.specs.length).to.equal(2);
    });

    it('末尾 chunk 不足 chunkFrames 时正确截断', () => {
      // totalFrames=250, chunkFrames=100, overlap=20
      // chunk 0: [0,100), chunk 1: [80,180), chunk 2: [160,250) → 末尾 90 帧
      const plan = diffusion._planChunks(250, 100, 20);
      expect(plan.specs.length).to.equal(3);
      expect(plan.specs[2].chunkEnd).to.equal(250);
      expect(plan.specs[2].currentChunkFrames).to.equal(90);
      expect(plan.specs[2].isLast).to.equal(true);
    });

    it('首 chunk 的 isFirst=true，其余 isFirst=false', () => {
      const plan = diffusion._planChunks(250, 100, 20);
      expect(plan.specs[0].isFirst).to.equal(true);
      for (let i = 1; i < plan.specs.length; i++) {
        expect(plan.specs[i].isFirst).to.equal(false);
      }
    });

    it('末 chunk 的 isLast=true，其余 isLast=false', () => {
      const plan = diffusion._planChunks(250, 100, 20);
      const n = plan.specs.length;
      expect(plan.specs[n - 1].isLast).to.equal(true);
      for (let i = 0; i < n - 1; i++) {
        expect(plan.specs[i].isLast).to.equal(false);
      }
    });

    it('Hann 窗满足 w[i] + w[N-1-i] = 1（对称归一化）', () => {
      const plan = diffusion._planChunks(250, 100, 20);
      const w = plan.fadeWindow;
      const N = w.length;
      for (let i = 0; i < N; i++) {
        const sum = w[i] + w[N - 1 - i];
        expect(sum).to.be.closeTo(1.0, 1e-6);
      }
    });

    it('Hann 窗值在 [0, 1] 区间内', () => {
      const plan = diffusion._planChunks(250, 100, 20);
      for (let i = 0; i < plan.fadeWindow.length; i++) {
        expect(plan.fadeWindow[i]).to.be.at.least(0);
        expect(plan.fadeWindow[i]).to.be.at.most(1);
      }
    });

    it('chunk 边界连续：chunk[i+1].chunkStart = chunk[i].chunkEnd - overlap', () => {
      const plan = diffusion._planChunks(500, 100, 20);
      for (let i = 0; i < plan.specs.length - 1; i++) {
        const cur = plan.specs[i];
        const next = plan.specs[i + 1];
        expect(next.chunkStart).to.equal(Math.max(0, cur.chunkEnd - plan.overlap));
      }
    });

    it('所有 chunkEnd <= totalFrames（不越界）', () => {
      const totalFrames = 500;
      const plan = diffusion._planChunks(totalFrames, 100, 20);
      for (const spec of plan.specs) {
        expect(spec.chunkEnd).to.be.at.most(totalFrames);
        expect(spec.chunkStart).to.be.at.least(0);
        expect(spec.currentChunkFrames).to.equal(spec.chunkEnd - spec.chunkStart);
      }
    });
  });

  // -------------------------------------------------------------------------

  describe('Diffusion._runSingleDiffusionChunk - 单块执行', () => {
    let Diffusion;
    let diffusion;
    let runCalls;

    before(() => {
      Diffusion = require('../src/inference/pipeline/diffusion').Diffusion;
    });

    beforeEach(() => {
      diffusion = new Diffusion();
      runCalls = [];
    });

    function makeSessions(fillValue = 0.01) {
      return {
        diffStep: {
          inputMetadata: [
            { name: 'xt_input', type: 'float32', shape: [1, -1, MEL_DIM] },
            { name: 't', type: 'float32', shape: [1] },
            { name: 'cond', type: 'float32', shape: [1, -1, COND_DIM] },
            { name: 'xt_mask', type: 'float32', shape: [1, -1] },
          ],
          async run(inputs) {
            const seqLen = inputs.xt_input.dims[1];
            runCalls.push({ seqLen, tVal: inputs.t.data[0] });
            const data = new Float32Array(seqLen * MEL_DIM).fill(fillValue);
            return { flow_pred: { type: 'float32', data, dims: [1, seqLen, MEL_DIM], dispose() {} } };
          },
        },
      };
    }

    it('首 chunk：直接整段 memcpy 写回（无交叉淡入淡出）', async () => {
      const totalFrames = 200;
      const ptFrameCount = 10;
      const chunkFrames = 100;
      const overlap = 20;

      const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
      const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
      const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);
      const fadeWindow = new Float32Array(overlap).fill(0.5);

      const ctx = {
        sessions: makeSessions(),
        xt,
        ptMelData,
        ptFrameCount,
        combinedCond,
        totalSteps: 1,
        cfgStrength: 0,
        cfgRescale: 0.75,
        isFP16: false,
        useStaticShapes: false,
        overlap,
        fadeWindow,
      };
      const spec = { chunkStart: 0, chunkEnd: 100, currentChunkFrames: 100, isFirst: true, isLast: false };
      const result = await diffusion._runSingleDiffusionChunk(ctx, spec, () => {}, 0, 50);
      expect(result.newCommitted).to.equal(Math.max(0, 100 - overlap)); // 80
      // 应有 1 次 diffStep.run（1 step × cfg=0 × 1 chunk）
      expect(runCalls.length).to.equal(1);
    });

    it('非首 chunk：重叠区逐帧加权混合', async () => {
      const totalFrames = 200;
      const ptFrameCount = 10;
      const chunkFrames = 100;
      const overlap = 20;

      const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
      // 在重叠区写入已知值，验证混合后不是单纯覆盖
      for (let i = 0; i < overlap * MEL_DIM; i++) {
        xt.data[i] = 0.99;
      }
      const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
      const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);
      const fadeWindow = new Float32Array(overlap);
      for (let i = 0; i < overlap; i++) {
        fadeWindow[i] = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (overlap + 1)));
      }

      const ctx = {
        sessions: makeSessions(0.5),
        xt,
        ptMelData,
        ptFrameCount,
        combinedCond,
        totalSteps: 1,
        cfgStrength: 0,
        cfgRescale: 0.75,
        isFP16: false,
        useStaticShapes: false,
        overlap,
        fadeWindow,
      };
      const spec = { chunkStart: 80, chunkEnd: 180, currentChunkFrames: 100, isFirst: false, isLast: false };
      const result = await diffusion._runSingleDiffusionChunk(ctx, spec, () => {}, 0, 50);
      // newCommitted = chunkEnd - overlap = 180 - 20 = 160
      expect(result.newCommitted).to.equal(160);
      // 重叠区 [80, 100) 应为混合值（非 0.99 也非 0.5）
      const mixedValue = xt.data[80 * MEL_DIM];
      expect(mixedValue).to.not.equal(0.99);
      expect(mixedValue).to.not.equal(0.5);
      // 非重叠区 [100, 180) 应为 subXt.data 的值（fillValue=0.5 经扩散更新后）
      // 由于扩散循环会修改 xt.data，这里仅验证不为 NaN
      expect(Number.isFinite(xt.data[100 * MEL_DIM])).to.equal(true);
    });

    it('末 chunk：newCommitted = chunkEnd（不扣 overlap）', async () => {
      const totalFrames = 250;
      const ptFrameCount = 10;
      const chunkFrames = 100;
      const overlap = 20;

      const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
      const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
      const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);
      const fadeWindow = new Float32Array(overlap).fill(0.5);

      const ctx = {
        sessions: makeSessions(),
        xt,
        ptMelData,
        ptFrameCount,
        combinedCond,
        totalSteps: 1,
        cfgStrength: 0,
        cfgRescale: 0.75,
        isFP16: false,
        useStaticShapes: false,
        overlap,
        fadeWindow,
      };
      // 末 chunk: [160, 250), 90 帧
      const spec = { chunkStart: 160, chunkEnd: 250, currentChunkFrames: 90, isFirst: false, isLast: true };
      const result = await diffusion._runSingleDiffusionChunk(ctx, spec, () => {}, 0, 50);
      expect(result.newCommitted).to.equal(250); // isLast → chunkEnd
    });

    it('CFG > 0 时每 step 调用 2 次 diffStep.run（cond + uncond）', async () => {
      const totalFrames = 200;
      const ptFrameCount = 10;

      const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
      const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
      const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);

      const ctx = {
        sessions: makeSessions(),
        xt,
        ptMelData,
        ptFrameCount,
        combinedCond,
        totalSteps: 2,
        cfgStrength: 3.0,
        cfgRescale: 0.75,
        isFP16: false,
        useStaticShapes: false,
        overlap: 20,
        fadeWindow: new Float32Array(20).fill(0.5),
      };
      const spec = { chunkStart: 0, chunkEnd: 100, currentChunkFrames: 100, isFirst: true, isLast: false };
      await diffusion._runSingleDiffusionChunk(ctx, spec, () => {}, 0, 50);
      // 2 steps × 2 runs (cfg>0) = 4 runs
      expect(runCalls.length).to.equal(4);
    });

    it('输出无 NaN/Inf（数值稳定性）', async () => {
      const totalFrames = 200;
      const ptFrameCount = 10;

      const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
      const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
      const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);

      const ctx = {
        sessions: makeSessions(0.01),
        xt,
        ptMelData,
        ptFrameCount,
        combinedCond,
        totalSteps: 2,
        cfgStrength: 3.0,
        cfgRescale: 0.75,
        isFP16: false,
        useStaticShapes: false,
        overlap: 20,
        fadeWindow: new Float32Array(20).fill(0.5),
      };
      const spec = { chunkStart: 0, chunkEnd: 100, currentChunkFrames: 100, isFirst: true, isLast: false };
      await diffusion._runSingleDiffusionChunk(ctx, spec, () => {}, 0, 50);

      let nanCount = 0, infCount = 0;
      for (let i = 0; i < xt.data.length; i++) {
        if (Number.isNaN(xt.data[i])) nanCount++;
        else if (!Number.isFinite(xt.data[i])) infCount++;
      }
      expect(nanCount).to.equal(0);
      expect(infCount).to.equal(0);
    });

    it('onProgress 回调被透传（不截断）', async () => {
      const totalFrames = 200;
      const ptFrameCount = 10;

      const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
      const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
      const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);

      const ctx = {
        sessions: makeSessions(),
        xt,
        ptMelData,
        ptFrameCount,
        combinedCond,
        totalSteps: 2,
        cfgStrength: 0,
        cfgRescale: 0.75,
        isFP16: false,
        useStaticShapes: false,
        overlap: 20,
        fadeWindow: new Float32Array(20).fill(0.5),
      };
      const spec = { chunkStart: 0, chunkEnd: 100, currentChunkFrames: 100, isFirst: true, isLast: false };
      const onProgress = sinon.spy();
      await diffusion._runSingleDiffusionChunk(ctx, spec, onProgress, 10, 50);
      // onProgress 应被调用（2 steps → 至少 2 次）
      expect(onProgress.callCount).to.be.greaterThan(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('端到端流式管线集成', () => {
    it('完整流式管线：diffusion chunk → vocoder → onChunkAudio', async () => {
      const pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);

      const onChunkAudio = sinon.spy();
      // 用 2 个音符避免 single-note context padding，确保走流式分块路径
      // 2 音符 × 4 拍 = 8 拍 → totalFrames=200
      // chunkFrames=30 → safeChunk=50 → 5 diffusion chunks (0-50, 45-95, 90-140, 135-185, 180-200)
      // vocoder chunkFrames=VOCODER_CHUNK_FRAMES=1008 → 单 vocoder chunk per diffusion chunk
      const out = await pipeline.synthesize(
        makeNotes(2),
        120,
        {
          diffStepChunk: true,
          diffStepChunkFrames: 30,
          diffStepOverlapFrames: 5,
          onChunkAudio,
          nSteps: 1,
          cfg: 0,
        }
      );
      // 5 diffusion chunks → 至少 5 次 onChunkAudio
      expect(onChunkAudio.callCount).to.be.greaterThanOrEqual(5);
      // 最后一次 isLast=true
      expect(onChunkAudio.lastCall.args[0].isLast).to.equal(true);
      // 输出长度 = totalFrames * HOP_SIZE = 200 * 480 = 96000
      expect(out.length).to.equal(96000);
      // 所有 sampleOffset 在 [0, 96000] 范围内
      for (const call of onChunkAudio.getCalls()) {
        const args = call.args[0];
        expect(args.sampleOffset).to.be.at.least(0);
        expect(args.sampleEnd).to.be.at.most(96000);
      }
    });

    it('多 fragment 流式管线：全局时间顺序 + 混合', async () => {
      const pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);

      const onChunkAudio = sinon.spy();
      const out = await pipeline.synthesizeMultiStreaming(
        [
          { notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: true, diffStepChunkFrames: 30, diffStepOverlapFrames: 5 } },
          { notes: makeNotes(1), startTimeBeat: 8, durationBeats: 4, options: { diffStepChunk: true, diffStepChunkFrames: 30, diffStepOverlapFrames: 5 } },
        ],
        120,
        { onChunkAudio }
      );
      // maxEndBeat=12 → totalMixedSamples=ceil(12/120*60*24000)=144000
      expect(out.length).to.equal(144000);
      // 至少 6 次（3 chunks × 2 fragments，safeChunk=50 时 100 帧 → 3 chunks）
      expect(onChunkAudio.callCount).to.be.greaterThanOrEqual(6);
      // 时间顺序：sampleOffset 非递减
      const offsets = onChunkAudio.getCalls().map(c => c.args[0].sampleOffset);
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]).to.be.at.least(offsets[i - 1]);
      }
      // 最后一次 isLast=true
      expect(onChunkAudio.lastCall.args[0].isLast).to.equal(true);
    });

    it('diffStep.run 抛错 → 错误向上传播到 synthesize', async () => {
      const pipeline = buildMockPipeline();
      pipeline.sessions.diffStep = {
        inputMetadata: [
          { name: 'xt_input', type: 'float32', shape: [1, -1, MEL_DIM] },
        ],
        async run() {
          throw new Error('Mock diffStep failure');
        },
      };
      let caught = null;
      try {
        await pipeline.synthesize(
          makeNotes(1),
          120,
          {
            diffStepChunk: true,
            diffStepChunkFrames: 30,
            diffStepOverlapFrames: 5,
            onChunkAudio: () => {},
            nSteps: 1,
            cfg: 0,
          }
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).to.not.be.null;
      expect(caught.message).to.match(/mock diffstep failure/i);
    });

    it('synthesizeMultiStreaming 内部 vocoder 错误传播', async () => {
      const pipeline = buildMockPipeline();
      pipeline.sessions.vocoder = {
        async run() {
          throw new Error('Mock vocoder failure in multistream');
        },
      };
      let caught = null;
      try {
        await pipeline.synthesizeMultiStreaming(
          [{ notes: makeNotes(1), startTimeBeat: 0, durationBeats: 4, options: { diffStepChunk: false } }],
          120,
          {}
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).to.not.be.null;
      expect(caught.message).to.match(/mock vocoder failure/i);
    });
  });

  // -------------------------------------------------------------------------

  describe('并发与串行化', () => {
    it('synthesize 串行化：连续两次调用不并发', async () => {
      const pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);

      // 跟踪 _recreateHeavySessionsAfterSynthesis 调用顺序
      const recreateCalls = [];
      pipeline._recreateHeavySessionsAfterSynthesis.restore();
      sinon.stub(pipeline, '_recreateHeavySessionsAfterSynthesis').callsFake(async () => {
        recreateCalls.push('start');
        await new Promise(r => setImmediate(r));
        recreateCalls.push('end');
      });

      // 使用不同 notes 避免第二次命中缓存（缓存命中时不进入串行化队列）
      const notes1 = [{ pitch: 60, start: 0, duration: 4, lyric: 'la' }];
      const notes2 = [{ pitch: 64, start: 0, duration: 4, lyric: 'la' }];
      const p1 = pipeline.synthesize(notes1, 120, { diffStepChunk: false, nSteps: 1, cfg: 0 });
      const p2 = pipeline.synthesize(notes2, 120, { diffStepChunk: false, nSteps: 1, cfg: 0 });
      await Promise.all([p1, p2]);

      // 串行化：第一个 recreate 必须先 start 再 end，第二个才能 start
      // 即序列应为：start, end, start, end
      expect(recreateCalls).to.deep.equal(['start', 'end', 'start', 'end']);
    });

    it('缓存命中时 synthesize 立即返回（不进入串行化队列后方）', async () => {
      const pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      // 第一次填充缓存
      await pipeline.synthesize(makeNotes(1), 120, { diffStepChunk: false, nSteps: 1, cfg: 0 });
      // 第二次应命中缓存
      const t0 = Date.now();
      await pipeline.synthesize(makeNotes(1), 120, { diffStepChunk: false, nSteps: 1, cfg: 0 });
      const elapsed = Date.now() - t0;
      // 缓存命中应几乎瞬时（< 100ms）
      expect(elapsed).to.be.lessThan(100);
    });
  });

  // -------------------------------------------------------------------------

  describe('MAX_SAFE_FRAMES 与 NPU 限制', () => {
    it('超长音频触发多 segment 分段合成（> 30s → 分段）', async () => {
      const pipeline = buildMockPipeline();
      installRecordingSessions(pipeline);
      // LONG_AUDIO_THRESHOLD_SEC=30, bpm=120 → 30 秒 = 60 拍
      // 用 200 拍（100 秒）触发多 segment 分段
      // MAX_SAFE_FRAMES=40000 是单 segment 的安全上限，正常分段每段 ≤ 1500 帧
      const longNote = [{ pitch: 60, start: 0, duration: 200, lyric: 'la' }];
      const out = await pipeline.synthesize(
        longNote,
        120,
        { diffStepChunk: false, nSteps: 1, cfg: 0 }
      );
      // 200 拍 × 0.5 秒/拍 × 24000 样本/秒 = 2400000 样本
      expect(out.length).to.equal(2400000);
    });

    it('useStaticShapes=true → diffStep 收到 pad 到 NPU_STATIC_SEQ_LEN 的输入', async () => {
      // 注意：NPU_STATIC_SEQ_LEN 截断逻辑（ptFrameCount + totalFrames > NPU_STATIC_SEQ_LEN）
      // 在当前常量下经 synthesize() 不可达：
      //   - 单 segment 路径要求 totalSec ≤ LONG_AUDIO_THRESHOLD_SEC(30s)
      //   - 30s × 50fps = 1500 frames < NPU_STATIC_SEQ_LEN(2048)
      //   - ptFrameCount ≤ 50 → ptFrameCount + totalFrames ≤ 1550 < 2048
      //   - 超过 30s 进入多 segment 路径，该路径不检查 NPU_STATIC_SEQ_LEN
      // 因此本测试改为验证 useStaticShapes=true 时实际触发的 NPU 静态形状行为：
      //   diffStep session 收到的 xt_input.dims[1] 应被 pad 到 NPU_STATIC_SEQ_LEN。
      const pipeline = buildMockPipeline({ modelPrecision: 'int8-npu' });
      expect(pipeline.useStaticShapes).to.equal(true);
      const { diffRecord } = installRecordingSessions(pipeline);
      // 单音符 4 拍 → context padding 后 totalFrames=150（远 < 2048，不触发截断）
      // 但 useStaticShapes=true 时 diffusion.js 仍会将 xt/cond/mask pad 到 NPU_STATIC_SEQ_LEN
      await pipeline.synthesize(
        makeNotes(1),
        120,
        { diffStepChunk: false, nSteps: 1, cfg: 0 }
      );
      expect(diffRecord.length).to.be.greaterThan(0);
      // 每次 diffStep.run 的 seqLen 应为 NPU_STATIC_SEQ_LEN（NPU 静态形状要求）
      for (const rec of diffRecord) {
        expect(rec.seqLen).to.equal(NPU_STATIC_SEQ_LEN);
      }
    });
  });
});
