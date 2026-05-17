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
  modelDownloadStart: () => ipcRenderer.invoke('model-download:start'),
  modelDownloadCancel: () => ipcRenderer.invoke('model-download:cancel'),
  modelDownloadCheck: () => ipcRenderer.invoke('model-download:check'),
});
