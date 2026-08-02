/**
 * audioOutputManager.js - Audio output manager using Web Audio API.
 *
 * Manages AudioContext lifecycle, playback of audio buffers, position tracking,
 * volume control, mute/unmute, and audio device enumeration.
 */

const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_CHANNELS = 1;

let audioContext = null;
let sourceNode = null;
let gainNode = null;
let _onEnded = null;
let isPlaying = false;
let startTime = 0;
let startOffset = 0; // seconds into the buffer at which playback started
let duration = 0;
let volume = 1.0;
let muted = false;
let _currentAudioData = null; // Float32Array mono mix
let _currentSampleRate = DEFAULT_SAMPLE_RATE;
let _currentChannels = DEFAULT_CHANNELS;

// Streaming support
let streamProcessor = null; // ScriptProcessorNode or AudioWorkletNode
let _streamCallback = null;

/**
 * Get or create the AudioContext, respecting a user-provided sample rate.
 * @param {number} [sampleRate=DEFAULT_SAMPLE_RATE]
 * @returns {AudioContext}
 */
function getAudioContext(sampleRate = DEFAULT_SAMPLE_RATE) {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate,
    });
  }
  return audioContext;
}

/**
 * Resume the AudioContext if it is suspended (required by browser autoplay policy).
 * @returns {Promise<AudioContext>}
 */
async function ensureAudioContext() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  return ctx;
}

/**
 * Check whether the Web Audio API is available.
 * @returns {boolean}
 */
export function isAvailable() {
  return !!(window.AudioContext || window.webkitAudioContext);
}

/**
 * Return the current sample rate of the AudioContext.
 * @returns {number}
 */
export function getSampleRate() {
  if (audioContext) return audioContext.sampleRate;
  return DEFAULT_SAMPLE_RATE;
}

/**
 * Enumerate available audio output devices.
 * Requires `navigator.mediaDevices.enumerateDevices()` which may need
 * user gesture or secure context.
 * @returns {Promise<Array<{deviceId: string, label: string, groupId: string}>>}
 */
export async function getAudioDevices() {
  const devices = [];
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return devices;
    }
    // Some browsers require a brief permission prompt to list audio outputs
    const all = await navigator.mediaDevices.enumerateDevices();
    for (const d of all) {
      if (d.kind === 'audiooutput') {
        devices.push({
          deviceId: d.deviceId,
          label: d.label || `Audio Output ${devices.length + 1}`,
          groupId: d.groupId,
        });
      }
    }
  } catch (err) {
    console.warn('[audioOutputManager] enumerateDevices failed:', err);
  }
  return devices;
}

/**
 * Set the audio output device (if supported by browser).
 * Uses `setSinkId` on the AudioContext destination.
 * @param {string} deviceId - The target output device ID.
 * @returns {Promise<boolean>}
 */
export async function setAudioDevice(deviceId) {
  try {
    const ctx = getAudioContext();
    if (typeof ctx.audioWorklet !== 'undefined' && ctx.destination.setSinkId) {
      await ctx.destination.setSinkId(deviceId);
      return true;
    }
    // Fallback: try on the audio element approach if we have one
    console.warn('[audioOutputManager] setSinkId not supported');
    return false;
  } catch (err) {
    console.error('[audioOutputManager] Failed to set audio device:', err);
    return false;
  }
}

/**
 * Set the onEnded callback, called when playback reaches the end of the buffer.
 * @param {Function|null} callback
 */
export function set onEnded(callback) {
  _onEnded = typeof callback === 'function' ? callback : null;
}

export function get onEnded() {
  return _onEnded;
}

/**
 * Play audio from a Float32Array (mono or interleaved multi-channel).
 *
 * @param {Float32Array} audioData - The audio samples (normalised -1..1).
 * @param {Object} [options]
 * @param {number} [options.sampleRate=44100] - Sample rate of the audio data.
 * @param {number} [options.channels=1] - Number of channels (1 = mono, 2 = stereo).
 * @param {number} [options.offset=0] - Start position in seconds.
 * @param {boolean} [options.loop=false] - Whether to loop playback.
 * @param {Function} [options.onEnded] - Shortcut to set onEnded for this call.
 * @returns {Promise<boolean>} Whether playback was started successfully.
 */
export async function play(audioData, options = {}) {
  if (!isAvailable()) {
    console.warn('[audioOutputManager] Web Audio API not available');
    return false;
  }

  const {
    sampleRate = DEFAULT_SAMPLE_RATE,
    channels = DEFAULT_CHANNELS,
    offset = 0,
    loop = false,
    onEnded: oneShotEnded = null,
  } = options;

  if (!audioData || audioData.length === 0) {
    console.warn('[audioOutputManager] No audio data provided');
    return false;
  }

  // Stop any current playback
  stop();

  const ctx = await ensureAudioContext();

  // Store for later queries
  _currentAudioData = audioData;
  _currentSampleRate = sampleRate;
  _currentChannels = channels;
  duration = audioData.length / sampleRate / channels;

  if (oneShotEnded) {
    _onEnded = oneShotEnded;
  }

  // Create an AudioBuffer from the Float32Array
  const buffer = ctx.createBuffer(channels, audioData.length / channels, sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < channelData.length; i++) {
      channelData[i] = audioData[i * channels + ch];
    }
  }

  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = buffer;
  sourceNode.loop = loop;

  gainNode = ctx.createGain();
  gainNode.gain.value = muted ? 0 : volume;

  sourceNode.connect(gainNode);
  gainNode.connect(ctx.destination);

  sourceNode.onended = () => {
    if (isPlaying) {
      isPlaying = false;
      if (_onEnded) {
        _onEnded();
      }
    }
  };

  const when = 0;
  startTime = ctx.currentTime;
  startOffset = Math.max(0, Math.min(offset, duration));
  sourceNode.start(when, startOffset);

  isPlaying = true;
  return true;
}

/**
 * Stop playback and reset state.
 */
export function stop() {
  if (sourceNode) {
    try {
      sourceNode.stop();
    } catch (_) {
      // Already stopped
    }
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (gainNode) {
    gainNode.disconnect();
    gainNode = null;
  }
  if (streamProcessor) {
    try {
      streamProcessor.disconnect();
    } catch (_) { /* ignore */ }
    streamProcessor = null;
  }
  isPlaying = false;
  startTime = 0;
  startOffset = 0;
  _streamCallback = null;
}

/**
 * Pause playback (retains position).
 */
export function pause() {
  if (!isPlaying) return;
  // Record current position
  const pos = getPosition();
  stop();
  startOffset = pos;
}

/**
 * Resume playback from the paused position.
 * @returns {Promise<boolean>}
 */
export async function resume() {
  if (isPlaying || !_currentAudioData) return false;
  return play(_currentAudioData, {
    sampleRate: _currentSampleRate,
    channels: _currentChannels,
    offset: startOffset,
  });
}

/**
 * Get the current playback position in seconds.
 * @returns {number}
 */
export function getPosition() {
  if (!isPlaying || !audioContext) {
    return Math.min(startOffset, duration);
  }
  const elapsed = audioContext.currentTime - startTime;
  const pos = startOffset + elapsed;
  if (pos >= duration) {
    // Playback has ended naturally
    return duration;
  }
  return pos;
}

/**
 * Seek to a specific position in seconds.
 * If currently playing, continues from the new position.
 * @param {number} seconds
 * @returns {Promise<boolean>}
 */
export async function seek(seconds) {
  const wasPlaying = isPlaying;
  const clamped = Math.max(0, Math.min(seconds, duration));
  startOffset = clamped;

  if (wasPlaying && _currentAudioData) {
    stop();
    return play(_currentAudioData, {
      sampleRate: _currentSampleRate,
      channels: _currentChannels,
      offset: clamped,
    });
  }
  return true;
}

/**
 * Get the total duration of the currently loaded audio in seconds.
 * @returns {number}
 */
export function getDuration() {
  return duration;
}

/**
 * Set the playback volume (0.0 – 1.0).
 * @param {number} value
 */
export function setVolume(value) {
  volume = Math.max(0, Math.min(1, value));
  if (gainNode) {
    gainNode.gain.value = muted ? 0 : volume;
  }
}

/**
 * Get the current volume level (0.0 – 1.0).
 * @returns {number}
 */
export function getVolume() {
  return volume;
}

/**
 * Mute playback.
 */
export function mute() {
  muted = true;
  if (gainNode) {
    gainNode.gain.value = 0;
  }
}

/**
 * Unmute playback, restoring the previous volume level.
 */
export function unmute() {
  muted = false;
  if (gainNode) {
    gainNode.gain.value = volume;
  }
}

/**
 * Toggle mute state.
 * @returns {boolean} New muted state.
 */
export function toggleMute() {
  if (muted) {
    unmute();
  } else {
    mute();
  }
  return muted;
}

/**
 * Check whether the audio is currently muted.
 * @returns {boolean}
 */
export function isMuted() {
  return muted;
}

/**
 * Check whether audio is currently playing.
 * @returns {boolean}
 */
export function getIsPlaying() {
  return isPlaying;
}

// --- Streaming support via ScriptProcessorNode (deprecated but widely supported) ---

/**
 * Start streaming audio processing via ScriptProcessorNode.
 * The callback receives (Float32Array) and should fill it with samples.
 *
 * @param {Function} onAudioProcess - callback(audioData: Float32Array) that fills the buffer.
 * @param {number} [bufferSize=4096] - Must be a power of 2 (256, 512, 1024, 2048, 4096, 8192, 16384).
 * @param {Object} [options]
 * @param {number} [options.sampleRate=44100]
 * @param {number} [options.channels=1]
 * @returns {boolean}
 */
export function startStreaming(onAudioProcess, bufferSize = 4096, options = {}) {
  if (!isAvailable()) return false;
  if (typeof onAudioProcess !== 'function') {
    console.warn('[audioOutputManager] startStreaming requires a callback function');
    return false;
  }

  const { sampleRate = DEFAULT_SAMPLE_RATE, channels = DEFAULT_CHANNELS } = options;
  stop();

  const ctx = getAudioContext(sampleRate);

  gainNode = ctx.createGain();
  gainNode.gain.value = muted ? 0 : volume;

  // Use ScriptProcessorNode for maximum compatibility
  streamProcessor = ctx.createScriptProcessor(bufferSize, 0, channels);
  _streamCallback = onAudioProcess;

  streamProcessor.onaudioprocess = (event) => {
    const output = event.outputBuffer;
    const numChannels = output.numberOfChannels;
    const len = output.length;
    const tempBuffer = new Float32Array(len * numChannels);

    _streamCallback(tempBuffer);

    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = output.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        channelData[i] = tempBuffer[i * numChannels + ch] || 0;
      }
    }
  };

  streamProcessor.connect(gainNode);
  gainNode.connect(ctx.destination);

  isPlaying = true;
  _currentAudioData = null;
  duration = Infinity; // streaming has indefinite duration
  return true;
}

/**
 * Stop streaming mode.
 */
export function stopStreaming() {
  if (streamProcessor) {
    try {
      streamProcessor.disconnect();
    } catch (_) { /* ignore */ }
    streamProcessor = null;
  }
  _streamCallback = null;
  if (isPlaying) {
    isPlaying = false;
  }
}

/**
 * Clean up all audio resources, close the AudioContext.
 */
export function destroy() {
  stop();
  stopStreaming();
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  _currentAudioData = null;
  _onEnded = null;
  duration = 0;
  startOffset = 0;
}

export default {
  isAvailable,
  getSampleRate,
  getAudioDevices,
  setAudioDevice,
  set onEnded(cb) { _onEnded = cb; },
  get onEnded() { return _onEnded; },
  play,
  stop,
  pause,
  resume,
  getPosition,
  seek,
  getDuration,
  setVolume,
  getVolume,
  mute,
  unmute,
  toggleMute,
  isMuted,
  getIsPlaying,
  startStreaming,
  stopStreaming,
  destroy,
};