'use strict';
/**
 * 插件 API v2 的公共常量与上限（CommonJS，主进程 / 渲染进程 / 插件 runtime 共用）。
 *
 * 冻结原则：这个文件只增不改。任何破坏性调整都必须升 API_VERSION，
 * 并给旧版本留至少一个小版本的兼容层 —— 否则第三方插件会在用户机器上静默失效。
 */

/** 当前契约版本。v1 = 既有歌声后端（src/shared/pluginContract.js）。 */
const API_VERSION = 2;

/** 宿主可加载的 apiVersion 集合。v1 由 legacy 路径接管，不进本套注册表。 */
const SUPPORTED_API_VERSIONS = Object.freeze([1, 2]);

/** manifest 里可声明的贡献点名称（未知键直接拒绝，避免拼写错误静默失效）。 */
const CONTRIBUTION_KEYS = Object.freeze([
  'commands', 'menus', 'panels', 'fileTypes', 'settings', 'keybindings',
  'toolbar', 'statusBar', 'contextMenus', 'timelineOverlays',
  'pipeline', 'synthesis', 'services', 'automation', 'llm', 'intents',
]);

/** 贡献点上限：防止一个坏 manifest 把界面撑爆。 */
const LIMITS = Object.freeze({
  commands: 128,
  menus: 128,
  panels: 32,
  fileTypes: 64,
  settings: 32,
  keybindings: 128,
  toolbar: 32,
  statusBar: 32,
  contextMenus: 64,
  timelineOverlays: 16,
  hooksPerStage: 8,
  services: 32,
  automationMethods: 128,
  intents: 64,
  /** 单个 manifest 声明的贡献项总数（跨类别）。 */
  totalContributions: 512,
});

/** 权限组与取值域。 */
const PERMISSION_GROUPS = Object.freeze({
  fs: ['pluginData', 'userPicked:read', 'userPicked:write', 'models'],
  ort: ['cpu', 'dml', 'webnn'],
  net: null,               // null = 自由字符串数组（域名 allowlist）
  project: ['read', 'write'],
  ui: ['panel', 'menu', 'toolbar', 'settings', 'statusBar', 'overlay', 'contextMenu'],
  automation: ['expose'],
  secrets: ['read', 'write'],
  clipboard: ['read', 'write'],
  notification: ['show'],
  llm: ['provider', 'consume'],
});

/** 面板可以申请的能力（iframe 内可见的 RPC 方法白名单）。 */
const PANEL_SCOPES = Object.freeze([
  'project.read', 'project.apply', 'project.document',
  'files.pick', 'files.readPicked',
  'command.run', 'command.list',
  'ui.notify', 'ui.progress', 'ui.setTitle', 'ui.resize',
  'state.get', 'state.set', 'state.delete',
  'ort.run', 'ort.manifest',
  'llm.chat',
  'audio.decode', 'audio.encode',
  'i18n.t', 'theme.tokens', 'host.version',
]);

/** 管线注入点。顺序固定，宿主按 order 数值 + pluginId 稳定排序。 */
const HOOK_STAGES = Object.freeze(['preEncoder', 'postMel', 'postWaveform']);

/** hook 的执行形态：model = 在推理 worker 内用 ORT 执行，张量不出进程；js = 跨进程回调。 */
const HOOK_KINDS = Object.freeze(['model', 'js']);

/** 消息种类。 */
const MSG = Object.freeze({
  REQ: 'req',
  RES: 'res',
  EVT: 'evt',
  READY: 'ready',
});

/** 统一错误码，渲染层与 agent 都按它分支。 */
const ERR = Object.freeze({
  PLUGIN_UNLOADED: 'PLUGIN_UNLOADED',
  PLUGIN_CRASHED: 'PLUGIN_CRASHED',
  PLUGIN_TIMEOUT: 'PLUGIN_TIMEOUT',
  PLUGIN_QUARANTINED: 'PLUGIN_QUARANTINED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_MANIFEST: 'INVALID_MANIFEST',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  UNSUPPORTED: 'UNSUPPORTED',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
});

/** 超时（毫秒）。插件是第三方代码，任何一次调用都必须有上限。 */
const TIMEOUTS = Object.freeze({
  /** 加载/初始化：包含 require、模型热身。 */
  init: 30000,
  /** 普通命令。 */
  command: 60000,
  /** panel RPC 默认值，可在 manifest 的 panel.timeoutMs 覆盖。 */
  panelRpc: 30000,
  /** 卸载时等待进程退出的宽限期，超过即强杀。 */
  killGrace: 2000,
  /** 卸载后等待异步回收完成，再采样泄漏计数。 */
  leakSampleDelay: 500,
});

/** 进程与内存上限。 */
const RUNTIME_LIMITS = Object.freeze({
  /** 单插件 JS 堆上限，交给 utilityProcess 的 execArgv。 */
  maxOldSpaceMb: 2048,
  /** 同时运行中的插件进程数（不活跃的会被回收）。 */
  maxLiveRuntimes: 8,
  /** 连续崩溃多少次后隔离。 */
  maxCrashes: 3,
  /** 连续泄漏多少次后隔离。 */
  maxLeaks: 2,
});

/** 包格式。 */
const PACKAGE = Object.freeze({
  /** 自定义扩展名，本质是 zip。 */
  ext: '.sxsp',
  manifest: 'manifest.json',
  checksums: 'checksums.json',
  signature: 'signature.json',
  /** 解压后总字节上限（防压缩炸弹）。 */
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 20000,
  maxSingleFileBytes: 256 * 1024 * 1024,
});

/** 目录约定（相对于 userData）。 */
const PATHS = Object.freeze({
  plugins: 'plugins',
  state: 'plugins-state',
  data: 'plugin-data',
  versions: '.versions',
  staging: '.staging',
});

module.exports = {
  API_VERSION,
  SUPPORTED_API_VERSIONS,
  CONTRIBUTION_KEYS,
  LIMITS,
  PERMISSION_GROUPS,
  PANEL_SCOPES,
  HOOK_STAGES,
  HOOK_KINDS,
  MSG,
  ERR,
  TIMEOUTS,
  RUNTIME_LIMITS,
  PACKAGE,
  PATHS,
};
