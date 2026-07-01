const ort = require('onnxruntime-node');

/**
 * Shared utility functions (tensor helpers, math, etc.)
 */

// Float32 <-> Float16 conversion utilities
// Two code paths:
//   - Native Float16Array (Node 24+, Chromium 130+): TypedArray.set 走 native
//     memcpy，比元素级循环快 2-3 倍
//   - Fallback (Node 22 LTS test env, no native Float16Array): manual IEEE 754
//     half-precision bit conversion via Uint16Array storage
let float32ToF16Buffer, f16BufferToFloat32;

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
        return sign | (exp << 10) | rounded;
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
    createFloatTensor,
    outputToFloat32,
    disposeTensor,
    normalizePeakTo,
};
