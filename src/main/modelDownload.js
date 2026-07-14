const { ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { t } = require('./locale');
const { loadSettings, saveSettingsFile } = require('./settings');
const { isPathAllowed } = require('./security');
const { getModelDir, setCustomModelDir } = require('./modelDir');
const { checkMissingFiles, checkMissingFilesAsync, deleteModelFiles, downloadMissingFiles, DEFAULT_PRECISION, isPrecisionDownloadable, MODEL_IDS, getSifiganFileDownloadUrl, downloadFileWithRetry, downloadFileChunked, getOptimalConcurrency, MIN_FILE_SIZE_FOR_CHUNKING, checkModelVersion, checkJpModelVersion, saveJpModelVersion, checkSifiganVersion, saveSifiganVersion, saveModelVersion, getLocalModelVersion, invalidateJpModelsCache, getModelTags, getJpModelTags, getSifiganTags, getLatestTag } = require('../modelManager');
const { createModelDownloadWindow, getModelDownloadWindow, setModelDownloadWindow, getMainWindow } = require('./windowManager');

let downloadAbortController = null;

// ===== SiFiGAN helpers =====
// SiFiGAN is an optional model group stored at the root of onnx_models/
// (not in precision subdirs). SiFiGAN has two onnx variants (FP16 量化版优先,
// FP32 DML 优化版回退); only one variant needs to be present + stats file.
//
// SIFIGAN_DOWNLOAD_FILES: files downloadable from ModelScope (FP32 variant).
//   The FP16 variant is generated locally via quantize_sifigan_fp16.py and
//   is NOT on ModelScope, so it is excluded from the download list.
// SIFIGAN_ALL_FILES: all possible files (FP16 + FP32 + stats) for deletion.
const SIFIGAN_DOWNLOAD_FILES = [
  'sifigan_vocoder_dml.onnx',
  'sifigan_vocoder_dml.onnx.data',
  'sifigan_stats.joblib',
];
const SIFIGAN_ALL_FILES = [
  'sifigan_vocoder_dml_fp16.onnx',
  'sifigan_vocoder_dml_fp16.onnx.data',
  'sifigan_vocoder_dml.onnx',
  'sifigan_vocoder_dml.onnx.data',
  'sifigan_stats.joblib',
];
// 兼容旧引用 (SIFIGAN_FILES 仍指向完整列表, 用于 deleteSifiganFiles)
const SIFIGAN_FILES = SIFIGAN_ALL_FILES;

// SiFiGAN 安装判定: stats 文件 + (FP16 变体完整 OR FP32 变体完整)
function _checkFileExists(modelDir, fileName) {
  try {
    const stats = fs.statSync(path.join(modelDir, fileName));
    return stats.size > 0;
  } catch (_) {
    return false;
  }
}

function isSifiganVariantComplete(modelDir, variant) {
  // variant: 'fp16' | 'fp32'
  if (variant === 'fp16') {
    return _checkFileExists(modelDir, 'sifigan_vocoder_dml_fp16.onnx')
        && _checkFileExists(modelDir, 'sifigan_vocoder_dml_fp16.onnx.data');
  }
  return _checkFileExists(modelDir, 'sifigan_vocoder_dml.onnx')
      && _checkFileExists(modelDir, 'sifigan_vocoder_dml.onnx.data');
}

function checkSifiganFilesExist(modelDir) {
  const result = {};
  for (const fileName of SIFIGAN_ALL_FILES) {
    const fullPath = path.join(modelDir, fileName);
    let exists = false;
    let size = 0;
    try {
      const stats = fs.statSync(fullPath);
      if (stats.size > 0) {
        exists = true;
        size = stats.size;
      }
    } catch (_) {}
    result[fileName] = { exists, size, fullPath };
  }
  // SiFiGAN 视为已安装: stats 存在 + (FP16 变体完整 OR FP32 变体完整)
  const statsOk = result['sifigan_stats.joblib'] && result['sifigan_stats.joblib'].exists;
  const fp16Ok = isSifiganVariantComplete(modelDir, 'fp16');
  const fp32Ok = isSifiganVariantComplete(modelDir, 'fp32');
  const allExist = !!(statsOk && (fp16Ok || fp32Ok));
  return { allExist, files: result, fp16Ok, fp32Ok, statsOk };
}

function deleteSifiganFiles(modelDir) {
  const deleted = [];
  const errors = [];
  for (const fileName of SIFIGAN_ALL_FILES) {
    const fullPath = path.join(modelDir, fileName);
    try {
      fs.unlinkSync(fullPath);
      deleted.push(fileName);
    } catch (err) {
      if (err.code !== 'ENOENT') errors.push({ fileName, message: err.message });
    }
  }
  return { deleted, errors };
}

async function startModelDownload(modelDir, missingFiles, precision, revision) {
  downloadAbortController = new AbortController();
  const abortSignal = downloadAbortController.signal;
  const currentPrecision = precision || DEFAULT_PRECISION;
  const modelDownloadWindow = getModelDownloadWindow();

  try {
    await downloadMissingFiles(modelDir, missingFiles, {
      abortSignal,
      precision: currentPrecision,
      revision,
      onProgress: (data) => {
        const win = getModelDownloadWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('model-download:progress', data);
        }
      },
      onFileStart: (filePath, fileIndex, totalFiles) => {
        const win = getModelDownloadWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('model-download:file-start', { filePath, fileIndex, totalFiles });
        }
      },
      onFileComplete: (filePath, fileIndex, totalFiles) => {
        const win = getModelDownloadWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('model-download:file-complete', { filePath, fileIndex, totalFiles });
        }
      },
    });

    const win = getModelDownloadWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('model-download:complete');
    }
    console.log('[Main] All model files downloaded');
  } catch (err) {
    if (err.message === 'Download cancelled') {
      console.log('[Main] Model download cancelled');
    } else {
      console.error('[Main] Model download failed:', err);
      const win = getModelDownloadWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('model-download:error', { message: err.message });
      }
    }
  } finally {
    downloadAbortController = null;
  }
}

async function checkAndDownloadModels() {
  if (require('electron').app.isPackaged) {
    const settings = loadSettings();
    if (settings.modelDir && typeof settings.modelDir === 'string' && isPathAllowed(settings.modelDir)) {
      try {
        fs.mkdirSync(settings.modelDir, { recursive: true });
        setCustomModelDir(settings.modelDir);
      } catch (_) {
        setCustomModelDir(null);
      }
    }
  }

  const modelDir = getModelDir();
  const precision = loadSettings().modelPrecision || DEFAULT_PRECISION;
  console.log('[Main] Check model files, dir:', modelDir, 'precision:', precision);
  const { missing, existing } = await checkMissingFilesAsync(modelDir, precision);

  if (missing.length === 0) {
    console.log('[Main] All model files ready');
    return true;
  }

  if (require('electron').app.isPackaged && !getCustomModelDir()) {
    const defaultDir = path.join(require('electron').app.getPath('userData'), 'onnx_models');
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: t('dialog.selectModelDownloadLocation'),
      defaultPath: defaultDir,
      properties: ['openDirectory'],
      buttonLabel: t('dialog.selectFolder'),
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      console.log('[Main] User cancelled model download location selection');
      return false;
    }

    let downloadDir = result.filePaths[0];
    if (!downloadDir.endsWith(path.sep)) {
      downloadDir = downloadDir + path.sep;
    }

    setCustomModelDir(downloadDir);
    const settings = loadSettings();
    settings.modelDir = downloadDir;
    await saveSettingsFile(settings);

    try {
      fs.mkdirSync(downloadDir, { recursive: true });
    } catch (_) {}

    const recheck = await checkMissingFilesAsync(downloadDir, precision);
    if (recheck.missing.length === 0) {
      console.log('[Main] Model files ready in selected directory');
      return true;
    }

    console.log(`[Main] Missing ${recheck.missing.length} model files:`, recheck.missing.map(f => f.filePath));
    createModelDownloadWindow(recheck.missing, precision, DEFAULT_PRECISION);
    return false;
  }

  console.log(`[Main] Missing ${missing.length} model files:`, missing.map(f => f.filePath));
  createModelDownloadWindow(missing, precision, DEFAULT_PRECISION);
  return false;
}

function getCustomModelDir() {
  const { getCustomModelDir: getCustom } = require('./modelDir');
  return getCustom();
}

function registerModelDownloadIpc() {
  // Open an external URL in the system default browser (for model-updates docs link)
  ipcMain.handle('model-download:open-external', async (event, url) => {
    const ALLOWED_EXTERNAL_URLS = [
      'https://henley04.github.io/SXSEditor/',
    ];
    if (!url || typeof url !== 'string') return { success: false };
    const isAllowed = ALLOWED_EXTERNAL_URLS.some(prefix => url.startsWith(prefix));
    if (!isAllowed) {
      return { success: false, error: 'URL not allowed' };
    }
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // List available model versions (tags) from ModelScope for a given precision.
  // Tags are fetched from the /revisions endpoint; branches are NOT shown.
  // Downloads are tag-only — there is no 'master' (latest) option.
  ipcMain.handle('model-download:list-versions', async (event, precision) => {
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    try {
      const tags = await getModelTags(currentPrecision);
      return { success: true, tags };
    } catch (err) {
      return { success: false, tags: [], error: err.message };
    }
  });

  // List available JP model versions (tags) from ModelScope
  ipcMain.handle('model-download:list-jp-versions', async (event, precision) => {
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    try {
      const tags = await getJpModelTags(currentPrecision);
      return { success: true, tags };
    } catch (err) {
      return { success: false, tags: [], error: err.message };
    }
  });

  // List available SiFiGAN model versions (tags) from ModelScope
  ipcMain.handle('model-download:list-sifigan-versions', async () => {
    try {
      const tags = await getSifiganTags();
      return { success: true, tags };
    } catch (err) {
      return { success: false, tags: [], error: err.message };
    }
  });

  ipcMain.handle('model-download:start', async (event, precision, revision) => {
    const modelDir = getModelDir();
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    // If no revision (tag) specified or 'latest' requested, fetch the latest tag from ModelScope
    let currentRevision = revision;
    if (!currentRevision || currentRevision === 'latest') {
      try {
        const tags = await getModelTags(currentPrecision);
        currentRevision = getLatestTag(tags);
      } catch (err) {
        return { success: false, error: `Failed to fetch model tags: ${err.message}` };
      }
    }
    if (!currentRevision) {
      return { success: false, error: 'No model tags available for download' };
    }
    if (!isPrecisionDownloadable(currentPrecision)) {
      return { success: false, error: `Download not available for precision: ${currentPrecision}` };
    }
    const { missing } = checkMissingFiles(modelDir, currentPrecision);
    if (missing.length === 0) {
      // All files present — just save version with revision
      saveModelVersion(modelDir, currentPrecision, currentRevision);
      return { success: true };
    }
    await startModelDownload(modelDir, missing, currentPrecision, currentRevision);
    return { success: true };
  });

  ipcMain.handle('model-download:cancel', async () => {
    if (downloadAbortController) {
      downloadAbortController.abort();
      downloadAbortController = null;
    }
    return { success: true };
  });

  ipcMain.handle('model-download:check', async (event, precision) => {
    const modelDir = getModelDir();
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    const { missing, existing } = checkMissingFiles(modelDir, currentPrecision);
    return { missing, existing };
  });

  ipcMain.handle('model-download:change-dir', async () => {
    const defaultDir = getCustomModelDir() || path.join(require('electron').app.getPath('userData'), 'onnx_models');
    const result = await dialog.showOpenDialog(getModelDownloadWindow() || getMainWindow(), {
      title: t('dialog.selectModelDownloadLocation'),
      defaultPath: defaultDir,
      properties: ['openDirectory'],
      buttonLabel: t('dialog.selectFolder'),
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { canceled: true };
    }

    let downloadDir = result.filePaths[0];
    if (!downloadDir.endsWith(path.sep)) {
      downloadDir = downloadDir + path.sep;
    }

    setCustomModelDir(downloadDir);
    const settings = loadSettings();
    settings.modelDir = downloadDir;
    await saveSettingsFile(settings);

    try {
      fs.mkdirSync(downloadDir, { recursive: true });
    } catch (_) {}

    const { missing, existing } = checkMissingFiles(downloadDir, loadSettings().modelPrecision || DEFAULT_PRECISION);
    return { canceled: false, modelDir: downloadDir, missing, existing };
  });

  ipcMain.handle('model-download:get-dir', async () => {
    return getModelDir();
  });

  ipcMain.handle('model-download:open', async (event, precision) => {
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    const modelDir = getModelDir();
    const { missing } = checkMissingFiles(modelDir, currentPrecision);
    createModelDownloadWindow(missing, currentPrecision, DEFAULT_PRECISION);
    return { success: true, missingCount: missing.length };
  });

  ipcMain.handle('model-download:delete-and-recheck', async (event, precision) => {
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    const modelDir = getModelDir();
    deleteModelFiles(modelDir, currentPrecision);
    const { missing } = checkMissingFiles(modelDir, currentPrecision);
    const win = getModelDownloadWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('model-download:missing-files', missing);
      win.webContents.send('model-download:precision', currentPrecision);
    }
    return { success: true, missingCount: missing.length };
  });

  ipcMain.handle('model-download:recheck', async (event, precision) => {
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    const modelDir = getModelDir();
    const { missing } = checkMissingFiles(modelDir, currentPrecision);
    const win = getModelDownloadWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('model-download:missing-files', missing);
      win.webContents.send('model-download:precision', currentPrecision);
    }
    return { success: true, missingCount: missing.length };
  });

  // JP model download handlers
  ipcMain.handle('model-download:check-jp', async (event, precision) => {
    const modelDir = getModelDir();
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    const { checkMissingJpFiles } = require('../modelManager');
    const { missing, existing } = checkMissingJpFiles(modelDir, currentPrecision);
    return { missing, existing };
  });

  ipcMain.handle('model-download:start-jp', async (event, precision, revision) => {
    const { checkMissingJpFiles, getJpLocalFilePath, getJpFileDownloadUrl, JP_MODEL_IDS } = require('../modelManager');
    const modelDir = getModelDir();
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    // If no revision (tag) specified or 'latest' requested, fetch the latest JP tag from ModelScope
    let currentRevision = revision;
    if (!currentRevision || currentRevision === 'latest') {
      try {
        const tags = await getJpModelTags(currentPrecision);
        currentRevision = getLatestTag(tags);
      } catch (err) {
        return { success: false, error: `Failed to fetch JP model tags: ${err.message}` };
      }
    }
    if (!currentRevision) {
      return { success: false, error: 'No JP model tags available for download' };
    }
    const { missing } = checkMissingJpFiles(modelDir, currentPrecision);
    if (missing.length === 0) return { success: true };

    // Check if JP model repo exists for this precision
    const jpModelId = JP_MODEL_IDS[currentPrecision] || JP_MODEL_IDS['fp16'];
    if (!jpModelId) {
      return { success: false, error: `JP models not available for precision: ${currentPrecision}` };
    }

    downloadAbortController = new AbortController();
    const abortSignal = downloadAbortController.signal;
    const modelDownloadWindow = getModelDownloadWindow();

    try {
      const { downloadMissingFiles } = require('../modelManager');
      // Download JP files to the JP subdirectory
      const jpMissingFiles = missing.map(f => ({
        ...f,
        _jpFilePath: getJpLocalFilePath(modelDir, f.filePath, currentPrecision),
      }));

      // Use custom download for JP files
      for (const file of missing) {
        const destPath = getJpLocalFilePath(modelDir, file.filePath, currentPrecision);
        const url = getJpFileDownloadUrl(file.filePath, currentPrecision, currentRevision);
        if (!url) continue;

        const { downloadFileWithRetry } = require('../modelManager');
        await downloadFileWithRetry(url, destPath, { abortSignal });

        const win = getModelDownloadWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('model-download:file-complete', { filePath: file.filePath });
        }
      }

      const win = getModelDownloadWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('model-download:complete');
      }
      // 失效 JP 模型存在性缓存，让下次合成重新检查文件
      invalidateJpModelsCache(modelDir, currentPrecision);
      // 保存 JP 模型版本信息
      saveJpModelVersion(modelDir, currentPrecision, currentRevision);
      console.log('[Main] JP model download complete');
    } catch (err) {
      if (err.message === 'Download cancelled') {
        console.log('[Main] JP model download cancelled');
      } else {
        console.error('[Main] JP model download failed:', err);
        const win = getModelDownloadWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('model-download:error', { message: err.message });
        }
      }
    } finally {
      downloadAbortController = null;
    }

    return { success: true };
  });

  ipcMain.handle('model-download:check-jp-exists', async () => {
    const { checkJpModelsExist } = require('../modelManager');
    const modelDir = getModelDir();
    const precision = loadSettings().modelPrecision || DEFAULT_PRECISION;
    return checkJpModelsExist(modelDir, precision);
  });

  // ===== SiFiGAN (optional vocoder) IPC handlers =====
  // The SiFiGAN group is optional and uses a placeholder ModelScope repo ID
  // (MODEL_IDS.sifigan = ''). Until the author uploads the model and fills
  // in the repo ID, the UI must gracefully show "download URL not configured"
  // instead of crashing or attempting a real download.

  // Returns: { status: 'installed' | 'not_downloaded' | 'download_url_not_configured',
  //            files: { ... }, allExist: boolean }
  ipcMain.handle('model-download:check-sifigan', async () => {
    const modelDir = getModelDir();
    const { allExist, files } = checkSifiganFilesExist(modelDir);
    const sifiganId = MODEL_IDS.sifigan || '';
    let status;
    if (allExist) {
      status = 'installed';
    } else if (!sifiganId) {
      status = 'download_url_not_configured';
    } else {
      status = 'not_downloaded';
    }
    return {
      status,
      allExist,
      files,
      modelId: sifiganId,
      message: status === 'download_url_not_configured'
        ? t('modelDownload.sifiganUrlNotConfigured')
        : '',
    };
  });

  // Start SiFiGAN download. Downloads the 3 expected files from the
  // ModelScope repo (MODEL_IDS.sifigan) to the root of onnx_models/.
  // Uses chunked download for files >= 16MB, single-threaded for smaller.
  ipcMain.handle('model-download:start-sifigan', async (event, revision) => {
    const sifiganId = MODEL_IDS.sifigan || '';
    // If no revision (tag) specified or 'latest' requested, fetch the latest SiFiGAN tag from ModelScope
    let currentRevision = revision;
    if ((!currentRevision || currentRevision === 'latest') && sifiganId) {
      try {
        const tags = await getSifiganTags();
        currentRevision = getLatestTag(tags);
      } catch (err) {
        return { status: 'download_url_not_configured', message: `Failed to fetch SiFiGAN tags: ${err.message}` };
      }
    }
    if (!sifiganId) {
      const modelDir = getModelDir();
      const { allExist, files } = checkSifiganFilesExist(modelDir);
      return {
        status: 'download_url_not_configured',
        message: t('modelDownload.sifiganUrlNotConfigured'),
        allExist,
        files,
      };
    }
    if (!currentRevision) {
      return { status: 'download_url_not_configured', message: 'No SiFiGAN tags available for download' };
    }

    const modelDir = getModelDir();
    const { allExist, files: existingFiles } = checkSifiganFilesExist(modelDir);
    if (allExist) {
      return { status: 'installed', allExist, files: existingFiles };
    }

    // Build the list of missing files to download.
    // Only download SIFIGAN_DOWNLOAD_FILES (FP32 variant + stats) from ModelScope.
    // The FP16 variant is generated locally and is not on ModelScope.
    const missingFiles = SIFIGAN_DOWNLOAD_FILES.filter(name => !existingFiles[name] || !existingFiles[name].exists);
    if (missingFiles.length === 0) {
      return { status: 'installed', allExist: true, files: existingFiles };
    }

    downloadAbortController = new AbortController();
    const abortSignal = downloadAbortController.signal;
    const win = getModelDownloadWindow();

    try {
      for (const fileName of missingFiles) {
        if (abortSignal.aborted) throw new Error('Download cancelled');

        const destPath = path.join(modelDir, fileName);
        const url = getSifiganFileDownloadUrl(fileName, currentRevision);
        if (!url) {
          throw new Error(`Failed to build download URL for ${fileName}`);
        }

        // Ensure parent directory exists
        fs.mkdirSync(path.dirname(destPath), { recursive: true });

        if (win && !win.isDestroyed()) {
          win.webContents.send('model-download:file-start', {
            filePath: fileName,
            fileIndex: missingFiles.indexOf(fileName),
            totalFiles: missingFiles.length,
          });
        }

        // Get remote file size via HEAD request to decide chunked vs single-threaded.
        // ModelScope redirects to CDN, so follow one redirect hop.
        let remoteSize = 0;
        try {
          const https = require('node:https');
          const http = require('node:http');
          const { URL } = require('node:url');
          const urlObj = new URL(url);
          const lib = urlObj.protocol === 'https:' ? https : http;
          remoteSize = await new Promise((resolve) => {
            const req = lib.request({
              hostname: urlObj.hostname,
              port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
              path: urlObj.pathname + urlObj.search,
              method: 'HEAD',
              headers: { 'User-Agent': 'Mozilla/5.0' },
            }, (response) => {
              if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                // Follow redirect — simplified single-hop
                const redirectUrl = new URL(response.headers.location, url).href;
                const redirectObj = new URL(redirectUrl);
                const redirectLib = redirectObj.protocol === 'https:' ? https : http;
                const redirectReq = redirectLib.request({
                  hostname: redirectObj.hostname,
                  port: redirectObj.port || (redirectObj.protocol === 'https:' ? 443 : 80),
                  path: redirectObj.pathname + redirectObj.search,
                  method: 'HEAD',
                  headers: { 'User-Agent': 'Mozilla/5.0' },
                }, (redirectResponse) => {
                  const cl = parseInt(redirectResponse.headers['content-length'] || '0', 10);
                  redirectResponse.resume();
                  resolve(cl);
                });
                redirectReq.on('error', () => resolve(0));
                redirectReq.end();
              } else {
                const cl = parseInt(response.headers['content-length'] || '0', 10);
                response.resume();
                resolve(cl);
              }
            });
            req.on('error', () => resolve(0));
            req.setTimeout(10000, () => { req.destroy(); resolve(0); });
            req.end();
          });
        } catch (_) {}

        // Use chunked download for large files, single-threaded for small
        if (remoteSize >= MIN_FILE_SIZE_FOR_CHUNKING) {
          await downloadFileChunked(url, destPath, remoteSize, {
            abortSignal,
            onProgress: (downloaded, total) => {
              if (win && !win.isDestroyed()) {
                win.webContents.send('model-download:progress', {
                  currentFile: fileName,
                  fileIndex: missingFiles.indexOf(fileName),
                  totalFiles: missingFiles.length,
                  bytesDownloaded: downloaded,
                  bytesTotal: total,
                  overallDownloaded: downloaded,
                  overallTotal: total,
                });
              }
            },
          });
        } else {
          await downloadFileWithRetry(url, destPath, {
            abortSignal,
            onProgress: (downloaded, total) => {
              if (win && !win.isDestroyed()) {
                win.webContents.send('model-download:progress', {
                  currentFile: fileName,
                  fileIndex: missingFiles.indexOf(fileName),
                  totalFiles: missingFiles.length,
                  bytesDownloaded: downloaded,
                  bytesTotal: total,
                  overallDownloaded: downloaded,
                  overallTotal: total,
                });
              }
            },
          });
        }

        if (win && !win.isDestroyed()) {
          win.webContents.send('model-download:file-complete', {
            filePath: fileName,
            fileIndex: missingFiles.indexOf(fileName),
            totalFiles: missingFiles.length,
          });
        }
      }

      // All downloads complete — re-check files
      const { allExist: nowExists, files: finalFiles } = checkSifiganFilesExist(modelDir);
      if (nowExists) {
        // 保存 SiFiGAN 模型版本信息
        saveSifiganVersion(modelDir, currentRevision);
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send('model-download:complete');
      }
      console.log('[Main] SiFiGAN model download complete');
      return {
        status: nowExists ? 'installed' : 'not_downloaded',
        allExist: nowExists,
        files: finalFiles,
      };
    } catch (err) {
      if (err.message === 'Download cancelled') {
        console.log('[Main] SiFiGAN model download cancelled');
      } else {
        console.error('[Main] SiFiGAN model download failed:', err);
        if (win && !win.isDestroyed()) {
          win.webContents.send('model-download:error', { message: err.message });
        }
      }
      const { allExist: errExists, files: errFiles } = checkSifiganFilesExist(modelDir);
      return {
        status: errExists ? 'installed' : 'not_downloaded',
        allExist: errExists,
        files: errFiles,
      };
    } finally {
      downloadAbortController = null;
    }
  });

  // Unload SiFiGAN: delete the model files, reset vocoderType to 'default'
  // in settings.json, and release the InferenceSession if the SVS pipeline
  // has it loaded. Reuses the existing pipeline.unloadModel(sessionKey)
  // API to dispose the session without tearing down the whole pipeline.
  ipcMain.handle('model-download:unload-sifigan', async () => {
    const modelDir = getModelDir();
    const result = deleteSifiganFiles(modelDir);

    // 删除 SiFiGAN 版本文件
    try {
      const { getSifiganVersionPath } = require('../modelManager');
      fs.unlinkSync(getSifiganVersionPath(modelDir));
    } catch (_) {}

    // Reset vocoderType to default so next inference uses the default vocoder
    try {
      const settings = loadSettings();
      if (settings.vocoderType && settings.vocoderType !== 'default') {
        settings.vocoderType = 'default';
        await saveSettingsFile(settings);
      }
    } catch (err) {
      console.warn('[Main] Failed to reset vocoderType:', err.message);
    }

    // Release the loaded SiFiGAN InferenceSession via the SVS pipeline.
    // The sessionKey for SiFiGAN is 'sifigan' (see modelRegistry.js).
    // We do NOT tear down the whole pipeline — only unload this one session.
    // On next inference the pipeline will see vocoderType='default' and load
    // the standard vocoder_dml.onnx instead.
    try {
      const { getSvsPipeline } = require('./svsIpc');
      const pipeline = getSvsPipeline();
      if (pipeline && pipeline.initialized && typeof pipeline.unloadModel === 'function') {
        pipeline.unloadModel('sifigan');
      }
    } catch (err) {
      console.warn('[Main] Failed to release SiFiGAN InferenceSession:', err.message);
    }

    // Re-check files after deletion to return fresh state
    const { allExist, files } = checkSifiganFilesExist(modelDir);
    return {
      success: true,
      deleted: result.deleted,
      errors: result.errors,
      status: allExist ? 'installed' : 'download_url_not_configured',
      allExist,
      files,
    };
  });

  // ===== Model version management IPC handlers =====

  // Check model version for a given precision (or all precisions)
  // Returns { updateAvailable, localVersion, latestVersion, hasModelFiles }
  ipcMain.handle('model-download:check-version', async (event, precision) => {
    const modelDir = getModelDir();
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    return await checkModelVersion(modelDir, currentPrecision);
  });

  // Check JP model version
  ipcMain.handle('model-download:check-jp-version', async (event, precision) => {
    const modelDir = getModelDir();
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    return await checkJpModelVersion(modelDir, currentPrecision);
  });

  // Check SiFiGAN model version
  ipcMain.handle('model-download:check-sifigan-version', async () => {
    const modelDir = getModelDir();
    return await checkSifiganVersion(modelDir);
  });

  // Check versions for all model groups at once (main + jp + sifigan)
  // Returns { main, jp, sifigan } where each is the version check result
  ipcMain.handle('model-download:check-all-versions', async (event, precision) => {
    const modelDir = getModelDir();
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    const [main, jp, sifigan] = await Promise.all([
      checkModelVersion(modelDir, currentPrecision),
      checkJpModelVersion(modelDir, currentPrecision),
      checkSifiganVersion(modelDir),
    ]);
    return { main, jp, sifigan };
  });

  // Update models: delete existing files for the precision and re-download
  // from ModelScope. This is used when a model update is available or when
  // switching to a different version (revision).
  ipcMain.handle('model-download:update', async (event, precision, revision) => {
    const modelDir = getModelDir();
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    // If no revision (tag) specified or 'latest' requested, fetch the latest tag from ModelScope
    let currentRevision = revision;
    if (!currentRevision || currentRevision === 'latest') {
      try {
        const tags = await getModelTags(currentPrecision);
        currentRevision = getLatestTag(tags);
      } catch (err) {
        return { success: false, error: `Failed to fetch model tags: ${err.message}` };
      }
    }
    if (!currentRevision) {
      return { success: false, error: 'No model tags available for download' };
    }
    if (!isPrecisionDownloadable(currentPrecision)) {
      return { success: false, error: `Download not available for precision: ${currentPrecision}` };
    }

    // Delete existing model files (including version.json) then re-download
    deleteModelFiles(modelDir, currentPrecision);
    // Also delete the version file so it gets re-created on successful download
    try {
      const { getModelVersionPath } = require('../modelManager');
      fs.unlinkSync(getModelVersionPath(modelDir, currentPrecision));
    } catch (_) {}

    const { missing } = checkMissingFiles(modelDir, currentPrecision);
    if (missing.length === 0) {
      // Edge case: all files somehow present. Save version and return.
      saveModelVersion(modelDir, currentPrecision, currentRevision);
      return { success: true };
    }

    // Open download window with the selected revision
    createModelDownloadWindow(missing, currentPrecision, DEFAULT_PRECISION, currentRevision);
    return { success: true, missingCount: missing.length };
  });

  // Update JP models: delete and re-download
  ipcMain.handle('model-download:update-jp', async (event, precision, revision) => {
    const { getJpLocalFilePath, getJpFileDownloadUrl, JP_MODEL_IDS, JP_MODEL_FILE_MANIFEST } = require('../modelManager');
    const modelDir = getModelDir();
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    // If no revision (tag) specified or 'latest' requested, fetch the latest JP tag from ModelScope
    let currentRevision = revision;
    if (!currentRevision || currentRevision === 'latest') {
      try {
        const tags = await getJpModelTags(currentPrecision);
        currentRevision = getLatestTag(tags);
      } catch (err) {
        return { success: false, error: `Failed to fetch JP model tags: ${err.message}` };
      }
    }
    if (!currentRevision) {
      return { success: false, error: 'No JP model tags available for download' };
    }

    const jpModelId = JP_MODEL_IDS[currentPrecision] || JP_MODEL_IDS['fp16'];
    if (!jpModelId) {
      return { success: false, error: `JP models not available for precision: ${currentPrecision}` };
    }

    // Delete existing JP model files
    for (const file of JP_MODEL_FILE_MANIFEST) {
      const fullPath = getJpLocalFilePath(modelDir, file.filePath, currentPrecision);
      try { fs.unlinkSync(fullPath); } catch (_) {}
    }
    // Delete JP version file
    try {
      const { getJpModelVersionPath } = require('../modelManager');
      fs.unlinkSync(getJpModelVersionPath(modelDir, currentPrecision));
    } catch (_) {}
    invalidateJpModelsCache(modelDir, currentPrecision);

    // Re-check missing files and trigger download via the existing start-jp handler
    const { checkMissingJpFiles } = require('../modelManager');
    const { missing } = checkMissingJpFiles(modelDir, currentPrecision);
    if (missing.length === 0) {
      saveJpModelVersion(modelDir, currentPrecision, currentRevision);
      return { success: true };
    }

    // Trigger JP download through the existing start-jp IPC flow
    const win = getModelDownloadWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('model-download:missing-files', missing);
      win.webContents.send('model-download:precision', currentPrecision);
      if (currentRevision) {
        win.webContents.send('model-download:revision', currentRevision);
      }
    }
    return { success: true, missingCount: missing.length };
  });

  // Update SiFiGAN: delete and re-download
  ipcMain.handle('model-download:update-sifigan', async (event, revision) => {
    const modelDir = getModelDir();
    const sifiganId = MODEL_IDS.sifigan || '';
    if (!sifiganId) {
      return { status: 'download_url_not_configured', message: t('modelDownload.sifiganUrlNotConfigured') };
    }
    // If no revision (tag) specified or 'latest' requested, fetch the latest SiFiGAN tag from ModelScope
    let currentRevision = revision;
    if (!currentRevision || currentRevision === 'latest') {
      try {
        const tags = await getSifiganTags();
        currentRevision = getLatestTag(tags);
      } catch (err) {
        return { status: 'download_url_not_configured', message: `Failed to fetch SiFiGAN tags: ${err.message}` };
      }
    }
    if (!currentRevision) {
      return { status: 'download_url_not_configured', message: 'No SiFiGAN tags available for download' };
    }

    // Delete existing SiFiGAN files
    deleteSifiganFiles(modelDir);
    try {
      const { getSifiganVersionPath } = require('../modelManager');
      fs.unlinkSync(getSifiganVersionPath(modelDir));
    } catch (_) {}

    // Re-download via the existing start-sifigan handler logic
    const { allExist, files: existingFiles } = checkSifiganFilesExist(modelDir);
    if (allExist) {
      saveSifiganVersion(modelDir, currentRevision);
      return { status: 'installed', allExist, files: existingFiles };
    }

    // Trigger SiFiGAN download through the existing start-sifigan IPC flow
    // by calling the handler directly is not possible (it's registered as
    // an ipcMain.handle), so we return a signal for the renderer to call
    // model-download:start-sifigan instead.
    return { status: 'needs_download', allExist: false, files: existingFiles };
  });
}

module.exports = {
  startModelDownload,
  checkAndDownloadModels,
  registerModelDownloadIpc,
};
