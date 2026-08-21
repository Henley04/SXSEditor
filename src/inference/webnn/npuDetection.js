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

/**
 * 在指定设备上运行小型 matmul benchmark，测量推理延迟
 * @param {string} deviceType - 'npu' | 'cpu'
 * @returns {Promise<{ inferenceMs: number, compileMs: number, error?: string }>}
 */
async function benchmarkDevice(deviceType) {
    try {
        const context = await navigator.ml.createContext({ deviceType });
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
        const input = builder.input('input', { type: 'float32', dimensions: [1, BENCH_DIM] });
        const weightData = new Float32Array(BENCH_DIM * BENCH_DIM);
        for (let i = 0; i < weightData.length; i++) weightData[i] = (i % 7) * 0.1;
        const weights = builder.constant({ type: 'float32', dimensions: [BENCH_DIM, BENCH_DIM] }, weightData);
        const output = builder.matmul(input, weights);

        const tCompile0 = performance.now();
        const graph = await builder.build({ output });
        const compileMs = performance.now() - tCompile0;

        const inputData = new Float32Array(BENCH_DIM);
        for (let i = 0; i < BENCH_DIM; i++) inputData[i] = i * 0.01;

        // Warmup（首次 compute 包含权重上传等一次性开销）
        try { await graph.compute({ input: inputData }); } catch (_) {}

        // Measure
        const t0 = performance.now();
        for (let i = 0; i < BENCH_RUNS; i++) {
            await graph.compute({ input: inputData });
        }
        const inferenceMs = (performance.now() - t0) / BENCH_RUNS;
        return { inferenceMs, compileMs };
    } catch (e) {
        return { inferenceMs: 0, compileMs: 0, error: e.message };
    }
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

    await ensureOrt();

    // 检查 navigator.ml API
    if (typeof navigator === 'undefined' || !navigator.ml) {
        const result = {
            webnnAvailable: false,
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

    const result = {
        webnnAvailable: npuAvailable || gpuAvailable,
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
