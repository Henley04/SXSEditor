/**
 * envCheckInfo.js — 「帮助 → 环境检测」的数据聚合（主进程）。
 *
 * 为什么分两级：
 *   getEnvReport()       只读内存快照，毫秒级返回，负责弹层首屏；
 *   getEnvCheckProbes()  才做重探测（原生桥初始化 / EP 枚举 / NPU 复检），
 *                        每项都带硬超时，结果只用来补「AI 加速」区。
 *
 * 为什么不在这里调 ensureGPUInfo() / queryGPUVRAMUsage()：
 *   两者内部都会跑 systeminformation.graphics()，冷路径实测可达 9 秒（另有
 *   15 秒 worker 兜底）。主窗口启动时 startGPUPreload() 通常已经在跑，直接读
 *   它的缓存即可；为了一个「显存占用」再触发第二次 9 秒系统查询不值得。
 *
 * 非 Windows 降级：不 require 原生桥、不 spawn PowerShell、不碰 GPU 扫描，
 * 只保留 CPU / 内存 / 运行时版本，其余标 unsupported。CI 跑在 Linux 上，
 * 这条路径必须安静且快。
 */

'use strict';

const os = require('node:os');
const { probeVcRuntime } = require('../shared/vcRuntime.js');

// ---------------------------------------------------------------------------
// 状态码。渲染层按 `envCheck.<group>.<code>` 取文案，测试遍历这些值断言
// 中英文案都存在——新增状态时必须同时补两套字典，否则测试会红。
// ---------------------------------------------------------------------------

const WINML_GATE = Object.freeze({
    OK: 'ok',
    PLATFORM: 'platform',
    ARCH: 'arch',
    BUILD: 'build',
    BACKEND_DML: 'backendDml',
    BACKEND_CPU: 'backendCpu',
    PROVIDER: 'provider',
    SETTING_OFF: 'settingOff',
});

const WINML_RUNTIME = Object.freeze({
    OK: 'ok',
    NO_PROVIDERS: 'noProviders',
    UNREADY: 'unready',
    BRIDGE_FAILED: 'bridgeFailed',
    TIMEOUT: 'timeout',
    ERROR: 'error',
});

const NPU_STATE = Object.freeze({
    AVAILABLE: 'available',
    UNAVAILABLE: 'unavailable',
    WEBNN_ONLY: 'webnnOnly',
    UNSUPPORTED: 'unsupported',
    UNKNOWN: 'unknown',
});

const BACKEND = Object.freeze({
    AUTO: 'auto',
    WINML: 'winml',
    DML: 'dml',
    CPU: 'cpu',
});

// WinML vendor EP 要求 Windows 11 24H2（build 26100）；这里只用于展示原因，
// 真正的门槛仍以 winmlCatalog.MIN_BUILD 为准。
const FALLBACK_MIN_BUILD = 26100;
const WINDOWS_10_MIN_BUILD = 10240;
const WINDOWS_11_MIN_BUILD = 22000;

/** 单项探测的硬超时：EP 枚举在冷启动时会扫 catalog + 注册 DLL，可能很久。 */
const PROBE_TIMEOUT_MS = 4000;

/**
 * 可选模块的加载器表（字面量 require）。
 *
 * 绝对不能写回 `require(variablePath)`：webpack 对变量 require 会生成一个
 * 空的 sync context（见 `.webpack/main/index.js` 里的 webpackEmptyContext），
 * 打包后**任何 key 都抛 MODULE_NOT_FOUND**。envCheck 里的 `./settings` /
 * `./gpuInfo` / `../inference/winml/winmlProvider` 于是全部静默返回 null —— 
 * 表现就是「设置里明明开了 WinML，环境检测却永远显示未启用」「GPU fast
 * 阶段已经探到 2 个设备，报告里却永远是空」。这条坑与 Q-Drift 的
 * CORRECTION_LOADERS 同源：动态 require 在 webpack 里会被静默丢弃。
 *
 * 用字面量 require 的函数表，webpack 才能静态收集依赖；每个 loader 仍是惰性
 * 调用，require 失败继续当作「该能力不可用」，不让环境检测整体崩掉。
 * 新增可选依赖时在这里登记一个字面量 loader，不要引入变量 require。
 */
const OPTIONAL_LOADERS = {
    './settings': () => require('./settings'),
    './ipcSafe': () => require('./ipcSafe'),
    './gpuInfo': () => require('./gpuInfo'),
    '../inference/winml/winmlCatalog': () => require('../inference/winml/winmlCatalog'),
    '../inference/winml/winmlProvider': () => require('../inference/winml/winmlProvider'),
    '../inference/winml/ortBridge': () => require('../inference/winml/ortBridge'),
};

function _tryRequire(rel) {
    const load = OPTIONAL_LOADERS[rel];
    if (typeof load !== 'function') return null;
    try {
        return load();
    } catch (_e) {
        return null;
    }
}

/**
 * 从 `os.release()` 解析 Windows build 号。
 *
 * 注意：`os.build` 不是 Node 的真实 API（写 `typeof os.build === 'number'`
 * 永远不成立），只能用 release 末尾数字。Windows 上形如 `10.0.22631` →
 * 22631；Linux 上形如 `6.8.0-45-generic`，末尾无数字 → 0。
 *
 * @param {string} [release]
 * @returns {number}
 */
function parseWindowsBuild(release) {
    const raw = release === undefined ? os.release() : release;
    const m = String(raw || '').match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
}

/**
 * 人类可读的 OS 版本。
 *
 * 不要用主版本判断 Win11：Windows 11 的 `os.release()` 同样是 `10.0.x`，
 * 必须靠 build（>= 22000 才是 11）。这里不猜「23H2 / 24H2」这类发行名——
 * 映射表会随新版本过期，build 号本身才是排障时真正有用的信息。
 *
 * @param {{platform?:string, release?:string}} [overrides]
 * @returns {{release:string, build:number, family:string, display:string}}
 */
function describeOs(overrides = {}) {
    const o = overrides || {};
    const platform = o.platform || process.platform;
    const release = o.release !== undefined ? String(o.release || '') : String(os.release() || '');

    if (platform === 'win32') {
        const build = parseWindowsBuild(release);
        let label = 'Windows';
        let family = 'windows';
        if (build >= WINDOWS_11_MIN_BUILD) {
            label = 'Windows 11';
            family = 'windows11';
        } else if (build >= WINDOWS_10_MIN_BUILD) {
            label = 'Windows 10';
            family = 'windows10';
        }
        return { release, build, family, display: release ? `${label} (${release})` : label };
    }

    const name = platform === 'darwin' ? 'macOS' : (platform === 'linux' ? 'Linux' : platform);
    return {
        release,
        build: 0,
        family: 'other',
        display: release ? `${name} ${release}` : name,
    };
}

function _loadSettingsSafe() {
    const settings = _tryRequire('./settings');
    if (!settings || typeof settings.loadSettings !== 'function') return {};
    try {
        return settings.loadSettings() || {};
    } catch (_e) {
        return {};
    }
}

function _appVersion(injected) {
    if (injected) return String(injected);
    try {
        const { app } = require('electron');
        if (app && typeof app.getVersion === 'function') return String(app.getVersion());
    } catch (_e) { /* 单测 / 非 Electron 环境 */ }
    return '';
}

function _minBuild() {
    const catalog = _tryRequire('../inference/winml/winmlCatalog');
    return (catalog && Number(catalog.MIN_BUILD)) || FALLBACK_MIN_BUILD;
}

/**
 * WinML 门控判定：Windows 上交给 winmlProvider.getWinmlGate()（单一真源），
 * 其它平台直接给 platform 原因，避免为了一个布尔去加载 WinML 相关模块。
 */
function _resolveGate({ platform, arch, build, minBuild, settings, isWindows }) {
    const detail = {
        build: Number(build) || 0,
        minBuild: Number(minBuild) || _minBuild(),
        arch: String(arch || ''),
        provider: String((settings && settings.inferenceProvider) || ''),
    };
    if (!isWindows) {
        return { enabled: false, reason: WINML_GATE.PLATFORM, detail };
    }
    const provider = _tryRequire('../inference/winml/winmlProvider');
    if (provider && typeof provider.getWinmlGate === 'function') {
        try {
            return provider.getWinmlGate({ platform, arch, build, minBuild, settings });
        } catch (_e) { /* 落到下面保守结果：宁可显示未启用，也不要假装已启用 */ }
    }
    return { enabled: false, reason: WINML_GATE.SETTING_OFF, detail };
}

function _readGpuSnapshot() {
    const gpuInfo = _tryRequire('./gpuInfo');
    if (!gpuInfo || typeof gpuInfo.getGPUInfoSnapshot !== 'function') return null;
    try {
        return gpuInfo.getGPUInfoSnapshot();
    } catch (_e) {
        return null;
    }
}

function _readNpuSnapshot() {
    const gpuInfo = _tryRequire('./gpuInfo');
    if (!gpuInfo || typeof gpuInfo.getNPUInfoSnapshot !== 'function') return null;
    try {
        return gpuInfo.getNPUInfoSnapshot();
    } catch (_e) {
        return null;
    }
}

function _npuStateOf(value) {
    if (!value) {
        return {
            state: NPU_STATE.UNKNOWN,
            webnnAvailable: false,
            webnnNpuAvailable: false,
            details: '',
        };
    }
    let state = NPU_STATE.UNAVAILABLE;
    if (value.npuAvailable === true) {
        // 硬件在但 WebNN 路径不可用时，选 NPU 也跑不了，单独标出来。
        state = value.webnnNpuAvailable === true ? NPU_STATE.AVAILABLE : NPU_STATE.WEBNN_ONLY;
    }
    return {
        state,
        webnnAvailable: value.webnnAvailable === true,
        webnnNpuAvailable: value.webnnNpuAvailable === true,
        details: String(value.details || '').slice(0, 200),
    };
}

function _describeGpu(snapshot) {
    const phase = String((snapshot && snapshot.phase) || 'none');
    const controllers = snapshot && Array.isArray(snapshot.controllers) ? snapshot.controllers : [];
    const full = phase === 'full';

    return {
        supported: true,
        phase,
        reason: null,
        items: controllers.map((c, idx) => {
            const totalMb = Number(c && (c.memoryTotal || c.vram)) || 0;
            const usedMb = Number(c && c.memoryUsed) || 0;
            // fast 阶段的显存来自 WMI AdapterRAM（uint32），>4GB 会被截断成
            // 4GB 甚至 0。只有 full（systeminformation 读注册表 qwMemorySize）
            // 才可信，所以非 full 阶段一律 null，由 UI 显示「检测中…」。
            const vramBytes = full && totalMb > 0 ? Math.round(totalMb * 1024 * 1024) : null;
            const usedBytes = full && usedMb > 0 ? Math.round(usedMb * 1024 * 1024) : null;
            const adapterIndex = Number(c && c.adapterIndex);
            return {
                index: Number.isFinite(adapterIndex) ? adapterIndex : idx,
                name: String((c && c.model) || ''),
                vendor: String((c && c.vendor) || ''),
                deviceType: String((c && c.deviceType) || 'unknown'),
                isDiscrete: !!(c && c.isDiscrete),
                vramBytes,
                usedBytes,
                // 与资源管理器同口径：预算上限取显存总量（真 DXGI budget 要起
                // 一次 DML 会话才能拿到，环境检测不该付这个代价）。
                budgetBytes: vramBytes,
                driverVersion: String((c && c.driverVersion) || ''),
                source: String((c && c._source) || (full ? 'si' : 'wmi')),
            };
        }),
    };
}

/**
 * 采集环境快照。**只读内存，不 await 任何探测**。
 *
 * @param {object} [overrides] 仅供单测注入（platform / release / settings / gpuSnapshot ...）
 * @returns {object}
 */
function getEnvReport(overrides = {}) {
    const o = overrides || {};
    const platform = o.platform || process.platform;
    const arch = o.arch || process.arch;
    const isWindows = platform === 'win32';
    const osInfo = describeOs({ platform, release: o.release });

    const settings = o.settings || _loadSettingsSafe();
    const gate = o.gate || _resolveGate({
        platform,
        arch,
        build: osInfo.build,
        minBuild: o.minBuild,
        settings,
        isWindows,
    });

    const gpu = isWindows
        ? _describeGpu(o.gpuSnapshot !== undefined ? o.gpuSnapshot : _readGpuSnapshot())
        : { supported: false, phase: 'skipped', reason: WINML_GATE.PLATFORM, items: [] };

    const npuSnapshot = o.npuSnapshot !== undefined ? o.npuSnapshot : (isWindows ? _readNpuSnapshot() : null);
    const npu = isWindows
        ? { supported: true, ..._npuStateOf(npuSnapshot && npuSnapshot.value) }
        : { supported: false, state: NPU_STATE.UNSUPPORTED, webnnAvailable: false, webnnNpuAvailable: false, details: '' };

    const cpus = os.cpus() || [];
    const platformSupported = ![WINML_GATE.PLATFORM, WINML_GATE.ARCH, WINML_GATE.BUILD].includes(gate.reason);

    return {
        generatedAt: Number(o.now) || Date.now(),
        platform,
        arch,
        isWindows,
        os: osInfo,
        cpu: {
            model: cpus[0] && cpus[0].model ? String(cpus[0].model).trim() : '',
            threads: cpus.length,
        },
        memory: {
            totalBytes: os.totalmem(),
            freeBytes: os.freemem(),
        },
        gpu,
        npu,
        winml: {
            supported: platformSupported,
            enabled: gate.enabled === true,
            gate: gate.reason,
            detail: gate.detail,
        },
        settings: {
            nativeInferenceBackend: String(settings.nativeInferenceBackend || BACKEND.AUTO),
            inferenceProvider: String(settings.inferenceProvider || ''),
            winmlEnabled: settings.winmlEnabled === true,
        },
        runtime: {
            app: _appVersion(o.appVersion),
            electron: String((process.versions && process.versions.electron) || ''),
            node: String((process.versions && process.versions.node) || ''),
            // 显式探测 VC++ 2015-2022 运行库。旧机器缺这三枚 DLL 时原生桥
            // （ort_bridge.node / onnxruntime.dll）会在加载阶段静默失败，
            // 用户只看到"binding 未找到"；这里把根因直接暴露出来。
            // o.vcRuntime 仅供单测注入，避免 CI(Linux) 触碰真实文件系统判定。
            vcRuntime: o.vcRuntime !== undefined ? o.vcRuntime : probeVcRuntime({ platform }),
        },
    };
}

// ---------------------------------------------------------------------------
// 运行期探测（异步、带超时）
// ---------------------------------------------------------------------------

function _withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve(fallback);
        }, ms);
        Promise.resolve(promise).then(
            (value) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({ __error: err });
            },
        );
    });
}

function _sanitize(message) {
    if (!message) return null;
    const text = String(message);
    try {
        const { sanitizeErrorMessage } = require('./ipcSafe');
        if (typeof sanitizeErrorMessage === 'function') {
            return String(sanitizeErrorMessage(text)).slice(0, 300);
        }
    } catch (_e) { /* 退化为下面的保守清洗 */ }
    return text
        .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
        .replace(/\/(?:home|Users|root)\/[^\s"']+/g, '<path>')
        .slice(0, 300);
}

function _basename(libraryPath) {
    const s = String(libraryPath || '');
    if (!s) return '';
    const parts = s.split(/[\\/]/);
    return String(parts[parts.length - 1] || '').slice(0, 60);
}

function _normalizeProviders(list) {
    return (Array.isArray(list) ? list : []).map((p) => {
        const readyState = Number(p && p.readyState) || 0;
        return {
            name: String((p && p.name) || ''),
            // readyState === 0 表示「已就绪」。WinRT 枚举里 0 是 Ready，非 0 才是
            // 需要下载 / 未就绪——反直觉，改之前先看 winmlCatalog.ensureEntryReady。
            readyState,
            ready: readyState === 0,
            // 只留文件名的原因：完整 libraryPath 是用户机器绝对路径，会被复制进 issue。
            library: _basename(p && p.libraryPath),
            devices: (Array.isArray(p && p.devices) ? p.devices : []).map((d) => ({
                type: String((d && d.deviceType) || 'unknown'),
                count: Array.isArray(d && d.indices) ? d.indices.length : 0,
                selectable: !!(d && d.selectable),
            })),
        };
    });
}

/**
 * 运行期状态优先级：桥挂了 → 超时 → 出错 → 没 EP → EP 未就绪 → 正常。
 * 桥失败必须排最前：桥不可用时 EP 列表必然是空的，报 noProviders 会误导。
 */
function _winmlRuntimeStatus(enabled, bridge, providers, providersTimedOut, providersError) {
    if (!enabled) return null;
    if (bridge && bridge.failureReason) return WINML_RUNTIME.BRIDGE_FAILED;
    if (providersTimedOut) return WINML_RUNTIME.TIMEOUT;
    if (providersError) return WINML_RUNTIME.ERROR;
    if (!providers.length) return WINML_RUNTIME.NO_PROVIDERS;
    if (!providers.some((p) => p.readyState === 0)) return WINML_RUNTIME.UNREADY;
    return WINML_RUNTIME.OK;
}

async function _probeBridge() {
    const bridge = _tryRequire('../inference/winml/ortBridge');
    if (!bridge || typeof bridge.ensureBridgeInit !== 'function') {
        return { initialized: false, failureReason: null };
    }
    let initialized = false;
    try {
        initialized = await _withTimeout(bridge.ensureBridgeInit(), PROBE_TIMEOUT_MS, false);
    } catch (_e) {
        initialized = false;
    }
    let failureReason = null;
    try {
        if (typeof bridge.getInitFailureReason === 'function') {
            failureReason = bridge.getInitFailureReason();
        }
    } catch (_e) {
        failureReason = null;
    }
    return { initialized: initialized === true, failureReason: _sanitize(failureReason) };
}

async function _probeProviders() {
    const provider = _tryRequire('../inference/winml/winmlProvider');
    if (!provider || typeof provider.listProviderDevices !== 'function') {
        return { providers: [], timedOut: false, error: true };
    }
    const result = await _withTimeout(
        provider.listProviderDevices({ forceRefresh: false }),
        PROBE_TIMEOUT_MS,
        { __timeout: true },
    );
    if (result && result.__timeout) return { providers: [], timedOut: true, error: false };
    if (result && result.__error) return { providers: [], timedOut: false, error: true };
    return { providers: Array.isArray(result) ? result : [], timedOut: false, error: false };
}

async function _probeNpu(overrides) {
    if (overrides.npuSnapshot && overrides.npuSnapshot.value) {
        return _npuStateOf(overrides.npuSnapshot.value);
    }
    const gpuInfo = _tryRequire('./gpuInfo');
    if (!gpuInfo || typeof gpuInfo.detectNPUCached !== 'function') {
        return _npuStateOf(null);
    }
    const result = await _withTimeout(gpuInfo.detectNPUCached(), PROBE_TIMEOUT_MS, { __timeout: true });
    if (!result || result.__timeout || result.__error) return _npuStateOf(null);
    return _npuStateOf(result);
}

/**
 * 采集运行期探测结果。仅 Windows 且 WinML 门控打开时才做重活；
 * 每一项都吃 PROBE_TIMEOUT_MS，超时就报对应状态而不是卡住弹层。
 *
 * @param {object} [overrides] 仅供单测注入（gate / bridge / providers / npuSnapshot）
 * @returns {Promise<object>}
 */
async function getEnvCheckProbes(overrides = {}) {
    const o = overrides || {};
    const platform = o.platform || process.platform;
    const arch = o.arch || process.arch;
    const isWindows = platform === 'win32';
    const settings = o.settings || _loadSettingsSafe();
    const gate = o.gate || _resolveGate({
        platform,
        arch,
        build: parseWindowsBuild(o.release),
        minBuild: o.minBuild,
        settings,
        isWindows,
    });

    if (!isWindows) {
        return {
            supported: false,
            winml: {
                gate: gate.reason,
                status: null,
                bridge: { initialized: false, failureReason: null },
                providers: [],
                providersTimedOut: false,
            },
            // 与 getEnvReport 保持同一口径：非 Windows 是「平台不支持」，
            // 不是「还没检测完」（unknown）。
            npu: {
                state: NPU_STATE.UNSUPPORTED,
                webnnAvailable: false,
                webnnNpuAvailable: false,
                details: '',
            },
        };
    }

    const npu = await _probeNpu(o);

    if (!gate.enabled) {
        return {
            supported: true,
            winml: {
                gate: gate.reason,
                // 门控没开就不去碰 EP：既没意义，也可能触发不必要的 catalog 扫描。
                status: null,
                bridge: { initialized: false, failureReason: null },
                providers: [],
                providersTimedOut: false,
            },
            npu,
        };
    }

    const bridge = o.bridge || await _probeBridge();
    const providersResult = o.providers
        ? { providers: Array.isArray(o.providers) ? o.providers : [], timedOut: false, error: false }
        : await _probeProviders();
    const providers = _normalizeProviders(providersResult.providers);

    return {
        supported: true,
        winml: {
            gate: gate.reason,
            status: _winmlRuntimeStatus(
                true,
                bridge,
                providers,
                providersResult.timedOut,
                providersResult.error,
            ),
            bridge: {
                initialized: !!(bridge && bridge.initialized),
                // 出口统一脱敏：_probeBridge() 内部已洗过一遍，但 overrides.bridge
                // 是外部注入的，不能假定它干净——这段文字会被用户直接贴进 issue。
                failureReason: _sanitize((bridge && bridge.failureReason) || null),
            },
            providers,
            providersTimedOut: !!providersResult.timedOut,
        },
        npu,
    };
}

module.exports = {
    getEnvReport,
    getEnvCheckProbes,
    describeOs,
    parseWindowsBuild,
    WINML_GATE,
    WINML_RUNTIME,
    NPU_STATE,
    BACKEND,
};
