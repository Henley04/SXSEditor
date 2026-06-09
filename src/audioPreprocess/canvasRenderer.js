import { state, dom } from './state.js';
import { PIANO_KEY_WIDTH, BEAT_WIDTH, BPM, HEADER_HEIGHT, F0_CURVE_AREA_HEIGHT } from './constants.js';
import { t } from '../i18n/index.js';

export function drawWaveformWithPlayhead(currentTime) {
  if (!state.wavAudioBuffer) return;

  const canvas = dom.waveformCanvas;
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

  const zoomX = state.pianoRoll ? state.pianoRoll.zoomX : state.waveformZoomX;
  const scrollX = state.pianoRoll ? state.pianoRoll.scrollX : state.waveformScrollX;

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

  const audioData = state.wavAudioBuffer.getChannelData(0);
  const totalSamples = audioData.length;
  const secondsPerBeat = 60 / BPM;
  const mid = height / 2;

  const audioEndBeat = (state.wavDuration / 60) * BPM;
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
      const barHeight = Math.max(1, ((max - min) / 2) * height);
      ctx.fillRect(i, mid - barHeight / 2, 1, barHeight);
    }
  }

  if (currentTime >= 0 && currentTime <= state.wavDuration) {
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
