/**
 * WebNN 推理模块 — NPU/GPU 检测逻辑
 */

/* global MLGraphBuilder */

import { ensureOrt } from './ortSetup.js';

// 缓存检测结果（包含 benchmark）
let _detectionCache = null;

// NPU 静态形状限制（与 constants.js 中保持一致）
const BENCH_DIM = 8;
const BENCH_RUNS = 5;
const NPU_SLOW_THRESHOLD = 1.5;

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
    // 返回缓存结果（benchmark 较重，避免重复执行）
    if (_detectionCache) return _detectionCache;

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
            // NPU 延迟 > 1.5× CPU 延迟 → 标记为慢，不推荐使用
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
    return result;
}
