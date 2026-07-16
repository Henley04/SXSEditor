import { state, dom } from './state.js';
import { PIANO_KEY_WIDTH, BEAT_WIDTH, BPM, HEADER_HEIGHT, NOTE_HEIGHT } from './constants.js';
import { drawWaveformWithPlayhead } from './canvasRenderer.js';
import { togglePlayback, startPlayback, stopPlayback } from './playback.js';
import { extractF0AndPitch } from './f0Extraction.js';
import { extractF0BasicPitch, importMidiFile } from './midiExtraction.js';
import { saveSingerData } from './uiControls.js';

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

  // Waveform canvas click
  dom.waveformCanvas.addEventListener('click', (e) => {
    if (!state.wavAudioBuffer || !state.wavDuration) return;

    const rect = dom.waveformCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    if (x < PIANO_KEY_WIDTH) return;

    const zoomX = state.pianoRoll ? state.pianoRoll.zoomX : state.waveformZoomX;
    const scrollX = state.pianoRoll ? state.pianoRoll.scrollX : state.waveformScrollX;

    const beat = (x + scrollX - PIANO_KEY_WIDTH) / (BEAT_WIDTH * zoomX);
    const secondsPerBeat = 60 / BPM;
    const clampedTime = Math.max(0, Math.min(state.wavDuration, beat * secondsPerBeat));

    state.playStartOffset = clampedTime;

    drawWaveformWithPlayhead(clampedTime);

    if (state.pianoRoll) {
      state.pianoRoll.setCurrentTime(clampedTime);
    }

    if (state.isPlaying) {
      stopPlayback();
      startPlayback();
    }
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

    drawWaveformWithPlayhead(state.pianoRoll.getCurrentTime());
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
