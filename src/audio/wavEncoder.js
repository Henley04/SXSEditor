/**
 * WAV 编码工具
 * 将 Float32Array 音频数据编码为 32-bit float PCM WAV 文件
 */

/**
 * 将 Float32Array 编码为 WAV 文件的 Uint8Array
 * @param {Float32Array} float32Array 单声道音频数据，范围 [-1, 1]
 * @param {number} sampleRate 采样率（如 24000）
 * @returns {Uint8Array} WAV 文件数据
 */
function encodeWav(float32Array, sampleRate, numChannels = 1) {
  if (numChannels === 2 && float32Array instanceof Float32Array && float32Array.length % 2 === 0) {
    return encodeWavStereo(float32Array, sampleRate);
  }
  const bitsPerSample = 32;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = float32Array.length * 4;
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

  for (let i = 0; i < float32Array.length; i++) {
    view.setFloat32(44 + i * 4, float32Array[i], true);
  }

  return new Uint8Array(buffer);
}

function encodeWavStereo(interleavedStereo, sampleRate) {
  const numChannels = 2;
  const bitsPerSample = 32;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = interleavedStereo.length * 4;
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

  for (let i = 0; i < interleavedStereo.length; i++) {
    view.setFloat32(44 + i * 4, interleavedStereo[i], true);
  }

  return new Uint8Array(buffer);
}

function applyEnvelopesToAudio(monoAudio, sampleRate, bpm, volumeEnvelope, panEnvelope) {
  const numSamples = monoAudio.length;
  const stereoData = new Float32Array(numSamples * 2);

  const hasVolume = volumeEnvelope && volumeEnvelope.keyframes && volumeEnvelope.keyframes.length > 0;
  const hasPan = panEnvelope && panEnvelope.keyframes && panEnvelope.keyframes.length > 0;

  for (let i = 0; i < numSamples; i++) {
    const timeSec = i / sampleRate;
    const beatTime = (timeSec / 60) * bpm;

    let volume = 1;
    if (hasVolume) {
      volume = _interpEnv(volumeEnvelope, beatTime);
    }

    let pan = 0;
    if (hasPan) {
      pan = _interpEnv(panEnvelope, beatTime);
    }

    const sample = monoAudio[i] * volume;
    const leftGain = Math.cos((pan + 1) * Math.PI / 4);
    const rightGain = Math.sin((pan + 1) * Math.PI / 4);

    stereoData[i * 2] = sample * leftGain;
    stereoData[i * 2 + 1] = sample * rightGain;
  }

  return stereoData;
}

function _interpEnv(envelope, time) {
  const kfs = envelope.keyframes;
  if (!kfs || kfs.length === 0) return 0;
  if (kfs.length === 1) return kfs[0].value;
  if (time <= kfs[0].time) return kfs[0].value;
  if (time >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;
  for (let i = 0; i < kfs.length - 1; i++) {
    if (time >= kfs[i].time && time <= kfs[i + 1].time) {
      const t = (time - kfs[i].time) / (kfs[i + 1].time - kfs[i].time);
      const smoothness = (kfs[i].smoothness || 0) / 100;
      const smoothT = smoothness > 0 ? t * t * (3 - 2 * t) : t;
      return kfs[i].value + smoothT * (kfs[i + 1].value - kfs[i].value);
    }
  }
  return kfs[kfs.length - 1].value;
}

export { encodeWav, applyEnvelopesToAudio };
