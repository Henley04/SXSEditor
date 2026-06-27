/**
 * WebNN 推理模块 — 常量定义
 *
 * 共享维度/NPU 形状常量从 shared/constants.js 引入，避免与 pipeline 模块重复定义。
 * 本文件仅保留 WebNN 专属常量（EP 超时、vocoder 输出修正等）。
 */
import {
    SAMPLE_RATE,
    HOP_SIZE,
    MEL_DIM,
    EMBED_DIM,
    COND_DIM,
    VOCODER_CHUNK_FRAMES,
    VOCODER_OVERLAP_FRAMES,
    NPU_STATIC_SEQ_LEN,
    NPU_VOCODER_SEQ_LEN,
} from '../shared/constants.js';

// 重新导出共享常量，保持现有 import 路径不变
export {
    SAMPLE_RATE,
    HOP_SIZE,
    MEL_DIM,
    EMBED_DIM,
    COND_DIM,
    VOCODER_CHUNK_FRAMES,
    VOCODER_OVERLAP_FRAMES,
    NPU_STATIC_SEQ_LEN,
    NPU_VOCODER_SEQ_LEN,
};

// ===== WebNN 专属常量 =====
export const NPU_STATIC_NUM_SAMPLES = 24000;
export const NPU_STATIC_MEL_FRAMES = 500;

export const WEBNN_EP_TIMEOUT = 120000; // 120s per EP
// Vocoder NPU compilation is significantly slower due to large Conv kernels (ISTFT, kernel_size=1922)
// and 484MB model size. 300s timeout provides sufficient headroom for NPU compiler.
export const WEBNN_VOCODER_TIMEOUT = 300000; // 300s for vocoder NPU

// Vocoder ISTFT 输出: Conv(kernel=1920, pad=[1919,1440]) + Slice(960:-960)
// 输出样本数 = seq_len * HOP_SIZE - (ISTFT_KERNEL - HOP_SIZE)
// 对于 seq_len=500: 500*480 - 480 = 239520
export const VOCODER_OUTPUT_TRIM_SAMPLES = 480;
