/**
 * loudnorm.js
 * Loudness normalisation utilities for the SXSEditor-Pad SVS pipeline.
 *
 * Implements ITU-R BS.1770-4 loudness measurement and
 * gain adjustment to a target LUFS level.
 *
 * Note: For a full EBU R128 compliant loudness normaliser,
 * use a dedicated library. This is a lightweight approximation
 * suitable for real-time preview.
 *
 * @module inference/pipeline/loudnorm
 */

import { clamp } from './utils.js';

/**
 * Apply loudness normalisation to audio samples.
 *
 * @param {Float32Array|number[]} samples - Input audio samples (range [-1, 1])
 * @param {number} [targetLUFS=-14] - Target loudness level in LUFS
 * @returns {Float32Array} Normalised audio samples
 */
export function loudnorm(samples, targetLUFS = -14) {
  const input = samples instanceof Float32Array ? samples : new Float32Array(samples);
  const measuredLUFS = measureLUFS(input);

  // If the measured loudness is already near the target, return as-is
  if (Math.abs(measuredLUFS - targetLUFS) < 0.5) {
    return new Float32Array(input);
  }

  // Compute gain adjustment
  const gainDb = targetLUFS - measuredLUFS;
  const gainLinear = 10 ** (gainDb / 20);

  // Apply gain, preventing clipping
  const output = new Float32Array(input.length);
  let peak = 0;

  for (let i = 0; i < input.length; i++) {
    const sample = input[i] * gainLinear;
    output[i] = clamp(sample, -1, 1);
    peak = Math.max(peak, Math.abs(sample));
  }

  // If clipping occurred, apply a second pass with soft limiting
  if (peak > 1.0) {
    const limitGain = 0.99 / peak;
    for (let i = 0; i < output.length; i++) {
      output[i] = clamp(output[i] * limitGain, -1, 1);
    }
  }

  return output;
}

/**
 * Measure the integrated loudness (LUFS) of audio samples
 * using a simplified ITU-R BS.1770-4 algorithm.
 *
 * This implementation uses the pre-filter and RLB weighting
 * specified by the standard.
 *
 * @param {Float32Array|number[]} samples - Audio samples at 44100 Hz
 * @returns {number} Measured loudness in LUFS
 */
export function measureLUFS(samples) {
  const input = samples instanceof Float32Array ? samples : new Float32Array(samples);
  const n = input.length;

  if (n === 0) return -Infinity;

  // Stage 1: Apply the pre-filter (high-pass + shelving filter)
  // Simplified: use a single-pole high-pass at ~38 Hz
  const filtered = new Float32Array(n);
  let prev = 0;
  const rc = 1 / (2 * Math.PI * 38);
  const dt = 1 / 44100;
  const alpha = dt / (rc + dt);

  for (let i = 0; i < n; i++) {
    filtered[i] = alpha * (prev + input[i] - prev);
    prev = input[i];
  }

  // Stage 2: Apply RLB weighting (2nd-order high-pass at ~100 Hz)
  // Simplified: 2nd-order Butterworth high-pass
  const rlbFiltered = new Float32Array(n);
  const w0 = 2 * Math.PI * 100 / 44100;
  const Q = 0.5;
  const b0 = 1 / (1 + w0 / Q + w0 * w0);
  const b1 = -2 * b0;
  const b2 = b0;
  const a1 = -2 * (w0 * w0 - 1) * b0;
  const a2 = -(1 - w0 / Q + w0 * w0) * b0;

  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const x = filtered[i];
    const y = b0 * x + b1 * x1 + b2 * x2 + a1 * y1 + a2 * y2;
    rlbFiltered[i] = y;
    x2 = x1; x1 = x;
    y2 = y1; y1 = y;
  }

  // Stage 3: Compute mean square in each channel (mono = 1 channel)
  let sumSquares = 0;
  for (let i = 0; i < n; i++) {
    sumSquares += rlbFiltered[i] * rlbFiltered[i];
  }

  const meanSquare = sumSquares / n;

  // Stage 4: Convert to LUFS
  // LUFS = -0.691 + 10 * log10(G_mean)
  // G_mean = meanSquare * channelWeight (mono = 1.0)
  if (meanSquare <= 0) {
    return -Infinity;
  }

  const lufs = -0.691 + 10 * Math.log10(meanSquare);
  return lufs;
}

/**
 * Compute the peak amplitude of audio samples.
 *
 * @param {Float32Array|number[]} samples
 * @returns {number} Peak amplitude (0 to 1+)
 */
export function measurePeak(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  return peak;
}

/**
 * Compute the RMS amplitude of audio samples.
 *
 * @param {Float32Array|number[]} samples
 * @returns {number} RMS amplitude (0 to 1)
 */
export function measureRMS(samples) {
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSq += samples[i] * samples[i];
  }
  return Math.sqrt(sumSq / samples.length);
}

export default {
  loudnorm,
  measureLUFS,
  measurePeak,
  measureRMS,
};