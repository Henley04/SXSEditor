/**
 * 主时间轴「缩放跟手」回归测试。
 *
 * 背景：分片的音符条用离屏精灵渲染（每帧一次 drawImage 代替上千次 fillRect）。
 * 旧实现把精灵缓存键写成**精确的屏宽**，于是 Ctrl+滚轮每缩放一点、屏宽就变一点，
 * 每个可见分片每帧都 cache miss → 每帧新建 N 张离屏 canvas 并把所有音符重画一遍。
 * 缩放因此比滚动慢一个数量级，表现为"缩放不跟手"（滚动时屏宽不变，所以完全正常）。
 *
 * 这里用「document.createElement('canvas') 的调用次数」作为离屏位图分配的度量：
 *   · 同一缩放级别重复渲染 → 0 次分配
 *   · 小步缩放（+1%）        → 0 次分配（分辨率够用就插值复用）
 *   · 屏宽翻倍               → 只允许重建一次
 *   · 缩小                   → 永不重建
 */
const { expect } = require('chai');

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

const { state, trackManager } = require('../src/renderer/state.js');
const {
  renderFragmentTimeline,
  invalidateFragmentNoteSprites,
} = require('../src/renderer/timelineRenderer.js');

// 统计离屏 canvas 分配次数（精灵 / 静态层都走 createElement）。
// after() 必须还原：patch 是模块级副作用，不还原会泄漏到之后加载的测试文件。
const _origCreateElement = document.createElement.bind(document);
let _canvasAllocs = 0;
document.createElement = (tag, ...rest) => {
  if (String(tag).toLowerCase() === 'canvas') _canvasAllocs++;
  return _origCreateElement(tag, ...rest);
};
after(() => {
  document.createElement = _origCreateElement;
});

function seedProject() {
  trackManager.clearAll();
  for (let s = 0; s < 3; s++) {
    const singer = trackManager.addSinger({ name: `S${s}`, type: 'singer' });
    for (let f = 0; f < 4; f++) {
      const notes = [];
      for (let n = 0; n < 64; n++) {
        notes.push({
          id: `n${s}-${f}-${n}`,
          start: n * 0.25,
          duration: 0.2,
          pitch: 60 + (n % 12),
          lyric: 'la',
        });
      }
      trackManager.addFragment({
        singerId: singer.id,
        startTime: f * 16,
        duration: 16,
        name: `F${s}-${f}`,
        notes,
      });
    }
  }
}

/** 渲染一帧并返回本次渲染新分配的离屏 canvas 数量。 */
function renderAndCount() {
  _canvasAllocs = 0;
  renderFragmentTimeline();
  return _canvasAllocs;
}

describe('主时间轴 缩放精灵缓存', () => {
  beforeEach(() => {
    seedProject();
    invalidateFragmentNoteSprites();
    state.fragmentZoomX = 1;
    state.fragmentScrollX = 0;
    state.fragmentScrollY = 0;
    renderAndCount(); // 预热：首帧允许建立精灵
  });

  it('同一缩放级别重复渲染不应重建精灵', () => {
    expect(renderAndCount()).to.equal(0);
    expect(renderAndCount()).to.equal(0);
  });

  it('小步缩放（+1%，连续 10 帧）不应每帧重建', () => {
    let total = 0;
    for (let i = 0; i < 10; i++) {
      state.fragmentZoomX *= 1.01;
      total += renderAndCount();
    }
    expect(total, '屏宽累计只涨 10%，分辨率余量足够，不应分配新位图').to.equal(0);
  });

  it('屏宽翻倍才允许重建，且单帧重建次数 = 可见分片数', () => {
    state.fragmentZoomX = 2.2; // 屏宽 2.2× 已超过 2× 超采样余量
    const allocs = renderAndCount();
    expect(allocs).to.be.greaterThan(0);
    // 之后同一缩放级别必须重新稳定
    expect(renderAndCount()).to.equal(0);
  });

  it('缩小方向永不重建精灵（降采样复用已有位图）', () => {
    // 先热身一遍：缩小会让更多分片进入视野，它们的「首次建图」是必要开销，
    // 这里要测的是「已有位图被复用」，所以先让几个缩放级别都各建一次图。
    state.fragmentZoomX = 0.3;
    renderAndCount();
    state.fragmentZoomX = 0.25;
    renderAndCount();

    state.fragmentZoomX = 0.3;
    expect(renderAndCount(), '缩小方向不应重建').to.equal(0);
    state.fragmentZoomX = 0.25;
    expect(renderAndCount(), '缩小方向不应重建').to.equal(0);
  });

  it('滚动不重建精灵（屏宽未变）', () => {
    const positions = [];
    for (let i = 1; i <= 8; i++) positions.push(i * 40);
    // 热身：滚过一遍，让沿途进入视野的分片各自建图
    for (const x of positions) {
      state.fragmentScrollX = x;
      renderAndCount();
    }
    for (const x of positions) {
      state.fragmentScrollX = x;
      expect(renderAndCount(), `scrollX=${x}`).to.equal(0);
    }
  });

  it('音符内容变化后必须重建（缓存不能吞掉编辑）', () => {
    const frag = trackManager.getFragments()[0];
    frag.notes.push({ id: 'extra', start: 1, duration: 0.5, pitch: 72, lyric: 'la' });
    expect(renderAndCount()).to.be.greaterThan(0);
  });
});
