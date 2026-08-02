/**
 * durationStats.js
 * Duration statistics utilities for the SXSEditor-Pad SVS pipeline.
 *
 * Computes statistics over phoneme duration arrays, used for
 * duration scaling and analysis.
 *
 * @module inference/pipeline/durationStats
 */

/**
 * Calculate statistics for an array of phoneme durations.
 *
 * @param {number[]} phonemeDurations - Array of phoneme durations (in frames)
 * @returns {{ min: number, max: number, mean: number, median: number, std: number, total: number, count: number, p25: number, p75: number, p90: number }}
 */
export function calculateDurationStats(phonemeDurations) {
  if (!phonemeDurations || phonemeDurations.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      std: 0,
      total: 0,
      count: 0,
      p25: 0,
      p75: 0,
      p90: 0,
    };
  }

  const sorted = [...phonemeDurations].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((sum, v) => sum + v, 0);
  const mean = total / n;

  // Variance
  const variance = sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);

  // Median
  let median;
  if (n % 2 === 0) {
    median = (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  } else {
    median = sorted[Math.floor(n / 2)];
  }

  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    median,
    std,
    total,
    count: n,
    p25: getDurationPercentile(sorted, 25),
    p75: getDurationPercentile(sorted, 75),
    p90: getDurationPercentile(sorted, 90),
  };
}

/**
 * Calculate the value at a given percentile from a sorted array of durations.
 *
 * @param {number[]} durations - Pre-sorted array of durations
 * @param {number} percentile - Percentile to compute (0-100)
 * @returns {number} The value at the requested percentile
 */
export function getDurationPercentile(durations, percentile) {
  if (!durations || durations.length === 0) {
    return 0;
  }

  const p = Math.max(0, Math.min(100, percentile));
  const index = (p / 100) * (durations.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return durations[lower];
  }

  // Linear interpolation between adjacent values
  const frac = index - lower;
  return durations[lower] * (1 - frac) + durations[upper] * frac;
}

/**
 * Scale durations by a factor, clamping to MAX_PHONE_DURATION.
 *
 * @param {number[]} durations - Original phoneme durations
 * @param {number} factor - Scale factor (e.g., 1.1 = 10% slower)
 * @param {number} [maxDuration=32] - Maximum allowed duration per phoneme
 * @returns {number[]} Scaled durations
 */
export function scaleDurations(durations, factor, maxDuration = 32) {
  return durations.map((d) => Math.min(Math.max(1, Math.round(d * factor)), maxDuration));
}

/**
 * Stretch or compress the total duration to a target number of frames
 * by proportionally adjusting each phoneme duration.
 *
 * @param {number[]} durations - Original phoneme durations
 * @param {number} targetFrames - Desired total number of frames
 * @param {number} [maxDuration=32] - Maximum allowed duration per phoneme
 * @returns {number[]} Adjusted durations
 */
export function matchTotalDuration(durations, targetFrames, maxDuration = 32) {
  const currentTotal = durations.reduce((sum, v) => sum + v, 0);
  if (currentTotal === 0) return durations;

  const factor = targetFrames / currentTotal;
  return scaleDurations(durations, factor, maxDuration);
}

export default {
  calculateDurationStats,
  getDurationPercentile,
  scaleDurations,
  matchTotalDuration,
};