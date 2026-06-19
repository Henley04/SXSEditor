/**
 * Built-in theme aggregator.
 *
 * Each entry is the parsed JSON of <id>.theme.json from this folder.
 * Themes are imported as ES module exports so webpack bundles them.
 */

import darkAurora from './dark-aurora.theme.json';
import lightPaper from './light-paper.theme.json';
import midnightAmber from './midnight-amber.theme.json';

export const BUILTIN_THEMES = [
    darkAurora,
    lightPaper,
    midnightAmber,
];

export const BUILTIN_THEME_IDS = BUILTIN_THEMES.map(t => t.id);

// CommonJS interop for main process (require)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { BUILTIN_THEMES, BUILTIN_THEME_IDS };
    module.exports.BUILTIN_THEMES = BUILTIN_THEMES;
    module.exports.BUILTIN_THEME_IDS = BUILTIN_THEME_IDS;
}
