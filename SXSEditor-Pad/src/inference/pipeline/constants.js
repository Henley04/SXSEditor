/**
 * constants.js
 * Pipeline constants for SXSEditor-Pad SVS inference.
 *
 * These values match the SoulX-Singer model configuration.
 * Adjust if using a different model variant.
 *
 * @module inference/pipeline/constants
 */

// ==================== Audio ====================

/** Target sample rate for synthesis (Hz) */
export const SAMPLE_RATE = 44100;

/** Hop length for STFT / mel spectrogram */
export const HOP_LENGTH = 512;

/** FFT size for STFT */
export const FFT_SIZE = 2048;

/** Number of mel bands */
export const NUM_MELS = 128;

/** Number of frames per inference step (for the acoustic model) */
export const NUM_FRAMES = 128;

// ==================== Phoneme / Duration ====================

/** Maximum duration for a single phoneme (frames) */
export const MAX_PHONE_DURATION = 32;

/** Phoneme vocabulary size */
export const VOCAB_SIZE = 150;

// ==================== Speaker ====================

/** Number of speakers in the model (1 = single-speaker) */
export const NUM_SPEAKERS = 1;

// ==================== Pitch ====================

/** Number of pitch bins for quantised pitch input */
export const PITCH_BINS = 256;

/** F0 minimum (Hz) */
export const F0_MIN = 50;

/** F0 maximum (Hz) */
export const F0_MAX = 1100;

// ==================== Diffusion ====================

/** Default number of diffusion steps */
export const DEFAULT_DIFFUSION_STEPS = 50;

/** Default CFG scale */
export const DEFAULT_CFG_SCALE = 2.0;

/** Minimum CFG scale */
export const CFG_SCALE_MIN = 1.0;

/** Maximum CFG scale */
export const CFG_SCALE_MAX = 10.0;

// ==================== Segmentation ====================

/** Maximum audio length per segment (seconds) */
export const MAX_SEGMENT_DURATION = 30;

/** Overlap duration between segments (seconds) */
export const SEGMENT_OVERLAP = 1.0;

/** Cross-fade duration (seconds) */
export const CROSSFADE_DURATION = 0.05;

// ==================== Loudness Normalisation ====================

/** Target LUFS for loudness normalisation */
export const TARGET_LUFS = -14.0;

/** Default LUFS for normalisation when no target is specified */
export const DEFAULT_LUFS = -16.0;

// ==================== Model IDs ====================

export const MODEL_IDS = {
  BASE: 'soulx-singer-base',
  JP: 'soulx-singer-jp',
  VOCODER: 'soulx-vocoder',
  RMVPE: 'rmvpe',
  BASIC_PITCH: 'basic-pitch',
  ROSVOT: 'rosvot',
};

// ==================== Execution Provider Priority ====================

export const EP_PRIORITY = [
  'webnn',
  'webgpu',
  'wasm',
];

// ==================== Logging ====================

export const LOG_PREFIX = '[SXS-Inference]';