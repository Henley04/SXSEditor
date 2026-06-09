/**
 * WebNN 推理模块 — 在渲染进程中使用 onnxruntime-web + WebNN EP 执行 NPU 推理
 *
 * 此模块运行在 Electron 渲染进程中，通过 WebNN API 访问 NPU 硬件。
 * 模型文件通过自定义 protocol (onnx://) 从主进程安全获取。
 * 推理输入/输出通过 IPC 与主进程协调。
 */

// onnxruntime-web 通过 script 标签加载（ort.all.min.js），暴露为全局变量 ort
let ort = null;

async function ensureOrt() {
    if (ort) return ort;
    // UMD bundle exposes 'ort' as a global variable
    if (typeof window !== 'undefined' && window.ort) {
        ort = window.ort;
        console.log('[WebNN] onnxruntime-web loaded from global, version:', ort.env?.versions?.web || 'unknown');

        // Configure WASM paths — must point to directory containing .wasm files
        // In Electron dev mode, the HTML is served from http://localhost:9000/main_window/
        // and the WASM files are copied to the same directory by webpack CopyPlugin
        if (ort.env?.wasm) {
            ort.env.wasm.wasmPaths = './';
            ort.env.wasm.numThreads = 1; // Disable SharedArrayBuffer threading (not available in Electron sandbox)
            console.log('[WebNN] WASM paths configured: ./, numThreads: 1');
        }
    } else {
        throw new Error('onnxruntime-web not loaded. Ensure ort.all.min.js is included via <script> tag.');
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
 * 构建模型 URL
 * @param {string} modelPath - 模型文件路径（绝对路径或相对路径）
 * @returns {string} file:/// URL
 */
function buildModelUrl(modelPath) {
    // 绝对路径直接使用 file:/// 协议
    if (modelPath.match(/^[A-Za-z]:\\/) || modelPath.startsWith('/')) {
        return `file:///${modelPath.replace(/\\/g, '/')}`;
    }
    // 相对路径使用 onnx:// 协议（兼容旧路径）
    return `onnx://${modelPath}`;
}

/**
 * 从绝对路径提取相对于 onnx_models 目录的路径
 * @param {string} absPath - 绝对路径
 * @returns {string} 相对路径（如 'note_text_encoder.onnx' 或 'int8/f0_encoder.onnx'）
 */
function extractRelativePath(absPath) {
    // Try to find onnx_models directory in path
    const idx = absPath.indexOf('onnx_models');
    if (idx !== -1) {
        // Get path after 'onnx_models/' or 'onnx_models\'
        const after = absPath.slice(idx + 'onnx_models'.length).replace(/^[/\\]+/, '');
        return after.replace(/\\/g, '/');
    }
    // Fallback: just use the filename
    const parts = absPath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1];
}

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
    const relativePath = extractRelativePath(modelPath);
    const dataRelativeName = relativePath + '.data';
    try {
        const dataResult = await window.electronAPI.webnnReadModelFile(dataPath);
        if (dataResult.success && dataResult.data) {
            externalDataBuffers.push({
                path: dataRelativeName,
                data: dataResult.data,
            });
            console.log(`[WebNN] External data read: ${dataRelativeName} (${(dataResult.data.byteLength / 1024).toFixed(1)} KB)`);
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
async function loadModel(modelId, modelPath, options = { deviceType: 'npu' }, modelUrl = null) {
    await ensureOrt();

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
            const WEBNN_EP_TIMEOUT = 120000; // 120s per EP
            const session = await Promise.race([
                ort.InferenceSession.create(modelBuffer, {
                    ...sessionOptions,
                    executionProviders: [ep],
                }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`EP ${epLabel} timed out after ${WEBNN_EP_TIMEOUT / 1000}s`)), WEBNN_EP_TIMEOUT)
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
 * 批量 Float32 → Float16 转换（使用共享 ArrayBuffer，避免逐元素分配）
 * 比 float32ToFloat16() 单元素转换快 5-10 倍
 * @param {Float32Array} f32Src - 源 Float32 数据
 * @param {Uint16Array} u16Dst - 目标 Uint16Array（长度 >= f32Src.length）
 * @param {number} [len] - 转换元素数（默认 f32Src.length）
 */
function batchFloat32ToFloat16(f32Src, u16Dst, len) {
    len = len || f32Src.length;
    // 使用 4 字节共享 buffer，一次处理一个 float32 → uint16
    const buf = new ArrayBuffer(4);
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    for (let i = 0; i < len; i++) {
        f32[0] = f32Src[i];
        const x = u32[0];
        const sign = (x >> 16) & 0x8000;
        const exponent = ((x >> 23) & 0xff) - 127;
        const mantissa = x & 0x7fffff;
        if (exponent >= 16) {
            u16Dst[i] = sign | 0x7c00;
        } else if (exponent >= -14) {
            u16Dst[i] = sign | ((exponent + 15) << 10) | (mantissa >> 13);
        } else if (exponent >= -24) {
            u16Dst[i] = sign | ((mantissa | 0x800000) >> (-exponent - 2));
        } else {
            u16Dst[i] = sign;
        }
    }
}

/**
 * 批量 Float16 → Float32 转换（使用共享 ArrayBuffer，避免逐元素分配）
 * @param {Uint16Array} u16Src - 源 Float16 数据（Uint16Array）
 * @param {Float32Array} f32Dst - 目标 Float32Array（长度 >= u16Src.length）
 * @param {number} [len] - 转换元素数（默认 u16Src.length）
 */
function batchFloat16ToFloat32(u16Src, f32Dst, len) {
    len = len || u16Src.length;
    const buf = new ArrayBuffer(4);
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    for (let i = 0; i < len; i++) {
        const h = u16Src[i];
        const sign = (h & 0x8000) << 16;
        let exp = (h & 0x7c00) >> 10;
        const mant = h & 0x03ff;
        if (exp === 0) {
            if (mant !== 0) {
                let m = mant;
                let e = 1;
                m <<= 1;
                while ((m & 0x0400) === 0) { m <<= 1; e--; }
                u32[0] = sign | (((e + 1 - 15 + 127) << 23) | ((m & 0x03ff) << 13));
            } else {
                u32[0] = sign;
            }
        } else if (exp === 31) {
            u32[0] = sign | (255 << 23) | (mant << 13);
        } else {
            u32[0] = sign | ((exp - 15 + 127) << 23) | (mant << 13);
        }
        f32Dst[i] = f32[0];
    }
}

/**
 * Float32 → Float16 单元素转换（保留兼容性，仅用于零星转换）
 * @param {number} value - Float32 值
 * @returns {number} Float16 位模式（存储在 Uint16 中）
 */
function float32ToFloat16(value) {
    const buf = new ArrayBuffer(4);
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    f32[0] = value;
    const x = u32[0];
    const sign = (x >> 16) & 0x8000;
    const exponent = ((x >> 23) & 0xff) - 127;
    const mantissa = x & 0x7fffff;
    if (exponent >= 16) return sign | 0x7c00;
    if (exponent >= -14) return sign | ((exponent + 15) << 10) | (mantissa >> 13);
    if (exponent >= -24) return sign | ((mantissa | 0x800000) >> (-exponent - 2));
    return sign;
}

/**
 * 创建浮点张量（自动处理 float16/float32）
 * 使用批量转换替代逐元素转换
 */
function createFloatTensor(type, data, dims) {
    if (type === 'float16') {
        const len = data.length;
        const u16 = new Uint16Array(len);
        if (data instanceof Float32Array) {
            batchFloat32ToFloat16(data, u16, len);
        } else {
            // 非 Float32Array 输入，逐元素转换
            for (let i = 0; i < len; i++) u16[i] = float32ToFloat16(data[i]);
        }
        return new ort.Tensor('float16', u16, dims);
    }
    return new ort.Tensor('float32', data instanceof Float32Array ? data : new Float32Array(data), dims);
}

/**
 * 从模型输出中提取 Float32Array
 * 使用批量转换替代逐元素转换
 */
function outputToFloat32(tensor) {
    if (tensor.type === 'float16') {
        const u16 = tensor.data instanceof Uint16Array ? tensor.data : new Uint16Array(tensor.data);
        const f32 = new Float32Array(u16.length);
        batchFloat16ToFloat32(u16, f32, u16.length);
        return f32;
    }
    return tensor.data instanceof Float32Array ? tensor.data : new Float32Array(tensor.data);
}

/**
 * 在渲染进程中运行完整的合成推理管线（encoder + diffusion loop + vocoder）
 * 所有推理在本地执行，无 IPC 开销，最大化 NPU 利用率
 *
 * @param {Object} params
 * @param {Object} params.sequences - notesToSequences 的输出
 * @param {number} params.tokenCount - token 数量
 * @param {number} params.totalFrames - 总帧数
 * @param {Float32Array|null} params.ptMelData - 参考音频 mel 数据
 * @param {number} params.ptFrameCount - 参考音频帧数
 * @param {number} params.totalSteps - 扩散步数
 * @param {number} params.cfgStrength - CFG 强度
 * @param {number} params.cfgRescale - CFG rescale
 * @param {boolean} params.isFP16 - 是否 FP16
 * @returns {{ audioData: number[], totalFrames: number }}
 */
async function runSynthesis(params) {
    await ensureOrt();

    const {
        sequences, tokenCount, totalFrames,
        ptMelData, ptFrameCount,
        totalSteps, cfgStrength, cfgRescale,
        isFP16,
        npuDiffBatchSize = 4,
        npuVocoderBatchSize = 2,
    } = params;

    const MEL_DIM = 128;
    const EMBED_DIM = 512;
    const COND_DIM = 1024;
    const HOP_SIZE = 480;
    const VOCODER_CHUNK_FRAMES = 1008;
    const VOCODER_OVERLAP_FRAMES = 8;

    const floatType = isFP16 ? 'float16' : 'float32';
    const diffBatch = cfgStrength > 0 ? Math.max(2, npuDiffBatchSize) : 1;

    // Helper: run a session by modelId
    async function runSession(modelId, feeds) {
        const entry = sessions.get(modelId);
        if (!entry || entry.status !== 'loaded' || !entry.session) {
            throw new Error(`Model ${modelId} is not loaded`);
        }
        return await entry.session.run(feeds);
    }

    // ===== Stage 1: Encoder =====
    const tEnc0 = performance.now();

    const phonemeIds = new BigInt64Array(sequences.noteTextSeq.map(v => BigInt(v)));
    const pitchIds = new BigInt64Array(sequences.notePitchSeq.map(v => BigInt(v)));
    const typeIds = new BigInt64Array(sequences.noteTypeSeq.map(v => BigInt(v)));
    const f0IdsArr = new BigInt64Array(sequences.f0Ids.map(v => BigInt(v)));
    const tEncPrep = performance.now();

    // Run 4 encoders in parallel (they are independent)
    const t4 = performance.now();
    const [textResults, pitchResults, typeResults, f0Results] = await Promise.all([
        runSession('noteTextEncoder', { input_ids: new ort.Tensor('int64', phonemeIds, [1, tokenCount]) }),
        runSession('notePitchEncoder', { input_ids: new ort.Tensor('int64', pitchIds, [1, tokenCount]) }),
        runSession('noteTypeEncoder', { input_ids: new ort.Tensor('int64', typeIds, [1, tokenCount]) }),
        runSession('f0Encoder', { input_ids: new ort.Tensor('int64', f0IdsArr, [1, totalFrames]) }),
    ]);
    const encInferMs = performance.now() - t4;
    console.log(`[WebNN] 4 encoders (parallel): ${encInferMs.toFixed(0)}ms [tokens=${tokenCount}, f0Frames=${totalFrames}]`);
    console.log(`[WebNN]   enc prep: ${(t4 - tEncPrep).toFixed(1)}ms, infer: ${encInferMs.toFixed(1)}ms`);

    const tEncPost = performance.now();
    const textEmb = outputToFloat32(textResults['embeddings']);
    const pitchEmb = outputToFloat32(pitchResults['embeddings']);
    const typeEmb = outputToFloat32(typeResults['embeddings']);
    const f0Emb = outputToFloat32(f0Results['embeddings']);

    // Combine token embeddings
    const tokenEmb = new Float32Array(tokenCount * EMBED_DIM);
    for (let t = 0; t < tokenCount; t++) {
        for (let d = 0; d < EMBED_DIM; d++) {
            tokenEmb[t * EMBED_DIM + d] =
                textEmb[t * EMBED_DIM + d] +
                pitchEmb[t * EMBED_DIM + d] +
                typeEmb[t * EMBED_DIM + d];
        }
    }
    console.log(`[WebNN]   enc postprocess (combine embeddings): ${(performance.now() - tEncPost).toFixed(1)}ms`);

    // Preflow
    const tpf = performance.now();
    const featuresTensor = createFloatTensor(floatType, tokenEmb, [1, tokenCount, EMBED_DIM]);
    const preflowResults = await runSession('preflow', { features: featuresTensor });
    const processedTokenEmb = outputToFloat32(preflowResults['processed_features']);
    console.log(`[WebNN] preflow: ${(performance.now() - tpf).toFixed(0)}ms [${tokenCount}tokens × ${EMBED_DIM}]`);

    // Expand and combine with f0
    const tExpand = performance.now();
    const mel2token = sequences.mel2token;
    const totalCondFrames = ptFrameCount > 0 ? ptFrameCount + totalFrames : totalFrames;
    const condCodeData = new Float32Array(totalCondFrames * EMBED_DIM);
    for (let f = 0; f < totalFrames; f++) {
        const tokenIdx = mel2token[f];
        for (let d = 0; d < EMBED_DIM; d++) {
            const combined = processedTokenEmb[tokenIdx * EMBED_DIM + d] + f0Emb[f * EMBED_DIM + d];
            condCodeData[(ptFrameCount + f) * EMBED_DIM + d] = combined;
        }
    }
    console.log(`[WebNN]   expand+combine (mel2token+f0): ${(performance.now() - tExpand).toFixed(1)}ms [${totalCondFrames}condFrames]`);

    // Cond embedding
    const tce = performance.now();
    const condCodeTensor = createFloatTensor(floatType, condCodeData, [1, totalCondFrames, EMBED_DIM]);
    const condEmbResults = await runSession('condEmb', { cond_code: condCodeTensor });
    const combinedCond = outputToFloat32(condEmbResults['cond_embedding']);
    console.log(`[WebNN] condEmb: ${(performance.now() - tce).toFixed(0)}ms [${totalCondFrames}frames × ${COND_DIM}]`);

    console.log(`[WebNN] Encoder total: ${(performance.now() - tEnc0).toFixed(0)}ms`);

    // ===== Stage 2: Diffusion Loop =====
    const tDiff0 = performance.now();

    // Initialize xt with random noise
    const xt = { data: new Float32Array(totalFrames * MEL_DIM) };
    for (let i = 0; i < xt.data.length; i++) {
        xt.data[i] = Math.sqrt(1.0) * gaussianRandom();
    }

    const totalFramesWithPrompt = ptFrameCount + totalFrames;
    const frameMask = new Float32Array(totalFramesWithPrompt).fill(1);
    const xtInputBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);
    const cfgPredBuf = new Float32Array(totalFrames * MEL_DIM);
    const dt = 1.0 / totalSteps;

    // prompt frames don't change, copy once
    if (ptMelData) {
        for (let f = 0; f < ptFrameCount; f++) {
            for (let d = 0; d < MEL_DIM; d++) {
                xtInputBuf[f * MEL_DIM + d] = ptMelData[f * MEL_DIM + d];
            }
        }
    }

    // Pre-create CONSTANT tensors once (these don't change between diffusion steps)
    const condTensorConst = createFloatTensor(floatType, combinedCond, [1, totalFramesWithPrompt, COND_DIM]);
    const frameMaskTensorConst = createFloatTensor(floatType, frameMask, [1, totalFramesWithPrompt]);

    // CFG batch: merge conditional + unconditional into one inference call
    // When diffBatch > 2, duplicate rows to fill batch for better NPU utilization
    const cfgBatchBuf = new Float32Array(diffBatch * totalFramesWithPrompt * MEL_DIM);
    const cfgCondBuf = new Float32Array(diffBatch * totalFramesWithPrompt * COND_DIM);
    const cfgMaskBuf = new Float32Array(diffBatch * totalFramesWithPrompt);
    // Rows 0,2,4,... mask = all ones (conditional)
    // Rows 1,3,5,... mask = zeros for prompt, ones for target (unconditional)
    for (let r = 0; r < diffBatch; r++) {
        const rowOff = r * totalFramesWithPrompt;
        if (r % 2 === 0) {
            // conditional: all ones
            cfgMaskBuf.fill(1, rowOff, rowOff + totalFramesWithPrompt);
        } else {
            // unconditional: zeros for prompt, ones for target
            cfgMaskBuf.fill(1, rowOff + ptFrameCount, rowOff + totalFramesWithPrompt);
        }
    }
    // Cond rows: even rows = combinedCond, odd rows = zeros (unconditional)
    for (let r = 0; r < diffBatch; r += 2) {
        cfgCondBuf.set(combinedCond, r * totalFramesWithPrompt * COND_DIM);
    }

    let cfgXtTensor, cfgTTensor, cfgCondTensor, cfgMaskTensor;
    let cfgTBuf;
    if (floatType === 'float16') {
        cfgXtTensor = new ort.Tensor('float16', new Uint16Array(diffBatch * totalFramesWithPrompt * MEL_DIM), [diffBatch, totalFramesWithPrompt, MEL_DIM]);
        cfgTBuf = new Uint16Array(diffBatch);
        cfgTTensor = new ort.Tensor('float16', cfgTBuf, [diffBatch]);
        cfgCondTensor = createFloatTensor(floatType, cfgCondBuf, [diffBatch, totalFramesWithPrompt, COND_DIM]);
        cfgMaskTensor = createFloatTensor(floatType, cfgMaskBuf, [diffBatch, totalFramesWithPrompt]);
    } else {
        cfgXtTensor = new ort.Tensor('float32', cfgBatchBuf, [diffBatch, totalFramesWithPrompt, MEL_DIM]);
        cfgTBuf = new Float32Array(diffBatch);
        cfgTTensor = new ort.Tensor('float32', cfgTBuf, [diffBatch]);
        cfgCondTensor = createFloatTensor(floatType, cfgCondBuf, [diffBatch, totalFramesWithPrompt, COND_DIM]);
        cfgMaskTensor = createFloatTensor(floatType, cfgMaskBuf, [diffBatch, totalFramesWithPrompt]);
    }

    // Pre-allocate for no-CFG path
    let xtInputTensor, tTensorBuf, tTensor;
    if (floatType === 'float16') {
        xtInputTensor = new ort.Tensor('float16', new Uint16Array(totalFramesWithPrompt * MEL_DIM), [1, totalFramesWithPrompt, MEL_DIM]);
        tTensorBuf = new Uint16Array(1);
        tTensor = new ort.Tensor('float16', tTensorBuf, [1]);
    } else {
        xtInputTensor = new ort.Tensor('float32', xtInputBuf, [1, totalFramesWithPrompt, MEL_DIM]);
        tTensorBuf = new Float32Array(1);
        tTensor = new ort.Tensor('float32', tTensorBuf, [1]);
    }

    // Diffusion step timing stats
    let diffInferMin = Infinity, diffInferMax = 0, diffInferTotal = 0;
    let diffPrepMin = Infinity, diffPrepMax = 0, diffPrepTotal = 0;
    let diffCfgMin = Infinity, diffCfgMax = 0, diffCfgTotal = 0;

    for (let step = 0; step < totalSteps; step++) {
        const tVal = (step + 0.5) / totalSteps;

        // Update xt input buffer (only the non-prompt part changes)
        const tPrep0 = performance.now();
        for (let f = 0; f < totalFrames; f++) {
            for (let d = 0; d < MEL_DIM; d++) {
                xtInputBuf[(ptFrameCount + f) * MEL_DIM + d] = xt.data[f * MEL_DIM + d];
            }
        }

        const tStep = performance.now();

        if (cfgStrength > 0) {
            // === CFG batch: conditional + unconditional in one call ===
            const tPrep = performance.now();
            cfgBatchBuf.fill(0);
            for (let r = 0; r < diffBatch; r++) {
                const rowOff = r * totalFramesWithPrompt * MEL_DIM;
                if (r % 2 === 0) {
                    cfgBatchBuf.set(xtInputBuf, rowOff);
                } else {
                    for (let f = 0; f < totalFrames; f++) {
                        for (let d = 0; d < MEL_DIM; d++) {
                            cfgBatchBuf[rowOff + (ptFrameCount + f) * MEL_DIM + d] = xt.data[f * MEL_DIM + d];
                        }
                    }
                }
            }

            if (floatType === 'float16') {
                batchFloat32ToFloat16(cfgBatchBuf, cfgXtTensor.data, cfgBatchBuf.length);
                for (let r = 0; r < diffBatch; r++) cfgTBuf[r] = float32ToFloat16(tVal);
            } else {
                cfgTBuf.fill(tVal);
            }
            const prepMs = performance.now() - tPrep;

            // NPU inference
            const tInfer = performance.now();
            const batchResults = await runSession('diffStep', {
                xt_input: cfgXtTensor, t: cfgTTensor, cond: cfgCondTensor, xt_mask: cfgMaskTensor,
            });
            const batchPred = outputToFloat32(batchResults['flow_pred']);
            const inferMs = performance.now() - tInfer;

            // CFG post-processing: merged into 2 passes instead of 3
            // Pass 1: compute CFG values + accumulate means
            const tCfg = performance.now();
            const targetLen = totalFrames * MEL_DIM;
            let posSum = 0, cfgAdjSum = 0;
            for (let f = 0; f < totalFrames; f++) {
                const condSrc = (ptFrameCount + f) * MEL_DIM;
                const uncondSrc = (totalFramesWithPrompt + ptFrameCount + f) * MEL_DIM;
                const flatBase = f * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    const condVal = batchPred[condSrc + d];
                    const uncondVal = batchPred[uncondSrc + d];
                    posSum += condVal;
                    const cfgVal = condVal + cfgStrength * (condVal - uncondVal);
                    cfgPredBuf[flatBase + d] = cfgVal;
                    cfgAdjSum += cfgVal;
                }
            }
            const posMean = posSum / targetLen;
            const cfgAdjMean = cfgAdjSum / targetLen;
            // Pass 2: compute variance + apply rescale + update xt (merged)
            let posVarSum = 0, cfgAdjVarSum = 0;
            for (let i = 0; i < targetLen; i++) {
                const pv = batchPred[ptFrameCount * MEL_DIM + i] - posMean;
                posVarSum += pv * pv;
                const cd = cfgPredBuf[i] - cfgAdjMean;
                cfgAdjVarSum += cd * cd;
            }
            const rescale = cfgRescale * (Math.sqrt(posVarSum / targetLen) + 1e-6) / (Math.sqrt(cfgAdjVarSum / targetLen) + 1e-6);
            for (let i = 0; i < targetLen; i++) {
                xt.data[i] += dt * (cfgPredBuf[i] * rescale);
            }
            const cfgMs = performance.now() - tCfg;

            // Track stats
            const prepTotalMs = prepMs + (tPrep - tPrep0);
            diffPrepMin = Math.min(diffPrepMin, prepTotalMs);
            diffPrepMax = Math.max(diffPrepMax, prepTotalMs);
            diffPrepTotal += prepTotalMs;
            diffInferMin = Math.min(diffInferMin, inferMs);
            diffInferMax = Math.max(diffInferMax, inferMs);
            diffInferTotal += inferMs;
            diffCfgMin = Math.min(diffCfgMin, cfgMs);
            diffCfgMax = Math.max(diffCfgMax, cfgMs);
            diffCfgTotal += cfgMs;

            if (step === 0 || step === totalSteps - 1) {
                console.log(`[WebNN] diffStep batch=${diffBatch} [${step}/${totalSteps}]: total=${(performance.now() - tStep).toFixed(0)}ms (prep=${prepMs.toFixed(1)} + infer=${inferMs.toFixed(1)} + cfg=${cfgMs.toFixed(1)})`);
            }
        } else {
            // === No CFG: single batch=1 call ===
            const tPrep = performance.now();
            if (floatType === 'float16') {
                batchFloat32ToFloat16(xtInputBuf, xtInputTensor.data, xtInputBuf.length);
                tTensorBuf[0] = float32ToFloat16(tVal);
            } else {
                tTensorBuf[0] = tVal;
            }
            const prepMs = performance.now() - tPrep;

            const tInfer = performance.now();
            const predResults = await runSession('diffStep', {
                xt_input: xtInputTensor, t: tTensor, cond: condTensorConst, xt_mask: frameMaskTensorConst,
            });
            const predData = outputToFloat32(predResults['flow_pred']);
            const inferMs = performance.now() - tInfer;

            const prepTotalMs = prepMs + (tPrep - tPrep0);
            diffPrepMin = Math.min(diffPrepMin, prepTotalMs);
            diffPrepMax = Math.max(diffPrepMax, prepTotalMs);
            diffPrepTotal += prepTotalMs;
            diffInferMin = Math.min(diffInferMin, inferMs);
            diffInferMax = Math.max(diffInferMax, inferMs);
            diffInferTotal += inferMs;

            if (step === 0 || step === totalSteps - 1) {
                console.log(`[WebNN] diffStep batch=1 [${step}/${totalSteps}]: total=${(performance.now() - tStep).toFixed(0)}ms (prep=${prepMs.toFixed(1)} + infer=${inferMs.toFixed(1)})`);
            }

            for (let f = 0; f < totalFrames; f++) {
                const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    xt.data[f * MEL_DIM + d] += dt * predData[tgtOffset + d];
                }
            }
        }
    }

    const diffTotalMs = performance.now() - tDiff0;
    console.log(`[WebNN] Diffusion total: ${diffTotalMs.toFixed(0)}ms (${totalSteps} steps, batch=${diffBatch})`);
    console.log(`[WebNN]   prep  — min=${diffPrepMin.toFixed(1)} max=${diffPrepMax.toFixed(1)} avg=${(diffPrepTotal / totalSteps).toFixed(1)} total=${diffPrepTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   infer — min=${diffInferMin.toFixed(1)} max=${diffInferMax.toFixed(1)} avg=${(diffInferTotal / totalSteps).toFixed(1)} total=${diffInferTotal.toFixed(0)}ms`);
    if (cfgStrength > 0) {
        console.log(`[WebNN]   cfg   — min=${diffCfgMin.toFixed(1)} max=${diffCfgMax.toFixed(1)} avg=${(diffCfgTotal / totalSteps).toFixed(1)} total=${diffCfgTotal.toFixed(0)}ms`);
    }
    const diffOverhead = diffTotalMs - diffPrepTotal - diffInferTotal - diffCfgTotal;
    console.log(`[WebNN]   overhead (tensor alloc, result copy): ${diffOverhead.toFixed(0)}ms`);

    // ===== Stage 3: Vocoder =====
    const tVoc0 = performance.now();
    const totalSamples = totalFrames * HOP_SIZE;
    let audioData;
    let vocChunkCount = 0, vocInferTotal = 0, vocPrepTotal = 0, vocPostTotal = 0;

    if (totalFrames <= VOCODER_CHUNK_FRAMES) {
        const tVocPrep = performance.now();
        const melTensor = createFloatTensor(floatType, xt.data, [1, totalFrames, MEL_DIM]);
        const vocPrepMs = performance.now() - tVocPrep;

        const tVocInfer = performance.now();
        const vocoderResults = await runSession('vocoder', { mel: melTensor });
        const vocInferMs = performance.now() - tVocInfer;

        const tVocPost = performance.now();
        const waveform = outputToFloat32(vocoderResults['waveform']);
        const trimmed = waveform.subarray(0, Math.min(waveform.length, totalSamples));
        audioData = trimmed.slice(); // TypedArray.slice() 比 Array.from() 快得多
        const vocPostMs = performance.now() - tVocPost;

        vocChunkCount = 1;
        vocPrepTotal = vocPrepMs;
        vocInferTotal = vocInferMs;
        vocPostTotal = vocPostMs;
        console.log(`[WebNN] vocoder (single): prep=${vocPrepMs.toFixed(1)} infer=${vocInferMs.toFixed(1)} post=${vocPostMs.toFixed(1)} [${totalFrames}frames → ${totalSamples}samples]`);
    } else {
        // Chunked vocoder with batch processing
        const chunkSize = VOCODER_CHUNK_FRAMES;
        const overlapFrames = VOCODER_OVERLAP_FRAMES;
        const vocBatch = Math.max(1, npuVocoderBatchSize);
        const output = new Float32Array(totalSamples);
        const weightSum = new Float32Array(totalSamples);
        const stepFrames = chunkSize - overlapFrames;
        const fadeSamples = overlapFrames * HOP_SIZE;
        const fadeWindow = new Float32Array(fadeSamples);
        for (let i = 0; i < fadeSamples; i++) {
            fadeWindow[i] = 0.5 * (1 - Math.cos(Math.PI * i / fadeSamples));
        }

        let offset = 0;
        while (offset < totalFrames) {
            // Collect up to vocBatch chunks
            const batchMels = [];
            const batchInfos = [];
            let maxChunkFrames = 0;

            for (let b = 0; b < vocBatch && offset < totalFrames; b++) {
                const end = Math.min(offset + chunkSize, totalFrames);
                const chunkFrames = end - offset;
                const chunkMel = new Float32Array(chunkFrames * MEL_DIM);
                for (let f = 0; f < chunkFrames; f++) {
                    for (let d = 0; d < MEL_DIM; d++) {
                        chunkMel[f * MEL_DIM + d] = xt.data[(offset + f) * MEL_DIM + d];
                    }
                }
                batchMels.push(chunkMel);
                batchInfos.push({ offset, chunkFrames, end });
                maxChunkFrames = Math.max(maxChunkFrames, chunkFrames);
                offset += stepFrames;
            }

            const batchSize = batchMels.length;
            vocChunkCount += batchSize;
            const tVocBatchPrep = performance.now();

            if (batchSize === 1) {
                // Single chunk, run directly
                const info = batchInfos[0];
                const melTensor = createFloatTensor(floatType, batchMels[0], [1, info.chunkFrames, MEL_DIM]);
                const prepMs = performance.now() - tVocBatchPrep;

                const tVocBatchInfer = performance.now();
                const vocoderResults = await runSession('vocoder', { mel: melTensor });
                const inferMs = performance.now() - tVocBatchInfer;

                const tVocBatchPost = performance.now();
                const waveform = outputToFloat32(vocoderResults['waveform']);
                const chunkSamples = info.chunkFrames * HOP_SIZE;
                const startSample = info.offset * HOP_SIZE;

                for (let i = 0; i < chunkSamples; i++) {
                    const idx = startSample + i;
                    if (idx < totalSamples) {
                        let w = 1.0;
                        if (info.offset > 0 && i < fadeSamples) w = fadeWindow[i];
                        if (info.end < totalFrames && i >= chunkSamples - fadeSamples) w = fadeWindow[chunkSamples - 1 - i];
                        output[idx] += waveform[i] * w;
                        weightSum[idx] += w;
                    }
                }
                const postMs = performance.now() - tVocBatchPost;
                vocPrepTotal += prepMs;
                vocInferTotal += inferMs;
                vocPostTotal += postMs;
                console.log(`[WebNN]   vocoder chunk [${info.offset}-${info.end}/${totalFrames}]: prep=${prepMs.toFixed(1)} infer=${inferMs.toFixed(1)} post=${postMs.toFixed(1)}`);
            } else {
                // Batch inference: pad all chunks to maxChunkFrames
                const batchData = new Float32Array(batchSize * maxChunkFrames * MEL_DIM);
                for (let b = 0; b < batchSize; b++) {
                    const mel = batchMels[b];
                    const frames = batchInfos[b].chunkFrames;
                    for (let f = 0; f < frames; f++) {
                        for (let d = 0; d < MEL_DIM; d++) {
                            batchData[(b * maxChunkFrames + f) * MEL_DIM + d] = mel[f * MEL_DIM + d];
                        }
                    }
                }

                const melTensor = createFloatTensor(floatType, batchData, [batchSize, maxChunkFrames, MEL_DIM]);
                const prepMs = performance.now() - tVocBatchPrep;

                const tVocBatchInfer = performance.now();
                const vocoderResults = await runSession('vocoder', { mel: melTensor });
                const inferMs = performance.now() - tVocBatchInfer;

                const tVocBatchPost = performance.now();
                const batchWaveform = outputToFloat32(vocoderResults['waveform']);
                const samplesPerChunk = maxChunkFrames * HOP_SIZE;

                for (let b = 0; b < batchSize; b++) {
                    const info = batchInfos[b];
                    const chunkSamples = info.chunkFrames * HOP_SIZE;
                    const startSample = info.offset * HOP_SIZE;
                    const waveOff = b * samplesPerChunk;

                    for (let i = 0; i < chunkSamples; i++) {
                        const idx = startSample + i;
                        if (idx < totalSamples) {
                            let w = 1.0;
                            if (info.offset > 0 && i < fadeSamples) w = fadeWindow[i];
                            if (info.end < totalFrames && i >= chunkSamples - fadeSamples) w = fadeWindow[chunkSamples - 1 - i];
                            output[idx] += batchWaveform[waveOff + i] * w;
                            weightSum[idx] += w;
                        }
                    }
                }
                const postMs = performance.now() - tVocBatchPost;
                vocPrepTotal += prepMs;
                vocInferTotal += inferMs;
                vocPostTotal += postMs;
                const chunkRange = batchInfos.map(i => `${i.offset}-${i.end}`).join(', ');
                console.log(`[WebNN]   vocoder batch=${batchSize} [${chunkRange}]: prep=${prepMs.toFixed(1)} infer=${inferMs.toFixed(1)} post=${postMs.toFixed(1)}`);
            }
        }
        for (let i = 0; i < totalSamples; i++) {
            if (weightSum[i] > 0) output[i] /= weightSum[i];
        }
        audioData = output.slice(); // TypedArray.slice() 替代 Array.from()
    }

    const vocTotalMs = performance.now() - tVoc0;
    console.log(`[WebNN] Vocoder total: ${vocTotalMs.toFixed(0)}ms (${vocChunkCount} chunks, batch=${npuVocoderBatchSize})`);
    console.log(`[WebNN]   prep  — total=${vocPrepTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   infer — total=${vocInferTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   post  — total=${vocPostTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   overhead: ${(vocTotalMs - vocPrepTotal - vocInferTotal - vocPostTotal).toFixed(0)}ms`);

    const synthTotalMs = performance.now() - tEnc0;
    const encMs = tDiff0 - tEnc0;
    const diffMs = diffTotalMs;
    const vocMs = vocTotalMs;
    console.log(`[WebNN] ===== Synthesis Summary =====`);
    console.log(`[WebNN]   Input: ${tokenCount} tokens, ${totalFrames} frames, ${totalSteps} diffusion steps, batch=${diffBatch}`);
    console.log(`[WebNN]   Encoder:    ${encMs.toFixed(0)}ms (${(encMs / synthTotalMs * 100).toFixed(1)}%)`);
    console.log(`[WebNN]   Diffusion:  ${diffMs.toFixed(0)}ms (${(diffMs / synthTotalMs * 100).toFixed(1)}%) — infer avg ${(diffInferTotal / totalSteps).toFixed(0)}ms/step`);
    console.log(`[WebNN]   Vocoder:    ${vocMs.toFixed(0)}ms (${(vocMs / synthTotalMs * 100).toFixed(1)}%)`);
    console.log(`[WebNN]   Total:      ${synthTotalMs.toFixed(0)}ms`);
    console.log(`[WebNN]   Output: ${totalFrames} frames, ${(totalFrames * HOP_SIZE / 24000).toFixed(1)}s audio`);
    console.log(`[WebNN] ================================`);

    return { audioData, totalFrames };
}

function gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * 批量合成：同时处理 2 个片段，diffusion batch=4（2 片段 × 2 CFG）
 * @param {Array} paramsArray - 2 个 runSynthesis 参数对象的数组
 * @returns {Array} 2 个 { audioData, totalFrames } 的数组
 */
async function runSynthesisBatch(paramsArray) {
    if (!paramsArray || paramsArray.length === 0) return [];
    if (paramsArray.length === 1) return [await runSynthesis(paramsArray[0])];

    await ensureOrt();

    const MEL_DIM = 128;
    const EMBED_DIM = 512;
    const COND_DIM = 1024;
    const HOP_SIZE = 480;
    const VOCODER_CHUNK_FRAMES = 1008;
    const VOCODER_OVERLAP_FRAMES = 8;

    const isFP16 = paramsArray[0].isFP16;
    const floatType = isFP16 ? 'float16' : 'float32';
    const diffBatch = 4; // 2 segments × 2 CFG

    async function runSession(modelId, feeds) {
        const entry = sessions.get(modelId);
        if (!entry || entry.status !== 'loaded' || !entry.session) {
            throw new Error(`Model ${modelId} is not loaded`);
        }
        return await entry.session.run(feeds);
    }

    // ===== Stage 1: Encode both segments in parallel =====
    const tEnc0 = performance.now();
    const segData = [];

    for (const params of paramsArray) {
        const { sequences, tokenCount, totalFrames, ptMelData, ptFrameCount } = params;

        const phonemeIds = new BigInt64Array(sequences.noteTextSeq.map(v => BigInt(v)));
        const pitchIds = new BigInt64Array(sequences.notePitchSeq.map(v => BigInt(v)));
        const typeIds = new BigInt64Array(sequences.noteTypeSeq.map(v => BigInt(v)));
        const f0IdsArr = new BigInt64Array(sequences.f0Ids.map(v => BigInt(v)));

        const [textResults, pitchResults, typeResults, f0Results] = await Promise.all([
            runSession('noteTextEncoder', { input_ids: new ort.Tensor('int64', phonemeIds, [1, tokenCount]) }),
            runSession('notePitchEncoder', { input_ids: new ort.Tensor('int64', pitchIds, [1, tokenCount]) }),
            runSession('noteTypeEncoder', { input_ids: new ort.Tensor('int64', typeIds, [1, tokenCount]) }),
            runSession('f0Encoder', { input_ids: new ort.Tensor('int64', f0IdsArr, [1, totalFrames]) }),
        ]);

        const textEmb = outputToFloat32(textResults['embeddings']);
        const pitchEmb = outputToFloat32(pitchResults['embeddings']);
        const typeEmb = outputToFloat32(typeResults['embeddings']);
        const f0Emb = outputToFloat32(f0Results['embeddings']);

        const tokenEmb = new Float32Array(tokenCount * EMBED_DIM);
        for (let t = 0; t < tokenCount; t++) {
            for (let d = 0; d < EMBED_DIM; d++) {
                tokenEmb[t * EMBED_DIM + d] =
                    textEmb[t * EMBED_DIM + d] +
                    pitchEmb[t * EMBED_DIM + d] +
                    typeEmb[t * EMBED_DIM + d];
            }
        }

        const featuresTensor = createFloatTensor(floatType, tokenEmb, [1, tokenCount, EMBED_DIM]);
        const preflowResults = await runSession('preflow', { features: featuresTensor });
        const processedTokenEmb = outputToFloat32(preflowResults['processed_features']);

        const mel2token = sequences.mel2token;
        const totalCondFrames = ptFrameCount > 0 ? ptFrameCount + totalFrames : totalFrames;
        const condCodeData = new Float32Array(totalCondFrames * EMBED_DIM);
        for (let f = 0; f < totalFrames; f++) {
            const tokenIdx = mel2token[f];
            for (let d = 0; d < EMBED_DIM; d++) {
                condCodeData[(ptFrameCount + f) * EMBED_DIM + d] =
                    processedTokenEmb[tokenIdx * EMBED_DIM + d] + f0Emb[f * EMBED_DIM + d];
            }
        }

        const condCodeTensor = createFloatTensor(floatType, condCodeData, [1, totalCondFrames, EMBED_DIM]);
        const condEmbResults = await runSession('condEmb', { cond_code: condCodeTensor });
        const combinedCond = outputToFloat32(condEmbResults['cond_embedding']);

        segData.push({
            totalFrames, tokenCount, ptMelData, ptFrameCount, combinedCond,
            totalCondFrames,
            totalFramesWithPrompt: ptFrameCount + totalFrames,
            totalSteps: params.totalSteps || 32,
            cfgStrength: params.cfgStrength ?? 3.0,
            cfgRescale: params.cfgRescale ?? 0.75,
            npuVocoderBatchSize: params.npuVocoderBatchSize || 1,
        });
    }
    const batchEncMs = performance.now() - tEnc0;
    console.log(`[WebNN] Batch encoder (2 segments): ${batchEncMs.toFixed(0)}ms [seg0: ${segData[0].tokenCount}tok/${segData[0].totalFrames}frm, seg1: ${segData[1].tokenCount}tok/${segData[1].totalFrames}frm]`);

    // ===== Stage 2: Batched Diffusion Loop (batch=4) =====
    const tDiff0 = performance.now();
    const maxTotalFramesWithPrompt = Math.max(...segData.map(s => s.totalFramesWithPrompt));
    const maxTotalFrames = Math.max(...segData.map(s => s.totalFrames));
    const totalSteps = segData[0].totalSteps;

    // Initialize xt for both segments
    const xts = segData.map(s => {
        const xt = new Float32Array(s.totalFrames * MEL_DIM);
        for (let i = 0; i < xt.length; i++) xt[i] = gaussianRandom();
        return xt;
    });

    // Build batch=4 tensors padded to maxTotalFramesWithPrompt
    const cfgBatchBuf = new Float32Array(diffBatch * maxTotalFramesWithPrompt * MEL_DIM);
    const cfgCondBuf = new Float32Array(diffBatch * maxTotalFramesWithPrompt * COND_DIM);
    const cfgMaskBuf = new Float32Array(diffBatch * maxTotalFramesWithPrompt);
    const xtInputBufs = segData.map(s => new Float32Array(s.totalFramesWithPrompt * MEL_DIM));
    const cfgPredBufs = segData.map(s => new Float32Array(s.totalFrames * MEL_DIM));

    // Set up cond and mask for batch=4:
    // Row 0: seg0 conditional, Row 1: seg0 unconditional
    // Row 2: seg1 conditional, Row 3: seg1 unconditional
    for (let si = 0; si < 2; si++) {
        const s = segData[si];
        const condRow = si * 2;
        const uncondRow = si * 2 + 1;
        const condOff = condRow * maxTotalFramesWithPrompt * COND_DIM;
        const maskCondOff = condRow * maxTotalFramesWithPrompt;
        const maskUncondOff = uncondRow * maxTotalFramesWithPrompt;

        cfgCondBuf.set(s.combinedCond, condOff);
        cfgMaskBuf.fill(1, maskCondOff, maskCondOff + s.totalFramesWithPrompt);
        cfgMaskBuf.fill(1, maskUncondOff + s.ptFrameCount, maskUncondOff + s.totalFramesWithPrompt);

        if (s.ptMelData) {
            for (let f = 0; f < s.ptFrameCount; f++) {
                for (let d = 0; d < MEL_DIM; d++) {
                    xtInputBufs[si][f * MEL_DIM + d] = s.ptMelData[f * MEL_DIM + d];
                }
            }
        }
    }

    let cfgXtTensor, cfgTTensor, cfgCondTensor, cfgMaskTensor;
    let cfgTBuf;
    if (floatType === 'float16') {
        cfgXtTensor = new ort.Tensor('float16', new Uint16Array(diffBatch * maxTotalFramesWithPrompt * MEL_DIM), [diffBatch, maxTotalFramesWithPrompt, MEL_DIM]);
        cfgTBuf = new Uint16Array(diffBatch);
        cfgTTensor = new ort.Tensor('float16', cfgTBuf, [diffBatch]);
        cfgCondTensor = createFloatTensor(floatType, cfgCondBuf, [diffBatch, maxTotalFramesWithPrompt, COND_DIM]);
        cfgMaskTensor = createFloatTensor(floatType, cfgMaskBuf, [diffBatch, maxTotalFramesWithPrompt]);
    } else {
        cfgXtTensor = new ort.Tensor('float32', cfgBatchBuf, [diffBatch, maxTotalFramesWithPrompt, MEL_DIM]);
        cfgTBuf = new Float32Array(diffBatch);
        cfgTTensor = new ort.Tensor('float32', cfgTBuf, [diffBatch]);
        cfgCondTensor = createFloatTensor(floatType, cfgCondBuf, [diffBatch, maxTotalFramesWithPrompt, COND_DIM]);
        cfgMaskTensor = createFloatTensor(floatType, cfgMaskBuf, [diffBatch, maxTotalFramesWithPrompt]);
    }

    const dt = 1.0 / totalSteps;
    const cfgStrength0 = segData[0].cfgStrength;
    const cfgRescale0 = segData[0].cfgRescale;

    // Batch diffusion timing stats
    let bDiffInferMin = Infinity, bDiffInferMax = 0, bDiffInferTotal = 0;
    let bDiffPrepTotal = 0, bDiffCfgTotal = 0;

    for (let step = 0; step < totalSteps; step++) {
        const tVal = (step + 0.5) / totalSteps;
        const tStepPrep = performance.now();
        cfgBatchBuf.fill(0);

        for (let si = 0; si < 2; si++) {
            const s = segData[si];
            const xt = xts[si];
            const xtInputBuf = xtInputBufs[si];
            const condRow = si * 2;
            const uncondRow = si * 2 + 1;
            const condRowOff = condRow * maxTotalFramesWithPrompt * MEL_DIM;
            const uncondRowOff = uncondRow * maxTotalFramesWithPrompt * MEL_DIM;

            for (let f = 0; f < s.totalFrames; f++) {
                for (let d = 0; d < MEL_DIM; d++) {
                    xtInputBuf[(s.ptFrameCount + f) * MEL_DIM + d] = xt[f * MEL_DIM + d];
                }
            }
            cfgBatchBuf.set(xtInputBuf, condRowOff);
            for (let f = 0; f < s.totalFrames; f++) {
                for (let d = 0; d < MEL_DIM; d++) {
                    cfgBatchBuf[uncondRowOff + (s.ptFrameCount + f) * MEL_DIM + d] = xt[f * MEL_DIM + d];
                }
            }
        }

        if (floatType === 'float16') {
            batchFloat32ToFloat16(cfgBatchBuf, cfgXtTensor.data, cfgBatchBuf.length);
            for (let r = 0; r < diffBatch; r++) cfgTBuf[r] = float32ToFloat16(tVal);
        } else {
            cfgTBuf.fill(tVal);
        }

        const prepMs = performance.now() - tStepPrep;

        const tStepInfer = performance.now();
        const batchResults = await runSession('diffStep', {
            xt_input: cfgXtTensor, t: cfgTTensor, cond: cfgCondTensor, xt_mask: cfgMaskTensor,
        });
        const batchPred = outputToFloat32(batchResults['flow_pred']);
        const inferMs = performance.now() - tStepInfer;

        const tStepCfg = performance.now();
        // Apply CFG per segment
        for (let si = 0; si < 2; si++) {
            const s = segData[si];
            const xt = xts[si];
            const cfgPredBuf = cfgPredBufs[si];
            const condRow = si * 2;
            const uncondRow = si * 2 + 1;
            const condRowOff = condRow * maxTotalFramesWithPrompt * MEL_DIM;
            const uncondRowOff = uncondRow * maxTotalFramesWithPrompt * MEL_DIM;
            const targetLen = s.totalFrames * MEL_DIM;

            let posSum = 0, cfgAdjSum = 0;
            for (let f = 0; f < s.totalFrames; f++) {
                const condSrc = condRowOff + (s.ptFrameCount + f) * MEL_DIM;
                const uncondSrc = uncondRowOff + (s.ptFrameCount + f) * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    const condVal = batchPred[condSrc + d];
                    const uncondVal = batchPred[uncondSrc + d];
                    posSum += condVal;
                    const cfgVal = condVal + cfgStrength0 * (condVal - uncondVal);
                    cfgPredBuf[f * MEL_DIM + d] = cfgVal;
                    cfgAdjSum += cfgVal;
                }
            }
            const posMean = posSum / targetLen;
            const cfgAdjMean = cfgAdjSum / targetLen;
            let posVarSum = 0, cfgAdjVarSum = 0;
            for (let f = 0; f < s.totalFrames; f++) {
                const condSrc = condRowOff + (s.ptFrameCount + f) * MEL_DIM;
                for (let d = 0; d < MEL_DIM; d++) {
                    const pv = batchPred[condSrc + d] - posMean;
                    posVarSum += pv * pv;
                    const cd = cfgPredBuf[f * MEL_DIM + d] - cfgAdjMean;
                    cfgAdjVarSum += cd * cd;
                }
            }
            const posStd = Math.sqrt(posVarSum / targetLen + 1e-8);
            const cfgAdjStd = Math.sqrt(cfgAdjVarSum / targetLen + 1e-8);
            const rescale = posStd / (cfgAdjStd + 1e-8);

            for (let f = 0; f < s.totalFrames; f++) {
                for (let d = 0; d < MEL_DIM; d++) {
                    const cfgVal = cfgPredBuf[f * MEL_DIM + d];
                    const rescaledVal = cfgRescale0 * (cfgVal * rescale) + (1 - cfgRescale0) * cfgVal;
                    xt[f * MEL_DIM + d] += rescaledVal * dt;
                }
            }
        }
        const cfgMs = performance.now() - tStepCfg;

        bDiffPrepTotal += prepMs;
        bDiffInferTotal += inferMs;
        bDiffInferMin = Math.min(bDiffInferMin, inferMs);
        bDiffInferMax = Math.max(bDiffInferMax, inferMs);
        bDiffCfgTotal += cfgMs;

        if (step === 0 || step === totalSteps - 1) {
            console.log(`[WebNN]   batch diffStep [${step}/${totalSteps}]: prep=${prepMs.toFixed(1)} infer=${inferMs.toFixed(1)} cfg=${cfgMs.toFixed(1)}`);
        }
    }
    const batchDiffMs = performance.now() - tDiff0;
    console.log(`[WebNN] Batch diffusion (2 segs, batch=4): ${batchDiffMs.toFixed(0)}ms (${totalSteps} steps)`);
    console.log(`[WebNN]   prep  — total=${bDiffPrepTotal.toFixed(0)}ms avg=${(bDiffPrepTotal / totalSteps).toFixed(1)}ms`);
    console.log(`[WebNN]   infer — min=${bDiffInferMin.toFixed(1)} max=${bDiffInferMax.toFixed(1)} avg=${(bDiffInferTotal / totalSteps).toFixed(1)} total=${bDiffInferTotal.toFixed(0)}ms`);
    console.log(`[WebNN]   cfg   — total=${bDiffCfgTotal.toFixed(0)}ms avg=${(bDiffCfgTotal / totalSteps).toFixed(1)}ms`);

    // ===== Stage 3: Vocoder per segment =====
    const results = [];
    for (let si = 0; si < 2; si++) {
        const s = segData[si];
        const xt = xts[si];
        const totalSamples = s.totalFrames * HOP_SIZE;
        let audioData;

        if (s.totalFrames <= VOCODER_CHUNK_FRAMES) {
            const melTensor = createFloatTensor(floatType, xt, [1, s.totalFrames, MEL_DIM]);
            const vocoderResults = await runSession('vocoder', { mel: melTensor });
            const waveform = outputToFloat32(vocoderResults['waveform']);
            audioData = Array.from(waveform.subarray(0, Math.min(waveform.length, totalSamples)));
        } else {
            const chunkSize = VOCODER_CHUNK_FRAMES;
            const overlapFrames = VOCODER_OVERLAP_FRAMES;
            const vocBatch = Math.max(1, s.npuVocoderBatchSize);
            const output = new Float32Array(totalSamples);
            const weightSum = new Float32Array(totalSamples);
            const stepFrames = chunkSize - overlapFrames;
            const fadeSamples = overlapFrames * HOP_SIZE;
            const fadeWindow = new Float32Array(fadeSamples);
            for (let i = 0; i < fadeSamples; i++) {
                fadeWindow[i] = 0.5 * (1 - Math.cos(Math.PI * i / fadeSamples));
            }

            let offset = 0;
            while (offset < s.totalFrames) {
                const batchMels = [];
                const batchInfos = [];
                let maxChunkFrames = 0;

                for (let b = 0; b < vocBatch && offset < s.totalFrames; b++) {
                    const end = Math.min(offset + chunkSize, s.totalFrames);
                    const chunkFrames = end - offset;
                    const chunkMel = new Float32Array(chunkFrames * MEL_DIM);
                    for (let f = 0; f < chunkFrames; f++) {
                        for (let d = 0; d < MEL_DIM; d++) {
                            chunkMel[f * MEL_DIM + d] = xt[(offset + f) * MEL_DIM + d];
                        }
                    }
                    batchMels.push(chunkMel);
                    batchInfos.push({ offset, chunkFrames, end });
                    maxChunkFrames = Math.max(maxChunkFrames, chunkFrames);
                    offset += stepFrames;
                }

                const batchSize = batchMels.length;
                if (batchSize === 1) {
                    const info = batchInfos[0];
                    const melTensor = createFloatTensor(floatType, batchMels[0], [1, info.chunkFrames, MEL_DIM]);
                    const vocoderResults = await runSession('vocoder', { mel: melTensor });
                    const waveform = outputToFloat32(vocoderResults['waveform']);
                    const chunkSamples = info.chunkFrames * HOP_SIZE;
                    const startSample = info.offset * HOP_SIZE;
                    for (let i = 0; i < chunkSamples; i++) {
                        const idx = startSample + i;
                        if (idx < totalSamples) {
                            let w = 1.0;
                            if (info.offset > 0 && i < fadeSamples) w = fadeWindow[i];
                            if (info.end < s.totalFrames && i >= chunkSamples - fadeSamples) w = fadeWindow[chunkSamples - 1 - i];
                            output[idx] += waveform[i] * w;
                            weightSum[idx] += w;
                        }
                    }
                } else {
                    const batchData = new Float32Array(batchSize * maxChunkFrames * MEL_DIM);
                    for (let b = 0; b < batchSize; b++) {
                        const mel = batchMels[b];
                        const frames = batchInfos[b].chunkFrames;
                        for (let f = 0; f < frames; f++) {
                            for (let d = 0; d < MEL_DIM; d++) {
                                batchData[(b * maxChunkFrames + f) * MEL_DIM + d] = mel[f * MEL_DIM + d];
                            }
                        }
                    }
                    const melTensor = createFloatTensor(floatType, batchData, [batchSize, maxChunkFrames, MEL_DIM]);
                    const vocoderResults = await runSession('vocoder', { mel: melTensor });
                    const batchWaveform = outputToFloat32(vocoderResults['waveform']);
                    const samplesPerChunk = maxChunkFrames * HOP_SIZE;

                    for (let b = 0; b < batchSize; b++) {
                        const info = batchInfos[b];
                        const chunkSamples = info.chunkFrames * HOP_SIZE;
                        const startSample = info.offset * HOP_SIZE;
                        const waveOff = b * samplesPerChunk;
                        for (let i = 0; i < chunkSamples; i++) {
                            const idx = startSample + i;
                            if (idx < totalSamples) {
                                let w = 1.0;
                                if (info.offset > 0 && i < fadeSamples) w = fadeWindow[i];
                                if (info.end < s.totalFrames && i >= chunkSamples - fadeSamples) w = fadeWindow[chunkSamples - 1 - i];
                                output[idx] += batchWaveform[waveOff + i] * w;
                                weightSum[idx] += w;
                            }
                        }
                    }
                }
            }
            for (let i = 0; i < totalSamples; i++) {
                if (weightSum[i] > 0) output[i] /= weightSum[i];
            }
            audioData = output.slice(); // TypedArray.slice() 替代 Array.from()
        }

        results.push({ audioData, totalFrames: s.totalFrames });
    }

    const batchSynthMs = performance.now() - tEnc0;
    console.log(`[WebNN] ===== Batch Synthesis Summary =====`);
    console.log(`[WebNN]   Segments: 2 (seg0: ${segData[0].totalFrames}frm, seg1: ${segData[1].totalFrames}frm)`);
    console.log(`[WebNN]   Encoder:    ${batchEncMs.toFixed(0)}ms`);
    console.log(`[WebNN]   Diffusion:  ${batchDiffMs.toFixed(0)}ms (${totalSteps} steps, batch=4) — infer avg ${(bDiffInferTotal / totalSteps).toFixed(0)}ms/step`);
    console.log(`[WebNN]   Total:      ${batchSynthMs.toFixed(0)}ms`);
    console.log(`[WebNN] =====================================`);
    return results;
}

// 导出接口供 IPC 调用
module.exports = {
    detectNPU,
    loadModel,
    unloadModel,
    runInference,
    runSynthesis,
    runSynthesisBatch,
    getStatus,
};
