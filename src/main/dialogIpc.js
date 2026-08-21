const { ipcMain, dialog, BrowserWindow, shell } = require('electron');
const { authorizePath, isPathAllowed } = require('./security');
const { t } = require('./locale');
const fs = require('node:fs');
const path = require('node:path');

function registerDialogIpc() {
  ipcMain.handle('dialog:showSaveDialog', async (event, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const safeOptions = {
      title: typeof options.title === 'string' ? options.title : undefined,
      defaultPath: typeof options.defaultPath === 'string' ? options.defaultPath : undefined,
      filters: Array.isArray(options.filters) ? options.filters : undefined,
    };
    const result = await dialog.showSaveDialog(win, safeOptions);
    if (!result.canceled && result.filePath) {
      authorizePath(result.filePath);
    }
    return result;
  });

  ipcMain.handle('dialog:showOpenDialog', async (event, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const safeOptions = {
      title: typeof options.title === 'string' ? options.title : undefined,
      defaultPath: typeof options.defaultPath === 'string' ? options.defaultPath : undefined,
      filters: Array.isArray(options.filters) ? options.filters : undefined,
      properties: Array.isArray(options.properties) ? options.properties.filter(p =>
        ['openFile', 'openDirectory', 'multiSelections'].includes(p)
      ) : ['openFile'],
    };
    const result = await dialog.showOpenDialog(win, safeOptions);
    if (!result.canceled && result.filePaths) {
      result.filePaths.forEach(fp => authorizePath(fp));
    }
    return result;
  });

  ipcMain.handle('file:saveFile', async (event, filePath, data) => {
    if (!isPathAllowed(filePath)) {
      return { success: false, error: t('error.pathNotAllowed') };
    }
    try {
      await fs.promises.writeFile(filePath, data);
      return { success: true };
    } catch (err) {
      console.error('[Main] File save failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('file:readFile', async (event, filePath) => {
    if (!isPathAllowed(filePath)) {
      throw new Error(t('error.pathNotAllowed'));
    }
    try {
      const data = await fs.promises.readFile(filePath, 'utf-8');
      return data;
    } catch (err) {
      console.error('[Main] File read failed:', err.message);
      throw err;
    }
  });

  ipcMain.handle('file:readFileBuffer', async (event, filePath) => {
    if (!isPathAllowed(filePath)) {
      throw new Error(t('error.pathNotAllowed'));
    }
    try {
      const buffer = await fs.promises.readFile(filePath);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } catch (err) {
      console.error('[Main] File read (Buffer) failed:', err.message);
      throw err;
    }
  });

  ipcMain.handle('file:exists', async (event, filePath) => {
    if (!isPathAllowed(filePath)) return false;
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
      return true;
    } catch (_) {
      return false;
    }
  });

  ipcMain.handle('file:authorizePath', async (event, dirPath) => {
    const { isSystemPath } = require('./security');
    if (isSystemPath(dirPath)) {
      return { success: false, error: 'Cannot authorize system directories' };
    }
    authorizePath(path.resolve(dirPath));
    return { success: true };
  });

  ipcMain.handle('resolvePath', async (event, basePath, relativePath) => {
    const resolved = path.resolve(basePath, relativePath);
    const normalizedBase = path.resolve(basePath);
    if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
      throw new Error('Path traversal blocked');
    }
    return resolved;
  });

  ipcMain.handle('getDirName', async (event, filePath) => {
    if (!isPathAllowed(filePath)) throw new Error(t('error.pathNotAllowed'));
    return path.dirname(filePath);
  });

  // 在系统文件管理器中显示指定文件（高亮选中该文件）
  // 用于导出完成后自动打开导出位置
  ipcMain.handle('shell:showItemInFolder', async (event, filePath) => {
    try {
      const resolved = path.resolve(filePath);
      // Only reveal files under already-authorized paths. Previously this
      // branch auto-authorized any path, which let a compromised renderer
      // reveal arbitrary file-system locations (information leak / phishing).
      if (!isPathAllowed(resolved)) {
        return { success: false, error: t('error.pathNotAllowed') };
      }
      const fs = require('node:fs');
      if (fs.existsSync(resolved)) shell.showItemInFolder(resolved);
      else await shell.openPath(path.dirname(resolved));
      return { success: true };
    } catch (err) {
      console.error('[Main] showItemInFolder failed:', err.message);
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerDialogIpc,
};
