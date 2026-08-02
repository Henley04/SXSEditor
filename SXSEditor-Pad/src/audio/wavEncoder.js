/**
 * wavEncoder.js - WAV encoder.
 *
 * Encodes Float32Array audio data to WAV format with support for
 * different sample rates and bit depths (16-bit, 24-bit, 32-bit float).
 */

/**
 * Encode a Float32Array to a WAV file as an ArrayBuffer.
 *
 * @param {Float32Array} audioData - Interleaved audio samples normalised to -1..1.
 * @param {Object} [options]
 * @param {number} [options.sampleRate=44100] - Sample rate in Hz.
 * @param {number} [options.numChannels=1] - Number of channels (1 = mono, 2 = stereo).
 * @param {number} [options.bitDepth=16] - Bits per sample. Supported: 16, 24, 32.
 * @returns {ArrayBuffer} The complete WAV file.
 */
export function encodeWav(audioData, options = {}) {
  const {
    sampleRate = 44100,
    numChannels = 1,
    bitDepth = 16,
  } = options;

  if (!audioData || audioData.length === 0) {
    throw new Error('encodeWav: audioData is empty');
  }

  const validBitDepths = [16, 24, 32];
  if (!validBitDepths.includes(bitDepth)) {
    throw new Error(`encodeWav: unsupported bit depth ${bitDepth}. Supported: ${validBitDepths.join(', ')}`);
  }

  const bytesPerSample = bitDepth / 8;
  const dataByteCount = audioData.length * bytesPerSample;
  const headerSize = 44;
  const totalSize = headerSize + dataByteCount;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // ---- Write helpers ----
  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // ---- RIFF header ----
  writeString(0, 'RIFF');
  view.setUint32(4, totalSize - 8, true); // Chunk size (file size minus RIFF header)
  writeString(8, 'WAVE');

  // ---- fmt sub-chunk ----
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Sub-chunk size (16 for PCM)

  const audioFormat = bitDepth === 32 ? 3 : 1; // 3 = IEEE float, 1 = PCM
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // Byte rate
  view.setUint16(32, numChannels * bytesPerSample, true); // Block align
  view.setUint16(34, bitDepth, true);

  // ---- data sub-chunk ----
  writeString(36, 'data');
  view.setUint32(40, dataByteCount, true);

  // ---- Write PCM samples ----
  let byteIndex = 44;

  for (let i = 0; i < audioData.length; i++) {
    // Clamp sample to [-1, 1]
    const sample = Math.max(-1, Math.min(1, audioData[i]));

    switch (bitDepth) {
      case 16: {
        // Signed 16-bit integer
        const intVal = sample < 0
          ? Math.round(sample * 32768)
          : Math.round(sample * 32767);
        view.setInt16(byteIndex, intVal, true);
        byteIndex += 2;
        break;
      }

      case 24: {
        // Signed 24-bit integer (little-endian)
        const intVal = sample < 0
          ? Math.round(sample * 8388608)
          : Math.round(sample * 8388607);
        // Write as two's complement 24-bit (3 bytes)
        let val = intVal;
        if (val < 0) {
          val = (val + 0x1000000) & 0xFFFFFF;
        }
        view.setUint8(byteIndex, val & 0xFF);
        view.setUint8(byteIndex + 1, (val >> 8) & 0xFF);
        view.setUint8(byteIndex + 2, (val >> 16) & 0xFF);
        byteIndex += 3;
        break;
      }

      case 32: {
        if (audioFormat === 3) {
          // 32-bit IEEE float
          view.setFloat32(byteIndex, sample, true);
        } else {
          // Signed 32-bit integer
          const intVal = sample < 0
            ? Math.round(sample * 2147483648)
            : Math.round(sample * 2147483647);
          view.setInt32(byteIndex, intVal, true);
        }
        byteIndex += 4;
        break;
      }

      default:
        // Should never reach here due to validation above
        throw new Error(`encodeWav: unexpected bit depth ${bitDepth}`);
    }
  }

  return buffer;
}

/**
 * Encode a Float32Array to a WAV Blob (convenience wrapper).
 *
 * @param {Float32Array} audioData
 * @param {Object} [options]
 * @param {number} [options.sampleRate=44100]
 * @param {number} [options.numChannels=1]
 * @param {number} [options.bitDepth=16]
 * @returns {Blob} A WAV Blob with audio/wav MIME type.
 */
export function encodeWavBlob(audioData, options = {}) {
  const arrayBuffer = encodeWav(audioData, options);
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

/**
 * Encode a Float32Array to a WAV data URL (convenience wrapper).
 *
 * @param {Float32Array} audioData
 * @param {Object} [options]
 * @param {number} [options.sampleRate=44100]
 * @param {number} [options.numChannels=1]
 * @param {number} [options.bitDepth=16]
 * @returns {string} A data URL representing the WAV file.
 */
export function encodeWavDataUrl(audioData, options = {}) {
  const blob = encodeWavBlob(audioData, options);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('encodeWavDataUrl: FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

export default {
  encodeWav,
  encodeWavBlob,
  encodeWavDataUrl,
};