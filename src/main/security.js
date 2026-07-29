const { app } = require('electron');
const path = require('node:path');

const ALLOWED_SAVE_DIRS = [
  () => app.getPath('userData'),
  () => app.getPath('documents'),
  () => app.getPath('desktop'),
  () => app.getPath('home'),
  () => app.getPath('temp'),
];

const dialogAuthorizedPaths = new Set();

function authorizePath(filePath) {
  if (typeof filePath === 'string' && filePath.length > 0) {
    dialogAuthorizedPaths.add(path.resolve(filePath));
    const dir = path.dirname(path.resolve(filePath));
    dialogAuthorizedPaths.add(dir);
    if (dialogAuthorizedPaths.size > 1000) {
      const entries = [...dialogAuthorizedPaths];
      dialogAuthorizedPaths.clear();
      for (let i = Math.floor(entries.length / 2); i < entries.length; i++) {
        dialogAuthorizedPaths.add(entries[i]);
      }
    }
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
  isPathAllowed,
  isSystemPath,
  getForbiddenPrefixes,
};
