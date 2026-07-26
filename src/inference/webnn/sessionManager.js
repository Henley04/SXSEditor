/**
 * WebNN 推理模块 — 模型会话创建、管理、释放
 */

import { ensureOrt, getOrt } from './ortSetup.js';
import { WEBNN_EP_TIMEOUT, WEBNN_VOCODER_TIMEOUT } from './constants.js';
import { extractRelativePath, batchFloat32ToFloat16, disposeTensor } from './utils.js';

// 会话管理
const sessions = new Map(); // modelId -> { session, status, ep, lastAccess }
const MAX_SESSIONS = 8; // LRU 上限：超过时淘汰最久未访问的会话

/**
 * 读取模型文件（及可选的外部数据文件）为 ArrayBuffer
 * @param {string} modelPath - 模型文件绝对路径
 * @returns {{ modelBuffer: ArrayBuffer, externalDataBuffers: Array<{path: string, data: ArrayBuffer}> }}
 */
async function readModelFiles(modelPath) {
    if (typeof window === 'undefined' || !window.electronAPI?.webnnReadModelFile) {
        throw new Error('webnnReadModelFile not available');
    }

    // Read the main .onnx file
    const t0 = Date.now();
    const result = await window.electronAPI.webnnReadModelFile(modelPath);
    if (!result.success) throw new Error(result.error);
    const modelBuffer = result.data;
    console.log(`[WebNN] Model file read: ${(modelBuffer.byteLength / 1024 / 1024).toFixed(2)} MB (${Date.now() - t0}ms)`);

    // Try to read the external data file (.onnx.data) if it exists
    const externalDataBuffers = [];
    const dataPath = modelPath + '.data';
    // External data location in the model uses the base filename (e.g. "vocoder_dml.onnx.data")
    // not the full relative path. Use basename to match.
    const modelBasename = modelPath.replace(/\\/g, '/').split('/').pop();
    const dataRelativeName = modelBasename + '.data';
    try {
        const dataResult = await window.electronAPI.webnnReadModelFile(dataPath);
        if (dataResult.success && dataResult.data) {
            externalDataBuffers.push({
                path: dataRelativeName,
                data: dataResult.data,
            });
            console.log(`[WebNN] External data read: ${dataRelativeName} (${(dataResult.data.byteLength / 1024 / 1024).toFixed(1)} MB)`);
        }
    } catch (_) {
        // No external data file — that's fine
    }

    return { modelBuffer, externalDataBuffers };
}

/**
 * 加载模型到 NPU（或回退到 GPU/WASM）
 * @param {string} modelId - 模型标识符
 * @param {string} modelPath - 模型文件路径（绝对路径）
 * @param {{ deviceType: 'npu'|'gpu'|'cpu' }} options - 设备选项
 * @param {string} [modelUrl] - 模型 URL（未使用，保留兼容性）
 * @returns {{ success: boolean, ep: string, error?: string }}
 */
export async function loadModel(modelId, modelPath, options = { deviceType: 'npu' }, modelUrl = null) {
    await ensureOrt();
    const ort = getOrt();

    if (sessions.has(modelId)) {
        const existing = sessions.get(modelId);
        existing.lastAccess = Date.now();
        return { success: true, ep: existing.ep, warning: 'Model already loaded' };
    }

    // LRU 淘汰：达到上限时释放最久未访问的会话，避免 sessions Map 无限增长
    if (sessions.size >= MAX_SESSIONS) {
        let oldestId = null;
        let oldestAccess = Infinity;
        for (const [id, entry] of sessions) {
            const access = entry.lastAccess || 0;
            if (access < oldestAccess) {
                oldestAccess = access;
                oldestId = id;
            }
        }
        if (oldestId) {
            console.log(`[WebNN] LRU evicting ${oldestId} (last access ${oldestAccess})`);
            await unloadModel(oldestId);
        }
    }

    // Read model file (+ optional .onnx.data) as ArrayBuffer via IPC
    let modelBuffer, externalDataBuffers;
    try {
        ({ modelBuffer, externalDataBuffers } = await readModelFiles(modelPath));
    } catch (e) {
        return { success: false, ep: null, error: `Failed to read model file: ${e.message}` };
    }

    console.log(`[WebNN] Loading ${modelId} (${(modelBuffer.byteLength / 1024 / 1024).toFixed(2)} MB, extData: ${externalDataBuffers.length})`);
    const { deviceType } = options;
    // Allow per-model timeout override (vocoder needs longer NPU compilation time)
    const epTimeout = options.timeout || (modelId === 'vocoder' ? WEBNN_VOCODER_TIMEOUT : WEBNN_EP_TIMEOUT);

    // 回退链：WebNN NPU → WebNN GPU → WASM
    const epChain = [];
    if (deviceType === 'npu') {
        epChain.push({ name: 'webnn', deviceType: 'npu' });
        epChain.push({ name: 'webnn', deviceType: 'gpu' });
    } else if (deviceType === 'gpu') {
        epChain.push({ name: 'webnn', deviceType: 'gpu' });
    }
    epChain.push('wasm'); // 最终回退到 WASM (CPU)

    const sessionOptions = {
        // Performance options for onnxruntime-web — 默认值与 ORT 官方推荐一致
        graphOptimizationLevel: 'all',   // Enable all graph optimizations
        executionMode: 'sequential',     // Sequential execution (lower latency for single inference)
        enableCpuMemArena: true,         // Enable CPU memory arena for better allocation
    };

    // 应用用户在设置中配置的 ORT 选项（onnxruntime-web 仅支持部分 onnxruntime-node 选项；
    // intraOp/interOpNumThreads 由 ortSetup.js 全局 env.wasm.numThreads 控制，这里不重复设置）
    try {
        const ortSettings = await window.electronAPI?.getSettings?.();
        if (ortSettings) {
            if (typeof ortSettings.ortEnableMemPattern === 'boolean') {
                sessionOptions.enableMemPattern = ortSettings.ortEnableMemPattern;
            }
            if (typeof ortSettings.ortEnableCpuMemArena === 'boolean') {
                sessionOptions.enableCpuMemArena = ortSettings.ortEnableCpuMemArena;
            }
            if (['disabled', 'basic', 'extended', 'all'].includes(ortSettings.ortGraphOptLevel)) {
                sessionOptions.graphOptimizationLevel = ortSettings.ortGraphOptLevel;
            }
            if (ortSettings.ortExecutionMode === 'sequential' || ortSettings.ortExecutionMode === 'parallel') {
                sessionOptions.executionMode = ortSettings.ortExecutionMode;
            }
            // logSeverityLevel 在 onnxruntime-web 中通过 ort.env.logLevel 全局设置，
            // sessionOptions 不直接接受 logSeverityLevel，由 ortSetup.js 统一处理
        }
    } catch (err) {
        console.warn('[WebNN] Failed to read ORT session settings, using defaults:', err.message);
    }

    // 大模型（>100MB）禁用运行时图优化以加速加载
    // 这些模型已经过离线优化，运行时优化是冗余的且 NPU 编译很慢
    const modelSizeMB = modelBuffer.byteLength / (1024 * 1024);
    if (modelSizeMB > 100) {
        sessionOptions.graphOptimizationLevel = 'disabled';
        console.log(`[WebNN] Large model (${modelSizeMB.toFixed(0)}MB), runtime graph optimization disabled (already offline-optimized)`);
    }

    if (externalDataBuffers.length > 0) {
        sessionOptions.externalData = externalDataBuffers;
    }

    let lastError = null;
    for (const ep of epChain) {
        const epLabel = typeof ep === 'string' ? ep : `webnn-${ep.deviceType}`;
        const t0 = Date.now();
        let timeoutId;
        try {
            console.log(`[WebNN] Trying ${modelId} with EP: ${epLabel}...`);

            // Wrap InferenceSession.create with a per-EP timeout to avoid hanging forever.
            // clearTimeout 在成功和失败路径上都调用，避免计时器泄漏导致 event loop 不退出。
            const session = await Promise.race([
                ort.InferenceSession.create(modelBuffer, {
                    ...sessionOptions,
                    executionProviders: [ep],
                }),
                new Promise((_, reject) => {
                    timeoutId = setTimeout(() => reject(new Error(`EP ${epLabel} timed out after ${epTimeout / 1000}s`)), epTimeout);
                }),
            ]);
            clearTimeout(timeoutId);
            const ms = Date.now() - t0;
            sessions.set(modelId, { session, status: 'loaded', ep: epLabel, lastAccess: Date.now(), warmedUp: false });
            console.log(`[WebNN] Model ${modelId} loaded with EP: ${epLabel} (${ms}ms)`);
            // Fire-and-forget warmup: runs a dummy inference to pre-compile kernels.
            // Best-effort — failure does not prevent normal operation. Does not block loadModel return.
            _warmupSession(modelId).catch(() => {});
            return { success: true, ep: epLabel };
        } catch (e) {
            clearTimeout(timeoutId);
            const ms = Date.now() - t0;
            console.warn(`[WebNN] Failed ${modelId} with EP ${epLabel} after ${ms}ms: ${e.message}`);
            lastError = e;
        }
    }

    sessions.set(modelId, { session: null, status: 'error', ep: null, error: lastError?.message || 'unknown', lastAccess: Date.now() });
    return { success: false, ep: null, error: lastError?.message || 'All execution providers failed' };
}

/**
 * 在模型加载后运行一次 dummy 推理进行预热（best-effort）。
 * 尝试从 session.inputMetadata 构建最小化输入张量；若 metadata 不可用则跳过。
 * 使用 withRunLock 串行化，防止与 runSynthesis/runInference 并发破坏 WASM 栈。
 * @param {string} modelId
 */
async function _warmupSession(modelId) {
    const entry = sessions.get(modelId);
    if (!entry || entry.status !== 'loaded' || !entry.session) return;

    const ort = getOrt();
    const { session } = entry;

    try {
        const inputMetadata = session.inputMetadata;
        if (!inputMetadata || inputMetadata.length === 0) return;

        const feeds = {};
        for (const meta of inputMetadata) {
            if (!meta || !meta.name) continue;
            const rawShape = meta.shape || [1];
            // 将符号维度（字符串）和非正维度替换为 1，构建最小化输入
            const dims = rawShape.map(d => (typeof d === 'number' && d > 0) ? d : 1);
            const size = dims.reduce((a, b) => a * b, 1);
            const type = meta.type || 'float32';
            if (type === 'int64') {
                feeds[meta.name] = new ort.Tensor('int64', new BigInt64Array(size), dims);
            } else if (type === 'float16') {
                feeds[meta.name] = new ort.Tensor('float16', new Uint16Array(size), dims);
            } else {
                feeds[meta.name] = new ort.Tensor('float32', new Float32Array(size), dims);
            }
        }

        await withRunLock(() => session.run(feeds));
        entry.warmedUp = true;
        console.log(`[WebNN] Model ${modelId} warmed up`);
    } catch (e) {
        // Best-effort: warmup failure doesn't prevent normal operation
        console.warn(`[WebNN] Warmup skipped for ${modelId}: ${e.message}`);
    }
}

/**
 * 卸载模型
 * @param {string} modelId - 模型标识符
 */
export async function unloadModel(modelId) {
    const entry = sessions.get(modelId);
    if (entry && entry.session) {
        try {
            entry.session.release();
        } catch (_) {}
    }
    sessions.delete(modelId);
    console.log(`[WebNN] Model ${modelId} unloaded`);
}

// 全局 FIFO 互斥锁：同一时刻只允许一次完整合成或单次推理执行。
//
// 根因（onnxruntime Issue #19443）：ORT Web 的 WASM 后端用共享的 stackAlloc/stackRestore
// 管理线性内存栈，多个 session.run() 并发——无论是单次 runSynthesis 内部的 Promise.all
// 跨 encoder、还是跨 runSynthesis 调用、或是 IPC 触发的 runInference——都会破坏栈指针，
// 触发 "memory access out of bounds" 和 "Session already started"。
// 该约束作用于同一 ORT 上下文的所有 session，与 modelId 无异；DML 路径不受影响。
//
// 经验证：单次 session.run() 粒度的锁不足以防止 ORT WASM 内部残留异步操作导致的竞态，
// 必须提升到合成函数级（runSynthesis / runSynthesisBatch / runInference 整体持锁）。
//
// 注意：此锁不可重入。runSession 不再加锁，调用方（runSynthesis 等）必须用 withRunLock
// 包裹整体，确保内部多个 runSession 调用都在同一持锁期间顺序执行。
let _runLock = Promise.resolve();

/**
 * 在全局互斥锁保护下执行任意异步任务（粗粒度，用于合成函数级串行）。
 * 不可重入：task 内部禁止再次调用 withRunLock，否则死锁。
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 * @template T
 */
export async function withRunLock(task) {
    const prev = _runLock;
    let release;
    _runLock = new Promise((r) => { release = r; });
    await prev;
    try {
        return await task();
    } finally {
        release();
    }
}

/**
 * 执行推理（IPC 触发路径，主进程→渲染进程）。
 * 整体持锁，防止与 runSynthesis / 其他 runInference 并发破坏 WASM 栈。
 */
export async function runInference(modelId, inputs) {
    return withRunLock(() => _runInferenceUnlocked(modelId, inputs));
}

async function _runInferenceUnlocked(modelId, inputs) {
    const ort = getOrt();
    const entry = sessions.get(modelId);
    if (!entry || entry.status !== 'loaded' || !entry.session) {
        throw new Error(`Model ${modelId} is not loaded`);
    }
    entry.lastAccess = Date.now();

    const { session } = entry;
    const feeds = {};
    const feedTensors = []; // 跟踪输入张量以便推理后释放

    for (const [name, tensorData] of Object.entries(inputs)) {
        const { data, dims, type } = tensorData;
        const tensorType = type || 'float32';
        let tensorDataArray;

        if (tensorType === 'float16') {
            if (data instanceof Uint16Array) {
                tensorDataArray = data;
            } else if (data instanceof Float32Array) {
                tensorDataArray = new Uint16Array(data.length);
                batchFloat32ToFloat16(data, tensorDataArray, data.length);
            } else {
                tensorDataArray = new Uint16Array(data);
            }
        } else if (tensorType === 'int64') {
            // int64 uses BigInt64Array — data may arrive as BigInt64Array or plain Array
            if (data instanceof BigInt64Array) {
                tensorDataArray = data;
            } else if (data instanceof Array) {
                tensorDataArray = BigInt64Array.from(data.map(v => BigInt(v)));
            } else {
                // Fallback: convert whatever we got to BigInt64Array
                tensorDataArray = new BigInt64Array(Array.from(data, v => BigInt(v)));
            }
        } else {
            // float32
            if (data instanceof Float32Array) {
                tensorDataArray = data;
            } else {
                tensorDataArray = new Float32Array(data);
            }
        }

        const tensor = new ort.Tensor(tensorType, tensorDataArray, dims);
        feeds[name] = tensor;
        feedTensors.push(tensor);
    }

    const results = await session.run(feeds);

    // 推理完成：释放所有输入张量（IPC 路径下输入张量每次调用新建，不复用）
    for (const t of feedTensors) disposeTensor(t);

    // 将结果转换为可序列化格式（IPC 传输）
    // 使用 TypedArray.slice() 替代 Array.from()，避免展开为普通数组的巨大开销
    const outputs = {};
    for (const [name, tensor] of Object.entries(results)) {
        const outType = tensor.type || 'float32';
        if (outType === 'int64') {
            // 手动循环比 Array.from(..., mapper) 更快：避免 map 回调开销
            const bigints = tensor.data instanceof BigInt64Array
                ? tensor.data
                : new BigInt64Array(tensor.data);
            const strings = new Array(bigints.length);
            for (let i = 0; i < bigints.length; i++) {
                strings[i] = bigints[i].toString();
            }
            outputs[name] = {
                data: strings,
                dims: tensor.dims,
                type: outType,
            };
        } else {
            // 使用 slice 获取独立副本（IPC 结构化克隆可零拷贝传输 ArrayBuffer）
            const typedData = tensor.data instanceof Float32Array || tensor.data instanceof Uint16Array
                ? tensor.data.slice()
                : new Float32Array(tensor.data);
            outputs[name] = {
                data: typedData,
                dims: tensor.dims,
                type: outType,
            };
        }
        // 释放输出张量（数据已拷贝到独立 TypedArray）
        disposeTensor(tensor);
    }

    return outputs;
}

/**
 * 获取所有模型状态
 * @returns {Object} 模型状态映射
 */
export function getStatus() {
    const status = {};
    for (const [modelId, entry] of sessions) {
        status[modelId] = {
            status: entry.status,
            ep: entry.ep,
            error: entry.error || null,
        };
    }
    return status;
}

/**
 * 获取指定模型的会话（供内部模块使用）
 * @param {string} modelId
 * @returns {{ session: object, status: string, ep: string } | undefined}
 */
export function getSession(modelId) {
    const entry = sessions.get(modelId);
    if (entry) {
        entry.lastAccess = Date.now();
    }
    return entry;
}

/**
 * 运行指定模型的推理（供内部模块使用，直接返回 ort 结果）。
 * 不加锁：调用方（runSynthesis / runSynthesisBatch）必须用 withRunLock 包裹整体，
 * 确保内部多个 runSession 调用顺序执行。锁不可重入，此处再加锁会死锁。
 */
export async function runSession(modelId, feeds) {
    const entry = sessions.get(modelId);
    if (!entry || entry.status !== 'loaded' || !entry.session) {
        throw new Error(`Model ${modelId} is not loaded`);
    }
    entry.lastAccess = Date.now();
    return await entry.session.run(feeds);
}
