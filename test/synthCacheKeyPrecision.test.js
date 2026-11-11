'use strict';
/**
 * 合成缓存键必须区分「模型精度」与「推理后端」。
 *
 * 背景：切换 fp32/fp16/int8 后推理用的是另一套权重，同一分片输入完全相同
 * 但输出音频的量化误差不同。键里不含精度时，切完精度按 Play 直接命中上一
 * 精度的 mel —— 用户听不出任何变化，会误判成"新精度没效果"。
 *
 * 同理，内置后端与插件后端算出的音频不同，必须分开；插件的 pluginId /
 * kindId 也要区分，否则换插件音色仍命中旧缓存。
 *
 * 另一半约束同样重要：「重新合成」（AI Retake）靠注入一次性 nonce 让键失配，
 * 不带 nonce 时键必须与未 retake 完全一致，否则每次 Play 都会重推。
 */
const { expect } = require('chai');
const { AudioSegmentation } = require('../src/inference/pipeline/audioSegmentation');

const NOTES = [{ start: 0, duration: 1, lyric: 'a', pitch: 60 }];

describe('computeMelCacheKey — 精度 / 后端 / retake', () => {
  let seg;
  beforeEach(() => { seg = new AudioSegmentation(); });

  const key = (opts) => seg.computeMelCacheKey(NOTES, 120, opts || {});

  it('不同模型精度产生不同缓存键', () => {
    const fp32 = key({ modelPrecision: 'fp32' });
    const fp16 = key({ modelPrecision: 'fp16' });
    const int8 = key({ modelPrecision: 'int8' });
    expect(fp16).to.not.equal(fp32);
    expect(int8).to.not.equal(fp16);
    expect(int8).to.not.equal(fp32);
  });

  it('同一精度重复调用键稳定（不会每次 Play 都重推）', () => {
    expect(key({ modelPrecision: 'int8' })).to.equal(key({ modelPrecision: 'int8' }));
  });

  it('缺省精度与显式 base 等价（老调用方不受影响）', () => {
    expect(key({})).to.equal(key({ modelPrecision: 'base' }));
  });

  it('切换推理后端改变缓存键（内置 ↔ 插件）', () => {
    const builtin = key({ modelPrecision: 'fp16' });
    const plugin = key({
      modelPrecision: 'fp16',
      backend: { type: 'plugin', pluginId: 'my-plugin', kindId: 'voice-1' },
    });
    expect(plugin).to.not.equal(builtin);
  });

  it('插件 id / kind 不同则键不同（换插件音色必须重推）', () => {
    const mk = (pluginId, kindId) => key({
      modelPrecision: 'fp16',
      backend: { type: 'plugin', pluginId, kindId },
    });
    expect(mk('p1', 'k1')).to.not.equal(mk('p2', 'k1'));
    expect(mk('p1', 'k1')).to.not.equal(mk('p1', 'k2'));
  });

  it('retakeNonce 让键失配（强制重新合成）', () => {
    const base = key({ modelPrecision: 'int8' });
    const retaken = key({ modelPrecision: 'int8', retakeNonce: 1700000000000 });
    expect(retaken).to.not.equal(base);
    // 不同 nonce 之间也必须不同，否则连续两次 retake 会命中第一次的结果
    expect(key({ modelPrecision: 'int8', retakeNonce: 1 }))
      .to.not.equal(key({ modelPrecision: 'int8', retakeNonce: 2 }));
  });

  it('未带 nonce 时与 undefined/0 等价（不产生多余后缀）', () => {
    const a = key({ modelPrecision: 'fp16' });
    expect(key({ modelPrecision: 'fp16', retakeNonce: undefined })).to.equal(a);
    expect(key({ modelPrecision: 'fp16', retakeNonce: 0 })).to.equal(a);
  });

  it('computeSynthCacheKey 继承同一组字段（mel 与音频两级缓存一致）', () => {
    const opts = { modelPrecision: 'int8', backend: { type: 'plugin', pluginId: 'p', kindId: 'k' } };
    const synth = seg.computeSynthCacheKey(NOTES, 120, opts);
    expect(synth).to.contain(`${seg.computeMelCacheKey(NOTES, 120, opts)}_mp`);
  });
});
