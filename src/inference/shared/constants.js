/**
 * 推理共享常量（pipeline 与 webnn 模块共用）
 *
 * 这些常量定义了模型输入/输出的维度与序列长度约束，两条推理路径
 * （主进程 ONNX Runtime + DirectML，渲染进程 WebNN）必须使用完全
 * 相同的数值，否则会产生难以定位的音质 bug。本文件作为唯一来源。
 *
 * 同时提供 CommonJS（module.exports）与 ESM（命名导出）两种导出，
 * 以兼容主进程（CJS）与渲染进程（ESM，经 webpack babel 转译）。
 */

// ===== 共享维度常量 =====
export const SAMPLE_RATE = 24000;
export const HOP_SIZE = 480;
export const SIFIGAN_HOP_SIZE = 120;
export const MEL_DIM = 128;
export const EMBED_DIM = 512;
export const COND_DIM = 1024;
export const VOCODER_CHUNK_FRAMES = 1024;
export const VOCODER_OVERLAP_FRAMES = 32;

// ===== NPU 静态形状常量 =====
// NPU 静态形状模型固定序列长度（encoder/diffusion 输入维度）
// 用于 optimized_npu 模型，totalFramesWithPrompt 不能超过此值
export const NPU_STATIC_SEQ_LEN = 2048;
// Vocoder NPU 静态形状（独立于 encoder/diffusion 的 seq_len）
// Vocoder ISTFT Conv 的 Pad 中间张量在 seq_len=2048 时超出 WebNN 2GB 限制
export const NPU_VOCODER_SEQ_LEN = 500;

// TensorRT-RTX (NvTensorRTRTXExecutionProvider) 默认全动态 profile 下，
// diff_step 的 Myelin 融合内核在序列索引 >=2048 时输出错误（逐帧 TRT-vs-DML
// 对照实证：seqLen<=2047 cos≈1.00000，seqLen>=2048 从第 2048 帧起 cos 塌缩
// 到 0.97 并经 32 步扩散放大为尾部能量凹陷）。此为动态形状安全上限，
// 仅约束 TRT-RTX 动态引擎路径；cond_emb/vocoder 不受此 bug 影响。
export const TRT_RTX_MAX_DYNAMIC_SEQ_LEN = 2047;
