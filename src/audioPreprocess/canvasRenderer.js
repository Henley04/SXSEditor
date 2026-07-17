import { state, dom } from './state.js';
import { PIANO_KEY_WIDTH, BEAT_WIDTH, BPM, HEADER_HEIGHT, F0_CURVE_AREA_HEIGHT } from './constants.js';
import { t } from '../i18n/index.js';
import { getCanvasColors, invalidateCanvasThemeCache } from '../themes/canvasTheme.js';

// Offscreen canvas cache for waveform (static layer, no playhead)
let _waveformCacheCanvas = null;
let _waveformCacheKey = '';

export function drawWaveformWithPlayhead(currentTime, options = {}) {
  if (!state.wavAudioBuffer) return;

  const canvas = dom.waveformCanvas;
  const container = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = container.clientWidth;
  const height = container.clientHeight;

  // Size guard: only set canvas size when it actually changes
  const expectedW = Math.floor(width * dpr);
  const expectedH = Math.floor(height * dpr);
  if (canvas.width !== expectedW || canvas.height !== expectedH) {
    canvas.width = expectedW;
    canvas.height = expectedH;
  }
  const expectedStyleW = width + 'px';
  const expectedStyleH = height + 'px';
  if (canvas.style.width !== expectedStyleW || canvas.style.height !== expectedStyleH) {
    canvas.style.width = expectedStyleW;
    canvas.style.height = expectedStyleH;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const c = getCanvasColors();

  const zoomX = state.pianoRoll ? state.pianoRoll.zoomX : state.waveformZoomX;
  const scrollX = state.pianoRoll ? state.pianoRoll.scrollX : state.waveformScrollX;

  const audioData = state.wavAudioBuffer.getChannelData(0);

  // Build cache key: changes only when waveform appearance would change
  const cacheKey = `${audioData.length}|${state.wavDuration}|${width}|${height}|${dpr}|${zoomX}|${scrollX}|${BEAT_WIDTH}|${PIANO_KEY_WIDTH}|${c.bgPanel}|${c.bgElevated}|${c.accent}|${c.fgDisabled}`;

  if (_waveformCacheKey !== cacheKey) {
    // Redraw static waveform layer to offscreen canvas
    if (!_waveformCacheCanvas || _waveformCacheCanvas.width !== expectedW || _waveformCacheCanvas.height !== expectedH) {
      _waveformCacheCanvas = document.createElement('canvas');
      _waveformCacheCanvas.width = expectedW;
      _waveformCacheCanvas.height = expectedH;
    }
    const cacheCtx = _waveformCacheCanvas.getContext('2d');
    cacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cacheCtx.clearRect(0, 0, width, height);

    cacheCtx.fillStyle = c.bgPanel;
    cacheCtx.fillRect(0, 0, width, height);

    cacheCtx.fillStyle = c.bgElevated;
    cacheCtx.fillRect(0, 0, PIANO_KEY_WIDTH, height);

    cacheCtx.strokeStyle = c.fgDisabled;
    cacheCtx.lineWidth = 1;
    cacheCtx.beginPath();
    cacheCtx.moveTo(PIANO_KEY_WIDTH, 0);
    cacheCtx.lineTo(PIANO_KEY_WIDTH, height);
    cacheCtx.stroke();

    const dataAreaWidth = width - PIANO_KEY_WIDTH;
    if (dataAreaWidth > 0) {
      const totalSamples = audioData.length;
      const secondsPerBeat = 60 / BPM;
      const mid = height / 2;

      const audioEndBeat = (state.wavDuration / 60) * BPM;
      const audioEndX = PIANO_KEY_WIDTH + audioEndBeat * BEAT_WIDTH * zoomX - scrollX;
      const drawEndX = Math.min(Math.floor(audioEndX), width);
      const drawStartX = PIANO_KEY_WIDTH;

      if (drawEndX > drawStartX && state.wavDuration > 0) {
        // Precompute min/max peak table indexed by pixel column
        const peakTable = new Float32Array((drawEndX - drawStartX) * 2);
        for (let i = drawStartX; i < drawEndX; i++) {
          const beat = (i + scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * zoomX);
          const nextBeat = (i + 1 + scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * zoomX);
          const time = beat * secondsPerBeat;
          const nextTime = nextBeat * secondsPerBeat;
          const sampleIdx = Math.floor((time / state.wavDuration) * totalSamples);
          const nextSampleIdx = Math.min(Math.floor((nextTime / state.wavDuration) * totalSamples), totalSamples);
          let min = 1.0;
          let max = -1.0;
          for (let idx = sampleIdx; idx < nextSampleIdx; idx++) {
            if (idx >= 0 && idx < totalSamples) {
              const datum = audioData[idx];
              if (datum < min) min = datum;
              if (datum > max) max = datum;
            }
          }
          const offset = (i - drawStartX) * 2;
          peakTable[offset] = min;
          peakTable[offset + 1] = max;
        }

        cacheCtx.fillStyle = c.accent;
        for (let i = drawStartX; i < drawEndX; i++) {
          const offset = (i - drawStartX) * 2;
          const min = peakTable[offset];
          const max = peakTable[offset + 1];
          const barHeight = Math.max(1, ((max - min) / 2) * height);
          cacheCtx.fillRect(i, mid - barHeight / 2, 1, barHeight);
        }
      }
    }

    _waveformCacheKey = cacheKey;
  }

  // Draw cached waveform layer
  ctx.drawImage(_waveformCacheCanvas, 0, 0, width, height);

  // Draw playhead on top (dynamic)
  if (currentTime >= 0 && currentTime <= state.wavDuration) {
    const currentBeat = (currentTime / 60) * BPM;
    const playheadX = PIANO_KEY_WIDTH + currentBeat * BEAT_WIDTH * zoomX - scrollX;

    if (playheadX >= PIANO_KEY_WIDTH && playheadX <= width) {
      ctx.save();
      // 暂停/拖拽态：半透明虚线，区分"已设置位置"与"实时播放"
      if (options.isPaused) {
        ctx.globalAlpha = 0.65;
        ctx.setLineDash([4, 3]);
      }
      ctx.strokeStyle = c.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();
      ctx.restore();

      // 顶部三角手柄：底边在 canvas 顶端 y=0，顶点指向下 y=8，
      // 视觉上像挂在天花板上的小旗，提示用户可在此处按下并拖拽跳转播放进度。
      ctx.fillStyle = c.playhead;
      ctx.beginPath();
      ctx.moveTo(playheadX - 6, 0);
      ctx.lineTo(playheadX + 6, 0);
      ctx.lineTo(playheadX, 8);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/**
 * 计算播放头当前 X 坐标（用于 hit-test）。
 * 播放中使用 currentTime 参数；未播放时由调用方传入 state.playStartOffset。
 */
export function getPlayheadXForTime(seconds) {
  if (!state.wavAudioBuffer) return -1;
  const zoomX = state.pianoRoll ? state.pianoRoll.zoomX : state.waveformZoomX;
  const scrollX = state.pianoRoll ? state.pianoRoll.scrollX : state.waveformScrollX;
  const currentBeat = (seconds / 60) * BPM;
  return PIANO_KEY_WIDTH + currentBeat * BEAT_WIDTH * zoomX - scrollX;
}

/**
 * 把波形 canvas 内部 X 坐标转换为秒数。
 * 用于拖拽时根据鼠标位置计算新的播放时间。
 */
export function xToWaveformTime(x) {
  const zoomX = state.pianoRoll ? state.pianoRoll.zoomX : state.waveformZoomX;
  const scrollX = state.pianoRoll ? state.pianoRoll.scrollX : state.waveformScrollX;
  if (x < PIANO_KEY_WIDTH) return 0;
  const beat = (x + scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * zoomX);
  const secondsPerBeat = 60 / BPM;
  return Math.max(0, beat * secondsPerBeat);
}

// 播放头拖拽 hit-test 容差（像素）
export const PLAYHEAD_HIT_WIDTH = 12;

export function invalidateWaveformCache() {
  _waveformCacheKey = '';
}

export function syncWaveformZoomToPianoRoll() {
  if (!state.pianoRoll) return;
  const beatPerPixel = 1 / (BEAT_WIDTH * state.waveformZoomX);
  state.pianoRoll.zoomX = state.waveformZoomX;
  state.pianoRoll.scrollX = state.waveformScrollX;
  state.pianoRoll.render();
}

export function syncPianoRollZoomToWaveform() {
  if (!state.pianoRoll) return;
  state.waveformZoomX = state.pianoRoll.zoomX;
  state.waveformScrollX = state.pianoRoll.scrollX;
  drawWaveformWithPlayhead(state.pianoRoll.getCurrentTime());
}
