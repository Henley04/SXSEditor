import { state, dom } from './state.js';
import { t } from '../i18n/index.js';
import { setLabel } from '../icons/iconHelper.js';
import { drawWaveformWithPlayhead } from './canvasRenderer.js';
// 播放头/时间码按"耳朵听到的位置"走：直接读 ctx.currentTime 会稳定跑在声音
// 前面一个设备缓冲（20–120 ms），这正是"进度条和声音不同步"的观感来源。
import { getAudibleElapsedSec } from '../shared/audioOutputClock.js';

/**
 * 已播秒数（可听域）。无 audioContext 时回落 0 —— 没有音频就没有延迟可言。
 * @returns {number}
 */
function _elapsedSec() {
  const ctx = state.audioContext;
  if (!ctx || ctx.state === 'closed') return 0;
  return getAudibleElapsedSec(ctx, state.playStartTime);
}

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

    // 时间基准必须与 source 真正开始发声的时刻对齐：先取基准、再用 start(when)
    // 精确落在该时刻。start(0) 只保证"下一个渲染量子"，基准取 start 之后的
    // currentTime 会让播放头从一开始就略微超前。
    const startAt = state.audioContext.currentTime;
    if (state.playStartOffset > 0 && state.playStartOffset < state.wavAudioBuffer.duration) {
      source.start(startAt, state.playStartOffset);
    } else {
      source.start(startAt);
    }

    // 记录播放启动时刻，用于 onended 触发时判断是否"刚启动就结束"
    // （用户拖拽到接近末尾时 source 会几乎立即结束，此时不应重置位置到 0，
    // 否则 playhead 会从拖拽位置跳回开头）。
    // 这里用**渲染域**时长（startAt 起算）：它回答的是"调度是否刚发生"，
    // 与可听位置无关，混用可听时钟会让 0.2s 阈值随设备延迟漂移。
    const playbackStartWallTime = startAt;

    source.onended = () => {
      if (!state.isPlaying) return;
      const realElapsed = state.audioContext.currentTime - playbackStartWallTime;
      state.isPlaying = false;
      setLabel(dom.btnPlayPause, t('preprocess.play'), { icon: 'play' });
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
    // 与 start(when) 同一个 startAt：这是渲染域基准，显示位置由 _elapsedSec()
    // 换算到可听域（扣设备输出延迟）。
    state.playStartTime = startAt;
    setLabel(dom.btnPlayPause, t('preprocess.pause'), { icon: 'pause' });

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
    } catch (_e) {}
    state.audioSource = null;
  }

  // 续播点取"听到的位置"：playStartTime 在渲染域，必须换算到可听域再累加，
  // 否则每次暂停/续播都把设备延迟重复计一次，位置会越暂停越靠前。
  state.playStartOffset += _elapsedSec();

  if (state.playStartOffset >= state.wavAudioBuffer.duration) {
    state.playStartOffset = 0;
  }

  setLabel(dom.btnPlayPause, t('preprocess.play'), { icon: 'play' });
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
    } catch (_e) {}
    state.audioSource = null;
  }
  stopPlaybackRaf();
  state.playStartOffset = 0;
  setLabel(dom.btnPlayPause, t('preprocess.play'), { icon: 'play' });
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
    } catch (_e) {}
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

  // 与 startPlayback 相同的时钟基准（渲染域 startAt）→ 换算成可听位置。
  const currentTime = state.playStartOffset + _elapsedSec();

  drawWaveformWithPlayhead(currentTime);

  state.playbackRaf = requestAnimationFrame(() => startPlaybackLoop());
}
