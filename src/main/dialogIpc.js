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

  // Atomic file save: write to a temp file in the same directory, then
  // rename over the target. A crash/power loss mid-write can no longer leave
  // a truncated .sxsproj. The previous version is kept as <file>.bak so the
  // user always has one fallback copy.
  ipcMain.handle('file:saveFile', async (event, filePath, data) => {
    if (!isPathAllowed(filePath)) {
      return { success: false, error: t('error.pathNotAllowed') };
    }
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const bakPath = `${filePath}.bak`;
    try {
      await fs.promises.writeFile(tmpPath, data);
      // Move the current file to .bak (ENOENT on first save is fine), then
      // atomically replace the target with the temp file. If the final
      // rename fails, restore the backup so nothing is lost.
      let hadOriginal = false;
      try {
        await fs.promises.rename(filePath, bakPath);
        hadOriginal = true;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      try {
        await fs.promises.rename(tmpPath, filePath);
      } catch (err) {
        if (hadOriginal) {
          try { await fs.promises.rename(bakPath, filePath); } catch (_) {}
        }
        throw err;
      }
      return { success: true };
    } catch (err) {
      console.error('[Main] File save failed:', err.message);
      return { success: false, error: err.message };
    } finally {
      // Best-effort cleanup of a leftover temp file (rename already consumed
      // it on success; this only fires on earlier failures).
      fs.promises.unlink(tmpPath).catch(() => {});
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

  // 在系统默认浏览器中打开外部链接（设置 → 关于页面中的 arXiv / 项目主页等）。
  // 仅允许 https 且主机名命中白名单，防止被攻陷的渲染进程拉起任意 URI
  // （file://、smb://、钓鱼站点等）。主机名按"边界匹配"，避免
  // github.com.evil.com 之类的前缀绕过。
  ipcMain.handle('shell:open-external', async (event, url) => {
    const ALLOWED_HOSTS = [
      'arxiv.org',
      'github.com',
      'huggingface.co',
      'basicpitch.io',
      'soul-ailab.github.io',
      'rosvot.github.io',
    ];
    if (!url || typeof url !== 'string') {
      return { success: false, error: 'Invalid URL' };
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return { success: false, error: 'Invalid URL' };
    }
    if (parsed.protocol !== 'https:') {
      return { success: false, error: 'Only https URLs are allowed' };
    }
    const host = parsed.hostname.toLowerCase();
    const allowed = ALLOWED_HOSTS.some(domain => host === domain || host.endsWith('.' + domain));
    if (!allowed) {
      return { success: false, error: 'Host not allowed' };
    }
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      console.error('[Main] openExternal failed:', err.message);
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerDialogIpc,
};
