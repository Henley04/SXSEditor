import './common.css';
import './modelDownload.css';
import { t, initI18n, applyLocale, getLocale } from './i18n/index.js';

const missingFiles = [];
const fileStates = {};
let downloadStartTime = 0;
let lastOverallDownloaded = 0;
let lastSpeedTime = 0;
let isDownloading = false;
let renderedFileIds = [];
let currentPrecision = 'fp16';

function createIconSvg(status) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'file-icon ' + status);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  if (status === 'pending') {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '10');
    svg.appendChild(circle);
  } else if (status === 'downloading') {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M21 12a9 9 0 11-6.219-8.56');
    svg.appendChild(path);
  } else if (status === 'complete') {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M22 11.08V12a10 10 0 1 1-5.93-9.14');
    svg.appendChild(path);
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', '22 4 12 14.01 9 11.01');
    svg.appendChild(polyline);
  } else if (status === 'error') {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '10');
    svg.appendChild(circle);
    const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line1.setAttribute('x1', '15'); line1.setAttribute('y1', '9'); line1.setAttribute('x2', '9'); line1.setAttribute('y2', '15');
    svg.appendChild(line1);
    const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line2.setAttribute('x1', '9'); line2.setAttribute('y1', '9'); line2.setAttribute('x2', '15'); line2.setAttribute('y2', '15');
    svg.appendChild(line2);
  }
  return svg;
}

function getStatusText(state) {
  if (state.status === 'pending') {
    return t('modelDownload.pending');
  } else if (state.status === 'downloading') {
    const pct = state.total > 0 ? Math.round(state.downloaded / state.total * 100) : 0;
    return `${pct}% (${formatBytes(state.downloaded)}/${formatBytes(state.total)})`;
  } else if (state.status === 'complete') {
    return `${t('modelDownload.complete')} (${formatBytes(state.total)})`;
  } else if (state.status === 'error') {
    return t('modelDownload.failed');
  }
  return '';
}

function buildFileItem(file, state) {
  const item = document.createElement('div');
  item.className = 'file-item' + (state.status === 'downloading' ? ' downloading' : '');
  item.dataset.fileId = file.filePath;

  item.appendChild(createIconSvg(state.status));

  const nameSpan = document.createElement('span');
  nameSpan.className = 'file-name';
  nameSpan.title = file.filePath;
  nameSpan.textContent = file.filePath;
  item.appendChild(nameSpan);

  const statusSpan = document.createElement('span');
  statusSpan.className = 'file-status ' + state.status;
  statusSpan.textContent = getStatusText(state);
  item.appendChild(statusSpan);

  return item;
}

function updateFileItem(item, state) {
  item.className = 'file-item' + (state.status === 'downloading' ? ' downloading' : '');

  const oldIcon = item.querySelector('.file-icon');
  if (oldIcon) {
    const newIcon = createIconSvg(state.status);
    oldIcon.replaceWith(newIcon);
  }

  const statusSpan = item.querySelector('.file-status');
  if (statusSpan) {
    statusSpan.className = 'file-status ' + state.status;
    statusSpan.textContent = getStatusText(state);
  }
}

function renderFileList(forceRebuild) {
  const container = document.getElementById('fileList');
  const currentIds = missingFiles.map(f => f.filePath);

  if (forceRebuild || currentIds.length !== renderedFileIds.length || !currentIds.every((id, i) => id === renderedFileIds[i])) {
    container.textContent = '';
    for (const file of missingFiles) {
      const state = fileStates[file.filePath] || { status: 'pending', progress: 0, downloaded: 0, total: 0 };
      container.appendChild(buildFileItem(file, state));
    }
    renderedFileIds = currentIds.slice();
  } else {
    for (const file of missingFiles) {
      const state = fileStates[file.filePath] || { status: 'pending', progress: 0, downloaded: 0, total: 0 };
      const item = container.querySelector(`[data-file-id="${CSS.escape(file.filePath)}"]`);
      if (item) {
        updateFileItem(item, state);
      }
    }
  }
}

async function loadModelDir() {
  try {
    const dir = await window.electronAPI.modelDownloadGetDir();
    document.getElementById('dirPath').textContent = dir;
    document.getElementById('dirInfo').style.display = 'flex';
  } catch (_) {}
}

function updateMissingFiles(newMissingFiles) {
  missingFiles.length = 0;
  missingFiles.push(...newMissingFiles);
  for (const file of newMissingFiles) {
    if (!fileStates[file.filePath] || fileStates[file.filePath].status === 'pending') {
      fileStates[file.filePath] = { status: 'pending', progress: 0, downloaded: 0, total: 0 };
    }
  }
  document.getElementById('statusText').textContent = t('modelDownload.needDownloadCount', { count: newMissingFiles.length });
  renderFileList(true);
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec <= 0) return '';
  return formatBytes(bytesPerSec) + '/s';
}

function updateOverallProgress(overallDownloaded, overallTotal) {
  const percent = overallTotal > 0 ? Math.round(overallDownloaded / overallTotal * 100) : 0;
  document.getElementById('overallPercent').textContent = `${percent}%`;
  document.getElementById('overallBar').style.width = `${percent}%`;
  document.querySelector('.progress-bar-bg').setAttribute('aria-valuenow', percent);

  const now = Date.now();
  if (downloadStartTime > 0 && now - lastSpeedTime > 500) {
    const elapsed = (now - lastSpeedTime) / 1000;
    const diff = overallDownloaded - lastOverallDownloaded;
    const speed = diff / elapsed;
    document.getElementById('speedInfo').textContent = formatSpeed(speed);
    lastSpeedTime = now;
    lastOverallDownloaded = overallDownloaded;
  }
}

window.electronAPI.onModelDownloadMissingFiles((files) => {
  missingFiles.length = 0;
  missingFiles.push(...files);
  for (const file of files) {
    fileStates[file.filePath] = { status: 'pending', progress: 0, downloaded: 0, total: 0 };
  }
  document.getElementById('statusText').textContent = t('modelDownload.needDownloadCount', { count: files.length });
  document.getElementById('startBtn').style.display = 'inline-block';
  document.getElementById('closeBtn').style.display = 'inline-block';
  document.getElementById('precisionSection').style.display = 'block';
  renderFileList(true);
  loadModelDir();
});

window.electronAPI.onModelDownloadPrecision((precision) => {
  currentPrecision = precision || 'fp16';
  const radio = document.querySelector(`input[name="modelPrecision"][value="${currentPrecision}"]`);
  if (radio) radio.checked = true;
});

window.electronAPI.onModelDownloadProgress((data) => {
  const state = fileStates[data.currentFile];
  if (state) {
    state.status = 'downloading';
    state.downloaded = data.bytesDownloaded;
    state.total = data.bytesTotal;
  }
  updateOverallProgress(data.overallDownloaded, data.overallTotal);
  renderFileList();
});

window.electronAPI.onModelDownloadFileStart((data) => {
  fileStates[data.filePath] = { status: 'downloading', progress: 0, downloaded: 0, total: 0 };
  // 统计当前正在下载的文件数
  const downloadingCount = Object.values(fileStates).filter(s => s.status === 'downloading').length;
  const completedCount = Object.values(fileStates).filter(s => s.status === 'complete').length;
  const statusText = document.getElementById('statusText');
  statusText.textContent = '';
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  statusText.appendChild(spinner);
  statusText.appendChild(document.createTextNode(t('modelDownload.downloadingMultiple', { active: downloadingCount, completed: completedCount, total: missingFiles.length })));
  renderFileList();
});

window.electronAPI.onModelDownloadFileComplete((data) => {
  const state = fileStates[data.filePath];
  if (state) {
    state.status = 'complete';
  }
  renderFileList();
});

window.electronAPI.onModelDownloadComplete(() => {
  document.getElementById('statusText').textContent = t('modelDownload.allComplete');
  document.getElementById('speedInfo').textContent = '';
  document.getElementById('cancelBtn').style.display = 'none';
  document.getElementById('closeBtn').style.display = 'inline-block';
  document.getElementById('changeDirBtn').disabled = true;
  document.getElementById('overallBar').style.width = '100%';
  document.getElementById('overallPercent').textContent = '100%';
  document.querySelector('.progress-bar-bg').setAttribute('aria-valuenow', 100);
  for (const key in fileStates) {
    fileStates[key].status = 'complete';
  }
  isDownloading = false;
  renderFileList();
});

window.electronAPI.onModelDownloadError((data) => {
  document.getElementById('statusText').textContent = t('modelDownload.downloadFailed');
  document.getElementById('speedInfo').textContent = '';
  document.getElementById('errorMessage').textContent = data.message || '未知错误';
  document.getElementById('errorMessage').style.display = 'block';
  document.getElementById('cancelBtn').style.display = 'none';
  document.getElementById('closeBtn').style.display = 'inline-block';
  document.getElementById('changeDirBtn').disabled = false;
  isDownloading = false;
});

document.getElementById('startBtn').addEventListener('click', () => {
  const selectedRadio = document.querySelector('input[name="modelPrecision"]:checked');
  currentPrecision = selectedRadio ? selectedRadio.value : 'fp16';

  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('closeBtn').style.display = 'none';
  document.getElementById('cancelBtn').style.display = 'inline-block';
  document.getElementById('changeDirBtn').disabled = true;
  document.getElementById('precisionSection').style.display = 'none';
  document.getElementById('progressSection').style.display = 'block';
  downloadStartTime = Date.now();
  lastSpeedTime = downloadStartTime;
  lastOverallDownloaded = 0;
  isDownloading = true;
  window.electronAPI.modelDownloadStart(currentPrecision);
});

document.getElementById('cancelBtn').addEventListener('click', () => {
  window.electronAPI.modelDownloadCancel();
  document.getElementById('statusText').textContent = t('modelDownload.downloadCancelled');
  document.getElementById('speedInfo').textContent = '';
  document.getElementById('cancelBtn').style.display = 'none';
  document.getElementById('closeBtn').style.display = 'inline-block';
  document.getElementById('changeDirBtn').disabled = false;
  isDownloading = false;
});

document.getElementById('closeBtn').addEventListener('click', () => {
  window.close();
});

document.getElementById('changeDirBtn').addEventListener('click', async () => {
  if (isDownloading) return;
  const result = await window.electronAPI.modelDownloadChangeDir();
  if (result.canceled) return;
  document.getElementById('dirPath').textContent = result.modelDir;
  updateMissingFiles(result.missing);
  if (result.missing.length === 0) {
    document.getElementById('statusText').textContent = t('modelDownload.modelsReady');
    document.getElementById('startBtn').style.display = 'none';
    document.getElementById('closeBtn').style.display = 'inline-block';
  } else {
    document.getElementById('startBtn').style.display = 'inline-block';
    document.getElementById('closeBtn').style.display = 'inline-block';
  }
});

initI18n();
applyLocale();
document.documentElement.lang = getLocale();
