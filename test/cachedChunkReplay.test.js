/**
 * 整段音频缓存命中时，必须把缓存按块"重放"给流式消费方。
 *
 * 背景：`_synthesizeImpl` 命中 `_synthCacheGet` 后直接 return，一个 chunk 都不发。
 * 分片编辑器据此认为"流式从未启动"，退化成"等 invoke 把整段 PCM 传完再整段开播"，
 * 表现为"明明有缓存，点播放却不流式、且从中段起播要先等整段传输"。
 */
const { expect } = require('chai');
const { OnnxSVSPipeline } = require('../src/inference/pipeline');
const { SAMPLE_RATE } = require('../src/inference/pipeline/constants');

describe('缓存命中的流式重放', () => {
  it('5s 缓存 → 按 2s 切块，偏移连续、只有末块 isLast', () => {
    const pipeline = new OnnxSVSPipeline('/fake/model/dir/');
    const audio = new Float32Array(5 * SAMPLE_RATE).fill(0.1);
    const chunks = [];
    pipeline._emitCachedAudioAsChunks(audio, (c) => chunks.push(c), 2);

    expect(chunks.map((c) => [c.sampleOffset, c.sampleEnd])).to.deep.equal([
      [0, 2 * SAMPLE_RATE],
      [2 * SAMPLE_RATE, 4 * SAMPLE_RATE],
      [4 * SAMPLE_RATE, 5 * SAMPLE_RATE],
    ]);
    expect(chunks.map((c) => c.isLast)).to.deep.equal([false, false, true]);
    expect(chunks[0].totalSamples).to.equal(audio.length);
    expect(chunks[0].chunkIndex).to.equal(0);
    expect(chunks[2].chunkIndex).to.equal(2);
    expect(chunks[1].audio.length).to.equal(2 * SAMPLE_RATE);
  });

  it('没有流式回调 / 空音频：不产生 chunk，也不抛错', () => {
    const pipeline = new OnnxSVSPipeline('/fake/model/dir/');
    expect(() => pipeline._emitCachedAudioAsChunks(new Float32Array(10), null)).to.not.throw();
    const chunks = [];
    pipeline._emitCachedAudioAsChunks(new Float32Array(0), (c) => chunks.push(c));
    expect(chunks).to.have.lengthOf(0);
  });

  it('回调抛错时停止重放（不让一条坏链路拖垮整次合成）', () => {
    const pipeline = new OnnxSVSPipeline('/fake/model/dir/');
    let n = 0;
    const audio = new Float32Array(6 * SAMPLE_RATE);
    pipeline._emitCachedAudioAsChunks(audio, () => {
      n += 1;
      if (n === 2) throw new Error('ipc closed');
    }, 2);
    expect(n, '第二个块抛错后不再继续').to.equal(2);
  });
});
