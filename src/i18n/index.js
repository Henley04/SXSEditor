import zhCN from './zh-CN.js';
import en from './en.js';

// B7: NOTE — there are two parallel i18n systems in this codebase:
//   1. This file (src/i18n/index.js + zh-CN.js + en.js) — ESM, used by the
//      renderer process.
//   2. src/main/locale.js — CJS, used by the main process.
// They are intentionally separate (renderer vs main) but must be kept in
// SYNC: any key used by both processes must exist in both dictionaries with
// matching semantics. When adding a key, check whether the other system
// needs it too.

const STORAGE_KEY = 'sxseditor-locale';

const locales = {
    'zh-CN': zhCN,
    'en': en,
};

let currentLocale = 'en';

// Translation cache: maps `${locale}:${key}` → resolved string (only for parameterless calls)
const _tCache = new Map();
const _tCacheMax = 2000;

function getLocale() {
    return currentLocale;
}

function setLocale(locale) {
    if (locales[locale]) {
        currentLocale = locale;
        _tCache.clear(); // Invalidate cache on locale change
        localStorage.setItem(STORAGE_KEY, locale);
        if (window.electronAPI?.saveLocale) {
            window.electronAPI.saveLocale(locale).catch(() => {});
        }
        document.dispatchEvent(new CustomEvent('localeChanged', { detail: { locale } }));
    }
}

function resolve(obj, key) {
    return key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

function t(key, params) {
    // Fast path: cache parameterless lookups
    if (!params) {
        const cacheKey = `${currentLocale}:${key}`;
        const cached = _tCache.get(cacheKey);
        if (cached !== undefined) return cached;

        let value = resolve(locales[currentLocale], key);
        if (value === undefined) {
            value = resolve(locales['en'], key);
        }
        if (value === undefined) {
            _tCache.set(cacheKey, key);
            return key;
        }
        _tCache.set(cacheKey, value);
        // Evict oldest entries if cache grows too large
        if (_tCache.size > _tCacheMax) {
            const firstKey = _tCache.keys().next().value;
            _tCache.delete(firstKey);
        }
        return value;
    }

    // Parameterized lookups are not cached (params vary)
    let value = resolve(locales[currentLocale], key);
    if (value === undefined) {
        value = resolve(locales['en'], key);
    }
    if (value === undefined) {
        return key;
    }
    return value.replace(/\{(\w+)\}/g, (_, name) => {
        return params[name] !== undefined ? params[name] : `{${name}}`;
    });
}

/**
 * W25: Translate with an explicit fallback. t() returns the raw key string
 * when a key is missing (never undefined), so `t(key) || 'fallback'` is dead
 * code that masks missing-key bugs and can leak raw key names (e.g.
 * 'common.confirm') to users. tOr() returns `fallback` ONLY when the key is
 * genuinely absent from both the current locale and the English dictionary.
 */
function tOr(key, fallback, params) {
    let value = resolve(locales[currentLocale], key);
    if (value === undefined) {
        value = resolve(locales['en'], key);
    }
    if (value === undefined) {
        return fallback;
    }
    if (params) {
        return value.replace(/\{(\w+)\}/g, (_, name) => {
            return params[name] !== undefined ? params[name] : `{${name}}`;
        });
    }
    return value;
}

function applyLocale() {
    const elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (key) {
            el.textContent = t(key);
        }
    });

    const placeholderElements = document.querySelectorAll('[data-i18n-placeholder]');
    placeholderElements.forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key) {
            el.placeholder = t(key);
        }
    });

    const titleElements = document.querySelectorAll('[data-i18n-title]');
    titleElements.forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (key) {
            el.title = t(key);
        }
    });

    // B9: support aria-label so accessibility labels can be localized too
    // (previously only data-i18n / -placeholder / -title were handled, which
    // left aria-labels like "波形预览" hardcoded in HTML).
    const ariaLabelElements = document.querySelectorAll('[data-i18n-aria-label]');
    ariaLabelElements.forEach(el => {
        const key = el.getAttribute('data-i18n-aria-label');
        if (key) {
            el.setAttribute('aria-label', t(key));
        }
    });
}

async function initI18n() {
    // 1. Check localStorage (fast, renderer-local)
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && locales[saved]) {
        currentLocale = saved;
        return;
    }
    // 2. Read from main process config file (authoritative source)
    try {
        if (window.electronAPI?.getLocale) {
            const mainLocale = await window.electronAPI.getLocale();
            if (mainLocale && locales[mainLocale]) {
                currentLocale = mainLocale;
                localStorage.setItem(STORAGE_KEY, mainLocale);
                return;
            }
        }
    } catch (_) {}
    // 3. Detect system language, default to English
    const lang = navigator.language || '';
    if (lang.startsWith('zh')) {
        currentLocale = 'zh-CN';
    } else {
        currentLocale = 'en';
    }
}

export { t, tOr, setLocale, getLocale, applyLocale, initI18n };
