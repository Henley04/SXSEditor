/**
 * rmvpePitchDetector.js
 * RMVPE pitch detector for SXSEditor-Pad.
 *
 * RMVPE (Robust Multi-Resolution Pitch Estimation) provides
 * fine-grained pitch (F0) detection using a deep learning model.
 *
 * This module loads the RMVPE ONNX model and runs inference
 * to extract frame-level F0 contours from audio.
 *
 * Reference: https://github.com/ML-GSAI/RMVPE
 *
 * @module inference/rmvpePitchDetector
 */

import { LOG_PREFIX, F0_MIN, F0_MAX } from './pipeline/constants.js';
import { getSession, createSession } from './webnn/sessionManager.js';
import { initOrt } from './webnn/ortSetup.js';

/**
 * @typedef {Object} RMVPEResult
 * @property {Float32Array} f0 - Frame-level F0 contour (Hz), 0 = unvoiced
 * @property {Float32Array} confidence - Per-frame confidence (0-1)
 * @property {number} hopLength - Hop length used for analysis
 * @property {number} sampleRate - Audio sample rate
 */

/**
 * Run RMVPE pitch detection on audio data.
 *
 * @param {Float32Array} audio - Input audio samples (44100 Hz mono)
 * @param {object} [options]
 * @param {number} [options.sampleRate=44100] - Input sample rate
 * @param {number} [options.threshold=0.5] - Confidence threshold for voiced/unvoiced
 * @returns {Promise<RMVPEResult>}
 */
export async function detectF0(audio, options = {}) {
  const { sampleRate = 44100, threshold = 0.5 } = options;

  const ort = await initOrt();
  const sessionMeta = getSession('rmvpe');

  if (!sessionMeta) {
    throw new Error('RMVPE model not loaded. Call loadRMVPEModel() first.');
  }

  const session = sessionMeta.session;

  // RMVPE expects 16000 Hz mono audio
  const targetSr = 16000;
  const resampled = resampleAudio(audio, sampleRate, targetSr);

  // Normalise audio
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

  // Parse outputs
  const outputName = session.outputNames[0];
  const outputData = results[outputName];
  const outputArray = new Float32Array(outputData.data);
  const dims = outputData.dims;

  // RMVPE output shape: [1, 360, frames] or [frames, 360]
  // where 360 is the number of pitch bins
  let numFrames;
  let numBins = 360;

  if (dims.length === 3) {
    numFrames = dims[2];
  } else if (dims.length === 2) {
    numFrames = dims[1];
    numBins = dims[0];
  } else {
    numFrames = outputArray.length / numBins;
  }

  // Convert softmax output to F0 values
  const hopLength = 160; // RMVPE default
  const f0 = new Float32Array(numFrames);
  const confidence = new Float32Array(numFrames);

  // Frequency bins: 10 Hz to 2000 Hz, log-spaced
  const binFreqs = new Float32Array(numBins);
  for (let b = 0; b < numBins; b++) {
    binFreqs[b] = 10 * Math.exp(b * Math.log(2000 / 10) / (numBins - 1));
  }

  for (let f = 0; f < numFrames; f++) {
    let maxProb = 0;
    let maxBin = 0;

    for (let b = 0; b < numBins; b++) {
      const idx = b * numFrames + f;
      const prob = outputArray[idx] || 0;
      if (prob > maxProb) {
        maxProb = prob;
        maxBin = b;
      }
    }

    confidence[f] = maxProb;

    if (maxProb >= threshold && maxBin > 0) {
      const freq = binFreqs[maxBin];
      f0[f] = Math.max(F0_MIN, Math.min(F0_MAX, freq));
    } else {
      f0[f] = 0; // Unvoiced
    }
  }

  return {
    f0,
    confidence,
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
 * Load the RMVPE model.
 *
 * @param {Uint8Array} modelData - ONNX model data
 * @param {object} [options] - Session creation options
 * @returns {Promise<object>} Session metadata
 */
export async function loadRMVPEModel(modelData, options = {}) {
  return createSession('rmvpe', modelData, options);
}

/**
 * Interpolate unvoiced frames in an F0 contour.
 *
 * @param {Float32Array} f0 - F0 contour with zeros for unvoiced
 * @param {Float32Array} confidence - Per-frame confidence
 * @param {number} [confidenceThreshold=0.5] - Confidence threshold
 * @param {'linear'|'nearest'|'none'} [method='linear'] - Interpolation method
 * @returns {Float32Array} Interpolated F0 contour
 */
export function interpolateF0(f0, confidence, confidenceThreshold = 0.5, method = 'linear') {
  if (method === 'none') {
    return new Float32Array(f0);
  }

  const n = f0.length;
  const result = new Float32Array(f0);

  if (method === 'nearest') {
    // Forward-fill: replace unvoiced with last voiced value
    let lastVoiced = 0;
    for (let i = 0; i < n; i++) {
      if (confidence[i] >= confidenceThreshold && f0[i] > 0) {
        lastVoiced = f0[i];
      } else if (lastVoiced > 0) {
        result[i] = lastVoiced;
      }
    }
    // Backward-fill for leading unvoiced
    let nextVoiced = 0;
    for (let i = n - 1; i >= 0; i--) {
      if (confidence[i] >= confidenceThreshold && f0[i] > 0) {
        nextVoiced = f0[i];
      } else if (nextVoiced > 0) {
        result[i] = nextVoiced;
      }
    }
  } else if (method === 'linear') {
    // Linear interpolation
    let lastVoicedIdx = -1;
    let lastVoicedVal = 0;

    for (let i = 0; i < n; i++) {
      if (confidence[i] >= confidenceThreshold && f0[i] > 0) {
        if (lastVoicedIdx >= 0) {
          // Interpolate between last voiced and current
          const gap = i - lastVoicedIdx;
          for (let j = 1; j < gap; j++) {
            const t = j / gap;
            result[lastVoicedIdx + j] = lastVoicedVal * (1 - t) + f0[i] * t;
          }
        }
        lastVoicedIdx = i;
        lastVoicedVal = f0[i];
      }
    }

    // Backward-fill for leading unvoiced
    if (lastVoicedIdx > 0) {
      for (let i = 0; i < lastVoicedIdx; i++) {
        result[i] = lastVoicedVal;
      }
    }
  }

  return result;
}

export default {
  detectF0,
  loadRMVPEModel,
  interpolateF0,
};