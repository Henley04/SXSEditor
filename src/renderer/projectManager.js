import { state, dom, trackManager, history } from './state.js';
import { SXSSINGER_CURRENT_VERSION } from './constants.js';
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

export function applySingerDataToSinger(singer, singerData) {
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

export async function loadSingerFile(singerId, buffer, filePath) {
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
    // refreshAll will be called by the caller
  }
}

export async function addSingerFromFile(buffer, filePath) {
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
    state.selectedSingerId = singer.id;
    // refreshAll will be called by the caller
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

export function serializeProject(embedSingerFiles = false) {
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
    dom.bpmDisplayBadge.textContent = `♩ ${state.project.bpm} BPM`;
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
    const data = serializeProject(false);
    await window.electronAPI.saveFile(state.currentProjectFilePath, data);
    markClean();
    console.log('Project auto-saved to', state.currentProjectFilePath);
  } catch (err) {
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
  if (window.electronAPI?.showSaveDialog) {
    try {
      const saveOptions = await showSaveProjectOptionsDialog();
      if (!saveOptions) return;

      const result = await window.electronAPI.showSaveDialog({
        filters: [{ name: 'SXSEditor Project', extensions: ['sxsproj'] }],
        defaultPath: state.currentProjectFilePath || undefined,
      });
      if (!result.canceled && result.filePath) {
        const data = serializeProject(saveOptions.embedSingerFiles);
        await window.electronAPI.saveFile(result.filePath, data);
        state.currentProjectFilePath = result.filePath;
        markClean();
        console.log('Project saved to', result.filePath);
      }
    } catch (err) {
      console.error('Save failed', err);
    }
  } else {
      // TODO: translate garbled log
  }
}

export async function loadProject() {
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
          state.project.bpm = obj.project.bpm ?? 120;
          state.project.timeSignature = obj.project.timeSignature ?? [4, 4];
          dom.bpmInput.value = state.project.bpm;
          dom.timeSigNum.value = state.project.timeSignature[0];
          dom.timeSigDen.value = state.project.timeSignature[1];
          if (dom.bpmDisplayBadge) dom.bpmDisplayBadge.textContent = `♩ ${state.project.bpm} BPM`;
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
        state.currentProjectFilePath = result.filePaths[0];
        history.clear();
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
