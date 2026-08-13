// 共享维度/NPU 形状常量从 shared/constants.js 引入，避免与 webnn 模块重复定义
const {
    SAMPLE_RATE,
    HOP_SIZE,
    SIFIGAN_HOP_SIZE,
    MEL_DIM,
    EMBED_DIM,
    COND_DIM,
    VOCODER_CHUNK_FRAMES,
    VOCODER_OVERLAP_FRAMES,
    NPU_STATIC_SEQ_LEN,
    NPU_VOCODER_SEQ_LEN,
} = require('../shared/constants.js');

// pipeline 专属常量
const N_FFT = 1920;
const NUM_MELS = 128;
const MEL_MEAN = -4.92;
const MEL_VAR = 8.14;
const F0_BIN = 361;
const F0_MIN = 32.7031956625;
const CFG_STRENGTH = 3.0;
const CFG_RESCALE = 0.7;
const DEFAULT_DIFF_STEPS = 32;
const LONG_AUDIO_THRESHOLD_SEC = 30;
const SEGMENT_MIN_SEC = 15;
const SEGMENT_MAX_SEC = 30;
const SEGMENT_OVERLAP_SEC = 2;
const MAX_SAFE_FRAMES = 40000;

// WebNN IPC 超时常量（毫秒）
// 单次模型推理：NPU 编译 + 推理的合理上限
const IPC_TIMEOUT_INFERENCE = 120000;
// 模型加载：含 EP 初始化与权重上传，比单次推理更慢
const IPC_TIMEOUT_MODEL_LOAD = 180000;
// 合成主流程：含多步 diffusion 循环 + vocoder，耗时最长
const IPC_TIMEOUT_SYNTHESIS = 600000;

const ONNX_MODEL_FILES = [
    'note_text_encoder.onnx',
    'note_pitch_encoder.onnx',
    'note_type_encoder.onnx',
    'f0_encoder.onnx',
    'preflow.onnx',
    'cond_emb.onnx',
    'diff_step_dml.onnx',
    'vocoder_dml.onnx',
    'mel_transform.onnx',
];

// SiFiGAN 可选替代声码器模型文件
// FP16 变体优先 (sifigan_vocoder_dml_fp16.onnx), FP32 DML 优化版作为回退
const SIFIGAN_MODEL_FILES = [
    'sifigan_vocoder_dml_fp16.onnx',
    'sifigan_vocoder_dml.onnx',
];

// SiFiGAN 输入特征归一化统计文件
const SIFIGAN_STATS_FILE = 'sifigan_stats.joblib';

// Model大小定义（字节，FP16 版本）
const MODEL_SIZES = {
    diff_step: 846.27 * 1024 * 1024,
    vocoder: 495.42 * 1024 * 1024,
    sifigan: 611.42 * 1024 * 1024,        // FP32 DML 优化版 (含 .data)
    sifigan_fp16: 23.1 * 1024 * 1024,     // FP16 量化版 (含 .data, ~1.99x 压缩)
    note_text_encoder: 2.93 * 1024 * 1024,
    note_pitch_encoder: 0.13 * 1024 * 1024,
    note_type_encoder: 0.13 * 1024 * 1024,
    f0_encoder: 0.13 * 1024 * 1024,
    preflow: 8.2 * 1024 * 1024,
    cond_emb: 0.51 * 1024 * 1024,
    mel_transform: 0.25 * 1024 * 1024,
    rmvpe: 349.21 * 1024 * 1024,
    rosvot: 54.58 * 1024 * 1024,
};

// Model组定义
const MODEL_GROUPS = {
    svs_diffusion: {
        models: ['diff_step', 'vocoder'],
        label: 'SVS 扩散Model',
    },
    svs_encoder: {
        models: ['note_text_encoder', 'note_pitch_encoder', 'note_type_encoder', 'f0_encoder', 'preflow', 'cond_emb'],
        label: 'SVS 编码器Model',
    },
    svs_auxiliary: {
        models: ['mel_transform'],
        label: 'SVS 辅助Model',
    },
    rmvpe: {
        models: ['rmvpe'],
        label: 'RMVPE 音高检测',
    },
    rosvot: {
        models: ['rosvot'],
        label: 'RosVot 语音检测',
    },
};

// 预计算旋转因子表 (twiddle factors)
const TWIDDLE_REAL = new Float32Array(N_FFT / 2);
const TWIDDLE_IMAG = new Float32Array(N_FFT / 2);
for (let i = 0; i < N_FFT / 2; i++) {
    TWIDDLE_REAL[i] = Math.cos(-2 * Math.PI * i / N_FFT);
    TWIDDLE_IMAG[i] = Math.sin(-2 * Math.PI * i / N_FFT);
}

// 预计算 Hann 窗
const HANN_WINDOW = new Float32Array(N_FFT);
for (let i = 0; i < N_FFT; i++) {
    HANN_WINDOW[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N_FFT - 1)));
}

module.exports = {
    SAMPLE_RATE,
    HOP_SIZE,
    SIFIGAN_HOP_SIZE,
    MEL_DIM,
    EMBED_DIM,
    COND_DIM,
    N_FFT,
    NUM_MELS,
    MEL_MEAN,
    MEL_VAR,
    F0_BIN,
    F0_MIN,
    CFG_STRENGTH,
    CFG_RESCALE,
    DEFAULT_DIFF_STEPS,
    VOCODER_CHUNK_FRAMES,
    VOCODER_OVERLAP_FRAMES,
    NPU_VOCODER_SEQ_LEN,
    NPU_STATIC_SEQ_LEN,
    LONG_AUDIO_THRESHOLD_SEC,
    SEGMENT_MIN_SEC,
    SEGMENT_MAX_SEC,
    SEGMENT_OVERLAP_SEC,
    MAX_SAFE_FRAMES,
    IPC_TIMEOUT_INFERENCE,
    IPC_TIMEOUT_MODEL_LOAD,
    IPC_TIMEOUT_SYNTHESIS,
    ONNX_MODEL_FILES,
    SIFIGAN_MODEL_FILES,
    SIFIGAN_STATS_FILE,
    MODEL_SIZES,
    MODEL_GROUPS,
    TWIDDLE_REAL,
    TWIDDLE_IMAG,
    HANN_WINDOW,
};
