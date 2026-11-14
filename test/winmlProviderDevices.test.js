'use strict';
/**
 * 设置页的 WinML 设备列表：EP 去重 + 同一 EP 的多硬件拆分（GPU / CPU / NPU）。
 *
 * 两个需求来源：
 *   1. 某些机器上 ExecutionProviderCatalog 起不来，但 EP 包已经装好 —— 名单
 *      必须并上文件系统扫描，且同一个 EP 只能出现一次（catalog 一条 +
 *      每个 MSIX 版本一条会让用户以为装了两个 EP）。
 *   2. OpenVINO 一个 EP 同时暴露 GPU/CPU/NPU，必须能分开选；选择要落到
 *      winmlPreferredDevice 并真正钉住对应的 device 索引。
 */

const { expect } = require('chai');
const sinon = require('sinon');

const winmlProvider = require('../src/inference/winml/winmlProvider');
const winmlCatalog = require('../src/inference/winml/winmlCatalog');
const ortBridge = require('../src/inference/winml/ortBridge');
const detectionCache = require('../src/inference/winml/winmlDetectionCache');

const TRT_DLL = 'C:\\Program Files\\WindowsApps\\MicrosoftCorporationII.WinML.NVIDIA.TRT-RTX.EP.2_2.50.53.0_x64__8wekyb3d8bbwe\\ExecutionProvider\\onnxruntime_providers_nv_tensorrt_rtx.dll';
const OV_DLL = 'C:\\Program Files\\WindowsApps\\MicrosoftCorporationII.WinML.Intel.OpenVINO.EP.1.8_2.1080.97.0_x64__8wekyb3d8bbwe\\ExecutionProvider\\onnxruntime_providers_openvino_plugin.dll';

const DEVICES = [
  { index: 0, epName: 'NvTensorRTRTXExecutionProvider', deviceType: 'gpu', vendor: 'NVIDIA' },
  { index: 1, epName: 'OpenVINOExecutionProvider', deviceType: 'gpu', vendor: 'Intel' },
  { index: 2, epName: 'OpenVINOExecutionProvider', deviceType: 'cpu', vendor: 'Intel' },
  { index: 3, epName: 'OpenVINOExecutionProvider', deviceType: 'npu', vendor: 'Intel' },
];

describe('WinML 设置页设备列表', function () {
  describe('winmlCatalog 名单合并', function () {
    const { _mergeProviderEntries, _isProviderDll } = winmlCatalog.__test;

    it('同一 EP 的多条来源（catalog + 多个 MSIX 版本）合并成一条', function () {
      const merged = _mergeProviderEntries([
        { name: 'NvTensorRTRTXExecutionProvider', readyState: 0, inst: { libraryPath: TRT_DLL } },
        { name: 'NvTensorRTRTXExecutionProvider', readyState: 0, inst: null, libraryPathHint: 'C:\\old\\onnxruntime_providers_nv_tensorrt_rtx.dll' },
        { name: 'OpenVINOExecutionProvider', readyState: 0, inst: null, libraryPathHint: OV_DLL },
      ]);
      expect(merged.map((m) => m.name)).to.deep.equal([
        'NvTensorRTRTXExecutionProvider',
        'OpenVINOExecutionProvider',
      ]);
      expect(merged[0].libraryPath).to.equal(TRT_DLL);
      expect(merged[0].source).to.equal('catalog');
      expect(merged[1].source).to.equal('filesystem');
    });

    it('readyState 取最"就绪"的那个（有已安装包就算就绪）', function () {
      const merged = _mergeProviderEntries([
        { name: 'OpenVINOExecutionProvider', readyState: 1, inst: {} },
        { name: 'OpenVINOExecutionProvider', readyState: 0, inst: null, libraryPathHint: OV_DLL },
      ]);
      expect(merged).to.have.lengthOf(1);
      expect(merged[0].readyState).to.equal(0);
    });

    it('provider 辅助 DLL 不会被当成 EP 本体', function () {
      expect(_isProviderDll('onnxruntime_providers_openvino_plugin.dll')).to.equal(true);
      expect(_isProviderDll('onnxruntime_providers_nv_tensorrt_rtx.dll')).to.equal(true);
      expect(_isProviderDll('onnxruntime_providers_shared.dll')).to.equal(false);
      expect(_isProviderDll('onnxruntime_providers_common.dll')).to.equal(false);
      expect(_isProviderDll('openvino_intel_npu_compiler.dll')).to.equal(false);
    });
  });

  describe('listProviderDevices / getWinmlCandidates', function () {
    let devicesStub;
    let registerStub;
    let cacheReadyStub;
    let savedNpuAvailable;
    let savedNpuSafe;

    beforeEach(function () {
      sinon.stub(winmlCatalog, 'isPlatformSupported').returns(true);
      sinon.stub(winmlCatalog, 'listCompatibleProviders').resolves([
        { name: 'NvTensorRTRTXExecutionProvider', readyState: 0, libraryPath: TRT_DLL },
        { name: 'OpenVINOExecutionProvider', readyState: 0, libraryPath: OV_DLL },
      ]);
      sinon.stub(ortBridge, 'ensureBridgeInit').resolves(true);
      devicesStub = sinon.stub(ortBridge, 'listDevices').returns(DEVICES);
      registerStub = sinon.stub(ortBridge, 'registerEp').returns(true);
      sinon.stub(ortBridge, 'canLoadLibrary').returns(true);
      cacheReadyStub = sinon.stub(detectionCache, 'getCachedReadyEps').returns([
        { name: 'NvTensorRTRTXExecutionProvider', libraryPath: TRT_DLL },
        { name: 'OpenVINOExecutionProvider', libraryPath: OV_DLL },
      ]);
      savedNpuAvailable = globalThis.__SXS_NPU_AVAILABLE__;
      savedNpuSafe = globalThis.__SXS_OPENVINO_NPU_SAFE__;
      globalThis.__SXS_SETTINGS_SNAPSHOT__ = {
        winmlEnabled: true,
        nativeInferenceBackend: 'auto',
        inferenceProvider: 'ortnode',
      };
      winmlProvider.resetEpState();
    });

    afterEach(function () {
      sinon.restore();
      delete globalThis.__SXS_SETTINGS_SNAPSHOT__;
      if (savedNpuAvailable === undefined) delete globalThis.__SXS_NPU_AVAILABLE__;
      else globalThis.__SXS_NPU_AVAILABLE__ = savedNpuAvailable;
      if (savedNpuSafe === undefined) delete globalThis.__SXS_OPENVINO_NPU_SAFE__;
      else globalThis.__SXS_OPENVINO_NPU_SAFE__ = savedNpuSafe;
      winmlProvider.resetEpState();
    });

    it('每个 EP 只出现一次，OpenVINO 拆出 gpu/cpu/npu 三个设备', async function () {
      const list = await winmlProvider.listProviderDevices();

      expect(list.map((p) => p.name)).to.deep.equal([
        'NvTensorRTRTXExecutionProvider',
        'OpenVINOExecutionProvider',
      ]);
      expect(list[0].devices).to.deep.equal([
        { deviceType: 'gpu', indices: [0], selectable: true },
      ]);
      expect(list[1].devices).to.deep.equal([
        { deviceType: 'gpu', indices: [1], selectable: true },
        { deviceType: 'npu', indices: [3], selectable: false },
        { deviceType: 'cpu', indices: [2], selectable: true },
      ]);
      // 两个 EP 各注册一次，没有重复注册
      expect(registerStub.callCount).to.equal(2);
    });

    it('NPU 安全门打开后 NPU 变为可选', async function () {
      globalThis.__SXS_NPU_AVAILABLE__ = true;
      globalThis.__SXS_OPENVINO_NPU_SAFE__ = true;

      const list = await winmlProvider.listProviderDevices();
      const ov = list.find((p) => p.name === 'OpenVINOExecutionProvider');
      expect(ov.devices.find((d) => d.deviceType === 'npu').selectable).to.equal(true);
    });

    it('门控关闭时不注册 EP、不枚举设备（只给名单）', async function () {
      globalThis.__SXS_SETTINGS_SNAPSHOT__.winmlEnabled = false;

      const list = await winmlProvider.listProviderDevices();
      expect(list).to.have.lengthOf(2);
      expect(list.every((p) => p.devices.length === 0)).to.equal(true);
      expect(registerStub.called).to.equal(false);
      expect(cacheReadyStub.called).to.equal(false);
    });

    it('选中 OpenVINO|CPU 时候选链只带 CPU 的设备索引', async function () {
      globalThis.__SXS_SETTINGS_SNAPSHOT__.winmlPreferredEp = 'OpenVINOExecutionProvider';
      globalThis.__SXS_SETTINGS_SNAPSHOT__.winmlPreferredDevice = 'cpu';

      const chain = await winmlProvider.getWinmlCandidates(false, true);
      expect(chain[0]).to.deep.equal({ epName: 'OpenVINOExecutionProvider', indices: [2] });
    });

    it('NPU 被安全门挡住时，选了 NPU 也不会把 NPU 索引交给会话', async function () {
      globalThis.__SXS_SETTINGS_SNAPSHOT__.winmlPreferredEp = 'OpenVINOExecutionProvider';
      globalThis.__SXS_SETTINGS_SNAPSHOT__.winmlPreferredDevice = 'npu';

      const chain = await winmlProvider.getWinmlCandidates(false, true);
      const npuUsed = chain.some((c) => c.indices.includes(3));
      expect(npuUsed, 'NPU 设备索引不得进入候选链').to.equal(false);
    });

    it('选中的硬件不存在时回退到该 EP 的全部设备，不直接掉到 DML', async function () {
      globalThis.__SXS_SETTINGS_SNAPSHOT__.winmlPreferredEp = 'OpenVINOExecutionProvider';
      globalThis.__SXS_SETTINGS_SNAPSHOT__.winmlPreferredDevice = 'gpu';
      devicesStub.returns(DEVICES.filter((d) => d.deviceType !== 'gpu'));

      const chain = await winmlProvider.getWinmlCandidates(false, true);
      expect(chain[0].epName).to.equal('OpenVINOExecutionProvider');
      expect(chain[0].indices).to.deep.equal([2]); // 只剩 cpu
    });

    it('winmlPreferredDevice 只影响被选中的 EP，其它 EP 保持自动顺序', async function () {
      globalThis.__SXS_SETTINGS_SNAPSHOT__.winmlPreferredEp = 'OpenVINOExecutionProvider';
      globalThis.__SXS_SETTINGS_SNAPSHOT__.winmlPreferredDevice = 'cpu';

      const chain = await winmlProvider.getWinmlCandidates(false, true);
      const trt = chain.find((c) => c.epName === 'NvTensorRTRTXExecutionProvider');
      expect(trt).to.deep.equal({ epName: 'NvTensorRTRTXExecutionProvider', indices: [0] });
    });
  });

  describe('IPC / 设置存储接线（源码守卫）', () => {
    const readSrc = (rel) => require('node:fs').readFileSync(require('node:path').resolve(__dirname, '..', rel), 'utf8');

    it('设置页的 EP 列表走 listProviderDevices（而非只读 catalog）', () => {
      const src = readSrc('src/main/settingsIpc.js');
      expect(src).to.match(/SETTINGS_GET_WINML_PROVIDERS[\s\S]{0,600}listProviderDevices/);
    });

    it('winmlPreferredDevice 在白名单、校验与 reset 触发项里都有', () => {
      const settingsSrc = readSrc('src/main/settings.js');
      expect(settingsSrc).to.match(/ALLOWED_SETTINGS_KEYS[\s\S]{0,2000}'winmlPreferredDevice'/);
      const ipcSrc = readSrc('src/main/settingsIpc.js');
      expect(ipcSrc).to.match(/const RESET_TRIGGER_KEYS = \[[\s\S]{0,900}'winmlPreferredDevice'/);
      expect(ipcSrc).to.match(/case 'winmlPreferredDevice':/);
    });
  });
});
