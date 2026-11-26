'use strict';
/**
 * INT8：GPU 独占给 DiT(diffStep) / Vocos(vocoder)，小模型走 CPU EP。
 *
 * 背景（实测）：NvTensorRTRTX 与 DmlExecutionProvider 同进程共存时，TRT 的
 * execution context 会稳定报 `enqueue failed`（diff_step / cond_emb 的 warmup
 * 必失败，node hash 恒为 ..._7780293478357352456_0_0）；完全不建 DML 会话时，
 * 同模型同形状（512/548/2048/2100/2300）全部通过且 nan=0。
 *
 * INT8 的价值在 TRT 的 INT8 kernel，所以小模型让出 GPU；它们的 CPU 开销实测为
 * encoder 1-6ms / cond_emb 78ms / mel_transform 110ms / preflow 788ms@2048帧
 * （真实歌词 token 远小于 2048），每次合成只跑一次，代价远小于 DiT 落回 DML。
 */
const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');
const sinon = require('sinon');

const ROOT = path.resolve(__dirname, '..');
const ort = require('onnxruntime-node');
const provider = require('../src/inference/winml/winmlProvider');
const ortBridge = require('../src/inference/winml/ortBridge');
const modelLoader = require('../src/inference/pipeline/modelLoader');

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TRT_DEVICES = [{ index: 5, epName: 'NvTensorRTRTXExecutionProvider', deviceType: 'gpu' }];
const modelPath = (name) => path.join(ROOT, 'onnx_models', 'int8', name);

describe('INT8 GPU 独占 — 小模型走 CPU EP', function () {
  let createStub;
  beforeEach(function () {
    sinon.stub(ortBridge, 'listDevices').returns(TRT_DEVICES);
    sinon.stub(ortBridge, 'ensureBridgeInit').resolves(true);
    // _trtGpuAvailable 复用 getWinmlCandidates 的完整候选链
    sinon.stub(provider, 'getWinmlCandidates').resolves([
      { epName: 'NvTensorRTRTXExecutionProvider', indices: [5] },
    ]);
    createStub = sinon.stub(ort.InferenceSession, 'create').resolves({
      inputMetadata: [], inputNames: [], outputNames: [], run: async () => ({}), release() {},
    });
  });
  afterEach(function () { sinon.restore(); });

  it('condEmb 在 INT8 下用 CPU EP（不建 DML 会话）', async function () {
    sinon.stub(provider, 'isWinmlEnabled').returns(true);
    const res = await modelLoader.createSessionWithValidation(
      modelPath('cond_emb.onnx'), 'condEmb', 'fake-gpu', 0, false, true);
    expect(res.ep).to.equal('cpu');
    expect(createStub.called).to.equal(true);
    expect(createStub.firstCall.args[1].executionProviders).to.deep.equal(['cpu']);
  });

  it('preflow / melTransform 同样走 CPU', async function () {
    sinon.stub(provider, 'isWinmlEnabled').returns(true);
    for (const [file, key] of [['preflow.onnx', 'preflow'], ['mel_transform.onnx', 'melTransform']]) {
      createStub.resetHistory();
      const res = await modelLoader.createSessionWithValidation(
        modelPath(file), key, 'fake-gpu', 0, false, true);
      expect(res.ep, key).to.equal('cpu');
      expect(createStub.firstCall.args[1].executionProviders, key).to.deep.equal(['cpu']);
    }
  });

  it('diffStep 不落 CPU（仍走 TRT/DML 链）', async function () {
    sinon.stub(provider, 'isWinmlEnabled').returns(true);
    sinon.stub(provider, 'tryCreateWinMLSession').resolves(null);
    const res = await modelLoader.createSessionWithValidation(
      modelPath('diff_step_dml.onnx'), 'diffStep', 'fake-gpu', 0, false, true);
    expect(res.ep).to.equal('dml');
  });

  it('TRT 不可用时保持原行为（小模型仍走 DML）', async function () {
    sinon.stub(provider, 'isWinmlEnabled').returns(false);
    const res = await modelLoader.createSessionWithValidation(
      modelPath('cond_emb.onnx'), 'condEmb', 'fake-gpu', 0, false, true);
    expect(res.ep).to.equal('dml');
  });

  it('WinML 开了但候选链里没有 NV 时不抢占（小模型仍 DML）', async function () {
    sinon.stub(provider, 'isWinmlEnabled').returns(true);
    provider.getWinmlCandidates.restore();
    sinon.stub(provider, 'getWinmlCandidates').resolves([
      { epName: 'OpenVINOExecutionProvider', indices: [6] },
    ]);
    const res = await modelLoader.createSessionWithValidation(
      modelPath('cond_emb.onnx'), 'condEmb', 'fake-gpu', 0, false, true);
    expect(res.ep).to.equal('dml');
  });
});

describe('源码守卫 — INT8 GPU 独占分支', function () {
  const src = readSrc('src/inference/pipeline/modelLoader.js');

  it('分支条件是 useStaticShapes + 非 diffStep/vocoder + TRT 可用', function () {
    expect(src).to.match(/if \(useStaticShapes && !isDiffStepOrVocoder && await _trtGpuAvailable\(\)\)/);
  });

  it('分支内部使用 CPU EP', function () {
    const m = /if \(useStaticShapes && !isDiffStepOrVocoder && await _trtGpuAvailable\(\)\) \{([\s\S]{0,320})/.exec(src);
    expect(m, '未找到 INT8 GPU 独占分支').to.be.ok;
    expect(m[1]).to.match(/executionProviders: \['cpu'\]/);
    expect(m[1]).to.match(/return \{ session, ep: 'cpu'/);
  });

  it('isDiffStepOrVocoder 在函数开头定义，早于该分支（否则变量未定义）', function () {
    const defIdx = src.indexOf('const isDiffStepOrVocoder = sessionKey');
    const branchIdx = src.indexOf('if (useStaticShapes && !isDiffStepOrVocoder && await _trtGpuAvailable()');
    expect(defIdx).to.be.greaterThan(0);
    expect(branchIdx).to.be.greaterThan(0);
    expect(defIdx).to.be.lessThan(branchIdx);
  });

  it('_trtGpuAvailable 复用 getWinmlCandidates 的完整候选链', function () {
    const m = /async function _trtGpuAvailable\(\) \{([\s\S]*?)\n\}/.exec(src);
    expect(m, '未找到 _trtGpuAvailable').to.be.ok;
    expect(m[1]).to.match(/isWinmlEnabled\(\)/);
    // 不能自己只 registerEp：单 EP 注册会导致 TRT 输出回传 D2H 失败
    expect(m[1]).to.match(/getWinmlCandidates\(true, false\)/);
    expect(m[1]).to.match(/NvTensorRTRTX/);
  });
});
