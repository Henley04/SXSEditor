'use strict';
/**
 * 计划 4.4：流式分轨路由。
 *
 *   · pipeline 把来源 trackId 透传进 streamManifest 和每个 chunk；
 *   · 渲染层收到带 trackId 的 chunk 时按轨路由到对应 GainNode，初值取当前
 *     可听性（静音轨首 chunk 不漏音），无 trackId 时回落 master gain；
 *   · 流式返回值升级为 { audio, segments }，并兼容旧 Float32Array。
 *
 * 测试策略沿用 streamingSynthesis.test.js：mock diffStep / vocoder session，
 * stub 所有触碰磁盘 / GPU 的方法，保留真实的纯逻辑（分片预处理、时间序队列、
 * chunk 发射）。
 */
const { expect } = require('chai');
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');
const { OnnxSVSPipeline } = require('../src/inference/pipeline');
const { MEL_DIM, COND_DIM } = require('../src/inference/pipeline/constants');

const EMBED_DIM = 512;

function makeMockDiffStepSession() {
  return {
    inputMetadata: [
      { name: 'xt_input', type: 'float32', shape: [1, -1, MEL_DIM] },
      { name: 't', type: 'float32', shape: [1] },
      { name: 'cond', type: 'float32', shape: [1, -1, COND_DIM] },
      { name: 'xt_mask', type: 'float32', shape: [1, -1] },
    ],
    async run(inputs) {
      const seqLen = inputs.xt_input.dims[1];
      const data = new Float32Array(seqLen * MEL_DIM).fill(0.01);
      return {
        flow_pred: { type: 'float32', data, dims: [1, seqLen, MEL_DIM], dispose() {} },
      };
    },
  };
}

function makeMockVocoderSession() {
  return {
    async run(inputs) {
      const melSeqLen = inputs.mel.dims[1];
      const waveLen = melSeqLen * 480; // HOP_SIZE
      const data = new Float32Array(waveLen).fill(0.5);
      return {
        waveform: { type: 'float32', data, dispose() {} },
      };
    },
  };
}

function makeMockEncoderSession() {
  return {
    async run() {
      return { embeddings: { type: 'float32', data: new Float32Array(EMBED_DIM).fill(0.1), dispose() {} } };
    },
  };
}

function buildMockPipeline() {
  const pipeline = new OnnxSVSPipeline('/fake/model/dir/', {});
  pipeline.initialized = true;
  pipeline.isFP16 = false;
  pipeline.diffStepIsFP16 = false;
  pipeline.vocoderIsFP16 = false;
  pipeline.vocoderType = 'default';
  pipeline.useWebNN = false;
  pipeline.sessionEPs = { diffStep: 'dml', vocoder: 'dml' };
  pipeline._resolvedVocoderFile = 'vocoder_dml.onnx';
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
  sinon.stub(pipeline, '_runEncoder').callsFake(async (_seq, _tok, totalFrames, ptFrameCount = 0) => {
    return new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);
  });
  sinon.stub(pipeline, '_recreateHeavySessionsAfterSynthesis').resolves();
  sinon.stub(pipeline, '_resolveVocoderChunkFrames').returns(0);
  sinon.stub(pipeline, '_maybeUnloadDiffStepBeforeVocoder').returns(false);
  sinon.stub(pipeline, '_reloadDiffStepAfterVocoder').resolves();
  sinon.stub(pipeline, '_extractRefF0WithFallback').resolves(null);
  sinon.stub(pipeline, '_extractRefMelOnnx').resolves({ data: new Float32Array(0), frames: 0 });
  sinon.stub(pipeline, '_extractRefMelAsync').resolves({ data: new Float32Array(0), frames: 0 });
  sinon.stub(pipeline, '_extractRefNotePitchesAsync').resolves([]);
  sinon.stub(pipeline, 'loadModel').resolves({ success: true });
  return pipeline;
}

function makeNotes(count = 1) {
  const notes = [];
  for (let i = 0; i < count; i++) {
    notes.push({ pitch: 60 + i, start: i * 4, duration: 4, lyric: 'la' });
  }
  return notes;
}

function makeFragment(trackId, startTimeBeat, opts = {}) {
  const frag = {
    notes: makeNotes(1),
    startTimeBeat,
    durationBeats: 4,
    options: { diffStepChunk: false },
  };
  if (trackId !== undefined) frag.trackId = trackId;
  if (opts.singerId !== undefined) frag.options.singerId = opts.singerId;
  return frag;
}

describe('流式分轨路由 (4.4)', () => {
  describe('pipeline: trackId 透传到 chunk 与 streamManifest', () => {
    let pipeline;

    beforeEach(() => {
      pipeline = buildMockPipeline();
    });

    it('每条 fragment 的 trackId 随每个 chunk 下发', async () => {
      const onChunkAudio = sinon.spy();
      await pipeline.synthesizeMultiStreaming(
        [makeFragment('singer-A', 0), makeFragment('singer-B', 4)],
        120,
        { onChunkAudio },
      );

      expect(onChunkAudio.callCount).to.be.greaterThan(0);
      const ids = new Set(onChunkAudio.getCalls().map((c) => c.args[0].trackId));
      expect(ids.has('singer-A'), 'A 轨 chunk 必须带 singer-A').to.equal(true);
      expect(ids.has('singer-B'), 'B 轨 chunk 必须带 singer-B').to.equal(true);
      expect([...ids].every((id) => id === 'singer-A' || id === 'singer-B')).to.equal(true);
    });

    it('streamManifest 每项带对应 trackId（key 形如 fragIdx:regionIdx）', async () => {
      const onChunkAudio = sinon.spy();
      await pipeline.synthesizeMultiStreaming(
        [makeFragment('singer-A', 0), makeFragment('singer-B', 4)],
        120,
        { onChunkAudio },
      );

      const manifest = onChunkAudio.firstCall.args[0].streamManifest;
      expect(manifest).to.be.an('array');
      expect(manifest).to.have.lengthOf(2);
      const byKey = Object.fromEntries(manifest.map((m) => [m.key, m.trackId]));
      expect(byKey['0:0']).to.equal('singer-A');
      expect(byKey['1:0']).to.equal('singer-B');
    });

    it('fragment 无 trackId 时用 options.singerId 兜底', async () => {
      const onChunkAudio = sinon.spy();
      await pipeline.synthesizeMultiStreaming(
        [makeFragment(undefined, 0, { singerId: 'singer-fallback' })],
        120,
        { onChunkAudio },
      );

      expect(onChunkAudio.callCount).to.be.greaterThan(0);
      for (const call of onChunkAudio.getCalls()) {
        expect(call.args[0].trackId).to.equal('singer-fallback');
      }
    });

    it('两者都无时 trackId 为 null，保持旧路径兼容', async () => {
      const onChunkAudio = sinon.spy();
      await pipeline.synthesizeMultiStreaming(
        [makeFragment(null, 0)],
        120,
        { onChunkAudio },
      );

      expect(onChunkAudio.callCount).to.be.greaterThan(0);
      for (const call of onChunkAudio.getCalls()) {
        expect(call.args[0].trackId).to.equal(null);
      }
    });

    it('缓存命中与 mel 复用路径同样带 trackId（所有 chunk 发射点统一）', async () => {
      const onChunkAudio = sinon.spy();
      const frags = [makeFragment('singer-A', 0)];
      // 第一次：正常合成并填充 chunk 缓存
      await pipeline.synthesizeMultiStreaming(frags, 120, { onChunkAudio });
      const firstIds = onChunkAudio.getCalls().map((c) => c.args[0].trackId);
      expect(firstIds.length).to.be.greaterThan(0);
      expect(firstIds.every((id) => id === 'singer-A')).to.equal(true);

      // 第二次：同一工程重放，走缓存命中路径；trackId 仍必须随 chunk 下发
      onChunkAudio.resetHistory();
      await pipeline.synthesizeMultiStreaming(frags, 120, { onChunkAudio });
      const secondIds = onChunkAudio.getCalls().map((c) => c.args[0].trackId);
      expect(secondIds.length).to.be.greaterThan(0);
      expect(secondIds.every((id) => id === 'singer-A'), '缓存命中 chunk 也必须带 trackId').to.equal(true);
    });
  });

  describe('渲染层: chunk → 对应轨 GainNode 路由契约', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'audioPlayback.js'), 'utf8');

    it('chunk 带 trackId 时经 getOrCreateTrackGain 路由，初值取当前可听性', () => {
      expect(src).to.match(/if \(chunkInfo\.trackId\)/);
      expect(src).to.match(/getOrCreateTrackGain\(/);
      expect(src).to.match(/computeAudibility\(currentSingers\)/);
      expect(src).to.match(/source\.connect\(chunkGain\)/);
    });

    it('无 trackId 的 chunk 回落 master gain（兼容旧主进程）', () => {
      expect(src).to.match(/let chunkGain = state\.gainNode;/);
      expect(src).to.match(/\|\| state\.gainNode;/);
    });

    it('多片段在新一轮合成开始时清空旧分轨数据', () => {
      expect(src).to.match(/state\.trackSegments = \[\];/);
      expect(src).to.match(/state\.trackSegmentsReady = false;/);
    });

    it('流式返回结构兼容 { audio, segments } 与旧 Float32Array', () => {
      expect(src).to.match(/result && !ArrayBuffer\.isView\(result\) && result\.audio \? result\.audio : result/);
      expect(src).to.match(/state\.trackSegments = returnedSegments;/);
      expect(src).to.match(/state\.trackSegmentsReady = returnedSegments\.length > 0;/);
    });
  });
});
