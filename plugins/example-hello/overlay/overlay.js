/**
 * 浮层脚本：只处理两件事 —— 主题令牌与视口尺寸。
 *
 * 浮层与宿主的唯一通道是 postMessage。宿主会在 iframe load 时发 welcome，
 * 之后窗口尺寸变化时发 viewport 事件；没有握手之前不要假设任何颜色。
 */
let viewport = { width: 0, height: 0 };

function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement;
  if (theme.fg) root.style.color = theme.fg;
  root.dataset.mode = theme.mode || '';
}

function applyViewport(next) {
  if (!next) return;
  viewport = next;
  const badge = document.getElementById('badge');
  if (badge) badge.textContent = `overlay ${Math.round(viewport.width)}×${Math.round(viewport.height)}`;
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.v !== 2) return;
  if (data.kind === 'welcome') {
    applyTheme(data.theme);
    applyViewport(data.viewport);
    return;
  }
  if (data.kind === 'evt' && data.event === 'viewport') applyViewport(data.payload);
});
