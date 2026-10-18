/**
 * mel 级 LRU 缓存（原始 diffstep mel）行为。
 *
 * 合约：音色曲线（melPostprocess）修改 → 原始 mel 复用（命中）；
 * 音高曲线等 diffstep 输入修改 → 键不同（必然 miss → 重新推理）。
 * 键的正确性在 synthCacheKeyMelPostprocess.test.js 钉死，这里只测 LRU 本身。
 */
const { expect } = require('chai');
const { NativeSVSPipeline } = require('../src/inference/pipeline');

function makeMel(frames) {
  return new Float32Array(frames * 80);
}

describe('mel cache LRU', () => {
  let pipeline;
  beforeEach(() => {
    pipeline = new NativeSVSPipeline('/fake/');
  });

  it('put 后 get 命中同一 mel 引用与帧数', () => {
    const mel = makeMel(10);
    pipeline._melCachePut('k1', { mel, frames: 10 });
    const hit = pipeline._melCacheGet('k1');
    expect(hit).to.not.equal(null);
    expect(hit.frames).to.equal(10);
    expect(hit.mel).to.equal(mel);
  });

  it('未设置的键返回 null', () => {
    expect(pipeline._melCacheGet('nope')).to.equal(null);
  });

  it('同键重复 put 覆盖且不重复计入字节数', () => {
    pipeline._melCachePut('k1', { mel: makeMel(10), frames: 10 });
    const bytesAfterFirst = pipeline._melCacheBytes;
    pipeline._melCachePut('k1', { mel: makeMel(10), frames: 10 });
    expect(pipeline._melCacheBytes).to.equal(bytesAfterFirst);
    expect(pipeline._melCacheMap.size).to.equal(1);
  });

  it('超过 maxEntries 淘汰最旧条目', () => {
    for (let i = 0; i < pipeline._melCacheMaxEntries + 2; i++) {
      pipeline._melCachePut(`k${i}`, { mel: makeMel(1), frames: 1 });
    }
    expect(pipeline._melCacheMap.size).to.equal(pipeline._melCacheMaxEntries);
    expect(pipeline._melCacheGet('k0')).to.equal(null); // 最先写入的被淘汰
    expect(pipeline._melCacheGet(`k${pipeline._melCacheMaxEntries + 1}`)).to.not.equal(null);
  });

  it('get 提升 LRU 位次：频繁访问的条目不被淘汰', () => {
    const n = pipeline._melCacheMaxEntries;
    pipeline._melCachePut('hot', { mel: makeMel(1), frames: 1 });
    for (let i = 0; i < n; i++) {
      pipeline._melCachePut(`k${i}`, { mel: makeMel(1), frames: 1 });
      pipeline._melCacheGet('hot'); // 保持 hot 为最新
    }
    expect(pipeline._melCacheGet('hot')).to.not.equal(null);
  });

  it('拒绝含 NaN/Inf 的 mel 与非法条目', () => {
    const bad = makeMel(4);
    bad[7] = NaN;
    pipeline._melCachePut('bad', { mel: bad, frames: 4 });
    expect(pipeline._melCacheGet('bad')).to.equal(null);
    pipeline._melCachePut('empty', null);
    pipeline._melCachePut('zeroframes', { mel: makeMel(4), frames: 0 });
    expect(pipeline._melCacheMap === null || pipeline._melCacheMap.size === 0).to.equal(true);
  });

  it('clearSynthCache 同步清空 mel 缓存', () => {
    pipeline._melCachePut('k1', { mel: makeMel(4), frames: 4 });
    pipeline.clearSynthCache();
    expect(pipeline._melCacheMap).to.equal(null);
    expect(pipeline._melCacheBytes).to.equal(0);
    expect(pipeline._melCacheGet('k1')).to.equal(null);
  });
});
