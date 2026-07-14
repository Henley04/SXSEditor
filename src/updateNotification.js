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

  // Release notes come from GitHub body_html (HTML content). Use innerHTML.
  if (typeof app.releaseNotesHtml === 'string') {
    releaseNotes.innerHTML = app.releaseNotesHtml;
  } else {
    releaseNotes.textContent = '';
  }
}

function renderModelArea(models) {
  const area = document.getElementById('modelUpdateArea');
  const list = document.getElementById('modelUpdateList');

  if (!models || !models.anyUpdateAvailable) {
    area.classList.add('hidden');
    list.innerHTML = '';
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
}

function updateActionButtons(app, models) {
  const updateNowBtn = document.getElementById('updateNowBtn');
  const skipVersionBtn = document.getElementById('skipVersionBtn');
  const dontRemindBtn = document.getElementById('dontRemindBtn');
  const hasAppUpdate = !!(app && app.updateAvailable && !app.error);
  updateNowBtn.hidden = !hasAppUpdate;
  skipVersionBtn.hidden = !hasAppUpdate;
  dontRemindBtn.hidden = !hasAppUpdate;
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

function wireButtons() {
  document.getElementById('updateNowBtn').addEventListener('click', async () => {
    const url = currentData && currentData.app && currentData.app.downloadUrl;
    try {
      await window.electronAPI.updateAPI.openDownloadPage(url);
      showToast(t('update.openBrowserHint'));
    } catch (err) {
      console.error('[UpdateNotification] openDownloadPage failed:', err);
    }
  });

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
