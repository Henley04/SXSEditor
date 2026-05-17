import './index.css';
import { TrackManager } from './editor/trackManager.js';
import { encodeWav } from './audio/wavEncoder.js';
import { HistoryManager } from './editor/historyManager.js';

const trackManager = new TrackManager();
const history = new HistoryManager();

const SAMPLE_RATE = 24000;
const SVS_HOP_SIZE = 480;
let pipelineInitialized = false;
let pipelineInitPromise = null;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

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
const btnSave = document.getElementById('btn-save');
const btnLoad = document.getElementById('btn-load');
const btnExport = document.getElementById('btn-export');
const btnAddSinger = document.getElementById('btn-add-singer');
const singerListEl = document.getElementById('singer-list');

const fragmentCanvas = document.getElementById('fragment-canvas');
const fragmentContainer = document.getElementById('fragment-canvas-container');
const btnFragmentZoomIn = document.getElementById('btn-fragment-zoom-in');
const btnFragmentZoomOut = document.getElementById('btn-fragment-zoom-out');
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

function showPromptDialog(title, defaultValue, onConfirm) {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `;

  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 8px;
    padding: 20px;
    min-width: 280px;
    color: #fff;
  `;

  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'margin-bottom: 12px; font-weight: 600;';
  titleEl.textContent = title;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = defaultValue || '';
  input.style.cssText = `
    width: 100%;
    padding: 8px;
    background: #1e1e1e;
    border: 1px solid #555;
    border-radius: 4px;
    color: #fff;
    margin-bottom: 12px;
    box-sizing: border-box;
  `;

  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = `
    padding: 6px 16px;
    background: #3c3c3c;
    border: 1px solid #555;
    border-radius: 4px;
    color: #fff;
    cursor: pointer;
  `;

  const okBtn = document.createElement('button');
  okBtn.textContent = '确定';
  okBtn.style.cssText = `
    padding: 6px 16px;
    background: #3498db;
    border: none;
    border-radius: 4px;
    color: #fff;
    cursor: pointer;
  `;

  btnContainer.appendChild(cancelBtn);
  btnContainer.appendChild(okBtn);
  dialog.appendChild(titleEl);
  dialog.appendChild(input);
  dialog.appendChild(btnContainer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const controller = new AbortController();
  const close = (value) => {
    controller.abort();
    document.body.removeChild(overlay);
    if (value !== null) {
      onConfirm(value);
    }
  };

  cancelBtn.addEventListener('click', () => close(null), { signal: controller.signal });
  okBtn.addEventListener('click', () => close(input.value), { signal: controller.signal });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') close(input.value);
    if (e.key === 'Escape') close(null);
  }, { signal: controller.signal });

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function showSingerSelectDialog(singerId) {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `;

  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 8px;
    padding: 20px;
    min-width: 320px;
    color: #fff;
  `;

  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'margin-bottom: 16px; font-weight: 600;';
  titleEl.textContent = '选择歌手';

  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = 'display: flex; flex-direction: column; gap: 10px;';

  const createBtn = document.createElement('button');
  createBtn.textContent = '打开歌手创建页面';
  createBtn.style.cssText = `
    padding: 10px 16px;
    background: #3498db;
    border: none;
    border-radius: 4px;
    color: #fff;
    cursor: pointer;
    font-size: 14px;
  `;

  const openBtn = document.createElement('button');
  openBtn.textContent = '打开已有歌手文件';
  openBtn.style.cssText = `
    padding: 10px 16px;
    background: #2ecc71;
    border: none;
    border-radius: 4px;
    color: #fff;
    cursor: pointer;
    font-size: 14px;
  `;

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = `
    padding: 10px 16px;
    background: #3c3c3c;
    border: 1px solid #555;
    border-radius: 4px;
    color: #fff;
    cursor: pointer;
    font-size: 14px;
  `;

  btnContainer.appendChild(titleEl);
  btnContainer.appendChild(createBtn);
  btnContainer.appendChild(openBtn);
  btnContainer.appendChild(cancelBtn);
  dialog.appendChild(btnContainer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const close = () => {
    document.body.removeChild(overlay);
  };

  createBtn.addEventListener('click', () => {
    close();
    if (window.electronAPI?.openSingerCreator) {
      window.electronAPI.openSingerCreator();
    } else {
      alert('歌手创建页面待实现');
    }
  });

  openBtn.addEventListener('click', async () => {
    close();
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
        console.error('加载歌手文件失败', err);
      }
    }
  });

  cancelBtn.addEventListener('click', close);
}

const SXSSINGER_CURRENT_VERSION = '1.0.0';

function validateSingerData(singerData) {
  const errors = [];
  const warnings = [];

  if (!singerData || typeof singerData !== 'object') {
    errors.push('文件内容不是有效的JSON对象');
    return { valid: false, errors, warnings };
  }

  if (singerData.formatVersion) {
    const parts = singerData.formatVersion.split('.').map(Number);
    const currentParts = SXSSINGER_CURRENT_VERSION.split('.').map(Number);
    if (parts[0] > currentParts[0]) {
      errors.push(`歌手文件版本(${singerData.formatVersion})高于当前支持的版本(${SXSSINGER_CURRENT_VERSION})，请升级SXSEditor`);
    } else if (parts[0] < currentParts[0]) {
      warnings.push(`歌手文件版本(${singerData.formatVersion})低于当前版本(${SXSSINGER_CURRENT_VERSION})，将尝试向前兼容加载`);
    } else if (parts[1] > currentParts[1]) {
      warnings.push(`歌手文件次版本号(${singerData.formatVersion})高于当前版本(${SXSSINGER_CURRENT_VERSION})，部分功能可能不可用`);
    }
  } else {
    warnings.push('歌手文件缺少版本信息(formatVersion)，将按旧格式加载');
  }

  if (!singerData.singerName || typeof singerData.singerName !== 'string') {
    errors.push('缺少歌手名称(singerName)或格式不正确');
  } else if (singerData.singerName.trim().length === 0) {
    errors.push('歌手名称(singerName)不能为空');
  }

  if (singerData.color !== undefined && singerData.color !== null) {
    if (typeof singerData.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(singerData.color)) {
      warnings.push('颜色(color)格式不正确，将使用默认颜色');
    }
  }

  if (!singerData.wavBase64 || typeof singerData.wavBase64 !== 'string') {
    errors.push('缺少参考音频数据(wavBase64)或格式不正确');
  } else if (singerData.wavBase64.length === 0) {
    errors.push('参考音频数据(wavBase64)为空');
  }

  if (singerData.midiNotes !== undefined && singerData.midiNotes !== null) {
    if (!Array.isArray(singerData.midiNotes)) {
      warnings.push('MIDI音符数据(midiNotes)格式不正确，将被忽略');
    }
  }

  if (singerData.f0Data !== undefined && singerData.f0Data !== null) {
    if (!Array.isArray(singerData.f0Data)) {
      warnings.push('F0数据(f0Data)格式不正确，将被忽略');
    }
  }

  if (singerData.singerData !== undefined && singerData.singerData !== null) {
    if (typeof singerData.singerData !== 'object') {
      warnings.push('歌手推理数据(singerData)格式不正确，将被忽略');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function showSingerValidationReport(validation) {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `;

  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: #2d2d2d;
    border: 1px solid ${validation.valid ? '#f39c12' : '#e74c3c'};
    border-radius: 8px;
    padding: 20px;
    min-width: 360px;
    max-width: 500px;
    max-height: 80vh;
    overflow-y: auto;
    color: #fff;
  `;

  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'margin-bottom: 12px; font-weight: 600; font-size: 14px;';
  titleEl.textContent = validation.valid ? '歌手文件加载警告' : '歌手文件格式错误';
  titleEl.style.color = validation.valid ? '#f39c12' : '#e74c3c';

  dialog.appendChild(titleEl);

  if (validation.errors.length > 0) {
    const errSection = document.createElement('div');
    errSection.style.cssText = 'margin-bottom: 10px;';
    const errTitle = document.createElement('div');
    errTitle.style.cssText = 'color: #e74c3c; font-weight: 600; margin-bottom: 4px; font-size: 12px;';
    errTitle.textContent = '错误:';
    errSection.appendChild(errTitle);
    validation.errors.forEach(msg => {
      const item = document.createElement('div');
      item.style.cssText = 'color: #e74c3c; font-size: 11px; padding-left: 8px; margin-bottom: 2px;';
      item.textContent = `• ${msg}`;
      errSection.appendChild(item);
    });
    dialog.appendChild(errSection);
  }

  if (validation.warnings.length > 0) {
    const warnSection = document.createElement('div');
    warnSection.style.cssText = 'margin-bottom: 10px;';
    const warnTitle = document.createElement('div');
    warnTitle.style.cssText = 'color: #f39c12; font-weight: 600; margin-bottom: 4px; font-size: 12px;';
    warnTitle.textContent = '警告:';
    warnSection.appendChild(warnTitle);
    validation.warnings.forEach(msg => {
      const item = document.createElement('div');
      item.style.cssText = 'color: #f39c12; font-size: 11px; padding-left: 8px; margin-bottom: 2px;';
      item.textContent = `• ${msg}`;
      warnSection.appendChild(item);
    });
    dialog.appendChild(warnSection);
  }

  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;';

  const okBtn = document.createElement('button');
  okBtn.textContent = '确定';
  okBtn.style.cssText = `
    padding: 6px 16px;
    background: ${validation.valid ? '#3498db' : '#e74c3c'};
    border: none;
    border-radius: 4px;
    color: #fff;
    cursor: pointer;
  `;

  btnContainer.appendChild(okBtn);
  dialog.appendChild(btnContainer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  return new Promise((resolve) => {
    const close = () => {
      document.body.removeChild(overlay);
      resolve();
    };
    okBtn.addEventListener('click', close);
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
      console.error('解析 wavBase64 失败:', e);
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
      errors: ['歌手文件JSON解析失败，文件可能已损坏'],
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
      errors: ['歌手文件JSON解析失败，文件可能已损坏'],
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
      trackName: singerData.singerName || '未命名歌手',
      singerName: singerData.singerName || '未命名歌手',
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
  project.bpm = Math.max(1, Math.min(999, bpm));
  project.timeSignature = [num, den];
}

bpmInput.addEventListener('change', updateProjectSettings);
timeSigNum.addEventListener('change', updateProjectSettings);
timeSigDen.addEventListener('change', updateProjectSettings);

btnPlay.addEventListener('click', async () => {
  const fragments = trackManager.getFragments();
  if (fragments.length === 0) {
    alert('当前没有分片，无法播放');
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

  for (let i = 0; i < totalFrames; i++) {
    const frameTimeSec = (i * SVS_HOP_SIZE) / SAMPLE_RATE;
    const frameBeat = (frameTimeSec / 60) * bpm;
    let pitch = null;

    for (const frag of pitchCurveFrags) {
      const pc = frag.pitchCurve;
      const localBeat = frameBeat - frag.startTime;

      if (pitch === null && pc.anchorPoints.length > 0) {
        const sorted = sortedAnchorsCache.get(frag.id);
        if (localBeat <= sorted[0].time) pitch = sorted[0].pitch;
        else if (localBeat >= sorted[sorted.length - 1].time) pitch = sorted[sorted.length - 1].pitch;
        else {
          for (let j = 0; j < sorted.length - 1; j++) {
            if (localBeat >= sorted[j].time && localBeat <= sorted[j + 1].time) {
              const t = (sorted[j + 1].time - sorted[j].time) > 0
                ? (localBeat - sorted[j].time) / (sorted[j + 1].time - sorted[j].time) : 0;
              const sm = (sorted[j].smoothness || 0) / 100;
              const st = sm > 0 ? t * t * (3 - 2 * t) : t;
              pitch = sorted[j].pitch + st * (sorted[j + 1].pitch - sorted[j].pitch);
              break;
            }
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
      for (const note of allNotes) {
        if (frameBeat >= note.start && frameBeat < note.start + note.duration) {
          pitch = note.pitch;
          break;
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
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        wavBase64 = btoa(binary);
      } catch (e) {
        console.error('编码wavBuffer失败:', e);
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
  } finally {
    pipelineInitPromise = null;
  }
}

async function playAll() {
  isSynthesizing = true;
  btnPlay.disabled = true;
  btnPlay.textContent = '合成中...';

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
      alert('当前没有分片，无法播放');
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
          const convertedNotes = fragment.notes.map(note => ({
            lyric: note.lyric || '',
            pitch: note.pitch,
            start: note.start + fragment.startTime,
            duration: note.duration,
          }));
          singerNotes.push(...convertedNotes);

          const fragmentEnd = fragment.startTime + fragment.duration;
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
      alert('当前没有音符，无法播放');
      return;
    }

    await ensurePipelineInitialized();

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
      timeDisplay.textContent = `合成中: ${formatTime(currentSeconds)} / ${formatTime(totalSeconds)}`;
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
    console.error('合成失败:', error);
    alert(`合成失败: ${error.message}`);
    timeDisplay.textContent = formatTime(0);
  } finally {
    isSynthesizing = false;
    btnPlay.textContent = '播放';
    btnPlay.disabled = false;
  }
}

function getAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    if (audioContext.sampleRate !== SAMPLE_RATE) {
      console.warn(`[Audio] AudioContext实际采样率: ${audioContext.sampleRate}Hz, 期望: ${SAMPLE_RATE}Hz, 将自动重采样`);
    }
    gainNode = audioContext.createGain();
    gainNode.connect(audioContext.destination);
    applyAudioSettings();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(err => {
      console.warn('[Audio] AudioContext resume 失败:', err);
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

function applyAudioSettings() {
  if (!audioSettings) return;

  if (gainNode && audioSettings.audioVolume !== undefined) {
    gainNode.gain.value = audioSettings.audioVolume;
  }

  if (audioContext && audioSettings.audioOutputDevice !== undefined && audioSettings.audioOutputDevice !== -1) {
    const sinkId = String(audioSettings.audioOutputDevice);
    if (audioContext.setSinkId && typeof audioContext.setSinkId === 'function') {
      audioContext.setSinkId(sinkId).catch(err => {
        console.warn('[Audio] 设置输出设备失败:', err.message);
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

    const result = await window.electronAPI.audioPlay(Array.from(currentAudioData), options);

    if (!result.success) {
      console.warn('[Audio] WASAPI 独占模式失败，回退到共享模式:', result.error);
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
    console.error('[Audio] 独占模式启动失败，回退到共享模式:', err);
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
      if (removeEndedListener) removeEndedListener();
      return;
    }

    timeDisplay.textContent = formatTime(elapsed);
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
    console.warn('[Audio] 停止独占播放失败:', err);
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
    timeDisplay.textContent = `已暂停: ${formatTime(elapsed)}`;
  } else {
    if (!currentAudioSource) return;
    const context = getAudioContext();
    const elapsed = context.currentTime - playbackStartTime;
    playbackPauseOffset = elapsed;
    stopAudioSource();
    isPlaying = false;
    stopPlayheadAnimation();
    timeDisplay.textContent = `已暂停: ${formatTime(elapsed)}`;
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
        return;
      }
    }

    timeDisplay.textContent = formatTime(elapsed);
    playheadRaf = requestAnimationFrame(updatePlayhead);
  }

  playheadRaf = requestAnimationFrame(updatePlayhead);
}

function stopPlayheadAnimation() {
  if (playheadRaf) {
    cancelAnimationFrame(playheadRaf);
    playheadRaf = null;
  }
}

function showSaveProjectOptionsDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #2d2d2d;
      border: 1px solid #555;
      border-radius: 8px;
      padding: 20px;
      min-width: 360px;
      color: #fff;
    `;

    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'margin-bottom: 16px; font-weight: 600; font-size: 14px;';
    titleEl.textContent = '保存项目选项';

    const optionsContainer = document.createElement('div');
    optionsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px;';

    const embedOption = document.createElement('label');
    embedOption.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-size: 13px;
      color: #cccccc;
    `;
    const embedCheckbox = document.createElement('input');
    embedCheckbox.type = 'checkbox';
    embedCheckbox.id = 'save-option-embed-singer';
    embedCheckbox.checked = false;
    const embedLabel = document.createElement('span');
    embedLabel.textContent = '嵌入歌手文件到项目文件中';
    const embedDesc = document.createElement('div');
    embedDesc.style.cssText = 'font-size: 11px; color: #888888; margin-top: 2px; padding-left: 24px;';
    embedDesc.textContent = '将歌手的参考音频和预处理数据嵌入项目文件，使项目文件可独立移动，但文件体积会增大';
    embedOption.appendChild(embedCheckbox);
    embedOption.appendChild(embedLabel);
    optionsContainer.appendChild(embedOption);
    optionsContainer.appendChild(embedDesc);

    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = `
      padding: 6px 16px;
      background: #3c3c3c;
      border: 1px solid #555;
      border-radius: 4px;
      color: #fff;
      cursor: pointer;
    `;

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '保存';
    saveBtn.style.cssText = `
      padding: 6px 16px;
      background: #3498db;
      border: none;
      border-radius: 4px;
      color: #fff;
      cursor: pointer;
    `;

    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(saveBtn);
    dialog.appendChild(titleEl);
    dialog.appendChild(optionsContainer);
    dialog.appendChild(btnContainer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = (result) => {
      document.body.removeChild(overlay);
      resolve(result);
    };

    cancelBtn.addEventListener('click', () => close(null));
    saveBtn.addEventListener('click', () => close({
      embedSingerFiles: embedCheckbox.checked,
    }));
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
        console.log('项目已保存到', result.filePath);
      }
    } catch (err) {
      console.error('保存失败', err);
    }
  } else {
    console.log('保存功能待实现（需要 electronAPI）');
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
            alert(`项目文件版本(${obj.version})过高，请升级SXSEditor`);
            return;
          }
          if (projVersion[0] < currentVersion[0] || projVersion[1] < currentVersion[1]) {
            console.warn(`项目文件版本(${obj.version})较低，将尝试兼容加载`);
          }
        }
        if (obj.project) {
          project.bpm = obj.project.bpm ?? 120;
          project.timeSignature = obj.project.timeSignature ?? [4, 4];
          bpmInput.value = project.bpm;
          timeSigNum.value = project.timeSignature[0];
          timeSigDen.value = project.timeSignature[1];
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
                    console.warn('歌手文件加载警告:', validation.warnings);
                  }
                  if (validation.valid) {
                    applySingerDataToSinger(singer, singerData);
                    if (singerData.wavDuration) {
                      singer.wavDuration = singerData.wavDuration;
                    }
                    singer.singerFileMissing = false;
                  }
                } catch (err) {
                  console.error('加载歌手文件失败:', err);
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
        refreshAll();
        console.log('项目已加载', result.filePaths[0]);
      }
    } catch (err) {
      console.error('加载失败', err);
      alert('项目加载失败: ' + (err.message || '未知错误'));
    }
  } else {
    console.log('加载功能待实现（需要 electronAPI）');
  }
});

btnExport.addEventListener('click', async () => {
  const fragments = trackManager.getFragments();
  if (fragments.length === 0) {
    alert('当前没有分片，无法导出');
    return;
  }

  const originalText = btnExport.textContent;
  btnExport.disabled = true;
  btnExport.textContent = '导出中...';
  timeDisplay.textContent = '准备中...';

  try {
    const singers = trackManager.getSingers();
    const allNotesBySinger = {};

    for (const singer of singers) {
      const singerFragments = fragments.filter(f => f.singerId === singer.id);
      if (singerFragments.length === 0) continue;

      const notes = [];
      for (const fragment of singerFragments) {
        if (fragment.notes && fragment.notes.length > 0) {
          for (const note of fragment.notes) {
            notes.push({
              start: note.start + fragment.startTime,
              duration: note.duration,
              pitch: note.pitch,
              lyric: note.lyric,
            });
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
      alert('当前分片没有音符，无法导出');
      return;
    }

    await ensurePipelineInitialized();

    let audioResults = [];
    let maxDuration = 0;

    for (const singerId of singerIds) {
      const { notes, singer } = allNotesBySinger[singerId];

      const refAudioWavBuffer = singer.wavBuffer || null;

      const singerFragments2 = fragments.filter(f => f.singerId === parseInt(singerId));
      const exportPitchCurveF0 = computePitchCurveF0(singerFragments2, notes, project.bpm);

      let finalPitchCurveF0 = exportPitchCurveF0;
      if (!finalPitchCurveF0 && singer.f0Data && singer.f0Data.length > 0) {
        const exportTotalBeats = notes.reduce((max, note) => Math.max(max, note.start + note.duration), 0);
        const totalSecondsExport = (exportTotalBeats / project.bpm) * 60;
        const converted = convertF0DataToPitchCurve(singer.f0Data, totalSecondsExport);
        if (converted) {
          finalPitchCurveF0 = Array.from(converted);
        }
      }

      const audioData = await window.electronAPI.synthesizeSVS({
        notes,
        bpm: project.bpm,
        options: { refAudioWavBuffer, pitchCurveF0: finalPitchCurveF0 },
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

    timeDisplay.textContent = '编码WAV...';

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

    const wavData = encodeWav(mixedAudio, SAMPLE_RATE);

    timeDisplay.textContent = '保存文件...';

    const result = await window.electronAPI.showSaveDialog({
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    });

    if (!result.canceled && result.filePath) {
      await window.electronAPI.saveFile(result.filePath, wavData);
      timeDisplay.textContent = formatTime(maxDuration);
    }

  } catch (err) {
    console.error('导出失败', err);
    alert(`导出失败: ${err.message || '未知错误'}`);
    timeDisplay.textContent = '导出失败';
  } finally {
    btnExport.disabled = false;
    btnExport.textContent = originalText;
  }
});

btnAddSinger.addEventListener('click', () => {
  showSingerSelectDialog(null);
});

if (window.electronAPI?.onSingerCreated) {
  window.electronAPI.onSingerCreated((singerData) => {
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
    refreshAll();
  });
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
  }
}

function renderSingerList() {
  singerListEl.innerHTML = '';
  const singers = trackManager.getSingers();

  const spacer = document.createElement('div');
  spacer.className = 'singer-row-spacer';
  singerListEl.appendChild(spacer);

  if (singers.length === 0) {
    const emptyItem = document.createElement('div');
    emptyItem.className = 'singer-item-empty';
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
    textDiv.textContent = '点击添加歌手';
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
    item.dataset.singerId = singer.id;

    const isEditingTrackName = editingTrackNameId === singer.id;

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'singer-avatar';
    if (singer.avatarPath) {
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
        background: #1e1e1e;
        color: #ffffff;
        border: 1px solid #3498db;
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
        warningDiv.textContent = '⚠ 歌手文件未找到';
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
        warningDiv.textContent = '⚠ 歌手文件未找到';
        infoDiv.appendChild(warningDiv);

        const relocateBtn = document.createElement('button');
        relocateBtn.className = 'btn-relocate-singer';
        relocateBtn.textContent = '重新选定';
        relocateBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const result = await window.electronAPI.showOpenDialog({
              title: '重新选定歌手文件',
              filters: [{ name: 'SXS Singer', extensions: ['sxssinger'] }],
              properties: ['openFile'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              const filePath = result.filePaths[0];
              const buffer = await window.electronAPI.readFileBuffer(filePath);
              await loadSingerFile(singer.id, buffer, filePath);
            }
          } catch (err) {
            console.error('重新选定歌手文件失败:', err);
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
    addBtn.title = '添加分片';
    addBtn.dataset.singerId = singer.id;
    addBtn.textContent = '+';
    actionsDiv.appendChild(addBtn);

    if (singers.length > 1) {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-singer-delete';
      delBtn.title = '删除歌手';
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
      const singerId = parseInt(addBtn.dataset.singerId);
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
          const color = singer ? singer.color : '#3498db';
          const frag = trackManager.addFragment({ singerId, startTime, duration: 4, color });
          renderFragmentTimeline();
        }
      });
      renderFragmentTimeline();
    });

    if (singers.length > 1) {
      const delBtn = item.querySelector('.btn-singer-delete');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const singerId = parseInt(delBtn.dataset.singerId);
          if (confirm(`确定删除歌手"${singer.trackName}"？`)) {
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

let isSyncingScroll = false;

fragmentContainer.addEventListener('scroll', () => {
  if (isSyncingScroll) return;
  isSyncingScroll = true;
  singerListEl.scrollTop = fragmentContainer.scrollTop;
  requestAnimationFrame(() => { isSyncingScroll = false; });
});

singerListEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  fragmentContainer.scrollTop += e.deltaY;
}, { passive: false });

function renderFragmentTimeline() {
  const ctx = fragmentCanvas.getContext('2d');
  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();

  const beatWidth = FRAGMENT_BASE_BEAT_WIDTH * fragmentZoomX;
  const maxBeat = fragments.reduce((max, f) => Math.max(max, f.startTime + f.duration), 0);
  const totalBeats = Math.max(64, Math.ceil((maxBeat + 16) / 16) * 16);
  const canvasWidth = totalBeats * beatWidth;
  const canvasHeight = singers.length * SINGER_ROW_HEIGHT + HEADER_HEIGHT;

  fragmentCanvas.width = canvasWidth;
  fragmentCanvas.height = canvasHeight;
  const newWidth = canvasWidth + 'px';
  const newHeight = canvasHeight + 'px';
  if (fragmentContainer.style.width !== newWidth) fragmentContainer.style.width = newWidth;
  if (fragmentContainer.style.height !== newHeight) fragmentContainer.style.height = newHeight;

  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 1;
  for (let i = 0; i <= totalBeats; i++) {
    const x = i * beatWidth;
    ctx.beginPath();
    ctx.moveTo(x, HEADER_HEIGHT);
    ctx.lineTo(x, canvasHeight);
    ctx.stroke();

    if (i % 4 === 0) {
      ctx.fillStyle = '#666666';
      ctx.font = '10px sans-serif';
      ctx.fillText(`第${i + 1}拍`, x + 2, HEADER_HEIGHT - 4);
    }
  }

  singers.forEach((singer, index) => {
    const y = index * SINGER_ROW_HEIGHT + HEADER_HEIGHT;

    ctx.fillStyle = '#2d2d2d';
    ctx.fillRect(0, y, canvasWidth, SINGER_ROW_HEIGHT - 2);

    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + SINGER_ROW_HEIGHT - 2);
    ctx.lineTo(canvasWidth, y + SINGER_ROW_HEIGHT - 2);
    ctx.stroke();

    const singerFragments = fragments.filter(f => f.singerId === singer.id);
    singerFragments.forEach(fragment => {
      const fragX = fragment.startTime * beatWidth;
      const fragWidth = fragment.duration * beatWidth;

      ctx.fillStyle = fragment.color + 'cc';
      ctx.fillRect(fragX, y + 4, fragWidth, FRAGMENT_HEIGHT);

      ctx.strokeStyle = fragment.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(fragX, y + 4, fragWidth, FRAGMENT_HEIGHT);

      ctx.fillStyle = '#ffffff';
      ctx.font = '11px sans-serif';
      ctx.fillText(fragment.name || '新分片', fragX + 4, y + 20);

      ctx.fillStyle = '#cccccc';
      ctx.font = '10px sans-serif';
      ctx.fillText(`${fragment.startTime}-${fragment.startTime + fragment.duration}拍`, fragX + 4, y + 36);

      ctx.save();
      ctx.strokeStyle = '#ffffff44';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(fragX - 2, y + 4, 4, FRAGMENT_HEIGHT);
      ctx.strokeRect(fragX + fragWidth - 2, y + 4, 4, FRAGMENT_HEIGHT);
      ctx.restore();
    });

    if (singerFragments.length === 0) {
      ctx.fillStyle = '#444444';
      ctx.font = '11px sans-serif';
      ctx.fillText('点击 + 添加分片', 8, y + 30);
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
  const beatWidth = FRAGMENT_BASE_BEAT_WIDTH * fragmentZoomX;

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
          dragState = { type: 'move', fragment, startX: x, originalStart: fragment.startTime };
          fragmentDragSnapshot = { startTime: fragment.startTime, duration: fragment.duration };
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
  const beatWidth = FRAGMENT_BASE_BEAT_WIDTH * fragmentZoomX;
  const dx = (x - dragState.startX) / beatWidth;

  if (dragState.type === 'move') {
    const newStart = Math.max(0, dragState.originalStart + dx);
    trackManager.updateFragment(dragState.fragment.id, { startTime: Math.round(newStart * 4) / 4 });
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
    const newStart = fragment.startTime;
    const newDuration = fragment.duration;
    const fragmentId = fragment.id;

    if (oldStart !== newStart || oldDuration !== newDuration) {
      history.push({
        undo() {
          const f = trackManager.getFragment(fragmentId);
          if (f) {
            f.startTime = oldStart;
            f.duration = oldDuration;
          }
          renderFragmentTimeline();
        },
        redo() {
          const f = trackManager.getFragment(fragmentId);
          if (f) {
            f.startTime = newStart;
            f.duration = newDuration;
          }
          renderFragmentTimeline();
        }
      });
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
  const beatWidth = FRAGMENT_BASE_BEAT_WIDTH * fragmentZoomX;

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
    alert('分片编辑窗口功能待实现');
  }
}

if (window.electronAPI?.onFragmentSaved) {
  window.electronAPI.onFragmentSaved((data) => {
    const { fragmentId, notes, envelopes, pitchCurve } = data;
    const fragment = trackManager.getFragments().find(f => f.id === fragmentId);
    if (fragment) {
      if (notes) fragment.notes = notes;
      if (envelopes) fragment.envelopes = envelopes;
      if (pitchCurve) fragment.pitchCurve = pitchCurve;
    }
    refreshAll();
    autoSaveProject();
  });
}

btnFragmentZoomIn.addEventListener('click', () => {
  fragmentZoomX = Math.min(4, fragmentZoomX * 1.25);
  renderFragmentTimeline();
});

btnFragmentZoomOut.addEventListener('click', () => {
  fragmentZoomX = Math.max(0.25, fragmentZoomX / 1.25);
  renderFragmentTimeline();
});

function refreshAll() {
  renderSingerList();
  renderFragmentTimeline();
}

async function autoSaveProject() {
  if (!currentProjectFilePath) return;
  try {
    const data = serializeProject(false);
    await window.electronAPI.saveFile(currentProjectFilePath, data);
    console.log('项目已自动保存到', currentProjectFilePath);
  } catch (err) {
    console.error('自动保存失败', err);
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

console.log('SXSEditor 渲染进程已启动');
