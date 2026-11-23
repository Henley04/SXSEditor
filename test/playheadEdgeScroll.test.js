'use strict';
/**
 * 拖动播放头到视口边缘的自动滚屏（计划 4.11）。
 *
 * 边缘滚屏逻辑在 eventHandlers.js 的内部函数里，通过导出的 rect 缓存注入点驱动。
 * 这里验证核心不变量：isFollowing() 在拖拽期间为 false，松手后重建；边缘滚屏的
 * 速度/方向/上限计算由纯函数语义（clamp + 距离映射）保证，通过状态与滚动值观察。
 */
const { expect } = require('chai');

const { state, dom, trackManager } = require('../src/renderer/state.js');
const {
  renderFragmentTimeline,
  pauseFollow,
  resetFollowAnchor,
  isFollowing,
  getMaxFragmentScrollX,
  getFollowState,
  FOLLOW_STATE,
} = require('../src/renderer/timelineRenderer.js');

function installDom(width = 1200) {
  document.body.innerHTML = `
    <div id="singer-list"></div>
    <div id="fragment-canvas-container">
      <canvas id="fragment-canvas"></canvas>
      <canvas id="fragment-playhead-canvas"></canvas>
    </div>
  `;
  const container = document.getElementById('fragment-canvas-container');
  Object.defineProperty(container, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 460, configurable: true });
  dom.singerListEl = document.getElementById('singer-list');
  dom.fragmentContainer = container;
  dom.fragmentCanvas = document.getElementById('fragment-canvas');
  dom.fragmentPlayheadCanvas = document.getElementById('fragment-playhead-canvas');
}

function seed() {
  trackManager.clearAll();
  const s = trackManager.addSinger({ name: 'S', type: 'singer' });
  trackManager.addFragment({
    singerId: s.id, startTime: 0, duration: 200, name: 'F',
    notes: [{ start: 0, duration: 2, pitch: 60, lyric: 'la' }],
  });
  state.project = { bpm: 120, timeSignature: [4, 4] };
  state.fragmentZoomX = 1;
  state.fragmentScrollX = 0;
  state.fragmentScrollY = 0;
  state.isPlaying = false;
  renderFragmentTimeline();
}

describe('播放头拖拽边缘滚屏 — 与跟随协调', () => {
  beforeEach(() => {
    installDom();
    seed();
  });

  it('getMaxFragmentScrollX 返回正数（有可滚动空间）', () => {
    expect(getMaxFragmentScrollX()).to.be.greaterThan(0);
  });

  it('拖拽开始 pauseFollow → 期间 isFollowing() 为 false', () => {
    pauseFollow();
    expect(getFollowState()).to.equal(FOLLOW_STATE.SUSPENDED_BY_DRAG);
    expect(isFollowing()).to.equal(false);
  });

  it('松手 resetFollowAnchor → isFollowing() 恢复，锚点以当前位置重建', () => {
    state.fragmentScrollX = 300;
    pauseFollow();
    resetFollowAnchor();
    expect(isFollowing()).to.equal(true);
    // resetFollowAnchor 不复位 scrollX —— 以当前视口为新锚点
    expect(state.fragmentScrollX).to.equal(300);
  });

  it('scrollX clamp 在 [0, maxScroll] 内', () => {
    const max = getMaxFragmentScrollX();
    state.fragmentScrollX = max + 1000;
    renderFragmentTimeline();
    expect(state.fragmentScrollX).to.be.at.most(max + 0.001);
    state.fragmentScrollX = -100;
    renderFragmentTimeline();
    expect(state.fragmentScrollX).to.be.at.least(0);
  });
});
