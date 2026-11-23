'use strict';
/**
 * 播放头分页跟随行为（计划 4.10 / 4.13）。
 *
 * 保留"播放头到视口 90% → 整页跳到 20%"的设计行为，并验证：
 *   · 用户滚轮/缩放进入 SUPPRESSED，抑制窗内视口不动；
 *   · 拖动播放头进入 SUSPENDED_BY_DRAG，松手重建锚点；
 *   · Stop / 工程装载调用锚点复位。
 */
const { expect } = require('chai');
const sinon = require('sinon');

const { state, dom, trackManager } = require('../src/renderer/state.js');
const {
  getBeatWidth,
  renderFragmentTimeline,
  playbackTimeToX,
  markUserViewActivity,
  pauseFollow,
  resetFollowAnchor,
  isFollowing,
  getFollowState,
  tickPlayheadFollow,
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

/** 内容足够宽，使 scrollX 有空间。 */
function seed() {
  trackManager.clearAll();
  const s = trackManager.addSinger({ name: 'S', type: 'singer' });
  // 100 拍 ≈ 50s @120bpm，足够宽
  trackManager.addFragment({
    singerId: s.id, startTime: 0, duration: 100, name: 'F',
    notes: [{ start: 0, duration: 2, pitch: 60, lyric: 'la' }],
  });
  state.project = { bpm: 120, timeSignature: [4, 4] };
  state.fragmentZoomX = 1;
  state.fragmentScrollX = 0;
  state.fragmentScrollY = 0;
  state.isPlaying = true;
  renderFragmentTimeline(); // 初始化 _lastViewportWidth
}

describe('分页跟随状态机（保留 90%→20% 行为）', () => {
  beforeEach(() => {
    installDom();
    seed();
  });

  it('默认 FOLLOWING，isFollowing() 为真', () => {
    resetFollowAnchor();
    expect(getFollowState()).to.equal(FOLLOW_STATE.FOLLOWING);
    expect(isFollowing()).to.equal(true);
  });

  it('滚轮/缩放进入 SUPPRESSED，抑制窗内 isFollowing() 为假', () => {
    resetFollowAnchor();
    markUserViewActivity();
    expect(getFollowState()).to.equal(FOLLOW_STATE.SUPPRESSED);
    expect(isFollowing()).to.equal(false);
  });

  it('拖动播放头进入 SUSPENDED_BY_DRAG，isFollowing() 为假', () => {
    resetFollowAnchor();
    pauseFollow();
    expect(getFollowState()).to.equal(FOLLOW_STATE.SUSPENDED_BY_DRAG);
    expect(isFollowing()).to.equal(false);
  });

  it('松手 resetFollowAnchor 后回到 FOLLOWING', () => {
    pauseFollow();
    resetFollowAnchor();
    expect(isFollowing()).to.equal(true);
  });

  it('播放中不被抑制且越过空闲门后：播放头到视口右侧临界，fragmentScrollX 前进（分页跟随）', () => {
    // 用假时钟推进 3s 越过 resetFollowAnchor / follower 的空闲门控。
    // 基线取当前真实时间之后，避免与前面用例留下的 lastActivityAt（真实时间戳）冲突。
    let now = performance.now() + 100000;
    const clockStub = sinon.stub(performance, 'now').callsFake(() => now);
    try {
      resetFollowAnchor();
      now += 4000; // 越过 3s 抑制窗口
      expect(isFollowing(), '越过抑制窗口后恢复跟随').to.equal(true);

      // 播放头在世界坐标远超视口右缘（playbackTimeToX(30) >> 1200px），
      // tick 应把视口分页前移（scrollX 增大）。
      const farSec = 30;
      tickPlayheadFollow(farSec);
      // 推进动画若干帧（每帧 +16ms）
      for (let i = 0; i < 40; i++) {
        now += 16;
        tickPlayheadFollow(farSec + i * 0.01);
      }
      expect(state.fragmentScrollX, '播放头越过临界后视口应分页前进').to.be.greaterThan(0);
    } finally {
      clockStub.restore();
    }
  });

  it('抑制期间播放头继续前进但 fragmentScrollX 保持不变', () => {
    resetFollowAnchor();
    const sec = playbackTimeToX(5) / getBeatWidth(); // 占位，实际用下面逻辑
    // 先让视口稳定在某处
    state.fragmentScrollX = 0;
    markUserViewActivity();
    const before = state.fragmentScrollX;
    // 抑制窗口内连续 tick：滚动不应变化
    for (let i = 0; i < 30; i++) tickPlayheadFollow(6 + i * 0.1);
    expect(state.fragmentScrollX).to.equal(before);
  });
});
