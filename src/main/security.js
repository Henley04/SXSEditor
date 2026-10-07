const { app } = require('electron');
const path = require('node:path');

// 无需任何授权即可访问的目录。这里曾经列着 app.getPath('home') 与 'temp'，
// 而 isPathAllowed() 对它们是递归前缀匹配 —— 等于让渲染进程无条件读写
// 整个用户主目录（~/.ssh、~/.aws、浏览器 cookie……）与系统临时目录。
// 保留范围只到"本应用确实会把文件放在这里"的三个目录；其余位置必须经
// 原生对话框（dialogIpc.js 的 authorizePath 调用点）或 file:authorizePath
// 的白名单规则授权。模型目录（可能在任意盘）由主进程 getModelDir 内部授权。
const ALLOWED_SAVE_DIRS = [
  () => app.getPath('userData'),
  () => app.getPath('documents'),
  () => app.getPath('desktop'),
];

const dialogAuthorizedPaths = new Set();

function authorizePath(filePath) {
  if (typeof filePath === 'string' && filePath.length > 0) {
    _addAuthorized(path.resolve(filePath));
    // 连带把父目录也写进白名单：授权一个素材文件后，同目录的工程伴生文件
    // （伴奏、歌姬包）才不必逐个再授权一次。
    // 注意：对"目录"不能用这个版本的授权 —— 一旦授权 D:\models，父目录 D:\
    // 也会进白名单，等于放行整个盘。授权目录请用 authorizePathExact()。
    _addAuthorized(path.dirname(path.resolve(filePath)));
  }
}

// 只授权路径本身，不连带父目录。用于"模型目录"这类用户可配到任意盘的位置：
// 授权 D:\models 之后，isPathAllowed() 对 D:\models\*.onnx 依然成立（父目录命中），
// 但 D:\ 本身不在白名单里，D:\evil.txt 不会被连带放行。
function authorizePathExact(filePath) {
  if (typeof filePath === 'string' && filePath.length > 0) {
    _addAuthorized(path.resolve(filePath));
  }
}

function _addAuthorized(resolvedPath) {
  dialogAuthorizedPaths.add(resolvedPath);
  if (dialogAuthorizedPaths.size > 1000) {
    const entries = [...dialogAuthorizedPaths];
    dialogAuthorizedPaths.clear();
    for (let i = Math.floor(entries.length / 2); i < entries.length; i++) {
      dialogAuthorizedPaths.add(entries[i]);
    }
  }
}

// 路径自身或任一祖先已经在白名单中。供 file:authorizePath 做幂等判断：
// 已经放行过的目录再授权一次不应被新规则拒绝。
function isAuthorizedAncestor(resolvedPath) {
  let cur = path.resolve(resolvedPath);
  for (;;) {
    if (dialogAuthorizedPaths.has(cur)) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

function _normalizeSep(p) {
  // Normalize separators so the prefix check works regardless of host OS
  // (e.g. CI on Linux validating Windows-style paths, or vice versa).
  return p.replace(/\\/g, '/');
}

function isPathAllowed(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (dialogAuthorizedPaths.has(resolved)) return true;
    if (dialogAuthorizedPaths.has(path.dirname(resolved))) return true;
    const normalizedResolved = _normalizeSep(resolved);
    return ALLOWED_SAVE_DIRS.some(dirFn => {
      try {
        // Use a separator after the prefix to avoid prefix confusion: without
        // it, an allowed dir "/home/user" would also match "/home/userevil/...".
        // Must match either the exact dir or a path strictly beneath it.
        const allowed = _normalizeSep(path.resolve(dirFn()));
        return normalizedResolved === allowed || normalizedResolved.startsWith(allowed + '/');
      } catch (_) {
        return false;
      }
    });
  } catch (_) {
    return false;
  }
}

function getForbiddenPrefixes() {
  return process.platform === 'win32'
    ? [
        path.resolve('C:\\Windows'),
        path.resolve('C:\\Program Files'),
        path.resolve('C:\\Program Files (x86)'),
        path.resolve('C:\\ProgramData'),
      ]
    : [
        '/etc', '/root', '/sys', '/proc', '/dev', '/boot',
        '/System', '/Library',
      ];
}

function isSystemPath(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;

  // Normalize Windows-style separators and case so the check works regardless
  // of the current host OS (e.g. CI running on Linux validating Windows paths).
  const normalized = dirPath.replace(/\\/g, '/').toLowerCase();
  const windowsSystemPrefixes = [
    'c:/windows',
    'c:/program files',
    'c:/program files (x86)',
    'c:/programdata',
  ];
  const isWindowsSystemPath = windowsSystemPrefixes.some(prefix =>
    normalized === prefix || normalized.startsWith(prefix + '/')
  );
  if (isWindowsSystemPath) return true;

  const resolvedPath = path.resolve(dirPath);
  const forbiddenPrefixes = getForbiddenPrefixes();
  return forbiddenPrefixes.some(prefix => resolvedPath.startsWith(prefix + path.sep) || resolvedPath === prefix);
}

module.exports = {
  authorizePath,
  authorizePathExact,
  isAuthorizedAncestor,
  isPathAllowed,
  isSystemPath,
  getForbiddenPrefixes,
};
