/**
 * ortBridge.js — JS wrapper around the sxs-ort-bridge native addon.
 *
 * Bridges between onnxruntime-node style sessions (ort.Tensor in/out) and the
 * addon's raw {type, data:ArrayBuffer, dims} descriptors, exposing a
 * WinMLSession that is duck-type compatible with what
 * createSessionWithValidation() and the SVS pipeline expect:
 *   { inputNames, outputNames, inputMetadata, outputMetadata, run(feeds), release() }
 *
 * All calls are synchronous under the hood (matching ORT CPU/DML semantics);
 * run() is async only to satisfy pipeline call sites.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const TYPED_ARRAY_BY_TYPE = {
    float32: Float32Array,
    float16: Uint16Array, // raw fp16 bits (same convention as pipeline float16Patch)
    int64: BigInt64Array,
    int32: Int32Array,
    uint8: Uint8Array,
    int8: Int8Array,
    bool: Uint8Array,
};

function _loadOrt() {
    try {
        return require('onnxruntime-node');
    } catch (_e) {
        return null; // tests may stub tensor creation
    }
}

let _addon = null;
let _initPromise = null;

/** asar 内路径换算到 unpacked（.node 二进制必须从真实文件系统加载）。 */
function _asarUnpackedVariant(p) {
    if (!p) return p;
    const idx = p.toLowerCase().indexOf('.asar');
    if (idx === -1) return p;
    const unpacked = p.slice(0, idx) + '.asar.unpacked' + p.slice(idx + 5);
    try {
        if (fs.existsSync(unpacked)) return unpacked;
    } catch (_) { /* ignore */ }
    return p;
}

/**
 * Resolve the bundled onnxruntime.dll shipped with onnxruntime-node.
 * Seeds: climb from __dirname, from process.resourcesPath and from the exe
 * directory — covers dev (repo root), forge dev layout (.webpack/main) and
 * packaged layouts (resources/app.asar[.unpacked] + external node_modules).
 */
function resolveOrtDllPath() {
    if (process.platform !== 'win32') return null; // WinML 仅 Windows
    const archDir = process.arch === 'arm64' ? 'arm64' : 'x64';
    const rel = path.join(
        'node_modules', 'onnxruntime-node', 'bin', 'napi-v6',
        'win32', archDir, 'onnxruntime.dll');
    const seeds = [];
    let dir = __dirname;
    for (let i = 0; i < 8; i++) { seeds.push(dir); dir = path.join(dir, '..'); }
    if (process.resourcesPath) {
        dir = process.resourcesPath;
        for (let i = 0; i < 4; i++) { seeds.push(dir); dir = path.join(dir, '..'); }
    }
    if (process.execPath) {
        dir = path.dirname(process.execPath);
        for (let i = 0; i < 4; i++) { seeds.push(dir); dir = path.join(dir, '..'); }
    }
    for (const seed of seeds) {
        const candidate = _asarUnpackedVariant(path.join(seed, rel));
        try {
            fs.accessSync(candidate);
            return candidate;
        } catch (_) { /* keep climbing */ }
    }
    // 诊断：打包/worker 场景定位失败时输出关键路径上下文
    try {
        console.warn(`[WinML] resolveOrtDllPath MISS: seeds=${seeds.length} __dirname=${__dirname} resources=${process.resourcesPath || 'n/a'} exec=${process.execPath || 'n/a'} lastTry=${path.join(seeds[seeds.length - 1] || '', rel)}`);
    } catch (_) {}
    return null;
}

/**
 * Initialize the bridge against the app's own onnxruntime runtime.
 * Safe to call multiple times; subsequent calls are no-ops.
 * @returns {Promise<boolean>} true when the bridge is usable.
 */
async function ensureBridgeInit() {
    if (_addon && _initPromise) return _initPromise;
    if (!_initPromise) {
        _initPromise = (async () => {
            try {
                const loaded = loadAddon();
                _addon = loaded.addon;
                const dllPath = resolveOrtDllPath();
                if (!dllPath) throw new Error('onnxruntime.dll not found under node_modules');
                const info = _addon.init(dllPath);
                if (!info || !info.apiVersion) throw new Error('bridge init returned no apiVersion');
                console.log(`[WinML] ort-bridge loaded from ${loaded.path} (api v${info.apiVersion})`);
                return true;
            } catch (e) {
                _addon = null;
                _initFailureReason = e.message;
                console.warn('[WinML] ort-bridge init failed:', e.message);
                return false;
            }
        })();
    }
    return _initPromise;
}

let _initFailureReason = null;

/**
 * Candidate locations for the compiled addon binary:
 *  1. SXS_ORT_BRIDGE_PATH env override
 *  2. Next to the webpack bundle (.webpack/main/native/) — packaged & dev-forge
 *  3. Repo build output (native/ort-bridge/build/Release) — dev from source
 *  4. Repo prebuilt (native/ort-bridge/prebuilt/win32-<arch>)
 * Each candidate gets an .asar → .asar.unpacked fallback (native binaries
 * cannot be loaded from inside asar).
 */
function candidatePaths() {
    const list = [];
    if (process.env.SXS_ORT_BRIDGE_PATH) list.push(process.env.SXS_ORT_BRIDGE_PATH);
    // bundle layout: __dirname = <app>/.webpack/main/inference/winml
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        list.push(path.join(dir, 'native', 'ort_bridge.node'));
        list.push(path.join(dir, 'native', 'ort_bridge_prebuilt.node'));
        dir = path.join(dir, '..');
    }
    // repo/source layout: climb to repo root and use native/ outputs
    dir = __dirname;
    for (let i = 0; i < 8; i++) {
        const root = dir;
        list.push(path.join(root, 'build', 'Release', 'ort_bridge.node'));
        list.push(path.join(root, 'prebuilt', `win32-${process.arch}`, 'ort_bridge.node'));
        list.push(path.join(root, 'node_modules', 'sxs-ort-bridge', 'prebuilt', `win32-${process.arch}`, 'ort_bridge.node'));
        dir = path.join(dir, '..');
    }
    return list;
}

function loadAddon() {
    // 测试注入口：单测通过 globalThis 注入 fake addon，避免触碰原生二进制
    if (globalThis.__SXS_ORT_BRIDGE_MOCK__) {
        return { addon: globalThis.__SXS_ORT_BRIDGE_MOCK__, path: 'mock' };
    }
    const errors = [];
    for (const raw of candidatePaths()) {
        try {
            let p = _asarUnpackedVariant(raw);
            if (!p || !fs.existsSync(p)) { errors.push(`${raw}: not found`); continue; }
            try {
                return { addon: require(p), path: p };
            } catch (requireErr) {
                // 二次尝试：process.dlopen 绕过 Module 包装层，暴露真实 OS 错误
                const mod = { exports: {} };
                try {
                    process.dlopen(mod, p);
                    return { addon: mod.exports, path: p };
                } catch (dlopenErr) {
                    errors.push(`${raw}: dlopen -> ${dlopenErr.message.split('\n')[0]}`);
                    continue;
                }
            }
        } catch (e) {
            errors.push(`${raw}: ${e.message.split('\n')[0]}`);
        }
    }
    throw new Error(
        '[sxs-ort-bridge] native module not found. Tried:\n  ' +
        errors.join('\n  ') +
        '\nBuild it with: npm run build:native'
    );
}

/** 将 asar.unpacked 内的二进制复制到无 ".asar" 字样的缓存路径并返回路径。 */
function _cachedCopy(src) {
    try {
        const os = require('node:os');
        const crypto = require('node:crypto');
        const st = fs.statSync(src);
        const key = crypto.createHash('sha1').update(`${src}:${st.size}:${Math.floor(st.mtimeMs)}`).digest('hex').slice(0, 12);
        const dir = path.join(os.tmpdir(), 'sxs-ort-bridge-cache');
        fs.mkdirSync(dir, { recursive: true });
        const dst = path.join(dir, `ort_bridge_${key}.node`);
        if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
        return dst;
    } catch (_e) {
        return null;
    }
}

function getAddon() {
    return _addon;
}

function getInitFailureReason() {
    return _initFailureReason;
}

/** Register a plugin EP library (from Windows ML catalog) into our ORT env. */
function registerEp(name, libraryPath) {
    if (!_addon) throw new Error('[WinML] bridge not initialized');
    return _addon.registerEp(name, libraryPath);
}

/** Test if a DLL can be LoadLibrary'd (checks dependencies, 1114 etc.) */
function canLoadLibrary(libraryPath) {
    if (!_addon || typeof _addon.canLoadLibrary !== 'function') return true; // old bridge, assume loadable
    try {
        return _addon.canLoadLibrary(libraryPath) === true;
    } catch (_) {
        return false;
    }
}

/** List EP devices visible after registration. */
function listDevices() {
    if (!_addon) return [];
    try {
        return _addon.listDevices();
    } catch (_) {
        return [];
    }
}

/** Pick device indices by predicate over listDevices(). */
function pickDeviceIndices(pred) {
    return listDevices().filter(pred).map((d) => d.index);
}

function _tensorFromDescriptor(v) {
    const TA = TYPED_ARRAY_BY_TYPE[v.type];
    if (!TA) return null;
    const bytes = v.data instanceof ArrayBuffer ? new Uint8Array(v.data) : new Uint8Array(v.data.buffer || v.data);
    // Copy into a correctly-typed view (bridge already copied out of native memory).
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const typed = new TA(ab);
    return { type: v.type, data: typed, dims: v.dims.map(Number) };
}

function _descriptorFromTensor(t) {
    const data = t.data;
    let buf;
    if (data instanceof ArrayBuffer) {
        buf = data;
    } else if (ArrayBuffer.isView(data)) {
        // Copy the exact view region — some producers hand back subarray views
        // over larger buffers (fp16 conversion helpers do this).
        buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } else {
        throw new Error(`[WinML] unsupported tensor data for descriptor: ${typeof data}`);
    }
    return {
        type: t.type,
        dims: Array.from(t.dims, (d) => Number(d)),
        data: buf,
    };
}

/**
 * Duck-type session backed by the native bridge with plugin EPs attached.
 */
class WinMLSession {
    /**
     * @param {object} addon native addon
     * @param {bigint|number} id session id from addon.createSession
     * @param {{inputs:Array,outputs:Array}} info from addon.sessionInfo
     */
    constructor(addon, id, info) {
        this._addon = addon;
        this._id = id;
        this.inputNames = info.inputs.map((i) => i.name);
        this.outputNames = info.outputs.map((o) => o.name);
        this.inputMetadata = info.inputs.map((i) => ({
            name: i.name,
            isTensor: true,
            type: i.type,
            shape: i.dims.map((d) => (Number(d) < 0 ? -1 : Number(d))),
        }));
        this.outputMetadata = info.outputs.map((o) => ({
            name: o.name,
            isTensor: true,
            type: o.type,
            shape: o.dims.map((d) => (Number(d) < 0 ? -1 : Number(d))),
        }));
        this.provider = 'windowsml';
    }

    async run(feeds) {
        const desc = {};
        for (const [name, t] of Object.entries(feeds)) {
            desc[name] = _descriptorFromTensor(t);
        }
        const out = this._addon.run(this._id, desc);
        const res = {};
        for (const [k, v] of Object.entries(out)) {
            const t = _tensorFromDescriptor(v);
            if (t) res[k] = t;
        }
        return res;
    }

    release() {
        try {
            this._addon.releaseSession(this._id);
        } catch (_) { /* idempotent */ }
    }
}

/**
 * Create a WinML-backed session for a model using the given EP device indices.
 * @param {string} modelPath absolute .onnx path
 * @param {number[]} deviceIndices indices within listDevices()
 * @returns {Promise<WinMLSession>}
 */
async function createSessionWithEps(modelPath, deviceIndices) {
    const ok = await ensureBridgeInit();
    if (!ok) throw new Error(getInitFailureReason() || '[WinML] bridge unavailable');
    const addon = getAddon();
    const id = addon.createSession(modelPath, deviceIndices || []);
    let info;
    try {
        info = addon.sessionInfo(id);
    } catch (e) {
        addon.releaseSession(id);
        throw e;
    }
    return new WinMLSession(addon, id, info);
}

function disposeAllSessions() {
    if (_addon) {
        try { _addon.disposeAll(); } catch (_) { /* ignore */ }
    }
}

module.exports = {
    ensureBridgeInit,
    getAddon,
    getInitFailureReason,
    registerEp,
    canLoadLibrary,
    listDevices,
    pickDeviceIndices,
    createSessionWithEps,
    disposeAllSessions,
    resolveOrtDllPath,
    // exposed for tests
    __test: { _tensorFromDescriptor, _descriptorFromTensor, TYPED_ARRAY_BY_TYPE },
};
