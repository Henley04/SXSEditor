/**
 * IPC Channel Name Constants
 * Centralizes all IPC channel names to prevent typos and enable refactoring.
 */

const IPC_CHANNELS = {
  // ==================== Dialog ====================
  DIALOG_SAVE: 'dialog:showSaveDialog',
  DIALOG_OPEN: 'dialog:showOpenDialog',

  // ==================== File Operations ====================
  FILE_SAVE: 'file:saveFile',
  FILE_READ: 'file:readFile',
  FILE_READ_BUFFER: 'file:readFileBuffer',
  FILE_EXISTS: 'file:exists',
  FILE_AUTHORIZE: 'file:authorizePath',

  // ==================== Window Management ====================
  OPEN_FRAGMENT_EDITOR: 'openFragmentEditor',
  SAVE_FRAGMENT_DATA: 'saveFragmentData',
  SAVE_FRAGMENT_DATA_SYNC: 'saveFragmentDataSync',
  GET_FRAGMENT_DATA: 'getFragmentData',
  FRAGMENT_DATA_SAVED: 'fragmentDataSaved',
  LOAD_FRAGMENT: 'loadFragment',
  UPDATE_FRAGMENT_BOUNDS: 'updateFragmentBounds',
  FRAGMENT_BOUNDS_CHANGED: 'fragmentBoundsChanged',
  UPDATE_PROJECT_SETTINGS: 'updateProjectSettings',
  PROJECT_SETTINGS_CHANGED: 'projectSettingsChanged',
  OPEN_SINGER_CREATOR: 'openSingerCreator',
  SAVE_SINGER_FILE: 'saveSingerFile',
  SINGER_CREATED: 'singerCreated',
  OPEN_AUDIO_PREPROCESS: 'openAudioPreprocess',
  SEND_PREPROCESS_DATA: 'sendPreprocessData',
  PREPROCESS_DATA_SAVED: 'preprocessDataSaved',
  LOAD_PREPROCESS_DATA: 'loadPreprocessData',
  SET_DIRTY: 'set-dirty',
  CLOSE_CONFIRMED: 'close-confirmed',
  CLOSE_CONFIRM: 'close-confirm',
  RELOAD_MAIN_WINDOW: 'reload-main-window',

  // ==================== SVS Pipeline ====================
  SVS_INIT: 'svs:init',
  SVS_SYNTHESIZE: 'svs:synthesize',
  SVS_DISPOSE: 'svs:dispose',
  SVS_CHECK_JP_MODELS: 'svs:checkJpModels',
  FRAGMENT_SVS_GET_SAMPLE_RATE: 'fragment-svs:getSampleRate',
  FRAGMENT_SVS_INIT: 'fragment-svs:init',
  FRAGMENT_SVS_SYNTHESIZE: 'fragment-svs:synthesize',
  FRAGMENT_SVS_DISPOSE: 'fragment-svs:dispose',
  FRAGMENT_SVS_RESOLVE_PHONEMES: 'fragment-svs:resolvePhonemes',
  FRAGMENT_SVS_PROGRESS: 'fragment-svs:progress',

  // ==================== Pitch & MIDI ====================
  EXTRACT_F0_ONNX: 'extractF0:onnx',
  EXTRACT_MIDI_ROSVOT: 'extractMidi:rosvot',
  EXTRACT_F0_BASIC_PITCH: 'extractF0:basicPitch',
  MIDI_IMPORT: 'midi:import',
  MIDI_IMPORT_MULTI_TRACK: 'midi:importMultiTrack',

  // ==================== Path Utilities ====================
  RESOLVE_PATH: 'resolvePath',
  GET_DIR_NAME: 'getDirName',

  // ==================== Settings ====================
  SETTINGS_GET_DML_DEVICES: 'settings:getDMLDevices',
  SETTINGS_GET_HARDWARE_STATUS: 'settings:getHardwareStatus',
  SETTINGS_GET_CURRENT_HARDWARE: 'settings:getCurrentHardware',
  SETTINGS_GET: 'settings:getSettings',
  SETTINGS_SAVE: 'settings:saveSettings',
  SETTINGS_CHECK_MODELS: 'settings:check-models',
  SETTINGS_VALIDATE_DEVICES: 'settings:validateDevices',
  APP_GET_VERSION: 'app:getVersion',
  GET_MODEL_DIR: 'getModelDir',

  // ==================== Audio ====================
  AUDIO_GET_DEVICES: 'audio:getDevices',
  AUDIO_PLAY: 'audio:play',
  AUDIO_STOP: 'audio:stop',
  AUDIO_GET_POSITION: 'audio:getPosition',
  AUDIO_IS_AVAILABLE: 'audio:isAvailable',
  AUDIO_ENDED: 'audio:ended',

  // ==================== Model Download ====================
  MODEL_DOWNLOAD_MISSING_FILES: 'model-download:missing-files',
  MODEL_DOWNLOAD_PROGRESS: 'model-download:progress',
  MODEL_DOWNLOAD_FILE_START: 'model-download:file-start',
  MODEL_DOWNLOAD_FILE_COMPLETE: 'model-download:file-complete',
  MODEL_DOWNLOAD_COMPLETE: 'model-download:complete',
  MODEL_DOWNLOAD_ERROR: 'model-download:error',
  MODEL_DOWNLOAD_PRECISION: 'model-download:precision',
  MODEL_DOWNLOAD_START: 'model-download:start',
  MODEL_DOWNLOAD_CANCEL: 'model-download:cancel',
  MODEL_DOWNLOAD_CHECK: 'model-download:check',
  MODEL_DOWNLOAD_CHANGE_DIR: 'model-download:change-dir',
  MODEL_DOWNLOAD_GET_DIR: 'model-download:get-dir',
  MODEL_DOWNLOAD_OPEN: 'model-download:open',
  MODEL_DOWNLOAD_DELETE_AND_RECHECK: 'model-download:delete-and-recheck',
  MODEL_DOWNLOAD_RECHECK: 'model-download:recheck',
  MODEL_DOWNLOAD_CHECK_JP: 'model-download:check-jp',
  MODEL_DOWNLOAD_START_JP: 'model-download:start-jp',
  MODEL_DOWNLOAD_CHECK_JP_EXISTS: 'model-download:check-jp-exists',
  MODEL_DOWNLOAD_LIST_VERSIONS: 'model-download:list-versions',
  MODEL_DOWNLOAD_LIST_JP_VERSIONS: 'model-download:list-jp-versions',
  MODEL_DOWNLOAD_LIST_SIFIGAN_VERSIONS: 'model-download:list-sifigan-versions',
  MODEL_DOWNLOAD_OPEN_EXTERNAL: 'model-download:open-external',
  MODEL_DOWNLOAD_REVISION: 'model-download:revision',

  // ==================== Locale ====================
  SAVE_LOCALE: 'save-locale',
  GET_LOCALE: 'get-locale',
  LOCALE_CHANGED: 'locale-changed',

  // ==================== Resource Manager ====================
  RESMGR_OPEN: 'resmgr:open',
  RESMGR_GET_GPU_INFO: 'resmgr:getGPUInfo',
  RESMGR_GET_MODEL_GROUPS: 'resmgr:getModelGroups',
  RESMGR_LOAD_MODEL: 'resmgr:loadModel',
  RESMGR_UNLOAD_MODEL: 'resmgr:unloadModel',
  RESMGR_LOAD_GROUP: 'resmgr:loadGroup',
  RESMGR_UNLOAD_GROUP: 'resmgr:unloadGroup',

  // ==================== WebNN / NPU ====================
  WEBNN_DETECT_NPU: 'webnn:detectNPU',
  WEBNN_LOAD_MODEL: 'webnn:loadModel',
  WEBNN_UNLOAD_MODEL: 'webnn:unloadModel',
  WEBNN_RUN_INFERENCE: 'webnn:runInference',
  WEBNN_GET_STATUS: 'webnn:getStatus',
  WEBNN_READ_MODEL_FILE: 'webnn:readModelFile',
  WEBNN_READ_MODEL_FILE_REPLY: 'webnn:readModelFile:reply',
  WEBNN_RUN_SYNTHESIS: 'webnn:runSynthesis',

  // WebNN renderer request channels (main → renderer)
  WEBNN_DETECT_NPU_REQUEST: 'webnn:detectNPU:request',
  WEBNN_LOAD_MODEL_REQUEST: 'webnn:loadModel:request',
  WEBNN_UNLOAD_MODEL_REQUEST: 'webnn:unloadModel:request',
  WEBNN_RUN_INFERENCE_REQUEST: 'webnn:runInference:request',
  WEBNN_GET_STATUS_REQUEST: 'webnn:getStatus:request',
  WEBNN_RUN_SYNTHESIS_REQUEST: 'webnn:runSynthesis:request',
  WEBNN_PREFETCH_REQUEST: 'webnn:prefetch:request',

  // ==================== Theme ====================
  THEME_BOOTSTRAP: 'theme:bootstrap',
  THEME_LIST: 'theme:list',
  THEME_GET: 'theme:get',
  THEME_CURRENT: 'theme:current',
  THEME_APPLY: 'theme:apply',
  THEME_SAVE: 'theme:save',
  THEME_DELETE: 'theme:delete',
  THEME_IMPORT: 'theme:import',
  THEME_EXPORT: 'theme:export',
  THEME_RESET: 'theme:reset',
  THEME_CHANGED: 'theme:changed',
  THEME_LIST_CHANGED: 'theme:list-changed',

  // ==================== Update ====================
  UPDATE_CHECK_NOW: 'update:check-now',
  UPDATE_GET_STATUS: 'update:get-status',
  UPDATE_SKIP_VERSION: 'update:skip-version',
  UPDATE_DONT_REMIND: 'update:dont-remind',
  UPDATE_OPEN_DOWNLOAD_PAGE: 'update:open-download-page',
  UPDATE_OPEN_MODEL_DOWNLOAD: 'update:open-model-download',
  UPDATE_NOTIFICATION_SHOW: 'update:notification-show',
};

module.exports = { IPC_CHANNELS };
