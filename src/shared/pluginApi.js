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
  'commands', 'menus', 'panels', 'fileTypes', 'exporters', 'settings', 'keybindings',
  'toolbar', 'statusBar', 'contextMenus', 'timelineOverlays',
  // `models` 取代了早期的 `llm`：模型调用面不局限于大模型，MIDI 生成 / 伴奏生成 /
  // 歌声合成 / TTS / ASR 都走同一套端点与授权（见设计方案 §12）。
  'pipeline', 'synthesis', 'services', 'automation', 'models', 'intents',
  // 宿主渲染的文案（工具栏 tooltip、状态栏、右键菜单）由插件自带字典，
  // 统一挂在 `plugin.<id>.` 前缀下；manifest 里只放扁平键值，不接受嵌套对象。
  'i18n',
]);

/** 右键菜单可插入的区域。区域由宿主定义，插件只能声明"插到哪个区域"。 */
const CONTEXT_AREAS = Object.freeze(['fragment', 'singer', 'canvas']);

/** 状态栏两个槽位。 */
const STATUS_ALIGNMENTS = Object.freeze(['left', 'right']);

/** 时间轴浮层的锚点。当前只支持时间轴画布：位置、裁剪都由宿主决定。 */
const OVERLAY_ANCHORS = Object.freeze(['canvas']);

/**
 * 贡献项的显示条件。
 *
 * 故意只做一个**封闭集合**而不是通用表达式：`when` 一旦可编程，插件就能把自己的
 * 求值逻辑塞进宿主每一帧的渲染路径，既难测也难保证不抛异常。这里宿主认识的条件
 * 都是布尔值，`!` 前缀取反，多个条件用 `&&` 连接。
 */
const WHEN_CLAUSES = Object.freeze([
  'projectOpen', 'hasFragments', 'hasSelection', 'playing', 'idle',
]);

/** 贡献点上限：防止一个坏 manifest 把界面撑爆。 */
const LIMITS = Object.freeze({
  commands: 128,
  menus: 128,
  panels: 32,
  fileTypes: 64,
  exporters: 16,
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
  // 跨插件服务：provide = 允许别人调你的代码；consume = 允许你调别人的代码。
  // 两项分开，是因为"我能被调"和"我能调人"在安装弹窗里是两句话。
  services: ['provide', 'consume'],
  secrets: ['read', 'write'],
  clipboard: ['read', 'write'],
  notification: ['show'],
  // consume = 调用他人端点；provide = 注册自己的端点（出站仍由宿主代发）
  models: ['consume', 'provide'],
  // 插件自举依赖：inspect 只读，三种来源分开授权（非市场来源风险不同，安装弹窗里
  // 是三句不同的话），selfUpdate 单独一项是因为"改自己"和"装别人"不是一回事。
  // 声明依赖本身不需要权限；只有真正发起安装才需要对应项。
  plugins: ['inspect', 'installMarket', 'installUrl', 'installPath', 'selfUpdate'],
});

/**
 * 插件级依赖上限。与 LIMITS 分开：LIMITS 管的是贡献项（会进宿主渲染路径），
 * dependencies 只是清单元数据，不进渲染，但仍需封顶防止一个坏 manifest 撑爆
 * 依赖解析与循环检测。
 */
const DEPENDENCY_LIMITS = Object.freeze({
  max: 32,
  idMaxLength: 64,
  rangeMaxLength: 128,
});

/**
 * 插件 runtime 可调用的宿主方法白名单（runtime → 主进程方向）。
 *
 * 这里是**唯一真源**：PluginRuntimeManager 在转发前用它做第一道拦截，
 * PluginService._handleHostCall 再做第二道（含权限校验）。两处都拦，是因为
 * runtime 是第三方进程，不能假设它只会发白名单内的方法。
 */
const HOST_CALL_METHODS = Object.freeze([
  // 既有能力（改动此列表前先确认 pluginRuntimeEntry.js 里对应的 hostCall）
  'project.read', 'project.apply',
  'ui.notify', 'ui.status',
  'models.list', 'models.invoke', 'models.cancel', 'models.ack', 'models.read',
  'secrets.get', 'secrets.set', 'secrets.delete', 'secrets.keys',
  'service.call',
  // 插件自举依赖
  'plugins.list',
  'plugins.resolveDependencies',
  'plugins.installOne',
  'plugins.installMany',
]);

/** 面板可以申请的能力（iframe 内可见的 RPC 方法白名单）。 */
const PANEL_SCOPES = Object.freeze([
  'project.read', 'project.apply', 'project.document',
  'files.pick', 'files.readPicked',
  'command.run', 'command.list',
  'ui.notify', 'ui.progress', 'ui.setTitle', 'ui.resize', 'ui.status',
  'state.get', 'state.set', 'state.delete',
  'ort.run', 'ort.manifest',
  'models.invoke', 'models.list',
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
  /** 长任务被调用方取消（MCP job 的 cancel、CLI 的 Ctrl+C）。 */
  CANCELLED: 'CANCELLED',
  /** 服务提供方已卸载/停用：这是"端点没了"，不是"你调错了"。 */
  SERVICE_GONE: 'SERVICE_GONE',
});

/** 超时（毫秒）。插件是第三方代码，任何一次调用都必须有上限。 */
const TIMEOUTS = Object.freeze({
  /** 加载/初始化：包含 require、模型热身。 */
  init: 30000,
  /** 普通命令。 */
  command: 60000,
  /**
   * 声明了 `long: true` 的命令。
   *
   * 与 MCP 桥接层 LONG_TIMEOUT_MS（600s）同量级，但**必须更短**：让插件先报
   * "我超时了"，桥接层才不会抢在它前面把调用变成一个没有上下文的 TIMEOUT。
   */
  longCommand: 570000,
  /** 跨插件服务调用。提供方是别人写的代码，消费方不该被它无限期拖住。 */
  service: 30000,
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
  /**
   * 连续泄漏多少次后隔离。
   *
   * 注意：M1 只在卸载时采样一次泄漏，而此时插件记录已删除，没有可累计的对象，
   * 所以这个阈值目前**没有消费方**（泄漏只写审计）。等 M2 把泄漏检测接到
   * "停用 / 重载" 路径上再生效。留在这里是为了让契约先固定下来。
   */
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
  CONTEXT_AREAS,
  STATUS_ALIGNMENTS,
  OVERLAY_ANCHORS,
  WHEN_CLAUSES,
  LIMITS,
  DEPENDENCY_LIMITS,
  HOST_CALL_METHODS,
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
