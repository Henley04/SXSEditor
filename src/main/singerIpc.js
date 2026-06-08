const { ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const { t } = require('./locale');
const { getMainWindow } = require('./windowManager');

const SXSSINGER_FORMAT_VERSION = '1.0.0';

function validateSingerFileData(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== 'object') {
    errors.push('文件内容不是有效的JSON对象');
    return { valid: false, errors, warnings };
  }

  if (!data.singerName || typeof data.singerName !== 'string') {
    errors.push('缺少歌手名称(singerName)或格式不正确');
  } else if (data.singerName.trim().length === 0) {
    errors.push('歌手名称(singerName)不能为空');
  } else if (data.singerName.length > 100) {
    warnings.push('歌手名称(singerName)过长，可能显示异常');
  }

  if (data.color !== undefined && data.color !== null) {
    if (typeof data.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(data.color)) {
      warnings.push('颜色(color)格式不正确，应为#RRGGBB格式，将使用默认颜色');
    }
  }

  if (!data.wavBase64 || typeof data.wavBase64 !== 'string') {
    errors.push('缺少参考音频数据(wavBase64)或格式不正确');
  } else {
    try {
      const wavBuf = Buffer.from(data.wavBase64, 'base64');
      if (wavBuf.length < 44) {
        errors.push('参考音频数据(wavBase64)过小，不是有效的WAV文件');
      } else if (wavBuf.length > 50 * 1024 * 1024) {
        warnings.push('参考音频数据(wavBase64)超过50MB，可能导致性能问题');
      }
    } catch (e) {
      errors.push('参考音频数据(wavBase64)Base64解码失败');
    }
  }

  if (data.wavDuration !== undefined && data.wavDuration !== null) {
    if (typeof data.wavDuration !== 'number' || data.wavDuration <= 0) {
      warnings.push('音频时长(wavDuration)格式不正确，将尝试从音频数据推断');
    } else if (data.wavDuration > 60) {
      warnings.push('音频时长超过60秒，建议使用较短的参考音频');
    }
  }

  if (data.midiNotes !== undefined && data.midiNotes !== null) {
    if (!Array.isArray(data.midiNotes)) {
      warnings.push('MIDI音符数据(midiNotes)格式不正确，将被忽略');
    } else {
      for (let i = 0; i < data.midiNotes.length; i++) {
        const note = data.midiNotes[i];
        if (!note || typeof note !== 'object') {
          warnings.push(`第${i + 1}个MIDI音符数据格式不正确`);
          break;
        }
        if (typeof note.pitch !== 'number' || note.pitch < 0 || note.pitch > 127) {
          warnings.push(`第${i + 1}个MIDI音符的pitch值异常(${note.pitch})`);
          break;
        }
      }
    }
  }

  if (data.f0Data !== undefined && data.f0Data !== null) {
    if (!Array.isArray(data.f0Data)) {
      warnings.push('F0数据(f0Data)格式不正确，将被忽略');
    }
  }

  if (data.singerData !== undefined && data.singerData !== null) {
    if (typeof data.singerData !== 'object') {
      warnings.push('歌手推理数据(singerData)格式不正确，将被忽略');
    }
  }

  if (data.avatarBase64 !== undefined && data.avatarBase64 !== null) {
    if (typeof data.avatarBase64 !== 'string') {
      warnings.push('头像数据(avatarBase64)格式不正确，将被忽略');
    }
  }

  if (data.formatVersion !== undefined && typeof data.formatVersion !== 'string') {
    warnings.push('版本号(formatVersion)格式不正确');
  }

  return { valid: errors.length === 0, errors, warnings };
}

function registerSingerIpc() {
  ipcMain.handle('saveSingerFile', async (event, singerData) => {
    try {
      const result = await dialog.showSaveDialog({
        title: t('dialog.saveSingerFile'),
        defaultPath: `${(singerData.singerName || '未命名歌手').replace(/[\\/:*?"<>|]/g, '_')}.sxssinger`,
        filters: [{ name: 'SXS Singer', extensions: ['sxssinger'] }],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, error: '用户取消保存' };
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

      await fs.promises.writeFile(result.filePath, singerFileContent);

      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('singerCreated', {
          filePath: result.filePath,
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

      return { success: true };
    } catch (err) {
      console.error('保存歌手文件失败:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerSingerIpc,
  validateSingerFileData,
  SXSSINGER_FORMAT_VERSION,
};
