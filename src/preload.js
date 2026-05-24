const { contextBridge, ipcRenderer } = require('electron');

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
  openSingerCreator: () => ipcRenderer.invoke('openSingerCreator'),
  saveSingerFile: (singerData) => ipcRenderer.invoke('saveSingerFile', singerData),
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
  disposeSVSPipeline: () => ipcRenderer.invoke('svs:dispose'),
  getFragmentSVSSampleRate: () => ipcRenderer.invoke('fragment-svs:getSampleRate'),
  initFragmentSVSPipeline: () => ipcRenderer.invoke('fragment-svs:init'),
  synthesizeFragmentSVS: (data) => ipcRenderer.invoke('fragment-svs:synthesize', data),
  disposeFragmentSVSPipeline: () => ipcRenderer.invoke('fragment-svs:dispose'),
  onFragmentSVSProgress: (callback) => {
    const handler = (event, data) => callback(data.progress);
    ipcRenderer.on('fragment-svs:progress', handler);
    return () => ipcRenderer.removeListener('fragment-svs:progress', handler);
  },
  extractF0: (data) => ipcRenderer.invoke('extractF0:onnx', data),
  extractMidiRosvot: (data) => ipcRenderer.invoke('extractMidi:rosvot', data),
  extractF0BasicPitch: (data) => ipcRenderer.invoke('extractF0:basicPitch', data),
  importMidi: () => ipcRenderer.invoke('midi:import'),
  resolvePath: (basePath, relativePath) => ipcRenderer.invoke('resolvePath', basePath, relativePath),
  getDirName: (filePath) => ipcRenderer.invoke('getDirName', filePath),
  getDMLDevices: () => ipcRenderer.invoke('settings:getDMLDevices'),
  getCurrentHardware: () => ipcRenderer.invoke('settings:getCurrentHardware'),
  getSettings: () => ipcRenderer.invoke('settings:getSettings'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:saveSettings', settings),
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
  modelDownloadStart: (precision) => ipcRenderer.invoke('model-download:start', precision),
  modelDownloadCancel: () => ipcRenderer.invoke('model-download:cancel'),
  modelDownloadCheck: () => ipcRenderer.invoke('model-download:check'),
  modelDownloadChangeDir: () => ipcRenderer.invoke('model-download:change-dir'),
  modelDownloadGetDir: () => ipcRenderer.invoke('model-download:get-dir'),
  modelDownloadOpen: (precision) => ipcRenderer.invoke('model-download:open', precision),
  saveLocale: (locale) => ipcRenderer.invoke('save-locale', locale),
  getLocale: () => ipcRenderer.invoke('get-locale'),
  reloadMainWindow: () => ipcRenderer.invoke('reload-main-window'),
  onLocaleChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('locale-changed', handler);
    return () => ipcRenderer.removeListener('locale-changed', handler);
  },
  setDirty: (dirty) => ipcRenderer.send('set-dirty', dirty),
  onCloseConfirm: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('close-confirm', handler);
    return () => ipcRenderer.removeListener('close-confirm', handler);
  },
  closeConfirmed: () => ipcRenderer.send('close-confirmed'),
  // 资源管理器
  resmgrOpen: () => ipcRenderer.invoke('resmgr:open'),
  resmgrGetGPUInfo: () => ipcRenderer.invoke('resmgr:getGPUInfo'),
  resmgrGetModelGroups: () => ipcRenderer.invoke('resmgr:getModelGroups'),
  resmgrLoadModel: (groupId, modelId) => ipcRenderer.invoke('resmgr:loadModel', { groupId, modelId }),
  resmgrUnloadModel: (groupId, modelId) => ipcRenderer.invoke('resmgr:unloadModel', { groupId, modelId }),
  resmgrLoadGroup: (groupId) => ipcRenderer.invoke('resmgr:loadGroup', { groupId }),
  resmgrUnloadGroup: (groupId) => ipcRenderer.invoke('resmgr:unloadGroup', { groupId }),
});
