'use strict';
/**
 * WinML EP 探测的耗时约束。
 *
 * 现场现象：一次冷启动的 EP 探测做了 19.3 s，其中 18.3 s 花在对旧 MSIX
 * 包（NvTensor TRT-RTX EP.1.8 = ORT 1.24 ABI）的 canLoadLibrary 上 ——
 * 它必然失败（宿主是 ORT 1.27），而且排序早已决定不会采用它。
 *
 * 两条不变量必须钉住：
 *   1. 高版本候选可加载时，不再探测更旧的候选（短路）；
 *   2. 探测失败的 DLL（size+mtime 未变）跨重启不再重探。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expect } = require('chai');
const sinon = require('sinon');

const winmlProvider = require('../src/inference/winml/winmlProvider');
const winmlCatalog = require('../src/inference/winml/winmlCatalog');
const ortBridge = require('../src/inference/winml/ortBridge');
const detectionCache = require('../src/inference/winml/winmlDetectionCache');

const TRT_DIR_NEW = 'C:\\Program Files\\WindowsApps\\MicrosoftCorporationII.WinML.NVIDIA.TRT-RTX.EP.2_2.50.53.0_x64__8wekyb3d8bbwe\\ExecutionProvider\\onnxruntime_providers_nv_tensorrt_rtx.dll';
const TRT_DIR_OLD = 'C:\\Program Files\\WindowsApps\\MicrosoftCorporationII.WinML.NVIDIA.TRT-RTX.EP.1.8_1.8.24.0_x64__8wekyb3d8bbwe\\ExecutionProvider\\onnxruntime_providers_nv_tensorrt_rtx.dll';
const OV_DIR = 'C:\\Program Files\\WindowsApps\\MicrosoftCorporationII.WinML.Intel.OpenVINO.EP.1.8_2.1080.97.0_x64__8wekyb3d8bbwe\\ExecutionProvider\\onnxruntime_providers_openvino_plugin.dll';

describe('WinML EP 探测 — 短路与负缓存', function () {
  let dir;
  let savedTrustDirs;
  let platformStub;
  let catalogStub;
  let entriesStub;
  let bridgeInitStub;
  let canLoadStub;

  /** 让 canLoadLibrary 只在给定路径集合上返回 true，并记录被探测的路径。 */
  function stubLoadable(loadablePaths) {
    if (canLoadStub) {
      canLoadStub.callsFake((p) => loadablePaths.includes(p));
      canLoadStub.resetHistory();
      return canLoadStub;
    }
    canLoadStub = sinon.stub(ortBridge, 'canLoadLibrary').callsFake((p) => loadablePaths.includes(p));
    return canLoadStub;
  }

  beforeEach(function () {
    canLoadStub = null;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-winml-probe-'));
    savedTrustDirs = process.env.SXS_EP_TRUST_DIRS;
    process.env.SXS_EP_TRUST_DIRS = dir;
    delete process.env.SXS_WINML_REPROBE;
    detectionCache._resetForTest(dir);

    platformStub = sinon.stub(winmlCatalog, 'isPlatformSupported').returns(true);
    catalogStub = sinon.stub(winmlCatalog, 'ensureCatalog').resolves(null);
    bridgeInitStub = sinon.stub(ortBridge, 'ensureBridgeInit').resolves(true);

    globalThis.__SXS_SETTINGS_SNAPSHOT__ = {
      winmlEnabled: true,
      nativeInferenceBackend: 'auto',
      inferenceProvider: 'ortnode',
    };
    winmlProvider.resetEpState();
  });

  afterEach(function () {
    for (const stub of [platformStub, catalogStub, entriesStub, bridgeInitStub, canLoadStub]) {
      if (stub && typeof stub.restore === 'function') stub.restore();
    }
    delete globalThis.__SXS_SETTINGS_SNAPSHOT__;
    delete process.env.SXS_WINML_REPROBE;
    if (savedTrustDirs === undefined) delete process.env.SXS_EP_TRUST_DIRS;
    else process.env.SXS_EP_TRUST_DIRS = savedTrustDirs;
    winmlProvider.resetEpState();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 目录里每个 EP 各给一个新/旧两个候选（新版本在前，模拟 catalog 顺序）。 */
  function stubEntries(list) {
    entriesStub = sinon.stub(winmlCatalog, 'listAllProviderEntries').resolves(list.map((libraryPath) => ({
      name: libraryPath.includes('OpenVINO') ? 'OpenVINOExecutionProvider' : 'NvTensorRTRTXExecutionProvider',
      readyState: 0,
      inst: null,
      libraryPathHint: libraryPath,
    })));
    return entriesStub;
  }

  it('高版本可加载时不再探测旧的 EP.1.8 包', async function () {
    stubEntries([TRT_DIR_OLD, TRT_DIR_NEW, OV_DIR]);
    const probe = stubLoadable([TRT_DIR_NEW, OV_DIR]);

    const eps = await winmlProvider.getReadyEpLibraries();

    expect(eps.map((e) => e.name)).to.deep.equal([
      'NvTensorRTRTXExecutionProvider',
      'OpenVINOExecutionProvider',
    ]);
    expect(eps[0].libraryPath).to.equal(TRT_DIR_NEW);
    // 关键断言：旧包一次都没被 LoadLibrary
    expect(probe.calledWith(TRT_DIR_OLD), '旧 ABI 包不应被探测').to.equal(false);
    expect(probe.callCount).to.equal(2);
  });

  it('高版本探测失败后才回退到低版本（短路不改变回退语义）', async function () {
    stubEntries([TRT_DIR_OLD, TRT_DIR_NEW]);
    const probe = stubLoadable([TRT_DIR_OLD]);

    const eps = await winmlProvider.getReadyEpLibraries();

    expect(eps).to.have.lengthOf(1);
    expect(eps[0].libraryPath).to.equal(TRT_DIR_OLD);
    expect(probe.calledWith(TRT_DIR_NEW)).to.equal(true);
    expect(probe.calledWith(TRT_DIR_OLD)).to.equal(true);
  });

  it('已知加载不起来的 DLL 在重启后不再重复探测', async function () {
    // 只有旧包：必然失败，这一轮要付出一次探测
    const dllOld = path.join(dir, 'ExecutionProvider', 'onnxruntime_providers_nv_tensorrt_rtx.dll');
    fs.mkdirSync(path.dirname(dllOld), { recursive: true });
    fs.writeFileSync(dllOld, 'old');
    stubEntries([dllOld]);
    const probe = stubLoadable([]);
    expect(await winmlProvider.getReadyEpLibraries()).to.deep.equal([]);
    expect(probe.callCount).to.equal(1);
    await detectionCache.flush();

    // 模拟重启：内存状态全清，磁盘负缓存保留
    winmlProvider.resetEpState();
    detectionCache._resetForTest(dir);
    probe.resetHistory();

    expect(await winmlProvider.getReadyEpLibraries()).to.deep.equal([]);
    expect(probe.callCount, '负缓存命中后不应再调 LoadLibrary').to.equal(0);
  });

  it('DLL 被替换（size/mtime 变化）后负缓存失效，重新探测', async function () {
    const dll = path.join(dir, 'ExecutionProvider', 'onnxruntime_providers_nv_tensorrt_rtx.dll');
    fs.mkdirSync(path.dirname(dll), { recursive: true });
    fs.writeFileSync(dll, 'old');
    stubEntries([dll]);
    const probe = stubLoadable([]);
    await winmlProvider.getReadyEpLibraries();
    expect(probe.callCount).to.equal(1);

    winmlProvider.resetEpState();
    detectionCache._resetForTest(dir);
    probe.resetHistory();
    // 升级包：内容变化会让指纹失配
    fs.writeFileSync(dll, 'a-newer-and-longer-content');
    stubLoadable([dll]);

    const eps = await winmlProvider.getReadyEpLibraries();
    expect(eps).to.have.lengthOf(1);
    expect(probe.callCount).to.equal(1);
  });

  it('SXS_WINML_REPROBE=1 可以强制忽略负缓存（排查新装包不生效）', async function () {
    const dll = path.join(dir, 'ExecutionProvider', 'onnxruntime_providers_nv_tensorrt_rtx.dll');
    fs.mkdirSync(path.dirname(dll), { recursive: true });
    fs.writeFileSync(dll, 'old');
    stubEntries([dll]);
    const probe = stubLoadable([]);
    await winmlProvider.getReadyEpLibraries();
    expect(probe.callCount).to.equal(1);
    await detectionCache.flush();

    winmlProvider.resetEpState();
    detectionCache._resetForTest(dir);
    probe.resetHistory();
    process.env.SXS_WINML_REPROBE = '1';

    await winmlProvider.getReadyEpLibraries();
    expect(probe.callCount).to.equal(1);
  });

  it('worker 侧只在快照路径注册失败时才枚举兜底候选', function () {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'inference', 'winml', 'winmlProvider.js'), 'utf8');
    // 快照路径必须先尝试，兜底枚举放在失败分支之后
    expect(src).to.match(/_registerSnapshotEp\(ep\.name, ep\.libraryPath, false\)/);
    expect(src).to.match(/if \(!registered\) \{[\s\S]{0,120}_getCatalogFallbackPaths/);
  });
});
