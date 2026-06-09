import './common.css';
import './index.css';
import { TrackManager } from './editor/trackManager.js';
import { HistoryManager } from './editor/historyManager.js';
import { t, initI18n, applyLocale, getLocale } from './i18n/index.js';
import { showAlertDialog, showConfirmDialog } from './alertDialog.js';
import { escapeHtml } from './utils/escapeHtml.js';

const trackManager = new TrackManager();
const history = new HistoryManager();

const SAMPLE_RATE = 24000;
const SVS_HOP_SIZE = 480;
let pipelineInitialized = false;
let pipelineInitPromise = null;

function convertF0DataToPitchCurve(f0Data, totalSeconds) {
  if (!f0Data || f0Data.length === 0) return null;
  const totalFrames = Math.floor(totalSeconds * SAMPLE_RATE / SVS_HOP_SIZE);
  const f0Arr = new Float32Array(totalFrames);
  const frameDuration = SVS_HOP_SIZE / SAMPLE_RATE;
  for (let i = 0; i < totalFrames; i++) {
    const frameTime = i * frameDuration;
    let lo = 0;
    let hi = f0Data.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (f0Data[mid].time <= frameTime) lo = mid;
      else hi = mid;
    }
    const f0Lo = f0Data[lo];
    const f0Hi = f0Data[hi];
    if (f0Lo && f0Hi && f0Lo.f0 > 0 && f0Hi.f0 > 0 && hi !== lo) {
      const t = (frameTime - f0Lo.time) / (f0Hi.time - f0Lo.time);
      f0Arr[i] = f0Lo.f0 + t * (f0Hi.f0 - f0Lo.f0);
    } else if (f0Lo && f0Lo.f0 > 0) {
      f0Arr[i] = f0Lo.f0;
    } else {
      f0Arr[i] = 0;
    }
  }
  return f0Arr;
}

let project = {
  bpm: 120,
  timeSignature: [4, 4],
};

let currentProjectFilePath = null;
let isDirty = false;

function markDirty() {
  isDirty = true;
  if (window.electronAPI?.setDirty) {
    window.electronAPI.setDirty(true);
  }
}

function markClean() {
  isDirty = false;
  if (window.electronAPI?.setDirty) {
    window.electronAPI.setDirty(false);
  }
}

let audioContext = null;
let currentAudioSource = null;
let currentAudioBuffer = null;
let playbackStartTime = 0;
let playbackPauseOffset = 0;
let isPlaying = false;
let isSynthesizing = false;
let playheadRaf = null;
let currentAudioData = null;
let gainNode = null;
let useExclusiveMode = false;
let exclusivePlaybackRaf = null;
let audioSettings = null;

const btnPlay = document.getElementById('btn-play');
const btnPause = document.getElementById('btn-pause');
const btnStop = document.getElementById('btn-stop');
const timeDisplay = document.getElementById('time-display');
const bpmInput = document.getElementById('bpm-input');
const timeSigNum = document.getElementById('time-sig-num');
const timeSigDen = document.getElementById('time-sig-den');
const autoShiftCheck = document.getElementById('auto-shift-check');
const btnSave = document.getElementById('btn-save');
const btnLoad = document.getElementById('btn-load');
const btnExport = document.getElementById('btn-export');
const btnAudioToMidi = document.getElementById('btn-audio-to-midi');
const btnAddSinger = document.getElementById('btn-add-singer');
const singerListEl = document.getElementById('singer-list');

const fragmentCanvas = document.getElementById('fragment-canvas');
const fragmentContainer = document.getElementById('fragment-canvas-container');
const fragmentPlayheadCanvas = document.getElementById('fragment-playhead-canvas');
const bpmDisplayBadge = document.getElementById('bpm-display-badge');
const versionDisplay = document.getElementById('version-display');

let fragmentZoomX = 1;

let selectedSingerId = null;

function getSelectedSinger() {
  if (!selectedSingerId) return null;
  return trackManager.getSingers().find(s => s.id === selectedSingerId) || null;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(ms).padStart(3, '0')}`;
}

/**
 * 统一的对话框工厂函数
 * @param {Object} options - 对话框配置选项
 * @param {string} options.title - 对话框标题
 * @param {string} [options.content] - 对话框内容文本
 * @param {HTMLElement} [options.contentElement] - 自定义内容元素
 * @param {Array} options.buttons - 按钮配置数组
 * @param {string} options.buttons[].text - 按钮文本
 * @param {string} [options.buttons[].type='default'] - 按钮类型：'primary' | 'default' | 'danger' | 'success'
 * @param {Function} options.buttons[].onClick - 按钮点击回调
 * @param {Object} [options.styles] - 自定义样式覆盖
 * @param {number} [options.minWidth=280] - 对话框最小宽度
 * @param {boolean} [options.closeOnClickOutside=true] - 点击遮罩层是否关闭
 * @returns {Object} 包含 close 方法的对话框控制对象
 */
function createDialog(options) {
  const {
    title,
    content,
    contentElement,
    buttons = [],
    styles = {},
    minWidth = 280,
    closeOnClickOutside = true,
  } = options;

  // 创建遮罩层
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(10,10,20,0.65);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `;

  // 创建对话框容器
  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: ${styles.dialogBackground || '#252538'};
    border: 1px solid ${styles.dialogBorder || '#3a3a52'};
    border-radius: 10px;
    padding: 20px;
    min-width: ${minWidth}px;
    max-width: ${styles.maxWidth || '500px'};
    max-height: ${styles.maxHeight || '80vh'};
    overflow-y: ${styles.overflowY || 'auto'};
    color: #e0e0f0;
    box-shadow: 0 12px 40px rgba(0,0,0,0.4);
  `;

  // 创建标题
  const titleEl = document.createElement('div');
  titleEl.style.cssText = `
    margin-bottom: 16px;
    font-weight: 600;
    font-size: ${styles.titleFontSize || '14px'};
    color: ${styles.titleColor || '#e0e0f0'};
  `;
  titleEl.textContent = title;
  dialog.appendChild(titleEl);

  // 创建内容区域
  if (content) {
    const contentEl = document.createElement('div');
    contentEl.style.cssText = `
      margin-bottom: 16px;
      font-size: ${styles.contentFontSize || '13px'};
      color: ${styles.contentColor || '#c8c8dc'};
      line-height: 1.5;
    `;
    contentEl.textContent = content;
    dialog.appendChild(contentEl);
  }

  if (contentElement) {
    dialog.appendChild(contentElement);
  }

  // 创建按钮容器
  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = `
    display: flex;
    gap: 8px;
    justify-content: ${styles.buttonAlign || 'flex-end'};
    flex-direction: ${styles.buttonDirection || 'row'};
    margin-top: ${styles.buttonMarginTop || '12px'};
  `;

  // 按钮样式映射
  const buttonStyles = {
    primary: `
      padding: 6px 16px;
      background: linear-gradient(180deg, #5b8def, #4a7de0);
      border: none;
      border-radius: 4px;
      color: #ffffff;
      cursor: pointer;
      text-shadow: 0 1px 2px rgba(0,0,0,0.3);
    `,
    default: `
      padding: 6px 16px;
      background: linear-gradient(180deg, #3a3a4e, #323246);
      border: 1px solid #4a4a62;
      border-radius: 4px;
      color: #ffffff;
      cursor: pointer;
      text-shadow: 0 1px 2px rgba(0,0,0,0.3);
    `,
    danger: `
      padding: 6px 16px;
      background: linear-gradient(180deg, #f87171, #e85555);
      border: none;
      border-radius: 4px;
      color: #ffffff;
      cursor: pointer;
      text-shadow: 0 1px 2px rgba(0,0,0,0.3);
    `,
    success: `
      padding: 6px 16px;
      background: linear-gradient(180deg, #4ade80, #3ac870);
      border: none;
      border-radius: 4px;
      color: #ffffff;
      cursor: pointer;
      text-shadow: 0 1px 2px rgba(0,0,0,0.3);
    `,
  };

  // 创建按钮
  buttons.forEach((btnConfig) => {
    const btn = document.createElement('button');
    btn.textContent = btnConfig.text;
    btn.style.cssText = buttonStyles[btnConfig.type] || buttonStyles.default;

    btn.addEventListener('click', () => {
      if (btnConfig.onClick) {
        btnConfig.onClick();
      }
      close();
    });

    btnContainer.appendChild(btn);
  });

  dialog.appendChild(btnContainer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // 关闭对话框的方法
  const close = () => {
    if (document.body.contains(overlay)) {
      document.body.removeChild(overlay);
    }
  };

  // 点击遮罩层关闭
  if (closeOnClickOutside) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        close();
      }
    });
  }

  return { close, overlay, dialog };
}

function showPromptDialog(title, defaultValue, onConfirm) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = defaultValue || '';
  input.style.cssText = `
    width: 100%;
    padding: 8px;
    background: #14141f;
    border: 1px solid #3a3a52;
    border-radius: 4px;
    color: #e0e0f0;
    margin-bottom: 12px;
    box-sizing: border-box;
  `;

  const contentWrapper = document.createElement('div');
  contentWrapper.appendChild(input);

  const dialog = createDialog({
    title,
    contentElement: contentWrapper,
    buttons: [
      {
        text: t('common.cancel'),
        type: 'default',
        onClick: () => {
          if (onConfirm) onConfirm(null);
        },
      },
      {
        text: t('common.confirm'),
        type: 'primary',
        onClick: () => {
          if (onConfirm) onConfirm(input.value);
        },
      },
    ],
  });

  // 添加键盘事件
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (onConfirm) onConfirm(input.value);
      dialog.close();
    }
    if (e.key === 'Escape') {
      if (onConfirm) onConfirm(null);
      dialog.close();
    }
  });

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function showSingerSelectDialog(singerId) {
  createDialog({
    title: t('main.selectSinger'),
    minWidth: 320,
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
                  loadSingerFile(singerId, buffer, filePath);
                } else {
                  addSingerFromFile(buffer, filePath);
                }
              }
            } catch (err) {
              console.error('Synthesis failed:', err);
            }
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
}

const SXSSINGER_CURRENT_VERSION = '1.0.0';

function validateSingerData(singerData) {
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

function showSingerValidationReport(validation) {
  const contentWrapper = document.createElement('div');

  if (validation.errors.length > 0) {
    const errSection = document.createElement('div');
    errSection.style.cssText = 'margin-bottom: 10px;';
    const errTitle = document.createElement('div');
    errTitle.style.cssText = 'color: #f87171; font-weight: 600; margin-bottom: 4px; font-size: 12px;';
    errTitle.textContent = t('common.errors');
    errSection.appendChild(errTitle);
    validation.errors.forEach((msg) => {
      const item = document.createElement('div');
      item.style.cssText = 'color: #f87171; font-size: 11px; padding-left: 8px; margin-bottom: 2px;';
      item.textContent = `• ${msg}`;
      errSection.appendChild(item);
    });
    contentWrapper.appendChild(errSection);
  }

  if (validation.warnings.length > 0) {
    const warnSection = document.createElement('div');
    warnSection.style.cssText = 'margin-bottom: 10px;';
    const warnTitle = document.createElement('div');
    warnTitle.style.cssText = 'color: #fbbf24; font-weight: 600; margin-bottom: 4px; font-size: 12px;';
    warnTitle.textContent = t('common.warnings');
    warnSection.appendChild(warnTitle);
    validation.warnings.forEach((msg) => {
      const item = document.createElement('div');
      item.style.cssText = 'color: #fbbf24; font-size: 11px; padding-left: 8px; margin-bottom: 2px;';
      item.textContent = `• ${msg}`;
      warnSection.appendChild(item);
    });
    contentWrapper.appendChild(warnSection);
  }

  return new Promise((resolve) => {
    createDialog({
      title: validation.valid ? t('main.singerLoadWarnings') : t('main.singerFileFormatError'),
      contentElement: contentWrapper,
      buttons: [
        {
          text: t('common.confirm'),
          type: validation.valid ? 'primary' : 'danger',
          onClick: () => resolve(),
        },
      ],
      styles: {
        titleColor: validation.valid ? '#fbbf24' : '#f87171',
        dialogBorder: validation.valid ? '#fbbf24' : '#f87171',
      },
    });
  });
}

function applySingerDataToSinger(singer, singerData) {
  if (singerData.wavBase64) {
    try {
      const binaryString = atob(singerData.wavBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      singer.wavBuffer = bytes.buffer;
    } catch (e) {
      console.error('Failed to decode wavBase64:', e);
    }
  }
  if (singerData.midiNotes) singer.midiNotes = singerData.midiNotes;
  if (singerData.f0Data) singer.f0Data = singerData.f0Data;
  if (singerData.singerData) singer.singerData = singerData.singerData;
}

async function loadSingerFile(singerId, buffer, filePath) {
  let singerData;
  try {
    const text = new TextDecoder().decode(buffer);
    singerData = JSON.parse(text);
  } catch (e) {
    await showSingerValidationReport({
      valid: false,
      errors: [t('main.singerJsonParseFailed')],
      warnings: [],
    });
    return;
  }

  const validation = validateSingerData(singerData);
  if (validation.errors.length > 0 || validation.warnings.length > 0) {
    await showSingerValidationReport(validation);
    if (!validation.valid) return;
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
      applySingerDataToSinger(singer, singerData);
    }
    refreshAll();
  }
}

async function addSingerFromFile(buffer, filePath) {
  let singerData;
  try {
    const text = new TextDecoder().decode(buffer);
    singerData = JSON.parse(text);
  } catch (e) {
    await showSingerValidationReport({
      valid: false,
      errors: [t('main.singerJsonParseFailed')],
      warnings: [],
    });
    return;
  }

  const validation = validateSingerData(singerData);
  if (validation.errors.length > 0 || validation.warnings.length > 0) {
    await showSingerValidationReport(validation);
    if (!validation.valid) return;
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
    applySingerDataToSinger(singer, singerData);
    selectedSingerId = singer.id;
    refreshAll();
  }
}

function updateProjectSettings() {
  const bpm = parseInt(bpmInput.value, 10) || 120;
  const num = parseInt(timeSigNum.value, 10) || 4;
  const den = parseInt(timeSigDen.value, 10) || 4;
  const oldBpm = project.bpm;
  project.bpm = Math.max(1, Math.min(999, bpm));
  project.timeSignature = [num, den];
  bpmInput.value = project.bpm;
  if (bpmDisplayBadge) {
    bpmDisplayBadge.textContent = `♩ ${project.bpm} BPM`;
    if (oldBpm !== project.bpm) {
      bpmDisplayBadge.classList.remove('bpm-flash');
      void bpmDisplayBadge.offsetWidth;
      bpmDisplayBadge.classList.add('bpm-flash');
    }
  }
  markDirty();
  refreshAll();
  if (window.electronAPI?.updateProjectSettings) {
    window.electronAPI.updateProjectSettings({ bpm: project.bpm, timeSignature: project.timeSignature });
  }
}

bpmInput.addEventListener('change', updateProjectSettings);
timeSigNum.addEventListener('change', updateProjectSettings);
timeSigDen.addEventListener('change', updateProjectSettings);

btnPlay.addEventListener('click', async () => {
  const fragments = trackManager.getFragments();
  if (fragments.length === 0) {
    showAlertDialog(t('main.noFragmentsToPlay'));
    return;
  }
  if (isSynthesizing) {
    return;
  }
  await playAll();
});

btnPause.addEventListener('click', () => {
  if (isPlaying) {
    pausePlayback();
  }
});

btnStop.addEventListener('click', () => {
  stopPlayback();
  timeDisplay.textContent = formatTime(0);
});

function computePitchCurveF0(singerFragments, allNotes, bpm) {
  const pitchCurveFrags = singerFragments.filter(f => f.pitchCurve && f.pitchCurve.enabled &&
    (f.pitchCurve.anchorPoints.length > 0 || f.pitchCurve.brushSegments.length > 0));

  if (pitchCurveFrags.length === 0) return null;
  if (allNotes.length === 0) return null;

  const lastNote = allNotes[allNotes.length - 1];
  const totalBeatsAll = lastNote.start + lastNote.duration;
  const totalSecondsAll = (totalBeatsAll / bpm) * 60;
  const totalFrames = Math.floor(totalSecondsAll * SAMPLE_RATE / SVS_HOP_SIZE);
  const f0Arr = new Float32Array(totalFrames);

  const sortedAnchorsCache = new Map();
  for (const frag of pitchCurveFrags) {
    const pc = frag.pitchCurve;
    if (pc.anchorPoints.length > 0 && !sortedAnchorsCache.has(frag.id)) {
      sortedAnchorsCache.set(frag.id, [...pc.anchorPoints].sort((a, b) => a.time - b.time));
    }
  }

  // Pre-compute fragment frame ranges
  const fragFrameRanges = [];
  for (const frag of pitchCurveFrags) {
    const fragStartBeat = frag.startTime || 0;
    const fragEndBeat = fragStartBeat + (frag.duration || 0);
    const fragStartSec = (fragStartBeat / bpm) * 60;
    const fragEndSec = (fragEndBeat / bpm) * 60;
    const startFrame = Math.floor(fragStartSec * SAMPLE_RATE / SVS_HOP_SIZE);
    const endFrame = frag.duration ? Math.floor(fragEndSec * SAMPLE_RATE / SVS_HOP_SIZE) : totalFrames;
    fragFrameRanges.push({ frag, startFrame, endFrame });
  }

  // Pre-sort notes by start beat for binary search
  const sortedNotes = allNotes.slice().sort((a, b) => a.start - b.start);

  for (let i = 0; i < totalFrames; i++) {
    const frameTimeSec = (i * SVS_HOP_SIZE) / SAMPLE_RATE;
    const frameBeat = (frameTimeSec / 60) * bpm;
    let pitch = null;

    for (const { frag, startFrame, endFrame } of fragFrameRanges) {
      if (i < startFrame || i >= endFrame) continue;

      const pc = frag.pitchCurve;
      const fragStartBeat = frag.startTime || 0;
      const localBeat = frameBeat - fragStartBeat;

      if (pitch === null && pc.anchorPoints.length > 0) {
        const sorted = sortedAnchorsCache.get(frag.id);
        if (localBeat < sorted[0].time || localBeat > sorted[sorted.length - 1].time) {
          // outside anchor range, skip
        } else {
          // Binary search for anchor point segment
          let lo = 0, hi = sorted.length - 1;
          while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid].time <= localBeat) lo = mid;
            else hi = mid;
          }
          if (localBeat >= sorted[lo].time && localBeat <= sorted[hi].time) {
            const t = (sorted[hi].time - sorted[lo].time) > 0
              ? (localBeat - sorted[lo].time) / (sorted[hi].time - sorted[lo].time) : 0;
            const sm = (sorted[lo].smoothness || 0) / 100;
            const st = sm > 0 ? t * t * (3 - 2 * t) : t;
            pitch = sorted[lo].pitch + st * (sorted[hi].pitch - sorted[lo].pitch);
          }
        }
      }

      if (pitch === null) {
        for (const seg of pc.brushSegments) {
          if (seg.points.length >= 2 && localBeat >= seg.points[0].time && localBeat <= seg.points[seg.points.length - 1].time) {
            for (let j = 0; j < seg.points.length - 1; j++) {
              if (localBeat >= seg.points[j].time && localBeat <= seg.points[j + 1].time) {
                const t = (seg.points[j + 1].time - seg.points[j].time) > 0
                  ? (localBeat - seg.points[j].time) / (seg.points[j + 1].time - seg.points[j].time) : 0;
                pitch = seg.points[j].pitch + t * (seg.points[j + 1].pitch - seg.points[j].pitch);
                break;
              }
            }
            break;
          }
        }
      }

      if (pitch !== null) break;
    }

    if (pitch === null) {
      // Binary search in sorted notes
      let lo = 0, hi = sortedNotes.length - 1;
      let found = false;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const note = sortedNotes[mid];
        if (frameBeat >= note.start && frameBeat < note.start + note.duration) {
          pitch = note.pitch;
          found = true;
          break;
        }
        if (note.start + note.duration <= frameBeat) {
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
    }

    if (pitch !== null && pitch > 0) {
      f0Arr[i] = 440 * Math.pow(2, (pitch - 69) / 12);
    } else {
      f0Arr[i] = 0;
    }
  }
  return Array.from(f0Arr);
}

function serializeProject(embedSingerFiles = false) {
  const singers = trackManager.getSingers().map(singer => {
    const singerObj = { ...singer };
    if (embedSingerFiles && singer.wavBuffer) {
      let wavBase64 = null;
      try {
        const bytes = new Uint8Array(singer.wavBuffer);
        const CHUNK_SIZE = 8192;
        let binary = '';
        for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
          const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
          binary += String.fromCharCode(...chunk);
        }
        wavBase64 = btoa(binary);
      } catch (e) {
        console.error('Failed to decode wavBuffer:', e);
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
    return singerObj;
  });

  return JSON.stringify({
    version: '1.1.0',
    project: {
      bpm: project.bpm,
      timeSignature: project.timeSignature,
    },
    singers,
    fragments: trackManager.getFragments(),
  }, null, 2);
}

async function ensurePipelineInitialized() {
  if (pipelineInitialized) return;
  if (pipelineInitPromise) {
    await pipelineInitPromise;
    return;
  }
  pipelineInitPromise = window.electronAPI.initSVSPipeline();
  try {
    await pipelineInitPromise;
    pipelineInitialized = true;
  } catch (err) {
    pipelineInitPromise = null;
    throw err;
  }
}

async function playAll() {
  isSynthesizing = true;
  btnPlay.disabled = true;
  btnPlay.textContent = t('main.synthesizing');

  try {
    const fragments = trackManager.getFragments();
    const singers = trackManager.getSingers();
    const singerMap = new Map();
    singers.forEach(s => singerMap.set(s.id, s));

    const fragmentsBySinger = new Map();
    fragments.forEach(f => {
      if (!fragmentsBySinger.has(f.singerId)) {
        fragmentsBySinger.set(f.singerId, []);
      }
      fragmentsBySinger.get(f.singerId).push(f);
    });

    const singerIds = [...fragmentsBySinger.keys()];
    if (singerIds.length === 0) {
      showAlertDialog(t('main.noFragmentsToPlay'));
      return;
    }

    let globalFirstStart = Infinity;
    let globalLastEnd = 0;
    const singerDataMap = new Map();

    for (const singerId of singerIds) {
      const singer = singerMap.get(singerId);
      const singerFragments = fragmentsBySinger.get(singerId)
        .sort((a, b) => a.startTime - b.startTime);

      const singerNotes = [];
      for (const fragment of singerFragments) {
        if (fragment.notes && fragment.notes.length > 0) {
          const fragEnd = fragment.startTime + fragment.duration;
          const convertedNotes = [];
          for (const note of fragment.notes) {
            const noteStart = note.start + fragment.startTime;
            const noteEnd = noteStart + note.duration;
            if (noteStart >= fragEnd) continue;
            if (noteEnd > fragEnd) {
              convertedNotes.push({
                lyric: note.lyric || '',
                pitch: note.pitch,
                start: noteStart,
                duration: fragEnd - noteStart,
              });
            } else {
              convertedNotes.push({
                lyric: note.lyric || '',
                pitch: note.pitch,
                start: noteStart,
                duration: note.duration,
              });
            }
          }
          singerNotes.push(...convertedNotes);

          const fragmentEnd = fragEnd;
          if (fragment.startTime < globalFirstStart) globalFirstStart = fragment.startTime;
          if (fragmentEnd > globalLastEnd) globalLastEnd = fragmentEnd;
        }
      }

      if (singerNotes.length === 0) continue;

      singerNotes.sort((a, b) => a.start - b.start);

      const pitchCurveF0 = computePitchCurveF0(singerFragments, singerNotes, project.bpm);

      let singerPitchCurveF0 = pitchCurveF0;
      if (!singerPitchCurveF0 && singer?.f0Data && singer.f0Data.length > 0) {
        const lastNote = singerNotes[singerNotes.length - 1];
        const totalBeatsAll = lastNote.start + lastNote.duration;
        const totalSecondsAll = (totalBeatsAll / project.bpm) * 60;
        const converted = convertF0DataToPitchCurve(singer.f0Data, totalSecondsAll);
        if (converted) {
          singerPitchCurveF0 = Array.from(converted);
        }
      }

      singerDataMap.set(singerId, {
        notes: singerNotes,
        singer,
        pitchCurveF0: singerPitchCurveF0,
        refAudioWavBuffer: singer?.wavBuffer || null,
      });
    }

    if (singerDataMap.size === 0) {
      showAlertDialog(t('main.noNotesToPlay'));
      return;
    }

    await ensurePipelineInitialized();

    const inferenceOpts = getPreviewInferenceOptions();

    const totalSeconds = ((globalLastEnd - globalFirstStart) / project.bpm) * 60;
    const totalSingers = singerDataMap.size;
    let completedSingers = 0;

    const audioResults = [];

    for (const [singerId, data] of singerDataMap) {
      const audioData = await window.electronAPI.synthesizeSVS({
        notes: data.notes,
        bpm: project.bpm,
        options: {
          f0Envelope: null,
          pitchCurveF0: data.pitchCurveF0,
          refAudioWavBuffer: data.refAudioWavBuffer,
          autoShift: autoShiftCheck.checked,
          nSteps: inferenceOpts.nSteps,
          cfg: inferenceOpts.cfg,
          cfgRescale: inferenceOpts.cfgRescale,
        },
      });

      const firstNoteStart = data.notes[0].start;
      audioResults.push({
        audioData,
        startTimeBeat: firstNoteStart,
      });

      completedSingers++;
      const overallProgress = (completedSingers / totalSingers) * 100;
      const currentSeconds = (overallProgress / 100) * totalSeconds;
      timeDisplay.textContent = t('main.synthesizingShort') + ': ' + formatTime(currentSeconds) + ' / ' + formatTime(totalSeconds);
    }

    const maxEndBeat = globalLastEnd;
    const totalSamples = Math.ceil(((maxEndBeat / project.bpm) * 60) * SAMPLE_RATE);
    const mixedAudio = new Float32Array(totalSamples);

    for (const result of audioResults) {
      const startSample = Math.round((result.startTimeBeat / project.bpm * 60) * SAMPLE_RATE);
      const samplesToMix = result.audioData.length;
      for (let i = 0; i < samplesToMix; i++) {
        const targetIndex = startSample + i;
        if (targetIndex < totalSamples) {
          mixedAudio[targetIndex] += result.audioData[i];
        }
      }
    }

    currentAudioData = mixedAudio;

    timeDisplay.textContent = formatTime(0);
    playbackPauseOffset = 0;
    await startAudioPlayback(0);

  } catch (error) {
    console.error('Synthesis failed:', error);
    showAlertDialog(t('main.synthesisFailed') + ': ' + error.message);
    timeDisplay.textContent = formatTime(0);
  } finally {
    isSynthesizing = false;
    btnPlay.textContent = t('main.play');
    btnPlay.disabled = false;
  }
}

function getAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    if (audioContext.sampleRate !== SAMPLE_RATE) {
      console.warn(`[Audio] AudioContext actual sample rate: ${audioContext.sampleRate}Hz, target: ${SAMPLE_RATE}Hz, will auto-resample`);
    }
    gainNode = audioContext.createGain();
    gainNode.connect(audioContext.destination);
    applyAudioSettings();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(err => {
      console.warn('[Audio] AudioContext resume failed:', err);
    });
  }
  return audioContext;
}

async function loadAudioSettings() {
  try {
    audioSettings = await window.electronAPI.getSettings();
    useExclusiveMode = audioSettings?.audioOutputMode === 'exclusive';
  } catch (e) {
    audioSettings = {};
  }
}

function getPreviewInferenceOptions() {
  return {
    nSteps: audioSettings?.previewDiffSteps ?? 16,
    cfg: audioSettings?.previewCfgStrength ?? 3.0,
    cfgRescale: audioSettings?.previewCfgRescale ?? 0.75,
    npuDiffBatchSize: audioSettings?.npuDiffBatchSize ?? 4,
    npuVocoderBatchSize: audioSettings?.npuVocoderBatchSize ?? 4,
  };
}

function getExportInferenceOptions() {
  return {
    nSteps: audioSettings?.exportDiffSteps ?? 32,
    cfg: audioSettings?.exportCfgStrength ?? 3.0,
    cfgRescale: audioSettings?.exportCfgRescale ?? 0.75,
    npuDiffBatchSize: audioSettings?.npuDiffBatchSize ?? 4,
    npuVocoderBatchSize: audioSettings?.npuVocoderBatchSize ?? 4,
  };
}

function applyAudioSettings() {
  if (!audioSettings) return;

  if (gainNode && audioSettings.audioVolume !== undefined) {
    gainNode.gain.value = audioSettings.audioVolume;
  }

  if (audioContext && audioSettings.audioOutputDevice !== undefined && audioSettings.audioOutputDevice !== -1) {
    const sinkId = String(audioSettings.audioOutputDevice);
    if (audioContext.setSinkId && typeof audioContext.setSinkId === 'function') {
      audioContext.setSinkId(sinkId).catch(err => {
      // TODO: translate garbled log
      });
    }
  }
}

async function startAudioPlayback(offset) {
  if (!currentAudioData || currentAudioData.length === 0) {
    return;
  }

  await loadAudioSettings();
  useExclusiveMode = audioSettings?.audioOutputMode === 'exclusive';

  if (useExclusiveMode) {
    await startExclusivePlayback(offset);
  } else {
    startSharedPlayback(offset);
  }
}

function startSharedPlayback(offset) {
  stopAudioSource();

  const context = getAudioContext();
  const audioBuffer = context.createBuffer(1, currentAudioData.length, SAMPLE_RATE);
  const channelData = audioBuffer.getChannelData(0);
  channelData.set(currentAudioData);

  currentAudioBuffer = audioBuffer;

  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(gainNode);

  source.onended = () => {
    if (isPlaying) {
      isPlaying = false;
      playbackPauseOffset = 0;
      stopPlayheadAnimation();
      timeDisplay.textContent = formatTime(0);
    }
  };

  source.start(0, offset);
  currentAudioSource = source;
  isPlaying = true;
  playbackStartTime = context.currentTime - offset;
  playbackPauseOffset = offset;

  startPlayheadAnimation();
}

async function startExclusivePlayback(offset) {
  stopAudioSource();
  stopExclusivePlayback();

  try {
    const options = {
      deviceId: audioSettings?.audioOutputDevice ?? -1,
      sampleRate: audioSettings?.audioSampleRate ?? SAMPLE_RATE,
      channels: 1,
      bitDepth: audioSettings?.audioBitDepth ?? 'float32',
      bufferSize: audioSettings?.audioBufferSize ?? 1024,
      exclusiveMode: true,
      volume: audioSettings?.audioVolume ?? 1.0,
      offset: offset,
    };

    const result = await window.electronAPI.audioPlay(currentAudioData, options);

    if (!result.success) {
      console.warn('[Audio] WASAPI exclusive mode failed, falling back to shared:', result.error);
      useExclusiveMode = false;
      startSharedPlayback(offset);
      return;
    }

    isPlaying = true;
    playbackStartTime = Date.now() / 1000 - offset;
    playbackPauseOffset = offset;

    const removeEndedListener = window.electronAPI.onAudioEnded(() => {
      if (isPlaying) {
        isPlaying = false;
        playbackPauseOffset = 0;
        stopExclusivePlayback();
        stopPlayheadAnimation();
        timeDisplay.textContent = formatTime(0);
      }
    });

    startExclusivePlayheadAnimation(removeEndedListener);
  } catch (err) {
      // TODO: translate garbled log
    useExclusiveMode = false;
    startSharedPlayback(offset);
  }
}

function startExclusivePlayheadAnimation(removeEndedListener) {
  function updatePlayhead() {
    if (!isPlaying) {
      if (removeEndedListener) removeEndedListener();
      return;
    }

    const elapsed = Date.now() / 1000 - playbackStartTime;
    const duration = currentAudioData ? currentAudioData.length / SAMPLE_RATE : 0;

    if (elapsed >= duration) {
      isPlaying = false;
      playbackPauseOffset = 0;
      stopExclusivePlayback();
      stopPlayheadAnimation();
      timeDisplay.textContent = formatTime(0);
      clearPlayheadLine();
      if (removeEndedListener) removeEndedListener();
      return;
    }

    timeDisplay.textContent = formatTime(elapsed);
    drawPlayheadLine(elapsed);
    exclusivePlaybackRaf = requestAnimationFrame(updatePlayhead);
  }

  exclusivePlaybackRaf = requestAnimationFrame(updatePlayhead);
}

function stopExclusivePlayback() {
  if (exclusivePlaybackRaf) {
    cancelAnimationFrame(exclusivePlaybackRaf);
    exclusivePlaybackRaf = null;
  }
  window.electronAPI.audioStop().catch(err => {
    console.warn('[Audio] Failed to stop exclusive playback:', err);
  });
}

function pausePlayback() {
  if (!isPlaying) {
    return;
  }

  if (useExclusiveMode) {
    const elapsed = Date.now() / 1000 - playbackStartTime;
    playbackPauseOffset = elapsed;
    stopExclusivePlayback();
    isPlaying = false;
    stopPlayheadAnimation();
    timeDisplay.textContent = t('main.paused') + ': ' + formatTime(elapsed);
  } else {
    if (!currentAudioSource) return;
    const context = getAudioContext();
    const elapsed = context.currentTime - playbackStartTime;
    playbackPauseOffset = elapsed;
    stopAudioSource();
    isPlaying = false;
    stopPlayheadAnimation();
    timeDisplay.textContent = t('main.paused') + ': ' + formatTime(elapsed);
  }
}

function stopPlayback() {
  if (useExclusiveMode) {
    stopExclusivePlayback();
  }
  stopAudioSource();
  isPlaying = false;
  playbackPauseOffset = 0;
  stopPlayheadAnimation();
  currentAudioData = null;
  currentAudioBuffer = null;
}

function stopAudioSource() {
  if (currentAudioSource) {
    try {
      currentAudioSource.onended = null;
      currentAudioSource.stop();
    } catch (e) {
    }
    currentAudioSource = null;
  }
  if (playheadRaf) {
    cancelAnimationFrame(playheadRaf);
    playheadRaf = null;
  }
}

function startPlayheadAnimation() {
  function updatePlayhead() {
    if (!isPlaying) return;

    const context = getAudioContext();
    const elapsed = context.currentTime - playbackStartTime;

    if (currentAudioBuffer) {
      const duration = currentAudioBuffer.duration;
      if (elapsed >= duration) {
        stopPlayback();
        timeDisplay.textContent = formatTime(0);
        clearPlayheadLine();
        return;
      }
    }

    timeDisplay.textContent = formatTime(elapsed);
    drawPlayheadLine(elapsed);
    playheadRaf = requestAnimationFrame(updatePlayhead);
  }

  playheadRaf = requestAnimationFrame(updatePlayhead);
}

function stopPlayheadAnimation() {
  if (playheadRaf) {
    cancelAnimationFrame(playheadRaf);
    playheadRaf = null;
  }
  clearPlayheadLine();
}

function drawPlayheadLine(elapsedSeconds) {
  if (!fragmentPlayheadCanvas) return;
  const ctx = fragmentPlayheadCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = fragmentPlayheadCanvas.width / dpr;
  const h = fragmentPlayheadCanvas.height / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const beatWidth = getBeatWidth();
  const currentBeat = (elapsedSeconds / 60) * project.bpm;
  const x = currentBeat * beatWidth;

  if (x < 0 || x > w) return;

  ctx.strokeStyle = '#ff4444';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h);
  ctx.stroke();

  ctx.fillStyle = '#ff4444';
  ctx.beginPath();
  ctx.moveTo(x - 5, 0);
  ctx.lineTo(x + 5, 0);
  ctx.lineTo(x, 8);
  ctx.closePath();
  ctx.fill();
}

function clearPlayheadLine() {
  if (!fragmentPlayheadCanvas) return;
  const ctx = fragmentPlayheadCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = fragmentPlayheadCanvas.width / dpr;
  const h = fragmentPlayheadCanvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
}

function showSaveProjectOptionsDialog() {
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
      color: #c8c8dc;
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
    embedDesc.style.cssText = 'font-size: 11px; color: #6a6a86; margin-top: -8px; padding-left: 24px;';
    embedDesc.textContent = t('main.embedSingerFilesDesc');
    optionsContainer.appendChild(embedDesc);

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
            }),
        },
      ],
      styles: {
        buttonMarginTop: '0',
      },
    });
  });
}

btnSave.addEventListener('click', async () => {
  if (window.electronAPI?.showSaveDialog) {
    try {
      const saveOptions = await showSaveProjectOptionsDialog();
      if (!saveOptions) return;

      const result = await window.electronAPI.showSaveDialog({
        filters: [{ name: 'SXSEditor Project', extensions: ['sxsproj'] }],
        defaultPath: currentProjectFilePath || undefined,
      });
      if (!result.canceled && result.filePath) {
        const data = serializeProject(saveOptions.embedSingerFiles);
        await window.electronAPI.saveFile(result.filePath, data);
        currentProjectFilePath = result.filePath;
        markClean();
        console.log('Project saved to', result.filePath);
      }
    } catch (err) {
      console.error('Save failed', err);
    }
  } else {
      // TODO: translate garbled log
  }
});

btnLoad.addEventListener('click', async () => {
  if (window.electronAPI?.showOpenDialog) {
    try {
      const result = await window.electronAPI.showOpenDialog({
        filters: [{ name: 'SXSEditor Project', extensions: ['sxsproj', 'sxs'] }],
        properties: ['openFile'],
      });
      if (!result.canceled && result.filePaths.length > 0) {
        const data = await window.electronAPI.readFile(result.filePaths[0]);
        const obj = JSON.parse(data);
        if (!obj || typeof obj !== 'object') throw new Error('无效的项目文件');
        if (obj.version) {
          const projVersion = obj.version.split('.').map(Number);
          const currentVersion = [1, 1, 0];
          if (projVersion[0] > currentVersion[0]) {
            showAlertDialog(t('main.projectVersionTooHigh', { version: obj.version }));
            return;
          }
          if (projVersion[0] < currentVersion[0] || projVersion[1] < currentVersion[1]) {
             console.warn(`Project file version(${obj.version}) is low, will try downgrade load`);
          }
        }
        if (obj.project) {
          project.bpm = obj.project.bpm ?? 120;
          project.timeSignature = obj.project.timeSignature ?? [4, 4];
          bpmInput.value = project.bpm;
          timeSigNum.value = project.timeSignature[0];
          timeSigDen.value = project.timeSignature[1];
          if (bpmDisplayBadge) bpmDisplayBadge.textContent = `♩ ${project.bpm} BPM`;
        }
        if (obj.singers) {
          trackManager.singers.length = 0;
          for (const s of obj.singers) {
            const singer = trackManager.addSinger(s);
            if (s.embeddedSingerData) {
              applySingerDataToSinger(singer, s.embeddedSingerData);
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
                    applySingerDataToSinger(singer, singerData);
                    if (singerData.wavDuration) {
                      singer.wavDuration = singerData.wavDuration;
                    }
                    singer.singerFileMissing = false;
                  }
                } catch (err) {
      // TODO: translate garbled log
                  singer.singerFileMissing = true;
                }
              }
            }
          }
        }
        if (obj.fragments) {
          trackManager.fragments.length = 0;
          for (const f of obj.fragments) trackManager.fragments.push(f);
        }
        currentProjectFilePath = result.filePaths[0];
        history.clear();
        markClean();
        refreshAll();
        console.log('Project loaded', result.filePaths[0]);
      }
    } catch (err) {
      console.error('Load failed', err);
      showAlertDialog(t('main.projectLoadFailed') + ': ' + (err.message || ''));
    }
  } else {
      // TODO: translate garbled log
  }
});

btnExport.addEventListener('click', async () => {
  const fragments = trackManager.getFragments();
  if (fragments.length === 0) {
    showAlertDialog(t('main.noFragmentsToExport'));
    return;
  }

  const originalText = btnExport.textContent;
  btnExport.disabled = true;
  btnExport.textContent = t('main.exporting');
  timeDisplay.textContent = t('main.preparing');

  try {
    const singers = trackManager.getSingers();
    const allNotesBySinger = {};

    for (const singer of singers) {
      const singerFragments = fragments.filter(f => f.singerId === singer.id);
      if (singerFragments.length === 0) continue;

      const notes = [];
      for (const fragment of singerFragments) {
        if (fragment.notes && fragment.notes.length > 0) {
          const fragEnd = fragment.startTime + fragment.duration;
          for (const note of fragment.notes) {
            const noteStart = note.start + fragment.startTime;
            const noteEnd = noteStart + note.duration;
            if (noteStart >= fragEnd) continue;
            if (noteEnd > fragEnd) {
              notes.push({
                start: noteStart,
                duration: fragEnd - noteStart,
                pitch: note.pitch,
                lyric: note.lyric,
              });
            } else {
              notes.push({
                start: noteStart,
                duration: note.duration,
                pitch: note.pitch,
                lyric: note.lyric,
              });
            }
          }
        }
      }

      if (notes.length > 0) {
        allNotesBySinger[singer.id] = {
          notes: notes.sort((a, b) => a.start - b.start),
          singer,
        };
      }
    }

    const singerIds = Object.keys(allNotesBySinger);
    if (singerIds.length === 0) {
      showAlertDialog(t('main.noNotesToExport'));
      return;
    }

    await ensurePipelineInitialized();

    const exportInferenceOpts = getExportInferenceOptions();

    let audioResults = [];
    let maxDuration = 0;

    for (const singerId of singerIds) {
      const { notes, singer } = allNotesBySinger[singerId];

      const refAudioWavBuffer = singer.wavBuffer || null;

      const singerFragments2 = fragments.filter(f => f.singerId === singerId);
      const exportPitchCurveF0 = computePitchCurveF0(singerFragments2, notes, project.bpm);

      let finalPitchCurveF0 = exportPitchCurveF0;
      if (!finalPitchCurveF0 && singer.f0Data && singer.f0Data.length > 0) {
        const exportTotalBeats = notes.reduce((max, note) => Math.max(max, note.start + note.duration), 0);
        const totalSecondsExport = (exportTotalBeats / project.bpm) * 60;
        const converted = convertF0DataToPitchCurve(singer.f0Data, totalSecondsExport);
        if (converted) {
          finalPitchCurveF0 = converted;
        }
      }

      const audioData = await window.electronAPI.synthesizeSVS({
        notes,
        bpm: project.bpm,
        options: {
          refAudioWavBuffer,
          pitchCurveF0: finalPitchCurveF0,
          autoShift: autoShiftCheck.checked,
          nSteps: exportInferenceOpts.nSteps,
          cfg: exportInferenceOpts.cfg,
          cfgRescale: exportInferenceOpts.cfgRescale,
        },
      });

      const firstNoteStart = notes[0].start;
      const lastNote = notes[notes.length - 1];
      const endBeat = lastNote.start + lastNote.duration;
      maxDuration = Math.max(maxDuration, (endBeat / project.bpm) * 60);

      audioResults.push({
        audioData,
        startTimeBeat: firstNoteStart,
      });
    }

    timeDisplay.textContent = t('main.encodingWav');

    const totalSamples = Math.ceil(maxDuration * SAMPLE_RATE);
    const mixedAudio = new Float32Array(totalSamples);

    for (const result of audioResults) {
      const startSample = Math.round((result.startTimeBeat / project.bpm * 60) * SAMPLE_RATE);
      const samplesToMix = result.audioData.length;

      for (let i = 0; i < samplesToMix; i++) {
        const targetIndex = startSample + i;
        if (targetIndex < totalSamples) {
          mixedAudio[targetIndex] += result.audioData[i];
        }
      }
    }

    const { encodeWav } = await import('./audio/wavEncoder.js');
    const wavData = encodeWav(mixedAudio, SAMPLE_RATE);

    timeDisplay.textContent = t('main.savingFile');

    const result = await window.electronAPI.showSaveDialog({
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    });

    if (!result.canceled && result.filePath) {
      await window.electronAPI.saveFile(result.filePath, wavData);
      timeDisplay.textContent = formatTime(maxDuration);
    }

  } catch (err) {
    console.error('Synthesis failed:', err);
    showAlertDialog(t('main.exportFailed') + ': ' + (err.message || ''));
    timeDisplay.textContent = t('main.exportFailed');
  } finally {
    btnExport.disabled = false;
    btnExport.textContent = originalText;
  }
});

btnAddSinger.addEventListener('click', () => {
  showSingerSelectDialog(null);
});

const _ipcCleanups = [];
if (window.electronAPI?.onSingerCreated) {
  const cleanup = window.electronAPI.onSingerCreated((singerData) => {
    const singer = trackManager.addSinger({
      trackName: singerData.singerName,
      singerName: singerData.singerName,
      color: singerData.color,
      avatarPath: singerData.avatarPath,
      wavPath: singerData.wavPath,
      midiPath: singerData.midiPath,
      singerFilePath: singerData.filePath || null,
      singerFileMissing: false,
    });
    if (singerData.wavBuffer) {
      singer.wavBuffer = singerData.wavBuffer;
    }
    if (singerData.midiNotes) {
      singer.midiNotes = singerData.midiNotes;
    }
    if (singerData.f0Data) {
      singer.f0Data = singerData.f0Data;
    }
    if (singerData.singerData) {
      singer.singerData = singerData.singerData;
    }
    selectedSingerId = singer.id;
    markDirty();
    refreshAll();
  });
  if (cleanup) _ipcCleanups.push(cleanup);
}

let editingTrackNameId = null;

function commitTrackNameEdit(singer, newName) {
  if (newName && newName !== singer.trackName) {
    const oldName = singer.trackName;
    const singerId = singer.id;
    trackManager.updateSinger(singer.id, { trackName: newName });
    history.push({
      undo() {
        trackManager.updateSinger(singerId, { trackName: oldName });
        refreshAll();
      },
      redo() {
        trackManager.updateSinger(singerId, { trackName: newName });
        refreshAll();
      }
    });
    markDirty();
  }
}

function renderSingerList() {
  const singers = trackManager.getSingers();
  const currentIds = singers.map(s => s.id).join(',');
  const currentNames = singers.map(s => s.trackName).join(',');
  const currentMissing = singers.map(s => s.singerFileMissing ? '1' : '0').join(',');
  const cacheKey = `${currentIds}|${currentNames}|${currentMissing}|${editingTrackNameId}`;
  if (renderSingerList._cacheKey === cacheKey && singerListEl.childElementCount > 0) return;
  renderSingerList._cacheKey = cacheKey;

  singerListEl.innerHTML = '';

  const spacer = document.createElement('div');
  spacer.className = 'singer-row-spacer';
  singerListEl.appendChild(spacer);

  if (singers.length === 0) {
    const emptyItem = document.createElement('div');
    emptyItem.className = 'singer-item-empty';
    emptyItem.setAttribute('role', 'listitem');
    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'singer-avatar-empty';
    const placeholder = document.createElement('span');
    placeholder.className = 'singer-avatar-placeholder';
    placeholder.textContent = '+';
    avatarDiv.appendChild(placeholder);
    const infoDiv = document.createElement('div');
    infoDiv.className = 'singer-info-empty';
    const textDiv = document.createElement('div');
    textDiv.className = 'singer-empty-text';
    textDiv.textContent = t('main.clickToAddSinger');
    infoDiv.appendChild(textDiv);
    emptyItem.appendChild(avatarDiv);
    emptyItem.appendChild(infoDiv);
    emptyItem.addEventListener('click', () => {
      showSingerSelectDialog(null);
    });
    singerListEl.appendChild(emptyItem);
    return;
  }

  singers.forEach(singer => {
    const item = document.createElement('div');
    item.className = 'singer-item';
    item.setAttribute('role', 'listitem');
    item.dataset.singerId = singer.id;

    const isEditingTrackName = editingTrackNameId === singer.id;

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'singer-avatar';
    if (singer.avatarPath && (singer.avatarPath.startsWith('data:image/') || /^[a-zA-Z]:\\|^\//.test(singer.avatarPath))) {
      const img = document.createElement('img');
      img.src = singer.avatarPath;
      img.alt = singer.singerName || '';
      avatarDiv.appendChild(img);
    } else {
      avatarDiv.textContent = '🎤';
    }

    const infoDiv = document.createElement('div');
    infoDiv.className = 'singer-info';

    if (isEditingTrackName) {
      const input = document.createElement('input');
      input.className = 'singer-track-name-input';
      input.value = singer.trackName;
      input.style.cssText = `
        background: #14141f;
        color: #e0e0f0;
        border: 1px solid #5b8def;
        border-radius: 3px;
        padding: 2px 4px;
        font-size: 12px;
        font-weight: 600;
        width: 100%;
      `;
      infoDiv.appendChild(input);

      const singerNameDiv = document.createElement('div');
      singerNameDiv.className = 'singer-singer-name';
      singerNameDiv.textContent = singer.singerName;
      infoDiv.appendChild(singerNameDiv);

      if (singer.singerFileMissing) {
        const warningDiv = document.createElement('div');
        warningDiv.className = 'singer-file-missing-warning';
        warningDiv.textContent = t('main.singerFileNotFound');
        infoDiv.appendChild(warningDiv);
      } else {
        const configDiv = document.createElement('div');
        configDiv.className = 'singer-config';
        configDiv.textContent = 'SXS INFERENCE';
        infoDiv.appendChild(configDiv);
      }

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          commitTrackNameEdit(singer, input.value.trim());
          editingTrackNameId = null;
          renderSingerList();
        } else if (e.key === 'Escape') {
          editingTrackNameId = null;
          renderSingerList();
        }
      });
      input.addEventListener('blur', () => {
        if (editingTrackNameId === singer.id) {
          commitTrackNameEdit(singer, input.value.trim());
          editingTrackNameId = null;
          renderSingerList();
        }
      });

      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else {
      const trackNameDiv = document.createElement('div');
      trackNameDiv.className = 'singer-track-name';
      trackNameDiv.textContent = singer.trackName;
      infoDiv.appendChild(trackNameDiv);

      const singerNameDiv = document.createElement('div');
      singerNameDiv.className = 'singer-singer-name';
      singerNameDiv.textContent = singer.singerName;
      infoDiv.appendChild(singerNameDiv);

      if (singer.singerFileMissing) {
        const warningDiv = document.createElement('div');
        warningDiv.className = 'singer-file-missing-warning';
        warningDiv.textContent = t('main.singerFileNotFound');
        infoDiv.appendChild(warningDiv);

        const relocateBtn = document.createElement('button');
        relocateBtn.className = 'btn-relocate-singer';
        relocateBtn.textContent = t('main.relocate');
        relocateBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const result = await window.electronAPI.showOpenDialog({
              title: t('main.relocateSingerFile'),
              filters: [{ name: 'SXS Singer', extensions: ['sxssinger'] }],
              properties: ['openFile'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              const filePath = result.filePaths[0];
              const buffer = await window.electronAPI.readFileBuffer(filePath);
              await loadSingerFile(singer.id, buffer, filePath);
            }
          } catch (err) {
      // TODO: translate garbled log
          }
        });
        infoDiv.appendChild(relocateBtn);
      } else {
        const configDiv = document.createElement('div');
        configDiv.className = 'singer-config';
        configDiv.textContent = 'SXS INFERENCE';
        infoDiv.appendChild(configDiv);
      }

      trackNameDiv.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        editingTrackNameId = singer.id;
        renderSingerList();
      });
    }

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'singer-item-actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-fragment-add';
    addBtn.title = t('main.addFragment');
    addBtn.dataset.singerId = singer.id;
    addBtn.textContent = '+';
    actionsDiv.appendChild(addBtn);

    if (singers.length > 1) {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-singer-delete';
      delBtn.title = t('main.deleteSinger');
      delBtn.dataset.singerId = singer.id;
      delBtn.textContent = '×';
      actionsDiv.appendChild(delBtn);
    }

    item.appendChild(avatarDiv);
    item.appendChild(infoDiv);
    item.appendChild(actionsDiv);

    item.addEventListener('click', (e) => {
      if (e.target.closest('.btn-fragment-add') || e.target.closest('.btn-singer-delete') || e.target.closest('.singer-track-name-input') || e.target.closest('.btn-relocate-singer')) {
        return;
      }
      if (editingTrackNameId === singer.id) {
        const input = item.querySelector('.singer-track-name-input');
        if (input) {
          commitTrackNameEdit(singer, input.value.trim());
        }
        editingTrackNameId = null;
        renderSingerList();
        return;
      }
      document.querySelectorAll('.singer-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      selectedSingerId = singer.id;
    });

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const singerId = addBtn.dataset.singerId;
      const fragments = trackManager.getFragments();
      const lastFragment = fragments.filter(f => f.singerId === singerId).pop();
      const startTime = lastFragment ? lastFragment.startTime + lastFragment.duration : 0;
      const newFragment = trackManager.addFragment({ singerId, startTime, duration: 4 });
      const newFragmentId = newFragment.id;
      history.push({
        undo() {
          trackManager.removeFragment(newFragmentId);
          refreshAll();
        },
        redo() {
          const singer = trackManager.getSinger(singerId);
          const color = singer ? singer.color : '#5b8def';
          const frag = trackManager.addFragment({ singerId, startTime, duration: 4, color });
          renderFragmentTimeline();
        }
      });
      markDirty();
      renderFragmentTimeline();
    });

    if (singers.length > 1) {
      const delBtn = item.querySelector('.btn-singer-delete');
      if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const singerId = delBtn.dataset.singerId;
          if (await showConfirmDialog(t('main.confirmDeleteSinger', { name: singer.trackName }))) {
            const singerClone = JSON.parse(JSON.stringify(singer));
            const singerFragments = trackManager.getFragments().filter(f => f.singerId === singerId);
            const fragmentsClone = singerFragments.map(f => JSON.parse(JSON.stringify(f)));
            trackManager.removeSinger(singerId);
            history.push({
              undo() {
                const restoredSinger = trackManager.addSinger(singerClone);
                for (const fc of fragmentsClone) {
                  trackManager.addFragment(fc);
                }
                refreshAll();
              },
              redo() {
                trackManager.removeSinger(singerId);
                refreshAll();
              }
            });
            markDirty();
            refreshAll();
          }
        });
      }
    }

    singerListEl.appendChild(item);
  });
}

const FRAGMENT_HEIGHT = 60;
const SINGER_ROW_HEIGHT = 80;
const HEADER_HEIGHT = 24;
const FRAGMENT_BASE_BEAT_WIDTH = 40;
const REF_BPM = 120;

function getBeatWidth() {
  const bpmFactor = REF_BPM / (project.bpm || 120);
  return FRAGMENT_BASE_BEAT_WIDTH * fragmentZoomX * bpmFactor;
}

let fragmentScrollX = 0;
let fragmentScrollY = 0;

function syncFragmentScroll() {
  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();
  const beatWidth = getBeatWidth();
  const maxBeat = fragments.reduce((max, f) => Math.max(max, f.startTime + f.duration), 0);
  const totalBeats = Math.max(64, Math.ceil((maxBeat + 16) / 16) * 16);
  const canvasWidth = totalBeats * beatWidth;
  const canvasHeight = singers.length * SINGER_ROW_HEIGHT + HEADER_HEIGHT;
  const containerW = fragmentContainer.clientWidth;
  const containerH = fragmentContainer.clientHeight;

  fragmentScrollX = Math.max(0, Math.min(fragmentScrollX, canvasWidth - containerW));
  fragmentScrollY = Math.max(0, Math.min(fragmentScrollY, canvasHeight - containerH));

  fragmentCanvas.style.transform = `translate(${-fragmentScrollX}px, ${-fragmentScrollY}px)`;
  fragmentPlayheadCanvas.style.transform = `translate(${-fragmentScrollX}px, ${-fragmentScrollY}px)`;
  singerListEl.scrollTop = fragmentScrollY;
}

fragmentContainer.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const containerRect = fragmentContainer.getBoundingClientRect();
    const mouseXInContainer = e.clientX - containerRect.left;
    const beatWidth = getBeatWidth();
    const mouseBeats = (mouseXInContainer + fragmentScrollX) / beatWidth;

    const delta = e.deltaY > 0 ? 0.85 : 1.18;
    fragmentZoomX = Math.max(0.25, Math.min(4, fragmentZoomX * delta));

    const newBeatWidth = getBeatWidth();
    fragmentScrollX = mouseBeats * newBeatWidth - mouseXInContainer;
    renderFragmentTimeline();
  } else if (e.shiftKey) {
    fragmentScrollY += e.deltaY;
  } else {
    fragmentScrollX += e.deltaY;
  }
  syncFragmentScroll();
}, { passive: false });

singerListEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  fragmentScrollY += e.deltaY;
  syncFragmentScroll();
}, { passive: false });

function renderFragmentTimeline() {
  const ctx = fragmentCanvas.getContext('2d');
  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();
  const dpr = window.devicePixelRatio || 1;

  const beatWidth = getBeatWidth();
  const maxBeat = fragments.reduce((max, f) => Math.max(max, f.startTime + f.duration), 0);
  const totalBeats = Math.max(64, Math.ceil((maxBeat + 16) / 16) * 16);
  const canvasWidth = totalBeats * beatWidth;
  const canvasHeight = singers.length * SINGER_ROW_HEIGHT + HEADER_HEIGHT;

  fragmentCanvas.style.width = canvasWidth + 'px';
  fragmentCanvas.style.height = canvasHeight + 'px';
  fragmentCanvas.width = Math.floor(canvasWidth * dpr);
  fragmentCanvas.height = Math.floor(canvasHeight * dpr);

  fragmentPlayheadCanvas.style.width = canvasWidth + 'px';
  fragmentPlayheadCanvas.style.height = canvasHeight + 'px';
  fragmentPlayheadCanvas.width = Math.floor(canvasWidth * dpr);
  fragmentPlayheadCanvas.height = Math.floor(canvasHeight * dpr);

  syncFragmentScroll();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#14141f';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const beatsPerMeasure = project.timeSignature ? project.timeSignature[0] : 4;

  ctx.strokeStyle = '#2a2a3d';
  ctx.lineWidth = 1;
  for (let i = 0; i <= totalBeats; i++) {
    const x = i * beatWidth;
    const isMeasureLine = (i % beatsPerMeasure === 0);
    ctx.strokeStyle = isMeasureLine ? '#4a4a66' : '#2a2a3d';
    ctx.beginPath();
    ctx.moveTo(x, HEADER_HEIGHT);
    ctx.lineTo(x, canvasHeight);
    ctx.stroke();

    if (isMeasureLine) {
      const measureNum = Math.floor(i / beatsPerMeasure) + 1;
      ctx.fillStyle = '#6a6a86';
      ctx.font = '10px sans-serif';
      ctx.fillText(String(measureNum), x + 2, HEADER_HEIGHT - 4);
    }
  }

  singers.forEach((singer, index) => {
    const y = index * SINGER_ROW_HEIGHT + HEADER_HEIGHT;

    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(0, y, canvasWidth, SINGER_ROW_HEIGHT - 2);

    ctx.strokeStyle = '#1a1a28';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + SINGER_ROW_HEIGHT - 2);
    ctx.lineTo(canvasWidth, y + SINGER_ROW_HEIGHT - 2);
    ctx.stroke();

    const singerFragments = fragments.filter(f => f.singerId === singer.id);
    singerFragments.forEach(fragment => {
      const fragX = fragment.startTime * beatWidth;
      const fragWidth = fragment.duration * beatWidth;
      const fragY = y + 4;
      const radius = 6;

      // 圆角矩形填充
      ctx.fillStyle = fragment.color + 'cc';
      ctx.beginPath();
      ctx.roundRect(fragX, fragY, fragWidth, FRAGMENT_HEIGHT, radius);
      ctx.fill();

      // 圆角矩形描边
      ctx.strokeStyle = fragment.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(fragX, fragY, fragWidth, FRAGMENT_HEIGHT, radius);
      ctx.stroke();

      // MIDI 音符可视化
      if (fragment.notes && fragment.notes.length > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(fragX, fragY, fragWidth, FRAGMENT_HEIGHT, radius);
        ctx.clip();

        const midiAreaTop = fragY + 22;
        const midiAreaHeight = FRAGMENT_HEIGHT - 26;
        const fragDuration = fragment.duration;

        // 计算音符的音高范围
        let minPitch = 127, maxPitch = 0;
        for (const note of fragment.notes) {
          if (note.start >= fragDuration) continue;
          if (note.pitch < minPitch) minPitch = note.pitch;
          if (note.pitch > maxPitch) maxPitch = note.pitch;
        }
        if (minPitch > maxPitch) { minPitch = 60; maxPitch = 72; }
        const pitchRange = Math.max(maxPitch - minPitch + 1, 6);

        for (const note of fragment.notes) {
          if (note.start >= fragDuration) continue;
          const noteEnd = Math.min(note.start + note.duration, fragDuration);
          const noteX = fragX + (note.start / fragDuration) * fragWidth;
          const noteW = Math.max(1, ((noteEnd - note.start) / fragDuration) * fragWidth);
          const pitchOffset = (maxPitch - note.pitch) / pitchRange;
          const noteH = Math.max(2, midiAreaHeight / pitchRange);
          const noteY = midiAreaTop + pitchOffset * midiAreaHeight;

          ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
          ctx.fillRect(noteX, noteY, noteW, noteH);
        }
        ctx.restore();
      }

      ctx.fillStyle = '#e0e0f0';
      ctx.font = '11px sans-serif';
      ctx.fillText(fragment.name || t('main.newFragment'), fragX + 6, y + 16);

      ctx.fillStyle = '#a8a8c0';
      ctx.font = '10px sans-serif';
      ctx.fillText(t('main.beatRange', { start: fragment.startTime, end: fragment.startTime + fragment.duration }), fragX + 6, y + 36);

      ctx.save();
      ctx.strokeStyle = '#ffffff44';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(fragX - 2, y + 4, 4, FRAGMENT_HEIGHT);
      ctx.strokeRect(fragX + fragWidth - 2, y + 4, 4, FRAGMENT_HEIGHT);
      ctx.restore();
    });

    if (singerFragments.length === 0) {
      ctx.fillStyle = '#4a4a66';
      ctx.font = '11px sans-serif';
      ctx.fillText(t('main.clickToAddFragment'), 8, y + 30);
    }
  });
}

let dragState = null;
let fragmentDragSnapshot = null;

fragmentCanvas.addEventListener('mousedown', (e) => {
  const rect = fragmentCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();
  const beatWidth = getBeatWidth();

  for (let i = 0; i < singers.length; i++) {
    const singerY = i * SINGER_ROW_HEIGHT + HEADER_HEIGHT;

    if (y >= singerY && y < singerY + SINGER_ROW_HEIGHT) {
      const singerId = singers[i].id;
      const singerFragments = fragments.filter(f => f.singerId === singerId);

      for (const fragment of singerFragments) {
        const fragX = fragment.startTime * beatWidth;
        const fragWidth = fragment.duration * beatWidth;

        if (x >= fragX - 4 && x <= fragX + 4) {
          dragState = { type: 'resize-left', fragment, startX: x, originalStart: fragment.startTime, originalDuration: fragment.duration };
          fragmentDragSnapshot = { startTime: fragment.startTime, duration: fragment.duration };
          return;
        }
        if (x >= fragX + fragWidth - 4 && x <= fragX + fragWidth + 4) {
          dragState = { type: 'resize-right', fragment, startX: x, originalStart: fragment.startTime, originalDuration: fragment.duration };
          fragmentDragSnapshot = { startTime: fragment.startTime, duration: fragment.duration };
          return;
        }
        if (x >= fragX && x <= fragX + fragWidth) {
          dragState = { type: 'move', fragment, startX: x, startY: y, originalStart: fragment.startTime, originalSingerId: fragment.singerId };
          fragmentDragSnapshot = { startTime: fragment.startTime, duration: fragment.duration, singerId: fragment.singerId };
          return;
        }
      }
    }
  }
});

let renderPending = false;

fragmentCanvas.addEventListener('mousemove', (e) => {
  if (!dragState) return;

  const rect = fragmentCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const beatWidth = getBeatWidth();
  const dx = (x - dragState.startX) / beatWidth;

  if (dragState.type === 'move') {
    const newStart = Math.max(0, dragState.originalStart + dx);
    const updateData = { startTime: Math.round(newStart * 4) / 4 };

    // 检测鼠标是否移到了其他歌手轨道行
    const singers = trackManager.getSingers();
    for (let i = 0; i < singers.length; i++) {
      const singerY = i * SINGER_ROW_HEIGHT + HEADER_HEIGHT;
      if (y >= singerY && y < singerY + SINGER_ROW_HEIGHT) {
        const targetSingerId = singers[i].id;
        if (targetSingerId !== dragState.fragment.singerId) {
          updateData.singerId = targetSingerId;
          updateData.color = singers[i].color;
        }
        break;
      }
    }

    trackManager.updateFragment(dragState.fragment.id, updateData);
  } else if (dragState.type === 'resize-right') {
    const newDuration = Math.max(0.25, dragState.originalDuration + dx);
    trackManager.updateFragment(dragState.fragment.id, { duration: Math.round(newDuration * 4) / 4 });
  } else if (dragState.type === 'resize-left') {
    const newStart = dragState.originalStart + dx;
    const newDuration = dragState.originalDuration - dx;
    if (newStart >= 0 && newDuration >= 0.25) {
      trackManager.updateFragment(dragState.fragment.id, {
        startTime: Math.round(newStart * 4) / 4,
        duration: Math.round(newDuration * 4) / 4,
      });
    }
  }

  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderFragmentTimeline();
      renderPending = false;
    });
  }
});

function finishDrag() {
  if (dragState && fragmentDragSnapshot) {
    const fragment = dragState.fragment;
    const oldStart = fragmentDragSnapshot.startTime;
    const oldDuration = fragmentDragSnapshot.duration;
    const oldSingerId = fragmentDragSnapshot.singerId;
    const newStart = fragment.startTime;
    const newDuration = fragment.duration;
    const newSingerId = fragment.singerId;
    const fragmentId = fragment.id;

    if (oldStart !== newStart || oldDuration !== newDuration || oldSingerId !== newSingerId) {
      history.push({
        undo() {
          const f = trackManager.getFragment(fragmentId);
          if (f) {
            f.startTime = oldStart;
            f.duration = oldDuration;
            if (oldSingerId !== newSingerId) {
              const oldSinger = trackManager.getSinger(oldSingerId);
              f.singerId = oldSingerId;
              f.color = oldSinger ? oldSinger.color : f.color;
            }
          }
          renderFragmentTimeline();
          if (window.electronAPI?.updateFragmentBounds) {
            window.electronAPI.updateFragmentBounds(fragmentId, { startTime: oldStart, duration: oldDuration });
          }
        },
        redo() {
          const f = trackManager.getFragment(fragmentId);
          if (f) {
            f.startTime = newStart;
            f.duration = newDuration;
            if (oldSingerId !== newSingerId) {
              const newSinger = trackManager.getSinger(newSingerId);
              f.singerId = newSingerId;
              f.color = newSinger ? newSinger.color : f.color;
            }
          }
          renderFragmentTimeline();
          if (window.electronAPI?.updateFragmentBounds) {
            window.electronAPI.updateFragmentBounds(fragmentId, { startTime: newStart, duration: newDuration });
          }
        }
      });
      markDirty();
      if (window.electronAPI?.updateFragmentBounds) {
        window.electronAPI.updateFragmentBounds(fragmentId, { startTime: newStart, duration: newDuration });
      }
    }
  }
  dragState = null;
  fragmentDragSnapshot = null;
}

fragmentCanvas.addEventListener('mouseup', finishDrag);
fragmentCanvas.addEventListener('mouseleave', finishDrag);

fragmentCanvas.addEventListener('dblclick', (e) => {
  const rect = fragmentCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();
  const beatWidth = getBeatWidth();

  for (let i = 0; i < singers.length; i++) {
    const singerY = i * SINGER_ROW_HEIGHT + HEADER_HEIGHT;

    if (y >= singerY && y < singerY + SINGER_ROW_HEIGHT) {
      const singerFragments = fragments.filter(f => f.singerId === singers[i].id);

      for (const fragment of singerFragments) {
        const fragX = fragment.startTime * beatWidth;
        const fragWidth = fragment.duration * beatWidth;

        if (x >= fragX && x <= fragX + fragWidth) {
          openFragmentEditor(fragment);
          return;
        }
      }
    }
  }
});

function openFragmentEditor(fragment) {
  if (window.electronAPI?.openFragmentEditor) {
    const singer = trackManager.getSingers().find(s => s.id === fragment.singerId);
    const wavBuffer = singer?.wavBuffer || null;

    window.electronAPI.openFragmentEditor({
      fragment,
      project,
      wavBuffer,
    });
  } else {
    showAlertDialog(t('main.fragmentEditorNotImplemented'));
  }
}

if (window.electronAPI?.onFragmentSaved) {
  const cleanup = window.electronAPI.onFragmentSaved((data) => {
    const { fragmentId, notes, envelopes, pitchCurve, startTime, duration } = data;
    const fragment = trackManager.getFragments().find(f => f.id === fragmentId);
    if (fragment) {
      if (notes) fragment.notes = notes;
      if (envelopes) fragment.envelopes = envelopes;
      if (pitchCurve) fragment.pitchCurve = pitchCurve;
      if (startTime !== undefined) fragment.startTime = startTime;
      if (duration !== undefined) fragment.duration = duration;
    }
    refreshAll();
    autoSaveProject();
  });
  if (cleanup) _ipcCleanups.push(cleanup);
}


function refreshAll() {
  renderSingerList();
  renderFragmentTimeline();
}

async function autoSaveProject() {
  if (!currentProjectFilePath) return;
  try {
    const data = serializeProject(false);
    await window.electronAPI.saveFile(currentProjectFilePath, data);
    markClean();
    console.log('Project auto-saved to', currentProjectFilePath);
  } catch (err) {
      // TODO: translate garbled log
  }
}

updateProjectSettings();
refreshAll();

(async () => {
  try {
    const version = await window.electronAPI.getAppVersion();
    if (versionDisplay) versionDisplay.textContent = `v${version}`;
  } catch (_) {
    if (versionDisplay) versionDisplay.textContent = 'v1.0.0';
  }
})();

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if ((e.ctrlKey || e.metaKey) && e.key === 's' && !e.shiftKey) {
    e.preventDefault();
    btnSave.click();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    if (history.canUndo()) {
      history.undo();
      refreshAll();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey) || (e.key === 'Z' && e.shiftKey))) {
    e.preventDefault();
    if (history.canRedo()) {
      history.redo();
      refreshAll();
    }
    return;
  }
});

initI18n();
applyLocale();
document.documentElement.lang = getLocale();

document.addEventListener('localeChanged', () => {
  applyLocale();
});

if (window.electronAPI?.onLocaleChanged) {
  const cleanup = window.electronAPI.onLocaleChanged(() => {
    location.reload();
  });
  if (cleanup) _ipcCleanups.push(cleanup);
}

if (window.electronAPI?.onCloseConfirm) {
  let closeAfterSave = false;
  let closeSavePollTimer = null;
  let closeSaveTimeoutTimer = null;

  function cleanupCloseTimers() {
    if (closeSavePollTimer) { clearInterval(closeSavePollTimer); closeSavePollTimer = null; }
    if (closeSaveTimeoutTimer) { clearTimeout(closeSaveTimeoutTimer); closeSaveTimeoutTimer = null; }
    closeAfterSave = false;
  }

  function doCloseConfirmed() {
    cleanupCloseTimers();
    if (window.electronAPI?.closeConfirmed) {
      window.electronAPI.closeConfirmed();
    }
  }

  // 拦截保存按钮点击，在保存成功后关闭窗口
  btnSave.addEventListener('click', function onSaveForClose() {
    if (!closeAfterSave) return;
    cleanupCloseTimers();
    closeSavePollTimer = setInterval(() => {
      if (!isDirty) doCloseConfirmed();
    }, 100);
    closeSaveTimeoutTimer = setTimeout(() => {
      doCloseConfirmed();
    }, 10000);
  });

  const cleanupClose = window.electronAPI.onCloseConfirm(async () => {
    try {
      const result = await showSaveBeforeCloseDialog();
      if (result === 'save') {
        closeAfterSave = true;
        btnSave.click();
      } else if (result === 'discard') {
        doCloseConfirmed();
      }
      // result === 'cancel' -> 不做任何事，窗口保持打开
    } catch (err) {
      console.error('Close confirmation dialog error:', err);
      doCloseConfirmed();
    }
  });
  if (cleanupClose) _ipcCleanups.push(cleanupClose);
}

async function showSaveBeforeCloseDialog() {
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

function showAudioToMidiDialog() {
  return new Promise((resolve) => {
    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display: flex; flex-direction: column; gap: 10px;';

    const extractPitchBtn = document.createElement('button');
    extractPitchBtn.style.cssText = `
      padding: 12px 16px;
      background: linear-gradient(180deg, #5b8def, #4a7de0);
      border: none;
      border-radius: 4px;
      color: #ffffff;
      cursor: pointer;
      font-size: 14px;
      text-align: left;
      text-shadow: 0 1px 2px rgba(0,0,0,0.3);
    `;
    const extractPitchLabel = document.createElement('div');
    extractPitchLabel.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
    extractPitchLabel.textContent = t('main.audioToMidiExtractPitch');
    const extractPitchDesc = document.createElement('div');
    extractPitchDesc.style.cssText = 'font-size: 12px; opacity: 0.8;';
    extractPitchDesc.textContent = t('main.audioToMidiExtractPitchDesc');
    extractPitchBtn.appendChild(extractPitchLabel);
    extractPitchBtn.appendChild(extractPitchDesc);

    const onlyMidiBtn = document.createElement('button');
    onlyMidiBtn.style.cssText = `
      padding: 12px 16px;
      background: linear-gradient(180deg, #4ade80, #3ac870);
      border: none;
      border-radius: 4px;
      color: #ffffff;
      cursor: pointer;
      font-size: 14px;
      text-align: left;
      text-shadow: 0 1px 2px rgba(0,0,0,0.3);
    `;
    const onlyMidiLabel = document.createElement('div');
    onlyMidiLabel.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
    onlyMidiLabel.textContent = t('main.audioToMidiOnly');
    const onlyMidiDesc = document.createElement('div');
    onlyMidiDesc.style.cssText = 'font-size: 12px; opacity: 0.8;';
    onlyMidiDesc.textContent = t('main.audioToMidiOnlyDesc');
    onlyMidiBtn.appendChild(onlyMidiLabel);
    onlyMidiBtn.appendChild(onlyMidiDesc);

    btnContainer.appendChild(extractPitchBtn);
    btnContainer.appendChild(onlyMidiBtn);

    const dialog = createDialog({
      title: t('main.audioToMidiTitle'),
      contentElement: btnContainer,
      buttons: [
        {
          text: t('common.cancel'),
          type: 'default',
          onClick: () => resolve(null),
        },
      ],
      styles: {
        titleFontSize: '16px',
        buttonMarginTop: '0',
      },
    });

    extractPitchBtn.addEventListener('click', () => {
      dialog.close();
      resolve('withPitch');
    });
    onlyMidiBtn.addEventListener('click', () => {
      dialog.close();
      resolve('midiOnly');
    });
  });
}

function showLoadingOverlay(message) {
  const overlay = document.createElement('div');
  overlay.id = 'audio-to-midi-loading';
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(10,10,20,0.75);
    backdrop-filter: blur(2px);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 10001;
    color: #e0e0f0;
  `;

  const spinner = document.createElement('div');
  spinner.style.cssText = `
    width: 40px;
    height: 40px;
    border: 3px solid #3a3a52;
    border-top-color: #5b8def;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-bottom: 16px;
  `;

  const style = document.createElement('style');
  style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;

  const msgEl = document.createElement('div');
  msgEl.style.cssText = 'font-size: 14px;';
  msgEl.textContent = message;

  overlay.appendChild(style);
  overlay.appendChild(spinner);
  overlay.appendChild(msgEl);
  document.body.appendChild(overlay);

  return overlay;
}

function updateLoadingMessage(overlay, message) {
  const msgEl = overlay.querySelector('div:last-child');
  if (msgEl) msgEl.textContent = message;
}

function hideLoadingOverlay(overlay) {
  if (overlay && overlay.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
}

function f0DataToPitchCurveAnchorPoints(f0Data, bpm) {
  if (!f0Data || f0Data.length === 0) return [];

  const beatDuration = 60 / bpm;
  const anchorInterval = 0.08;
  const anchorPoints = [];

  let currentBeat = -1;
  let pitchSum = 0;
  let pitchCount = 0;

  for (const frame of f0Data) {
    if (!frame.f0 || frame.f0 <= 0) continue;

    const pitch = 69 + 12 * Math.log2(frame.f0 / 440);
    if (pitch < 24 || pitch > 108) continue;

    const beat = frame.time / beatDuration;
    const anchorBeat = Math.floor(beat / anchorInterval) * anchorInterval;

    if (anchorBeat !== currentBeat) {
      if (currentBeat >= 0 && pitchCount > 0) {
        anchorPoints.push({
          time: currentBeat,
          pitch: pitchSum / pitchCount,
          smoothness: 30,
        });
      }
      currentBeat = anchorBeat;
      pitchSum = pitch;
      pitchCount = 1;
    } else {
      pitchSum += pitch;
      pitchCount += 1;
    }
  }

  if (currentBeat >= 0 && pitchCount > 0) {
    anchorPoints.push({
      time: currentBeat,
      pitch: pitchSum / pitchCount,
      smoothness: 30,
    });
  }

  return anchorPoints;
}

async function handleAudioToMidi() {
  const choice = await showAudioToMidiDialog();
  if (!choice) return;

  const extractPitch = choice === 'withPitch';

  try {
    const result = await window.electronAPI.showOpenDialog({
      title: t('main.audioToMidiSelectFile'),
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

    let audioBuffer;
    const ac = new AudioContext();
    try {
      audioBuffer = await ac.decodeAudioData(buffer.slice(0));
    } catch (decodeErr) {
      console.error('Audio decode failed:', decodeErr);
      showAlertDialog(t('main.audioToMidiDecodeFailed') + ': ' + decodeErr.message);
      return;
    } finally {
      ac.close();
    }

    const channelData = audioBuffer.getChannelData(0);
    const audioData = Array.from(channelData);
    const sampleRate = audioBuffer.sampleRate;
    const bpm = project.bpm || 120;

    const loading = showLoadingOverlay(t('main.audioToMidiExtracting'));

    let midiNotes = [];
    let f0Data = null;

    try {
      const settings = await window.electronAPI.getSettings();
      const midiTool = (settings?.midiExtractTool === 'rosvot' ? 'rmvpe' : settings?.midiExtractTool) || 'basicpitch';

      if (midiTool === 'rmvpe') {
        // RMVPE: 使用 RMVPE 提取 F0 + f0ToNotes 转 MIDI
        const rmvpeResult = await window.electronAPI.extractMidiRosvot({
          audioData,
          sampleRate,
          bpm,
        });

        if (!rmvpeResult.success) {
          throw new Error(rmvpeResult.error || 'RMVPE failed');
        }

        midiNotes = (rmvpeResult.notes || []).map((n, i) => ({
          id: n.id ?? (Date.now() + i),
          pitch: n.pitch ?? 60,
          start: n.start ?? 0,
          duration: n.duration ?? 0.25,
          lyric: n.lyric || 'la',
        }));

        if (extractPitch) {
          f0Data = rmvpeResult.f0Array;
        }
      } else {
        // Basic Pitch: 直接提取 MIDI + F0
        const bpResult = await window.electronAPI.extractF0BasicPitch({
          audioData,
          sampleRate,
          bpm,
        });

        if (!bpResult.success) {
          throw new Error(bpResult.error || 'Basic Pitch failed');
        }

        midiNotes = (bpResult.notes || []).map((n, i) => ({
          id: n.id ?? (Date.now() + i),
          pitch: n.pitch ?? 60,
          start: n.start ?? 0,
          duration: n.duration ?? 0.25,
          lyric: n.lyric || 'la',
        }));

        if (extractPitch) {
          updateLoadingMessage(loading, t('main.audioToMidiExtractingF0'));

          const rmvpeResult = await window.electronAPI.extractF0({
            audioData,
            sampleRate,
          });

          if (!rmvpeResult.success) {
            throw new Error(rmvpeResult.error || 'RMVPE failed');
          }

          f0Data = rmvpeResult.f0Array;
        }
      }
    } catch (err) {
      hideLoadingOverlay(loading);
      console.error('Audio to MIDI failed:', err);
      showAlertDialog(t('main.audioToMidiFailed') + ': ' + err.message);
      return;
    }

    hideLoadingOverlay(loading);

    if (midiNotes.length === 0) {
      showAlertDialog(t('main.audioToMidiFailed') + ': no notes extracted');
      return;
    }

    const lastNote = midiNotes[midiNotes.length - 1];
    const totalBeats = lastNote.start + lastNote.duration;
    const duration = Math.max(4, Math.ceil(totalBeats));

    const singer = trackManager.addSinger({
      trackName: t('main.audioToMidiTitle'),
      singerName: t('main.audioToMidiTitle'),
      singerFileMissing: true,
    });

    const fragment = trackManager.addFragment({
      singerId: singer.id,
      startTime: 0,
      duration,
      notes: midiNotes,
    });

    if (f0Data && f0Data.length > 0) {
      const anchorPoints = f0DataToPitchCurveAnchorPoints(f0Data, bpm);
      if (anchorPoints.length > 0) {
        fragment.pitchCurve = {
          enabled: true,
          anchorPoints,
          brushSegments: [],
        };
      }
    }

    selectedSingerId = singer.id;
    refreshAll();

    showAlertDialog(t('main.audioToMidiComplete'));
  } catch (err) {
    console.error('Audio to MIDI process error:', err);
    showAlertDialog(t('main.audioToMidiFailed') + ': ' + err.message);
  }
}

btnAudioToMidi.addEventListener('click', handleAudioToMidi);

window.addEventListener('beforeunload', () => {
  for (const cleanup of _ipcCleanups) {
    try { cleanup(); } catch (_) {}
  }
  _ipcCleanups.length = 0;
});

console.log('SXSEditor renderer started');

// ==================== WebNN 渲染进程监听器 ====================
// 处理来自主进程的 WebNN 请求（NPU 检测、Model加载/卸载/推理）
(async () => {
  let webnnPipeline = null;

  async function getWebnnPipeline() {
    if (webnnPipeline) return webnnPipeline;
    try {
      const mod = await import('./inference/webnn/index.js');
      webnnPipeline = mod;
      return webnnPipeline;
    } catch (e) {
      console.error('[Renderer] Failed to load webnnPipeline:', e);
      return null;
    }
  }

  const api = window.electronAPI;
  if (!api) return;

  // 监听 NPU 检测请求
  api.onWebnnDetectNPURequest(async ({ requestId }) => {
    const pipeline = await getWebnnPipeline();
    let result;
    if (pipeline) {
      try {
        result = await pipeline.detectNPU();
      } catch (e) {
        result = { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: e.message };
      }
    } else {
      result = { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'webnnPipeline module not available' };
    }
    api.webnnRespond(`webnn:detectNPU:response:${requestId}`, result);
  });

  // 监听Model加载请求
  api.onWebnnLoadModelRequest(async ({ requestId, modelId, modelPath, options }) => {
    console.log(`[Renderer] WebNN load request: ${modelId} (${modelPath})`);
    let result;
    try {
      const pipeline = await getWebnnPipeline();
      if (!pipeline) {
        result = { success: false, error: 'webnnPipeline module not available' };
      } else {
        // Model file is read as ArrayBuffer via IPC inside loadModel
        result = await pipeline.loadModel(modelId, modelPath, options);
      }
    } catch (e) {
      console.error(`[Renderer] WebNN load error: ${e.message}`);
      result = { success: false, error: e.message };
    }
    console.log(`[Renderer] WebNN load result for ${modelId}:`, JSON.stringify(result));
    api.webnnRespond(`webnn:loadModel:response:${requestId}`, result);
  });

  // 监听Model卸载请求
  api.onWebnnUnloadModelRequest(async ({ requestId, modelId }) => {
    const pipeline = await getWebnnPipeline();
    let result;
    if (pipeline) {
      try {
        await pipeline.unloadModel(modelId);
        result = { success: true };
      } catch (e) {
        result = { success: false, error: e.message };
      }
    } else {
      result = { success: false, error: 'webnnPipeline module not available' };
    }
    api.webnnRespond(`webnn:unloadModel:response:${requestId}`, result);
  });

  // 监听推理请求
  api.onWebnnRunInferenceRequest(async ({ requestId, modelId, inputs }) => {
    const pipeline = await getWebnnPipeline();
    let result;
    if (pipeline) {
      try {
        result = await pipeline.runInference(modelId, inputs);
      } catch (e) {
        result = { error: e.message };
      }
    } else {
      result = { error: 'webnnPipeline module not available' };
    }
    api.webnnRespond(`webnn:runInference:response:${requestId}`, result);
  });

  // 监听状态查询请求
  api.onWebnnGetStatusRequest(async ({ requestId }) => {
    const pipeline = await getWebnnPipeline();
    let result;
    if (pipeline) {
      result = pipeline.getStatus();
    } else {
      result = {};
    }
    api.webnnRespond(`webnn:getStatus:response:${requestId}`, result);
  });

  // 监听完整合成管线请求（在渲染进程本地运行，消除逐次 IPC 开销）
  api.onWebnnRunSynthesisRequest(async ({ requestId, params }) => {
    const pipeline = await getWebnnPipeline();
    let result;
    if (pipeline) {
      try {
        // Array params = batch synthesis (2 segments, batch=4)
        if (Array.isArray(params)) {
          result = await pipeline.runSynthesisBatch(params);
        } else {
          result = await pipeline.runSynthesis(params);
        }
      } catch (e) {
        result = { error: e.message };
      }
    } else {
      result = { error: 'webnnPipeline module not available' };
    }
    api.webnnRespond(`webnn:runSynthesis:response:${requestId}`, result);
  });
})();
