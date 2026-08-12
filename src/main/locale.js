const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

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
      website: '官网',
      userDocs: '用户帮助文档',
      devDocs: '开发者文档',
      openLogDir: '打开日志文件夹',
      openDumpDir: '打开崩溃转储文件夹',
    },
    dialog: {
      saveSingerFile: '保存歌手文件',
      selectModelDownloadLocation: '选择模型文件下载位置（默认位置无需管理员权限）',
      selectFolder: '选择此文件夹',
      importMidi: '导入MIDI文件',
    },
    error: {
      pathNotAllowed: '不允许访问该路径',
      svsNotInitialized: 'SVS Pipeline 未初始化',
      fragmentSvsNotInitialized: 'Fragment SVS Pipeline 未初始化',
      // W19: i18n key for the JP-models-missing error (was hardcoded Chinese).
      jpModelNotDownloaded: '日语模型未下载。请在模型下载页面下载日语模型。',
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
    },
  },
  'en': {
    menu: {
      aboutSXSEditor: 'About SXSEditor',
      quit: 'Quit',
      file: 'File',
      save: 'Save',
      saveAs: 'Save As...',
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
      website: 'Website',
      userDocs: 'User Documentation',
      devDocs: 'Developer Documentation',
      openLogDir: 'Open Logs Folder',
      openDumpDir: 'Open Crash Dumps Folder',
    },
    dialog: {
      saveSingerFile: 'Save Singer File',
      selectModelDownloadLocation: 'Select model file download location (default location doesn\'t require admin privileges)',
      selectFolder: 'Select This Folder',
      importMidi: 'Import MIDI File',
    },
    error: {
      pathNotAllowed: 'Access to this path is not allowed',
      svsNotInitialized: 'SVS Pipeline not initialized',
      fragmentSvsNotInitialized: 'Fragment SVS Pipeline not initialized',
      // W19: i18n key for the JP-models-missing error (was hardcoded Chinese).
      jpModelNotDownloaded: 'Japanese model not downloaded. Please download the Japanese model on the model download page.',
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
    },
  },
};

let mainLocale = 'en';

function loadMainLocale() {
  try {
    const configPath = path.join(app.getPath('userData'), 'sxseditor-locale.json');
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (data.locale && mainLocales[data.locale]) {
        mainLocale = data.locale;
        return;
      }
    }
  } catch (err) { console.warn('[Main] Failed to load locale config:', err.message); }
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
