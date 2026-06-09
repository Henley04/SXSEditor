import { state, dom } from './state.js';
import { t } from '../i18n/index.js';
import { drawWaveformWithPlayhead } from './canvasRenderer.js';

export function togglePlayback() {
  if (state.isPlaying) {
    pausePlayback();
  } else {
    startPlayback();
  }
}

export async function startPlayback() {
  if (!state.wavAudioBuffer) return;

  try {
    if (!state.audioContext || state.audioContext.state === 'closed') {
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    }

    if (state.audioContext.state === 'suspended') {
      await state.audioContext.resume();
    }

    const source = state.audioContext.createBufferSource();
    source.buffer = state.wavAudioBuffer;
    source.connect(state.audioContext.destination);

    if (state.playStartOffset > 0 && state.playStartOffset < state.wavAudioBuffer.duration) {
      source.start(0, state.playStartOffset);
    } else {
      source.start();
    }

    source.onended = () => {
      if (state.isPlaying) {
        state.isPlaying = false;
        state.playStartOffset = 0;
        dom.btnPlayPause.textContent = t('preprocess.play');
        stopPlaybackRaf();
        drawWaveformWithPlayhead(0);
        if (state.pianoRoll) state.pianoRoll.stopPlayback();
      }
    };

    state.audioSource = source;
    state.isPlaying = true;
    state.playStartTime = performance.now();
    dom.btnPlayPause.textContent = t('preprocess.pause');

    // 统一播放循环，确保waveform和pianoRoll使用同一个时间源
    if (state.pianoRoll) {
      state.pianoRoll.isPlaying = true;
      state.pianoRoll.playStartTime = state.playStartTime;
      state.pianoRoll.playStartOffset = state.playStartOffset;
      state.pianoRoll.currentTime = state.playStartOffset;
      state.pianoRoll._tickPlayback();
    } else {
      startPlaybackLoop();
    }
  } catch (err) {
    console.error('播放失败:', err);
  }
}

export function pausePlayback() {
  if (!state.isPlaying) return;

  state.isPlaying = false;
  if (state.audioSource) {
    try {
      state.audioSource.onended = null;
      state.audioSource.stop();
    } catch (e) {}
    state.audioSource = null;
  }

  const elapsed = (performance.now() - state.playStartTime) / 1000;
  state.playStartOffset += elapsed;

  if (state.playStartOffset >= state.wavAudioBuffer.duration) {
    state.playStartOffset = 0;
  }

  dom.btnPlayPause.textContent = t('preprocess.play');
  stopPlaybackRaf();

  const currentTime = state.playStartOffset;
  drawWaveformWithPlayhead(currentTime);
  if (state.pianoRoll) {
    state.pianoRoll.pausePlayback();
    state.pianoRoll.setCurrentTime(currentTime);
  }
}

export function stopPlayback() {
  state.isPlaying = false;
  if (state.audioSource) {
    try {
      state.audioSource.onended = null;
      state.audioSource.stop();
    } catch (e) {}
    state.audioSource = null;
  }
  stopPlaybackRaf();
  state.playStartOffset = 0;
  dom.btnPlayPause.textContent = t('preprocess.play');
  drawWaveformWithPlayhead(0);
  if (state.pianoRoll) state.pianoRoll.stopPlayback();
}

export function stopPlaybackRaf() {
  if (state.playbackRaf) {
    cancelAnimationFrame(state.playbackRaf);
    state.playbackRaf = null;
  }
}

export function startPlaybackLoop() {
  if (!state.isPlaying) return;

  const elapsed = (performance.now() - state.playStartTime) / 1000;
  const currentTime = state.playStartOffset + elapsed;

  drawWaveformWithPlayhead(currentTime);

  state.playbackRaf = requestAnimationFrame(() => startPlaybackLoop());
}
