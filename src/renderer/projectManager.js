import { state, dom, trackManager, history } from './state.js';
import { SXSSINGER_CURRENT_VERSION, SAMPLE_RATE } from './constants.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { createDialog, showSingerValidationReport } from './uiControls.js';

export function markDirty() {
  state.isDirty = true;
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
async function decodeAudioToMono(buffer) {
  const ac = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const audioBuffer = await ac.decodeAudioData(buffer.slice(0));
    // Downmix to mono: average all channels
    const numChannels = audioBuffer.numberOfChannels;
    const channel0 = audioBuffer.getChannelData(0);
    if (numChannels === 1) {
      return { audioData: new Float32Array(channel0), duration: audioBuffer.duration };
    }
    const mono = new Float32Array(channel0.length);
    for (let ch = 0; ch < numChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        mono[i] += data[i] / numChannels;
      }
    }
    return { audioData: mono, duration: audioBuffer.duration };
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
    const { audioData: monoData } = await decodeAudioToMono(wavBuffer);
    singer.audioBuffer = monoData;
    singer.audioDuration = audioData.audioDuration || (monoData.length / SAMPLE_RATE);
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
      audioData = await decodeAudioToMono(buffer);
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
    });
    singer.audioBuffer = audioData.audioData;

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
    audioData = await decodeAudioToMono(buffer);
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
  });
  const singer = trackManager.getSinger(singerId);
  if (singer) {
    singer.audioBuffer = audioData.audioData;
  }
}

export function showSingerSelectDialog(singerId) {
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

export async function serializeProject(embedSingerFiles = false, embedAccompanimentAudio = false) {
  const singers = await Promise.all(trackManager.getSingers().map(async (singer) => {
    const singerObj = { ...singer };
    if (singer.type === 'accompaniment') {
      // Accompaniment track: optionally embed audio as base64 WAV
      if (embedAccompanimentAudio && singer.audioBuffer) {
        let wavBase64 = null;
        try {
          const { encodeWav } = require('../audio/wavEncoder.js');
          const wavBytes = encodeWav(singer.audioBuffer, SAMPLE_RATE);
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
    // Clear runtime audioBuffer from serialization
    delete singerObj.audioBuffer;
    return singerObj;
  }));

  return JSON.stringify({
    version: '1.1.0',
    project: {
      bpm: state.project.bpm,
      timeSignature: state.project.timeSignature,
    },
    singers,
    fragments: trackManager.getFragments(),
  }, null, 2);
}

export function updateProjectSettings() {
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
  markDirty();
  // refreshAll will be called by the caller
  if (window.electronAPI?.updateProjectSettings) {
    window.electronAPI.updateProjectSettings({ bpm: state.project.bpm, timeSignature: state.project.timeSignature });
  }
}

export async function autoSaveProject() {
  if (!state.currentProjectFilePath) return;
  try {
    const data = await serializeProject(false);
    await window.electronAPI.saveFile(state.currentProjectFilePath, data);
    markClean();
    console.log('Project auto-saved to', state.currentProjectFilePath);
  } catch (_err) {
      // TODO: translate garbled log
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

export async function saveProject() {
  // Save in-place: if we already have a file path, write to it silently
  // without showing a dialog or the save-options popup.
  if (state.currentProjectFilePath) {
    try {
      const data = await serializeProject(false);
      await window.electronAPI.saveFile(state.currentProjectFilePath, data);
      markClean();
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
  if (window.electronAPI?.showSaveDialog) {
    try {
      const saveOptions = await showSaveProjectOptionsDialog();
      if (!saveOptions) return { saved: false, canceled: true };

      const result = await window.electronAPI.showSaveDialog({
        filters: [{ name: 'SXSEditor Project', extensions: ['sxsproj'] }],
        defaultPath: state.currentProjectFilePath || undefined,
      });
      if (!result.canceled && result.filePath) {
        const data = await serializeProject(saveOptions.embedSingerFiles, saveOptions.embedAccompanimentAudio);
        await window.electronAPI.saveFile(result.filePath, data);
        state.currentProjectFilePath = result.filePath;
        markClean();
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
          state.project.bpm = obj.project.bpm ?? 120;
          state.project.timeSignature = obj.project.timeSignature ?? [4, 4];
          dom.bpmInput.value = state.project.bpm;
          dom.timeSigNum.value = state.project.timeSignature[0];
          dom.timeSigDen.value = state.project.timeSignature[1];
          if (dom.bpmDisplayBadge) {
            const bpmText = dom.bpmDisplayBadge.querySelector('#bpm-display-text') ||
              document.getElementById('bpm-display-text');
            if (bpmText) bpmText.textContent = `${state.project.bpm} BPM`;
          }
        }
        if (obj.singers) {
          trackManager.singers.length = 0;
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
                    const { audioData } = await decodeAudioToMono(buffer);
                    singer.audioBuffer = audioData;
                    singer.audioDuration = audioData.length / SAMPLE_RATE;
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
                } catch (_err) {
      // TODO: translate garbled log
                  singer.singerFileMissing = true;
                }
              }
            }
          }
        }
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
  } else {
      // TODO: translate garbled log
  }
}
