'use strict';
/**
 * preflow.onnx：留在 WinML 白名单（WINML_ELIGIBLE_KEYS）里，但**不用
 * TensorRT-RTX 加载**，固定回退 DML。
 *
 * 为什么这两件事要分开：白名单决定的不只是"能不能试 WinML"，还决定 TRT 不可用
 * 时的回退目标（白名单内非 diff_step/vocoder 的模型直接掉 CPU）。所以不能简单
 * 把 preflow 从白名单删掉——那样它会被当成普通模型走 DML→CPU 链，EP 上报与
 * 其它按 WinML 主模型处理的逻辑也会跟着变。这里加的是独立的"TRT 例外名单"。
 *
 * 覆盖两层：
 *   1. 行为测试：候选链能按 excludeTrtRtx 只剔除 NV，不封杀其它 WinML EP；
 *   2. 源码守卫：modelLoader 真的把标记传下去、且被排除的模型保留 DML 回退
 *      （否则重构时容易把回退条件改回去，preflow 静默落到 CPU）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');
const sinon = require('sinon');

const ROOT = path.resolve(__dirname, '..');
const provider = require('../src/inference/winml/winmlProvider');
const winmlCatalog = require('../src/inference/winml/winmlCatalog');
const ortBridge = require('../src/inference/winml/ortBridge');

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// NV + OpenVINO 两个 EP 都出现在设备表里：ensureEpsRegistered 的 _syncRegisteredFromDevices
// 会因此把两个名字都记为已注册，missing 为空 → 不触碰 WinRT catalog，测试不依赖真机。
const DEVICES = [
  { index: 5, epName: 'NvTensorRTRTXExecutionProvider', deviceType: 'gpu' },
  { index: 6, epName: 'OpenVINOExecutionProvider', deviceType: 'gpu' },
];

describe('WinML 候选链 — TRT-RTX 按模型排除', function () {
  beforeEach(function () {
    sinon.stub(winmlCatalog, 'isPlatformSupported').returns(true);
    sinon.stub(ortBridge, 'ensureBridgeInit').resolves(true);
    sinon.stub(ortBridge, 'listDevices').returns(DEVICES);
    globalThis.__SXS_SETTINGS_SNAPSHOT__ = {
      winmlEnabled: true,
      nativeInferenceBackend: 'auto',
      inferenceProvider: 'ortnode',
    };
    provider.resetEpState();
  });

  afterEach(function () {
    sinon.restore();
    delete globalThis.__SXS_SETTINGS_SNAPSHOT__;
    provider.resetEpState();
  });

  it('默认（智能模式）NV 仍是第一候选', async function () {
    const chain = await provider.getWinmlCandidates(false, false);
    expect(chain.map((c) => c.epName)).to.deep.equal(['NvTensorRTRTXExecutionProvider']);
  });

  it('excludeTrtRtx 时候选链里不再有 NV', async function () {
    const chain = await provider.getWinmlCandidates(false, false, { excludeTrtRtx: true });
    expect(chain).to.deep.equal([]);
  });

  it('只剔除 TRT，不封杀其它 WinML EP（OpenVINO 仍在）', async function () {
    const chain = await provider.getWinmlCandidates(false, true, { excludeTrtRtx: true });
    expect(chain.map((c) => c.epName)).to.deep.equal(['OpenVINOExecutionProvider']);
  });

  it('用户手动指定 NV 时同样被排除', async function () {
    globalThis.__SXS_SETTINGS_SNAPSHOT__.winmlPreferredEp = 'NvTensorRTRTXExecutionProvider';
    const chain = await provider.getWinmlCandidates(false, false, { excludeTrtRtx: true });
    expect(chain).to.deep.equal([]);
  });

  it('排除后没有候选时 tryCreateWinMLSession 返回 null（交给 DML）', async function () {
    const res = await provider.tryCreateWinMLSession('C:/fake/preflow.onnx', false, false, { excludeTrtRtx: true });
    expect(res).to.equal(null);
  });
});

describe('pipeline 接线 — preflow 白名单内但不走 TRT（源码守卫）', function () {
  const src = readSrc('src/inference/pipeline/modelLoader.js');

  it('preflow 在 WinML 白名单内', function () {
    const m = /const WINML_ELIGIBLE_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
    expect(m, '未找到 WINML_ELIGIBLE_KEYS').to.be.ok;
    expect(m[1]).to.match(/'preflow'/);
  });

  it('preflow 同时被 TRT-RTX 例外名单排除', function () {
    const m = /const TRT_RTX_EXCLUDED_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
    expect(m, '未找到 TRT_RTX_EXCLUDED_KEYS').to.be.ok;
    expect(m[1]).to.match(/'preflow'/);
  });

  it('创建 WinML 会话时把 excludeTrtRtx 传给 provider', function () {
    expect(src).to.match(/const trtRtxExcluded = TRT_RTX_EXCLUDED_KEYS\.has\(sessionKey\)/);
    expect(src).to.match(/tryCreateWinMLSession\([\s\S]{0,220}?excludeTrtRtx:\s*trtRtxExcluded/);
  });

  it('被排除的模型保留 DML 回退，不会直接掉到 CPU', function () {
    // 原条件 !(winmlEligible && !isDiffStepOrVocoder) 会把白名单模型送去 CPU。
    expect(src).not.to.match(/if \(!\(winmlEligible && !isDiffStepOrVocoder\)\)/);
    expect(src).to.match(/if \(!winmlEligible \|\| isDiffStepOrVocoder \|\| trtRtxExcluded\)/);
  });
});
