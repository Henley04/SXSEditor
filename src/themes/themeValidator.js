/**
 * Theme pack validator.
 *
 * Validates theme JSON objects against:
 *   - id (kebab-case, no leading/trailing dash, non-empty)
 *   - tokens (object, all keys are valid --token names, values are valid colors/sizes)
 *   - extends (string id of parent theme; depth <= 3; no cycles)
 *
 * Returns { ok, errors, warnings }.
 * Does NOT throw — callers can decide.
 */

import { computeIsDark } from './colorUtils.js';

const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const TOKEN_NAME_RE = /^--[a-z0-9][a-z0-9-]*$/;
const COLOR_VALUE_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|transparent|currentColor|inherit)$/;
// CSS value used in size / motion: a number with unit or zero or 0
const SIZE_VALUE_RE = /^(0|[1-9][0-9]*(\.[0-9]+)?(px|rem|em|%|vh|vw|s|ms))$/;
// CSS shadow is a free-form CSS shadow value. We just check it's a string.
const SHADOW_VALUE_RE = /^.+$/;

const MAX_EXTENDS_DEPTH = 3;

export class ThemeValidationError extends Error {
    constructor(errors) {
        super(`Theme validation failed: ${errors.length} error(s)`);
        this.name = 'ThemeValidationError';
        this.errors = errors;
    }
}

function isValidColorValue(v) {
    if (typeof v !== 'string') return false;
    return COLOR_VALUE_RE.test(v.trim());
}

function isValidSizeValue(v) {
    if (typeof v !== 'string') return false;
    if (v === '0') return true;
    if (v === 'auto' || v === 'initial' || v === 'inherit' || v === 'unset') return true;
    return SIZE_VALUE_RE.test(v.trim());
}

function isValidTokenValue(meta, v) {
    if (typeof v !== 'string') return false;
    if (!meta) {
        // Unknown token — accept as free CSS value
        return v.length > 0;
    }
    switch (meta.type) {
        case 'color':   return isValidColorValue(v);
        case 'size':    return isValidSizeValue(v);
        case 'motion':  return isValidSizeValue(v);
        case 'shadow':  return SHADOW_VALUE_RE.test(v);
        case 'string':  return v.length > 0;
        default:        return v.length > 0;
    }
}

function looksLikeColor(v) {
    return typeof v === 'string' && (v.startsWith('#') || v.startsWith('rgb') || v.startsWith('hsl'));
}

function looksLikeSize(v) {
    return typeof v === 'string' && /^-?[0-9.]/.test(v);
}

/**
 * Validate a theme object. Pass `getThemeById` to enable extends validation
 * (parent existence + depth + cycle). If not provided, extends is only
 * shape-validated.
 */
export function validate(theme, opts = {}) {
    const errors = [];
    const warnings = [];
    const getThemeById = opts.getThemeById;

    if (!theme || typeof theme !== 'object') {
        return { ok: false, errors: [{ field: 'root', message: 'Theme must be an object' }], warnings };
    }

    // id
    if (typeof theme.id !== 'string' || !theme.id.length) {
        errors.push({ field: 'id', message: 'Missing id' });
    } else if (!ID_RE.test(theme.id)) {
        errors.push({ field: 'id', message: `id "${theme.id}" must be kebab-case (lowercase letters, digits, hyphens, cannot start or end with hyphen)` });
    }

    // name (optional but recommended)
    if (theme.name !== undefined && typeof theme.name !== 'string') {
        errors.push({ field: 'name', message: 'name must be a string' });
    }

    // version (optional, default 1.0.0)
    if (theme.version !== undefined && typeof theme.version !== 'string') {
        errors.push({ field: 'version', message: 'version must be a string' });
    }

    // isDark (optional, default false)
    if (theme.isDark !== undefined && typeof theme.isDark !== 'boolean') {
        errors.push({ field: 'isDark', message: 'isDark must be a boolean' });
    }

    // author / description
    if (theme.author !== undefined && typeof theme.author !== 'string') {
        errors.push({ field: 'author', message: 'author must be a string' });
    }
    if (theme.description !== undefined && typeof theme.description !== 'string') {
        errors.push({ field: 'description', message: 'description must be a string' });
    }

    // tokens
    if (!theme.tokens || typeof theme.tokens !== 'object' || Array.isArray(theme.tokens)) {
        errors.push({ field: 'tokens', message: 'Missing tokens or wrong type' });
    } else {
        for (const [name, value] of Object.entries(theme.tokens)) {
            if (!TOKEN_NAME_RE.test(name)) {
                errors.push({ token: name, message: `Token name "${name}" invalid (must start with --, only lowercase letters, digits, hyphens)` });
                continue;
            }
            // Try to detect type from value pattern when token is unknown
            let meta = null;
            try {
                // Lazy import to avoid circular dep
                // eslint-disable-next-line global-require
                const { TOKEN_CATALOG } = require('./tokenCatalog.js');
                meta = TOKEN_CATALOG[name];
            } catch (_) {
                // Ignore — TOKEN_CATALOG may not be available in pure node test env without bundler
            }
            if (!isValidTokenValue(meta, value)) {
                errors.push({ token: name, message: `Token "${name}" value "${value}" invalid` });
            }
        }
    }

    // extends
    if (theme.extends !== undefined) {
        if (typeof theme.extends !== 'string') {
            errors.push({ field: 'extends', message: 'extends must be a string' });
        } else if (getThemeById) {
            const chain = [];
            let current = theme;
            let depth = 0;
            let ok = true;
            while (current && current.extends) {
                if (chain.includes(current.id)) {
                    errors.push({ field: 'extends', message: `Circular inheritance detected: ${chain.join(' -> ')} -> ${current.id}` });
                    ok = false;
                    break;
                }
                chain.push(current.id);
                depth += 1;
                if (depth > MAX_EXTENDS_DEPTH) {
                    errors.push({ field: 'extends', message: `Inheritance depth ${depth} exceeds ${MAX_EXTENDS_DEPTH} levels` });
                    ok = false;
                    break;
                }
                const parent = getThemeById(current.extends);
                if (!parent) {
                    errors.push({ field: 'extends', message: `Parent theme "${current.extends}" does not exist` });
                    ok = false;
                    break;
                }
                current = parent;
            }
            if (ok && current && current.extends) {
                errors.push({ field: 'extends', message: `Parent theme "${current.extends}" does not exist` });
            }
        }
    }

    // Loose import compatibility
    if (theme.tokens && typeof theme.tokens === 'object') {
        for (const key of Object.keys(theme.tokens)) {
            if (!key.startsWith('--')) {
                warnings.push({ token: key, message: `Token key "${key}" missing -- prefix, auto-completed` });
            }
        }
    }

    return { ok: errors.length === 0, errors, warnings };
}

/**
 * Normalize a theme object: add -- prefix where missing, ensure version,
 * and compute isDark from --bg-app if not provided.
 */
export function normalize(theme, opts = {}) {
    const out = { ...theme };
    if (!out.version) out.version = '1.0.0';
    if (out.isDark === undefined) {
        out.isDark = computeIsDark(out.tokens || {});
    }
    if (out.tokens) {
        const fixed = {};
        for (const [k, v] of Object.entries(out.tokens)) {
            const key = k.startsWith('--') ? k : `--${k}`;
            fixed[key] = v;
        }
        out.tokens = fixed;
    }
    return out;
}

/**
 * Quick parse + validate from JSON string. Throws ThemeValidationError on
 * failure.
 */
export function parseThemeJson(jsonString) {
    let parsed;
    try {
        parsed = JSON.parse(jsonString);
    } catch (e) {
        throw new ThemeValidationError([{ field: 'root', message: `JSON parse failed: ${e.message}` }]);
    }
    const result = validate(parsed);
    if (!result.ok) {
        throw new ThemeValidationError(result.errors);
    }
    return normalize(parsed);
}
