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
 * All failures degrade to null so callers fall back to the existing chains.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ortBridge = require('./ortBridge');
const winmlCatalog = require('./winmlCatalog');

const registeredEps = new Set();
let registrationAttempted = false;
let _lastAttemptAt = 0;
const RETRY_COOLDOWN_MS = 15000;
let _registeringPromise = null;
let _readyEpLibrariesPromise = null;
let _readyEpLibrariesCache = null;

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

/** User opt-in gate (experimental feature). */
function isWinmlEnabled() {
    if (!winmlCatalog.isPlatformSupported()) return false;
    const s = _getSettings();
    return s.winmlEnabled === true;
}

/**
 * 主进程专用：确保兼容 EP 就绪（必要时触发 MSIX 下载），
 * 返回可直接 registerEp 的 {name, libraryPath} 列表。
 * 在 worker_threads 里不可用（dynwinrt/COM 依赖主进程环境）——
 * worker 应改用 __SXS_WINML_EPS__ 快照。
 */
async function _resolveReadyEpLibraries() {
    if (!isWinmlEnabled()) {
        console.log('[WinML] getReadyEpLibraries: gate closed');
        return [];
    }
    const s = _getSettings();
    await winmlCatalog.ensureCatalog(s.winmlBootstrapDllPath);
    const entries = await winmlCatalog.listAllProviderEntries();
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

    const out = [];
    for (const [name, group] of byName) {
        // Probe highest MSIX version first so the 2.x hint is tried before stale 1.8 (saves a failed canLoad)
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
                const dirName = libraryPath.split('\\').slice(-3, -1).join('/') || libraryPath.split('\\').pop();
                // Verify the DLL can actually be loaded in this process (check 1114 etc.)
                // This filters out ABI-mismatched old packages like TRT 1.8 on ORT 1.27
                try {
                    await ortBridge.ensureBridgeInit();
                    if (!ortBridge.canLoadLibrary(libraryPath)) {
                        console.warn(`[WinML] warmup ${name}: DLL not loadable, skipping ${dirName}/${libraryPath.split('\\').pop()}`);
                        continue;
                    }
                } catch (_) { /* ignore, assume loadable */ }
                console.log(`[WinML] warmup ${name}: candidate ${dirName}/${libraryPath.split('\\').pop()} OK`);
                candidates.push({ name, libraryPath });
            } catch (e) {
                console.warn(`[WinML] warmup ${name} threw: ${(e.message || '').split('\n')[0].slice(0, 120)}`);
            }
        }
        if (!candidates.length) {
            console.warn(`[WinML] no ready candidate for ${name}`);
            continue;
        }
        candidates.sort((a, b) => _compareMsixVersion(_msixVersionOf(b.libraryPath), _msixVersionOf(a.libraryPath)));
        const best = candidates[0];
        if (candidates.length > 1) {
            console.log(`[WinML] ${name}: ${candidates.length} loadable candidates, picking highest ${best.libraryPath.split('\\').pop()} (skipped: ${candidates.slice(1).map(c => c.libraryPath.split('\\').pop()).join(', ')})`);
        }
        out.push(best);
    }
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
    if (_readyEpLibrariesCache) return _readyEpLibrariesCache.map(e => ({ ...e }));
    if (_readyEpLibrariesPromise) {
        console.log('[WinML][ready] join=in-flight');
        return _readyEpLibrariesPromise;
    }
    const started = Date.now();
    console.log('[WinML][ready] start');
    _readyEpLibrariesPromise = _resolveReadyEpLibraries()
        .then((eps) => {
            _readyEpLibrariesCache = eps.map(e => ({ ...e }));
            console.log(`[WinML][ready] done ms=${Date.now() - started} eps=${eps.map(e => e.name).join(',') || 'none'}`);
            return _readyEpLibrariesCache.map(e => ({ ...e }));
        })
        .finally(() => { _readyEpLibrariesPromise = null; });
    return _readyEpLibrariesPromise;
}

/** 从 MSIX libraryPath 提取数字版本串用于比较（如 ...EP.2_2.30.49.0_x64 -> 2.30.49.0）。 */
function _msixVersionOf(libraryPath) {
    const m = /EP\.(\d+)_(\d+\.\d+\.\d+\.\d+)_/i.exec(libraryPath || '');
    return m ? m[1] + '.' + m[2] : '0';
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
            // Also handle vendor qualified names like OpenVINOExecutionProvider.AUTO
            const base = String(d.epName).split('.')[0];
            if (base && !registeredEps.has(base) && (base === 'OpenVINOExecutionProvider' || base === 'NvTensorRTRTXExecutionProvider')) {
                // Do not auto-add base for AUTO variants, but devices list will contain base already when EP registered
            }
        }
    } catch (_) {}
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
        for (const ep of snapshotEps) {
            if (registeredEps.has(ep.name)) continue;
            let registered = false;
            const catalogHints = await _getCatalogFallbackPaths(ep.name);
            const fsHints = _findAlternativeWinMLPaths(ep.name);
            const merged = [ep.libraryPath];
            for (const p of [...catalogHints, ...fsHints]) if (p !== ep.libraryPath && !merged.includes(p)) merged.push(p);
            // Sort fallbacks by MSIX version descending so 2.x is tried before 1.8 even when snapshot was stale
            const fallbacks = merged.slice(1).sort((a, b) => _compareMsixVersion(_msixVersionOf(b), _msixVersionOf(a)));
            const candidates = [merged[0], ...fallbacks];
            for (const libPath of candidates) {
                try {
                    ortBridge.registerEp(ep.name, libPath);
                    registeredEps.add(ep.name);
                    if (libPath !== ep.libraryPath) {
                        console.log(`[WinML] worker registered ${ep.name} via fallback ${libPath.split('\\').pop()}`);
                    } else {
                        console.log(`[WinML] worker registered ${ep.name}`);
                    }
                    registered = true;
                    break;
                } catch (e) {
                    const msg = (e.message || '').split('\n')[0].slice(0, 300);
                    if (msg.toLowerCase().includes('already registered')) {
                        console.log(`[WinML] worker ${ep.name} already registered (gle=126), treating as OK`);
                        registeredEps.add(ep.name);
                        registered = true;
                        break;
                    }
                    console.warn(`[WinML] worker registerEp(${ep.name} <- ${libPath.split('\\').pop()}) failed: ${msg}`);
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
        if (!_emptyReasonLogged) {
            _emptyReasonLogged = true;
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
                // canLoadLibrary 过滤 1.8 旧 ABI，再择最高版本。
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
                        await ortBridge.ensureBridgeInit();
                        if (!ortBridge.canLoadLibrary(libraryPath)) {
                            console.warn(`[WinML] register warmup ${name}: DLL not loadable, skipping ${libraryPath.split('\\').pop()}`);
                            continue;
                        }
                        candidates.push({ name, libraryPath });
                    } catch (_) { /* try next */ }
                }
                if (!candidates.length) {
                    console.warn(`[WinML] no ready candidate for ${name}`);
                    continue;
                }
                candidates.sort((a, b) => _compareMsixVersion(_msixVersionOf(b.libraryPath), _msixVersionOf(a.libraryPath)));
                const best = candidates[0];
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

/**
 * Ordered WinML EP candidates for this model kind.
 * @returns {Promise<Array<{epName:string, indices:number[]}>>}
 */
let _emptyReasonLogged = false;
async function getWinmlCandidates(useStaticShapes) {
    if (!isWinmlEnabled()) {
        if (!_emptyReasonLogged) {
            _emptyReasonLogged = true;
            console.log(`[WinML] gate closed (enabled=false or platform unsupported); platform=${process.platform}/${process.arch}, snapshot=${JSON.stringify(globalThis.__SXS_SETTINGS_SNAPSHOT__ || null)}`);
        }
        return [];
    }
    // Main models target GPU EPs: NvTensorRTRTX 2.x (ORT 1.27 ABI) is
    // preferred when loadable (canLoadLibrary gates 1.8); OpenVINO is fallback.
    const preferred = [
        'NvTensorRTRTXExecutionProvider',
        'OpenVINOExecutionProvider',
    ];
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
    const byName = (name, deviceType) => devices
        .filter((d) => d.epName === name && (!deviceType || d.deviceType === deviceType))
        .map((d) => d.index);
    const byNameAny = (name) => devices.filter((d) => d.epName === name).map((d) => d.index);

    const chain = [];
    // GPU priority: NvTensorRTRTX 2.x first (when registered), OpenVINO fallback.
    const trt = byName('NvTensorRTRTXExecutionProvider', 'gpu');
    if (trt.length) chain.push({ epName: 'NvTensorRTRTXExecutionProvider', indices: trt });
    const ovAny = byNameAny('OpenVINOExecutionProvider');
    if (ovAny.length) chain.push({ epName: 'OpenVINOExecutionProvider', indices: ovAny });
    else {
        const ovGpu = byName('OpenVINOExecutionProvider', 'gpu');
        if (ovGpu.length) chain.push({ epName: 'OpenVINOExecutionProvider(gpu)', indices: ovGpu });
    }
    if (useStaticShapes) {
        const npu = byName('OpenVINOExecutionProvider', 'npu');
        if (npu.length && !chain.some(c => c.indices.includes(npu[0]))) chain.push({ epName: 'OpenVINOExecutionProvider(npu)', indices: npu });
        const auto = devices.filter((d) => d.epName.endsWith('.AUTO')).map((d) => d.index);
        if (auto.length) chain.push({ epName: 'OpenVINO.AUTO', indices: auto });
    }
    console.log(`[WinML][select] shape=${useStaticShapes ? 'static' : 'dynamic'} chain=${chain.map(c => `${c.epName}@${c.indices.join(',')}`).join('>') || 'none'} devices=${devices.map(d => `${d.index}:${d.epName}/${d.deviceType}`).join(',') || 'none'}`);
    return chain;
}

/**
 * Try creating a WinML-backed session walking the candidate chain.
 * @returns {Promise<{session:object, ep:string}|null>}
 */
async function tryCreateWinMLSession(modelPath, useStaticShapes) {
    const candidates = await getWinmlCandidates(useStaticShapes);
    if (!candidates.length) return null;
    const modelName = path.basename(modelPath);
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
    const crypto = require('node:crypto');
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

/** Test/diagnostic reset. */
function __resetForTest() {
    registeredEps.clear();
    registrationAttempted = false;
    _lastAttemptAt = 0;
    _emptyReasonLogged = false;
    _readyEpLibrariesPromise = null;
    _readyEpLibrariesCache = null;
}

module.exports = {
    isWinmlEnabled,
    ensureEpsRegistered,
    getReadyEpLibraries,
    getWinmlCandidates,
    tryCreateWinMLSession,
    clearTRTEngineCache,
    listCompatibleProviders: (...a) => winmlCatalog.listCompatibleProviders(...a),
    __resetForTest,
};
