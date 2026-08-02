/**
 * preprocessing.js
 * Audio preprocessing for the SXSEditor-Pad SVS pipeline.
 *
 * Converts text and pitch data into model input tensors.
 * Handles phoneme encoding, pitch processing, duration processing,
 * and speaker embedding preparation.
 *
 * @module inference/pipeline/preprocessing
 */

import { VOCAB_SIZE, NUM_SPEAKERS, PITCH_BINS, F0_MIN, F0_MAX, HOP_LENGTH, SAMPLE_RATE } from './constants.js';
import { resolvePhonemes } from './textProcessing.js';

/**
 * Convert text to phoneme ID sequence.
 *
 * @param {string} text - Input text
 * @param {object} [options]
 * @param {'auto'|'zh'|'en'|'ja'} [options.language='auto']
 * @returns {Promise<number[]>} Phoneme ID array
 */
export async function textToPhonemes(text, options = {}) {
  const { phonemes } = await resolvePhonemes(text, options);
  return phonemes;
}

/**
 * Process pitch values for model input.
 * Converts Hz values to quantised pitch bins.
 *
 * @param {Float32Array|number[]} f0 - F0 contour in Hz (per frame)
 * @param {number} [numBins=PITCH_BINS] - Number of pitch bins
 * @returns {Int32Array} Quantised pitch bins
 */
export function processPitch(f0, numBins = PITCH_BINS) {
  const n = f0.length;
  const bins = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    const hz = f0[i];
    if (hz <= 0) {
      bins[i] = 0; // Unvoiced
    } else {
      // Map Hz to bin
      const logMin = Math.log(F0_MIN);
      const logMax = Math.log(F0_MAX);
      const logHz = Math.log(Math.max(F0_MIN, Math.min(F0_MAX, hz)));
      const normalized = (logHz - logMin) / (logMax - logMin);
      bins[i] = Math.min(Math.max(1, Math.round(normalized * (numBins - 2)) + 1), numBins - 1);
    }
  }

  return bins;
}

/**
 * Process phoneme durations for model input.
 *
 * @param {number[]} durations - Phoneme durations in frames
 * @param {number} [maxDuration=32] - Maximum duration per phoneme
 * @returns {Int32Array} Duration array
 */
export function processDurations(durations, maxDuration = 32) {
  const n = durations.length;
  const processed = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    processed[i] = Math.max(1, Math.min(Math.round(durations[i]), maxDuration));
  }

  return processed;
}

/**
 * Prepare speaker embedding input.
 *
 * @param {number} [speakerId=0] - Speaker ID
 * @param {number} [numSpeakers=NUM_SPEAKERS] - Total number of speakers
 * @returns {Float32Array} One-hot speaker embedding
 */
export function prepareSpeakerEmbedding(speakerId = 0, numSpeakers = NUM_SPEAKERS) {
  const embedding = new Float32Array(numSpeakers);
  if (speakerId >= 0 && speakerId < numSpeakers) {
    embedding[speakerId] = 1.0;
  }
  return embedding;
}

/**
 * Expand phoneme IDs to frame-level using duration information.
 *
 * @param {number[]} phonemeIds - Phoneme ID sequence
 * @param {number[]} durations - Duration per phoneme (in frames)
 * @returns {Int32Array} Frame-level phoneme IDs
 */
export function expandPhonemesToFrames(phonemeIds, durations) {
  if (phonemeIds.length !== durations.length) {
    throw new Error(
      `phonemeIds length (${phonemeIds.length}) must match durations length (${durations.length})`
    );
  }

  const totalFrames = durations.reduce((sum, d) => sum + d, 0);
  const framePhonemes = new Int32Array(totalFrames);
  let offset = 0;

  for (let i = 0; i < phonemeIds.length; i++) {
    const phoneId = phonemeIds[i];
    const dur = durations[i];
    for (let j = 0; j < dur; j++) {
      framePhonemes[offset + j] = phoneId;
    }
    offset += dur;
  }

  return framePhonemes;
}

/**
 * Prepare the full set of input tensors for the acoustic model.
 *
 * @param {object} ort - ONNX Runtime module
 * @param {object} params
 * @param {number[]} params.phonemeIds - Phoneme ID sequence
 * @param {number[]} params.durations - Duration per phoneme (frames)
 * @param {Float32Array|number[]} params.f0 - F0 contour (Hz per frame)
 * @param {number} [params.speakerId=0] - Speaker ID
 * @param {number} [params.numFrames] - Target number of frames (padded/truncated)
 * @returns {object} Object with named tensor inputs
 */
export function prepareInputs(ort, params) {
  const { phonemeIds, durations, f0, speakerId = 0, numFrames } = params;

  // Expand phonemes to frame level
  const framePhonemes = expandPhonemesToFrames(phonemeIds, durations);
  const totalFrames = framePhonemes.length;

  // Determine target frame count
  const targetFrames = numFrames || totalFrames;

  // Process pitch
  const pitchBins = processPitch(f0, PITCH_BINS);

  // Pad or truncate to target frames
  const padFrames = (arr, target) => {
    const padded = new Int32Array(target);
    const copyLen = Math.min(arr.length, target);
    for (let i = 0; i < copyLen; i++) {
      padded[i] = arr[i];
    }
    // Fill remaining with silence phoneme ID
    for (let i = copyLen; i < target; i++) {
      padded[i] = 57; // sil
    }
    return padded;
  };

  const padFramesFloat = (arr, target) => {
    const padded = new Float32Array(target);
    const copyLen = Math.min(arr.length, target);
    for (let i = 0; i < copyLen; i++) {
      padded[i] = arr[i];
    }
    return padded;
  };

  const paddedPhonemes = padFrames(framePhonemes, targetFrames);
  const paddedPitch = padFrames(pitchBins.length >= targetFrames ? pitchBins : (() => {
    const p = new Int32Array(targetFrames);
    const copyLen = Math.min(pitchBins.length, targetFrames);
    for (let i = 0; i < copyLen; i++) p[i] = pitchBins[i];
    return p;
  })(), targetFrames);

  const paddedF0 = f0 instanceof Float32Array ? f0 : new Float32Array(f0);
  const f0Padded = padFramesFloat(paddedF0, targetFrames);

  // Speaker embedding
  const speakerEmb = prepareSpeakerEmbedding(speakerId);

  // Create tensors
  const inputs = {};

  // Phoneme IDs: [1, seq_len] int32
  inputs.phonemes = new ort.Tensor('int32', paddedPhonemes, [1, targetFrames]);

  // Pitch: [1, seq_len] int32
  inputs.pitch = new ort.Tensor('int32', paddedPitch, [1, targetFrames]);

  // F0: [1, seq_len] float32
  inputs.f0 = new ort.Tensor('float32', f0Padded, [1, targetFrames]);

  // Speaker embedding: [1, num_speakers] float32
  inputs.speaker = new ort.Tensor('float32', speakerEmb, [1, NUM_SPEAKERS]);

  return inputs;
}

export default {
  textToPhonemes,
  processPitch,
  processDurations,
  prepareSpeakerEmbedding,
  expandPhonemesToFrames,
  prepareInputs,
};