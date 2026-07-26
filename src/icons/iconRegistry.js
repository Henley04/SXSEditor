/**
 * SVG icon registry for SXSEditor.
 *
 * Design language:
 *   - 24x24 viewBox, 1.75px stroke, round caps/joins (Lucide/Heroicons style)
 *   - Outline-first aesthetic for consistency, with solid fills reserved for
 *     media transport (play/pause/stop) where immediate shape recognition matters.
 *   - All icons use currentColor so they inherit the surrounding text color and
 *     automatically adapt to every theme (light + dark) without versioning.
 *   - Status-tinted icons (success/warning/danger) accept an extra `tint` class
 *     so CSS variables (--success, --warning, --danger) drive their color.
 *
 * Each entry is a function returning an SVG inner-markup string. The outer
 * <svg> wrapper is supplied by createIcon() in iconHelper.js.
 */

export const ICON_REGISTRY = {
    // ===== Transport: solid shapes for instant recognition =====
    play: () => '<path fill="currentColor" stroke="none" d="M7 4.5v15a1 1 0 0 0 1.52.86l11-7.5a1 1 0 0 0 0-1.72l-11-7.5A1 1 0 0 0 7 4.5z"/>',
    pause: () => '<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
    stop: () => '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',

    // ===== File operations =====
    save: () => '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 14h8v6H8z"/>',
    'folder-open': () => '<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v2"/><path d="M3 7v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V10a1 1 0 0 0-1-1H10l-2 2H4a1 1 0 0 0-1 1z"/>',
    upload: () => '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    download: () => '<path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 18v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/>',
    'download-tray': () => '<path d="M12 3v9"/><path d="M8 9l4 4 4-4"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/>',
    disc: () => '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none"/>',

    // ===== Audio / music =====
    microphone: () => '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M8 21h8"/>',
    music: () => '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    'music-note': () => '<path d="M10 18V5l9-2v13"/><circle cx="7" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
    'file-music': () => '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/><circle cx="11" cy="16" r="2"/><path d="M13 16V11l3-1v6"/><circle cx="14" cy="15" r="2"/>',
    sliders: () => '<path d="M4 6h10"/><path d="M18 6h2"/><path d="M4 12h4"/><path d="M12 12h8"/><path d="M4 18h12"/><path d="M20 18h0"/><circle cx="16" cy="6" r="2.2"/><circle cx="10" cy="12" r="2.2"/><circle cx="18" cy="18" r="2.2"/>',

    // ===== Actions =====
    check: () => '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    'check-circle': () => '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16 9.5"/>',
    close: () => '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    warning: () => '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.5" r="0.8" fill="currentColor" stroke="none"/>',
    refresh: () => '<path d="M4 12a8 8 0 0 1 13.66-5.66L20 8"/><path d="M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-13.66 5.66L4 16"/><path d="M4 20v-4h4"/>',
    undo: () => '<path d="M9 7L4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 5 5v1"/>',
    redo: () => '<path d="M15 7l5 5-5 5"/><path d="M20 12H9a5 5 0 0 0-5 5v1"/>',
    trash: () => '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    pencil: () => '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
    keyboard: () => '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h0"/><path d="M10 10h0"/><path d="M14 10h0"/><path d="M18 10h0"/><path d="M7 14h10"/>',

    // ===== Arrows =====
    'arrow-up': () => '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
    'arrow-down': () => '<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>',
    'arrow-left': () => '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
    'arrow-right': () => '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    'chevron-up': () => '<path d="M6 15l6-6 6 6"/>',
    'chevron-right': () => '<path d="M9 6l6 6-6 6"/>',

    // ===== Status / utility =====
    info: () => '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.5" r="0.8" fill="currentColor" stroke="none"/>',
};

/**
 * Get the inner SVG markup for an icon name.
 * @param {string} name
 * @returns {string|null}
 */
export function getIconMarkup(name) {
    const factory = ICON_REGISTRY[name];
    return factory ? factory() : null;
}

/**
 * All registered icon names. Useful for diagnostics / sprites.
 * @returns {string[]}
 */
export function getIconNames() {
    return Object.keys(ICON_REGISTRY);
}
