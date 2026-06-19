const SAMPLE_RATE = 24000;
const HOP_SIZE = 480;
const MEL_DIM = 128;
const EMBED_DIM = 512;
const COND_DIM = 1024;
const N_FFT = 1920;
const NUM_MELS = 128;
const MEL_MEAN = -4.92;
const MEL_VAR = 8.14;
const F0_BIN = 361;
const F0_MIN = 32.7031956625;
const CFG_STRENGTH = 3.0;
const CFG_RESCALE = 0.75;
const DEFAULT_DIFF_STEPS = 32;
const VOCODER_CHUNK_FRAMES = 1008;
const VOCODER_OVERLAP_FRAMES = 8;
// Vocoder NPU 静态形状（独立于 encoder/diffusion 的 seq_len=2048）
// Vocoder ISTFT Conv 的 Pad 中间张量在 seq_len=2048 时超出 WebNN 2GB 限制
const NPU_VOCODER_SEQ_LEN = 500;
const LONG_AUDIO_THRESHOLD_SEC = 30;
const SEGMENT_MIN_SEC = 15;
const SEGMENT_MAX_SEC = 30;
const SEGMENT_OVERLAP_SEC = 2;
const MAX_SAFE_FRAMES = 40000;

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

// Model大小定义（字节，FP16 版本）
const MODEL_SIZES = {
    diff_step: 846.27 * 1024 * 1024,
    vocoder: 495.42 * 1024 * 1024,
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
    LONG_AUDIO_THRESHOLD_SEC,
    SEGMENT_MIN_SEC,
    SEGMENT_MAX_SEC,
    SEGMENT_OVERLAP_SEC,
    MAX_SAFE_FRAMES,
    ONNX_MODEL_FILES,
    MODEL_SIZES,
    MODEL_GROUPS,
    TWIDDLE_REAL,
    TWIDDLE_IMAG,
    HANN_WINDOW,
};
