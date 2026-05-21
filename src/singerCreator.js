import './singerCreator.css';
import { t, initI18n, applyLocale, getLocale } from './i18n/index.js';

initI18n();
applyLocale();
document.documentElement.lang = getLocale();

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
const btnCreate = document.getElementById('btn-create');
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
  wavUploadArea.style.borderColor = '#3498db';
});
wavUploadArea.addEventListener('dragleave', () => {
  wavUploadArea.style.borderColor = '#555555';
});
wavUploadArea.addEventListener('drop', async (e) => {
  e.preventDefault();
  wavUploadArea.style.borderColor = '#555555';
  if (e.dataTransfer.files.length > 0) {
    await handleWavFile(e.dataTransfer.files[0]);
  }
});

wavFileInput.addEventListener('change', async (e) => {
  if (e.target.files.length > 0) {
    await handleWavFile(e.target.files[0]);
  }
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
    alert(t('singerCreator.pleaseUploadWav'));
    return;
  }
  if (!window.electronAPI || !window.electronAPI.openAudioPreprocess) {
    alert(t('singerCreator.preprocessUnavailable'));
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

waveformCanvas.addEventListener('click', (e) => {
  if (!wavAudioBuffer || !wavDuration) return;

  const rect = waveformCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const width = rect.width;
  const clampedTime = Math.max(0, Math.min(wavDuration, (x / width) * wavDuration));

  previewPlayStartOffset = clampedTime;
  drawWaveform(clampedTime);

  if (isPlayingPreview) {
    stopPreviewPlayback();
    previewPlayStartOffset = clampedTime;
    playPreviewWav();
  }
});

btnCancel.addEventListener('click', () => {
  stopPreviewPlayback();
  cleanupListeners();
  window.close();
});

btnCreate.addEventListener('click', async () => {
  if (!wavFileBuffer) {
    alert(t('singerCreator.pleaseSelectWav'));
    return;
  }
  if (!window.electronAPI || !window.electronAPI.saveSingerFile) {
    alert(t('singerCreator.saveUnavailable'));
    return;
  }

  const singerName = singerNameInput.value.trim() || t('singerCreator.unnamedSinger');
  const singerColor = singerColorInput.value;

  const useAvatarImage = (avatarMode === 'image' && avatarImageData);

  stopPreviewPlayback();

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
    });

    if (result && result.success) {
      alert(t('singerCreator.createSuccess'));
      cleanupListeners();
      window.close();
    } else {
      alert(t('singerCreator.createFailed') + ': ' + (result && result.error ? result.error : ''));
    }
  } catch (err) {
    console.error(t('singerCreator.saveFailed'), err);
    alert(t('singerCreator.createFailed') + ': ' + (err && err.message ? err.message : ''));
  }
});

function handleAvatarFile(file) {
  if (!file.type.startsWith('image/')) {
    alert(t('singerCreator.pleaseSelectImage'));
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
    alert(t('singerCreator.imageReadFailed'));
  };
  reader.readAsDataURL(file);
}

async function handleWavFile(file) {
  if (!file.name.toLowerCase().endsWith('.wav')) {
    alert(t('singerCreator.pleaseSelectWavFormat'));
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
      alert(t('singerCreator.wavTooLong'));
      wavFileBuffer = null;
      wavAudioBuffer = null;
      wavFileName = '';
      wavDuration = 0;
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
    alert(t('singerCreator.wavParseFailed') + ': ' + err.message);
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

    if (previewPlayStartOffset > 0 && previewPlayStartOffset < wavAudioBuffer.duration) {
      source.start(0, previewPlayStartOffset);
    } else {
      source.start();
      previewPlayStartOffset = 0;
    }

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
    previewPlayStartContextTime = previewAudioContext.currentTime;
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

  const elapsed = previewAudioContext.currentTime - previewPlayStartContextTime;
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

  const elapsed = previewAudioContext.currentTime - previewPlayStartContextTime;
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
    const span = document.createElement('span');
    span.textContent = '🎤';
    previewAvatar.appendChild(span);
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

window.updatePreprocessStatus = (status) => {
  isPreprocessed = status;
  updatePreview();
};

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

console.log(t('singerCreator.pageStarted'));
