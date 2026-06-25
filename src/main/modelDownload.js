const { ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { t } = require('./locale');
const { loadSettings, saveSettingsFile } = require('./settings');
const { isPathAllowed } = require('./security');
const { getModelDir, setCustomModelDir } = require('./modelDir');
const { checkMissingFiles, checkMissingFilesAsync, deleteModelFiles, downloadMissingFiles, DEFAULT_PRECISION, isPrecisionDownloadable } = require('../modelManager');
const { createModelDownloadWindow, getModelDownloadWindow, setModelDownloadWindow, getMainWindow } = require('./windowManager');

let downloadAbortController = null;

async function startModelDownload(modelDir, missingFiles, precision) {
  downloadAbortController = new AbortController();
  const abortSignal = downloadAbortController.signal;
  const currentPrecision = precision || DEFAULT_PRECISION;
  const modelDownloadWindow = getModelDownloadWindow();

  try {
    await downloadMissingFiles(modelDir, missingFiles, {
      abortSignal,
      precision: currentPrecision,
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
    console.log('[Main] 所有模型文件下载完成');
  } catch (err) {
    if (err.message === 'Download cancelled') {
      console.log('[Main] 模型下载已取消');
    } else {
      console.error('[Main] 模型下载失败:', err);
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
  console.log('[Main] 检查模型文件，目录:', modelDir, '精度:', precision);
  const { missing, existing } = await checkMissingFilesAsync(modelDir, precision);

  if (missing.length === 0) {
    console.log('[Main] 所有模型文件已就绪');
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
      console.log('[Main] 用户取消了模型下载位置选择');
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
      console.log('[Main] 所选目录中模型文件已就绪');
      return true;
    }

    console.log(`[Main] 缺少 ${recheck.missing.length} 个模型文件:`, recheck.missing.map(f => f.filePath));
    createModelDownloadWindow(recheck.missing, precision, DEFAULT_PRECISION);
    return false;
  }

  console.log(`[Main] 缺少 ${missing.length} 个模型文件:`, missing.map(f => f.filePath));
  createModelDownloadWindow(missing, precision, DEFAULT_PRECISION);
  return false;
}

function getCustomModelDir() {
  const { getCustomModelDir: getCustom } = require('./modelDir');
  return getCustom();
}

function registerModelDownloadIpc() {
  ipcMain.handle('model-download:start', async (event, precision) => {
    const modelDir = getModelDir();
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
    if (!isPrecisionDownloadable(currentPrecision)) {
      return { success: false, error: `Download not available for precision: ${currentPrecision}` };
    }
    const { missing } = checkMissingFiles(modelDir, currentPrecision);
    if (missing.length === 0) return { success: true };
    await startModelDownload(modelDir, missing, currentPrecision);
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

  ipcMain.handle('model-download:start-jp', async (event, precision) => {
    const { checkMissingJpFiles, getJpLocalFilePath, getJpFileDownloadUrl, JP_MODEL_IDS } = require('../modelManager');
    const modelDir = getModelDir();
    const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
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
        const url = getJpFileDownloadUrl(file.filePath, currentPrecision);
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
}

module.exports = {
  startModelDownload,
  checkAndDownloadModels,
  registerModelDownloadIpc,
};
