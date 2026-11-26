/**
 * .sxssinger 解析与「歌手编辑」入参构建。
 *
 * 刻意与 Electron 解耦：这里不 require('electron')，因此可以被 mocha 直接
 * 单测（主进程那边只负责对话框、文件 IO 与窗口）。解析失败的原因统一用
 * 错误码返回，由调用方决定提示文案。
 */

const SXSSINGER_FORMAT_VERSION = '1.0.0';

/** 从裸 base64 的图片字节推断 MIME，供 <img src="data:..."> 使用。 */
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return 'image/png';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return 'image/png';
}

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
    } catch (_e) {
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

/**
 * 把 .sxssinger 的 JSON 文本转换成「打开预处理窗口」所需的入参。
 *
 * @param {string} rawText 文件内容
 * @param {string} filePath 绝对路径（保存时写回同一路径）
 * @returns {{ok: true, payload: object, warnings: string[]} | {ok: false, error: string, code: string}}
 */
function buildSingerEditPayload(rawText, filePath) {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    return { ok: false, code: 'EMPTY', error: 'Singer file is empty' };
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (_e) {
    return { ok: false, code: 'INVALID_JSON', error: 'Not a valid singer file (JSON parse failed)' };
  }

  const check = validateSingerFileData(data);
  if (!check.valid) {
    return { ok: false, code: 'INVALID_DATA', error: check.errors.join('; ') };
  }

  // 渲染进程用 decodeAudioData(buffer.slice(0))，必须给 ArrayBuffer；
  // Buffer 经 IPC 结构化克隆会变成 Uint8Array，会被 decodeAudioData 拒绝。
  const wavBytes = Buffer.from(data.wavBase64, 'base64');
  const wavBuffer = wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength);
  let avatarImageData = null;
  let avatarImageName = '';
  if (typeof data.avatarBase64 === 'string' && data.avatarBase64.length > 0) {
    const avatarBuf = Buffer.from(data.avatarBase64, 'base64');
    avatarImageData = `data:${sniffImageMime(avatarBuf)};base64,${data.avatarBase64}`;
    avatarImageName = 'avatar';
  }

  const payload = {
    wavBuffer,
    wavFileName: data.wavFileName || (filePath ? filePath.split(/[\\/]/).pop() : 'audio.wav'),
    duration: data.wavDuration,
    singerName: data.singerName,
    singerColor: data.color,
    avatarImageData,
    avatarImageName,
    edit: {
      filePath,
      singerName: data.singerName,
      color: data.color,
      avatarImageData,
      avatarImageName,
      midiNotes: Array.isArray(data.midiNotes) ? data.midiNotes : [],
      f0Data: Array.isArray(data.f0Data) ? data.f0Data : [],
      singerData: data.singerData || null,
    },
  };

  return { ok: true, payload, warnings: check.warnings };
}

module.exports = {
  SXSSINGER_FORMAT_VERSION,
  sniffImageMime,
  validateSingerFileData,
  buildSingerEditPayload,
};
