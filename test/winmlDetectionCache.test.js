'use strict';
/**
 * WinML EP 探测结果持久化缓存：bootstrap DLL 路径、provider 列表、已就绪 EP 库。
 * 目标是把"Edge/WindowsApps 深度遍历 + WinRT catalog 初始化 + DLL 可加载性探测"
 * 的重复成本降到一次文件读取。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expect } = require('chai');

const cache = require('../src/inference/winml/winmlDetectionCache');

const CACHE_FILE = 'winml-detection-cache.json';

describe('winmlDetectionCache — EP 探测结果跨重启缓存', function () {
  let dir;
  let savedTrustDirs;
  let savedLocalAppData;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-winml-cache-'));
    // 生产环境的 libraryPath 白名单只认系统/应用/用户目录；测试把临时目录
    // 显式加进可信根，避免为了测试而放宽生产策略。
    savedTrustDirs = process.env.SXS_EP_TRUST_DIRS;
    savedLocalAppData = process.env.LOCALAPPDATA;
    process.env.SXS_EP_TRUST_DIRS = dir;
    delete process.env.LOCALAPPDATA;
    cache._resetForTest(dir);
  });

  afterEach(function () {
    if (savedTrustDirs === undefined) delete process.env.SXS_EP_TRUST_DIRS;
    else process.env.SXS_EP_TRUST_DIRS = savedTrustDirs;
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocalAppData;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function readRaw() {
    return JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), 'utf8'));
  }

  it('bootstrap DLL 路径：文件存在才复用', async function () {
    const dll = path.join(dir, 'Microsoft.WindowsAppRuntime.Bootstrap.dll');
    fs.writeFileSync(dll, 'x');
    cache.setCachedBootstrapPath(dll);
    await cache.flush();

    cache._resetForTest(dir);
    expect(cache.getCachedBootstrapPath()).to.equal(dll);

    fs.unlinkSync(dll);
    expect(cache.getCachedBootstrapPath()).to.equal(null);
  });

  it('provider 列表：TTL 内直接命中，过期标记为 fresh=false', async function () {
    cache.setCachedProviders([
      { name: 'OpenVINOExecutionProvider', readyState: 0 },
      { name: 'NvTensorRTRTXExecutionProvider', readyState: 1 },
    ]);
    await cache.flush();

    cache._resetForTest(dir);
    const hit = cache.getCachedProviders();
    expect(hit).to.be.an('object');
    expect(hit.fresh).to.equal(true);
    expect(hit.list.map((p) => p.name)).to.deep.equal([
      'OpenVINOExecutionProvider',
      'NvTensorRTRTXExecutionProvider',
    ]);

    // 把 savedAt 改到 TTL 之外，模拟半天/一天前缓存的结果
    const raw = readRaw();
    raw.data.providers.savedAt = Date.now() - 13 * 60 * 60 * 1000;
    fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify(raw), 'utf8');

    cache._resetForTest(dir);
    expect(cache.getCachedProviders().fresh).to.equal(false);
  });

  it('provider 列表：运行环境指纹变化后失效（Electron 升级 / OS build 变化）', async function () {
    cache.setCachedProviders([{ name: 'QNNExecutionProvider', readyState: 0 }]);
    await cache.flush();

    const raw = readRaw();
    raw.data.providers.fingerprint = 'other-arch|1.0.0|0';
    fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify(raw), 'utf8');

    cache._resetForTest(dir);
    expect(cache.getCachedProviders()).to.equal(null);
  });

  it('已就绪 EP 库：libraryPath 仍存在且门控键一致时命中', async function () {
    const dll = path.join(dir, 'onnxruntime_providers_trt.dll');
    fs.writeFileSync(dll, 'x');
    const gateKey = 'on|auto|ortnode';
    cache.setCachedReadyEps(gateKey, [
      { name: 'NvTensorRTRTXExecutionProvider', libraryPath: dll },
    ]);
    await cache.flush();

    cache._resetForTest(dir);
    expect(cache.getCachedReadyEps(gateKey)).to.deep.equal([
      { name: 'NvTensorRTRTXExecutionProvider', libraryPath: dll },
    ]);

    // 门控键变化（切到 DML 再切回会得到不同的 key，不应误用）
    expect(cache.getCachedReadyEps('off|dml|ortnode')).to.equal(null);

    // EP 包被卸载/升级：旧路径消失后必须重新探测
    fs.unlinkSync(dll);
    expect(cache.getCachedReadyEps(gateKey)).to.equal(null);
  });

  it('缓存损坏时返回 null，不抛异常', async function () {
    fs.writeFileSync(path.join(dir, CACHE_FILE), '{ not json', 'utf8');
    cache._resetForTest(dir);
    expect(cache.getCachedProviders()).to.equal(null);
    expect(cache.getCachedBootstrapPath()).to.equal(null);
    expect(cache.getCachedReadyEps('on|auto|ortnode')).to.equal(null);
  });

  it('libraryPath 只接受可信根内的 .dll 绝对路径', function () {
    const trusted = path.join(dir, 'ExecutionProvider', 'onnxruntime_providers_nv.dll');
    fs.mkdirSync(path.dirname(trusted), { recursive: true });
    fs.writeFileSync(trusted, 'x');
    expect(cache._isTrustedEpLibraryPath(trusted)).to.equal(true);

    // 相对路径、非 DLL、以及可信根之外的绝对路径都不接受 ——
    // 命中失败只会让调用方重新探测，不会报错。
    expect(cache._isTrustedEpLibraryPath('onnxruntime_providers_nv.dll')).to.equal(false);
    expect(cache._isTrustedEpLibraryPath(path.join(dir, 'notes.txt'))).to.equal(false);
    // 注意：不能用 os.tmpdir() 造"根外"路径 —— Windows 上 %TEMP% 位于
    // C:\Users\<user>\AppData\Local\Temp，正好在可信根 os.homedir() 之下，
    // 断言会恒为 true（与实现无关的环境耦合）。这里取当前临时目录所在卷的
    // 根目录，确保它不在任何可信根里。
    const volumeRoot = path.parse(dir).root;
    const outside = path.join(volumeRoot, 'sxs-outside', 'evil.dll');
    expect(cache._isTrustedEpLibraryPath(outside)).to.equal(false);
    expect(cache._isTrustedEpLibraryPath('\\\\server\\share\\evil.dll')).to.equal(false);
  });
});
