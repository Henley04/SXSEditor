/**
 * WebNN 推理模块 — 在渲染进程中使用 onnxruntime-web + WebNN EP 执行 NPU 推理
 *
 * 此模块运行在 Electron 渲染进程中，通过 WebNN API 访问 NPU 硬件。
 * 模型文件通过自定义 protocol (onnx://) 从主进程安全获取。
 * 推理输入/输出通过 IPC 与主进程协调。
 */

// onnxruntime-web 需要在渲染进程中使用
let ort = null;

async function ensureOrt() {
    if (ort) return ort;
    try {
        const mod = await import('onnxruntime-web/all');
        ort = mod;
    } catch (e) {
        console.error('[WebNN] Failed to import onnxruntime-web:', e);
        throw e;
    }
    return ort;
}

// 会话管理
const sessions = new Map(); // modelId -> { session, status, ep }

/**
 * 检测 WebNN/NPU 可用性
 * @returns {{ webnnAvailable: boolean, npuAvailable: boolean, gpuAvailable: boolean, details: string }}
 */
async function detectNPU() {
    await ensureOrt();

    // 检查 navigator.ml API
    if (typeof navigator === 'undefined' || !navigator.ml) {
        return {
            webnnAvailable: false,
            npuAvailable: false,
            gpuAvailable: false,
            details: 'navigator.ml API not available (WebNN not enabled or unsupported Chromium version)',
        };
    }

    let npuAvailable = false;
    let gpuAvailable = false;
    let details = '';

    // 检测 NPU
    try {
        const npuContext = await navigator.ml.createContext({ deviceType: 'npu' });
        if (npuContext) {
            npuAvailable = true;
            details += 'NPU: available; ';
        }
    } catch (e) {
        details += `NPU: not available (${e.message}); `;
    }

    // 检测 GPU (WebNN)
    try {
        const gpuContext = await navigator.ml.createContext({ deviceType: 'gpu' });
        if (gpuContext) {
            gpuAvailable = true;
            details += 'GPU (WebNN): available; ';
        }
    } catch (e) {
        details += `GPU (WebNN): not available (${e.message}); `;
    }

    return {
        webnnAvailable: npuAvailable || gpuAvailable,
        npuAvailable,
        gpuAvailable,
        details: details.trim(),
    };
}

/**
 * 构建模型 URL（通过 onnx:// protocol）
 * @param {string} modelPath - 相对于 onnx_models 目录的模型文件路径
 * @returns {string} onnx:// URL
 */
function buildModelUrl(modelPath) {
    return `onnx://model-path/${modelPath}`;
}

/**
 * 加载模型到 NPU（或回退到 GPU/WASM）
 * @param {string} modelId - 模型标识符
 * @param {string} modelPath - 相对于 onnx_models 目录的模型文件路径
 * @param {{ deviceType: 'npu'|'gpu'|'cpu' }} options - 设备选项
 * @returns {{ success: boolean, ep: string, error?: string }}
 */
async function loadModel(modelId, modelPath, options = { deviceType: 'npu' }) {
    await ensureOrt();

    if (sessions.has(modelId)) {
        return { success: true, ep: sessions.get(modelId).ep, warning: 'Model already loaded' };
    }

    const modelUrl = buildModelUrl(modelPath);
    const { deviceType } = options;

    // 回退链：WebNN NPU → WebNN GPU → WASM
    const epChain = [];
    if (deviceType === 'npu') {
        epChain.push({ name: 'webnn', deviceType: 'npu' });
        epChain.push({ name: 'webnn', deviceType: 'gpu' });
    } else if (deviceType === 'gpu') {
        epChain.push({ name: 'webnn', deviceType: 'gpu' });
    }
    epChain.push('wasm'); // 最终回退到 WASM (CPU)

    let lastError = null;
    for (const ep of epChain) {
        try {
            const session = await ort.InferenceSession.create(modelUrl, {
                executionProviders: [ep],
            });
            const epLabel = typeof ep === 'string' ? ep : `webnn-${ep.deviceType}`;
            sessions.set(modelId, { session, status: 'loaded', ep: epLabel });
            console.log(`[WebNN] Model ${modelId} loaded with EP: ${epLabel}`);
            return { success: true, ep: epLabel };
        } catch (e) {
            const epLabel = typeof ep === 'string' ? ep : `webnn-${ep.deviceType}`;
            console.warn(`[WebNN] Failed to load model ${modelId} with EP ${epLabel}: ${e.message}`);
            lastError = e;
        }
    }

    sessions.set(modelId, { session: null, status: 'error', ep: null, error: lastError?.message });
    return { success: false, ep: null, error: lastError?.message || 'All execution providers failed' };
}

/**
 * 卸载模型
 * @param {string} modelId - 模型标识符
 */
async function unloadModel(modelId) {
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
async function runInference(modelId, inputs) {
    const entry = sessions.get(modelId);
    if (!entry || entry.status !== 'loaded' || !entry.session) {
        throw new Error(`Model ${modelId} is not loaded`);
    }

    const { session } = entry;
    const feeds = {};

    for (const [name, tensorData] of Object.entries(inputs)) {
        const { data, dims, type } = tensorData;
        // 根据类型创建张量
        let tensorType = type || 'float32';
        let tensorDataArray;

        if (tensorType === 'float16') {
            // float16 使用 Uint16Array
            if (data instanceof Uint16Array) {
                tensorDataArray = data;
            } else if (data instanceof Float32Array) {
                // Float32 → Float16 转换
                tensorDataArray = new Uint16Array(data.length);
                for (let i = 0; i < data.length; i++) {
                    const f16 = float32ToFloat16(data[i]);
                    tensorDataArray[i] = f16;
                }
            } else {
                tensorDataArray = new Uint16Array(data);
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
    const outputs = {};
    for (const [name, tensor] of Object.entries(results)) {
        outputs[name] = {
            data: Array.from(tensor.data),
            dims: tensor.dims,
            type: tensor.type,
        };
    }

    return outputs;
}

/**
 * 获取所有模型状态
 * @returns {Object} 模型状态映射
 */
function getStatus() {
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
 * Float32 → Float16 转换（IEEE 754）
 * @param {number} value - Float32 值
 * @returns {number} Float16 位模式（存储在 Uint16 中）
 */
function float32ToFloat16(value) {
    const buffer = new ArrayBuffer(4);
    const f32 = new Float32Array(buffer);
    const u32 = new Uint32Array(buffer);
    f32[0] = value;
    const x = u32[0];

    let sign = (x >> 16) & 0x8000;
    let exponent = ((x >> 23) & 0xff) - 127;
    let mantissa = x & 0x7fffff;

    if (exponent >= 16) {
        // Overflow → Infinity
        return sign | 0x7c00;
    } else if (exponent >= -14) {
        // Normalized
        return sign | ((exponent + 15) << 10) | (mantissa >> 13);
    } else if (exponent >= -24) {
        // Subnormal
        mantissa |= 0x800000;
        return sign | (mantissa >> (-exponent - 2));
    } else {
        // Underflow → Zero
        return sign;
    }
}

// 导出接口供 IPC 调用
module.exports = {
    detectNPU,
    loadModel,
    unloadModel,
    runInference,
    getStatus,
};
