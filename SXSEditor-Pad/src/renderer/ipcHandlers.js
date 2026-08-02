import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getState, setBpm, markDirty, getProject } from './state.js';
import { requestRender } from './timelineRenderer.js';

// ==================== Command Invokers ====================

/**
 * Get the app version from the Rust backend.
 */
export async function getAppVersion() {
  try {
    return await invoke('get_app_version');
  } catch (err) {
    console.error('[ipc] get_app_version failed:', err);
    return '0.0.0';
  }
}

/**
 * Get the current settings from the backend.
 */
export async function getSettings() {
  try {
    return await invoke('get_settings');
  } catch (err) {
    console.error('[ipc] get_settings failed:', err);
    return null;
  }
}

/**
 * Save settings to the backend.
 */
export async function saveSettings(settings) {
  try {
    await invoke('save_settings', { settings });
    return true;
  } catch (err) {
    console.error('[ipc] save_settings failed:', err);
    return false;
  }
}

/**
 * Get the current locale.
 */
export async function getLocale() {
  try {
    return await invoke('get_locale');
  } catch (err) {
    console.error('[ipc] get_locale failed:', err);
    return 'zh-CN';
  }
}

/**
 * Save the locale preference.
 */
export async function saveLocale(locale) {
  try {
    await invoke('save_locale', { locale });
    return true;
  } catch (err) {
    console.error('[ipc] save_locale failed:', err);
    return false;
  }
}

/**
 * Get the model directory path.
 */
export async function getModelDir() {
  try {
    return await invoke('get_model_dir');
  } catch (err) {
    console.error('[ipc] get_model_dir failed:', err);
    return '';
  }
}

/**
 * Set the model directory path.
 */
export async function setModelDir(path) {
  try {
    await invoke('set_model_dir', { path });
    return true;
  } catch (err) {
    console.error('[ipc] set_model_dir failed:', err);
    return false;
  }
}

/**
 * Get the list of singers from the backend.
 */
export async function getSingers() {
  try {
    return await invoke('get_singers');
  } catch (err) {
    console.error('[ipc] get_singers failed:', err);
    return [];
  }
}

/**
 * Save a singer to the backend.
 */
export async function saveSinger(singer) {
  try {
    await invoke('save_singer', { singer });
    return true;
  } catch (err) {
    console.error('[ipc] save_singer failed:', err);
    return false;
  }
}

/**
 * Delete a singer by ID.
 */
export async function deleteSinger(id) {
  try {
    await invoke('delete_singer', { id });
    return true;
  } catch (err) {
    console.error('[ipc] delete_singer failed:', err);
    return false;
  }
}

/**
 * Save a project info record to the backend.
 */
export async function saveProjectInfo(project) {
  try {
    await invoke('save_project', { project });
    return true;
  } catch (err) {
    console.error('[ipc] save_project_info failed:', err);
    return false;
  }
}

/**
 * Get the list of projects from the backend.
 */
export async function getProjects() {
  try {
    return await invoke('get_projects');
  } catch (err) {
    console.error('[ipc] get_projects failed:', err);
    return [];
  }
}

/**
 * Delete a project info record by ID.
 */
export async function deleteProjectInfo(id) {
  try {
    await invoke('delete_project', { id });
    return true;
  } catch (err) {
    console.error('[ipc] delete_project_info failed:', err);
    return false;
  }
}

/**
 * Check available models.
 */
export async function checkModels() {
  try {
    return await invoke('check_models');
  } catch (err) {
    console.error('[ipc] check_models failed:', err);
    return [];
  }
}

/**
 * Download a model by name.
 */
export async function downloadModel(modelName) {
  try {
    await invoke('download_model', { modelName });
    return true;
  } catch (err) {
    console.error('[ipc] download_model failed:', err);
    return false;
  }
}

/**
 * List available themes.
 */
export async function listThemes() {
  try {
    return await invoke('list_themes');
  } catch (err) {
    console.error('[ipc] list_themes failed:', err);
    return [];
  }
}

// ==================== Tauri Event Listeners ====================

let unlistenCallbacks = [];

/**
 * Set up all Tauri event listeners.
 */
export async function setupEventListeners() {
  // Clean up existing listeners
  await destroyEventListeners();

  try {
    // Listen for menu events from the backend
    const unlistenMenu = await listen('menu-event', (event) => {
      const { action } = event.payload;
      switch (action) {
        case 'new-project':
          window.dispatchEvent(new CustomEvent('sxs:new-project'));
          break;
        case 'open-project':
          window.dispatchEvent(new CustomEvent('sxs:load-project'));
          break;
        case 'save-project':
          window.dispatchEvent(new CustomEvent('sxs:save-project'));
          break;
        case 'export':
          window.dispatchEvent(new CustomEvent('sxs:export'));
          break;
        case 'undo':
          window.dispatchEvent(new CustomEvent('sxs:undo'));
          break;
      }
    });
    unlistenCallbacks.push(unlistenMenu);

    // Listen for settings changes pushed from the backend
    const unlistenSettings = await listen('settings-changed', (event) => {
      const settings = event.payload;
      if (settings.bpm) {
        setBpm(settings.bpm);
        requestRender();
      }
    });
    unlistenCallbacks.push(unlistenSettings);

    // Listen for theme changes
    const unlistenTheme = await listen('theme-changed', (event) => {
      const { themeId } = event.payload;
      document.documentElement.setAttribute('data-theme', themeId);
    });
    unlistenCallbacks.push(unlistenTheme);

    console.log('[ipc] Event listeners initialized');
  } catch (err) {
    console.error('[ipc] Failed to set up event listeners:', err);
  }
}

/**
 * Remove all Tauri event listeners.
 */
export async function destroyEventListeners() {
  for (const unlisten of unlistenCallbacks) {
    try {
      unlisten();
    } catch (e) {
      // Ignore unlisten errors
    }
  }
  unlistenCallbacks = [];
}

/**
 * Initialize all IPC handlers.
 */
export async function initIpcHandlers() {
  await setupEventListeners();
  console.log('[ipc] IPC handlers initialized');
}