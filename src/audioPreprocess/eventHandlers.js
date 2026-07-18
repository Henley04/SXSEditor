import { state, dom } from './state.js';
import { PIANO_KEY_WIDTH, BEAT_WIDTH, HEADER_HEIGHT, NOTE_HEIGHT } from './constants.js';
import { drawWaveformWithPlayhead, getPlayheadXForTime, xToWaveformTime, PLAYHEAD_HIT_WIDTH } from './canvasRenderer.js';
import { togglePlayback, startPlayback, stopPlayback, pausePlayback } from './playback.js';
import { extractF0AndPitch } from './f0Extraction.js';
import { extractF0BasicPitch, importMidiFile } from './midiExtraction.js';
import { saveSingerData } from './uiControls.js';
import { t } from '../i18n/index.js';

// Playhead 拖拽状态：mousedown 时置 true，mouseup/mouseleave 时置 false。
// 用于在 mousemove 中区分"拖拽中实时更新视觉"与"仅悬停显示光标/tooltip"。
let _isPlayheadDragging = false;
// 拖拽开始时是否正在播放。mouseup 时若为 true，则从新位置恢复播放。
// 这样拖拽期间只更新视觉（不重启 source，避免每次 mousemove 创建 AudioBufferSourceNode 导致卡顿）。
let _wasPlayingBeforeDrag = false;
// Tooltip 元素（懒创建，附加到 document.body）
let _playheadTooltip = null;

function _formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(ms).padStart(3, '0')}`;
}

function _ensurePlayheadTooltip() {
  if (_playheadTooltip && document.body.contains(_playheadTooltip)) return _playheadTooltip;
  _playheadTooltip = document.createElement('div');
  _playheadTooltip.className = 'playhead-tooltip';
  _playheadTooltip.style.cssText = `
    position: fixed;
    z-index: 9999;
    padding: 4px 8px;
    background: var(--bg-tooltip, #1a1a2e);
    color: var(--fg-tooltip, #e0e0f0);
    border: 1px solid var(--border-tooltip, #3a3a5a);
    border-radius: 3px;
    font-size: 11px;
    font-family: sans-serif;
    pointer-events: none;
    white-space: nowrap;
    box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    display: none;
  `;
  document.body.appendChild(_playheadTooltip);
  return _playheadTooltip;
}

function _showPlayheadTooltip(clientX, clientY, seconds) {
  const tip = _ensurePlayheadTooltip();
  tip.textContent = _formatTime(seconds) + ' · ' + t('preprocess.dragToSeek');
  tip.style.left = (clientX + 12) + 'px';
  tip.style.top = (clientY + 12) + 'px';
  tip.style.display = 'block';
}

function _hidePlayheadTooltip() {
  if (_playheadTooltip) _playheadTooltip.style.display = 'none';
}

/**
 * 返回当前播放头在波形 canvas 内部坐标系下的 X。
 * 播放中：使用 pianoRoll.currentTime（rAF 实时更新）。
 * 未播放：使用 state.playStartOffset（暂停/拖拽位置）。
 */
function _getCurrentPlayheadX() {
  const seconds = state.pianoRoll ? state.pianoRoll.getCurrentTime() : state.playStartOffset;
  return getPlayheadXForTime(seconds);
}

function _mouseToCanvasX(e) {
  const rect = dom.waveformCanvas.getBoundingClientRect();
  return e.clientX - rect.left;
}

/**
 * 把 canvas 内部 X 坐标转换为可播放的秒数，并截断到 [0, duration - 0.001]。
 */
function _canvasXToClampedSeconds(x) {
  const seconds = xToWaveformTime(x);
  if (!state.wavAudioBuffer) return Math.max(0, seconds);
  const duration = state.wavAudioBuffer.duration;
  return Math.max(0, Math.min(duration - 0.001, seconds));
}

/**
 * 拖拽期间只更新视觉（不重启 source）。
 * 更新 state.playStartOffset（作为 mouseup 后恢复播放的起点）、
 * 绘制暂停态 playhead、同步 pianoRoll 当前时间。
 */
function _updatePlayheadVisual(seconds) {
  state.playStartOffset = seconds;
  drawWaveformWithPlayhead(seconds, { isPaused: true });
  if (state.pianoRoll) state.pianoRoll.setCurrentTime(seconds);
}

/**
 * 结束拖拽：若拖拽前正在播放，从当前位置恢复播放。
 */
function _endPlayheadDrag() {
  if (!_isPlayheadDragging) return;
  _isPlayheadDragging = false;
  _hidePlayheadTooltip();
  if (_wasPlayingBeforeDrag) {
    _wasPlayingBeforeDrag = false;
    startPlayback();
  }
}

export function setupEventHandlers() {
  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      togglePlayback();
    }
  });

  // Buttons
  dom.btnPlayPause.addEventListener('click', togglePlayback);
  dom.btnExtractF0.addEventListener('click', extractF0AndPitch);
  dom.btnExtractF0BasicPitch.addEventListener('click', extractF0BasicPitch);
  if (dom.btnImportMidi) {
    dom.btnImportMidi.addEventListener('click', importMidiFile);
  }
  dom.btnSave.addEventListener('click', saveSingerData);
  dom.btnBack.addEventListener('click', () => {
    stopPlayback();
    window.close();
  });

  // Waveform canvas: playhead 拖拽 + 悬停 tooltip
  // 拖拽期间只更新视觉（不重启 source），避免每次 mousemove 创建 AudioBufferSourceNode 导致卡顿。
  // 若拖拽前正在播放：mousedown 先暂停（保留当前位置），mouseup 时从新位置恢复播放。
  dom.waveformCanvas.addEventListener('mousedown', (e) => {
    if (!state.wavAudioBuffer || !state.wavDuration) return;
    if (e.button !== 0) return;

    const rect = dom.waveformCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (x < PIANO_KEY_WIDTH) return;

    // 点击 playhead 热区（横向 ±PLAYHEAD_HIT_WIDTH/2）或顶部 header（y <= HEADER_HEIGHT）
    // 即启动拖拽并跳转到点击位置。header 区域整条带状都可作为拖拽热区，
    // 因为顶部三角手柄只在 playhead 当前 X 处，但 header 整体可见且无其它交互，
    // 让用户在 header 任意位置按下都能跳转，体验与分片编辑器一致。
    const playheadX = _getCurrentPlayheadX();
    const onPlayhead = Math.abs(x - playheadX) <= PLAYHEAD_HIT_WIDTH / 2;
    const onHeader = y <= HEADER_HEIGHT;
    if (!onPlayhead && !onHeader) return;

    e.preventDefault();
    // 若正在播放：先暂停（停止 source 但保留 playStartOffset），拖拽期间只更新视觉。
    // mouseup 时若 _wasPlayingBeforeDrag 为 true，则从新位置恢复播放。
    if (state.isPlaying) {
      _wasPlayingBeforeDrag = true;
      pausePlayback();
    } else {
      _wasPlayingBeforeDrag = false;
    }
    _isPlayheadDragging = true;
    const newSeconds = _canvasXToClampedSeconds(x);
    _updatePlayheadVisual(newSeconds);
    _hidePlayheadTooltip();
  });

  dom.waveformCanvas.addEventListener('mousemove', (e) => {
    // 拖拽中：只更新视觉（不重启 source，避免卡顿）
    if (_isPlayheadDragging) {
      const x = _mouseToCanvasX(e);
      const newSeconds = _canvasXToClampedSeconds(x);
      _updatePlayheadVisual(newSeconds);
      return;
    }

    if (!state.wavAudioBuffer) return;

    const rect = dom.waveformCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (x < PIANO_KEY_WIDTH) {
      dom.waveformCanvas.style.cursor = 'default';
      _hidePlayheadTooltip();
      return;
    }

    const playheadX = _getCurrentPlayheadX();
    const onPlayhead = Math.abs(x - playheadX) <= PLAYHEAD_HIT_WIDTH / 2;
    const onHeader = y <= HEADER_HEIGHT;
    if (onPlayhead || onHeader) {
      dom.waveformCanvas.style.cursor = 'ew-resize';
      const tipSeconds = _canvasXToClampedSeconds(x);
      _showPlayheadTooltip(e.clientX, e.clientY, tipSeconds);
    } else {
      dom.waveformCanvas.style.cursor = 'default';
      _hidePlayheadTooltip();
    }
  });

  dom.waveformCanvas.addEventListener('mouseup', () => {
    _endPlayheadDrag();
  });

  dom.waveformCanvas.addEventListener('mouseleave', () => {
    _endPlayheadDrag();
    dom.waveformCanvas.style.cursor = 'default';
  });

  // Waveform canvas wheel
  dom.waveformCanvas.addEventListener('wheel', (e) => {
    if (!state.wavAudioBuffer || !state.pianoRoll) return;
    e.preventDefault();

    const rect = dom.waveformCanvas.getBoundingClientRect();
    const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    if (e.ctrlKey || e.metaKey) {
      const oldZoomX = state.pianoRoll.zoomX;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      state.pianoRoll.zoomX = Math.max(0.25, Math.min(4, state.pianoRoll.zoomX * delta));
      const mouseBeats = (pos.x + state.pianoRoll.scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * oldZoomX);
      state.pianoRoll.scrollX = PIANO_KEY_WIDTH + mouseBeats * BEAT_WIDTH * state.pianoRoll.zoomX - pos.x;
      state.pianoRoll.scrollX = Math.max(0, state.pianoRoll.scrollX);
      state.pianoRoll.render();
    } else if (e.shiftKey) {
      state.pianoRoll.scrollX += e.deltaY;
      state.pianoRoll.scrollX = Math.max(0, state.pianoRoll.scrollX);
      state.pianoRoll.render();
    } else {
      state.pianoRoll.scrollY += e.deltaY;
      const totalHeight = 128 * NOTE_HEIGHT * state.pianoRoll.zoomY + HEADER_HEIGHT;
      state.pianoRoll.scrollY = Math.max(0, Math.min(totalHeight - state.pianoRoll.height, state.pianoRoll.scrollY));
      state.pianoRoll.render();
    }

    // 缩放/滚动后确保 playhead 在可见范围内：若超出则调整 scrollX 使其靠近边缘可见。
    // 否则 drawWaveformWithPlayhead 会因 playheadX 超出 [PIANO_KEY_WIDTH, width] 而不绘制，
    // 导致"缩放后进度条消失"的问题。
    const canvasWidth = dom.waveformCanvas.clientWidth;
    const playheadX = getPlayheadXForTime(state.pianoRoll.getCurrentTime());
    if (playheadX < PIANO_KEY_WIDTH) {
      state.pianoRoll.scrollX = Math.max(0, state.pianoRoll.scrollX - (PIANO_KEY_WIDTH - playheadX + 20));
      state.waveformScrollX = state.pianoRoll.scrollX;
      state.pianoRoll.render();
    } else if (playheadX > canvasWidth - 20) {
      state.pianoRoll.scrollX += (playheadX - canvasWidth + 40);
      state.waveformScrollX = state.pianoRoll.scrollX;
      state.pianoRoll.render();
    }

    drawWaveformWithPlayhead(state.pianoRoll.getCurrentTime(), { isPaused: !state.isPlaying });
  }, { passive: false });

  // Resize handle
  dom.resizeHandle.addEventListener('mousedown', (e) => {
    state.isResizing = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!state.isResizing) return;
    const mainRect = dom.mainContent.getBoundingClientRect();
    const relY = e.clientY - mainRect.top;
    const pct = (relY / mainRect.height) * 100;
    const clamped = Math.max(10, Math.min(60, pct));
    dom.waveformSection.style.flex = `0 0 ${clamped}%`;
    drawWaveformWithPlayhead(state.pianoRoll ? state.pianoRoll.getCurrentTime() : 0);
    if (state.pianoRoll) state.pianoRoll._resize();
  });

  document.addEventListener('mouseup', () => {
    state.isResizing = false;
  });
}
