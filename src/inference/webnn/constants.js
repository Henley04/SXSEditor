/**
 * WebNN 推理模块 — 常量定义
 */

export const SAMPLE_RATE = 24000;
export const HOP_SIZE = 480;
export const MEL_DIM = 128;
export const EMBED_DIM = 512;
export const COND_DIM = 1024;
export const VOCODER_CHUNK_FRAMES = 1008;
export const VOCODER_OVERLAP_FRAMES = 8;
export const WEBNN_EP_TIMEOUT = 120000; // 120s per EP
// Vocoder NPU compilation is significantly slower due to large Conv kernels (ISTFT, kernel_size=1922)
// and 484MB model size. 300s timeout provides sufficient headroom for NPU compiler.
export const WEBNN_VOCODER_TIMEOUT = 300000; // 300s for vocoder NPU

// NPU 静态形状常量（optimized_npu 模型）
export const NPU_STATIC_SEQ_LEN = 2048;
export const NPU_STATIC_NUM_SAMPLES = 240000;
export const NPU_STATIC_MEL_FRAMES = 500;

// Vocoder NPU 静态形状（独立于 encoder/diffusion 的 seq_len）
// Vocoder ISTFT Conv 的 Pad 中间张量在 seq_len=2048 时为 7.56GB，超出 WebNN 2GB 限制
// seq_len=500 时为 1.84GB，安全限制内
export const NPU_VOCODER_SEQ_LEN = 500;

// Vocoder ISTFT 输出: Conv(kernel=1920, pad=[1919,1440]) + Slice(960:-960)
// 输出样本数 = seq_len * HOP_SIZE - (ISTFT_KERNEL - HOP_SIZE)
// 对于 seq_len=500: 500*480 - 480 = 239520
export const VOCODER_OUTPUT_TRIM_SAMPLES = 480;
