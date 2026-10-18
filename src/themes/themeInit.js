/**
 * Shared theme initialization for all renderer windows.
 *
 * Usage:
 *   import { initWindowTheme } from '../themes/themeInit.js';
 *   initWindowTheme(ipcCleanupsArray);
 */

/**
 * 把主题 token 写进 :root 的 inline style。
 *
 * 审查项 2.2：这个函数此前在三个文件里各写了一份
 * （themes/themeInit.js、themes/themeManager.js、renderer/ipcHandlers.js）。
 * themeManager 那份**既不清理旧变量也不派发 theme:changed**，切主题时会残留
 * 上一个主题的脏 CSS 变量，且 canvas 渲染层缓存的颜色不会失效 —— 现在统一到
 * 这一份实现：先清空旧的 --* 变量，再写入新 token，最后广播 theme:changed。
 */
export function injectTokens(tokens) {
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
