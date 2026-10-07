const { app } = require('electron');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { compareVersions, checkModelVersion, checkJpModelVersion, checkSifiganVersion } = require('../modelManager');
const { getModelDir } = require('./modelDir');
const { loadSettings, saveSettingsFile } = require('./settings');

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
/**
 * 容错读取构建元信息（buildTimestamp / version / buildDate ...）。
 *
 * 为什么不能用静态 require('../build-info.json')：
 * src/build-info.json 是打包产物，由 scripts/generate-build-info.js 在
 * prestart / prepackage 钩子里生成，且被 .gitignore 排除、已移出 git 跟踪。
 * 因此干净克隆（或直接用 electron . 启动）时它可能不存在 —— 静态 require 会让
 * webpack 在"解析模块"阶段就失败，`npm run make` / `npm start` 直接中断
 * （CopyPlugin 的 noErrorOnMissing 只影响拷贝，不会替我们造出这个文件）。
 *
 * （在 (a) 给 start/make/package 补 pre 钩子 与 (b) 改成容错读取 之间选了 (b)：
 * 钩子只能覆盖 npm scripts 入口，任何绕过 npm 的启动方式（electron .、
 * forge 内部脚本、CI 直接调用 webpack）仍会踩到同一个坑；改成运行时容错读取后，
 * 构建期不再依赖该文件存在，启动路径也就彻底不受影响。）
 *
 * 兜底：两个候选位置都读不到时返回 null，由调用方显式跳过依赖它的判断。
 */
function _readBuildInfo() {
  const candidates = [
    path.join(__dirname, 'build-info.json'),        // 打包后：webpack 复制到 main 目录
    path.join(__dirname, '..', 'build-info.json'),  // 源码运行：src/build-info.json
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) { /* 不存在或不是合法 JSON，试下一个候选 */ }
  }
  return null;
}

/**
 * 取得"本地构建时间"：优先 build-info.json 的 buildTimestamp，缺失时退回
 * package.json 的修改时间（版本真源文件的落盘时间）。两个都拿不到就返回 null，
 * 调用方显式跳过 —— 绝不退化成"拿不到就当作很旧"，否则会误报永远有新版。
 */
function _resolveBuildTimestamp(buildInfo) {
  if (buildInfo && typeof buildInfo.buildTimestamp === 'number' && isFinite(buildInfo.buildTimestamp)) {
    return buildInfo.buildTimestamp;
  }
  try {
    return fs.statSync(path.join(__dirname, '..', 'package.json')).mtimeMs;
  } catch (_) {
    return null;
  }
}

async function checkAppUpdate(channel) {
  const currentVersion = app.getVersion();
  const buildInfo = _readBuildInfo();

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
      // W26: Validate buildTimestamp before comparing. If it is undefined or
      // non-finite, `undefined + 60000 = NaN` and `publishedMs > NaN` is always
      // false, silently suppressing nightly update prompts. Bail out explicitly
      // so the invalid case is intentional rather than accidental NaN arithmetic.
      // build-info.json 缺失时 _resolveBuildTimestamp 会退回 package.json 的
      // mtime；连它都拿不到就显式跳过，不做时间比较。
      const buildTimestamp = _resolveBuildTimestamp(buildInfo);
      if (buildTimestamp !== null && publishedAt) {
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
