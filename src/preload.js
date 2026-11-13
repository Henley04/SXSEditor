const { contextBridge, ipcRenderer } = require('electron');
const { IPC_CHANNELS } = require('./shared/ipcChannels');
let heavyIpcReadyPromise;
async function invokeHeavy(channel,...args){if(!heavyIpcReadyPromise)heavyIpcReadyPromise=ipcRenderer.invoke(IPC_CHANNELS.APP_WAIT_FOR_HEAVY_IPC);const result=await heavyIpcReadyPromise;if(!result?.success)throw new Error(result?.error||'Deferred IPC initialization failed');return ipcRenderer.invoke(channel,...args);}

// Forward renderer errors to the main process for centralized logging.
// Runs in the preload's isolated world, but DOM event listeners added via
// window.addEventListener still catch errors thrown from the main world
// (with contextIsolation: true). This catches window.onerror,
// unhandledrejection, and console.error — the most common sources of silent
// renderer failures — and persists them to the same log file used by the
// main process. This runs before contextBridge.exposeInMainWorld so it
// applies to every renderer (main, fragment, settings, modelDownload,
// resourceManager, singerCreator, audioPreprocess, updateNotification)
// without any per-window setup.
(function attachRendererErrorForwarding() {
  try {
    const fmt = (e) => {
      if (e instanceof Error) return e.stack || e.message;
      if (typeof e === 'object' && e !== null) {
        try { return JSON.stringify(e); } catch { return String(e); }
      }
      return String(e);
    };
    const fwd = (level, message) => {
      try { ipcRenderer.send(IPC_CHANNELS.CRASH_LOG, { level, source: 'renderer', message }); } catch (_) {}
    };
    window.addEventListener('error', (event) => {
      const where = `${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}`;
      fwd('ERROR', `[window.onerror] ${event.message || ''} @ ${where}` + (event.error ? '\n' + fmt(event.error) : ''));
    });
    window.addEventListener('unhandledrejection', (event) => {
      fwd('ERROR', `[unhandledrejection] ${fmt(event.reason)}`);
    });
    const origConsoleError = console.error.bind(console);
    console.error = (...args) => {
      try { fwd('ERROR', args.map(fmt).join(' ')); } catch (_) {}
      try { origConsoleError(...args); } catch (_) {}
    };
  } catch (_) {}
})();

let _webnnReadModelFileReqId = 0;

// ---------------------------------------------------------------------------
// A4：按窗口裁剪高危能力
//
// 10 个窗口共用这一个 preload，于是每个渲染进程都拿到了 155+ 个方法的全集 ——
// 连"更新通知"和"启动闪屏"这种纯展示窗口都持有 file:saveFile、shell:open-external、
// plugin:synthesize。任何一个窗口被 XSS/恶意内容拿下，就能直接写任意已授权路径、
// 打开外部链接、发起合成。
//
// 这里按窗口做**最小权限**裁剪：
//   · 识别不出当前窗口（例如未来新增的入口）→ 不裁剪，保持全量，不冒险；
//   · 被裁剪的方法替换成抛明确错误的函数，而不是 undefined —— 万一白名单漏了，
//     会立刻在控制台看到"哪个窗口缺哪个能力"，而不是一个莫名的 undefined 报错。
// ---------------------------------------------------------------------------
const { windowIdFromPath, applyWindowCapabilityRedaction } = require('./shared/windowCapabilities');

const WINDOW_ID = (() => {
  try {
    return windowIdFromPath(location.pathname);
  } catch (_) {
    return null;
  }
})();

function redactApi(api) {
  // 无法识别窗口（例如未来新增的入口）→ 不裁剪，保持全量，不冒险
  return applyWindowCapabilityRedaction(api, WINDOW_ID);
}

const _fullElectronAPI = {
  onMcpAutomationRequest: callback => { const h=(_e,m)=>callback(m); ipcRenderer.on(IPC_CHANNELS.MCP_AUTOMATION_REQUEST,h); return ()=>ipcRenderer.removeListener(IPC_CHANNELS.MCP_AUTOMATION_REQUEST,h); },
  sendMcpAutomationResponse: message => ipcRenderer.send(IPC_CHANNELS.MCP_AUTOMATION_RESPONSE,message),
  sendMcpAutomationEvent: event => ipcRenderer.send(IPC_CHANNELS.MCP_AUTOMATION_EVENT,event),
  showSaveDialog: (options) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SAVE, options),
  showOpenDialog: (options) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN, options),
  // 系统投递进来的文件（双击 / 打开方式）。take 取走即清空，重复调用只会拿到一次。
  takePendingOpenFile: () => ipcRenderer.invoke(IPC_CHANNELS.APP_TAKE_PENDING_FILE),
  onFileRequested: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.APP_FILE_REQUESTED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_FILE_REQUESTED, handler);
  },
  openSingerFileAt: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.SINGER_OPEN_AT, filePath),
  saveFile: (filePath, data) => ipcRenderer.invoke(IPC_CHANNELS.FILE_SAVE, filePath, data),
  readFile: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, filePath),
  readFileBuffer: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_BUFFER, filePath),
  fileExists: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.FILE_EXISTS, filePath),
  authorizePath: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.FILE_AUTHORIZE, filePath),
  openFragmentEditor: (data) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_FRAGMENT_EDITOR, data),
  saveFragmentData: (fragmentId, data) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_FRAGMENT_DATA, fragmentId, data),
  saveFragmentDataSync: (fragmentId, data) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_FRAGMENT_DATA_SYNC, fragmentId, data),
  getFragmentData: (fragmentId) => ipcRenderer.invoke(IPC_CHANNELS.GET_FRAGMENT_DATA, fragmentId),
  closeFragmentEditor: (fragmentId) => ipcRenderer.invoke(IPC_CHANNELS.FRAGMENT_CLOSE, fragmentId),
  closeAllFragmentEditors: () => ipcRenderer.invoke(IPC_CHANNELS.FRAGMENT_CLOSE_ALL),
  onFragmentSaved: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.FRAGMENT_DATA_SAVED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FRAGMENT_DATA_SAVED, handler);
  },
  onLoadFragment: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.LOAD_FRAGMENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.LOAD_FRAGMENT, handler);
  },
  // 主窗口侧改完分片数据后推给已打开的编辑器（MCP / 自动流程用）
  pushFragmentPatch: (fragmentId, patch) => ipcRenderer.invoke(IPC_CHANNELS.PUSH_FRAGMENT_PATCH, fragmentId, patch),
  onFragmentDataPatched: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.FRAGMENT_DATA_PATCH, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FRAGMENT_DATA_PATCH, handler);
  },
  updateFragmentBounds: (fragmentId, data) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_FRAGMENT_BOUNDS, fragmentId, data),
  onFragmentBoundsChanged: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.FRAGMENT_BOUNDS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FRAGMENT_BOUNDS_CHANGED, handler);
  },
  updateProjectSettings: (projectData) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_PROJECT_SETTINGS, projectData),
  onProjectSettingsChanged: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.PROJECT_SETTINGS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PROJECT_SETTINGS_CHANGED, handler);
  },
  openSingerCreator: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_SINGER_CREATOR),
  // 打开已有 .sxssinger 进入「歌手编辑」：沿用预处理窗口，保存时写回原文件。
  openSingerEditor: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_SINGER_EDITOR),
  onSingerUpdated: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SINGER_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SINGER_UPDATED, handler);
  },
  openSingerMarket: () => ipcRenderer.invoke('openSingerMarket'),
  saveSingerFile: (singerData) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_SINGER_FILE, singerData),
  onSingerCreatorSaveRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.SINGER_CREATOR_SAVE_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SINGER_CREATOR_SAVE_REQUEST, handler);
  },
  onSingerCreatorSaveAsRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.SINGER_CREATOR_SAVE_AS_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SINGER_CREATOR_SAVE_AS_REQUEST, handler);
  },
  onSingerCreated: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SINGER_CREATED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SINGER_CREATED, handler);
  },
  openAudioPreprocess: (data) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_AUDIO_PREPROCESS, data),
  sendPreprocessData: (data) => ipcRenderer.invoke(IPC_CHANNELS.SEND_PREPROCESS_DATA, data),
  onPreprocessDataSaved: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.PREPROCESS_DATA_SAVED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PREPROCESS_DATA_SAVED, handler);
  },
  onLoadPreprocessData: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.LOAD_PREPROCESS_DATA, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.LOAD_PREPROCESS_DATA, handler);
  },
  getModelDir: () => ipcRenderer.invoke(IPC_CHANNELS.GET_MODEL_DIR),
  initSVSPipeline: (options) => invokeHeavy('svs:init', options),
  synthesizeSVS: (data) => invokeHeavy('svs:synthesize', data),
  synthesizeMultiStreaming: (data) => invokeHeavy('svs:synthesizeMultiStreaming', data),
  cancelSVSSynthesis: () => invokeHeavy('svs:cancel'),
  disposeSVSPipeline: () => invokeHeavy('svs:dispose'),
  onSVSProgress: (callback) => {
    const handler = (event, data) => callback(data.progress);
    ipcRenderer.on(IPC_CHANNELS.SVS_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SVS_PROGRESS, handler);
  },
  // 模型加载进度（svs:loadProgress）：{ stage, percent, current, total, name }
  onSVSLoadProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SVS_LOAD_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SVS_LOAD_PROGRESS, handler);
  },
  onSVSChunkAudio: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SVS_CHUNK_AUDIO, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SVS_CHUNK_AUDIO, handler);
  },
  onSVSDiffStepIncompatible: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SVS_MODEL_INCOMPATIBLE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SVS_MODEL_INCOMPATIBLE, handler);
  },
  getFragmentSVSSampleRate: () => invokeHeavy('fragment-svs:getSampleRate'),
  initFragmentSVSPipeline: (options) => invokeHeavy('fragment-svs:init', options),
  synthesizeFragmentSVS: async (data) => {
    const result = await invokeHeavy('fragment-svs:synthesize', data);
    if (result.error) {
      throw new Error(result.error);
    }
    return result.data;
  },
  resolvePhonemes: (lyrics) => invokeHeavy('fragment-svs:resolvePhonemes', { lyrics }),
  disposeFragmentSVSPipeline: () => invokeHeavy('fragment-svs:dispose'),
  onFragmentSVSProgress: (callback) => {
    const handler = (event, data) => callback(data.progress);
    ipcRenderer.on(IPC_CHANNELS.FRAGMENT_SVS_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FRAGMENT_SVS_PROGRESS, handler);
  },
  onFragmentSVSChunkAudio: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.FRAGMENT_SVS_CHUNK_AUDIO, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FRAGMENT_SVS_CHUNK_AUDIO, handler);
  },
  extractF0: (data) => invokeHeavy('extractF0:onnx', data),
  extractMidiRosvot: (data) => invokeHeavy('extractMidi:rosvot', data),
  extractF0BasicPitch: (data) => invokeHeavy('extractF0:basicPitch', data),
  extractMidiFcpe: (data) => invokeHeavy('extractMidi:fcpe', data),
  importMidi: () => ipcRenderer.invoke(IPC_CHANNELS.MIDI_IMPORT),
  importMidiMultiTrack: () => ipcRenderer.invoke(IPC_CHANNELS.MIDI_IMPORT_MULTI_TRACK),
  resolvePath: (basePath, relativePath) => ipcRenderer.invoke(IPC_CHANNELS.RESOLVE_PATH, basePath, relativePath),
  getDirName: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.GET_DIR_NAME, filePath),
  showItemInFolder: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_SHOW_ITEM_IN_FOLDER, filePath),
  // Open an allowed https URL (arXiv / GitHub etc.) in the system browser.
  // Used by the Settings → About page (license / papers / acknowledgments).
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url),
  getDMLDevices: (options = {}) => invokeHeavy('settings:getDMLDevices', options),
  getWinmlProviders: (options = {}) => invokeHeavy('settings:getWinmlProviders', options),
  getHardwareStatus: () => invokeHeavy('settings:getHardwareStatus'),
  getCurrentHardware: () => invokeHeavy('settings:getCurrentHardware'),
  getVocoderChunkFramesInfo: () => invokeHeavy('settings:getVocoderChunkFramesInfo'),
  getVocoderChunkFramesTable: () => invokeHeavy('settings:getVocoderChunkFramesTable'),
  getSettings: () => invokeHeavy('settings:getSettings'),
  saveSettings: (settings) => invokeHeavy('settings:saveSettings', settings),
  checkModels: () => invokeHeavy('settings:check-models'),
  runTrtRtxDiagnostic: () => invokeHeavy('settings:run-trtrtx-diagnostic'),
  clearInferenceCaches: () => invokeHeavy(IPC_CHANNELS.SETTINGS_CLEAR_INFERENCE_CACHE),
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),
  getAudioDevices: () => invokeHeavy('audio:getDevices'),
  audioPlay: (audioData, options) => invokeHeavy('audio:play', { audioData, options }),
  audioStop: () => invokeHeavy('audio:stop'),
  audioGetPosition: () => invokeHeavy('audio:getPosition'),
  audioIsAvailable: () => invokeHeavy('audio:isAvailable'),
  onAudioEnded: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AUDIO_ENDED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AUDIO_ENDED, handler);
  },
  onModelDownloadMissingFiles: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MODEL_DOWNLOAD_MISSING_FILES, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MODEL_DOWNLOAD_MISSING_FILES, handler);
  },
  onModelDownloadProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MODEL_DOWNLOAD_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MODEL_DOWNLOAD_PROGRESS, handler);
  },
  onModelDownloadFileStart: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MODEL_DOWNLOAD_FILE_START, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MODEL_DOWNLOAD_FILE_START, handler);
  },
  onModelDownloadFileComplete: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MODEL_DOWNLOAD_FILE_COMPLETE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MODEL_DOWNLOAD_FILE_COMPLETE, handler);
  },
  onModelDownloadComplete: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MODEL_DOWNLOAD_COMPLETE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MODEL_DOWNLOAD_COMPLETE, handler);
  },
  onModelDownloadError: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MODEL_DOWNLOAD_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MODEL_DOWNLOAD_ERROR, handler);
  },
  onModelDownloadPrecision: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MODEL_DOWNLOAD_PRECISION, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MODEL_DOWNLOAD_PRECISION, handler);
  },
  // 模型下载窗口关闭事件：用于设置页面刷新模型状态总览区
  onModelDownloadWindowClosed: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MODEL_DOWNLOAD_WINDOW_CLOSED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MODEL_DOWNLOAD_WINDOW_CLOSED, handler);
  },
  onModelDownloadRevision: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MODEL_DOWNLOAD_REVISION, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MODEL_DOWNLOAD_REVISION, handler);
  },
  modelDownloadStart: (precision, revision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_START, precision, revision),
  modelDownloadCancel: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_CANCEL),
  modelDownloadCheck: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_CHECK),
  modelDownloadChangeDir: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_CHANGE_DIR),
  modelDownloadGetDir: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_GET_DIR),
  modelDownloadOpen: (precision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_OPEN, precision),
  modelDownloadDeleteAndRecheck: (precision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_DELETE_AND_RECHECK, precision),
  modelDownloadRecheck: (precision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_RECHECK, precision),
  // JP model download
  modelDownloadCheckJp: (precision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_CHECK_JP, precision),
  modelDownloadStartJp: (precision, revision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_START_JP, precision, revision),
  modelDownloadCheckJpExists: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_CHECK_JP_EXISTS),
  // SiFiGAN (optional vocoder) download/unload
  modelDownloadCheckSifigan: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_CHECK_SIFIGAN),
  modelDownloadStartSifigan: (revision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_START_SIFIGAN, revision),
  modelDownloadUnloadSifigan: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_UNLOAD_SIFIGAN),
  // FCPE (optional pitch detector) download/unload
  modelDownloadCheckFcpe: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_CHECK_FCPE),
  modelDownloadStartFcpe: (revision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_START_FCPE, revision),
  modelDownloadUnloadFcpe: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_UNLOAD_FCPE),
  // Model version management
  modelDownloadCheckVersion: (precision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_CHECK_VERSION, precision),
  modelDownloadCheckJpVersion: (precision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_CHECK_JP_VERSION, precision),
  modelDownloadCheckSifiganVersion: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_CHECK_SIFIGAN_VERSION),
  modelDownloadCheckFcpeVersion: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_CHECK_FCPE_VERSION),
  modelDownloadCheckAllVersions: (precision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_CHECK_ALL_VERSIONS, precision),
  modelDownloadUpdate: (precision, revision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_UPDATE, precision, revision),
  modelDownloadUpdateJp: (precision, revision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_UPDATE_JP, precision, revision),
  modelDownloadUpdateSifigan: (revision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_UPDATE_SIFIGAN, revision),
  modelDownloadUpdateFcpe: (revision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_UPDATE_FCPE, revision),
  // Version listing (fetch available branches from ModelScope)
  modelDownloadListVersions: (precision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_LIST_VERSIONS, precision),
  modelDownloadListJpVersions: (precision) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_LIST_JP_VERSIONS, precision),
  modelDownloadListSifiganVersions: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_LIST_SIFIGAN_VERSIONS),
  // Open external URL (for model-updates docs link)
  modelDownloadOpenExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DOWNLOAD_OPEN_EXTERNAL, url),
  // SVS JP model check
  svsCheckJpModels: () => ipcRenderer.invoke(IPC_CHANNELS.SVS_CHECK_JP_MODELS),
  saveLocale: (locale) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_LOCALE, locale),
  getLocale: () => ipcRenderer.invoke(IPC_CHANNELS.GET_LOCALE),
  reloadMainWindow: () => ipcRenderer.invoke(IPC_CHANNELS.RELOAD_MAIN_WINDOW),
  // 布局尺寸变化通知（DevTools 打开/关闭、窗口 resize 等）。
  // 停靠式 DevTools 关闭后 BrowserWindow 的 bounds 不变，window 'resize'
  // 不一定触发，导致 canvas 仍按旧尺寸绘制 —— 需要主进程显式推送一次。
  onRelayout: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.RELAYOUT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.RELAYOUT, handler);
  },
  onLocaleChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.LOCALE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.LOCALE_CHANGED, handler);
  },
  setDirty: (dirty) => ipcRenderer.invoke(IPC_CHANNELS.SET_DIRTY, dirty),
  onCloseConfirm: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.CLOSE_CONFIRM, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CLOSE_CONFIRM, handler);
  },
  // 模态设置窗口已打开（主进程 → 主窗口）：渲染层应暂停播放，
  // 否则模态期间主窗口输入被禁用而音频继续，用户无法控制。
  onSettingsWindowOpened: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.SETTINGS_WINDOW_OPENED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_WINDOW_OPENED, handler);
  },
  closeConfirmed: () => ipcRenderer.invoke(IPC_CHANNELS.CLOSE_CONFIRMED),
  onMainMenuSaveRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MAIN_MENU_SAVE_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MAIN_MENU_SAVE_REQUEST, handler);
  },
  onMainMenuSaveAsRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MAIN_MENU_SAVE_AS_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MAIN_MENU_SAVE_AS_REQUEST, handler);
  },
  onMainMenuExportMidiRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MAIN_MENU_EXPORT_MIDI_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MAIN_MENU_EXPORT_MIDI_REQUEST, handler);
  },
  onMainMenuMcpSetupRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MAIN_MENU_MCP_SETUP_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MAIN_MENU_MCP_SETUP_REQUEST, handler);
  },
  mcpSetupGetInfo: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_SETUP_GET_INFO),
  // 资源管理器
  resmgrOpen: () => ipcRenderer.invoke(IPC_CHANNELS.RESMGR_OPEN),
  resmgrGetGPUInfo: () => ipcRenderer.invoke(IPC_CHANNELS.RESMGR_GET_GPU_INFO),
  resmgrGetModelGroups: () => ipcRenderer.invoke(IPC_CHANNELS.RESMGR_GET_MODEL_GROUPS),
  resmgrLoadModel: (groupId, modelId) => ipcRenderer.invoke(IPC_CHANNELS.RESMGR_LOAD_MODEL, { groupId, modelId }),
  resmgrUnloadModel: (groupId, modelId) => ipcRenderer.invoke(IPC_CHANNELS.RESMGR_UNLOAD_MODEL, { groupId, modelId }),
  resmgrLoadGroup: (groupId) => ipcRenderer.invoke(IPC_CHANNELS.RESMGR_LOAD_GROUP, { groupId }),
  resmgrUnloadGroup: (groupId) => ipcRenderer.invoke(IPC_CHANNELS.RESMGR_UNLOAD_GROUP, { groupId }),

  // ==================== WebNN / NPU API ====================
  webnnDetectNPU: () => ipcRenderer.invoke(IPC_CHANNELS.WEBNN_DETECT_NPU),
  webnnLoadModel: (modelId, modelPath, options) => ipcRenderer.invoke(IPC_CHANNELS.WEBNN_LOAD_MODEL, modelId, modelPath, options),
  webnnUnloadModel: (modelId) => ipcRenderer.invoke(IPC_CHANNELS.WEBNN_UNLOAD_MODEL, modelId),
  webnnRunInference: (modelId, inputs) => ipcRenderer.invoke(IPC_CHANNELS.WEBNN_RUN_INFERENCE, modelId, inputs),
  webnnGetStatus: () => ipcRenderer.invoke(IPC_CHANNELS.WEBNN_GET_STATUS),
  webnnReadModelFile: (filePath) => {
    return new Promise((resolve, reject) => {
      const reqId = ++_webnnReadModelFileReqId;
      const replyChannel = `webnn:readModelFile:reply:${reqId}`;
      ipcRenderer.once(replyChannel, (_event, result) => {
        if (result && result.success) {
          resolve(result);
        } else {
          reject(new Error(result && result.error ? result.error : 'webnn:readModelFile failed'));
        }
      });
      ipcRenderer.send(IPC_CHANNELS.WEBNN_READ_MODEL_FILE, { filePath, reqId });
    });
  },
  validateDevices: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_VALIDATE_DEVICES),

  // WebNN 渲染进程监听器注册（主进程 → 渲染进程请求）
  onWebnnDetectNPURequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.WEBNN_DETECT_NPU_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBNN_DETECT_NPU_REQUEST, handler);
  },
  onWebnnLoadModelRequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.WEBNN_LOAD_MODEL_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBNN_LOAD_MODEL_REQUEST, handler);
  },
  onWebnnUnloadModelRequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.WEBNN_UNLOAD_MODEL_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBNN_UNLOAD_MODEL_REQUEST, handler);
  },
  onWebnnRunInferenceRequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.WEBNN_RUN_INFERENCE_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBNN_RUN_INFERENCE_REQUEST, handler);
  },
  onWebnnGetStatusRequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.WEBNN_GET_STATUS_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBNN_GET_STATUS_REQUEST, handler);
  },
  onWebnnRunSynthesisRequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.WEBNN_RUN_SYNTHESIS_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBNN_RUN_SYNTHESIS_REQUEST, handler);
  },
  onWebnnPrefetchRequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.WEBNN_PREFETCH_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBNN_PREFETCH_REQUEST, handler);
  },
  // 主进程 clearNPUFailureCache() 通过 'webnn:clearNpuCache' 通知渲染端清掉
  // 本地检测结果缓存。此前 preload 未暴露该桥接，主进程清缓存后渲染端仍会
  // 返回陈旧结果（要等 5 分钟 TTL 才恢复），表现为"换语言模型后 NPU 一直
  // 检测不到"。
  onClearNpuCache: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.WEBNN_CLEAR_NPU_CACHE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBNN_CLEAR_NPU_CACHE, handler);
  },
  // Security: whitelist allowed WebNN response channels to prevent arbitrary IPC invocation
  webnnRespond: (responseChannel, result) => {
    const allowedPrefixes = [
      'webnn:detectNPU:response:',
      'webnn:loadModel:response:',
      'webnn:unloadModel:response:',
      'webnn:runInference:response:',
      'webnn:getStatus:response:',
      'webnn:runSynthesis:response:',
    ];
    if (!allowedPrefixes.some(prefix => responseChannel.startsWith(prefix))) {
      console.error('[Preload] Blocked unauthorized webnnRespond channel:', responseChannel);
      return;
    }
    // Main process listens with ipcMain.on (not handle), so use send only.
    // Using invoke here triggers "No handler registered" in main and an
    // uncaught rejection overlay in the renderer.
    try {
      ipcRenderer.send(responseChannel, result);
    } catch (_) {}
  },
  // Security: whitelist allowed WebNN progress channels
  webnnProgress: (progressChannel, data) => {
    if (!progressChannel.startsWith('webnn:progress:')) {
      console.error('[Preload] Blocked unauthorized webnnProgress channel:', progressChannel);
      return;
    }
    ipcRenderer.send(progressChannel, data);
  },
  // Security: whitelist allowed WebNN chunk-audio channels (流式 vocoder chunk 推送)
  webnnChunk: (chunkChannel, data) => {
    if (!chunkChannel.startsWith('webnn:runSynthesis:response:chunk:')) {
      console.error('[Preload] Blocked unauthorized webnnChunk channel:', chunkChannel);
      return;
    }
    ipcRenderer.send(chunkChannel, data);
  },

  // ==================== Theme API ====================
  themeAPI: {
    bootstrap: () => ipcRenderer.invoke(IPC_CHANNELS.THEME_BOOTSTRAP),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.THEME_LIST),
    get: (themeId) => ipcRenderer.invoke(IPC_CHANNELS.THEME_GET, themeId),
    current: (options) => ipcRenderer.invoke(IPC_CHANNELS.THEME_CURRENT, options || {}),
    apply: (themeId, options) => ipcRenderer.invoke(IPC_CHANNELS.THEME_APPLY, themeId, options || {}),
    save: (themeObj) => ipcRenderer.invoke(IPC_CHANNELS.THEME_SAVE, themeObj),
    delete: (themeId) => ipcRenderer.invoke(IPC_CHANNELS.THEME_DELETE, themeId),
    import: () => ipcRenderer.invoke(IPC_CHANNELS.THEME_IMPORT),
    export: (themeId) => ipcRenderer.invoke(IPC_CHANNELS.THEME_EXPORT, themeId),
    reset: () => ipcRenderer.invoke(IPC_CHANNELS.THEME_RESET),
    onChanged: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.THEME_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.THEME_CHANGED, handler);
    },
    onListChanged: (callback) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.THEME_LIST_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.THEME_LIST_CHANGED, handler);
    },
  },

  // ==================== Update API ====================
  updateAPI: {
    checkNow: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK_NOW),
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_GET_STATUS),
    skipVersion: (version) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SKIP_VERSION, version),
    dontRemind: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DONT_REMIND),
    openDownloadPage: (url) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_OPEN_DOWNLOAD_PAGE, url),
    openModelDownload: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_OPEN_MODEL_DOWNLOAD),
    // In-app installer download
    downloadInstaller: (url, version) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD_INSTALLER, { url, version }),
    cancelDownload: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CANCEL_DOWNLOAD),
    installInstaller: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_INSTALL_INSTALLER, { filePath }),
    onDownloadProgress: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, handler);
    },
    onDownloadComplete: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_DOWNLOAD_COMPLETE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_DOWNLOAD_COMPLETE, handler);
    },
    onDownloadError: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_DOWNLOAD_ERROR, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_DOWNLOAD_ERROR, handler);
    },
    onNotificationShow: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_NOTIFICATION_SHOW, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_NOTIFICATION_SHOW, handler);
    },
  },

  // ==================== Singer Market API ====================
  // Proxy to the Cloudflare Workers backend. The Bearer token never
  // leaves the main process; the renderer only sees the high-level
  // { success, data, error } results.
  singerMarket: {
    login: (username, password) => ipcRenderer.invoke(IPC_CHANNELS.SINGER_MARKET_LOGIN, { username, password }),
    register: (username, password) => ipcRenderer.invoke(IPC_CHANNELS.SINGER_MARKET_REGISTER, { username, password }),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.SINGER_MARKET_LOGOUT),
    me: () => ipcRenderer.invoke(IPC_CHANNELS.SINGER_MARKET_ME),
    list: (params) => ipcRenderer.invoke(IPC_CHANNELS.SINGER_MARKET_LIST, params),
    fileDetail: (fileId) => ipcRenderer.invoke(IPC_CHANNELS.SINGER_MARKET_FILE_DETAIL, fileId),
    tags: (params) => ipcRenderer.invoke(IPC_CHANNELS.SINGER_MARKET_TAGS, params),
    licenses: () => ipcRenderer.invoke(IPC_CHANNELS.SINGER_MARKET_LICENSES),
    upload: (payload) => ipcRenderer.invoke(IPC_CHANNELS.SINGER_MARKET_UPLOAD, payload),
    download: (fileId) => ipcRenderer.invoke(IPC_CHANNELS.SINGER_MARKET_DOWNLOAD, fileId),
    // Subscribe to download progress events from the main process.
    // Returns an unsubscribe function.
    onDownloadProgress: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.SINGER_MARKET_DOWNLOAD_PROGRESS, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SINGER_MARKET_DOWNLOAD_PROGRESS, listener);
    },
    pickFile: () => ipcRenderer.invoke(IPC_CHANNELS.SINGER_MARKET_PICK_FILE),
    pickSavePath: (suggestedName) => ipcRenderer.invoke(IPC_CHANNELS.SINGER_MARKET_PICK_SAVE_PATH, suggestedName),
  },

  // ==================== Plugin Host API（第三方歌声后端） ====================
  // 插件跑在主进程内：options 以同一引用交给插件，因此这里不做任何结构化拷贝，
  // 参数怎么传给内置 pipeline 的就怎么传给插件。
  pluginAPI: {
    // 列出已加载插件（含 trackKinds 与加载失败清单）
    list: () => invokeHeavy('plugin:list'),
    // 热重载：清 require 缓存 + dispose 旧实例后重新扫描
    reload: () => invokeHeavy('plugin:reload'),
    getVoices: (pluginId, kindId) => invokeHeavy('plugin:getVoices', { pluginId, kindId }),
    // 单次合成：{kindId, pluginId, trackId, notes, bpm, options, params, voiceId, sampleRate}
    synthesize: (request) => invokeHeavy('plugin:synthesize', request || {}),
    getPluginsDir: () => invokeHeavy('plugin:getPluginsDir'),
    openPluginsFolder: () => invokeHeavy('plugin:openPluginsFolder'),
    // 请求取消一个 cancellable 的阻滞 ticket
    cancelTicket: (ticketId) => invokeHeavy('plugin:cancelTicket', { ticketId }),
    // 主进程 → 渲染进程：阻滞播放（插件在合成前/合成中阻塞 UI 并显示信息）
    onBlockingStart: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.PLUGIN_BLOCKING_START, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGIN_BLOCKING_START, handler);
    },
    onBlockingUpdate: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.PLUGIN_BLOCKING_UPDATE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGIN_BLOCKING_UPDATE, handler);
    },
    onBlockingEnd: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.PLUGIN_BLOCKING_END, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGIN_BLOCKING_END, handler);
    },
    // 主进程 → 渲染进程：插件输出通道
    onProgress: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.PLUGIN_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGIN_PROGRESS, handler);
    },
    onAudio: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.PLUGIN_AUDIO, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGIN_AUDIO, handler);
    },
    onDiagnostics: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.PLUGIN_DIAGNOSTICS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGIN_DIAGNOSTICS, handler);
    },
  },

  // ==================== Plugin Host v2（全应用插件） ====================
  // 窄接口：只暴露"列出/安装/卸载/跑命令/面板 RPC/事件"，不暴露任何文件路径或
  // 进程句柄。面板 iframe 的能力由 pluginHost.panelRpc 再收一道（apiScopes）。
  pluginHost: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_LIST),
    admin: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_ADMIN),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_INSTALL),
    installFromPath: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_INSTALL_PATH, filePath),
    uninstall: (id, keepData) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_UNINSTALL, id, !!keepData),
    // ---- M6：签名与信任 ----
    // 信任的是**公钥指纹**，不是包自称的发布者名。管理器把指纹显示给用户核对。
    trustList: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_TRUST_LIST),
    trustAdd: (input) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_TRUST_ADD, input || {}),
    trustRemove: (keyId) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_TRUST_REMOVE, keyId),
    setRequireSignature: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_REQUIRE_SIGNATURE, !!enabled),
    verifyInstall: (id) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_VERIFY_INSTALL, id),
    // ---- M6：市场接口 ----
    // 搜索是"取一次索引、本地过滤"，不逐键发请求；预览一定会下载整包 ——
    // 索引里的签名字段只是源的自述，包内 signature.json 才是判定依据。
    marketSources: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_MARKET_SOURCES),
    marketAddSource: (input) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_MARKET_ADD_SOURCE, input || {}),
    marketRemoveSource: (id) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_MARKET_REMOVE_SOURCE, id),
    marketSearch: (query, options) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_MARKET_SEARCH, query, options || {}),
    marketPreview: (sourceId, pluginId, options) => (
      ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_MARKET_PREVIEW, sourceId, pluginId, options || {})
    ),
    marketInstall: (sourceId, pluginId, options) => (
      ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_MARKET_INSTALL, sourceId, pluginId, options || {})
    ),
    setEnabled: (id, enabled) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_SET_ENABLED, id, !!enabled),
    reload: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_RELOAD),
    runCommand: (commandId, args) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_RUN_COMMAND, commandId, args || {}),
    panelRpc: (request) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_PANEL_RPC, request || {}),
    openPluginsFolder: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_OPEN_DIR),
    getLog: (limit) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_GET_LOG, limit),
    // ---- M2：界面贡献点 ----
    // 设置页读写的只是 manifest 里声明过的表单值；值域收敛在主进程做，
    // 这里不做任何判断（渲染层判权限等于把锁挂在门框上）。
    settingsGet: (pluginId) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_SETTINGS_GET, pluginId),
    settingsSet: (pluginId, patch) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_SETTINGS_SET, pluginId, patch || {}),
    setKeybindings: (pluginId, enabled) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_SET_KEYBINDINGS, pluginId, !!enabled),
    setAutomation: (pluginId, enabled) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_SET_AUTOMATION, pluginId, !!enabled),
    // iframe 地址由主进程 mint：manifest.entry 只在主进程可见
    overlayUrl: (pluginId, overlayId) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_OVERLAY_URL, pluginId, overlayId),
    // 请主窗口把某个面板挂到右侧抽屉（设置分区/管理器用）
    openPanel: (pluginId, panelId) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_OPEN_PANEL_REQUEST, pluginId, panelId),
    // M4 数据面：按扩展名路由到插件 codec，拿回校验过的工程文档。
    // 失败时返回 { ok:false, code, message }（没有插件接管 / 没权限 / 文档非法），
    // 由渲染层决定怎么提示。
    openDocument: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_OPEN_DOCUMENT, filePath),
    // 保存/导出：把当前工程文档交给插件编码，写盘仍由主进程完成。
    saveDocument: (filePath, document, options) => (
      ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_SAVE_DOCUMENT, filePath, document, options || {})
    ),
    fileFilters: (role) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_FILE_FILTERS, role || 'open'),
    // 工程级渲染意图（document.extSchema[*].render）：pipeline 在主进程跑，
    // 这是"这份工程要求谁做后处理"唯一能过去的路。传 null 表示回到默认语义。
    setRenderIntent: (intent) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_SET_RENDER_INTENT, intent || null),
    // 音频导出器：清单 + 执行。音频走结构化克隆（Float32Array 原样过），
    // 不要在这里 JSON 化 —— 14M 个采样点转成数组会慢到用户以为卡死。
    listExporters: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_LIST_EXPORTERS),
    exportAudio: (filePath, ref, audio) => (
      ipcRenderer.invoke(IPC_CHANNELS.PLUGINHOST_EXPORT_AUDIO, filePath, ref || {}, audio || {})
    ),
    // 主进程 → 渲染进程：投影更新 / 插件事件 / 工程写入请求
    onSync: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.PLUGINHOST_SYNC, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGINHOST_SYNC, handler);
    },
    onEvent: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.PLUGINHOST_EVENT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGINHOST_EVENT, handler);
    },
    onProjectApply: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.PLUGINHOST_PROJECT_APPLY, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGINHOST_PROJECT_APPLY, handler);
    },
    sendProjectApplyResult: (payload) => ipcRenderer.send(IPC_CHANNELS.PLUGINHOST_PROJECT_APPLY_RESULT, payload),
    // 菜单点了"打开面板" → 主进程下发已算好的 plugin:// URL，渲染层挂 iframe
    onOpenPanel: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.PLUGINHOST_OPEN_PANEL, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGINHOST_OPEN_PANEL, handler);
    },
  },

  // ==================== 模型调用面（设计方案 §12） ====================
  // 设置页读写端点/绑定/授权/审计；主窗口只参与首次调用的确认。
  // 密钥永远不经过渲染层：这里没有任何"读密钥"的方法，写进去就不再回来。
  models: {
    snapshot: () => ipcRenderer.invoke(IPC_CHANNELS.MODELS_SNAPSHOT),
    upsertEndpoint: (endpoint) => ipcRenderer.invoke(IPC_CHANNELS.MODELS_ENDPOINT_UPSERT, { endpoint: endpoint || {} }),
    removeEndpoint: (id) => ipcRenderer.invoke(IPC_CHANNELS.MODELS_ENDPOINT_REMOVE, { id }),
    bind: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MODELS_BIND, payload || {}),
    unbind: (task, endpointId) => ipcRenderer.invoke(IPC_CHANNELS.MODELS_UNBIND, { task, endpointId }),
    setDefault: (task, endpointId) => ipcRenderer.invoke(IPC_CHANNELS.MODELS_SET_DEFAULT, { task, endpointId }),
    grant: (subject, endpointId, decision, scope) => ipcRenderer.invoke(
      IPC_CHANNELS.MODELS_GRANT, { subject, endpointId, decision, scope },
    ),
    revoke: (subject, endpointId) => ipcRenderer.invoke(IPC_CHANNELS.MODELS_REVOKE, { subject, endpointId }),
    setSettings: (patch) => ipcRenderer.invoke(IPC_CHANNELS.MODELS_SET_SETTINGS, patch || {}),
    audit: (query) => ipcRenderer.invoke(IPC_CHANNELS.MODELS_AUDIT, query || {}),
    // 主进程 → 渲染层：请求确认（渲染层画模态，30s 无响应由主进程判拒）
    onConsentRequest: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.MODELS_CONSENT_REQUEST, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.MODELS_CONSENT_REQUEST, handler);
    },
    consentReply: (requestId, answer) => ipcRenderer.invoke(
      IPC_CHANNELS.MODELS_CONSENT_REPLY, { requestId, answer },
    ),
  },

  // ==================== Crash Reporting API ====================
  // Used by settings/help UI to surface log/dump file locations so users can
  // attach them when filing issues. Log forwarding (window.onerror /
  // unhandledrejection / console.error) is wired up automatically at the top
  // of this file — renderers do not need to call into this API to report errors.
  crashReportAPI: {
    getReportInfo: () => ipcRenderer.invoke(IPC_CHANNELS.CRASH_GET_REPORT_INFO),
    openLogDir: () => ipcRenderer.invoke(IPC_CHANNELS.CRASH_OPEN_LOG_DIR),
    openDumpDir: () => ipcRenderer.invoke(IPC_CHANNELS.CRASH_OPEN_DUMP_DIR),
    log: (level, message) => ipcRenderer.send(IPC_CHANNELS.CRASH_LOG, { level, source: 'renderer', message }),
  },
};

contextBridge.exposeInMainWorld('electronAPI', redactApi(_fullElectronAPI));
