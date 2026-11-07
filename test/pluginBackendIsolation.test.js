/**
 * 推理后端隔离的回归矩阵。
 *
 * 用户要求：纯插件工程在播放 / 导出 / 打开分片编辑器 / 编辑器内播放 / MCP
 * exportTo 五条路径都不自动加载内置模型；内置与混合工程行为完全不变。
 *
 * 三层验证：
 *   1. 真函数判定矩阵：3 类工程 × 整批路径与单分片路径的期望值；
 *   2. 源码接线：五条路径的调用点确实接入了判定，防止守卫被删掉；
 *   3. 真跑分片编辑器 initPipeline()：插件轨道连采样率查询都不发。
 *
 * 第 2 层是静态断言，作用是"接线防丢"，不是行为验证；行为由 1、3 层与
 * test/svsInitGuard.test.js 的真 handler 覆盖。**文字里不含可运行代码**。
 */
const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const {
  needsBuiltinPipeline, needsBuiltinForFragment,
} = require('../src/shared/pipelineDecision.js');

const ROOT = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SXS = { type: 'sxs' };
const PLUGIN = { type: 'plugin', pluginId: 'audio.cpp' };
const frag = (singerId) => ({ id: `f-${singerId}`, singerId, notes: [] });

const MATRIX = [
  {
    scene: '纯内置工程',
    fragments: [frag('s1'), frag('s2')],
    singerMap: new Map([['s1', { backend: SXS }], ['s2', { backend: SXS }]]),
    bulk: true,            // 播放 / 导出整工程：需要内置模型
    perFragment: [true, true],
  },
  {
    scene: '混合工程（插件分片 + 内置分片）',
    fragments: [frag('s1'), frag('s2')],
    singerMap: new Map([['s1', { backend: PLUGIN }], ['s2', { backend: SXS }]]),
    bulk: true,            // 整批里有内置轨道，照旧加载
    perFragment: [false, true], // 单看插件分片不加载，单看内置分片加载
  },
  {
    scene: '纯插件工程',
    fragments: [frag('s1'), frag('s2')],
    singerMap: new Map([['s1', { backend: PLUGIN }], ['s2', { backend: PLUGIN }]]),
    bulk: false,           // 播放 / 导出都不该加载
    perFragment: [false, false],
  },
];

describe('推理后端隔离 — 回归矩阵', () => {
  it('三类工程 × 整批路径（播放 / 导出）的判定符合预期', () => {
    for (const s of MATRIX) {
      expect(needsBuiltinPipeline(s.fragments, s.singerMap), s.scene).to.equal(s.bulk);
    }
  });

  it('三类工程 × 单分片路径（MCP exportTo / 开编辑器 / 编辑器内播放）符合预期', () => {
    for (const s of MATRIX) {
      s.fragments.forEach((fragment, i) => {
        const backend = s.singerMap.get(fragment.singerId).backend;
        expect(needsBuiltinForFragment(fragment, backend), `${s.scene} 第 ${i + 1} 个分片`)
          .to.equal(s.perFragment[i]);
      });
    }
  });

  it('混合工程：整批判定不因存在插件分片而误跳过', () => {
    const mixed = MATRIX[1];
    expect(needsBuiltinPipeline(mixed.fragments, mixed.singerMap)).to.equal(true);
    expect(needsBuiltinForFragment(mixed.fragments[0], PLUGIN)).to.equal(false);
  });

  describe('源码接线（防守卫被删）', () => {
    it('主窗口播放与导出仍各有一次 allFragmentsUsePluginBackend 守卫，且空语义不变', () => {
      const src = read('renderer/audioPlayback.js');
      expect(src).to.match(/if \(!allFragments \|\| allFragments\.length === 0\) return false;/);
      expect((src.match(/!allFragmentsUsePluginBackend\(allFragments, singerMap\)/g) || []))
        .to.have.length(2);
      expect(src).to.include('initSVSPipeline({ needsBuiltin: true })');
    });

    it('MCP exportFragmentTo 用单分片判定包住 ensurePipelineInitialized', () => {
      const src = read('renderer/mcpAutomation.js');
      expect(src).to.include("import { needsBuiltinForFragment } from '../shared/pipelineDecision.js'");
      expect(src).to.include('if (needsBuiltinForFragment(f, singer && singer.backend)) {');
    });

    it('分片编辑器开窗口按 backend 决定，且 initPipeline 自身也短路', () => {
      const index = read('fragmentEditor/index.js');
      expect(index).to.include('waitForTrackBackend()');
      expect(index).to.include('isPluginBackend(backend) ? Promise.resolve() : initPipeline()');
      expect(index).not.to.match(/^initPipeline\(\)\.catch/m);

      const pipe = read('fragmentEditor/pipeline.js');
      expect(pipe).to.include('if (!needsBuiltinForFragment(getCurrentFragment(), getTrackBackend()))');
      // 短路必须写在采样率查询之前，否则仍会连带发 IPC。用真实调用语句做锚点，
      // 不能用函数名 —— 说明性注释里也提到了它，会把顺序比反。
      expect(pipe.indexOf('if (!needsBuiltinForFragment(getCurrentFragment()'))
        .to.be.lessThan(pipe.indexOf('setSampleRate(await window.electronAPI.getFragmentSVSSampleRate())'));
    });

    it('preload 透传 options，主进程两个 init handler 都支持跳过', () => {
      const preload = read('preload.js');
      expect(preload).to.include("initSVSPipeline: (options) => invokeHeavy('svs:init', options)");
      expect(preload).to.include("initFragmentSVSPipeline: (options) => invokeHeavy('fragment-svs:init', options)");

      const svs = read('main/svsIpc.js');
      expect((svs.match(/options\.needsBuiltin === false/g) || [])).to.have.length(2);
      expect((svs.match(/skipped: true/g) || [])).to.have.length(2);
    });
  });

  describe('分片编辑器 initPipeline() 真跑短路', function () {
    let st;
    let pipeline;
    let calls;

    before(function () {
      st = require('../src/fragmentEditor/state.js');
      pipeline = require('../src/fragmentEditor/pipeline.js');
    });

    beforeEach(function () {
      calls = { sampleRate: 0, init: 0 };
      global.window.electronAPI = {
        getFragmentSVSSampleRate: async () => { calls.sampleRate++; return 24000; },
        initFragmentSVSPipeline: async () => { calls.init++; return { success: true, skipped: true }; },
      };
      st.setPipelineInitialized(false);
      st.setPipelineInitPromise(null);
      st.setCurrentFragment(frag('s1'));
    });

    afterEach(function () {
      st.setPipelineInitialized(false);
      st.setPipelineInitPromise(null);
      st.setCurrentFragment(null);
      st.setTrackBackend(null);
      delete global.window.electronAPI;
    });

    it('插件 backend → 不查采样率、不发 init IPC', async function () {
      st.setTrackBackend(PLUGIN);
      await pipeline.initPipeline();
      expect(calls.sampleRate).to.equal(0);
      expect(calls.init).to.equal(0);
      expect(st.getPipelineInitialized()).to.equal(false);
    });

    it('内置 backend → 照常走完整初始化（内置工程不回归）', async function () {
      st.setTrackBackend(SXS);
      await pipeline.initPipeline();
      expect(calls.sampleRate).to.equal(1);
      expect(calls.init).to.equal(1);
      expect(st.getPipelineInitialized()).to.equal(true);
    });

    it('backend 尚未到达 → 保守地按内置处理', async function () {
      st.setTrackBackend(null);
      await pipeline.initPipeline();
      expect(calls.init).to.equal(1);
    });
  });
});
