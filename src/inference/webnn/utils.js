/**
 * WebNN 推理模块 — 共享工具函数
 */

import { getOrt } from './ortSetup.js';

/**
 * Float32 → Float16 单元素转换（保留兼容性，仅用于零星转换）
 * @param {number} value - Float32 值
 * @returns {number} Float16 位模式（存储在 Uint16 中）
 */
export function float32ToFloat16(value) {
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
 * 批量 Float32 → Float16 转换（使用共享 ArrayBuffer，避免逐元素分配）
 * 比 float32ToFloat16() 单元素转换快 5-10 倍
 * @param {Float32Array} f32Src - 源 Float32 数据
 * @param {Uint16Array} u16Dst - 目标 Uint16Array（长度 >= f32Src.length）
 * @param {number} [len] - 转换元素数（默认 f32Src.length）
 */
export function batchFloat32ToFloat16(f32Src, u16Dst, len) {
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
export function batchFloat16ToFloat32(u16Src, f32Dst, len) {
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
 * 创建浮点张量（自动处理 float16/float32）
 * 使用批量转换替代逐元素转换
 */
export function createFloatTensor(type, data, dims) {
    const ort = getOrt();
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
export function outputToFloat32(tensor) {
    if (tensor.type === 'float16') {
        const u16 = tensor.data instanceof Uint16Array ? tensor.data : new Uint16Array(tensor.data);
        const f32 = new Float32Array(u16.length);
        batchFloat16ToFloat32(u16, f32, u16.length);
        return f32;
    }
    return tensor.data instanceof Float32Array ? tensor.data : new Float32Array(tensor.data);
}

/**
 * 将 BigInt64Array 零填充到目标长度（右侧填充 0n）
 * @param {BigInt64Array} src - 源数据
 * @param {number} targetLen - 目标长度
 * @returns {BigInt64Array} 填充后的数组（新分配）
 */
export function padInt64ToLength(src, targetLen) {
    if (src.length >= targetLen) return src;
    const padded = new BigInt64Array(targetLen);
    padded.set(src);
    return padded;
}

/**
 * 将 Float32Array 零填充到目标长度（右侧填充 0）
 * @param {Float32Array} src - 源数据
 * @param {number} targetLen - 目标长度
 * @returns {Float32Array} 填充后的数组（新分配）
 */
export function padFloat32ToLength(src, targetLen) {
    if (src.length >= targetLen) return src;
    const padded = new Float32Array(targetLen);
    padded.set(src);
    return padded;
}

/**
 * 将数据零填充到目标长度，返回新的 TypedArray
 * @param {TypedArray} src - 源数据
 * @param {number} targetLen - 目标长度
 * @returns {TypedArray} 填充后的数组
 */
export function padToLength(src, targetLen) {
    if (src.length >= targetLen) return src;
    const padded = new src.constructor(targetLen);
    padded.set(src);
    return padded;
}

/**
 * 从张量输出中提取并裁剪到实际帧数
 * @param {Object} tensorOutput - ORT 张量输出
 * @param {number} actualLen - 实际有效长度（沿第 1 维）
 * @returns {Float32Array} 裁剪后的 Float32 数据
 */
export function trimOutputToLength(tensorOutput, actualLen) {
    const full = outputToFloat32(tensorOutput);
    if (tensorOutput.dims.length === 3) {
        const dim2 = tensorOutput.dims[2];
        return full.subarray(0, actualLen * dim2);
    }
    if (tensorOutput.dims.length === 2) {
        const dim1 = tensorOutput.dims[1];
        return full.subarray(0, actualLen * dim1);
    }
    return full.subarray(0, actualLen);
}

/**
 * 高斯随机数生成（Box-Muller 变换）
 */
export function gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * 从绝对路径提取相对于 onnx_models 目录的路径
 * @param {string} absPath - 绝对路径
 * @returns {string} 相对路径（如 'note_text_encoder.onnx' 或 'int8/f0_encoder.onnx'）
 */
export function extractRelativePath(absPath) {
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
 * 构建模型 URL
 * @param {string} modelPath - 模型文件路径（绝对路径或相对路径）
 * @returns {string} file:/// URL
 */
export function buildModelUrl(modelPath) {
    // 绝对路径直接使用 file:/// 协议
    if (modelPath.match(/^[A-Za-z]:\\/) || modelPath.startsWith('/')) {
        return `file:///${modelPath.replace(/\\/g, '/')}`;
    }
    // 相对路径使用 onnx:// 协议（兼容旧路径）
    return `onnx://${modelPath}`;
}
