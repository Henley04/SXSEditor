/**
 * winmlCatalog.js — Windows ML execution-provider discovery & acquisition.
 *
 * Uses @microsoft/dynwinrt + generated WinRT bindings to talk to
 * Microsoft.Windows.AI.MachineLearning.ExecutionProviderCatalog:
 *   - lists vendor EPs compatible with the current hardware
 *     (QNN / OpenVINO / MIGraphX / VitisAI / NvTensorRtRtx ...)
 *   - downloads their MSIX packages on demand (EnsureReadyAsync)
 *   - returns plugin library paths that ortBridge.registerEp() then loads
 *     into OUR OrtEnv (no dependency on WinML's own runtime env).
 *
 * Everything here fails soft: callers must treat any throw/[] as "feature
 * unavailable" and fall back to the DirectML/CPU chain.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIN_BUILD = 26100; // Windows 11 24H2 — downloadable EPs requirement

let _bootstrapDllPath = null;
const _entryReadyPromises = new WeakMap();
let _catalog = null;
let _catalogPromise = null;

function isWindows() {
    return process.platform === 'win32';
}

function isSupportedArch() {
    return process.arch === 'x64' || process.arch === 'arm64';
}

function getOsBuildNumber() {
    try {
        const v = require('node:os');
        // os.build exists on win32 in modern Node; fall back to release parsing.
        if (typeof v.build === 'number') return v.build;
        const release = v.release && v.release();
        if (release) {
            const m = String(release).match(/(\d+)$/);
            if (m) return parseInt(m[1], 10);
        }
    } catch (_) { /* ignore */ }
    return 0;
}

/** Feature gate: platform, arch and OS build checks only (no side effects). */
function isPlatformSupported() {
    return isWindows() && isSupportedArch() && getOsBuildNumber() >= MIN_BUILD;
}

/**
 * Locate a Microsoft.WindowsAppRuntime.Bootstrap.dll. Order:
 *   1. WINAPPSDK_BOOTSTRAP_DLL_PATH env var
 *   2. Known redistributable install locations on user machines
 * A copy can also be shipped with the app via settings override later.
 */
function locateBootstrapDll(explicitPath) {
    if (_bootstrapDllPath && fs.existsSync(_bootstrapDllPath)) return _bootstrapDllPath;
    const candidates = [];
    if (explicitPath) candidates.push(explicitPath);
    if (process.env.WINAPPSDK_BOOTSTRAP_DLL_PATH) candidates.push(process.env.WINAPPSDK_BOOTSTRAP_DLL_PATH);

    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const knownDirs = [
        path.join(pf86, 'Microsoft', 'Edge'),
        path.join(localAppData, 'PowerToys'),
        path.join(programFiles, 'Intel', 'Intel Graphics Software'),
        path.join(localAppData, 'Microsoft', 'WindowsApps'),
    ];
    for (const dir of knownDirs) {
        try {
            if (!dir || !fs.existsSync(dir)) continue;
            const hits = walkFind(dir, 'Microsoft.WindowsAppRuntime.Bootstrap.dll', 4);
            candidates.push(...hits);
            if (candidates.length >= 3) break;
        } catch (_) { /* permission errors are expected here */ }
    }
    for (const c of candidates) {
        try {
            if (c && fs.existsSync(c)) {
                _bootstrapDllPath = c;
                return c;
            }
        } catch (_) { /* ignore */ }
    }
    return null;
}

function walkFind(root, fileName, maxDepth) {
    const out = [];
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length && out.length < 3) {
        const { dir, depth } = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            continue;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
            } else if (e.name === fileName) {
                out.push(full);
                break;
            }
        }
    }
    return out;
}

/**
 * Initialize dynwinrt + bootstrap and acquire the default catalog.
 * @returns {Promise<object|null>} catalog or null when unavailable.
 */
async function ensureCatalog(settingsOverrideBootstrapPath) {
    if (!isPlatformSupported()) return null;
    if (_catalog) return _catalog;
    if (_catalogPromise) return _catalogPromise;
    _catalogPromise = (async () => {
        const bootstrap = locateBootstrapDll(settingsOverrideBootstrapPath);
        if (!bootstrap) {
            console.warn('[WinML] Windows App SDK bootstrap DLL not found; provider catalog disabled');
            return null;
        }
        const dyn = require('@microsoft/dynwinrt');
        process.env.WINAPPSDK_BOOTSTRAP_DLL_PATH = bootstrap;
        try {
            dyn.roInitialize(1); // MTA; no-op if apartment already initialized
        } catch (_) { /* already initialized */ }
        let ok = false;
        for (const [major, minor] of [[2, 5], [2, 4], [2, 3], [2, 2], [2, 1]]) {
            try {
                dyn.initWinappsdk(major, minor);
                ok = true;
                break;
            } catch (_) { /* try older framework family */ }
        }
        if (!ok) {
            console.warn('[WinML] Windows App SDK bootstrap failed; provider catalog disabled');
            return null;
        }
        // 静态逐文件引入：winrt-bindings/index.js 的 __exportLazy 使用运行时
        // require(path)（动态表达式），webpack 打包后上下文解析失败报
        // "Cannot find module './ExecutionProviderCatalog.js'"。
        // 只静态引入本模块实际用到的符号。
        const { ExecutionProviderCatalog } = require('./winrt-bindings/ExecutionProviderCatalog.js');
        const catalog = ExecutionProviderCatalog.getDefault();
        if (!catalog) {
            console.warn('[WinML] ExecutionProviderCatalog unavailable');
            return null;
        }
        _catalog = catalog;
        return catalog;
    })();
    return _catalogPromise;
}

/**
 * List EPs compatible with this hardware (raw wrapper instances included).
 * @returns {Promise<Array<{name:string, readyState:number, inst:object}>>}
 */
async function listCompatibleProviderEntries() {
    const catalog = await ensureCatalog();
    if (!catalog) return [];
    try {
        return catalog.findAllProviders().map((p) => ({
            name: p.name,
            readyState: Number(p.readyState),
            inst: p,
        }));
    } catch (e) {
        console.warn('[WinML] findAllProviders failed:', e.message);
        return [];
    }
}

/**
 * List ALL EPs known to the catalog regardless of current compatibility filter.
 * On current Windows ML builds findAllProviders already returns the full set,
 * but we keep a separate entry point so callers can explicitly scan for
 * alternative MSIX versions (e.g. EP.2 when only EP.1 is marked compatible).
 * Also merges filesystem-discovered packages that the catalog hasn't yet indexed
 * (e.g. freshly downloaded 2.x MSIX not yet reflected in the snapshot).
 * @returns {Promise<Array<{name:string, readyState:number, inst:object, libraryPathHint:string|null}>>}
 */
let _listAllLogged = false;
async function listAllProviderEntries() {
    const base = await listCompatibleProviderEntries();
    // Merge filesystem scan for NvTensor 2.x that may not yet appear in catalog
    // (no elevation required to read libraryPathHint; caller validates via ensureEntryReady/canLoadLibrary)
    const extra = _scanFilesystemHints();
    if (extra.length && !_listAllLogged) { console.log(`[WinML] listAll: catalog=${base.length} + fsHints=${extra.length}`); _listAllLogged = true; }
    for (const h of extra) {
        // Only add if not already represented by a catalog instance with same path
        const exists = base.some((e) => h.libraryPathHint && e.inst && String(e.inst.libraryPath || '').toLowerCase() === h.libraryPathHint.toLowerCase());
        if (!exists) base.push({ name: h.name, readyState: 0, inst: null, libraryPathHint: h.libraryPathHint });
    }
    return base;
}

let _fsHintsCache = null;
let _fsHintsCacheLogged = false;
function _scanFilesystemHints() {
    if (_fsHintsCache) return _fsHintsCache;
    const out = [];
    const patterns = {
        'NvTensorRTRTXExecutionProvider': ['trt-rtx', 'nv_tensorrt', 'tensorrt_rtx', 'nvidia'],
        'OpenVINOExecutionProvider': ['openvino'],
        'QNNExecutionProvider': ['qnn'],
        'MIGraphXExecutionProvider': ['migraphx'],
        'VitisAIExecutionProvider': ['vitis'],
    };
    const winApps = 'C:\\Program Files\\WindowsApps';
    let dirs = null;
    try { dirs = fs.readdirSync(winApps); } catch (e) {
        if (!_fsHintsCacheLogged) console.warn(`[WinML] WindowsApps readdir failed (${e.code || e.message}); trying PowerShell fallback`);
        // Fallback: query AppX packages via PowerShell (works without direct FS ACL)
        try {
            const { execSync } = require('node:child_process');
            const ps = `powershell -NoProfile -Command "Get-AppxPackage -Name '*WinML*' | Select-Object -ExpandProperty InstallLocation"`;
            const raw = execSync(ps, { encoding: 'utf8', timeout: 8000, windowsHide: true });
            const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            for (const loc of lines) {
                const lower = loc.toLowerCase();
                for (const [epName, keywords] of Object.entries(patterns)) {
                    if (!keywords.some((k) => lower.includes(k))) continue;
                    const epDir = path.join(loc, 'ExecutionProvider');
                    let files;
                    try { files = fs.readdirSync(epDir); } catch { continue; }
                    for (const f of files) {
                        if (f.toLowerCase().endsWith('.dll') && f.toLowerCase().includes('onnxruntime_providers')) {
                            out.push({ name: epName, libraryPathHint: path.join(epDir, f) });
                        }
                    }
                }
            }
            if (out.length && !_fsHintsCacheLogged) console.log(`[WinML] filesystem hints via PowerShell: ${out.map(o => o.libraryPathHint.split('\\').slice(-3).join('/')).join(', ')}`);
            _fsHintsCache = out;
            _fsHintsCacheLogged = true;
            return out;
        } catch (pe) {
            console.warn(`[WinML] PowerShell fallback failed: ${pe.message?.slice(0,120)}`);
            _fsHintsCache = out;
            _fsHintsCacheLogged = true;
            return out;
        }
    }
    for (const dir of dirs) {
        const lower = dir.toLowerCase();
        if (!lower.includes('winml')) continue;
        for (const [epName, keywords] of Object.entries(patterns)) {
            if (!keywords.some((k) => lower.includes(k))) continue;
            const epDir = path.join(winApps, dir, 'ExecutionProvider');
            let files;
            try { files = fs.readdirSync(epDir); } catch { continue; }
            for (const f of files) {
                if (f.toLowerCase().endsWith('.dll') && f.toLowerCase().includes('onnxruntime_providers')) {
                    out.push({ name: epName, libraryPathHint: path.join(epDir, f) });
                }
            }
        }
    }
    if (out.length && !_fsHintsCacheLogged) console.log(`[WinML] filesystem hints: ${out.map(o => o.libraryPathHint.split('\\').slice(-3).join('/')).join(', ')}`);
    _fsHintsCache = out;
    _fsHintsCacheLogged = true;
    return out;
}

/**
 * List EPs compatible with this hardware.
 * @returns {Promise<Array<{name:string, readyState:number}>>}
 */
async function listCompatibleProviders() {
    const entries = await listCompatibleProviderEntries();
    return entries.map(({ name, readyState }) => ({ name, readyState }));
}

/** Ensure a specific provider wrapper instance is ready (downloads if needed). */
async function ensureEntryReady(entry, onProgress) {
    const inst = entry && entry.inst;
    if (!inst) return { ok: false, libraryPath: null };

    // Read the live WinRT property, not the stale snapshot captured by
    // listAllProviderEntries(). Another caller may have completed between
    // enumeration and this function.
    const liveState = Number(inst.readyState);
    if (liveState === 0 && inst.libraryPath) {
        return { ok: true, libraryPath: inst.libraryPath };
    }

    const inFlight = _entryReadyPromises.get(inst);
    if (inFlight) return inFlight;

    const promise = (async () => {
        // Final check immediately before EnsureReadyAsync. Calling it in Ready
        // state is a process-fatal contract violation in Chromium WebNN.
        if (Number(inst.readyState) === 0) {
            return inst.libraryPath
                ? { ok: true, libraryPath: inst.libraryPath }
                : { ok: false, libraryPath: null };
        }
        const op = inst.ensureReadyAsync();
        if (onProgress && op && typeof op.progress === 'function') {
            try {
                op.progress((v) => {
                    const frac = v <= 1 ? Number(v) : Number(v) / 100;
                    if (Number.isFinite(frac)) onProgress(Math.max(0, Math.min(1, frac)));
                });
            } catch (_) { /* progress unsupported */ }
        }
        await op;
        return inst.libraryPath
            ? { ok: true, libraryPath: inst.libraryPath }
            : { ok: false, libraryPath: null };
    })();
    _entryReadyPromises.set(inst, promise);
    try {
        return await promise;
    } finally {
        _entryReadyPromises.delete(inst);
    }
}

/**
 * Ensure a provider package is present (downloading if needed).
 * @param {string} providerName e.g. 'NvTensorRTRTXExecutionProvider'
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<{ok:boolean, libraryPath:string|null, diagnostic?:string}>}
 */
async function ensureProviderReady(providerName, onProgress) {
    const catalog = await ensureCatalog();
    if (!catalog) return { ok: false, libraryPath: null };
    let providers = [];
    try {
        providers = catalog.findAllProviders();
    } catch (e) {
        return { ok: false, libraryPath: null, diagnostic: e.message };
    }
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return { ok: false, libraryPath: null };

    try {
        if (provider.readyState === 0 && provider.libraryPath) return { ok: true, libraryPath: provider.libraryPath };
        const op = provider.ensureReadyAsync();
        if (onProgress && op && typeof op.progress === 'function') {
            try {
                op.progress((v) => {
                    const frac = v <= 1 ? Number(v) : Number(v) / 100;
                    if (Number.isFinite(frac)) onProgress(Math.max(0, Math.min(1, frac)));
                });
            } catch (_) { /* progress unsupported when nothing to download */ }
        }
        await op;
        const lib = provider.libraryPath;
        if (lib) return { ok: true, libraryPath: lib };
        return { ok: false, libraryPath: null };
    } catch (e) {
        return { ok: false, libraryPath: null, diagnostic: e.message };
    }
}

module.exports = {
    isPlatformSupported,
    locateBootstrapDll,
    ensureCatalog,
    listCompatibleProviders,
    listCompatibleProviderEntries,
    listAllProviderEntries,
    ensureEntryReady,
    ensureProviderReady,
};
