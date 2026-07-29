import { state, dom } from './state.js';
import { PIANO_KEY_WIDTH, NOTE_HEIGHT, BEAT_WIDTH, HEADER_HEIGHT, F0_CURVE_AREA_HEIGHT, BPM } from './constants.js';
import { t } from '../i18n/index.js';
import { debounce } from '../utils/debounce.js';
import { midiToNoteName } from '../utils/midiUtils.js';
import { getCanvasColors, invalidateCanvasThemeCache } from '../themes/canvasTheme.js';
import { drawWaveformWithPlayhead, getMaxScrollX, getMaxScrollY, updateScrollbars } from './canvasRenderer.js';
import { updateMidiInfo, startInlineEdit, updateInlineInputPosition } from './uiControls.js';

// visibilitychange handler: pause rAF-driven playback UI updates when tab hidden.
// Registered once per module; resumes _tickPlayback when visible again.
let _visibilityHandlerRegistered = false;

function _ensureVisibilityHandler() {
  if (_visibilityHandlerRegistered) return;
  _visibilityHandlerRegistered = true;
  document.addEventListener('visibilitychange', () => {
    const pr = state.pianoRoll;
    if (!pr) return;
    if (document.hidden) {
      if (pr.playbackRaf) {
        cancelAnimationFrame(pr.playbackRaf);
        pr.playbackRaf = null;
      }
    } else {
      if (pr.isPlaying && !pr.playbackRaf) {
        pr._tickPlayback();
      }
    }
  });
}

export function initPianoRoll() {
  if (state.pianoRoll) return Promise.resolve();

  const notes = [];
  state.pianoRoll = {
    canvas: dom.midiCanvas,
    notes: notes,
    scrollX: 0,
    scrollY: 0,
    zoomX: 1,
    zoomY: 1,
    isPlaying: false,
    currentTime: 0,
    playStartTime: 0,
    playStartOffset: 0,
    playbackRaf: null,
    selectedNoteId: null,
    dragMode: null,
    dragStartX: 0,
    dragStartY: 0,
    dragNoteStart: { start: 0, pitch: 0, duration: 0 },
    hoverNoteId: null,
    bpm: BPM,
    projectSettings: { bpm: BPM, timeSignature: [4, 4] },
    // Snap grid in beats per cell. Default 1/16 (sixteenth note) matches the
    // historical behavior. Mutators below read this so the grid is configurable.
    snapGrid: 1 / 16,
    dpr: window.devicePixelRatio || 1,

    _staticCache: null,
    _staticCacheDirty: true,

    _initEvents() {
      this._boundResize = debounce(() => this._resize(), 100);
      this._boundMouseUp = () => this._onMouseUp();
      this._boundKeyDown = (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (this.selectedNoteId !== null) {
            this.removeNote(this.selectedNoteId);
            this.selectedNoteId = null;
            this._staticCacheDirty = true;
            this.render();
            updateMidiInfo();
          }
        }
      };
      window.addEventListener('resize', this._boundResize);
      this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
      this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
      document.addEventListener('mouseup', this._boundMouseUp);
      this.canvas.addEventListener('mouseleave', () => {
        this.hoverNoteId = null;
        this.canvas.style.cursor = 'default';
      });
      this.canvas.addEventListener('dblclick', (e) => this._onDoubleClick(e));
      this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
      document.addEventListener('keydown', this._boundKeyDown);
    },

    destroy() {
      window.removeEventListener('resize', this._boundResize);
      document.removeEventListener('mouseup', this._boundMouseUp);
      document.removeEventListener('keydown', this._boundKeyDown);
    },

    _resize() {
      const rect = this.canvas.parentElement.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      this.canvas.style.width = width + 'px';
      this.canvas.style.height = height + 'px';
      this.canvas.width = Math.floor(width * this.dpr);
      this.canvas.height = Math.floor(height * this.dpr);
      this.width = width;
      this.height = height;
      this.ctx = this.canvas.getContext('2d');
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      // 视口尺寸变化后，原有 scrollX/scrollY 可能超出新的最大值，需重新 clamp
      this.scrollX = Math.max(0, Math.min(getMaxScrollX(), this.scrollX));
      this.scrollY = Math.max(0, Math.min(getMaxScrollY(), this.scrollY));
      state.waveformScrollX = this.scrollX;
      this._staticCacheDirty = true;
      this.render();
    },

    _getMousePos(e) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    },

    _timeToX(beats) {
      return PIANO_KEY_WIDTH + beats * BEAT_WIDTH * this.zoomX - this.scrollX;
    },

    _xToTime(x) {
      return (x + this.scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * this.zoomX);
    },

    _pitchToY(pitch) {
      const maxPitch = 127;
      const pianoAreaTop = HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT;
      const pianoAreaBottom = this.height;
      return pianoAreaTop + (maxPitch - pitch) * NOTE_HEIGHT * this.zoomY - this.scrollY;
    },

    _yToPitch(y) {
      const maxPitch = 127;
      const pianoAreaTop = HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT;
      const pianoAreaBottom = this.height;
      if (y >= pianoAreaBottom) return 0;
      if (y <= pianoAreaTop) return maxPitch;
      return Math.round(maxPitch - (y + this.scrollY - pianoAreaTop) / (NOTE_HEIGHT * this.zoomY));
    },

    _snapBeats(beats) {
      const grid = this.snapGrid;
      return Math.round(beats / grid) * grid;
    },

    /**
     * Half-width of the trailing resize hot zone in BEATS.
     *
     * targetPx = clamp(halfGridPx, 4, 12) where halfGridPx = (snapGrid *
     * pxPerBeat) / 2. Scaling with the snap grid makes the clamp actually
     * reachable: fine grids shrink the hot zone toward 4px, coarse grids
     * grow it toward 12px. Returns beats so the hot zone scales naturally
     * with zoom level.
     */
    _resizeHotZoneBeats() {
      const pxPerBeat = BEAT_WIDTH * this.zoomX;
      if (pxPerBeat <= 0) return 0.06;
      const gridPx = this.snapGrid * pxPerBeat;
      const targetPx = gridPx / 2;
      const clampedPx = Math.max(4, Math.min(12, targetPx));
      return clampedPx / pxPerBeat;
    },

    _findNoteAt(x, y) {
      // Half-open interval [start, start+duration) to eliminate boundary
      // ambiguity between adjacent notes. Iterate last-first so the most
      // recently added note wins on shared boundaries (matches old behavior
      // for the rare case of true overlap). Resize-edge flag is computed
      // from a zoom-aware hot zone instead of a fixed 6px.
      const resizeBeats = this._resizeHotZoneBeats();
      const xTime = this._xToTime(x);
      const pitch = this._yToPitch(y);
      // Iterate from last to first to preserve historical "newest wins"
      // tie-break for genuinely overlapping notes at the same pitch.
      for (let i = this.notes.length - 1; i >= 0; i--) {
        const note = this.notes[i];
        if (note.pitch !== pitch) continue;
        const nEnd = note.start + note.duration;
        // Half-open: click exactly at start is inside; click exactly at end
        // is NOT inside (belongs to next note or empty space).
        if (xTime >= note.start && xTime < nEnd) {
          const rx = Math.round(this._timeToX(note.start));
          const ry = Math.round(this._pitchToY(note.pitch));
          const rw = Math.round(note.duration * BEAT_WIDTH * this.zoomX);
          const rh = Math.round(NOTE_HEIGHT * this.zoomY);
          const onResizeEdge = (nEnd - xTime) <= resizeBeats + 1e-9;
          return { note, nx: rx, ny: ry, nw: rw, nh: rh, onResizeEdge };
        }
      }
      // Allow pitch rounding tolerance: try neighbor pitches if exact match missed.
      for (let dy = -1; dy <= 1; dy += 2) {
        const adjPitch = pitch + dy;
        if (adjPitch < 0 || adjPitch > 127) continue;
        for (let i = this.notes.length - 1; i >= 0; i--) {
          const note = this.notes[i];
          if (note.pitch !== adjPitch) continue;
          const nEnd = note.start + note.duration;
          const ry = Math.round(this._pitchToY(note.pitch));
          const rh = Math.round(NOTE_HEIGHT * this.zoomY);
          // Only count if click y is within this note's pixel row.
          if (y < ry - 1 || y > ry + rh + 1) continue;
          if (xTime >= note.start && xTime < nEnd) {
            const rx = Math.round(this._timeToX(note.start));
            const rw = Math.round(note.duration * BEAT_WIDTH * this.zoomX);
            const onResizeEdge = (nEnd - xTime) <= resizeBeats + 1e-9;
            return { note, nx: rx, ny: ry, nw: rw, nh: rh, onResizeEdge };
          }
        }
      }
      return null;
    },

    _isResizeEdge(x, nx, nw) {
      // Legacy pixel-based check; kept for backward-compat with old call sites.
      return x >= nx + nw - 6 && x <= nx + nw;
    },

    _onMouseDown(e) {
      const pos = this._getMousePos(e);
      const { x, y } = pos;
      if (x < PIANO_KEY_WIDTH) return;
      if (y < HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT) return;

      const hit = this._findNoteAt(x, y);
      if (hit) {
        this.selectedNoteId = hit.note.id;
        if (hit.onResizeEdge) {
          this.dragMode = 'resize';
        } else {
          this.dragMode = 'move';
          this.dragNoteStart = { start: hit.note.start, pitch: hit.note.pitch, duration: hit.note.duration };
        }
        this.dragStartX = x;
        this.dragStartY = y;
        this._dragMoved = false;
      } else {
        const beats = this._snapBeats(this._xToTime(x));
        const pitch = this._yToPitch(y);
        const clampedPitch = Math.max(0, Math.min(127, pitch));
        const newNote = {
          id: Date.now() + Math.random(),
          pitch: clampedPitch,
          start: Math.max(0, beats),
          duration: 0.25,
          lyric: 'la',
        };
        this.notes.push(newNote);
        this.selectedNoteId = newNote.id;
        this.dragMode = 'resize';
        this.dragStartX = x;
        this.dragStartY = y;
        this.dragNoteStart = { start: newNote.start, pitch: newNote.pitch, duration: newNote.duration };
        this._dragMoved = false;
        updateMidiInfo();
      }
      this._staticCacheDirty = true;
      this.render();
    },

    _onMouseMove(e) {
      const pos = this._getMousePos(e);
      const { x, y } = pos;
      if (!this.dragMode) {
        const hit = this._findNoteAt(x, y);
        if (hit) {
          this.hoverNoteId = hit.note.id;
          this.canvas.style.cursor = hit.onResizeEdge ? 'ew-resize' : 'move';
        } else {
          this.hoverNoteId = null;
          this.canvas.style.cursor = 'default';
        }
        return;
      }

      const note = this.notes.find((n) => n.id === this.selectedNoteId);
      if (!note) return;

      const dx = Math.abs(x - this.dragStartX);
      const dy = Math.abs(y - this.dragStartY);
      if (dx > 3 || dy > 3) {
        this._dragMoved = true;
      }

      if (this.dragMode === 'move') {
        const dxBeats = (x - this.dragStartX) / (BEAT_WIDTH * this.zoomX);
        const dyPitch = Math.round((this.dragStartY - y) / (NOTE_HEIGHT * this.zoomY));
        let newStart = this.dragNoteStart.start + dxBeats;
        let newPitch = this.dragNoteStart.pitch + dyPitch;
        newStart = Math.max(0, this._snapBeats(newStart));
        newPitch = Math.max(0, Math.min(127, newPitch));
        note.start = newStart;
        note.pitch = newPitch;
      } else if (this.dragMode === 'resize') {
        const dxBeats = (x - this.dragStartX) / (BEAT_WIDTH * this.zoomX);
        let newDuration = this.dragNoteStart.duration + dxBeats;
        // Resize minimum = one snap grid cell so the result always lands on
        // a grid line.
        newDuration = Math.max(this.snapGrid, this._snapBeats(newDuration));
        note.duration = newDuration;
      }
      this._staticCacheDirty = true;
      this.render();
    },

    _onMouseUp() {
      if (this.dragMode && this._dragMoved) {
        updateMidiInfo();
      } else if (this.dragMode && !this._dragMoved) {
        // 没有实际移动，恢复音符原始位置
        const note = this.notes.find((n) => n.id === this.selectedNoteId);
        if (note && this.dragNoteStart) {
          note.start = this.dragNoteStart.start;
          note.pitch = this.dragNoteStart.pitch;
          note.duration = this.dragNoteStart.duration;
          this._staticCacheDirty = true;
          this.render();
        }
      }
      this.dragMode = null;
      this.dragStartX = 0;
      this.dragStartY = 0;
      this._dragMoved = false;
    },

    _onDoubleClick(e) {
      const pos = this._getMousePos(e);
      const { x, y } = pos;
      if (x < PIANO_KEY_WIDTH) return;
      if (y < HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT) return;

      const hit = this._findNoteAt(x, y);
      if (hit) {
        const note = hit.note;
        startInlineEdit(this, note, hit);
      }
    },

    _onWheel(e) {
      e.preventDefault();
      const pos = this._getMousePos(e);
      if (e.ctrlKey || e.metaKey) {
        const oldZoomX = this.zoomX;
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        this.zoomX = Math.max(0.05, Math.min(4, this.zoomX * delta));
        const mouseBeats = (pos.x + this.scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * oldZoomX);
        this.scrollX = PIANO_KEY_WIDTH + mouseBeats * BEAT_WIDTH * this.zoomX - pos.x;
        this.scrollX = Math.max(0, Math.min(getMaxScrollX(), this.scrollX));
        state.waveformZoomX = this.zoomX;
        state.waveformScrollX = this.scrollX;
        drawWaveformWithPlayhead(this.getCurrentTime());
      } else if (e.shiftKey) {
        this.scrollX += e.deltaY;
        this.scrollX = Math.max(0, Math.min(getMaxScrollX(), this.scrollX));
        state.waveformScrollX = this.scrollX;
        drawWaveformWithPlayhead(this.getCurrentTime());
      } else {
        this.scrollY += e.deltaY;
        this.scrollY = Math.max(0, Math.min(getMaxScrollY(), this.scrollY));
      }
      this._staticCacheDirty = true;
      this.render();
    },

    _secondsToBeats(seconds) {
      return (seconds / 60) * this.bpm;
    },

    startPlayback() {
      _ensureVisibilityHandler();
      if (this.isPlaying) return;
      this.isPlaying = true;
      this.playStartTime = performance.now();
      this.playStartOffset = this.currentTime;
      this._tickPlayback();
    },

    pausePlayback() {
      if (!this.isPlaying) return;
      this.isPlaying = false;
      if (this.playbackRaf) {
        cancelAnimationFrame(this.playbackRaf);
        this.playbackRaf = null;
      }
      const elapsed = (performance.now() - this.playStartTime) / 1000;
      this.currentTime = this.playStartOffset + elapsed;
    },

    stopPlayback() {
      this.isPlaying = false;
      if (this.playbackRaf) {
        cancelAnimationFrame(this.playbackRaf);
        this.playbackRaf = null;
      }
      this.currentTime = 0;
      this.render();
    },

    _tickPlayback() {
      if (!this.isPlaying) return;
      const elapsed = (performance.now() - this.playStartTime) / 1000;
      this.currentTime = this.playStartOffset + elapsed;
      this.render();
      drawWaveformWithPlayhead(this.getCurrentTime());
      this.playbackRaf = requestAnimationFrame(() => this._tickPlayback());
    },

    setCurrentTime(seconds) {
      this.currentTime = Math.max(0, seconds);
      if (!this.isPlaying) this.render();
    },

    getCurrentTime() {
      if (this.isPlaying) {
        return this.playStartOffset + (performance.now() - this.playStartTime) / 1000;
      }
      return this.currentTime;
    },

    removeNote(noteId) {
      const idx = this.notes.findIndex((n) => n.id === noteId);
      if (idx !== -1) {
        this.notes.splice(idx, 1);
        if (this.selectedNoteId === noteId) this.selectedNoteId = null;
        this._staticCacheDirty = true;
        this.render();
      }
    },

    render() {
      const ctx = this.ctx;
      const w = this.width;
      const h = this.height;
      if (!ctx) return;

      const c = getCanvasColors();
      const pixelW = Math.floor(w * this.dpr);
      const pixelH = Math.floor(h * this.dpr);

      if (!this._staticCacheDirty && this._staticCache && this._staticCache.width === pixelW && this._staticCache.height === pixelH) {
        // Use cached static layer (background/grid/f0/notes/keys)
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(this._staticCache, 0, 0, w, h);
      } else {
        // Full redraw
        ctx.clearRect(0, 0, w, h);
        this._drawBackground(ctx, w, h, c);
        this._drawGrid(ctx, w, h, c);
        this._drawF0Curve(ctx, w, h, c);
        this._drawNotes(ctx, c);
        this._drawPianoKeys(ctx, h, c);

        // Copy result to static cache
        if (!this._staticCache || this._staticCache.width !== pixelW || this._staticCache.height !== pixelH) {
          this._staticCache = document.createElement('canvas');
          this._staticCache.width = pixelW;
          this._staticCache.height = pixelH;
        }
        const cacheCtx = this._staticCache.getContext('2d');
        cacheCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        cacheCtx.clearRect(0, 0, w, h);
        cacheCtx.drawImage(this.canvas, 0, 0, w, h);
        this._staticCacheDirty = false;
      }

      // Always draw playhead on top
      this._drawPlayhead(ctx, h, c);
      updateInlineInputPosition(this);
      // 同步底部和右侧滚动条滑块位置（在所有视口/内容变化后）
      updateScrollbars();
    },

    _drawBackground(ctx, w, h, c) {
      ctx.fillStyle = c.bgElevated;
      ctx.fillRect(0, 0, w, h);
    },

    _drawF0Curve(ctx, w, h, c) {
      if (!this.f0Data || this.f0Data.length === 0) return;

      const f0AreaTop = HEADER_HEIGHT;
      const f0AreaBottom = f0AreaTop + F0_CURVE_AREA_HEIGHT;
      const f0AreaHeight = f0AreaBottom - f0AreaTop;
      const minF0 = 50;
      const maxF0 = 1500;
      const minLogF0 = Math.log2(minF0);
      const maxLogF0 = Math.log2(maxF0);
      const logRange = maxLogF0 - minLogF0;

      // 计算音频结束位置的X坐标，将F0区域背景裁剪到音频实际长度
      const audioEndBeat = (state.wavDuration / 60) * this.bpm;
      const audioEndX = PIANO_KEY_WIDTH + audioEndBeat * BEAT_WIDTH * this.zoomX - this.scrollX;
      const f0BgEndX = state.wavDuration > 0 ? Math.min(Math.floor(audioEndX), w) : w;

      ctx.fillStyle = c.bgInput;
      ctx.fillRect(PIANO_KEY_WIDTH, f0AreaTop, f0BgEndX - PIANO_KEY_WIDTH, F0_CURVE_AREA_HEIGHT);

      // 在F0区域背景之上重绘节拍网格线
      const beatsPerMeasure = this.projectSettings.timeSignature[0];
      const startBeat = this._xToTime(PIANO_KEY_WIDTH);
      const endBeat = this._xToTime(f0BgEndX);
      ctx.lineWidth = 1;
      for (let b = Math.floor(startBeat); b <= Math.ceil(endBeat); b++) {
        const x = this._timeToX(b);
        if (x < PIANO_KEY_WIDTH) continue;
        if (x > f0BgEndX) break;
        const isMeasureLine = (b % beatsPerMeasure === 0);
        ctx.strokeStyle = isMeasureLine ? c.gridLineMajor : c.gridLineMinor;
        ctx.beginPath();
        ctx.moveTo(x, f0AreaTop);
        ctx.lineTo(x, f0AreaBottom);
        ctx.stroke();
      }

      // 绘制音频结束标记线
      if (state.wavDuration > 0 && audioEndX >= PIANO_KEY_WIDTH && audioEndX <= w) {
        ctx.strokeStyle = c.fgDisabled;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(audioEndX, f0AreaTop);
        ctx.lineTo(audioEndX, f0AreaBottom);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = c.timeText;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(t('preprocess.f0CurveReadOnly'), PIANO_KEY_WIDTH + 6, f0AreaTop + 14);

      ctx.strokeStyle = c.borderStrong;
      ctx.lineWidth = 1;
      const refFreqs = [100, 200, 300, 400, 500, 600, 700, 800, 1000, 1200];
      for (const freq of refFreqs) {
        if (freq < minF0 || freq > maxF0) continue;
        const normalizedF0 = (Math.log2(freq) - minLogF0) / logRange;
        const y = f0AreaBottom - normalizedF0 * f0AreaHeight;
        ctx.beginPath();
        ctx.setLineDash([2, 4]);
        ctx.moveTo(PIANO_KEY_WIDTH, y);
        ctx.lineTo(f0BgEndX, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = c.fgDisabled;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(freq + 'Hz', PIANO_KEY_WIDTH - 4, y + 3);
      }

      ctx.strokeStyle = c.fgDisabled;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PIANO_KEY_WIDTH, f0AreaBottom);
      ctx.lineTo(f0BgEndX, f0AreaBottom);
      ctx.stroke();

      ctx.strokeStyle = c.danger;
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      let isFirst = true;
      let lastVisibleX = -1;
      for (const frame of this.f0Data) {
        if (frame.f0 <= 0) {
          if (!isFirst) {
            ctx.stroke();
            ctx.beginPath();
            isFirst = true;
          }
          continue;
        }

        const beats = this._secondsToBeats(frame.time);
        const x = this._timeToX(beats);
        const normalizedF0 = Math.max(0, Math.min(1, (Math.log2(frame.f0) - minLogF0) / logRange));
        const y = f0AreaBottom - normalizedF0 * f0AreaHeight;

        if (x < PIANO_KEY_WIDTH - 10) continue;
        if (x > f0BgEndX + 10) {
          if (!isFirst) {
            ctx.stroke();
          }
          break;
        }

        if (isFirst) {
          ctx.moveTo(x, y);
          isFirst = false;
        } else {
          ctx.lineTo(x, y);
        }
        lastVisibleX = x;
      }

      ctx.stroke();

      if (this.f0Data.length > 0) {
        ctx.fillStyle = c.dangerGlow;
        ctx.beginPath();
        let fillStarted = false;
        let fillLastX = -1;
        for (const frame of this.f0Data) {
          if (frame.f0 <= 0) {
            if (fillStarted) {
              ctx.lineTo(fillLastX, f0AreaBottom);
              ctx.closePath();
              ctx.fill();
              ctx.beginPath();
              fillStarted = false;
            }
            continue;
          }
          const beats = this._secondsToBeats(frame.time);
          const x = this._timeToX(beats);
          const normalizedF0 = Math.max(0, Math.min(1, (Math.log2(frame.f0) - minLogF0) / logRange));
          const y = f0AreaBottom - normalizedF0 * f0AreaHeight;
          if (x < PIANO_KEY_WIDTH - 10) continue;
          if (x > f0BgEndX + 10) break;
          if (!fillStarted) {
            ctx.moveTo(x, f0AreaBottom);
            ctx.lineTo(x, y);
            fillStarted = true;
          } else {
            ctx.lineTo(x, y);
          }
          fillLastX = x;
        }
        if (fillStarted) {
          ctx.lineTo(fillLastX, f0AreaBottom);
          ctx.closePath();
          ctx.fill();
        }
      }
    },

    _drawGrid(ctx, w, h, c) {
      const beatsPerMeasure = this.projectSettings.timeSignature[0];
      const startBeat = this._xToTime(PIANO_KEY_WIDTH);
      const endBeat = this._xToTime(w);

      ctx.lineWidth = 1;
      for (let b = Math.floor(startBeat); b <= Math.ceil(endBeat); b++) {
        const x = this._timeToX(b);
        if (x < PIANO_KEY_WIDTH) continue;
        const isMeasureLine = (b % beatsPerMeasure === 0);
        ctx.strokeStyle = isMeasureLine ? c.gridLineMeasure : c.gridLineMajor;
        ctx.beginPath();
        ctx.moveTo(x, HEADER_HEIGHT);
        ctx.lineTo(x, HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT);
        ctx.stroke();
        ctx.strokeStyle = isMeasureLine ? c.fgDisabled : c.borderStrong;
        ctx.beginPath();
        ctx.moveTo(x, HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT);
        ctx.lineTo(x, h);
        ctx.stroke();
        if (isMeasureLine) {
          ctx.fillStyle = c.timeText;
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          const measureNum = Math.floor(b / beatsPerMeasure) + 1;
          ctx.fillText(String(measureNum), x, HEADER_HEIGHT - 6);
        }
      }

      const startPitch = this._yToPitch(h);
      const endPitch = this._yToPitch(HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT);
      const blackKeys = new Set([1, 3, 6, 8, 10]);
      for (let p = Math.max(0, startPitch); p <= Math.min(127, endPitch); p++) {
        const y = this._pitchToY(p);
        const isBlack = blackKeys.has(p % 12);
        ctx.strokeStyle = isBlack ? c.gridLineMajor : c.gridLineMinor;
        ctx.beginPath();
        ctx.moveTo(PIANO_KEY_WIDTH, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    },

    _drawNotes(ctx, c) {
      for (const note of this.notes) {
        const x = this._timeToX(note.start);
        const y = this._pitchToY(note.pitch);
        const w = note.duration * BEAT_WIDTH * this.zoomX;
        const h = NOTE_HEIGHT * this.zoomY;

        if (x + w < PIANO_KEY_WIDTH || x > this.width || y + h < HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT || y > this.height) continue;

        const isSelected = note.id === this.selectedNoteId;
        const isHover = note.id === this.hoverNoteId;

        ctx.fillStyle = state.singerColor || c.accent;
        ctx.globalAlpha = isSelected ? 1.0 : 0.85;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1.0;

        ctx.strokeStyle = isSelected ? c.noteSelectedBg : (isHover ? c.fgSecondary : c.noteBorder);
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.strokeRect(x, y, w, h);

        if (w > 20) {
          ctx.fillStyle = c.noteText;
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const displayText = note.lyric || midiToNoteName(note.pitch);
          ctx.fillText(displayText, x + 4, y + h / 2);
        } else if (w > 8) {
          ctx.fillStyle = c.noteText;
          ctx.font = '8px sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const displayText = note.lyric || midiToNoteName(note.pitch);
          ctx.fillText(displayText, x + 2, y + h / 2);
        }

        ctx.fillStyle = c.selectionBg;
        ctx.fillRect(x + w - 4, y + 2, 2, h - 4);
      }
    },

    _drawPianoKeys(ctx, h, c) {
      const midiToNoteNameLocal = (midi) => {
        const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(midi / 12) - 1;
        return names[midi % 12] + String(octave);
      };

      const startPitch = this._yToPitch(h);
      const endPitch = this._yToPitch(HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT);
      const blackKeys = new Set([1, 3, 6, 8, 10]);

      for (let p = Math.max(0, startPitch); p <= Math.min(127, endPitch); p++) {
        const y = this._pitchToY(p);
        const keyH = NOTE_HEIGHT * this.zoomY;
        const isBlack = blackKeys.has(p % 12);

        ctx.fillStyle = isBlack ? c.pianoBlackKey : c.pianoWhiteKey;
        ctx.fillRect(0, y, PIANO_KEY_WIDTH, keyH);

        ctx.strokeStyle = c.pianoKeyBorder;
        ctx.strokeRect(0, y, PIANO_KEY_WIDTH, keyH);

        ctx.fillStyle = isBlack ? '#cccccc' : '#2a2a3d';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(midiToNoteNameLocal(p), PIANO_KEY_WIDTH - 4, y + keyH / 2 + 4);
      }

      ctx.strokeStyle = c.pianoKeyBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PIANO_KEY_WIDTH, HEADER_HEIGHT);
      ctx.lineTo(PIANO_KEY_WIDTH, h);
      ctx.stroke();
    },

    _drawPlayhead(ctx, h, c) {
      const currentTime = this.getCurrentTime();
      const beat = this._secondsToBeats(currentTime);
      const x = this._timeToX(beat);
      if (x < PIANO_KEY_WIDTH || x > this.width) return;

      ctx.strokeStyle = c.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, HEADER_HEIGHT);
      ctx.lineTo(x, h);
      ctx.stroke();

      ctx.fillStyle = c.playhead;
      ctx.beginPath();
      ctx.moveTo(x, HEADER_HEIGHT);
      ctx.lineTo(x - 6, HEADER_HEIGHT - 6);
      ctx.lineTo(x + 6, HEADER_HEIGHT - 6);
      ctx.closePath();
      ctx.fill();
    },
  };

  state.pianoRoll._initEvents();
  state.pianoRoll._resize();
  return Promise.resolve();
}
