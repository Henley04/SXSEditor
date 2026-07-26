import './common.css';
import './modelDownload.css';
import { t, initI18n, applyLocale, getLocale } from './i18n/index.js';
import { initWindowTheme } from './themes/themeInit.js';
import { formatBytes } from './utils/formatBytes.js';
import { showConfirmDialog } from './alertDialog.js';

const missingFiles = [];
const fileStates = {};
let downloadStartTime = 0;
let lastOverallDownloaded = 0;
let lastSpeedTime = 0;
let isDownloading = false;
let renderedFileIds = [];
let currentPrecision = 'fp32';
let currentRevision = 'latest'; // selected revision: 'latest' = auto-pick newest tag, or a specific tag (e.g. 'v1')
let availableTags = []; // tags fetched from ModelScope (branches NOT shown)
let currentVersionInfo = null; // { updateAvailable, localVersion, latestVersion, hasModelFiles, localRevision }
let i18nReady = false;
// Resolved when the main process pushes the initial precision via
// 'model-download:precision'. Used to make refreshVersionInfo() wait for the
// real precision instead of falling back to the 'fp16' default — otherwise
// an FP32 install would briefly display the FP16 version number on open.
let resolveInitialPrecision;
const initialPrecisionReady = new Promise((resolve) => { resolveInitialPrecision = resolve; });

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
    let pct = 0;
    if (state.total > 0) {
      pct = Math.min(Math.max(Math.round(state.downloaded / state.total * 100), 0), 100);
    }
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

// ===== Version management =====

/**
 * Check model version for the current precision and update the UI.
 * Called on window load, precision switch, and after download completes.
 */
async function refreshVersionInfo() {
  try {
    const result = await window.electronAPI.modelDownloadCheckVersion(currentPrecision);
    currentVersionInfo = result;
    renderVersionInfo(result);
  } catch (err) {
    console.error('[Version] Failed to check model version:', err);
    document.getElementById('versionInfoSection').style.display = 'none';
  }
  // Update overview after main model version info is refreshed
  updateOverviewStatus();
}

/**
 * Resolve the latest tag from availableTags (same logic as getLatestTag in
 * modelManager.js). Returns the latest tag string or null if none match.
 */
function resolveLatestTag(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return null;
  const valid = tags.filter(t => typeof t === 'string' && /^v?\d+/i.test(t));
  if (valid.length === 0) return null;
  valid.sort((a, b) => {
    const na = a.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const nb = b.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(na.length, nb.length);
    for (let i = 0; i < len; i++) {
      const da = na[i] || 0, db = nb[i] || 0;
      if (da !== db) return db - da; // descending
    }
    return 0;
  });
  return valid[0];
}

/**
 * Check if the currently selected main model revision resolves to v0 or
 * null (no real version). In such cases the download/update confirmation
 * should warn the user that v0 and legacy content are identical.
 */
function isMainModelTargetV0OrLegacy() {
  if (currentRevision === 'v0') return true;
  if (currentRevision === 'latest') {
    const latest = resolveLatestTag(availableTags);
    return !latest || latest === 'v0';
  }
  return false;
}

/**
 * Check if SiFiGAN's latest version is v0 or null based on cached versionInfo.
 */
function isSifiganTargetV0OrLegacy() {
  const info = sifiganState.versionInfo;
  if (!info) return false; // unknown — don't block initial download
  return !info.latestVersion || info.latestVersion === 'v0';
}

/**
 * Fetch available model versions (tags) from ModelScope and populate
 * the version selector dropdown. The first option is always 'latest'
 * (auto-pick the newest tag). Tags are appended after. Branches are
 * NOT shown. 'latest' is the default selection.
 */
async function refreshVersionSelector() {
  const select = document.getElementById('versionSelect');
  if (!select) return;
  select.disabled = true;
  select.innerHTML = '';
  try {
    const result = await window.electronAPI.modelDownloadListVersions(currentPrecision);
    availableTags = (result && result.tags) || [];
  } catch (_) {
    availableTags = [];
  }
  // First option: latest (auto-pick newest tag on download)
  const latestOpt = document.createElement('option');
  latestOpt.value = 'latest';
  latestOpt.textContent = t('modelDownload.latestVersionLabel');
  select.appendChild(latestOpt);
  // Remaining options: tags
  for (const tag of availableTags) {
    const option = document.createElement('option');
    option.value = tag;
    option.textContent = tag;
    select.appendChild(option);
  }
  // Determine which option to select:
  // 1. If local model has a specific tag installed, select that tag
  // 2. Else default to 'latest'
  const localRev = currentVersionInfo && currentVersionInfo.hasModelFiles
    ? currentVersionInfo.localRevision
    : null;
  if (localRev && localRev !== 'master' && availableTags.includes(localRev)) {
    select.value = localRev;
    currentRevision = localRev;
  } else {
    select.value = 'latest';
    currentRevision = 'latest';
  }
  select.disabled = false;
}

function renderVersionInfo(info) {
  const section = document.getElementById('versionInfoSection');
  const localEl = document.getElementById('localVersionValue');
  const latestEl = document.getElementById('latestVersionValue');
  const banner = document.getElementById('versionUpdateBanner');
  const updateText = document.getElementById('versionUpdateText');
  const updateBtn = document.getElementById('updateModelBtn');

  if (!info || !info.hasModelFiles) {
    // No model files installed — hide version info, no update needed
    section.style.display = 'none';
    // Still refresh the version selector so user can pick a version to download
    refreshVersionSelector();
    return;
  }

  section.style.display = 'block';
  // Show local revision (tag name) and latest version
  const localRev = info.localRevision;
  if (!localRev || localRev === 'master') {
    // Legacy branch-based install — show as legacy
    localEl.textContent = t('modelDownload.legacyVersion');
  } else {
    localEl.textContent = localRev;
  }
  latestEl.textContent = info.latestVersion || '-';

  if (info.updateAvailable) {
    banner.style.display = 'flex';
    if (!localRev || localRev === 'master') {
      // Legacy install → update to latest tag
      updateText.textContent = t('modelDownload.legacyUpdateHint');
    } else {
      // Specific tag installed → update to latest available
      updateText.textContent = t('modelDownload.versionSwitchHint', { version: localRev });
    }
    updateBtn.style.display = 'inline-block';
  } else {
    banner.style.display = 'none';
  }
  // Refresh the version selector to reflect installed revision
  refreshVersionSelector();
}

document.getElementById('updateModelBtn').addEventListener('click', async () => {
  if (isDownloading) return;
  const confirmMsg = isMainModelTargetV0OrLegacy()
    ? t('modelDownload.v0LegacyConfirmMessage')
    : t('modelDownload.updateConfirmMessage');
  const confirmed = await showConfirmDialog(confirmMsg);
  if (!confirmed) return;

  isDownloading = true;
  document.getElementById('updateModelBtn').style.display = 'none';
  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('closeBtn').style.display = 'none';
  document.getElementById('cancelBtn').style.display = 'inline-block';
  document.getElementById('changeDirBtn').disabled = true;
  document.getElementById('precisionSection').style.display = 'none';
  document.getElementById('versionInfoSection').style.display = 'none';
  document.getElementById('progressSection').style.display = 'block';
  downloadStartTime = Date.now();
  lastSpeedTime = downloadStartTime;
  lastOverallDownloaded = 0;

  const result = await window.electronAPI.modelDownloadUpdate(currentPrecision, currentRevision);
  if (result && !result.success && result.error) {
    document.getElementById('statusText').textContent = t('modelDownload.downloadNotAvailable');
    document.getElementById('errorMessage').textContent = result.error;
    document.getElementById('errorMessage').style.display = 'block';
    document.getElementById('cancelBtn').style.display = 'none';
    document.getElementById('closeBtn').style.display = 'inline-block';
    document.getElementById('changeDirBtn').disabled = false;
    document.getElementById('precisionSection').style.display = 'block';
    isDownloading = false;
  }
});

function formatSpeed(bytesPerSec) {
  if (bytesPerSec <= 0) return '';
  return formatBytes(bytesPerSec) + '/s';
}

function updateOverallProgress(overallDownloaded, overallTotal) {
  let percent = overallTotal > 0 ? Math.round(overallDownloaded / overallTotal * 100) : 0;
  percent = Math.min(Math.max(percent, 0), 100);
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
  // Skip main-model UI updates when an optional model (JP/SiFiGAN) is being
  // downloaded — those flows reuse the same IPC events but should not reset
  // the main model panel.
  if (jpState.isDownloading || sifiganState.isDownloading) {
    return;
  }
  missingFiles.length = 0;
  missingFiles.push(...files);
  // 清除旧的文件状态
  for (const key in fileStates) {
    delete fileStates[key];
  }
  for (const file of files) {
    fileStates[file.filePath] = { status: 'pending', progress: 0, downloaded: 0, total: 0 };
  }
  renderFileList(true);
  loadModelDir();
  // During an in-window update (updateModelBtn flow), isDownloading is true
  // and the progress section is already visible. Don't reset the UI back to
  // the "ready to download" state — the download is about to start.
  if (isDownloading) {
    document.getElementById('errorMessage').style.display = 'none';
    return;
  }
  document.getElementById('statusText').textContent = t('modelDownload.needDownloadCount', { count: files.length });
  document.getElementById('startBtn').style.display = 'inline-block';
  document.getElementById('closeBtn').style.display = 'inline-block';
  document.getElementById('precisionSection').style.display = 'block';
  document.getElementById('progressSection').style.display = 'none';
  document.getElementById('errorMessage').style.display = 'none';
});

window.electronAPI.onModelDownloadPrecision((precision) => {
  const newPrecision = precision || 'fp32';
  const changed = newPrecision !== currentPrecision;
  currentPrecision = newPrecision;
  const radio = document.querySelector(`input[name="modelPrecision"][value="${currentPrecision}"]`);
  if (radio) radio.checked = true;
  // Resolve the initial-precision promise so the first refreshVersionInfo()
  // call (in initI18n().then()) uses the real precision.
  if (resolveInitialPrecision) {
    const r = resolveInitialPrecision;
    resolveInitialPrecision = null;
    r();
  } else if (i18nReady && changed) {
    // Subsequent precision pushes (e.g. after delete-and-recheck) — refresh
    // version info so the UI reflects the new precision.
    refreshVersionInfo();
    // JP model status depends on precision (JP files live under <precision>/JP/)
    refreshJpCard();
  }
});

// Receive initial revision context from main process when window opens
window.electronAPI.onModelDownloadRevision((revision) => {
  if (revision && typeof revision === 'string' && revision !== 'latest') {
    currentRevision = revision;
    const select = document.getElementById('versionSelect');
    if (select && Array.from(select.options).some(opt => opt.value === revision)) {
      select.value = revision;
    }
  }
});

window.electronAPI.onModelDownloadProgress((data) => {
  // Skip main-model UI updates when an optional model (JP/SiFiGAN) is being
  // downloaded — those flows reuse the same IPC events but should not update
  // the main model progress bar / file list.
  if (jpState.isDownloading || sifiganState.isDownloading) {
    return;
  }
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
  // Skip for optional model downloads (JP/SiFiGAN)
  if (jpState.isDownloading || sifiganState.isDownloading) {
    return;
  }
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
  // Skip for optional model downloads (JP/SiFiGAN)
  if (jpState.isDownloading || sifiganState.isDownloading) {
    return;
  }
  const state = fileStates[data.filePath];
  if (state) {
    state.status = 'complete';
  }
  renderFileList();
});

window.electronAPI.onModelDownloadComplete(() => {
  // JP/SiFiGAN downloads reuse the same 'complete' event. Route to the right
  // card refresh and skip main-model UI updates. Note: isDownloading flags
  // may have already been reset by the click handler's finally block (the
  // IPC event can fire before or after the await returns), so we check
  // isDownloading (main model) first — if it's true, this is a main model
  // download. Otherwise, treat it as an optional model completion and
  // refresh all optional cards.
  if (!isDownloading) {
    // Optional model (JP or SiFiGAN) completed — refresh both cards
    jpState.isDownloading = false;
    sifiganState.isDownloading = false;
    refreshJpCard();
    refreshSifiganCard();
    updateOverviewStatus();
    return;
  }
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
  // 刷新版本信息（下载完成后版本应已更新）
  refreshVersionInfo();
  updateOverviewStatus();
});

window.electronAPI.onModelDownloadError((data) => {
  // Optional model error — refresh cards and skip main-model UI updates
  if (!isDownloading) {
    jpState.isDownloading = false;
    sifiganState.isDownloading = false;
    if (data && data.message) showJpTooltip(data.message);
    refreshJpCard();
    refreshSifiganCard();
    updateOverviewStatus();
    return;
  }
  document.getElementById('statusText').textContent = t('modelDownload.downloadFailed');
  document.getElementById('speedInfo').textContent = '';
  document.getElementById('errorMessage').textContent = data.message || '未知错误';
  document.getElementById('errorMessage').style.display = 'block';
  document.getElementById('cancelBtn').style.display = 'none';
  document.getElementById('closeBtn').style.display = 'inline-block';
  document.getElementById('changeDirBtn').disabled = false;
  isDownloading = false;
});

document.getElementById('startBtn').addEventListener('click', async () => {
  const selectedRadio = document.querySelector('input[name="modelPrecision"]:checked');
  currentPrecision = selectedRadio ? selectedRadio.value : 'fp16';

  // When the target revision is v0 or null (no real version), warn the user
  // that v0 and legacy content are identical before starting the download.
  if (isMainModelTargetV0OrLegacy()) {
    const confirmed = await showConfirmDialog(t('modelDownload.v0LegacyConfirmMessage'));
    if (!confirmed) return;
  }

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

  const result = await window.electronAPI.modelDownloadStart(currentPrecision, currentRevision);
  if (result && !result.success && result.error) {
    document.getElementById('statusText').textContent = t('modelDownload.downloadNotAvailable');
    document.getElementById('speedInfo').textContent = '';
    document.getElementById('errorMessage').textContent = result.error;
    document.getElementById('errorMessage').style.display = 'block';
    document.getElementById('cancelBtn').style.display = 'none';
    document.getElementById('closeBtn').style.display = 'inline-block';
    document.getElementById('changeDirBtn').disabled = false;
    document.getElementById('precisionSection').style.display = 'block';
    document.getElementById('progressSection').style.display = 'none';
    isDownloading = false;
  }
});

// 精度切换时检查对应模型文件（不删除已有文件，不同精度可共存）
document.querySelectorAll('input[name="modelPrecision"]').forEach(radio => {
  radio.addEventListener('change', async (e) => {
    if (isDownloading) return;
    const newPrecision = e.target.value;
    if (newPrecision === currentPrecision) return;

    currentPrecision = newPrecision;
    document.getElementById('statusText').textContent = t('modelDownload.detecting');
    document.getElementById('startBtn').style.display = 'none';
    // 切换精度时刷新版本信息
    refreshVersionInfo();
    // 切换精度时也刷新 JP 卡片（JP 文件存放在 <precision>/JP/ 下）
    refreshJpCard();
    try {
      await window.electronAPI.modelDownloadRecheck(currentPrecision);
    } catch (err) {
      console.error('Failed to recheck model files:', err);
    }
  });
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

// ===== JP (Japanese LoRA) card rendering & state management =====
// The JP card is an optional model group. The download is triggered via
// model-download:start-jp, which sends the same IPC events as the main
// model download (model-download:file-complete / model-download:complete).
// To prevent these events from resetting the main model panel, the global
// event callbacks above check jpState.isDownloading / sifiganState.isDownloading
// and route the refresh to the correct card.

const jpState = {
  status: 'checking', // 'installed' | 'not_downloaded' | 'checking' | 'downloading'
  isDownloading: false,
  versionInfo: null, // { updateAvailable, localVersion, latestVersion, hasModelFiles }
};

function setJpStatusText(text) {
  const el = document.getElementById('jpStatusText');
  if (el) el.textContent = text;
}

function setJpStatusIndicator(state) {
  // state: 'installed' | 'not_downloaded' | 'checking' | 'downloading'
  const el = document.getElementById('jpStatusIndicator');
  if (!el) return;
  el.className = 'status-indicator ' + state;
}

function showJpTooltip(message) {
  const el = document.getElementById('jpTooltip');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.style.display = 'block';
    el.classList.add('visible');
  } else {
    el.style.display = 'none';
    el.classList.remove('visible');
  }
}

function renderJpCard() {
  const downloadBtn = document.getElementById('jpDownloadBtn');
  const unloadBtn = document.getElementById('jpUnloadBtn');
  const progress = document.getElementById('jpProgress');
  const versionText = document.getElementById('jpVersionText');
  const updateBtn = document.getElementById('jpUpdateBtn');
  if (!downloadBtn || !unloadBtn) return;

  // Reset transient visibility
  progress.style.display = 'none';
  if (versionText) versionText.textContent = '';
  if (updateBtn) updateBtn.style.display = 'none';

  switch (jpState.status) {
    case 'installed': {
      downloadBtn.style.display = 'none';
      unloadBtn.style.display = 'inline-block';
      unloadBtn.disabled = false;
      downloadBtn.disabled = false;
      setJpStatusIndicator('installed');
      setJpStatusText(t('modelDownload.jpInstalled'));
      showJpTooltip('');
      if (jpState.versionInfo && versionText) {
        const v = jpState.versionInfo;
        const localStr = v.localVersion || t('modelDownload.legacyVersion');
        versionText.textContent = t('modelDownload.versionDisplay', { local: localStr, latest: v.latestVersion || '-' });
        if (v.updateAvailable && updateBtn) {
          updateBtn.style.display = 'inline-block';
        }
      }
      break;
    }
    case 'not_downloaded': {
      downloadBtn.style.display = 'inline-block';
      unloadBtn.style.display = 'none';
      downloadBtn.disabled = false;
      setJpStatusIndicator('not_downloaded');
      setJpStatusText(t('modelDownload.jpNotDownloaded'));
      showJpTooltip('');
      break;
    }
    case 'downloading': {
      downloadBtn.style.display = 'inline-block';
      downloadBtn.disabled = true;
      unloadBtn.style.display = 'none';
      progress.style.display = 'block';
      setJpStatusIndicator('downloading');
      setJpStatusText(t('modelDownload.checking'));
      break;
    }
    case 'checking':
    default: {
      downloadBtn.style.display = 'inline-block';
      downloadBtn.disabled = true;
      unloadBtn.style.display = 'none';
      setJpStatusIndicator('checking');
      setJpStatusText(t('modelDownload.checking'));
      showJpTooltip('');
      break;
    }
  }
}

async function refreshJpCard() {
  jpState.status = 'checking';
  renderJpCard();
  try {
    const result = await window.electronAPI.modelDownloadCheckJp(currentPrecision);
    if (result && result.missing && result.missing.length === 0) {
      jpState.status = 'installed';
      try {
        jpState.versionInfo = await window.electronAPI.modelDownloadCheckJpVersion(currentPrecision);
      } catch (_) { jpState.versionInfo = null; }
    } else {
      jpState.status = 'not_downloaded';
      jpState.versionInfo = null;
    }
  } catch (err) {
    console.error('[JP] status check failed:', err);
    jpState.status = 'not_downloaded';
    jpState.versionInfo = null;
  }
  renderJpCard();
  updateOverviewStatus();
}

document.getElementById('jpDownloadBtn').addEventListener('click', async () => {
  if (jpState.isDownloading) return;
  jpState.isDownloading = true;
  jpState.status = 'downloading';
  renderJpCard();
  try {
    const result = await window.electronAPI.modelDownloadStartJp(currentPrecision, 'latest');
    if (result && result.success === false && result.error) {
      showJpTooltip(result.error);
      jpState.status = 'not_downloaded';
    } else {
      // Refresh state after download
      const checkResult = await window.electronAPI.modelDownloadCheckJp(currentPrecision);
      if (checkResult && checkResult.missing && checkResult.missing.length === 0) {
        jpState.status = 'installed';
        try {
          jpState.versionInfo = await window.electronAPI.modelDownloadCheckJpVersion(currentPrecision);
        } catch (_) { jpState.versionInfo = null; }
      } else {
        jpState.status = 'not_downloaded';
      }
    }
  } catch (err) {
    console.error('[JP] download failed:', err);
    showJpTooltip(err.message || t('modelDownload.jpDownloadFailed'));
    jpState.status = 'not_downloaded';
  } finally {
    jpState.isDownloading = false;
    renderJpCard();
    updateOverviewStatus();
  }
});

document.getElementById('jpUnloadBtn').addEventListener('click', async () => {
  if (jpState.isDownloading) return;
  // Inform user that frontend unloading is not supported in this version
  await showConfirmDialog(t('modelDownload.jpUnloadNotSupported'));
});

document.getElementById('jpUpdateBtn').addEventListener('click', async () => {
  if (jpState.isDownloading) return;
  const confirmed = await showConfirmDialog(t('modelDownload.jpUpdateConfirmMessage'));
  if (!confirmed) return;
  jpState.isDownloading = true;
  jpState.status = 'downloading';
  renderJpCard();
  try {
    // Delete existing files then re-download
    await window.electronAPI.modelDownloadUpdateJp(currentPrecision, 'latest');
    const result = await window.electronAPI.modelDownloadStartJp(currentPrecision, 'latest');
    if (result && result.success === false && result.error) {
      showJpTooltip(result.error);
      jpState.status = 'not_downloaded';
    } else {
      const checkResult = await window.electronAPI.modelDownloadCheckJp(currentPrecision);
      if (checkResult && checkResult.missing && checkResult.missing.length === 0) {
        jpState.status = 'installed';
        try {
          jpState.versionInfo = await window.electronAPI.modelDownloadCheckJpVersion(currentPrecision);
        } catch (_) { jpState.versionInfo = null; }
      } else {
        jpState.status = 'not_downloaded';
      }
    }
  } catch (err) {
    console.error('[JP] update failed:', err);
    showJpTooltip(err.message || t('modelDownload.jpDownloadFailed'));
    jpState.status = 'not_downloaded';
  } finally {
    jpState.isDownloading = false;
    renderJpCard();
    updateOverviewStatus();
  }
});

// ===== Overview section: aggregate status of all three model groups =====
// Updates the three overview cards at the top of the download window based
// on the current main / jp / sifigan state. Called whenever a model group's
// state changes (after refresh, after download, etc.).

function setOverviewCard(groupId, dotState, statusText) {
  const dot = document.getElementById(`overview${groupId.charAt(0).toUpperCase() + groupId.slice(1)}Dot`);
  const status = document.getElementById(`overview${groupId.charAt(0).toUpperCase() + groupId.slice(1)}Status`);
  if (dot) dot.className = 'overview-dot ' + dotState;
  if (status && statusText) status.textContent = statusText;
}

function updateOverviewStatus() {
  const section = document.getElementById('overviewSection');
  if (!section) return;
  section.style.display = 'flex';

  // Main model: derive from currentVersionInfo (refreshVersionInfo populates it)
  let mainState = 'checking';
  let mainText = t('modelDownload.overviewChecking');
  if (currentVersionInfo) {
    if (currentVersionInfo.hasModelFiles) {
      mainState = currentVersionInfo.updateAvailable ? 'warning' : 'installed';
      mainText = currentVersionInfo.updateAvailable
        ? t('modelDownload.overviewUpdateAvailable')
        : t('modelDownload.overviewReady');
    } else {
      mainState = 'missing';
      mainText = t('modelDownload.overviewMissing');
    }
  }
  // When main model is downloading, override to 'checking' (animated)
  if (isDownloading) {
    mainState = 'checking';
    mainText = t('modelDownload.overviewDownloading');
  }
  setOverviewCard('main', mainState, mainText);

  // JP model
  let jpDotState = 'checking';
  let jpText = t('modelDownload.overviewChecking');
  if (jpState.status === 'installed') {
    jpDotState = (jpState.versionInfo && jpState.versionInfo.updateAvailable) ? 'warning' : 'installed';
    jpText = (jpState.versionInfo && jpState.versionInfo.updateAvailable)
      ? t('modelDownload.overviewUpdateAvailable')
      : t('modelDownload.overviewReady');
  } else if (jpState.status === 'not_downloaded') {
    jpDotState = 'missing';
    jpText = t('modelDownload.overviewMissing');
  } else if (jpState.status === 'downloading') {
    jpDotState = 'checking';
    jpText = t('modelDownload.overviewDownloading');
  }
  setOverviewCard('jp', jpDotState, jpText);

  // SiFiGAN
  let sifiganDotState = 'checking';
  let sifiganText = t('modelDownload.overviewChecking');
  if (sifiganState.status === 'installed') {
    sifiganDotState = (sifiganState.versionInfo && sifiganState.versionInfo.updateAvailable) ? 'warning' : 'installed';
    sifiganText = (sifiganState.versionInfo && sifiganState.versionInfo.updateAvailable)
      ? t('modelDownload.overviewUpdateAvailable')
      : t('modelDownload.overviewReady');
  } else if (sifiganState.status === 'not_downloaded' || sifiganState.status === 'download_url_not_configured') {
    sifiganDotState = 'missing';
    sifiganText = t('modelDownload.overviewMissing');
  } else if (sifiganState.status === 'downloading') {
    sifiganDotState = 'checking';
    sifiganText = t('modelDownload.overviewDownloading');
  }
  setOverviewCard('sifigan', sifiganDotState, sifiganText);
}

// ===== SiFiGAN card rendering & state management =====
// The SiFiGAN card is an independent optional model group. Its download
// short-circuits on the main process when MODEL_IDS.sifigan is empty, so
// the UI must gracefully handle the 'download_url_not_configured' status
// by disabling the download button and showing a tooltip explaining the
// situation (user should wait for the author to upload to ModelScope, or
// manually place the model files in onnx_models/).

const sifiganState = {
  status: 'checking', // 'installed' | 'not_downloaded' | 'download_url_not_configured' | 'checking' | 'downloading'
  files: null,
  isDownloading: false,
  versionInfo: null, // { updateAvailable, localVersion, latestVersion, hasModelFiles }
};

function setSifiganStatusText(text) {
  const el = document.getElementById('sifiganStatusText');
  if (el) el.textContent = text;
  // 同步更新折叠摘要的状态文字，便于用户在折叠时查看
  const summaryEl = document.getElementById('optionalSummaryStatus');
  if (summaryEl) summaryEl.textContent = text;
}

function setSifiganStatusIndicator(state) {
  // state: 'installed' | 'not_downloaded' | 'warning' | 'checking' | 'downloading'
  const el = document.getElementById('sifiganStatusIndicator');
  if (!el) return;
  el.className = 'status-indicator ' + state;
}

function showSifiganTooltip(message) {
  const el = document.getElementById('sifiganTooltip');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.style.display = 'block';
    el.classList.add('visible');
  } else {
    el.style.display = 'none';
    el.classList.remove('visible');
  }
}

function renderSifiganCard() {
  const downloadBtn = document.getElementById('sifiganDownloadBtn');
  const unloadBtn = document.getElementById('sifiganUnloadBtn');
  const progress = document.getElementById('sifiganProgress');
  const versionText = document.getElementById('sifiganVersionText');
  const updateBtn = document.getElementById('sifiganUpdateBtn');
  if (!downloadBtn || !unloadBtn) return;

  // Reset visibility
  progress.style.display = 'none';
  if (versionText) versionText.textContent = '';
  if (updateBtn) updateBtn.style.display = 'none';

  switch (sifiganState.status) {
    case 'installed': {
      downloadBtn.style.display = 'none';
      unloadBtn.style.display = 'inline-block';
      unloadBtn.disabled = false;
      downloadBtn.disabled = false;
      setSifiganStatusIndicator('installed');
      setSifiganStatusText(t('modelDownload.sifiganInstalled'));
      showSifiganTooltip('');
      // 显示版本信息和更新按钮
      if (sifiganState.versionInfo && versionText) {
        const v = sifiganState.versionInfo;
        const localStr = v.localVersion || t('modelDownload.legacyVersion');
        versionText.textContent = t('modelDownload.versionDisplay', { local: localStr, latest: v.latestVersion || '-' });
        if (v.updateAvailable && updateBtn) {
          updateBtn.style.display = 'inline-block';
        }
      }
      break;
    }
    case 'not_downloaded': {
      downloadBtn.style.display = 'inline-block';
      unloadBtn.style.display = 'none';
      downloadBtn.disabled = false;
      setSifiganStatusIndicator('not_downloaded');
      setSifiganStatusText(t('modelDownload.sifiganNotDownloaded'));
      showSifiganTooltip('');
      break;
    }
    case 'download_url_not_configured': {
      // Disable download button and show explanatory tooltip
      downloadBtn.style.display = 'inline-block';
      unloadBtn.style.display = 'none';
      downloadBtn.disabled = true;
      setSifiganStatusIndicator('warning');
      setSifiganStatusText(t('modelDownload.sifiganUrlNotConfigured'));
      showSifiganTooltip(t('modelDownload.sifiganUrlNotConfiguredTooltip'));
      break;
    }
    case 'downloading': {
      downloadBtn.style.display = 'inline-block';
      downloadBtn.disabled = true;
      unloadBtn.style.display = 'none';
      progress.style.display = 'block';
      setSifiganStatusIndicator('downloading');
      break;
    }
    case 'checking':
    default: {
      downloadBtn.style.display = 'inline-block';
      downloadBtn.disabled = true;
      unloadBtn.style.display = 'none';
      setSifiganStatusIndicator('checking');
      setSifiganStatusText(t('modelDownload.checking'));
      showSifiganTooltip('');
      break;
    }
  }
}

async function refreshSifiganCard() {
  sifiganState.status = 'checking';
  renderSifiganCard();
  try {
    const result = await window.electronAPI.modelDownloadCheckSifigan();
    sifiganState.status = result.status;
    sifiganState.files = result.files;
    // 检查 SiFiGAN 版本
    if (result.allExist) {
      try {
        sifiganState.versionInfo = await window.electronAPI.modelDownloadCheckSifiganVersion();
      } catch (_) {
        sifiganState.versionInfo = null;
      }
    } else {
      sifiganState.versionInfo = null;
    }
  } catch (err) {
    console.error('[SiFiGAN] status check failed:', err);
    sifiganState.status = 'download_url_not_configured';
  }
  renderSifiganCard();
  updateOverviewStatus();
}

document.getElementById('sifiganDownloadBtn').addEventListener('click', async () => {
  if (sifiganState.isDownloading) return;
  // Warn if SiFiGAN's latest version is v0 or null (same as legacy content).
  if (isSifiganTargetV0OrLegacy()) {
    const confirmed = await showConfirmDialog(t('modelDownload.v0LegacyConfirmMessage'));
    if (!confirmed) return;
  }
  sifiganState.isDownloading = true;
  sifiganState.status = 'downloading';
  renderSifiganCard();
  try {
    const result = await window.electronAPI.modelDownloadStartSifigan();
    if (result.status === 'download_url_not_configured') {
      // Main process short-circuited because MODEL_IDS.sifigan is empty.
      // Disable the download button and show the tooltip explaining how
      // to obtain the model.
      sifiganState.status = 'download_url_not_configured';
      sifiganState.files = result.files;
    } else if (result.status === 'installed') {
      sifiganState.status = 'installed';
      sifiganState.files = result.files;
      // 下载完成后刷新版本信息
      try {
        sifiganState.versionInfo = await window.electronAPI.modelDownloadCheckSifiganVersion();
      } catch (_) { sifiganState.versionInfo = null; }
    } else {
      sifiganState.status = 'not_downloaded';
      sifiganState.files = result.files;
    }
  } catch (err) {
    console.error('[SiFiGAN] download failed:', err);
    sifiganState.status = 'download_url_not_configured';
  } finally {
    sifiganState.isDownloading = false;
    renderSifiganCard();
  }
});

document.getElementById('sifiganUnloadBtn').addEventListener('click', async () => {
  if (sifiganState.isDownloading) return;
  // Confirm before deleting model files
  const confirmed = await showConfirmDialog(t('modelDownload.sifiganUnloadConfirmMessage'));
  if (!confirmed) return;

  sifiganState.isDownloading = true;
  try {
    const result = await window.electronAPI.modelDownloadUnloadSifigan();
    sifiganState.status = result.status || 'download_url_not_configured';
    sifiganState.files = result.files;
    sifiganState.versionInfo = null;
  } catch (err) {
    console.error('[SiFiGAN] unload failed:', err);
    // Re-check on failure to get the actual state
  } finally {
    sifiganState.isDownloading = false;
    renderSifiganCard();
  }
});

// SiFiGAN 更新按钮：删除旧文件后重新下载
document.getElementById('sifiganUpdateBtn').addEventListener('click', async () => {
  if (sifiganState.isDownloading) return;
  const confirmMsg = isSifiganTargetV0OrLegacy()
    ? t('modelDownload.v0LegacyConfirmMessage')
    : t('modelDownload.sifiganUpdateConfirmMessage');
  const confirmed = await showConfirmDialog(confirmMsg);
  if (!confirmed) return;

  sifiganState.isDownloading = true;
  sifiganState.status = 'downloading';
  renderSifiganCard();
  try {
    // 先删除旧文件（含版本文件），再触发下载
    await window.electronAPI.modelDownloadUpdateSifigan();
    const result = await window.electronAPI.modelDownloadStartSifigan();
    if (result.status === 'installed') {
      sifiganState.status = 'installed';
      sifiganState.files = result.files;
      try {
        sifiganState.versionInfo = await window.electronAPI.modelDownloadCheckSifiganVersion();
      } catch (_) { sifiganState.versionInfo = null; }
    } else {
      sifiganState.status = 'not_downloaded';
      sifiganState.files = result.files;
    }
  } catch (err) {
    console.error('[SiFiGAN] update failed:', err);
    sifiganState.status = 'download_url_not_configured';
  } finally {
    sifiganState.isDownloading = false;
    renderSifiganCard();
  }
});

// Version selector: update currentRevision when user picks a different version
document.getElementById('versionSelect').addEventListener('change', (e) => {
  if (isDownloading) {
    // revert selection during download
    e.target.value = currentRevision;
    return;
  }
  const newRevision = e.target.value;
  if (newRevision && newRevision !== currentRevision) {
    currentRevision = newRevision;
  }
});

// Open model-updates docs page in system default browser
document.getElementById('modelUpdatesLink').addEventListener('click', async (e) => {
  e.preventDefault();
  await window.electronAPI.modelDownloadOpenExternal('https://henley04.github.io/SXSEditor/user/model-updates.html');
});

initI18n().then(async () => {
  applyLocale();
  document.documentElement.lang = getLocale();
  i18nReady = true;
  // Wait for the main process to push the real precision before querying
  // the version — otherwise an FP32 install would briefly show the FP16
  // version. Fall back after a short timeout in case the push never arrives.
  await Promise.race([
    initialPrecisionReady,
    new Promise((r) => setTimeout(r, 1000)),
  ]);
  // Refresh SiFiGAN card once i18n is ready so status text is translated
  refreshSifiganCard();
  // Refresh JP card after precision is known
  refreshJpCard();
  // 检查主模型版本信息
  refreshVersionInfo();
  // Initial overview status (will be re-updated as each refresh completes)
  updateOverviewStatus();
});

// Apply saved theme
initWindowTheme();
