const { app } = require('electron');

// B7: NOTE — there are two parallel i18n systems in this codebase:
//   1. This file (src/main/locale.js) — CJS, used by the main process.
//   2. src/i18n/index.js + zh-CN.js + en.js — ESM, used by the renderer.
// They are intentionally separate (main vs renderer) but must be kept in
// SYNC: any key used by both processes must exist in both dictionaries with
// matching semantics. When adding a key, check whether the other system
// needs it too.

const mainLocales = {
  'zh-CN': {
    menu: {
      aboutSXSEditor: '关于 SXSEditor',
      quit: '退出',
      file: '文件',
      save: '保存',
      saveAs: '另存为...',
      exportMidi: '导出项目为 MIDI...',
      importMidi: '导入 MIDI...',
      audioToMidi: '音频转 MIDI...',
      mcpSetup: 'MCP 连接...',
      editSinger: '编辑歌手文件...',
      edit: '编辑',
      undo: '撤销',
      redo: '重做',
      cut: '剪切',
      copy: '复制',
      paste: '粘贴',
      selectAll: '全选',
      settings: '设置',
      resourceManager: '资源管理器',
      view: '视图',
      reload: '重新加载',
      forceReload: '强制重新加载',
      devTools: '开发者工具',
      resetZoom: '重置缩放',
      zoomIn: '放大',
      zoomOut: '缩小',
      fullscreen: '全屏',
      help: '帮助',
      website: 'GitHub 项目主页',
      userDocs: '用户帮助文档（本地）',
      devDocs: '开发者文档（本地）',
      onlineDocs: '在线文档（最新版）',
      openLogDir: '打开日志文件夹',
      openDumpDir: '打开崩溃转储文件夹',
      plugins: '插件',
      pluginsManage: '插件管理器…',
      pluginsInstall: '从文件安装插件…',
      pluginsReload: '重新加载全部插件',
      pluginsOpenFolder: '打开插件目录',
      pluginsLog: '插件日志',
      pluginsOpenPanel: '打开面板…',
    },
    dialog: {
      saveSingerFile: '保存歌手文件',
      openSingerFile: '打开歌手文件进行编辑',
      singerFileInvalid: '不是有效的歌手文件（.sxssinger）',
      singerFileTooLarge: '歌手文件过大，无法打开',
      selectModelDownloadLocation: '选择模型文件下载位置（默认位置无需管理员权限）',
      selectFolder: '选择此文件夹',
      importMidi: '导入MIDI文件',
    },
    // 插件发起安装时的强制确认对话框（主进程）。与渲染层 i18n 分开维护，
    // 但键名保持一致，避免同一句提示在两种界面里说不同的话。
    pluginInstallConsent: {
      title: '插件请求安装其他插件',
      message: '有插件请求安装插件包。请核对以下清单后决定是否继续：',
      initiator: '发起插件',
      source: '来源',
      relation: '版本关系',
      signature: '签名',
      permissionsChanged: '权限清单与已装版本不同',
      selfUpdate: '这是发起插件的自更新',
      nonMarket: '非市场来源：没有索引里的校验值背书，请确认来源可信',
      unknownId: '（包内读取插件 ID）',
      rejectAll: '全部拒绝',
      confirmAll: '全部确认安装',
      rel_new: '首次安装',
      rel_upgrade: '升级',
      rel_downgrade: '降级',
      rel_same: '同版本覆盖安装',
      rel_unknown: '未知（未指定版本）',
    },
    error: {
      pathNotAllowed: '不允许访问该路径',
      svsNotInitialized: 'SVS Pipeline 未初始化',
      fragmentSvsNotInitialized: 'Fragment SVS Pipeline 未初始化',
      // W19: i18n key for the JP-models-missing error (was hardcoded Chinese).
      jpModelNotDownloaded: '日语模型未下载。请在模型下载页面下载日语模型。',
      // ---- 远程 API 推理 ----
      // 这些消息会经 ipcSafe.sanitizeErrorMessage 处理，其中会把 URL 路径替换成
      // <path>，因此文案里不要依赖完整 URL；用 Provider 名称指代服务即可。
      // "[API ...]" 前缀是渲染层识别「必须显式弹窗」的标记（后台自动推理路径）。
      apiNoProvider: '[API 配置] 未配置 API 服务。请在「设置 → 推理与硬件 → API」中新建或选择一个 Provider。',
      apiAuth: '[API 401/403] 「{name}」鉴权失败：{detail}。请检查该 Provider 的密钥是否正确或已过期；密钥可留空，但服务端要求鉴权时必须填写。',
      apiRateLimit: '[API 429] 「{name}」请求被限流：{detail}。{wait}请稍后重试，或切换到其它 Provider。',
      apiRetryAfter: '建议 {seconds} 秒后重试。',
      apiServer: '[API {status}] 「{name}」服务端错误：{detail}',
      apiStreamFail: '[API 推理失败] 「{name}」在推理过程中出错：{detail}',
      apiHttp: '[API {status}] 「{name}」请求失败：{detail}',
      apiBadRequest: '[API 400] 「{name}」请求参数被拒绝：{detail}',
      apiTimeout: '[API 超时] 「{name}」在限定时间内没有返回结果，请检查服务是否繁忙或稍后重试。',
      apiNetwork: '[API 网络] 无法连接到「{name}」：{detail}。请检查 API 网址、网络与防火墙设置。',
      apiBadResponse: '[API 响应] 「{name}」返回的不是有效 WAV 音频，也没有可解析的音频字段。',
      apiBadWav: '[API 响应] 服务端返回的 WAV 无法解析（仅支持 32-bit float / PCM16 / PCM32）。',
      apiEmptyAudio: '[API 响应] 服务端返回的音频为空。',
      apiEmptyNotes: '[API 请求] 没有可合成的音符。',
      apiTestOk: '连接成功：「{name}」{summary}',
    },
    about: {
      soulXSingerEditor: 'SoulX Singer 编辑器',
      aiSvsWorkbench: '基于 ONNX Runtime / DirectML 的 AI 歌声合成工作台',
      version: '版本',
    },
    resourceManager: {
      title: '资源管理器',
    },
    modelDownload: {
      // W20: window title for the model download window (was hardcoded Chinese).
      title: 'SXSEditor 模型文件下载',
      sifiganUrlNotConfigured: '下载链接待配置，请等待作者上传至 ModelScope 或手动放置模型文件',
    },
    // W20: window titles for the fragment editor and audio preprocess windows.
    fragment: {
      title: '分片编辑 - {name}',
    },
    preprocess: {
      title: '音频预处理',
    },
    singerCreator: {
      title: '歌手创建',
      fileMenu: '文件',
      save: '保存',
      saveAs: '另存为...',
      close: '关闭',
    },
    singerMarket: {
      title: '歌手市场',
      // 大陆网络下连接失败时给出的区域化提示 + 诊断信息
      serviceUnavailableCN: '此服务未在你所在的区域提供，服务器不可用。',
      diagApiAddress: '服务地址',
      diagDns: 'DNS 解析',
      diagSystem: '系统',
      diagTimeout: '超时设置',
      diagRegion: '出口网络',
      diagAttempts: '连接尝试',
      diagLastError: '最近错误',
      diagFailed: '失败',
      diagUnknown: '未知',
    },
  },
  'en': {
    menu: {
      aboutSXSEditor: 'About SXSEditor',
      quit: 'Quit',
      file: 'File',
      save: 'Save',
      saveAs: 'Save As...',
      exportMidi: 'Export Project as MIDI...',
      importMidi: 'Import MIDI...',
      audioToMidi: 'Audio to MIDI...',
      mcpSetup: 'MCP Connection...',
      editSinger: 'Edit Singer File...',
      edit: 'Edit',
      undo: 'Undo',
      redo: 'Redo',
      cut: 'Cut',
      copy: 'Copy',
      paste: 'Paste',
      selectAll: 'Select All',
      settings: 'Settings',
      resourceManager: 'Resource Manager',
      view: 'View',
      reload: 'Reload',
      forceReload: 'Force Reload',
      devTools: 'Developer Tools',
      resetZoom: 'Reset Zoom',
      zoomIn: 'Zoom In',
      zoomOut: 'Zoom Out',
      fullscreen: 'Fullscreen',
      help: 'Help',
      website: 'GitHub Project Home',
      userDocs: 'User Documentation (Local)',
      devDocs: 'Developer Documentation (Local)',
      onlineDocs: 'Online Documentation (Latest)',
      openLogDir: 'Open Logs Folder',
      openDumpDir: 'Open Crash Dumps Folder',
      plugins: 'Plugins',
      pluginsManage: 'Manage Plugins…',
      pluginsInstall: 'Install from File…',
      pluginsReload: 'Reload All Plugins',
      pluginsOpenFolder: 'Open Plugins Folder',
      pluginsLog: 'Plugin Log',
      pluginsOpenPanel: 'Open Panel…',
    },
    dialog: {
      saveSingerFile: 'Save Singer File',
      openSingerFile: 'Open a singer file to edit',
      singerFileInvalid: 'Not a valid singer file (.sxssinger)',
      singerFileTooLarge: 'Singer file is too large to open',
      selectModelDownloadLocation: 'Select model file download location (default location doesn\'t require admin privileges)',
      selectFolder: 'Select This Folder',
      importMidi: 'Import MIDI File',
    },
    pluginInstallConsent: {
      title: 'A plugin is requesting to install other plugins',
      message: 'A plugin has requested to install plugin packages. Review the list before continuing:',
      initiator: 'Requested by',
      source: 'Source',
      relation: 'Version',
      signature: 'Signature',
      permissionsChanged: 'Permissions differ from the installed version',
      selfUpdate: 'This updates the requesting plugin itself',
      nonMarket: 'Non-market source: no index checksum to vouch for it, confirm you trust the source',
      unknownId: '(plugin id read from package)',
      rejectAll: 'Reject all',
      confirmAll: 'Confirm and install all',
      rel_new: 'First install',
      rel_upgrade: 'Upgrade',
      rel_downgrade: 'Downgrade',
      rel_same: 'Same version, reinstall',
      rel_unknown: 'Unknown (no version specified)',
    },
    error: {
      pathNotAllowed: 'Access to this path is not allowed',
      svsNotInitialized: 'SVS Pipeline not initialized',
      fragmentSvsNotInitialized: 'Fragment SVS Pipeline not initialized',
      // W19: i18n key for the JP-models-missing error (was hardcoded Chinese).
      jpModelNotDownloaded: 'Japanese model not downloaded. Please download the Japanese model on the model download page.',
      // ---- Remote API inference ----
      // Messages pass through ipcSafe.sanitizeErrorMessage, which rewrites URL
      // paths to <path>; never rely on a full URL here. The "[API ...]" prefix is
      // how the renderer recognises errors that MUST be surfaced to the user.
      apiNoProvider: '[API Config] No API provider configured. Create or select one in Settings > Inference & Hardware > API.',
      apiAuth: '[API 401/403] Authentication failed for "{name}": {detail}. Check that this provider\'s key is correct and not expired. The key is optional, but must be set when the server requires authentication.',
      apiRateLimit: '[API 429] Rate limited by "{name}": {detail}. {wait}Please retry later or switch to another provider.',
      apiRetryAfter: 'Retry in about {seconds}s. ',
      apiServer: '[API {status}] Server error from "{name}": {detail}',
      apiStreamFail: '[API Inference] "{name}" failed during synthesis: {detail}',
      apiHttp: '[API {status}] Request to "{name}" failed: {detail}',
      apiBadRequest: '[API 400] "{name}" rejected the request: {detail}',
      apiTimeout: '[API Timeout] "{name}" did not respond in time. The service may be busy; please retry later.',
      apiNetwork: '[API Network] Cannot reach "{name}": {detail}. Check the API URL, network and firewall settings.',
      apiBadResponse: '[API Response] "{name}" returned neither a valid WAV nor a parseable audio field.',
      apiBadWav: '[API Response] The returned WAV cannot be decoded (only 32-bit float / PCM16 / PCM32 are supported).',
      apiEmptyAudio: '[API Response] The service returned empty audio.',
      apiEmptyNotes: '[API Request] There are no notes to synthesize.',
      apiTestOk: 'Connected: "{name}"{summary}',
    },
    about: {
      soulXSingerEditor: 'SoulX Singer Editor',
      aiSvsWorkbench: 'AI Singing Voice Synthesis Workbench based on ONNX Runtime / DirectML',
      version: 'Version',
    },
    resourceManager: {
      title: 'Resource Manager',
    },
    modelDownload: {
      // W20: window title for the model download window (was hardcoded Chinese).
      title: 'SXSEditor Model Download',
      sifiganUrlNotConfigured: 'Download URL not configured. Please wait for the author to upload to ModelScope or manually place the model files.',
    },
    // W20: window titles for the fragment editor and audio preprocess windows.
    fragment: {
      title: 'Fragment Editor - {name}',
    },
    preprocess: {
      title: 'Audio Preprocessing',
    },
    singerCreator: {
      title: 'Singer Creator',
      fileMenu: 'File',
      save: 'Save',
      saveAs: 'Save As...',
      close: 'Close',
    },
    singerMarket: {
      title: 'Singer Market',
      // Region-specific message when a mainland-China network cannot reach the backend.
      serviceUnavailableCN: 'This service is not available in your region. The server is unreachable.',
      diagApiAddress: 'API address',
      diagDns: 'DNS resolution',
      diagSystem: 'system',
      diagTimeout: 'Timeout settings',
      diagRegion: 'Egress network',
      diagAttempts: 'Connection attempts',
      diagLastError: 'Last error',
      diagFailed: 'failed',
      diagUnknown: 'unknown',
    },
  },
};

let mainLocale = 'en';

function loadMainLocale() {
  // A6: 配置读取统一走 ConfigStore，避免文件名在主进程里被多处硬编码。
  const data = require('./configStore').readJsonConfig('locale');
  if (data && data.locale && mainLocales[data.locale]) {
    mainLocale = data.locale;
    return;
  }
  // No config file — detect system language
  const sysLang = app.getLocale(); // e.g. 'zh-CN', 'en-US', 'ja'
  if (sysLang.startsWith('zh')) {
    mainLocale = 'zh-CN';
  } else {
    mainLocale = 'en';
  }
}

function t(key, params) {
  const resolve = (obj, k) => k.split('.').reduce((o, p) => (o && o[p] !== undefined ? o[p] : undefined), obj);
  let value = resolve(mainLocales[mainLocale], key);
  if (value === undefined) value = resolve(mainLocales['en'], key);
  if (value === undefined) return key;
  if (params) {
    return value.replace(/\{(\w+)\}/g, (_, name) => params[name] !== undefined ? params[name] : `{${name}}`);
  }
  return value;
}

function setLocale(locale) {
  if (mainLocales[locale]) {
    mainLocale = locale;
  }
}

function getLocale() {
  return mainLocale;
}

function getMainLocales() {
  return mainLocales;
}

module.exports = {
  loadMainLocale,
  t,
  setLocale,
  getLocale,
  getMainLocales,
};
