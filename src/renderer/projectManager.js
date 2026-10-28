import { state, dom, trackManager, history } from './state.js';
import { SXSSINGER_CURRENT_VERSION, SAMPLE_RATE } from './constants.js';
// 工程格式版本收敛到单一常量（原来 '1.1.0' 与 [1,1,0] 两处硬编码，改一处会判错）
import { PROJECT_FORMAT_VERSION, PROJECT_MIN_READER, PROJECT_FEATURES, checkProjectHeader } from '../shared/projectFormat.js';
import { buildAutoCurve, resolvePitchRanges } from '../shared/autoPitchCurve.js';
import { computeActiveClippedNotes, lastNoteEnd } from '../shared/activeNotes.js';
import { t } from '../i18n/index.js';
import { showAlertDialog, showConfirmDialog } from '../alertDialog.js';
import { createDialog, showSingerValidationReport } from './uiControls.js';
import { createPluginBackendSection } from './pluginTrackDialog.js';
import { ensurePluginCatalog, findTrackKind } from './pluginBackend.js';
import { isPluginTrack, getSingerBackend } from '../editor/trackManager.js';

// 保存纪元：每次 markDirty 自增。异步写盘完成后只有纪元未变（期间没有新编辑）
// 才允许 markClean，否则会把写盘期间产生的新改动误标为"已保存"。
let _saveEpoch = 0;

export function markDirty() {
  state.isDirty = true;
  _saveEpoch++;
  if (window.electronAPI?.setDirty) {
    window.electronAPI.setDirty(true);
  }
}

export function markClean() {
  state.isDirty = false;
  if (window.electronAPI?.setDirty) {
    window.electronAPI.setDirty(false);
  }
}

// Undo/redo change in-memory content just like any edit, so they must mark
// the project dirty too. Otherwise the main process sees a "clean" window
// after Ctrl+Z/Ctrl+Y and closes it without prompting — silently losing the
// (now disk-divergent) state. The hook covers every undo/redo call site,
// including keyboard shortcuts and MCP automation.
history.onMutation = markDirty;

export function validateSingerData(singerData) {
  const errors = [];
  const warnings = [];

  if (!singerData || typeof singerData !== 'object') {
    errors.push(t('main.invalidJsonObject'));
    return { valid: false, errors, warnings };
  }

  if (singerData.formatVersion) {
    const parts = singerData.formatVersion.split('.').map(Number);
    const currentParts = SXSSINGER_CURRENT_VERSION.split('.').map(Number);
    if (parts[0] > currentParts[0]) {
      errors.push(t('main.singerVersionTooHigh', { version: singerData.formatVersion, currentVersion: SXSSINGER_CURRENT_VERSION }));
    } else if (parts[0] < currentParts[0]) {
      warnings.push(t('main.singerVersionTooLow', { version: singerData.formatVersion, currentVersion: SXSSINGER_CURRENT_VERSION }));
    } else if (parts[1] > currentParts[1]) {
      warnings.push(t('main.singerMinorVersionTooHigh', { version: singerData.formatVersion, currentVersion: SXSSINGER_CURRENT_VERSION }));
    }
  } else {
    warnings.push(t('main.singerMissingVersion'));
  }

  if (!singerData.singerName || typeof singerData.singerName !== 'string') {
    errors.push(t('main.singerMissingName'));
  } else if (singerData.singerName.trim().length === 0) {
    errors.push(t('main.singerNameEmpty'));
  }

  if (singerData.color !== undefined && singerData.color !== null) {
    if (typeof singerData.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(singerData.color)) {
      warnings.push(t('main.singerColorInvalid'));
    }
  }

  if (!singerData.wavBase64 || typeof singerData.wavBase64 !== 'string') {
    errors.push(t('main.singerMissingWav'));
  } else if (singerData.wavBase64.length === 0) {
    errors.push(t('main.singerWavEmpty'));
  }

  if (singerData.midiNotes !== undefined && singerData.midiNotes !== null) {
    if (!Array.isArray(singerData.midiNotes)) {
      warnings.push(t('main.singerMidiInvalid'));
    }
  }

  if (singerData.f0Data !== undefined && singerData.f0Data !== null) {
    if (!Array.isArray(singerData.f0Data)) {
      warnings.push(t('main.singerF0Invalid'));
    }
  }

  if (singerData.singerData !== undefined && singerData.singerData !== null) {
    if (typeof singerData.singerData !== 'object') {
      warnings.push(t('main.singerInferenceDataInvalid'));
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function applySingerDataToSinger(singer, singerData) {
  if (singerData.wavBase64) {
    try {
      singer.wavBuffer = base64ToArrayBuffer(singerData.wavBase64);
    } catch (e) {
      console.error('Failed to decode wavBase64:', e);
    }
  }
  if (singerData.midiNotes) singer.midiNotes = singerData.midiNotes;
  if (singerData.f0Data) singer.f0Data = singerData.f0Data;
  if (singerData.singerData) singer.singerData = singerData.singerData;
}

export async function loadSingerFile(singerId, buffer, filePath) {
  let singerData;
  try {
    const text = new TextDecoder().decode(buffer);
    singerData = JSON.parse(text);
  } catch (_e) {
    await showSingerValidationReport({
      valid: false,
      errors: [t('main.singerJsonParseFailed')],
      warnings: [],
    });
    return;
  }

  const validation = validateSingerData(singerData);
  // 与 loadProject 行为一致：warnings 只记录到 console（低版本歌手文件每次
  // 打开都弹完整验证报告是体验噪音），仅 errors（不可用文件）才弹窗。
  if (validation.errors.length > 0) {
    await showSingerValidationReport(validation);
    if (!validation.valid) return;
  } else if (validation.warnings.length > 0) {
    console.warn('Singer file validation warnings:', validation.warnings);
  }

  if (singerData) {
    const singer = trackManager.getSinger(singerId);
    if (singer) {
      const updates = {
        trackName: singerData.singerName || singer.trackName,
        singerName: singerData.singerName || singer.singerName,
        avatarPath: singerData.avatarBase64 || singer.avatarPath,
        color: singerData.color || singer.color,
        singerFilePath: filePath || singer.singerFilePath,
        singerFileMissing: false,
      };
      trackManager.updateSinger(singerId, updates);
      await applySingerDataToSinger(singer, singerData);
    }
    // refreshAll will be called by the caller
  }
}

export async function addSingerFromFile(buffer, filePath) {
  let singerData;
  try {
    const text = new TextDecoder().decode(buffer);
    singerData = JSON.parse(text);
  } catch (_e) {
    await showSingerValidationReport({
      valid: false,
      errors: [t('main.singerJsonParseFailed')],
      warnings: [],
    });
    return;
  }

  const validation = validateSingerData(singerData);
  // 同 loadSingerFile：warnings 走 console，仅 errors 弹窗。
  if (validation.errors.length > 0) {
    await showSingerValidationReport(validation);
    if (!validation.valid) return;
  } else if (validation.warnings.length > 0) {
    console.warn('Singer file validation warnings:', validation.warnings);
  }

  if (singerData) {
    const singer = trackManager.addSinger({
      trackName: singerData.singerName || t('common.unnamedSinger'),
      singerName: singerData.singerName || t('common.unnamedSinger'),
      avatarPath: singerData.avatarBase64 || null,
      color: singerData.color || null,
      singerFilePath: filePath || null,
      singerFileMissing: false,
    });
    await applySingerDataToSinger(singer, singerData);
    state.selectedSingerId = singer.id;
    // refreshAll will be called by the caller
  }
}

/**
 * Decode an audio file ArrayBuffer into a mono Float32Array at SAMPLE_RATE.
 * Supports wav/mp3/flac/ogg/aac/m4a via WebAudio decodeAudioData.
 * @param {ArrayBuffer} buffer - Raw audio file data
 * @returns {Promise<{audioData: Float32Array, duration: number}>}
 */
async function decodeAudioPreserveChannels(buffer) {
  const ac = new AudioContext();
  try {
    const decoded = await ac.decodeAudioData(buffer.slice(0));
    const audioChannels = new Array(decoded.numberOfChannels);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      audioChannels[ch] = new Float32Array(decoded.getChannelData(ch));
    }
    return {
      audioChannels,
      numberOfChannels: decoded.numberOfChannels,
      sampleRate: decoded.sampleRate,
      duration: decoded.duration,
    };
  } finally {
    ac.close();
  }
}

/**
 * Apply embedded accompaniment audio data to a singer.
 * @param {object} singer - Target singer object
 * @param {object} audioData - { wavBase64, audioFileName, audioDuration }
 */
async function applyAccompanimentDataToSinger(singer, audioData) {
  if (!audioData || !audioData.wavBase64) return;
  try {
    // Decode base64 WAV to Float32Array
    const wavBuffer = base64ToArrayBuffer(audioData.wavBase64);
    const decoded = await decodeAudioPreserveChannels(wavBuffer);
    singer.audioChannels = decoded.audioChannels;
    singer.analysisMono = null;
    singer.audioBuffer = decoded.audioChannels[0]; // compatibility: waveform display only
    singer.audioSampleRate = decoded.sampleRate;
    singer.audioDuration = audioData.audioDuration || decoded.duration;
  } catch (e) {
    console.error('Failed to decode embedded accompaniment audio:', e);
  }
}

/**
 * Import an audio file as an accompaniment track.
 * Shows a file dialog, decodes the audio, and creates a new accompaniment singer.
 */
export async function addAccompanimentFromFile() {
  try {
    const result = await window.electronAPI.showOpenDialog({
      title: t('main.importAccompaniment'),
      filters: [
        { name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a'] },
        { name: 'WAV Files', extensions: ['wav'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return;
    }

    const filePath = result.filePaths[0];
    const buffer = await window.electronAPI.readFileBuffer(filePath);

    let audioData;
    try {
      audioData = await decodeAudioPreserveChannels(buffer);
    } catch (decodeErr) {
      console.error('Accompaniment audio decode failed:', decodeErr);
      showAlertDialog(t('main.accompanimentDecodeFailedDetail', { detail: decodeErr.message }));
      return;
    }

    // Extract file name from path
    const fileName = filePath.split(/[\\/]/).pop() || 'accompaniment';

    const singer = trackManager.addSinger({
      type: 'accompaniment',
      trackName: fileName,
      singerName: fileName,
      audioFilePath: filePath,
      audioFileMissing: false,
      audioFileName: fileName,
      audioDuration: audioData.duration,
    numberOfChannels: audioData.numberOfChannels,
    audioSampleRate: audioData.sampleRate,
    });
    singer.audioChannels = audioData.audioChannels;
    singer.analysisMono = null;
    singer.audioBuffer = audioData.audioChannels[0];

    state.selectedSingerId = singer.id;
    // refreshAll will be called by the caller
  } catch (err) {
    console.error('Import accompaniment failed:', err);
    showAlertDialog(t('main.accompanimentImportFailedDetail', { detail: err.message }));
  }
}

/**
 * Reload accompaniment audio from a new file path (for relocating missing files).
 * @param {string} singerId - Target singer ID
 * @param {ArrayBuffer} buffer - Raw audio file data
 * @param {string} filePath - New file path
 */
export async function loadAccompanimentFile(singerId, buffer, filePath) {
  let audioData;
  try {
    audioData = await decodeAudioPreserveChannels(buffer);
  } catch (decodeErr) {
    console.error('Accompaniment audio decode failed:', decodeErr);
    showAlertDialog(t('main.accompanimentDecodeFailedDetail', { detail: decodeErr.message }));
    return;
  }

  const fileName = filePath.split(/[\\/]/).pop() || 'accompaniment';
  trackManager.updateSinger(singerId, {
    audioFilePath: filePath,
    audioFileMissing: false,
    audioFileName: fileName,
    audioDuration: audioData.duration,
    numberOfChannels: audioData.numberOfChannels,
    audioSampleRate: audioData.sampleRate,
  });
  const singer = trackManager.getSinger(singerId);
  if (singer) {
    singer.audioChannels = audioData.audioChannels;
    singer.analysisMono = null;
    singer.audioBuffer = audioData.audioChannels[0];
  }
}

export function showSingerSelectDialog(singerId) {
  // 插件建轨会在本对话框之上再叠一层"创建插件轨道"对话框（见
  // pluginTrackDialog.js）。建轨成功后内层那层会自己关掉，但外层这层没人管，
  // 于是它立刻重新露出来继续盖住整个主窗口 —— 用户看到的就是"新建轨道后
  // 提示窗不自动消失"。所以 onCreated 里要把本对话框一起收掉。
  let dialogRef = null;
  const closeSelf = () => {
    if (dialogRef) {
      dialogRef.close();
      dialogRef = null;
    }
  };

  // 插件后端分区：清单走异步 IPC，分区内部自带加载态与失败兜底，
  // 因此这里不会阻塞对话框打开。
  const pluginSection = createPluginBackendSection({
    singerId,
    onCreated: async () => {
      // 先关窗再刷新：refreshAll 是同步重绘，先关可以避免用户看到
      // "遮罩还在、列表已更新"的中间态。
      closeSelf();
      markDirty();
      // Dynamic import to avoid circular dependency with timelineRenderer
      const { refreshAll } = await import('./timelineRenderer.js');
      refreshAll();
    },
  });

  dialogRef = createDialog({
    title: t('main.selectSinger'),
    minWidth: 320,
    contentElement: pluginSection,
    buttons: [
      {
        text: t('main.openSingerCreator'),
        type: 'primary',
        onClick: () => {
          if (window.electronAPI?.openSingerCreator) {
            window.electronAPI.openSingerCreator();
          } else {
            showAlertDialog(t('main.singerCreatorNotImplemented'));
          }
        },
      },
      {
        text: t('main.openExistingSinger'),
        type: 'success',
        onClick: async () => {
          if (window.electronAPI?.showOpenDialog) {
            try {
              const result = await window.electronAPI.showOpenDialog({
                filters: [{ name: 'SXS Singer', extensions: ['sxssinger'] }],
                properties: ['openFile'],
              });
              if (!result.canceled && result.filePaths.length > 0) {
                const filePath = result.filePaths[0];
                const buffer = await window.electronAPI.readFileBuffer(filePath);
                if (singerId !== null) {
                  await loadSingerFile(singerId, buffer, filePath);
                } else {
                  await addSingerFromFile(buffer, filePath);
                }
                // Dynamic import to avoid circular dependency with timelineRenderer
                const { refreshAll } = await import('./timelineRenderer.js');
                refreshAll();
              }
            } catch (err) {
              console.error('Synthesis failed:', err);
            }
          }
        },
      },
      {
        text: t('main.editSingerFile'),
        type: 'default',
        onClick: async () => {
          closeSelf();
          if (!window.electronAPI?.openSingerEditor) {
            showAlertDialog(t('main.singerCreatorNotImplemented'));
            return;
          }
          const res = await window.electronAPI.openSingerEditor();
          if (res && res.success === false && !res.canceled) {
            showAlertDialog(t('main.singerEditorFailed', { detail: res.error || '' }));
          }
        },
      },
      {
        text: t('common.cancel'),
        type: 'default',
        onClick: () => {},
      },
    ],
    styles: {
      buttonDirection: 'column',
      buttonAlign: 'stretch',
    },
  });

  return dialogRef;
}

/**
 * 加载后校验插件后端：插件 / 轨道种类已不存在（用户把插件删了）时只打
 * `backendMissing` 标记，backend 字段本身原样保留 —— 装回插件即可恢复，
 * 绝不在用户不知情的情况下把轨道静默降级成内置后端。
 *
 * 清单拉取失败（插件宿主没起来）时不误报缺失：保留现场，等后续渲染再判定。
 */
async function validatePluginBackends() {
  const pluginTracks = trackManager.getSingers().filter(isPluginTrack);
  if (pluginTracks.length === 0) return;
  let catalog;
  try {
    catalog = await ensurePluginCatalog();
  } catch (_err) {
    return;
  }
  if (catalog && (catalog.failed || catalog.unavailable)) return;
  for (const singer of pluginTracks) {
    singer.backendMissing = !findTrackKind(singer.backend.pluginId, singer.backend.kindId);
  }
}

export async function serializeProject(embedSingerFiles = false, embedAccompanimentAudio = false) {
  const singers = await Promise.all(trackManager.getSingers().map(async (singer) => {
    const singerObj = { ...singer };
    if (singer.type === 'accompaniment') {
      // Accompaniment track: optionally embed audio as base64 WAV
      if (embedAccompanimentAudio && singer.audioBuffer) {
        let wavBase64 = null;
        try {
          const { encodeWav } = require('../audio/wavEncoder.js');
          const channels = singer.audioChannels?.length ? singer.audioChannels : [singer.audioBuffer];
          const frames = channels[0].length;
          const interleaved = new Float32Array(frames * channels.length);
          for (let i = 0; i < frames; i++) {
            for (let ch = 0; ch < channels.length; ch++) interleaved[i * channels.length + ch] = channels[ch][i] || 0;
          }
          const wavBytes = encodeWav(interleaved, singer.audioSampleRate || SAMPLE_RATE, channels.length);
          const blob = new Blob([wavBytes]);
          wavBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result;
              const base64 = result.substring(result.indexOf(',') + 1);
              resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } catch (e) {
          console.error('Failed to encode accompaniment audio:', e);
        }
        singerObj.embeddedAudioData = {
          wavBase64,
          audioFileName: singer.audioFileName || 'accompaniment.wav',
          audioDuration: singer.audioDuration || null,
        };
      } else {
        singerObj.embeddedAudioData = null;
      }
      // Clear runtime audioBuffer from serialization
      delete singerObj.audioBuffer;
      delete singerObj.audioChannels;
      delete singerObj.analysisMono;
      return singerObj;
    }
    // Singer track: existing embed logic
    if (embedSingerFiles && singer.wavBuffer) {
      let wavBase64 = null;
      try {
        const bytes = new Uint8Array(singer.wavBuffer);
        const blob = new Blob([bytes]);
        wavBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result;
            const base64 = result.substring(result.indexOf(',') + 1);
            resolve(base64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        console.error('Failed to encode wavBuffer:', e);
      }
      singerObj.embeddedSingerData = {
        formatVersion: SXSSINGER_CURRENT_VERSION,
        singerName: singer.singerName,
        color: singer.color,
        avatarBase64: singer.avatarPath || null,
        wavBase64,
        wavFileName: singer.singerName ? `${singer.singerName}.wav` : 'reference.wav',
        wavDuration: singer.wavDuration || null,
        isPreprocessed: !!(singer.midiNotes || singer.f0Data || singer.singerData),
        midiNotes: singer.midiNotes || null,
        f0Data: singer.f0Data || null,
        singerData: singer.singerData || null,
      };
    } else {
      singerObj.embeddedSingerData = null;
    }
    // 后端信息原样带上：插件轨道靠 pluginId/kindId/voiceId/params 复现，
    // 旧工程没有 backend 字段时补内置后端（{type:'sxs'}）。
    singerObj.backend = getSingerBackend(singer);
    // backendMissing 是加载期算出来的运行时标记，不落盘。
    delete singerObj.backendMissing;
    // Clear runtime audioBuffer from serialization
    delete singerObj.audioBuffer;
      delete singerObj.audioChannels;
      delete singerObj.analysisMono;
    return singerObj;
  }));

  // 嵌入模式包含大段 base64（无换行的长字符串），缩进只会白白增大体积、
  // 拖慢 stringify，此时改为紧凑输出；普通工程保留 2 空格缩进便于 diff/手查。
  const hasEmbeddedPayload = embedSingerFiles || embedAccompanimentAudio;
  return JSON.stringify({
    version: PROJECT_FORMAT_VERSION,
    // minReader：低于此版本读写会丢字段（auto 层于 1.2.0 引入）。
    // features：能力清单，旧版读到未知项应提示而不是静默忽略。
    minReader: PROJECT_MIN_READER,
    features: PROJECT_FEATURES,
    project: {
      bpm: state.project.bpm,
      timeSignature: state.project.timeSignature,
    },
    singers,
    fragments: trackManager.getFragments(),
  }, null, hasEmbeddedPayload ? undefined : 2);
}

/**
 * 把 state.project 的 BPM / 拍号写回工具栏控件。
 *
 * 只改 state 不改 DOM，界面会显示旧值（实际 96、显示 120）；更麻烦的是用户随后
 * 任何触发 updateProjectSettings() 的操作都会读 DOM，把 state 里的正确值覆盖回去。
 * 载入工程、MCP 脚本改工程、导入 MIDI 同步工程信息都要走这里。
 */
export function syncProjectControls() {
  if (!dom.bpmInput) return;
  dom.bpmInput.value = state.project.bpm;
  if (dom.timeSigNum) dom.timeSigNum.value = state.project.timeSignature[0];
  if (dom.timeSigDen) dom.timeSigDen.value = state.project.timeSignature[1];
  if (dom.bpmDisplayBadge) {
    const bpmText = dom.bpmDisplayBadge.querySelector('#bpm-display-text')
      || document.getElementById('bpm-display-text');
    if (bpmText) bpmText.textContent = `${state.project.bpm} BPM`;
  }
}

export function updateProjectSettings(options = {}) {
  const markProjectDirty = options.markDirty !== false;
  const bpm = parseInt(dom.bpmInput.value, 10) || 120;
  const num = parseInt(dom.timeSigNum.value, 10) || 4;
  const den = parseInt(dom.timeSigDen.value, 10) || 4;
  const oldBpm = state.project.bpm;
  state.project.bpm = Math.max(1, Math.min(999, bpm));
  state.project.timeSignature = [num, den];
  dom.bpmInput.value = state.project.bpm;
  if (dom.bpmDisplayBadge) {
    const bpmText = dom.bpmDisplayBadge.querySelector('#bpm-display-text') ||
      document.getElementById('bpm-display-text');
    if (bpmText) bpmText.textContent = `${state.project.bpm} BPM`;
    if (oldBpm !== state.project.bpm) {
      dom.bpmDisplayBadge.classList.remove('bpm-flash');
      void dom.bpmDisplayBadge.offsetWidth;
      dom.bpmDisplayBadge.classList.add('bpm-flash');
    }
  }
  if (markProjectDirty) markDirty();
  // refreshAll will be called by the caller
  if (window.electronAPI?.updateProjectSettings) {
    window.electronAPI.updateProjectSettings({ bpm: state.project.bpm, timeSignature: state.project.timeSignature });
  }
}

let _lastAutoSaveAlertAt = 0;
// 自动保存采用 trailing 防抖：分片编辑器连续编辑时避免每个事件都全量
// JSON.stringify + 写盘（工程大时 stringify 是明显的主线程卡顿源）。
const AUTOSAVE_DEBOUNCE_MS = 400;
let _autoSaveTimer = null;

/**
 * 请求一次自动保存（防抖）。真正写盘由 _commitAutoSave 完成。
 * 关闭窗口前需要立即落盘时调用 flushAutoSave()。
 */
export function autoSaveProject() {
  if (!state.currentProjectFilePath) return;
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    _autoSaveTimer = null;
    _commitAutoSave().catch(() => {});
  }, AUTOSAVE_DEBOUNCE_MS);
}

/**
 * 立即执行一次自动保存（取消 pending 防抖），供关闭前调用。
 */
export async function flushAutoSave() {
  if (_autoSaveTimer) {
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = null;
  }
  await _commitAutoSave();
}

/**
 * 取消尚未触发的自动保存。用于两类场景：
 *  - 手动保存成功后，避免 400ms 后再做一次全量序列化 + 写盘；
 *  - 关闭确认对话框弹出时，避免用户在“是否保存”对话框停留期间，
 *    后台定时器把用户稍后可能选择“不保存”的改动写入磁盘。
 */
export function cancelPendingAutoSave() {
  if (_autoSaveTimer) {
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = null;
  }
}

async function _commitAutoSave() {
  if (!state.currentProjectFilePath) return;
  // 捕获写入开始时的纪元：写盘（尤其大工程）期间可能又有新编辑。
  const epoch = _saveEpoch;
  const path = state.currentProjectFilePath;
  try {
    const data = await serializeProject(false);
    await _enqueueProjectWrite(async () => {
      const res = await window.electronAPI.saveFile(path, data);
      _checkSaveResult(res);
    });
    // 仅在写盘期间没有新编辑时清除脏标记。
    if (epoch === _saveEpoch) markClean();
    console.log('Project auto-saved to', path);
  } catch (err) {
    console.warn('Project auto-save failed:', err);
    // 自动保存失败必须让用户感知，否则"已保存"的假象会在关闭时丢数据。
    // 用节流弹窗提示（60s 内不重复轰炸），并保留 console 记录。
    const now = Date.now();
    if (now - _lastAutoSaveAlertAt > 60000) {
      _lastAutoSaveAlertAt = now;
      try {
        showAlertDialog(t('main.autoSaveFailed', { error: err.message }));
      } catch (_) {}
    }
  }
}

export function showSaveProjectOptionsDialog() {
  return new Promise((resolve) => {
    const optionsContainer = document.createElement('div');
    optionsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';

    const embedOption = document.createElement('label');
    embedOption.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-size: 13px;
      color: var(--fg-secondary);
    `;
    const embedCheckbox = document.createElement('input');
    embedCheckbox.type = 'checkbox';
    embedCheckbox.checked = false;
    const embedLabel = document.createElement('span');
    embedLabel.textContent = t('main.embedSingerFiles');
    embedOption.appendChild(embedCheckbox);
    embedOption.appendChild(embedLabel);
    optionsContainer.appendChild(embedOption);

    const embedDesc = document.createElement('div');
    embedDesc.style.cssText = 'font-size: 11px; color: var(--fg-muted); margin-top: -8px; padding-left: 24px;';
    embedDesc.textContent = t('main.embedSingerFilesDesc');
    optionsContainer.appendChild(embedDesc);

    // Accompaniment embed option
    const hasAccompaniment = trackManager.getSingers().some(s => s.type === 'accompaniment');
    if (hasAccompaniment) {
      const accSeparator = document.createElement('div');
      accSeparator.style.cssText = 'height: 1px; background: var(--border-subtle); margin: 4px 0;';
      optionsContainer.appendChild(accSeparator);

      const accEmbedOption = document.createElement('label');
      accEmbedOption.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        font-size: 13px;
        color: var(--fg-secondary);
      `;
      const accEmbedCheckbox = document.createElement('input');
      accEmbedCheckbox.type = 'checkbox';
      accEmbedCheckbox.checked = false;
      const accEmbedLabel = document.createElement('span');
      accEmbedLabel.textContent = t('main.embedAccompanimentAudio');
      accEmbedOption.appendChild(accEmbedCheckbox);
      accEmbedOption.appendChild(accEmbedLabel);
      optionsContainer.appendChild(accEmbedOption);

      const accEmbedDesc = document.createElement('div');
      accEmbedDesc.style.cssText = 'font-size: 11px; color: var(--fg-muted); margin-top: -8px; padding-left: 24px;';
      accEmbedDesc.textContent = t('main.embedAccompanimentAudioDesc');
      optionsContainer.appendChild(accEmbedDesc);

      createDialog({
        title: t('main.saveProjectOptions'),
        contentElement: optionsContainer,
        buttons: [
          {
            text: t('common.cancel'),
            type: 'default',
            onClick: () => resolve(null),
          },
          {
            text: t('common.save'),
            type: 'primary',
            onClick: () =>
              resolve({
                embedSingerFiles: embedCheckbox.checked,
                embedAccompanimentAudio: accEmbedCheckbox.checked,
              }),
          },
        ],
        styles: {
          buttonMarginTop: '0',
        },
      });
    } else {
      createDialog({
        title: t('main.saveProjectOptions'),
        contentElement: optionsContainer,
        buttons: [
          {
            text: t('common.cancel'),
            type: 'default',
            onClick: () => resolve(null),
          },
          {
            text: t('common.save'),
            type: 'primary',
            onClick: () =>
              resolve({
                embedSingerFiles: embedCheckbox.checked,
                embedAccompanimentAudio: false,
              }),
          },
        ],
        styles: {
          buttonMarginTop: '0',
        },
      });
    }
  });
}

export function showSaveBeforeCloseDialog() {
  return new Promise((resolve) => {
    createDialog({
      title: t('main.unsavedChanges'),
      content: t('main.unsavedChangesDesc'),
      buttons: [
        {
          text: t('main.discardCancel'),
          type: 'default',
          onClick: () => resolve('cancel'),
        },
        {
          text: t('main.discardChanges'),
          type: 'default',
          onClick: () => resolve('discard'),
        },
        {
          text: t('main.saveAndExit'),
          type: 'primary',
          onClick: () => resolve('save'),
        },
      ],
      styles: {
        titleFontSize: '16px',
        contentFontSize: '14px',
        contentColor: '#aaa',
      },
    });
  });
}

// 写盘互斥：自动保存（400ms trailing 防抖，见 AUTOSAVE_DEBOUNCE_MS）与手动保存
// 可能几乎同时触发，并发写同一文件有交错/竞争风险。所有真实写盘都串行排队。
let _projectWriteChain = Promise.resolve();
function _enqueueProjectWrite(writeFn) {
  const run = _projectWriteChain.then(writeFn, writeFn);
  // 队列本身永不 reject，失败由 writeFn 内部处理/返回
  _projectWriteChain = run.catch(() => {});
  return run;
}

function _checkSaveResult(res) {
  // file:saveFile 以 { success: false, error } 返回失败而非抛错，
  // 这里统一转换为异常，避免保存失败仍 markClean。
  if (res && res.success === false) {
    throw new Error(res.error || 'Save failed');
  }
}

export async function saveProject() {
  // 手动保存优先：取消尚未触发的自动保存，避免保存完成后再全量写一次。
  cancelPendingAutoSave();
  // Save in-place: if we already have a file path, write to it silently
  // without showing a dialog or the save-options popup.
  if (state.currentProjectFilePath) {
    try {
      const epoch = _saveEpoch;
      const data = await serializeProject(false);
      await _enqueueProjectWrite(async () => {
        const res = await window.electronAPI.saveFile(state.currentProjectFilePath, data);
        _checkSaveResult(res);
      });
      // 写盘期间若有新编辑，不能清掉 dirty。
      if (epoch === _saveEpoch) markClean();
      console.log('Project saved to', state.currentProjectFilePath);
      return { saved: true, canceled: false };
    } catch (err) {
      console.error('Save failed', err);
      return { saved: false, canceled: false, error: err.message };
    }
  }
  // No file path yet — fall back to Save As (prompts for location & options).
  return saveProjectAs();
}

export async function saveProjectAs() {
  // 同 saveProject：另存为也会提交全部状态，无需再触发一次自动保存。
  cancelPendingAutoSave();
  if (window.electronAPI?.showSaveDialog) {
    try {
      const saveOptions = await showSaveProjectOptionsDialog();
      if (!saveOptions) return { saved: false, canceled: true };

      const result = await window.electronAPI.showSaveDialog({
        filters: [{ name: 'SXSEditor Project', extensions: ['sxsproj'] }],
        defaultPath: state.currentProjectFilePath || undefined,
      });
      if (!result.canceled && result.filePath) {
        const epoch = _saveEpoch;
        const data = await serializeProject(saveOptions.embedSingerFiles, saveOptions.embedAccompanimentAudio);
        await _enqueueProjectWrite(async () => {
          const res = await window.electronAPI.saveFile(result.filePath, data);
          _checkSaveResult(res);
        });
        state.currentProjectFilePath = result.filePath;
        // 写盘期间若有新编辑，不能清掉 dirty。
        if (epoch === _saveEpoch) markClean();
        console.log('Project saved to', result.filePath);
        return { saved: true, canceled: false };
      }
      return { saved: false, canceled: true };
    } catch (err) {
      console.error('Save failed', err);
      return { saved: false, canceled: false, error: err.message };
    }
  }
  return { saved: false, canceled: true };
}

export async function loadProject() {
  // 立刻取消在途的自动保存。否则：
  //   · 用户确认"丢弃未保存改动"的对话框停留期间，400ms 定时器会把即将被丢弃的
  //     改动写回旧工程文件；
  //   · 加载过程中 state.currentProjectFilePath 仍是旧路径，而内存里已经是
  //     半加载的新工程，定时器触发就会把半加载状态写进旧工程。
  cancelPendingAutoSave();
  if (state.isDirty) {
    const discard = await showConfirmDialog(t('main.unsavedChangesConfirm') || 'Unsaved changes will be lost. Continue?');
    if (!discard) return { loaded: false, canceled: true };
  }
  if (window.electronAPI?.showOpenDialog) {
    try {
      const result = await window.electronAPI.showOpenDialog({
        filters: [{ name: 'SXSEditor Project', extensions: ['sxsproj', 'sxs'] }],
        properties: ['openFile'],
      });
      if (!result.canceled && result.filePaths.length > 0) {
        // 加载新工程前关闭所有分片编辑器窗口，避免旧窗口持有已失效的 fragment id
        // 导致 onFragmentSaved 的 find(f => f.id === fragmentId) 失败、编辑静默丢失
        if (window.electronAPI?.closeAllFragmentEditors) {
          await window.electronAPI.closeAllFragmentEditors();
        }
        const data = await window.electronAPI.readFile(result.filePaths[0]);
        const obj = JSON.parse(data);
        if (!obj || typeof obj !== 'object') throw new Error('Invalid project file');
        // 版本判定收敛到 shared/projectFormat.checkProjectHeader（可单测）：
        //   reject  —— major 更高，或 minReader 高于当前版本（会算错/丢数据）
        //   confirm —— major 相同、minor 更高（新字段会被忽略，重存即丢）
        //   ok      —— 正常/降级加载
        const compat = checkProjectHeader(obj);
        if (compat.action === 'reject') {
          showAlertDialog(t(
            compat.reason === 'min-reader' ? 'main.projectMinReaderTooHigh' : 'main.projectVersionTooHigh',
            { version: obj.version, minReader: obj.minReader, currentVersion: PROJECT_FORMAT_VERSION },
          ));
          return;
        }
        if (compat.action === 'confirm') {
          const proceed = await showConfirmDialog(
            t('main.projectMinorVersionTooHigh', { version: obj.version })
          );
          if (!proceed) return { loaded: false, canceled: true };
        }
        if (compat.reason === 'lower') {
          console.warn(`Project file version(${obj.version}) is low, will try downgrade load`);
        }
        if (compat.unknownFeatures.length > 0) {
          // 前向兼容：未知特性不阻断，只记录（将来可在 UI 上提示）
          console.warn('[project] 未知特性（可能来自更新版本）:', compat.unknownFeatures.join(', '));
        }
        if (obj.project) {
          state.project.bpm = obj.project.bpm ?? 120;
          state.project.timeSignature = obj.project.timeSignature ?? [4, 4];
          syncProjectControls();
        }
        if (obj.singers) {
          trackManager.singers.length = 0;
          // 先清后端缺失标记：下面的校验会按当前插件清单重新判定
          for (const s of obj.singers) {
            if (s && typeof s === 'object') delete s.backendMissing;
          }
          for (const s of obj.singers) {
            const singer = trackManager.addSinger(s);
            // Accompaniment track: load from embedded data or file path
            if (singer.type === 'accompaniment') {
              if (s.embeddedAudioData) {
                await applyAccompanimentDataToSinger(singer, s.embeddedAudioData);
              } else if (s.audioFilePath) {
                await window.electronAPI.authorizePath(s.audioFilePath);
                const exists = await window.electronAPI.fileExists(s.audioFilePath);
                if (!exists) {
                  singer.audioFileMissing = true;
                } else {
                  try {
                    const buffer = await window.electronAPI.readFileBuffer(s.audioFilePath);
                    const decoded = await decodeAudioPreserveChannels(buffer);
                    singer.audioChannels = decoded.audioChannels;
                    singer.analysisMono = null;
                    singer.audioBuffer = decoded.audioChannels[0];
                    singer.audioSampleRate = decoded.sampleRate;
                    singer.audioDuration = decoded.duration;
                    singer.audioFileMissing = false;
                  } catch (_err) {
                    singer.audioFileMissing = true;
                  }
                }
              }
              continue;
            }
            // Singer track: existing load logic
            if (s.embeddedSingerData) {
              await applySingerDataToSinger(singer, s.embeddedSingerData);
              if (s.embeddedSingerData.wavDuration) {
                singer.wavDuration = s.embeddedSingerData.wavDuration;
              }
            }
            if (s.singerFilePath && !s.embeddedSingerData) {
              await window.electronAPI.authorizePath(s.singerFilePath);
              const exists = await window.electronAPI.fileExists(s.singerFilePath);
              if (!exists) {
                singer.singerFileMissing = true;
              } else {
                try {
                  const buffer = await window.electronAPI.readFileBuffer(s.singerFilePath);
                  const text = new TextDecoder().decode(buffer);
                  const singerData = JSON.parse(text);
                  const validation = validateSingerData(singerData);
                  if (validation.warnings.length > 0) {
                     console.warn('File load validation warnings:', validation.warnings);
                  }
                  if (validation.valid) {
                    await applySingerDataToSinger(singer, singerData);
                    if (singerData.wavDuration) {
                      singer.wavDuration = singerData.wavDuration;
                    }
                    singer.singerFileMissing = false;
                  }
                } catch (err) {
                  console.warn('Unable to restore singer file:', err);
                  singer.singerFileMissing = true;
                }
              }
            }
          }
        }
        // 插件后端存在性校验：插件被删掉时只标记，不阻断工程加载
        await validatePluginBackends();
        if (obj.fragments) {
          trackManager.fragments.length = 0;
          // 使用 addFragment 规范化每个分片（补齐 envelopes/pitchCurve 等字段），
          // 避免 raw JSON push 导致后续访问 fragment.envelopes 等字段时为 undefined
          for (const f of obj.fragments) trackManager.addFragment(f);
        }
        state.currentProjectFilePath = result.filePaths[0];
        history.clear();
        state.selectedFragmentId = null;
        markClean();
        // refreshAll will be called by the caller
        console.log('Project loaded', result.filePaths[0]);
      }
    } catch (err) {
      console.error('Load failed', err);
      showAlertDialog(t('main.projectLoadFailed') + ': ' + (err.message || ''));
    }
  }
}

/**
 * 生成「旧版兼容工程」（1.1.0）。
 *
 * 跨版本协作的现实问题：1.2.0 工程里的自动音高曲线是**参数化派生**的，
 * 旧版（1.1.0）不认识 auto 字段 —— 打开后曲线变成平线，且一旦打开分片编辑器
 * 就会被三字段白名单抹掉，重存即永久丢失。
 *
 * 这里把自动层**烘焙成普通锚点**（0.08 拍采样，与旧版默认密度一致），
 * 并把版本号写回 1.1.0：旧版打开就是一条普通手绘曲线，听感基本一致。
 *
 * 只烘焙"完全没有手动内容"的分片；已有锚点/笔刷/派生段的分片保持原样
 * （那本来就是旧版能读的东西）。
 *
 * @returns {string} 可直接写盘的 JSON 字符串
 */
export function buildLegacyProjectJson() {
  const bpm = state.project.bpm;
  const fragments = trackManager.getFragments().map((f) => {
    const pc = f.pitchCurve || {};
    const legacyCurve = {
      enabled: pc.enabled !== false,
      anchorPoints: Array.isArray(pc.anchorPoints) ? pc.anchorPoints.map((a) => ({ ...a })) : [],
      brushSegments: Array.isArray(pc.brushSegments) ? pc.brushSegments.map((s) => ({ ...s })) : [],
    };
    const hasManual = legacyCurve.anchorPoints.length > 0
      || legacyCurve.brushSegments.length > 0
      || (Array.isArray(pc.bakedSegments) && pc.bakedSegments.length > 0);
    const autoOn = pc.auto && pc.auto.enabled;
    if (autoOn && !hasManual) {
      // 全自动分片 → 采样成锚点，旧版即可原样播放
      const notes = computeActiveClippedNotes(f, f.notes);
      if (notes.length > 0) {
        const pts = buildAutoCurve(
          { sortedNotes: notes, auto: pc.auto, bpm, ranges: resolvePitchRanges(notes) },
          0, lastNoteEnd(notes), 0.08,
        );
        legacyCurve.anchorPoints = pts.map((p) => ({
          time: Math.max(0, p.time),
          pitch: p.pitch,
          strength: 100,
          smoothness: 30,
        }));
      }
    }
    return { ...f, pitchCurve: legacyCurve };
  });

  return JSON.stringify({
    version: '1.1.0',
    project: { bpm: state.project.bpm, timeSignature: state.project.timeSignature },
    singers: trackManager.getSingers(),
    fragments,
  }, null, 2);
}

/**
 * 导出旧版兼容工程（弹保存对话框）。
 * @returns {Promise<{saved:boolean, filePath?:string}>}
 */
export async function exportLegacyProject() {
  if (!window.electronAPI?.showSaveDialog) return { saved: false };
  const result = await window.electronAPI.showSaveDialog({
    filters: [{ name: 'SXSEditor Project (compat)', extensions: ['sxsproj'] }],
    defaultPath: (state.currentProjectFilePath || 'project.sxsproj').replace(/\.sxsproj$/i, '') + '-compat.sxsproj',
  });
  if (result.canceled || !result.filePath) return { saved: false };
  const json = buildLegacyProjectJson();
  try {
    await window.electronAPI.writeFile(result.filePath, json);
    return { saved: true, filePath: result.filePath };
  } catch (err) {
    console.error('[project] 导出旧版兼容工程失败:', err);
    showAlertDialog(t('main.projectSaveFailed') + ': ' + (err.message || ''));
    return { saved: false };
  }
}
