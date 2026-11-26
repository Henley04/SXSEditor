/**
 * 内置推理管线判定 —— 全局唯一真源的行为契约。
 *
 * 重点是"保守"：任何拿不准的情况都必须返回 true。误判 false 会让正常使用
 * 内置模型的工程不再加载模型，直接合不出声；误判 true 只是多加载一次。
 */
const { expect } = require('chai');
const {
  isPluginBackend, needsBuiltinForFragment, needsBuiltinPipeline,
} = require('../src/shared/pipelineDecision.js');

const SXS = { type: 'sxs' };
const PLUGIN = { type: 'plugin', pluginId: 'audio.cpp', kindId: 'singing' };

const frag = (singerId) => ({ id: `f-${singerId}`, singerId, notes: [] });
const singers = (...entries) => new Map(entries);

describe('pipelineDecision — 内置管线判定', () => {
  describe('isPluginBackend', () => {
    it('只认 type === plugin 的普通对象', () => {
      expect(isPluginBackend(PLUGIN)).to.equal(true);
      expect(isPluginBackend(SXS)).to.equal(false);
      expect(isPluginBackend(null)).to.equal(false);
      expect(isPluginBackend(undefined)).to.equal(false);
      expect(isPluginBackend('plugin')).to.equal(false);
      expect(isPluginBackend([])).to.equal(false);
      expect(isPluginBackend({ type: 'Plugin' })).to.equal(false);
    });
  });

  describe('needsBuiltinForFragment', () => {
    it('插件后端且分片已到达 → false', () => {
      expect(needsBuiltinForFragment(frag('s1'), PLUGIN)).to.equal(false);
    });

    it('内置 / 缺省 / 未知 type → true', () => {
      expect(needsBuiltinForFragment(frag('s1'), SXS)).to.equal(true);
      expect(needsBuiltinForFragment(frag('s1'), undefined)).to.equal(true);
      expect(needsBuiltinForFragment(frag('s1'), { type: 'weird' })).to.equal(true);
    });

    it('分片或 backend 尚未到达 → 保守 true', () => {
      expect(needsBuiltinForFragment(null, PLUGIN)).to.equal(true);
      expect(needsBuiltinForFragment(undefined, PLUGIN)).to.equal(true);
      expect(needsBuiltinForFragment(frag('s1'), null)).to.equal(true);
    });
  });

  describe('needsBuiltinPipeline', () => {
    it('空 / 非数组 → 保守 true', () => {
      expect(needsBuiltinPipeline([], new Map())).to.equal(true);
      expect(needsBuiltinPipeline(null, new Map())).to.equal(true);
      expect(needsBuiltinPipeline(undefined, new Map())).to.equal(true);
    });

    it('纯内置工程 → true', () => {
      const m = singers(['s1', { backend: SXS }], ['s2', { backend: undefined }]);
      expect(needsBuiltinPipeline([frag('s1'), frag('s2')], m)).to.equal(true);
    });

    it('混合工程（只要有任一内置轨道）→ true', () => {
      const m = singers(['s1', { backend: PLUGIN }], ['s2', { backend: SXS }]);
      expect(needsBuiltinPipeline([frag('s1'), frag('s2')], m)).to.equal(true);
    });

    it('纯插件工程 → false', () => {
      const m = singers(['s1', { backend: PLUGIN }], ['s2', { backend: PLUGIN }]);
      expect(needsBuiltinPipeline([frag('s1'), frag('s2')], m)).to.equal(false);
    });

    it('singer 缺失 → 保守 true', () => {
      const m = singers(['s1', { backend: PLUGIN }]);
      expect(needsBuiltinPipeline([frag('s1'), frag('missing')], m)).to.equal(true);
    });

    it('singerMap 为普通对象也能判定', () => {
      expect(needsBuiltinPipeline([frag('s1')], { s1: { backend: PLUGIN } })).to.equal(false);
    });
  });
});
