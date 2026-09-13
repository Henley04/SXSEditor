/**
 * WebNN 推理模块 — NPU/GPU 检测逻辑
 */

/* global MLGraphBuilder */

import { ensureOrt } from './ortSetup.js';

// 缓存检测结果（包含 benchmark）
let _detectionCache = null;
// W12: 缓存时间戳，成功结果超过 CACHE_TTL_MS 后也需重新检测
let _cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // W12: 5 分钟后重新检测（与主进程一致）

// W13: benchmark 维度需反映真实模型工作负载。过小的 [1,8]×[8,8] matmul 会让
// NPU 的固定调度/上传开销主导，导致可用 NPU 被误判为 npuSlow 而回退到 WASM。
// 256 足够大以摊薄 NPU 启动开销，又能保持 benchmark 轻量。
const BENCH_DIM = 256;
const BENCH_RUNS = 5;
// W13: 阈值放宽到 2.0× — 更大 matmul 下 NPU 若仍 >2× 慢于 CPU 才视为不可用
const NPU_SLOW_THRESHOLD = 2.0;

// createContext 在 NPU 冷启动（驱动/编译器首次初始化）时可能长时间不返回，
// 没有超时保护会让整个检测卡死，主进程只能以 "Detection timeout" 收场。
const CONTEXT_TIMEOUT_MS = 15000;

/**
 * 给 promise 加超时，超时后返回 { timedOut: true } 而不是永久挂起。
 */
function withTimeout(promise, ms, label) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ timedOut: true, error: `${label} timed out after ${ms}ms` });
        }, ms);
        Promise.resolve(promise).then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ value });
            },
            (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ error: error && error.message ? error.message : String(error) });
            },
        );
    });
}

/**
 * 安全创建 WebNN context：同时防御同步抛错与永久挂起。
 * createContext 在部分实现上会同步 throw（而非返回 rejected promise），
 * 直接 await 会把异常抛出 detectNPU()，使整个检测以 "xxx is not a function"
 * 之类的错误失败，WebNN 被误报为不可用。
 */
function createContextSafe(deviceType) {
    try {
        return withTimeout(
            navigator.ml.createContext({ deviceType }),
            CONTEXT_TIMEOUT_MS,
            `createContext(${deviceType})`,
        );
    } catch (e) {
        return Promise.resolve({ error: e && e.message ? e.message : String(e) });
    }
}

/**
 * 后台静默预热 onnxruntime-web。
 *
 * 关键：NPU/WebNN 检测只依赖 navigator.ml，完全不需要 ort。原先 detectNPU()
 * 在检查 navigator.ml 之前无条件 `await ensureOrt()`，而 ort.all.min.js 有
 * 5-10MB：一旦脚本加载失败（路径/CSP/打包缺失）或缓慢，检测就会抛错或超时，
 * 把本来可用的 WebNN 误报为“不可用”。改为 fire-and-forget 预热后，ORT 的
 * 状态不再影响检测结论。
 */
function warmupOrt() {
    try {
        const p = ensureOrt();
        if (p && typeof p.catch === 'function') {
            p.catch((e) => console.warn('[WebNN] onnxruntime-web preload failed (不影响 WebNN 检测):', e.message));
        }
    } catch (e) {
        console.warn('[WebNN] onnxruntime-web preload failed (不影响 WebNN 检测):', e.message);
    }
}

/**
 * 在指定设备上运行小型 matmul benchmark，测量推理延迟
 * @param {string} deviceType - 'npu' | 'cpu'
 * @returns {Promise<{ inferenceMs: number, compileMs: number, error?: string }>}
 */
async function benchmarkDevice(deviceType) {
    try {
        const ctx = await createContextSafe(deviceType);
        if (ctx.timedOut || ctx.error) {
            return { inferenceMs: 0, compileMs: 0, error: ctx.error || 'createContext timeout' };
        }
        const context = ctx.value;
        if (!context) return { inferenceMs: 0, compileMs: 0, error: 'No context' };

        // WebNN GraphBuilder API（部分实现可能未暴露 MLGraphBuilder 构造器）
        const MLBuilder = (typeof MLGraphBuilder !== 'undefined')
            ? MLGraphBuilder
            : (typeof self !== 'undefined' && self.MLGraphBuilder)
                ? self.MLGraphBuilder
                : null;
        if (!MLBuilder) {
            return { inferenceMs: 0, compileMs: 0, error: 'MLGraphBuilder not available' };
        }

        const builder = new MLBuilder(context);
        // 现行 WebNN 规范的 MLOperandDescriptor 使用 `dataType` + `shape`。
        // 旧代码用的是 `type` + `dimensions`（早期草案），在当前 Chromium 上
        // 会直接抛 "Required member is undefined"，benchmark 从未跑起来过。
        const input = builder.input('input', { dataType: 'float32', shape: [1, BENCH_DIM] });
        const weightData = new Float32Array(BENCH_DIM * BENCH_DIM);
        for (let i = 0; i < weightData.length; i++) weightData[i] = (i % 7) * 0.1;
        const weights = builder.constant({ dataType: 'float32', shape: [BENCH_DIM, BENCH_DIM] }, weightData);
        const output = builder.matmul(input, weights);

        const tCompile0 = performance.now();
        const graph = await builder.build({ output });
        const compileMs = performance.now() - tCompile0;

        const inputData = new Float32Array(BENCH_DIM);
        for (let i = 0; i < BENCH_DIM; i++) inputData[i] = i * 0.01;

        const compute = await createComputeFn(context, graph, inputData);
        if (compute.error) return { inferenceMs: 0, compileMs, error: compute.error };

        try {
            // Warmup（首次 dispatch 包含权重上传等一次性开销）
            try { await compute.run(); } catch (_) {}

            const t0 = performance.now();
            for (let i = 0; i < BENCH_RUNS; i++) {
                await compute.run();
            }
            const inferenceMs = (performance.now() - t0) / BENCH_RUNS;
            return { inferenceMs, compileMs };
        } finally {
            await compute.dispose();
        }
    } catch (e) {
        return { inferenceMs: 0, compileMs: 0, error: e.message };
    }
}

/**
 * 构造一次图计算的调用闭包。
 *
 * 现行规范（tensor API）：context.createTensor + writeTensor + dispatch。
 * 旧规范：graph.compute(inputs)（已在新 Chromium 移除，保留以兼容老版本）。
 *
 * 注意：Electron 42 / Chromium 148 未暴露 MLTensorUsage，无法为 tensor 申请
 * 写权限，此时 createTensor/writeTensor 会失败。这是平台限制而非代码缺陷，
 * 这里返回明确的 error，由调用方忽略（benchmark 失败不影响可用性判定）。
 *
 * @returns {Promise<{ run?: Function, dispose?: Function, error?: string }>}
 */
async function createComputeFn(context, graph, inputData) {
    if (typeof context.dispatch === 'function' && typeof context.createTensor === 'function') {
        try {
            const inputTensor = await context.createTensor({ dataType: 'float32', shape: [1, BENCH_DIM] });
            const outputTensor = await context.createTensor({ dataType: 'float32', shape: [1, BENCH_DIM] });
            await context.writeTensor(inputTensor, inputData);
            return {
                run: () => context.dispatch(graph, { input: inputTensor }, { output: outputTensor }),
                dispose: async () => {
                    try { await inputTensor.destroy(); } catch (_) { /* 已销毁 */ }
                    try { await outputTensor.destroy(); } catch (_) { /* 已销毁 */ }
                },
            };
        } catch (e) {
            return { error: `WebNN tensor API unavailable: ${e.message}` };
        }
    }
    if (graph && typeof graph.compute === 'function') {
        return {
            run: () => graph.compute({ input: inputData }),
            dispose: async () => {},
        };
    }
    return { error: 'No supported WebNN compute API (context.dispatch / graph.compute)' };
}

/**
 * 检测 WebNN/NPU 可用性
 * @returns {{ webnnAvailable: boolean, npuAvailable: boolean, gpuAvailable: boolean, details: string, npuInferenceMs?: number, cpuInferenceMs?: number, npuSlow?: boolean }}
 */
export async function detectNPU() {
    // W12: 成功结果也带 TTL，超过 CACHE_TTL_MS 后重新检测
    // （NPU 可能在运行中变为不可用，陈旧的成功缓存应自动过期）
    if (_detectionCache) {
        if (Date.now() - _cacheTime <= CACHE_TTL_MS) return _detectionCache;
        _detectionCache = null;
        _cacheTime = 0;
    }

    // 只做后台预热，绝不阻塞/影响检测结论（见 warmupOrt 注释）
    warmupOrt();

    // 检查 navigator.ml API
    if (typeof navigator === 'undefined' || !navigator.ml) {
        const result = {
            webnnAvailable: false,
            webnnNpuAvailable: false,
            webnnApiAvailable: false,
            npuAvailable: false,
            gpuAvailable: false,
            details: 'navigator.ml API not available (WebNN not enabled or unsupported Chromium version)',
        };
        _detectionCache = result;
        _cacheTime = Date.now();
        return result;
    }

    let npuAvailable = false;
    let gpuAvailable = false;
    let details = '';

    // 检测 NPU
    const npuCtx = await createContextSafe('npu');
    if (npuCtx.value) {
        npuAvailable = true;
        details += 'NPU: available; ';
    } else {
        details += `NPU: not available (${npuCtx.error}); `;
    }

    // 检测 GPU (WebNN)
    const gpuCtx = await createContextSafe('gpu');
    if (gpuCtx.value) {
        gpuAvailable = true;
        details += 'GPU (WebNN): available; ';
    } else {
        details += `GPU (WebNN): not available (${gpuCtx.error}); `;
    }

    const result = {
        webnnAvailable: npuAvailable || gpuAvailable,
        webnnNpuAvailable: npuAvailable,
        webnnApiAvailable: true,
        npuAvailable,
        gpuAvailable,
        details: details.trim(),
    };

    // 性能 benchmark：NPU 可用时与 CPU 对比，若 NPU 显著慢则标记为不推荐
    if (npuAvailable) {
        const [npuBench, cpuBench] = await Promise.all([
            benchmarkDevice('npu'),
            benchmarkDevice('cpu'),
        ]);

        if (npuBench.inferenceMs > 0) result.npuInferenceMs = npuBench.inferenceMs;
        if (cpuBench.inferenceMs > 0) result.cpuInferenceMs = cpuBench.inferenceMs;

        if (npuBench.error) {
            details += `NPU benchmark failed (${npuBench.error}); `;
        } else if (cpuBench.error) {
            details += `CPU benchmark failed (${cpuBench.error}); `;
        } else if (npuBench.inferenceMs > 0 && cpuBench.inferenceMs > 0) {
            // W13: NPU 延迟 > 2.0× CPU 延迟 → 标记为慢，不推荐使用
            if (npuBench.inferenceMs > cpuBench.inferenceMs * NPU_SLOW_THRESHOLD) {
                result.npuSlow = true;
                result.npuAvailable = false;
                result.webnnNpuAvailable = false;
                result.webnnAvailable = result.npuAvailable || result.gpuAvailable;
                details += `NPU slow (${npuBench.inferenceMs.toFixed(1)}ms vs CPU ${cpuBench.inferenceMs.toFixed(1)}ms, disabled); `;
            } else {
                details += `NPU perf OK (${npuBench.inferenceMs.toFixed(1)}ms vs CPU ${cpuBench.inferenceMs.toFixed(1)}ms); `;
            }
        }
        result.details = details.trim();
    }

    _detectionCache = result;
    _cacheTime = Date.now(); // W12: 记录缓存时间，供 success-TTL 判断
    return result;
}

/**
 * W12: 清除本地检测缓存（_detectionCache）。供主进程通过 IPC 通知触发，
 * 或外部需要强制重新检测时调用。主进程 clearNPUFailureCache() 后会通过
 * 'webnn:clearNpuCache' 通知渲染端；若 preload 未暴露相应桥接，则依赖
 * detectNPU() 内的 success-TTL 自动过期，调用本函数始终安全。
 */
export function clearCache() {
    _detectionCache = null;
    _cacheTime = 0;
}

// W12: 监听主进程的缓存清除通知。仅在 preload 暴露了相应桥接时注册，
// 避免在不支持该桥接的环境（如测试 jsdom）中报错。
if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.onClearNpuCache === 'function') {
    window.electronAPI.onClearNpuCache(() => clearCache());
}
