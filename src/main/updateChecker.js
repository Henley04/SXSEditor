const { app } = require('electron');
const https = require('node:https');
const { compareVersions, checkModelVersion, checkJpModelVersion, checkSifiganVersion } = require('../modelManager');
const { getModelDir } = require('./modelDir');
const { loadSettings, saveSettingsFile, invalidateSettingsCache } = require('./settings');

const GITHUB_REPO = 'Henley04/SXSEditor';
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`;
const INSTALLER_ASSET = 'sxsinstaller_x64_no_models.exe';

// Release notes are viewed on the official docs site (opened as external link).
const APP_RELEASE_NOTES_URL = 'https://henley04.github.io/SXSEditor/user/app-updates.html';
const MODEL_RELEASE_NOTES_URL = 'https://henley04.github.io/SXSEditor/user/model-updates.html';

const REQUEST_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;
const NIGHTLY_TOLERANCE_MS = 60000;
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch JSON from a GitHub API URL via https.request.
 * Handles redirects (up to MAX_REDIRECTS), 403 rate-limit detection, and
 * a REQUEST_TIMEOUT_MS socket timeout. Resolves with parsed JSON or throws.
 */
function _fetchGithubJson(url) {
  return new Promise((resolve, reject) => {
    let redirectCount = 0;

    const doRequest = (targetUrl) => {
      const req = https.request(targetUrl, {
        headers: {
          'User-Agent': 'SXSEditor-Updater',
          'Accept': 'application/vnd.github+json',
        },
      }, (res) => {
        const status = res.statusCode;
        // Follow redirects (GitHub API rarely redirects; handle at most MAX_REDIRECTS)
        if (
          (status === 301 || status === 302 || status === 307 || status === 308) &&
          res.headers.location &&
          redirectCount < MAX_REDIRECTS
        ) {
          redirectCount++;
          res.resume(); // drain
          doRequest(res.headers.location);
          return;
        }
        if (status === 403) {
          const reset = res.headers['x-ratelimit-reset'];
          res.resume();
          const err = new Error(`RATE_LIMIT: GitHub API rate limited. Resets at ${reset || 'unknown'}`);
          err.rateLimitReset = reset;
          reject(err);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf-8');
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error('GitHub API request timeout'));
      });
      req.end();
    };

    doRequest(url);
  });
}

/**
 * Check for an app update on the given channel ('release' | 'nightly').
 * Returns a result object describing availability, URLs, and release notes.
 *
 * Release notes are fetched from the official docs site (app-updates.html)
 * and returned as structured `appReleaseNotes`. The GitHub `releaseNotesHtml`
 * is kept as a fallback when the official site is unreachable or the version
 * is not yet documented there.
 */
async function checkAppUpdate(channel) {
  const currentVersion = app.getVersion();
  const buildInfo = require('../build-info.json');

  let updateAvailable = false;
  let latestVersion = null;
  let releaseUrl = null;
  let downloadUrl = null;
  let publishedAt = null;
  let releaseNotesHtml = null;

  try {
    if (channel === 'nightly') {
      const release = await _fetchGithubJson(`${GITHUB_API_BASE}/releases/tags/nightly`);
      latestVersion = 'nightly';
      publishedAt = release.published_at || null;
      releaseUrl = release.html_url || null;
      downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/nightly/${INSTALLER_ASSET}`;
      releaseNotesHtml = release.body_html || release.body || null;
      const buildTimestamp = buildInfo.buildTimestamp;
      if (publishedAt) {
        const publishedMs = Date.parse(publishedAt);
        if (!isNaN(publishedMs)) {
          updateAvailable = publishedMs > buildTimestamp + NIGHTLY_TOLERANCE_MS;
        }
      }
    } else {
      // release channel (default)
      const release = await _fetchGithubJson(`${GITHUB_API_BASE}/releases/latest`);
      latestVersion = release.tag_name || null;
      publishedAt = release.published_at || null;
      releaseUrl = release.html_url || null;
      releaseNotesHtml = release.body_html || release.body || null;
      const asset = release.assets && release.assets.find((a) => a.name === INSTALLER_ASSET);
      downloadUrl = (asset && asset.browser_download_url) ||
        `https://github.com/${GITHUB_REPO}/releases/latest/download/${INSTALLER_ASSET}`;
      if (latestVersion) {
        updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
      }
    }

    // Release notes are viewed as an external link instead of fetched/parsed.
    return {
      updateAvailable,
      currentVersion,
      latestVersion,
      releaseUrl,
      downloadUrl,
      publishedAt,
      releaseNotesHtml,
      appReleaseNotesUrl: APP_RELEASE_NOTES_URL,
      channel,
    };
  } catch (err) {
    let errorMsg = err.message;
    if (errorMsg.includes('RATE_LIMIT')) {
      errorMsg = 'rate_limited';
    }
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: null,
      releaseUrl: null,
      downloadUrl: null,
      publishedAt: null,
      releaseNotesHtml: null,
      appReleaseNotesUrl: APP_RELEASE_NOTES_URL,
      channel,
      error: errorMsg,
    };
  }
}

/**
 * Check for model updates (main, JP, SiFiGAN) against the local model dir.
 * Returns { main, jp, sifigan, anyUpdateAvailable, modelReleaseNotesUrl }.
 *
 * Release notes are viewed as an external link to the official docs site
 * (model-updates.html) instead of being fetched and parsed inline.
 */
async function checkModelUpdates() {
  try {
    const modelDir = getModelDir();
    const settings = loadSettings();
    const precision = settings.modelPrecision || 'fp32';
    const [main, jp, sifigan] = await Promise.all([
      checkModelVersion(modelDir, precision),
      checkJpModelVersion(modelDir, precision),
      checkSifiganVersion(modelDir),
    ]);
    const anyUpdateAvailable = !!(main.updateAvailable || jp.updateAvailable || sifigan.updateAvailable);

    return { main, jp, sifigan, anyUpdateAvailable, modelReleaseNotesUrl: MODEL_RELEASE_NOTES_URL };
  } catch (err) {
    return { main: null, jp: null, sifigan: null, anyUpdateAvailable: false, modelReleaseNotesUrl: MODEL_RELEASE_NOTES_URL, error: err.message };
  }
}

/**
 * Check both app and model updates concurrently.
 * Returns { app, models }.
 */
async function checkAllUpdates(channel) {
  const [appResult, models] = await Promise.all([
    checkAppUpdate(channel),
    checkModelUpdates(),
  ]);
  return { app: appResult, models };
}

/**
 * Decide whether an automatic background update check should run.
 * Requires autoCheckUpdates enabled, packaged app, dontRemindAppUpdates off,
 * and more than AUTO_CHECK_INTERVAL_MS since the last check (or never checked).
 */
function shouldAutoCheck(settings, isPackaged) {
  if (!settings.autoCheckUpdates) return false;
  if (!isPackaged) return false;
  if (settings.dontRemindAppUpdates) return false;
  const last = settings.lastUpdateCheckTime;
  if (!last) return true;
  const lastTime = Date.parse(last);
  if (isNaN(lastTime)) return true;
  const elapsed = Date.now() - lastTime;
  return elapsed > AUTO_CHECK_INTERVAL_MS;
}

/**
 * Persist the current time as the last update check timestamp.
 */
async function recordCheckTime() {
  const settings = loadSettings();
  settings.lastUpdateCheckTime = new Date().toISOString();
  await saveSettingsFile(settings);
}

/**
 * Decide whether to show the update notification window.
 * Manual checks ignore dontRemindAppUpdates; auto checks respect it.
 */
function shouldShowNotification(appResult, modelsResult, settings, isManual) {
  const appUpdateToShow = appResult.updateAvailable && appResult.latestVersion !== settings.skippedAppVersion;
  const modelUpdateToShow = modelsResult.anyUpdateAvailable;
  if (isManual) {
    return appUpdateToShow || modelUpdateToShow;
  }
  return appUpdateToShow || modelUpdateToShow;
}

module.exports = {
  checkAppUpdate,
  checkModelUpdates,
  checkAllUpdates,
  shouldAutoCheck,
  recordCheckTime,
  shouldShowNotification,
};
