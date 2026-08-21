import { state, dom } from './state.js';
import { PIANO_KEY_WIDTH, NOTE_HEIGHT, BEAT_WIDTH, BPM, HEADER_HEIGHT, F0_CURVE_AREA_HEIGHT } from './constants.js';
import { getCanvasColors } from '../themes/canvasTheme.js';

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

/**
 * 计算水平方向最大 scrollX（数据区总宽度 - 可视宽度）。
 * 总内容宽度取音频结尾与最后一个音符结尾的较大者，确保音符超出音频范围时也可滚动到。
 */
export function getMaxScrollX() {
  if (!state.pianoRoll) return 0;
  const pr = state.pianoRoll;
  if (!pr.width) return 0;
  const viewportWidth = pr.width - PIANO_KEY_WIDTH;
  if (viewportWidth <= 0) return 0;
  const audioEndBeat = state.wavDuration > 0 ? (state.wavDuration / 60) * BPM : 0;
  let lastNoteEnd = 0;
  if (pr.notes && pr.notes.length > 0) {
    for (const n of pr.notes) {
      const end = n.start + n.duration;
      if (end > lastNoteEnd) lastNoteEnd = end;
    }
  }
  const totalBeats = Math.max(audioEndBeat, lastNoteEnd);
  const totalContentWidth = totalBeats * BEAT_WIDTH * pr.zoomX;
  return Math.max(0, totalContentWidth - viewportWidth);
}

/**
 * 计算垂直方向最大 scrollY（钢琴键区总高度 - 可视高度）。
 */
export function getMaxScrollY() {
  if (!state.pianoRoll) return 0;
  const pr = state.pianoRoll;
  if (!pr.height) return 0;
  const pianoAreaTop = HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT;
  const viewportHeight = pr.height - pianoAreaTop;
  if (viewportHeight <= 0) return 0;
  const totalContentHeight = 128 * NOTE_HEIGHT * pr.zoomY;
  return Math.max(0, totalContentHeight - viewportHeight);
}

/**
 * 根据 pianoRoll 当前 scrollX/scrollY/zoomX/zoomY 更新底部和右侧滚动条滑块位置与大小。
 * 内容不足时隐藏对应滚动条；内容溢出时显示并按比例定位滑块。
 * 应在 render()、wheel、resize 等改变视口或内容的入口后调用。
 */
export function updateScrollbars() {
  const pr = state.pianoRoll;
  // pianoRoll 未初始化时隐藏滚动条（避免无内容时显示空滑块）
  if (!pr || !pr.width || !pr.height) {
    if (dom.hscroll) dom.hscroll.style.display = 'none';
    if (dom.vscroll) dom.vscroll.style.display = 'none';
    return;
  }

  // 水平滚动条
  if (dom.hscroll && dom.hscrollThumb) {
    const viewportWidth = pr.width - PIANO_KEY_WIDTH;
    const audioEndBeat = state.wavDuration > 0 ? (state.wavDuration / 60) * BPM : 0;
    let lastNoteEnd = 0;
    if (pr.notes && pr.notes.length > 0) {
      for (const n of pr.notes) {
        const end = n.start + n.duration;
        if (end > lastNoteEnd) lastNoteEnd = end;
      }
    }
    const totalBeats = Math.max(audioEndBeat, lastNoteEnd);
    const totalContentWidth = Math.max(totalBeats * BEAT_WIDTH * pr.zoomX, viewportWidth);
    const maxScrollX = Math.max(0, totalContentWidth - viewportWidth);
    const trackWidth = dom.hscroll.clientWidth;

    if (totalContentWidth <= viewportWidth || trackWidth <= 0) {
      dom.hscroll.style.display = 'none';
    } else {
      dom.hscroll.style.display = '';
      const thumbWidth = Math.max(24, (viewportWidth / totalContentWidth) * trackWidth);
      const usableTrack = trackWidth - thumbWidth;
      const ratio = maxScrollX > 0 ? Math.max(0, Math.min(1, pr.scrollX / maxScrollX)) : 0;
      const thumbX = ratio * usableTrack;
      dom.hscrollThumb.style.width = thumbWidth + 'px';
      dom.hscrollThumb.style.left = thumbX + 'px';
    }
  }

  // 垂直滚动条
  if (dom.vscroll && dom.vscrollThumb) {
    const pianoAreaTop = HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT;
    const viewportHeight = pr.height - pianoAreaTop;
    const totalContentHeight = 128 * NOTE_HEIGHT * pr.zoomY;
    const maxScrollY = Math.max(0, totalContentHeight - viewportHeight);
    const trackHeight = dom.vscroll.clientHeight;

    if (totalContentHeight <= viewportHeight || trackHeight <= 0) {
      dom.vscroll.style.display = 'none';
    } else {
      dom.vscroll.style.display = '';
      const thumbHeight = Math.max(24, (viewportHeight / totalContentHeight) * trackHeight);
      const usableTrack = trackHeight - thumbHeight;
      const ratio = maxScrollY > 0 ? Math.max(0, Math.min(1, pr.scrollY / maxScrollY)) : 0;
      const thumbY = ratio * usableTrack;
      dom.vscrollThumb.style.height = thumbHeight + 'px';
      dom.vscrollThumb.style.top = thumbY + 'px';
    }
  }
}
