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
let _nextSessionTraceId = 1;

function _traceEnabled() {
    if (process.env.SXS_WINML_TRACE === '1' || process.env.SXSEDITOR_ORT_DEBUG === '1') return true;
    const snapshot = globalThis.__SXS_SETTINGS_SNAPSHOT__;
    return !!(snapshot && snapshot.diagnosticMode === true);
}

function _fmtDims(dims) {
    return `[${Array.from(dims || [], Number).join('x')}]`;
}

function _fp16ToNumber(bits) {
    const sign = (bits & 0x8000) ? -1 : 1;
    const exp = (bits >>> 10) & 0x1f;
    const frac = bits & 0x3ff;
    if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024);
    if (exp === 31) return frac ? NaN : sign * Infinity;
    return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

function _finiteStats(data, type = 'float32') {
    if (!data || typeof data.length !== 'number') return 'n/a';
    const n = data.length;
    if (!n) return 'n=0';
    // Full finite scan is intentional in trace mode: silent NaN/Inf corruption
    // is the failure mode being diagnosed. Numeric moments use bounded sampling
    // to keep logging practical for multi-million-element tensors.
    let nan = 0, inf = 0, zero = 0;
    for (let i = 0; i < n; i++) {
        const v = type === 'float16' ? _fp16ToNumber(data[i]) : Number(data[i]);
        if (Number.isNaN(v)) nan++;
        else if (!Number.isFinite(v)) inf++;
        else if (v === 0) zero++;
    }
    const step = Math.max(1, Math.floor(n / 4096));
    let min = Infinity, max = -Infinity, sum = 0, sum2 = 0, count = 0;
    for (let i = 0; i < n; i += step) {
        const v = type === 'float16' ? _fp16ToNumber(data[i]) : Number(data[i]);
        if (!Number.isFinite(v)) continue;
        min = Math.min(min, v); max = Math.max(max, v);
        sum += v; sum2 += v * v; count++;
    }
    const mean = count ? sum / count : NaN;
    const rms = count ? Math.sqrt(sum2 / count) : NaN;
    const f = (v) => Number.isFinite(v) ? v.toExponential(3) : String(v);
    return `n=${n} min=${f(min)} max=${f(max)} mean=${f(mean)} rms=${f(rms)} zero=${zero} nan=${nan} inf=${inf}`;
}

function _tensorSummary(name, tensor) {
    return `${name}:${tensor.type}${_fmtDims(tensor.dims)}{${_finiteStats(tensor.data, tensor.type)}}`;
}

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
                console.log(`[WinML][bridge] ready api=${info.apiVersion} addon=${path.basename(loaded.path)} source=${_sourceLabel(loaded.path)} ort=${path.basename(dllPath)} arch=${process.arch} native=${info.buildTag || 'legacy'}`);
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

/** Derive a short source label from the loaded addon path for log clarity. */
function _sourceLabel(p) {
    if (!p || p === 'mock') return 'mock';
    const norm = p.replace(/\\/g, '/');
    if (norm.includes('.webpack/')) return 'webpack';
    if (norm.includes('/build/Release/')) return 'build';
    if (norm.includes('/prebuilt/')) return 'prebuilt';
    if (norm.includes('node_modules')) return 'node_modules';
    return 'other';
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
    constructor(addon, id, info, context = {}) {
        this._addon = addon;
        this._id = id;
        this._traceId = _nextSessionTraceId++;
        this._modelPath = context.modelPath || '';
        this._epName = context.epName || 'unknown';
        this._runCount = 0;
        this._logScope = String(this._epName).includes('NvTensorRTRTX') ? 'TRTRTX' : 'WinML';
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
        const run = ++this._runCount;
        const trace = _traceEnabled();
        const started = performance.now();
        const desc = {};
        for (const [name, tensor] of Object.entries(feeds)) desc[name] = _descriptorFromTensor(tensor);
        if (trace) {
            console.log(`[${this._logScope}][run:${this._traceId}.${run}][in] ep=${this._epName} model=${path.basename(this._modelPath)} ${Object.entries(feeds).map(([n, x]) => _tensorSummary(n, x)).join(' | ')}`);
        }
        try {
            const out = this._addon.run(this._id, desc);
            const res = {};
            for (const [k, v] of Object.entries(out)) {
                const tensor = _tensorFromDescriptor(v);
                if (tensor) res[k] = tensor;
            }
            if (trace) {
                console.log(`[${this._logScope}][run:${this._traceId}.${run}][out] ms=${(performance.now() - started).toFixed(1)} ${Object.entries(res).map(([n, x]) => _tensorSummary(n, x)).join(' | ')}`);
            }
            return res;
        } catch (error) {
            console.error(`[${this._logScope}][run:${this._traceId}.${run}][fail] ms=${(performance.now() - started).toFixed(1)} ep=${this._epName} model=${path.basename(this._modelPath)} error=${String(error.message || error).split('\n')[0]}`);
            throw error;
        }
    }

    release() {
        try {
            this._addon.releaseSession(this._id);
        } catch (_) { /* idempotent */ }
    }
}

/**
 * Build provider-specific options for TensorRT-RTX EP.
 *
 * Supports three modes via env vars:
 *  - SXS_TRTRTX_EXPLICIT_PROFILE=1 → opt in to experimental explicit profiles
 *  - SXS_TRTRTX_OPT_SEQ / SXS_TRTRTX_MAX_SEQ → override opt-in profile lengths
 *  - SXS_WINML_TRACE=1 → auto-add nv_detailed_build_log + nv_dump_subgraphs
 */
function _tensorRtRtxOptions(modelPath) {
    const name = path.basename(modelPath || '').toLowerCase();
    const useExplicitProfile = process.env.SXS_TRTRTX_EXPLICIT_PROFILE === '1';
    const maxSeq = Math.max(2048, Number.parseInt(process.env.SXS_TRTRTX_MAX_SEQ || '4096', 10) || 4096);
    const optSeq = Math.min(maxSeq, Math.max(1, Number.parseInt(process.env.SXS_TRTRTX_OPT_SEQ || '1950', 10) || 1950));
    const options = {};

    // Do not force profiles by default. These optimized models run with EP-inferred
    // shapes, while an incompatible explicit profile causes execution-context
    // enqueue failures. Keep profiles behind an explicit diagnostic opt-in.
    if (useExplicitProfile) {
        if (name.includes('diff_step')) {
            options.nv_profile_min_shapes = 'xt_input:1x1x128;t:1;cond:1x1x1024;xt_mask:1x1';
            options.nv_profile_opt_shapes = `xt_input:1x${optSeq}x128;t:1;cond:1x${optSeq}x1024;xt_mask:1x${optSeq}`;
            options.nv_profile_max_shapes = `xt_input:1x${maxSeq}x128;t:1;cond:1x${maxSeq}x1024;xt_mask:1x${maxSeq}`;
        } else if (name.includes('preflow')) {
            options.nv_profile_min_shapes = 'features:1x1x512';
            options.nv_profile_opt_shapes = `features:1x${Math.min(optSeq, 1500)}x512`;
            options.nv_profile_max_shapes = `features:1x${maxSeq}x512`;
        }
    }

    if (_traceEnabled()) {
        options.nv_detailed_build_log = '1';
        // nv_dump_subgraphs exports the TRT-assigned subgraphs so we can verify
        // which nodes TRT took over and whether outputs originate from TRT or CPU.
        options.nv_dump_subgraphs = '1';
    }
    return options;
}

/**
 * Validate that a TRT session produces non-zero, finite output for non-zero input.
 * Returns normally if output is valid; throws if output is all-zero, NaN, or Inf.
 * This catches TRT compilation bugs that silently produce zero output without
 * ORT reporting an error — the exact failure mode diagnosed in the all-zero bug.
 *
 * @param {Object} outputs - session.run() return value {name: {type, data, dims}}
 * @throws {Error} with descriptive message on validation failure
 */
function validateTRTOutput(outputs, expectedNames = []) {
    const entries = Object.entries(outputs || {});
    if (entries.length === 0) throw new Error('TRT returned no outputs');
    for (const expected of expectedNames) {
        if (!Object.prototype.hasOwnProperty.call(outputs, expected)) {
            throw new Error(`TRT missing expected output '${expected}'`);
        }
    }
    let validated = 0;
    for (const [name, tensor] of entries) {
        const data = tensor.data;
        if (!data || typeof data.length !== 'number' || data.length === 0) {
            throw new Error(`TRT output '${name}' is missing or empty`);
        }
        validated++;
        const n = data.length;
        const isFp16 = tensor.type === 'float16';
        let zero = 0, nan = 0, inf = 0;
        for (let i = 0; i < n; i++) {
            const v = isFp16 ? _fp16ToNumber(data[i]) : Number(data[i]);
            if (Number.isNaN(v)) nan++;
            else if (!Number.isFinite(v)) inf++;
            else if (v === 0) zero++;
        }
        if (nan > 0 || inf > 0) {
            throw new Error(`TRT output '${name}' non-finite: nan=${nan} inf=${inf} n=${n}`);
        }
        if (zero === n) {
            throw new Error(`TRT output '${name}' entirely zero: zero=${zero}/${n}`);
        }
        // Numerically silent: rms so low it's effectively zero
        let sum2 = 0, count = 0;
        const step = Math.max(1, Math.floor(n / 4096));
        for (let i = 0; i < n; i += step) {
            const v = isFp16 ? _fp16ToNumber(data[i]) : Number(data[i]);
            if (Number.isFinite(v)) { sum2 += v * v; count++; }
        }
        const rms = count ? Math.sqrt(sum2 / count) : 0;
        if (rms < 1e-8) {
            throw new Error(`TRT output '${name}' numerically silent: rms=${rms.toExponential(3)}`);
        }
    }
    if (validated === 0) throw new Error('TRT produced no valid tensor outputs');
}

/**
 * Create a WinML-backed session for a model using the given EP device indices.
 * @param {string} modelPath absolute .onnx path
 * @param {number[]} deviceIndices indices within listDevices()
 * @returns {Promise<WinMLSession>}
 */
async function createSessionWithEps(modelPath, deviceIndices, epName = 'unknown') {
    const ok = await ensureBridgeInit();
    if (!ok) throw new Error(getInitFailureReason() || '[WinML] bridge unavailable');
    const addon = getAddon();
    const providerOptions = String(epName).includes('NvTensorRTRTX')
        ? _tensorRtRtxOptions(modelPath)
        : {};
    if (_traceEnabled() && Object.keys(providerOptions).length) {
        console.log(`[TRTRTX][profile] model=${path.basename(modelPath)} ${Object.entries(providerOptions).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }
    const id = addon.createSession(modelPath, deviceIndices || [], providerOptions);
    let info;
    try {
        info = addon.sessionInfo(id);
    } catch (e) {
        addon.releaseSession(id);
        throw e;
    }
    const session = new WinMLSession(addon, id, info, { modelPath, epName });
    if (_traceEnabled()) {
        const stat = fs.statSync(modelPath);
        const inputs = info.inputs.map(x => `${x.name}:${x.type}${_fmtDims(x.dims)}`).join(',');
        const outputs = info.outputs.map(x => `${x.name}:${x.type}${_fmtDims(x.dims)}`).join(',');
        console.log(`[${session._logScope}][session:${session._traceId}] created ep=${epName} devices=${(deviceIndices || []).join(',')} model=${path.basename(modelPath)} bytes=${stat.size} inputs=${inputs} outputs=${outputs}`);
    }
    return session;
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
    validateTRTOutput,
    disposeAllSessions,
    resolveOrtDllPath,
    // exposed for tests
    __test: { _tensorFromDescriptor, _descriptorFromTensor, TYPED_ARRAY_BY_TYPE, _finiteStats, _fmtDims, _fp16ToNumber, _tensorRtRtxOptions, validateTRTOutput },
};
