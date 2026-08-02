/**
 * resampleAudio.js - Audio resampling utilities.
 *
 * Provides resampling via linear interpolation (fast) and
 * high-quality resampling via the Web Audio API's AudioContext.
 */

/**
 * Resample audio data to a target sample rate using linear interpolation.
 * This is fast and suitable for real-time use.
 *
 * @param {Float32Array} audioData - Input audio samples.
 * @param {number} inputSampleRate - Original sample rate in Hz.
 * @param {number} outputSampleRate - Target sample rate in Hz.
 * @returns {Float32Array} Resampled audio data.
 */
export function resampleAudio(audioData, inputSampleRate, outputSampleRate) {
  if (!audioData || audioData.length === 0) {
    return new Float32Array(0);
  }

  if (inputSampleRate === outputSampleRate) {
    return audioData.slice();
  }

  if (inputSampleRate <= 0 || outputSampleRate <= 0) {
    throw new Error(`resampleAudio: invalid sample rates (in: ${inputSampleRate}, out: ${outputSampleRate})`);
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
 * Resample audio data to a target sample rate using the Web Audio API's
 * AudioContext for high-quality sample-rate conversion (typically uses
 * an IIR or polyphase filter internally).
 *
 * This is higher quality than linear interpolation but requires an
 * AudioContext and is asynchronous.
 *
 * @param {Float32Array} audioData - Input audio samples (mono or interleaved).
 * @param {number} inputSampleRate - Original sample rate in Hz.
 * @param {number} outputSampleRate - Target sample rate in Hz.
 * @param {Object} [options]
 * @param {number} [options.numChannels=1] - Number of channels in the input.
 * @param {AbortSignal} [options.signal] - Optional AbortSignal to cancel the operation.
 * @returns {Promise<Float32Array>} Resampled audio data.
 */
export async function resampleAudioHQ(audioData, inputSampleRate, outputSampleRate, options = {}) {
  if (!audioData || audioData.length === 0) {
    return new Float32Array(0);
  }

  if (inputSampleRate === outputSampleRate) {
    return audioData.slice();
  }

  if (inputSampleRate <= 0 || outputSampleRate <= 0) {
    throw new Error(`resampleAudioHQ: invalid sample rates (in: ${inputSampleRate}, out: ${outputSampleRate})`);
  }

  const { numChannels = 1, signal } = options;

  // Create an offline AudioContext at the target sample rate
  const numFrames = Math.floor(audioData.length / numChannels);

  let offlineCtx;
  try {
    offlineCtx = new OfflineAudioContext({
      numberOfChannels: numChannels,
      length: Math.round(numFrames * outputSampleRate / inputSampleRate),
      sampleRate: outputSampleRate,
    });
  } catch (err) {
    // Fallback: if OfflineAudioContext is not available (e.g., some workers),
    // use linear interpolation
    console.warn('[resampleAudio] OfflineAudioContext not available, falling back to linear interpolation');
    return resampleAudio(audioData, inputSampleRate, outputSampleRate);
  }

  if (signal && signal.aborted) {
    offlineCtx.close().catch(() => {});
    throw new DOMException('Aborted', 'AbortError');
  }

  // Create a buffer with the source audio
  const sourceBuffer = offlineCtx.createBuffer(numChannels, numFrames, inputSampleRate);
  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = sourceBuffer.getChannelData(ch);
    for (let i = 0; i < numFrames; i++) {
      channelData[i] = audioData[i * numChannels + ch];
    }
  }

  const source = offlineCtx.createBufferSource();
  source.buffer = sourceBuffer;
  source.connect(offlineCtx.destination);
  source.start();

  // Render the audio at the new sample rate
  let renderedBuffer;
  try {
    renderedBuffer = await offlineCtx.startRendering();
  } catch (err) {
    offlineCtx.close().catch(() => {});
    throw new Error(`resampleAudioHQ: rendering failed - ${err.message}`);
  } finally {
    offlineCtx.close().catch(() => {});
  }

  // Extract the rendered data as interleaved Float32Array
  const renderedFrames = renderedBuffer.length;
  const output = new Float32Array(renderedFrames * numChannels);
  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = renderedBuffer.getChannelData(ch);
    for (let i = 0; i < renderedFrames; i++) {
      output[i * numChannels + ch] = channelData[i];
    }
  }

  return output;
}

/**
 * Downmix a multi-channel audio buffer to mono, then resample.
 * Convenience function for common usage.
 *
 * @param {Float32Array} audioData - Interleaved multi-channel audio.
 * @param {number} numChannels - Number of channels.
 * @param {number} inputSampleRate - Original sample rate.
 * @param {number} outputSampleRate - Target sample rate.
 * @param {boolean} [highQuality=false] - Use HQ resampling (async).
 * @returns {Promise<Float32Array>|Float32Array} Resampled mono audio.
 */
export function resampleToMono(audioData, numChannels, inputSampleRate, outputSampleRate, highQuality = false) {
  // Convert to mono first
  const numFrames = Math.floor(audioData.length / numChannels);
  const mono = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      sum += audioData[i * numChannels + ch];
    }
    mono[i] = sum / numChannels;
  }

  if (highQuality) {
    return resampleAudioHQ(mono, inputSampleRate, outputSampleRate, { numChannels: 1 });
  }

  return resampleAudio(mono, inputSampleRate, outputSampleRate);
}

export default {
  resampleAudio,
  resampleAudioHQ,
  resampleToMono,
};