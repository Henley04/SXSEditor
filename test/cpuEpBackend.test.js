'use strict';
/**
 * 「CPU（全部模型）」后端：策略判定、持久化、WinML 门控与全链路接线。
 *
 * 行为测试覆盖纯 JS 可验证的三处（epPolicy 判定、loadSettings 白名单、
 * isWinmlEnabled 门控）。主漏斗与旁路 session 创建在 Linux CI 上无法起真实
 * ORT/WinML 会话，且给 lazyOrt 模块级 Proxy 注入假 ORT 会污染后续测试，
 * 因此沿用 test/winmlEpState.test.js 的既有做法：用源码守卫把「CPU 后端必须
 * 在所有 GPU 分支之前短路、且每个旁路都接入策略」这条约束钉死，防止重构时被删。
 */

const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');
const sinon = require('sinon');

const ROOT = path.resolve(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { isCpuOnlyBackend } = require('../src/inference/shared/epPolicy');
const settingsMod = require('../src/main/settings');
const winmlProvider = require('../src/inference/winml/winmlProvider');
const winmlCatalog = require('../src/inference/winml/winmlCatalog');

describe('CPU EP 后端 — 策略判定', () => {
  it("'cpu' 为 true，auto / winml / dml / 缺省均为 false", () => {
    expect(isCpuOnlyBackend({ nativeInferenceBackend: 'cpu' })).to.equal(true);
    for (const backend of ['auto', 'winml', 'dml', undefined]) {
      expect(isCpuOnlyBackend({ nativeInferenceBackend: backend }), String(backend)).to.equal(false);
    }
    expect(isCpuOnlyBackend({})).to.equal(false);
  });

  it('未显式传参时从 worker 设置快照读取', () => {
    const prev = globalThis.__SXS_SETTINGS_SNAPSHOT__;
    try {
      globalThis.__SXS_SETTINGS_SNAPSHOT__ = { nativeInferenceBackend: 'cpu' };
      expect(isCpuOnlyBackend()).to.equal(true);
      globalThis.__SXS_SETTINGS_SNAPSHOT__ = { nativeInferenceBackend: 'dml' };
      expect(isCpuOnlyBackend()).to.equal(false);
    } finally {
      if (prev === undefined) delete globalThis.__SXS_SETTINGS_SNAPSHOT__;
      else globalThis.__SXS_SETTINGS_SNAPSHOT__ = prev;
    }
  });
});

describe('CPU EP 后端 — 持久化白名单', () => {
  let snapshotBackup;

  beforeEach(() => {
    snapshotBackup = globalThis.__SXS_SETTINGS_SNAPSHOT__;
  });

  afterEach(() => {
    if (snapshotBackup === undefined) delete globalThis.__SXS_SETTINGS_SNAPSHOT__;
    else globalThis.__SXS_SETTINGS_SNAPSHOT__ = snapshotBackup;
    settingsMod.invalidateSettingsCache();
  });

  it("保存 'cpu' 后 loadSettings 不把它静默重置成 'auto'", () => {
    globalThis.__SXS_SETTINGS_SNAPSHOT__ = {
      nativeInferenceBackend: 'cpu', inferenceProvider: 'ortnode',
    };
    settingsMod.invalidateSettingsCache();
    expect(settingsMod.loadSettings().nativeInferenceBackend).to.equal('cpu');
  });

  it('未知后端仍然回落到 auto（白名单没有被放开）', () => {
    globalThis.__SXS_SETTINGS_SNAPSHOT__ = { nativeInferenceBackend: 'bogus' };
    settingsMod.invalidateSettingsCache();
    expect(settingsMod.loadSettings().nativeInferenceBackend).to.equal('auto');
  });

  it('ALLOWED_SETTINGS_KEYS 保留 nativeInferenceBackend（无需新增配置键）', () => {
    expect(settingsMod.ALLOWED_SETTINGS_KEYS).to.include('nativeInferenceBackend');
  });
});

describe('CPU EP 后端 — WinML 门控', () => {
  let platformStub;
  let snapshotBackup;

  beforeEach(() => {
    // Linux 上 isPlatformSupported() 恒为 false，会让门控用例短路；只 stub 平台。
    platformStub = sinon.stub(winmlCatalog, 'isPlatformSupported').returns(true);
    snapshotBackup = globalThis.__SXS_SETTINGS_SNAPSHOT__;
  });

  afterEach(() => {
    platformStub.restore();
    if (snapshotBackup === undefined) delete globalThis.__SXS_SETTINGS_SNAPSHOT__;
    else globalThis.__SXS_SETTINGS_SNAPSHOT__ = snapshotBackup;
    winmlProvider.resetEpState();
  });

  it('CPU 后端关闭 WinML gate，即使 winmlEnabled 仍为 true', () => {
    globalThis.__SXS_SETTINGS_SNAPSHOT__ = {
      winmlEnabled: true, nativeInferenceBackend: 'cpu', inferenceProvider: 'ortnode',
    };
    expect(winmlProvider.isWinmlEnabled()).to.equal(false);
  });

  it('auto 后端仍能开启 gate（CPU 分支没有误伤原路径）', () => {
    globalThis.__SXS_SETTINGS_SNAPSHOT__ = {
      winmlEnabled: true, nativeInferenceBackend: 'auto', inferenceProvider: 'ortnode',
    };
    expect(winmlProvider.isWinmlEnabled()).to.equal(true);
  });

  it('EP 缓存键包含后端值，CPU ↔ auto 切换不会命中旧缓存', () => {
    // _epCacheKey 是模块内私有函数，用源码守卫确认它把后端值并入键，
    // 而不是留一个「gate on/off」的粗粒度键让 CPU 与 auto 互相污染缓存。
    const src = readSrc('src/inference/winml/winmlProvider.js');
    const keyFn = /function _epCacheKey\(\) \{([\s\S]*?)\n\}/.exec(src);
    expect(keyFn, '未找到 _epCacheKey').to.be.ok;
    expect(keyFn[1]).to.match(/nativeInferenceBackend/);
    expect(keyFn[1]).to.match(/isWinmlEnabled\(\)/);
  });
});

describe('CPU EP 后端 — 全链路接线（源码守卫）', () => {
  it('主漏斗在 WinML / DML 分支之前短路为 executionProviders: [cpu]', () => {
    const src = readSrc('src/inference/pipeline/modelLoader.js');
    const fn = src.slice(src.indexOf('async function createSessionWithValidation'));
    const guardAt = fn.indexOf('if (isCpuOnlyBackend())');
    expect(guardAt, 'createSessionWithValidation 缺少 CPU 短路').to.be.greaterThan(-1);
    const shortCircuit = /if \(isCpuOnlyBackend\(\)\) \{([\s\S]*?)\n    \}/.exec(fn);
    expect(shortCircuit, '短路必须只带 CPU EP 并返回 ep: cpu').to.be.ok;
    expect(shortCircuit[1]).to.match(/executionProviders: \['cpu'\]/);
    expect(shortCircuit[1]).to.match(/ep: 'cpu'/);
    // 短路必须排在任何 GPU 尝试之前，且自身不含 DML / WinML 痕迹。
    expect(guardAt).to.be.lessThan(fn.indexOf('const winmlEligible'));
    expect(shortCircuit[0]).to.match(/warmedUp: false/);
    expect(shortCircuit[0]).to.not.match(/dml|winml/i);
    expect(src).to.match(/require\('\.\.\/shared\/epPolicy'\)/);
  });

  it('WinML 门控、worker 注入、设置页派生都把 CPU 视为关闭 GPU 路径', () => {
    const provider = readSrc('src/inference/winml/winmlProvider.js');
    const gate = /function getWinmlGate\([\s\S]*?\n\}/.exec(provider);
    expect(gate, '未找到 getWinmlGate').to.be.ok;
    // dml / cpu 拆成两条独立短路，是为了让环境检测能给出不同原因码
    // （backendDml / backendCpu）。但两者都必须排在 provider 与 winmlEnabled
    // 判定之前，否则会出现「设了 CPU 后端却被后面的条件提前放行」。
    const body = gate[0];
    const dmlAt = body.indexOf("nativeInferenceBackend === 'dml'");
    const cpuAt = body.indexOf("nativeInferenceBackend === 'cpu'");
    expect(dmlAt, '缺少 dml 短路').to.be.greaterThan(-1);
    expect(cpuAt, '缺少 cpu 短路').to.be.greaterThan(dmlAt);
    expect(cpuAt).to.be.lessThan(body.indexOf('s.inferenceProvider && s.inferenceProvider'));
    expect(cpuAt).to.be.lessThan(body.indexOf('s.winmlEnabled !== true'));
    expect(readSrc('src/main/svsIpc.js'))
      .to.match(/settings\.nativeInferenceBackend === 'cpu'/);
    expect(readSrc('src/settings.js'))
      .to.match(/!\['dml', 'cpu'\]\.includes\(/);
  });

  it('旁路 session 创建点全部接入 CPU 策略（所有模型，不留漏网）', () => {
    for (const rel of [
      'src/inference/fcpePitchDetector.js',
      'src/inference/rmvpePitchDetector.js',
      'src/main/plugins/runtime/ortRunner.js',
      'src/inference/pipeline/index.js',
    ]) {
      expect(readSrc(rel), `${rel} 未接入 isCpuOnlyBackend`).to.match(/isCpuOnlyBackend\(\)/);
    }
    // WebNN 是 ESM 且跑在渲染层，用设置读取判断是否只保留 WASM (CPU)。
    const webnn = readSrc('src/inference/webnn/sessionManager.js');
    expect(webnn).to.match(/cpuOnlyBackend/);
    expect(webnn).to.match(/epChain\.push\('wasm'\)/);
    // RosVot 本来就只建 CPU session，不尝试 DML。
    expect(readSrc('src/inference/rosvotDetector.js')).to.match(/executionProviders: \['cpu'\]/);
  });

  it('WebNN 路径的 vocoder DML 旁路同样受全局 CPU 策略约束', () => {
    const idx = readSrc('src/inference/pipeline/index.js');
    expect(idx).to.match(/require\('\.\.\/shared\/epPolicy'\)/);
    // 门控：CPU 后端不启用 WebNN 分支，避免主模型之外再走 DML vocoder 旁路。
    expect(idx).to.match(/inferenceProvider === 'ortweb' && !isCpuOnlyBackend\(\)/);
    // 纵深防御：即便将来 WebNN 分支重新可达，vocoder 也只带 CPU EP，
    // 且 CPU 短路必须排在 [dmlOpts, 'cpu'] 尝试之前。
    const guardAt = idx.indexOf('if (isCpuOnlyBackend())');
    const dmlAt = idx.indexOf("executionProviders: [dmlOpts, 'cpu']");
    expect(guardAt, 'loadVocDmlOrCpu 缺少 CPU 短路').to.be.greaterThan(-1);
    expect(dmlAt, '非 CPU 后端仍应保留 DML 优先尝试').to.be.greaterThan(-1);
    expect(guardAt, 'CPU 短路必须排在 DML 尝试之前').to.be.lessThan(dmlAt);
    const cpuGuard = /if \(isCpuOnlyBackend\(\)\) \{([\s\S]*?)\n            \}/.exec(idx);
    expect(cpuGuard, '未找到 CPU 短路块').to.be.ok;
    expect(cpuGuard[1]).to.match(/executionProviders: \['cpu'\]/);
    expect(cpuGuard[1]).to.match(/ep: 'cpu'/);
    expect(cpuGuard[0]).to.not.match(/dml/i);
  });

  it('后端变化触发 pipeline 重建与 EP 状态清理（复用既有 RESET_TRIGGER_KEYS）', () => {
    const src = readSrc('src/main/settingsIpc.js');
    const trigger = /const RESET_TRIGGER_KEYS = \[([\s\S]*?)\];/.exec(src);
    expect(trigger, '未找到 RESET_TRIGGER_KEYS').to.be.ok;
    expect(trigger[1]).to.match(/'nativeInferenceBackend'/);
    expect(src).to.match(/backendChanged[\s\S]{0,500}?resetEpState\(\)/);
  });
});

describe('⋯ 溢出菜单上移到原生「文件」菜单 — 接线与清理', () => {
  it('File 菜单新增两项并发送对应 IPC 通道', () => {
    const menu = readSrc('src/main/windowManager.js');
    expect(menu).to.match(/t\('menu\.importMidi'\)/);
    expect(menu).to.match(/t\('menu\.audioToMidi'\)/);
    expect(menu).to.match(/MAIN_MENU_IMPORT_MIDI_REQUEST/);
    expect(menu).to.match(/MAIN_MENU_AUDIO_TO_MIDI_REQUEST/);
  });

  it('通道常量、preload 订阅、渲染层回调三处成对', () => {
    const channels = readSrc('src/shared/ipcChannels.js');
    expect(channels).to.match(/MAIN_MENU_IMPORT_MIDI_REQUEST: 'main-menu:import-midi-request'/);
    expect(channels).to.match(/MAIN_MENU_AUDIO_TO_MIDI_REQUEST: 'main-menu:audio-to-midi-request'/);
    const preload = readSrc('src/preload.js');
    expect(preload).to.match(/onMainMenuImportMidiRequest/);
    expect(preload).to.match(/onMainMenuAudioToMidiRequest/);
    const handlers = readSrc('src/renderer/eventHandlers.js');
    expect(handlers).to.match(/onMainMenuImportMidiRequest\(\(\) => \{ void handleImportMidi\(\)/);
    expect(handlers).to.match(/onMainMenuAudioToMidiRequest\(\(\) => \{ void handleAudioToMidi\(\)/);
  });

  it('主进程 menu 字典 zh/en 都覆盖新键', () => {
    const locales = require('../src/main/locale.js').getMainLocales();
    for (const locale of ['zh-CN', 'en']) {
      for (const key of ['importMidi', 'audioToMidi']) {
        expect(locales[locale].menu[key], `${locale}.menu.${key}`).to.be.a('string').and.not.empty;
      }
    }
  });

  it('主页面不再有 ⋯ 溢出层、旧按钮与旧绑定（其它窗口同名 id 不受影响）', () => {
    const html = readSrc('src/index.html');
    expect(html).to.not.match(/toolbar-more-panel/);
    expect(html).to.not.match(/btn-toolbar-more/);
    expect(html).to.not.match(/id="btn-audio-to-midi"/);
    expect(html).to.not.match(/id="btn-import-midi"/);
    expect(readSrc('src/renderer/toolbarPopovers.js')).to.not.match(/btn-toolbar-more/);
    expect(readSrc('src/renderer/state.js')).to.not.match(/btnAudioToMidi/);
    expect(readSrc('src/renderer/eventHandlers.js')).to.not.match(/dom\.btnAudioToMidi\.addEventListener/);
    expect(readSrc('src/index.css')).to.not.match(/\.toolbar-more\b/);
  });
});

describe('CPU EP 选项 — 双字典文案同步', () => {
  it('设置页渲染层字典 zh/en 都含 CPU 选项与说明', () => {
    const zh = require('../src/i18n/zh-CN.js').default;
    const en = require('../src/i18n/en.js').default;
    for (const dict of [zh, en]) {
      expect(dict.settings.nativeBackendCpu).to.be.a('string').and.not.empty;
      expect(dict.settings.nativeBackendCpuHint).to.be.a('string').and.not.empty;
    }
  });

  it('设置页下拉框含与 WinML / DirectML 同级的 CPU 选项', () => {
    const html = readSrc('src/settings.html');
    const select = /<select id="nativeInferenceBackend">([\s\S]*?)<\/select>/.exec(html);
    expect(select, '未找到本机执行后端下拉框').to.be.ok;
    for (const value of ['auto', 'winml', 'dml', 'cpu']) {
      expect(select[1], `缺少 ${value} 选项`).to.match(new RegExp(`value="${value}"`));
    }
  });
});
