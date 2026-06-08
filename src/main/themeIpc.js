const { ipcMain, dialog, app } = require('electron');
const themeStorage = require('../themes/themeStorage');
const BUILTIN_THEMES = require('../themes/builtins/index.js');
const { loadSettings, saveSettingsFile, DEFAULT_THEME } = require('./settings');
const { getAllWebContents } = require('./windowManager');

function listAllThemes() {
  const settings = loadSettings();
  const userDir = app.getPath('userData');
  const { themes: userThemes } = themeStorage.loadUserThemes(userDir);
  return [
    ...BUILTIN_THEMES.BUILTIN_THEMES.map(t => ({
      id: t.id,
      name: t.name || t.id,
      isDark: t.isDark === true,
      author: t.author || 'SXSEditor',
      version: t.version || '1.0.0',
      source: 'builtin',
      description: t.description || '',
    })),
    ...userThemes.map(t => ({
      id: t.id,
      name: t.name || t.id,
      isDark: t.isDark === true,
      author: t.author || '',
      version: t.version || '1.0.0',
      source: 'user',
      description: t.description || '',
    })),
  ];
}

function broadcastThemeChanged(themeId, scope) {
  for (const wc of getAllWebContents()) {
    try { wc.send('theme:changed', { themeId, scope }); } catch (_) {}
  }
}

function broadcastThemeListChanged() {
  for (const wc of getAllWebContents()) {
    try { wc.send('theme:list-changed'); } catch (_) {}
  }
}

function registerThemeIpc() {
  ipcMain.handle('theme:list', async () => {
    return listAllThemes();
  });

  ipcMain.handle('theme:get', async (event, themeId) => {
    if (!themeId) return null;
    const all = listAllThemes();
    const meta = all.find(t => t.id === themeId);
    if (!meta) return null;
    if (meta.source === 'builtin') {
      const t = BUILTIN_THEMES.BUILTIN_THEMES.find(b => b.id === themeId);
      return t || null;
    }
    const userDir = app.getPath('userData');
    const { themes } = themeStorage.loadUserThemes(userDir);
    return themes.find(t => t.id === themeId) || null;
  });

  ipcMain.handle('theme:current', async (event, options) => {
    const settings = loadSettings();
    const win = options && options.scope;
    if (win && win !== 'global' && settings.themePerWindow && settings.themePerWindow[win]) {
      return { themeId: settings.themePerWindow[win], scope: win, globalId: settings.theme };
    }
    return { themeId: settings.theme, scope: 'global', globalId: settings.theme };
  });

  ipcMain.handle('theme:apply', async (event, themeId, options) => {
    if (!themeId || typeof themeId !== 'string') {
      return { success: false, error: 'themeId 必须为字符串' };
    }
    if (!themeStorage.isValidId(themeId)) {
      return { success: false, error: '非法 id' };
    }
    const all = listAllThemes();
    if (!all.find(t => t.id === themeId)) {
      return { success: false, error: `主题 "${themeId}" 不存在` };
    }
    const settings = loadSettings();
    const scope = (options && options.scope) || 'global';
    if (scope === 'global') {
      settings.theme = themeId;
    } else {
      if (!settings.themePerWindow) settings.themePerWindow = {};
      settings.themePerWindow[scope] = themeId;
    }
    await saveSettingsFile(settings);
    broadcastThemeChanged(themeId, scope);
    return { success: true, themeId, scope };
  });

  ipcMain.handle('theme:save', async (event, themeObj) => {
    try {
      if (!themeObj || !themeStorage.isValidId(themeObj.id)) {
        return { success: false, error: '非法 id' };
      }
      const userDir = app.getPath('userData');
      const result = themeStorage.saveTheme(userDir, themeObj);
      broadcastThemeListChanged();
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('theme:delete', async (event, themeId) => {
    try {
      if (!themeId || !themeStorage.isValidId(themeId)) {
        return { success: false, error: '非法 id' };
      }
      if (themeStorage.BUILTIN_IDS.has(themeId)) {
        return { success: false, error: '不能删除内置主题' };
      }
      const userDir = app.getPath('userData');
      const result = themeStorage.deleteTheme(userDir, themeId);
      const settings = loadSettings();
      if (settings.theme === themeId) settings.theme = DEFAULT_THEME;
      if (settings.themePerWindow) {
        for (const k of Object.keys(settings.themePerWindow)) {
          if (settings.themePerWindow[k] === themeId) delete settings.themePerWindow[k];
        }
      }
      await saveSettingsFile(settings);
      broadcastThemeListChanged();
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('theme:import', async (event) => {
    try {
      const result = await dialog.showOpenDialog({
        title: '导入主题',
        filters: [
          { name: '主题文件', extensions: ['json'] },
          { name: '所有文件', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      const obj = themeStorage.importThemeFromFile(result.filePaths[0]);
      const userDir = app.getPath('userData');
      const saved = themeStorage.saveTheme(userDir, obj);
      broadcastThemeListChanged();
      return { success: true, themeId: obj.id, filePath: saved.filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('theme:export', async (event, themeId) => {
    try {
      if (!themeId || !themeStorage.isValidId(themeId)) {
        return { success: false, error: '非法 id' };
      }
      let themeObj = null;
      if (themeStorage.BUILTIN_IDS.has(themeId)) {
        themeObj = BUILTIN_THEMES.BUILTIN_THEMES.find(b => b.id === themeId);
      } else {
        const userDir = app.getPath('userData');
        const { themes } = themeStorage.loadUserThemes(userDir);
        themeObj = themes.find(t => t.id === themeId);
      }
      if (!themeObj) return { success: false, error: '主题不存在' };
      const defaultName = `${themeId}.theme.json`;
      const result = await dialog.showSaveDialog({
        title: '导出主题',
        defaultPath: defaultName,
        filters: [{ name: '主题文件', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }
      themeStorage.exportThemeToFile({ ...themeObj, source: undefined }, result.filePath);
      return { success: true, filePath: result.filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('theme:reset', async () => {
    const settings = loadSettings();
    settings.theme = DEFAULT_THEME;
    settings.themePerWindow = {};
    await saveSettingsFile(settings);
    broadcastThemeChanged(DEFAULT_THEME, 'global');
    return { success: true, themeId: DEFAULT_THEME };
  });

  ipcMain.handle('theme:bootstrap', async (event) => {
    const settings = loadSettings();
    return {
      themeId: settings.theme,
      globalId: settings.theme,
      themePerWindow: settings.themePerWindow,
      available: listAllThemes(),
    };
  });
}

module.exports = {
  registerThemeIpc,
  listAllThemes,
  broadcastThemeChanged,
  broadcastThemeListChanged,
};
