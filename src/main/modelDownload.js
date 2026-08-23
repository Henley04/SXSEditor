const { ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { t } = require('./locale');
const { loadSettings, saveSettingsFile } = require('./settings');
const { isPathAllowed, isSystemPath } = require('./security');
const { getModelDir, setCustomModelDir } = require('./modelDir');
const { checkMissingFiles, checkMissingFilesAsync, deleteModelFiles, downloadMissingFiles, DEFAULT_PRECISION, isPrecisionDownloadable, MODEL_IDS, getSifiganFileDownloadUrl, getFcpeFileDownloadUrl, getFcpeLocalFilePath, downloadFileWithRetry, downloadFileChunked, MIN_FILE_SIZE_FOR_CHUNKING, checkModelVersion, checkJpModelVersion, saveJpModelVersion, checkSifiganVersion, saveSifiganVersion, saveModelVersion, invalidateJpModelsCache, getModelTags, getJpModelTags, getSifiganTags, getFcpeRevision, getLatestTag, getRemoteFileSizeByUrl, saveFcpeVersion, checkFcpeVersion } = require('../modelManager');
const { createModelDownloadWindow, getModelDownloadWindow, getMainWindow } = require('./windowManager');

// W5: Per-download-key AbortController map. Replaces the single shared
// `downloadAbortController` global so concurrent downloads (main/JP/SiFiGAN)
// each keep their own cancel ability instead of overwriting one variable
// (which made the prior download uncancellable).
const downloadAbortControllers = new Map();

// W5: Per-destination-path mutex (Promise-chain). Serializes concurrent
// downloads to the same file path so two flows cannot interleave bytes
// into the same destination file.
const _downloadPathMutexes = new Map();
function withDownloadPathMutex(destPath, task) {
  const prev = _downloadPathMutexes.get(destPath) || Promise.resolve();
  // Run task after the previous holder releases, regardless of whether it
  // resolved or rejected (a failed download must not block later ones).
  const next = prev.then(() => task(), () => task());
  // Keep the chain alive as an always-resolving promise so a rejection in
  // task does not break subsequent waiters. `next` still reflects task's
  // actual result for the caller.
  _downloadPathMutexes.set(destPath, next.then(() => {}, () => {}));
  return next;
}

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

// ===== FCPE helpers =====
// FCPE is an optional pitch-detection model stored at onnx_models/preprocess/.
// The remote repo (MODEL_IDS.fcpe) hosts fcpe_model.onnx at its root; we
// place it at preprocess/fcpe_model.onnx (same dir as rmvpe/rosvot).
const FCPE_DOWNLOAD_FILES = [
  'fcpe_model.onnx',
];

function checkFcpeFilesExist(modelDir) {
  const result = {};
  for (const fileName of FCPE_DOWNLOAD_FILES) {
    const fullPath = getFcpeLocalFilePath(modelDir, fileName);
    let exists = false;
    let size = 0;
    try {
      const stats = fs.statSync(fullPath);
      if (stats.size > 0) {
        exists = true;
        size = stats.size;
      }
    } catch (_) {}
    result[fileName] = { exists, size, fullPath, local: true };
  }
  // FCPE 视为已安装: preprocess/fcpe_model.onnx 存在且非空
  const allExist = result['fcpe_model.onnx'] && result['fcpe_model.onnx'].exists;
  return { allExist, files: result };
}

function deleteFcpeFiles(modelDir) {
  const deleted = [];
  const errors = [];
  for (const fileName of FCPE_DOWNLOAD_FILES) {
    // 只删除该模型文件，避免误删 preprocess/ 下的 rmvpe/rosvot 等共享模型
    const fullPath = getFcpeLocalFilePath(modelDir, fileName);
    if (!fullPath) continue;
    try {
      fs.unlinkSync(fullPath);
      deleted.push(fileName);
    } catch (err) {
      if (err.code !== 'ENOENT') errors.push({ fileName, message: err.message });
    }
  }
  // 删除 FCPE 版本文件
  try {
    const { getFcpeVersionPath } = require('../modelManager');
    fs.unlinkSync(getFcpeVersionPath(modelDir));
  } catch (_) {}
  return { deleted, errors };
}

async function startModelDownload(modelDir, missingFiles, precision, revision) {
  // W5: key the controller by download type so a concurrent JP/SiFiGAN
  // download does not overwrite this one's cancel handle.
  const downloadKey = 'main';
  const downloadAbortController = new AbortController();
  downloadAbortControllers.set(downloadKey, downloadAbortController);
  const abortSignal = downloadAbortController.signal;
  const currentPrecision = precision || DEFAULT_PRECISION;
  const _modelDownloadWindow = getModelDownloadWindow();

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
      onFilesResolved: (resolvedFiles) => {
        // 远程检测后文件列表可能变化（补充了 data 文件或过滤了远程不存在的文件），
        // 推送给渲染进程让 UI 显示最终的下载列表
        const win = getModelDownloadWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('model-download:missing-files', resolvedFiles);
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
    downloadAbortControllers.delete(downloadKey);
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
  const { missing } = await checkMissingFilesAsync(modelDir, precision);

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

  // W5: cancel a specific in-flight download by key (e.g. 'main' | 'jp' |
  // 'sifigan'), or — for backwards compatibility — abort all in-flight
  // downloads when no key is provided.
  ipcMain.handle('model-download:cancel', async (event, key) => {
    if (key) {
      const controller = downloadAbortControllers.get(key);
      if (controller) {
        controller.abort();
        downloadAbortControllers.delete(key);
      }
    } else {
      for (const controller of downloadAbortControllers.values()) {
        controller.abort();
      }
      downloadAbortControllers.clear();
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

    // W11: reject system directories (e.g. C:\Windows) and unwritable paths
    // before persisting the choice, so model files are never written into a
    // system directory or a location the user cannot write to.
    const resolvedDir = path.resolve(downloadDir);
    if (isSystemPath(resolvedDir)) {
      return { success: false, error: 'Cannot use system directory for model storage' };
    }
    try {
      fs.accessSync(resolvedDir, fs.constants.W_OK);
    } catch (_) {
      return { success: false, error: 'Selected directory is not writable' };
    }

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

    // W5: per-key AbortController so a concurrent main/SiFiGAN download
    // cannot overwrite this download's cancel handle.
    const jpDownloadKey = 'jp';
    const downloadAbortController = new AbortController();
    downloadAbortControllers.set(jpDownloadKey, downloadAbortController);
    const abortSignal = downloadAbortController.signal;
    const _modelDownloadWindow = getModelDownloadWindow();

    try {
      // Download JP files to the JP subdirectory
      const _jpMissingFiles = missing.map(f => ({
        ...f,
        _jpFilePath: getJpLocalFilePath(modelDir, f.filePath, currentPrecision),
      }));

      // Use custom download for JP files
      for (const file of missing) {
        const destPath = getJpLocalFilePath(modelDir, file.filePath, currentPrecision);
        const url = getJpFileDownloadUrl(file.filePath, currentPrecision, currentRevision);
        if (!url) continue;

        const { downloadFileWithRetry } = require('../modelManager');
        // W5: serialize on the destination path so a concurrent download to
        // the same file cannot interleave bytes.
        await withDownloadPathMutex(destPath, () => downloadFileWithRetry(url, destPath, { abortSignal }));

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
      downloadAbortControllers.delete(jpDownloadKey);
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

    // W5: per-key AbortController so a concurrent main/JP download cannot
    // overwrite this download's cancel handle.
    const sifiganDownloadKey = 'sifigan';
    const downloadAbortController = new AbortController();
    downloadAbortControllers.set(sifiganDownloadKey, downloadAbortController);
    const abortSignal = downloadAbortController.signal;
    const win = getModelDownloadWindow();

    try {
      // Fetch all remote file sizes in parallel using Range requests for
      // accurate size detection (ModelScope CDN: HEAD returns 404, GET returns
      // 302 redirect page size; only GET+Range returns the correct size).
      const fileUrls = missingFiles.map(fileName => getSifiganFileDownloadUrl(fileName, currentRevision));
      const sizeResults = await Promise.all(
        fileUrls.map(url => url ? getRemoteFileSizeByUrl(url) : Promise.resolve(0))
      );
      const fileSizes = {};
      let overallTotal = 0;
      for (let i = 0; i < missingFiles.length; i++) {
        fileSizes[missingFiles[i]] = sizeResults[i];
        overallTotal += sizeResults[i];
      }
      let cumulativeDownloaded = 0;

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

        const remoteSize = fileSizes[fileName] || 0;
        const fileBaseDownloaded = cumulativeDownloaded;

        // Use chunked download for large files, single-threaded for small
        if (remoteSize >= MIN_FILE_SIZE_FOR_CHUNKING) {
          // W5: serialize on the destination path so a concurrent download
          // to the same file cannot interleave bytes.
          await withDownloadPathMutex(destPath, () => downloadFileChunked(url, destPath, remoteSize, {
            abortSignal,
            onProgress: (downloaded, total) => {
              if (win && !win.isDestroyed()) {
                win.webContents.send('model-download:progress', {
                  currentFile: fileName,
                  fileIndex: missingFiles.indexOf(fileName),
                  totalFiles: missingFiles.length,
                  bytesDownloaded: downloaded,
                  bytesTotal: total,
                  overallDownloaded: fileBaseDownloaded + downloaded,
                  overallTotal: overallTotal,
                });
              }
            },
          }));
        } else {
          // W5: serialize on the destination path so a concurrent download
          // to the same file cannot interleave bytes.
          await withDownloadPathMutex(destPath, () => downloadFileWithRetry(url, destPath, {
            abortSignal,
            onProgress: (downloaded, total) => {
              if (win && !win.isDestroyed()) {
                win.webContents.send('model-download:progress', {
                  currentFile: fileName,
                  fileIndex: missingFiles.indexOf(fileName),
                  totalFiles: missingFiles.length,
                  bytesDownloaded: downloaded,
                  bytesTotal: total,
                  overallDownloaded: fileBaseDownloaded + downloaded,
                  overallTotal: overallTotal,
                });
              }
            },
          }));
        }

        cumulativeDownloaded += remoteSize;

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
      downloadAbortControllers.delete(sifiganDownloadKey);
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

  // ===== FCPE (optional pitch detector) IPC handlers =====
  // FCPE is an optional shared model. Download maps the repo-root file
  // fcpe_model.onnx to preprocess/fcpe_model.onnx under onnx_models/.

  // Returns: { status: 'installed' | 'not_downloaded' | 'download_url_not_configured',
  //            files: { ... }, allExist: boolean }
  ipcMain.handle('model-download:check-fcpe', async () => {
    const modelDir = getModelDir();
    const { allExist, files } = checkFcpeFilesExist(modelDir);
    const fcpeId = MODEL_IDS.fcpe || '';
    let status;
    if (allExist) {
      status = 'installed';
    } else if (!fcpeId) {
      status = 'download_url_not_configured';
    } else {
      status = 'not_downloaded';
    }
    return {
      status,
      allExist,
      files,
      modelId: fcpeId,
      message: status === 'download_url_not_configured'
        ? t('modelDownload.fcpeUrlNotConfigured')
        : '',
    };
  });

  // Start FCPE download. Downloads fcpe_model.onnx from MODEL_IDS.fcpe and
  // places it at preprocess/fcpe_model.onnx. Uses chunked download for the
  // ~47MB file.
  ipcMain.handle('model-download:start-fcpe', async (event, revision) => {
    const fcpeId = MODEL_IDS.fcpe || '';
    // If no revision resolved, fall back to the latest tag or 'master'
    // (the FCPE repo currently has no tags — master is used).
    let currentRevision = revision;
    if (!currentRevision || currentRevision === 'latest') {
      if (fcpeId) {
        try {
          currentRevision = await getFcpeRevision();
        } catch (err) {
          return { status: 'download_url_not_configured', message: `Failed to fetch FCPE revision: ${err.message}` };
        }
      }
    }
    if (!fcpeId) {
      const modelDir = getModelDir();
      const { allExist, files } = checkFcpeFilesExist(modelDir);
      return {
        status: 'download_url_not_configured',
        message: t('modelDownload.fcpeUrlNotConfigured'),
        allExist,
        files,
      };
    }
    if (!currentRevision) {
      return { status: 'download_url_not_configured', message: 'No FCPE revision available for download' };
    }

    const modelDir = getModelDir();
    const { allExist, files: existingFiles } = checkFcpeFilesExist(modelDir);
    if (allExist) {
      return { status: 'installed', allExist, files: existingFiles };
    }

    // Build the list of missing files to download.
    const missingFiles = FCPE_DOWNLOAD_FILES.filter(name => !existingFiles[name] || !existingFiles[name].exists)
      .map(name => ({ remote: name, local: getFcpeLocalFilePath(modelDir, name) }))
      .filter(f => !!f.local);
    if (missingFiles.length === 0) {
      return { status: 'installed', allExist: true, files: existingFiles };
    }

    const fcpeDownloadKey = 'fcpe';
    const downloadAbortController = new AbortController();
    downloadAbortControllers.set(fcpeDownloadKey, downloadAbortController);
    const abortSignal = downloadAbortController.signal;
    const win = getModelDownloadWindow();

    try {
      // Fetch all remote file sizes in parallel using Range requests
      const fileUrls = missingFiles.map(f => getFcpeFileDownloadUrl(f.remote, currentRevision));
      const sizeResults = await Promise.all(
        fileUrls.map(url => url ? getRemoteFileSizeByUrl(url) : Promise.resolve(0))
      );
      const fileSizes = {};
      let overallTotal = 0;
      for (let i = 0; i < missingFiles.length; i++) {
        fileSizes[missingFiles[i].remote] = sizeResults[i];
        overallTotal += sizeResults[i];
      }
      let cumulativeDownloaded = 0;

      for (let i = 0; i < missingFiles.length; i++) {
        if (abortSignal.aborted) throw new Error('Download cancelled');

        const { remote, local } = missingFiles[i];
        const destPath = local;
        const url = getFcpeFileDownloadUrl(remote, currentRevision);
        if (!url) {
          throw new Error(`Failed to build download URL for ${remote}`);
        }

        // Ensure parent directory exists
        fs.mkdirSync(path.dirname(destPath), { recursive: true });

        if (win && !win.isDestroyed()) {
          win.webContents.send('model-download:file-start', {
            filePath: remote,
            fileIndex: i,
            totalFiles: missingFiles.length,
          });
        }

        const remoteSize = fileSizes[remote] || 0;
        const fileBaseDownloaded = cumulativeDownloaded;

        // Use chunked download for the ~47MB file
        if (remoteSize >= MIN_FILE_SIZE_FOR_CHUNKING) {
          await withDownloadPathMutex(destPath, () => downloadFileChunked(url, destPath, remoteSize, {
            abortSignal,
            onProgress: (downloaded, total) => {
              if (win && !win.isDestroyed()) {
                win.webContents.send('model-download:progress', {
                  currentFile: remote,
                  fileIndex: i,
                  totalFiles: missingFiles.length,
                  bytesDownloaded: downloaded,
                  bytesTotal: total,
                  overallDownloaded: fileBaseDownloaded + downloaded,
                  overallTotal: overallTotal,
                });
              }
            },
          }));
        } else {
          await withDownloadPathMutex(destPath, () => downloadFileWithRetry(url, destPath, {
            abortSignal,
            onProgress: (downloaded, total) => {
              if (win && !win.isDestroyed()) {
                win.webContents.send('model-download:progress', {
                  currentFile: remote,
                  fileIndex: i,
                  totalFiles: missingFiles.length,
                  bytesDownloaded: downloaded,
                  bytesTotal: total,
                  overallDownloaded: fileBaseDownloaded + downloaded,
                  overallTotal: overallTotal,
                });
              }
            },
          }));
        }

        cumulativeDownloaded += remoteSize;

        if (win && !win.isDestroyed()) {
          win.webContents.send('model-download:file-complete', {
            filePath: remote,
            fileIndex: i,
            totalFiles: missingFiles.length,
          });
        }
      }

      // All downloads complete — re-check files
      const { allExist: nowExists, files: finalFiles } = checkFcpeFilesExist(modelDir);
      if (nowExists) {
        saveFcpeVersion(modelDir, currentRevision);
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send('model-download:complete');
      }
      console.log('[Main] FCPE model download complete');
      return {
        status: nowExists ? 'installed' : 'not_downloaded',
        allExist: nowExists,
        files: finalFiles,
      };
    } catch (err) {
      if (err.message === 'Download cancelled') {
        console.log('[Main] FCPE model download cancelled');
      } else {
        console.error('[Main] FCPE model download failed:', err);
        if (win && !win.isDestroyed()) {
          win.webContents.send('model-download:error', { message: err.message });
        }
      }
      const { allExist: errExists, files: errFiles } = checkFcpeFilesExist(modelDir);
      return {
        status: errExists ? 'installed' : 'not_downloaded',
        allExist: errExists,
        files: errFiles,
      };
    } finally {
      downloadAbortControllers.delete(fcpeDownloadKey);
    }
  });

  // Unload FCPE: delete the model file + version file, and release any loaded
  // FCPE InferenceSession via the pipeline.
  ipcMain.handle('model-download:unload-fcpe', async () => {
    const modelDir = getModelDir();
    const result = deleteFcpeFiles(modelDir);

    // Release the loaded FCPE detector (managed via pitchMidiIpc's lazy
    // initializer, not the SVS pipeline session). On next load this ensures
    // a fresh session is created against the (now deleted) model.
    try {
      const { getFcpeDetector, fcpeLazy } = require('./pitchMidiIpc');
      const d = getFcpeDetector();
      if (d) { try { d.dispose(); } catch (_) {} }
      fcpeLazy.reset();
    } catch (err) {
      console.warn('[Main] Failed to release FCPE detector:', err.message);
    }

    // Re-check files after deletion to return fresh state
    const { allExist, files } = checkFcpeFilesExist(modelDir);
    return {
      success: true,
      deleted: result.deleted,
      errors: result.errors,
      status: allExist ? 'installed' : 'not_downloaded',
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

  // Check FCPE model version
  ipcMain.handle('model-download:check-fcpe-version', async () => {
    const modelDir = getModelDir();
    return await checkFcpeVersion(modelDir);
  });

  // Check versions for all model groups at once (main + jp + sifigan + fcpe)
  // Returns { main, jp, sifigan, fcpe } where each is the version check result
  ipcMain.handle('model-download:check-all-versions', async (event, precision) => {
    const modelDir = getModelDir();
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    const [main, jp, sifigan, fcpe] = await Promise.all([
      checkModelVersion(modelDir, currentPrecision),
      checkJpModelVersion(modelDir, currentPrecision),
      checkSifiganVersion(modelDir),
      checkFcpeVersion(modelDir),
    ]);
    return { main, jp, sifigan, fcpe };
  });

  // Update models: delete existing files for the precision and re-download
  // from ModelScope. This is used when a model update is available or when
  // switching to a different version (revision).
  // When invoked from an already-open download window, the download is
  // started in that window directly (createModelDownloadWindow would
  // otherwise no-op because the window already exists).
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

    // If a download window is already open (e.g. user clicked the update
    // button inside the download window), push the new missing-files list
    // and revision into it, then start the download in that same window.
    const existingWin = getModelDownloadWindow();
    if (existingWin && !existingWin.isDestroyed()) {
      existingWin.webContents.send('model-download:missing-files', missing);
      existingWin.webContents.send('model-download:precision', currentPrecision);
      existingWin.webContents.send('model-download:revision', currentRevision);
      await startModelDownload(modelDir, missing, currentPrecision, currentRevision);
      return { success: true, missingCount: missing.length };
    }

    // No existing window — create one. The renderer will call
    // model-download:start with the pre-resolved revision.
    createModelDownloadWindow(missing, currentPrecision, DEFAULT_PRECISION, currentRevision);
    return { success: true, missingCount: missing.length };
  });

  // Update JP models: delete and re-download
  ipcMain.handle('model-download:update-jp', async (event, precision, revision) => {
    const { getJpLocalFilePath, JP_MODEL_IDS, JP_MODEL_FILE_MANIFEST } = require('../modelManager');
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

  // Update FCPE: delete and re-download
  ipcMain.handle('model-download:update-fcpe', async (event, revision) => {
    const modelDir = getModelDir();
    const fcpeId = MODEL_IDS.fcpe || '';
    if (!fcpeId) {
      return { status: 'download_url_not_configured', message: t('modelDownload.fcpeUrlNotConfigured') };
    }
    // Resolve revision (no tags → 'master' branch)
    let currentRevision = revision;
    if (!currentRevision || currentRevision === 'latest') {
      try {
        currentRevision = await getFcpeRevision();
      } catch (err) {
        return { status: 'download_url_not_configured', message: `Failed to fetch FCPE revision: ${err.message}` };
      }
    }
    if (!currentRevision) {
      return { status: 'download_url_not_configured', message: 'No FCPE revision available for download' };
    }

    // Delete existing FCPE files + version file
    deleteFcpeFiles(modelDir);

    const { allExist, files: existingFiles } = checkFcpeFilesExist(modelDir);
    if (allExist) {
      saveFcpeVersion(modelDir, currentRevision);
      return { status: 'installed', allExist, files: existingFiles };
    }

    // Signal the renderer to call model-download:start-fcpe
    return { status: 'needs_download', allExist: false, files: existingFiles };
  });
}

module.exports = {
  startModelDownload,
  checkAndDownloadModels,
  registerModelDownloadIpc,
};
