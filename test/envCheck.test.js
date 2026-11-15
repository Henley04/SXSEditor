/**
 * 帮助 → 环境检测：菜单接线、i18n、WinML 门控、平台降级、格式化与弹层复制。
 *
 * 重点守住三条容易回归的行为：
 *   1. 非 Windows 不得触发 PowerShell / 原生桥 / GPU 扫描（CI 跑在 Linux）；
 *   2. readyState === 0 才是 Ready（反直觉，WinRT 的语义）；
 *   3. 复制文本不得包含任何绝对路径（会被直接贴进 issue）。
 */
const { expect } = require('chai');
const sinon = require('sinon');

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const resolveKey = (obj, key) => key.split('.').reduce(
  (o, part) => (o && o[part] !== undefined ? o[part] : undefined),
  obj,
);

/** 用给定字典构造 t()，避免测试依赖 i18n 单例的当前语言。 */
function makeT(dict, fallbackDict) {
  return (key, params) => {
    let value = resolveKey(dict, key);
    if (value === undefined && fallbackDict) value = resolveKey(fallbackDict, key);
    if (value === undefined) return key;
    if (params) {
      value = value.replace(/\{(\w+)\}/g, (_, name) => (
        params[name] !== undefined ? params[name] : `{${name}}`
      ));
    }
    return value;
  };
}

const WIN_SETTINGS = { winmlEnabled: true, inferenceProvider: 'ortnode', nativeInferenceBackend: 'auto' };
const NPU_SNAPSHOT_EMPTY = { value: { npuAvailable: false, webnnNpuAvailable: false, details: '' }, pending: false };

let envCheckInfo;
let envCheckFormat;
let zh;
let en;

before(async () => {
  envCheckInfo = require('../src/main/envCheckInfo.js');
  envCheckFormat = await import('../src/renderer/envCheckFormat.js');
  zh = (await import('../src/i18n/zh-CN.js')).default;
  en = (await import('../src/i18n/en.js')).default;
});

describe('帮助 → 环境检测', () => {
  describe('菜单与接线', () => {
    it('帮助子菜单里有环境检测项，位置在 MCP 与打开日志之间', () => {
      const menu = read('src/main/windowManager.js');
      const helpStart = menu.indexOf("t('menu.help')");
      expect(helpStart, '找不到帮助菜单').to.be.greaterThan(0);
      const help = menu.slice(helpStart);
      expect(help).to.match(/t\('menu\.envCheck'\)/);
      expect(help).to.match(/MAIN_MENU_ENV_CHECK_REQUEST/);
      // id 供自动化验证用 Menu.getMenuItemById('env-check') 直接定位
      expect(help).to.match(/id: 'env-check'/);

      const mcpAt = help.indexOf("t('menu.mcpSetup')");
      const envAt = help.indexOf("t('menu.envCheck')");
      const logAt = help.indexOf("t('menu.openLogDir')");
      expect(mcpAt).to.be.greaterThan(-1);
      expect(envAt).to.be.greaterThan(mcpAt);
      expect(logAt).to.be.greaterThan(envAt);
    });

    it('通道常量、preload、渲染层订阅、main.js 注册四处成对', () => {
      const channels = read('src/shared/ipcChannels.js');
      expect(channels).to.match(/MAIN_MENU_ENV_CHECK_REQUEST: 'main-menu:env-check-request'/);
      expect(channels).to.match(/ENV_CHECK_GET_REPORT: 'env-check:get-report'/);
      expect(channels).to.match(/ENV_CHECK_GET_PROBES: 'env-check:get-probes'/);

      const preload = read('src/preload.js');
      expect(preload).to.match(/onMainMenuEnvCheckRequest/);
      expect(preload).to.match(/envCheckGetReport: \(\) => ipcRenderer\.invoke\(IPC_CHANNELS\.ENV_CHECK_GET_REPORT\)/);
      expect(preload).to.match(/envCheckGetProbes: \(\) => ipcRenderer\.invoke\(IPC_CHANNELS\.ENV_CHECK_GET_PROBES\)/);

      const handlers = read('src/renderer/eventHandlers.js');
      expect(handlers).to.match(/onMainMenuEnvCheckRequest\(\(\) => \{ void showEnvCheckDialog\(\)/);
      expect(handlers).to.match(/_ipcCleanups\.push\(offEnvCheck\)/);

      expect(read('src/main.js')).to.match(/registerEnvCheckIpc\(\)/);
      expect(read('src/main/envCheckIpc.js')).to.match(
        /safeHandle\(IPC_CHANNELS\.ENV_CHECK_GET_REPORT/,
      );
    });
  });

  describe('i18n', () => {
    it('主进程 menu.envCheck 中英都有，且与渲染层逐字一致', () => {
      const mainLocales = require('../src/main/locale.js').getMainLocales();
      for (const locale of ['zh-CN', 'en']) {
        const mainValue = mainLocales[locale].menu.envCheck;
        expect(mainValue, `${locale}.menu.envCheck`).to.be.a('string').and.not.empty;
        expect(mainValue).to.not.equal('menu.envCheck');
        const rendererDict = locale === 'zh-CN' ? zh : en;
        expect(mainValue, `${locale} 主进程与渲染层译文不一致`).to.equal(rendererDict.menu.envCheck);
      }
    });

    it('弹层关键文案中英都非空', () => {
      const keys = [
        'title', 'description', 'kv', 'copy', 'copied', 'copiedHint', 'copyFailed', 'close',
        'loading', 'loadFailed', 'preview', 'generatedAt',
        'sectionSystem', 'sectionGpu', 'sectionAi', 'sectionRuntime',
        'osVersion', 'osVersionGeneric', 'cpu', 'threads', 'ram', 'ramValue',
        'gpu', 'gpuModel', 'gpuIndexed', 'gpuStatus', 'vram', 'vramUsage', 'vramUsageValue', 'driverVersion',
        'winml', 'winmlReasonLabel', 'winmlProviders', 'npu', 'backend',
        'appVersion', 'electronVersion', 'nodeVersion', 'platform',
        'notSupported', 'detecting', 'timeout', 'unknown', 'none',
        'deviceDiscrete', 'deviceIntegrated', 'deviceNpu', 'deviceCpu', 'deviceUnknown',
        'providerReady', 'providerOnDemand', 'providerDevices',
      ];
      for (const dict of [zh, en]) {
        for (const key of keys) {
          expect(dict.envCheck[key], key).to.be.a('string').and.not.empty;
        }
      }
    });

    it('四组状态枚举的每个 code 都有中英译文（新增状态不会漏译）', () => {
      const groups = [
        ['winmlGate', envCheckInfo.WINML_GATE],
        ['winmlRuntime', envCheckInfo.WINML_RUNTIME],
        ['npuState', envCheckInfo.NPU_STATE],
        ['backendValue', envCheckInfo.BACKEND],
      ];
      for (const dict of [zh, en]) {
        for (const [group, codes] of groups) {
          for (const code of Object.values(codes)) {
            const value = dict.envCheck[group][code];
            expect(value, `${group}.${code}`).to.be.a('string').and.not.empty;
            expect(value).to.not.equal(`${group}.${code}`);
            // winmlGate 的值直接接在「WinML 状态：」后面，自带「不可用：」这类
            // 前缀会拼出双冒号（曾出现过「WinML 状态：不可用：当前系统不是 Windows」）。
            if (group === 'winmlGate') {
              expect(value, `${group}.${code} 不应自带冒号前缀`).to.not.match(/[：:]/);
            }
          }
        }
      }
    });
  });

  describe('WinML 门控（单一真源）', () => {
    const { getWinmlGate, isWinmlEnabled } = require('../src/inference/winml/winmlProvider.js');
    const settings = (over = {}) => ({ ...WIN_SETTINGS, ...over });
    const gate = (over = {}, settingsOver = {}) => getWinmlGate({
      platform: 'win32',
      arch: 'x64',
      build: 26100,
      settings: settings(settingsOver),
      ...over,
    });

    it('非 Windows → platform', () => {
      expect(gate({ platform: 'linux' })).to.include({ enabled: false, reason: 'platform' });
    });

    it('架构不支持 → arch', () => {
      expect(gate({ arch: 'ia32' })).to.include({ enabled: false, reason: 'arch' });
    });

    it('Build 不足 → build（Win11 24H2 才支持 WinML EP）', () => {
      expect(gate({ build: 22631 })).to.include({ enabled: false, reason: 'build' });
    });

    it('后端为 dml / cpu → backendDml / backendCpu', () => {
      expect(gate({}, { nativeInferenceBackend: 'dml' }).reason).to.equal('backendDml');
      expect(gate({}, { nativeInferenceBackend: 'cpu' }).reason).to.equal('backendCpu');
    });

    it('推理提供方不是本机 ORT → provider', () => {
      expect(gate({}, { inferenceProvider: 'ortweb' }).reason).to.equal('provider');
    });

    it('winmlEnabled 未开 → settingOff', () => {
      expect(gate({}, { winmlEnabled: false }).reason).to.equal('settingOff');
    });

    it('全部满足 → ok / enabled', () => {
      expect(gate()).to.include({ enabled: true, reason: 'ok' });
    });

    it('isWinmlEnabled 与 gate.enabled 等价（行为未因重构漂移）', () => {
      expect(isWinmlEnabled()).to.equal(getWinmlGate().enabled);
    });
  });

  describe('非 Windows 降级', () => {
    it('不触发 PowerShell / GPU 扫描 / NPU 探测，仍返回 CPU 与内存', async () => {
      const cp = require('node:child_process');
      const gpuInfo = require('../src/main/gpuInfo.js');
      const execSpy = global.__sinonSandbox.spy(cp, 'execFile');
      const gpuSpy = global.__sinonSandbox.spy(gpuInfo, 'getGPUInfoSnapshot');
      const npuSpy = global.__sinonSandbox.spy(gpuInfo, 'getNPUInfoSnapshot');

      const report = envCheckInfo.getEnvReport({ platform: 'linux', release: '6.8.0-45-generic' });
      const probes = await envCheckInfo.getEnvCheckProbes({ platform: 'linux', release: '6.8.0-45-generic' });

      expect(report.isWindows).to.equal(false);
      expect(report.os.display).to.match(/^Linux 6\.8\.0/);
      expect(report.cpu.threads).to.be.a('number').above(0);
      expect(report.memory.totalBytes).to.be.a('number').above(0);
      expect(report.gpu).to.include({ supported: false, phase: 'skipped' });
      expect(report.gpu.items).to.deep.equal([]);
      expect(report.winml).to.include({ supported: false, gate: 'platform' });
      expect(report.npu.state).to.equal('unsupported');
      expect(probes.supported).to.equal(false);
      expect(probes.npu.state).to.equal('unsupported');

      expect(execSpy.called, '不应 spawn 任何外部进程').to.equal(false);
      expect(gpuSpy.called, '不应读 GPU 缓存/触发扫描').to.equal(false);
      expect(npuSpy.called, '不应读 NPU 缓存').to.equal(false);
    });
  });

  describe('Windows 聚合', () => {
    const report = () => envCheckInfo.getEnvReport({
      platform: 'win32',
      arch: 'x64',
      release: '10.0.26100',
      appVersion: '2.0.3',
      now: 1731670000000,
      settings: WIN_SETTINGS,
      gpuSnapshot: {
        phase: 'full',
        controllers: [{
          adapterIndex: 0,
          model: 'NVIDIA GeForce RTX 4060 Laptop GPU',
          vendor: 'NVIDIA',
          deviceType: 'discrete-gpu',
          isDiscrete: true,
          memoryTotal: 8192,
          memoryUsed: 1229,
          driverVersion: '31.0.15.5176',
          _source: 'si',
        }],
      },
      npuSnapshot: { value: { npuAvailable: true, webnnNpuAvailable: true, details: '' }, pending: false },
    });

    it('OS 名称按 build 判定为 Windows 11', () => {
      expect(report().os.display).to.equal('Windows 11 (10.0.26100)');
      expect(envCheckInfo.describeOs({ platform: 'win32', release: '10.0.19045' }).family).to.equal('windows10');
      expect(envCheckInfo.parseWindowsBuild('10.0.26100')).to.equal(26100);
      expect(envCheckInfo.parseWindowsBuild('6.8.0-45-generic')).to.equal(0);
    });

    it('显存换算为字节，驱动版本透传', () => {
      const item = report().gpu.items[0];
      expect(item.vramBytes).to.equal(8192 * 1024 * 1024);
      expect(item.usedBytes).to.equal(1229 * 1024 * 1024);
      expect(item.budgetBytes).to.equal(item.vramBytes);
      expect(item.driverVersion).to.equal('31.0.15.5176');
      expect(item.isDiscrete).to.equal(true);
    });

    it('fast 阶段不暴露显存（WMI AdapterRAM 是 uint32，>4GB 会截断）', () => {
      const fast = envCheckInfo.getEnvReport({
        platform: 'win32',
        arch: 'x64',
        release: '10.0.26100',
        settings: WIN_SETTINGS,
        gpuSnapshot: {
          phase: 'fast',
          controllers: [{ adapterIndex: 0, model: 'X', memoryTotal: 4095, memoryUsed: 0, _source: 'wmi' }],
        },
        npuSnapshot: NPU_SNAPSHOT_EMPTY,
      });
      expect(fast.gpu.phase).to.equal('fast');
      expect(fast.gpu.items[0].vramBytes).to.equal(null);
      expect(fast.gpu.items[0].usedBytes).to.equal(null);
    });

    it('WinML 已启用且 NPU 可用', () => {
      const r = report();
      expect(r.winml.enabled).to.equal(true);
      expect(r.winml.gate).to.equal('ok');
      expect(r.npu.state).to.equal('available');
    });
  });

  describe('运行期探测状态', () => {
    const base = {
      platform: 'win32',
      settings: WIN_SETTINGS,
      npuSnapshot: NPU_SNAPSHOT_EMPTY,
      gate: { enabled: true, reason: 'ok', detail: {} },
    };

    it('readyState 0 才算 Ready；provider 库路径只留文件名', async () => {
      const probes = await envCheckInfo.getEnvCheckProbes({
        ...base,
        bridge: { initialized: true, failureReason: null },
        providers: [
          { name: 'NvTensorRtRtx', readyState: 0, libraryPath: 'C:\\Windows\\SystemApps\\x\\NvTensorRtRtxEP.dll', devices: [] },
          { name: 'OpenVINO', readyState: 2, libraryPath: '', devices: [{ deviceType: 'npu', indices: [0], selectable: false }] },
        ],
      });
      expect(probes.winml.status).to.equal('ok');
      expect(probes.winml.providers[0].ready).to.equal(true);
      expect(probes.winml.providers[0].library).to.equal('NvTensorRtRtxEP.dll');
      expect(probes.winml.providers[1].ready).to.equal(false);
      expect(probes.winml.providers[1].devices[0]).to.include({ type: 'npu', count: 1, selectable: false });
    });

    it('全部 EP 未就绪 → unready；无 EP → noProviders', async () => {
      const unready = await envCheckInfo.getEnvCheckProbes({
        ...base,
        bridge: { initialized: true, failureReason: null },
        providers: [{ name: 'OpenVINO', readyState: 2, libraryPath: '', devices: [] }],
      });
      expect(unready.winml.status).to.equal('unready');

      const none = await envCheckInfo.getEnvCheckProbes({
        ...base,
        bridge: { initialized: true, failureReason: null },
        providers: [],
      });
      expect(none.winml.status).to.equal('noProviders');
    });

    it('桥初始化失败优先于 noProviders，且原因已脱敏', async () => {
      const probes = await envCheckInfo.getEnvCheckProbes({
        ...base,
        bridge: { initialized: false, failureReason: 'cannot load C:\\app\\resources\\x.dll' },
        providers: [],
      });
      expect(probes.winml.status).to.equal('bridgeFailed');
      expect(probes.winml.bridge.failureReason).to.be.a('string');
      expect(probes.winml.bridge.failureReason).to.not.match(/C:\\/);
    });

    it('门控未启用时不枚举 EP，状态为 null', async () => {
      const probes = await envCheckInfo.getEnvCheckProbes({
        ...base,
        gate: { enabled: false, reason: 'backendCpu', detail: {} },
        bridge: { initialized: false, failureReason: null },
        providers: [{ name: 'X', readyState: 0, libraryPath: '', devices: [] }],
      });
      expect(probes.winml.status).to.equal(null);
      expect(probes.winml.gate).to.equal('backendCpu');
      expect(probes.winml.providers).to.deep.equal([]);
    });
  });

  describe('格式化与复制文本', () => {
    // 必须惰性构造：describe 回调在「收集用例」阶段就同步执行，那时顶层的
    // before 还没跑、zh / en 仍是 undefined，直接 makeT(zh, en) 会让 t() 全程返回 key。
    let t;
    before(() => { t = makeT(zh, en); });

    const winReport = () => envCheckInfo.getEnvReport({
      platform: 'win32',
      arch: 'x64',
      release: '10.0.26100',
      appVersion: '2.0.3',
      now: 1731670000000,
      settings: WIN_SETTINGS,
      gpuSnapshot: {
        phase: 'full',
        controllers: [{
          adapterIndex: 0,
          model: 'NVIDIA GeForce RTX 4060 Laptop GPU',
          vendor: 'NVIDIA',
          deviceType: 'discrete-gpu',
          isDiscrete: true,
          memoryTotal: 8192,
          memoryUsed: 1229,
          driverVersion: '31.0.15.5176',
          _source: 'si',
        }],
      },
      npuSnapshot: { value: { npuAvailable: true, webnnNpuAvailable: true, details: '' }, pending: false },
    });

    it('字节格式化按 GB / MB / KB 切换，0 与 null 视为未知', () => {
      expect(envCheckFormat.formatBytesHuman(8 * 1024 ** 3)).to.equal('8.0 GB');
      expect(envCheckFormat.formatBytesHuman(512 * 1024 ** 2)).to.equal('512 MB');
      expect(envCheckFormat.formatBytesHuman(1536 * 1024)).to.equal('2 MB');
      expect(envCheckFormat.formatBytesHuman(0)).to.equal(null);
      expect(envCheckFormat.formatBytesHuman(null)).to.equal(null);
    });

    it('四个分区齐全，关键行有值', () => {
      const view = envCheckFormat.buildEnvCheckView(winReport(), null, t);
      expect(view.sections.map((s) => s.key)).to.deep.equal(['system', 'gpu', 'ai', 'runtime']);

      const gpuRows = view.sections.find((s) => s.key === 'gpu').rows;
      const values = gpuRows.map((r) => r.value).join(' | ');
      expect(values).to.include('8.0 GB');
      expect(values).to.include('31.0.15.5176');
      expect(values).to.include('独显');

      expect(view.plainText).to.include('[系统]');
      expect(view.plainText).to.include('[显卡]');
      expect(view.plainText).to.include('[AI 加速]');
      expect(view.plainText).to.include('显存占用');
      expect(view.plainText).to.include('Windows 11 (10.0.26100)');
    });

    it('单卡用「型号」避免与分区标题重复，多卡才带序号', () => {
      const single = envCheckFormat.buildEnvCheckView(winReport(), null, t);
      expect(single.sections.find((s) => s.key === 'gpu').rows[0].label)
        .to.equal(t('envCheck.gpuModel'));

      const two = envCheckInfo.getEnvReport({
        platform: 'win32',
        arch: 'x64',
        release: '10.0.26100',
        appVersion: '2.0.3',
        settings: WIN_SETTINGS,
        gpuSnapshot: {
          phase: 'full',
          controllers: [
            { adapterIndex: 0, model: 'NVIDIA GeForce RTX 4060', isDiscrete: true, memoryTotal: 8192, memoryUsed: 1024, driverVersion: '1.0' },
            { adapterIndex: 1, model: 'Intel UHD Graphics', deviceType: 'integrated-gpu', memoryTotal: 2048, memoryUsed: 256, driverVersion: '2.0' },
          ],
        },
        npuSnapshot: NPU_SNAPSHOT_EMPTY,
      });
      const multiLabels = envCheckFormat.buildEnvCheckView(two, null, t)
        .sections.find((s) => s.key === 'gpu').rows.map((r) => r.label);
      expect(multiLabels).to.include(t('envCheck.gpuIndexed', { index: 1 }));
      expect(multiLabels).to.include(t('envCheck.gpuIndexed', { index: 2 }));
    });

    it('复制文本不含任何绝对路径', () => {
      const probes = {
        supported: true,
        winml: {
          gate: 'ok',
          status: 'bridgeFailed',
          bridge: { initialized: false, failureReason: 'cannot load <path>' },
          providers: [{
            name: 'NvTensorRtRtx',
            readyState: 0,
            ready: true,
            library: 'NvTensorRtRtxEP.dll',
            devices: [{ type: 'gpu', count: 1, selectable: true }],
          }],
          providersTimedOut: false,
        },
        npu: { state: 'available', webnnAvailable: true, webnnNpuAvailable: true, details: '' },
      };
      const view = envCheckFormat.buildEnvCheckView(winReport(), probes, t);
      expect(view.plainText).to.not.match(/[A-Za-z]:\\/);
      expect(view.plainText).to.not.match(/\/home\//);
      expect(view.plainText).to.not.include('resourcesPath');
      expect(view.plainText).to.include('NvTensorRtRtxEP.dll');
    });

    it('GPU 未就绪时显示检测中，超时后显示检测超时', () => {
      const pending = envCheckInfo.getEnvReport({
        platform: 'win32',
        arch: 'x64',
        release: '10.0.26100',
        settings: WIN_SETTINGS,
        gpuSnapshot: { phase: 'none', controllers: [] },
        npuSnapshot: NPU_SNAPSHOT_EMPTY,
      });
      const detecting = envCheckFormat.buildEnvCheckView(pending, null, t);
      expect(detecting.plainText).to.include(t('envCheck.detecting'));

      const timedOut = envCheckFormat.buildEnvCheckView(pending, null, t, { gpuTimedOut: true });
      expect(timedOut.plainText).to.include(t('envCheck.timeout'));
    });

    it('英文视角同样分成四区且不含中文标签', () => {
      const tEn = makeT(en, zh);
      const view = envCheckFormat.buildEnvCheckView(winReport(), null, tEn);
      expect(view.sections.map((s) => s.title)).to.deep.equal(['System', 'Graphics', 'AI acceleration', 'Runtime']);
      expect(view.plainText).to.include('Windows version');
      expect(view.plainText).to.not.include('[系统]');
    });
  });

  describe('弹层与复制', () => {
    // 弹层内部用的是渲染层 i18n 单例，断言又拿 makeT(zh) 算期望值，两边必须是
    // 同一语言。这里把语言钉成 zh-CN 并在本文件结束时还原——上一轮 CI 的教训：
    // 改了全局 locale 不还原，会让后续文件的英文断言莫名拿到中文。
    let t;
    let localeBefore;
    before(async () => {
      const i18n = await import('../src/i18n/index.js');
      localeBefore = i18n.getLocale();
      i18n.setLocale('zh-CN');
      t = makeT(zh, en);
    });
    after(async () => {
      const i18n = await import('../src/i18n/index.js');
      i18n.setLocale(localeBefore);
    });

    const report = () => envCheckInfo.getEnvReport({
      platform: 'win32',
      arch: 'x64',
      release: '10.0.26100',
      appVersion: '2.0.3',
      settings: WIN_SETTINGS,
      gpuSnapshot: { phase: 'full', controllers: [] },
      npuSnapshot: NPU_SNAPSHOT_EMPTY,
    });

    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    let close = null;
    afterEach(() => {
      if (close) {
        close();
        close = null;
      }
      delete window.electronAPI;
    });

    it('打开后渲染四个分区，复制成功给出反馈且预览与剪贴板一致', async () => {
      window.electronAPI = {
        envCheckGetReport: async () => report(),
        envCheckGetProbes: async () => ({
          supported: true,
          winml: { gate: 'ok', status: 'ok', bridge: { initialized: true, failureReason: null }, providers: [], providersTimedOut: false },
          npu: { state: 'available', webnnAvailable: true, webnnNpuAvailable: true, details: '' },
        }),
      };
      const mod = await import('../src/renderer/envCheckDialog.js');
      close = await mod.showEnvCheckDialog();

      const dialog = document.querySelector('[data-testid="env-check-dialog"]');
      expect(dialog, '弹层未渲染').to.be.ok;
      const sections = Array.from(dialog.querySelectorAll('[data-section]')).map((el) => el.dataset.section);
      expect(sections).to.deep.equal(['system', 'gpu', 'ai', 'runtime']);

      const writeText = sinon.stub().resolves();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      const copyBtn = dialog.querySelector('[data-testid="env-check-copy"]');
      expect(copyBtn.disabled).to.equal(false);
      copyBtn.click();
      await tick();

      expect(writeText.calledOnce).to.equal(true);
      expect(writeText.firstCall.args[0]).to.include('SXSEditor');
      expect(copyBtn.textContent).to.equal(t('envCheck.copied'));
      expect(dialog.querySelector('[data-testid="env-check-preview"]').value)
        .to.equal(writeText.firstCall.args[0]);
    });

    it('复制失败时展开预览，弹层不关闭', async () => {
      window.electronAPI = {
        envCheckGetReport: async () => report(),
        envCheckGetProbes: async () => null,
      };
      const mod = await import('../src/renderer/envCheckDialog.js');
      close = await mod.showEnvCheckDialog();

      const dialog = document.querySelector('[data-testid="env-check-dialog"]');
      const writeText = sinon.stub().rejects(new Error('denied'));
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const originalExec = document.execCommand;
      document.execCommand = () => false;

      try {
        dialog.querySelector('[data-testid="env-check-copy"]').click();
        await tick();
      } finally {
        document.execCommand = originalExec;
      }

      expect(dialog.querySelector('[data-testid="env-check-feedback"]').textContent)
        .to.equal(t('envCheck.copyFailed'));
      expect(dialog.querySelector('details').open).to.equal(true);
      expect(document.querySelector('[data-testid="env-check-dialog"]')).to.be.ok;
    });

    it('关闭后 DOM 不残留，重复点击菜单不会叠加', async () => {
      window.electronAPI = {
        envCheckGetReport: async () => report(),
        envCheckGetProbes: async () => null,
      };
      const mod = await import('../src/renderer/envCheckDialog.js');
      const first = await mod.showEnvCheckDialog();
      const second = await mod.showEnvCheckDialog();
      expect(document.querySelectorAll('[data-testid="env-check-dialog"]')).to.have.length(1);

      first();
      second();
      expect(document.querySelector('[data-testid="env-check-dialog"]')).to.equal(null);
      close = null;
    });

    it('读取快照失败时给出错误提示而不是空弹层', async () => {
      window.electronAPI = {
        envCheckGetReport: async () => { throw new Error('boom'); },
        envCheckGetProbes: async () => null,
      };
      const mod = await import('../src/renderer/envCheckDialog.js');
      close = await mod.showEnvCheckDialog();

      const body = document.querySelector('[data-testid="env-check-body"]');
      expect(body.textContent).to.equal(t('envCheck.loadFailed'));
    });
  });
});
