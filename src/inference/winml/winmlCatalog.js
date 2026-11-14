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
const { execFile } = require('node:child_process');
const detectionCache = require('./winmlDetectionCache');

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
    // 显式配置永远优先；命中后不再做目录遍历。
    for (const c of candidates) {
        try {
            if (c && fs.existsSync(c)) {
                _bootstrapDllPath = c;
                detectionCache.setCachedBootstrapPath(c);
                return c;
            }
        } catch (_) { /* ignore */ }
    }
    // 上一次启动找到的路径：文件还在就直接复用，跳过 Edge/WindowsApps 的深度遍历
    // （这是 EP 探测里最慢的一步，WindowsApps 权限受限时还要等 PowerShell 超时）。
    const cachedPath = detectionCache.getCachedBootstrapPath();
    if (cachedPath) {
        _bootstrapDllPath = cachedPath;
        return cachedPath;
    }

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
                detectionCache.setCachedBootstrapPath(c);
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
    // catalog 枚举（WinRT）与文件系统扫描（WindowsApps readdir / Get-AppxPackage）
    // 互不依赖：并发跑取较慢的那个，而不是相加。WindowsApps ACL 受限的机器上
    // Get-AppxPackage 约 0.8s，串行等于把它整段叠在探测链路上。
    // 文件系统扫描补的是 catalog 还没索引到的包（如刚下载的 2.x MSIX），
    // 读 libraryPathHint 不需要提权，真正可加载性由调用方的 canLoadLibrary 判定。
    const [base, extra] = await Promise.all([
        listCompatibleProviderEntries(),
        _scanFilesystemHints(),
    ]);
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
let _fsHintsPromise = null;

/**
 * 同步扫描 WindowsApps 目录下的 WinML EP 包。普通权限下 readdir 常因
 * WindowsApps ACL 返回 EPERM —— 此时返回 null（而非空数组），由调用方
 * 走 Get-AppxPackage 回填路径。
 */
/**
 * 该 DLL 是否是"可注册的 provider 本体"。
 *
 * `onnxruntime_providers_shared.dll` / `onnxruntime_providers_common.dll` 是
 * provider 共用的辅助库，和 provider 放在同一目录、同样匹配
 * `onnxruntime_providers*`：它们能被 LoadLibrary（所以能通过可加载性探测），
 * 但 registerEp 注册它不会带来任何 EP device。必须在这一层排掉。
 */
function _isProviderDll(fileName) {
    const f = String(fileName || '').toLowerCase();
    if (!f.endsWith('.dll')) return false;
    if (!f.includes('onnxruntime_providers')) return false;
    const base = f.slice(0, -4);
    if (base === 'onnxruntime_providers_shared' || base === 'onnxruntime_providers_common') return false;
    return true;
}

function _scanFilesystemHintsSync() {
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
    try { dirs = fs.readdirSync(winApps); } catch {
        return null;
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
                if (_isProviderDll(f)) {
                    out.push({ name: epName, libraryPathHint: path.join(epDir, f) });
                }
            }
        }
    }
    return out;
}

/** 包名 → EP 名映射（Get-AppxPackage Name 形如 ...WinML.NVIDIA.TRT-RTX.EP.2）。 */
function _epNameFromPackage(pkgName) {
    const n = String(pkgName || '').toLowerCase();
    if (n.includes('nvidia') && (n.includes('trt') || n.includes('tensorrt'))) return 'NvTensorRTRTXExecutionProvider';
    if (n.includes('openvino')) return 'OpenVINOExecutionProvider';
    if (n.includes('qnn')) return 'QNNExecutionProvider';
    if (n.includes('migraphx')) return 'MIGraphXExecutionProvider';
    if (n.includes('vitis')) return 'VitisAIExecutionProvider';
    return null;
}

/**
 * 通过 Get-AppxPackage 枚举已安装的 WinML EP 包并返回 provider DLL 路径。
 * 走 AppX 注册信息，无需读取 WindowsApps 目录（普通权限 readdir 会 EPERM）。
 */
function _scanFilesystemHintsViaAppx() {
    return new Promise((resolve) => {
        const ps = 'Get-AppxPackage -Name "MicrosoftCorporationII.WinML*" | ForEach-Object { $_.Name + "|" + $_.InstallLocation }';
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
            { timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
            (err, stdout) => {
                const out = [];
                if (err) { resolve(out); return; }
                for (const line of String(stdout || '').split(/\r?\n/)) {
                    const bar = line.indexOf('|');
                    if (bar <= 0) continue;
                    const pkg = line.slice(0, bar).trim();
                    const loc = line.slice(bar + 1).trim();
                    const epName = _epNameFromPackage(pkg);
                    if (!epName || !loc) continue;
                    const epDir = path.join(loc, 'ExecutionProvider');
                    let files;
                    try { files = fs.readdirSync(epDir); } catch { continue; }
                    for (const f of files) {
                        if (_isProviderDll(f)) {
                            out.push({ name: epName, libraryPathHint: path.join(epDir, f) });
                        }
                    }
                }
                resolve(out);
            });
    });
}

async function _scanFilesystemHints() {
    if (_fsHintsCache) return _fsHintsCache;
    // 快速路径：直接 readdir WindowsApps（普通权限下常 EPERM，返回 null 走回退）
    const direct = _scanFilesystemHintsSync();
    if (direct !== null) {
        _fsHintsCache = direct;
        if (direct.length && !_fsHintsCacheLogged) console.log(`[WinML] filesystem hints: ${direct.map((o) => o.libraryPathHint.split('\\').slice(-3).join('/')).join(', ')}`);
        _fsHintsCacheLogged = true;
        return direct;
    }
    if (_fsHintsPromise) return _fsHintsPromise;
    _fsHintsPromise = (async () => {
        const viaAppx = await _scanFilesystemHintsViaAppx();
        _fsHintsCache = viaAppx;
        if (viaAppx.length && !_fsHintsCacheLogged) {
            console.log(`[WinML] filesystem hints (appx): ${viaAppx.map((o) => o.libraryPathHint.split('\\').slice(-3).join('/')).join(', ')}`);
        } else if (!viaAppx.length && !_fsHintsCacheLogged) {
            console.warn('[WinML] WindowsApps readdir unavailable and Get-AppxPackage returned no WinML packages; optional hints skipped');
        }
        _fsHintsCacheLogged = true;
        return viaAppx;
    })();
    try { return await _fsHintsPromise; } finally { _fsHintsPromise = null; }
}

/**
 * EP display/selection priority for the settings device list. TRT-RTX is the
 * preferred GPU EP on this stack, so it must rank above OpenVINO. Providers not
 * listed here keep their catalog order and sink below the known ones.
 */
const EP_PRIORITY = [
    'NvTensorRTRTXExecutionProvider',
    'OpenVINOExecutionProvider',
    'QNNExecutionProvider',
    'MIGraphXExecutionProvider',
    'VitisAIExecutionProvider',
];

/**
 * 把 catalog 实例与文件系统扫描结果按 EP 名合并成一份名单。
 *
 * 同一台机器上同一个 EP 会以多条形式出现：catalog 一条、WindowsApps 里每个
 * MSIX 版本各一条（甚至同目录下多个 provider DLL 各一条）。设置页只关心
 * "这个 EP 能不能用"，不能把 1.8 / 2.x 两个包列成两个设备 —— 那会让用户
 * 以为有两个不同的 EP。合并规则：
 *   · 名字相同的全部收进一条；
 *   · readyState 取最"就绪"的那个（有已安装的包就算就绪）；
 *   · libraryPath 保留第一条非空的，仅用于展示/排查，真正的选库仍由
 *     winmlProvider 按 MSIX 版本 + 可加载性决定。
 * @param {Array<{name:string, readyState:number, inst?:object, libraryPathHint?:string}>} entries
 */
function _mergeProviderEntries(entries) {
    const byName = new Map();
    for (const e of entries || []) {
        const name = String((e && e.name) || '');
        if (!name) continue;
        const path = e.inst ? (e.inst.libraryPath || '') : (e.libraryPathHint || '');
        const readyState = Number(e.readyState) || 0;
        const prev = byName.get(name);
        if (!prev) {
            byName.set(name, {
                name,
                readyState,
                libraryPath: path || '',
                source: e.inst ? 'catalog' : 'filesystem',
            });
            continue;
        }
        if (!prev.libraryPath && path) prev.libraryPath = path;
        if (readyState < prev.readyState) prev.readyState = readyState;
        if (e.inst && prev.source !== 'catalog') prev.source = 'catalog';
    }
    return [...byName.values()];
}

/**
 * List EPs compatible with this hardware, ordered so that higher-priority EPs
 * (e.g. NvTensorRTRTX above OpenVINO) appear first in the device dropdown.
 *
 * 数据源是 catalog + 文件系统扫描的并集：某些机器上 ExecutionProviderCatalog
 * 起不来（initWinappsdk 失败），但 EP 包其实已经装好了 —— 只读 catalog 会让
 * 设置页显示"没有可用的 Windows ML 设备"，而管线侧照样在用这些 EP。
 * @param {{forceRefresh?:boolean}} [options]
 * @returns {Promise<Array<{name:string, readyState:number, libraryPath:string, source:string}>>}
 */
async function listCompatibleProviders(options = {}) {
    const cached = detectionCache.getCachedProviders();
    if (cached && options.forceRefresh !== true) {
        // 过期 / 后台有更新的 EP 包时先返回可用列表，避免设置页被 WinRT 初始化卡住；
        // 刷新在后台完成，下次打开或以 forceRefresh 调用时拿到新结果。
        if (!cached.fresh) {
            void _refreshCompatibleProviders().catch(() => {});
        }
        return cached.list;
    }
    return _refreshCompatibleProviders();
}

let _providersRefreshPromise = null;

function _sortProviders(list) {
    const rank = (name) => {
        const idx = EP_PRIORITY.indexOf(name);
        return idx === -1 ? EP_PRIORITY.length : idx;
    };
    return list.sort((a, b) => rank(a.name) - rank(b.name));
}

async function _refreshCompatibleProviders() {
    if (_providersRefreshPromise) return _providersRefreshPromise;
    _providersRefreshPromise = (async () => {
        // listAllProviderEntries 自带"catalog 枚举 ∥ 文件系统扫描"，这里再按
        // EP 名折叠，保证设置页每个 EP 只出现一次。
        const merged = _sortProviders(_mergeProviderEntries(await listAllProviderEntries()));
        // 空列表可能是"硬件枚举尚未就绪"的瞬时结果，不能落盘，否则 12 小时内
        // 设置页都会误报"没有可用 EP"。落盘的只有名字 + 状态（设备列表每次现算）。
        if (merged.length > 0) {
            detectionCache.setCachedProviders(merged.map(({ name, readyState }) => ({ name, readyState })));
        }
        return merged;
    })().finally(() => { _providersRefreshPromise = null; });
    return _providersRefreshPromise;
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
    // 供单测直接验证"同名 EP 只出现一次"与 provider DLL 过滤规则。
    __test: { _mergeProviderEntries, _isProviderDll },
};
