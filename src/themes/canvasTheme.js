/**
 * canvasTheme — reads CSS custom properties from :root and returns
 * a plain color map for use in Canvas 2D rendering.
 *
 * Usage:
 *   import { getCanvasColors } from '../themes/canvasTheme.js';
 *   const c = getCanvasColors();
 *   ctx.fillStyle = c.bgApp;
 */

let _cached = null;
let _cachedVersion = 0;
let _version = 0;

/**
 * Invalidate the cached color map. Call this when the theme changes
 * (e.g. on the 'theme:changed' event) so the next getCanvasColors()
 * call re-reads from the DOM.
 */
export function invalidateCanvasThemeCache() {
    _cached = null;
    _version++;
}

/**
 * Read all canvas-relevant colors from the current theme.
 * Results are cached until invalidateCanvasThemeCache() is called.
 */
export function getCanvasColors() {
    if (_cached && _cachedVersion === _version) return _cached;

    const s = document.documentElement.style;
    const cs = typeof getComputedStyle !== 'undefined'
        ? getComputedStyle(document.documentElement)
        : null;

    function v(name) {
        // Prefer inline style (set by themeManager), fall back to computed
        const inline = s.getPropertyValue(name).trim();
        if (inline) return inline;
        if (cs) {
            const computed = cs.getPropertyValue(name).trim();
            if (computed) return computed;
        }
        return '';
    }

    _cached = {
        // ---- Backgrounds ----
        bgApp:          v('--bg-app')          || '#14141f',
        bgPanel:        v('--bg-panel')        || '#1a1a2a',
        bgElevated:     v('--bg-elevated')     || '#1e1e2e',
        bgInput:        v('--bg-input')        || '#1a1a28',
        bgOverlay:      v('--bg-overlay')      || 'rgba(10, 10, 20, 0.7)',

        // ---- Foregrounds ----
        fgPrimary:      v('--fg-primary')      || '#e0e0f0',
        fgSecondary:    v('--fg-secondary')    || '#d8d8ec',
        fgMuted:        v('--fg-muted')        || '#c8c8dc',
        fgDisabled:     v('--fg-disabled')     || '#5a5a72',

        // ---- Accent ----
        accent:         v('--accent')          || '#5b8def',
        accentHover:    v('--accent-hover')    || '#6b9df5',
        accentSoft:     v('--accent-soft')     || 'rgba(91, 141, 239, 0.15)',
        accentLine:     v('--accent-line')     || 'rgba(91, 141, 239, 0.2)',
        accentFg:       v('--accent-fg')       || '#6b9df5',

        // ---- Status ----
        success:        v('--success')         || '#4ade80',
        successSoft:    v('--success-soft')    || 'rgba(74, 222, 128, 0.12)',
        warning:        v('--warning')         || '#fbbf24',
        danger:         v('--danger')          || '#f87171',
        dangerGlow:     v('--danger-glow')     || 'rgba(248, 113, 113, 0.3)',

        // ---- Borders ----
        borderSubtle:   v('--border-subtle')   || '#1a1a28',
        borderDefault:  v('--border-default')  || '#2a2a3d',
        borderStrong:   v('--border-strong')   || '#3a3a52',
        borderAccent:   v('--border-accent')   || '#5b8def',

        // ---- Shadows ----
        shadowColor:    v('--shadow-color')    || 'rgba(0, 0, 0, 0.2)',
        shadowColorMid: v('--shadow-color-mid') || 'rgba(0, 0, 0, 0.3)',

        // ---- Scrollbar ----
        scrollbarThumb: v('--scrollbar-thumb') || 'rgba(58, 58, 82, 0.6)',

        // ---- Selection ----
        selectionBg:    v('--selection-bg')    || 'rgba(91, 141, 239, 0.4)',

        // ---- Specific canvas colors ----
        // Piano keys — always real piano colors, independent of theme
        pianoWhiteKey:  '#f0f0f0',
        pianoBlackKey:  '#1a1a1a',
        pianoKeyBorder: v('--border-strong')   || '#3a3a52',

        // Grid lines — brighter than UI borders for canvas visibility
        gridLineMajor:  v('--color-ink-50')    || '#3a3a4e',
        gridLineMinor:  v('--color-ink-100')   || '#323246',
        gridLineMeasure:v('--color-gray-800')  || '#4a4a66',

        // Note rendering
        noteBg:         v('--accent')          || '#5b8def',
        noteSelectedBg: v('--fg-primary')      || '#ffffff',
        noteBorder:     v('--color-black')     || '#000000',
        noteText:       v('--fg-on-accent')    || '#ffffff',

        // Pitch curve
        pitchLine:      v('--success')         || '#4ade80',
        pitchPoint:     v('--success')         || '#4ade80',
        pitchAutoLine:  v('--success-glow')    || 'rgba(74, 222, 128, 0.25)',
        pitchAutoPoint: v('--success-soft')    || 'rgba(74, 222, 128, 0.6)',

        // Envelope / parameter lines
        paramVol:       v('--accent')          || '#5b8def',
        paramPan:       v('--danger')          || '#f87171',
        paramF0:        v('--success')         || '#4ade80',

        // Playhead
        playhead:       v('--danger')          || '#ff4444',

        // Timeline fragments
        fragmentText:   v('--fg-on-accent')    || '#ffffff',

        // Beat/time text
        timeText:       v('--fg-muted')        || '#8888a8',

        // Loading overlay
        loadingBg:      v('--bg-overlay')      || 'rgba(10, 10, 20, 0.7)',
    };
    _cachedVersion = _version;
    return _cached;
}
