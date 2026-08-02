import { invoke } from '@tauri-apps/api/core';
import { open, save, message } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import {
  getState,
  getProject,
  getProjectFilePath,
  setProjectFilePath,
  markDirty,
  markClean,
  isDirty,
  setBpm,
  setTimeSig,
  setAutoShift,
  setPlaybackPosition,
  setPlaybackDuration,
} from './state.js';
import { requestRender } from './timelineRenderer.js';
import { saveProjectInfo } from './ipcHandlers.js';

// ==================== Serialization ====================

/**
 * Serialize the project state to a JSON object.
 */
export function serializeProject() {
  const project = getProject();
  return {
    version: '1.0.0',
    app: 'sxseditor-pad',
    project: {
      bpm: project.bpm,
      timeSigNum: project.timeSigNum,
      timeSigDen: project.timeSigDen,
      autoShift: project.autoShift,
      fragments: project.fragments.map((frag) => ({
        id: frag.id,
        label: frag.label,
        startBeat: frag.startBeat,
        durationBeats: frag.durationBeats,
        trackIndex: frag.trackIndex,
        singerId: frag.singerId,
        singerName: frag.singerName,
        audioPath: frag.audioPath,
        midiPath: frag.midiPath,
        pitchData: frag.pitchData,
        phoneticData: frag.phoneticData,
        muted: frag.muted || false,
        gain: frag.gain ?? 1.0,
        pan: frag.pan ?? 0.0,
      })),
      singers: project.singers.map((singer) => ({
        id: singer.id,
        name: singer.name,
        trackName: singer.trackName,
        modelPath: singer.modelPath,
        configPath: singer.configPath,
      })),
    },
  };
}

/**
 * Deserialize a JSON object into the project state.
 */
export function deserializeProject(data) {
  if (!data || !data.project) {
    throw new Error('Invalid project data');
  }

  const p = data.project;

  setBpm(p.bpm || 120);
  setTimeSig(p.timeSigNum || 4, p.timeSigDen || 4);
  setAutoShift(p.autoShift !== undefined ? p.autoShift : true);

  const project = getProject();
  project.fragments = (p.fragments || []).map((f) => ({
    id: f.id,
    label: f.label || '',
    startBeat: f.startBeat || 0,
    durationBeats: f.durationBeats || 4,
    trackIndex: f.trackIndex || 0,
    singerId: f.singerId || null,
    singerName: f.singerName || '',
    audioPath: f.audioPath || null,
    midiPath: f.midiPath || null,
    pitchData: f.pitchData || null,
    phoneticData: f.phoneticData || null,
    muted: f.muted || false,
    gain: f.gain ?? 1.0,
    pan: f.pan ?? 0.0,
  }));

  project.singers = (p.singers || []).map((s) => ({
    id: s.id,
    name: s.name,
    trackName: s.trackName || '',
    modelPath: s.modelPath || null,
    configPath: s.configPath || null,
  }));

  setPlaybackPosition(0);
  setPlaybackDuration(0);
}

// ==================== File Operations ====================

/**
 * Generate a default project file name.
 */
function defaultProjectName() {
  return `untitled.sxsproj`;
}

/**
 * Save the current project to a file.
 * If no file path is set, prompts the user via the save dialog.
 */
export async function saveProject() {
  try {
    let filePath = getProjectFilePath();

    if (!filePath) {
      filePath = await save({
        filters: [
          { name: 'SXS Project', extensions: ['sxsproj'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        defaultPath: defaultProjectName(),
      });

      if (!filePath) return false; // User cancelled
      setProjectFilePath(filePath);
    }

    const json = JSON.stringify(serializeProject(), null, 2);
    await writeTextFile(filePath, json);

    markClean();
    await saveProjectInfo({
      id: filePath,
      name: filePath.split('/').pop().split('\\').pop(),
      path: filePath,
      modified: new Date().toISOString(),
    });

    console.log(`[projectManager] Project saved to ${filePath}`);
    return true;
  } catch (err) {
    console.error('[projectManager] Save failed:', err);
    await message(`保存项目失败: ${err}`, { title: 'SXSEditor-Pad', kind: 'error' });
    return false;
  }
}

/**
 * Save the project to a new file (Save As).
 */
export async function saveProjectAs() {
  try {
    const filePath = await save({
      filters: [
        { name: 'SXS Project', extensions: ['sxsproj'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      defaultPath: defaultProjectName(),
    });

    if (!filePath) return false;

    const json = JSON.stringify(serializeProject(), null, 2);
    await writeTextFile(filePath, json);

    setProjectFilePath(filePath);
    markClean();

    await saveProjectInfo({
      id: filePath,
      name: filePath.split('/').pop().split('\\').pop(),
      path: filePath,
      modified: new Date().toISOString(),
    });

    console.log(`[projectManager] Project saved as ${filePath}`);
    return true;
  } catch (err) {
    console.error('[projectManager] Save As failed:', err);
    await message(`另存为失败: ${err}`, { title: 'SXSEditor-Pad', kind: 'error' });
    return false;
  }
}

/**
 * Load a project from a file.
 * If no path is provided, prompts the user via the open dialog.
 */
export async function loadProject(filePath) {
  try {
    if (!filePath) {
      filePath = await open({
        filters: [
          { name: 'SXS Project', extensions: ['sxsproj'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        multiple: false,
      });

      if (!filePath) return false; // User cancelled
    }

    const json = await readTextFile(filePath);
    const data = JSON.parse(json);

    deserializeProject(data);
    setProjectFilePath(filePath);
    markClean();

    requestRender();
    console.log(`[projectManager] Project loaded from ${filePath}`);
    return true;
  } catch (err) {
    console.error('[projectManager] Load failed:', err);
    await message(`加载项目失败: ${err}`, { title: 'SXSEditor-Pad', kind: 'error' });
    return false;
  }
}

/**
 * Create a new empty project.
 */
export function newProject() {
  const project = getProject();
  project.fragments = [];
  project.singers = [];
  setBpm(120);
  setTimeSig(4, 4);
  setAutoShift(true);
  setProjectFilePath(null);
  setPlaybackPosition(0);
  setPlaybackDuration(0);
  markClean();
  requestRender();
  console.log('[projectManager] New project created');
}

/**
 * Check if there are unsaved changes and prompt the user.
 * Returns true if it's safe to proceed (saved or user declined save).
 */
export async function confirmSaveBeforeAction(action) {
  if (!isDirty()) return true;

  const result = await message(
    '当前项目有未保存的更改。是否保存？',
    {
      title: 'SXSEditor-Pad',
      kind: 'info',
      okLabel: '保存',
      cancelLabel: '取消',
    }
  );

  if (result) {
    return await saveProject();
  }

  return false;
}