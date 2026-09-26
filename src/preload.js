const { contextBridge, ipcRenderer } = require('electron');
let heavyIpcReadyPromise;
async function invokeHeavy(channel,...args){if(!heavyIpcReadyPromise)heavyIpcReadyPromise=ipcRenderer.invoke('app:waitForHeavyIpc');const result=await heavyIpcReadyPromise;if(!result?.success)throw new Error(result?.error||'Deferred IPC initialization failed');return ipcRenderer.invoke(channel,...args);}

// Forward renderer errors to the main process for centralized logging.
// Runs in the preload's isolated world, but DOM event listeners added via
// window.addEventListener still catch errors thrown from the main world
// (with contextIsolation: true). This catches window.onerror,
// unhandledrejection, and console.error — the most common sources of silent
// renderer failures — and persists them to the same log file used by the
// main process. This runs before contextBridge.exposeInMainWorld so it
// applies to every renderer (main, fragment, settings, modelDownload,
// resourceManager, singerCreator, audioPreprocess, splash,
// updateNotification) without any per-window setup.
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
      try { ipcRenderer.send('crash:log', { level, source: 'renderer', message }); } catch (_) {}
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

contextBridge.exposeInMainWorld('electronAPI', {
  onMcpAutomationRequest: callback => { const h=(_e,m)=>callback(m); ipcRenderer.on('mcp:automation-request',h); return ()=>ipcRenderer.removeListener('mcp:automation-request',h); },
  sendMcpAutomationResponse: message => ipcRenderer.send('mcp:automation-response',message),
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
  initSVSPipeline: () => invokeHeavy('svs:init'),
  synthesizeSVS: (data) => invokeHeavy('svs:synthesize', data),
  synthesizeMultiStreaming: (data) => invokeHeavy('svs:synthesizeMultiStreaming', data),
  cancelSVSSynthesis: () => invokeHeavy('svs:cancel'),
  disposeSVSPipeline: () => invokeHeavy('svs:dispose'),
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
  onSVSDiffStepIncompatible: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('svs:model-incompatible', handler);
    return () => ipcRenderer.removeListener('svs:model-incompatible', handler);
  },
  getFragmentSVSSampleRate: () => invokeHeavy('fragment-svs:getSampleRate'),
  initFragmentSVSPipeline: () => invokeHeavy('fragment-svs:init'),
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
    ipcRenderer.on('fragment-svs:progress', handler);
    return () => ipcRenderer.removeListener('fragment-svs:progress', handler);
  },
  onFragmentSVSChunkAudio: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('fragment-svs:chunk-audio', handler);
    return () => ipcRenderer.removeListener('fragment-svs:chunk-audio', handler);
  },
  extractF0: (data) => invokeHeavy('extractF0:onnx', data),
  extractMidiRosvot: (data) => invokeHeavy('extractMidi:rosvot', data),
  extractF0BasicPitch: (data) => invokeHeavy('extractF0:basicPitch', data),
  extractMidiFcpe: (data) => invokeHeavy('extractMidi:fcpe', data),
  importMidi: () => ipcRenderer.invoke('midi:import'),
  importMidiMultiTrack: () => ipcRenderer.invoke('midi:importMultiTrack'),
  resolvePath: (basePath, relativePath) => ipcRenderer.invoke('resolvePath', basePath, relativePath),
  getDirName: (filePath) => ipcRenderer.invoke('getDirName', filePath),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  // Open an allowed https URL (arXiv / GitHub etc.) in the system browser.
  // Used by the Settings → About page (license / papers / acknowledgments).
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  getDMLDevices: (options = {}) => invokeHeavy('settings:getDMLDevices', options),
  getWinmlProviders: () => invokeHeavy('settings:getWinmlProviders'),
  getHardwareStatus: () => invokeHeavy('settings:getHardwareStatus'),
  getCurrentHardware: () => invokeHeavy('settings:getCurrentHardware'),
  getVocoderChunkFramesInfo: () => invokeHeavy('settings:getVocoderChunkFramesInfo'),
  getVocoderChunkFramesTable: () => invokeHeavy('settings:getVocoderChunkFramesTable'),
  getSettings: () => invokeHeavy('settings:getSettings'),
  saveSettings: (settings) => invokeHeavy('settings:saveSettings', settings),
  checkModels: () => invokeHeavy('settings:check-models'),
  runTrtRtxDiagnostic: () => invokeHeavy('settings:run-trtrtx-diagnostic'),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  getAudioDevices: () => invokeHeavy('audio:getDevices'),
  audioPlay: (audioData, options) => invokeHeavy('audio:play', { audioData, options }),
  audioStop: () => invokeHeavy('audio:stop'),
  audioGetPosition: () => invokeHeavy('audio:getPosition'),
  audioIsAvailable: () => invokeHeavy('audio:isAvailable'),
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
  // FCPE (optional pitch detector) download/unload
  modelDownloadCheckFcpe: () => ipcRenderer.invoke('model-download:check-fcpe'),
  modelDownloadStartFcpe: (revision) => ipcRenderer.invoke('model-download:start-fcpe', revision),
  modelDownloadUnloadFcpe: () => ipcRenderer.invoke('model-download:unload-fcpe'),
  // Model version management
  modelDownloadCheckVersion: (precision) => ipcRenderer.invoke('model-download:check-version', precision),
  modelDownloadCheckJpVersion: (precision) => ipcRenderer.invoke('model-download:check-jp-version', precision),
  modelDownloadCheckSifiganVersion: () => ipcRenderer.invoke('model-download:check-sifigan-version'),
  modelDownloadCheckFcpeVersion: () => ipcRenderer.invoke('model-download:check-fcpe-version'),
  modelDownloadCheckAllVersions: (precision) => ipcRenderer.invoke('model-download:check-all-versions', precision),
  modelDownloadUpdate: (precision, revision) => ipcRenderer.invoke('model-download:update', precision, revision),
  modelDownloadUpdateJp: (precision, revision) => ipcRenderer.invoke('model-download:update-jp', precision, revision),
  modelDownloadUpdateSifigan: (revision) => ipcRenderer.invoke('model-download:update-sifigan', revision),
  modelDownloadUpdateFcpe: (revision) => ipcRenderer.invoke('model-download:update-fcpe', revision),
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
  // 布局尺寸变化通知（DevTools 打开/关闭、窗口 resize 等）。
  // 停靠式 DevTools 关闭后 BrowserWindow 的 bounds 不变，window 'resize'
  // 不一定触发，导致 canvas 仍按旧尺寸绘制 —— 需要主进程显式推送一次。
  onRelayout: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('app:relayout', handler);
    return () => ipcRenderer.removeListener('app:relayout', handler);
  },
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
  // 模态设置窗口已打开（主进程 → 主窗口）：渲染层应暂停播放，
  // 否则模态期间主窗口输入被禁用而音频继续，用户无法控制。
  onSettingsWindowOpened: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('settings-window:opened', handler);
    return () => ipcRenderer.removeListener('settings-window:opened', handler);
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
  // 主进程 clearNPUFailureCache() 通过 'webnn:clearNpuCache' 通知渲染端清掉
  // 本地检测结果缓存。此前 preload 未暴露该桥接，主进程清缓存后渲染端仍会
  // 返回陈旧结果（要等 5 分钟 TTL 才恢复），表现为"换语言模型后 NPU 一直
  // 检测不到"。
  onClearNpuCache: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('webnn:clearNpuCache', handler);
    return () => ipcRenderer.removeListener('webnn:clearNpuCache', handler);
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
    licenses: () => ipcRenderer.invoke('singer-market:licenses'),
    upload: (payload) => ipcRenderer.invoke('singer-market:upload', payload),
    download: (fileId) => ipcRenderer.invoke('singer-market:download', fileId),
    // Subscribe to download progress events from the main process.
    // Returns an unsubscribe function.
    onDownloadProgress: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('singer-market:download-progress', listener);
      return () => ipcRenderer.removeListener('singer-market:download-progress', listener);
    },
    pickFile: () => ipcRenderer.invoke('singer-market:pick-file'),
    pickSavePath: (suggestedName) => ipcRenderer.invoke('singer-market:pick-save-path', suggestedName),
  },

  // ==================== Crash Reporting API ====================
  // Used by settings/help UI to surface log/dump file locations so users can
  // attach them when filing issues. Log forwarding (window.onerror /
  // unhandledrejection / console.error) is wired up automatically at the top
  // of this file — renderers do not need to call into this API to report errors.
  crashReportAPI: {
    getReportInfo: () => ipcRenderer.invoke('crash:getReportInfo'),
    openLogDir: () => ipcRenderer.invoke('crash:openLogDir'),
    openDumpDir: () => ipcRenderer.invoke('crash:openDumpDir'),
    log: (level, message) => ipcRenderer.send('crash:log', { level, source: 'renderer', message }),
  },
});
