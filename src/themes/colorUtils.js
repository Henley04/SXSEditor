/**
 * Color utility functions used by theme system.
 */

function parseHex(hex) {
    let h = hex.replace('#', '').trim();
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length === 4) h = h.split('').map(c => c + c).join('');
    if (h.length === 6) h += 'ff';
    if (h.length !== 8) return null;
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: parseInt(h.slice(6, 8), 16) / 255,
    };
}

function srgbToLinear(c) {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(r, g, b) {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/**
 * Compute perceived luminance of --bg-app. Returns 0..1 (higher = brighter).
 * Supports hex and rgb(...) values. Returns 0.5 (unknown) for unparseable
 * values.
 */
export function computeLuminance(colorValue) {
    if (!colorValue || typeof colorValue !== 'string') return 0.5;
    let rgb = null;
    if (colorValue.startsWith('#')) {
        const p = parseHex(colorValue);
        if (p) rgb = p;
    } else if (colorValue.startsWith('rgb')) {
        const m = colorValue.match(/rgba?\(([^)]+)\)/);
        if (m) {
            const parts = m[1].split(',').map(s => parseFloat(s.trim()));
            if (parts.length >= 3) rgb = { r: parts[0], g: parts[1], b: parts[2] };
        }
    }
    if (!rgb) return 0.5;
    return relativeLuminance(rgb.r, rgb.g, rgb.b);
}

export function computeIsDark(tokens) {
    if (!tokens) return false;
    const v = tokens['--bg-app'];
    if (!v) return false;
    return computeLuminance(v) < 0.5;
}
