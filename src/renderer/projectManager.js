import { state, dom, trackManager, history } from './state.js';
import { SXSSINGER_CURRENT_VERSION, SAMPLE_RATE } from './constants.js';
// 工程格式版本收敛到单一常量（原来 '1.1.0' 与 [1,1,0] 两处硬编码，改一处会判错）
import { PROJECT_FORMAT_VERSION, PROJECT_MIN_READER, PROJECT_FEATURES, checkProjectHeader } from '../shared/projectFormat.js';
import { buildAutoCurve, resolvePitchRanges } from '../shared/autoPitchCurve.js';
import { computeActiveClippedNotes, lastNoteEnd } from '../shared/activeNotes.js';
import { buildRenderIntent } from '../shared/pluginRenderIntent.js';
import { t } from '../i18n/index.js';
import { showAlertDialog, showConfirmDialog } from '../alertDialog.js';
import { createDialog, showSingerValidationReport } from './uiControls.js';
import { createPluginBackendSection } from './pluginTrackDialog.js';
import { ensurePluginCatalog, findTrackKind, describeTrackBackend } from './pluginBackend.js';
import { isPluginTrack, getSingerBackend } from '../editor/trackManager.js';
import { shouldNotifyAutoSaveFailure, resetAutoSaveNotification } from './autoSaveNotification.js';
import {
  extensionOf, normalizeSavePath,
  formatDropsAccompaniment, requiresAccompanimentAudio,
} from './saveAsPath.js';

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

/**
 * 把一份 .sxssinger 载入到已有轨道（换音色）。
 *
 * @param {string} singerId
 * @param {ArrayBuffer} buffer
 * @param {string} filePath
 * @param {{keepTrackName?: boolean}} [options] keepTrackName：只换音色，不动轨道名。
 *        「替换歌手」走这条 —— 轨道名是用户的标签（他可能改成了"主唱"），
 *        换一个歌手的音色不该顺带把它改掉。
 */
export async function loadSingerFile(singerId, buffer, filePath, options = {}) {
  const keepTrackName = options.keepTrackName === true;
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
        ...(keepTrackName ? {} : { trackName: singerData.singerName || singer.trackName }),
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
    // 声道数随解码结果走：工程里存的值可能来自另一台机器/另一份文件，混音时
    // 以实际声道为准，否则立体声伴奏会被当成单声道处理。
    singer.numberOfChannels = decoded.numberOfChannels;
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
    // 换了音频源：之前那份内嵌 base64 已经与 audioChannels 不同源，必须作废，
    // 否则下次保存（复用已有 base64 的那条快路径）会把旧音频写回工程。
    embeddedAudioData: null,
  });
  const singer = trackManager.getSinger(singerId);
  if (singer) {
    singer.audioChannels = audioData.audioChannels;
    singer.analysisMono = null;
    singer.audioBuffer = audioData.audioChannels[0];
  }
}

/**
 * "当前音色"一行：歌手名字 + 后端标签。
 *
 * 标签复用 describeTrackBackend()，与轨道行上显示的是同一个字符串
 * （内置后端就是 'SXS INFERENCE'，插件后端是插件声明的 kind 名）。
 *
 * @param {object} singer
 * @returns {HTMLElement}
 */
function _buildCurrentVoiceRow(singer) {
  const desc = describeTrackBackend(singer);
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    background: var(--surface-2, var(--bg-button));
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  `;
  const title = document.createElement('div');
  title.style.cssText = 'font-size: 11px; color: var(--fg-muted);';
  title.textContent = t('main.currentVoice');
  const name = document.createElement('div');
  name.style.cssText = 'font-size: 12px; font-weight: 600;';
  name.textContent = singer.singerName || singer.trackName || '';
  const backend = document.createElement('div');
  backend.style.cssText = 'font-size: 11px; color: var(--fg-muted);';
  backend.textContent = desc.detail ? `${desc.label} · ${desc.detail}` : desc.label;
  wrap.append(title, name, backend);
  return wrap;
}

/**
 * 「选择 / 替换歌手」对话框。
 *
 * 两种模式共用一套内容：
 *   · 新建（singerId === null）：给空轨道挑音色，或从文件/插件新建轨道；
 *   · 替换（mode === 'replace'）：双击歌手名进入，只改这条轨道现有的音色 ——
 *     换一个歌手文件（按文件里的**歌手名字**显示），或换回内置后端
 *     （列表顶部的 SXS INFERENCE 那一行）。
 *
 * 替换模式不再提供"新建歌手"入口：用户是在改这一条轨道，不是要再造一条。
 *
 * @param {string|null} singerId
 * @param {{mode?: 'create'|'replace'}} [options]
 */
export function showSingerSelectDialog(singerId, options = {}) {
  const replaceMode = options.mode === 'replace' && !!singerId;
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
    // 替换模式要把"内置后端"这一行列进去，否则换了插件后端就回不去了
    includeBuiltin: replaceMode,
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

  // 替换模式在分区上方补一行"当前音色"：用户点进来第一件事是确认现在用的是什么。
  const content = document.createElement('div');
  content.style.cssText = 'display: flex; flex-direction: column; gap: 10px;';
  if (replaceMode) {
    const singer = trackManager.getSinger(singerId);
    if (singer) {
      content.appendChild(_buildCurrentVoiceRow(singer));
    }
  }
  content.appendChild(pluginSection);

  dialogRef = createDialog({
    title: replaceMode ? t('main.replaceSinger') : t('main.selectSinger'),
    minWidth: 320,
    contentElement: content,
    buttons: [
      ...(replaceMode ? [] : [{
        text: t('main.openSingerCreator'),
        type: 'primary',
        onClick: () => {
          if (window.electronAPI?.openSingerCreator) {
            window.electronAPI.openSingerCreator();
          } else {
            showAlertDialog(t('main.singerCreatorNotImplemented'));
          }
        },
      }]),
      {
        text: replaceMode ? t('main.chooseSingerFile') : t('main.openExistingSinger'),
        type: replaceMode ? 'default' : 'success',
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
                  // 替换歌手：只换音色，保留用户给轨道起的名字
                  await loadSingerFile(singerId, buffer, filePath, { keepTrackName: replaceMode });
                } else {
                  await addSingerFromFile(buffer, filePath);
                }
                // 替换模式换完就收窗：用户点的是"换这条路轨的音色"，不是"开个面板继续看"
                if (replaceMode) {
                  closeSelf();
                  markDirty();
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

/**
 * 组装「当前工程」的可序列化对象。
 *
 * 从 serializeProject 拆出来是为了给插件保存用：`.sxsproj` 要的是 JSON 字符串，
 * 而 codec.write 要的是**对象**（它自己决定编码成文本还是二进制）。两者必须
 * 出自同一份组装逻辑，否则"存 sxsproj"与"导出 demo"会带上不同的字段集 ——
 * 那种差异极难发现，直到某天用户发现导出后少了东西。
 *
 * @returns {Promise<{out: object, hasEmbeddedPayload: boolean}>}
 */
export async function buildProjectObject(embedSingerFiles = false, embedAccompanimentAudio = false) {
  const singers = await Promise.all(trackManager.getSingers().map(async (singer) => {
    const singerObj = { ...singer };
    if (singer.type === 'accompaniment') {
      // Accompaniment track: optionally embed audio as base64 WAV
      if (embedAccompanimentAudio && singer.audioBuffer) {
        // 优先复用工程里已有的 base64。
        //
        // 伴奏没有"编辑"路径 —— 只有"换一个音频文件"，而那条路径
        // （loadAccompanimentFile）会把 embeddedAudioData 置空。所以一份存在的
        // base64 必然与 audioChannels 同源，可以直接搬过去。这不是小优化：
        // 一首歌的伴奏是几十 MB，每次自动保存都重编码一次 WAV 再 base64
        // （几百毫秒 + 一份同等大小的临时字符串）会让编辑明显发涩。
        let wavBase64 = singer.embeddedAudioData && typeof singer.embeddedAudioData.wavBase64 === 'string'
          ? singer.embeddedAudioData.wavBase64
          : null;
        if (!wavBase64) {
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
  const out = {
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
  };
  // 插件扩展域的声明与文档级数据必须一起存回，否则"导入 → 编辑 → 存成 .sxsproj
  // → 再导出回原格式"这一趟会丢数据，而这一趟正是 ext 唯一的存在理由。
  const ext = state.projectExt || {};
  if (ext.schema && Object.keys(ext.schema).length) {
    out.extSchema = ext.schema;
  }
  if (ext.root && Object.keys(ext.root).length) {
    out.ext = ext.root;
  }
  return { out, hasEmbeddedPayload };
}

/** 内置格式的落盘形态：JSON 字符串（缩进规则见 buildProjectObject 的说明）。 */
export async function serializeProject(embedSingerFiles = false, embedAccompanimentAudio = false) {
  const { out, hasEmbeddedPayload } = await buildProjectObject(embedSingerFiles, embedAccompanimentAudio);
  return JSON.stringify(out, null, hasEmbeddedPayload ? undefined : 2);
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
  // 拍号徽标只在用户 input 时由 toolbarPopovers.js 同步；载入工程 / MCP 改工程
  // 是直接赋 value，不会触发 input，这里补一次。
  const timesigDisplay = document.getElementById('timesig-display');
  if (timesigDisplay) {
    timesigDisplay.textContent = `${state.project.timeSignature[0]}/${state.project.timeSignature[1]}`;
  }
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

// 自动保存采用 trailing 防抖：分片编辑器连续编辑时避免每个事件都全量
// JSON.stringify + 写盘（工程大时 stringify 是明显的主线程卡顿源）。
// 失败通知的「同一原因只弹一次」判定收敛在 autoSaveNotification.js（纯逻辑，
// 可单测），这里只负责把 path + code 组成 key 传进去。
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
    // 必须走与 Ctrl+S 同一条路径：按目标扩展名分派。
    // 这里原先直接 `serializeProject` + `saveFile` —— 对 .sxsproj 没问题，
    // 但插件格式（.demo）的工程一编辑就被写成一坨 JSON，下次插件再读它会
    // 直接报"不是 Demo 工程"。走查里就是这么把 /tmp/*.demo 写坏的。
    //
    // `silentWarnings`：自动保存是每 400ms 的冷路径，插件的"没写进去的东西"
    // 提示不能在这里弹 —— 拖一个音符就弹一次没人受得了。警告仍然记在
    // `state.projectSaveWarnings` 里，手动保存时照常弹。
    await _writeProjectTo(path, { silentWarnings: true });
    // 仅在写盘期间没有新编辑时清除脏标记。
    if (epoch === _saveEpoch) markClean();
    // 成功一次就复位：之后若因别的原因再次失败，用户仍应看到新的提示。
    resetAutoSaveNotification();
    console.log('Project auto-saved to', path);
  } catch (err) {
    console.warn('Project auto-save failed:', err);
    // 自动保存失败必须让用户感知，否则"已保存"的假象会在关闭时丢数据。
    // 但同一个"路径 + 错误码"只通知一次：能力边界类错误（没有插件能保存、
    // 权限不足）不会因用户继续编辑而改变，重复弹窗只会逼用户关掉应用。
    // console.warn 每次都留，便于排查；手动 Ctrl+S 的错误不走这里，照常提示。
    const key = `${path}|${err.code || err.message || 'unknown'}`;
    if (shouldNotifyAutoSaveFailure(key)) {
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
      // 默认值与就地保存的规则一致：没有源文件的伴奏不嵌入就会丢，默认勾上。
      accEmbedCheckbox.checked = needsAccompanimentEmbed();
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

/**
 * 「另存为 .svp」时的版本行为询问。
 *
 * 用户明确要求：SV1 与 SV2 都是 .svp 但 schema 互不兼容，**只有另存为 .svp
 * 时才询问**按哪个版本行为写；就地保存（Ctrl+S / 自动保存 / MCP 导出）一律沿用
 * 源工程的世代与 version 原值，绝不弹窗。三选一对齐 Dreamtonics 官方手册的
 * 「另存为（与 1.10.0 兼容）」：沿用源版本 / SV2 / SV1 兼容。
 *
 * 为什么独立成一个对话框而不是塞进 showSaveProjectOptionsDialog：那个对话框
 * 的顺序与返回值已经被现有流程与测试锁定，版本询问是另一类「写盘前条件询问」
 * （与「伴奏将丢失」确认同层），混进去会连带改动非 .svp 的保存顺序。
 *
 * @returns {Promise<'keep'|'sv2'|'sv1'|null>} null 表示取消
 */
export function showSvpVersionDialog() {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    container.style.cssText = 'display: flex; flex-direction: column; gap: 10px;';

    const intro = document.createElement('div');
    intro.style.cssText = 'font-size: 12px; color: var(--fg-secondary); line-height: 1.6;';
    intro.textContent = t('main.svpVersionDesc');
    container.appendChild(intro);

    const radios = [];
    for (const [value, label] of [
      ['keep', t('main.svpVersionKeep')],
      ['sv2', t('main.svpVersion2')],
      ['sv1', t('main.svpVersion1Compat')],
    ]) {
      const option = document.createElement('label');
      option.style.cssText = 'display: flex; align-items: flex-start; gap: 8px; cursor: pointer; font-size: 13px; color: var(--fg-secondary); line-height: 1.5;';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'svp-version';
      input.value = value;
      input.checked = value === 'keep'; // 默认沿用源版本，与就地保存一致
      input.style.cssText = 'margin-top: 3px; flex: none;';
      const text = document.createElement('span');
      text.textContent = label;
      option.appendChild(input);
      option.appendChild(text);
      container.appendChild(option);
      radios.push(input);
    }

    const warn = document.createElement('div');
    warn.style.cssText = 'font-size: 11px; color: var(--fg-muted); line-height: 1.6;';
    warn.textContent = t('main.svpVersionDowngradeWarn');
    container.appendChild(warn);

    createDialog({
      title: t('main.svpVersionTitle'),
      contentElement: container,
      buttons: [
        { text: t('common.cancel'), type: 'default', onClick: () => resolve(null) },
        {
          text: t('common.save'),
          type: 'primary',
          onClick: () => {
            const picked = radios.find((r) => r.checked);
            resolve(picked ? picked.value : 'keep');
          },
        },
      ],
      styles: { buttonMarginTop: '0' },
    });
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

/**
 * 就地保存时必须嵌入伴奏音频吗？
 *
 * 伴奏音频只有两种存在方式：源文件路径（下次打开能重新解码）或工程内嵌 base64。
 * 从外部工程导入的伴奏（如 .vpr 里的 `Project/Audio/*.wav`）、以及上次以嵌入
 * 方式保存的伴奏，都没有源路径 —— 这种情况下不嵌入就是**静默丢音频**：用户按
 * 一次 Ctrl+S，重开工程伴奏就空了。所以默认值由"有没有可重新加载的源文件"决定，
 * 而不是照抄上一次的勾选。
 */
function needsAccompanimentEmbed() {
  return trackManager.getSingers().some((singer) => singer
    && singer.type === 'accompaniment'
    && !singer.audioFilePath
    && (singer.audioBuffer || (Array.isArray(singer.audioChannels) && singer.audioChannels.length)));
}

/**
 * 保存/导出后，把插件报的"没写进去的东西"显示出来。 */
function _notifySaveWarnings(warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return;
  const head = t('main.projectSaveWarnings', { count: warnings.length });
  showAlertDialog(`${head}\n\n${warnings.slice(0, 8).join('\n')}${warnings.length > 8 ? '\n…' : ''}`);
}

/**
 * 把当前工程写到指定路径。
 *
 * 判定只看**目标扩展名**：内置的 .sxsproj/.sxs 走 JSON，其余一律问插件。
 * 用扩展名而不是"当前文档来源"是刻意的 —— 用户可以把一个 .demo 工程另存为
 * 另一个 .demo、也可以把新建工程直接导出成 .demo；这两种情况都该归插件管，
 * 而"来源"只描述它最初从哪来。
 *
 * 两条路径都进 `_enqueueProjectWrite`：自动保存与手动保存可能几乎同时触发，
 * 串行化与"用哪条路径"是两件独立的事，不能只有一条路径排队。
 */
async function _writeProjectTo(filePath, opts = {}) {
  // 只看最后一段文件名的扩展名。原来用 split('.').pop() 会把目录里的点
  // （C:\a.b\proj）算进去，无后缀路径更会返回整段路径，两者都会被误判成
  // 插件格式，交给 saveDocument 后回 FILE_NOT_HANDLED —— 表现就是
  // 「另存为保存成功，再打开却报错」。
  const ext = extensionOf(filePath);
  const viaPlugin = ext !== '' && !BUILTIN_PROJECT_EXTENSIONS.includes(ext);
  // 未显式指定时按"会不会丢音频"决定：自动保存与就地 Ctrl+S 都不经过保存
  // 选项对话框，这条默认值是它们唯一的依据。
  // 能写回伴奏的外部格式（.vpr）是例外：插件只收得到文档里的内嵌音频字节，
  // 没有它 regenerate 不出音频轨，所以即便用户取消勾选也必须嵌入。
  // 对 .sxsproj 的用户选择不受影响。
  const embedAccompanimentAudio = requiresAccompanimentAudio(filePath)
    || (opts.embedAccompanimentAudio === undefined
      ? needsAccompanimentEmbed()
      : !!opts.embedAccompanimentAudio);

  if (!viaPlugin) {
    const data = await serializeProject(opts.embedSingerFiles, embedAccompanimentAudio);
    await _enqueueProjectWrite(async () => {
      const res = await window.electronAPI.saveFile(filePath, data);
      _checkSaveResult(res);
    });
    // 内置格式是完整序列化，不存在"没写进去的字段" —— 把上一次插件保存留下的
    // 告警清掉，否则界面上会一直挂着一条已经与当前文件无关的提示。
    state.projectSaveWarnings = [];
    return { ok: true };
  }

  const api = window.electronAPI?.pluginHost;
  if (!api?.saveDocument) throw new Error(t('main.projectPluginUnavailable'));
  return _enqueueProjectWrite(async () => {
    const { out } = await buildProjectObject(opts.embedSingerFiles, embedAccompanimentAudio);
    // 只有「另存为 .svp」才会带 svpVersion（见 saveProjectAs）。就地 Ctrl+S、
    // 自动保存、MCP 导出都不带，插件侧 resolveWriteTarget 缺省按 'keep' 沿用
    // 源版本 —— 这正是「就地保存不弹窗、按原 JSON 版本号行为保存」的落点。
    const res = await api.saveDocument(filePath, out, {
      target: 'save',
      ...(opts.svpVersion ? { svpVersion: opts.svpVersion } : {}),
    });
    if (!res || !res.ok) {
      const err = new Error((res && res.message) || t('main.projectPluginSaveFailed'));
      err.code = res && res.code;
      throw err;
    }
    // 无论弹不弹，都把最近一次的警告记下来：自动保存静默，但信息不能凭空消失
    // —— 自动化与"导出后检查"都能读到它。
    state.projectSaveWarnings = Array.isArray(res.warnings) ? res.warnings : [];
    if (!opts.silentWarnings) _notifySaveWarnings(res.warnings);
    return res;
  });
}

export async function saveProject() {
  // 手动保存优先：取消尚未触发的自动保存，避免保存完成后再全量写一次。
  cancelPendingAutoSave();
  // Save in-place: if we already have a file path, write to it silently
  // without showing a dialog or the save-options popup.
  if (state.currentProjectFilePath) {
    try {
      const epoch = _saveEpoch;
      await _writeProjectTo(state.currentProjectFilePath, {});
      // 写盘期间若有新编辑，不能清掉 dirty。
      if (epoch === _saveEpoch) markClean();
      // 手动保存成功：此前自动保存失败留下的"已通知"标记作废。
      resetAutoSaveNotification();
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
        // 让"另存为"也能选插件格式：主进程把 registry 里 role=save/both 的
        // 扩展名并进来，但只单列、绝不并入第一项。第一项代表宿主原生格式
        // "SXSEditor Project (*.sxsproj)"；一旦把 .vpr/.svp 等并进去，用户
        // 看到的就是"工程文件的后缀名包括了所有支持打开的后缀"，默认落点也
        // 会变成有损的外部格式。插件装/卸的知识仍只在主进程。
        includePluginFormats: true,
        extendFirstFilter: false,
        defaultPath: state.currentProjectFilePath || undefined,
      });
      if (!result.canceled && result.filePath) {
        // 部分平台的原生保存框不自动补后缀、用户也可能删掉后缀。没有扩展名
        // 的路径会被写出端误判成插件格式并回 FILE_NOT_HANDLED，写出的文件
        // 之后也打不开；统一补宿主默认格式。已有扩展名（含用户主动选的外部
        // 格式）一律原样保留。
        const filePath = normalizeSavePath(result.filePath);
        // SV1 / SV2 都是 .svp 但 schema 互不兼容：仅在「另存为 .svp」时询问
        // 按哪个版本行为写。就地 Ctrl+S 走 saveProject()，完全不经过这里。
        let svpVersion;
        if (extensionOf(filePath) === 'svp') {
          svpVersion = await showSvpVersionDialog();
          if (!svpVersion) return { saved: false, canceled: true };
        }
        // 只有「装不下伴奏」的外部格式（.svp/.vsqx/.demo 等）才在写盘前提醒：
        // 插件的 "伴奏不会写回" 告警是**保存之后**才看得到的，用户往往先发现
        // 伴奏没了。.vpr 从内置插件 1.2.0 起能把伴奏重建进容器，不再误报。
        if (formatDropsAccompaniment(filePath)
          && trackManager.getSingers().some((s) => s && s.type === 'accompaniment')) {
          const proceed = await showConfirmDialog(
            t('main.saveExternalFormatDropsAccompaniment', { ext: extensionOf(filePath).toUpperCase() }),
          );
          if (!proceed) return { saved: false, canceled: true };
        }
        const epoch = _saveEpoch;
        await _writeProjectTo(filePath, {
          embedSingerFiles: saveOptions.embedSingerFiles,
          embedAccompanimentAudio: saveOptions.embedAccompanimentAudio,
          ...(svpVersion ? { svpVersion } : {}),
        });
        // projectImportSource 不清：它带着 extSchema 与文档级 ext，是**数据**而不是
        // "当前格式"的标记。存成 .sxsproj 之后这些数据仍要跟着走，否则
        // `demo → sxsproj → demo` 这一趟会丢插件私有字段。
        state.currentProjectFilePath = filePath;
        // 写盘期间若有新编辑，不能清掉 dirty。
        if (epoch === _saveEpoch) markClean();
        // 另存为换了目标格式，旧的失败原因与新文件无关，复位。
        resetAutoSaveNotification();
        console.log('Project saved to', filePath);
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

/**
 * 宿主自己解析的工程扩展名。
 *
 * 其余扩展名一律先问插件（见 openProjectViaPlugin）：插件没接管时会回
 * FILE_NOT_HANDLED，继续走宿主的 JSON 管线。这条"先问插件"的顺序很重要 ——
 * 反过来做的话，任何插件格式都会被 JSON.parse 先炸一次。
 */
export const BUILTIN_PROJECT_EXTENSIONS = ['sxsproj', 'sxs'];

export async function loadProject(filePath = null) {
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
  // 系统"打开方式"投递的路径由主进程给出，此时不弹选择框
  let targetPath = filePath;
  if (!targetPath) {
    if (!window.electronAPI?.showOpenDialog) return { loaded: false, canceled: true };
    const result = await window.electronAPI.showOpenDialog({
      // 第一项是"所有支持的格式"：主进程会把插件声明的扩展名并进这一项
      // （dialogIpc 的 includePluginFormats），所以渲染层不需要知道装了哪些插件。
      filters: [
        { name: t('main.projectFilterAll') || '所有支持的格式', extensions: BUILTIN_PROJECT_EXTENSIONS },
        { name: 'SXSEditor Project', extensions: BUILTIN_PROJECT_EXTENSIONS },
      ],
      includePluginFormats: true,
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { loaded: false, canceled: true };
    }
    targetPath = result.filePaths[0];
  }

  try {
    // 投递进来的路径不在授权列表里，读之前显式授权，否则 readFile 会被拒
    if (window.electronAPI?.authorizePath) await window.electronAPI.authorizePath(targetPath);

    // 加载新工程前关闭所有分片编辑器窗口，避免旧窗口持有已失效的 fragment id
    // 导致 onFragmentSaved 的 find(f => f.id === fragmentId) 失败、编辑静默丢失
    if (window.electronAPI?.closeAllFragmentEditors) {
      await window.electronAPI.closeAllFragmentEditors();
    }

    // M4：先问插件。内置格式与"没有插件接管"的扩展名都会在第一步被挡回来。
    const fromPlugin = await openProjectViaPlugin(targetPath);
    if (fromPlugin) return fromPlugin;

    const data = await window.electronAPI.readFile(targetPath);
    const obj = JSON.parse(data);
    if (!obj || typeof obj !== 'object') throw new Error('Invalid project file');
    // 合法 JSON 不等于工程：`{}`、`{"format":"demo"}`、随便一份配置文件都能 parse 成功。
    // 少了这道判断，打开一个陌生 .json 会把当前工程**静默清空**（三个字段都 undefined，
    // 下面每个 if 都跳过，最后还 markClean）。插件格式被停用后正好会走到这条路径上。
    if (!obj.project && !obj.singers && !obj.fragments) {
      throw new Error(t('main.projectNotAProject') || 'Not a SXSEditor project file');
    }
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
      return { loaded: false, canceled: false, rejected: true };
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
    await applyProjectDocument(obj, targetPath);
    return { loaded: true };
  } catch (err) {
    console.error('Load failed', err);
    showAlertDialog(t('main.projectLoadFailed') + ': ' + (err.message || ''));
    return { loaded: false, canceled: false, error: err.message };
  }
}

/**
 * 走插件 codec 打开。返回 null 表示"这件事不归插件管，继续走内置管线"。
 *
 * 判定交给主进程而不是渲染层：扩展名归属只有注册表说了算，渲染层若自己维护一份
 * "哪些扩展名是插件的"，插件装/卸之后两边必然对不上，表现是"文件打不开也没提示"。
 *
 * 导入进来的内容**不认作原生工程路径**：本段插件只实现了 codec.read，没有 write，
 * 直接按原路径保存会把 sxsproj 的 JSON 写进 .demo，把用户的文件毁掉。所以这里
 * 只保留"内容来源于哪个插件的哪个文件"，currentProjectFilePath 留空 ——
 * 用户保存时自然走"另存为"，落成真正的 .sxsproj。
 */
async function openProjectViaPlugin(targetPath) {
  const api = window.electronAPI?.pluginHost;
  if (!api?.openDocument) return null;

  let res;
  try {
    res = await api.openDocument(targetPath);
  } catch (err) {
    console.warn('[project] 插件打开失败:', err && err.message);
    return null;
  }
  if (!res || res.code === 'FILE_NOT_HANDLED') return null;
  if (!res.ok) {
    showAlertDialog(t('main.projectPluginOpenFailed', { reason: res.message || res.code || '' }));
    return { loaded: false, canceled: false, error: res };
  }
  if (Array.isArray(res.warnings) && res.warnings.length) {
    console.warn('[project] 插件解码警告:\n' + res.warnings.join('\n'));
  }
  await applyProjectDocument(res.document, targetPath, { pluginId: res.pluginId, ext: res.ext });
  return { loaded: true, pluginId: res.pluginId, warnings: res.warnings || [] };
}

/**
 * 把 `extSchema[*].render` 推给主进程的 pipeline hook 执行器。
 *
 * 为什么在"装载工程"里做而不是在导出前做：意图属于文档，属于打开那一刻。
 * 用户可能在打开后立刻试听（不带 hook 的声音），如果等到导出才推，
 * 试听与导出的听感就是两回事 —— 而这类差异用户几乎不可能归因。
 */
export function syncRenderIntent() {
  const api = window.electronAPI?.pluginHost;
  if (!api?.setRenderIntent) return;
  const intent = buildRenderIntent(state.projectExt && state.projectExt.schema);
  try {
    const p = api.setRenderIntent(intent);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {
    /* 推不过去最多是顺序按默认走，不该拦住工程打开 */
  }
}

/**
 * 把一份**已经解析并经校验**的工程文档装进编辑器状态。
 *
 * 从 loadProject 里拆出来的原因不只是"函数太长"：M4 之后有两个来源
 * （宿主 JSON / 插件 codec），它们只在"怎么解析"和"怎么判定版本"上不同，
 * 装载步骤必须逐字相同 —— 拆开才能保证这一点，也才能被单独测试。
 *
 * @param {object} obj 工程文档（{ project, singers, fragments }）
 * @param {string} targetPath 来源路径
 * @param {{pluginId?: string}} [options] 来自插件时给出 pluginId，表示这是一次导入
 */
export async function applyProjectDocument(obj, targetPath, options = {}) {
  const fromPlugin = !!options.pluginId;
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
  // 插件格式也认作"原生路径"。M4 第 1 段只实现了 read，那时把它置空是对的：
  // 回写会把 sxsproj 的 JSON 塞进 .demo。现在 codec.write 落地了，覆盖原文件
  // 才是用户按 Ctrl+S 时期望的行为（写盘有 .bak 兜底）。
  state.currentProjectFilePath = targetPath;
  state.projectImportSource = fromPlugin
    ? { pluginId: options.pluginId, path: targetPath }
    : null;
  // 扩展域与来源解耦：从 .sxsproj 读出来的工程也带着这些数据，它没有来源插件，
  // 但下次导出成 .demo 时仍然要用。
  state.projectExt = {
    schema: obj.extSchema || null,
    root: obj.ext || null,
  };
  syncRenderIntent();
  state.projectSaveWarnings = [];
  // 换了一份工程，上一个文件的自动保存失败提示与它无关，复位以免新工程
  // 的首次失败被旧标记吞掉。
  resetAutoSaveNotification();
  history.clear();
  state.selectedFragmentId = null;
  markClean();
  // refreshAll will be called by the caller
  console.log('Project loaded', targetPath, fromPlugin ? `(via ${options.pluginId})` : '');
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
