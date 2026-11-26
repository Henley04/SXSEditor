'use strict';
/**
 * 分页跟随掉帧回归：网格 / 背景静态层不得随 scrollX 每帧重建。
 *
 * 现场（用户报告）：跟随播放进度时视图移动明显掉帧。根因是静态层离屏缓存的
 * key 含精确的 scrollX —— 分页动画连续 ~18 帧改写 scrollX，每帧都重建整张
 * 网格（主窗口实测重建 1.06ms vs 命中 0.21ms）。
 *
 * 修复：静态层改为世界坐标锚定 + 按视口量化的页，缓存覆盖 2 个视口宽；
 * 页内滚动只做带偏移的 drawImage，不重建。这里锁住两条：
 *   · 页内小步滚动（跟随动画的典型步长）不产生任何 stroke/fillRect 重建；
 *   · blit 的源 x 偏移 = (scrollX - 页锚点) × dpr，视图始终取到正确的一屏。
 */
const { expect } = require('chai');

const { state, dom, trackManager } = require('../src/renderer/state.js');
const { renderFragmentTimeline, invalidateGridCache } = require('../src/renderer/timelineRenderer.js');

function installDom() {
  document.body.innerHTML = `
    <div id="singer-list"></div>
    <div id="fragment-canvas-container">
      <canvas id="fragment-canvas"></canvas>
      <canvas id="fragment-playhead-canvas"></canvas>
    </div>
  `;
  const container = document.getElementById('fragment-canvas-container');
  Object.defineProperty(container, 'clientWidth', { value: 1200, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 460, configurable: true });
  dom.singerListEl = document.getElementById('singer-list');
  dom.fragmentContainer = container;
  dom.fragmentCanvas = document.getElementById('fragment-canvas');
  dom.fragmentPlayheadCanvas = document.getElementById('fragment-playhead-canvas');
}

function seedProject() {
  trackManager.clearAll();
  const singer = trackManager.addSinger({ name: 'S', type: 'singer' });
  for (let f = 0; f < 6; f++) {
    trackManager.addFragment({
      singerId: singer.id, startTime: f * 64, duration: 64, name: `F${f}`,
      notes: [{ id: `n${f}`, start: 0, duration: 2, pitch: 60, lyric: 'la' }],
    });
  }
  state.project.bpm = 120;
  state.project.timeSignature = [4, 4];
  state.fragmentZoomX = 1;
  state.fragmentScrollX = 0;
  state.fragmentScrollY = 0;
  invalidateGridCache();
}

/** 主画布 2D 上下文（记录型，见 test/setup.js）。 */
function mainCtx() { return dom.fragmentCanvas.getContext('2d'); }

/** 从主画布最近一次 drawImage 找到被 blit 的离屏网格 canvas。 */
function lastBlittedGrid() {
  const ops = mainCtx().__ops('drawImage');
  if (!ops.length) return null;
  return ops[ops.length - 1].args[0];
}

/** 网格离屏 canvas 自上次以来的 stroke 次数（>0 表示发生了重建）。 */
function gridStrokeCount() {
  const grid = lastBlittedGrid();
  if (!grid || !grid.getContext) return 0;
  return grid.getContext('2d').__ops('stroke').length;
}

describe('网格缓存 — 分页跟随期间不重建', () => {
  beforeEach(() => {
    installDom();
    seedProject();
    state.isPlaying = false;
  });

  it('页内小步滚动：网格不重建，只有带偏移的 drawImage', () => {
    renderFragmentTimeline();               // 建一次网格（锚点 0）
    const grid = lastBlittedGrid();
    expect(grid, '应 blit 一张离屏网格').to.not.equal(null);
    grid.getContext('2d').__reset();

    // 跟随动画的典型步长：视口 1200px，页内 100→260px 小步前进
    for (let x = 100; x <= 260; x += 20) {
      state.fragmentScrollX = x;
      renderFragmentTimeline();
    }
    expect(gridStrokeCount(), '页内滚动不应重建网格').to.equal(0);
  });

  it('blit 源 x 偏移 = (scrollX - 页锚点) × dpr', () => {
    const dpr = global.window.devicePixelRatio || 1;
    state.fragmentScrollX = 260;            // 落在页 [0,1200) 内
    renderFragmentTimeline();
    const blit = mainCtx().__ops('drawImage').slice(-1)[0];
    // 9 参数形式：drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
    const sx = blit.args[1];
    expect(sx).to.be.closeTo(260 * dpr, 0.001);
  });

  it('跨页时重建一次网格（锚点变化），且新页内继续命中', () => {
    state.fragmentScrollX = 0;
    renderFragmentTimeline();
    // 跳到下一页（>1200），锚点变，网格必须重建
    state.fragmentScrollX = 1300;
    renderFragmentTimeline();
    const grid = lastBlittedGrid();
    grid.getContext('2d').__reset();
    // 新页内小步滚动不再重建
    for (let x = 1320; x <= 1500; x += 30) {
      state.fragmentScrollX = x;
      renderFragmentTimeline();
    }
    expect(gridStrokeCount(), '新页内不应重复重建').to.equal(0);
  });
});
