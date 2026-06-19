/**
 * WebNN 推理模块 — 模型会话创建、管理、释放
 */

import { ensureOrt, getOrt } from './ortSetup.js';
import { WEBNN_EP_TIMEOUT, WEBNN_VOCODER_TIMEOUT } from './constants.js';
import { extractRelativePath, float32ToFloat16 } from './utils.js';

// 会话管理
const sessions = new Map(); // modelId -> { session, status, ep }

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
        return { success: true, ep: sessions.get(modelId).ep, warning: 'Model already loaded' };
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
        // Performance options for onnxruntime-web
        graphOptimizationLevel: 'all',   // Enable all graph optimizations
        executionMode: 'sequential',      // Sequential execution (lower latency for single inference)
        enableCpuMemArena: true,          // Enable CPU memory arena for better allocation
    };

    // 大模型（>100MB）使用基础优化以加速加载（已离线优化，无需运行时深度优化）
    const modelSizeMB = modelBuffer.byteLength / (1024 * 1024);
    if (modelSizeMB > 100) {
        sessionOptions.graphOptimizationLevel = 'basic';
        console.log(`[WebNN] Large model (${modelSizeMB.toFixed(0)}MB), using basic graph optimization`);
    }

    if (externalDataBuffers.length > 0) {
        sessionOptions.externalData = externalDataBuffers;
    }

    let lastError = null;
    for (const ep of epChain) {
        const epLabel = typeof ep === 'string' ? ep : `webnn-${ep.deviceType}`;
        const t0 = Date.now();
        try {
            console.log(`[WebNN] Trying ${modelId} with EP: ${epLabel}...`);

            // Wrap InferenceSession.create with a per-EP timeout to avoid hanging forever
            const session = await Promise.race([
                ort.InferenceSession.create(modelBuffer, {
                    ...sessionOptions,
                    executionProviders: [ep],
                }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`EP ${epLabel} timed out after ${epTimeout / 1000}s`)), epTimeout)
                ),
            ]);
            const ms = Date.now() - t0;
            sessions.set(modelId, { session, status: 'loaded', ep: epLabel });
            console.log(`[WebNN] Model ${modelId} loaded with EP: ${epLabel} (${ms}ms)`);
            return { success: true, ep: epLabel };
        } catch (e) {
            const ms = Date.now() - t0;
            console.warn(`[WebNN] Failed ${modelId} with EP ${epLabel} after ${ms}ms: ${e.message}`);
            lastError = e;
        }
    }

    sessions.set(modelId, { session: null, status: 'error', ep: null, error: lastError?.message || 'unknown' });
    return { success: false, ep: null, error: lastError?.message || 'All execution providers failed' };
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

/**
 * 执行推理
 * @param {string} modelId - 模型标识符
 * @param {Object} inputs - 输入张量数据 { inputName: { data: Float32Array|Uint16Array, dims: number[] } }
 * @returns {Object} 输出张量数据 { outputName: { data: Array, dims: number[] } }
 */
export async function runInference(modelId, inputs) {
    const ort = getOrt();
    const entry = sessions.get(modelId);
    if (!entry || entry.status !== 'loaded' || !entry.session) {
        throw new Error(`Model ${modelId} is not loaded`);
    }

    const { session } = entry;
    const feeds = {};

    for (const [name, tensorData] of Object.entries(inputs)) {
        const { data, dims, type } = tensorData;
        const tensorType = type || 'float32';
        let tensorDataArray;

        if (tensorType === 'float16') {
            if (data instanceof Uint16Array) {
                tensorDataArray = data;
            } else if (data instanceof Float32Array) {
                tensorDataArray = new Uint16Array(data.length);
                for (let i = 0; i < data.length; i++) {
                    tensorDataArray[i] = float32ToFloat16(data[i]);
                }
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

        feeds[name] = new ort.Tensor(tensorType, tensorDataArray, dims);
    }

    const results = await session.run(feeds);

    // 将结果转换为可序列化格式（IPC 传输）
    // 使用 TypedArray.slice() 替代 Array.from()，避免展开为普通数组的巨大开销
    const outputs = {};
    for (const [name, tensor] of Object.entries(results)) {
        const outType = tensor.type || 'float32';
        if (outType === 'int64') {
            outputs[name] = {
                data: Array.from(tensor.data, v => v.toString()),
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
    return sessions.get(modelId);
}

/**
 * 运行指定模型的推理（供内部模块使用，直接返回 ort 结果）
 * @param {string} modelId
 * @param {Object} feeds
 * @returns {Object} ort 推理结果
 */
export async function runSession(modelId, feeds) {
    const entry = sessions.get(modelId);
    if (!entry || entry.status !== 'loaded' || !entry.session) {
        throw new Error(`Model ${modelId} is not loaded`);
    }
    return await entry.session.run(feeds);
}
