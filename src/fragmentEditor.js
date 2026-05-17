import './fragmentEditor.css';
import { PARAM_MODES } from './editor/pianoRoll.js';
import { encodeWav, applyEnvelopesToAudio } from './audio/wavEncoder.js';
import { HistoryManager } from './editor/historyManager.js';

const canvas = document.getElementById('piano-roll');
const ctx = canvas.getContext('2d');
const pianoKeysCanvas = document.getElementById('piano-keys');
const pianoKeysCtx = pianoKeysCanvas.getContext('2d');

const PIANO_KEY_WIDTH = 80;
const NOTE_HEIGHT = 16;
const BEAT_WIDTH = 80;
const HEADER_HEIGHT = 24;
const PARAM_CURVE_HEIGHT = 80;
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const PITCH_CURVE_SAMPLE_INTERVAL = 0.02;

let SAMPLE_RATE = 24000;
let pipelineInitialized = false;
let pipelineInitPromise = null;

function initPipeline() {
  if (pipelineInitialized) return Promise.resolve();
  if (pipelineInitPromise) return pipelineInitPromise;

  const overlay = document.getElementById('model-loading-overlay');
  if (overlay) overlay.classList.add('visible');

  pipelineInitPromise = (async () => {
    try {
      SAMPLE_RATE = await window.electronAPI.getFragmentSVSSampleRate();
      await window.electronAPI.initFragmentSVSPipeline();
      pipelineInitialized = true;
      console.log('[FragmentEditor] SVS Pipeline 已初始化 (DirectML)');
    } catch (err) {
      console.error('[FragmentEditor] SVS Pipeline 初始化失败:', err);
      pipelineInitPromise = null;
      throw err;
    } finally {
      if (overlay) overlay.classList.remove('visible');
    }
  })();

  return pipelineInitPromise;
}

initPipeline();

let fragmentAudioContext = null;
let fragmentAudioSource = null;
let fragmentAudioData = null;
let fragmentIsPlaying = false;
let fragmentIsSynthesizing = false;
let fragmentPlaybackStartTime = 0;
let fragmentPlaybackOffset = 0;
let fragmentPlayheadRaf = null;
let fragmentCurrentTime = 0;
let fragmentGainNode = null;
let fragmentUseExclusiveMode = false;
let fragmentExclusiveRaf = null;
let fragmentAudioSettings = null;

let wavFileBuffer = null;

function midiToNoteName(midi) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  return `${names[midi % 12]}${octave}`;
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

let currentFragment = null;
let currentProject = null;
let currentParamMode = PARAM_MODES.MIDI;
let notes = [];
let envelopes = {
  volume: { keyframes: [{ time: 0, value: 1, smoothness: 0 }] },
  pan: { keyframes: [{ time: 0, value: 0, smoothness: 0 }] },
};
let pitchCurve = {
  enabled: true,
  anchorPoints: [],
  brushSegments: [],
};

let autoSaveTimer = null;

function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    saveFragmentData();
  }, 500);
}

function saveFragmentData() {
  if (currentFragment) {
    currentFragment.notes = notes;
    currentFragment.envelopes = envelopes;
    currentFragment.pitchCurve = pitchCurve;
    if (window.electronAPI?.saveFragmentData) {
      window.electronAPI.saveFragmentData(currentFragment.id, { notes, envelopes, pitchCurve });
    }
  }
}

let selectedNoteId = null;
let dragMode = null;
let dragStartX = 0;
let dragStartY = 0;
let dragNoteStart = { start: 0, pitch: 0, duration: 0 };
let scrollY = 0;
let scrollX = 0;
let nextNoteId = 1;
let zoomX = 1;

let pitchDragAnchorIdx = -1;
let pitchDragStartValue = 0;
let pitchDragStartTime = 0;
let isBrushDrawing = false;
let currentBrushStroke = null;

const history = new HistoryManager();
let dragOperation = null;
let pitchCurveSnapshotBeforeDrag = null;
let envelopeSnapshotBeforeDrag = null;
let lyricEditOldValue = null;
let lyricEditNoteId = null;

function dpr() {
  return window.devicePixelRatio || 1;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function clonePitchCurveState() {
  return {
    enabled: pitchCurve.enabled,
    anchorPoints: deepClone(pitchCurve.anchorPoints),
    brushSegments: deepClone(pitchCurve.brushSegments),
  };
}

function applyPitchCurveSnapshot(snapshot) {
  pitchCurve.enabled = snapshot.enabled;
  pitchCurve.anchorPoints = deepClone(snapshot.anchorPoints);
  pitchCurve.brushSegments = deepClone(snapshot.brushSegments);
}

function cloneEnvelopeState(envKey) {
  return deepClone(envelopes[envKey].keyframes);
}

function applyEnvelopeSnapshot(envKey, snapshot) {
  envelopes[envKey].keyframes = deepClone(snapshot);
}

function finalizeDragOperation() {
  if (!dragOperation) return;

  switch (dragOperation.type) {
    case 'noteAdd': {
      const note = notes.find(n => n.id === dragOperation.noteId);
      if (note) {
        const noteClone = { ...note };
        history.push({
          undo() {
            const idx = notes.findIndex(n => n.id === noteClone.id);
            if (idx !== -1) notes.splice(idx, 1);
            if (selectedNoteId === noteClone.id) selectedNoteId = null;
          },
          redo() {
            notes.push({ ...noteClone });
            selectedNoteId = noteClone.id;
          }
        });
      }
      break;
    }
    case 'noteMove': {
      const note = notes.find(n => n.id === dragOperation.noteId);
      if (note && (note.start !== dragOperation.oldStart || note.pitch !== dragOperation.oldPitch)) {
        const newStart = note.start;
        const newPitch = note.pitch;
        const noteId = dragOperation.noteId;
        const oldStart = dragOperation.oldStart;
        const oldPitch = dragOperation.oldPitch;
        history.push({
          undo() {
            const n = notes.find(nn => nn.id === noteId);
            if (n) { n.start = oldStart; n.pitch = oldPitch; }
          },
          redo() {
            const n = notes.find(nn => nn.id === noteId);
            if (n) { n.start = newStart; n.pitch = newPitch; }
          }
        });
      }
      break;
    }
    case 'noteResize': {
      const note = notes.find(n => n.id === dragOperation.noteId);
      if (note && note.duration !== dragOperation.oldDuration) {
        const newDuration = note.duration;
        const noteId = dragOperation.noteId;
        const oldDuration = dragOperation.oldDuration;
        history.push({
          undo() {
            const n = notes.find(nn => nn.id === noteId);
            if (n) { n.duration = oldDuration; }
          },
          redo() {
            const n = notes.find(nn => nn.id === noteId);
            if (n) { n.duration = newDuration; }
          }
        });
      }
      break;
    }
    case 'pitchAnchorMove':
    case 'pitchAnchorAdd': {
      if (pitchCurveSnapshotBeforeDrag) {
        const oldSnapshot = pitchCurveSnapshotBeforeDrag;
        const newSnapshot = clonePitchCurveState();
        history.push({
          undo() { applyPitchCurveSnapshot(oldSnapshot); },
          redo() { applyPitchCurveSnapshot(newSnapshot); }
        });
      }
      break;
    }
    case 'pitchBrush': {
      if (pitchCurveSnapshotBeforeDrag) {
        const oldSnapshot = pitchCurveSnapshotBeforeDrag;
        const newSnapshot = clonePitchCurveState();
        history.push({
          undo() { applyPitchCurveSnapshot(oldSnapshot); },
          redo() { applyPitchCurveSnapshot(newSnapshot); }
        });
      }
      break;
    }
    case 'envelopeKeyframeMove':
    case 'envelopeKeyframeAdd': {
      if (envelopeSnapshotBeforeDrag) {
        const envKey = dragOperation.envKey;
        const oldSnapshot = envelopeSnapshotBeforeDrag;
        const newSnapshot = cloneEnvelopeState(envKey);
        history.push({
          undo() { applyEnvelopeSnapshot(envKey, oldSnapshot); },
          redo() { applyEnvelopeSnapshot(envKey, newSnapshot); }
        });
      }
      break;
    }
  }

  dragOperation = null;
  pitchCurveSnapshotBeforeDrag = null;
  envelopeSnapshotBeforeDrag = null;
}

function resizeCanvases() {
  const containerRect = document.getElementById('piano-roll-container').getBoundingClientRect();
  const keysContainerRect = document.getElementById('piano-keys-container').getBoundingClientRect();
  const h = keysContainerRect.height;
  const w = containerRect.width;

  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.floor(w * dpr());
  canvas.height = Math.floor(h * dpr());

  pianoKeysCanvas.style.width = `${PIANO_KEY_WIDTH}px`;
  pianoKeysCanvas.style.height = `${h}px`;
  pianoKeysCanvas.width = Math.floor(PIANO_KEY_WIDTH * dpr());
  pianoKeysCanvas.height = Math.floor(h * dpr());

  pianoKeysCtx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);

  render();
}

function getVisibleDuration() {
  const w = canvas.clientWidth;
  const visibleBeats = w / (BEAT_WIDTH * zoomX);
  const bpm = currentProject ? currentProject.bpm : 120;
  const beatsPerSecond = bpm / 60;
  return visibleBeats / beatsPerSecond;
}

window.addEventListener('resize', resizeCanvases);

function timeToX(beats) {
  return beats * BEAT_WIDTH * zoomX - scrollX;
}

function xToTime(x) {
  return (x + scrollX) / (BEAT_WIDTH * zoomX);
}

function pitchToY(pitch) {
  const pianoAreaTop = HEADER_HEIGHT;
  const showParamArea = currentParamMode === PARAM_MODES.VOL || currentParamMode === PARAM_MODES.PAN;
  const pianoAreaBottom = canvas.parentElement.clientHeight - (showParamArea ? PARAM_CURVE_HEIGHT : 0);
  const maxPitch = 127;
  return pianoAreaTop + (maxPitch - pitch) * NOTE_HEIGHT - scrollY;
}

function yToPitch(y) {
  const pianoAreaTop = HEADER_HEIGHT;
  const showParamArea = currentParamMode === PARAM_MODES.VOL || currentParamMode === PARAM_MODES.PAN;
  const pianoAreaBottom = canvas.parentElement.clientHeight - (showParamArea ? PARAM_CURVE_HEIGHT : 0);
  if (y >= pianoAreaBottom) return 0;
  if (y <= pianoAreaTop) return 127;
  const maxPitch = 127;
  return Math.round(maxPitch - (y + scrollY - pianoAreaTop) / NOTE_HEIGHT);
}

function snapBeats(beats) {
  const grid = 1 / 4;
  return Math.round(beats / grid) * grid;
}

function findNoteAt(x, y) {
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i];
    const nx = timeToX(note.start);
    const ny = pitchToY(note.pitch);
    const nw = note.duration * BEAT_WIDTH * zoomX;
    const nh = NOTE_HEIGHT;
    if (x >= nx && x <= nx + nw && y >= ny && y <= ny + nh) {
      return { note, nx, ny, nw, nh };
    }
  }
  return null;
}

function _getParamCurveAreaTop() {
  return canvas.parentElement.clientHeight - PARAM_CURVE_HEIGHT;
}

function _getParamCurveAreaBottom() {
  return canvas.parentElement.clientHeight;
}

function _getParamCurveYRange() {
  switch (currentParamMode) {
    case PARAM_MODES.VOL: return { min: 0, max: 1 };
    case PARAM_MODES.PAN: return { min: -1, max: 1 };
    default: return { min: 0, max: 1 };
  }
}

function _valueToParamY(value) {
  const areaTop = _getParamCurveAreaTop();
  const areaBottom = _getParamCurveAreaBottom();
  const areaHeight = areaBottom - areaTop;
  const { min, max } = _getParamCurveYRange();
  const normalized = (value - min) / (max - min);
  return areaTop + (1 - normalized) * areaHeight;
}

function _interpolateEnvelope(envelope, time) {
  const kfs = envelope.keyframes;
  if (kfs.length === 0) return 0.5;
  if (kfs.length === 1) return kfs[0].value;
  if (time <= kfs[0].time) return kfs[0].value;
  if (time >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;
  for (let i = 0; i < kfs.length - 1; i++) {
    if (time >= kfs[i].time && time <= kfs[i + 1].time) {
      const t = (time - kfs[i].time) / (kfs[i + 1].time - kfs[i].time);
      const smoothness = kfs[i].smoothness / 100;
      const smoothT = smoothness > 0 ? t * t * (3 - 2 * t) : t;
      return kfs[i].value + (kfs[i + 1].value - kfs[i].value) * smoothT;
    }
  }
  return 0.5;
}

function genNoteId() {
  return nextNoteId++;
}

function generateAutoPitchPoints() {
  if (notes.length === 0) return [];
  const sortedNotes = [...notes].sort((a, b) => a.start - b.start);
  const points = [];
  for (const note of sortedNotes) {
    points.push({ time: note.start, pitch: note.pitch });
    points.push({ time: note.start + note.duration, pitch: note.pitch });
  }
  return points;
}

function isPitchCurveCustomized() {
  return pitchCurve.anchorPoints.length > 0 || pitchCurve.brushSegments.length > 0;
}

function getPitchAtTime(time) {
  if (!pitchCurve.enabled) return null;

  for (const seg of pitchCurve.brushSegments) {
    if (seg.points.length < 2) continue;
    if (time >= seg.points[0].time && time <= seg.points[seg.points.length - 1].time) {
      for (let i = 0; i < seg.points.length - 1; i++) {
        if (time >= seg.points[i].time && time <= seg.points[i + 1].time) {
          const t = (seg.points[i + 1].time - seg.points[i].time) > 0
            ? (time - seg.points[i].time) / (seg.points[i + 1].time - seg.points[i].time)
            : 0;
          return seg.points[i].pitch + t * (seg.points[i + 1].pitch - seg.points[i].pitch);
        }
      }
    }
  }

  if (pitchCurve.anchorPoints.length > 0) {
    const sorted = [...pitchCurve.anchorPoints].sort((a, b) => a.time - b.time);
    if (time <= sorted[0].time) return sorted[0].pitch;
    if (time >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].pitch;
    for (let i = 0; i < sorted.length - 1; i++) {
      if (time >= sorted[i].time && time <= sorted[i + 1].time) {
        const t = (sorted[i + 1].time - sorted[i].time) > 0
          ? (time - sorted[i].time) / (sorted[i + 1].time - sorted[i].time)
          : 0;
        const smoothness = (sorted[i].smoothness || 0) / 100;
        const smoothT = smoothness > 0 ? t * t * (3 - 2 * t) : t;
        return sorted[i].pitch + smoothT * (sorted[i + 1].pitch - sorted[i].pitch);
      }
    }
    return sorted[sorted.length - 1].pitch;
  }

  const autoPoints = generateAutoPitchPoints();
  if (autoPoints.length === 0) return null;
  if (time <= autoPoints[0].time) return autoPoints[0].pitch;
  if (time >= autoPoints[autoPoints.length - 1].time) return autoPoints[autoPoints.length - 1].pitch;
  for (let i = 0; i < autoPoints.length - 1; i++) {
    if (time >= autoPoints[i].time && time <= autoPoints[i + 1].time) {
      const t = (autoPoints[i + 1].time - autoPoints[i].time) > 0
        ? (time - autoPoints[i].time) / (autoPoints[i + 1].time - autoPoints[i].time)
        : 0;
      return autoPoints[i].pitch + t * (autoPoints[i + 1].pitch - autoPoints[i].pitch);
    }
  }
  return autoPoints[autoPoints.length - 1].pitch;
}

function findAnchorPointAt(x, y) {
  if (pitchCurve.anchorPoints.length === 0) return -1;
  for (let i = 0; i < pitchCurve.anchorPoints.length; i++) {
    const ap = pitchCurve.anchorPoints[i];
    const px = timeToX(ap.time);
    const py = pitchToY(ap.pitch);
    const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
    if (dist <= 8) return i;
  }
  return -1;
}

function findNoteAtTime(time) {
  for (const note of notes) {
    if (time >= note.start && time <= note.start + note.duration) {
      return note;
    }
  }
  return null;
}

function renderPianoKeys() {
  const h = pianoKeysCanvas.parentElement.clientHeight;
  const w = PIANO_KEY_WIDTH;
  pianoKeysCtx.clearRect(0, 0, w, h);
  pianoKeysCtx.fillStyle = '#2a2a2a';
  pianoKeysCtx.fillRect(0, 0, w, h);

  const startPitch = yToPitch(h);
  const endPitch = yToPitch(HEADER_HEIGHT);

  for (let p = Math.max(0, startPitch); p <= Math.min(127, endPitch); p++) {
    const y = pitchToY(p);
    const keyH = NOTE_HEIGHT;
    const isBlack = BLACK_KEYS.has(p % 12);

    pianoKeysCtx.fillStyle = isBlack ? '#1a1a1a' : '#e8e8e8';
    pianoKeysCtx.fillRect(0, y, w, keyH);

    pianoKeysCtx.strokeStyle = '#555555';
    pianoKeysCtx.lineWidth = 0.5;
    pianoKeysCtx.strokeRect(0, y, w, keyH);

    if (!isBlack && keyH >= 10) {
      pianoKeysCtx.fillStyle = '#333333';
      pianoKeysCtx.font = '10px sans-serif';
      pianoKeysCtx.textAlign = 'right';
      pianoKeysCtx.textBaseline = 'middle';
      pianoKeysCtx.fillText(midiToNoteName(p), w - 4, y + keyH / 2);
    }
  }
}

function renderPitchCurve() {
  if (!pitchCurve.enabled) return;

  const w = canvas.parentElement.clientWidth;
  const h = canvas.parentElement.clientHeight;
  const startBeat = xToTime(0);
  const endBeat = xToTime(w);

  const hasCustom = isPitchCurveCustomized();

  if (!hasCustom) {
    const autoPoints = generateAutoPitchPoints();
    if (autoPoints.length === 0) return;

    ctx.strokeStyle = 'rgba(46, 204, 113, 0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    let first = true;
    for (const pt of autoPoints) {
      if (pt.time < startBeat - 1 || pt.time > endBeat + 1) continue;
      const px = timeToX(pt.time);
      const py = pitchToY(pt.pitch);
      if (first) { ctx.moveTo(px, py); first = false; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    for (const note of notes) {
      const startX = timeToX(note.start);
      const endX = timeToX(note.start + note.duration);
      const y = pitchToY(note.pitch);
      if (endX < 0 || startX > w) continue;

      ctx.fillStyle = 'rgba(46, 204, 113, 0.4)';
      ctx.beginPath();
      ctx.arc(startX, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(endX, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    return;
  }

  const autoPoints = generateAutoPitchPoints();
  if (autoPoints.length > 0) {
    ctx.strokeStyle = 'rgba(46, 204, 113, 0.25)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    let first = true;
    for (const pt of autoPoints) {
      if (pt.time < startBeat - 1 || pt.time > endBeat + 1) continue;
      const px = timeToX(pt.time);
      const py = pitchToY(pt.pitch);
      if (first) { ctx.moveTo(px, py); first = false; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (pitchCurve.anchorPoints.length > 0) {
    const sorted = [...pitchCurve.anchorPoints].sort((a, b) => a.time - b.time);
    const maxTime = Math.max(endBeat, sorted[sorted.length - 1].time) + 2;
    const steps = Math.max(100, Math.floor((maxTime - startBeat) / PITCH_CURVE_SAMPLE_INTERVAL));

    ctx.strokeStyle = '#2ecc71';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let first = true;
    for (let i = 0; i <= steps; i++) {
      const t = startBeat + (i / steps) * (maxTime - startBeat);
      let inBrush = false;
      for (const seg of pitchCurve.brushSegments) {
        if (seg.points.length >= 2 && t >= seg.points[0].time && t <= seg.points[seg.points.length - 1].time) {
          inBrush = true;
          break;
        }
      }
      if (inBrush) continue;

      const pitch = getPitchAtTime(t);
      if (pitch === null) continue;
      const px = timeToX(t);
      const py = pitchToY(pitch);
      if (first) { ctx.moveTo(px, py); first = false; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    for (let i = 0; i < pitchCurve.anchorPoints.length; i++) {
      const ap = pitchCurve.anchorPoints[i];
      const px = timeToX(ap.time);
      const py = pitchToY(ap.pitch);
      const isSelected = i === pitchDragAnchorIdx;

      ctx.fillStyle = isSelected ? '#ffffff' : '#2ecc71';
      ctx.beginPath();
      ctx.arc(px, py, isSelected ? 7 : 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = isSelected ? '#3498db' : 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.stroke();

      if (isSelected) {
        ctx.strokeStyle = 'rgba(52, 152, 219, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, 12, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  for (const seg of pitchCurve.brushSegments) {
    if (seg.points.length < 2) continue;
    ctx.strokeStyle = '#e67e22';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    let first = true;
    for (const pt of seg.points) {
      const px = timeToX(pt.time);
      const py = pitchToY(pt.pitch);
      if (first) { ctx.moveTo(px, py); first = false; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  if (currentBrushStroke && currentBrushStroke.points.length >= 2) {
    ctx.strokeStyle = '#f39c12';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    let first = true;
    for (const pt of currentBrushStroke.points) {
      const px = timeToX(pt.time);
      const py = pitchToY(pt.pitch);
      if (first) { ctx.moveTo(px, py); first = false; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

function render() {
  const w = canvas.parentElement.clientWidth;
  const h = canvas.parentElement.clientHeight;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, w, h);

  const beatsPerMeasure = currentProject ? currentProject.timeSignature[0] : 4;
  const startBeat = xToTime(0);
  const endBeat = xToTime(w);

  const showParamArea = currentParamMode === PARAM_MODES.VOL || currentParamMode === PARAM_MODES.PAN;
  const pianoAreaBottom = showParamArea ? _getParamCurveAreaTop() : h;

  ctx.lineWidth = 0.5;
  for (let b = Math.floor(startBeat); b <= Math.ceil(endBeat); b++) {
    const x = timeToX(b);
    if (x < 0) continue;
    const isMeasure = (b % beatsPerMeasure === 0);
    ctx.strokeStyle = isMeasure ? '#555555' : '#333333';
    ctx.beginPath();
    ctx.moveTo(x, HEADER_HEIGHT);
    ctx.lineTo(x, pianoAreaBottom);
    ctx.stroke();
    if (isMeasure) {
      ctx.fillStyle = '#888888';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(Math.floor(b / beatsPerMeasure) + 1), x, HEADER_HEIGHT - 6);
    }
  }

  const startPitch = yToPitch(h);
  const endPitch = yToPitch(HEADER_HEIGHT);
  for (let p = Math.max(0, startPitch); p <= Math.min(127, endPitch); p++) {
    const y = pitchToY(p);
    const isBlack = BLACK_KEYS.has(p % 12);
    ctx.strokeStyle = isBlack ? '#2a2a2a' : '#252525';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  for (const note of notes) {
    const x = timeToX(note.start);
    const y = pitchToY(note.pitch);
    const nw = note.duration * BEAT_WIDTH * zoomX;
    const nh = NOTE_HEIGHT;
    if (x + nw < 0 || x > w) continue;

    const isSelected = note.id === selectedNoteId;
    const isPitchMode = currentParamMode === 'Pitch';
    ctx.fillStyle = '#3498db';
    ctx.globalAlpha = isSelected ? 1.0 : (isPitchMode ? 0.4 : 0.8);
    ctx.fillRect(x, y, nw, nh);
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = isSelected ? '#ffffff' : '#000000';
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.strokeRect(x, y, nw, nh);

    if (nw > 16) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(note.lyric || '', x + 3, y + nh / 2);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillRect(x + nw - 3, y + 2, 2, nh - 4);
  }

  if (currentParamMode === 'Pitch') {
    renderPitchCurve();
  }

  if (showParamArea) {
    const areaTop = _getParamCurveAreaTop();
    const areaBottom = _getParamCurveAreaBottom();
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, areaTop, w, PARAM_CURVE_HEIGHT);

    ctx.strokeStyle = '#444444';
    ctx.beginPath();
    ctx.moveTo(0, areaTop);
    ctx.lineTo(w, areaTop);
    ctx.stroke();

    const { min, max } = _getParamCurveYRange();
    ctx.fillStyle = '#666666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(max.toFixed(0), 4, areaTop + 12);
    ctx.fillText(min.toFixed(0), 4, areaBottom - 4);
    ctx.textAlign = 'right';
    ctx.fillText(currentParamMode, w - 4, areaTop + 12);

    const envKey = currentParamMode === PARAM_MODES.VOL ? 'volume' : 'pan';
    const envelope = envelopes[envKey];
    if (envelope && envelope.keyframes && envelope.keyframes.length > 0) {
      const maxTime = Math.max(8, ...envelope.keyframes.map(k => k.time)) * 1.2;
      const steps = 50;

      const lineColors = { VOL: '#3498db', PAN: '#e74c3c' };
      ctx.strokeStyle = lineColors[currentParamMode] || '#3498db';
      ctx.lineWidth = 2;
      ctx.beginPath();

      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * maxTime;
        const value = _interpolateEnvelope(envelope, t);
        const px = (t / maxTime) * w;
        const py = _valueToParamY(value);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      for (const kf of envelope.keyframes) {
        const px = (kf.time / maxTime) * w;
        const py = _valueToParamY(kf.value);
        ctx.fillStyle = lineColors[currentParamMode] || '#3498db';
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  renderPianoKeys();
  drawPlayhead(ctx, w, h);
  updateInlineInputPosition();
}

function drawPlayhead(ctxToUse, w, h) {
  if (!fragmentIsPlaying && fragmentCurrentTime <= 0) return;

  const bpm = currentProject ? currentProject.bpm : 120;
  const beat = (fragmentCurrentTime / 60) * bpm;
  const x = timeToX(beat);

  if (x < 0 || x > w) return;

  ctxToUse.strokeStyle = '#ff4444';
  ctxToUse.lineWidth = 2;
  ctxToUse.beginPath();
  ctxToUse.moveTo(x, HEADER_HEIGHT);
  ctxToUse.lineTo(x, h);
  ctxToUse.stroke();

  ctxToUse.fillStyle = '#ff4444';
  ctxToUse.beginPath();
  ctxToUse.moveTo(x, HEADER_HEIGHT);
  ctxToUse.lineTo(x - 6, HEADER_HEIGHT - 6);
  ctxToUse.lineTo(x + 6, HEADER_HEIGHT - 6);
  ctxToUse.closePath();
  ctxToUse.fill();
}

function updateFragmentPlayhead() {
  if (!fragmentIsPlaying) return;
  if (!fragmentAudioContext) return;

  const elapsed = fragmentAudioContext.currentTime - fragmentPlaybackStartTime;
  fragmentCurrentTime = fragmentPlaybackOffset + elapsed;

  if (fragmentAudioData) {
    const duration = fragmentAudioData.length / SAMPLE_RATE;
    if (fragmentCurrentTime >= duration) {
      stopFragmentPlayback();
      fragmentCurrentTime = 0;
    }
  }

  render();

  fragmentPlayheadRaf = requestAnimationFrame(updateFragmentPlayhead);
}

function updateParamModeButtons() {
  const modes = ['MIDI', 'Pitch', 'VOL', 'PAN'];
  modes.forEach(mode => {
    const btn = document.getElementById(`btn-param-${mode}`);
    if (btn) {
      const isActive = currentParamMode === mode || (mode === 'Pitch' && currentParamMode === 'Pitch');
      if (isActive) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  });

  const pitchTools = document.getElementById('pitch-tools');
  const pitchDivider = document.getElementById('pitch-tools-divider');
  if (currentParamMode === 'Pitch') {
    if (!pitchCurve.enabled) {
      pitchCurve.enabled = true;
      scheduleAutoSave();
    }
    if (pitchTools) pitchTools.style.display = 'flex';
    if (pitchDivider) pitchDivider.style.display = '';
  } else {
    if (pitchTools) pitchTools.style.display = 'none';
    if (pitchDivider) pitchDivider.style.display = 'none';
  }

  updatePitchToolButtons();
}

function updatePitchToolButtons() {
  const resetBtn = document.getElementById('btn-pitch-reset');
  if (resetBtn) {
    if (pitchCurve.enabled) {
      resetBtn.classList.remove('disabled-mode');
    } else {
      resetBtn.classList.add('disabled-mode');
    }
  }
}

document.querySelectorAll('[id^="btn-param-"]').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.id.replace('btn-param-', '');
    if (mode === 'Pitch') {
      currentParamMode = 'Pitch';
    } else {
      currentParamMode = PARAM_MODES[mode] || mode;
    }
    updateParamModeButtons();
    render();
  });
});

document.getElementById('btn-pitch-reset').addEventListener('click', () => {
  const oldSnapshot = clonePitchCurveState();
  pitchCurve.anchorPoints = [];
  pitchCurve.brushSegments = [];
  const newSnapshot = clonePitchCurveState();
  history.push({
    undo() { applyPitchCurveSnapshot(oldSnapshot); },
    redo() { applyPitchCurveSnapshot(newSnapshot); }
  });
  render();
  scheduleAutoSave();
});

document.getElementById('btn-save').addEventListener('click', () => {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  saveFragmentData();
  const btnSave = document.getElementById('btn-save');
  const origText = btnSave.textContent;
  btnSave.textContent = '✅ 已保存';
  setTimeout(() => { btnSave.textContent = origText; }, 1500);
});

document.getElementById('btn-close').addEventListener('click', () => {
  stopFragmentPlayback();
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  saveFragmentData();
  window.close();
});

const btnPlayFragment = document.getElementById('btn-play-fragment');
const btnExportFragment = document.getElementById('btn-export-fragment');

window.electronAPI.onFragmentSVSProgress((progress) => {
  if (fragmentIsSynthesizing) {
    btnPlayFragment.textContent = `合成中 ${progress}%`;
    btnExportFragment.textContent = `导出 ${progress}%`;
  }
});

btnPlayFragment.addEventListener('click', async () => {
  if (notes.length === 0) {
    alert('当前分片没有音符，无法播放');
    return;
  }
  if (fragmentIsSynthesizing) return;
  if (fragmentIsPlaying) {
    stopFragmentPlayback();
    fragmentCurrentTime = 0;
    render();
    return;
  }
  await playFragment();
});

btnExportFragment.addEventListener('click', async () => {
  if (notes.length === 0) {
    alert('当前分片没有音符，无法导出');
    return;
  }
  await exportFragment();
});

document.getElementById('btn-import-midi').addEventListener('click', async () => {
  try {
    const result = await window.electronAPI.importMidi();
    if (!result.success) {
      if (!result.canceled) {
        alert('MIDI导入失败: ' + (result.error || '未知错误'));
      }
      return;
    }
    const oldNotes = notes.map(n => ({ ...n }));
    const oldSelectedNoteId = selectedNoteId;
    notes = result.notes.map((n, i) => ({
      id: genNoteId(),
      pitch: n.pitch,
      start: n.start,
      duration: n.duration,
      lyric: n.lyric || '',
      noteType: n.noteType,
    }));
    selectedNoteId = null;
    const newNotes = notes.map(n => ({ ...n }));
    history.push({
      undo() {
        notes = oldNotes.map(n => ({ ...n }));
        selectedNoteId = oldSelectedNoteId;
      },
      redo() {
        notes = newNotes.map(n => ({ ...n }));
        selectedNoteId = null;
      }
    });
    render();
    scheduleAutoSave();
  } catch (err) {
    alert('MIDI导入失败: ' + err.message);
  }
});

async function getFragmentAudioContext() {
  if (!fragmentAudioContext || fragmentAudioContext.state === 'closed') {
    fragmentAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    fragmentGainNode = fragmentAudioContext.createGain();
    fragmentGainNode.connect(fragmentAudioContext.destination);
    await applyFragmentAudioSettings();
  }
  if (fragmentAudioContext.state === 'suspended') {
    await fragmentAudioContext.resume();
  }
  return fragmentAudioContext;
}

async function loadFragmentAudioSettings() {
  try {
    fragmentAudioSettings = await window.electronAPI.getSettings();
    fragmentUseExclusiveMode = fragmentAudioSettings?.audioOutputMode === 'exclusive';
  } catch (e) {
    fragmentAudioSettings = {};
  }
}

async function applyFragmentAudioSettings() {
  if (!fragmentAudioSettings) return;

  if (fragmentGainNode && fragmentAudioSettings.audioVolume !== undefined) {
    fragmentGainNode.gain.value = fragmentAudioSettings.audioVolume;
  }

  if (fragmentAudioContext && fragmentAudioSettings.audioOutputDevice !== undefined && fragmentAudioSettings.audioOutputDevice !== -1) {
    const sinkId = String(fragmentAudioSettings.audioOutputDevice);
    if (fragmentAudioContext.setSinkId && typeof fragmentAudioContext.setSinkId === 'function') {
      try {
        await fragmentAudioContext.setSinkId(sinkId);
      } catch (err) {
        console.warn('[FragmentAudio] 设置输出设备失败:', err.message);
      }
    }
  }
}

function stopFragmentPlayback() {
  if (fragmentAudioSource) {
    try {
      fragmentAudioSource.onended = null;
      fragmentAudioSource.stop();
    } catch (e) {}
    fragmentAudioSource = null;
  }
  stopFragmentExclusivePlayback();
  fragmentIsPlaying = false;
  if (fragmentPlayheadRaf) {
    cancelAnimationFrame(fragmentPlayheadRaf);
    fragmentPlayheadRaf = null;
  }
  updateFragmentPlayButton();
}

function stopFragmentExclusivePlayback() {
  if (fragmentExclusiveRaf) {
    cancelAnimationFrame(fragmentExclusiveRaf);
    fragmentExclusiveRaf = null;
  }
  window.electronAPI.audioStop().catch(() => {});
}

function updateFragmentPlayButton() {
  if (fragmentIsSynthesizing) {
    btnPlayFragment.textContent = '合成中...';
    btnPlayFragment.disabled = true;
  } else if (fragmentIsPlaying) {
    btnPlayFragment.textContent = '⏸ 停止';
    btnPlayFragment.disabled = false;
  } else {
    btnPlayFragment.textContent = '▶ 播放';
    btnPlayFragment.disabled = false;
  }
}

function buildPitchCurveF0Data() {
  if (!pitchCurve.enabled || notes.length === 0) return null;

  const hasCustom = isPitchCurveCustomized();
  if (!hasCustom) return null;

  const bpm = currentProject ? currentProject.bpm : 120;
  const lastNote = notes[notes.length - 1];
  const totalBeats = lastNote.start + lastNote.duration;
  const totalSeconds = (totalBeats / bpm) * 60;
  const hopSize = 480;
  const totalFrames = Math.floor(totalSeconds * SAMPLE_RATE / hopSize);

  const f0Array = new Float32Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    const frameTimeSec = (i * hopSize) / SAMPLE_RATE;
    const frameBeat = (frameTimeSec / 60) * bpm;
    const pitch = getPitchAtTime(frameBeat);
    if (pitch !== null && pitch > 0) {
      f0Array[i] = 440 * Math.pow(2, (pitch - 69) / 12);
    } else {
      f0Array[i] = 0;
    }
  }

  return f0Array;
}

async function playFragment() {
  fragmentIsSynthesizing = true;
  updateFragmentPlayButton();
  try {
    if (!pipelineInitialized) {
      await initPipeline();
    }

    const pitchCurveF0 = buildPitchCurveF0Data();
    const pitchCurveF0Serializable = pitchCurveF0 ? Array.from(pitchCurveF0) : null;

    fragmentAudioData = await window.electronAPI.synthesizeFragmentSVS({
      notes: notes,
      bpm: currentProject ? currentProject.bpm : 120,
      options: {
        f0Envelope: null,
        pitchCurveF0: pitchCurveF0Serializable,
        refAudioWavBuffer: wavFileBuffer || null,
        autoShift: document.getElementById('autoShiftCheck').checked,
      },
    });

    await loadFragmentAudioSettings();
    fragmentUseExclusiveMode = fragmentAudioSettings?.audioOutputMode === 'exclusive';

    if (fragmentUseExclusiveMode) {
      await playFragmentExclusive();
    } else {
      await playFragmentShared();
    }
  } catch (error) {
    console.error('分片合成失败:', error);
    alert(`合成失败: ${error.message}`);
  } finally {
    fragmentIsSynthesizing = false;
    updateFragmentPlayButton();
  }
}

async function playFragmentShared() {
  const context = await getFragmentAudioContext();
  const audioBuffer = context.createBuffer(1, fragmentAudioData.length, SAMPLE_RATE);
  audioBuffer.getChannelData(0).set(fragmentAudioData);
  stopFragmentPlayback();
  const source = context.createBufferSource();
  source.buffer = audioBuffer;

  const envGainNode = context.createGain();
  const panNode = context.createStereoPanner();

  const bpm = currentProject ? currentProject.bpm : 120;
  const audioDuration = fragmentAudioData.length / SAMPLE_RATE;
  const volumeEnv = envelopes.volume;
  const panEnv = envelopes.pan;

  if (volumeEnv && volumeEnv.keyframes && volumeEnv.keyframes.length > 0) {
    const now = context.currentTime;
    const sortedKfs = [...volumeEnv.keyframes].sort((a, b) => a.time - b.time);
    for (const kf of sortedKfs) {
      const timeSec = (kf.time / bpm) * 60;
      if (timeSec <= audioDuration) {
        envGainNode.gain.setValueAtTime(kf.value, now + timeSec);
      }
    }
    const lastKf = sortedKfs[sortedKfs.length - 1];
    const lastTimeSec = (lastKf.time / bpm) * 60;
    if (lastTimeSec < audioDuration) {
      envGainNode.gain.setValueAtTime(lastKf.value, now + audioDuration);
    }
  }

  if (panEnv && panEnv.keyframes && panEnv.keyframes.length > 0) {
    const now = context.currentTime;
    const sortedKfs = [...panEnv.keyframes].sort((a, b) => a.time - b.time);
    for (const kf of sortedKfs) {
      const timeSec = (kf.time / bpm) * 60;
      if (timeSec <= audioDuration) {
        panNode.pan.setValueAtTime(kf.value, now + timeSec);
      }
    }
    const lastKf = sortedKfs[sortedKfs.length - 1];
    const lastTimeSec = (lastKf.time / bpm) * 60;
    if (lastTimeSec < audioDuration) {
      panNode.pan.setValueAtTime(lastKf.value, now + audioDuration);
    }
  }

  source.connect(envGainNode).connect(panNode).connect(fragmentGainNode);
  source.onended = () => {
    fragmentIsPlaying = false;
    if (fragmentPlayheadRaf) {
      cancelAnimationFrame(fragmentPlayheadRaf);
      fragmentPlayheadRaf = null;
    }
    fragmentCurrentTime = 0;
    updateFragmentPlayButton();
    render();
  };
  source.start();
  fragmentAudioSource = source;
  fragmentIsPlaying = true;
  fragmentPlaybackStartTime = context.currentTime;
  fragmentPlaybackOffset = 0;
  fragmentCurrentTime = 0;
  updateFragmentPlayhead();
  updateFragmentPlayButton();
}

async function playFragmentExclusive() {
  stopFragmentPlayback();

  try {
    const options = {
      deviceId: fragmentAudioSettings?.audioOutputDevice ?? -1,
      sampleRate: fragmentAudioSettings?.audioSampleRate ?? SAMPLE_RATE,
      channels: 1,
      bitDepth: fragmentAudioSettings?.audioBitDepth ?? 'float32',
      bufferSize: fragmentAudioSettings?.audioBufferSize ?? 1024,
      exclusiveMode: true,
      volume: fragmentAudioSettings?.audioVolume ?? 1.0,
      offset: 0,
    };

    const result = await window.electronAPI.audioPlay(Array.from(fragmentAudioData), options);

    if (!result.success) {
      console.warn('[FragmentAudio] WASAPI 独占模式失败，回退到共享模式:', result.error);
      fragmentUseExclusiveMode = false;
      await playFragmentShared();
      return;
    }

    fragmentIsPlaying = true;
    fragmentPlaybackStartTime = performance.now();
    fragmentPlaybackOffset = 0;
    fragmentCurrentTime = 0;

    const removeEndedListener = window.electronAPI.onAudioEnded(() => {
      fragmentIsPlaying = false;
      if (fragmentPlayheadRaf) {
        cancelAnimationFrame(fragmentPlayheadRaf);
        fragmentPlayheadRaf = null;
      }
      fragmentCurrentTime = 0;
      updateFragmentPlayButton();
      render();
    });

    updateFragmentExclusivePlayhead(removeEndedListener);
    updateFragmentPlayButton();
  } catch (err) {
    console.error('[FragmentAudio] 独占模式启动失败，回退到共享模式:', err);
    fragmentUseExclusiveMode = false;
    await playFragmentShared();
  }
}

function updateFragmentExclusivePlayhead(removeEndedListener) {
  function update() {
    if (!fragmentIsPlaying) {
      if (removeEndedListener) removeEndedListener();
      return;
    }

    const elapsed = (performance.now() - fragmentPlaybackStartTime) / 1000 + fragmentPlaybackOffset;
    const duration = fragmentAudioData ? fragmentAudioData.length / SAMPLE_RATE : 0;

    if (elapsed >= duration) {
      fragmentIsPlaying = false;
      fragmentCurrentTime = 0;
      stopFragmentExclusivePlayback();
      if (fragmentPlayheadRaf) {
        cancelAnimationFrame(fragmentPlayheadRaf);
        fragmentPlayheadRaf = null;
      }
      updateFragmentPlayButton();
      render();
      if (removeEndedListener) removeEndedListener();
      return;
    }

    fragmentCurrentTime = elapsed;
    fragmentExclusiveRaf = requestAnimationFrame(update);
  }

  fragmentExclusiveRaf = requestAnimationFrame(update);
}

async function exportFragment() {
  const originalText = btnExportFragment.textContent;
  btnExportFragment.disabled = true;
  btnExportFragment.textContent = '导出中...';
  try {
    if (!pipelineInitialized) {
      await initPipeline();
    }

    const pitchCurveF0 = buildPitchCurveF0Data();
    const pitchCurveF0Serializable = pitchCurveF0 ? Array.from(pitchCurveF0) : null;

    const audioData = await window.electronAPI.synthesizeFragmentSVS({
      notes: notes,
      bpm: currentProject ? currentProject.bpm : 120,
      options: {
        f0Envelope: null,
        pitchCurveF0: pitchCurveF0Serializable,
        refAudioWavBuffer: wavFileBuffer || null,
        autoShift: document.getElementById('autoShiftCheck').checked,
      },
    });
    const bpm = currentProject ? currentProject.bpm : 120;
    const stereoData = applyEnvelopesToAudio(audioData, SAMPLE_RATE, bpm, envelopes.volume, envelopes.pan);
    const wavData = encodeWav(stereoData, SAMPLE_RATE, 2);
    const result = await window.electronAPI.showSaveDialog({
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    });
    if (!result.canceled && result.filePath) {
      await window.electronAPI.saveFile(result.filePath, wavData);
    }
  } catch (error) {
    console.error('分片导出失败:', error);
    alert(`导出失败: ${error.message}`);
  } finally {
    btnExportFragment.disabled = false;
    btnExportFragment.textContent = originalText;
  }
}

function getMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('mousedown', (e) => {
  const pos = getMousePos(e);

  if (currentParamMode === 'Pitch' && pitchCurve.enabled) {
    handlePitchMouseDown(e, pos);
    return;
  }

  if (currentParamMode === 'VOL' || currentParamMode === 'PAN') {
    const areaTop = _getParamCurveAreaTop();
    if (pos.y >= areaTop) {
      handleParamEnvelopeMouseDown(pos);
      return;
    }
  }

  const hit = findNoteAt(pos.x, pos.y);

  if (hit) {
    selectedNoteId = hit.note.id;
    if (pos.x >= hit.nx + hit.nw - 6) {
      dragMode = 'resize';
      dragOperation = { type: 'noteResize', noteId: hit.note.id, oldDuration: hit.note.duration };
    } else {
      dragMode = 'move';
      dragNoteStart = { start: hit.note.start, pitch: hit.note.pitch, duration: hit.note.duration };
      dragOperation = { type: 'noteMove', noteId: hit.note.id, oldStart: hit.note.start, oldPitch: hit.note.pitch };
    }
    dragStartX = pos.x;
    dragStartY = pos.y;
  } else {
    const beats = snapBeats(xToTime(pos.x));
    const pitch = yToPitch(pos.y);
    const clampedPitch = Math.max(0, Math.min(127, pitch));
    const newNote = {
      id: genNoteId(),
      pitch: clampedPitch,
      start: Math.max(0, beats),
      duration: 1 / 4,
      lyric: 'la',
    };
    notes.push(newNote);
    selectedNoteId = newNote.id;
    dragMode = 'resize';
    dragStartX = pos.x;
    dragNoteStart = { start: newNote.start, pitch: newNote.pitch, duration: newNote.duration };
    dragOperation = { type: 'noteAdd', noteId: newNote.id };
    scheduleAutoSave();
  }
  render();
});

function handlePitchMouseDown(e, pos) {
  pitchCurveSnapshotBeforeDrag = clonePitchCurveState();
  if (e.shiftKey) {
    isBrushDrawing = true;
    const time = xToTime(pos.x);
    const pitch = yToPitch(pos.y);
    currentBrushStroke = {
      points: [{ time: Math.max(0, time), pitch: Math.max(0, Math.min(127, pitch)) }],
    };
    dragMode = 'pitch-brush';
    dragOperation = { type: 'pitchBrush' };
  } else {
    const anchorIdx = findAnchorPointAt(pos.x, pos.y);
    if (anchorIdx >= 0) {
      pitchDragAnchorIdx = anchorIdx;
      pitchDragStartTime = pitchCurve.anchorPoints[anchorIdx].time;
      pitchDragStartValue = pitchCurve.anchorPoints[anchorIdx].pitch;
      dragStartX = pos.x;
      dragStartY = pos.y;
      dragMode = 'pitch-anchor';
      dragOperation = { type: 'pitchAnchorMove' };
    } else {
      const time = xToTime(pos.x);
      const pitch = yToPitch(pos.y);
      const clampedPitch = Math.max(0, Math.min(127, pitch));
      pitchCurve.anchorPoints.push({
        time: Math.max(0, time),
        pitch: clampedPitch,
        smoothness: 30,
      });
      pitchDragAnchorIdx = pitchCurve.anchorPoints.length - 1;
      pitchDragStartTime = time;
      pitchDragStartValue = clampedPitch;
      dragStartX = pos.x;
      dragStartY = pos.y;
      dragMode = 'pitch-anchor';
      dragOperation = { type: 'pitchAnchorAdd' };
      scheduleAutoSave();
    }
  }
  render();
}

let paramEnvelopeDrag = null;

function handleParamEnvelopeMouseDown(pos) {
  const envKey = currentParamMode === PARAM_MODES.VOL ? 'volume' : 'pan';
  const envelope = envelopes[envKey];
  if (!envelope) return;

  envelopeSnapshotBeforeDrag = cloneEnvelopeState(envKey);

  const maxTime = Math.max(8, ...envelope.keyframes.map(k => k.time)) * 1.2;
  const w = canvas.parentElement.clientWidth;

  for (let i = 0; i < envelope.keyframes.length; i++) {
    const kf = envelope.keyframes[i];
    const px = (kf.time / maxTime) * w;
    const py = _valueToParamY(kf.value);
    const dist = Math.sqrt((pos.x - px) ** 2 + (pos.y - py) ** 2);
    if (dist <= 8) {
      paramEnvelopeDrag = { envKey, index: i, startX: pos.x, startY: pos.y, origTime: kf.time, origValue: kf.value };
      dragMode = 'param-envelope';
      dragOperation = { type: 'envelopeKeyframeMove', envKey };
      return;
    }
  }

  const time = (pos.x / w) * maxTime;
  const { min, max } = _getParamCurveYRange();
  const value = min + (1 - (pos.y - _getParamCurveAreaTop()) / PARAM_CURVE_HEIGHT) * (max - min);
  const clampedValue = Math.max(min, Math.min(max, value));
  envelope.keyframes.push({ time: Math.max(0, time), value: clampedValue, smoothness: 0 });
  envelope.keyframes.sort((a, b) => a.time - b.time);
  dragOperation = { type: 'envelopeKeyframeAdd', envKey };
  render();
  scheduleAutoSave();
}

canvas.addEventListener('mousemove', (e) => {
  const pos = getMousePos(e);

  if (dragMode === 'pitch-anchor' && pitchDragAnchorIdx >= 0) {
    const ap = pitchCurve.anchorPoints[pitchDragAnchorIdx];
    if (ap) {
      const dxBeats = (pos.x - dragStartX) / (BEAT_WIDTH * zoomX);
      const dyPitch = Math.round((dragStartY - pos.y) / NOTE_HEIGHT);
      ap.time = Math.max(0, pitchDragStartTime + dxBeats);
      ap.pitch = Math.max(0, Math.min(127, pitchDragStartValue + dyPitch));
    }
    render();
    return;
  }

  if (dragMode === 'pitch-brush' && isBrushDrawing && currentBrushStroke) {
    const time = xToTime(pos.x);
    const pitch = yToPitch(pos.y);
    const lastPt = currentBrushStroke.points[currentBrushStroke.points.length - 1];
    const dt = Math.abs(time - lastPt.time);
    if (dt > PITCH_CURVE_SAMPLE_INTERVAL) {
      currentBrushStroke.points.push({
        time: Math.max(0, time),
        pitch: Math.max(0, Math.min(127, pitch)),
      });
    }
    render();
    return;
  }

  if (dragMode === 'param-envelope' && paramEnvelopeDrag) {
    const { envKey, index, startX, startY, origTime, origValue } = paramEnvelopeDrag;
    const envelope = envelopes[envKey];
    if (!envelope || index >= envelope.keyframes.length) return;
    const w = canvas.parentElement.clientWidth;
    const maxTime = Math.max(8, ...envelope.keyframes.map(k => k.time)) * 1.2;
    const dxTime = ((pos.x - startX) / w) * maxTime;
    const { min, max } = _getParamCurveYRange();
    const dyValue = -((pos.y - startY) / PARAM_CURVE_HEIGHT) * (max - min);
    envelope.keyframes[index].time = Math.max(0, origTime + dxTime);
    envelope.keyframes[index].value = Math.max(min, Math.min(max, origValue + dyValue));
    render();
    return;
  }

  if (!dragMode) {
    if (currentParamMode === 'Pitch' && pitchCurve.enabled) {
      if (e.shiftKey) {
        canvas.style.cursor = 'crosshair';
      } else {
        const anchorIdx = findAnchorPointAt(pos.x, pos.y);
        canvas.style.cursor = anchorIdx >= 0 ? 'grab' : 'crosshair';
      }
      return;
    }
    const hit = findNoteAt(pos.x, pos.y);
    if (hit) {
      canvas.style.cursor = (pos.x >= hit.nx + hit.nw - 6) ? 'ew-resize' : 'move';
    } else {
      canvas.style.cursor = 'default';
    }
    return;
  }

  const note = notes.find(n => n.id === selectedNoteId);
  if (!note) return;

  if (dragMode === 'move') {
    const dxBeats = (pos.x - dragStartX) / BEAT_WIDTH;
    const dyPitch = Math.round((dragStartY - pos.y) / NOTE_HEIGHT);
    note.start = Math.max(0, snapBeats(dragNoteStart.start + dxBeats));
    note.pitch = Math.max(0, Math.min(127, dragNoteStart.pitch + dyPitch));
  } else if (dragMode === 'resize') {
    const dxBeats = (pos.x - dragStartX) / BEAT_WIDTH;
    note.duration = Math.max(1 / 16, snapBeats(dragNoteStart.duration + dxBeats));
  }
  render();
});

canvas.addEventListener('mouseup', (e) => {
  if (dragMode === 'pitch-brush' && isBrushDrawing && currentBrushStroke) {
    if (currentBrushStroke.points.length >= 2) {
      pitchCurve.brushSegments.push(currentBrushStroke);
    }
    currentBrushStroke = null;
    isBrushDrawing = false;
  }

  if (dragMode === 'pitch-anchor') {
    pitchDragAnchorIdx = -1;
  }

  if (dragMode === 'param-envelope') {
    const envKey = currentParamMode === PARAM_MODES.VOL ? 'volume' : 'pan';
    const envelope = envelopes[envKey];
    if (envelope) {
      envelope.keyframes.sort((a, b) => a.time - b.time);
    }
    paramEnvelopeDrag = null;
  }

  finalizeDragOperation();

  if (dragMode) {
    scheduleAutoSave();
  }

  dragMode = null;
});

canvas.addEventListener('mouseleave', () => {
  if (dragMode === 'pitch-brush' && isBrushDrawing && currentBrushStroke) {
    if (currentBrushStroke.points.length >= 2) {
      pitchCurve.brushSegments.push(currentBrushStroke);
    }
    currentBrushStroke = null;
    isBrushDrawing = false;
  }
  finalizeDragOperation();
  dragMode = null;
  pitchDragAnchorIdx = -1;
  paramEnvelopeDrag = null;
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (currentParamMode !== 'Pitch' || !pitchCurve.enabled) return;

  const pos = getMousePos(e);
  const anchorIdx = findAnchorPointAt(pos.x, pos.y);
  if (anchorIdx >= 0) {
    const oldSnapshot = clonePitchCurveState();
    pitchCurve.anchorPoints.splice(anchorIdx, 1);
    const newSnapshot = clonePitchCurveState();
    history.push({
      undo() { applyPitchCurveSnapshot(oldSnapshot); },
      redo() { applyPitchCurveSnapshot(newSnapshot); }
    });
    render();
    scheduleAutoSave();
  }
});

let activeInlineInput = null;
let activeInlineEditNote = null;

function startInlineEdit(note, hit) {
  if (activeInlineInput) {
    if (activeInlineInput.parentElement) activeInlineInput.remove();
    activeInlineInput = null;
    activeInlineEditNote = null;
  }

  activeInlineEditNote = note;
  lyricEditNoteId = note.id;
  lyricEditOldValue = note.lyric || '';

  const container = canvas.parentElement;
  const containerRect = container.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();

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
        const oldLyric = lyricEditOldValue;
        const noteId = lyricEditNoteId;
        const tokens = tokenizeLyric(newLyric);
        if (tokens.length <= 1) {
          note.lyric = newLyric;
        } else {
          const noteIdx = notes.findIndex(n => n.id === note.id);
          if (noteIdx !== -1) {
            note.lyric = tokens[0];
            for (let t = 1; t < tokens.length; t++) {
              const nextIdx = noteIdx + t;
              if (nextIdx < notes.length) {
                notes[nextIdx].lyric = tokens[t];
              }
            }
          } else {
            note.lyric = newLyric;
          }
        }
        history.push({
          undo() {
            const n = notes.find(nn => nn.id === noteId);
            if (n) n.lyric = oldLyric;
          },
          redo() {
            const n = notes.find(nn => nn.id === noteId);
            if (n) n.lyric = newLyric;
          }
        });
      }
    }
    if (input.parentElement) input.remove();
    activeInlineInput = null;
    activeInlineEditNote = null;
    render();
    if (save) scheduleAutoSave();
  };

  input.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

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

function updateInlineInputPosition() {
  if (!activeInlineInput || !activeInlineEditNote) return;

  const note = activeInlineEditNote;
  const container = canvas.parentElement;
  const containerRect = container.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();

  const offsetX = canvasRect.left - containerRect.left;
  const offsetY = canvasRect.top - containerRect.top;

  const nx = timeToX(note.start);
  const ny = pitchToY(note.pitch);
  const nw = note.duration * BEAT_WIDTH * zoomX;
  const nh = NOTE_HEIGHT;

  const visible = nx + nw >= 0 && nx <= container.clientWidth &&
                  ny + nh >= HEADER_HEIGHT && ny <= container.clientHeight;

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

canvas.addEventListener('dblclick', (e) => {
  if (currentParamMode === 'Pitch') return;

  const pos = getMousePos(e);
  const hit = findNoteAt(pos.x, pos.y);
  if (hit) {
    startInlineEdit(hit.note, hit);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    if (history.canUndo()) {
      history.undo();
      render();
      scheduleAutoSave();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey) || (e.key === 'Z' && e.shiftKey))) {
    e.preventDefault();
    if (history.canRedo()) {
      history.redo();
      render();
      scheduleAutoSave();
    }
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (currentParamMode === 'Pitch' && pitchCurve.enabled) {
      return;
    }
    if (selectedNoteId !== null) {
      const idx = notes.findIndex(n => n.id === selectedNoteId);
      if (idx !== -1) {
        const deletedNote = { ...notes[idx] };
        const deletedIndex = idx;
        const oldSelectedNoteId = selectedNoteId;
        notes.splice(idx, 1);
        selectedNoteId = null;
        history.push({
          undo() {
            notes.splice(deletedIndex, 0, { ...deletedNote });
            selectedNoteId = oldSelectedNoteId;
          },
          redo() {
            const idx2 = notes.findIndex(n => n.id === deletedNote.id);
            if (idx2 !== -1) notes.splice(idx2, 1);
            if (selectedNoteId === deletedNote.id) selectedNoteId = null;
          }
        });
        render();
        scheduleAutoSave();
      }
    }
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const oldZoomX = zoomX;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    zoomX = Math.max(0.25, Math.min(4, zoomX * delta));

    const pos = getMousePos(e);
    const mouseBeats = xToTime(pos.x);
    scrollX = mouseBeats * BEAT_WIDTH * zoomX - pos.x;

    scrollX = Math.max(0, scrollX);
  } else {
    scrollY += e.deltaY;
    const maxScrollY = Math.max(0, 128 * NOTE_HEIGHT + HEADER_HEIGHT + PARAM_CURVE_HEIGHT - canvas.parentElement.clientHeight);
    scrollY = Math.max(0, Math.min(maxScrollY, scrollY));
  }
  render();
}, { passive: false });

let fragmentDataReceived = false;

async function handleFragmentData(data) {
  if (!data || fragmentDataReceived) return;
  fragmentDataReceived = true;

  currentFragment = data.fragment;
  currentProject = data.project;
  document.getElementById('fragment-name').textContent = currentFragment.name || '分片';
  notes = currentFragment.notes || [];
  envelopes = currentFragment.envelopes || {
    volume: { keyframes: [{ time: 0, value: 1, smoothness: 0 }] },
    pan: { keyframes: [{ time: 0, value: 0, smoothness: 0 }] },
  };

  if (currentFragment.pitchCurve) {
    pitchCurve = {
      enabled: currentFragment.pitchCurve.enabled !== undefined ? currentFragment.pitchCurve.enabled : true,
      anchorPoints: currentFragment.pitchCurve.anchorPoints || [],
      brushSegments: currentFragment.pitchCurve.brushSegments || [],
    };
  } else {
    pitchCurve = {
      enabled: true,
      anchorPoints: [],
      brushSegments: [],
    };
  }

  history.clear();
  dragOperation = null;
  dragMode = null;
  pitchCurveSnapshotBeforeDrag = null;
  envelopeSnapshotBeforeDrag = null;
  selectedNoteId = null;
  lyricEditOldValue = null;
  lyricEditNoteId = null;
  nextNoteId = notes.reduce((max, n) => Math.max(max, (n.id || 0) + 1), 1);

  currentParamMode = PARAM_MODES.MIDI;
  updateParamModeButtons();

  if (data.wavBuffer) {
    wavFileBuffer = data.wavBuffer;
  }

  resizeCanvases();
}

if (window.electronAPI?.onLoadFragment) {
  window.electronAPI.onLoadFragment(async (data) => {
    await handleFragmentData(data);
  });
}

(async () => {
  await new Promise(resolve => setTimeout(resolve, 500));
  if (!fragmentDataReceived) {
    const hash = window.location.hash;
    const match = hash.match(/fragmentId=([^&]+)/);
    if (match && window.electronAPI?.getFragmentData) {
      const fragmentId = match[1];
      const data = await window.electronAPI.getFragmentData(fragmentId);
      if (data) {
        await handleFragmentData(data);
      }
    }
  }
})();

console.log('分片编辑窗口已启动');

window.addEventListener('beforeunload', () => {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  saveFragmentData();
});
