import './common.css';
import './singerMarket.css';
import { t, tOr, initI18n, applyLocale, getLocale } from './i18n/index.js';
import { initWindowTheme } from './themes/themeInit.js';
import { hydrateIcons } from './icons/iconHelper.js';

initI18n().then(() => {
  applyLocale();
  document.documentElement.lang = getLocale();
  hydrateIcons(document);
});

initWindowTheme();

// Build marker: verify in the market window's DevTools console that the
// running bundle includes the region-aware error state (vs. stale builds
// that still show "No singers found" on network failures).
console.log('[SingerMarket] UI build 2026-09-26.3 (detail loading state + tags/license fix)');

// ==================== State ====================
const state = {
  user: null,             // { id, username, is_admin } or null
  singers: [],            // current page of singer items
  tags: [],               // popular tags shown as filter suggestions
  activeTags: [],         // user-selected tag filter
  searchQuery: '',
  page: 1,
  pageSize: 24,
  totalCount: 0,
  totalPages: 1,
  loading: false,
  loadError: null,        // last list-load failure message; null on success
  loadErrorRegion: null,  // 'CN' when the failure is a region block (from main-process diagnostics)
  // Dialog state
  authMode: 'login',      // 'login' | 'register'
  uploadFile: null,       // { path, filename, singerName? } — populated when user picks a file
  detailSinger: null,     // singer currently shown in detail/download dialog
  detailLoading: false,   // true while a file-detail request is in flight
  detailSeq: 0,           // monotonically increasing; guards stale detail responses
  licenseCatalog: null,   // cached /api/licenses payload { items, default, ... }
  licenseCatalogLoading: false,
};

// ==================== DOM refs ====================
const dom = {
  // Toolbar
  authStatus: document.getElementById('auth-status'),
  btnLogin: document.getElementById('btn-login'),
  btnRegister: document.getElementById('btn-register'),
  btnLogout: document.getElementById('btn-logout'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnUpload: document.getElementById('btn-upload'),

  // Filter bar
  searchInput: document.getElementById('search-input'),
  tagSuggestions: document.getElementById('tag-suggestions'),
  activeTagChips: document.getElementById('active-tag-chips'),

  // Grid
  singerGrid: document.getElementById('singer-grid'),
  emptyState: document.getElementById('empty-state'),
  loadingState: document.getElementById('loading-state'),
  errorState: document.getElementById('error-state'),
  errorStateTitle: document.getElementById('error-state-title'),
  errorStateDetail: document.getElementById('error-state-detail'),
  btnRetry: document.getElementById('btn-retry'),

  // Pagination
  pagination: document.getElementById('pagination'),
  btnPrevPage: document.getElementById('btn-prev-page'),
  btnNextPage: document.getElementById('btn-next-page'),
  pageInfo: document.getElementById('page-info'),

  // Auth dialog
  authDialog: document.getElementById('auth-dialog'),
  authDialogTitle: document.getElementById('auth-dialog-title'),
  authUsername: document.getElementById('auth-username'),
  authPassword: document.getElementById('auth-password'),
  authError: document.getElementById('auth-error'),
  btnAuthCancel: document.getElementById('btn-auth-cancel'),
  btnAuthSubmit: document.getElementById('btn-auth-submit'),

  // Upload dialog
  uploadDialog: document.getElementById('upload-dialog'),
  uploadDropArea: document.getElementById('upload-drop-area'),
  uploadFileInput: document.getElementById('upload-file-input'),
  uploadInfo: document.getElementById('upload-info'),
  uploadFileName: document.getElementById('upload-file-name'),
  uploadSingerName: document.getElementById('upload-singer-name'),
  uploadDescription: document.getElementById('upload-description'),
  uploadTags: document.getElementById('upload-tags'),
  uploadVisibility: document.getElementById('upload-visibility'),
  uploadLicense: document.getElementById('upload-license'),
  btnUploadCancel: document.getElementById('btn-upload-cancel'),
  btnUploadSubmit: document.getElementById('btn-upload-submit'),

  // Detail / download dialog
  detailDialog: document.getElementById('detail-dialog'),
  detailTitle: document.getElementById('detail-title'),
  detailBody: document.getElementById('detail-body'),
  disclaimerLink: document.getElementById('disclaimer-link'),
  btnDetailCancel: document.getElementById('btn-detail-cancel'),
  btnDetailDownload: document.getElementById('btn-detail-download'),

  // Toast
  toastContainer: document.getElementById('toast-container'),
};

// Disclaimer link target — the legally controlling English version of the
// Singer Market Terms of Use (the Chinese translation is linked from that page).
const DISCLAIMER_URL = 'https://henley04.github.io/SXSEditor/singer-market-terms-en.html';

// ==================== Utility helpers ====================
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Generate a deterministic color from a string (for avatar fallback)
function colorFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 50%)`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (_) {
    return isoString;
  }
}

// The backend returns tags as objects ({ id, name, created_at }) but older
// shapes / upload echo paths may produce plain strings or { tag }. Normalize
// everything to display strings so tags never render as "[object Object]".
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => {
      if (typeof tag === 'string') return tag.trim();
      if (tag && typeof tag === 'object') {
        const name = tag.name || tag.tag || tag.label;
        return typeof name === 'string' ? name.trim() : '';
      }
      return '';
    })
    .filter(Boolean);
}

// Coerce any error payload into a displayable string — the IPC layer normally
// guarantees a string, but a stale/older main process may hand back objects.
function errorText(err, fallback) {
  if (typeof err === 'string' && err) return err;
  if (err && typeof err === 'object') {
    if (typeof err.error === 'string' && err.error) return err.error;
    if (err.error && typeof err.error.message === 'string') return err.error.message;
  }
  return fallback;
}

// ==================== License catalog ====================
async function ensureLicenseCatalog() {
  if (state.licenseCatalog || state.licenseCatalogLoading) return state.licenseCatalog;
  state.licenseCatalogLoading = true;
  try {
    const result = await apiLicenses();
    if (result.success && result.data && Array.isArray(result.data.items)) {
      state.licenseCatalog = result.data;
    }
  } catch (_) {
    // Non-fatal — the selector keeps its placeholder and upload proceeds
    // without an explicit license (server applies its default).
  } finally {
    state.licenseCatalogLoading = false;
  }
  return state.licenseCatalog;
}

// Populate the upload dialog's license <select> from the catalog. Preset
// licenses only; the "custom" slot (custom_allowed/custom_key) is omitted
// because uploading arbitrary license text is not part of the client contract.
function renderLicenseOptions() {
  const select = dom.uploadLicense;
  if (!select) return;
  const catalog = state.licenseCatalog;
  select.innerHTML = '';
  if (!catalog || !Array.isArray(catalog.items)) {
    select.innerHTML = `<option value="">${escapeHtml(tOr('singerMarket.licenseLoadFailed', 'License catalog unavailable'))}</option>`;
    return;
  }
  const customKey = catalog.custom_key;
  const presets = catalog.items.filter((item) => {
    if (!item || !item.key) return false;
    if (customKey && item.key === customKey) return false;
    if (item.custom === true) return false;
    return true;
  });
  for (const item of presets) {
    const opt = document.createElement('option');
    opt.value = item.key;
    const spdx = item.spdx ? ` (${escapeHtml(item.spdx)})` : '';
    opt.textContent = `${item.name || item.key}${spdx}`;
    select.appendChild(opt);
  }
  // Preselect the server-declared default license.
  if (catalog.default) {
    select.value = catalog.default;
    if (select.value !== catalog.default) select.selectedIndex = 0;
  }
}

// ==================== API wrappers ====================
async function apiLogin(username, password) {
  return window.electronAPI.singerMarket.login(username, password);
}
async function apiRegister(username, password) {
  return window.electronAPI.singerMarket.register(username, password);
}
async function apiLogout() {
  return window.electronAPI.singerMarket.logout();
}
async function apiMe() {
  return window.electronAPI.singerMarket.me();
}
async function apiListSingers(params) {
  return window.electronAPI.singerMarket.list(params);
}
async function apiFileDetail(fileId) {
  return window.electronAPI.singerMarket.fileDetail(fileId);
}
async function apiTags(params) {
  return window.electronAPI.singerMarket.tags(params);
}
async function apiLicenses() {
  return window.electronAPI.singerMarket.licenses();
}
async function apiUpload(payload) {
  return window.electronAPI.singerMarket.upload(payload);
}
async function apiDownload(fileId) {
  return window.electronAPI.singerMarket.download(fileId);
}

// ==================== Auth UI ====================
async function refreshAuthState() {
  try {
    const result = await apiMe();
    if (result.success && result.user) {
      state.user = result.user;
      dom.authStatus.textContent = tOr('singerMarket.loggedInAs', 'Logged in as {name}', { name: result.user.username });
      dom.btnLogin.style.display = 'none';
      dom.btnRegister.style.display = 'none';
      dom.btnLogout.style.display = '';
      dom.btnUpload.style.display = '';
    } else {
      state.user = null;
      dom.authStatus.textContent = tOr('singerMarket.notLoggedIn', 'Not logged in');
      dom.btnLogin.style.display = '';
      dom.btnRegister.style.display = '';
      dom.btnLogout.style.display = 'none';
      dom.btnUpload.style.display = 'none';
    }
  } catch (_) {
    state.user = null;
  }
}

function openAuthDialog(mode) {
  state.authMode = mode;
  dom.authDialogTitle.textContent = mode === 'register'
    ? tOr('singerMarket.registerTitle', 'Register')
    : tOr('singerMarket.loginTitle', 'Login');
  dom.authUsername.value = '';
  dom.authPassword.value = '';
  dom.authError.style.display = 'none';
  dom.authError.textContent = '';
  dom.authDialog.style.display = 'flex';
  setTimeout(() => dom.authUsername.focus(), 50);
}

function closeAuthDialog() {
  dom.authDialog.style.display = 'none';
}

dom.btnLogin.addEventListener('click', () => openAuthDialog('login'));
dom.btnRegister.addEventListener('click', () => openAuthDialog('register'));
dom.btnAuthCancel.addEventListener('click', closeAuthDialog);
dom.authDialog.addEventListener('click', (e) => {
  if (e.target === dom.authDialog) closeAuthDialog();
});

dom.btnAuthSubmit.addEventListener('click', async () => {
  const username = dom.authUsername.value.trim();
  const password = dom.authPassword.value;
  if (!username || !password) {
    dom.authError.textContent = tOr('singerMarket.fillAllFields', 'Please fill in all fields');
    dom.authError.style.display = '';
    return;
  }
  dom.btnAuthSubmit.disabled = true;
  try {
    const result = state.authMode === 'register'
      ? await apiRegister(username, password)
      : await apiLogin(username, password);
    if (result.success) {
      closeAuthDialog();
      await refreshAuthState();
      showToast(
        state.authMode === 'register'
          ? tOr('singerMarket.registerSuccess', 'Registration successful')
          : tOr('singerMarket.loginSuccess', 'Login successful'),
        'success'
      );
      await loadSingers();
    } else {
      dom.authError.textContent = result.error || tOr('singerMarket.authFailed', 'Authentication failed');
      dom.authError.style.display = '';
    }
  } catch (err) {
    dom.authError.textContent = err.message;
    dom.authError.style.display = '';
  } finally {
    dom.btnAuthSubmit.disabled = false;
  }
});

dom.authPassword.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dom.btnAuthSubmit.click();
});
dom.authUsername.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dom.authPassword.focus();
});

dom.btnLogout.addEventListener('click', async () => {
  await apiLogout();
  state.user = null;
  await refreshAuthState();
  showToast(tOr('singerMarket.loggedOut', 'Logged out'), 'info');
  await loadSingers();
});

// ==================== Search & filter ====================
let _searchDebounceTimer = null;
dom.searchInput.addEventListener('input', () => {
  state.searchQuery = dom.searchInput.value.trim();
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    state.page = 1;
    loadSingers();
  }, 350);
});

function toggleActiveTag(tag) {
  const idx = state.activeTags.indexOf(tag);
  if (idx >= 0) {
    state.activeTags.splice(idx, 1);
  } else {
    state.activeTags.push(tag);
  }
  state.page = 1;
  renderTagSuggestions();
  renderActiveTagChips();
  loadSingers();
}

function renderTagSuggestions() {
  dom.tagSuggestions.innerHTML = '';
  if (state.tags.length === 0) return;
  state.tags.slice(0, 15).forEach((tag) => {
    const chip = document.createElement('div');
    chip.className = 'tag-chip' + (state.activeTags.includes(tag) ? ' active' : '');
    chip.textContent = tag;
    chip.addEventListener('click', () => toggleActiveTag(tag));
    dom.tagSuggestions.appendChild(chip);
  });
}

function renderActiveTagChips() {
  dom.activeTagChips.innerHTML = '';
  state.activeTags.forEach((tag) => {
    const chip = document.createElement('div');
    chip.className = 'filter-chip';
    chip.innerHTML = `<span>${escapeHtml(tag)}</span>`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'filter-chip-remove';
    removeBtn.textContent = '×';
    removeBtn.title = tOr('singerMarket.removeTag', 'Remove tag');
    removeBtn.addEventListener('click', () => toggleActiveTag(tag));
    chip.appendChild(removeBtn);
    dom.activeTagChips.appendChild(chip);
  });
}

async function loadPopularTags() {
  try {
    const result = await apiTags({ limit: 30 });
    if (result.success && Array.isArray(result.data)) {
      // API may return either array of strings or array of { name, count }
      state.tags = normalizeTags(result.data);
      renderTagSuggestions();
    }
  } catch (_) {
    // Non-fatal — tag suggestions are optional.
  }
}

// ==================== Singer list ====================
async function loadSingers() {
  state.loading = true;
  state.loadError = null;
  dom.loadingState.style.display = 'flex';
  dom.emptyState.style.display = 'none';
  try {
    const params = {
      page: state.page,
      limit: state.pageSize,
    };
    if (state.searchQuery) params.q = state.searchQuery;
    if (state.activeTags.length > 0) {
      params.tags = state.activeTags;
      params.tag_mode = 'and';
    }
    const result = await apiListSingers(params);
    if (result.success && result.data) {
      const data = result.data;
      state.singers = Array.isArray(data.items) ? data.items : [];
      state.totalCount = data.total || state.singers.length;
      // Backend envelope field is `pages` (list envelope: items/page/size/
      // total/pages/has_more); `total_pages` kept as a defensive fallback.
      state.totalPages = data.pages || data.total_pages
        || Math.max(1, Math.ceil(state.totalCount / state.pageSize));
    } else {
      state.singers = [];
      state.totalPages = 1;
      state.loadError = errorText(result, tOr('singerMarket.loadFailed', 'Unable to reach the singer market'));
      state.loadErrorRegion = result.region || null;
      showToast(state.loadError.split('\n')[0], 'error');
    }
  } catch (err) {
    state.singers = [];
    state.totalPages = 1;
    state.loadError = errorText(err, tOr('singerMarket.loadFailed', 'Unable to reach the singer market'));
    state.loadErrorRegion = null;
    showToast(state.loadError, 'error');
  } finally {
    state.loading = false;
    dom.loadingState.style.display = 'none';
    renderSingerGrid();
    renderPagination();
  }
}

function renderSingerGrid() {
  dom.singerGrid.innerHTML = '';
  if (state.loadError) {
    // Network/service failure must be distinguishable from an empty result:
    // show a dedicated error state with the reason and a retry button.
    // Region-blocked (mainland China) failures lead with the region message
    // and put the diagnostic details (attempts/timeouts/IPs) below it.
    const msg = state.loadError;
    const nl = msg.indexOf('\n');
    if (state.loadErrorRegion === 'CN' && nl > 0) {
      dom.errorStateTitle.textContent = msg.slice(0, nl);
      dom.errorStateDetail.textContent = msg.slice(nl + 1).trim();
    } else {
      dom.errorStateTitle.textContent = tOr('singerMarket.loadFailed', 'Unable to reach the singer market');
      dom.errorStateDetail.textContent = msg;
    }
    dom.errorState.style.display = '';
    dom.singerGrid.appendChild(dom.errorState);
    return;
  }
  dom.errorState.style.display = 'none';
  if (state.singers.length === 0) {
    dom.singerGrid.appendChild(dom.emptyState);
    dom.emptyState.style.display = '';
    return;
  }
  state.singers.forEach((singer) => {
    dom.singerGrid.appendChild(buildSingerCard(singer));
  });
}

function buildSingerCard(singer) {
  const card = document.createElement('div');
  card.className = 'singer-card';
  card.addEventListener('click', () => openDetailDialog(singer));

  // Backend file objects expose the stored filename as `name` (`filename` is
  // a legacy defensive fallback); strip the .sxssinger extension for display.
  const name = singer.name?.replace(/\.sxssinger$/i, '')
    || singer.filename?.replace(/\.sxssinger$/i, '')
    || singer.description?.split('\n')[0]
    || `Singer #${singer.id?.slice(0, 8)}`;
  const description = singer.description || '';
  const tags = normalizeTags(singer.tags);
  const size = formatBytes(singer.size);
  const date = formatDate(singer.created_at || singer.uploaded_at);

  // Avatar (first letter on a colored background)
  const avatarColor = colorFromString(name);
  const initials = name.charAt(0).toUpperCase();

  card.innerHTML = `
    <div class="singer-card-header">
      <div class="singer-avatar" style="background: ${avatarColor};">${escapeHtml(initials)}</div>
      <div class="singer-info">
        <div class="singer-name">${escapeHtml(name)}</div>
        <div class="singer-meta">${escapeHtml(size)} · ${escapeHtml(date)}</div>
      </div>
    </div>
    <div class="singer-description">${escapeHtml(description || tOr('singerMarket.noDescription', 'No description'))}</div>
    <div class="singer-tags">
      ${tags.slice(0, 4).map((tag) => `<span class="singer-tag">${escapeHtml(tag)}</span>`).join('')}
    </div>
  `;
  return card;
}

// ==================== Pagination ====================
function renderPagination() {
  if (state.totalPages <= 1) {
    dom.pagination.style.display = 'none';
    return;
  }
  dom.pagination.style.display = 'flex';
  dom.pageInfo.textContent = `${state.page} / ${state.totalPages}`;
  dom.btnPrevPage.disabled = state.page <= 1;
  dom.btnNextPage.disabled = state.page >= state.totalPages;
}

dom.btnPrevPage.addEventListener('click', () => {
  if (state.page > 1) {
    state.page--;
    loadSingers();
  }
});
dom.btnNextPage.addEventListener('click', () => {
  if (state.page < state.totalPages) {
    state.page++;
    loadSingers();
  }
});

// Retry after a failed load (network unreachable / service error).
dom.btnRetry.addEventListener('click', () => {
  if (!state.loading) loadSingers();
});

// ==================== Refresh ====================
dom.btnRefresh.addEventListener('click', async () => {
  dom.btnRefresh.disabled = true;
  try {
    await Promise.all([loadSingers(), loadPopularTags()]);
    showToast(tOr('singerMarket.refreshed', 'Refreshed'), 'success');
  } finally {
    dom.btnRefresh.disabled = false;
  }
});

// ==================== Upload dialog ====================
dom.btnUpload.addEventListener('click', () => openUploadDialog());

function openUploadDialog() {
  if (!state.user) {
    showToast(tOr('singerMarket.loginRequired', 'Please log in to upload'), 'error');
    return;
  }
  state.uploadFile = null;
  dom.uploadInfo.style.display = 'none';
  dom.uploadDescription.value = '';
  dom.uploadTags.value = '';
  dom.uploadVisibility.value = 'public';
  dom.uploadDialog.style.display = 'flex';
  // License catalog: render from cache instantly; refresh in the background
  // so a first-ever open also gets options without a restart.
  renderLicenseOptions();
  ensureLicenseCatalog().then(renderLicenseOptions);
}

function closeUploadDialog() {
  dom.uploadDialog.style.display = 'none';
}

dom.btnUploadCancel.addEventListener('click', closeUploadDialog);
dom.uploadDialog.addEventListener('click', (e) => {
  if (e.target === dom.uploadDialog) closeUploadDialog();
});

dom.uploadDropArea.addEventListener('click', async () => {
  const result = await window.electronAPI.singerMarket.pickFile();
  if (result.success) {
    await handleUploadFilePicked(result.filePath, result.filename);
  }
});

dom.uploadDropArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  dom.uploadDropArea.classList.add('dragover');
});
dom.uploadDropArea.addEventListener('dragleave', () => {
  dom.uploadDropArea.classList.remove('dragover');
});
dom.uploadDropArea.addEventListener('drop', async (e) => {
  e.preventDefault();
  dom.uploadDropArea.classList.remove('dragover');
  // Renderer cannot read arbitrary file paths from drag events due to
  // security restrictions; we fall back to the native picker.
  const result = await window.electronAPI.singerMarket.pickFile();
  if (result.success) {
    await handleUploadFilePicked(result.filePath, result.filename);
  }
});

async function handleUploadFilePicked(filePath, filename) {
  state.uploadFile = { path: filePath, filename };
  dom.uploadFileName.textContent = filename;
  // Try to read the singer name from the file. The file is a JSON
  // .sxssinger file; we read the first KB to find the singerName field.
  try {
    const buffer = await window.electronAPI.readFileBuffer(filePath);
    const text = new TextDecoder().decode(buffer);
    const parsed = JSON.parse(text);
    if (parsed.singerName) {
      dom.uploadSingerName.textContent = parsed.singerName;
      state.uploadFile.singerName = parsed.singerName;
    } else {
      dom.uploadSingerName.textContent = filename.replace(/\.sxssinger$/i, '');
    }
  } catch (_) {
    dom.uploadSingerName.textContent = filename.replace(/\.sxssinger$/i, '');
  }
  dom.uploadInfo.style.display = '';
}

dom.btnUploadSubmit.addEventListener('click', async () => {
  if (!state.uploadFile) {
    showToast(tOr('singerMarket.pickFileFirst', 'Please select a file first'), 'error');
    return;
  }
  dom.btnUploadSubmit.disabled = true;
  try {
    const result = await apiUpload({
      filePath: state.uploadFile.path,
      description: dom.uploadDescription.value.trim(),
      tags: dom.uploadTags.value.trim(),
      visibility: dom.uploadVisibility.value,
      // License key from the catalog selector (e.g. "cc_by_4_0"); accepted
      // server-side as an alias of license_key. Empty → server default.
      license: dom.uploadLicense ? dom.uploadLicense.value : '',
    });
    if (result.success) {
      showToast(tOr('singerMarket.uploadSuccess', 'Upload successful'), 'success');
      closeUploadDialog();
      await loadSingers();
      await loadPopularTags();
    } else {
      showToast(result.error || tOr('singerMarket.uploadFailed', 'Upload failed'), 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    dom.btnUploadSubmit.disabled = false;
  }
});

// ==================== Detail / download dialog ====================
// The dialog opens IMMEDIATELY with whatever data the list view already has
// (name/size/date/tags), showing an in-dialog loading row while the fuller
// file-detail request is in flight. Without this, a slow network (up to the
// 30s IPC ceiling) leaves the click seemingly dead and users re-click.
function renderDetailBody(detail, { detailPending }) {
  const name = detail.name?.replace(/\.sxssinger$/i, '')
    || detail.filename?.replace(/\.sxssinger$/i, '')
    || detail.description?.split('\n')[0]
    || `Singer #${detail.id?.slice(0, 8)}`;
  dom.detailTitle.textContent = name;

  const description = detail.description || tOr('singerMarket.noDescription', 'No description');
  const tags = normalizeTags(detail.tags);
  const size = formatBytes(detail.size);
  const date = formatDate(detail.created_at || detail.uploaded_at);
  // Backend exposes `uploaded_by` (e.g. "user:alice"); `owner` kept as a
  // defensive fallback for older shapes.
  const owner = detail.uploaded_by || detail.owner || detail.user_id || '-';
  const visibility = detail.visibility || 'public';
  const avatarColor = colorFromString(name);
  const initials = name.charAt(0).toUpperCase();

  // License block — the backend stores a license object
  // { key, name, spdx, url, commercial_use, derivatives, custom } on every
  // file; null means the uploader left it at the server default or it predates
  // license support.
  const license = detail.license && typeof detail.license === 'object' ? detail.license : null;
  const licenseHtml = license && (license.name || license.spdx || license.key)
    ? `
      <span class="detail-license-name">${escapeHtml(license.name || license.spdx || license.key)}${license.spdx && license.spdx !== (license.name || license.key) ? ` (${escapeHtml(license.spdx)})` : ''}</span>
      <span class="detail-license-flag ${license.commercial_use === false ? 'no' : 'yes'}">${escapeHtml(license.commercial_use === false
        ? tOr('singerMarket.licenseNoCommercial', 'No commercial use')
        : tOr('singerMarket.licenseCommercial', 'Commercial use allowed'))}</span>
      ${license.url ? `<a class="detail-license-link" href="${escapeHtml(license.url)}" target="_blank" rel="noopener">${escapeHtml(tOr('singerMarket.licenseView', 'View license'))}</a>` : ''}
    `
    : `<span class="detail-license-name">${escapeHtml(tOr('singerMarket.licenseUnspecified', 'Not specified'))}</span>`;

  dom.detailBody.innerHTML = `
    <div class="detail-header">
      <div class="detail-avatar" style="background: ${avatarColor};">${escapeHtml(initials)}</div>
      <div class="detail-info">
        <div class="detail-name">${escapeHtml(name)}</div>
        <div class="detail-meta">
          <span class="detail-meta-item"><strong>${tOr('singerMarket.size', 'Size')}:</strong> ${escapeHtml(size)}</span>
          <span class="detail-meta-item"><strong>${tOr('singerMarket.uploaded', 'Uploaded')}:</strong> ${escapeHtml(date)}</span>
          <span class="detail-meta-item"><strong>${tOr('singerMarket.owner', 'Owner')}:</strong> ${escapeHtml(String(owner))}</span>
          <span class="detail-meta-item"><strong>${tOr('singerMarket.visibilityLabel', 'Visibility')}:</strong> ${escapeHtml(visibility)}</span>
        </div>
      </div>
    </div>
    ${detailPending ? `
      <div class="detail-loading-row">
        <span class="spinner spinner--sm"></span>
        <span>${escapeHtml(tOr('singerMarket.detailLoading', 'Loading details…'))}</span>
      </div>
    ` : ''}
    <div>
      <div class="detail-section-title">${tOr('singerMarket.license', 'License')}</div>
      <div class="detail-license">${licenseHtml}</div>
    </div>
    ${tags.length > 0 ? `
      <div>
        <div class="detail-section-title">${tOr('singerMarket.tags', 'Tags')}</div>
        <div class="detail-tags">
          ${tags.map((tag) => `<span class="singer-tag">${escapeHtml(tag)}</span>`).join('')}
        </div>
      </div>
    ` : ''}
    <div>
      <div class="detail-section-title">${tOr('singerMarket.description', 'Description')}</div>
      <div class="detail-description">${escapeHtml(description)}</div>
    </div>
  `;
}

async function openDetailDialog(singer) {
  // Ignore re-clicks on the same singer while its detail request is running —
  // this is what made the unresponsive window feel like it needed more clicks.
  if (state.detailLoading && state.detailSinger && state.detailSinger.id === singer.id
      && dom.detailDialog.style.display !== 'none') {
    return;
  }

  const seq = ++state.detailSeq;
  state.detailSinger = singer;
  state.detailLoading = true;

  // Open right away with list-level data + a loading row.
  renderDetailBody(singer, { detailPending: true });
  dom.disclaimerLink.href = DISCLAIMER_URL;
  dom.detailDialog.style.display = 'flex';

  let detail = singer;
  let ok = false;
  try {
    const result = await apiFileDetail(singer.id);
    if (result.success && result.data) {
      detail = { ...singer, ...result.data };
      ok = true;
    }
  } catch (_) {}

  // A newer open (different singer) superseded this request — drop it.
  if (seq !== state.detailSeq) return;

  state.detailLoading = false;
  if (!ok && state.detailSinger && state.detailSinger.id === singer.id) {
    // Detail fetch failed: keep the dialog usable with list-level data and
    // tell the user why details are incomplete. Download still works (it
    // operates on the id).
    showToast(tOr('singerMarket.detailLoadFailed', 'Failed to load full details; showing basic info.'), 'error');
  }
  if (state.detailSinger && state.detailSinger.id === singer.id) {
    renderDetailBody(detail, { detailPending: false });
    dom.disclaimerLink.href = DISCLAIMER_URL;
  }
}

function closeDetailDialog() {
  // Invalidate any in-flight detail request for this dialog.
  state.detailSeq++;
  state.detailLoading = false;
  dom.detailDialog.style.display = 'none';
  state.detailSinger = null;
}

dom.btnDetailCancel.addEventListener('click', closeDetailDialog);
dom.detailDialog.addEventListener('click', (e) => {
  if (e.target === dom.detailDialog) closeDetailDialog();
});

dom.btnDetailDownload.addEventListener('click', async () => {
  if (!state.detailSinger) return;
  const singer = state.detailSinger;
  const suggestedName = singer.name || singer.filename
    || `${(singer.description?.split('\n')[0] || 'singer').replace(/[^\w-]+/g, '_')}.sxssinger`;

  dom.btnDetailDownload.disabled = true;
  const prevLabel = dom.btnDetailDownload.textContent;
  // Live download progress (gracefully absent if the main process is older).
  let offProgress = null;
  if (window.electronAPI.singerMarket.onDownloadProgress) {
    offProgress = window.electronAPI.singerMarket.onDownloadProgress((p) => {
      if (!p || p.fileId !== singer.id || !p.total) return;
      const pct = Math.min(100, Math.round((p.received / p.total) * 100));
      dom.btnDetailDownload.textContent = `${tOr('singerMarket.downloading', 'Downloading…')} ${pct}%`;
    });
  }
  try {
    // Pick save path
    const pick = await window.electronAPI.singerMarket.pickSavePath(suggestedName);
    if (!pick.success) {
      // User canceled — keep the dialog open.
      return;
    }

    // Download bytes
    const dlResult = await apiDownload(singer.id);
    if (!dlResult.success) {
      showToast(dlResult.error || tOr('singerMarket.downloadFailed', 'Download failed'), 'error');
      return;
    }

    // Write to disk via existing file:saveFile IPC. The buffer is an
    // ArrayBuffer from the main process; we need to convert to a Uint8Array
    // view that the IPC marshal can transfer.
    const buf = dlResult.data.buffer;
    const saveResult = await window.electronAPI.saveFile(
      pick.filePath,
      new Uint8Array(buf)
    );
    if (saveResult && saveResult.success !== false) {
      showToast(tOr('singerMarket.downloadSuccess', 'Downloaded to {path}', { path: pick.filePath }), 'success');
      closeDetailDialog();
    } else {
      showToast(saveResult?.error || tOr('singerMarket.saveFailed', 'Failed to save file'), 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (offProgress) offProgress();
    dom.btnDetailDownload.textContent = prevLabel;
    dom.btnDetailDownload.disabled = false;
  }
});

// ==================== Init ====================
(async function init() {
  await refreshAuthState();
  await Promise.all([loadSingers(), loadPopularTags()]);
})();
