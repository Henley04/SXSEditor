/**
 * WAV 编码工具
 * 将 Float32Array 音频数据编码为 32-bit float PCM WAV 文件
 */

import { smoothstep } from '../utils/smoothstep.js';

/**
 * WAV 编码内部实现
 * @param {Float32Array} audioData 音频数据（单声道或交错立体声）
 * @param {number} sampleRate 采样率
 * @param {number} numChannels 声道数（1 或 2）
 * @returns {Uint8Array} WAV 文件数据
 */
function _encodeWavBase(audioData, sampleRate, numChannels) {
  const bitsPerSample = 32;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = audioData.length * 4;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < audioData.length; i++) {
    view.setFloat32(44 + i * 4, audioData[i], true);
  }

  return new Uint8Array(buffer);
}

/**
 * 将 Float32Array 编码为 WAV 文件的 Uint8Array
 * @param {Float32Array} float32Array 单声道音频数据，范围 [-1, 1]
 * @param {number} sampleRate 采样率（如 24000）
 * @returns {Uint8Array} WAV 文件数据
 */
function encodeWav(float32Array, sampleRate, numChannels = 1) {
  if (numChannels === 2 && float32Array instanceof Float32Array && float32Array.length % 2 === 0) {
    return _encodeWavBase(float32Array, sampleRate, 2);
  }
  return _encodeWavBase(float32Array, sampleRate, numChannels);
}

function encodeWavStereo(interleavedStereo, sampleRate) {
  return _encodeWavBase(interleavedStereo, sampleRate, 2);
}

function applyEnvelopesToAudio(monoAudio, sampleRate, bpm, volumeEnvelope, panEnvelope) {
  const numSamples = monoAudio.length;
  const stereoData = new Float32Array(numSamples * 2);

  const hasVolume = volumeEnvelope && volumeEnvelope.keyframes && volumeEnvelope.keyframes.length > 0;
  const hasPan = panEnvelope && panEnvelope.keyframes && panEnvelope.keyframes.length > 0;

  // Precompute beat time increment to avoid per-sample division
  const beatTimeInc = bpm / (60 * sampleRate);
  let beatTime = 0;

  for (let i = 0; i < numSamples; i++) {
    let volume = 1;
    if (hasVolume) {
      volume = _interpEnv(volumeEnvelope, beatTime);
    }

    let pan = 0;
    if (hasPan) {
      pan = _interpEnv(panEnvelope, beatTime);
    }

    const sample = monoAudio[i] * volume;
    const leftGain = Math.cos((pan + 1) * 0.7853981633974483); // PI/4 precomputed
    const rightGain = Math.sin((pan + 1) * 0.7853981633974483);

    stereoData[i * 2] = sample * leftGain;
    stereoData[i * 2 + 1] = sample * rightGain;
    beatTime += beatTimeInc;
  }

  return stereoData;
}

function _interpEnv(envelope, time) {
  const kfs = envelope.keyframes;
  const len = kfs.length;
  if (len === 0) return 0;
  if (len === 1) return kfs[0].value;
  if (time <= kfs[0].time) return kfs[0].value;
  if (time >= kfs[len - 1].time) return kfs[len - 1].value;

  // Binary search for the segment containing `time`
  let lo = 0, hi = len - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (kfs[mid].time <= time) lo = mid;
    else hi = mid;
  }
  const t = (time - kfs[lo].time) / (kfs[lo + 1].time - kfs[lo].time);
  const smoothness = (kfs[lo].smoothness || 0) / 100;
  const smoothT = smoothstep(t, smoothness);
  return kfs[lo].value + smoothT * (kfs[lo + 1].value - kfs[lo].value);
}

export { encodeWav, applyEnvelopesToAudio };
