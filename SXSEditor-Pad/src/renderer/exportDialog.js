import { invoke } from '@tauri-apps/api/core';
import { save, message } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { getProject, getPlayback, getState } from './state.js';
import { SAMPLE_RATE } from './constants.js';
import { getAudioBuffer } from './audioPlayback.js';

// Dialog state
let dialogContainer = null;
let dialogOverlay = null;

/**
 * Create the export dialog modal element and inject it into the DOM.
 */
function createDialogElement() {
  if (dialogContainer) return;

  // Overlay
  dialogOverlay = document.createElement('div');
  dialogOverlay.className = 'export-dialog-overlay';
  dialogOverlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  `;

  // Container
  dialogContainer = document.createElement('div');
  dialogContainer.className = 'export-dialog';
  dialogContainer.style.cssText = `
    background: #1a1a2e;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 24px;
    min-width: 400px;
    max-width: 500px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    color: #e0e0e0;
    font-family: sans-serif;
  `;

  dialogContainer.innerHTML = `
    <h2 style="margin: 0 0 20px 0; font-size: 18px; color: #ffffff;">导出音频</h2>

    <div style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 6px; font-size: 13px; color: #a0a0a0;">格式</label>
      <select id="export-format" style="
        width: 100%; padding: 8px 12px; border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.15);
        background: #16213e; color: #e0e0e0; font-size: 14px;
      ">
        <option value="wav">WAV (无损)</option>
        <option value="mp3">MP3 (有损压缩)</option>
        <option value="flac">FLAC (无损压缩)</option>
        <option value="ogg">OGG Vorbis</option>
      </select>
    </div>

    <div id="export-quality-section" style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 6px; font-size: 13px; color: #a0a0a0;">质量</label>
      <select id="export-quality" style="
        width: 100%; padding: 8px 12px; border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.15);
        background: #16213e; color: #e0e0e0; font-size: 14px;
      ">
        <option value="320">320 kbps (最高)</option>
        <option value="256">256 kbps (高)</option>
        <option value="192">192 kbps (标准)</option>
        <option value="128">128 kbps (中等)</option>
        <option value="96">96 kbps (低)</option>
      </select>
    </div>

    <div style="margin-bottom: 20px;">
      <label style="display: block; margin-bottom: 6px; font-size: 13px; color: #a0a0a0;">采样率</label>
      <select id="export-samplerate" style="
        width: 100%; padding: 8px 12px; border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.15);
        background: #16213e; color: #e0e0e0; font-size: 14px;
      ">
        <option value="44100">44100 Hz (CD质量)</option>
        <option value="48000">48000 Hz (专业)</option>
        <option value="96000">96000 Hz (高解析度)</option>
        <option value="22050">22050 Hz (低质量)</option>
      </select>
    </div>

    <div id="export-progress" style="display: none; margin-bottom: 16px;">
      <div style="font-size: 13px; color: #a0a0a0; margin-bottom: 6px;">导出中...</div>
      <div style="
        width: 100%; height: 6px; background: rgba(255,255,255,0.1);
        border-radius: 3px; overflow: hidden;
      ">
        <div id="export-progress-bar" style="
          width: 0%; height: 100%;
          background: linear-gradient(90deg, #e94560, #457fe9);
          border-radius: 3px; transition: width 0.2s;
        "></div>
      </div>
    </div>

    <div id="export-error" style="display: none; margin-bottom: 16px; padding: 8px 12px;
      background: rgba(233, 69, 96, 0.15); border: 1px solid rgba(233, 69, 96, 0.3);
      border-radius: 6px; color: #e94560; font-size: 13px;"></div>

    <div style="display: flex; justify-content: flex-end; gap: 10px;">
      <button id="export-cancel-btn" style="
        padding: 8px 20px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15);
        background: transparent; color: #a0a0a0; font-size: 14px; cursor: pointer;
      ">取消</button>
      <button id="export-confirm-btn" style="
        padding: 8px 20px; border-radius: 6px; border: none;
        background: #e94560; color: #ffffff; font-size: 14px; cursor: pointer;
      ">导出</button>
    </div>
  `;

  dialogOverlay.appendChild(dialogContainer);
  document.body.appendChild(dialogOverlay);

  // Event handlers
  const formatSelect = dialogContainer.querySelector('#export-format');
  const qualitySection = dialogContainer.querySelector('#export-quality-section');

  formatSelect.addEventListener('change', () => {
    const format = formatSelect.value;
    qualitySection.style.display = format === 'wav' || format === 'flac' ? 'none' : 'block';
  });

  dialogContainer.querySelector('#export-cancel-btn').addEventListener('click', closeDialog);
  dialogContainer.querySelector('#export-confirm-btn').addEventListener('click', handleExport);
  dialogOverlay.addEventListener('click', (e) => {
    if (e.target === dialogOverlay) closeDialog();
  });

  // Close on Escape
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      closeDialog();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

/**
 * Show the export dialog.
 */
export function showExportDialog() {
  createDialogElement();
  dialogOverlay.style.display = 'flex';
  setProgress(0, false);
  setError('');

  // Reset format to default
  const formatSelect = dialogContainer.querySelector('#export-format');
  if (formatSelect) {
    formatSelect.value = 'wav';
    dialogContainer.querySelector('#export-quality-section').style.display = 'none';
  }
}

/**
 * Close the export dialog.
 */
export function closeDialog() {
  if (dialogOverlay) {
    dialogOverlay.style.display = 'none';
  }
}

// ==================== Export Logic ====================

function setProgress(percent, visible) {
  const progress = dialogContainer?.querySelector('#export-progress');
  const bar = dialogContainer?.querySelector('#export-progress-bar');
  if (progress) progress.style.display = visible ? 'block' : 'none';
  if (bar) bar.style.width = `${percent}%`;
}

function setError(msg) {
  const errorEl = dialogContainer?.querySelector('#export-error');
  if (errorEl) {
    errorEl.textContent = msg;
    errorEl.style.display = msg ? 'block' : 'none';
  }
}

/**
 * Handle the export button click.
 */
async function handleExport() {
  const formatSelect = dialogContainer.querySelector('#export-format');
  const qualitySelect = dialogContainer.querySelector('#export-quality');
  const srSelect = dialogContainer.querySelector('#export-samplerate');

  const format = formatSelect.value;
  const quality = parseInt(qualitySelect.value, 10);
  const sampleRate = parseInt(srSelect.value, 10);

  // Validate audio buffer
  const audioBuffer = getAudioBuffer();
  if (!audioBuffer) {
    setError('没有加载音频数据。请先导入音频文件。');
    return;
  }

  setProgress(0, true);
  setError('');

  try {
    // Build the export data
    const exportData = await buildExportData(audioBuffer, format, quality, sampleRate);

    // Ask for save path
    const ext = format === 'mp3' ? 'mp3' : format === 'flac' ? 'flac' : format === 'ogg' ? 'ogg' : 'wav';
    const savePath = await save({
      filters: [
        { name: format.toUpperCase(), extensions: [ext] },
        { name: 'All Files', extensions: ['*'] },
      ],
      defaultPath: `export.${ext}`,
    });

    if (!savePath) {
      setProgress(0, false);
      return; // Cancelled
    }

    setProgress(50, true);

    // Write the file
    await writeFile(savePath, exportData);

    setProgress(100, true);
    setTimeout(() => {
      closeDialog();
      message(`导出成功: ${savePath}`, { title: 'SXSEditor-Pad', kind: 'info' });
    }, 500);
  } catch (err) {
    console.error('[exportDialog] Export failed:', err);
    setError(`导出失败: ${err.message || err}`);
    setProgress(0, false);
  }
}

/**
 * Build the export audio data as a Uint8Array.
 * For WAV we write the header directly; for other formats we use the Web Audio API
 * encoder (MediaRecorder or AudioContext encode).
 */
async function buildExportData(audioBuffer, format, quality, targetSampleRate) {
  const numChannels = audioBuffer.numberOfChannels;
  const srcSampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;

  // Resample if needed
  let buffer = audioBuffer;
  if (targetSampleRate !== srcSampleRate) {
    buffer = resampleAudioBuffer(audioBuffer, targetSampleRate);
  }

  if (format === 'wav') {
    return encodeWav(buffer);
  }

  // For MP3, FLAC, OGG — use OfflineAudioContext + MediaRecorder if available
  // Otherwise fall back to WAV
  try {
    const blob = await encodeWithMediaRecorder(buffer, format, quality);
    const arrayBuffer = await blob.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  } catch (err) {
    console.warn('[exportDialog] MediaRecorder encoding failed, falling back to WAV:', err);
    return encodeWav(buffer);
  }
}

/**
 * Encode an AudioBuffer to WAV format.
 */
function encodeWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitsPerSample = 16;

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = audioBuffer.length * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave and write samples
  const channels = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }

  let offset = 44;
  for (let i = 0; i < audioBuffer.length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Uint8Array(arrayBuffer);
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Encode audio using MediaRecorder with a specific MIME type.
 */
function encodeWithMediaRecorder(audioBuffer, format, quality) {
  return new Promise((resolve, reject) => {
    const mimeType = format === 'mp3'
      ? 'audio/mpeg'
      : format === 'flac'
        ? 'audio/flac'
        : format === 'ogg'
          ? 'audio/ogg'
          : 'audio/wav';

    // Check if the MIME type is supported
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      reject(new Error(`MIME type ${mimeType} not supported in this browser`));
      return;
    }

    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;

    // Create an offline context to render the audio
    const offlineCtx = new OfflineAudioContext(
      numChannels,
      audioBuffer.length,
      sampleRate
    );

    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start();

    // Create a MediaStream from the destination
    const dest = offlineCtx.createMediaStreamDestination();
    source.connect(dest);

    const recorder = new MediaRecorder(dest.stream, {
      mimeType,
      audioBitsPerSecond: quality * 1000,
    });

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      resolve(blob);
    };

    recorder.onerror = () => {
      reject(new Error('MediaRecorder error'));
    };

    // Start recording
    recorder.start();

    // Render and stop
    offlineCtx.startRendering().then(() => {
      recorder.stop();
    }).catch(reject);
  });
}

/**
 * Simple linear interpolation resampling.
 */
function resampleAudioBuffer(audioBuffer, targetSampleRate) {
  const srcRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const srcLength = audioBuffer.length;
  const ratio = targetSampleRate / srcRate;
  const dstLength = Math.round(srcLength * ratio);

  const result = new AudioBuffer({
    length: dstLength,
    numberOfChannels: numChannels,
    sampleRate: targetSampleRate,
  });

  for (let c = 0; c < numChannels; c++) {
    const srcData = audioBuffer.getChannelData(c);
    const dstData = result.getChannelData(c);

    for (let i = 0; i < dstLength; i++) {
      const srcPos = i / ratio;
      const srcIdx = Math.floor(srcPos);
      const frac = srcPos - srcIdx;

      if (srcIdx >= srcLength - 1) {
        dstData[i] = srcData[srcLength - 1];
      } else {
        dstData[i] = srcData[srcIdx] * (1 - frac) + srcData[srcIdx + 1] * frac;
      }
    }
  }

  return result;
}

/**
 * Clean up the export dialog DOM.
 */
export function destroyExportDialog() {
  if (dialogContainer) {
    dialogContainer.remove();
    dialogContainer = null;
  }
  if (dialogOverlay) {
    dialogOverlay.remove();
    dialogOverlay = null;
  }
}