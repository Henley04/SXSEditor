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

    // 记录播放启动时刻，用于 onended 触发时判断是否"刚启动就结束"
    // （用户拖拽到接近末尾时 source 会几乎立即结束，此时不应重置位置到 0，
    // 否则 playhead 会从拖拽位置跳回开头）
    const playbackStartWallTime = performance.now();

    source.onended = () => {
      if (!state.isPlaying) return;
      const realElapsed = (performance.now() - playbackStartWallTime) / 1000;
      state.isPlaying = false;
      dom.btnPlayPause.textContent = t('preprocess.play');
      stopPlaybackRaf();
      if (realElapsed < 0.2) {
        // 播放刚启动就结束（用户拖拽到接近末尾）：保留当前位置，不重置到 0
        drawWaveformWithPlayhead(state.playStartOffset, { isPaused: true });
        if (state.pianoRoll) {
          state.pianoRoll.pausePlayback();
          state.pianoRoll.setCurrentTime(state.playStartOffset);
        }
      } else {
        // 自然播放结束：重置到 0
        state.playStartOffset = 0;
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
    console.error('Playback failed:', err);
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
  // 绘制暂停态播放头（虚线 + 顶部三角手柄），提示用户当前可拖拽位置
  drawWaveformWithPlayhead(currentTime, { isPaused: true });
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

/**
 * 实时跳转到新的播放位置。
 * 播放中：停止当前 source，从 newOffset 重新 start（边播边拖无延迟）。
 * 未播放：仅更新 playStartOffset 并重绘暂停态播放头。
 */
export function seekPlayback(newOffset) {
  if (!state.wavAudioBuffer) return;
  const duration = state.wavAudioBuffer.duration;
  // 余量 50ms 防止拖拽到接近末尾时 source 立即结束触发 onended 重置位置
  const margin = duration > 0.1 ? 0.05 : duration * 0.5;
  const clamped = Math.max(0, Math.min(duration - margin, newOffset));

  // 停止当前 source（不重置 playStartOffset）
  if (state.audioSource) {
    try {
      state.audioSource.onended = null;
      state.audioSource.stop();
    } catch (e) {}
    state.audioSource = null;
  }

  state.playStartOffset = clamped;

  if (state.isPlaying) {
    // 播放中拖拽：立即从新位置重启 source
    state.isPlaying = false;
    stopPlaybackRaf();
    startPlayback();
  } else {
    // 未播放：仅更新视觉
    drawWaveformWithPlayhead(clamped, { isPaused: true });
    if (state.pianoRoll) {
      state.pianoRoll.setCurrentTime(clamped);
    }
  }
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
