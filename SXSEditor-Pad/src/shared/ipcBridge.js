/**
 * ipcBridge.js
 * IPC bridge for SXSEditor-Pad (Tauri v2).
 *
 * Replaces the Electron preload.js / ipcRenderer pattern with Tauri's invoke API,
 * dialog plugin, fs plugin, shell plugin, process plugin, and event system.
 *
 * Exposes a `window.electronAPI`-compatible object so that existing renderer code
 * (written for Electron) can work with minimal changes under Tauri.
 *
 * @module shared/ipcBridge
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import {
  open as dialogOpen,
  save as dialogSave,
  message as dialogMessage,
  ask as dialogAsk,
  confirm as dialogConfirm,
} from '@tauri-apps/plugin-dialog';
import {
  readTextFile,
  writeTextFile,
  readFile as fsReadBinary,
  exists as fsExists,
  mkdir as fsMkdir,
  remove as fsRemove,
  rename as fsRename,
  stat as fsStat,
} from '@tauri-apps/plugin-fs';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { exit as processExit } from '@tauri-apps/plugin-process';

// ==================== Internal Helpers ====================

/**
 * Safely call a Tauri invoke command with error handling.
 * Returns a promise that resolves to the command result or rejects with an error object.
 *
 * @param {string} cmd - The Tauri command name
 * @param {object} [args={}] - The command arguments
 * @returns {Promise<any>}
 */
async function safeInvoke(cmd, args = {}) {
  try {
    return await invoke(cmd, args);
  } catch (err) {
    console.error(`[ipcBridge] invoke error on "${cmd}":`, err);
    throw err;
  }
}

/**
 * Convert a string to an ArrayBuffer (UTF-8 encoded).
 * Used to match Electron's `ipcRenderer.invoke('file:readBuffer')` return type.
 *
 * @param {string} str
 * @returns {ArrayBuffer}
 */
function stringToArrayBuffer(str) {
  const encoder = new TextEncoder();
  return encoder.encode(str).buffer;
}

/**
 * Convert a Uint8Array to an ArrayBuffer.
 *
 * @param {Uint8Array} uint8
 * @returns {ArrayBuffer}
 */
function uint8ToArrayBuffer(uint8) {
  return uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
}

// ==================== Active Event Listener Registry ====================

/**
 * Tracks active event listener unsubscription functions so that
 * listeners can be properly cleaned up.
 *
 * @type {Map<string, Array<() => void>>}
 */
const _listenerCleanups = new Map();

/**
 * Register a Tauri event listener with automatic cleanup tracking.
 *
 * @param {string} channel - Event channel name
 * @param {Function} callback - Handler receiving the event payload
 * @returns {() => void} Unsubscribe function
 */
function addEventListener(channel, callback) {
  const unlistenPromise = listen(channel, (event) => {
    callback(event.payload, event);
  });

  const unlisten = () => {
    unlistenPromise.then((fn) => fn()).catch(console.error);
  };

  if (!_listenerCleanups.has(channel)) {
    _listenerCleanups.set(channel, []);
  }
  _listenerCleanups.get(channel).push(unlisten);

  return unlisten;
}

/**
 * Remove all listeners for a specific channel.
 *
 * @param {string} channel
 */
function removeAllListeners(channel) {
  const cleanups = _listenerCleanups.get(channel);
  if (cleanups) {
    cleanups.forEach((fn) => fn());
    _listenerCleanups.delete(channel);
  }
}

// ==================== IPC Bridge Object ====================

/**
 * `window.electronAPI`-compatible bridge object.
 *
 * Each method mirrors the interface expected by the Electron-era renderer code.
 * Under the hood it uses Tauri invoke, plugin APIs, or the event system.
 *
 * @type {object}
 */
const electronAPI = {
  // ==================== App Info ====================

  /** Get the application version string */
  getAppVersion: () => safeInvoke('get_app_version'),

  /** Get the current platform string */
  getPlatform: () => Promise.resolve(navigator.platform || 'unknown'),

  // ==================== File Operations ====================

  /**
   * Show a native "Save As" dialog.
   * @param {object} options - Dialog options (filters, defaultPath, title)
   * @returns {Promise<string|null>} Selected file path, or null if cancelled
   */
  showSaveDialog: async (options = {}) => {
    try {
      const path = await dialogSave({
        title: options.title || '保存文件',
        defaultPath: options.defaultPath,
        filters: options.filters || [],
      });
      return path || null;
    } catch (err) {
      console.error('[ipcBridge] showSaveDialog error:', err);
      return null;
    }
  },

  /**
   * Show a native "Open" dialog.
   * @param {object} options - Dialog options (filters, defaultPath, title, multiple)
   * @returns {Promise<string|string[]|null>} Selected file path(s), or null if cancelled
   */
  showOpenDialog: async (options = {}) => {
    try {
      const result = await dialogOpen({
        title: options.title || '打开文件',
        defaultPath: options.defaultPath,
        filters: options.filters || [],
        multiple: options.multiple || false,
        directory: options.directory || false,
      });
      if (result === null) return null;
      if (options.multiple) {
        return Array.isArray(result) ? result : [result];
      }
      return Array.isArray(result) ? result[0] : result;
    } catch (err) {
      console.error('[ipcBridge] showOpenDialog error:', err);
      return null;
    }
  },

  /**
   * Save text content to a file.
   * @param {string} filePath - Absolute file path
   * @param {string} content - Text content to write
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveFile: async (filePath, content) => {
    try {
      await writeTextFile(filePath, content);
      return { success: true };
    } catch (err) {
      console.error('[ipcBridge] saveFile error:', err);
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Read a file as text.
   * @param {string} filePath - Absolute file path
   * @returns {Promise<string|null>} File content, or null on error
   */
  readFile: async (filePath) => {
    try {
      return await readTextFile(filePath);
    } catch (err) {
      console.error('[ipcBridge] readFile error:', err);
      return null;
    }
  },

  /**
   * Read a file as an ArrayBuffer (binary).
   * @param {string} filePath - Absolute file path
   * @returns {Promise<ArrayBuffer|null>} File content as ArrayBuffer, or null on error
   */
  readFileBuffer: async (filePath) => {
    try {
      const uint8 = await fsReadBinary(filePath);
      return uint8ToArrayBuffer(uint8);
    } catch (err) {
      console.error('[ipcBridge] readFileBuffer error:', err);
      return null;
    }
  },

  /**
   * Check if a file exists at the given path.
   * @param {string} filePath - Absolute file path
   * @returns {Promise<boolean>}
   */
  fileExists: async (filePath) => {
    try {
      return await fsExists(filePath);
    } catch (err) {
      console.error('[ipcBridge] fileExists error:', err);
      return false;
    }
  },

  /**
   * Authorize a file path for access (Tauri v2 scope).
   * In Tauri this is typically handled by the filesystem scope configuration,
   * but this method provides a runtime fallback.
   * @param {string} filePath - Absolute file path to authorize
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  authorizePath: async (filePath) => {
    try {
      // In Tauri v2, runtime path authorization is handled by the fs plugin scope.
      // We attempt a stat call to verify accessibility.
      await fsStat(filePath);
      return { success: true };
    } catch (err) {
      console.error('[ipcBridge] authorizePath error:', err);
      return { success: false, error: err.toString() };
    }
  },

  // ==================== Fragment Editor ====================

  /**
   * Open the fragment editor window.
   * @param {object} data - Fragment data to edit
   */
  openFragmentEditor: (data) => emit('sxs://fragment/open-editor', data),

  /**
   * Save fragment data from the editor.
   * @param {object} data - Fragment data payload
   */
  saveFragmentData: (data) => emit('sxs://fragment/save-data', data),

  /**
   * Retrieve fragment data for editing.
   * @param {string} fragmentId - Fragment identifier
   */
  getFragmentData: (fragmentId) => emit('sxs://fragment/get-data', { fragmentId }),

  /** Event: fragment saved */
  onFragmentSaved: (callback) => addEventListener('sxs://fragment/saved', callback),

  /** Event: fragment editor closed */
  onFragmentEditorClosed: (callback) => addEventListener('sxs://fragment/editor-closed', callback),

  /** Event: fragment editor ready */
  onFragmentEditorReady: (callback) => addEventListener('sxs://fragment/editor-ready', callback),

  // ==================== SVS (Singing Voice Synthesis) ====================

  /**
   * Initialize the SVS inference pipeline.
   * @param {object} config - Pipeline configuration (model paths, device, etc.)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  initSVSPipeline: async (config) => {
    try {
      return await safeInvoke('svs_init_pipeline', { config });
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Run SVS synthesis on input features.
   * @param {object} params - Synthesis parameters
   * @returns {Promise<{success: boolean, data?: ArrayBuffer, error?: string}>}
   */
  synthesizeSVS: async (params) => {
    try {
      return await safeInvoke('svs_synthesize', { params });
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Dispose the SVS pipeline and free resources.
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  disposeSVSPipeline: async () => {
    try {
      return await safeInvoke('svs_dispose_pipeline');
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  /** Event: SVS synthesis progress */
  onSVSProgress: (callback) => addEventListener('sxs://svs/progress', callback),

  /** Event: SVS synthesis complete */
  onSVSComplete: (callback) => addEventListener('sxs://svs/complete', callback),

  /** Event: SVS synthesis error */
  onSVSError: (callback) => addEventListener('sxs://svs/error', callback),

  /** Event: SVS pipeline ready */
  onSVSPipelineReady: (callback) => addEventListener('sxs://svs/pipeline-ready', callback),

  // ==================== Settings ====================

  /**
   * Get application settings.
   * @returns {Promise<object>}
   */
  getSettings: () => safeInvoke('get_settings'),

  /**
   * Save application settings.
   * @param {object} settings - Settings object to persist
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveSettings: async (settings) => {
    try {
      await safeInvoke('save_settings', { settings });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Check available models (local or remote).
   * @returns {Promise<Array<{name: string, size: number, downloaded: boolean, progress: number}>>}
   */
  checkModels: () => safeInvoke('check_models'),

  /**
   * Get available DirectML devices.
   * @returns {Promise<Array<{deviceId: number, name: string, type: string}>>}
   */
  getDMLDevices: () => safeInvoke('get_dml_devices'),

  /** Event: settings changed */
  onSettingsChanged: (callback) => addEventListener('sxs://settings/changed', callback),

  // ==================== Audio ====================

  /**
   * Get available audio output devices.
   * @returns {Promise<Array<{deviceId: string, name: string, label: string}>>}
   */
  getAudioDevices: () => safeInvoke('get_audio_devices'),

  /**
   * Start audio playback from an ArrayBuffer or file path.
   * @param {string|ArrayBuffer} source - Audio data or file path
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  audioPlay: async (source) => {
    try {
      return await safeInvoke('audio_play', { source });
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Stop audio playback.
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  audioStop: async () => {
    try {
      return await safeInvoke('audio_stop');
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  /** Event: audio time update */
  onAudioTimeUpdate: (callback) => addEventListener('sxs://audio/time-update', callback),

  /** Event: audio playback ended */
  onAudioEnded: (callback) => addEventListener('sxs://audio/ended', callback),

  // ==================== Model Download ====================

  /**
   * Start downloading a model.
   * @param {string} modelName - Name of the model to download
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  modelDownloadStart: async (modelName) => {
    try {
      await safeInvoke('download_model', { modelName });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Cancel a running model download.
   * @param {string} modelName - Name of the model
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  modelDownloadCancel: async (modelName) => {
    try {
      return await safeInvoke('model_download_cancel', { modelName });
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Check the download status of a model.
   * @param {string} modelName - Name of the model
   * @returns {Promise<{downloaded: boolean, progress: number, error?: string}>}
   */
  modelDownloadCheck: async (modelName) => {
    try {
      return await safeInvoke('model_download_check', { modelName });
    } catch (err) {
      return { downloaded: false, progress: 0, error: err.toString() };
    }
  },

  /** Event: model download progress */
  onModelDownloadProgress: (callback) => addEventListener('sxs://model-download/progress', callback),

  /** Event: model download complete */
  onModelDownloadComplete: (callback) => addEventListener('sxs://model-download/complete', callback),

  /** Event: model download error */
  onModelDownloadError: (callback) => addEventListener('sxs://model-download/error', callback),

  // ==================== Theme ====================

  /** Theme API sub-namespace */
  themeAPI: {
    /** Bootstrap the theme system */
    bootstrap: () => safeInvoke('theme_bootstrap'),

    /** List all available themes */
    list: () => safeInvoke('list_themes'),

    /** Get theme details by ID */
    get: (themeId) => safeInvoke('theme_get', { themeId }),

    /** Get the currently active theme ID */
    current: () => safeInvoke('theme_current'),

    /** Apply a theme by ID */
    apply: (themeId) => safeInvoke('theme_apply', { themeId }),

    /** Save a custom theme */
    save: (theme) => safeInvoke('theme_save', { theme }),

    /** Delete a theme by ID */
    delete: (themeId) => safeInvoke('theme_delete', { themeId }),

    /** Event: theme changed */
    onChange: (callback) => addEventListener('sxs://theme/changed', callback),
  },

  // ==================== Singer Market ====================

  /** Singer market API sub-namespace */
  singerMarket: {
    /** Login to singer market */
    login: (credentials) => safeInvoke('singer_market_login', { credentials }),

    /** Register a new singer market account */
    register: (info) => safeInvoke('singer_market_register', { info }),

    /** Logout from singer market */
    logout: () => safeInvoke('singer_market_logout'),

    /** List available singers in the market */
    list: (filters) => safeInvoke('singer_market_list', { filters }),

    /** Purchase a singer from the market */
    purchase: (singerId) => safeInvoke('singer_market_purchase', { singerId }),

    /** Download a purchased singer */
    download: (singerId) => safeInvoke('singer_market_download', { singerId }),

    /** Search singers in the market */
    search: (query) => safeInvoke('singer_market_search', { query }),

    /** Get current user info */
    getUserInfo: () => safeInvoke('singer_market_user_info'),
  },

  // ==================== Update ====================

  /** Update API sub-namespace */
  updateAPI: {
    /** Check for updates immediately */
    checkNow: () => safeInvoke('update_check_now'),

    /** Get current update status */
    getStatus: () => safeInvoke('update_get_status'),

    /** Start downloading the available update */
    download: () => safeInvoke('update_download'),

    /** Install the downloaded update */
    install: () => safeInvoke('update_install'),

    /** Event: update available */
    onAvailable: (callback) => addEventListener('sxs://update/available', callback),

    /** Event: update download progress */
    onProgress: (callback) => addEventListener('sxs://update/progress', callback),

    /** Event: no update available */
    onNotAvailable: (callback) => addEventListener('sxs://update/not-available', callback),

    /** Event: update error */
    onError: (callback) => addEventListener('sxs://update/error', callback),
  },

  // ==================== WebNN ====================

  /**
   * Detect NPU availability via WebNN API.
   * @returns {Promise<{available: boolean, devices: Array<object>}>}
   */
  webnnDetectNPU: async () => {
    try {
      return await safeInvoke('webnn_detect_npu');
    } catch (err) {
      // Fallback: try the browser WebNN API directly
      try {
        // @ts-ignore - WebNN API is experimental
        const ml = navigator.ml;
        if (ml) {
          const devices = [];
          // Check for NPU availability
          const context = await ml.createContext({ deviceType: 'npu' });
          devices.push({ deviceType: 'npu', label: 'NPU (WebNN)' });
          return { available: true, devices };
        }
        return { available: false, devices: [] };
      } catch (_webnnErr) {
        return { available: false, devices: [] };
      }
    }
  },

  /**
   * Load a model into WebNN for inference.
   * @param {string} modelPath - Path to the model
   * @param {object} options - Load options (deviceType, etc.)
   * @returns {Promise<{success: boolean, modelId?: string, error?: string}>}
   */
  webnnLoadModel: async (modelPath, options = {}) => {
    try {
      return await safeInvoke('webnn_load_model', { modelPath, options });
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Run inference on a WebNN-loaded model.
   * @param {string} modelId - Model identifier from webnnLoadModel
   * @param {object} inputs - Input tensors
   * @returns {Promise<{success: boolean, outputs?: object, error?: string}>}
   */
  webnnRunInference: async (modelId, inputs) => {
    try {
      return await safeInvoke('webnn_run_inference', { modelId, inputs });
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Unload a WebNN model and free resources.
   * @param {string} modelId - Model identifier to unload
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  webnnUnloadModel: async (modelId) => {
    try {
      return await safeInvoke('webnn_unload_model', { modelId });
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  // ==================== Singer Management ====================

  /**
   * Get the list of installed singers.
   * @returns {Promise<Array<object>>}
   */
  getSingers: () => safeInvoke('get_singers'),

  /**
   * Save a singer's information.
   * @param {object} singer - Singer info object
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveSinger: async (singer) => {
    try {
      await safeInvoke('save_singer', { singer });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Delete a singer by ID.
   * @param {string} singerId - Singer identifier
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  deleteSinger: async (singerId) => {
    try {
      await safeInvoke('delete_singer', { id: singerId });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  // ==================== Project Management ====================

  /**
   * Get the list of saved projects.
   * @returns {Promise<Array<object>>}
   */
  getProjects: () => safeInvoke('get_projects'),

  /**
   * Save a project.
   * @param {object} project - Project info object
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveProject: async (project) => {
    try {
      await safeInvoke('save_project', { project });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Delete a project by ID.
   * @param {string} projectId - Project identifier
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  deleteProject: async (projectId) => {
    try {
      await safeInvoke('delete_project', { id: projectId });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  // ==================== Locale ====================

  /**
   * Get the current locale string.
   * @returns {Promise<string>}
   */
  getLocale: () => safeInvoke('get_locale'),

  /**
   * Save the locale preference.
   * @param {string} locale - Locale string (e.g. 'zh-CN', 'en-US', 'ja-JP')
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveLocale: async (locale) => {
    try {
      await safeInvoke('save_locale', { locale });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  /** Event: locale changed */
  onLocaleChanged: (callback) => addEventListener('sxs://locale/changed', callback),

  // ==================== Model Directory ====================

  /**
   * Get the model directory path.
   * @returns {Promise<string>}
   */
  getModelDir: () => safeInvoke('get_model_dir'),

  /**
   * Set the model directory path.
   * @param {string} path - Absolute path to the model directory
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  setModelDir: async (path) => {
    try {
      await safeInvoke('set_model_dir', { path });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.toString() };
    }
  },

  // ==================== Dialog Helpers ====================

  /**
   * Show a native message dialog.
   * @param {string} message - Message text
   * @param {object} [options] - Dialog options
   * @returns {Promise<void>}
   */
  showMessageDialog: (message, options) => dialogMessage(message, options),

  /**
   * Show a native confirmation dialog (OK/Cancel).
   * @param {string} message - Message text
   * @param {object} [options] - Dialog options
   * @returns {Promise<boolean>}
   */
  showConfirmDialog: (message, options) => dialogConfirm(message, options),

  /**
   * Show a native ask dialog (Yes/No).
   * @param {string} message - Message text
   * @param {object} [options] - Dialog options
   * @returns {Promise<boolean>}
   */
  showAskDialog: (message, options) => dialogAsk(message, options),

  // ==================== Shell / Utilities ====================

  /**
   * Open a URL in the default system browser.
   * @param {string} url - URL to open
   * @returns {Promise<void>}
   */
  openExternal: (url) => shellOpen(url),

  /**
   * Exit the application.
   * @param {number} [code=0] - Exit code
   * @returns {Promise<void>}
   */
  appExit: (code = 0) => processExit(code),

  // ==================== Event System ====================

  /**
   * Emit a custom event through Tauri's event system.
   * @param {string} channel - Event channel name
   * @param {*} payload - Event payload
   * @returns {Promise<void>}
   */
  emit: (channel, payload) => emit(channel, payload),

  /**
   * Listen for a custom event.
   * @param {string} channel - Event channel name
   * @param {Function} callback - Event handler
   * @returns {() => void} Unsubscribe function
   */
  on: (channel, callback) => addEventListener(channel, callback),

  /**
   * Remove all listeners for a specific event channel.
   * @param {string} channel - Event channel name
   */
  removeAllListeners,

  // ==================== Version Info ====================

  /** Get the bridge (Tauri) implementation version */
  getBridgeVersion: () => Promise.resolve('2.0.0-tauri'),
};

// ==================== Install Bridge ====================

/**
 * Install the electronAPI bridge into the window object.
 * This makes `window.electronAPI` available to all renderer code.
 */
export function installBridge() {
  if (window.electronAPI) {
    console.warn('[ipcBridge] window.electronAPI already exists, skipping install.');
    return;
  }
  window.electronAPI = electronAPI;
  console.log('[ipcBridge] Tauri v2 IPC bridge installed successfully.');
}

/**
 * Uninstall the bridge and clean up all event listeners.
 */
export function uninstallBridge() {
  // Clean up all registered listeners
  for (const [channel] of _listenerCleanups) {
    removeAllListeners(channel);
  }
  delete window.electronAPI;
  console.log('[ipcBridge] IPC bridge uninstalled.');
}

// ==================== Direct Export ====================

export { electronAPI };
export default electronAPI;