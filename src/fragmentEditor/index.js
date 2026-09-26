import '../common.css';
import '../fragmentEditor.css';
import { initI18n, applyLocale, getLocale, t } from '../i18n/index.js';
import { initWindowTheme } from '../themes/themeInit.js';
import { hydrateIcons } from '../icons/iconHelper.js';
import { initPipeline } from './pipeline.js';
import { resizeCanvases } from './canvasRenderer.js';
import { setupEventListeners, _invalidateCanvasRect } from './eventHandlers.js';
import { setupIpcHandlers, loadFragmentFromHash } from './ipcHandlers.js';
import { setupUiControls } from './uiControls.js';
import { startAutoInferenceWatcher, stopAutoInferenceWatcher } from './autoInference.js';
import { installAutoRelayout } from '../shared/autoRelayout.js';
import {
  getAutoSaveTimer, setAutoSaveTimer,
  getIpcCleanups,
  getCurrentFragment,
  getNotes,
  getEnvelopes,
  getPitchCurve,
} from './state.js';

// Initialize pipeline
initPipeline();

// Apply saved theme
initWindowTheme(getIpcCleanups());

// Setup window resize + container-level auto relayout.
// ResizeObserver 覆盖停靠式 DevTools 打开/关闭这类 window 'resize' 不触发的
// 场景：此前 DevTools 关闭后 canvas 仍按旧尺寸绘制，必须手动交互才刷新。
installAutoRelayout(
  [
    document.getElementById('piano-roll-container'),
    document.getElementById('piano-keys-container'),
  ],
  () => {
    // canvas 位置/尺寸已变，旧的 getBoundingClientRect 缓存必须失效，
    // 否则 hit-test 会用旧坐标 → 点击位置与预期不符。
    _invalidateCanvasRect();
    resizeCanvases();
  },
);

// Setup all event listeners
setupEventListeners();

// Setup IPC handlers
setupIpcHandlers();

// Setup UI controls
setupUiControls();

// Wire up param lane tabs with hidden select
{
  const tabs = document.querySelectorAll('.param-lane-tab:not(.disabled)');
  const select = document.getElementById('param-mode-select');
  if (tabs.length && select) {
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const lane = tab.dataset.lane;
        select.value = lane;
        select.dispatchEvent(new Event('change'));
      });
    });
    // Sync tab active state when select changes
    select.addEventListener('change', () => {
      tabs.forEach(t => t.classList.toggle('active', t.dataset.lane === select.value));
      document.querySelectorAll('.param-lane-tab.disabled').forEach(t => t.classList.remove('active'));
    });
  }
}

// Setup inspector resize handle
{
  const handle = document.getElementById('inspector-resize');
  const mainContent = document.getElementById('main-content');
  if (handle && mainContent) {
    let dragging = false, startX = 0, startCols = '';
    // rAF 合并：mousemove 每帧可达数十次，同步改 gridTemplateColumns +
    // 重算 canvas 会造成明显卡顿。同时此前完全不触发重绘，
    // 拖完必须手动交互一次 canvas 才更新尺寸。
    let rafId = 0;
    const scheduleRelayout = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        _invalidateCanvasRect();
        resizeCanvases();
      });
    };
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startCols = mainContent.style.gridTemplateColumns || getComputedStyle(mainContent).gridTemplateColumns;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = startX - e.clientX;
      const cols = startCols.split(/\s+/);
      const currentW = parseFloat(cols[3]) || 220;
      const newW = Math.max(160, Math.min(400, currentW + dx));
      mainContent.style.gridTemplateColumns = `80px 1fr 4px ${newW}px`;
      scheduleRelayout();
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      scheduleRelayout();
    });
  }
}

// Setup inspector slider interaction
{
  document.querySelectorAll('.insp-slider').forEach(sl => {
    const thumb = sl.querySelector('.thumb');
    const fill = sl.querySelector('.fill');
    const val = sl.querySelector('.val');
    if (!thumb) return;
    let drag = false;
    const onMove = (e) => {
      const rect = sl.getBoundingClientRect();
      let pct = ((e.clientX - rect.left - 4) / (rect.width - 8)) * 100;
      pct = Math.max(0, Math.min(100, pct));
      thumb.style.left = pct + '%';
      fill.style.width = pct + '%';
      if (val) val.textContent = Math.round(pct);
    };
    thumb.addEventListener('mousedown', (e) => { drag = true; e.preventDefault(); });
    sl.addEventListener('mousedown', (e) => { drag = true; onMove(e); });
    document.addEventListener('mousemove', (e) => { if (drag) onMove(e); });
    document.addEventListener('mouseup', () => { drag = false; });
  });
}

// Load fragment from hash if needed
loadFragmentFromHash();

// 编辑后自动实时推理监听（设置项 autoRealtimeInference，默认关闭）。
// 放在 loadFragmentFromHash 之后：此时 currentFragment 已就绪，才能比对签名。
startAutoInferenceWatcher();

// Initialize i18n
initI18n().then(() => {
  applyLocale();
  document.documentElement.lang = getLocale();
  hydrateIcons(document);
});

console.log(t('fragment.consoleStarted'));

// Handle beforeunload
window.addEventListener('beforeunload', () => {
  stopAutoInferenceWatcher();
  for (const cleanup of getIpcCleanups()) {
    try { cleanup(); } catch (_) {}
  }
  getIpcCleanups().length = 0;
  const autoSaveTimer = getAutoSaveTimer();
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    setAutoSaveTimer(null);
  }
  // Use synchronous save to ensure data is persisted before unload
  try {
    const currentFragment = getCurrentFragment();
    if (currentFragment) {
      currentFragment.notes = getNotes();
      currentFragment.envelopes = getEnvelopes();
      currentFragment.pitchCurve = getPitchCurve();
      if (window.electronAPI?.saveFragmentDataSync) {
        window.electronAPI.saveFragmentDataSync(currentFragment.id, {
          notes: getNotes(),
          envelopes: getEnvelopes(),
          pitchCurve: getPitchCurve(),
          startTime: currentFragment.startTime,
          duration: currentFragment.duration,
        });
      }
    }
  } catch (_) {}
});
