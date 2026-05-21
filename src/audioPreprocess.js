import './audioPreprocess.css';
import { t, initI18n, applyLocale, getLocale } from './i18n/index.js';

function debounce(fn, ms) {
  let timer = null;
  return function(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(this, args); }, ms);
  };
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

function mergePhoneme(notes) {
  const merged = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const lyric = (n.lyric || '').replace('<AP>', '<SP>');
    const isSP = !lyric.trim() || lyric === '<SP>';
    const hasLyric = lyric.trim().length > 0 && !isSP;
    const isSlur = n.isSlur || n.isContinuation;
    let noteType;
    if (!hasLyric && isSP) {
      noteType = 1;
    } else if (isSlur) {
      noteType = 3;
    } else {
      noteType = 2;
    }
    if (
      i > 0 &&
      merged.length > 0 &&
      isSP &&
      !merged[merged.length - 1].hasLyric &&
      merged[merged.length - 1].isSP &&
      noteType === merged[merged.length - 1].noteType &&
      n.pitch === merged[merged.length - 1].pitch
    ) {
      merged[merged.length - 1].duration += n.duration;
    } else {
      merged.push({
        lyric: isSP ? '<SP>' : lyric,
        pitch: n.pitch,
        duration: n.duration,
        start: n.start,
        id: n.id,
        isSlur: isSlur,
        isContinuation: n.isContinuation,
        hasLyric: hasLyric,
        isSP: isSP,
        noteType: noteType,
      });
    }
  }
  return merged.map(m => ({
    lyric: m.isSP ? '' : m.lyric,
    pitch: m.pitch,
    duration: m.duration,
    start: m.start,
    id: m.id,
    isSlur: m.isSlur,
    isContinuation: m.isContinuation,
  }));
}

function buildSingerFields(notes) {
  const mergedNotes = mergePhoneme(notes);
  const textParts = [];
  const phonemeParts = [];
  const noteTypeParts = [];
  for (let i = 0; i < mergedNotes.length; i++) {
    const n = mergedNotes[i];
    const lyric = n.lyric || '';
    const hasLyric = lyric.trim().length > 0;
    const isSlur = n.isSlur || n.isContinuation;
    if (hasLyric) {
      textParts.push(lyric);
      phonemeParts.push(lyric);
    } else {
      textParts.push('<SP>');
      phonemeParts.push('<SP>');
    }
    if (!hasLyric) {
      noteTypeParts.push('1');
    } else if (isSlur) {
      noteTypeParts.push('3');
    } else {
      noteTypeParts.push('2');
    }
  }
  return {
    text: textParts.join(' '),
    phoneme: phonemeParts.join(' '),
    note_type: noteTypeParts.join(' '),
  };
}

let wavFileBuffer = null;
let wavFileName = '';
let wavAudioBuffer = null;
let wavDuration = 0;
let singerName = '';
let singerColor = '#3498db';
let avatarImageData = null;
let avatarImageName = '';

let pianoRoll = null;
let isPlaying = false;
let audioContext = null;
let audioSource = null;
let playStartTime = 0;
let playStartOffset = 0;
let playbackRaf = null;

let f0Data = null;
let singerData = null;

let waveformScrollX = 0;
let waveformZoomX = 1;

const PIANO_KEY_WIDTH = 60;
const NOTE_HEIGHT = 16;
const BEAT_WIDTH = 80;
const HEADER_HEIGHT = 24;
const F0_CURVE_AREA_HEIGHT = 100;
const BPM = 120;

function syncWaveformZoomToPianoRoll() {
  if (!pianoRoll) return;
  const beatPerPixel = 1 / (BEAT_WIDTH * waveformZoomX);
  pianoRoll.zoomX = waveformZoomX;
  pianoRoll.scrollX = waveformScrollX;
  pianoRoll.render();
}

function syncPianoRollZoomToWaveform() {
  if (!pianoRoll) return;
  waveformZoomX = pianoRoll.zoomX;
  waveformScrollX = pianoRoll.scrollX;
  drawWaveformWithPlayhead(pianoRoll.getCurrentTime());
}

const btnPlayPause = document.getElementById('btn-play-pause');
const btnExtractF0 = document.getElementById('btn-extract-f0');
const btnExtractF0BasicPitch = document.getElementById('btn-extract-f0-basic-pitch');
const btnSave = document.getElementById('btn-save');
const btnBack = document.getElementById('btn-back');
const wavFileNameEl = document.getElementById('wav-file-name');
const midiInfoEl = document.getElementById('midi-info');
const waveformCanvas = document.getElementById('waveform-canvas');
const midiCanvas = document.getElementById('midi-canvas');

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    togglePlayback();
  }
});

btnPlayPause.addEventListener('click', togglePlayback);
btnExtractF0.addEventListener('click', extractF0AndPitch);
btnExtractF0BasicPitch.addEventListener('click', extractF0BasicPitch);
btnSave.addEventListener('click', saveSingerData);
btnBack.addEventListener('click', () => {
  stopPlayback();
  window.close();
});

function togglePlayback() {
  if (isPlaying) {
    pausePlayback();
  } else {
    startPlayback();
  }
}

async function startPlayback() {
  if (!wavAudioBuffer) return;

  try {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    }

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    const source = audioContext.createBufferSource();
    source.buffer = wavAudioBuffer;
    source.connect(audioContext.destination);

    if (playStartOffset > 0 && playStartOffset < wavAudioBuffer.duration) {
      source.start(0, playStartOffset);
    } else {
      source.start();
    }

    source.onended = () => {
      if (isPlaying) {
        isPlaying = false;
        playStartOffset = 0;
        btnPlayPause.textContent = t('preprocess.play');
        stopPlaybackRaf();
        drawWaveformWithPlayhead(0);
        if (pianoRoll) pianoRoll.stopPlayback();
      }
    };

    audioSource = source;
    isPlaying = true;
    playStartTime = performance.now();
    btnPlayPause.textContent = t('preprocess.pause');

    // 统一播放循环，确保waveform和pianoRoll使用同一个时间源
    if (pianoRoll) {
      pianoRoll.isPlaying = true;
      pianoRoll.playStartTime = playStartTime;
      pianoRoll.playStartOffset = playStartOffset;
      pianoRoll.currentTime = playStartOffset;
      pianoRoll._tickPlayback();
    } else {
      startPlaybackLoop();
    }
  } catch (err) {
    console.error('播放失败:', err);
  }
}

function pausePlayback() {
  if (!isPlaying) return;

  isPlaying = false;
  if (audioSource) {
    try {
      audioSource.onended = null;
      audioSource.stop();
    } catch (e) {}
    audioSource = null;
  }

  const elapsed = (performance.now() - playStartTime) / 1000;
  playStartOffset += elapsed;

  if (playStartOffset >= wavAudioBuffer.duration) {
    playStartOffset = 0;
  }

  btnPlayPause.textContent = t('preprocess.play');
  stopPlaybackRaf();

  const currentTime = playStartOffset;
  drawWaveformWithPlayhead(currentTime);
  if (pianoRoll) {
    pianoRoll.pausePlayback();
    pianoRoll.setCurrentTime(currentTime);
  }
}

function stopPlayback() {
  isPlaying = false;
  if (audioSource) {
    try {
      audioSource.onended = null;
      audioSource.stop();
    } catch (e) {}
    audioSource = null;
  }
  stopPlaybackRaf();
  playStartOffset = 0;
  btnPlayPause.textContent = t('preprocess.play');
  drawWaveformWithPlayhead(0);
  if (pianoRoll) pianoRoll.stopPlayback();
}

function stopPlaybackRaf() {
  if (playbackRaf) {
    cancelAnimationFrame(playbackRaf);
    playbackRaf = null;
  }
}

function startPlaybackLoop() {
  if (!isPlaying) return;

  const elapsed = (performance.now() - playStartTime) / 1000;
  const currentTime = playStartOffset + elapsed;

  drawWaveformWithPlayhead(currentTime);

  playbackRaf = requestAnimationFrame(() => startPlaybackLoop());
}

function drawWaveformWithPlayhead(currentTime) {
  if (!wavAudioBuffer) return;

  const canvas = waveformCanvas;
  const container = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = container.clientWidth;
  const height = container.clientHeight;

  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, width, height);

  const zoomX = pianoRoll ? pianoRoll.zoomX : waveformZoomX;
  const scrollX = pianoRoll ? pianoRoll.scrollX : waveformScrollX;

  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, PIANO_KEY_WIDTH, height);

  ctx.strokeStyle = '#555555';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PIANO_KEY_WIDTH, 0);
  ctx.lineTo(PIANO_KEY_WIDTH, height);
  ctx.stroke();

  const dataAreaWidth = width - PIANO_KEY_WIDTH;
  if (dataAreaWidth <= 0) return;

  const audioData = wavAudioBuffer.getChannelData(0);
  const totalSamples = audioData.length;
  const secondsPerBeat = 60 / BPM;
  const mid = height / 2;

  const audioEndBeat = (wavDuration / 60) * BPM;
  const audioEndX = PIANO_KEY_WIDTH + audioEndBeat * BEAT_WIDTH * zoomX - scrollX;
  const drawEndX = Math.min(Math.floor(audioEndX), width);
  const drawStartX = PIANO_KEY_WIDTH;

  if (drawEndX > drawStartX) {
    ctx.fillStyle = '#3498db';
    for (let i = drawStartX; i < drawEndX; i++) {
      const beat = (i + scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * zoomX);
      const nextBeat = (i + 1 + scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * zoomX);
      const time = beat * secondsPerBeat;
      const nextTime = nextBeat * secondsPerBeat;
      const sampleIdx = Math.floor((time / wavDuration) * totalSamples);
      const nextSampleIdx = Math.min(Math.floor((nextTime / wavDuration) * totalSamples), totalSamples);
      let min = 1.0;
      let max = -1.0;
      for (let idx = sampleIdx; idx < nextSampleIdx; idx++) {
        if (idx >= 0 && idx < totalSamples) {
          const datum = audioData[idx];
          if (datum < min) min = datum;
          if (datum > max) max = datum;
        }
      }
      const barHeight = Math.max(1, ((max - min) / 2) * height);
      ctx.fillRect(i, mid - barHeight / 2, 1, barHeight);
    }
  }

  if (currentTime >= 0 && currentTime <= wavDuration) {
    const currentBeat = (currentTime / 60) * BPM;
    const playheadX = PIANO_KEY_WIDTH + currentBeat * BEAT_WIDTH * zoomX - scrollX;

    if (playheadX >= PIANO_KEY_WIDTH && playheadX <= width) {
      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();

      ctx.fillStyle = '#ff4444';
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX - 6, -2);
      ctx.lineTo(playheadX + 6, -2);
      ctx.closePath();
      ctx.fill();
    }
  }
}

waveformCanvas.addEventListener('click', (e) => {
  if (!wavAudioBuffer || !wavDuration) return;

  const rect = waveformCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;

  if (x < PIANO_KEY_WIDTH) return;

  const zoomX = pianoRoll ? pianoRoll.zoomX : waveformZoomX;
  const scrollX = pianoRoll ? pianoRoll.scrollX : waveformScrollX;

  const beat = (x + scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * zoomX);
  const secondsPerBeat = 60 / BPM;
  const clampedTime = Math.max(0, Math.min(wavDuration, beat * secondsPerBeat));

  playStartOffset = clampedTime;

  drawWaveformWithPlayhead(clampedTime);

  if (pianoRoll) {
    pianoRoll.setCurrentTime(clampedTime);
  }

  if (isPlaying) {
    stopPlayback();
    startPlayback();
  }
});

waveformCanvas.addEventListener('wheel', (e) => {
  if (!wavAudioBuffer || !pianoRoll) return;
  e.preventDefault();

  const rect = waveformCanvas.getBoundingClientRect();
  const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };

  if (e.ctrlKey || e.metaKey) {
    const oldZoomX = pianoRoll.zoomX;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    pianoRoll.zoomX = Math.max(0.25, Math.min(4, pianoRoll.zoomX * delta));
    const mouseBeats = (pos.x + pianoRoll.scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * oldZoomX);
    pianoRoll.scrollX = PIANO_KEY_WIDTH + mouseBeats * BEAT_WIDTH * pianoRoll.zoomX - pos.x;
    pianoRoll.scrollX = Math.max(0, pianoRoll.scrollX);
    pianoRoll.render();
  } else if (e.shiftKey) {
    pianoRoll.scrollX += e.deltaY;
    pianoRoll.scrollX = Math.max(0, pianoRoll.scrollX);
    pianoRoll.render();
  } else {
    pianoRoll.scrollY += e.deltaY;
    const totalHeight = 128 * NOTE_HEIGHT * pianoRoll.zoomY + HEADER_HEIGHT;
    pianoRoll.scrollY = Math.max(0, Math.min(totalHeight - pianoRoll.height, pianoRoll.scrollY));
    pianoRoll.render();
  }
  
  drawWaveformWithPlayhead(pianoRoll.getCurrentTime());
}, { passive: false });

async function initPianoRoll() {
  if (pianoRoll) return;

  const notes = [];
  pianoRoll = {
    canvas: midiCanvas,
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
    dpr: window.devicePixelRatio || 1,

    _initEvents() {
      window.addEventListener('resize', debounce(() => this._resize(), 100));
      this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
      this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
      document.addEventListener('mouseup', () => this._onMouseUp());
      this.canvas.addEventListener('mouseleave', () => {
        this.hoverNoteId = null;
        this.canvas.style.cursor = 'default';
      });
      this.canvas.addEventListener('dblclick', (e) => this._onDoubleClick(e));
      this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
      document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (this.selectedNoteId !== null) {
            this.removeNote(this.selectedNoteId);
            this.selectedNoteId = null;
            this.render();
            updateMidiInfo();
          }
        }
      });
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
      if (y >= pianoAreaBottom) return maxPitch;
      if (y <= pianoAreaTop) return 0;
      return Math.round(maxPitch - (y + this.scrollY - pianoAreaTop) / (NOTE_HEIGHT * this.zoomY));
    },

    _snapBeats(beats) {
      const grid = 1 / 16;
      return Math.round(beats / grid) * grid;
    },

    _findNoteAt(x, y) {
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
    },

    _isResizeEdge(x, nx, nw) {
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
        if (this._isResizeEdge(x, hit.nx, hit.nw)) {
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
      this.render();
    },

    _onMouseMove(e) {
      const pos = this._getMousePos(e);
      const { x, y } = pos;
      if (!this.dragMode) {
        const hit = this._findNoteAt(x, y);
        if (hit) {
          this.hoverNoteId = hit.note.id;
          this.canvas.style.cursor = this._isResizeEdge(x, hit.nx, hit.nw) ? 'ew-resize' : 'move';
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
        newDuration = Math.max(1 / 16, this._snapBeats(newDuration));
        note.duration = newDuration;
      }
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
        this.zoomX = Math.max(0.25, Math.min(4, this.zoomX * delta));
        const mouseBeats = (pos.x + this.scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * oldZoomX);
        this.scrollX = PIANO_KEY_WIDTH + mouseBeats * BEAT_WIDTH * this.zoomX - pos.x;
        this.scrollX = Math.max(0, this.scrollX);
        waveformZoomX = this.zoomX;
        waveformScrollX = this.scrollX;
        drawWaveformWithPlayhead(this.getCurrentTime());
      } else if (e.shiftKey) {
        this.scrollX += e.deltaY;
        this.scrollX = Math.max(0, this.scrollX);
        waveformScrollX = this.scrollX;
        drawWaveformWithPlayhead(this.getCurrentTime());
      } else {
        this.scrollY += e.deltaY;
      }
      this.scrollY = Math.max(0, Math.min(128 * NOTE_HEIGHT * this.zoomY + HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT - this.height, this.scrollY));
      this.scrollX = Math.max(0, this.scrollX);
      this.render();
    },

    _secondsToBeats(seconds) {
      return (seconds / 60) * this.bpm;
    },

    startPlayback() {
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
        this.render();
      }
    },

    render() {
      const ctx = this.ctx;
      const w = this.width;
      const h = this.height;
      if (!ctx) return;

      ctx.clearRect(0, 0, w, h);
      this._drawBackground(ctx, w, h);
      this._drawGrid(ctx, w, h);
      this._drawF0Curve(ctx, w, h);
      this._drawNotes(ctx);
      this._drawPianoKeys(ctx, h);
      this._drawPlayhead(ctx, h);
      updateInlineInputPosition(this);
    },

    _drawBackground(ctx, w, h) {
      ctx.fillStyle = '#1e1e1e';
      ctx.fillRect(0, 0, w, h);
    },

    _drawF0Curve(ctx, w, h) {
      if (!this.f0Data || this.f0Data.length === 0) return;

      const f0AreaTop = HEADER_HEIGHT;
      const f0AreaBottom = f0AreaTop + F0_CURVE_AREA_HEIGHT;
      const f0AreaHeight = f0AreaBottom - f0AreaTop;
      const minF0 = 50;
      const maxF0 = 1500;
      const minLogF0 = Math.log2(minF0);
      const maxLogF0 = Math.log2(maxF0);
      const logRange = maxLogF0 - minLogF0;

      ctx.fillStyle = '#161616';
      ctx.fillRect(PIANO_KEY_WIDTH, f0AreaTop, w - PIANO_KEY_WIDTH, F0_CURVE_AREA_HEIGHT);

      ctx.fillStyle = '#888888';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(t('preprocess.f0CurveReadOnly'), PIANO_KEY_WIDTH + 6, f0AreaTop + 14);

      ctx.strokeStyle = '#444444';
      ctx.lineWidth = 1;
      const refFreqs = [100, 200, 300, 400, 500, 600, 700, 800, 1000, 1200];
      for (const freq of refFreqs) {
        if (freq < minF0 || freq > maxF0) continue;
        const normalizedF0 = (Math.log2(freq) - minLogF0) / logRange;
        const y = f0AreaBottom - normalizedF0 * f0AreaHeight;
        ctx.beginPath();
        ctx.setLineDash([2, 4]);
        ctx.moveTo(PIANO_KEY_WIDTH, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#555555';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(freq + 'Hz', PIANO_KEY_WIDTH - 4, y + 3);
      }

      ctx.strokeStyle = '#666666';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PIANO_KEY_WIDTH, f0AreaBottom);
      ctx.lineTo(w, f0AreaBottom);
      ctx.stroke();

      ctx.strokeStyle = '#ff6b6b';
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
        if (x > w + 10) {
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
        ctx.fillStyle = '#ff6b6b88';
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
          if (x > w + 10) break;
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

    _drawGrid(ctx, w, h) {
      const beatsPerMeasure = this.projectSettings.timeSignature[0];
      const startBeat = this._xToTime(PIANO_KEY_WIDTH);
      const endBeat = this._xToTime(w);

      ctx.lineWidth = 1;
      for (let b = Math.floor(startBeat); b <= Math.ceil(endBeat); b++) {
        const x = this._timeToX(b);
        if (x < PIANO_KEY_WIDTH) continue;
        const isMeasureLine = (b % beatsPerMeasure === 0);
        ctx.strokeStyle = isMeasureLine ? '#444444' : '#333333';
        ctx.beginPath();
        ctx.moveTo(x, HEADER_HEIGHT);
        ctx.lineTo(x, HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT);
        ctx.stroke();
        ctx.strokeStyle = isMeasureLine ? '#666666' : '#444444';
        ctx.beginPath();
        ctx.moveTo(x, HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT);
        ctx.lineTo(x, h);
        ctx.stroke();
        if (isMeasureLine) {
          ctx.fillStyle = '#999999';
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
        ctx.strokeStyle = isBlack ? '#333333' : '#2a2a2a';
        ctx.beginPath();
        ctx.moveTo(PIANO_KEY_WIDTH, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    },

    _drawNotes(ctx) {
      const midiToNoteName = (midi) => {
        const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(midi / 12) - 1;
        return names[midi % 12] + String(octave);
      };

      for (const note of this.notes) {
        const x = this._timeToX(note.start);
        const y = this._pitchToY(note.pitch);
        const w = note.duration * BEAT_WIDTH * this.zoomX;
        const h = NOTE_HEIGHT * this.zoomY;

        if (x + w < PIANO_KEY_WIDTH || x > this.width || y + h < HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT || y > this.height) continue;

        const isSelected = note.id === this.selectedNoteId;
        const isHover = note.id === this.hoverNoteId;

        ctx.fillStyle = singerColor || '#3498db';
        ctx.globalAlpha = isSelected ? 1.0 : 0.85;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1.0;

        ctx.strokeStyle = isSelected ? '#ffffff' : (isHover ? '#dddddd' : '#000000');
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.strokeRect(x, y, w, h);

        if (w > 20) {
          ctx.fillStyle = '#ffffff';
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const displayText = note.lyric || midiToNoteName(note.pitch);
          ctx.fillText(displayText, x + 4, y + h / 2);
        } else if (w > 8) {
          ctx.fillStyle = '#ffffff';
          ctx.font = '8px sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const displayText = note.lyric || midiToNoteName(note.pitch);
          ctx.fillText(displayText, x + 2, y + h / 2);
        }

        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(x + w - 4, y + 2, 2, h - 4);
      }
    },

    _drawPianoKeys(ctx, h) {
      const midiToNoteName = (midi) => {
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

        ctx.fillStyle = isBlack ? '#111111' : '#eeeeee';
        ctx.fillRect(0, y, PIANO_KEY_WIDTH, keyH);

        ctx.strokeStyle = '#555555';
        ctx.strokeRect(0, y, PIANO_KEY_WIDTH, keyH);

        if (!isBlack) {
          ctx.fillStyle = '#333333';
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(midiToNoteName(p), PIANO_KEY_WIDTH - 4, y + keyH / 2 + 4);
        }
      }

      ctx.strokeStyle = '#555555';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PIANO_KEY_WIDTH, HEADER_HEIGHT);
      ctx.lineTo(PIANO_KEY_WIDTH, h);
      ctx.stroke();
    },

    _drawPlayhead(ctx, h) {
      const currentTime = this.getCurrentTime();
      const beat = this._secondsToBeats(currentTime);
      const x = this._timeToX(beat);
      if (x < PIANO_KEY_WIDTH || x > this.width) return;

      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, HEADER_HEIGHT);
      ctx.lineTo(x, h);
      ctx.stroke();

      ctx.fillStyle = '#ff4444';
      ctx.beginPath();
      ctx.moveTo(x, HEADER_HEIGHT);
      ctx.lineTo(x - 6, HEADER_HEIGHT - 6);
      ctx.lineTo(x + 6, HEADER_HEIGHT - 6);
      ctx.closePath();
      ctx.fill();
    },
  };

  pianoRoll._initEvents();
  pianoRoll._resize();
}

function updateMidiInfo() {
  if (pianoRoll) {
    const noteCount = pianoRoll.notes.length;
    midiInfoEl.textContent = noteCount > 0 ? t('preprocess.noteCount', { count: noteCount }) : t('preprocess.waitingForExtraction');
  }
}

let activeInlineInput = null;
let activeInlineEditNote = null;

function startInlineEdit(roll, note, hit) {
  if (activeInlineInput) {
    if (activeInlineInput.parentElement) activeInlineInput.remove();
    activeInlineInput = null;
    activeInlineEditNote = null;
  }

  activeInlineEditNote = note;

  const container = roll.canvas.parentElement;
  const containerRect = container.getBoundingClientRect();
  const canvasRect = roll.canvas.getBoundingClientRect();

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
  activeInlineInput = input;

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
          const noteIdx = roll.notes.findIndex(n => n.id === note.id);
          if (noteIdx !== -1) {
            note.lyric = tokens[0];
            for (let t = 1; t < tokens.length; t++) {
              const nextIdx = noteIdx + t;
              if (nextIdx < roll.notes.length) {
                roll.notes[nextIdx].lyric = tokens[t];
              }
            }
            updateMidiInfo();
          } else {
            note.lyric = newLyric;
          }
        }
      }
    }
    if (input.parentElement) input.remove();
    activeInlineInput = null;
    activeInlineEditNote = null;
    roll.render();
  };

  input.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  input.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    roll._onWheel(e);
  }, { passive: false });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) {
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

function updateInlineInputPosition(roll) {
  if (!activeInlineInput || !activeInlineEditNote) return;

  const note = activeInlineEditNote;
  const container = roll.canvas.parentElement;
  const containerRect = container.getBoundingClientRect();
  const canvasRect = roll.canvas.getBoundingClientRect();

  const offsetX = canvasRect.left - containerRect.left;
  const offsetY = canvasRect.top - containerRect.top;

  const nx = roll._timeToX(note.start);
  const ny = roll._pitchToY(note.pitch);
  const nw = note.duration * BEAT_WIDTH * roll.zoomX;
  const nh = NOTE_HEIGHT * roll.zoomY;

  const visible = nx + nw >= PIANO_KEY_WIDTH && nx <= roll.width &&
                  ny + nh >= HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT && ny <= roll.height;

  if (visible) {
    activeInlineInput.style.display = '';
    activeInlineInput.style.left = (offsetX + nx + 2) + 'px';
    activeInlineInput.style.top = (offsetY + ny) + 'px';
    activeInlineInput.style.width = Math.max(40, nw - 4) + 'px';
    activeInlineInput.style.height = nh + 'px';
  } else {
    activeInlineInput.style.display = 'none';
  }
}

function showPromptDialog(title, defaultValue, onConfirm) {
  const escapeHtml = (str) => str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `;

  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 8px;
    padding: 20px;
    min-width: 280px;
    color: #fff;
  `;

  dialog.innerHTML = `
    <div style="margin-bottom: 12px; font-weight: 600;">${escapeHtml(title)}</div>
    <input type="text" id="prompt-input" value="${escapeHtml(defaultValue || '')}" style="
      width: 100%;
      padding: 8px;
      background: #1e1e1e;
      border: 1px solid #555;
      border-radius: 4px;
      color: #fff;
      margin-bottom: 12px;
      box-sizing: border-box;
    "/>
    <div style="display: flex; gap: 8px; justify-content: flex-end;">
      <button id="prompt-cancel" style="
        padding: 6px 16px;
        background: #3c3c3c;
        border: 1px solid #555;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
      ">${t('common.cancel')}</button>
      <button id="prompt-ok" style="
        padding: 6px 16px;
        background: #3498db;
        border: none;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
      ">${t('common.confirm')}</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const input = dialog.querySelector('#prompt-input');
  const cancelBtn = dialog.querySelector('#prompt-cancel');
  const okBtn = dialog.querySelector('#prompt-ok');

  const close = (value) => {
    document.body.removeChild(overlay);
    if (value !== null) {
      onConfirm(value);
    }
  };

  cancelBtn.addEventListener('click', () => close(null));
  okBtn.addEventListener('click', () => close(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') close(input.value);
    if (e.key === 'Escape') close(null);
  });

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function showAlertDialog(message, onClose) {
  const escapeHtml = (str) => str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const overlay = document.createElement('div');
  overlay.className = 'alert-dialog-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `;

  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 8px;
    padding: 20px;
    min-width: 280px;
    max-width: 420px;
    color: #fff;
  `;

  dialog.innerHTML = `
    <div style="margin-bottom: 16px; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(message)}</div>
    <div style="display: flex; justify-content: flex-end;">
      <button class="alert-ok-btn" style="
        padding: 6px 20px;
        background: #3498db;
        border: none;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
      ">${t('common.confirm') || 'OK'}</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const okBtn = dialog.querySelector('.alert-ok-btn');

  const close = () => {
    if (overlay.parentElement) overlay.remove();
    if (onClose) onClose();
  };

  okBtn.addEventListener('click', close);
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  requestAnimationFrame(() => {
    okBtn.focus();
  });
}

function showLoading(text = t('preprocess.processing')) {
  const existing = document.querySelector('.loading-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'loading-overlay';
  overlay.innerHTML = `
    <div class="loading-content">
      <div class="loading-spinner"></div>
      <div class="loading-text">${text}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function hideLoading(overlay) {
  if (overlay && overlay.parentNode) {
    overlay.remove();
  }
}

async function extractF0AndPitch() {
  if (!wavAudioBuffer) {
    showAlertDialog(t('preprocess.pleaseLoadAudio'));
    return;
  }

  const loading = showLoading(t('preprocess.extractingF0Rmvpe'));

  try {
    const channelData = wavAudioBuffer.getChannelData(0);
    const audioData = Array.from(channelData);

    const result = await window.electronAPI.extractF0({
      audioData: audioData,
      sampleRate: wavAudioBuffer.sampleRate,
      bpm: BPM,
    });

    if (!result.success) {
      throw new Error(result.error || 'RMVPE推理失败');
    }

    f0Data = result.f0Array;

    if (pianoRoll) {
      pianoRoll.f0Data = f0Data;
      pianoRoll.render();
      updateMidiInfo();
    }

    // RMVPE只提取F0，不生成MIDI音符
    const currentNotes = pianoRoll ? pianoRoll.notes : [];
    const fields = buildSingerFields(currentNotes);
    singerData = {
      index: `vocal_${Math.floor(wavDuration * 1000)}`,
      language: 'Mandarin',
      time: [0, Math.floor(wavDuration * 1000)],
      duration: currentNotes.map((n) => (n.duration * (60 / BPM)).toFixed(2)).join(' '),
      text: fields.text,
      phoneme: fields.phoneme,
      note_pitch: currentNotes.map((n) => n.pitch).join(' '),
      note_type: fields.note_type,
      f0: f0Data.map((f) => f.f0.toFixed(1)).join(' '),
    };

    updateMidiInfo();
    showAlertDialog(t('preprocess.f0ExtractionComplete'));
  } catch (err) {
    console.error('提取失败:', err);
    showAlertDialog(t('preprocess.extractionFailed') + ': ' + err.message);
  } finally {
    hideLoading(loading);
  }
}

async function extractF0BasicPitch() {
  if (!wavAudioBuffer) {
    showAlertDialog(t('preprocess.pleaseLoadAudio'));
    return;
  }

  const loading = showLoading(t('preprocess.extractingMidiBasicPitch'));

  try {
    const channelData = wavAudioBuffer.getChannelData(0);
    const audioData = Array.from(channelData);

    const result = await window.electronAPI.extractF0BasicPitch({
      audioData: audioData,
      sampleRate: wavAudioBuffer.sampleRate,
      bpm: BPM,
    });

    if (!result.success) {
      throw new Error(result.error || 'Basic Pitch推理失败');
    }

    const notes = (result.notes || []).map((n, i) => ({
      id: n.id ?? (Date.now() + i),
      pitch: n.pitch ?? 60,
      start: n.start ?? 0,
      duration: n.duration ?? 0.25,
      lyric: n.lyric || n.text || 'la',
    }));

    if (result.f0Array && result.f0Array.length > 0) {
      f0Data = result.f0Array;
    }

    if (pianoRoll) {
      pianoRoll.notes = notes;
      if (f0Data) {
        pianoRoll.f0Data = f0Data;
      }
      pianoRoll.render();
      updateMidiInfo();
    }

    const currentF0 = f0Data || [];
    const fields = buildSingerFields(notes);
    singerData = {
      index: `vocal_${Math.floor(wavDuration * 1000)}`,
      language: 'Mandarin',
      time: [0, Math.floor(wavDuration * 1000)],
      duration: notes.map((n) => (n.duration * (60 / BPM)).toFixed(2)).join(' '),
      text: fields.text,
      phoneme: fields.phoneme,
      note_pitch: notes.map((n) => n.pitch).join(' '),
      note_type: fields.note_type,
      f0: currentF0.map((f) => f.f0.toFixed(1)).join(' '),
    };

    updateMidiInfo();
    showAlertDialog(t('preprocess.midiExtractionComplete'));
  } catch (err) {
    console.error('提取失败:', err);
    showAlertDialog(t('preprocess.extractionFailed') + ': ' + err.message);
  } finally {
    hideLoading(loading);
  }
}

async function simulateF0AndPitchExtraction() {
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const sampleCount = Math.floor(wavDuration * 100);
  const f0Array = [];
  for (let i = 0; i < sampleCount; i++) {
    const time = i / 100;
    if (time >= wavDuration) break;
    const baseFreq = 220 + Math.sin(time * 2) * 100;
    f0Array.push({ time: time, f0: time < 0.5 || time > wavDuration - 0.5 ? 0 : baseFreq });
  }
  f0Data = f0Array;

  const notes = [];
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const f0ToMidi = (f0) => {
    if (f0 <= 0) return 0;
    return Math.round(69 + 12 * Math.log2(f0 / 440));
  };

  let currentTime = 0;
  const noteDuration = 0.5;
  while (currentTime < wavDuration - noteDuration) {
    const segment = f0Array.filter((f) => f.time >= currentTime && f.time < currentTime + noteDuration);
    const activeF0 = segment.filter((f) => f.f0 > 0);

    if (activeF0.length > segment.length * 0.5) {
      const avgF0 = activeF0.reduce((sum, f) => sum + f.f0, 0) / activeF0.length;
      const midiPitch = f0ToMidi(avgF0);
      if (midiPitch >= 24 && midiPitch <= 108) {
        notes.push({
          id: Date.now() + Math.random(),
          pitch: midiPitch,
          start: currentTime / (60 / BPM),
          duration: noteDuration / (60 / BPM),
        });
      }
    }
    currentTime += noteDuration;
  }

  if (pianoRoll) {
    pianoRoll.notes = notes;
    pianoRoll.render();
    updateMidiInfo();
  }

  const fields = buildSingerFields(notes);
  singerData = {
    index: `vocal_${Math.floor(currentTime * 1000)}`,
    language: 'Mandarin',
    time: [0, Math.floor(wavDuration * 1000)],
    duration: notes.map((n) => (n.duration * (60 / BPM)).toFixed(2)).join(' '),
    text: fields.text,
    phoneme: fields.phoneme,
    note_pitch: notes.map((n) => n.pitch).join(' '),
    note_type: fields.note_type,
    f0: f0Array.map((f) => f.f0.toFixed(1)).join(' '),
  };
}

async function saveSingerData() {
  if (!wavAudioBuffer) {
    showAlertDialog(t('preprocess.noAudioToSave'));
    return;
  }

  const currentNotes = pianoRoll ? pianoRoll.notes : [];
  const hasNotes = currentNotes.length > 0;
  const hasF0 = f0Data && f0Data.length > 0;

  if (!hasNotes && !hasF0) {
    showAlertDialog(t('preprocess.noDataToSave'));
    return;
  }

  // 始终根据当前pianoRoll音符和F0数据重新构建singerData，确保编辑后的变更被保存
  const fields = buildSingerFields(currentNotes);
  singerData = {
    index: `vocal_${Math.floor(wavDuration * 1000)}`,
    language: 'Mandarin',
    time: [0, Math.floor(wavDuration * 1000)],
    duration: currentNotes.map((n) => (n.duration * (60 / BPM)).toFixed(2)).join(' '),
    text: fields.text,
    phoneme: fields.phoneme,
    note_pitch: currentNotes.map((n) => n.pitch).join(' '),
    note_type: fields.note_type,
    f0: hasF0 ? f0Data.map((f) => f.f0.toFixed(1)).join(' ') : '',
  };

  const loading = showLoading(t('preprocess.savingPreprocessData'));

  try {
    const preprocessResult = {
      singerData: singerData,
      f0Data: f0Data,
      midiNotes: pianoRoll ? pianoRoll.notes : [],
    };

    await window.electronAPI.sendPreprocessData(preprocessResult);

    showAlertDialog(t('preprocess.preprocessSaveSuccess'), () => {
      stopPlayback();
      window.close();
    });
  } catch (err) {
    console.error('保存失败:', err);
    showAlertDialog(t('preprocess.saveFailed') + ': ' + err.message);
  } finally {
    hideLoading(loading);
  }
}

function trimLeadingSilence(audioBuffer, threshold = 0.01) {
  const data = audioBuffer.getChannelData(0);
  let silenceEndIndex = 0;
  
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > threshold) {
      silenceEndIndex = i;
      break;
    }
  }
  
  if (silenceEndIndex === 0) {
    return audioBuffer;
  }
  
  const targetLength = audioBuffer.length - silenceEndIndex;
  const offlineCtx = new OfflineAudioContext(1, targetLength, audioBuffer.sampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0, silenceEndIndex / audioBuffer.sampleRate);
  return offlineCtx.startRendering();
}

async function processWavBuffer(buffer) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });

  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(buffer.slice(0));
  } finally {
    audioCtx.close();
  }
  const originalSampleRate = audioBuffer.sampleRate;
  const originalChannels = audioBuffer.numberOfChannels;
  const originalDuration = audioBuffer.duration;

  let monoBuffer = audioBuffer;
  if (originalChannels > 1) {
    const offlineCtx = new OfflineAudioContext(1, audioBuffer.length, originalSampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;

    const splitter = offlineCtx.createChannelSplitter(originalChannels);
    const merger = offlineCtx.createChannelMerger(1);
    
    source.connect(splitter);
    for (let ch = 0; ch < originalChannels; ch++) {
      splitter.connect(merger, ch, 0);
    }
    merger.connect(offlineCtx.destination);
    source.start();

    monoBuffer = await offlineCtx.startRendering();
  }

  if (originalDuration > 30) {
    const targetLength = Math.floor(30 * 44100);
    if (monoBuffer.length > targetLength) {
      const offlineCtx = new OfflineAudioContext(1, targetLength, 44100);
      const source = offlineCtx.createBufferSource();
      source.buffer = monoBuffer;
      source.connect(offlineCtx.destination);
      source.start();
      monoBuffer = await offlineCtx.startRendering();
    }
  }

  if (monoBuffer.sampleRate !== 44100) {
    const targetLength = Math.floor(monoBuffer.duration * 44100);
    const offlineCtx = new OfflineAudioContext(1, targetLength, 44100);
    const source = offlineCtx.createBufferSource();
    source.buffer = monoBuffer;
    source.connect(offlineCtx.destination);
    source.start();
    monoBuffer = await offlineCtx.startRendering();
  }

  monoBuffer = await trimLeadingSilence(monoBuffer);

  return monoBuffer;
}

const resizeHandle = document.getElementById('resize-handle');
const waveformSection = document.getElementById('waveform-section');
const mainContent = document.getElementById('main-content');

let isResizing = false;

resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const mainRect = mainContent.getBoundingClientRect();
  const relY = e.clientY - mainRect.top;
  const pct = (relY / mainRect.height) * 100;
  const clamped = Math.max(10, Math.min(60, pct));
  waveformSection.style.flex = `0 0 ${clamped}%`;
  drawWaveformWithPlayhead(pianoRoll ? pianoRoll.getCurrentTime() : 0);
  if (pianoRoll) pianoRoll._resize();
});

document.addEventListener('mouseup', () => {
  isResizing = false;
});

window.addEventListener('DOMContentLoaded', async () => {
  try {
    const ipc = window.electronAPI;

    function initializeWithData(data) {
      if (!data || !data.wavBuffer) {
        showAlertDialog(t('preprocess.noAudioReceived'));
        return;
      }

      wavFileBuffer = data.wavBuffer;
      wavFileName = data.data?.wavFileName || 'audio.wav';
      singerName = data.data?.singerName || '未命名歌手';
      singerColor = data.data?.singerColor || '#3498db';
      avatarImageData = data.data?.avatarImageData;
      avatarImageName = data.data?.avatarImageName;

      wavFileNameEl.textContent = wavFileName;
      midiInfoEl.textContent = t('preprocess.waitingForExtraction');

      processWavBuffer(wavFileBuffer).then((buffer) => {
        wavAudioBuffer = buffer;
        wavDuration = wavAudioBuffer.duration;

        drawWaveformWithPlayhead(0);

        initPianoRoll().then(() => {
          console.log(t('preprocess.consoleStarted'));
        });
      }).catch((err) => {
        console.error(t('preprocess.initFailed'), err);
        showAlertDialog(t('preprocess.initFailed') + ': ' + err.message);
      });
    }

    ipc.onLoadPreprocessData((data) => {
      initializeWithData(data);
    });

    const initialData = window._pendingPreprocessData;
    if (initialData) {
      initializeWithData(initialData);
    }
  } catch (err) {
    console.error(t('preprocess.initFailed'), err);
    showAlertDialog(t('preprocess.initFailed') + ': ' + err.message);
  }
});

initI18n();
applyLocale();
document.documentElement.lang = getLocale();
