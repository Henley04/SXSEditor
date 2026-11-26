const { dialog } = require('electron');
const { safeHandle } = require('./ipcSafe');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('worker_threads');
const { t } = require('./locale');
const { getMainWindow, openAudioPreprocess } = require('./windowManager');
const { isPathAllowed, isSystemPath, authorizePath } = require('./security');
const { IPC_CHANNELS } = require('../shared/ipcChannels');

const {
  SXSSINGER_FORMAT_VERSION,
  validateSingerFileData,
  buildSingerEditPayload,
} = require('../shared/singerFileEdit');

// 歌手文件内嵌 WAV（base64），50MB 音频会膨胀到 ~67MB。留足余量但挡住误选的大文件。
const MAX_SINGER_FILE_BYTES = 300 * 1024 * 1024;

/**
 * Offload WAV base64 encoding + JSON.stringify to a worker_thread so the
 * main thread is not blocked for hundreds of ms on large WAV files.
 * The worker is created inline (eval) and terminated after a single use.
 * Returns the serialized singer file content string.
 */
function encodeSingerFileContentAsync(singerData, fields) {
  const singerObj = {
    formatVersion: SXSSINGER_FORMAT_VERSION,
    singerName: singerData.singerName,
    color: singerData.color,
    avatarBase64: fields.avatarBase64,
    wavFileName: singerData.wavFileName,
    wavDuration: singerData.duration,
    isPreprocessed: singerData.isPreprocessed,
    midiNotes: fields.midiNotes,
    f0Data: fields.f0Data,
    singerData: fields.singerData,
  };

  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort } = require('worker_threads');
      parentPort.on('message', (msg) => {
        try {
          const wavBase64 = Buffer.from(msg.wavBuffer).toString('base64');
          const content = JSON.stringify({ ...msg.singerObj, wavBase64 }, null, 2);
          parentPort.postMessage(content);
        } catch (err) {
          parentPort.postMessage({ error: err.message });
        }
      });
    `, { eval: true });

    worker.on('message', (msg) => {
      worker.terminate();
      if (typeof msg === 'string') {
        resolve(msg);
      } else {
        reject(new Error(msg.error || 'encodeSingerFileContentAsync failed'));
      }
    });
    worker.on('error', (err) => {
      worker.terminate();
      reject(err);
    });

    worker.postMessage({ wavBuffer: singerData.wavBuffer, singerObj });
  });
}

/**
 * 打开已有 .sxssinger 进入「歌手编辑」。
 *
 * 复用预处理窗口（音高/MIDI 编辑能力原本就在那里），只是额外把已有的
 * midiNotes / f0Data / singerData / 文件路径一起送进去，保存时写回原文件，
 * 而不是新建一个歌手。
 */
async function openSingerFileForEdit() {
  const mainWindow = getMainWindow();
  const dialogOptions = {
    title: t('dialog.openSingerFile'),
    filters: [{ name: 'SXS Singer', extensions: ['sxssinger'] }],
    properties: ['openFile'],
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  return openSingerFileAt(result.filePaths[0]);
}

/**
 * 按路径打开歌手文件并进入编辑 —— 对话框版与系统"双击/打开方式"共用。
 *
 * 路径可能来自注册表命令行，属于外部输入，所以这里再校验一次扩展名：
 * 上层（fileAssociation）已经按扩展名筛过，但那是分发逻辑，不该是唯一防线。
 */
async function openSingerFileAt(rawPath) {
  try {
    const filePath = path.resolve(rawPath);
    if (!filePath.toLowerCase().endsWith('.sxssinger')) {
      return { success: false, error: t('dialog.singerFileInvalid') };
    }
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return { success: false, error: t('dialog.singerFileInvalid') };
    if (stat.size > MAX_SINGER_FILE_BYTES) {
      return { success: false, error: t('dialog.singerFileTooLarge') };
    }

    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = buildSingerEditPayload(raw, filePath);
    if (!parsed.ok) {
      const invalid = parsed.code === 'INVALID_JSON' || parsed.code === 'INVALID_DATA';
      console.warn('[SingerEditor] rejected file:', parsed.code, parsed.error);
      return { success: false, error: invalid ? t('dialog.singerFileInvalid') : parsed.error };
    }

    // 编辑后要写回同一个路径：显式授权，否则保存时会被 isPathAllowed 拒绝。
    authorizePath(filePath);
    openAudioPreprocess(parsed.payload);

    return { success: true, filePath };
  } catch (err) {
    console.error('[SingerEditor] open failed:', err);
    return { success: false, error: err.message };
  }
}

function registerSingerIpc() {
  safeHandle(IPC_CHANNELS.OPEN_SINGER_EDITOR, () => openSingerFileForEdit());
  // 系统"打开方式"/双击 .sxssinger：路径由主进程分发过来，不再弹选择框
  safeHandle(IPC_CHANNELS.SINGER_OPEN_AT, (event, filePath) => openSingerFileAt(filePath));

  safeHandle(IPC_CHANNELS.SAVE_SINGER_FILE, async (event, singerData) => {
    try {
      // If filePath is provided, save directly to it (save-in-place).
      // Otherwise show a Save As dialog to pick a path.
      let filePath = singerData.filePath || null;

      if (!filePath) {
        const result = await dialog.showSaveDialog({
          title: t('dialog.saveSingerFile'),
          defaultPath: `${(singerData.singerName || 'Unnamed Singer').replace(/[\\/:*?"<>|]/g, '_')}.sxssinger`,
          filters: [{ name: 'SXS Singer', extensions: ['sxssinger'] }],
        });

        if (result.canceled || !result.filePath) {
          return { success: false, error: 'User cancelled save', canceled: true };
        }
        filePath = result.filePath;
        // The dialog picks the path, so authorize it for subsequent reads.
        authorizePath(filePath);
      } else {
        // Renderer-supplied save-in-place path: validate before writing to
        // prevent arbitrary file writes. Must be an allowed, non-system path
        // and have the .sxssinger extension.
        const resolved = path.resolve(filePath);
        if (isSystemPath(resolved)) {
          return { success: false, error: 'Cannot write to system directory' };
        }
        if (!isPathAllowed(resolved)) {
          return { success: false, error: t('error.pathNotAllowed') };
        }
        if (!resolved.toLowerCase().endsWith('.sxssinger')) {
          return { success: false, error: 'Invalid file extension' };
        }
        filePath = resolved;
      }

      const hasPreprocessResult = singerData.preprocessResult && singerData.preprocessResult.singerData;
      const midiNotesToSave = hasPreprocessResult ? singerData.preprocessResult.midiNotes : null;
      const f0DataToSave = hasPreprocessResult ? singerData.preprocessResult.f0Data : null;
      const singerDataToSave = hasPreprocessResult ? singerData.preprocessResult.singerData : null;

      let avatarBase64 = null;
      if (singerData.avatarImageData && singerData.avatarImageName) {
        const avatarDataUrl = singerData.avatarImageData;
        avatarBase64 = avatarDataUrl.split(',')[1];
      }

      const singerFileContent = await encodeSingerFileContentAsync(singerData, {
        midiNotes: midiNotesToSave,
        f0Data: f0DataToSave,
        singerData: singerDataToSave,
        avatarBase64,
      });

      await fs.promises.writeFile(filePath, singerFileContent);

      // Only notify the main window when explicitly requested (first save that
      // actually creates the singer in the project). Subsequent saves / save-as
      // must not add duplicate singer entries.
      const shouldNotify = singerData.notifyMainWindow === true;
      if (shouldNotify) {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.SINGER_CREATED, {
            filePath: filePath,
            singerName: singerData.singerName,
            color: singerData.color,
            avatarPath: avatarBase64,
            wavPath: null,
            midiPath: null,
            wavBuffer: singerData.wavBuffer,
            midiNotes: midiNotesToSave,
            f0Data: f0DataToSave,
            singerData: singerDataToSave,
          });
        }
      }

      // 歌手编辑：文件已存在，主窗口按 filePath 就地刷新对应歌手
      // （而不是走 SINGER_CREATED 再添加一条重复记录）。
      if (singerData.notifyMainWindowUpdate === true) {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.SINGER_UPDATED, {
            filePath,
            singerName: singerData.singerName,
            color: singerData.color,
            avatarPath: avatarBase64,
            wavBuffer: singerData.wavBuffer,
            midiNotes: midiNotesToSave,
            f0Data: f0DataToSave,
            singerData: singerDataToSave,
          });
        }
      }

      return { success: true, filePath, canceled: false };
    } catch (err) {
      console.error('Failed to save singer file:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerSingerIpc,
  openSingerFileForEdit,
  openSingerFileAt,
  validateSingerFileData,
  SXSSINGER_FORMAT_VERSION,
};
