'use strict';
/**
 * 后端在 DML 与 Windows ML 之间切换后的 EP 状态。
 *
 * 用户报的现象：切到 DML 再切回 Windows ML，界面上的 EP 一直显示 DML。
 * 根因是多层状态没跟着后端一起失效：解析缓存（含 gate 关闭期间产生的空列表）、
 * 运行期被钉到 DML 的模型集合、注册过的 EP、以及下发给 worker 的 EP 快照。
 *
 * 前一层用行为测试覆盖；后两层是主进程 IPC 接线，Linux CI 上无法起真实
 * Windows ML 会话，用源码守卫把「后端变化必须清状态 / DML 不进 WinML 分支」
 * 这两条约束钉死，防止重构时被悄悄删掉。
 */

const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');
const sinon = require('sinon');

const ROOT = path.resolve(__dirname, '..');
const winmlProvider = require('../src/inference/winml/winmlProvider');
const winmlCatalog = require('../src/inference/winml/winmlCatalog');

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('WinML EP 状态 — DML ↔ Windows ML 切换', function () {
  let platformStub;

  beforeEach(function () {
    // Linux 上 isPlatformSupported() 恒为 false，会让所有门控用例短路；
    // 只把平台支持 stub 成 true，测的是后端开关本身。
    platformStub = sinon.stub(winmlCatalog, 'isPlatformSupported').returns(true);
    globalThis.__SXS_SETTINGS_SNAPSHOT__ = {
      winmlEnabled: true,
      nativeInferenceBackend: 'auto',
      inferenceProvider: 'ortnode',
    };
    winmlProvider.resetEpState();
  });

  afterEach(function () {
    platformStub.restore();
    delete globalThis.__SXS_SETTINGS_SNAPSHOT__;
    winmlProvider.resetEpState();
  });

  const settings = (patch) => {
    globalThis.__SXS_SETTINGS_SNAPSHOT__ = {
      ...globalThis.__SXS_SETTINGS_SNAPSHOT__, ...patch,
    };
  };

  it('后端显式为 DML 时关闭 WinML gate，即使 winmlEnabled 仍为 true', function () {
    settings({ nativeInferenceBackend: 'dml' });
    expect(winmlProvider.isWinmlEnabled()).to.equal(false);
  });

  it('推理提供器不是 ortnode 时同样关闭 gate', function () {
    settings({ inferenceProvider: 'webgpu' });
    expect(winmlProvider.isWinmlEnabled()).to.equal(false);
  });

  it('winmlEnabled=false 时关闭 gate', function () {
    settings({ winmlEnabled: false });
    expect(winmlProvider.isWinmlEnabled()).to.equal(false);
  });

  it('切回 Windows ML 后 gate 重新打开（不再被 DML 状态钉住）', function () {
    settings({ nativeInferenceBackend: 'dml' });
    expect(winmlProvider.isWinmlEnabled()).to.equal(false);
    settings({ nativeInferenceBackend: 'auto', inferenceProvider: 'ortnode' });
    expect(winmlProvider.isWinmlEnabled()).to.equal(true);
  });

  it('gate 关闭时 getReadyEpLibraries 返回空且不缓存', async function () {
    settings({ nativeInferenceBackend: 'dml' });
    expect(await winmlProvider.getReadyEpLibraries()).to.deep.equal([]);
    // 切回后门控必须重新打开；若空结果被缓存，这里会连解析机会都没有。
    settings({ nativeInferenceBackend: 'auto' });
    expect(winmlProvider.isWinmlEnabled()).to.equal(true);
  });

  it('resetEpState 清掉运行期被钉到 DML 的模型记录', function () {
    winmlProvider.reportRuntimeFailure('mel_transform.onnx', 'setInputShape failed');
    expect(winmlProvider.isRuntimeBlocked('mel_transform.onnx')).to.equal(true);
    winmlProvider.resetEpState();
    expect(winmlProvider.isRuntimeBlocked('mel_transform.onnx')).to.equal(false);
  });

  it('resetEpState 保留旧测试名 __resetForTest 作为别名', function () {
    expect(winmlProvider.__resetForTest).to.equal(winmlProvider.resetEpState);
  });
});

describe('后端切换的 EP 状态接线（源码守卫）', () => {
  it('settingsIpc 把 nativeInferenceBackend 列为 reset 触发项，后端变化时清 EP 状态', () => {
    const src = readSrc('src/main/settingsIpc.js');
    const trigger = /const RESET_TRIGGER_KEYS = \[([\s\S]*?)\];/.exec(src);
    expect(trigger, '未找到 RESET_TRIGGER_KEYS').to.be.ok;
    expect(trigger[1]).to.match(/'nativeInferenceBackend'/);
    expect(src).to.match(/backendChanged[\s\S]{0,500}?resetEpState\(\)/);
  });

  it('svsIpc 在 DML 后端下不进 WinML 分支，空 EP 快照时重置后再取一次', () => {
    const src = readSrc('src/main/svsIpc.js');
    expect(src).to.match(/backendIsDml/);
    expect(src).to.match(/winmlEnabled === true && !backendIsDml/);
    expect(src).to.match(/winmlProvider\.resetEpState\(\)/);
    const calls = src.match(/getReadyEpLibraries\(\)/g) || [];
    expect(calls.length, '重置后必须重新解析一次 EP').to.be.greaterThan(1);
  });
});
