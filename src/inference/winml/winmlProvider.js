/**
 * winmlProvider.js — orchestration layer between the pipeline's model loader
 * and the Windows ML stack.
 *
 * Priority policy ("main models first", per project decision):
 *   - diff_step / vocoder / preflow class models (dynamic shapes):
 *       NvTensorRtRtx (GPU) -> OpenVINO (GPU) -> [caller falls back to DML/CPU]
 *   - static-shape int8 models may additionally target the NPU:
 *       ... -> OpenVINO (NPU) / OpenVINO.AUTO
 *   - small detectors (FCPE/RMVPE/ROSVOT) are intentionally NOT adapted.
 *
 * Single EP spanning multiple hardware (e.g. OpenVINO exposes one
 * OpenVINOExecutionProvider EP whose device entries cover NPU/CPU/GPU): those
 * devices all share the same epName, so the JS chain hands ALL of that EP's
 * device indices to one session (createSessionWithEps) and ORT/WinML picks the
 * device internally — we do not pin a deviceType from JS for the grouped
 * candidate. A separate `.AUTO` variant (epName ending in `.AUTO`) and the
 * explicit NPU entry are appended only for static-shape int8 models.
 *
 * All failures degrade to null so callers fall back to the existing chains.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ortBridge = require('./ortBridge');
const winmlCatalog = require('./winmlCatalog');
const detectionCache = require('./winmlDetectionCache');

// Models that already failed at RUNTIME on a WinML vendor EP, keyed by model
// file name. Creation can succeed (the validation dummy usually has a length
// inside the compiled profile) while real inputs fail, e.g.
//   mel_transform (arbitrary reference-audio sample counts)
//     → NvTensorRTRTX EP failed to call ...setInputShape() for input 'waveform'
//   vocoder / diff_step fed with an out-of-profile shape or non-finite data
//     → NvTensorRTRTX EP execution context enqueue failed.
// Recreating the same engine reproduces the failure, so once a model lands here
// it is pinned to the DML/CPU fallback chain for the rest of the process.
const _runtimeBlockedModels = new Set();

function _blockedKey(modelPath) {
    return path.basename(String(modelPath || '')).toLowerCase();
}

/**
 * Pin a model to the non-WinML fallback chain after a runtime failure.
 * @param {string} modelPath - path or file name of the failing model
 * @param {string} [message] - original error message (for logging)
 * @returns {boolean} true when the model is now blocked
 */
function reportRuntimeFailure(modelPath, message) {
    const key = _blockedKey(modelPath);
    if (!key) return false;
    if (!_runtimeBlockedModels.has(key)) {
        console.warn(`[WinML][runtime] model=${key} pinned to DML/CPU after runtime failure: ${String(message || '').split('\n')[0].slice(0, 140)}`);
    }
    _runtimeBlockedModels.add(key);
    return true;
}

/**
 * Whether the given model must skip the WinML chain (see reportRuntimeFailure).
 * @param {string} modelPath
 * @returns {boolean}
 */
function isRuntimeBlocked(modelPath) {
    return _runtimeBlockedModels.has(_blockedKey(modelPath));
}

const registeredEps = new Set();
let registrationAttempted = false;
let _lastAttemptAt = 0;
const RETRY_COOLDOWN_MS = 15000;
let _registeringPromise = null;
let _readyEpLibrariesPromise = null;
let _readyEpLibrariesCache = null;
// 记录解析缓存时的后端门控状态。缓存随后端失效是必要的：用户在 DML 与
// Windows ML 之间切换时，gate 关闭期间解析出的空 EP 列表若被永久缓存，切回
// Windows ML 后所有模型会继续回退到 DML/CPU，界面上的 EP 便一直是 DML。
let _readyEpLibrariesCacheKey = null;

function _getSettings() {
    // worker_threads 场景：svsWorker 启动时把主进程下发的开关快照挂到
    // globalThis（worker 里 require('electron') 不可用，settings 模块读不到
    // userData）。主进程/渲染进程场景回落到 loadSettings()。
    const snapshot = globalThis.__SXS_SETTINGS_SNAPSHOT__;
    if (snapshot && typeof snapshot === 'object') return snapshot;
    try {
        const { loadSettings } = require('../../main/settings');
        return loadSettings() || {};
    } catch (_e) {
        return {};
    }
}

/** Gate for the WinML branch. On by default with backend auto/winml; closed
 * (returns false) when the user opts into DML (nativeInferenceBackend==='dml')
 * or the platform is unsupported.
 *
 * 同时校验 nativeInferenceBackend：界面保存时 winmlEnabled 由后端派生，但
 * 旧配置、CLI 注入或诊断快照可能只带其中一个字段。两者任一指向 DML 都应
 * 关闭 WinML 分支，避免"设置显示已切回 WinML、实际仍走 DML"的不一致。
 */
function isWinmlEnabled() {
    if (!winmlCatalog.isPlatformSupported()) return false;
    const s = _getSettings();
    if (s.nativeInferenceBackend === 'dml') return false;
    if (s.inferenceProvider && s.inferenceProvider !== 'ortnode') return false;
    return s.winmlEnabled === true;
}

/** 解析缓存的键：门控开关 + 显式后端。后端一变，旧缓存立即失效。 */
function _epCacheKey() {
    const s = _getSettings();
    return `${isWinmlEnabled() ? 'on' : 'off'}|${String(s.nativeInferenceBackend || 'auto')}|${String(s.inferenceProvider || '')}`;
}

/** libraryPath 的短标签：<包名>/ExecutionProvider（日志可读性用）。 */
function _libLabel(libraryPath) {
    const parts = String(libraryPath || '').split('\\');
    const dirName = parts.slice(-3, -1).join('/');
    return dirName || parts[parts.length - 1] || '?';
}

/**
 * 从同名 EP 的多份 MSIX 里挑一份"版本最高且真的能加载"的库。
 *
 * 核心是一个短路：命中第一个可加载的候选就返回，**不再探测更旧的版本**。
 * 这不是微优化 —— 旧 ABI 的 provider（如 ORT 1.24 时代的 EP.1.8）在宿主
 * ORT 1.27 上 LoadLibrary 时，DllMain 会先把 TensorRT/CUDA 初始化跑一遍
 * 再以 1114 失败：现场日志里这一次探测花了 18.3 s（另外两次 3.5 s），而它
 * 的结论永远不会被采用（版本排序已经保证取最高版本）。
 *
 * 失败结论写进持久化负缓存（winmlDetectionCache.isKnownUnloadable）：
 * 机器上只剩旧包时，后续启动直接跳过探测，不再重付这份时间。
 *
 * @param {string} name EP 名（仅用于日志）
 * @param {Array<{libraryPath:string}>} candidates 候选
 * @returns {Promise<{name:string, libraryPath:string}|null>}
 */
async function _pickLoadableCandidate(name, candidates) {
    const ordered = [...candidates].sort(
        (a, b) => _compareMsixVersion(_msixVersionOf(b.libraryPath), _msixVersionOf(a.libraryPath)),
    );
    const skipped = [];
    let probed = 0;
    for (const cand of ordered) {
        const dirName = _libLabel(cand.libraryPath);
        if (detectionCache.isKnownUnloadable(cand.libraryPath)) {
            skipped.push(`${dirName}(known-bad)`);
            continue;
        }
        let loadable = false;
        const started = Date.now();
        try {
            await ortBridge.ensureBridgeInit();
            loadable = ortBridge.canLoadLibrary(cand.libraryPath);
        } catch (_) { /* 探测本身出错按不可加载处理 */ }
        const ms = Date.now() - started;
        probed += 1;
        if (loadable) {
            if (skipped.length) {
                console.log(`[WinML] warmup ${name}: pick ${dirName} (skipped ${skipped.join(', ')}) probed=${probed} ms=${ms}`);
            } else {
                console.log(`[WinML] warmup ${name}: candidate ${dirName} OK ms=${ms}`);
            }
            detectionCache.clearUnloadable(cand.libraryPath);
            return { name, libraryPath: cand.libraryPath };
        }
        detectionCache.reportUnloadable(cand.libraryPath);
        console.warn(`[WinML] warmup ${name}: DLL not loadable, skipping ${dirName} ms=${ms}`);
    }
    if (skipped.length) {
        console.warn(`[WinML] ${name}: all candidates skipped by probe cache (${skipped.join(', ')}); `
            + 'set SXS_WINML_REPROBE=1 or clear the inference cache in settings to re-probe');
    }
    return null;
}

/**
 * 主进程专用：确保兼容 EP 就绪（必要时触发 MSIX 下载），
 * 返回可直接 registerEp 的 {name, libraryPath} 列表。
 * 在 worker_threads 里不可用（dynwinrt/COM 依赖主进程环境）——
 * worker 应改用 __SXS_WINML_EPS__ 快照。
 */
async function _resolveReadyEpLibraries() {
    if (!isWinmlEnabled()) {
        console.log('[WinML] getReadyEpLibraries: gate closed (winmlEnabled=false / backend=dml / platform unsupported)');
        return [];
    }
    const t0 = Date.now();
    const phases = [];
    const mark = (label, from) => phases.push(`${label}:${Date.now() - from}`);

    const s = _getSettings();
    const tBoot = Date.now();
    await winmlCatalog.ensureCatalog(s.winmlBootstrapDllPath);
    mark('catalog', tBoot);

    const tScan = Date.now();
    const entries = await winmlCatalog.listAllProviderEntries();
    mark('scan', tScan);
    console.log(`[WinML] getReadyEpLibraries: ${entries.length} provider(s) (catalog+fs scan)`);

    // 同名 provider 可能存在多个 MSIX 版本（如 NvTensorRtRtx 同时装有
    // WinML 1.8 时代的 EP.1.8_x（对应 ORT 1.24 ABI）与 2.x 的 EP.2_y
    // （对应 ORT 1.27 ABI））。宿主是 ORT 1.27 —— 必须择最高可加载版本注册，
    // 否则旧 ABI 插件 LoadLibrary 后 RegisterExecutionProviderLibrary 报错 1114。
    const byName = new Map();
    for (const e of entries) {
        const arr = byName.get(e.name) || [];
        arr.push(e);
        byName.set(e.name, arr);
    }

    const tProbe = Date.now();
    const out = [];
    for (const [name, group] of byName) {
        // 按 MSIX 版本降序整理候选：既让 2.x 排在 1.8 前面（省掉一次必然
        // 失败的 canLoad），也保证 _pickLoadableCandidate 的短路取到最高版本。
        const sortedGroup = [...group].sort((a, b) => {
            const pa = a.inst ? (a.inst.libraryPath || '') : (a.libraryPathHint || '');
            const pb = b.inst ? (b.inst.libraryPath || '') : (b.libraryPathHint || '');
            return _compareMsixVersion(_msixVersionOf(pb), _msixVersionOf(pa));
        });
        const seenPaths = new Set();
        const candidates = [];
        for (const entry of sortedGroup) {
            try {
                let libraryPath = null;
                if (entry.inst) {
                    const r = await winmlCatalog.ensureEntryReady(entry);
                    if (!r.ok || !r.libraryPath) {
                        console.warn(`[WinML] warmup ${name}: not ready (readyState=${entry.readyState})`);
                        continue;
                    }
                    libraryPath = r.libraryPath;
                } else if (entry.libraryPathHint) {
                    libraryPath = entry.libraryPathHint;
                } else continue;
                const lower = libraryPath.toLowerCase();
                if (seenPaths.has(lower)) continue;
                seenPaths.add(lower);
                candidates.push({ name, libraryPath });
            } catch (e) {
                console.warn(`[WinML] warmup ${name} threw: ${(e.message || '').split('\n')[0].slice(0, 120)}`);
            }
        }
        if (!candidates.length) {
            console.warn(`[WinML] no ready candidate for ${name}`);
            continue;
        }
        // 可加载性探测放在这里：只探到第一个能加载的为止（见 _pickLoadableCandidate）。
        const best = await _pickLoadableCandidate(name, candidates);
        if (!best) {
            console.warn(`[WinML] no loadable candidate for ${name} (candidates=${candidates.length})`);
            continue;
        }
        out.push(best);
    }
    mark('resolve', tProbe);
    console.log(`[WinML][ready] phases=${phases.join(',')} total=${Date.now() - t0}`);
    return out;
}

/**
 * Resolve provider packages once per process. ExecutionProviderCatalog is not
 * re-entrant: two concurrent EnsureReadyAsync calls for the same provider can
 * race after the first call changes readyState and Chromium terminates the
 * process with a WebNN FATAL. Settings warmup and first synthesis commonly
 * overlap, so all callers must share this single flight.
 */
async function getReadyEpLibraries() {
    const key = _epCacheKey();
    // 只有当缓存来自**同一个门控状态**时才复用。旧实现无条件命中，
    // 于是 DML 后端期间解析出的空列表（甚至是 [] 这个 truthy 值）会在切回
    // Windows ML 后继续被返回，worker 拿到空 EP 快照，全部模型回退 DML。
    if (_readyEpLibrariesCache && _readyEpLibrariesCacheKey === key) {
        return _readyEpLibrariesCache.map(e => ({ ...e }));
    }
    if (_readyEpLibrariesPromise) {
        console.log('[WinML][ready] join=in-flight');
        return _readyEpLibrariesPromise;
    }

    // 门控关闭时不要解析、也不要缓存：诊断/预热等路径会在后端为 DML 时
    // 调用本函数，若把 [] 写进缓存，切回 Windows ML 后就是永久短路。
    if (!isWinmlEnabled()) {
        _readyEpLibrariesCache = null;
        _readyEpLibrariesCacheKey = null;
        console.log('[WinML][ready] gate closed; returning empty without caching');
        return [];
    }

    // 跨重启缓存：上一次启动已解析出的可注册 EP 库。libraryPath 仍存在、
    // 门控键与运行环境（Electron / OS build / 架构）一致时直接复用，跳过
    // catalog 初始化与逐个 DLL 的可加载性探测 —— 这是管线初始化最慢的一段。
    const persisted = detectionCache.getCachedReadyEps(key);
    if (persisted) {
        _readyEpLibrariesCache = persisted.map(e => ({ ...e }));
        _readyEpLibrariesCacheKey = key;
        console.log(`[WinML][ready] persistent-cache eps=${persisted.map(e => e.name).join(',')}`);
        return persisted.map(e => ({ ...e }));
    }

    const started = Date.now();
    console.log('[WinML][ready] start');
    _readyEpLibrariesPromise = _resolveReadyEpLibraries()
        .then((eps) => {
            _readyEpLibrariesCache = eps.map(e => ({ ...e }));
            _readyEpLibrariesCacheKey = key;
            if (eps.length > 0) detectionCache.setCachedReadyEps(key, eps);
            console.log(`[WinML][ready] done ms=${Date.now() - started} eps=${eps.map(e => e.name).join(',') || 'none'}`);
            return _readyEpLibrariesCache.map(e => ({ ...e }));
        })
        .finally(() => { _readyEpLibrariesPromise = null; });
    return _readyEpLibrariesPromise;
}

/** 归一化用户选择的硬件类型：'gpu' | 'cpu' | 'npu' | ''（空 = 沿用该 EP 的全部设备）。 */
function _normalizeDeviceType(value) {
    const v = String(value || '').trim().toLowerCase();
    return (v === 'gpu' || v === 'cpu' || v === 'npu') ? v : '';
}

/**
 * 设置页专用：EP 名单 + 每个 EP 实际暴露的硬件设备（gpu / cpu / npu）。
 *
 * 为什么要在主进程注册 EP：WinRT catalog 只给 EP 名与安装状态，硬件粒度只有
 * ORT 的 EpDevice 枚举才有（OrtEpDevice_Device().Type → gpu/cpu/npu）。主进程
 * 与管线各自持有独立的 OrtEnv（WinML 开启时管线跑在 worker 里），在这里注册
 * 不会影响 worker 的会话。
 *
 * 门控关闭（DML 后端 / WinML 未开启）时只返回名单不枚举设备：枚举要先跑一遍
 * EP 解析与注册，用户没打算用 WinML 时不该付这份钱。
 *
 * @param {{forceRefresh?:boolean}} [options]
 * @returns {Promise<Array<{name:string, readyState:number, libraryPath:string,
 *   devices:Array<{deviceType:string, indices:number[], selectable:boolean}>}>>}
 */
async function listProviderDevices(options = {}) {
    const providers = await winmlCatalog.listCompatibleProviders({
        forceRefresh: options && options.forceRefresh === true,
    });
    const out = (providers || []).map((p) => ({
        name: p.name,
        readyState: Number(p.readyState) || 0,
        libraryPath: p.libraryPath || '',
        source: p.source || '',
        devices: [],
    }));
    if (!out.length || !isWinmlEnabled()) return out;

    const eps = await getReadyEpLibraries();
    if (!eps.length) return out;
    const bridgeReady = await ortBridge.ensureBridgeInit();
    if (!bridgeReady) return out;

    for (const ep of eps) {
        if (registeredEps.has(ep.name)) continue;
        try {
            ortBridge.registerEp(ep.name, ep.libraryPath);
            registeredEps.add(ep.name);
        } catch (e) {
            const msg = (e.message || '').toLowerCase();
            if (msg.includes('already registered')) {
                registeredEps.add(ep.name);
            } else {
                console.warn(`[WinML][devices] registerEp(${ep.name}) failed: ${(e.message || '').split('\n')[0].slice(0, 140)}`);
            }
        }
    }

    const devices = ortBridge.listDevices();
    const npuUsable = globalThis.__SXS_NPU_AVAILABLE__ === true
        && globalThis.__SXS_OPENVINO_NPU_SAFE__ === true;
    const TYPE_ORDER = { gpu: 0, npu: 1, cpu: 2 };
    for (const entry of out) {
        const byType = new Map();
        for (const d of devices) {
            // 只认精确 EP 名：`.AUTO` 之类是另一种虚拟设备，混进来会让
            // "OpenVINO GPU" 同时带上 AUTO 的设备索引。
            if (d.epName !== entry.name) continue;
            const type = _normalizeDeviceType(d.deviceType) || 'cpu';
            if (!byType.has(type)) byType.set(type, []);
            byType.get(type).push(d.index);
        }
        entry.devices = [...byType.entries()]
            .sort((a, b) => (TYPE_ORDER[a[0]] ?? 9) - (TYPE_ORDER[b[0]] ?? 9))
            .map(([deviceType, indices]) => ({
                deviceType,
                indices,
                // NPU 被安全门挡住时仍然列出来（让用户知道硬件存在），
                // 但标记不可选 —— 直接放行会让 OpenVINO 的 NPU compiler 崩。
                selectable: deviceType !== 'npu' || npuUsable,
            }));
    }
    return out;
}

/** 从 MSIX libraryPath 提取数字版本串用于比较（如 ...EP.2_2.30.49.0_x64 -> 2.30.49.0）。 */
function _msixVersionOf(libraryPath) {
    const m = /EP\.(\d+)_(\d+\.\d+\.\d+\.\d+)_/i.exec(libraryPath || '');
    return m ? m[1] + '.' + m[2] : '0';
}

/**
 * 读取 provider DLL 的文件版本（PE 版本资源里的 FileVersion）。
 *
 * 只在 TRT 会话首次创建时执行一次并缓存：PowerShell 冷启动约 200-400ms，
 * 放在每次模型加载里不可接受。读不到就返回 null，由调用方回退到文件的
 * size/mtime 指纹 —— 版本号拿不到不能影响缓存本身的可用性。
 */
function _readDllFileVersion(dllPath) {
    const override = String(process.env.SXS_TRT_VERSION || '').trim();
    if (override) return `env:${override.slice(0, 40)}`;
    if (process.platform !== 'win32' || !dllPath) return null;
    try {
        const { execFileSync } = require('node:child_process');
        const escaped = String(dllPath).replace(/'/g, "''");
        const out = execFileSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`,
        ], { timeout: 2500, windowsHide: true, encoding: 'utf8' });
        const version = String(out || '').trim().split(/\r?\n/)[0].trim();
        return version ? version.slice(0, 40) : null;
    } catch (_) {
        return null;
    }
}

let _trtRuntimeFingerprintPromise = null;

/**
 * TensorRT-RTX 运行时身份指纹，用于持久化 dummy 校验的缓存键。
 *
 * 为什么需要：TRT 的 engine 每次启动都会重新加载/编译，上一次会话校验通过
 * 不能证明本次 engine 健康。但"同一个 TRT 运行时 + 同一个 GPU + 同一个模型"
 * 在版本不变时重编译出坏 engine 的概率极低，可以安全复用校验记录。反过来，
 * TRT 运行时（EP 包 / provider DLL）一升级，旧记录必须立即失效 —— 这正是
 * 这个指纹的作用。GPU 名称由调用方另外并入缓存键。
 *
 * 组成：EP 包 MSIX 版本 + provider DLL 的 FileVersion（取不到时用 size/mtime）。
 * 拿不到指纹时返回一个"每次启动都不同"的值：宁可每次重新校验，也不误命中
 * 一个无法判断版本的旧记录。同一进程内仍是稳定的（promise 缓存）。
 *
 * @returns {Promise<string>}
 */
function getTrtRuntimeFingerprint() {
    if (_trtRuntimeFingerprintPromise) return _trtRuntimeFingerprintPromise;
    const unresolved = `unresolved-${Date.now().toString(36)}-${process.pid}`;
    _trtRuntimeFingerprintPromise = (async () => {
        try {
            const eps = await getReadyEpLibraries();
            const trt = (eps || []).find((e) => String((e && e.name) || '').includes('NvTensor'));
            if (!trt || !trt.libraryPath) return unresolved;
            const lib = String(trt.libraryPath);
            const msix = _msixVersionOf(lib);
            const fileVersion = _readDllFileVersion(lib);
            let stamp = 'nostat';
            try {
                const stat = fs.statSync(lib);
                stamp = `${stat.size}-${Math.round(stat.mtimeMs)}`;
            } catch (_) { /* 文件消失：保留 nostat，下次启动会重新探测 */ }
            return `trt-rtx@${msix || 'na'}+${fileVersion || stamp}`;
        } catch (_) {
            return unresolved;
        }
    })();
    return _trtRuntimeFingerprintPromise;
}

function _compareMsixVersion(a, b) {
    const va = String(a).split('.').map(Number);
    const vb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const da = va[i] || 0, db = vb[i] || 0;
        if (da !== db) return da - db;
    }
    return 0;
}

/**
 * 在 WindowsApps 下扫描同类 EP 的其他 MSIX 版本（用于 worker 快照回退）。
 * 例如 NvTensor 的 1.8 旧包加载失败时，自动找到 2.x 新包的 DLL。
 * 返回按版本降序排列的候选 libraryPath 列表。
 */
const _altPathCache = new Map();
function _findAlternativeWinMLPaths(epName) {
    if (_altPathCache.has(epName)) return _altPathCache.get(epName);
    const patterns = {
        'NvTensorRTRTXExecutionProvider': ['TRT-RTX', 'trt_rtx', 'nv_tensorrt'],
        'OpenVINOExecutionProvider': ['OpenVINO'],
        'QNNExecutionProvider': ['QNN', 'qnn'],
        'MIGraphXExecutionProvider': ['MIGraphX', 'migraphx'],
        'VitisAIExecutionProvider': ['VitisAI', 'vitis'],
    };
    const keywords = patterns[epName] || [epName.replace('ExecutionProvider', '')];
    const winApps = 'C:\\Program Files\\WindowsApps';
    let dirs;
    try { dirs = fs.readdirSync(winApps); } catch { _altPathCache.set(epName, []); return []; }
    const candidates = [];
    for (const dir of dirs) {
        const lower = dir.toLowerCase();
        if (!lower.includes('winml')) continue;
        const matched = keywords.some(k => lower.includes(k.toLowerCase()));
        if (!matched) continue;
        const epDir = path.join(winApps, dir, 'ExecutionProvider');
        let files;
        try { files = fs.readdirSync(epDir); } catch { continue; }
        for (const f of files) {
            const fl = f.toLowerCase();
            if (fl.endsWith('.dll') && fl.includes('onnxruntime_providers')) {
                candidates.push(path.join(epDir, f));
            }
        }
    }
    candidates.sort((a, b) => _compareMsixVersion(_msixVersionOf(b), _msixVersionOf(a)));
    _altPathCache.set(epName, candidates);
    return candidates;
}

async function _getCatalogFallbackPaths(epName) {
    try {
        const entries = await winmlCatalog.listAllProviderEntries();
        const out = [];
        for (const e of entries) {
            if (e.name !== epName) continue;
            const p = e.inst ? (e.inst.libraryPath || null) : (e.libraryPathHint || null);
            if (p) out.push(p);
        }
        out.sort((a, b) => _compareMsixVersion(_msixVersionOf(b), _msixVersionOf(a)));
        return out;
    } catch { return []; }
}

/**
 * Make sure bridge is initialized and the given EP names are registered.
 * Worker 场景使用主进程经 workerData 下发的 __SXS_WINML_EPS__ 快照
 * （worker 内 dynwinrt/catalog 不可用）；主进程场景走 catalog 动态解析。
 */
function _syncRegisteredFromDevices() {
    try {
        const devices = ortBridge.listDevices();
        for (const d of devices) {
            if (d.epName && !registeredEps.has(d.epName)) registeredEps.add(d.epName);
        }
    } catch (_) {}
}

/**
 * worker 侧注册单个 EP 库。
 * @param {string} epName
 * @param {string} libPath
 * @param {boolean} isFallback 仅影响日志措辞
 * @returns {boolean} 是否已可用
 */
function _registerSnapshotEp(epName, libPath, isFallback) {
    try {
        ortBridge.registerEp(epName, libPath);
        registeredEps.add(epName);
        if (isFallback) console.log(`[WinML] worker registered ${epName} via fallback ${libPath.split('\\').pop()}`);
        else console.log(`[WinML] worker registered ${epName}`);
        return true;
    } catch (e) {
        const msg = (e.message || '').split('\n')[0].slice(0, 300);
        if (msg.toLowerCase().includes('already registered')) {
            console.log(`[WinML] worker ${epName} already registered (gle=126), treating as OK`);
            registeredEps.add(epName);
            return true;
        }
        console.warn(`[WinML] worker registerEp(${epName} <- ${String(libPath).split('\\').pop()}) failed: ${msg}`);
        return false;
    }
}

async function ensureEpsRegistered(epNames) {
    if (!isWinmlEnabled()) return false;
    const ok = await ortBridge.ensureBridgeInit();
    if (!ok) return false;
    _syncRegisteredFromDevices();

    const snapshotEps = Array.isArray(globalThis.__SXS_WINML_EPS__)
        ? globalThis.__SXS_WINML_EPS__
        : null;

    if (snapshotEps) {
        // Worker path: the MSIX package graph (WindowsApps) requires package
        // identity via initWinappsdk. Without it LoadLibrary on the MSIX path
        // fails with 1114 (DLL init failed). Ensure catalog first.
        try {
            const snapSettings = globalThis.__SXS_SETTINGS_SNAPSHOT__ || {};
            await winmlCatalog.ensureCatalog(snapSettings.winmlBootstrapDllPath);
        } catch (e) {
            console.warn(`[WinML] worker ensureCatalog failed: ${(e.message || '').slice(0,120)}`);
        }
        // Snapshot carries the best loadable libPath from main (preferring 2.x).
        // If that specific version fails (e.g. transient 1114 or stale cache),
        // try catalog-discovered hints first (no elevation needed), then filesystem scan.
        //
        // 兜底枚举必须懒执行：catalog 初始化 + Get-AppxPackage 要在 worker 里
        // 付 1–2s（WindowsApps 受限时更久），而快照路径几乎总是直接注册成功。
        // 旧实现无条件先算兜底列表，等于每次 spawn worker 都白付这笔钱。
        for (const ep of snapshotEps) {
            if (registeredEps.has(ep.name)) continue;
            let registered = _registerSnapshotEp(ep.name, ep.libraryPath, false);
            if (!registered) {
                const catalogHints = await _getCatalogFallbackPaths(ep.name);
                const fsHints = _findAlternativeWinMLPaths(ep.name);
                const fallbacks = [...catalogHints, ...fsHints]
                    .filter((p, i, all) => p && p !== ep.libraryPath && all.indexOf(p) === i)
                    // Sort fallbacks by MSIX version descending so 2.x is tried before 1.8 even when snapshot was stale
                    .sort((a, b) => _compareMsixVersion(_msixVersionOf(b), _msixVersionOf(a)));
                for (const libPath of fallbacks) {
                    if (_registerSnapshotEp(ep.name, libPath, true)) { registered = true; break; }
                }
            }
            if (!registered) {
                console.warn(`[WinML] worker: all candidates failed for ${ep.name}`);
            }
        }
        if (registeredEps.size === 0) {
            console.warn('[WinML] worker snapshot registration failed for ALL EPs');
        }
        return registeredEps.size > 0;
    }

    const missing = epNames.filter((n) => !registeredEps.has(n));
    if (missing.length === 0) return true;

    // ExecutionProviderCatalog 的硬件枚举是异步的：应用启动初期
    // findAllProviders() 可能返回空数组（不报错）。失败不能永久短路：
    // - 注册正在进行 → 共享同一个 Promise 等待完成；
    // - 上次尝试刚失败 → 冷却期内快速放弃，冷却结束后重试。
    const now = Date.now();
    if (_registeringPromise) {
        try { await _registeringPromise; } catch (_) { /* fallthrough */ }
        return registeredEps.size > 0;
    }
    if (registrationAttempted && now - _lastAttemptAt < RETRY_COOLDOWN_MS) {
        if (!_cooldownLogged) {
            _cooldownLogged = true;
            console.log('[WinML] EP registration cooling down; models in this batch will use DML/CPU');
        }
        return registeredEps.size > 0;
    }
    registrationAttempted = true;
    _lastAttemptAt = now;
    console.log(`[WinML][register] requested=${missing.join(',')} source=${snapshotEps ? 'worker-snapshot' : 'catalog'}`);

    _registeringPromise = (async () => {
        try {
            const s = _getSettings();
            await winmlCatalog.ensureCatalog(s.winmlBootstrapDllPath);
            const entries = await winmlCatalog.listAllProviderEntries();
            for (const name of missing) {
                if (registeredEps.has(name)) continue;
                // 与 getReadyEpLibraries 相同：枚举所有实例（含 filesystem hint），
                // 只探到第一个可加载的候选为止（旧 ABI 的 1.8 包不再白探）。
                const group = entries.filter((e) => e.name === name);
                const candidates = [];
                for (const entry of group) {
                    try {
                        let libraryPath = null;
                        if (entry.inst) {
                            const r = await winmlCatalog.ensureEntryReady(entry);
                            if (!r.ok || !r.libraryPath) continue;
                            libraryPath = r.libraryPath;
                        } else if (entry.libraryPathHint) {
                            libraryPath = entry.libraryPathHint;
                        } else continue;
                        candidates.push({ name, libraryPath });
                    } catch (_) { /* try next */ }
                }
                if (!candidates.length) {
                    console.warn(`[WinML] no ready candidate for ${name}`);
                    continue;
                }
                const best = await _pickLoadableCandidate(name, candidates);
                if (!best) {
                    console.warn(`[WinML] no loadable candidate for ${name} (candidates=${candidates.length})`);
                    continue;
                }
                try {
                    ortBridge.registerEp(best.name, best.libraryPath);
                    registeredEps.add(best.name);
                    console.log(`[WinML][register] ep=${best.name} dll=${best.libraryPath.split('\\').pop()} version=${_msixVersionOf(best.libraryPath)} status=ok`);
                } catch (e) {
                    const m = (e.message || '').toLowerCase();
                    if (m.includes('already registered')) {
                        console.log(`[WinML] ${name} already registered, treating as OK`);
                        registeredEps.add(best.name);
                    } else {
                        console.warn(`[WinML] registerEp(${name}) failed: ${(e.message || '').split('\n')[0].slice(0, 140)}`);
                        // Try next candidate if best failed to register (e.g. transient 1114)
                        for (const alt of candidates.slice(1)) {
                            try {
                                ortBridge.registerEp(alt.name, alt.libraryPath);
                                registeredEps.add(alt.name);
                                console.log(`[WinML] registered ${alt.name} via fallback <- ${alt.libraryPath.split('\\').pop()}`);
                                break;
                            } catch (ee) {
                                if (String(ee.message || '').toLowerCase().includes('already registered')) {
                                    registeredEps.add(alt.name);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // 关键：catalog/bootstrap 抛错必须落日志。此前这里向上抛会被
            // modelLoader 的外层静默 catch 吞掉，表现为"无任何 [WinML] 日志"。
            console.warn(`[WinML] EP bootstrap/catalog failed: ${(e.stack || e.message).split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);
        }
    })();

    await _registeringPromise;
    _registeringPromise = null;
    return registeredEps.size > 0;
}

// R24: 拆成两个标志 —— 一个标志同时抑制"gate 关闭/无可用 EP"和"注册冷却中"
// 两条完全不同的日志，先命中的那条会把另一条永久吞掉。
let _emptyReasonLogged = false;
let _cooldownLogged = false;

/**
 * Ordered WinML EP candidates for this model kind.
 * @param {boolean} useStaticShapes
 * @param {boolean} [allowOpenVINO] - 允许非 NV 的 WinML EP（仅 diffstep/vocoder）
 * @param {{excludeTrtRtx?: boolean}} [options] - excludeTrtRtx: 该模型不尝试
 *   NvTensorRTRTX（白名单内但按项目决定固定交给 DML 的模型，如 preflow）。
 *   只剔除 TRT-RTX，用户手动指定的其它 WinML EP 与 OpenVINO 分支保持原样。
 * @returns {Promise<Array<{epName:string, indices:number[]}>>}
 */
async function getWinmlCandidates(useStaticShapes, allowOpenVINO = false, options = {}) {
    const excludeTrtRtx = options && options.excludeTrtRtx === true;
    if (!isWinmlEnabled()) {
        if (!_emptyReasonLogged) {
            _emptyReasonLogged = true;
            console.log(`[WinML] gate closed (winmlEnabled=false or platform unsupported); platform=${process.platform}/${process.arch}, snapshot=${JSON.stringify(globalThis.__SXS_SETTINGS_SNAPSHOT__ || null)}`);
        }
        return [];
    }
    // 智能模式(未手动指定 EP)：自动优先 NV(TRT-RTX GPU)；手动指定则尊重用户、置于最先尝试。
    // winmlPreferredDevice 是设置页里"同一 EP 的不同硬件分开选"的结果
    // （如 OpenVINO 的 gpu / cpu / npu）：只对用户手动选中的那个 EP 生效，
    // 把候选钉在该 deviceType 上；为空表示沿用该 EP 暴露的全部设备。
    const snapSettings = globalThis.__SXS_SETTINGS_SNAPSHOT__ || {};
    const selectedEp = String(snapSettings.winmlPreferredEp || '').trim();
    const selectedDevice = _normalizeDeviceType(snapSettings.winmlPreferredDevice);
    const npuAvailable = globalThis.__SXS_NPU_AVAILABLE__ === true;
    const openvinoNpuSafe = globalThis.__SXS_OPENVINO_NPU_SAFE__ === true;
    const npuUsable = npuAvailable && openvinoNpuSafe;
    const preferred = [selectedEp, 'NvTensorRTRTXExecutionProvider', 'OpenVINOExecutionProvider']
        .filter((name, index, all) => name && all.indexOf(name) === index);
    if (useStaticShapes) {
        preferred.push('OpenVINOExecutionProvider.AUTO');
    }
    const ok = await ensureEpsRegistered(preferred);
    if (!ok) {
        if (!_emptyReasonLogged) {
            _emptyReasonLogged = true;
            console.log('[WinML] EP registration produced no usable providers');
        }
        return [];
    }

    const devices = ortBridge.listDevices();
    const indexTypeOf = (idx) => {
        const d = devices.find((x) => x.index === idx);
        return d ? (d.deviceType || '?') : '?';
    };
    const fmtCandidate = (c) => `${c.epName}@${c.indices.map((i) => `${i}:${indexTypeOf(i)}`).join(',')}`;
    const byName = (name, deviceType) => devices
        .filter((d) => d.epName === name && (!deviceType || d.deviceType === deviceType))
        .map((d) => d.index);
    const byNameAny = (name) => devices.filter((d) => d.epName === name).map((d) => d.index);

    const chain = [];
    const pushIfMissing = (c) => { if (!chain.some((x) => x.epName === c.epName)) chain.push(c); };
    const isTrtName = (name) => String(name || '').includes('NvTensorRTRTX');
    const isNpuIndex = (i) => {
        const d = devices.find((x) => x.index === i);
        return !!d && d.deviceType === 'npu';
    };
    // 所有交给会话的索引都要过这一层：无论是自动链还是用户手动指定的 EP，
    // 只要 NPU 安全门没开就不能带 NPU 设备（否则 OpenVINO NPU compiler 崩）。
    const dropNpu = (indices) => (npuUsable ? indices : indices.filter((i) => !isNpuIndex(i)));
    // 1) 用户手动指定的 EP 最先尝试（尊重选择）
    if (selectedEp) {
        if (excludeTrtRtx && isTrtName(selectedEp)) {
            console.log(`[WinML][select] model=excluded-trt selectedEp=${selectedEp} skipped reason=trt-rtx-excluded`);
        } else if (selectedDevice === 'npu' && !npuUsable) {
            // NPU 被安全门挡着：不能按"用户选了就用"处理，否则 OpenVINO 的
            // NPU compiler 会在版本错配时空指针崩溃（见下面的 gate 说明）。
            console.warn(`[WinML][select] selectedEp=${selectedEp} device=npu ignored reason=npu-gated (npuAvailable=${npuAvailable} openvinoNpuSafe=${openvinoNpuSafe})`);
        } else {
            const selIndices = dropNpu(selectedDevice ? byName(selectedEp, selectedDevice) : byNameAny(selectedEp));
            if (selIndices.length) {
                chain.push({ epName: selectedEp, indices: selIndices });
            } else if (selectedDevice) {
                // 选中的硬件在本次探测里消失了（换卡/驱动回退）：如实记录，
                // 后续仍按自动顺序尝试该 EP 的其它设备，避免用户凭空掉到 DML。
                console.warn(`[WinML][select] selectedEp=${selectedEp} device=${selectedDevice} not found; falling back to all devices of that EP`);
                const all = dropNpu(byNameAny(selectedEp));
                if (all.length) chain.push({ epName: selectedEp, indices: all });
            }
        }
    }
    // 2) NV(TRT-RTX GPU) 始终最高优先 —— 智能模式默认选择，NV > ALL OTHER EP
    const trt = excludeTrtRtx ? [] : byName('NvTensorRTRTXExecutionProvider', 'gpu');
    if (trt.length) pushIfMissing({ epName: 'NvTensorRTRTXExecutionProvider', indices: trt });
    // 3) 其他 WinML EP(OpenVINO 等)：仅当被允许(diffstep/vocoder)或用户显式指定才纳入
    const openvinoAllowed = allowOpenVINO || selectedEp === 'OpenVINOExecutionProvider';
    // Gate the OpenVINO NPU device on app-confirmed NPU availability. If an Intel NPU
    // driver is installed (with its openvino_intel_npu_compiler.dll) but NPU hardware is
    // not usable, letting ORT create an OpenVINO NPU session makes that compiler dereference
    // a null pointer (access violation reading 0x20) and hard-crash the process. The
    // __SXS_NPU_AVAILABLE__ flag is written by main after detectAllHardware(); when unset we
    // treat the NPU as unavailable (conservative).
    // OpenVINO NPU 设备仅在 NPU 硬件确认可用 且 OpenVINO NPU 推理被显式放行
    // （__SXS_OPENVINO_NPU_SAFE__）时才暴露。即使 PnP 检测到 NPU 硬件，EP 包
    // openvino 运行时与驱动 NPU compiler 版本错配时创建 NPU 会话仍会让编译器
    // 空指针崩溃（minidump: openvino_intel_npu_compiler.dll 0xC0000005 读 0x0），
    // 因此默认保守关闭，由 main 在版本匹配验证通过后放开。
    if (openvinoAllowed) {
        const ovAny = dropNpu(byNameAny('OpenVINOExecutionProvider'));
        if (ovAny.length) pushIfMissing({ epName: 'OpenVINOExecutionProvider', indices: ovAny });
        else {
            const ovGpu = byName('OpenVINOExecutionProvider', 'gpu');
            if (ovGpu.length) pushIfMissing({ epName: 'OpenVINOExecutionProvider(gpu)', indices: ovGpu });
        }
        if (useStaticShapes && npuUsable) {
            const npu = byName('OpenVINOExecutionProvider', 'npu');
            if (npu.length && !chain.some((c) => c.indices.includes(npu[0]))) pushIfMissing({ epName: 'OpenVINOExecutionProvider(npu)', indices: npu });
            const auto = devices.filter((d) => d.epName.endsWith('.AUTO')).map((d) => d.index);
            if (auto.length) pushIfMissing({ epName: 'OpenVINO.AUTO', indices: auto });
        }
    }
    // Log the resolved chain with per-index hardware so a single EP that spans
    // multiple hardware (e.g. OpenVINO NPU/CPU/GPU) is unambiguous in the console.
    console.log(`[WinML][select] shape=${useStaticShapes ? 'static' : 'dynamic'}${excludeTrtRtx ? ' trt-rtx=excluded' : ''} chain=${chain.map(fmtCandidate).join('>') || 'none'} devices=${devices.map((d) => `${d.index}:${d.epName}/${d.deviceType || '?'}`).join(',') || 'none'}`);
    // Explain single-EP multi-hardware grouping: all indices of that EP ride in
    // one session, and ORT/WinML picks the actual device internally at creation.
    for (const c of chain) {
        const types = [...new Set(c.indices.map(indexTypeOf).filter((t) => t !== '?'))];
        if (types.length > 1) {
            console.log(`[WinML][select] ${c.epName} spans ${types.length} hardware (${types.join('/')}); passing all ${c.indices.length} device indices to one session — device is chosen by ORT/WinML at session creation`);
        }
    }
    return chain;
}

/**
 * Try creating a WinML-backed session walking the candidate chain.
 * @param {string} modelPath
 * @param {boolean} useStaticShapes
 * @param {boolean} [allowOpenVINO]
 * @param {{excludeTrtRtx?: boolean}} [options] - 见 getWinmlCandidates
 * @returns {Promise<{session:object, ep:string}|null>}
 */
async function tryCreateWinMLSession(modelPath, useStaticShapes, allowOpenVINO = false, options = {}) {
    const modelName = path.basename(modelPath);
    // Do not rebuild an engine that already proved unusable at runtime.
    if (isRuntimeBlocked(modelPath)) {
        console.log(`[WinML][session] model=${modelName} status=skipped reason=runtime-failure-blocklist`);
        return null;
    }
    const candidates = await getWinmlCandidates(useStaticShapes, allowOpenVINO, options);
    if (!candidates.length) {
        if (options && options.excludeTrtRtx === true) {
            console.log(`[WinML][session] model=${modelName} status=skipped reason=trt-rtx-excluded (no remaining candidate)`);
        }
        return null;
    }
    for (const cand of candidates) {
        try {
            const session = await ortBridge.createSessionWithEps(modelPath, cand.indices, cand.epName);
            console.log(`[WinML][session] model=${modelName} ep=${cand.epName} devices=${cand.indices.join(',')} status=created`);
            return { session, ep: `winml:${cand.epName}` };
        } catch (e) {
            const reason = (e.message || '').split('\n')[0].slice(0, 90);
            console.warn(`[WinML][session] model=${modelName} ep=${cand.epName} devices=${cand.indices.join(',')} status=failed error=${reason}`);
        }
    }
    return null;
}

/**
 * Clear TensorRT-RTX engine cache files.
 *
 * TRT caches compiled engines to disk. When the ONNX model or provider options
 * change (e.g. profile shapes), stale cached engines can be reused, producing
 * incorrect results or enqueue failures. This function scans common cache
 * locations and removes TRT-related cache files.
 *
 * @returns {number} count of removed files
 */
function clearTRTEngineCache() {
    const os = require('node:os');
    let removed = 0;
    // TRT-RTX EP stores cache in subdirectories of these roots:
    //  - %LOCALAPPDATA% (most common on Windows)
    //  - %USERPROFILE%\.cache
    //  - Model directory itself (next to .onnx files)
    const roots = [];
    if (process.env.LOCALAPPDATA) roots.push(process.env.LOCALAPPDATA);
    if (process.env.APPDATA) roots.push(process.env.APPDATA);
    roots.push(path.join(os.homedir(), '.cache'));
    roots.push(path.join(os.tmpdir()));

    for (const root of roots) {
        let entries;
        try { entries = fs.readdirSync(root); } catch (_) { continue; }
        for (const entry of entries) {
            const lower = entry.toLowerCase();
            // TRT cache dirs typically contain "tensorrt", "trt", "onnxruntime" in their name
            const isTrtCache = lower.includes('tensorrt') || lower.includes('trt_cache') ||
                (lower.includes('onnxruntime') && lower.includes('trt'));
            if (!isTrtCache) continue;
            const fullPath = path.join(root, entry);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                    removed++;
                    console.log(`[WinML][TRT-cache] removed dir: ${fullPath}`);
                } else {
                    fs.unlinkSync(fullPath);
                    removed++;
                    console.log(`[WinML][TRT-cache] removed file: ${fullPath}`);
                }
            } catch (_) { /* permission or in-use */ }
        }
    }
    if (removed > 0) {
        console.log(`[WinML][TRT-cache] cleared ${removed} cache entr${removed === 1 ? 'y' : 'ies'}`);
    }
    return removed;
}

/**
 * 重置全部进程级 EP 状态。
 *
 * 后端在 DML 与 Windows ML 之间切换时必须调用：否则主进程里缓存的空 EP
 * 列表、运行期失败 pin（_runtimeBlockedModels）、已注册集合与冷却计时都会
 * 残留，导致切回 Windows ML 后仍全部回退 DML。测试也用同一个入口复位。
 */
function resetEpState() {
    registeredEps.clear();
    _runtimeBlockedModels.clear();
    registrationAttempted = false;
    _lastAttemptAt = 0;
    _emptyReasonLogged = false;
    _cooldownLogged = false;
    _registeringPromise = null;
    _readyEpLibrariesPromise = null;
    _readyEpLibrariesCache = null;
    _readyEpLibrariesCacheKey = null;
    // EP 包可能在运行期被更新（应用内升级 / MSIX 刷新），下次解析重新读版本。
    _trtRuntimeFingerprintPromise = null;
}

module.exports = {
    isWinmlEnabled,
    ensureEpsRegistered,
    getReadyEpLibraries,
    listProviderDevices,
    getWinmlCandidates,
    tryCreateWinMLSession,
    reportRuntimeFailure,
    isRuntimeBlocked,
    getTrtRuntimeFingerprint,
    clearTRTEngineCache,
    resetEpState,
    listCompatibleProviders: (...a) => winmlCatalog.listCompatibleProviders(...a),
    // 兼容既有测试与诊断脚本使用的旧名称。
    __resetForTest: resetEpState,
    __test: { _normalizeDeviceType, _pickLoadableCandidate, _libLabel },
};
