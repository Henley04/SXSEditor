const { expect } = require('chai');
const sinon = require('sinon');
const { OnnxSVSPipeline } = require('../src/inference/pipeline');
const { SAMPLE_RATE } = require('../src/inference/pipeline/constants');

/**
 * 多 segment 流式发射器（_createSegmentStreamEmitter）回归测试。
 *
 * 背景（2026-10-18 修复）：synthesize() 多 segment 路径（分片 >20s 或含 ≥1.5s
 * 长休止）旧实现完全不推送 chunk，分片编辑器播放预览必须等全部推理完才开播。
 * 修复后由发射器在 segment 粒度上按时间顺序门控发射：
 *   - 乱序完成（priorityTimeSec 重排 / 分片缓存命中）先缓冲，时间序前面的
 *     segment 全部发射完才轮到后段；
 *   - region 间长休止中心补静音 chunk（与最终混音的零填充区一致）；
 *   - 同 region 20s 分段的 2s 重叠：保留前序整段、裁掉后续头部，接头 15ms 渐变；
 *   - isLast 只随时间轴最后一个 chunk 发出（空 segment 收尾补 1 样本）。
 *
 * 渲染端（fragmentEditor/audioPlayback.js）按到达顺序无缝拼接 chunk、不感知
 * 采样偏移 —— 因此"时间轴连续 + 严格时间序"是本发射器的核心合约。
 */

/** 构造跳过真实模型加载的 pipeline 实例（仅用其纯逻辑方法） */
function buildPipeline() {
  const pipeline = new OnnxSVSPipeline('/fake/model/dir/', {});
  return pipeline;
}

/** bpm=60 → 1 beat = 1s，便于用秒直接写拍位 */
const BPM = 60;
const SEC = SAMPLE_RATE; // 1 秒的样本数

/** 收集 onChunkAudio 回调的辅助：返回 {emitter, chunks} */
function makeEmitter(segments, { firstNoteStartBeat = 0, totalSamples = null } = {}) {
  const chunks = [];
  const pipeline = buildPipeline();
  const ts = totalSamples != null
    ? totalSamples
    : Math.floor((segments[segments.length - 1].endBeat / BPM) * 60 * SAMPLE_RATE);
  const emitter = pipeline._createSegmentStreamEmitter(
    segments, BPM, firstNoteStartBeat, ts,
    (c) => chunks.push(c),
  );
  return { emitter, chunks };
}

function makeAudio(seconds, fill = 0.1) {
  return new Float32Array(Math.round(seconds * SEC)).fill(fill);
}

describe('多 segment 流式发射器 (_createSegmentStreamEmitter)', () => {
  describe('时间顺序门控', () => {
    it('后段先完成时不发射；前段完成后按时间序一次发射两段', () => {
      const segA = { startBeat: 0, endBeat: 10 };
      const segB = { startBeat: 10, endBeat: 20 };
      const { emitter, chunks } = makeEmitter([segA, segB]);
      const audioA = makeAudio(10, 0.1);
      const audioB = makeAudio(10, 0.2);

      emitter.segmentDone(1, audioB);
      expect(chunks).to.have.lengthOf(0); // segA 未完成，B 必须缓冲

      emitter.segmentDone(0, audioA);
      expect(chunks).to.have.lengthOf(2);
      expect(chunks[0].audio[0]).to.be.closeTo(0.1, 1e-6); // 先 A
      expect(chunks[0].isLast).to.equal(false);
      expect(chunks[1].audio[0]).to.be.closeTo(0.2, 1e-6); // 后 B
      expect(chunks[1].isLast).to.equal(true);
      // 时间轴连续：B 的起点 = A 的终点
      expect(chunks[0].sampleOffset).to.equal(0);
      expect(chunks[1].sampleOffset).to.equal(chunks[0].sampleEnd);
    });

    it('重复 segmentDone 与未知 segIdx 被忽略', () => {
      const segA = { startBeat: 0, endBeat: 10 };
      const { emitter, chunks } = makeEmitter([segA]);
      const audio = makeAudio(10);
      emitter.segmentDone(0, audio);
      emitter.segmentDone(0, audio); // 重复
      emitter.segmentDone(99, audio); // 未知
      expect(chunks).to.have.lengthOf(1);
    });
  });

  describe('region 间长休止静音填充', () => {
    it('相邻 region 间隙补全零静音 chunk，时间轴与最终混音一致', () => {
      // splitLongRestRegions 语义：region1 [0, 4.15]，region2 [5.85, 10]
      const segA = { startBeat: 0, endBeat: 4.15 };
      const segB = { startBeat: 5.85, endBeat: 10 };
      const { emitter, chunks } = makeEmitter([segA, segB]);
      const audioA = makeAudio(4.15, 0.1);
      const audioB = makeAudio(4.15, 0.2);

      emitter.segmentDone(1, audioB); // 乱序：B 先完成
      emitter.segmentDone(0, audioA);

      expect(chunks).to.have.lengthOf(3);
      const [c0, gap, c2] = chunks;
      expect(c0.audio[0]).to.be.closeTo(0.1, 1e-6);
      expect(c0.isLast).to.equal(false);
      // 静音 chunk 覆盖 [4.15s, 5.85s)
      expect(gap.sampleOffset).to.equal(c0.sampleEnd);
      expect(gap.sampleEnd).to.equal(Math.round(5.85 * SEC));
      for (let i = 0; i < gap.audio.length; i++) {
        if (gap.audio[i] !== 0) {
          throw new Error(`silence chunk nonzero at ${i}: ${gap.audio[i]}`);
        }
      }
      expect(gap.isLast).to.equal(false);
      // B 从 5.85s 开始，是最后一个 chunk
      expect(c2.sampleOffset).to.equal(Math.round(5.85 * SEC));
      expect(c2.audio[0]).to.be.closeTo(0.2, 1e-6);
      expect(c2.isLast).to.equal(true);
    });
  });

  describe('2s 重叠裁剪与接头渐变', () => {
    it('后段裁掉与前序重叠的头部，前段尾部渐出、后段头部渐入', () => {
      const segA = { startBeat: 0, endBeat: 20 };
      const segB = { startBeat: 18, endBeat: 38 };
      const { emitter, chunks } = makeEmitter([segA, segB]);
      const audioA = makeAudio(20, 0.1);
      const audioB = makeAudio(20, 0.2);
      const audioBOriginalHead = audioB[0];
      const audioAOriginalTail = audioA[audioA.length - 1];

      emitter.segmentDone(0, audioA);
      emitter.segmentDone(1, audioB);

      expect(chunks).to.have.lengthOf(2);
      const [c0, c1] = chunks;
      // A 整段发射（20s），尾部 15ms 渐出但缓存原数组不被污染
      expect(c0.audio.length).to.equal(Math.round(20 * SEC));
      expect(c0.audio[c0.audio.length - 1]).to.be.lessThan(0.1); // 渐出
      expect(audioAOriginalTail).to.be.closeTo(0.1, 1e-6); // 原始缓存音频不变
      // B 裁掉 2s 重叠头部：发射长度 = 20s - 2s
      expect(c1.audio.length).to.equal(Math.round(18 * SEC));
      expect(c1.sampleOffset).to.equal(Math.round(20 * SEC));
      expect(c1.audio[0]).to.be.lessThan(audioBOriginalHead); // 渐入
      expect(c1.audio[c1.audio.length - 1]).to.be.closeTo(0.2, 1e-6);
      expect(c1.isLast).to.equal(true);
      // B 的原始音频头部不被污染（裁剪用 slice）
      expect(audioB[0]).to.be.closeTo(audioBOriginalHead, 1e-9);
    });

    it('发射后 frontier 前进量与发射内容长度一致（无采样漂移）', () => {
      const segA = { startBeat: 0, endBeat: 20 };
      const segB = { startBeat: 18, endBeat: 38 };
      const { emitter, chunks } = makeEmitter([segA, segB]);
      emitter.segmentDone(0, makeAudio(20, 0.1));
      emitter.segmentDone(1, makeAudio(20, 0.2));
      let acc = 0;
      for (const c of chunks) {
        expect(c.sampleOffset).to.equal(acc);
        acc = c.sampleEnd;
      }
      expect(acc).to.equal(Math.round(38 * SEC));
    });
  });

  describe('firstNoteStart 偏移与 isLast 收尾', () => {
    it('分片以休止开头时首段裁掉前导休止（audioData[0] 对齐首音符）', () => {
      const segA = { startBeat: 0, endBeat: 12 }; // 前导休止已补，音频从拍 0 开始
      const { emitter, chunks } = makeEmitter([segA], { firstNoteStartBeat: 2 });
      emitter.segmentDone(0, makeAudio(12, 0.1));
      expect(chunks).to.have.lengthOf(1);
      expect(chunks[0].sampleOffset).to.equal(0);
      expect(chunks[0].audio.length).to.equal(Math.round(10 * SEC)); // 12s - 2s 前导
      expect(chunks[0].isLast).to.equal(true);
    });

    it('最后一个 segment 为空时补静音 chunk 承载 isLast（时间轴补到末尾）', () => {
      const segA = { startBeat: 0, endBeat: 10 };
      const segB = { startBeat: 10, endBeat: 20 };
      const { emitter, chunks } = makeEmitter([segA, segB]);
      emitter.segmentDone(0, makeAudio(10, 0.1));
      emitter.segmentDone(1, new Float32Array(0)); // 空结果（全休止 / 异常）
      expect(chunks).to.have.lengthOf(2);
      expect(chunks[0].isLast).to.equal(false);
      // 末段无音频：补一段静音把时间轴补到末尾，并承载 isLast
      expect(chunks[1].isLast).to.equal(true);
      expect(chunks[1].sampleOffset).to.equal(Math.round(10 * SEC));
      expect(chunks[1].sampleEnd).to.equal(Math.round(20 * SEC));
      for (let i = 0; i < chunks[1].audio.length; i++) {
        if (chunks[1].audio[i] !== 0) throw new Error(`tail silence nonzero at ${i}`);
      }
    });

    it('末段 vocoder 取整导致的尾部缺口由最后一个 chunk 补静音（流式长度 == 最终长度）', () => {
      // 真模型实测：末段音频比时间轴短约 241 样本（~10ms）
      const totalSamples = Math.round(10.01 * SEC);
      const segA = { startBeat: 0, endBeat: 10 };
      const audioA = makeAudio(10, 0.1);
      const { emitter, chunks } = makeEmitter([segA], { totalSamples });
      emitter.segmentDone(0, audioA);
      expect(chunks).to.have.lengthOf(1); // 补在最后一个 chunk 内，不追加
      const last = chunks[0];
      expect(last.isLast).to.equal(true);
      expect(last.sampleEnd).to.equal(totalSamples);      // 流式时间轴 == 最终时间轴
      expect(last.audio.length).to.equal(totalSamples);
      for (let i = audioA.length; i < last.audio.length; i++) {
        if (last.audio[i] !== 0) throw new Error(`tail padding nonzero at ${i}`);
      }
      expect(audioA.length).to.equal(Math.round(10 * SEC)); // 原始音频不被就地扩写
    });
  });

  describe('synthesize() 多 segment 路径端到端接线', () => {
    it('含长休止的分片：segment 合成完成后按时间序推送 chunk（乱序完成被缓冲）', async () => {
      const pipeline = buildPipeline();
      pipeline.initialized = true;
      pipeline.isFP16 = false;
      pipeline.diffStepIsFP16 = false;
      pipeline.vocoderIsFP16 = false;
      pipeline.vocoderType = 'default';
      pipeline.useWebNN = false;
      pipeline.sessionEPs = { diffStep: 'dml', vocoder: 'dml' };

      // 分片：乐句 [0,4] + 长休止 [4,6] + 乐句 [6,10]（bpm=60，休止 2s ≥ 1.5s）
      const notes = [
        { pitch: 60, start: 0, duration: 4, lyric: 'la' },
        { pitch: 62, start: 6, duration: 4, lyric: 'la' },
      ];
      // 不加载真实模型
      sinon.stub(pipeline, 'ensureAllModelsLoaded').resolves();

      // 记录 _synthesizeSegment 调用顺序，并返回与 segment 时长一致的音频
      // （rest[14] = segStartBeat，实参序见 _synthesizeSegment 签名）
      const synthCalls = [];
      sinon.stub(pipeline, '_synthesizeSegment').callsFake(async (segNotes, bpm, ...rest) => {
        const segStartBeat = rest[14];
        const segEndBeat = segStartBeat + segNotes[segNotes.length - 1].start
          + segNotes[segNotes.length - 1].duration;
        synthCalls.push(segStartBeat);
        return { audio: makeAudio(segEndBeat - segStartBeat, 0.1), frames: 1 };
      });
      sinon.stub(pipeline, '_recreateHeavySessionsAfterSynthesis').resolves();

      const chunks = [];
      // priorityTimeSec=7（落在第二个 region）→ 推理顺序 [seg1, seg0]，
      // 发射器必须缓冲 seg1、待 seg0 完成后按时间序发射。
      await pipeline.synthesize(notes, BPM, {
        priorityTimeSec: 7,
        onChunkAudio: (c) => chunks.push(c),
      });

      expect(synthCalls).to.have.lengthOf(2);
      expect(synthCalls[0]).to.equal(5.85); // 先推理后段（priority）
      expect(synthCalls[1]).to.equal(0);
      expect(chunks).to.have.lengthOf(3);
      expect(chunks[0].sampleOffset).to.equal(0); // seg0（后完成但先发射）
      expect(chunks[0].isLast).to.equal(false);
      // 长休止静音填充
      expect(chunks[1].sampleEnd).to.equal(Math.round(5.85 * SEC));
      expect(chunks[1].isLast).to.equal(false);
      expect(chunks[2].sampleOffset).to.equal(Math.round(5.85 * SEC));
      expect(chunks[2].isLast).to.equal(true);
    });

    it('不传 onChunkAudio（导出 / 主页面路径）时不创建发射器、行为不变', async () => {
      const pipeline = buildPipeline();
      pipeline.initialized = true;
      pipeline.isFP16 = false;
      pipeline.diffStepIsFP16 = false;
      pipeline.vocoderIsFP16 = false;
      pipeline.vocoderType = 'default';
      pipeline.useWebNN = false;
      pipeline.sessionEPs = { diffStep: 'dml', vocoder: 'dml' };

      const notes = [
        { pitch: 60, start: 0, duration: 4, lyric: 'la' },
        { pitch: 62, start: 6, duration: 4, lyric: 'la' },
      ];
      // 不加载真实模型
      sinon.stub(pipeline, 'ensureAllModelsLoaded').resolves();
      const spy = sinon.spy(pipeline, '_createSegmentStreamEmitter');
      sinon.stub(pipeline, '_synthesizeSegment').callsFake(async () => ({ audio: makeAudio(4.15), frames: 1 }));
      sinon.stub(pipeline, '_recreateHeavySessionsAfterSynthesis').resolves();

      const audio = await pipeline.synthesize(notes, BPM, {});
      expect(spy.called).to.equal(false);
      expect(audio).to.be.an.instanceOf(Float32Array);
    });
  });
});
