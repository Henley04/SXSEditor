/**
 * Shared theme initialization for all renderer windows.
 *
 * Usage:
 *   import { initWindowTheme } from '../themes/themeInit.js';
 *   initWindowTheme(ipcCleanupsArray);
 */

function injectTokens(tokens) {
    if (!tokens || typeof document === 'undefined') return;
    const root = document.documentElement;
    // Clear previous inline CSS variables to avoid stale tokens
    const toRemove = [];
    for (let i = 0; i < root.style.length; i++) {
        if (root.style[i].startsWith('--')) toRemove.push(root.style[i]);
    }
    for (const prop of toRemove) root.style.removeProperty(prop);
    // Apply new theme tokens
    for (const [k, v] of Object.entries(tokens)) {
        try { root.style.setProperty(k, v); } catch (_) {}
    }
    // Notify canvas renderers to invalidate cached colors and re-render
    try { window.dispatchEvent(new CustomEvent('theme:changed')); } catch (_) {}
}

/**
 * Initialize theme for the current renderer window.
 *
 * 1. Fetches the current theme via themeAPI.bootstrap() (includes tokens)
 * 2. Applies its tokens to :root
 * 3. Listens for theme:changed IPC and re-applies
 *
 * @param {Array} [ipcCleanups] - Optional array to push cleanup fns into
 */
export async function initWindowTheme(ipcCleanups) {
    const api = window.electronAPI;
    if (!api?.themeAPI) return;

    async function applyTheme(themeId) {
        if (!themeId) return;
        try {
            const themeObj = await api.themeAPI.get(themeId);
            if (themeObj && themeObj.tokens) {
                injectTokens(themeObj.tokens);
            }
        } catch (_) {}
    }

    try {
        const bootstrap = await api.themeAPI.bootstrap();
        if (bootstrap) {
            // Use theme from bootstrap response (avoids second IPC call)
            if (bootstrap.currentTheme && bootstrap.currentTheme.tokens) {
                injectTokens(bootstrap.currentTheme.tokens);
            } else if (bootstrap.themeId) {
                await applyTheme(bootstrap.themeId);
            }
        }
    } catch (_) {}

    if (api.themeAPI.onChanged) {
        const cleanup = api.themeAPI.onChanged(async (data) => {
            if (data && data.themeId) {
                await applyTheme(data.themeId);
            }
        });
        if (cleanup && ipcCleanups) ipcCleanups.push(cleanup);
    }
}
