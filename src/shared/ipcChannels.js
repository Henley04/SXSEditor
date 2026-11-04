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
  // 主窗口 → 分片编辑器：**已打开**编辑器的增量补丁（MCP / 脚本 / 自动流程
  // 从主窗口侧改了分片数据后，编辑器必须同步，否则它的 500ms 自动保存会把
  // 旧数据写回去覆盖掉外部修改）。与 LOAD_FRAGMENT 的区别是只更新指定字段、
  // 不重建编辑器状态，因此撤销栈与视口位置都保留。
  PUSH_FRAGMENT_PATCH: 'pushFragmentPatch',
  FRAGMENT_DATA_PATCH: 'fragmentDataPatch',
  UPDATE_FRAGMENT_BOUNDS: 'updateFragmentBounds',
  FRAGMENT_BOUNDS_CHANGED: 'fragmentBoundsChanged',
  UPDATE_PROJECT_SETTINGS: 'updateProjectSettings',
  PROJECT_SETTINGS_CHANGED: 'projectSettingsChanged',
  OPEN_SINGER_CREATOR: 'openSingerCreator',
  OPEN_SINGER_EDITOR: 'openSingerEditor',
  // 主进程 → 歌手编辑：直接按路径打开（用于系统"打开方式"/双击 .sxssinger）
  SINGER_OPEN_AT: 'singer:openAt',
  SAVE_SINGER_FILE: 'saveSingerFile',
  SINGER_CREATED: 'singerCreated',
  // 主进程 → 主窗口：已存在的歌手文件被编辑保存，按 filePath 就地更新
  SINGER_UPDATED: 'singerUpdated',
  OPEN_AUDIO_PREPROCESS: 'openAudioPreprocess',
  SEND_PREPROCESS_DATA: 'sendPreprocessData',
  PREPROCESS_DATA_SAVED: 'preprocessDataSaved',
  LOAD_PREPROCESS_DATA: 'loadPreprocessData',
  SET_DIRTY: 'set-dirty',
  CLOSE_CONFIRMED: 'close-confirmed',
  CLOSE_CONFIRM: 'close-confirm',
  RELOAD_MAIN_WINDOW: 'reload-main-window',
  // 主进程 → 渲染进程：内容区尺寸可能已变化，请重新布局/重绘。
  // 覆盖停靠式 DevTools 开关这类 window 'resize' 不触发的场景。
  RELAYOUT: 'app:relayout',

  // ==================== OS "open with" ====================
  // 系统把 .sxsproj / .sxssinger 交给应用（双击、拖到图标、"打开方式"）。
  // 文件路径先存在主进程，渲染层就绪后主动来取，取走即清空 —— 只走这一条
  // 数据通道，避免"启动参数"和"运行时事件"两套逻辑各写一遍还互相打架。
  APP_TAKE_PENDING_FILE: 'app:takePendingOpenFile',
  // 主进程 → 渲染层：有新文件待取（仅通知，不携带路径）
  APP_FILE_REQUESTED: 'app:fileRequested',

  // ==================== SVS Pipeline ====================
  SVS_INIT: 'svs:init',
  SVS_SYNTHESIZE: 'svs:synthesize',
  SVS_SYNTHESIZE_MULTI_STREAMING: 'svs:synthesizeMultiStreaming',
  SVS_CHUNK_AUDIO: 'svs:chunk-audio',
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
  EXTRACT_MIDI_FCPE: 'extractMidi:fcpe',
  MIDI_IMPORT: 'midi:import',
  MIDI_IMPORT_MULTI_TRACK: 'midi:importMultiTrack',

  // ==================== Path Utilities ====================
  RESOLVE_PATH: 'resolvePath',
  GET_DIR_NAME: 'getDirName',

  // ==================== Settings ====================
  SETTINGS_GET_DML_DEVICES: 'settings:getDMLDevices',
  SETTINGS_GET_WINML_PROVIDERS: 'settings:getWinmlProviders',
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
  MODEL_DOWNLOAD_CHECK_FCPE: 'model-download:check-fcpe',
  MODEL_DOWNLOAD_START_FCPE: 'model-download:start-fcpe',
  MODEL_DOWNLOAD_UNLOAD_FCPE: 'model-download:unload-fcpe',
  MODEL_DOWNLOAD_CHECK_FCPE_VERSION: 'model-download:check-fcpe-version',
  MODEL_DOWNLOAD_UPDATE_FCPE: 'model-download:update-fcpe',
  MODEL_DOWNLOAD_OPEN_EXTERNAL: 'model-download:open-external',
  MODEL_DOWNLOAD_REVISION: 'model-download:revision',

  // ==================== Locale ====================
  SAVE_LOCALE: 'save-locale',
  GET_LOCALE: 'get-locale',
  LOCALE_CHANGED: 'locale-changed',

  // ==================== Plugin Host (第三方歌声后端) ====================
  PLUGIN_LIST: 'plugin:list',
  PLUGIN_RELOAD: 'plugin:reload',
  PLUGIN_GET_VOICES: 'plugin:getVoices',
  PLUGIN_SYNTHESIZE: 'plugin:synthesize',
  PLUGIN_GET_PLUGINS_DIR: 'plugin:getPluginsDir',
  PLUGIN_OPEN_PLUGINS_FOLDER: 'plugin:openPluginsFolder',
  PLUGIN_CANCEL_TICKET: 'plugin:cancelTicket',
  // 主进程 → 渲染进程：插件阻滞播放的 ticket 生命周期（对应 host.blockPlayback）
  PLUGIN_BLOCKING_START: 'plugin:blocking-start',
  PLUGIN_BLOCKING_UPDATE: 'plugin:blocking-update',
  PLUGIN_BLOCKING_END: 'plugin:blocking-end',
  // 主进程 → 渲染进程：插件输出通道（进度 / 流式音频 / 诊断）
  PLUGIN_PROGRESS: 'plugin:progress',
  PLUGIN_AUDIO: 'plugin:audio',
  PLUGIN_DIAGNOSTICS: 'plugin:diagnostics',

  // ==================== Plugin Host v2（全应用插件） ====================
  // 注意与上面的 v1（plugin:*，仅歌声后端）分开：v1 保持原样直到 3.0 移除。
  // 这里没有"每插件一个通道"的动态通道 —— 插件 runtime 与主进程走
  // utilityProcess 的 MessagePort，不占 ipcMain，天然免掉一类卸载残留。
  PLUGINHOST_LIST: 'plugin-host:list',
  PLUGINHOST_ADMIN: 'plugin-host:admin',
  PLUGINHOST_INSTALL: 'plugin-host:install',
  PLUGINHOST_INSTALL_PATH: 'plugin-host:install-path',
  PLUGINHOST_UNINSTALL: 'plugin-host:uninstall',
  PLUGINHOST_SET_ENABLED: 'plugin-host:set-enabled',
  PLUGINHOST_RELOAD: 'plugin-host:reload',
  PLUGINHOST_RUN_COMMAND: 'plugin-host:run-command',
  PLUGINHOST_PANEL_RPC: 'plugin-host:panel-rpc',
  PLUGINHOST_OPEN_DIR: 'plugin-host:open-dir',
  PLUGINHOST_GET_LOG: 'plugin-host:get-log',
  // M2：界面贡献点。设置页读写插件设置、管理器开关快捷键、渲染层取 iframe 地址。
  // 地址必须由主进程 mint（entry 只在主进程可见），渲染层不能自己拼 plugin://。
  PLUGINHOST_SETTINGS_GET: 'plugin-host:settings-get',
  PLUGINHOST_SETTINGS_SET: 'plugin-host:settings-set',
  PLUGINHOST_SET_KEYBINDINGS: 'plugin-host:set-keybindings',
  PLUGINHOST_OVERLAY_URL: 'plugin-host:overlay-url',
  // 设置页/管理器 → 主窗口：把某个面板挂到主窗口的右侧抽屉（设置分区用它对
  // 自定义界面；管理器用它做"打开面板"）。面板的 apiScopes 校验仍在主进程做。
  PLUGINHOST_OPEN_PANEL_REQUEST: 'plugin-host:open-panel-request',
  // M4：数据面。渲染层给出路径，主进程按扩展名路由到插件 codec，返回校验过的
  // 工程文档。路径不经过渲染层的文件系统 API —— 插件格式的解析全在主进程的
  // codec 进程里完成，渲染层只负责把文档装进 state。
  PLUGINHOST_OPEN_DOCUMENT: 'plugin-host:open-document',
  // 插件声明的文件格式（对话框过滤器用）。投影里也有 fileTypes，但那份要按
  // 插件分组、还要算 UI 渲染状态；对话框只要一张扁平的"扩展名 → 显示名"。
  PLUGINHOST_FILE_FILTERS: 'plugin-host:file-filters',
  // 主进程 → 渲染进程
  PLUGINHOST_SYNC: 'plugin-host:sync',
  PLUGINHOST_EVENT: 'plugin-host:event',
  // 主进程 → 主窗口：一次工程写入往返（插件 runtime 经宿主转发）
  PLUGINHOST_PROJECT_APPLY: 'plugin-host:project-apply',
  PLUGINHOST_PROJECT_APPLY_RESULT: 'plugin-host:project-apply-result',
  // 主进程 → 主窗口：请渲染层挂载某个插件的 iframe 面板（菜单项触发）
  PLUGINHOST_OPEN_PANEL: 'plugin-host:open-panel',

  // 模型调用面（设计方案 §12）：设置页读写端点/绑定/授权/审计，以及首次调用的确认窗。
  MODELS_SNAPSHOT: 'models:snapshot',
  MODELS_ENDPOINT_UPSERT: 'models:endpoint-upsert',
  MODELS_ENDPOINT_REMOVE: 'models:endpoint-remove',
  MODELS_BIND: 'models:bind',
  MODELS_UNBIND: 'models:unbind',
  MODELS_SET_DEFAULT: 'models:set-default',
  MODELS_GRANT: 'models:grant',
  MODELS_REVOKE: 'models:revoke',
  MODELS_SET_SETTINGS: 'models:set-settings',
  MODELS_AUDIT: 'models:audit',
  // 主进程 → 渲染层：请求用户确认（首次调用某端点）
  MODELS_CONSENT_REQUEST: 'models:consent-request',
  // 渲染层 → 主进程：确认结果
  MODELS_CONSENT_REPLY: 'models:consent-reply',

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

  // ==================== 补充收录（从现有调用点汇总） ====================
  // 这些通道此前只以裸字符串形式散落在 src/main/*.js 与 src/preload.js 里，
  // 从未登记进常量表 —— 这正是审查项 A3 的另一半：常量表覆盖了 150 个，
  // 实际还有 56 个通道一直在裸写。scripts/check-ipc-channels.js 会守住这条线。
  // ---- app ----
  APP_WAIT_FOR_HEAVY_IPC: 'app:waitForHeavyIpc',
  // ---- crash ----
  CRASH_GET_REPORT_INFO: 'crash:getReportInfo',
  CRASH_LOG: 'crash:log',
  CRASH_OPEN_DUMP_DIR: 'crash:openDumpDir',
  CRASH_OPEN_LOG_DIR: 'crash:openLogDir',
  // ---- fragment ----
  FRAGMENT_CLOSE: 'fragment:close',
  FRAGMENT_CLOSE_ALL: 'fragment:closeAll',
  // ---- fragment-svs ----
  FRAGMENT_SVS_CHUNK_AUDIO: 'fragment-svs:chunk-audio',
  // ---- main-menu ----
  MAIN_MENU_SAVE_AS_REQUEST: 'main-menu:save-as-request',
  MAIN_MENU_SAVE_REQUEST: 'main-menu:save-request',
  // ---- mcp ----
  MCP_AUTOMATION_REQUEST: 'mcp:automation-request',
  MCP_AUTOMATION_RESPONSE: 'mcp:automation-response',
  MCP_AUTOMATION_EVENT: 'mcp:automation-event',
  // ---- model-download ----
  MODEL_DOWNLOAD_CHECK_ALL_VERSIONS: 'model-download:check-all-versions',
  MODEL_DOWNLOAD_CHECK_JP_VERSION: 'model-download:check-jp-version',
  MODEL_DOWNLOAD_CHECK_SIFIGAN: 'model-download:check-sifigan',
  MODEL_DOWNLOAD_CHECK_SIFIGAN_VERSION: 'model-download:check-sifigan-version',
  MODEL_DOWNLOAD_CHECK_VERSION: 'model-download:check-version',
  MODEL_DOWNLOAD_START_SIFIGAN: 'model-download:start-sifigan',
  MODEL_DOWNLOAD_UNLOAD_SIFIGAN: 'model-download:unload-sifigan',
  MODEL_DOWNLOAD_UPDATE: 'model-download:update',
  MODEL_DOWNLOAD_UPDATE_JP: 'model-download:update-jp',
  MODEL_DOWNLOAD_UPDATE_SIFIGAN: 'model-download:update-sifigan',
  MODEL_DOWNLOAD_WINDOW_CLOSED: 'model-download:window-closed',
  // ---- settings ----
  SETTINGS_GET_VOCODER_CHUNK_FRAMES_INFO: 'settings:getVocoderChunkFramesInfo',
  SETTINGS_GET_VOCODER_CHUNK_FRAMES_TABLE: 'settings:getVocoderChunkFramesTable',
  SETTINGS_RUN_TRTRTX_DIAGNOSTIC: 'settings:run-trtrtx-diagnostic',
  // ---- settings-window ----
  SETTINGS_WINDOW_OPENED: 'settings-window:opened',
  // ---- shell ----
  SHELL_OPEN_EXTERNAL: 'shell:open-external',
  SHELL_SHOW_ITEM_IN_FOLDER: 'shell:showItemInFolder',
  // ---- singer-creator ----
  SINGER_CREATOR_SAVE_AS_REQUEST: 'singer-creator:save-as-request',
  SINGER_CREATOR_SAVE_REQUEST: 'singer-creator:save-request',
  // ---- singer-market ----
  SINGER_MARKET_DOWNLOAD: 'singer-market:download',
  SINGER_MARKET_DOWNLOAD_PROGRESS: 'singer-market:download-progress',
  SINGER_MARKET_FILE_DETAIL: 'singer-market:file-detail',
  SINGER_MARKET_LICENSES: 'singer-market:licenses',
  SINGER_MARKET_LIST: 'singer-market:list',
  SINGER_MARKET_LOGIN: 'singer-market:login',
  SINGER_MARKET_LOGOUT: 'singer-market:logout',
  SINGER_MARKET_ME: 'singer-market:me',
  SINGER_MARKET_PICK_FILE: 'singer-market:pick-file',
  SINGER_MARKET_PICK_SAVE_PATH: 'singer-market:pick-save-path',
  SINGER_MARKET_REGISTER: 'singer-market:register',
  SINGER_MARKET_TAGS: 'singer-market:tags',
  SINGER_MARKET_UPLOAD: 'singer-market:upload',
  // ---- svs ----
  SVS_CANCEL: 'svs:cancel',
  SVS_MODEL_INCOMPATIBLE: 'svs:model-incompatible',
  SVS_PROGRESS: 'svs:progress',
  SVS_LOAD_PROGRESS: 'svs:loadProgress',
  // ---- update ----
  UPDATE_CANCEL_DOWNLOAD: 'update:cancel-download',
  UPDATE_DOWNLOAD_COMPLETE: 'update:download-complete',
  UPDATE_DOWNLOAD_ERROR: 'update:download-error',
  UPDATE_DOWNLOAD_INSTALLER: 'update:download-installer',
  UPDATE_DOWNLOAD_PROGRESS: 'update:download-progress',
  UPDATE_INSTALL_INSTALLER: 'update:install-installer',
  // ---- webnn ----
  WEBNN_CLEAR_NPU_CACHE: 'webnn:clearNpuCache',
};

module.exports = { IPC_CHANNELS };
