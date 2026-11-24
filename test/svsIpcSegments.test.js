'use strict';
/**
 * 计划 4.4：主进程分轨 segments 汇总。
 *
 *   · _mixTrackAudio 兼容 Float32Array（内置管线 / 旧调用）与 { audio, segments }
 *     （插件 / API 组）两种输入；
 *   · 统一峰值增益必须同时作用于混音与所有 segments，否则实时播放与重新 seek
 *     后音量不一致；
 *   · 插件组 / API 组按 frag.trackId 保留每片音频；内置组由 onChunkAudio 累积
 *     builtinSegments，作为权威分轨数据返回渲染层。
 *
 * 说明：_runPluginGroup / _runApiGroup 的后端依赖在模块顶层以解构方式导入，
 * 无法用 sinon stub 替换；这里用源码契约检查锁定「带 trackId + 返回 segments」
 * 的接线，纯逻辑则由 _mixTrackAudio 的真实执行覆盖。
 */
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { __test } = require('../src/main/svsIpc.js');

const { _mixTrackAudio, _alignBuiltinSegmentsToMix } = __test;

describe('svsIpc 分轨 segments 汇总 (4.4)', () => {
  describe('_mixTrackAudio 纯逻辑', () => {
    it('兼容 Float32Array 与 { audio, segments } 两种输入，按绝对起点叠加', () => {
      const a = new Float32Array([0.1, 0.2]);
      // b 的第 2 个采样起始的分片（startSample=1）。注意 segments 是 audio 的
      // 分轨来源，不参与混音叠加；混音只叠加各轨的 audio。
      const segA = { trackId: 't1', startSample: 1, audio: new Float32Array([0.3]) };
      const b = { audio: new Float32Array([0.0, 0.3]), segments: [segA] };

      const out = _mixTrackAudio([a, b]);

      expect(out.audio).to.be.instanceOf(Float32Array);
      expect(out.audio.length).to.equal(2);
      expect(out.audio[0]).to.be.closeTo(0.1, 1e-6);
      expect(out.audio[1]).to.be.closeTo(0.5, 1e-6);
      expect(out.segments).to.have.lengthOf(1);
      expect(out.segments[0]).to.equal(segA);
      expect(out.segments[0].startSample).to.equal(1);
    });

    it('峰值超限时统一增益同时作用于混音与所有 segments', () => {
      // 两条各 1.0 的轨同位置叠加 → 混音 peak=2.0 → gain=0.95/2。
      // 每个轨各自带一段 segment（和 = 该轨 audio），不是把 segment 再叠加进混音。
      const segA = { trackId: 't1', startSample: 0, audio: new Float32Array([1.0, 0.0]) };
      const segB = { trackId: 't2', startSample: 0, audio: new Float32Array([1.0, 0.0]) };
      const groupA = { audio: new Float32Array([1.0, 0.0]), segments: [segA] };
      const groupB = { audio: new Float32Array([1.0, 0.0]), segments: [segB] };

      const out = _mixTrackAudio([groupA, groupB]);

      const expectedGain = 0.95 / 2;
      expect(out.audio[0]).to.be.closeTo(0.95, 1e-6);
      expect(segA.audio[0], 'segment 必须乘同一个增益').to.be.closeTo(expectedGain, 1e-6);
      expect(segB.audio[0], 'segment 必须乘同一个增益').to.be.closeTo(expectedGain, 1e-6);
      // segments 叠加后与混音逐样本一致：实时播放与重新 seek 后音量一致。
      expect(segA.audio[0] + segB.audio[0]).to.be.closeTo(out.audio[0], 1e-6);
    });

    it('extraSegments（内置组 chunk）进入返回 segments 并被同一个增益缩放', () => {
      const audio = new Float32Array([1.0, 0.0]);
      const extra = { trackId: 'builtin', startSample: 0, audio: new Float32Array([1.0, 0.0]) };

      const out = _mixTrackAudio([audio], [extra]);

      expect(out.segments).to.have.lengthOf(1);
      expect(out.segments[0]).to.equal(extra);
      expect(extra.audio[0]).to.be.closeTo(0.95, 1e-6);
      expect(out.audio[0]).to.be.closeTo(0.95, 1e-6);
    });

    it('峰值不超限时增益为 1，segments 不被改写', () => {
      const seg = { trackId: 't', startSample: 0, audio: new Float32Array([0.2]) };
      const out = _mixTrackAudio([{ audio: new Float32Array([0.2]), segments: [seg] }]);
      expect(seg.audio[0]).to.be.closeTo(0.2, 1e-6);
      expect(out.audio[0]).to.be.closeTo(0.2, 1e-6);
    });

    it('过滤无效 segment（null / 无 audio / 空 audio）', () => {
      const good = { trackId: 't', startSample: 0, audio: new Float32Array([0.2]) };
      const out = _mixTrackAudio(
        [],
        [null, { trackId: 'x', audio: null }, { trackId: 'y', audio: new Float32Array(0) }, good],
      );
      expect(out.segments).to.have.lengthOf(1);
      expect(out.segments[0]).to.equal(good);
    });

    it('未改 M/S 时混音逐样本与旧行为一致（无 segments 输入）', () => {
      const a = new Float32Array([0.1, 0.2, 0.3]);
      const b = new Float32Array([0.4, 0.5]);
      const out = _mixTrackAudio([a, b]);
      expect(out.audio).to.have.lengthOf(3);
      expect([...out.audio][0]).to.be.closeTo(0.5, 1e-6); // 0.1 + 0.4
      expect([...out.audio][1]).to.be.closeTo(0.7, 1e-6); // 0.2 + 0.5
      expect([...out.audio][2]).to.be.closeTo(0.3, 1e-6); // 仅 a 有
      expect(out.segments).to.have.lengthOf(0);
    });
  });

  describe('内置组 segments 与混音峰值对齐 (P2-1)', () => {
    it('segments 归一化前的峰值被对齐到内置混音峰值', () => {
      // 模拟：pipeline 把混音归一化到 0.95，chunk 仍是原始峰值 1.9。
      const segA = { trackId: 't1', startSample: 0, audio: new Float32Array([1.9]) };
      const segB = { trackId: 't2', startSample: 0, audio: new Float32Array([1.9]) };
      const segments = [segA, segB];
      const normalizedMix = new Float32Array([0.95]); // 已归一化的内置混音

      const gain = _alignBuiltinSegmentsToMix(segments, normalizedMix);

      // 重建峰值 = 1.9+1.9 = 3.8；refPeak=0.95 → gain=0.25
      expect(gain).to.be.closeTo(0.25, 1e-6);
    });

    it('对齐后 segments 叠加与归一化混音逐样本一致', () => {
      // 两条轨不相交：各 1.9，重建峰值 1.9，归一化混音峰值 0.95 → gain=0.5
      const segA = { trackId: 't1', startSample: 0, audio: new Float32Array([1.9, 0]) };
      const segB = { trackId: 't2', startSample: 1, audio: new Float32Array([1.9]) };
      const segments = [segA, segB];
      const normalizedMix = new Float32Array([0.95, 0.95]);

      _alignBuiltinSegmentsToMix(segments, normalizedMix);

      expect(segA.audio[0]).to.be.closeTo(0.95, 1e-6);
      expect(segB.audio[0]).to.be.closeTo(0.95, 1e-6);
      const rebuilt = new Float32Array([segA.audio[0], segA.audio[1] + segB.audio[0]]);
      expect([...rebuilt]).to.deep.equal([...normalizedMix]);
    });

    it('进入 _mixTrackAudio 后 segments 与 audio 用同一增益，比例一致', () => {
      // 内置组：归一化 audio 峰值 0.95；segments 原始峰值 1.9（不相交两轨）。
      const segA = { trackId: 't1', startSample: 0, audio: new Float32Array([1.9, 0]) };
      const segB = { trackId: 't2', startSample: 1, audio: new Float32Array([1.9]) };
      const builtinMix = new Float32Array([0.95, 0.95]);
      _alignBuiltinSegmentsToMix([segA, segB], builtinMix);

      // 混入插件组：峰值叠加 1.9 → 统一增益 0.5。
      const pluginSeg = { trackId: 'p', startSample: 0, audio: new Float32Array([1.0, 0]) };
      const out = _mixTrackAudio(
        [builtinMix, { audio: new Float32Array([1.0, 0]), segments: [pluginSeg] }],
        [segA, segB],
      );

      // 对齐后：segA=[0.95,0], segB=[0,0.95], pluginSeg=[1.0,0]
      // 混音：[0.95+1.0, 0.95+0]=[1.95,0.95]，统一增益 g=0.95/1.95 作用二者。
      // segments 叠加 = 混音逐样本一致。
      expect(segA.audio[0] + pluginSeg.audio[0]).to.be.closeTo(out.audio[0], 1e-6);
      expect(segB.audio[0]).to.be.closeTo(out.audio[1], 1e-6);
    });

    it('参考混音为空或 segments 为空时不改动', () => {
      const seg = { trackId: 't', startSample: 0, audio: new Float32Array([0.5]) };
      expect(_alignBuiltinSegmentsToMix([seg], new Float32Array(0))).to.equal(1);
      expect(seg.audio[0]).to.equal(0.5);
      expect(_alignBuiltinSegmentsToMix([], new Float32Array([0.5]))).to.equal(1);
    });
  });

  describe('分组函数与 handler 源码契约', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'svsIpc.js'), 'utf8');

    it('插件组每片保留 trackId，返回 per-track segments', () => {
      expect(src).to.match(/parts\.push\(\{\s*audio: result\.audio,\s*offset,\s*trackId: frag\.trackId \|\| frag\.id \|\| null\s*\}\)/);
      expect(src).to.match(/const segments = parts\.map\(p => \(\{ trackId: p\.trackId, startSample: p\.offset, audio: p\.audio \}\)\)/);
      expect(src).to.include('return { ok: true, audio: mixed, segments };');
    });

    it('API 组每片保留 trackId，返回 per-track segments', () => {
      expect(src).to.match(/parts\.push\(\{\s*audio,\s*offset,\s*trackId: frag\.trackId \|\| frag\.id \|\| null\s*\}\)/);
      expect(src).to.include('return { audio: mixed, segments };');
    });

    it('内置组 onChunkAudio 累积 builtinSegments，handler 以 { audio, segments } 返回', () => {
      expect(src).to.include('const builtinSegments = []');
      expect(src).to.match(/builtinSegments\.push\(\{/);
      expect(src).to.include('return _mixTrackAudio(tracks, builtinSegments);');
    });

    it('内置组 segments 在混合前对齐到归一化混音峰值 (P2-1)', () => {
      expect(src).to.include('_alignBuiltinSegmentsToMix(builtinSegments, builtinMix)');
    });

    it('插件组结果以 { audio, segments } 进入 tracks', () => {
      expect(src).to.match(/tracks\.push\(\{\s*audio: pluginResult\.audio, segments: pluginResult\.segments \|\| \[\]\s*\}\)/);
    });

    it('chunk 累积的是独立副本，避免结构化克隆后丢失权威数据', () => {
      expect(src).to.match(/audio: chunkInfo\.audio\.slice\(\)/);
    });
  });
});
