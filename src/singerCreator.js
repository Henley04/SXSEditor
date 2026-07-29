import './common.css';
import './singerCreator.css';
import { t, initI18n, applyLocale, getLocale } from './i18n/index.js';
import { initWindowTheme } from './themes/themeInit.js';
import { showAlertDialog } from './alertDialog.js';
import { createIcon, hydrateIcons } from './icons/iconHelper.js';

initI18n().then(() => {
  applyLocale();
  document.documentElement.lang = getLocale();
  hydrateIcons(document);
});

// Apply saved theme
initWindowTheme();

let wavFileBuffer = null;
let wavFileName = '';
let wavAudioBuffer = null;
let wavDuration = 0;
let isPreprocessed = false;
let preprocessResult = null;

let avatarImageData = null;
let avatarImageName = '';
let avatarMode = 'color';

let isPlayingPreview = false;
let previewAudioSource = null;
let previewAudioContext = null;
let previewPlayStartContextTime = 0;
let previewPlayStartOffset = 0;
let previewRaf = null;

let preprocessDataSavedCleanup = null;

// Save state: track the file path so subsequent saves (Ctrl+S) write to the
// original file silently instead of prompting with a Save As dialog.
let currentSingerFilePath = null;
// Whether the main window has already been notified about this singer (so we
// don't add duplicate singer entries on every save).
let singerCreatedNotified = false;
let isSaving = false;

const singerNameInput = document.getElementById('singer-name-input');
const singerColorInput = document.getElementById('singer-color-input');
const avatarFileInput = document.getElementById('avatar-file-input');
const btnSelectAvatar = document.getElementById('btn-select-avatar');
const avatarPreview = document.getElementById('avatar-preview');
const avatarPreviewImg = document.getElementById('avatar-preview-img');
const btnClearAvatar = document.getElementById('btn-clear-avatar');
const wavUploadArea = document.getElementById('wav-upload-area');
const wavFileInput = document.getElementById('wav-file-input');
const wavInfo = document.getElementById('wav-info');
const wavFilename = document.getElementById('wav-filename');
const wavDurationEl = document.getElementById('wav-duration');
const waveformCanvas = document.getElementById('waveform-canvas');
const btnPlayPreview = document.getElementById('btn-play-preview');
const btnClearWav = document.getElementById('btn-clear-wav');
const btnStartPreprocess = document.getElementById('btn-start-preprocess');
const preprocessActions = document.getElementById('preprocess-actions');
const btnCancel = document.getElementById('btn-cancel');
const previewName = document.getElementById('preview-name');
const previewAvatar = document.getElementById('preview-avatar');
const previewWavStatus = document.getElementById('preview-wav-status');
const previewPreprocessStatus = document.getElementById('preview-preprocess-status');
const previewPlaceholder = document.getElementById('preview-placeholder');
const previewContent = document.getElementById('preview-content');

wavUploadArea.addEventListener('click', () => wavFileInput.click());

wavUploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  wavUploadArea.style.borderColor = 'var(--accent)';
});
wavUploadArea.addEventListener('dragleave', () => {
  wavUploadArea.style.borderColor = 'var(--border-default)';
});
wavUploadArea.addEventListener('drop', async (e) => {
  e.preventDefault();
  wavUploadArea.style.borderColor = 'var(--border-default)';
  if (e.dataTransfer.files.length > 0) {
    await handleWavFile(e.dataTransfer.files[0]);
  }
});

wavFileInput.addEventListener('change', async (e) => {
  if (e.target.files.length > 0) {
    await handleWavFile(e.target.files[0]);
  }
  wavFileInput.value = '';
});

btnSelectAvatar.addEventListener('click', () => avatarFileInput.click());

avatarFileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleAvatarFile(e.target.files[0]);
  }
});

btnClearAvatar.addEventListener('click', () => {
  avatarImageData = null;
  avatarImageName = '';
  avatarPreview.style.display = 'none';
  avatarFileInput.value = '';
  if (avatarMode === 'image') {
    singerColorInput.disabled = false;
  }
  updatePreview();
});

document.querySelectorAll('input[name="avatar-type"]').forEach(radio => {
  radio.addEventListener('change', () => {
    avatarMode = radio.value;
    if (avatarMode === 'image' && avatarImageData) {
      singerColorInput.disabled = true;
    } else {
      singerColorInput.disabled = false;
    }
    updatePreview();
  });
});

singerNameInput.addEventListener('input', updatePreview);
singerColorInput.addEventListener('input', updatePreview);

btnClearWav.addEventListener('click', () => {
  wavFileBuffer = null;
  wavAudioBuffer = null;
  wavFileName = '';
  wavDuration = 0;
  isPreprocessed = false;
  preprocessResult = null;
  wavInfo.style.display = 'none';
  preprocessActions.style.display = 'none';
  wavUploadArea.style.display = 'block';
  stopPreviewPlayback();
  updatePreview();
});

btnStartPreprocess.addEventListener('click', () => {
  if (!wavFileBuffer) {
    showAlertDialog(t('singerCreator.pleaseUploadWav'));
    return;
  }
  if (!window.electronAPI || !window.electronAPI.openAudioPreprocess) {
    showAlertDialog(t('singerCreator.preprocessUnavailable'));
    return;
  }
  stopPreviewPlayback();
  window.electronAPI.openAudioPreprocess({
    wavBuffer: wavFileBuffer,
    wavFileName: wavFileName,
    duration: wavDuration,
    singerName: singerNameInput.value.trim() || t('singerCreator.unnamedSinger'),
    singerColor: singerColorInput.value,
    avatarImageData: avatarImageData,
    avatarImageName: avatarImageName,
  });
});

btnPlayPreview.addEventListener('click', async () => {
  if (wavAudioBuffer) {
    if (isPlayingPreview) {
      pausePreviewPlayback();
    } else {
      await playPreviewWav();
    }
  }
});

let _waveformDragging = false;

function getWaveformTime(clientX) {
  const rect = waveformCanvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const width = rect.width;
  return Math.max(0, Math.min(wavDuration, (x / width) * wavDuration));
}

waveformCanvas.addEventListener('mousedown', (e) => {
  if (!wavAudioBuffer || !wavDuration) return;
  e.preventDefault();
  _waveformDragging = true;
  const time = getWaveformTime(e.clientX);
  if (isPlayingPreview) stopPreviewPlayback();
  previewPlayStartOffset = time;
  drawWaveform(time);
});

document.addEventListener('mousemove', (e) => {
  if (!_waveformDragging) return;
  const time = getWaveformTime(e.clientX);
  previewPlayStartOffset = time;
  drawWaveform(time);
});

document.addEventListener('mouseup', () => {
  if (!_waveformDragging) return;
  _waveformDragging = false;
});

btnCancel.addEventListener('click', () => {
  stopPreviewPlayback();
  cleanupListeners();
  window.close();
});

document.getElementById('btn-save').addEventListener('click', () => {
  performSave(false);
});

// ==================== Save / Save As logic ====================
// Save (Ctrl+S): if a file path is already known, write to it silently.
// Otherwise fall back to Save As (show the dialog).
// Save As: always show the dialog and update the tracked path.
// The main window is notified (singerCreated) only on the first successful
// save, so subsequent saves don't add duplicate singer entries.
async function performSave(isSaveAs = false) {
  if (isSaving) return;
  if (!wavFileBuffer) {
    showAlertDialog(t('singerCreator.pleaseSelectWav'));
    return;
  }
  if (!window.electronAPI || !window.electronAPI.saveSingerFile) {
    showAlertDialog(t('singerCreator.saveUnavailable'));
    return;
  }

  const singerName = singerNameInput.value.trim() || t('singerCreator.unnamedSinger');
  const singerColor = singerColorInput.value;
  const useAvatarImage = (avatarMode === 'image' && avatarImageData);

  stopPreviewPlayback();

  const hasFilePath = !!currentSingerFilePath && !isSaveAs;
  const notifyMainWindow = !singerCreatedNotified;

  isSaving = true;
  try {
    const result = await window.electronAPI.saveSingerFile({
      singerName,
      color: singerColor,
      avatarImageData: useAvatarImage ? avatarImageData : null,
      avatarImageName: useAvatarImage ? avatarImageName : null,
      wavBuffer: wavFileBuffer,
      wavFileName: wavFileName,
      duration: wavDuration,
      isPreprocessed: isPreprocessed,
      preprocessResult: preprocessResult,
      filePath: hasFilePath ? currentSingerFilePath : null,
      notifyMainWindow,
    });

    if (result && result.success) {
      if (result.filePath) {
        currentSingerFilePath = result.filePath;
      }
      if (notifyMainWindow) {
        singerCreatedNotified = true;
      }
      showAlertDialog(t('singerCreator.saved'));
    } else if (result && result.canceled) {
      // User cancelled the Save As dialog — do nothing.
    } else {
      // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
      showAlertDialog(t('singerCreator.createFailedDetail', { detail: (result && result.error ? result.error : '') }));
    }
  } catch (err) {
    console.error(t('singerCreator.saveFailed'), err);
    // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
    showAlertDialog(t('singerCreator.createFailedDetail', { detail: (err && err.message ? err.message : '') }));
  } finally {
    isSaving = false;
  }
}

// Menu-driven save / save-as requests (sent from the main process menu).
// The menu also registers the Ctrl+S / Ctrl+Shift+S accelerators, which
// trigger these same requests — no separate keydown listener is needed.
if (window.electronAPI?.onSingerCreatorSaveRequest) {
  window.electronAPI.onSingerCreatorSaveRequest(() => {
    performSave(false);
  });
}
if (window.electronAPI?.onSingerCreatorSaveAsRequest) {
  window.electronAPI.onSingerCreatorSaveAsRequest(() => {
    performSave(true);
  });
}

function handleAvatarFile(file) {
  if (!file.type.startsWith('image/')) {
    showAlertDialog(t('singerCreator.pleaseSelectImage'));
    return;
  }

  avatarImageName = file.name;

  const reader = new FileReader();
  reader.onload = (e) => {
    avatarImageData = e.target.result;
    avatarPreviewImg.src = avatarImageData;
    avatarPreview.style.display = 'flex';
    if (avatarMode === 'image') {
      singerColorInput.disabled = true;
    }
    updatePreview();
  };
  reader.onerror = () => {
    showAlertDialog(t('singerCreator.imageReadFailed'));
  };
  reader.readAsDataURL(file);
}

async function handleWavFile(file) {
  if (!file.name.toLowerCase().endsWith('.wav')) {
    showAlertDialog(t('singerCreator.pleaseSelectWavFormat'));
    return;
  }

  wavFileName = file.name;

  try {
    const arrayBuffer = await file.arrayBuffer();
    wavFileBuffer = arrayBuffer;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    wavAudioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    wavDuration = wavAudioBuffer.duration;
    audioCtx.close();

    if (wavDuration > 30) {
      showWavTrimModal(wavAudioBuffer, wavFileBuffer, wavFileName, wavDuration);
      return;
    }

    wavInfo.style.display = 'block';
    preprocessActions.style.display = 'flex';
    wavUploadArea.style.display = 'none';
    wavFilename.textContent = wavFileName;
    wavDurationEl.textContent = wavDuration.toFixed(2) + t('singerCreator.seconds');

    requestAnimationFrame(() => {
      drawWaveform(0);
    });
    updatePreview();
  } catch (err) {
    console.error(t('singerCreator.wavParseError'), err);
    // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
    showAlertDialog(t('singerCreator.wavParseFailedDetail', { detail: err.message }));
    wavFileBuffer = null;
    wavAudioBuffer = null;
    wavFileName = '';
    wavDuration = 0;
  }
}

function drawWaveform(currentTime) {
  if (!wavAudioBuffer) return;

  const canvas = waveformCanvas;
  const container = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = container.clientWidth;
  const height = container.clientHeight || 60;

  if (width <= 0 || height <= 0) {
    requestAnimationFrame(() => drawWaveform(currentTime));
    return;
  }

  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, width, height);

  const data = wavAudioBuffer.getChannelData(0);
  const samplesPerPixel = data.length / width;
  const mid = height / 2;

  ctx.fillStyle = '#3498db';
  for (let i = 0; i < width; i++) {
    const startSample = Math.floor(i * samplesPerPixel);
    const endSample = Math.floor((i + 1) * samplesPerPixel);
    let min = 1.0;
    let max = -1.0;
    for (let j = startSample; j < endSample; j++) {
      const datum = data[j];
      if (datum < min) min = datum;
      if (datum > max) max = datum;
    }
    const barHeight = Math.max(1, ((max - min) / 2) * height);
    ctx.fillRect(i, mid - barHeight / 2, 1, barHeight);
  }

  if (currentTime !== undefined && currentTime >= 0 && currentTime <= wavDuration) {
    const playheadX = (currentTime / wavDuration) * width;

    ctx.fillStyle = 'rgba(52, 152, 219, 0.25)';
    ctx.fillRect(0, 0, playheadX, height);

    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX - 5, -2);
    ctx.lineTo(playheadX + 5, -2);
    ctx.closePath();
    ctx.fill();
  }
}

async function playPreviewWav() {
  if (!wavAudioBuffer) return;

  try {
    if (!previewAudioContext || previewAudioContext.state === 'closed') {
      previewAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (previewAudioContext.state === 'suspended') {
      await previewAudioContext.resume();
    }

    const source = previewAudioContext.createBufferSource();
    source.buffer = wavAudioBuffer;
    source.connect(previewAudioContext.destination);

    let startOffset = (previewPlayStartOffset > 0 && previewPlayStartOffset < wavAudioBuffer.duration)
      ? previewPlayStartOffset
      : 0;
    previewPlayStartOffset = startOffset;

    // Schedule playback slightly in the future so the audio system has time to
    // prepare the first buffer. Using an explicit `when` (instead of 0) makes
    // the start time deterministic and lets us align the playhead baseline to
    // the exact moment audio begins generating.
    const SCHEDULE_AHEAD = 0.05;
    const scheduledStartTime = previewAudioContext.currentTime + SCHEDULE_AHEAD;
    // The audible signal lags behind the AudioContext clock by the output
    // latency. Aligning the baseline to scheduledStartTime + outputLatency
    // keeps the playhead in sync with what is actually heard, preventing the
    // bar from running ahead of the audio.
    const outputLatency = (previewAudioContext.outputLatency != null
      ? previewAudioContext.outputLatency
      : previewAudioContext.baseLatency) || 0;
    source.start(scheduledStartTime, startOffset);

    source.onended = () => {
      if (isPlayingPreview) {
        isPlayingPreview = false;
        previewPlayStartOffset = 0;
        btnPlayPreview.textContent = t('singerCreator.preview');
        stopPreviewRaf();
        drawWaveform(0);
      }
    };

    previewAudioSource = source;
    isPlayingPreview = true;
    previewPlayStartContextTime = scheduledStartTime + outputLatency;
    btnPlayPreview.textContent = t('singerCreator.pausePreview');
    startPreviewPlaybackLoop();
  } catch (err) {
    console.error(t('singerCreator.previewPlayFailed'), err);
  }
}

function pausePreviewPlayback() {
  if (!isPlayingPreview) return;

  isPlayingPreview = false;
  if (previewAudioSource) {
    try {
      previewAudioSource.onended = null;
      previewAudioSource.stop();
    } catch (e) {}
    previewAudioSource = null;
  }

  const elapsed = Math.max(0, previewAudioContext.currentTime - previewPlayStartContextTime);
  previewPlayStartOffset += elapsed;

  if (previewPlayStartOffset >= wavDuration) {
    previewPlayStartOffset = 0;
  }

  btnPlayPreview.textContent = t('singerCreator.preview');
  stopPreviewRaf();
  drawWaveform(previewPlayStartOffset);
}

function startPreviewPlaybackLoop() {
  if (!isPlayingPreview) return;

  // Clamp to 0 so the playhead stays put until the scheduled (audible) start
  // time is reached, instead of running ahead of the audio.
  const elapsed = Math.max(0, previewAudioContext.currentTime - previewPlayStartContextTime);
  const currentTime = previewPlayStartOffset + elapsed;

  drawWaveform(currentTime);

  previewRaf = requestAnimationFrame(() => startPreviewPlaybackLoop());
}

function stopPreviewRaf() {
  if (previewRaf) {
    cancelAnimationFrame(previewRaf);
    previewRaf = null;
  }
}

function stopPreviewPlayback() {
  stopPreviewRaf();
  if (previewAudioSource) {
    try {
      previewAudioSource.onended = null;
      previewAudioSource.stop();
    } catch (e) {}
    previewAudioSource = null;
  }
  if (previewAudioContext && previewAudioContext.state !== 'closed') {
    previewAudioContext.close().catch(() => {});
    previewAudioContext = null;
  }
  isPlayingPreview = false;
  previewPlayStartOffset = 0;
  btnPlayPreview.textContent = t('singerCreator.preview');
  if (wavAudioBuffer) {
    drawWaveform(0);
  }
}

function updatePreview() {
  const name = singerNameInput.value.trim() || t('singerCreator.unnamedSinger');
  previewName.textContent = name;

  const useAvatarImage = (avatarMode === 'image' && avatarImageData);
  if (useAvatarImage) {
    const existingImg = previewAvatar.querySelector('img');
    if (existingImg) {
      existingImg.src = avatarImageData;
      existingImg.alt = name;
    } else {
      previewAvatar.textContent = '';
      const img = document.createElement('img');
      img.src = avatarImageData;
      img.alt = name;
      previewAvatar.appendChild(img);
    }
    previewAvatar.style.backgroundColor = 'transparent';
  } else {
    previewAvatar.textContent = '';
    previewAvatar.style.backgroundColor = singerColorInput.value;
    const micIcon = createIcon('microphone', { size: 22 });
    if (micIcon) previewAvatar.appendChild(micIcon);
  }

  const hasWav = !!wavFileBuffer;

  previewWavStatus.textContent = hasWav ? t('singerCreator.wavReady') : t('singerCreator.wavStatus');
  previewWavStatus.className = 'status-badge' + (hasWav ? ' ready' : '');

  previewPreprocessStatus.textContent = isPreprocessed ? t('singerCreator.preprocessReady') : t('singerCreator.preprocessStatus');
  previewPreprocessStatus.className = 'status-badge' + (isPreprocessed ? ' ready' : '');

  if (hasWav) {
    previewPlaceholder.style.display = 'none';
    previewContent.style.display = 'block';
  } else {
    previewPlaceholder.style.display = 'block';
    previewContent.style.display = 'none';
  }
}

// TODO: 如果未来需要从主进程通知预处理状态变化，应在 preload.js 中添加
// onPreprocessStatus IPC 通道（类似 onPreprocessDataSaved），并在 main.js 中
// 使用 webContents.send('preprocessStatus', status) 替代 executeJavaScript

if (window.electronAPI && window.electronAPI.onPreprocessDataSaved) {
  preprocessDataSavedCleanup = window.electronAPI.onPreprocessDataSaved((result) => {
    // 只有当WAV文件存在时才接受预处理数据，防止清除WAV后预处理窗口仍回调覆盖状态
    if (!wavFileBuffer) return;
    preprocessResult = result;
    isPreprocessed = true;
    updatePreview();
  });
}

function cleanupListeners() {
  if (preprocessDataSavedCleanup) {
    preprocessDataSavedCleanup();
    preprocessDataSavedCleanup = null;
  }
}

// ==================== WAV 截取模态框逻辑 ====================

const MAX_TRIM_DURATION = 30;

let trimAudioBuffer = null;
let trimStart = 0;
let trimLength = MAX_TRIM_DURATION;
let trimTotalDuration = 0;
let trimDragging = null; // 'selection' | 'left' | 'right'
let trimDragStartX = 0;
let trimDragStartValue = 0;
let trimPreviewSource = null;
let trimPreviewContext = null;
let isTrimPreviewPlaying = false;

const trimOverlay = document.getElementById('wav-trim-overlay');
const trimCanvas = document.getElementById('wav-trim-canvas');
const trimSelection = document.getElementById('wav-trim-selection');
const trimLabelStart = document.getElementById('wav-trim-label-start');
const trimLabelEnd = document.getElementById('wav-trim-label-end');
const trimStartInput = document.getElementById('trim-start-input');
const trimLengthInput = document.getElementById('trim-length-input');
const btnTrimPreview = document.getElementById('btn-trim-preview');
const btnTrimConfirm = document.getElementById('btn-trim-confirm');
const btnTrimCancel = document.getElementById('btn-trim-cancel');

function showWavTrimModal(audioBuffer, fileBuffer, fileName, duration) {
  trimAudioBuffer = audioBuffer;
  trimTotalDuration = duration;
  trimStart = 0;
  trimLength = Math.min(MAX_TRIM_DURATION, duration);
  trimOverlay.style.display = 'flex';

  trimStartInput.max = (duration - 0.1).toFixed(1);
  trimStartInput.value = trimStart.toFixed(1);
  trimLengthInput.value = trimLength.toFixed(1);

  requestAnimationFrame(() => {
    drawTrimWaveform();
    updateTrimSelectionUI();
    drawTrimTimeAxis();
  });
}

function closeWavTrimModal() {
  stopTrimPreview();
  trimOverlay.style.display = 'none';
  trimAudioBuffer = null;
  trimTotalDuration = 0;
}

function drawWaveformBars(ctx, data, fromX, toX, samplesPerPixel, height, mid, color, canvasWidth) {
  ctx.fillStyle = color;
  const maxX = canvasWidth != null ? canvasWidth : toX;
  for (let i = fromX; i < toX; i++) {
    if (i < 0 || i >= maxX) continue;
    const startSample = Math.floor(i * samplesPerPixel);
    const endSample = Math.floor((i + 1) * samplesPerPixel);
    let min = 1.0;
    let max = -1.0;
    for (let j = startSample; j < endSample; j++) {
      const datum = data[j];
      if (datum < min) min = datum;
      if (datum > max) max = datum;
    }
    const barHeight = Math.max(1, ((max - min) / 2) * height);
    ctx.fillRect(i, mid - barHeight / 2, 1, barHeight);
  }
}

function drawTrimWaveform() {
  if (!trimAudioBuffer) return;

  const canvas = trimCanvas;
  const wrapper = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = wrapper.clientWidth;
  const height = wrapper.clientHeight || 100;

  if (width <= 0 || height <= 0) {
    requestAnimationFrame(() => drawTrimWaveform());
    return;
  }

  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#14141f';
  ctx.fillRect(0, 0, width, height);

  const data = trimAudioBuffer.getChannelData(0);
  const samplesPerPixel = data.length / width;
  const mid = height / 2;

  const selLeft = (trimStart / trimTotalDuration) * width;
  const selRight = ((trimStart + trimLength) / trimTotalDuration) * width;

  // 基础波形
  drawWaveformBars(ctx, data, 0, width, samplesPerPixel, height, mid, '#3a3a52');

  // 选区外暗化
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fillRect(0, 0, selLeft, height);
  ctx.fillRect(selRight, 0, width - selRight, height);

  // 选区内高亮波形
  drawWaveformBars(ctx, data, Math.floor(selLeft), Math.ceil(selRight), samplesPerPixel, height, mid, '#5b8def', width);
}

function drawTrimTimeAxis() {
  const axisEl = document.getElementById('wav-trim-time-axis');
  if (!axisEl || !trimTotalDuration) return;

  const width = axisEl.clientWidth;
  if (width <= 0) {
    requestAnimationFrame(() => drawTrimTimeAxis());
    return;
  }

  axisEl.innerHTML = '';

  // 计算合适的刻度间隔
  let interval = 5;
  if (trimTotalDuration <= 60) interval = 5;
  else if (trimTotalDuration <= 120) interval = 10;
  else interval = 15;

  for (let time = 0; time <= trimTotalDuration; time += interval) {
    const x = (time / trimTotalDuration) * width;
    const tick = document.createElement('div');
    tick.style.cssText = `
      position: absolute;
      left: ${x}px;
      bottom: 0;
      font-size: 9px;
      color: var(--fg-muted);
      transform: translateX(-50%);
    `;
    tick.textContent = time + 's';
    axisEl.appendChild(tick);
  }
}

function updateTrimSelectionUI() {
  if (!trimTotalDuration) return;

  const wrapper = document.getElementById('wav-trim-waveform-wrapper');
  const width = wrapper.clientWidth;
  if (width <= 0) return;

  const leftPx = (trimStart / trimTotalDuration) * width;
  const rightPx = ((trimStart + trimLength) / trimTotalDuration) * width;

  trimSelection.style.left = leftPx + 'px';
  trimSelection.style.width = (rightPx - leftPx) + 'px';

  trimLabelStart.textContent = trimStart.toFixed(1) + 's';
  trimLabelEnd.textContent = (trimStart + trimLength).toFixed(1) + 's';

  trimStartInput.value = trimStart.toFixed(1);
  trimLengthInput.value = trimLength.toFixed(1);
}

function clampTrimValues() {
  trimStart = Math.max(0, trimStart);
  trimLength = Math.max(0.1, trimLength);
  trimLength = Math.min(MAX_TRIM_DURATION, trimLength);
  trimLength = Math.min(trimLength, trimTotalDuration - trimStart);
  if (trimStart + trimLength > trimTotalDuration) {
    trimStart = trimTotalDuration - trimLength;
  }
  trimStart = Math.max(0, trimStart);
}

// 选区拖拽交互
function handleTrimPointerDown(clientX) {
  if (!trimAudioBuffer) return;

  const wrapper = document.getElementById('wav-trim-waveform-wrapper');
  const rect = wrapper.getBoundingClientRect();
  const x = clientX - rect.left;
  const width = rect.width;

  const selLeft = (trimStart / trimTotalDuration) * width;
  const selRight = ((trimStart + trimLength) / trimTotalDuration) * width;

  const handleZone = 8;

  if (Math.abs(x - selLeft) < handleZone) {
    trimDragging = 'left';
  } else if (Math.abs(x - selRight) < handleZone) {
    trimDragging = 'right';
  } else if (x > selLeft && x < selRight) {
    trimDragging = 'selection';
    trimDragStartX = clientX;
    trimDragStartValue = trimStart;
  } else {
    const clickTime = (x / width) * trimTotalDuration;
    trimStart = Math.max(0, Math.min(clickTime - trimLength / 2, trimTotalDuration - trimLength));
    clampTrimValues();
    drawTrimWaveform();
    updateTrimSelectionUI();
    trimDragging = 'selection';
    trimDragStartX = clientX;
    trimDragStartValue = trimStart;
  }
}

function handleTrimPointerMove(clientX) {
  if (!trimDragging || !trimAudioBuffer) return;

  const wrapper = document.getElementById('wav-trim-waveform-wrapper');
  const width = wrapper.clientWidth;

  if (trimDragging === 'left') {
    const rect = wrapper.getBoundingClientRect();
    const x = clientX - rect.left;
    const fixedEnd = trimStart + trimLength;
    trimStart = Math.max(0, (x / width) * trimTotalDuration);
    trimLength = fixedEnd - trimStart;
    if (trimLength > MAX_TRIM_DURATION) {
      trimLength = MAX_TRIM_DURATION;
      trimStart = fixedEnd - MAX_TRIM_DURATION;
    }
    if (trimLength < 0.1) {
      trimLength = 0.1;
      trimStart = fixedEnd - 0.1;
    }
    clampTrimValues();
  } else if (trimDragging === 'right') {
    const rect = wrapper.getBoundingClientRect();
    const x = clientX - rect.left;
    const currentEnd = (x / width) * trimTotalDuration;
    trimLength = Math.min(MAX_TRIM_DURATION, currentEnd - trimStart);
    clampTrimValues();
  } else if (trimDragging === 'selection') {
    const dx = clientX - trimDragStartX;
    const wrapper2 = document.getElementById('wav-trim-waveform-wrapper');
    const width2 = wrapper2.clientWidth;
    const dTime = (dx / width2) * trimTotalDuration;
    trimStart = trimDragStartValue + dTime;
    clampTrimValues();
  }

  drawTrimWaveform();
  updateTrimSelectionUI();
}

function handleTrimPointerUp() {
  trimDragging = null;
}

const trimWrapper = document.getElementById('wav-trim-waveform-wrapper');
trimWrapper.addEventListener('mousedown', (e) => {
  handleTrimPointerDown(e.clientX);
  e.preventDefault();
});
trimWrapper.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    handleTrimPointerDown(e.touches[0].clientX);
    e.preventDefault();
  }
}, { passive: false });

document.addEventListener('mousemove', (e) => handleTrimPointerMove(e.clientX));
document.addEventListener('touchmove', (e) => {
  if (e.touches.length === 1) {
    handleTrimPointerMove(e.touches[0].clientX);
    e.preventDefault();
  }
}, { passive: false });

document.addEventListener('mouseup', handleTrimPointerUp);
document.addEventListener('touchend', handleTrimPointerUp);
document.addEventListener('touchcancel', handleTrimPointerUp);

// 数值输入
trimStartInput.addEventListener('input', () => {
  const val = parseFloat(trimStartInput.value);
  if (isNaN(val)) return;
  trimStart = val;
  clampTrimValues();
  drawTrimWaveform();
  updateTrimSelectionUI();
});

trimLengthInput.addEventListener('input', () => {
  const val = parseFloat(trimLengthInput.value);
  if (isNaN(val)) return;
  trimLength = val;
  clampTrimValues();
  drawTrimWaveform();
  updateTrimSelectionUI();
});

// 预览播放
btnTrimPreview.addEventListener('click', async () => {
  if (isTrimPreviewPlaying) {
    stopTrimPreview();
    return;
  }

  if (!trimAudioBuffer) return;

  try {
    trimPreviewContext = new (window.AudioContext || window.webkitAudioContext)();
    const sampleRate = trimAudioBuffer.sampleRate;
    const startSample = Math.floor(trimStart * sampleRate);
    const lengthSamples = Math.floor(trimLength * sampleRate);
    const channels = trimAudioBuffer.numberOfChannels;

    const previewBuffer = trimPreviewContext.createBuffer(channels, lengthSamples, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const srcData = trimAudioBuffer.getChannelData(ch);
      const dstData = previewBuffer.getChannelData(ch);
      for (let i = 0; i < lengthSamples; i++) {
        dstData[i] = srcData[startSample + i] || 0;
      }
    }

    const source = trimPreviewContext.createBufferSource();
    source.buffer = previewBuffer;
    source.connect(trimPreviewContext.destination);
    source.start();
    source.onended = () => {
      isTrimPreviewPlaying = false;
      btnTrimPreview.textContent = t('singerCreator.wavTrimPreview');
    };

    trimPreviewSource = source;
    isTrimPreviewPlaying = true;
    btnTrimPreview.textContent = t('singerCreator.wavTrimStopPreview');
  } catch (err) {
    console.error('Trim preview failed:', err);
  }
});

function stopTrimPreview() {
  if (trimPreviewSource) {
    try { trimPreviewSource.onended = null; trimPreviewSource.stop(); } catch (e) {}
    trimPreviewSource = null;
  }
  if (trimPreviewContext && trimPreviewContext.state !== 'closed') {
    trimPreviewContext.close().catch(() => {});
    trimPreviewContext = null;
  }
  isTrimPreviewPlaying = false;
  btnTrimPreview.textContent = t('singerCreator.wavTrimPreview');
}

// 确认截取
btnTrimConfirm.addEventListener('click', () => {
  if (!trimAudioBuffer) return;

  stopTrimPreview();

  try {
    const sampleRate = trimAudioBuffer.sampleRate;
    const startSample = Math.floor(trimStart * sampleRate);
    const lengthSamples = Math.floor(trimLength * sampleRate);
    const channels = trimAudioBuffer.numberOfChannels;

    // 创建截取后的 AudioBuffer
    const trimmedBuffer = new AudioBuffer({
      length: lengthSamples,
      sampleRate: sampleRate,
      numberOfChannels: channels,
    });
    for (let ch = 0; ch < channels; ch++) {
      const srcData = trimAudioBuffer.getChannelData(ch);
      const dstData = trimmedBuffer.getChannelData(ch);
      for (let i = 0; i < lengthSamples; i++) {
        dstData[i] = srcData[startSample + i] || 0;
      }
    }

    // 编码为 WAV ArrayBuffer
    const wavArrayBuffer = encodeAudioBufferToWav(trimmedBuffer);

    // 更新全局状态
    wavFileBuffer = wavArrayBuffer;
    wavAudioBuffer = trimmedBuffer;
    wavDuration = trimLength;
    // 文件名保持不变

    closeWavTrimModal();

    wavInfo.style.display = 'block';
    preprocessActions.style.display = 'flex';
    wavUploadArea.style.display = 'none';
    wavFilename.textContent = wavFileName;
    wavDurationEl.textContent = wavDuration.toFixed(2) + t('singerCreator.seconds');

    requestAnimationFrame(() => {
      drawWaveform(0);
    });
    updatePreview();
  } catch (err) {
    console.error('Trim encode failed:', err);
    // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
    showAlertDialog(t('singerCreator.wavTrimEncodeFailedDetail', { detail: err.message }));
  }
});

// 取消
btnTrimCancel.addEventListener('click', () => {
  closeWavTrimModal();
  // 清空已加载的WAV数据
  wavFileBuffer = null;
  wavAudioBuffer = null;
  wavFileName = '';
  wavDuration = 0;
});

// WAV 编码函数
function encodeAudioBufferToWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = length * numChannels * (bitsPerSample / 8);
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // 交错写入采样数据
  let offset = 44;
  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = channels[ch][i];
      sample = Math.max(-1, Math.min(1, sample));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

console.log(t('singerCreator.pageStarted'));
