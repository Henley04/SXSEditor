const { ipcMain, dialog, app } = require('electron');
const themeStorage = require('../themes/themeStorage');
const BUILTIN_THEMES = require('../themes/builtins/index.js');
const { loadSettings, saveSettingsFile, DEFAULT_THEME } = require('./settings');
const { getAllWebContents } = require('./windowManager');

/**
 * Resolve extends chain into a flat token map (same logic as renderer flattenTheme).
 */
function flattenTheme(themeObj) {
  const out = {};
  const chain = [];
  let cur = themeObj;
  while (cur) {
    chain.unshift(cur);
    if (!cur.extends) break;
    const parent = BUILTIN_THEMES.BUILTIN_THEMES.find(t => t.id === cur.extends);
    if (!parent) break;
    cur = parent;
  }
  for (const t of chain) {
    Object.assign(out, t.tokens || {});
  }
  return out;
}

function listAllThemes() {
  const _settings = loadSettings();
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

/**
 * Resolve a theme ID to its full object with flattened tokens.
 * Returns null if the theme is not found.
 */
function resolveTheme(themeId) {
  if (!themeId) return null;
  const all = listAllThemes();
  const meta = all.find(t => t.id === themeId);
  if (!meta) return null;
  let themeObj = null;
  if (meta.source === 'builtin') {
    themeObj = BUILTIN_THEMES.BUILTIN_THEMES.find(b => b.id === themeId) || null;
  } else {
    const userDir = app.getPath('userData');
    const { themes } = themeStorage.loadUserThemes(userDir);
    themeObj = themes.find(t => t.id === themeId) || null;
  }
  if (!themeObj) return null;
  return { ...themeObj, tokens: flattenTheme(themeObj) };
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
    return resolveTheme(themeId);
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
      return { success: false, error: 'themeId must be a string' };
    }
    if (!themeStorage.isValidId(themeId)) {
      return { success: false, error: 'invalid id' };
    }
    const all = listAllThemes();
    if (!all.find(t => t.id === themeId)) {
      return { success: false, error: `Theme "${themeId}" does not exist` };
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
        return { success: false, error: 'invalid id' };
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
        return { success: false, error: 'invalid id' };
      }
      if (themeStorage.BUILTIN_IDS.has(themeId)) {
        return { success: false, error: 'Cannot delete built-in theme' };
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

  ipcMain.handle('theme:import', async (_event) => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Import Theme',
        filters: [
          { name: 'Theme Files', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
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
        return { success: false, error: 'invalid id' };
      }
      let themeObj = null;
      if (themeStorage.BUILTIN_IDS.has(themeId)) {
        themeObj = BUILTIN_THEMES.BUILTIN_THEMES.find(b => b.id === themeId);
      } else {
        const userDir = app.getPath('userData');
        const { themes } = themeStorage.loadUserThemes(userDir);
        themeObj = themes.find(t => t.id === themeId);
      }
      if (!themeObj) return { success: false, error: 'Theme does not exist' };
      const defaultName = `${themeId}.theme.json`;
      const result = await dialog.showSaveDialog({
        title: 'Export Theme',
        defaultPath: defaultName,
        filters: [{ name: 'Theme Files', extensions: ['json'] }],
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

  ipcMain.handle('theme:bootstrap', async (_event) => {
    const settings = loadSettings();
    const all = listAllThemes();
    return {
      themeId: settings.theme,
      globalId: settings.theme,
      themePerWindow: settings.themePerWindow,
      available: all,
      currentTheme: resolveTheme(settings.theme),
    };
  });
}

module.exports = {
  registerThemeIpc,
  listAllThemes,
  broadcastThemeChanged,
  broadcastThemeListChanged,
};
