/**
 * 设置页的通用 UI 增强：滑杆可输入、长说明折叠。
 *
 * 这两件事都**不能**靠逐条改 HTML 完成：设置页有 15 个滑杆、40 多条 hint，
 * 一条条加按钮既容易漏，也会随文案改动失效。所以统一在 DOM 上做一次后处理，
 * 并且用 dataset 标记幂等。
 *
 * 不引入任何"泛光"视觉：折叠只用原生 <details> 的三角，可编辑数值就是一个
 * 普通 number input。
 */

import { t } from './i18n/index.js';

/** 超过这个长度的 hint 默认折起来，只留前两行。 */
const FOLD_THRESHOLD = 96;

/** 把 0.900 这种写成 0.9，别把滑杆端点显示成三位小数。 */
function formatBound(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw);
  return String(parseFloat(n.toFixed(6)));
}

function beginBadgeEdit(badge, range) {
  if (badge.querySelector('input')) return;
  const restore = badge.textContent;
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'volume-display-input';
  if (range.min !== '') input.min = range.min;
  if (range.max !== '') input.max = range.max;
  input.step = range.step || 'any';
  input.value = formatBound(range.value);
  badge.textContent = '';
  badge.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      let value = Number(input.value);
      if (!Number.isFinite(value)) {
        badge.textContent = restore;
        return;
      }
      const min = Number(range.min);
      const max = Number(range.max);
      if (Number.isFinite(min)) value = Math.max(min, value);
      if (Number.isFinite(max)) value = Math.min(max, value);
      // 走原生 value + input/change：settings.js 里每条滑杆的监听器都在这条路径上，
      // 不需要知道"值是被拖出来的还是敲进来的"。
      range.value = String(value);
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
      // 监听器会把 badge 的 textContent 写回数值；但若该滑杆没有监听器，
      // 这里兜底显示，避免徽章一直停在输入框状态。
      if (badge.contains(input)) badge.textContent = formatBound(range.value);
    } else {
      badge.textContent = restore;
    }
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

/**
 * 给每个 range 补三件事：端点刻度、数值可点改、双击 label 复位默认值。
 * @param {ParentNode} [root]
 */
export function enhanceSliders(root = document) {
  root.querySelectorAll('input[type="range"]').forEach((range) => {
    if (range.dataset.uiEnhanced === '1') return;
    range.dataset.uiEnhanced = '1';

    const label = range.id
      ? document.querySelector(`label[for="${range.id}"]`)
      : null;
    const badge = label ? label.querySelector('.volume-display') : null;

    // 端点刻度：让"我现在在最左还是最右"可判断，而不是纯靠手感。
    const scale = document.createElement('div');
    scale.className = 'range-scale';
    scale.setAttribute('aria-hidden', 'true');
    const lo = document.createElement('span');
    lo.textContent = formatBound(range.min);
    const hi = document.createElement('span');
    hi.textContent = formatBound(range.max);
    scale.appendChild(lo);
    scale.appendChild(hi);
    range.insertAdjacentElement('afterend', scale);

    if (badge) {
      badge.classList.add('volume-display--editable');
      badge.title = t('settings.sliderValueHint');
      badge.addEventListener('click', () => beginBadgeEdit(badge, range));
    }

    if (label) {
      label.title = t('settings.sliderResetHint');
      label.addEventListener('dblclick', (event) => {
        // 双击落在数值徽章上时是"再编辑一次"，不是复位
        if (badge && event.target.closest('.volume-display')) return;
        const fallback = range.getAttribute('value');
        if (fallback === null) return;
        event.preventDefault();
        range.value = fallback;
        range.dispatchEvent(new Event('input', { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
  });
}

/**
 * 长 hint 默认折叠：保留前两行，右侧（下方）一个"详情"。
 * 用原生 <details>：键盘、读屏、Ctrl+F 都还能命中正文（display:none 才会失效，
 * 这里用 line-clamp，文本仍在文档里）。
 * @param {ParentNode} [root]
 */
export function foldLongHints(root = document) {
  root.querySelectorAll('.hint').forEach((p) => {
    if (p.closest('details.hint-fold')) return;
    if (p.dataset.noFold === '1') return;
    if (p.textContent.trim().length < FOLD_THRESHOLD) return;

    const details = document.createElement('details');
    details.className = 'hint-fold';

    const summary = document.createElement('summary');
    summary.setAttribute('data-i18n', 'settings.detailsLabel');
    summary.textContent = t('settings.detailsLabel');

    p.parentNode.insertBefore(details, p);
    details.appendChild(summary);
    details.appendChild(p);
  });
}

/** 语言切换后文案长度变了，重新判定哪些还要折叠。 */
export function refreshHintFolding(root = document) {
  root.querySelectorAll('details.hint-fold').forEach((details) => {
    const p = details.querySelector('.hint');
    if (p) details.parentNode.insertBefore(p, details);
    details.remove();
  });
  foldLongHints(root);
}

/**
 * 安装全部增强。返回清理函数，便于窗口卸载时摘监听。
 * @returns {() => void}
 */
export function installSettingsUiPolish() {
  enhanceSliders();
  foldLongHints();

  const onLocale = () => {
    refreshHintFolding();
    // 只刷新 t() 生成的 title，不重复 enhance —— 重复调用会叠加监听器
    // （同一个徽章点一次触发两次 beginBadgeEdit）。
    document.querySelectorAll('input[type="range"]').forEach((range) => {
      const label = range.id ? document.querySelector(`label[for="${range.id}"]`) : null;
      const badge = label ? label.querySelector('.volume-display') : null;
      if (badge) badge.title = t('settings.sliderValueHint');
      if (label) label.title = t('settings.sliderResetHint');
    });
  };
  document.addEventListener('localeChanged', onLocale);
  return () => document.removeEventListener('localeChanged', onLocale);
}
