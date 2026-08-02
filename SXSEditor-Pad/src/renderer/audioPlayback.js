import { SAMPLE_RATE } from './constants.js';
import {
  getPlayback,
  setPlaybackPlaying,
  setPlaybackPosition,
  setPlaybackDuration,
  getProject,
} from './state.js';
import { requestRender } from './timelineRenderer.js';

let audioContext = null;
let audioBuffer = null;
let sourceNode = null;
let gainNode = null;
let startTime = 0;
let startOffset = 0; // position in seconds when playback started
let scheduledStopTime = 0;
let animationFrameId = null;
let onEndedCallback = null;

/**
 * Get or create the AudioContext.
 */
function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: SAMPLE_RATE,
    });
  }
  return audioContext;
}

/**
 * Resume the AudioContext if it's suspended (required by browser autoplay policy).
 */
async function ensureAudioContext() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  return ctx;
}

/**
 * Set the callback for when playback ends naturally.
 */
export function setOnEnded(callback) {
  onEndedCallback = callback;
}

/**
 * Update position tracking via requestAnimationFrame.
 */
function startPositionTracking() {
  function track() {
    if (!getPlayback().isPlaying) return;
    const ctx = getAudioContext();
    const elapsed = ctx.currentTime - startTime;
    const position = startOffset + elapsed;

    if (audioBuffer && position >= audioBuffer.duration) {
      // Playback finished
      setPlaybackPlaying(false);
      setPlaybackPosition(0);
      requestRender();
      if (onEndedCallback) onEndedCallback();
      return;
    }

    setPlaybackPosition(position * (getProject().bpm / 60)); // convert seconds to beats
    requestRender();
    animationFrameId = requestAnimationFrame(track);
  }
  animationFrameId = requestAnimationFrame(track);
}

function stopPositionTracking() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

/**
 * Load an audio buffer from an ArrayBuffer.
 */
export async function loadAudioBuffer(arrayBuffer) {
  try {
    const ctx = getAudioContext();
    audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    setPlaybackDuration(audioBuffer.duration);
    return true;
  } catch (err) {
    console.error('[audioPlayback] Failed to decode audio data:', err);
    return false;
  }
}

/**
 * Load audio from a URL via fetch.
 */
export async function loadAudioFromUrl(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    return await loadAudioBuffer(arrayBuffer);
  } catch (err) {
    console.error('[audioPlayback] Failed to load audio from URL:', err);
    return false;
  }
}

/**
 * Load audio from a Blob.
 */
export async function loadAudioFromBlob(blob) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    return await loadAudioBuffer(arrayBuffer);
  } catch (err) {
    console.error('[audioPlayback] Failed to load audio from blob:', err);
    return false;
  }
}

/**
 * Start or resume playback.
 */
export async function play(positionInBeats) {
  if (!audioBuffer) {
    console.warn('[audioPlayback] No audio buffer loaded');
    return;
  }

  const ctx = await ensureAudioContext();

  // Stop any existing playback
  stop();

  const bpm = getProject().bpm;
  const pos = positionInBeats !== undefined ? positionInBeats : getPlayback().position;
  const offsetSeconds = bpm > 0 ? pos / (bpm / 60) : 0;

  if (offsetSeconds >= audioBuffer.duration) {
    setPlaybackPosition(0);
    startOffset = 0;
  } else {
    startOffset = offsetSeconds;
  }

  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = audioBuffer;

  gainNode = ctx.createGain();
  gainNode.gain.value = 1.0;

  sourceNode.connect(gainNode);
  gainNode.connect(ctx.destination);

  sourceNode.onended = () => {
    if (getPlayback().isPlaying) {
      setPlaybackPlaying(false);
      setPlaybackPosition(0);
      stopPositionTracking();
      requestRender();
      if (onEndedCallback) onEndedCallback();
    }
  };

  startTime = ctx.currentTime;
  sourceNode.start(0, startOffset);

  setPlaybackPlaying(true);
  startPositionTracking();
  requestRender();
}

/**
 * Pause playback.
 */
export function pause() {
  if (!getPlayback().isPlaying) return;

  const ctx = getAudioContext();
  const elapsed = ctx.currentTime - startTime;
  const position = startOffset + elapsed;

  stop();

  setPlaybackPosition(position * (getProject().bpm / 60));
  setPlaybackPlaying(false);
  requestRender();
}

/**
 * Toggle between play and pause.
 */
export function togglePlay() {
  if (getPlayback().isPlaying) {
    pause();
  } else {
    play();
  }
}

/**
 * Stop playback and reset position to 0.
 */
export function stopPlayback() {
  stop();
  setPlaybackPlaying(false);
  setPlaybackPosition(0);
  requestRender();
}

/**
 * Internal stop — disconnects the source node.
 */
function stop() {
  stopPositionTracking();
  if (sourceNode) {
    try {
      sourceNode.stop();
    } catch (e) {
      // Already stopped
    }
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (gainNode) {
    gainNode.disconnect();
    gainNode = null;
  }
}

/**
 * Seek to a specific beat position.
 */
export function seekTo(beat) {
  const wasPlaying = getPlayback().isPlaying;
  stop();
  setPlaybackPosition(Math.max(0, beat));
  if (wasPlaying) {
    play(beat);
  } else {
    requestRender();
  }
}

/**
 * Set the playback volume (0.0 – 1.0).
 */
export function setVolume(volume) {
  if (gainNode) {
    gainNode.gain.value = Math.max(0, Math.min(1, volume));
  }
}

/**
 * Get the current audio buffer (for export, etc.).
 */
export function getAudioBuffer() {
  return audioBuffer;
}

/**
 * Clean up all audio resources.
 */
export function destroyAudioPlayback() {
  stop();
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  audioBuffer = null;
  onEndedCallback = null;
}