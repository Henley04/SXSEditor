const missingFiles = [];
const fileStates = {};
let downloadStartTime = 0;
let lastOverallDownloaded = 0;
let lastSpeedTime = 0;
let isDownloading = false;

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
  document.getElementById('statusText').textContent = `需要下载 ${newMissingFiles.length} 个模型文件`;
  renderFileList();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec <= 0) return '';
  return formatBytes(bytesPerSec) + '/s';
}

function renderFileList() {
  const container = document.getElementById('fileList');
  container.innerHTML = '';
  for (const file of missingFiles) {
    const state = fileStates[file.filePath] || { status: 'pending', progress: 0, downloaded: 0, total: 0 };
    const item = document.createElement('div');
    item.className = 'file-item' + (state.status === 'downloading' ? ' downloading' : '');

    let iconSvg = '';
    if (state.status === 'pending') {
      iconSvg = '<svg class="file-icon pending" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
    } else if (state.status === 'downloading') {
      iconSvg = '<svg class="file-icon downloading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>';
    } else if (state.status === 'complete') {
      iconSvg = '<svg class="file-icon complete" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
    } else if (state.status === 'error') {
      iconSvg = '<svg class="file-icon error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    }

    let statusText = '';
    if (state.status === 'pending') {
      statusText = '等待中';
    } else if (state.status === 'downloading') {
      const pct = state.total > 0 ? Math.round(state.downloaded / state.total * 100) : 0;
      statusText = `${pct}% (${formatBytes(state.downloaded)}/${formatBytes(state.total)})`;
    } else if (state.status === 'complete') {
      statusText = `完成 (${formatBytes(state.total)})`;
    } else if (state.status === 'error') {
      statusText = '失败';
    }

    item.innerHTML = `
      ${iconSvg}
      <span class="file-name" title="${file.filePath}">${file.filePath}</span>
      <span class="file-status ${state.status}">${statusText}</span>
    `;
    container.appendChild(item);
  }
}

function updateOverallProgress(overallDownloaded, overallTotal) {
  const percent = overallTotal > 0 ? Math.round(overallDownloaded / overallTotal * 100) : 0;
  document.getElementById('overallPercent').textContent = `${percent}%`;
  document.getElementById('overallBar').style.width = `${percent}%`;

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
  document.getElementById('statusText').textContent = `需要下载 ${files.length} 个模型文件`;
  document.getElementById('startBtn').style.display = 'inline-block';
  document.getElementById('closeBtn').style.display = 'inline-block';
  renderFileList();
  loadModelDir();
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
  document.getElementById('statusText').innerHTML = `<span class="spinner"></span>正在下载: ${data.filePath}`;
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
  document.getElementById('statusText').textContent = '所有模型文件下载完成！';
  document.getElementById('speedInfo').textContent = '';
  document.getElementById('cancelBtn').style.display = 'none';
  document.getElementById('closeBtn').style.display = 'inline-block';
  document.getElementById('changeDirBtn').disabled = true;
  document.getElementById('overallBar').style.width = '100%';
  document.getElementById('overallPercent').textContent = '100%';
  for (const key in fileStates) {
    fileStates[key].status = 'complete';
  }
  isDownloading = false;
  renderFileList();
});

window.electronAPI.onModelDownloadError((data) => {
  document.getElementById('statusText').textContent = '下载失败';
  document.getElementById('speedInfo').textContent = '';
  document.getElementById('errorMessage').textContent = data.message || '未知错误';
  document.getElementById('errorMessage').style.display = 'block';
  document.getElementById('cancelBtn').style.display = 'none';
  document.getElementById('closeBtn').style.display = 'inline-block';
  document.getElementById('changeDirBtn').disabled = false;
  isDownloading = false;
});

document.getElementById('startBtn').addEventListener('click', () => {
  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('closeBtn').style.display = 'none';
  document.getElementById('cancelBtn').style.display = 'inline-block';
  document.getElementById('changeDirBtn').disabled = true;
  document.getElementById('progressSection').style.display = 'block';
  downloadStartTime = Date.now();
  lastSpeedTime = downloadStartTime;
  lastOverallDownloaded = 0;
  isDownloading = true;
  window.electronAPI.modelDownloadStart();
});

document.getElementById('cancelBtn').addEventListener('click', () => {
  window.electronAPI.modelDownloadCancel();
  document.getElementById('statusText').textContent = '下载已取消';
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
    document.getElementById('statusText').textContent = '所选目录中模型文件已就绪';
    document.getElementById('startBtn').style.display = 'none';
    document.getElementById('closeBtn').style.display = 'inline-block';
  } else {
    document.getElementById('startBtn').style.display = 'inline-block';
    document.getElementById('closeBtn').style.display = 'inline-block';
  }
});
