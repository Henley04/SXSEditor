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

/**
 * Map the app locale ('en' | 'zh-CN') to the data-lang code used in the docs
 * HTML ('en' | 'zh').
 */
function docsLang() {
  return getLocale().startsWith('zh') ? 'zh' : 'en';
}

/**
 * Escape HTML special characters in a plain string so it can be safely
 * inserted via textContent. (We use innerHTML for structured notes because
 * they contain trusted formatting tags like <strong>, <code>, <kbd>.)
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize the inner HTML extracted from the docs site. Only a small whitelist
 * of formatting tags is allowed; everything else is stripped. This prevents
 * any unexpected content from the remote page being injected as raw HTML.
 *
 * Allowed tags: <strong>, <em>, <code>, <kbd>, <a>, <br>
 */
function sanitizeRichHtml(html) {
  if (!html) return '';
  // Decode common entities first so we can re-encode consistently
  let out = html;
  // Whitelist approach: replace allowed tags with placeholders, strip all
  // other tags, then restore the placeholders.
  const allowed = [];
  // Capture allowed tags (opening, closing, self-closing)
  out = out.replace(/<\/?(strong|em|code|kbd|a|br)\b[^>]*>/gi, (tag) => {
    const idx = allowed.length;
    allowed.push(tag);
    return `\x00${idx}\x00`;
  });
  // For <a> tags, only keep href
  for (let i = 0; i < allowed.length; i++) {
    const tag = allowed[i];
    if (/^<a\b/i.test(tag)) {
      const hrefMatch = tag.match(/href="([^"]*)"/i);
      const href = hrefMatch ? hrefMatch[1] : '#';
      allowed[i] = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">`;
    }
  }
  // Strip all remaining tags
  out = out.replace(/<[^>]+>/g, '');
  // Restore allowed tags
  out = out.replace(/\x00(\d+)\x00/g, (_, idx) => allowed[Number(idx)] || '');
  return out;
}

/**
 * Render structured release notes (from the official docs site) as HTML.
 * Returns an HTML string suitable for innerHTML.
 *
 * Structure: { sections: [{ title: {en, zh}, items: [{en, zh}, ...] }], intro: {en, zh}|null }
 */
function renderStructuredNotes(notes) {
  if (!notes || !notes.sections || notes.sections.length === 0) return '';
  const lang = docsLang();
  const parts = [];

  if (notes.intro) {
    const introText = notes.intro[lang] || notes.intro.en || notes.intro.zh;
    if (introText) {
      parts.push(`<p class="rn-intro">${sanitizeRichHtml(introText)}</p>`);
    }
  }

  for (const section of notes.sections) {
    const title = (section.title && (section.title[lang] || section.title.en || section.title.zh)) || '';
    if (title) {
      parts.push(`<h4 class="rn-section-title">${escapeHtml(title)}</h4>`);
    }
    if (section.items && section.items.length > 0) {
      const items = section.items
        .map((item) => {
          const text = item[lang] || item.en || item.zh || '';
          return `<li>${sanitizeRichHtml(text)}</li>`;
        })
        .join('');
      parts.push(`<ul class="rn-item-list">${items}</ul>`);
    }
  }

  return parts.join('');
}

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

  // Prefer structured release notes from the official docs site.
  // Fall back to GitHub body_html when the docs site is unreachable or the
  // version is not yet documented there.
  const structuredHtml = renderStructuredNotes(app.appReleaseNotes);
  if (structuredHtml) {
    releaseNotes.innerHTML = structuredHtml;
  } else if (typeof app.releaseNotesHtml === 'string') {
    releaseNotes.innerHTML = app.releaseNotesHtml;
  } else {
    releaseNotes.textContent = '';
  }
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

  // Render structured model release notes from the official docs site
  const notesHtml = renderStructuredNotes(models.modelReleaseNotes);
  if (notesHtml) {
    notesEl.innerHTML = notesHtml;
    notesWrapper.classList.remove('hidden');
  } else {
    notesEl.innerHTML = '';
    notesWrapper.classList.add('hidden');
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
