/**
 * themes module aggregator.
 *
 * Renderer-side entry point: import themeManager + builtins here.
 */
export { default as themeManager, ThemeNotFoundError, computeIsDarkFromTokens } from './themeManager.js';
export { validate, normalize, parseThemeJson, ThemeValidationError } from './themeValidator.js';
export { TOKEN_CATALOG, TOKEN_NAMES, REQUIRED_TOKENS_FOR_BUILTIN, buildDefaultTokens, getGroupedTokens } from './tokenCatalog.js';
export { BUILTIN_THEMES, BUILTIN_THEME_IDS } from './builtins/index.js';
