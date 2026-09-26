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

// ===== diff_step 序列长度上限 =====
// 2026-09-26 起 diff_step_dml.onnx 将 RoPE 位置表离线烘焙为权重初始化器
// （rope_cos_table / rope_sin_table，[1,8192,64] fp16，运行时只做 Slice 取行），
// 根治了 TensorRT-RTX（NvTensorRTRTXExecutionProvider）的 2048 帧边界 bug：
// 其 Myelin 融合内核以 11 位尾数网格执行 fp32 位置 MatMul，位置 >=2049 的
// 奇数帧相位被舍入 ±inv_freq，经 22 层 attention + 32 步扩散放大为尾部能量
// 凹陷。TRT-RTX 实测 seq=2100/4096 逐帧 cos≈0.9986+，与 DML/CPU 一致。
// 因此旧的缓解措施（TRT-RTX 动态序列钳制 2047，原 TRT_RTX_MAX_DYNAMIC_SEQ_LEN）
// 已移除；8192 是烘焙 rope 表的行数上限（163.84s @50fps），对所有 EP 生效：
// 超出后 Slice 返回 8192 行，与注意力 [1,seq,·,64] 广播失败（硬错误），
// pipeline 侧保留钳制兜底（_clampDiffStepMaxFrames）。
export const DIFF_STEP_MAX_SEQ_LEN = 8192;
