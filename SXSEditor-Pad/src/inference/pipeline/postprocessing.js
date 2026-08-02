/**
 * postprocessing.js
 * Audio postprocessing for the SXSEditor-Pad SVS pipeline.
 *
 * Converts model output tensors to audio waveforms,
 * applies loudness normalisation, and formats output.
 *
 * @module inference/pipeline/postprocessing
 */

import { SAMPLE_RATE, HOP_LENGTH } from './constants.js';
import { loudnorm } from './loudnorm.js';

/**
 * Convert a mel spectrogram tensor to audio waveform using the vocoder model.
 *
 * @param {object} ort - ONNX Runtime module
 * @param {import('onnxruntime-web').InferenceSession} vocoderSession - Vocoder session
 * @param {import('onnxruntime-web').Tensor} melTensor - Mel spectrogram tensor
 * @returns {Promise<Float32Array>} Audio waveform samples
 */
export async function melToAudio(ort, vocoderSession, melTensor) {
  const feeds = {};
  feeds[vocoderSession.inputNames[0]] = melTensor;

  const results = await vocoderSession.run(feeds);
  const outputName = vocoderSession.outputNames[0];
  const audioTensor = results[outputName];

  // Extract audio data (shape: [1, 1, audio_len] or [1, audio_len])
  let audioData;
  if (audioTensor.dims.length === 3) {
    audioData = new Float32Array(audioTensor.data);
  } else if (audioTensor.dims.length === 2) {
    audioData = new Float32Array(audioTensor.data);
  } else {
    audioData = new Float32Array(audioTensor.data);
  }

  return audioData;
}

/**
 * Convert a model output tensor directly to audio (for end-to-end models).
 *
 * @param {import('onnxruntime-web').InferenceSession} session
 * @param {import('onnxruntime-web').Tensor} outputTensor
 * @returns {Float32Array} Audio samples
 */
export function tensorToAudio(session, outputTensor) {
  // The output tensor may be the waveform directly
  const data = new Float32Array(outputTensor.data);
  return data;
}

/**
 * Apply loudness normalisation to the output audio.
 *
 * @param {Float32Array} audio - Raw audio samples
 * @param {number} [targetLUFS=-14] - Target loudness
 * @returns {Float32Array} Normalised audio
 */
export function normalizeAudio(audio, targetLUFS = -14) {
  return loudnorm(audio, targetLUFS);
}

/**
 * Format the output audio for playback or export.
 *
 * @param {Float32Array} samples - Audio samples (range [-1, 1])
 * @param {number} [sampleRate=SAMPLE_RATE] - Sample rate
 * @returns {Promise<{ samples: Float32Array, sampleRate: number, duration: number }>}
 */
export async function formatOutput(samples, sampleRate = SAMPLE_RATE) {
  const duration = samples.length / sampleRate;

  return {
    samples,
    sampleRate,
    duration,
  };
}

/**
 * Convert audio samples to a WAV ArrayBuffer.
 * Useful for creating a playable blob for the Web Audio API.
 *
 * @param {Float32Array} samples - Audio samples (range [-1, 1])
 * @param {number} [sampleRate=SAMPLE_RATE] - Sample rate
 * @returns {ArrayBuffer} WAV file as ArrayBuffer
 */
export function samplesToWav(samples, sampleRate = SAMPLE_RATE) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * blockAlign;
  const bufferSize = 44 + dataSize;

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, bufferSize - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write samples (16-bit PCM)
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    view.setInt16(offset, intSample, true);
    offset += 2;
  }

  return buffer;
}

/**
 * Helper: write a string to a DataView at a given offset.
 *
 * @param {DataView} view
 * @param {number} offset
 * @param {string} str
 */
function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Apply a simple gain to the audio.
 *
 * @param {Float32Array} samples
 * @param {number} gain - Gain factor (1.0 = no change)
 * @returns {Float32Array}
 */
export function applyGain(samples, gain) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return out;
}

export default {
  melToAudio,
  tensorToAudio,
  normalizeAudio,
  formatOutput,
  samplesToWav,
  applyGain,
};