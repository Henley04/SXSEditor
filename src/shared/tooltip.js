/**
 * Lightweight custom tooltip for elements with `data-tooltip`.
 * Replaces native `title` to allow wrapping, i18n, and avoidance of
 * clipping inside toolbars with overflow.
 * No deps; appends a single div to body and repositions on hover.
 */

let tooltipEl = null;
let hideTimer = null;
let currentTarget = null;

function ensureEl() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement('div');
  tooltipEl.id = 'sxs-tooltip';
  tooltipEl.setAttribute('role', 'tooltip');
  tooltipEl.style.cssText = `
    position: fixed;
    z-index: 10001;
    max-width: 320px;
    padding: 6px 10px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--fg-primary, #e0e0f0);
    background: var(--bg-elevated, #1e1e2e);
    border: 1px solid var(--border-strong, #3a3a4a);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    pointer-events: none;
    opacity: 0;
    transform: translateY(2px);
    transition: opacity 120ms ease, transform 120ms ease;
    white-space: normal;
    word-break: break-word;
    display: none;
  `;
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

function showTooltip(target) {
  const text = target.getAttribute('data-tooltip');
  if (!text) return;
  const el = ensureEl();
  el.textContent = text;
  el.style.display = 'block';
  // force reflow then animate in
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });
  positionTooltip(target, el);
  currentTarget = target;
}

function hideTooltip() {
  if (!tooltipEl || tooltipEl.style.display === 'none') return;
  tooltipEl.style.opacity = '0';
  tooltipEl.style.transform = 'translateY(2px)';
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }, 120);
  currentTarget = null;
}

function positionTooltip(target, el) {
  const rect = target.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // measure
  el.style.left = '0px';
  el.style.top = '0px';
  const tRect = el.getBoundingClientRect();
  const gap = 8;
  let left = rect.left + rect.width / 2 - tRect.width / 2;
  let top = rect.bottom + gap;
  // prefer below; if not enough space, show above
  if (top + tRect.height > vh - 8) {
    top = rect.top - tRect.height - gap;
  }
  if (left < 8) left = 8;
  if (left + tRect.width > vw - 8) left = vw - tRect.width - 8;
  // clamp top
  if (top < 8) top = 8;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function onMouseEnter(e) {
  const target = e.currentTarget;
  if (target.disabled) return;
  clearTimeout(hideTimer);
  showTooltip(target);
}

function onMouseLeave() {
  hideTooltip();
}

function onFocus(e) {
  showTooltip(e.currentTarget);
}

function onBlur() {
  hideTooltip();
}

export function initTooltips(root = document) {
  const els = root.querySelectorAll('[data-tooltip]');
  els.forEach(el => {
    // Remove native title if both exist to avoid double tooltip
    if (el.hasAttribute('title') && el.getAttribute('data-tooltip')) {
      el.removeAttribute('title');
    }
    if (el._tooltipBound) return;
    el._tooltipBound = true;
    el.addEventListener('mouseenter', onMouseEnter);
    el.addEventListener('mouseleave', onMouseLeave);
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    el.addEventListener('click', hideTooltip);
  });
}

// Auto-init for dynamically added elements via MutationObserver
let observer = null;
export function autoInitTooltips() {
  initTooltips();
  if (observer) return;
  observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.hasAttribute && node.hasAttribute('data-tooltip')) {
          initTooltips(node.parentElement || document);
        }
        if (node.querySelectorAll) {
          const nested = node.querySelectorAll('[data-tooltip]');
          if (nested.length) initTooltips(node);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('scroll', () => { if (currentTarget) positionTooltip(currentTarget, ensureEl()); }, true);
  window.addEventListener('resize', () => { if (currentTarget) positionTooltip(currentTarget, ensureEl()); });
}
