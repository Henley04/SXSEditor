/**
 * MCP pipeline.* 域：本地 ONNX 管线的加载 / 卸载 / 状态。
 *
 * 三层验证：
 *   1. schema：三条方法存在、target=main、不与 model.* 混淆、version 2.1、文档同步；
 *   2. dispatch：真跑 _internal.dispatch，断言参数校验与分发到资源管理器；
 *   3. 资源管理器：真跑 getPipelineStatus / loadAllPipelineModels /
 *      unloadAllPipelineModels，用 spy 确认确实调用 svsPipelineLazy.get / resetSvsPipeline。
 */
const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const mcpSchema = require('../src/shared/mcpSchema.js');
const { getModelGroups } = require('../src/modelRegistry.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const METHODS = ['pipeline.status', 'pipeline.load', 'pipeline.unload'];

describe('MCP pipeline.* — schema 与文档', () => {
  it('VERSION 升到 2.1，渲染层两处硬编码同步', () => {
    expect(mcpSchema.VERSION).to.equal('2.1');
    expect(mcpSchema.schema().version).to.equal('2.1');
    const src = read('src/renderer/mcpAutomation.js');
    expect(src).to.not.include("schemaVersion: '2.0'");
    expect((src.match(/schemaVersion: '2\.1'/g) || [])).to.have.length(2);
  });

  it('三条方法都在 public schema 里，且 target=main', () => {
    const pub = mcpSchema.schema();
    for (const name of METHODS) {
      const def = mcpSchema.getMethod(name);
      expect(def, name).to.be.an('object');
      expect(def.target).to.equal('main');
      expect(pub.methods[name], name).to.be.an('object');
    }
    expect(mcpSchema.getMethod('pipeline.load').mutates).to.equal(true);
    expect(mcpSchema.getMethod('pipeline.load').long).to.equal(true);
    expect(mcpSchema.getMethod('pipeline.unload').mutates).to.equal(true);
    expect(mcpSchema.getMethod('pipeline.status').mutates).to.not.equal(true);
  });

  it('不给 requires:["models"]，纯插件工程也能查 status', () => {
    for (const name of METHODS) {
      expect(mcpSchema.getMethod(name).requires || []).to.deep.equal([]);
    }
  });

  it('description 明确区分本地 ONNX 管线与 model.* 远程端点', () => {
    for (const name of METHODS) {
      const d = mcpSchema.getMethod(name).description;
      expect(d).to.include('model.*');
      expect(d.toLowerCase()).to.match(/local|on-device/);
    }
  });

  it('model.* 与 pipeline.* 是不同方法，互不覆盖', () => {
    expect(mcpSchema.getMethod('model.list')).to.be.an('object');
    expect(mcpSchema.methodNames()).to.include('model.list');
    for (const name of METHODS) expect(mcpSchema.methodNames()).to.include(name);
  });

  it('生成的文档收录三条新方法', () => {
    for (const rel of ['docs/MCP.md', 'docs/dev/mcp.html']) {
      const doc = read(rel);
      for (const name of METHODS) expect(doc, `${rel} 缺 ${name}`).to.include(name);
    }
  });
});

describe('MCP pipeline.* — dispatch 真跑', function () {
  this.timeout(30000);

  const fakeStatus = {
    initialized: false, pendingReset: false, language: null,
    groups: [{ id: 'svs', models: [{ id: 'diffStep', sessionKey: 'diffStep', loaded: false }] }],
  };
  const calls = {
    status: 0, loadSingle: [], unloadSingle: [], loadAll: 0, unloadAll: 0,
    failNext: false, throwNext: false,
    throwMsg: 'Model file does not exist: note_text_encoder.onnx',
  };
  let bridge;
  let originalLoad;

  before(function () {
    originalLoad = Module._load;
    Module._load = function (request, parent) {
      if (request === './resourceManagerIpc' && parent && parent.filename
        && parent.filename.endsWith(path.join('main', 'mcpBridge.js'))) {
        return {
          getPipelineStatus: () => { calls.status++; return fakeStatus; },
          loadSingleModel: async (g, m) => {
            calls.loadSingle.push([g, m]);
            if (calls.throwNext) throw new Error(calls.throwMsg);
            return calls.failNext ? { success: false, error: '模型文件缺失' } : { success: true };
          },
          unloadSingleModel: async (g, m) => { calls.unloadSingle.push([g, m]); return { success: true }; },
          loadAllPipelineModels: async () => { calls.loadAll++; return { success: true, errors: [] }; },
          unloadAllPipelineModels: async () => { calls.unloadAll++; return { success: true, errors: [] }; },
        };
      }
      return originalLoad.apply(this, arguments);
    };
    bridge = require('../src/main/mcpBridge.js');
  });

  after(function () { Module._load = originalLoad; });

  beforeEach(function () {
    calls.status = 0; calls.loadSingle = []; calls.unloadSingle = [];
    calls.loadAll = 0; calls.unloadAll = 0; calls.failNext = false; calls.throwNext = false;
    calls.throwMsg = 'Model file does not exist: note_text_encoder.onnx';
  });

  const run = (method, params) => bridge._internal.dispatch(method, params, {});

  it('pipeline.status 返回资源管理器状态', async function () {
    const r = await run('pipeline.status', {});
    expect(r.result).to.deep.equal(fakeStatus);
    expect(calls.status).to.equal(1);
  });

  it('pipeline.load 指定模型 → loadSingleModel(group, model)', async function () {
    const r = await run('pipeline.load', { group: 'svs', model: 'diffStep' });
    expect(r.result.ok).to.equal(true);
    expect(calls.loadSingle).to.deep.equal([['svs', 'diffStep']]);
  });

  it('pipeline.unload 指定模型 → unloadSingleModel(group, model)', async function () {
    await run('pipeline.unload', { group: 'svs', model: 'diffStep' });
    expect(calls.unloadSingle).to.deep.equal([['svs', 'diffStep']]);
  });

  it('pipeline.load {all:true} → loadAllPipelineModels', async function () {
    const r = await run('pipeline.load', { all: true });
    expect(r.result.target).to.equal('all');
    expect(calls.loadAll).to.equal(1);
    expect(calls.loadSingle).to.have.length(0);
  });

  it('pipeline.unload {all:true} → unloadAllPipelineModels', async function () {
    await run('pipeline.unload', { all: true });
    expect(calls.unloadAll).to.equal(1);
  });

  it('缺 group/model 且无 all → VALIDATION_ERROR', async function () {
    const err = await run('pipeline.load', {}).catch((e) => e);
    expect(err.code).to.equal('VALIDATION_ERROR');
  });

  it('非法 group → VALIDATION_ERROR，不触碰资源管理器', async function () {
    const err = await run('pipeline.load', { group: 'nope', model: 'x' }).catch((e) => e);
    expect(err.code).to.equal('VALIDATION_ERROR');
    expect(calls.loadSingle).to.have.length(0);
  });

  it('非法 model → VALIDATION_ERROR', async function () {
    const err = await run('pipeline.unload', { group: 'svs', model: 'nope' }).catch((e) => e);
    expect(err.code).to.equal('VALIDATION_ERROR');
  });

  it('资源管理器返回 success:false → PRECONDITION_FAILED', async function () {
    calls.failNext = true;
    const err = await run('pipeline.load', { group: 'svs', model: 'diffStep' }).catch((e) => e);
    expect(err.code).to.equal('PRECONDITION_FAILED');
  });

  it('资源管理器抛"模型文件不存在" → PRECONDITION_FAILED 而非 INTERNAL', async function () {
    calls.throwNext = true;
    const err = await run('pipeline.load', { group: 'svs', model: 'diffStep' }).catch((e) => e);
    expect(err.code).to.equal('PRECONDITION_FAILED');
    expect(err.message).to.include('Model file does not exist');
  });

  it('与缺模型无关的异常仍归 INTERNAL，不被一律降格', async function () {
    calls.throwNext = true;
    calls.throwMsg = 'unexpected runtime failure';
    const err = await run('pipeline.load', { group: 'svs', model: 'diffStep' }).catch((e) => e);
    expect(err.code).to.equal('INTERNAL');
  });
});

describe('MCP pipeline.* — 资源管理器真函数', function () {
  this.timeout(30000);

  let rm;
  let originalLoad;
  const spy = {
    lazyGet: 0, reset: 0,
    runtime: { initialized: true, pendingReset: true, language: 'zh' },
  };

  before(function () {
    const svsStub = {
      getSvsPipeline: () => ({ initialized: true, sessions: { diffStep: {} } }),
      getPipelineRuntimeState: () => spy.runtime,
      svsPipelineLazy: {
        get: async () => { spy.lazyGet++; return {}; },
        getInstance: () => null,
      },
      resetSvsPipeline: () => { spy.reset++; },
    };
    const lazy = () => ({ getInstance: () => ({}), get: async () => ({}), reset() {} });
    originalLoad = Module._load;
    Module._load = function (request, parent) {
      const fromRm = parent && parent.filename
        && parent.filename.endsWith(path.join('main', 'resourceManagerIpc.js'));
      if (fromRm && request === './svsIpc') return svsStub;
      if (fromRm && request === './pitchMidiIpc') {
        return {
          getRmvpeDetector: () => null, getBasicPitchDetector: () => null,
          getRosvotDetector: () => null, getFcpeDetector: () => null,
          rmvpeLazy: lazy(), basicPitchLazy: lazy(), rosvotLazy: lazy(), fcpeLazy: lazy(),
        };
      }
      if (request === 'electron') {
        return {
          app: {
            isPackaged: false, getPath: () => '/tmp', getVersion: () => '0', getLocale: () => 'en',
            on() {}, removeListener() {}, whenReady: () => Promise.resolve(),
          },
          ipcMain: { handle() {}, on() {}, removeHandler() {}, handleOnce() {} },
          BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
          shell: { openPath() {} },
          dialog: { showMessageBox: async () => ({ response: 0 }) },
          protocol: { handle() {}, registerSchemesAsPrivileged() {} },
        };
      }
      return originalLoad.apply(this, arguments);
    };
    try {
      delete require.cache[require.resolve('../src/main/resourceManagerIpc.js')];
      rm = require('../src/main/resourceManagerIpc.js');
    } finally {
      Module._load = originalLoad;
    }
  });

  after(function () {
    delete require.cache[require.resolve('../src/main/resourceManagerIpc.js')];
  });

  it('getPipelineStatus 枚举真实注册表里的全部模型组', function () {
    const s = rm.getPipelineStatus();
    expect(s.groups.map((g) => g.id)).to.deep.equal(getModelGroups().map((g) => g.id));
    expect(s.initialized).to.equal(true);
    expect(s.pendingReset).to.equal(true);
    expect(s.language).to.equal('zh');
    for (const g of s.groups) {
      for (const m of g.models) expect(m).to.have.all.keys('id', 'sessionKey', 'loaded');
    }
  });

  it('svs 组按 sessionKey 判定 loaded，覆盖到未加载的模型', function () {
    const s = rm.getPipelineStatus();
    const svs = s.groups.find((g) => g.id === 'svs');
    expect(svs.models.find((m) => m.id === 'diffStep').loaded).to.equal(true);
    expect(svs.models.find((m) => m.id === 'vocoder').loaded).to.equal(false);
  });

  it('loadAllPipelineModels 初始化 SVS 管线且不影响其它组', async function () {
    spy.lazyGet = 0;
    const r = await rm.loadAllPipelineModels();
    expect(spy.lazyGet).to.equal(1);
    expect(r.success).to.equal(true);
    expect(r.errors).to.deep.equal([]);
  });

  it('unloadAllPipelineModels 调 resetSvsPipeline（合成忙时由它排队）', async function () {
    spy.reset = 0;
    const r = await rm.unloadAllPipelineModels();
    expect(spy.reset).to.equal(1);
    expect(r.success).to.equal(true);
  });
});
