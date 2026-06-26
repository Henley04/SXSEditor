/**
 * Icon helper — build <svg class="icon"> elements from the registry.
 *
 * Usage:
 *   import { createIcon } from './icons/iconHelper.js';
 *   btn.replaceChildren(createIcon('play'), document.createTextNode('Play'));
 *
 * Or for static HTML, use the data-icon attribute and call hydrateIcons():
 *   <button data-icon="play">Play</button>
 *   hydrateIcons(document);   // prepends the SVG, keeps the text node
 */

import { getIconMarkup } from './iconRegistry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_SIZE = 16;

/**
 * Build an inline <svg> icon element.
 * @param {string} name  Icon key from ICON_REGISTRY.
 * @param {object} [opts]
 * @param {number} [opts.size=16]  Pixel size (square).
 * @param {string} [opts.className]  Extra class names appended after `icon`.
 * @param {string} [opts.label]  aria-label for icon-only buttons.
 * @returns {SVGSVGElement|null}  null if the icon name is unknown.
 */
export function createIcon(name, opts = {}) {
    const markup = getIconMarkup(name);
    if (markup == null) return null;

    const size = opts.size ?? DEFAULT_SIZE;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `icon icon-${name}${opts.className ? ' ' + opts.className : ''}`);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (opts.label) {
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', opts.label);
    }
    svg.innerHTML = markup;
    return svg;
}

/**
 * Replace any element's text-emoji prefix with an inline SVG.
 * Mutates the element: prepends the icon node, leaves the rest of the children
 * untouched. Intended for buttons whose innerText still starts with an emoji
 * glyph loaded from i18n strings.
 *
 * @param {HTMLElement} el
 * @param {string} iconName
 * @param {object} [opts]
 */
export function setIcon(el, iconName, opts = {}) {
    if (!el) return;
    const icon = createIcon(iconName, opts);
    if (!icon) return;
    // Remove any existing leading .icon node so this is idempotent.
    const existing = el.querySelector(':scope > svg.icon');
    if (existing) existing.remove();
    el.prepend(icon);
}

/**
 * Hydrate every `[data-icon]` element in a root subtree by prepending an SVG.
 * Use in static HTML to avoid hard-coding SVG strings inline:
 *   <button id="btn-play" data-icon="play">Play</button>
 *
 * @param {ParentNode} [root=document]
 */
export function hydrateIcons(root = document) {
    const nodes = root.querySelectorAll('[data-icon]');
    nodes.forEach((node) => {
        const name = node.getAttribute('data-icon');
        if (!name) return;
        const size = parseInt(node.getAttribute('data-icon-size') || '', 10);
        const cls = node.getAttribute('data-icon-class') || '';
        const opts = {};
        if (Number.isFinite(size)) opts.size = size;
        if (cls) opts.className = cls;
        setIcon(node, name, opts);
    });
}

/**
 * Strip a leading emoji glyph from a localized string and return the trimmed
 * remainder. Used to migrate old i18n values to icon-prefixed UI without
 * editing every translation key at once.
 *
 * NOTE: With the new i18n tables (emoji removed), this is a no-op safety net
 * kept for backward compatibility with any cached strings.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripLeadingEmoji(text) {
    if (typeof text !== 'string') return text;
    // Single emoji/symbol glyph + optional variation selector + trailing space.
    return text.replace(/^[\u2190-\u21FF\u2328\u23F8-\u23FA\u25A0-\u27BF\u2B00-\u2BFF\u{1F300}-\u{1FAFF}\uFE0F]+\s*/u, '').trim();
}
