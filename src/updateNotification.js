import './common.css';
import './updateNotification.css';
import { t, initI18n, applyLocale, getLocale } from './i18n/index.js';
import { initWindowTheme } from './themes/themeInit.js';

// Cached result so button handlers can access data.app.downloadUrl / latestVersion
let currentData = null;

const MODEL_LABELS = {
  main: 'Main',
  jp: 'JP',
  sifigan: 'SiFiGAN',
};

function applyTranslations() {
  // applyLocale() iterates [data-i18n] elements and sets textContent = t(key)
  applyLocale();
}

/**
 * Render a "view release notes" link into the target element.
 * The link opens the given URL in the external browser via the update API's
 * openDownloadPage IPC (which enforces the URL whitelist).
 */
function renderReleaseNotesLink(el, url) {
  if (!url) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<a href="#" class="release-notes-link">${t('update.viewReleaseNotesLink')}</a>`;
  const link = el.querySelector('a');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.electronAPI.updateAPI.openDownloadPage(url);
    });
  }
}

function formatBytes(n) {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function render(data) {
  currentData = data || {};
  const app = currentData.app || {};
  const models = currentData.models || {};

  renderAppArea(app);
  renderModelArea(models);
  updateActionButtons(app, models);
}

function renderAppArea(app) {
  const area = document.getElementById('appUpdateArea');
  const releaseNotes = document.getElementById('releaseNotes');

  if (app.error) {
    // Show the app area as an error banner (no version rows, no update button)
    area.classList.remove('hidden');
    const errMsg = app.error === 'rate_limited'
      ? t('update.rateLimited')
      : t('update.networkError');
    releaseNotes.innerHTML = '';
    releaseNotes.textContent = errMsg;
    document.getElementById('appCurrentVersion').textContent = app.currentVersion || '-';
    document.getElementById('appLatestVersion').textContent = '-';
    document.getElementById('appPublishedAt').textContent = '-';
    return;
  }

  if (!app.updateAvailable) {
    // No app update: hide the app area entirely
    area.classList.add('hidden');
    return;
  }

  area.classList.remove('hidden');
  document.getElementById('appCurrentVersion').textContent = app.currentVersion || '-';
  document.getElementById('appLatestVersion').textContent = app.latestVersion || '-';
  document.getElementById('appPublishedAt').textContent = app.publishedAt || '-';

  // Render a link to the release notes page (opened in external browser)
  renderReleaseNotesLink(releaseNotes, app.appReleaseNotesUrl);
}

function renderModelArea(models) {
  const area = document.getElementById('modelUpdateArea');
  const list = document.getElementById('modelUpdateList');
  const notesWrapper = document.getElementById('modelReleaseNotesWrapper');
  const notesEl = document.getElementById('modelReleaseNotes');

  if (!models) {
    area.classList.add('hidden');
    list.innerHTML = '';
    notesWrapper.classList.add('hidden');
    return;
  }

  if (models.error) {
    // Model check failed — show the error so the user knows why no updates
    // are reported (e.g. network failure, ModelScope API unreachable).
    area.classList.remove('hidden');
    list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'model-error';
    li.textContent = t('update.modelCheckError');
    list.appendChild(li);
    notesWrapper.classList.add('hidden');
    return;
  }

  if (!models.anyUpdateAvailable) {
    area.classList.add('hidden');
    list.innerHTML = '';
    notesWrapper.classList.add('hidden');
    return;
  }

  area.classList.remove('hidden');
  list.innerHTML = '';

  const entries = [['main', models.main], ['jp', models.jp], ['sifigan', models.sifigan]];
  for (const [key, info] of entries) {
    if (!info || !info.updateAvailable) continue;
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = MODEL_LABELS[key] || key;
    const version = document.createElement('span');
    version.className = 'model-version';
    const local = info.localVersion
      ? info.localVersion
      : t('modelDownload.legacyVersion');
    version.textContent = `${local} → ${info.latestVersion || '-'}`;
    li.appendChild(name);
    li.appendChild(version);
    list.appendChild(li);
  }

  // Render a link to the model release notes page (opened in external browser)
  renderReleaseNotesLink(notesEl, models.modelReleaseNotesUrl);
  notesWrapper.classList.remove('hidden');
}

function updateActionButtons(app, _models) {
  const updateNowBtn = document.getElementById('updateNowBtn');
  const skipVersionBtn = document.getElementById('skipVersionBtn');
  const dontRemindBtn = document.getElementById('dontRemindBtn');
  const hasAppUpdate = !!(app && app.updateAvailable && !app.error);
  updateNowBtn.hidden = !hasAppUpdate;
  skipVersionBtn.hidden = !hasAppUpdate;
  dontRemindBtn.hidden = !hasAppUpdate;
}

function showDownloadProgress() {
  document.getElementById('downloadProgressContainer').classList.remove('hidden');
  document.getElementById('updateNowBtn').hidden = true;
  document.getElementById('skipVersionBtn').hidden = true;
  document.getElementById('dontRemindBtn').hidden = true;
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('downloadSize').textContent = '0%';
  document.getElementById('downloadStatus').textContent = t('update.downloading');
}

function hideDownloadProgress() {
  document.getElementById('downloadProgressContainer').classList.add('hidden');
}

function setProgress(percent, received, total) {
  const pct = Math.max(0, Math.min(100, percent || 0));
  document.getElementById('progressBar').style.width = `${pct.toFixed(1)}%`;
  const sizeEl = document.getElementById('downloadSize');
  if (total > 0) {
    sizeEl.textContent = `${pct.toFixed(1)}% (${formatBytes(received)} / ${formatBytes(total)})`;
  } else {
    sizeEl.textContent = `${formatBytes(received)}`;
  }
}

let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4000);
}

function wireDownloadHandlers() {
  const api = window.electronAPI && window.electronAPI.updateAPI;
  if (!api) return;

  // Replace the original "Update Now" behavior: instead of opening the
  // browser to GitHub, start an in-app download with a progress bar.
  document.getElementById('updateNowBtn').addEventListener('click', async () => {
    const app = currentData && currentData.app;
    if (!app || !app.downloadUrl) {
      showToast(t('update.networkError'));
      return;
    }
    showDownloadProgress();
    try {
      const result = await api.downloadInstaller(app.downloadUrl, app.latestVersion);
      // Success: the 'download-complete' event handler will trigger the installer.
      // If the IPC returns success:false without an event (rare), surface the error.
      if (result && result.success === false && result.error !== 'cancelled') {
        hideDownloadProgress();
        document.getElementById('updateNowBtn').hidden = false;
        const msg = result.error === 'download_in_progress'
          ? t('update.downloadInProgress')
          : t('update.downloadFailed');
        showToast(msg);
      }
    } catch (err) {
      console.error('[UpdateNotification] downloadInstaller failed:', err);
      hideDownloadProgress();
      document.getElementById('updateNowBtn').hidden = false;
      showToast(t('update.downloadFailed'));
    }
  });

  document.getElementById('cancelDownloadBtn').addEventListener('click', async () => {
    try {
      await api.cancelDownload();
    } catch (err) {
      console.error('[UpdateNotification] cancelDownload failed:', err);
    }
    hideDownloadProgress();
    const app = currentData && currentData.app;
    if (app && app.updateAvailable && !app.error) {
      document.getElementById('updateNowBtn').hidden = false;
      document.getElementById('skipVersionBtn').hidden = false;
      document.getElementById('dontRemindBtn').hidden = false;
    }
    showToast(t('update.downloadCancelled'));
  });

  // Main process pushes progress updates while the installer downloads.
  api.onDownloadProgress((data) => {
    setProgress(data.percent, data.received, data.total);
  });

  // When the download completes, automatically launch the installer.
  // The main process spawns the installer detached and quits the app.
  api.onDownloadComplete(async (data) => {
    setProgress(100, data.size, data.size);
    document.getElementById('downloadStatus').textContent = t('update.downloadComplete');
    document.getElementById('cancelDownloadBtn').disabled = true;
    try {
      const res = await api.installInstaller(data.filePath);
      if (res && res.success === false) {
        document.getElementById('downloadStatus').textContent = t('update.installFailed');
        document.getElementById('cancelDownloadBtn').disabled = false;
        showToast(t('update.installFailed'));
      } else {
        // App will quit shortly; show a transient status.
        document.getElementById('downloadStatus').textContent = t('update.startingInstaller');
      }
    } catch (err) {
      console.error('[UpdateNotification] installInstaller failed:', err);
      document.getElementById('downloadStatus').textContent = t('update.installFailed');
      document.getElementById('cancelDownloadBtn').disabled = false;
      showToast(t('update.installFailed'));
    }
  });

  // Surface download errors (non-cancel) with a toast and reset the UI.
  api.onDownloadError((data) => {
    console.error('[UpdateNotification] download error:', data && data.error);
    hideDownloadProgress();
    document.getElementById('updateNowBtn').hidden = false;
    document.getElementById('skipVersionBtn').hidden = false;
    document.getElementById('dontRemindBtn').hidden = false;
    showToast(t('update.downloadFailed'));
  });
}

function wireButtons() {
  wireDownloadHandlers();

  document.getElementById('openModelDownloadBtn').addEventListener('click', async () => {
    try {
      await window.electronAPI.updateAPI.openModelDownload();
    } catch (err) {
      console.error('[UpdateNotification] openModelDownload failed:', err);
    }
    window.close();
  });

  document.getElementById('skipVersionBtn').addEventListener('click', async () => {
    const version = currentData && currentData.app && currentData.app.latestVersion;
    if (!version) return;
    try {
      await window.electronAPI.updateAPI.skipVersion(version);
    } catch (err) {
      console.error('[UpdateNotification] skipVersion failed:', err);
    }
    window.close();
  });

  document.getElementById('dontRemindBtn').addEventListener('click', async () => {
    try {
      await window.electronAPI.updateAPI.dontRemind();
    } catch (err) {
      console.error('[UpdateNotification] dontRemind failed:', err);
    }
    window.close();
  });

  document.getElementById('closeBtn').addEventListener('click', () => {
    window.close();
  });
}

function onDOMContentLoaded() {
  applyTranslations();
  initWindowTheme();
  wireButtons();

  // Register IPC listener for notification data pushed by the main process
  const api = window.electronAPI && window.electronAPI.updateAPI;
  if (api && typeof api.onNotificationShow === 'function') {
    api.onNotificationShow((data) => render(data));
  } else {
    console.error('[UpdateNotification] updateAPI.onNotificationShow is not available');
  }
}

initI18n().then(() => {
  applyTranslations();
  document.documentElement.lang = getLocale();
});

// Apply saved theme
initWindowTheme();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onDOMContentLoaded);
} else {
  onDOMContentLoaded();
}
