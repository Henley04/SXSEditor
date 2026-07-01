const { ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const { t } = require('./locale');
const { getMainWindow } = require('./windowManager');

const SXSSINGER_FORMAT_VERSION = '1.0.0';

function validateSingerFileData(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== 'object') {
    errors.push('File content is not a valid JSON object');
    return { valid: false, errors, warnings };
  }

  if (!data.singerName || typeof data.singerName !== 'string') {
    errors.push('Missing singerName or incorrect format');
  } else if (data.singerName.trim().length === 0) {
    errors.push('singerName cannot be empty');
  } else if (data.singerName.length > 100) {
    warnings.push('singerName too long, may display incorrectly');
  }

  if (data.color !== undefined && data.color !== null) {
    if (typeof data.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(data.color)) {
      warnings.push('color format incorrect, expected #RRGGBB format, will use default color');
    }
  }

  if (!data.wavBase64 || typeof data.wavBase64 !== 'string') {
    errors.push('Missing wavBase64 or incorrect format');
  } else {
    try {
      const wavBuf = Buffer.from(data.wavBase64, 'base64');
      if (wavBuf.length < 44) {
        errors.push('wavBase64 too small, not a valid WAV file');
      } else if (wavBuf.length > 50 * 1024 * 1024) {
        warnings.push('wavBase64 exceeds 50MB, may cause performance issues');
      }
    } catch (e) {
      errors.push('wavBase64 Base64 decode failed');
    }
  }

  if (data.wavDuration !== undefined && data.wavDuration !== null) {
    if (typeof data.wavDuration !== 'number' || data.wavDuration <= 0) {
      warnings.push('wavDuration format incorrect, will try to infer from audio data');
    } else if (data.wavDuration > 60) {
      warnings.push('Audio duration exceeds 60 seconds, recommend using shorter reference audio');
    }
  }

  if (data.midiNotes !== undefined && data.midiNotes !== null) {
    if (!Array.isArray(data.midiNotes)) {
      warnings.push('midiNotes format incorrect, will be ignored');
    } else {
      for (let i = 0; i < data.midiNotes.length; i++) {
        const note = data.midiNotes[i];
        if (!note || typeof note !== 'object') {
          warnings.push(`MIDI note ${i + 1} format incorrect`);
          break;
        }
        if (typeof note.pitch !== 'number' || note.pitch < 0 || note.pitch > 127) {
          warnings.push(`MIDI note ${i + 1} has abnormal pitch value (${note.pitch})`);
          break;
        }
      }
    }
  }

  if (data.f0Data !== undefined && data.f0Data !== null) {
    if (!Array.isArray(data.f0Data)) {
      warnings.push('f0Data format incorrect, will be ignored');
    }
  }

  if (data.singerData !== undefined && data.singerData !== null) {
    if (typeof data.singerData !== 'object') {
      warnings.push('singerData format incorrect, will be ignored');
    }
  }

  if (data.avatarBase64 !== undefined && data.avatarBase64 !== null) {
    if (typeof data.avatarBase64 !== 'string') {
      warnings.push('avatarBase64 format incorrect, will be ignored');
    }
  }

  if (data.formatVersion !== undefined && typeof data.formatVersion !== 'string') {
    warnings.push('formatVersion format incorrect');
  }

  return { valid: errors.length === 0, errors, warnings };
}

function registerSingerIpc() {
  ipcMain.handle('saveSingerFile', async (event, singerData) => {
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
      }

      const hasPreprocessResult = singerData.preprocessResult && singerData.preprocessResult.singerData;
      const midiNotesToSave = hasPreprocessResult ? singerData.preprocessResult.midiNotes : null;
      const f0DataToSave = hasPreprocessResult ? singerData.preprocessResult.f0Data : null;
      const singerDataToSave = hasPreprocessResult ? singerData.preprocessResult.singerData : null;

      const wavBase64 = Buffer.from(singerData.wavBuffer).toString('base64');

      let avatarBase64 = null;
      if (singerData.avatarImageData && singerData.avatarImageName) {
        const avatarDataUrl = singerData.avatarImageData;
        avatarBase64 = avatarDataUrl.split(',')[1];
      }

      const singerFileContent = JSON.stringify({
        formatVersion: SXSSINGER_FORMAT_VERSION,
        singerName: singerData.singerName,
        color: singerData.color,
        avatarBase64,
        wavBase64,
        wavFileName: singerData.wavFileName,
        wavDuration: singerData.duration,
        isPreprocessed: singerData.isPreprocessed,
        midiNotes: midiNotesToSave,
        f0Data: f0DataToSave,
        singerData: singerDataToSave,
      }, null, 2);

      await fs.promises.writeFile(filePath, singerFileContent);

      // Only notify the main window when explicitly requested (first save that
      // actually creates the singer in the project). Subsequent saves / save-as
      // must not add duplicate singer entries.
      const shouldNotify = singerData.notifyMainWindow === true;
      if (shouldNotify) {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('singerCreated', {
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

      return { success: true, filePath, canceled: false };
    } catch (err) {
      console.error('Failed to save singer file:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerSingerIpc,
  validateSingerFileData,
  SXSSINGER_FORMAT_VERSION,
};
