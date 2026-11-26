// 惰性 ORT：见 ortRuntime.js。
const { lazyOrt: ort } = require('../ortRuntime.js');

/**
 * Shared utility functions (tensor helpers, math, etc.)
 */

// Float32 <-> Float16 conversion utilities
// Two code paths:
//   - Native Float16Array (Node 24+, Chromium 130+): TypedArray.set 走 native
//     memcpy，比元素级循环快 2-3 倍
//   - Fallback (Node 22 LTS test env, no native Float16Array): manual IEEE 754
//     half-precision bit conversion via Uint16Array storage
let float32ToF16Buffer, f16BufferToFloat32, f16BufferToFloat32Into;

if (typeof Float16Array !== 'undefined') {
    float32ToF16Buffer = (f32Data) => {
        const f16 = new Float16Array(f32Data.length);
        f16.set(f32Data);
        return new Uint16Array(f16.buffer, f16.byteOffset, f16.length);
    };
    f16BufferToFloat32 = (u16Data) => {
        const f16 = new Float16Array(u16Data.buffer, u16Data.byteOffset, u16Data.length);
        const f32 = new Float32Array(f16.length);
        f32.set(f16);
        return f32;
    };
    f16BufferToFloat32Into = (u16Data, dst) => {
        const f16 = new Float16Array(u16Data.buffer, u16Data.byteOffset, u16Data.length);
        dst.set(f16);
        return dst;
    };
} else {
    // Shared buffer for float32 bit reinterpretation (avoid per-call allocation)
    const _buf = new ArrayBuffer(4);
    const _u32 = new Uint32Array(_buf);
    const _f32 = new Float32Array(_buf);

    const f32ToF16Bits = (val) => {
        _f32[0] = val;
        const x = _u32[0];
        const sign = (x >>> 16) & 0x8000;
        const exponent = (x >>> 23) & 0xff;
        const mantissa = x & 0x7fffff;
        if (exponent === 0xff) {
            // Inf or NaN
            if (mantissa === 0) return sign | 0x7c00; // Inf
            return sign | 0x7c00 | 0x0200; // quiet NaN (matches native encoding)
        }
        const exp = exponent - 127 + 15;
        if (exp >= 0x1f) {
            // Overflow → Inf
            return sign | 0x7c00;
        }
        if (exp <= 0) {
            // Subnormal or flush-to-zero
            if (exp < -10) return sign;
            const shift = 14 - exp;
            const value = (mantissa | 0x800000) >>> 0;
            const halfWay = 1 << (shift - 1);
            const mask = (1 << shift) - 1;
            const dropped = value & mask;
            let rounded = value >>> shift;
            if (dropped > halfWay || (dropped === halfWay && (rounded & 1))) {
                rounded++; // round-half-to-even
            }
            return sign | rounded;
        }
        // Normalized: round 23-bit mantissa to 10 bits
        const shift = 13;
        const halfWay = 1 << (shift - 1);
        const mask = (1 << shift) - 1;
        const dropped = mantissa & mask;
        let rounded = mantissa >>> shift;
        if (dropped > halfWay || (dropped === halfWay && (rounded & 1))) {
            rounded++; // round-half-to-even
        }
        // Use + instead of | so that mantissa overflow (0x3FF + 1 = 0x400)
        // correctly carries into the exponent. With |, bit 10 of rounded would
        // be silently absorbed by exp's LSB, producing e.g. 511.96 -> -256
        // instead of -512. + is equivalent to | when rounded <= 0x3FF.
        return sign + (exp << 10) + rounded;
    };

    const f16BitsToF32 = (u16) => {
        const sign = (u16 & 0x8000) << 16;
        const exponent = (u16 & 0x7c00) >>> 10;
        const mantissa = u16 & 0x03ff;
        let bits;
        if (exponent === 0) {
            if (mantissa === 0) {
                bits = sign; // signed zero
            } else {
                // Subnormal → normalize to float32
                let m = mantissa;
                let e = 0;
                while ((m & 0x0400) === 0) {
                    m <<= 1;
                    e--;
                }
                m &= 0x3ff;
                bits = sign | ((127 - 14 + e) << 23) | (m << 13);
            }
        } else if (exponent === 0x1f) {
            // Inf or NaN
            bits = sign | 0x7f800000 | (mantissa ? 0x400000 : 0);
        } else {
            // Normalized
            bits = sign | ((exponent - 15 + 127) << 23) | (mantissa << 13);
        }
        _u32[0] = bits;
        return _f32[0];
    };

    float32ToF16Buffer = (f32Data) => {
        const u16 = new Uint16Array(f32Data.length);
        for (let i = 0; i < f32Data.length; i++) {
            u16[i] = f32ToF16Bits(f32Data[i]);
        }
        return u16;
    };
    f16BufferToFloat32 = (u16Data) => {
        const f32 = new Float32Array(u16Data.length);
        for (let i = 0; i < u16Data.length; i++) {
            f32[i] = f16BitsToF32(u16Data[i]);
        }
        return f32;
    };
    f16BufferToFloat32Into = (u16Data, dst) => {
        for (let i = 0; i < u16Data.length; i++) {
            dst[i] = f16BitsToF32(u16Data[i]);
        }
        return dst;
    };
}

// 模块级共享的 4 字节转换缓冲（P26）：FP16 CFG 每步要调用 float32ToFloat16
// 两次，复用同一缓冲避免每次 new ArrayBuffer/两个视图。
// 注意：仅限同步调用、不可重入 —— 若在 setFloat32 与 getUint32 之间发生重入
// （await / 回调），共享缓冲会被覆盖，结果错误。
const _f16ScalarView = new DataView(new ArrayBuffer(4));

// Float32 → Float16 single-element conversion (returns Uint16 bit pattern).
// Used for scalar values (e.g. t tensor with batch=1/2). Allocates no buffer.
function float32ToFloat16(value) {
    _f16ScalarView.setFloat32(0, value, true);
    const x = _f16ScalarView.getUint32(0, true);
    const sign = (x >> 16) & 0x8000;
    const exponent = ((x >> 23) & 0xff) - 127;
    const mantissa = x & 0x7fffff;
    if (exponent >= 16) return sign | 0x7c00;
    if (exponent >= -14) return sign | ((exponent + 15) << 10) | (mantissa >> 13);
    if (exponent >= -24) return sign | ((mantissa | 0x800000) >> (-exponent - 1));
    return sign;
}

// Batch Float32 → Float16 in-place conversion into an existing Uint16Array
// buffer. Avoids per-step allocation in the diffusion loop where the target
// tensor's .data buffer is pre-allocated once and reused across steps.
// Mirrors webnn/utils.js batchFloat32ToFloat16 for parity between paths.
function batchFloat32ToFloat16(f32Src, u16Dst, len) {
    len = len || f32Src.length;
    // Native path (Node 24+, Chromium 130+): reinterpret the destination
    // Uint16 storage as Float16Array and let TypedArray.set do a native
    // round-to-even conversion (~2x faster than the scalar bit loop).
    if (typeof Float16Array !== 'undefined') {
        new Float16Array(u16Dst.buffer, u16Dst.byteOffset, len)
            .set(f32Src.subarray(0, len));
        return;
    }
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
            u16Dst[i] = sign | ((mantissa | 0x800000) >> (-exponent - 1));
        } else {
            u16Dst[i] = sign;
        }
    }
}

// 根据Model精度创建浮点张量
function createFloatTensor(type, f32Data, dims) {
    if (type === 'float16') {
        return new ort.Tensor('float16', float32ToF16Buffer(f32Data), dims);
    }
    return new ort.Tensor('float32', f32Data, dims);
}

// 从Model输出中提取 Float32Array（自动处理 float16 输出）
function outputToFloat32(tensor) {
    if (tensor.type === 'float16') {
        return f16BufferToFloat32(tensor.data);
    }
    return new Float32Array(tensor.data);
}

/**
 * 把 Model 输出写入**调用方提供的**缓冲区（P1-3）。
 *
 * 扩散循环每步都会调用一次 outputToFloat32：seqLen=2048 的 mel 输出是
 * 2048×128×4B = 1MB（batch 合并路径 2MB），32 步就是几十 MB 的临时数组，
 * 全部丢给 GC —— 这是纯分配开销，数据本身下一步就丢。
 *
 * 在"读完立刻消费、不保留引用"的调用点（diffusion.js 的 CFG batch 路径与
 * no-CFG 路径，结果马上被 set 进跨步复用的 condPredBuf/uncondPredBuf）改用
 * 这个版本，每步 0 分配。
 *
 * 注意：dst 会被**覆盖**，调用方必须保证上一步的结果已经用完。
 *
 * @param {import('onnxruntime-node').Tensor} tensor
 * @param {Float32Array} dst 容量 >= tensor 元素数的复用缓冲
 * @returns {Float32Array} 返回 dst 本身
 */
function outputToFloat32Into(tensor, dst) {
    if (tensor.type === 'float16') {
        return f16BufferToFloat32Into(tensor.data, dst);
    }
    // FP32 输出：ORT 的 data 就是 Float32Array（或 subarray 视图），dst.set 走
    // native 拷贝，不新建数组。
    dst.set(tensor.data);
    return dst;
}

/**
 * 释放 ONNX Runtime Tensor 的 native 资源。
 * onnxruntime-node 的 Tensor 提供 dispose() 方法，可立即释放底层 GPU/CPU 缓冲区，
 * 不必等待 V8 GC finalizer。在推理管线中，每步创建的输入/输出张量若不显式释放，
 * 会累积在 GPU 显存导致后续推理 OOM (887A0005/887A0006)。
 * @param {import('onnxruntime-node').Tensor|null|undefined} tensor
 */
function disposeTensor(tensor) {
    if (!tensor) return;
    try {
        if (typeof tensor.dispose === 'function') {
            tensor.dispose();
        }
    } catch (_) { /* 忽略重复 dispose 或已释放 */ }
}

// GPU 排空：仅让出一个事件循环轮次（setImmediate），不做墙钟等待。
// DML 后端的资源回收顺序由 ONNX Runtime 内部负责；本函数只用于在阶段切换处
// 给事件循环一次机会处理 pending 任务，并不保证任何固定的毫秒级排空时间。
function gpuDrain() {
    return new Promise(resolve => setImmediate(resolve));
}

// 大模型 session.release() 后的排空：与 gpuDrain 相同，仅让出一个事件循环轮次，
// 不做墙钟等待（历史注释中的 ~800ms 分轮 setTimeout 从未实现）。
// session.release() 与 ORT 内部的同步语义负责资源顺序，JS 层不额外 sleep。
async function gpuDrainLong() {
    // Never impose wall-clock sleeps. Session release and ORT synchronization
    // are responsible for resource ordering; this only yields one event turn.
    await new Promise(resolve => setImmediate(resolve));
}

// 自适应 GPU 排空：实际行为同样只是 setImmediate yield 让出事件循环一轮，
// 不做墙钟等待。markGpuOom() 设置的标志只会在下一次调用时被消费（清除），
// 不会延长等待时间；保留该标志是为了将来可能的差异化策略与外部观测。
let _oomFlag = false;
function markGpuOom() {
    _oomFlag = true;
}
async function gpuDrainAdaptive() {
    if (_oomFlag) _oomFlag = false;
    await new Promise(resolve => setImmediate(resolve));
}

/**
 * Build a cancellation error with a stable code, so callers / IPC can detect
 * that the failure was an intentional cooperative cancel rather than a real bug.
 * @param {string} [message='Synthesis cancelled']
 */
function cancelledError(message = 'Synthesis cancelled') {
    const err = new Error(message);
    err.code = 'SYNTHESIS_CANCELLED';
    return err;
}

/**
 * Throw a cancellation error if the given AbortSignal has been aborted.
 * Used as the collaborative-safe-point gate inside diffusion loops / synthesis
 * phases. This lets the worker exit gracefully instead of being force-killed
 * (worker.terminate()), which avoided a native D3D device crash on Windows.
 * @param {AbortSignal|null|undefined} signal
 * @param {string} [message='Synthesis cancelled']
 */
function throwIfCancelled(signal, message = 'Synthesis cancelled') {
    if (signal && signal.aborted) throw cancelledError(message);
}

/**
 * Normalize audio array peak to a threshold (default 0.95).
 * @param {Float32Array} arr
 * @param {number} [len] - number of samples to process (defaults to arr.length)
 * @param {number} [threshold=0.95]
 */
function normalizePeakTo(arr, len, threshold = 0.95) {
    const n = len !== undefined ? len : arr.length;
    let peak = 0;
    for (let i = 0; i < n; i++) {
        const abs = Math.abs(arr[i]);
        if (abs > peak) peak = abs;
    }
    if (peak > threshold) {
        const scale = threshold / peak;
        for (let i = 0; i < n; i++) arr[i] *= scale;
    }
}

module.exports = {
    float32ToF16Buffer,
    f16BufferToFloat32,
    f16BufferToFloat32Into,
    outputToFloat32Into,
    float32ToFloat16,
    batchFloat32ToFloat16,
    createFloatTensor,
    outputToFloat32,
    disposeTensor,
    normalizePeakTo,
    gpuDrain,
    gpuDrainLong,
    gpuDrainAdaptive,
    markGpuOom,
    cancelledError,
    throwIfCancelled,
};
