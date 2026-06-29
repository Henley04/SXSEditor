/**
 * themeManager (renderer process)
 *
 * - Register / unregister themes
 * - Activate a theme (resolve extends, inject tokens, fire event)
 * - Export / import (with validation)
 * - mergeOverrides for live editor preview
 * - computeIsDark: derive isDark from --bg-app
 * - 20-step undo stack for in-editor history
 *
 * Public API on `themeManager`:
 *   register(themeObj)
 *   registerBuiltins(builtinArray)
 *   unregister(id)
 *   get(id)
 *   list()                   -> [{id,name,isDark,author,version,source}]
 *   activate(id, { scope })
 *   current()                -> id | null
 *   currentTokens()          -> { id, scope, tokens } | null
 *   export(id)               -> JSON string
 *   import(jsonString)       -> theme object
 *   mergeOverrides(patch)    -> applies transient patch (not persisted)
 *   clearOverrides()
 *   pushHistory()
 *   undo()
 *   redo()
 *   on(eventName, handler)   -> unsubscribe fn
 *
 * Events: 'theme-changed', 'theme-list-changed', 'theme-overwritten', 'theme-imported'
 */

import { buildDefaultTokens, TOKEN_CATALOG } from './tokenCatalog.js';
import { validate, normalize, ThemeValidationError } from './themeValidator.js';
import { computeIsDark as computeIsDarkUtil } from './colorUtils.js';

const STORAGE_KEY_OVERRIDES = 'sxseditor-theme-overrides';

class ThemeNotFoundError extends Error {
    constructor(id) {
        super(`Theme "${id}" not registered`);
        this.name = 'ThemeNotFoundError';
        this.id = id;
    }
}

const registry = new Map(); // id -> { theme, source }
let currentId = null;
let currentScope = 'global';
let currentScopeId = null;
let overrides = {};
let lastBaseTokens = buildDefaultTokens();

const listeners = new Map();
function emit(name, detail) {
    const set = listeners.get(name);
    if (!set) return;
    for (const fn of set) {
        try { fn(detail); } catch (e) { console.error('[themeManager] listener error', e); }
    }
    if (typeof document !== 'undefined') {
        document.dispatchEvent(new CustomEvent(name, { detail }));
    }
}

function on(name, handler) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler);
    return () => listeners.get(name).delete(handler);
}

// ==================== Helpers ====================

function cloneTokens(tokens) {
    return { ...(tokens || {}) };
}

/**
 * Resolve extends chain into a flat token map.
 * Order: top-level parent first, then child overrides.
 */
function flattenTheme(theme) {
    const out = {};
    const chain = [];
    let cur = theme;
    while (cur) {
        chain.unshift(cur);
        if (!cur.extends) break;
        const parent = registry.get(cur.extends);
        if (!parent) {
            throw new Error(`Parent theme "${cur.extends}" of theme "${cur.id}" does not exist`);
        }
        cur = parent.theme;
    }
    for (const t of chain) {
        Object.assign(out, t.tokens || {});
    }
    return out;
}

function injectTokens(tokens) {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(tokens)) {
        try {
            root.style.setProperty(k, v);
        } catch (e) {
            // Skip invalid property names silently
        }
    }
}

function clearInjectedTokens(tokenNames) {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    for (const name of tokenNames) {
        root.style.removeProperty(name);
    }
}

// ==================== isDark computation ====================

/**
 * Compute perceived luminance of --bg-app. Returns 0..1 (higher = brighter).
 * Supports hex and rgb(...) values. Returns 0.5 (unknown) for unparseable
 * values.
 */
export function computeIsDark(tokens) {
    if (!tokens) return false;
    return computeIsDarkUtil(tokens);
}

// ==================== History (undo/redo) ====================

const HISTORY_LIMIT = 20;
const history = []; // [{tokens}]
let historyIndex = -1;
let historyActive = false;

function pushHistory() {
    if (!historyActive) return;
    // truncate redo branch
    if (historyIndex < history.length - 1) {
        history.splice(historyIndex + 1);
    }
    history.push({ tokens: cloneTokens(overrides) });
    if (history.length > HISTORY_LIMIT) history.shift();
    historyIndex = history.length - 1;
}

function activateHistory() {
    history.length = 0;
    historyIndex = -1;
    historyActive = true;
    pushHistory();
}
function deactivateHistory() {
    historyActive = false;
}

function snapshot() {
    return {
        overrides: cloneTokens(overrides),
        index: historyIndex,
        length: history.length,
    };
}
function restoreSnapshot(s) {
    overrides = s.overrides;
    historyIndex = s.index;
    history.length = s.length;
    applyCurrent();
}

// ==================== API ====================

function register(theme) {
    if (!theme || !theme.id) {
        throw new ThemeValidationError([{ field: 'id', message: 'Theme missing id' }]);
    }
    const result = validate(theme, { getThemeById: (id) => registry.get(id)?.theme });
    if (!result.ok) {
        throw new ThemeValidationError(result.errors);
    }
    const normalized = normalize(theme);
    const source = registry.has(theme.id) ? registry.get(theme.id).source : 'memory';
    const existed = registry.has(theme.id);
    registry.set(theme.id, { theme: normalized, source });
    if (existed) emit('theme-overwritten', { id: theme.id });
    emit('theme-list-changed', { id: theme.id, source });
    return normalized;
}

function registerBuiltins(builtinArray) {
    for (const t of builtinArray || []) {
        try {
            register({ ...t, source: 'builtin' });
        } catch (e) {
            console.error('[themeManager] registerBuiltins failed', t?.id, e);
        }
    }
}

function unregister(id) {
    if (!registry.has(id)) return false;
    const entry = registry.get(id);
    if (entry.source === 'builtin') {
        console.warn('[themeManager] refusing to unregister builtin theme', id);
        return false;
    }
    registry.delete(id);
    if (currentId === id) currentId = null;
    emit('theme-list-changed', { id, source: entry.source });
    return true;
}

function get(id) {
    const e = registry.get(id);
    return e ? e.theme : null;
}

function list() {
    const out = [];
    for (const [id, { theme, source }] of registry.entries()) {
        out.push({
            id: theme.id,
            name: theme.name || id,
            isDark: theme.isDark === true,
            author: theme.author || '',
            version: theme.version || '1.0.0',
            source,
            description: theme.description || '',
        });
    }
    return out;
}

function applyCurrent() {
    const base = currentId ? flattenTheme(get(currentId)) : buildDefaultTokens();
    lastBaseTokens = base;
    const merged = { ...base, ...overrides };
    injectTokens(merged);
    emit('theme-changed', {
        themeId: currentId,
        scope: currentScope,
        scopeId: currentScopeId,
        tokens: merged,
        overrides: cloneTokens(overrides),
    });
}

function activate(id, options = {}) {
    const scope = options.scope || 'global';
    const scopeId = options.scopeId || null;
    if (id && !registry.has(id)) {
        throw new ThemeNotFoundError(id);
    }
    currentId = id;
    currentScope = scope;
    currentScopeId = scopeId;
    overrides = {};
    applyCurrent();
    return currentId;
}

function current() {
    return { themeId: currentId, scope: currentScope, scopeId: currentScopeId };
}

function currentTokens() {
    if (!currentId) return null;
    const base = flattenTheme(get(currentId));
    return {
        id: currentId,
        scope: currentScope,
        scopeId: currentScopeId,
        tokens: { ...base, ...overrides },
        baseTokens: base,
        overrides: cloneTokens(overrides),
    };
}

function exportTheme(id) {
    const theme = get(id);
    if (!theme) throw new ThemeNotFoundError(id);
    const flat = cloneTokens(theme.tokens || {});
    return JSON.stringify({
        id: theme.id,
        name: theme.name,
        version: theme.version || '1.0.0',
        author: theme.author,
        isDark: theme.isDark,
        description: theme.description,
        tags: theme.tags,
        source: registry.get(id)?.source,
        tokens: flat,
    }, null, 2);
}

function importTheme(jsonString) {
    const parsed = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
    const result = validate(parsed, { getThemeById: (id) => registry.get(id)?.theme });
    if (!result.ok) {
        throw new ThemeValidationError(result.errors);
    }
    const normalized = normalize(parsed);
    registry.set(normalized.id, { theme: normalized, source: 'user' });
    emit('theme-imported', { id: normalized.id, source: 'user', warnings: result.warnings });
    emit('theme-list-changed', { id: normalized.id, source: 'user' });
    return normalized;
}

function mergeOverrides(patch) {
    if (!patch || typeof patch !== 'object') return;
    if (!historyActive) activateHistory();
    overrides = { ...overrides, ...patch };
    pushHistory();
    applyCurrent();
}

function clearOverrides() {
    overrides = {};
    if (historyActive) {
        history.length = 0;
        historyIndex = -1;
        pushHistory();
    }
    applyCurrent();
}

function setOverrideValue(name, value) {
    mergeOverrides({ [name]: value });
}

function undo() {
    if (!historyActive) return false;
    if (historyIndex <= 0) return false;
    historyIndex -= 1;
    overrides = cloneTokens(history[historyIndex].tokens);
    applyCurrent();
    return true;
}

function redo() {
    if (!historyActive) return false;
    if (historyIndex >= history.length - 1) return false;
    historyIndex += 1;
    overrides = cloneTokens(history[historyIndex].tokens);
    applyCurrent();
    return true;
}

const themeManager = {
    register,
    registerBuiltins,
    unregister,
    get,
    list,
    activate,
    current,
    currentTokens,
    export: exportTheme,
    import: importTheme,
    mergeOverrides,
    clearOverrides,
    setOverrideValue,
    pushHistory,
    undo,
    redo,
    snapshot,
    restoreSnapshot,
    on,
    computeIsDark,
    ThemeNotFoundError,
};

export default themeManager;
export { ThemeNotFoundError, flattenTheme, cloneTokens, computeIsDark as computeIsDarkFromTokens };
