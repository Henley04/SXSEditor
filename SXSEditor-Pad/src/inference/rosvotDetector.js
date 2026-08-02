/**
 * rosvotDetector.js
 * ROSVOT voice activity detector for SXSEditor-Pad.
 *
 * ROSVOT (Robust Singing Voice Onset/Offset Tracker) detects
 * voiced regions in audio, providing frame-level voice activity
 * detection (VAD) specialised for singing voice.
 *
 * @module inference/rosvotDetector
 */

import { LOG_PREFIX } from './pipeline/constants.js';
import { getSession, createSession } from './webnn/sessionManager.js';
import { initOrt } from './webnn/ortSetup.js';

/**
 * @typedef {Object} VADResult
 * @property {Float32Array} voiceProb - Frame-level voice probability (0-1)
 * @property {Array<{ start: number, end: number }>} segments - Voice activity segments (in seconds)
 * @property {number} hopLength - Hop length used for analysis
 * @property {number} sampleRate - Audio sample rate
 */

/**
 * Run voice activity detection using the ROSVOT model.
 *
 * @param {Float32Array} audio - Input audio samples (44100 Hz mono)
 * @param {object} [options]
 * @param {number} [options.sampleRate=44100] - Input sample rate
 * @param {number} [options.threshold=0.5] - VAD threshold
 * @param {number} [options.minSegmentDuration=0.1] - Minimum segment duration (seconds)
 * @returns {Promise<VADResult>}
 */
export async function detectVoiceActivity(audio, options = {}) {
  const { sampleRate = 44100, threshold = 0.5, minSegmentDuration = 0.1 } = options;

  const ort = await initOrt();
  const sessionMeta = getSession('rosvot');

  if (!sessionMeta) {
    throw new Error('ROSVOT model not loaded. Call loadROSVOTModel() first.');
  }

  const session = sessionMeta.session;

  // ROSVOT expects 16000 Hz mono audio
  const targetSr = 16000;
  const resampled = resampleAudio(audio, sampleRate, targetSr);

  // Normalise
  const maxVal = Math.max(...resampled.map(Math.abs), 1e-8);
  const normalised = new Float32Array(resampled.length);
  for (let i = 0; i < resampled.length; i++) {
    normalised[i] = resampled[i] / maxVal;
  }

  // Create input tensor: [1, 1, audio_len]
  const audioTensor = new ort.Tensor('float32', normalised, [1, 1, normalised.length]);

  // Run inference
  const feeds = {};
  feeds[session.inputNames[0]] = audioTensor;
  const results = await session.run(feeds);

  // Parse output
  const outputName = session.outputNames[0];
  const outputData = results[outputName];
  const outputArray = new Float32Array(outputData.data);
  const dims = outputData.dims;

  // ROSVOT output shape: [1, 1, frames] or [1, frames]
  let numFrames;
  if (dims.length === 3) {
    numFrames = dims[2];
  } else {
    numFrames = outputArray.length;
  }

  const hopLength = 160; // ROSVOT default
  const voiceProb = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    voiceProb[i] = outputArray[i] || 0;
  }

  // Convert frame-level probabilities to time segments
  const segments = [];
  let inVoice = false;
  let segStart = 0;

  for (let i = 0; i < numFrames; i++) {
    const time = i * hopLength / targetSr;
    const isVoice = voiceProb[i] >= threshold;

    if (isVoice && !inVoice) {
      segStart = time;
      inVoice = true;
    } else if (!isVoice && inVoice) {
      const segDuration = time - segStart;
      if (segDuration >= minSegmentDuration) {
        segments.push({ start: segStart, end: time });
      }
      inVoice = false;
    }
  }

  // Handle trailing voice segment
  if (inVoice) {
    const endTime = numFrames * hopLength / targetSr;
    const segDuration = endTime - segStart;
    if (segDuration >= minSegmentDuration) {
      segments.push({ start: segStart, end: endTime });
    }
  }

  return {
    voiceProb,
    segments,
    hopLength,
    sampleRate: targetSr,
  };
}

/**
 * Resample audio to a target sample rate.
 *
 * @param {Float32Array} audio
 * @param {number} inputSr
 * @param {number} targetSr
 * @returns {Float32Array}
 */
function resampleAudio(audio, inputSr, targetSr) {
  if (inputSr === targetSr) {
    return new Float32Array(audio);
  }

  const ratio = targetSr / inputSr;
  const newLength = Math.round(audio.length * ratio);
  const resampled = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIdx = i / ratio;
    const idxLow = Math.floor(srcIdx);
    const idxHigh = Math.min(idxLow + 1, audio.length - 1);
    const frac = srcIdx - idxLow;
    resampled[i] = audio[idxLow] * (1 - frac) + audio[idxHigh] * frac;
  }

  return resampled;
}

/**
 * Load the ROSVOT model.
 *
 * @param {Uint8Array} modelData - ONNX model data
 * @param {object} [options] - Session creation options
 * @returns {Promise<object>} Session metadata
 */
export async function loadROSVOTModel(modelData, options = {}) {
  return createSession('rosvot', modelData, options);
}

/**
 * Apply a median filter to the voice probability array to smooth it.
 *
 * @param {Float32Array} probs - Voice probabilities
 * @param {number} [windowSize=5] - Median filter window size (must be odd)
 * @returns {Float32Array} Smoothed probabilities
 */
export function smoothVAD(probs, windowSize = 5) {
  const n = probs.length;
  const half = Math.floor(windowSize / 2);
  const result = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const values = [];
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      values.push(probs[j]);
    }
    values.sort((a, b) => a - b);
    result[i] = values[Math.floor(values.length / 2)];
  }

  return result;
}

export default {
  detectVoiceActivity,
  loadROSVOTModel,
  smoothVAD,
};