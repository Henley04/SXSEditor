const { contextBridge, ipcRenderer } = require('electron');

let _webnnReadModelFileReqId = 0;

contextBridge.exposeInMainWorld('electronAPI', {
  showSaveDialog: (options) => ipcRenderer.invoke('dialog:showSaveDialog', options),
  showOpenDialog: (options) => ipcRenderer.invoke('dialog:showOpenDialog', options),
  saveFile: (filePath, data) => ipcRenderer.invoke('file:saveFile', filePath, data),
  readFile: (filePath) => ipcRenderer.invoke('file:readFile', filePath),
  readFileBuffer: (filePath) => ipcRenderer.invoke('file:readFileBuffer', filePath),
  fileExists: (filePath) => ipcRenderer.invoke('file:exists', filePath),
  authorizePath: (filePath) => ipcRenderer.invoke('file:authorizePath', filePath),
  openFragmentEditor: (data) => ipcRenderer.invoke('openFragmentEditor', data),
  saveFragmentData: (fragmentId, data) => ipcRenderer.invoke('saveFragmentData', fragmentId, data),
  saveFragmentDataSync: (fragmentId, data) => ipcRenderer.invoke('saveFragmentDataSync', fragmentId, data),
  getFragmentData: (fragmentId) => ipcRenderer.invoke('getFragmentData', fragmentId),
  closeFragmentEditor: (fragmentId) => ipcRenderer.invoke('fragment:close', fragmentId),
  closeAllFragmentEditors: () => ipcRenderer.invoke('fragment:closeAll'),
  onFragmentSaved: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('fragmentDataSaved', handler);
    return () => ipcRenderer.removeListener('fragmentDataSaved', handler);
  },
  onLoadFragment: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('loadFragment', handler);
    return () => ipcRenderer.removeListener('loadFragment', handler);
  },
  updateFragmentBounds: (fragmentId, data) => ipcRenderer.invoke('updateFragmentBounds', fragmentId, data),
  onFragmentBoundsChanged: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('fragmentBoundsChanged', handler);
    return () => ipcRenderer.removeListener('fragmentBoundsChanged', handler);
  },
  updateProjectSettings: (projectData) => ipcRenderer.invoke('updateProjectSettings', projectData),
  onProjectSettingsChanged: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('projectSettingsChanged', handler);
    return () => ipcRenderer.removeListener('projectSettingsChanged', handler);
  },
  openSingerCreator: () => ipcRenderer.invoke('openSingerCreator'),
  openSingerMarket: () => ipcRenderer.invoke('openSingerMarket'),
  saveSingerFile: (singerData) => ipcRenderer.invoke('saveSingerFile', singerData),
  onSingerCreatorSaveRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('singer-creator:save-request', handler);
    return () => ipcRenderer.removeListener('singer-creator:save-request', handler);
  },
  onSingerCreatorSaveAsRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('singer-creator:save-as-request', handler);
    return () => ipcRenderer.removeListener('singer-creator:save-as-request', handler);
  },
  onSingerCreated: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('singerCreated', handler);
    return () => ipcRenderer.removeListener('singerCreated', handler);
  },
  openAudioPreprocess: (data) => ipcRenderer.invoke('openAudioPreprocess', data),
  sendPreprocessData: (data) => ipcRenderer.invoke('sendPreprocessData', data),
  onPreprocessDataSaved: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('preprocessDataSaved', handler);
    return () => ipcRenderer.removeListener('preprocessDataSaved', handler);
  },
  onLoadPreprocessData: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('loadPreprocessData', handler);
    return () => ipcRenderer.removeListener('loadPreprocessData', handler);
  },
  getModelDir: () => ipcRenderer.invoke('getModelDir'),
  initSVSPipeline: () => ipcRenderer.invoke('svs:init'),
  synthesizeSVS: (data) => ipcRenderer.invoke('svs:synthesize', data),
  synthesizeMultiStreaming: (data) => ipcRenderer.invoke('svs:synthesizeMultiStreaming', data),
  disposeSVSPipeline: () => ipcRenderer.invoke('svs:dispose'),
  onSVSProgress: (callback) => {
    const handler = (event, data) => callback(data.progress);
    ipcRenderer.on('svs:progress', handler);
    return () => ipcRenderer.removeListener('svs:progress', handler);
  },
  onSVSChunkAudio: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('svs:chunk-audio', handler);
    return () => ipcRenderer.removeListener('svs:chunk-audio', handler);
  },
  getFragmentSVSSampleRate: () => ipcRenderer.invoke('fragment-svs:getSampleRate'),
  initFragmentSVSPipeline: () => ipcRenderer.invoke('fragment-svs:init'),
  synthesizeFragmentSVS: async (data) => {
    const result = await ipcRenderer.invoke('fragment-svs:synthesize', data);
    if (result.error) {
      throw new Error(result.error);
    }
    return result.data;
  },
  resolvePhonemes: (lyrics) => ipcRenderer.invoke('fragment-svs:resolvePhonemes', { lyrics }),
  disposeFragmentSVSPipeline: () => ipcRenderer.invoke('fragment-svs:dispose'),
  onFragmentSVSProgress: (callback) => {
    const handler = (event, data) => callback(data.progress);
    ipcRenderer.on('fragment-svs:progress', handler);
    return () => ipcRenderer.removeListener('fragment-svs:progress', handler);
  },
  onFragmentSVSChunkAudio: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('fragment-svs:chunk-audio', handler);
    return () => ipcRenderer.removeListener('fragment-svs:chunk-audio', handler);
  },
  extractF0: (data) => ipcRenderer.invoke('extractF0:onnx', data),
  extractMidiRosvot: (data) => ipcRenderer.invoke('extractMidi:rosvot', data),
  extractF0BasicPitch: (data) => ipcRenderer.invoke('extractF0:basicPitch', data),
  importMidi: () => ipcRenderer.invoke('midi:import'),
  importMidiMultiTrack: () => ipcRenderer.invoke('midi:importMultiTrack'),
  resolvePath: (basePath, relativePath) => ipcRenderer.invoke('resolvePath', basePath, relativePath),
  getDirName: (filePath) => ipcRenderer.invoke('getDirName', filePath),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  getDMLDevices: () => ipcRenderer.invoke('settings:getDMLDevices'),
  getHardwareStatus: () => ipcRenderer.invoke('settings:getHardwareStatus'),
  getCurrentHardware: () => ipcRenderer.invoke('settings:getCurrentHardware'),
  getVocoderChunkFramesInfo: () => ipcRenderer.invoke('settings:getVocoderChunkFramesInfo'),
  getVocoderChunkFramesTable: () => ipcRenderer.invoke('settings:getVocoderChunkFramesTable'),
  getSettings: () => ipcRenderer.invoke('settings:getSettings'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:saveSettings', settings),
  checkModels: () => ipcRenderer.invoke('settings:check-models'),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  getAudioDevices: () => ipcRenderer.invoke('audio:getDevices'),
  audioPlay: (audioData, options) => ipcRenderer.invoke('audio:play', { audioData, options }),
  audioStop: () => ipcRenderer.invoke('audio:stop'),
  audioGetPosition: () => ipcRenderer.invoke('audio:getPosition'),
  audioIsAvailable: () => ipcRenderer.invoke('audio:isAvailable'),
  onAudioEnded: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('audio:ended', handler);
    return () => ipcRenderer.removeListener('audio:ended', handler);
  },
  onModelDownloadMissingFiles: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('model-download:missing-files', handler);
    return () => ipcRenderer.removeListener('model-download:missing-files', handler);
  },
  onModelDownloadProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('model-download:progress', handler);
    return () => ipcRenderer.removeListener('model-download:progress', handler);
  },
  onModelDownloadFileStart: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('model-download:file-start', handler);
    return () => ipcRenderer.removeListener('model-download:file-start', handler);
  },
  onModelDownloadFileComplete: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('model-download:file-complete', handler);
    return () => ipcRenderer.removeListener('model-download:file-complete', handler);
  },
  onModelDownloadComplete: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('model-download:complete', handler);
    return () => ipcRenderer.removeListener('model-download:complete', handler);
  },
  onModelDownloadError: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('model-download:error', handler);
    return () => ipcRenderer.removeListener('model-download:error', handler);
  },
  onModelDownloadPrecision: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('model-download:precision', handler);
    return () => ipcRenderer.removeListener('model-download:precision', handler);
  },
  // 模型下载窗口关闭事件：用于设置页面刷新模型状态总览区
  onModelDownloadWindowClosed: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('model-download:window-closed', handler);
    return () => ipcRenderer.removeListener('model-download:window-closed', handler);
  },
  onModelDownloadRevision: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('model-download:revision', handler);
    return () => ipcRenderer.removeListener('model-download:revision', handler);
  },
  modelDownloadStart: (precision, revision) => ipcRenderer.invoke('model-download:start', precision, revision),
  modelDownloadCancel: () => ipcRenderer.invoke('model-download:cancel'),
  modelDownloadCheck: () => ipcRenderer.invoke('model-download:check'),
  modelDownloadChangeDir: () => ipcRenderer.invoke('model-download:change-dir'),
  modelDownloadGetDir: () => ipcRenderer.invoke('model-download:get-dir'),
  modelDownloadOpen: (precision) => ipcRenderer.invoke('model-download:open', precision),
  modelDownloadDeleteAndRecheck: (precision) => ipcRenderer.invoke('model-download:delete-and-recheck', precision),
  modelDownloadRecheck: (precision) => ipcRenderer.invoke('model-download:recheck', precision),
  // JP model download
  modelDownloadCheckJp: (precision) => ipcRenderer.invoke('model-download:check-jp', precision),
  modelDownloadStartJp: (precision, revision) => ipcRenderer.invoke('model-download:start-jp', precision, revision),
  modelDownloadCheckJpExists: () => ipcRenderer.invoke('model-download:check-jp-exists'),
  // SiFiGAN (optional vocoder) download/unload
  modelDownloadCheckSifigan: () => ipcRenderer.invoke('model-download:check-sifigan'),
  modelDownloadStartSifigan: (revision) => ipcRenderer.invoke('model-download:start-sifigan', revision),
  modelDownloadUnloadSifigan: () => ipcRenderer.invoke('model-download:unload-sifigan'),
  // Model version management
  modelDownloadCheckVersion: (precision) => ipcRenderer.invoke('model-download:check-version', precision),
  modelDownloadCheckJpVersion: (precision) => ipcRenderer.invoke('model-download:check-jp-version', precision),
  modelDownloadCheckSifiganVersion: () => ipcRenderer.invoke('model-download:check-sifigan-version'),
  modelDownloadCheckAllVersions: (precision) => ipcRenderer.invoke('model-download:check-all-versions', precision),
  modelDownloadUpdate: (precision, revision) => ipcRenderer.invoke('model-download:update', precision, revision),
  modelDownloadUpdateJp: (precision, revision) => ipcRenderer.invoke('model-download:update-jp', precision, revision),
  modelDownloadUpdateSifigan: (revision) => ipcRenderer.invoke('model-download:update-sifigan', revision),
  // Version listing (fetch available branches from ModelScope)
  modelDownloadListVersions: (precision) => ipcRenderer.invoke('model-download:list-versions', precision),
  modelDownloadListJpVersions: (precision) => ipcRenderer.invoke('model-download:list-jp-versions', precision),
  modelDownloadListSifiganVersions: () => ipcRenderer.invoke('model-download:list-sifigan-versions'),
  // Open external URL (for model-updates docs link)
  modelDownloadOpenExternal: (url) => ipcRenderer.invoke('model-download:open-external', url),
  // SVS JP model check
  svsCheckJpModels: () => ipcRenderer.invoke('svs:checkJpModels'),
  saveLocale: (locale) => ipcRenderer.invoke('save-locale', locale),
  getLocale: () => ipcRenderer.invoke('get-locale'),
  reloadMainWindow: () => ipcRenderer.invoke('reload-main-window'),
  onLocaleChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('locale-changed', handler);
    return () => ipcRenderer.removeListener('locale-changed', handler);
  },
  setDirty: (dirty) => ipcRenderer.invoke('set-dirty', dirty),
  onCloseConfirm: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('close-confirm', handler);
    return () => ipcRenderer.removeListener('close-confirm', handler);
  },
  closeConfirmed: () => ipcRenderer.invoke('close-confirmed'),
  onMainMenuSaveRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('main-menu:save-request', handler);
    return () => ipcRenderer.removeListener('main-menu:save-request', handler);
  },
  onMainMenuSaveAsRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('main-menu:save-as-request', handler);
    return () => ipcRenderer.removeListener('main-menu:save-as-request', handler);
  },
  // 资源管理器
  resmgrOpen: () => ipcRenderer.invoke('resmgr:open'),
  resmgrGetGPUInfo: () => ipcRenderer.invoke('resmgr:getGPUInfo'),
  resmgrGetModelGroups: () => ipcRenderer.invoke('resmgr:getModelGroups'),
  resmgrLoadModel: (groupId, modelId) => ipcRenderer.invoke('resmgr:loadModel', { groupId, modelId }),
  resmgrUnloadModel: (groupId, modelId) => ipcRenderer.invoke('resmgr:unloadModel', { groupId, modelId }),
  resmgrLoadGroup: (groupId) => ipcRenderer.invoke('resmgr:loadGroup', { groupId }),
  resmgrUnloadGroup: (groupId) => ipcRenderer.invoke('resmgr:unloadGroup', { groupId }),

  // ==================== WebNN / NPU API ====================
  webnnDetectNPU: () => ipcRenderer.invoke('webnn:detectNPU'),
  webnnLoadModel: (modelId, modelPath, options) => ipcRenderer.invoke('webnn:loadModel', modelId, modelPath, options),
  webnnUnloadModel: (modelId) => ipcRenderer.invoke('webnn:unloadModel', modelId),
  webnnRunInference: (modelId, inputs) => ipcRenderer.invoke('webnn:runInference', modelId, inputs),
  webnnGetStatus: () => ipcRenderer.invoke('webnn:getStatus'),
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
      ipcRenderer.send('webnn:readModelFile', { filePath, reqId });
    });
  },
  validateDevices: () => ipcRenderer.invoke('settings:validateDevices'),

  // WebNN 渲染进程监听器注册（主进程 → 渲染进程请求）
  onWebnnDetectNPURequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('webnn:detectNPU:request', handler);
    return () => ipcRenderer.removeListener('webnn:detectNPU:request', handler);
  },
  onWebnnLoadModelRequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('webnn:loadModel:request', handler);
    return () => ipcRenderer.removeListener('webnn:loadModel:request', handler);
  },
  onWebnnUnloadModelRequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('webnn:unloadModel:request', handler);
    return () => ipcRenderer.removeListener('webnn:unloadModel:request', handler);
  },
  onWebnnRunInferenceRequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('webnn:runInference:request', handler);
    return () => ipcRenderer.removeListener('webnn:runInference:request', handler);
  },
  onWebnnGetStatusRequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('webnn:getStatus:request', handler);
    return () => ipcRenderer.removeListener('webnn:getStatus:request', handler);
  },
  onWebnnRunSynthesisRequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('webnn:runSynthesis:request', handler);
    return () => ipcRenderer.removeListener('webnn:runSynthesis:request', handler);
  },
  onWebnnPrefetchRequest: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('webnn:prefetch:request', handler);
    return () => ipcRenderer.removeListener('webnn:prefetch:request', handler);
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
    ipcRenderer.invoke(responseChannel, result);
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
    bootstrap: () => ipcRenderer.invoke('theme:bootstrap'),
    list: () => ipcRenderer.invoke('theme:list'),
    get: (themeId) => ipcRenderer.invoke('theme:get', themeId),
    current: (options) => ipcRenderer.invoke('theme:current', options || {}),
    apply: (themeId, options) => ipcRenderer.invoke('theme:apply', themeId, options || {}),
    save: (themeObj) => ipcRenderer.invoke('theme:save', themeObj),
    delete: (themeId) => ipcRenderer.invoke('theme:delete', themeId),
    import: () => ipcRenderer.invoke('theme:import'),
    export: (themeId) => ipcRenderer.invoke('theme:export', themeId),
    reset: () => ipcRenderer.invoke('theme:reset'),
    onChanged: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('theme:changed', handler);
      return () => ipcRenderer.removeListener('theme:changed', handler);
    },
    onListChanged: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('theme:list-changed', handler);
      return () => ipcRenderer.removeListener('theme:list-changed', handler);
    },
  },

  // ==================== Update API ====================
  updateAPI: {
    checkNow: () => ipcRenderer.invoke('update:check-now'),
    getStatus: () => ipcRenderer.invoke('update:get-status'),
    skipVersion: (version) => ipcRenderer.invoke('update:skip-version', version),
    dontRemind: () => ipcRenderer.invoke('update:dont-remind'),
    openDownloadPage: (url) => ipcRenderer.invoke('update:open-download-page', url),
    openModelDownload: () => ipcRenderer.invoke('update:open-model-download'),
    // In-app installer download
    downloadInstaller: (url, version) => ipcRenderer.invoke('update:download-installer', { url, version }),
    cancelDownload: () => ipcRenderer.invoke('update:cancel-download'),
    installInstaller: (filePath) => ipcRenderer.invoke('update:install-installer', { filePath }),
    onDownloadProgress: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('update:download-progress', handler);
      return () => ipcRenderer.removeListener('update:download-progress', handler);
    },
    onDownloadComplete: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('update:download-complete', handler);
      return () => ipcRenderer.removeListener('update:download-complete', handler);
    },
    onDownloadError: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('update:download-error', handler);
      return () => ipcRenderer.removeListener('update:download-error', handler);
    },
    onNotificationShow: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('update:notification-show', handler);
      return () => ipcRenderer.removeListener('update:notification-show', handler);
    },
  },

  // ==================== Singer Market API ====================
  // Proxy to the Cloudflare Workers backend. The Bearer token never
  // leaves the main process; the renderer only sees the high-level
  // { success, data, error } results.
  singerMarket: {
    login: (username, password) => ipcRenderer.invoke('singer-market:login', { username, password }),
    register: (username, password) => ipcRenderer.invoke('singer-market:register', { username, password }),
    logout: () => ipcRenderer.invoke('singer-market:logout'),
    me: () => ipcRenderer.invoke('singer-market:me'),
    list: (params) => ipcRenderer.invoke('singer-market:list', params),
    fileDetail: (fileId) => ipcRenderer.invoke('singer-market:file-detail', fileId),
    tags: (params) => ipcRenderer.invoke('singer-market:tags', params),
    upload: (payload) => ipcRenderer.invoke('singer-market:upload', payload),
    download: (fileId) => ipcRenderer.invoke('singer-market:download', fileId),
    pickFile: () => ipcRenderer.invoke('singer-market:pick-file'),
    pickSavePath: (suggestedName) => ipcRenderer.invoke('singer-market:pick-save-path', suggestedName),
  },
});
