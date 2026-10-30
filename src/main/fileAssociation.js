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

/** 支持的两种文件类型。新增类型只改这里，注册与分发都按它走。 */
const FILE_TYPES = [
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

const EXT_TO_KIND = new Map(FILE_TYPES.map((t) => [t.ext, t.kind]));

/** 从命令行里挑出第一个我们认识的文件路径。 */
function extractOpenPath(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue;
    const ext = path.extname(arg).toLowerCase();
    if (!EXT_TO_KIND.has(ext)) continue;
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

/** 按扩展名判断文件类型，认不出返回 null。 */
function classify(filePath) {
  if (!filePath) return null;
  const kind = EXT_TO_KIND.get(path.extname(filePath).toLowerCase());
  return kind ? { kind, path: filePath } : null;
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

async function registerWindowsType(type) {
  const classes = `HKCU\\Software\\Classes`;
  const extKey = `${classes}\\${type.ext}`;
  const progKey = `${classes}\\${type.progId}`;

  // 用户可能已经用"打开方式 → 始终使用"指定了别的程序。那种情况下 .ext 的
  // 默认值不是我们的 progId，说明用户做过显式选择，不能覆盖。
  const current = await queryReg(extKey);
  if (current && current !== type.progId) return false;

  const exe = process.execPath;
  const ok = await regAdd([extKey, '/ve', '/d', type.progId]);
  await regAdd([progKey, '/ve', '/d', type.label]);
  if (fs.existsSync(iconPath(type.icon))) {
    await regAdd([`${progKey}\\DefaultIcon`, '/ve', '/d', iconPath(type.icon)]);
  }
  await regAdd([`${progKey}\\shell\\open\\command`, '/ve', '/d', `"${exe}" "%1"`]);
  return ok;
}

/**
 * 确保 Windows 上两类文件都关联到当前可执行文件。
 *
 * 只在打包后执行：开发模式跑的是 electron.exe，写进注册表会把 .sxsproj 绑到
 * 一个随时会消失的调试二进制上。失败不抛错 —— 关联不上不该拦住应用启动。
 */
async function ensureWindowsFileAssociations() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  for (const type of FILE_TYPES) {
    try {
      await registerWindowsType(type);
    } catch (err) {
      console.warn('[fileAssoc] register failed:', type.ext, err.message);
    }
  }
}

module.exports = {
  FILE_TYPES,
  extractOpenPath,
  classify,
  setPendingTarget,
  takePendingTarget,
  ensureWindowsFileAssociations,
};
