const ort = require('onnxruntime-node');

/**
 * Shared utility functions (tensor helpers, math, etc.)
 */

// Float32 -> Float16 转换工具
// Using Float16Array 进行转换（Node.js v24+ 原生支持）
// TypedArray.set 走 native memcpy，比元素级循环快 2-3 倍
function float32ToF16Buffer(f32Data) {
    const f16 = new Float16Array(f32Data.length);
    f16.set(f32Data);
    return new Uint16Array(f16.buffer, f16.byteOffset, f16.length);
}

function f16BufferToFloat32(u16Data) {
    const f16 = new Float16Array(u16Data.buffer, u16Data.byteOffset, u16Data.length);
    const f32 = new Float32Array(f16.length);
    f32.set(f16);
    return f32;
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
    normalizePeakTo,
};
