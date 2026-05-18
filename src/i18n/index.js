import zhCN from './zh-CN.js';
import en from './en.js';

const STORAGE_KEY = 'sxseditor-locale';

const locales = {
    'zh-CN': zhCN,
    'en': en,
};

let currentLocale = 'zh-CN';

function getLocale() {
    return currentLocale;
}

function setLocale(locale) {
    if (locales[locale]) {
        currentLocale = locale;
        localStorage.setItem(STORAGE_KEY, locale);
        document.dispatchEvent(new CustomEvent('localeChanged', { detail: { locale } }));
    }
}

function resolve(obj, key) {
    return key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

function t(key, params) {
    let value = resolve(locales[currentLocale], key);
    if (value === undefined) {
        value = resolve(locales['zh-CN'], key);
    }
    if (value === undefined) {
        return key;
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
}

function initI18n() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && locales[saved]) {
        currentLocale = saved;
    }
}

export { t, setLocale, getLocale, applyLocale, initI18n };
