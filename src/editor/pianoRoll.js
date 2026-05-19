/**
 * 钢琴卷帘 Canvas 渲染与交互模块
 * 负责网格、钢琴键、音符块绘制，鼠标交互，播放头显示
 */

function debounce(fn, ms) {
  let timer = null;
  return function(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(this, args); }, ms);
  };
}

// 常量配置
const PIANO_KEY_WIDTH = 60;          // 钢琴键区域宽度（CSS像素）
const NOTE_HEIGHT = 16;              // 每个半音的高度（CSS像素）
const BEAT_WIDTH = 80;               // 一拍对应的宽度（CSS像素）
const HEADER_HEIGHT = 24;            // 顶部标尺高度
const PARAM_CURVE_HEIGHT = 80;       // 参数曲线区域高度
const MIN_NOTE_DURATION = 1 / 16;    // 最小时长（十六分音符）
const DEFAULT_NOTE_DURATION = 1 / 4; // 默认新建音符时长
const RESIZE_EDGE_WIDTH = 6;         // 音符右边缘拖拽感应区宽度

const PARAM_MODES = {
  MIDI: 'MIDI',
  VOL: 'VOL',
  PAN: 'PAN',
  F0: 'F0',
};

// 黑键对应的 MIDI 音高（模12）
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

// 音高名称映射（C4 = 60）
function midiToNoteName(midi) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  const name = names[midi % 12];
  return `${name}${octave}`;
}

function isCJK(char) {
  const code = char.codePointAt(0) || 0;
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0x20000 && code <= 0x2A6DF) ||
    (code >= 0x3040 && code <= 0x309F) ||
    (code >= 0x30A0 && code <= 0x30FF) ||
    (code >= 0xAC00 && code <= 0xD7AF)
  );
}

function tokenizeLyric(text) {
  if (!text || text.trim().length === 0) return [];
  const cleaned = text.trim();
  const tokens = [];
  let i = 0;
  while (i < cleaned.length) {
    const char = cleaned[i];
    if (/\s/.test(char)) { i++; continue; }
    if (isCJK(char)) { tokens.push(char); i++; continue; }
    let word = '';
    while (i < cleaned.length && !/\s/.test(cleaned[i]) && !isCJK(cleaned[i])) {
      word += cleaned[i];
      i++;
    }
    if (word) tokens.push(word);
  }
  return tokens;
}

class PianoRoll {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} options
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = {
      showPromptDialog: options.showPromptDialog ?? null,
      ...options
    };

    this.projectSettings = {
      bpm: 120,
      timeSignature: [4, 4],
    };

    this.tracks = [];
    this.notes = [];

    this.scrollX = 0;
    this.scrollY = 0;
    this.zoomX = 1;
    this.zoomY = 1;

    this.isPlaying = false;
    this.currentTime = 0;
    this.playStartTime = 0;
    this.playStartOffset = 0;
    this.playbackRaf = null;

    this.selectedNoteId = null;
    this.dragMode = null;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragNoteStart = { start: 0, pitch: 0, duration: 0 };
    this.hoverNoteId = null;

    this.paramMode = PARAM_MODES.VOL;
    this.envelopes = {
      volume: { keyframes: [{ time: 0, value: 1, smoothness: 0 }] },
      pan: { keyframes: [{ time: 0, value: 0, smoothness: 0 }] },
      f0: { keyframes: [{ time: 0, value: 0, smoothness: 0 }] },
    };
    this.selectedEnvelopeIndex = -1;
    this.dragEnvelopeIndex = -1;
    this.hoverEnvelopeIndex = -1;
    this._activeInlineInput = null;

    this.dpr = window.devicePixelRatio || 1;

    this._initEvents();
    this._resize();
  }

  // ===================== 初始化与事件绑定 =====================

  _initEvents() {
    window.addEventListener('resize', () => this._resize());

    // 鼠标事件
    this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this.canvas.addEventListener('mouseup', (e) => this._onMouseUp(e));
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverNoteId = null;
      this.canvas.style.cursor = 'default';
    });
    this.canvas.addEventListener('dblclick', (e) => this._onDoubleClick(e));

    // 滚轮缩放与滚动
    this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

    // 键盘事件（Delete 删除选中音符）
    document.addEventListener('keydown', (e) => this._onKeyDown(e));
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.floor(width * this.dpr);
    this.canvas.height = Math.floor(height * this.dpr);

    this.width = width;
    this.height = height;

    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.render();
  }

  // ===================== 坐标转换 =====================

  /**
   * 将鼠标事件坐标转换为 Canvas 内部 CSS 坐标
   */
  _getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  /**
   * 时间（拍）→ 绘制 X 坐标（含滚动与缩放）
   */
  _timeToX(beats) {
    return PIANO_KEY_WIDTH + beats * BEAT_WIDTH * this.zoomX - this.scrollX;
  }

  /**
   * 绘制 X 坐标 → 时间（拍）
   */
  _xToTime(x) {
    return (x + this.scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * this.zoomX);
  }

  /**
   * MIDI 音高 → 绘制 Y 坐标（从上到下，C8 在顶部）
   */
  _pitchToY(pitch) {
    const maxPitch = 127;
    const pianoAreaTop = HEADER_HEIGHT;
    const pianoAreaBottom = this.height - PARAM_CURVE_HEIGHT;
    const pianoAreaHeight = pianoAreaBottom - pianoAreaTop;
    return pianoAreaTop + (maxPitch - pitch) * NOTE_HEIGHT * this.zoomY - this.scrollY;
  }

  /**
   * 绘制 Y 坐标 → MIDI 音高
   */
  _yToPitch(y) {
    const maxPitch = 127;
    const pianoAreaTop = HEADER_HEIGHT;
    const pianoAreaBottom = this.height - PARAM_CURVE_HEIGHT;
    if (y >= pianoAreaBottom) return maxPitch;
    if (y <= pianoAreaTop) return 0;
    return Math.round(maxPitch - (y + this.scrollY - pianoAreaTop) / (NOTE_HEIGHT * this.zoomY));
  }

  /**
   * 吸附到最近的拍网格
   */
  _snapBeats(beats) {
    const grid = 1 / 4; // 四分音符网格
    return Math.round(beats / grid) * grid;
  }

  // ===================== 音符查询 =====================

  /**
   * 根据坐标查找音符（优先返回最上层/最后绘制的）
   */
  _findNoteAt(x, y) {
    // 从后往前遍历，后绘制的在上层
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const note = this.notes[i];
      const nx = this._timeToX(note.start);
      const ny = this._pitchToY(note.pitch);
      const nw = note.duration * BEAT_WIDTH * this.zoomX;
      const nh = NOTE_HEIGHT * this.zoomY;
      if (x >= nx && x <= nx + nw && y >= ny && y <= ny + nh) {
        return { note, nx, ny, nw, nh };
      }
    }
    return null;
  }

  /**
   * 判断鼠标位置是否在音符右边缘（resize 区域）
   */
  _isResizeEdge(x, nx, nw) {
    return x >= nx + nw - RESIZE_EDGE_WIDTH && x <= nx + nw;
  }

  // ===================== 鼠标交互 =====================

  _onMouseDown(e) {
    const pos = this._getMousePos(e);
    const { x, y } = pos;

    // 点击钢琴键区域：不处理（后续可扩展为试听）
    if (x < PIANO_KEY_WIDTH) return;

    const hit = this._findNoteAt(x, y);

    if (hit) {
      const { note } = hit;
      this.selectedNoteId = note.id;

      if (this._isResizeEdge(x, hit.nx, hit.nw)) {
        this.dragMode = 'resize';
      } else {
        this.dragMode = 'move';
        this.dragNoteStart = { start: note.start, pitch: note.pitch, duration: note.duration };
      }
      this.dragStartX = x;
      this.dragStartY = y;
    } else {
      // 点击空白处：新建音符
      const beats = this._snapBeats(this._xToTime(x));
      const pitch = this._yToPitch(y);
      const clampedPitch = Math.max(0, Math.min(127, pitch));

      // 确定当前活跃轨道（默认第一个）
      const activeTrack = this.tracks[0];
      const newNote = {
        id: this._genNoteId(),
        trackId: activeTrack?.id ?? 1,
        pitch: clampedPitch,
        start: Math.max(0, beats),
        duration: DEFAULT_NOTE_DURATION,
        lyric: 'la',
      };
      this.notes.push(newNote);
      this.selectedNoteId = newNote.id;
      this.dragMode = 'resize'; // 新建后直接进入 resize 方便调整时长
      this.dragStartX = x;
      this.dragStartY = y;
      this.dragNoteStart = { start: newNote.start, pitch: newNote.pitch, duration: newNote.duration };
    }

    this.render();
  }

  _onMouseMove(e) {
    const pos = this._getMousePos(e);
    const { x, y } = pos;

    if (!this.dragMode) {
      // 仅 hover 检测，更新光标样式
      const hit = this._findNoteAt(x, y);
      if (hit) {
        this.hoverNoteId = hit.note.id;
        if (this._isResizeEdge(x, hit.nx, hit.nw)) {
          this.canvas.style.cursor = 'ew-resize';
        } else {
          this.canvas.style.cursor = 'move';
        }
      } else {
        this.hoverNoteId = null;
        this.canvas.style.cursor = 'default';
      }
      return;
    }

    const note = this.notes.find((n) => n.id === this.selectedNoteId);
    if (!note) return;

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
      newDuration = Math.max(MIN_NOTE_DURATION, this._snapBeats(newDuration));
      note.duration = newDuration;
    }

    this.render();
  }

  _onMouseUp() {
    this.dragMode = null;
    this.dragStartX = 0;
    this.dragStartY = 0;
  }

  _onDoubleClick(e) {
    const pos = this._getMousePos(e);
    const hit = this._findNoteAt(pos.x, pos.y);
    if (hit) {
      this._startInlineEdit(hit.note, hit);
    }
  }

  _startInlineEdit(note, hit) {
    if (this._activeInlineInput) {
      if (this._activeInlineInput.parentElement) this._activeInlineInput.remove();
      this._activeInlineInput = null;
      this._activeInlineEditNote = null;
    }

    this._activeInlineEditNote = note;

    const container = this.canvas.parentElement;
    const containerRect = container.getBoundingClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();

    const offsetX = canvasRect.left - containerRect.left;
    const offsetY = canvasRect.top - containerRect.top;

    const inputX = offsetX + hit.nx + 2;
    const inputY = offsetY + hit.ny;
    const inputW = Math.max(40, hit.nw - 4);
    const inputH = hit.nh;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = note.lyric || '';
    input.style.cssText = `
      position: absolute;
      left: ${inputX}px;
      top: ${inputY}px;
      width: ${inputW}px;
      height: ${inputH}px;
      background: #1e1e1e;
      border: 1px solid #3498db;
      border-radius: 2px;
      color: #ffffff;
      font-size: 11px;
      font-family: sans-serif;
      padding: 0 2px;
      outline: none;
      z-index: 1000;
      box-sizing: border-box;
    `;

    container.style.position = 'relative';
    container.appendChild(input);
    this._activeInlineInput = input;

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    let finished = false;

    const finish = (save) => {
      if (finished) return;
      finished = true;

      if (save) {
        const newLyric = input.value;
        if (newLyric !== note.lyric) {
          const tokens = tokenizeLyric(newLyric);
          if (tokens.length <= 1) {
            note.lyric = newLyric;
          } else {
            const noteIdx = this.notes.findIndex(n => n.id === note.id);
            if (noteIdx !== -1) {
              note.lyric = tokens[0];
              for (let t = 1; t < tokens.length; t++) {
                const nextIdx = noteIdx + t;
                if (nextIdx < this.notes.length) {
                  this.notes[nextIdx].lyric = tokens[t];
                }
              }
            } else {
              note.lyric = newLyric;
            }
          }
        }
      }
      if (input.parentElement) input.remove();
      this._activeInlineInput = null;
      this._activeInlineEditNote = null;
      this.render();
    };

    input.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    input.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._onWheel(e);
    }, { passive: false });

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });

    input.addEventListener('blur', () => {
      finish(true);
    });
  }

  _updateInlineInputPosition() {
    if (!this._activeInlineInput || !this._activeInlineEditNote) return;

    const note = this._activeInlineEditNote;
    const container = this.canvas.parentElement;
    const containerRect = container.getBoundingClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();

    const offsetX = canvasRect.left - containerRect.left;
    const offsetY = canvasRect.top - containerRect.top;

    const nx = this._timeToX(note.start);
    const ny = this._pitchToY(note.pitch);
    const nw = note.duration * BEAT_WIDTH * this.zoomX;
    const nh = NOTE_HEIGHT * this.zoomY;

    const visible = nx + nw >= PIANO_KEY_WIDTH && nx <= this.width &&
                    ny + nh >= HEADER_HEIGHT && ny <= this.height - PARAM_CURVE_HEIGHT;

    if (visible) {
      this._activeInlineInput.style.display = '';
      this._activeInlineInput.style.left = (offsetX + nx + 2) + 'px';
      this._activeInlineInput.style.top = (offsetY + ny) + 'px';
      this._activeInlineInput.style.width = Math.max(40, nw - 4) + 'px';
      this._activeInlineInput.style.height = nh + 'px';
    } else {
      this._activeInlineInput.style.display = 'none';
    }
  }

  _onWheel(e) {
    e.preventDefault();
    const pos = this._getMousePos(e);

    if (e.ctrlKey || e.metaKey) {
      // 水平缩放
      const oldZoomX = this.zoomX;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this.zoomX = Math.max(0.25, Math.min(4, this.zoomX * delta));
      // 以鼠标位置为中心缩放
      const mouseBeats = this._xToTime(pos.x);
      this.scrollX = mouseBeats * BEAT_WIDTH * this.zoomX - (pos.x - PIANO_KEY_WIDTH);
    } else if (e.shiftKey) {
      // 水平滚动
      this.scrollX += e.deltaY;
    } else {
      // 垂直滚动
      this.scrollY += e.deltaY;
    }

    // 限制滚动范围
    const totalHeight = 128 * NOTE_HEIGHT * this.zoomY + HEADER_HEIGHT;
    this.scrollY = Math.max(0, Math.min(totalHeight - this.height, this.scrollY));
    this.scrollX = Math.max(0, this.scrollX);

    this.render();
  }

  _onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selectedNoteId !== null) {
        this.removeNote(this.selectedNoteId);
        this.selectedNoteId = null;
        this.render();
      }
    }
  }

  _genNoteId() {
    return Date.now() + Math.random();
  }

  // ===================== 绘制 =====================

  render() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    ctx.clearRect(0, 0, w, h);

    this._drawBackground(ctx, w, h);
    this._drawGrid(ctx, w, h);
    this._drawNotes(ctx);
    this._drawPianoKeys(ctx, h);
    this._drawParamCurve(ctx, w, h);
    this._drawPlayhead(ctx, h);
    this._updateInlineInputPosition();
  }

  _drawBackground(ctx, w, h) {
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, w, h);
  }

  /**
   * 绘制网格线（小节线、拍线）
   */
  _drawGrid(ctx, w, h) {
    const beatsPerMeasure = this.projectSettings.timeSignature[0];

    // 计算可见时间范围
    const startBeat = this._xToTime(PIANO_KEY_WIDTH);
    const endBeat = this._xToTime(w);

    ctx.lineWidth = 1;

    for (let b = Math.floor(startBeat); b <= Math.ceil(endBeat); b++) {
      const x = this._timeToX(b);
      if (x < PIANO_KEY_WIDTH) continue;

      const isMeasureLine = (b % beatsPerMeasure === 0);
      ctx.strokeStyle = isMeasureLine ? '#666666' : '#444444';
      ctx.beginPath();
      ctx.moveTo(x, HEADER_HEIGHT);
      ctx.lineTo(x, this._getParamCurveAreaTop());
      ctx.stroke();

      // 小节编号
      if (isMeasureLine) {
        ctx.fillStyle = '#999999';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        const measureNum = Math.floor(b / beatsPerMeasure) + 1;
        ctx.fillText(String(measureNum), x, HEADER_HEIGHT - 6);
      }
    }

    // 绘制水平音高分隔线
    const startPitch = this._yToPitch(h);
    const endPitch = this._yToPitch(HEADER_HEIGHT);
    for (let p = Math.max(0, startPitch); p <= Math.min(127, endPitch); p++) {
      const y = this._pitchToY(p);
      const isBlack = BLACK_KEYS.has(p % 12);
      ctx.strokeStyle = isBlack ? '#333333' : '#2a2a2a';
      ctx.beginPath();
      ctx.moveTo(PIANO_KEY_WIDTH, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  /**
   * 绘制钢琴键（左侧固定区域）
   */
  _drawPianoKeys(ctx, h) {
    const startPitch = this._yToPitch(h);
    const endPitch = this._yToPitch(HEADER_HEIGHT);

    for (let p = Math.max(0, startPitch); p <= Math.min(127, endPitch); p++) {
      const y = this._pitchToY(p);
      const keyH = NOTE_HEIGHT * this.zoomY;
      const isBlack = BLACK_KEYS.has(p % 12);

      ctx.fillStyle = isBlack ? '#111111' : '#eeeeee';
      ctx.fillRect(0, y, PIANO_KEY_WIDTH, keyH);

      ctx.strokeStyle = '#555555';
      ctx.strokeRect(0, y, PIANO_KEY_WIDTH, keyH);

      // 白键显示音名
      if (!isBlack) {
        ctx.fillStyle = '#333333';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(midiToNoteName(p), PIANO_KEY_WIDTH - 4, y + keyH / 2 + 4);
      }
    }

    // 钢琴键与网格分隔线
    ctx.strokeStyle = '#555555';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PIANO_KEY_WIDTH, HEADER_HEIGHT);
    ctx.lineTo(PIANO_KEY_WIDTH, h);
    ctx.stroke();
  }

  /**
   * 绘制音符块
   */
  _drawNotes(ctx) {
    for (const note of this.notes) {
      const x = this._timeToX(note.start);
      const y = this._pitchToY(note.pitch);
      const w = note.duration * BEAT_WIDTH * this.zoomX;
      const h = NOTE_HEIGHT * this.zoomY;

      // 若不在可视区域则跳过
      if (x + w < PIANO_KEY_WIDTH || x > this.width || y + h < HEADER_HEIGHT || y > this.height) {
        continue;
      }

      const track = this.tracks.find((t) => t.id === note.trackId);
      const baseColor = track?.color ?? '#3498db';

      // 选中高亮
      const isSelected = note.id === this.selectedNoteId;
      const isHover = note.id === this.hoverNoteId;

      ctx.fillStyle = baseColor;
      ctx.globalAlpha = isSelected ? 1.0 : 0.85;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1.0;

      // 边框
      ctx.strokeStyle = isSelected ? '#ffffff' : (isHover ? '#dddddd' : '#000000');
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeRect(x, y, w, h);

      // 歌词文本
      if (w > 20) {
        ctx.fillStyle = '#ffffff';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const text = note.lyric || '';
        const textX = x + 4;
        const textY = y + h / 2;
        ctx.fillText(text, textX, textY);
      }

      // 右边缘 resize 指示条
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(x + w - 4, y + 2, 2, h - 4);
    }
  }

  _getParamCurveAreaTop() {
    return this.height - PARAM_CURVE_HEIGHT;
  }

  _getParamCurveAreaBottom() {
    return this.height;
  }

  _getParamCurveYRange() {
    switch (this.paramMode) {
      case PARAM_MODES.VOL:
        return { min: 0, max: 1 };
      case PARAM_MODES.PAN:
        return { min: -1, max: 1 };
      case PARAM_MODES.F0:
        return { min: -12, max: 12 };
      default:
        return { min: 0, max: 1 };
    }
  }

  _valueToParamY(value) {
    const areaTop = this._getParamCurveAreaTop();
    const areaBottom = this._getParamCurveAreaBottom();
    const areaHeight = areaBottom - areaTop;
    const { min, max } = this._getParamCurveYRange();
    const normalized = (value - min) / (max - min);
    return areaTop + (1 - normalized) * areaHeight;
  }

  _paramYToValue(y) {
    const areaTop = this._getParamCurveAreaTop();
    const areaBottom = this._getParamCurveAreaBottom();
    const areaHeight = areaBottom - areaTop;
    const { min, max } = this._getParamCurveYRange();
    const normalized = 1 - (y - areaTop) / areaHeight;
    return min + normalized * (max - min);
  }

  _drawParamCurve(ctx, w, h) {
    if (this.paramMode === PARAM_MODES.MIDI) return;

    const areaTop = this._getParamCurveAreaTop();
    const areaBottom = this._getParamCurveAreaBottom();

    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, areaTop, w, PARAM_CURVE_HEIGHT);

    ctx.strokeStyle = '#444444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, areaTop);
    ctx.lineTo(w, areaTop);
    ctx.stroke();

    const { min, max } = this._getParamCurveYRange();
    ctx.fillStyle = '#666666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(max.toFixed(0), 4, areaTop + 12);
    ctx.fillText(min.toFixed(0), 4, areaBottom - 4);
    ctx.textAlign = 'right';
    ctx.fillText(this.paramMode, w - 4, areaTop + 12);

    const envKey = this.paramMode === PARAM_MODES.VOL ? 'volume' : (this.paramMode === PARAM_MODES.PAN ? 'pan' : 'f0');
    const envelope = this.envelopes[envKey];
    if (!envelope || !envelope.keyframes || envelope.keyframes.length === 0) return;

    const maxTime = Math.max(8, ...envelope.keyframes.map(k => k.time)) * 1.2;
    const steps = Math.max(50, Math.floor(maxTime * 20));

    const lineColors = {
      [PARAM_MODES.VOL]: '#3498db',
      [PARAM_MODES.PAN]: '#e74c3c',
      [PARAM_MODES.F0]: '#2ecc71',
    };
    ctx.strokeStyle = lineColors[this.paramMode] || '#3498db';
    ctx.lineWidth = 2;
    ctx.beginPath();

    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * maxTime;
      const value = this._interpolateEnvelope(envelope, t);
      const x = PIANO_KEY_WIDTH + (t / maxTime) * (w - PIANO_KEY_WIDTH) - (this.scrollX * (1 + (w - PIANO_KEY_WIDTH) / maxTime / BEAT_WIDTH / this.zoomX));
      const y = this._valueToParamY(value);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    for (let i = 0; i < envelope.keyframes.length; i++) {
      const kf = envelope.keyframes[i];
      const x = PIANO_KEY_WIDTH + (kf.time / maxTime) * (w - PIANO_KEY_WIDTH) - (this.scrollX * (1 + (w - PIANO_KEY_WIDTH) / maxTime / BEAT_WIDTH / this.zoomX));
      const y = this._valueToParamY(kf.value);
      const isSelected = i === this.selectedEnvelopeIndex;
      const isHover = i === this.hoverEnvelopeIndex;

      ctx.fillStyle = isSelected ? '#ffffff' : (isHover ? '#dddddd' : (lineColors[this.paramMode] || '#3498db'));
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = isSelected ? '#ffffff' : '#222222';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();
    }
  }

  _interpolateEnvelope(envelope, time) {
    const kfs = envelope.keyframes;
    if (kfs.length === 0) return 0.5;
    if (kfs.length === 1) return kfs[0].value;

    if (time <= kfs[0].time) return kfs[0].value;
    if (time >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;

    for (let i = 0; i < kfs.length - 1; i++) {
      if (time >= kfs[i].time && time <= kfs[i + 1].time) {
        const t = (time - kfs[i].time) / (kfs[i + 1].time - kfs[i].time);
        const smoothness = kfs[i].smoothness / 100;
        const smoothT = smoothness > 0 ? this._smoothstep(t, smoothness) : t;
        return kfs[i].value + (kfs[i + 1].value - kfs[i].value) * smoothT;
      }
    }
    return 0.5;
  }

  _smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  _findEnvelopeKeyframeAt(x, y) {
    if (this.paramMode === PARAM_MODES.MIDI) return null;

    const areaTop = this._getParamCurveAreaTop();
    const areaBottom = this._getParamCurveAreaBottom();
    if (y < areaTop || y > areaBottom) return null;

    const envKey = this.paramMode === PARAM_MODES.VOL ? 'volume' : (this.paramMode === PARAM_MODES.PAN ? 'pan' : 'f0');
    const envelope = this.envelopes[envKey];
    if (!envelope || !envelope.keyframes) return null;

    const maxTime = Math.max(8, ...envelope.keyframes.map(k => k.time)) * 1.2;

    for (let i = 0; i < envelope.keyframes.length; i++) {
      const kf = envelope.keyframes[i];
      const kx = PIANO_KEY_WIDTH + (kf.time / maxTime) * (this.width - PIANO_KEY_WIDTH) - (this.scrollX * (1 + (this.width - PIANO_KEY_WIDTH) / maxTime / BEAT_WIDTH / this.zoomX));
      const ky = this._valueToParamY(kf.value);
      const dist = Math.sqrt((x - kx) ** 2 + (y - ky) ** 2);
      if (dist <= 8) {
        return { index: i, keyframe: kf, x: kx, y: ky };
      }
    }
    return null;
  }

  /**
   * 绘制播放头
   */
  _drawPlayhead(ctx, h) {
    const beat = this._secondsToBeats(this.currentTime);
    const x = this._timeToX(beat);
    if (x < PIANO_KEY_WIDTH || x > this.width) return;

    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, HEADER_HEIGHT);
    ctx.lineTo(x, h);
    ctx.stroke();

    // 播放头三角标
    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.moveTo(x, HEADER_HEIGHT);
    ctx.lineTo(x - 6, HEADER_HEIGHT - 6);
    ctx.lineTo(x + 6, HEADER_HEIGHT - 6);
    ctx.closePath();
    ctx.fill();
  }

  // ===================== 播放控制 =====================

  /**
   * 秒 → 拍（根据 BPM）
   */
  _secondsToBeats(seconds) {
    return (seconds / 60) * this.projectSettings.bpm;
  }

  /**
   * 拍 → 秒
   */
  _beatsToSeconds(beats) {
    return (beats / this.projectSettings.bpm) * 60;
  }

  startPlayback() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.playStartTime = performance.now();
    this.playStartOffset = this.currentTime;
    this._tickPlayback();
  }

  pausePlayback() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    if (this.playbackRaf) {
      cancelAnimationFrame(this.playbackRaf);
      this.playbackRaf = null;
    }
    // 记录当前时间
    const elapsed = (performance.now() - this.playStartTime) / 1000;
    this.currentTime = this.playStartOffset + elapsed;
  }

  stopPlayback() {
    this.isPlaying = false;
    if (this.playbackRaf) {
      cancelAnimationFrame(this.playbackRaf);
      this.playbackRaf = null;
    }
    this.currentTime = 0;
    this.render();
  }

  _tickPlayback() {
    if (!this.isPlaying) return;
    const elapsed = (performance.now() - this.playStartTime) / 1000;
    this.currentTime = this.playStartOffset + elapsed;
    this.render();
    this.playbackRaf = requestAnimationFrame(() => this._tickPlayback());
  }

  // ===================== 公共 API =====================

  /**
   * 设置轨道列表（用于获取颜色）
   * @param {Object[]} tracks
   */
  setTracks(tracks) {
    this.tracks = tracks.map((t) => ({ id: t.id, color: t.color }));
    this.render();
  }

  /**
   * 设置项目参数
   * @param {number} bpm
   * @param {number[]} timeSignature [分子, 分母]
   */
  setProject(bpm, timeSignature) {
    if (bpm !== undefined) this.projectSettings.bpm = bpm;
    if (timeSignature !== undefined) this.projectSettings.timeSignature = timeSignature;
    this.render();
  }

  /**
   * 获取所有音符
   * @returns {Object[]}
   */
  getNotes() {
    return this.notes;
  }

  /**
   * 设置所有音符（用于切换歌手时加载对应音符）
   * @param {Object[]} notes
   */
  setNotes(notes) {
    this.notes = notes || [];
    this.render();
  }

  /**
   * 添加音符
   * @param {Object} note
   */
  addNote(note) {
    const newNote = {
      id: note.id ?? this._genNoteId(),
      trackId: note.trackId ?? (this.tracks[0]?.id ?? 1),
      pitch: Math.max(0, Math.min(127, note.pitch ?? 60)),
      start: Math.max(0, note.start ?? 0),
      duration: Math.max(MIN_NOTE_DURATION, note.duration ?? DEFAULT_NOTE_DURATION),
      lyric: note.lyric ?? 'la',
    };
    this.notes.push(newNote);
    this.render();
    return newNote;
  }

  /**
   * 删除音符
   * @param {number} noteId
   */
  removeNote(noteId) {
    const idx = this.notes.findIndex((n) => n.id === noteId);
    if (idx !== -1) {
      this.notes.splice(idx, 1);
      if (this.selectedNoteId === noteId) this.selectedNoteId = null;
      this.render();
    }
  }

  /**
   * 设置播放时间（秒）
   * @param {number} seconds
   */
  setCurrentTime(seconds) {
    this.currentTime = Math.max(0, seconds);
    if (!this.isPlaying) this.render();
  }

  /**
   * 获取当前播放时间（秒）
   * @returns {number}
   */
  getCurrentTime() {
    if (this.isPlaying) {
      return this.playStartOffset + (performance.now() - this.playStartTime) / 1000;
    }
    return this.currentTime;
  }

  getParamMode() {
    return this.paramMode;
  }

  setParamMode(mode) {
    if (Object.values(PARAM_MODES).includes(mode)) {
      this.paramMode = mode;
      this.render();
    }
  }

  getEnvelopes() {
    return this.envelopes;
  }

  setEnvelopes(envelopes) {
    if (envelopes) {
      this.envelopes = {
        volume: envelopes.volume || { keyframes: [{ time: 0, value: 1, smoothness: 0 }] },
        pan: envelopes.pan || { keyframes: [{ time: 0, value: 0, smoothness: 0 }] },
        f0: envelopes.f0 || { keyframes: [{ time: 0, value: 0, smoothness: 0 }] },
      };
      this.render();
    }
  }

  getCurrentEnvelope() {
    switch (this.paramMode) {
      case PARAM_MODES.VOL:
        return this.envelopes.volume;
      case PARAM_MODES.PAN:
        return this.envelopes.pan;
      case PARAM_MODES.F0:
        return this.envelopes.f0;
      default:
        return this.envelopes.volume;
    }
  }

  updateCurrentEnvelope(envelope) {
    switch (this.paramMode) {
      case PARAM_MODES.VOL:
        this.envelopes.volume = envelope;
        break;
      case PARAM_MODES.PAN:
        this.envelopes.pan = envelope;
        break;
      case PARAM_MODES.F0:
        this.envelopes.f0 = envelope;
        break;
    }
  }
}

export { PianoRoll, PIANO_KEY_WIDTH, NOTE_HEIGHT, BEAT_WIDTH, PARAM_MODES, PARAM_CURVE_HEIGHT };
