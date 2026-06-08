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

function isPathAllowed(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (dialogAuthorizedPaths.has(resolved)) return true;
    if (dialogAuthorizedPaths.has(path.dirname(resolved))) return true;
    return ALLOWED_SAVE_DIRS.some(dirFn => {
      try {
        return resolved.startsWith(path.resolve(dirFn()));
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
