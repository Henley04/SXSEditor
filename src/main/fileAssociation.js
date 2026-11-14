/**
 * 工程文件 / 歌手文件的系统关联与"双击打开"。
 *
 * 两条独立的链路，容易被混为一谈：
 *
 *   1. 关联（association）—— 让操作系统知道 .sxsproj 归谁、显示什么图标。
 *      Windows 写 HKCU\Software\Classes，安装器也会写一份；macOS 走 Info.plist
 *      的 CFBundleDocumentTypes；Linux 走 .desktop 的 MimeType。
 *
 *   2. 投递（delivery）—— 用户双击后，路径怎么进到渲染层。
 *      Windows/Linux 是命令行参数（首次启动在 argv，二次启动在 second-instance
 *      的 argv）；macOS 是 app 的 'open-file' 事件，**不经过 argv**。
 *
 * 投递统一收敛成一条通道：路径先放进 pending 槽，渲染层就绪后自己来 take，
 * 取走即清空。这样"冷启动传参"和"运行中再双击"不需要两套处理逻辑，也不会
 * 因为渲染层还没注册监听而把第一个文件丢掉。
 */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

/** 宿主自己接管的两种文件类型。插件声明的扩展名走 setPluginFileTypes 注入。 */
const BASE_FILE_TYPES = [
  {
    kind: 'project',
    ext: '.sxsproj',
    progId: 'SXSEditor.Project',
    label: 'SXSEditor 工程',
    icon: 'project',
  },
  {
    kind: 'singer',
    ext: '.sxssinger',
    progId: 'SXSEditor.Singer',
    label: 'SXSEditor 歌手',
    icon: 'singer',
  },
];

/**
 * 插件声明的扩展名（M4）。
 *
 * 为什么要注入而不是让这里去读注册表：本模块在 `main.js` 顶层就被 require，
 * 那时插件服务还没初始化；而"双击投递"发生在任意时刻，必须能 O(1) 回答
 * "这个扩展名认不认识"。于是由 PluginService 在加载/卸载后主动推一份快照过来。
 */
let pluginFileTypes = [];

/** 扩展名 → 类型表。内置优先：插件不可能抢走 .sxsproj（manifest 层已拒绝）。 */
let extIndex = new Map(BASE_FILE_TYPES.map((t) => [t.ext, t]));

function rebuildIndex() {
  extIndex = new Map();
  for (const t of BASE_FILE_TYPES) extIndex.set(t.ext, t);
  for (const t of pluginFileTypes) {
    if (!extIndex.has(t.ext)) extIndex.set(t.ext, t);
  }
}

/**
 * 用插件当前的 fileTypes 替换注入表。
 *
 * 只收扩展名、kind、归属插件与显示名 —— 投递链路只需要知道"该交给谁"，
 * 不需要（也不该）在这里理解插件的 codec。
 */
function setPluginFileTypes(list) {
  const next = [];
  for (const item of Array.isArray(list) ? list : []) {
    const ext = typeof item?.ext === 'string' ? item.ext.toLowerCase() : '';
    if (!/^\.[a-z0-9]{1,16}$/.test(ext)) continue;
    if (BASE_FILE_TYPES.some((t) => t.ext === ext)) continue;
    next.push({
      kind: 'plugin',
      ext,
      pluginId: String(item.pluginId || ''),
      label: String(item.label || ext),
    });
  }
  pluginFileTypes = next;
  rebuildIndex();
}

function getFileTypes() {
  return [...BASE_FILE_TYPES, ...pluginFileTypes];
}

/** 从命令行里挑出第一个我们认识的文件路径。 */
function extractOpenPath(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue;
    const ext = path.extname(arg).toLowerCase();
    if (!extIndex.has(ext)) continue;
    try {
      const abs = path.resolve(arg);
      // 只接受真实存在的文件：命令行里可能是历史记录、网络路径残留
      if (fs.existsSync(abs)) return abs;
    } catch (_) {
      /* 路径非法就跳过 */
    }
  }
  return null;
}

/**
 * 按扩展名判断文件类型，认不出返回 null。
 *
 * 插件类型额外带上 pluginId：投递到渲染层后，界面要据此说明"这个文件由谁打开"，
 * 也方便出问题时直接看出路由到了哪个插件。
 */
function classify(filePath) {
  if (!filePath) return null;
  const type = extIndex.get(path.extname(filePath).toLowerCase());
  if (!type) return null;
  if (type.kind === 'plugin') return { kind: 'plugin', path: filePath, pluginId: type.pluginId };
  return { kind: type.kind, path: filePath };
}

// ---------------------------------------------------------------------------
// pending 槽
// ---------------------------------------------------------------------------
let pendingTarget = null;

/** 记录一个待打开文件。后到的覆盖先到的：双击第二个文件时以最新意图为准。 */
function setPendingTarget(target) {
  if (!target) return;
  pendingTarget = target;
}

/** 取走待打开文件并清空 —— 同一个文件不会被处理两次。 */
function takePendingTarget() {
  const t = pendingTarget;
  pendingTarget = null;
  return t;
}

// ---------------------------------------------------------------------------
// Windows 注册表
// ---------------------------------------------------------------------------

/** 读注册表默认值；键不存在返回 null（reg query 会以非零码退出）。 */
function queryReg(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve'], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      // 输出形如 "    (默认)    REG_SZ    值"，取最后一列
      const line = stdout.split(/\r?\n/).find((l) => /REG_SZ|REG_EXPAND_SZ/.test(l));
      if (!line) return resolve(null);
      resolve(line.split(/REG_SZ|REG_EXPAND_SZ/)[1].trim());
    });
  });
}

function regAdd(args) {
  return new Promise((resolve) => {
    execFile('reg', ['add', ...args, '/f'], { windowsHide: true }, (err) => resolve(!err));
  });
}

/** 删键 / 删值。失败（键本来就不存在）不算错。 */
function regDelete(key, valueArgs) {
  return new Promise((resolve) => {
    const args = ['delete', key];
    if (Array.isArray(valueArgs)) args.push(...valueArgs);
    args.push('/f');
    execFile('reg', args, { windowsHide: true }, (err) => resolve(!err));
  });
}

/**
 * 打包后图标随 extraResource 落进 resources/。
 *
 * electron-packager 复制 extraResource 时会丢掉父级目录，只保留 basename，
 * 所以 'assets/fileicons' 到了资源目录里就叫 'fileicons'。两个位置都查一遍 ——
 * 不同版本的 packager 行为有过差异，与其赌，不如都认。
 */
function iconPath(name) {
  const candidates = [
    path.join(process.resourcesPath, 'fileicons', `${name}.ico`),
    path.join(process.resourcesPath, 'assets', 'fileicons', `${name}.ico`),
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || candidates[0];
}

/**
 * 某个 ProgId 的打开命令是否指向当前可执行文件。
 *
 * 用来把"自家旧版本留下的陈旧关联"和"用户手动指定的第三方程序"区分开：
 * 前者可以安全接管，后者必须尊重。
 */
async function progIdPointsToUs(progId) {
  const cmd = await queryReg(`HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`);
  if (!cmd) return false;
  const norm = (s) => s.replace(/"/g, '').toLowerCase().replace(/\//g, '\\');
  return norm(cmd).includes(norm(process.execPath));
}

async function registerWindowsType(type) {
  const classes = `HKCU\\Software\\Classes`;
  const extKey = `${classes}\\${type.ext}`;
  const progKey = `${classes}\\${type.progId}`;
  const exe = process.execPath;
  const icon = iconPath(type.icon);
  const hasIcon = (() => { try { return fs.existsSync(icon); } catch (_) { return false; } })();

  // 1) ProgId 自身：标签 / 图标 / 打开命令。这三条无条件写 —— 即使默认关联
  //    被别的程序占着，"打开方式"列表里也得有我们，而且得带图标。
  await regAdd([progKey, '/ve', '/d', type.label]);
  if (hasIcon) {
    // 末尾的 ,0 是图标索引：Windows 认这一种写法，裸路径在部分版本上取不到
    await regAdd([`${progKey}\\DefaultIcon`, '/ve', '/d', `${icon},0`]);
  }
  await regAdd([`${progKey}\\shell\\open\\command`, '/ve', '/d', `"${exe}" "%1"`]);

  // 2) 扩展名的 OpenWithProgids。旧实现只在"默认值不是别人"时才写这条，
  //    结果一旦被抢占，用户连右键"打开方式"里都找不到本程序，只能手动翻 exe。
  await regAdd([`${extKey}\\OpenWithProgids`, '/v', type.progId, '/t', 'REG_SZ', '/d', '']);

  // 3) 默认关联（决定双击行为 + 资源管理器用哪个图标）。
  const current = await queryReg(extKey);
  if (!current) {
    await regAdd([extKey, '/ve', '/d', type.progId]);
    return true;
  }
  if (current === type.progId) return true;

  // 默认值指向别的 ProgId，分两种情况：
  //   · 指向本程序的另一个 ProgId —— 旧版本遗留（工程扩展名早先用过
  //     SXSEditor.sxsproj）。旧 ProgId 往往没有 DefaultIcon，资源管理器就一直
  //     显示空白图标；而歌手扩展名是后加的、从没被旧 ProgId 占过，所以出现了
  //     "sxssinger 有图标、sxsproj 没有"。这种情况安全接管。
  //   · 指向第三方程序 —— 那是用户的显式选择，保留默认值，只补 OpenWithProgids。
  const stale = await progIdPointsToUs(current);
  if (stale) {
    await regAdd([extKey, '/ve', '/d', type.progId]);
    return true;
  }
  return false;
}

/**
 * 确保 Windows 上两类内置文件都关联到当前可执行文件，并同步插件扩展名。
 *
 * 只在打包后执行：开发模式跑的是 electron.exe，写进注册表会把 .sxsproj 绑到
 * 一个随时会消失的调试二进制上。失败不抛错 —— 关联不上不该拦住应用启动。
 *
 * 插件扩展名走独立开关（见 syncWindowsPluginFileAssociations）：它们会随插件
 * 装卸而变化，写进系统的副作用比内置格式大，所以默认关闭、由用户显式选择。
 */
async function ensureWindowsFileAssociations() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  for (const type of BASE_FILE_TYPES) {
    try {
      await registerWindowsType(type);
    } catch (err) {
      console.warn('[fileAssoc] register failed:', type.ext, err.message);
    }
  }
  refreshShellIcons();
  try {
    await syncWindowsPluginFileAssociations();
  } catch (err) {
    console.warn('[fileAssoc] 插件关联同步失败:', err && err.message);
  }
}

/**
 * 关联改写后通知资源管理器重读图标。
 *
 * 只改注册表而不刷新的话，Windows 会继续用 IconCache 里的旧图标 —— 表现就是
 * "注册表已经指到新 ico 了，文件夹里还是白纸"。ie4uinit -show 是系统自带的
 * 刷新入口；失败无所谓，重启资源管理器同样能生效。
 */
function refreshShellIcons() {
  execFile('ie4uinit.exe', ['-show'], { windowsHide: true }, () => {});
}

// ---------------------------------------------------------------------------
// 插件扩展名的系统级关联（M4）
// ---------------------------------------------------------------------------
/**
 * 插件扩展名的 ProgId 前缀。
 *
 * 用固定前缀而不是每个插件随便起名，是为了让"清理"有一个可枚举的边界：
 * 只要扫 `HKCU\Software\Classes` 下这个前缀的子键，就知道我们往系统里写过什么。
 * 这是孤儿项唯一的可靠解法 —— 靠内存记录的话，崩溃一次就再也找不到它们。
 */
const PLUGIN_PROGID_PREFIX = 'SXSEditor.Plugin.';

/**
 * `pluginId` + 扩展名 → ProgId。
 *
 * 插件 id 允许点分（com.example.demo），所以扩展名放在**最后**一段并用
 * 去掉点的形式：反解时取最后一个点之后就是扩展名。
 */
function pluginProgId(pluginId, ext) {
  const safeId = String(pluginId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48);
  const safeExt = String(ext || '').replace(/^\./, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return `${PLUGIN_PROGID_PREFIX}${safeId}.${safeExt}`;
}

/** 从 ProgId 反解扩展名（清理时要知道 OpenWithProgids 挂在哪个扩展名下）。 */
function extFromPluginProgId(progId) {
  if (typeof progId !== 'string' || !progId.startsWith(PLUGIN_PROGID_PREFIX)) return null;
  const rest = progId.slice(PLUGIN_PROGID_PREFIX.length);
  const i = rest.lastIndexOf('.');
  if (i <= 0 || i === rest.length - 1) return null;
  return `.${rest.slice(i + 1)}`;
}

/** 枚举我们写进系统的插件 ProgId。非 Windows / 无权限时返回空数组。 */
function listPluginProgIds() {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKEY_CURRENT_USER\\Software\\Classes'],
      { windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const out = [];
        for (const line of stdout.split(/\r?\n/)) {
          const m = /\\Classes\\(SXSEditor\.Plugin\.[^\s]+)\s*$/.exec(line.trim());
          if (m) out.push(m[1]);
        }
        resolve(out);
      },
    );
  });
}

/**
 * 摘掉一个插件 ProgId。
 *
 * 顺序有讲究：先删 `OpenWithProgids` 里的值、再删默认值、最后删 ProgId 树。
 * 反过来的话，删完树之后我们仍然知道 ext（从 ProgId 反解），但如果中途失败，
 * 扩展名下会留下一个指向"已经不存在的 ProgId"的默认值 —— 资源管理器双击时
 * 找不到处理程序，比"打开方式里没有我们"更糟。
 */
async function unregisterPluginProgId(progId) {
  const ext = extFromPluginProgId(progId);
  const classes = 'HKCU\\Software\\Classes';
  if (ext) {
    await regDelete(`${classes}\\${ext}\\OpenWithProgids`, ['/v', progId]);
    const current = await queryReg(`${classes}\\${ext}`);
    if (current === progId) await regDelete(`${classes}\\${ext}`, ['/ve']);
  }
  await regDelete(`${classes}\\${progId}`);
}

/**
 * 同步插件扩展名的系统关联。
 *
 * 三态：
 *   · 设置里 `pluginFileAssociations` 未开 → 期望集合为空，把写过的全删掉；
 *   · 开了 → 每个插件扩展名一个 ProgId，标签用插件给的显示名；
 *   · 插件被卸载/停用 → 它从 `pluginFileTypes` 消失，下次同步即被删掉。
 *
 * 只在**打包后的 Windows** 上执行：开发模式跑的是 electron.exe，写进注册表
 * 会把 .demo 绑到一个随时会消失的调试二进制上 —— 卸载重装后用户的文件就打不开了。
 *
 * 默认关闭。注册表项的生命周期比插件长，`pluginFileAssociations` 是让用户
 * 显式选择"我愿意让这个应用接管这些扩展名"，而不是装个插件就悄悄改系统。
 */
async function syncWindowsPluginFileAssociations() {
  if (process.platform !== 'win32' || !app.isPackaged) return { changed: false, registered: 0, removed: 0 };

  let enabled = false;
  try {
    const s = require('./settings').loadSettings();
    enabled = s && s.pluginFileAssociations === true;
  } catch (_) { /* 设置读不到就当作关 */ }

  const desired = new Map();
  if (enabled) {
    for (const t of pluginFileTypes) desired.set(pluginProgId(t.pluginId, t.ext), t);
  }

  let removed = 0;
  let registered = 0;
  for (const progId of await listPluginProgIds()) {
    if (desired.has(progId)) continue;
    try {
      await unregisterPluginProgId(progId);
      removed++;
    } catch (err) {
      console.warn('[fileAssoc] 清理插件关联失败:', progId, err.message);
    }
  }
  for (const [progId, type] of desired) {
    try {
      // 插件类型统一用工程的图标：插件的 .sxsp 里没有独立 ico 的落位约定，
      // 用一个能打开的图标比每个插件各带一份资源现实得多。
      await registerWindowsType({ ...type, progId, icon: 'project' });
      registered++;
    } catch (err) {
      console.warn('[fileAssoc] 注册插件关联失败:', type.ext, err.message);
    }
  }
  if (registered || removed) refreshShellIcons();
  return { changed: Boolean(registered || removed), registered, removed };
}

module.exports = {
  FILE_TYPES: BASE_FILE_TYPES,
  getFileTypes,
  setPluginFileTypes,
  extractOpenPath,
  classify,
  setPendingTarget,
  takePendingTarget,
  ensureWindowsFileAssociations,
  syncWindowsPluginFileAssociations,
  pluginProgId,
  extFromPluginProgId,
};
