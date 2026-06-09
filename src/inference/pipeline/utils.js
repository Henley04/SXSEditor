const ort = require('onnxruntime-node');

/**
 * Shared utility functions (tensor helpers, math, etc.)
 */

// Float32 -> Float16 转换工具
// Using Float16Array 进行转换（Node.js v24+ 原生支持）
function float32ToF16Buffer(f32Data) {
    const f16 = new Float16Array(f32Data.length);
    for (let i = 0; i < f32Data.length; i++) {
        f16[i] = f32Data[i];
    }
    return new Uint16Array(f16.buffer, f16.byteOffset, f16.length);
}

function f16BufferToFloat32(u16Data) {
    const f16 = new Float16Array(u16Data.buffer, u16Data.byteOffset, u16Data.length);
    const f32 = new Float32Array(f16.length);
    for (let i = 0; i < f16.length; i++) {
        f32[i] = f16[i];
    }
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

module.exports = {
    float32ToF16Buffer,
    f16BufferToFloat32,
    createFloatTensor,
    outputToFloat32,
};
