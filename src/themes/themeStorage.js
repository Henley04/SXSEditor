/**
 * themeStorage — main-process theme file IO.
 *
 * - loadUserThemes: read all *.theme.json under userData/themes/
 * - saveTheme: atomic write (tmp + rename), validate id
 * - deleteTheme: refuse builtin, only delete user
 * - importFromPath / exportToPath: file-based helpers
 *
 * Path security: theme id must be kebab-case without slashes / control chars.
 */

const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const BUILTIN_IDS = new Set(['dark-aurora', 'light-paper', 'midnight-amber', 'acg']);

class ThemeStorageError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'ThemeStorageError';
        this.code = code || 'THEME_STORAGE';
    }
}

function getUserThemesDir(userDataDir) {
    return path.join(userDataDir, 'themes');
}

function ensureDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
}

function isValidId(id) {
    return typeof id === 'string' && ID_RE.test(id) && !/[\\/:*?"<>|\x00-\x1f]/.test(id);
}

function listUserThemeFiles(userDataDir) {
    const dir = getUserThemesDir(userDataDir);
    ensureDir(dir);
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
        return [];
    }
    return entries
        .filter(e => e.isFile() && e.name.endsWith('.theme.json'))
        .map(e => path.join(dir, e.name));
}

function loadUserThemes(userDataDir) {
    const files = listUserThemeFiles(userDataDir);
    const themes = [];
    const errors = [];
    for (const fp of files) {
        try {
            const raw = fs.readFileSync(fp, 'utf8');
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object') throw new Error('not an object');
            if (!isValidId(obj.id)) throw new Error(`invalid id "${obj.id}"`);
            themes.push({ ...obj, source: 'user', filePath: fp });
        } catch (e) {
            console.warn(`[themeStorage] skipped corrupted theme file ${fp}: ${e.message}`);
            errors.push({ filePath: fp, message: e.message });
        }
    }
    return { themes, errors };
}

function saveTheme(userDataDir, themeObj) {
    if (!themeObj || typeof themeObj !== 'object') {
        throw new ThemeStorageError('Theme must be an object', 'THEME_INVALID');
    }
    if (!isValidId(themeObj.id)) {
        throw new ThemeStorageError(`invalid id "${themeObj.id}"`, 'THEME_INVALID_ID');
    }
    const dir = getUserThemesDir(userDataDir);
    ensureDir(dir);
    const target = path.join(dir, `${themeObj.id}.theme.json`);
    const tmp = target + '.tmp';
    const payload = JSON.stringify({ ...themeObj, source: 'user' }, null, 2);
    let backup = null;
    let hadExisting = false;
    try {
        if (fs.existsSync(target)) {
            hadExisting = true;
            backup = fs.readFileSync(target);
        }
    } catch (_) {}
    try {
        fs.writeFileSync(tmp, payload, 'utf8');
        fs.renameSync(tmp, target);
    } catch (e) {
        // rollback backup if rename failed and we had one
        if (hadExisting && backup) {
            try { fs.writeFileSync(target, backup); } catch (_) {}
        }
        throw new ThemeStorageError(`write failed: ${e.message}`, 'THEME_WRITE_FAIL');
    }
    return { filePath: target, id: themeObj.id };
}

function deleteTheme(userDataDir, themeId) {
    if (!isValidId(themeId)) {
        throw new ThemeStorageError(`invalid id "${themeId}"`, 'THEME_INVALID_ID');
    }
    if (BUILTIN_IDS.has(themeId)) {
        throw new ThemeStorageError('Cannot delete built-in theme', 'THEME_BUILTIN_PROTECTED');
    }
    const target = path.join(getUserThemesDir(userDataDir), `${themeId}.theme.json`);
    if (!fs.existsSync(target)) {
        return { deleted: false, filePath: target };
    }
    fs.unlinkSync(target);
    return { deleted: true, filePath: target };
}

function exportThemeToFile(themeObj, filePath) {
    const payload = JSON.stringify(themeObj, null, 2);
    fs.writeFileSync(filePath, payload, 'utf8');
    return { filePath };
}

function importThemeFromFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(raw);
    if (!isValidId(obj.id)) {
        throw new ThemeStorageError(`invalid id "${obj.id}"`, 'THEME_INVALID_ID');
    }
    return obj;
}

module.exports = {
    loadUserThemes,
    saveTheme,
    deleteTheme,
    exportThemeToFile,
    importThemeFromFile,
    isValidId,
    BUILTIN_IDS,
    getUserThemesDir,
    ThemeStorageError,
};
