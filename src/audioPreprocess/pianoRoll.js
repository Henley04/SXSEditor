import { state, dom } from './state.js';
import { PIANO_KEY_WIDTH, NOTE_HEIGHT, BEAT_WIDTH, HEADER_HEIGHT, F0_CURVE_AREA_HEIGHT, BPM } from './constants.js';
import { t } from '../i18n/index.js';
import { debounce } from '../utils/debounce.js';
import { midiToNoteName } from '../utils/midiUtils.js';
import { getCanvasColors } from '../themes/canvasTheme.js';
import { drawWaveformWithPlayhead, getMaxScrollX, getMaxScrollY, updateScrollbars } from './canvasRenderer.js';
import { updateMidiInfo, startInlineEdit, updateInlineInputPosition } from './uiControls.js';

// visibilitychange handler: pause rAF-driven playback UI updates when tab hidden.
// Registered once per module; resumes _tickPlayback when visible again.
let _visibilityHandlerRegistered = false;
// W22: store the handler reference so destroy() can remove it.
let _visibilityChangeHandler = null;

function _ensureVisibilityHandler() {
  if (_visibilityHandlerRegistered) return;
  _visibilityHandlerRegistered = true;
  _visibilityChangeHandler = () => {
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
  };
  document.addEventListener('visibilitychange', _visibilityChangeHandler);
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
    // 本次按下是否新建了音符（id）。mouseup 后清空，用于只在真正新建时刷新计数。
    _dragCreatedNoteId: null,
    hoverNoteId: null,
    bpm: BPM,
    projectSettings: { bpm: BPM, timeSignature: [4, 4] },
    // Snap grid in beats per cell. Default 1/16 (sixteenth note) matches the
    // historical behavior. Mutators below read this so the grid is configurable.
    snapGrid: 1 / 16,
    dpr: window.devicePixelRatio || 1,

    _staticCache: null,
    _staticCacheDirty: true,

    // 命中测试用的「按 start 排序」视图缓存：避免每次 mousemove 反向线性扫描。
    // notes 数组被替换 / 长度变化 / 音符被就地移动时置空（见 _invalidateSortedNotes）。
    _sortedNoteEntries: null,
    _sortedNotesRef: null,
    _sortedNotesLen: -1,

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
      // W22: cancel any pending playback rAF so no frame fires after destroy.
      if (this.playbackRaf) {
        cancelAnimationFrame(this.playbackRaf);
        this.playbackRaf = null;
      }
      // Cancel any pending wheel rAF so no frame fires after destroy.
      if (this._wheelRaf) {
        cancelAnimationFrame(this._wheelRaf);
        this._wheelRaf = 0;
      }
      this._wheelAcc = null;
      window.removeEventListener('resize', this._boundResize);
      document.removeEventListener('mouseup', this._boundMouseUp);
      document.removeEventListener('keydown', this._boundKeyDown);
      // W22: release offscreen static cache canvas + its context so they can be GC'd.
      this._staticCache = null;
      this.ctx = null;
      // W22: remove the module-level visibilitychange listener so a destroyed
      // instance doesn't receive callbacks, and reset the flag so a new
      // instance can register again.
      if (_visibilityHandlerRegistered && _visibilityChangeHandler) {
        document.removeEventListener('visibilitychange', _visibilityChangeHandler);
        _visibilityHandlerRegistered = false;
        _visibilityChangeHandler = null;
      }
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
      // Hit-test the exact rectangles users see. Converting y back to a rounded
      // MIDI pitch made the top/bottom pixels of a drawn note resolve to the
      // adjacent pitch row after zoom/DPR rounding, so a visible hit was treated
      // as empty space and the legacy create-note path fired below the note.
      const verticalTolerancePx = 2;
      const resizeHotZonePx = Math.max(4, Math.min(12, this.snapGrid * BEAT_WIDTH * this.zoomX / 2));
      const entries = this._getSortedNoteEntries();
      if (entries.length === 0) return null;
      // 候选区间：只有 start ∈ [xBeat - maxDuration, xBeat] 的音符可能覆盖 x。
      // 先二分定位下界再顺序扫描，取代原先每次 mousemove 的反向线性扫描。
      const xBeat = this._xToTime(x);
      const lowerBound = xBeat - (this._sortedMaxDuration || 0) - 1e-9;
      let lo = 0;
      let hi = entries.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (entries[mid].start < lowerBound) lo = mid + 1;
        else hi = mid;
      }
      let best = null;
      for (let i = lo; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.start > xBeat + 1e-9) break;
        // 命中优先级与原实现一致：数组里越靠后（越晚加入）的音符越优先。
        if (best && entry.order < best.order) continue;
        const note = entry.note;
        const nx = this._timeToX(note.start);
        const ny = this._pitchToY(note.pitch);
        const nw = Math.max(1, note.duration * BEAT_WIDTH * this.zoomX);
        const nh = Math.max(1, NOTE_HEIGHT * this.zoomY);
        if (x < nx || x > nx + nw) continue;
        if (y < ny - verticalTolerancePx || y > ny + nh + verticalTolerancePx) continue;
        const onResizeEdge = x >= nx + nw - resizeHotZonePx;
        best = { note, nx, ny, nw, nh, onResizeEdge, order: entry.order };
      }
      if (!best) return null;
      return { note: best.note, nx: best.nx, ny: best.ny, nw: best.nw, nh: best.nh, onResizeEdge: best.onResizeEdge };
    },

    /** 命中测试用排序视图（按 start 升序，附带原数组下标用于保持既有优先级）。 */
    _getSortedNoteEntries() {
      if (this._sortedNoteEntries &&
        this._sortedNotesRef === this.notes &&
        this._sortedNotesLen === this.notes.length) {
        return this._sortedNoteEntries;
      }
      const entries = new Array(this.notes.length);
      let maxDuration = 0;
      for (let i = 0; i < this.notes.length; i++) {
        const note = this.notes[i];
        entries[i] = { note, order: i, start: note.start };
        if (note.duration > maxDuration) maxDuration = note.duration;
      }
      entries.sort((a, b) => a.start - b.start || b.note.duration - a.note.duration);
      this._sortedNoteEntries = entries;
      this._sortedNotesRef = this.notes;
      this._sortedNotesLen = this.notes.length;
      this._sortedMaxDuration = maxDuration;
      return entries;
    },

    /** 音符被就地移动/改长度后调用，下一次命中测试重建排序视图。 */
    _invalidateSortedNotes() {
      this._sortedNoteEntries = null;
      this._sortedNotesRef = null;
      this._sortedNotesLen = -1;
    },

    /**
     * 同一音高上 [start, end) 是否与既有音符重叠。
     *
     * 与分片编辑器的 hasNoteOverlap 语义一致：只比较同音高、半开区间相交。
     * 新建音符与拖拽加长时用它兜底，避免手绘出同音高叠在一起的音符（合唱
     * 声部数据里这种重叠会让 note_pitch/duration 两列对不上）。
     */
    _hasNoteOverlap(excludeId, pitch, start, end) {
      for (const note of this.notes) {
        if (note.id === excludeId) continue;
        if (note.pitch !== pitch) continue;
        if (note.start < end && note.start + note.duration > start) return true;
      }
      return false;
    },

    _onMouseDown(e) {
      const pos = this._getMousePos(e);
      const { x, y } = pos;
      if (x < PIANO_KEY_WIDTH) return;
      if (y < HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT) return;
      if (e.button !== 0) return;

      this._dragCreatedNoteId = null;
      const hit = this._findNoteAt(x, y);
      if (hit) {
        this.selectedNoteId = hit.note.id;
        // Always capture an immutable drag snapshot. Resize previously reused
        // the snapshot from the last operation, causing occasional length jumps.
        this.dragNoteStart = { start: hit.note.start, pitch: hit.note.pitch, duration: hit.note.duration };
        this.dragMode = hit.onResizeEdge ? 'resize' : 'move';
        this.dragStartX = x;
        this.dragStartY = y;
        this._dragMoved = false;
      } else {
        // 空白处按下 = 新建音符，与分片编辑器保持一致：按下即落一个 1/4 拍
        // （不小于吸附网格）的音符并直接进入 resize 拖拽，拖动决定时值。
        //
        // 迁移前这里只清选择、新建只能靠双击 —— 两个编辑器手感不同，按分片
        // 编辑器的习惯拖一下就什么都不会发生（用户感知为"无法新建 MIDI"）。
        this.selectedNoteId = null;
        this.dragMode = null;

        const beats = Math.max(0, this._snapBeats(this._xToTime(x)));
        const pitch = Math.max(0, Math.min(127, this._yToPitch(y)));
        const newDuration = Math.max(this.snapGrid, 0.25);
        // 同音高重叠时不新建（与分片编辑器一致）：紧贴既有音符下方的误点
        // 不应该凭空多出一个音符。
        if (!this._hasNoteOverlap(null, pitch, beats, beats + newDuration)) {
          const newNote = {
            id: Date.now() + Math.random(),
            pitch,
            start: beats,
            duration: newDuration,
            lyric: 'la',
          };
          this.notes.push(newNote);
          this.selectedNoteId = newNote.id;
          this.dragNoteStart = { start: newNote.start, pitch: newNote.pitch, duration: newNote.duration };
          this.dragMode = 'resize';
          this.dragStartX = x;
          this.dragStartY = y;
          this._dragMoved = false;
          this._dragCreatedNoteId = newNote.id;
          this._invalidateSortedNotes();
        }
      }

      this._staticCacheDirty = true;
      this.render();
      // 新建后立刻刷新头部计数（此前只在 mouseup 且发生过位移时才刷）。
      if (this._dragCreatedNoteId !== null) updateMidiInfo();
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
        this._invalidateSortedNotes();
      } else if (this.dragMode === 'resize') {
        const dxBeats = (x - this.dragStartX) / (BEAT_WIDTH * this.zoomX);
        let newDuration = this.dragNoteStart.duration + dxBeats;
        // Resize minimum = one snap grid cell so the result always lands on
        // a grid line.
        newDuration = Math.max(this.snapGrid, this._snapBeats(newDuration));
        // 加长时禁止吃进同音高的下一个音符；缩短永远放行（否则一旦历史上
        // 存在重叠，用户就再也拉不回合法长度）。
        if (newDuration < note.duration ||
            !this._hasNoteOverlap(note.id, note.pitch, note.start, note.start + newDuration)) {
          note.duration = newDuration;
          this._invalidateSortedNotes();
        }
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
          this._invalidateSortedNotes();
          this._staticCacheDirty = true;
          this.render();
        }
      }
      this.dragMode = null;
      this.dragStartX = 0;
      this.dragStartY = 0;
      this._dragMoved = false;
      this._dragCreatedNoteId = null;
    },

    /**
     * 双击只做「编辑歌词」。
     *
     * 新建音符已经下移到 mousedown/拖拽（与分片编辑器一致），这里若再新建，
     * 空白处双击会在 mousedown 已建的那个音符上再叠一个，变成一次双击两个音符。
     */
    _onDoubleClick(e) {
      const pos = this._getMousePos(e);
      const { x, y } = pos;
      if (x < PIANO_KEY_WIDTH) return;
      if (y < HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT) return;

      const hit = this._findNoteAt(x, y);
      if (hit) {
        startInlineEdit(this, hit.note, hit);
      }
    },

    _onWheel(e) {
      e.preventDefault();
      // rAF 合并 wheel：一帧内到达的多个事件必须「累加」delta，不能只保留最后一个。
      // 触控板一帧能推 3~5 次事件，只留最后一个会把大部分滚动/缩放量吃掉 ——
      // 表现就是缩放/滚动慢半拍、不跟手。缩放量按 delta 指数映射，与手势幅度成正比。
      if (!this._wheelAcc) {
        this._wheelAcc = { dx: 0, dy: 0, zoom: false, shift: false, ev: null, has: false };
      }
      const acc = this._wheelAcc;
      const norm = (v) => (e.deltaMode === 1 ? v * 16 : e.deltaMode === 2 ? v * 100 : v);
      acc.dx += norm(e.deltaX);
      acc.dy += norm(e.deltaY);
      // 修饰键与鼠标位置取「本帧最后一个」事件：绘制发生在帧末，用旧位置做
      // 缩放锚点会让缩放中心落后于指针。
      acc.zoom = e.ctrlKey || e.metaKey;
      acc.shift = e.shiftKey;
      acc.ev = e;
      acc.has = true;
      if (this._wheelRaf) return;
      this._wheelRaf = requestAnimationFrame(() => this._applyWheelAcc());
    },

    _applyWheelAcc() {
      this._wheelRaf = 0;
      const acc = this._wheelAcc;
      if (!acc || !acc.has) return;
      acc.has = false;
      const { dx, dy, zoom, shift, ev } = acc;
      acc.dx = 0;
      acc.dy = 0;
      acc.ev = null;
      if (!ev) return;

      const pos = this._getMousePos(ev);
      if (zoom) {
        const oldZoomX = this.zoomX;
        const nextZoomX = Math.max(0.05, Math.min(4, oldZoomX * Math.pow(0.9, dy / 100)));
        this.zoomX = nextZoomX;
        const mouseBeats = (pos.x + this.scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * oldZoomX);
        this.scrollX = PIANO_KEY_WIDTH + mouseBeats * BEAT_WIDTH * this.zoomX - pos.x;
        this.scrollX = Math.max(0, Math.min(getMaxScrollX(), this.scrollX));
        state.waveformZoomX = this.zoomX;
        state.waveformScrollX = this.scrollX;
        drawWaveformWithPlayhead(this.getCurrentTime());
      } else if (shift) {
        this.scrollX += (dx !== 0 ? dx : dy);
        this.scrollX = Math.max(0, Math.min(getMaxScrollX(), this.scrollX));
        state.waveformScrollX = this.scrollX;
        drawWaveformWithPlayhead(this.getCurrentTime());
      } else {
        this.scrollY += dy;
        this.scrollY = Math.max(0, Math.min(getMaxScrollY(), this.scrollY));
      }
      this._staticCacheDirty = true;
      this.render();
    },

    _secondsToBeats(seconds) {
      return (seconds / 60) * this.bpm;
    },

    // 播放时钟基准：优先用 audioContext.currentTime（与音频输出同一时钟，
    // 见 fragmentEditor/audioPlayback.js 的做法），避免 performance.now()
    // 与音频缓冲区调度之间的漂移。
    _clockNow() {
      const audioCtx = state.audioContext;
      if (audioCtx && audioCtx.state !== 'closed') return audioCtx.currentTime;
      return performance.now() / 1000;
    },

    startPlayback() {
      _ensureVisibilityHandler();
      if (this.isPlaying) return;
      this.isPlaying = true;
      this.playStartTime = this._clockNow();
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
      const elapsed = this._clockNow() - this.playStartTime;
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
      const elapsed = this._clockNow() - this.playStartTime;
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
        return this.playStartOffset + (this._clockNow() - this.playStartTime);
      }
      return this.currentTime;
    },

    removeNote(noteId) {
      const idx = this.notes.findIndex((n) => n.id === noteId);
      if (idx !== -1) {
        this.notes.splice(idx, 1);
        if (this.selectedNoteId === noteId) this.selectedNoteId = null;
        this._invalidateSortedNotes();
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
      // 静态层命中 = 自上次全量重绘以来没有发生 scroll/zoom/内容/尺寸变化。
      const staticCacheHit = !this._staticCacheDirty && this._staticCache &&
        this._staticCache.width === pixelW && this._staticCache.height === pixelH;

      if (staticCacheHit) {
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
      // 只在此前发生了 scroll/zoom/内容/尺寸变化（静态层未命中）时同步滚动条：
      // 播放头推进、悬停高亮等纯重绘不再每帧做 O(n) 内容扫描 + DOM 写入。
      if (!staticCacheHit) updateScrollbars();
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
          const displayText = (note.isContinuation || note.isSlur || note.noteType === 3) ? '-' : (note.lyric || midiToNoteName(note.pitch));
          ctx.fillText(displayText, x + 4, y + h / 2);
        } else if (w > 8) {
          ctx.fillStyle = c.noteText;
          ctx.font = '8px sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const displayText = (note.isContinuation || note.isSlur || note.noteType === 3) ? '-' : (note.lyric || midiToNoteName(note.pitch));
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
