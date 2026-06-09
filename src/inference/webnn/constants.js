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
