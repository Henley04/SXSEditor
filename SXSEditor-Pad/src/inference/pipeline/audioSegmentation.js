/**
 * audioSegmentation.js
 * Audio segmentation utilities for the SXSEditor-Pad SVS pipeline.
 *
 * Splits long audio into manageable segments, handles overlap,
 * and merges segments back together with cross-fading.
 *
 * @module inference/pipeline/audioSegmentation
 */

import { MAX_SEGMENT_DURATION, SEGMENT_OVERLAP, CROSSFADE_DURATION, SAMPLE_RATE } from './constants.js';

/**
 * Split a long synthesis into segments for processing.
 *
 * Each segment is defined by its start and end frame index.
 * Segments overlap by SEGMENT_OVERLAP seconds worth of frames.
 *
 * @param {number} totalFrames - Total number of frames in the full synthesis
 * @param {number} [maxSegmentFrames] - Max frames per segment (derived from MAX_SEGMENT_DURATION if not given)
 * @param {number} [overlapFrames] - Overlap frames (derived from SEGMENT_OVERLAP if not given)
 * @param {number} [hopLength=512] - Hop length for frame-to-sample conversion
 * @returns {Array<{ start: number, end: number, index: number }>} Segment descriptors
 */
export function splitIntoSegments(
  totalFrames,
  maxSegmentFrames,
  overlapFrames,
  hopLength = 512
) {
  const maxFrames = maxSegmentFrames ?? Math.floor(MAX_SEGMENT_DURATION * SAMPLE_RATE / hopLength);
  const overlap = overlapFrames ?? Math.floor(SEGMENT_OVERLAP * SAMPLE_RATE / hopLength);

  if (totalFrames <= maxFrames) {
    return [{ start: 0, end: totalFrames, index: 0 }];
  }

  const segments = [];
  let start = 0;
  let index = 0;

  while (start < totalFrames) {
    const end = Math.min(start + maxFrames, totalFrames);
    segments.push({ start, end, index });
    index++;
    // Move start forward, accounting for overlap
    start = end - overlap;
    if (start >= totalFrames) break;
  }

  return segments;
}

/**
 * Apply a cross-fade between two arrays of audio samples.
 *
 * @param {Float32Array} prevSamples - Previous segment's tail (overlap region)
 * @param {Float32Array} nextSamples - Next segment's head (overlap region)
 * @param {number} [crossfadeLen] - Cross-fade length in samples
 * @returns {Float32Array} Cross-faded samples
 */
export function crossfade(prevSamples, nextSamples, crossfadeLen) {
  const len = crossfadeLen ?? Math.floor(CROSSFADE_DURATION * SAMPLE_RATE);
  const fadeLen = Math.min(len, prevSamples.length, nextSamples.length);
  const result = new Float32Array(fadeLen);

  for (let i = 0; i < fadeLen; i++) {
    const gain = i / fadeLen; // 0 → 1
    result[i] = prevSamples[prevSamples.length - fadeLen + i] * (1 - gain)
      + nextSamples[i] * gain;
  }

  return result;
}

/**
 * Merge audio segments back into a single continuous waveform.
 *
 * @param {Float32Array[]} segmentAudio - Array of audio sample arrays, one per segment
 * @param {Array<{ start: number, end: number, index: number }>} segments - Segment descriptors
 * @param {number} [crossfadeLen] - Cross-fade length in samples
 * @param {number} [hopLength=512] - Hop length
 * @returns {Float32Array} Merged audio
 */
export function mergeSegments(
  segmentAudio,
  segments,
  crossfadeLen,
  hopLength = 512
) {
  if (segments.length === 0 || segmentAudio.length === 0) {
    return new Float32Array(0);
  }

  if (segments.length === 1) {
    return segmentAudio[0];
  }

  const fadeLen = crossfadeLen ?? Math.floor(CROSSFADE_DURATION * SAMPLE_RATE);
  const overlapFrames = Math.floor(SEGMENT_OVERLAP * SAMPLE_RATE / hopLength);
  const overlapSamples = overlapFrames * hopLength;

  // Estimate total length
  let totalSamples = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segFrames = seg.end - seg.start;
    const segSamples = segFrames * hopLength;
    totalSamples += segSamples;
    if (i > 0) {
      totalSamples -= overlapSamples; // Remove overlap
    }
  }

  const merged = new Float32Array(Math.max(0, totalSamples));
  let offset = 0;

  for (let i = 0; i < segments.length; i++) {
    const audio = segmentAudio[i];
    const seg = segments[i];
    const segFrames = seg.end - seg.start;
    const segSamples = segFrames * hopLength;

    if (i === 0) {
      // First segment: copy entirely
      for (let j = 0; j < Math.min(segSamples, audio.length); j++) {
        merged[offset + j] = audio[j];
      }
      offset += segSamples;
    } else {
      // Subsequent segments: cross-fade the overlap region
      const copyStart = overlapSamples; // Skip the overlap part of the new segment
      const copyLen = Math.min(segSamples - overlapSamples, audio.length - overlapSamples);

      // Cross-fade in the overlap region
      const fadeOutStart = offset - overlapSamples;
      if (fadeOutStart >= 0) {
        for (let j = 0; j < Math.min(overlapSamples, fadeLen); j++) {
          const gain = j / Math.min(overlapSamples, fadeLen);
          merged[fadeOutStart + j] = merged[fadeOutStart + j] * (1 - gain)
            + audio[j] * gain;
        }
      }

      // Copy the non-overlapping part
      for (let j = 0; j < copyLen; j++) {
        merged[offset + j] = audio[copyStart + j];
      }
      offset += copyLen;
    }
  }

  // Trim to actual written length
  return merged.slice(0, offset);
}

/**
 * Process a long synthesis in segments, calling a synthesis function for each.
 *
 * @param {number} totalFrames - Total number of frames
 * @param {Function} synthesizeFn - Async function (startFrame, endFrame) => Float32Array audio
 * @param {object} [options]
 * @param {number} [options.maxSegmentFrames] - Max frames per segment
 * @param {number} [options.hopLength=512] - Hop length
 * @param {Function} [options.onSegment] - Callback (segmentIndex, totalSegments)
 * @returns {Promise<Float32Array>} Merged audio
 */
export async function processSegmented(totalFrames, synthesizeFn, options = {}) {
  const { maxSegmentFrames, hopLength = 512, onSegment } = options;

  const segments = splitIntoSegments(totalFrames, maxSegmentFrames, undefined, hopLength);
  const segmentAudio = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (onSegment) {
      onSegment(i, segments.length);
    }

    const audio = await synthesizeFn(seg.start, seg.end);
    segmentAudio.push(audio);
  }

  return mergeSegments(segmentAudio, segments, undefined, hopLength);
}

export default {
  splitIntoSegments,
  crossfade,
  mergeSegments,
  processSegmented,
};