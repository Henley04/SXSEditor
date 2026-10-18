/**
 * 音色 / 后处理参数的悬浮提示卡。
 *
 * 原生 title 有三个毛病：约 1 秒延迟、样式由系统决定（浅色/深色主题下不跟随）、
 * 不能排版。这里换成一张跟随主题的轻卡片：参数名 + 分组/范围/默认值 + 作用说明，
 * 鼠标悬浮 120ms 后出现，移开、按下、滚动或按 Esc 立即隐藏。
 *
 * 刻意不做"光晕"：不使用 --accent-glow / shadowBlur 一类发光效果，
 * 只保留 1px 描边 + 一层很浅的投影。
 */

const SHOW_DELAY_MS = 120;
const EDGE_PAD = 8;
const TIP_ID = 'pp-hover-tip';

const builders = new WeakMap();

let tipEl = null;
let showTimer = 0;
let activeEl = null;

function _ensureEl() {
  if (tipEl && tipEl.isConnected) return tipEl;
  tipEl = document.createElement('div');
  tipEl.id = TIP_ID;
  tipEl.className = 'pp-tip';
  tipEl.setAttribute('role', 'tooltip');
  // 提示卡是纯视觉辅助：内容通过 aria-describedby 暴露给读屏，本身不参与焦点树。
  tipEl.setAttribute('aria-hidden', 'true');

  const title = document.createElement('div');
  title.className = 'pp-tip-title';
  const meta = document.createElement('div');
  meta.className = 'pp-tip-meta';
  const desc = document.createElement('div');
  desc.className = 'pp-tip-desc';

  tipEl.append(title, meta, desc);
  (document.body || document.documentElement).appendChild(tipEl);
  return tipEl;
}

function _render(content) {
  const el = _ensureEl();
  const [title, meta, desc] = el.children;
  title.textContent = content.title || '';
  title.style.display = content.title ? '' : 'none';
  meta.textContent = content.meta || '';
  meta.style.display = content.meta ? '' : 'none';
  desc.textContent = content.desc || '';
  desc.style.display = content.desc ? '' : 'none';
}

/** 定位：优先放在元素下方，空间不够翻到上方；左右都夹在窗口内。 */
function _position(rect) {
  const el = _ensureEl();
  const box = el.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;

  let top = rect.bottom + 6;
  if (top + box.height > vh - EDGE_PAD) {
    const above = rect.top - box.height - 6;
    top = above >= EDGE_PAD ? above : Math.max(EDGE_PAD, vh - box.height - EDGE_PAD);
  }
  let left = rect.left;
  left = Math.max(EDGE_PAD, Math.min(left, Math.max(EDGE_PAD, vw - box.width - EDGE_PAD)));

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.classList.add('visible');
}

function _show(el) {
  const build = builders.get(el);
  if (!build) return;
  const content = build();
  if (!content) return;
  _render(content);
  activeEl = el;
  _position(el.getBoundingClientRect());
}

function _scheduleShow(el) {
  hideHoverTip();
  if (showTimer) clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    showTimer = 0;
    _show(el);
  }, SHOW_DELAY_MS);
}

export function hideHoverTip() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = 0;
  }
  activeEl = null;
  if (!tipEl) return;
  tipEl.classList.remove('visible');
}

/** 悬浮提示卡当前挂在哪个元素上（无则返回 null）。 */
export function getHoverTipTarget() {
  return activeEl;
}

/**
 * 给元素挂上悬浮提示。
 * @param {HTMLElement} el 目标元素
 * @param {() => ({title?: string, meta?: string, desc?: string})} build
 *        每次显示时调用（这样切语言、改数值后重新悬浮都能拿到最新文案）。
 */
export function attachHoverTip(el, build) {
  if (!el || typeof build !== 'function') return;
  builders.set(el, build);
  // aria-describedby 指向提示卡：读屏读到控件时会把说明一起念出来。
  if (!el.hasAttribute('aria-describedby')) {
    el.setAttribute('aria-describedby', TIP_ID);
  }
  el.addEventListener('mouseenter', () => _scheduleShow(el));
  el.addEventListener('mouseleave', hideHoverTip);
  el.addEventListener('focus', () => _scheduleShow(el));
  el.addEventListener('blur', hideHoverTip);
  el.addEventListener('mousedown', hideHoverTip);
}

/** 全局兜底隐藏：滚动 / 失焦 / Esc / 窗口尺寸变化。只注册一次。 */
export function installHoverTipGlobalDismiss() {
  if (installHoverTipGlobalDismiss._done) return;
  installHoverTipGlobalDismiss._done = true;
  const dismiss = () => hideHoverTip();
  window.addEventListener('wheel', dismiss, { passive: true, capture: true });
  window.addEventListener('resize', dismiss);
  window.addEventListener('blur', dismiss);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismiss();
  });
}
