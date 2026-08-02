/**
 * ipcChannels.js
 * IPC channel constant definitions for SXSEditor-Pad (Tauri v2).
 *
 * Adapted from the Electron original — replaces ipcMain/ipcRenderer channel strings
 * with Tauri event names. Channels prefixed with "tauri://" are reserved system events;
 * application-level events use the "sxs://" prefix for namespacing.
 *
 * @module shared/ipcChannels
 */

// ==================== Fragment Editor ====================

/** Open the fragment editor window */
export const FRAGMENT_OPEN_EDITOR = 'sxs://fragment/open-editor';
/** Fragment data has been saved */
export const FRAGMENT_SAVED = 'sxs://fragment/saved';
/** Save fragment data */
export const FRAGMENT_SAVE_DATA = 'sxs://fragment/save-data';
/** Retrieve fragment data */
export const FRAGMENT_GET_DATA = 'sxs://fragment/get-data';
/** Fragment editor closed */
export const FRAGMENT_EDITOR_CLOSED = 'sxs://fragment/editor-closed';
/** Fragment editor ready */
export const FRAGMENT_EDITOR_READY = 'sxs://fragment/editor-ready';

// ==================== SVS (Singing Voice Synthesis) ====================

/** Initialize SVS pipeline */
export const SVS_INIT_PIPELINE = 'sxs://svs/init-pipeline';
/** Run SVS synthesis */
export const SVS_SYNTHESIZE = 'sxs://svs/synthesize';
/** Dispose SVS pipeline */
export const SVS_DISPOSE_PIPELINE = 'sxs://svs/dispose-pipeline';
/** SVS progress update (event) */
export const SVS_PROGRESS = 'sxs://svs/progress';
/** SVS synthesis complete (event) */
export const SVS_COMPLETE = 'sxs://svs/complete';
/** SVS synthesis error (event) */
export const SVS_ERROR = 'sxs://svs/error';
/** SVS pipeline ready (event) */
export const SVS_PIPELINE_READY = 'sxs://svs/pipeline-ready';

// ==================== Settings ====================

/** Get application settings */
export const SETTINGS_GET = 'sxs://settings/get';
/** Save application settings */
export const SETTINGS_SAVE = 'sxs://settings/save';
/** Check available models */
export const SETTINGS_CHECK_MODELS = 'sxs://settings/check-models';
/** Get DML (DirectML) devices */
export const SETTINGS_GET_DML_DEVICES = 'sxs://settings/get-dml-devices';
/** Settings changed (event) */
export const SETTINGS_CHANGED = 'sxs://settings/changed';

// ==================== Audio ====================

/** Get available audio output devices */
export const AUDIO_GET_DEVICES = 'sxs://audio/get-devices';
/** Start audio playback */
export const AUDIO_PLAY = 'sxs://audio/play';
/** Stop audio playback */
export const AUDIO_STOP = 'sxs://audio/stop';
/** Audio playback position update (event) */
export const AUDIO_TIME_UPDATE = 'sxs://audio/time-update';
/** Audio playback ended (event) */
export const AUDIO_ENDED = 'sxs://audio/ended';

// ==================== File Operations ====================

/** Show native save dialog */
export const FILE_SHOW_SAVE_DIALOG = 'sxs://file/show-save-dialog';
/** Show native open dialog */
export const FILE_SHOW_OPEN_DIALOG = 'sxs://file/show-open-dialog';
/** Save content to file */
export const FILE_SAVE = 'sxs://file/save';
/** Read file as text */
export const FILE_READ = 'sxs://file/read';
/** Read file as ArrayBuffer */
export const FILE_READ_BUFFER = 'sxs://file/read-buffer';
/** Check if file exists */
export const FILE_EXISTS = 'sxs://file/exists';
/** Authorize a file path for access */
export const FILE_AUTHORIZE_PATH = 'sxs://file/authorize-path';

// ==================== Model Download ====================

/** Start model download */
export const MODEL_DOWNLOAD_START = 'sxs://model-download/start';
/** Cancel model download */
export const MODEL_DOWNLOAD_CANCEL = 'sxs://model-download/cancel';
/** Check model download status */
export const MODEL_DOWNLOAD_CHECK = 'sxs://model-download/check';
/** Model download progress (event) */
export const MODEL_DOWNLOAD_PROGRESS = 'sxs://model-download/progress';
/** Model download complete (event) */
export const MODEL_DOWNLOAD_COMPLETE = 'sxs://model-download/complete';
/** Model download error (event) */
export const MODEL_DOWNLOAD_ERROR = 'sxs://model-download/error';

// ==================== Theme ====================

/** Bootstrap theme system */
export const THEME_BOOTSTRAP = 'sxs://theme/bootstrap';
/** List available themes */
export const THEME_LIST = 'sxs://theme/list';
/** Get a theme by ID */
export const THEME_GET = 'sxs://theme/get';
/** Get current theme */
export const THEME_CURRENT = 'sxs://theme/current';
/** Apply a theme */
export const THEME_APPLY = 'sxs://theme/apply';
/** Save a custom theme */
export const THEME_SAVE = 'sxs://theme/save';
/** Delete a theme */
export const THEME_DELETE = 'sxs://theme/delete';
/** Theme changed (event) */
export const THEME_CHANGED = 'sxs://theme/changed';

// ==================== Singer Market ====================

/** Login to singer market */
export const SINGER_MARKET_LOGIN = 'sxs://singer-market/login';
/** Register singer market account */
export const SINGER_MARKET_REGISTER = 'sxs://singer-market/register';
/** Logout from singer market */
export const SINGER_MARKET_LOGOUT = 'sxs://singer-market/logout';
/** List available singers in market */
export const SINGER_MARKET_LIST = 'sxs://singer-market/list';
/** Purchase a singer from market */
export const SINGER_MARKET_PURCHASE = 'sxs://singer-market/purchase';
/** Download a purchased singer */
export const SINGER_MARKET_DOWNLOAD = 'sxs://singer-market/download';
/** Search singers in market */
export const SINGER_MARKET_SEARCH = 'sxs://singer-market/search';
/** Get singer market user info */
export const SINGER_MARKET_USER_INFO = 'sxs://singer-market/user-info';

// ==================== Update ====================

/** Check for updates now */
export const UPDATE_CHECK_NOW = 'sxs://update/check-now';
/** Get update status */
export const UPDATE_GET_STATUS = 'sxs://update/get-status';
/** Start downloading update */
export const UPDATE_DOWNLOAD = 'sxs://update/download';
/** Install update */
export const UPDATE_INSTALL = 'sxs://update/install';
/** Update available (event) */
export const UPDATE_AVAILABLE = 'sxs://update/available';
/** Update progress (event) */
export const UPDATE_PROGRESS = 'sxs://update/progress';
/** Update not available (event) */
export const UPDATE_NOT_AVAILABLE = 'sxs://update/not-available';
/** Update error (event) */
export const UPDATE_ERROR = 'sxs://update/error';

// ==================== WebNN ====================

/** Detect NPU availability via WebNN */
export const WEBNN_DETECT_NPU = 'sxs://webnn/detect-npu';
/** Load a model into WebNN */
export const WEBNN_LOAD_MODEL = 'sxs://webnn/load-model';
/** Run inference via WebNN */
export const WEBNN_RUN_INFERENCE = 'sxs://webnn/run-inference';
/** Unload WebNN model */
export const WEBNN_UNLOAD_MODEL = 'sxs://webnn/unload-model';

// ==================== App Lifecycle ====================

/** App is ready (event) */
export const APP_READY = 'sxs://app/ready';
/** App is about to close (event) */
export const APP_BEFORE_CLOSE = 'sxs://app/before-close';
/** Get app version */
export const APP_GET_VERSION = 'sxs://app/get-version';
/** Get platform info */
export const APP_GET_PLATFORM = 'sxs://app/get-platform';

// ==================== Singer Management ====================

/** Get list of installed singers */
export const SINGER_GET_LIST = 'sxs://singer/get-list';
/** Save singer info */
export const SINGER_SAVE = 'sxs://singer/save';
/** Delete a singer */
export const SINGER_DELETE = 'sxs://singer/delete';

// ==================== Project Management ====================

/** Get list of projects */
export const PROJECT_GET_LIST = 'sxs://project/get-list';
/** Save project */
export const PROJECT_SAVE = 'sxs://project/save';
/** Delete a project */
export const PROJECT_DELETE = 'sxs://project/delete';

// ==================== Locale ====================

/** Get current locale */
export const LOCALE_GET = 'sxs://locale/get';
/** Save locale preference */
export const LOCALE_SAVE = 'sxs://locale/save';
/** Locale changed (event) */
export const LOCALE_CHANGED = 'sxs://locale/changed';

// ==================== Model Directory ====================

/** Get model directory path */
export const MODEL_DIR_GET = 'sxs://model-dir/get';
/** Set model directory path */
export const MODEL_DIR_SET = 'sxs://model-dir/set';

// ==================== Export ====================

export default {
  FRAGMENT_OPEN_EDITOR,
  FRAGMENT_SAVED,
  FRAGMENT_SAVE_DATA,
  FRAGMENT_GET_DATA,
  FRAGMENT_EDITOR_CLOSED,
  FRAGMENT_EDITOR_READY,
  SVS_INIT_PIPELINE,
  SVS_SYNTHESIZE,
  SVS_DISPOSE_PIPELINE,
  SVS_PROGRESS,
  SVS_COMPLETE,
  SVS_ERROR,
  SVS_PIPELINE_READY,
  SETTINGS_GET,
  SETTINGS_SAVE,
  SETTINGS_CHECK_MODELS,
  SETTINGS_GET_DML_DEVICES,
  SETTINGS_CHANGED,
  AUDIO_GET_DEVICES,
  AUDIO_PLAY,
  AUDIO_STOP,
  AUDIO_TIME_UPDATE,
  AUDIO_ENDED,
  FILE_SHOW_SAVE_DIALOG,
  FILE_SHOW_OPEN_DIALOG,
  FILE_SAVE,
  FILE_READ,
  FILE_READ_BUFFER,
  FILE_EXISTS,
  FILE_AUTHORIZE_PATH,
  MODEL_DOWNLOAD_START,
  MODEL_DOWNLOAD_CANCEL,
  MODEL_DOWNLOAD_CHECK,
  MODEL_DOWNLOAD_PROGRESS,
  MODEL_DOWNLOAD_COMPLETE,
  MODEL_DOWNLOAD_ERROR,
  THEME_BOOTSTRAP,
  THEME_LIST,
  THEME_GET,
  THEME_CURRENT,
  THEME_APPLY,
  THEME_SAVE,
  THEME_DELETE,
  THEME_CHANGED,
  SINGER_MARKET_LOGIN,
  SINGER_MARKET_REGISTER,
  SINGER_MARKET_LOGOUT,
  SINGER_MARKET_LIST,
  SINGER_MARKET_PURCHASE,
  SINGER_MARKET_DOWNLOAD,
  SINGER_MARKET_SEARCH,
  SINGER_MARKET_USER_INFO,
  UPDATE_CHECK_NOW,
  UPDATE_GET_STATUS,
  UPDATE_DOWNLOAD,
  UPDATE_INSTALL,
  UPDATE_AVAILABLE,
  UPDATE_PROGRESS,
  UPDATE_NOT_AVAILABLE,
  UPDATE_ERROR,
  WEBNN_DETECT_NPU,
  WEBNN_LOAD_MODEL,
  WEBNN_RUN_INFERENCE,
  WEBNN_UNLOAD_MODEL,
  APP_READY,
  APP_BEFORE_CLOSE,
  APP_GET_VERSION,
  APP_GET_PLATFORM,
  SINGER_GET_LIST,
  SINGER_SAVE,
  SINGER_DELETE,
  PROJECT_GET_LIST,
  PROJECT_SAVE,
  PROJECT_DELETE,
  LOCALE_GET,
  LOCALE_SAVE,
  LOCALE_CHANGED,
  MODEL_DIR_GET,
  MODEL_DIR_SET,
};