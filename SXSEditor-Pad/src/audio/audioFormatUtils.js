/**
 * audioFormatUtils.js - Audio format utilities.
 *
 * Provides WAV file parsing (read/write), sample-rate conversion,
 * channel conversion (mono/stereo), audio normalisation, and
 * Float32Array <-> Int16Array conversion.
 */

const WAV_HEADER_SIZE = 44;

/**
 * Parse a WAV file from an ArrayBuffer and return the decoded audio data.
 *
 * @param {ArrayBuffer} buffer - Raw WAV file data.
 * @returns {{ sampleRate: number, numChannels: number, bitDepth: number, data: Float32Array }}
 * @throws {Error} If the buffer is not a valid WAV file.
 */
export function readWavFile(buffer) {
  const view = new DataView(buffer);

  // RIFF header
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') {
    throw new Error('Not a valid WAV file: missing RIFF header');
  }

  const fileSize = view.getUint32(4, true);

  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (wave !== 'WAVE') {
    throw new Error('Not a valid WAV file: missing WAVE identifier');
  }

  // Parse chunks
  let offset = 12;
  let fmtFound = false;
  let dataFound = false;

  let audioFormat = 1; // PCM
  let numChannels = 1;
  let sampleRate = 44100;
  let byteRate = 0;
  let blockAlign = 0;
  let bitDepth = 16;
  let dataChunkSize = 0;
  let dataOffset = 0;

  while (offset < buffer.byteLength - 8) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3)
    );
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      fmtFound = true;
      audioFormat = view.getUint16(offset + 8, true);
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      byteRate = view.getUint32(offset + 16, true);
      blockAlign = view.getUint16(offset + 20, true);
      bitDepth = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataFound = true;
      dataChunkSize = chunkSize;
      dataOffset = offset + 8;
    }

    offset += 8 + chunkSize;
    // Chunks are padded to even offset
    if (chunkSize % 2 !== 0) offset += 1;
  }

  if (!fmtFound) {
    throw new Error('Not a valid WAV file: missing fmt chunk');
  }
  if (!dataFound) {
    throw new Error('Not a valid WAV file: missing data chunk');
  }

  // Read raw PCM samples
  const numSamples = dataChunkSize / (bitDepth / 8);
  const data = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const byteIndex = dataOffset + i * (bitDepth / 8);
    let sample = 0;

    switch (bitDepth) {
      case 8: {
        // Unsigned 8-bit
        sample = (view.getUint8(byteIndex) - 128) / 128;
        break;
      }
      case 16: {
        // Signed 16-bit
        sample = view.getInt16(byteIndex, true) / 32768;
        break;
      }
      case 24: {
        // Signed 24-bit (little-endian)
        let val = view.getUint8(byteIndex)
          | (view.getUint8(byteIndex + 1) << 8)
          | (view.getUint8(byteIndex + 2) << 16);
        // Sign extend
        if (val & 0x800000) {
          val |= ~0xFFFFFF;
        }
        sample = val / 8388608; // 2^23
        break;
      }
      case 32: {
        // Signed 32-bit or float
        if (audioFormat === 3) {
          // IEEE float 32-bit
          sample = view.getFloat32(byteIndex, true);
        } else {
          sample = view.getInt32(byteIndex, true) / 2147483648; // 2^31
        }
        break;
      }
      default:
        throw new Error(`Unsupported bit depth: ${bitDepth}`);
    }

    data[i] = sample;
  }

  return {
    sampleRate,
    numChannels,
    bitDepth,
    data,
  };
}

/**
 * Write audio data to a WAV file ArrayBuffer.
 *
 * @param {Float32Array} audioData - Interleaved audio samples (-1..1).
 * @param {Object} [options]
 * @param {number} [options.sampleRate=44100] - Sample rate in Hz.
 * @param {number} [options.numChannels=1] - Number of channels.
 * @param {number} [options.bitDepth=16] - Bits per sample (16, 24, or 32).
 * @returns {ArrayBuffer} The complete WAV file as an ArrayBuffer.
 */
export function writeWavFile(audioData, options = {}) {
  const {
    sampleRate = 44100,
    numChannels = 1,
    bitDepth = 16,
  } = options;

  const numSamples = audioData.length;
  const bytesPerSample = bitDepth / 8;
  const dataByteCount = numSamples * bytesPerSample;
  const headerSize = 44;
  const totalSize = headerSize + dataByteCount;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // Helper to write a string into the buffer
  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // RIFF header
  writeString(0, 'RIFF');
  view.setUint32(4, totalSize - 8, true); // File size - 8
  writeString(8, 'WAVE');

  // fmt sub-chunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Sub-chunk size (16 for PCM)
  const audioFormat = bitDepth === 32 ? 3 : 1; // 3 = IEEE float, 1 = PCM
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true); // block align
  view.setUint16(34, bitDepth, true);

  // data sub-chunk
  writeString(36, 'data');
  view.setUint32(40, dataByteCount, true);

  // Write PCM samples
  let byteIndex = 44;
  for (let i = 0; i < numSamples; i++) {
    let sample = Math.max(-1, Math.min(1, audioData[i])); // clamp

    switch (bitDepth) {
      case 16: {
        const intSample = sample < 0 ? sample * 32768 : sample * 32767;
        view.setInt16(byteIndex, Math.round(intSample), true);
        byteIndex += 2;
        break;
      }
      case 24: {
        const int24 = sample < 0 ? sample * 8388608 : sample * 8388607;
        let val = Math.round(int24);
        if (val < 0) val += 0x1000000; // two's complement for 24-bit
        view.setUint8(byteIndex, val & 0xFF);
        view.setUint8(byteIndex + 1, (val >> 8) & 0xFF);
        view.setUint8(byteIndex + 2, (val >> 16) & 0xFF);
        byteIndex += 3;
        break;
      }
      case 32: {
        if (audioFormat === 3) {
          // IEEE float 32-bit
          view.setFloat32(byteIndex, sample, true);
        } else {
          const int32 = sample < 0 ? sample * 2147483648 : sample * 2147483647;
          view.setInt32(byteIndex, Math.round(int32), true);
        }
        byteIndex += 4;
        break;
      }
      default:
        throw new Error(`Unsupported bit depth: ${bitDepth}`);
    }
  }

  return buffer;
}

/**
 * Convert a multi-channel interleaved Float32Array to mono by averaging channels.
 *
 * @param {Float32Array} interleaved - Interleaved multi-channel audio data.
 * @param {number} numChannels - Number of channels in the input.
 * @returns {Float32Array} Mono audio data.
 */
export function convertToMono(interleaved, numChannels) {
  if (numChannels === 1) return interleaved.slice();
  const numFrames = Math.floor(interleaved.length / numChannels);
  const mono = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      sum += interleaved[i * numChannels + ch];
    }
    mono[i] = sum / numChannels;
  }
  return mono;
}

/**
 * Convert a mono Float32Array to stereo by duplicating the channel.
 *
 * @param {Float32Array} mono - Mono audio data.
 * @returns {Float32Array} Interleaved stereo audio data (L,R,L,R,...).
 */
export function convertToStereo(mono) {
  const stereo = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    stereo[i * 2] = mono[i];
    stereo[i * 2 + 1] = mono[i];
  }
  return stereo;
}

/**
 * Resample audio data to a target sample rate using linear interpolation.
 *
 * @param {Float32Array} audioData - Input audio samples.
 * @param {number} inputSampleRate - Original sample rate.
 * @param {number} outputSampleRate - Target sample rate.
 * @returns {Float32Array} Resampled audio data.
 */
export function resampleAudio(audioData, inputSampleRate, outputSampleRate) {
  if (inputSampleRate === outputSampleRate) {
    return audioData.slice();
  }

  const ratio = outputSampleRate / inputSampleRate;
  const outputLength = Math.round(audioData.length * ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const inputIndex = i / ratio;
    const indexFloor = Math.floor(inputIndex);
    const frac = inputIndex - indexFloor;
    const indexCeil = Math.min(indexFloor + 1, audioData.length - 1);

    output[i] = audioData[indexFloor] * (1 - frac) + audioData[indexCeil] * frac;
  }

  return output;
}

/**
 * Normalise audio data to peak amplitude = 1.0 (or a specified max).
 *
 * @param {Float32Array} audioData - Input audio samples.
 * @param {number} [targetMax=1.0] - Target peak amplitude.
 * @returns {Float32Array} Normalised audio data.
 */
export function normalizeAudio(audioData, targetMax = 1.0) {
  let peak = 0;
  for (let i = 0; i < audioData.length; i++) {
    const abs = Math.abs(audioData[i]);
    if (abs > peak) peak = abs;
  }

  if (peak === 0) return audioData.slice();

  const gain = targetMax / peak;
  const result = new Float32Array(audioData.length);
  for (let i = 0; i < audioData.length; i++) {
    result[i] = audioData[i] * gain;
  }
  return result;
}

/**
 * Convert a Float32Array (-1..1) to Int16Array.
 *
 * @param {Float32Array} floatData - Normalised float samples (-1..1).
 * @returns {Int16Array} 16-bit integer samples.
 */
export function float32ToInt16(floatData) {
  const int16 = new Int16Array(floatData.length);
  for (let i = 0; i < floatData.length; i++) {
    const s = Math.max(-1, Math.min(1, floatData[i]));
    int16[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return int16;
}

/**
 * Convert an Int16Array to Float32Array (-1..1).
 *
 * @param {Int16Array} int16Data - 16-bit integer samples.
 * @returns {Float32Array} Normalised float samples (-1..1).
 */
export function int16ToFloat32(int16Data) {
  const float32 = new Float32Array(int16Data.length);
  for (let i = 0; i < int16Data.length; i++) {
    const val = int16Data[i];
    float32[i] = val / (val < 0 ? 32768 : 32767);
  }
  return float32;
}

/**
 * Convert a Float32Array to Uint8Array (8-bit unsigned).
 *
 * @param {Float32Array} floatData - Normalised float samples (-1..1).
 * @returns {Uint8Array} 8-bit unsigned samples (0-255).
 */
export function float32ToUint8(floatData) {
  const uint8 = new Uint8Array(floatData.length);
  for (let i = 0; i < floatData.length; i++) {
    const s = Math.max(-1, Math.min(1, floatData[i]));
    uint8[i] = Math.round((s + 1) * 127.5);
  }
  return uint8;
}

/**
 * Convert a Uint8Array (8-bit unsigned) to Float32Array (-1..1).
 *
 * @param {Uint8Array} uint8Data - 8-bit unsigned samples.
 * @returns {Float32Array} Normalised float samples (-1..1).
 */
export function uint8ToFloat32(uint8Data) {
  const float32 = new Float32Array(uint8Data.length);
  for (let i = 0; i < uint8Data.length; i++) {
    float32[i] = uint8Data[i] / 127.5 - 1;
  }
  return float32;
}

/**
 * Mix multiple Float32Array buffers together (sum with optional gain per track).
 * All buffers must have the same length.
 *
 * @param {Float32Array[]} buffers - Array of audio buffers to mix.
 * @param {number[]} [gains] - Per-buffer gain (default 1.0 for each).
 * @returns {Float32Array} Mixed audio buffer.
 */
export function mixAudio(buffers, gains) {
  if (buffers.length === 0) return new Float32Array(0);

  const len = buffers[0].length;
  const result = new Float32Array(len);

  for (let i = 0; i < buffers.length; i++) {
    const buf = buffers[i];
    const gain = (gains && gains[i] !== undefined) ? gains[i] : 1.0;
    for (let j = 0; j < len && j < buf.length; j++) {
      result[j] += buf[j] * gain;
    }
  }

  return result;
}

/**
 * Apply a simple fade-in / fade-out envelope to the audio data.
 *
 * @param {Float32Array} audioData - Input audio.
 * @param {number} fadeInMs - Fade-in duration in milliseconds.
 * @param {number} fadeOutMs - Fade-out duration in milliseconds.
 * @param {number} sampleRate - Sample rate in Hz.
 * @returns {Float32Array} Processed audio (new array).
 */
export function applyFade(audioData, fadeInMs, fadeOutMs, sampleRate) {
  const result = audioData.slice();
  const fadeInSamples = Math.round((fadeInMs / 1000) * sampleRate);
  const fadeOutSamples = Math.round((fadeOutMs / 1000) * sampleRate);
  const len = result.length;

  // Fade in
  for (let i = 0; i < fadeInSamples && i < len; i++) {
    result[i] *= i / fadeInSamples;
  }

  // Fade out
  for (let i = 0; i < fadeOutSamples && i < len; i++) {
    const idx = len - 1 - i;
    result[idx] *= i / fadeOutSamples;
  }

  return result;
}

export default {
  readWavFile,
  writeWavFile,
  convertToMono,
  convertToStereo,
  resampleAudio,
  normalizeAudio,
  float32ToInt16,
  int16ToFloat32,
  float32ToUint8,
  uint8ToFloat32,
  mixAudio,
  applyFade,
};