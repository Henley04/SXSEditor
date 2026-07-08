const path = require('node:path');
const fs = require('node:fs');
const ort = require('onnxruntime-node');
const { getGraphicsCached } = require('../../utils/gpuCache');
const { ensureGPUInfo } = require('../../main/gpuInfo');
const { classifyDevice } = require('../../utils/deviceClassifier');
const { EMBED_DIM, MEL_DIM, COND_DIM, HOP_SIZE, SAMPLE_RATE, MODEL_SIZES, MODEL_GROUPS, ONNX_MODEL_FILES, NPU_STATIC_SEQ_LEN, IPC_TIMEOUT_INFERENCE } = require('./constants');
const { float32ToF16Buffer } = require('./utils');
const { requestInference } = require('./webnnIpc');

/**
 * 获取主窗口的 webContents（WebNN IPC 必须发送到主窗口，因为只有主窗口注册了 WebNN 处理器）
 * 通过 windowManager 模块获取主窗口引用（避免直接 require 导致的循环依赖）
 */
let _getMainWindowRef = null;
function getMainWindowWebContents() {
    const { BrowserWindow } = require('electron');
    // 尝试通过 windowManager 获取主窗口
    if (!_getMainWindowRef) {
        try {
            _getMainWindowRef = require('../../main/windowManager').getMainWindow;
        } catch (_) { _getMainWindowRef = null; }
    }
    if (_getMainWindowRef) {
        const mainWin = _getMainWindowRef();
        if (mainWin && !mainWin.isDestroyed()) return mainWin.webContents;
    }
    // Fallback: 遍历所有窗口，跳过分片编辑器等子窗口
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
        if (!w.isDestroyed() && w.webContents) return w.webContents;
    }
    return null;
}

const DUMMY_TEST_INPUTS_FP32 = {
    noteTextEncoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([1n, 2n, 3n]), [1, 3]) },
    notePitchEncoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([60n, 62n, 64n]), [1, 3]) },
    noteTypeEncoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([0n, 0n, 0n]), [1, 3]) },
    f0Encoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([100n, 100n, 100n]), [1, 3]) },
    preflow: { features: new ort.Tensor('float32', new Float32Array(3 * EMBED_DIM), [1, 3, EMBED_DIM]) },
    condEmb: { cond_code: new ort.Tensor('float32', new Float32Array(3 * EMBED_DIM), [1, 3, EMBED_DIM]) },
    diffStep: {
        xt_input: new ort.Tensor('float32', new Float32Array(3 * MEL_DIM), [1, 3, MEL_DIM]),
        t: new ort.Tensor('float32', new Float32Array([0.5]), [1]),
        cond: new ort.Tensor('float32', new Float32Array(3 * COND_DIM), [1, 3, COND_DIM]),
        xt_mask: new ort.Tensor('float32', new Float32Array([1, 1, 1]), [1, 3]),
    },
    vocoder: { mel: new ort.Tensor('float32', new Float32Array(3 * MEL_DIM), [1, 3, MEL_DIM]) },
    // SiFiGAN 双输入验证：mel + f0（sessionKey 仍为 'vocoder'，通过 overrideDummyInputs 传入）
    sifigan: {
        mel: new ort.Tensor('float32', new Float32Array(3 * MEL_DIM), [1, 3, MEL_DIM]),
        f0: new ort.Tensor('float32', new Float32Array(3), [1, 3, 1]),
    },
    melTransform: { audio: new ort.Tensor('float32', new Float32Array(SAMPLE_RATE), [1, SAMPLE_RATE]) },
};

const DUMMY_TEST_INPUTS_FP16 = {
    noteTextEncoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([1n, 2n, 3n]), [1, 3]) },
    notePitchEncoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([60n, 62n, 64n]), [1, 3]) },
    noteTypeEncoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([0n, 0n, 0n]), [1, 3]) },
    f0Encoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([100n, 100n, 100n]), [1, 3]) },
    preflow: { features: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(3 * EMBED_DIM)), [1, 3, EMBED_DIM]) },
    condEmb: { cond_code: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(3 * EMBED_DIM)), [1, 3, EMBED_DIM]) },
    diffStep: {
        xt_input: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(3 * MEL_DIM)), [1, 3, MEL_DIM]),
        t: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array([0.5])), [1]),
        cond: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(3 * COND_DIM)), [1, 3, COND_DIM]),
        xt_mask: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array([1, 1, 1])), [1, 3]),
    },
    vocoder: { mel: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(3 * MEL_DIM)), [1, 3, MEL_DIM]) },
    // SiFiGAN 双输入验证（FP16）
    sifigan: {
        mel: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(3 * MEL_DIM)), [1, 3, MEL_DIM]),
        f0: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(3)), [1, 3, 1]),
    },
    melTransform: { audio: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(SAMPLE_RATE)), [1, SAMPLE_RATE]) },
};

// NPU 静态形状模型的验证输入（维度固定为 NPU_STATIC_SEQ_LEN=2048）
const DUMMY_TEST_INPUTS_NPU = {
    noteTextEncoder: { input_ids: new ort.Tensor('int64', new BigInt64Array(NPU_STATIC_SEQ_LEN), [1, NPU_STATIC_SEQ_LEN]) },
    notePitchEncoder: { input_ids: new ort.Tensor('int64', new BigInt64Array(NPU_STATIC_SEQ_LEN), [1, NPU_STATIC_SEQ_LEN]) },
    noteTypeEncoder: { input_ids: new ort.Tensor('int64', new BigInt64Array(NPU_STATIC_SEQ_LEN), [1, NPU_STATIC_SEQ_LEN]) },
    f0Encoder: { input_ids: new ort.Tensor('int64', new BigInt64Array(NPU_STATIC_SEQ_LEN), [1, NPU_STATIC_SEQ_LEN]) },
    preflow: { features: new ort.Tensor('float32', new Float32Array(NPU_STATIC_SEQ_LEN * EMBED_DIM), [1, NPU_STATIC_SEQ_LEN, EMBED_DIM]) },
    condEmb: { cond_code: new ort.Tensor('float32', new Float32Array(NPU_STATIC_SEQ_LEN * EMBED_DIM), [1, NPU_STATIC_SEQ_LEN, EMBED_DIM]) },
    diffStep: {
        xt_input: new ort.Tensor('float32', new Float32Array(NPU_STATIC_SEQ_LEN * MEL_DIM), [1, NPU_STATIC_SEQ_LEN, MEL_DIM]),
        t: new ort.Tensor('float32', new Float32Array([0.5]), [1]),
        cond: new ort.Tensor('float32', new Float32Array(NPU_STATIC_SEQ_LEN * COND_DIM), [1, NPU_STATIC_SEQ_LEN, COND_DIM]),
        xt_mask: new ort.Tensor('float32', new Float32Array(NPU_STATIC_SEQ_LEN), [1, NPU_STATIC_SEQ_LEN]),
    },
    vocoder: { mel: new ort.Tensor('float32', new Float32Array(NPU_STATIC_SEQ_LEN * MEL_DIM), [1, NPU_STATIC_SEQ_LEN, MEL_DIM]) },
    melTransform: { audio: new ort.Tensor('float32', new Float32Array(SAMPLE_RATE), [1, SAMPLE_RATE]) },
};

/** @deprecated Using classifyDevice 替代 */
function isDiscreteGPUByName(name) {
    const dt = classifyDevice(name, 0, undefined);
    if (dt === 'discrete-gpu') return true;
    if (dt === 'integrated-gpu' || dt === 'npu') return false;
    return undefined;
}

function gpuCacheToDevices(controllers) {
    const devices = [];
    for (let i = 0; i < controllers.length; i++) {
        const c = controllers[i];
        const vramBytes = (c.memoryTotal || c.vram || 0) * 1024 * 1024;
        const gb = vramBytes / (1024 * 1024 * 1024);
        const vramStr = gb >= 1 ? `${Math.round(gb * 10) / 10} GB` : `${Math.round(vramBytes / (1024 * 1024))} MB`;
        const vendorName = c.vendor || '';
        const deviceType = classifyDevice(c.model, vramBytes, undefined);
        devices.push({
            name: c.model || '',
            type: 1,
            deviceType,
            isDiscrete: deviceType === 'discrete-gpu',
            dxgiAdapterNumber: i,
            vram: vramStr,
            vramBytes: vramBytes,
            vendor: vendorName,
            source: 'systeminformation',
        });
    }
    return devices;
}

async function enumerateGPUsViaNodeGpuInfo(cachedControllers) {
    try {
        if (cachedControllers && cachedControllers.length > 0) {
            return gpuCacheToDevices(cachedControllers);
        }
        const graphics = await getGraphicsCached();
        const controllers = graphics.controllers || [];
        if (controllers.length === 0) return [];
        return gpuCacheToDevices(controllers);
    } catch (e) {
        console.warn('[OnnxSVSPipeline] systeminformation GPU enumeration failed:', e.message);
        return [];
    }
}

async function enumerateDMLDevicesInProcess(modelDir) {
    const probeModel = path.join(modelDir, 'note_text_encoder.onnx');
    try {
        await fs.promises.access(probeModel);
    } catch (_) {
        return [];
    }

    const iconv = require('iconv-lite');
    const origWrite = process.stderr.write.bind(process.stderr);
    let stderrBuf = '';
    process.stderr.write = function(chunk, encoding, callback) {
        if (typeof chunk === 'string') stderrBuf += chunk;
        else if (Buffer.isBuffer(chunk)) stderrBuf += iconv.decode(chunk, process.platform === 'win32' ? 'gbk' : 'utf-8');
        return origWrite(chunk, encoding, callback);
    };

    ort.env.logLevel = 'verbose';

    try {
        try {
            const session = await ort.InferenceSession.create(probeModel, {
                executionProviders: [{ name: 'dml', deviceId: 0 }, 'cpu']
            });
            session.release();
        } catch (_) {}

        await new Promise(r => setTimeout(r, 500));
    } finally {
        process.stderr.write = origWrite;
        ort.env.logLevel = 'warning';
    }

    const devices = [];
    const lines = stderrBuf.split('\n');
    for (const line of lines) {
        if (!line.includes('Discovered OrtHardwareDevice')) continue;

        const descMatch = line.match(/Description=([^,\]]+)/);
        const typeMatch = line.match(/type:(\d+)/);
        const discreteMatch = line.match(/Discrete=(\d)/);
        const adapterMatch = line.match(/DxgiAdapterNumber=(\d+)/);
        const vramMatch = line.match(/DxgiVideoMemory=(\d+)\s*([MG]B)/);
        const vendorMatch = line.match(/vendor:([^,\]]+)/);

        if (!descMatch || !typeMatch) continue;

        const gpuName = descMatch[1].trim();
        const typeVal = parseInt(typeMatch[1]);

        const isDiscreteFromFlag = discreteMatch ? discreteMatch[1] === '1' : undefined;
        let vramStr = undefined;
        let vramBytes = 0;
        if (vramMatch) {
            const vramVal = parseInt(vramMatch[1]);
            const vramUnit = vramMatch[2];
            vramStr = `${vramVal} ${vramUnit}`;
            if (vramUnit === 'GB') vramBytes = vramVal * 1024 * 1024 * 1024;
            else if (vramUnit === 'MB') vramBytes = vramVal * 1024 * 1024;
        }

        const deviceType = classifyDevice(gpuName, vramBytes, isDiscreteFromFlag);

        devices.push({
            name: gpuName,
            type: typeVal,
            deviceType,
            isDiscrete: deviceType === 'discrete-gpu',
            dxgiAdapterNumber: adapterMatch ? parseInt(adapterMatch[1]) : undefined,
            vram: vramStr,
            vramBytes: vramBytes,
            vendor: vendorMatch ? vendorMatch[1].trim() : '',
            source: 'dml',
        });
    }

    return devices;
}

async function enumerateDMLDevices(modelDir, cachedControllers) {
    let devices = await enumerateGPUsViaNodeGpuInfo(cachedControllers);

    if (devices.length > 0) {
        console.log(`[OnnxSVSPipeline] systeminformation enumeration found ${devices.length}  GPU device(s)`);
        return devices;
    }

    console.log('[OnnxSVSPipeline] systeminformation found no GPU, trying ONNX Runtime verbose log enumeration...');
    if (modelDir) {
        devices = await enumerateDMLDevicesInProcess(modelDir);
    }

    return devices;
}

async function detectBestGPU(modelDir) {
    let devices;
    try {
        // Pass cached GPU controllers so enumerateGPUsViaNodeGpuInfo can use them
        // instead of falling through to enumerateDMLDevicesInProcess (which can native-crash)
        const controllers = await ensureGPUInfo();
        devices = await enumerateDMLDevices(modelDir, controllers);
    } catch (e) {
        console.warn('[OnnxSVSPipeline] enumerateDMLDevices failed:', e.message);
        devices = [];
    }

    if (devices.length === 0) {
        console.log('[OnnxSVSPipeline] No GPU devices found, will use CPU');
        return { deviceId: undefined, name: '', devices: [] };
    }

    console.log(`[OnnxSVSPipeline] Found ${devices.length} device(s):`);
    for (const d of devices) {
        const vramStr = d.vram ? ` (${d.vram})` : '';
        const typeLabel = { 'discrete-gpu': '[独显]', 'integrated-gpu': '[核显]', 'npu': '[NPU]', 'cpu': '[CPU]' }[d.deviceType] || (d.isDiscrete ? '[独显]' : '[核显]');
        const adapterStr = d.dxgiAdapterNumber !== undefined ? ` deviceId=${d.dxgiAdapterNumber}` : '';
        const sourceStr = d.source ? ` (${d.source})` : '';
        console.log(`  - ${d.name}${vramStr} ${typeLabel}${adapterStr}${sourceStr}`);
    }

    const gpus = devices.filter(d => d.dxgiAdapterNumber !== undefined && d.deviceType !== 'npu');
    if (gpus.length === 0) {
        return { deviceId: undefined, name: '', devices };
    }

    const discrete = gpus.filter(d => d.isDiscrete);
    let best;
    if (discrete.length > 0) {
        best = discrete.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
    } else {
        best = gpus.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
    }
    const vramStr = best.vram ? ` (${best.vram})` : '';
    const typeLabel = { 'discrete-gpu': '[独显]', 'integrated-gpu': '[核显]', 'npu': '[NPU]', 'cpu': '[CPU]' }[best.deviceType] || (best.isDiscrete ? '[独显]' : '[核显]');

    console.log(`[OnnxSVSPipeline] Auto-selected: ${best.name}${vramStr} ${typeLabel} (deviceId=${best.dxgiAdapterNumber})`);

    return {
        deviceId: best.dxgiAdapterNumber,
        name: `${best.name}${vramStr}`,
        devices,
    };
}

/**
 * 智能设备选择 — 按优先级 GPU(独显) > NPU > GPU(核显) > CPU 选择主设备
 * @param {Array} devices - 设备列表
 * @param {boolean} npuAvailable - NPU 是否available（WebNN 检测结果）
 * @returns {{ deviceId: number|undefined, deviceType: string, name: string, devices: Array }}
 */
function selectBestDevice(devices, npuAvailable = false) {
    if (devices.length === 0) {
        return { deviceId: undefined, deviceType: 'cpu', name: 'CPU', devices: [] };
    }

    // 按优先级排序
    const priority = { 'discrete-gpu': 0, 'npu': 1, 'integrated-gpu': 2, 'cpu': 3 };
    const availableDevices = devices.filter(d => {
        // NPU 设备需要 WebNN available
        if (d.deviceType === 'npu' && !npuAvailable) return false;
        // GPU 设备需要有 dxgiAdapterNumber
        if ((d.deviceType === 'discrete-gpu' || d.deviceType === 'integrated-gpu') && d.dxgiAdapterNumber === undefined) return false;
        return true;
    });

    if (availableDevices.length === 0) {
        return { deviceId: undefined, deviceType: 'cpu', name: 'CPU', devices };
    }

    // 按优先级和显存排序
    availableDevices.sort((a, b) => {
        const pa = priority[a.deviceType] ?? 4;
        const pb = priority[b.deviceType] ?? 4;
        if (pa !== pb) return pa - pb;
        return (b.vramBytes || 0) - (a.vramBytes || 0);
    });

    const best = availableDevices[0];
    return {
        deviceId: best.dxgiAdapterNumber,
        deviceType: best.deviceType,
        name: best.name,
        devices,
    };
}

/**
 * 智能Model-设备分配
 * @param {Array} devices - 设备列表
 * @param {boolean} npuAvailable - NPU 是否available
 * @returns {Object} modelDeviceMapping — { modelGroup: { deviceType, deviceId, process } }
 */
function buildModelDeviceMapping(devices, npuAvailable = false) {
    const best = selectBestDevice(devices, npuAvailable);
    const hasDiscreteGPU = devices.some(d => d.deviceType === 'discrete-gpu' && d.dxgiAdapterNumber !== undefined);
    const discreteGPU = devices.find(d => d.deviceType === 'discrete-gpu' && d.dxgiAdapterNumber !== undefined);
    const integratedGPU = devices.find(d => d.deviceType === 'integrated-gpu' && d.dxgiAdapterNumber !== undefined);

    const mapping = {};

    for (const [groupId, group] of Object.entries(MODEL_GROUPS)) {
        // 计算Model组总大小
        const totalSize = group.models.reduce((sum, m) => sum + (MODEL_SIZES[m] || 0), 0);

        if (totalSize > 100 * 1024 * 1024) {
            // 大Model组（>100MB）→ GPU（主进程 DirectML）
            if (hasDiscreteGPU) {
                mapping[groupId] = { deviceType: 'discrete-gpu', deviceId: discreteGPU.dxgiAdapterNumber, process: 'main' };
            } else if (integratedGPU) {
                mapping[groupId] = { deviceType: 'integrated-gpu', deviceId: integratedGPU.dxgiAdapterNumber, process: 'main' };
            } else {
                mapping[groupId] = { deviceType: 'cpu', deviceId: undefined, process: 'main' };
            }
        } else if (totalSize > 10 * 1024 * 1024) {
            // 中等Model组（10-100MB）→ GPU 优先
            if (hasDiscreteGPU) {
                mapping[groupId] = { deviceType: 'discrete-gpu', deviceId: discreteGPU.dxgiAdapterNumber, process: 'main' };
            } else if (integratedGPU) {
                mapping[groupId] = { deviceType: 'integrated-gpu', deviceId: integratedGPU.dxgiAdapterNumber, process: 'main' };
            } else if (npuAvailable) {
                mapping[groupId] = { deviceType: 'npu', deviceId: 'npu-webnn', process: 'renderer' };
            } else {
                mapping[groupId] = { deviceType: 'cpu', deviceId: undefined, process: 'main' };
            }
        } else {
            // 小Model组（<10MB）→ NPU 优先（释放 GPU 显存），否则 CPU
            if (npuAvailable) {
                mapping[groupId] = { deviceType: 'npu', deviceId: 'npu-webnn', process: 'renderer' };
            } else {
                mapping[groupId] = { deviceType: 'cpu', deviceId: undefined, process: 'main' };
            }
        }
    }

    return mapping;
}

/**
 * 替代 detectBestGPU 的新函数，返回包含 deviceType 和 modelDeviceMapping 的结果
 * @param {string} modelDir - Model目录
 * @param {boolean} npuAvailable - NPU 是否available
 * @returns {{ deviceId: number|undefined, deviceType: string, name: string, devices: Array, modelDeviceMapping: Object }}
 */
async function detectBestDevice(modelDir, npuAvailable = false) {
    let devices = await enumerateDMLDevices(modelDir);

    if (devices.length === 0) {
        console.log('[OnnxSVSPipeline] No devices found, will use CPU');
        return { deviceId: undefined, deviceType: 'cpu', name: 'CPU', devices: [], modelDeviceMapping: {} };
    }

    console.log(`[OnnxSVSPipeline] Found ${devices.length} device(s):`);
    for (const d of devices) {
        const vramStr = d.vram ? ` (${d.vram})` : '';
        const typeLabel = { 'discrete-gpu': '[独显]', 'integrated-gpu': '[核显]', 'npu': '[NPU]', 'cpu': '[CPU]' }[d.deviceType] || (d.isDiscrete ? '[独显]' : '[核显]');
        const adapterStr = d.dxgiAdapterNumber !== undefined ? ` deviceId=${d.dxgiAdapterNumber}` : '';
        const sourceStr = d.source ? ` (${d.source})` : '';
        console.log(`  - ${d.name}${vramStr} ${typeLabel}${adapterStr}${sourceStr}`);
    }

    const best = selectBestDevice(devices, npuAvailable);
    const modelDeviceMapping = buildModelDeviceMapping(devices, npuAvailable);

    return {
        deviceId: best.deviceId,
        deviceType: best.deviceType,
        name: best.name,
        devices,
        modelDeviceMapping,
    };
}

async function createSessionWithValidation(modelPath, sessionKey, gpuDeviceName, dmlDeviceId, isFP16, useStaticShapes = false, overrideDummyInputs = null) {
    const modelName = path.basename(modelPath);
    // overrideDummyInputs: 调用方可传入自定义 dummy 输入（如 SiFiGAN 双输入 mel+f0），为 null 时走原有查找逻辑
    const dummyInputs = overrideDummyInputs || (useStaticShapes
        ? DUMMY_TEST_INPUTS_NPU[sessionKey]
        : (isFP16 ? DUMMY_TEST_INPUTS_FP16[sessionKey] : DUMMY_TEST_INPUTS_FP32[sessionKey]));
    const gpuTag = gpuDeviceName ? ` [${gpuDeviceName}]` : '';

    if (!dummyInputs) {
        const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
        return { session, ep: 'cpu', warmedUp: false };
    }

    // NPU 静态形状模型直接创建 CPU 会话（跳过 DML 验证，NPU 模型不适合 DML）
    if (useStaticShapes) {
        // NPU 模型已离线优化（onnxsim），跳过运行时图优化以加速加载
        const session = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'basic',
        });
        // 跳过推理验证 — NPU 模型已通过离线验证，且大模型（如 diff_step 423MB）的验证耗时过长
        console.log(`[OnnxSVSPipeline] ${modelName} loaded [CPU] (NPU static shapes, opt=basic)`);
        return { session, ep: 'cpu', warmedUp: false };
    }

    let dmlSession = null;
    try {
        const dmlOpts = typeof dmlDeviceId === 'number'
            ? { name: 'dml', deviceId: dmlDeviceId }
            : 'dml';
        dmlSession = await ort.InferenceSession.create(modelPath, {
            executionProviders: [dmlOpts, 'cpu'],
            // DirectML EP 要求 disable memory pattern + sequential execution；否则 DML 可能过度预分配 GPU 内存池。
            enableMemPattern: false,
            executionMode: 'sequential',
        });
        await dmlSession.run(dummyInputs);
        console.log(`[OnnxSVSPipeline] ${modelName} loaded [DML]${gpuTag} (inference verified)`);
        return { session: dmlSession, ep: 'dml', warmedUp: true };
    } catch (dmlErr) {
        if (dmlSession) {
            try { dmlSession.release(); } catch (e) {
                console.warn(`[OnnxSVSPipeline] Failed to release DML session (${modelName}):`, e.message);
            }
        }
        const reason = dmlErr.message.includes('Reshape')
            ? 'DML 不支持动态 Reshape (89个节点)'
            : dmlErr.message.includes('ConvTranspose')
            ? 'DML 不支持大 stride ConvTranspose (stride=480)'
            : `DML 推理验证失败 (${dmlErr.message.substring(0, 60).split('\n')[0]})`;
        console.log(`[OnnxSVSPipeline] ${modelName} DML load failed, reason: ${reason}`);
    }

    // DML不available，尝试UsingDML优化版本Model（在CPU上运行）
    const dmlModelPath = modelPath.replace('.onnx', '_dml.onnx');
    if (dmlModelPath !== modelPath) {
        let dmlModelExists = false;
        try { await fs.promises.access(dmlModelPath); dmlModelExists = true; } catch (_) {}
        if (dmlModelExists) {
            try {
                const dmlModelSession = await ort.InferenceSession.create(dmlModelPath, { executionProviders: ['cpu'] });
                try {
                    await dmlModelSession.run(dummyInputs);
                } catch (runErr) {
                    try { dmlModelSession.release(); } catch (_) {}
                    throw runErr;
                }
                return { session: dmlModelSession, ep: 'cpu', warmedUp: true };
            } catch (dmlModelErr) {
                console.log(`[OnnxSVSPipeline] ${path.basename(dmlModelPath)} DML-optimized model load failed: ${dmlModelErr.message.substring(0, 60).split('\n')[0]}`);
            }
        }
    }

    const cpuSession = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    try {
        await cpuSession.run(dummyInputs);
    } catch (runErr) {
        // 当 DML EP 不可用而回退到 CPU 时，dummy 输入可能与模型的静态形状不匹配。常见情况：
        //   1. *_dml.onnx 静态形状模型（diff_step seq_len=2048, vocoder seq_len=500）
        //      与动态 dummy（seq_len=3）不匹配 → "invalid dimensions"
        //   2. mel_transform.onnx 形状为静态 [1,24000]，dummy 也是 [1,1440] → "invalid dimensions"
        // 模型已成功加载（create 成功），验证失败仅因 dummy 不匹配，
        // 跳过验证直接返回会话，首次实际推理时自然验证。动态形状的 fp16 模型不受影响。
        const errSummary = runErr.message.substring(0, 80).split('\n')[0];
        const isDummyMismatch = runErr.message.includes('invalid dimensions')
            || runErr.message.includes('is missing in \'feeds\'');
        if (isDummyMismatch) {
            console.warn(`[OnnxSVSPipeline] ${modelName} CPU validation skipped (dummy mismatch): ${errSummary}`);
            console.log(`[OnnxSVSPipeline] ${modelName} loaded [CPU] (validation skipped)`);
            return { session: cpuSession, ep: 'cpu', warmedUp: false };
        }
        try { cpuSession.release(); } catch (_) {}
        throw runErr;
    }
    console.log(`[OnnxSVSPipeline] ${modelName} loaded [CPU] (inference verified)`);
    return { session: cpuSession, ep: 'cpu', warmedUp: true };
}

/**
 * WebNN 会话代理 — 将 session.run() 调用通过 IPC 转发到渲染进程的 WebNN 推理引擎
 */
class WebNNSessionProxy {
    constructor(modelId) {
        this.modelId = modelId;
    }

    async run(feeds) {
        const { ipcMain } = require('electron');

        const wc = getMainWindowWebContents();
        if (!wc) throw new Error('No renderer window for WebNN inference');

        // 序列化输入张量
        const serializedInputs = {};
        for (const [name, tensor] of Object.entries(feeds)) {
            serializedInputs[name] = {
                data: tensor.data,
                dims: tensor.dims,
                type: tensor.type,
            };
        }

        return new Promise((resolve, reject) => {
            requestInference(wc, this.modelId, serializedInputs, `WebNN inference timeout (${this.modelId})`)
                .then((result) => {
                    if (result && result.error) {
                        reject(new Error(result.error));
                        return;
                    }
                    // 反序列化输出张量
                    // data 现在是 TypedArray（Float32Array/Uint16Array）或 string[]（int64）
                    const outputTensors = {};
                    for (const [name, out] of Object.entries(result)) {
                        let typedData;
                        if (out.type === 'float16') {
                            typedData = out.data instanceof Uint16Array ? out.data : new Uint16Array(out.data);
                        } else if (out.type === 'int64') {
                            typedData = Array.isArray(out.data)
                                ? BigInt64Array.from(out.data.map(v => BigInt(v)))
                                : out.data;
                        } else {
                            typedData = out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
                        }
                        outputTensors[name] = new ort.Tensor(out.type || 'float32', typedData, out.dims);
                    }
                    resolve(outputTensors);
                })
                .catch(reject);
        });
    }

    release() {
        // WebNN Model卸载由 pipeline dispose 统一处理
    }
}

module.exports = {
    getMainWindowWebContents,
    classifyDevice,
    isDiscreteGPUByName,
    gpuCacheToDevices,
    enumerateGPUsViaNodeGpuInfo,
    enumerateDMLDevicesInProcess,
    enumerateDMLDevices,
    detectBestGPU,
    selectBestDevice,
    buildModelDeviceMapping,
    detectBestDevice,
    createSessionWithValidation,
    WebNNSessionProxy,
    DUMMY_TEST_INPUTS_FP32,
    DUMMY_TEST_INPUTS_FP16,
};
