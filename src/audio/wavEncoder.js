/**
 * WAV 编码工具
 * 将 Float32Array 音频数据编码为 32-bit float PCM WAV 文件
 */

// B2: use CommonJS require to match the rest of src/audio (audioWorker.js is
// forked directly and copied via CopyPlugin; mixing ESM/CJS can break under
// packaging config changes). smoothstep.js already exports via CommonJS.
const { smoothstep } = require('../utils/smoothstep.js');

const _TRIG_LUT_SIZE = 1024;
const _cosLut = new Float32Array(_TRIG_LUT_SIZE);
const _sinLut = new Float32Array(_TRIG_LUT_SIZE);
for (let i = 0; i < _TRIG_LUT_SIZE; i++) {
    const a = (i / _TRIG_LUT_SIZE) * 2 * Math.PI;
    _cosLut[i] = Math.cos(a);
    _sinLut[i] = Math.sin(a);
}
const _trigLutScale = _TRIG_LUT_SIZE / (2 * Math.PI);
const _PI4 = 0.7853981633974483;

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

  // 一次性 memcpy 替代逐样本 setFloat32（性能审查 §4 中优先级）
  new Float32Array(buffer, 44, audioData.length).set(audioData);

  return new Uint8Array(buffer);
}

/**
 * 将 Float32Array 编码为 WAV 文件的 Uint8Array
 * @param {Float32Array} float32Array 单声道音频数据，范围 [-1, 1]
 * @param {number} sampleRate 采样率（如 24000）
 * @returns {Uint8Array} WAV 文件数据
 */
function encodeWav(float32Array, sampleRate, numChannels = 1) {
  // B4: stereo WAV requires interleaved L,R sample pairs, so the data length
  // must be a multiple of 2 (blockAlign = numChannels * bitsPerSample/8 = 8).
  // If an odd-length array is passed for stereo, pad with a single zero
  // sample at the end so the WAV header (numChannels=2) matches the data
  // length. Padding preserves all original audio data and is backwards-
  // compatible.
  if (numChannels === 2 && float32Array.length % 2 !== 0) {
    const padded = new Float32Array(float32Array.length + 1);
    padded.set(float32Array);
    return _encodeWavBase(padded, sampleRate, 2);
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
    // LUT lookup for equal-power panning gains.
    // angle = (pan+1) * π/4 ∈ [0, π/2] for pan ∈ [-1, 1], within LUT coverage [0, 2π).
    const angle = (pan + 1) * _PI4;
    const lutIdx = ((angle * _trigLutScale) | 0) & (_TRIG_LUT_SIZE - 1);
    const leftGain = _cosLut[lutIdx];
    const rightGain = _sinLut[lutIdx];

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

// B2: use CommonJS module.exports to match the rest of src/audio modules.
module.exports = { encodeWav, applyEnvelopesToAudio };
