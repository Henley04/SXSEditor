'use strict';
/**
 * 播放头在"缩放 / 横向滚动"时的重绘回归测试。
 *
 * 现场（用户报告）：等待推理时缩放并横向滚动，播放头就固定在屏幕上了 ——
 * 时间轴在它下面滚过去，它一动不动。
 *
 * 成因：renderFragmentTimeline() 只在 `!state.isPlaying` 时补画播放头。
 * 等待推理期间 isPlaying 仍为 true（只是 AudioContext 被 suspend、rAF 被
 * 取消），于是缩放/滚动的重绘路径一次都没有画过播放头；而播放头画布是固定
 * 覆盖可视区域的独立画布，尺寸不变就不会被清空 —— 旧像素留在原屏幕坐标上。
 *
 * 这里锁住的行为：只要画布上应该有播放头，任何一次重绘都必须按**当前视图**
 * （playbackTimeToX - scrollX）重新画一遍，而不是把它留在上一帧的屏幕位置。
 */
const { expect } = require('chai');

const { state, dom, trackManager } = require('../src/renderer/state.js');
const {
  renderFragmentTimeline,
  drawPlayheadLine,
  playbackTimeToX,
} = require('../src/renderer/timelineRenderer.js');

/**
 * 重建画布 DOM 并重新绑定 dom 引用。
 *
 * 不能只在模块顶层写一次：mocha 先把所有用例文件加载完再逐个执行，后面加载的
 * 文件里任何一次 `document.body.innerHTML = …` 都会把这里的节点换掉（本文件
 * 单独跑能过、整套跑就挂在 null.getContext 上）。所以每个用例开头重建一次。
 */
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
  // dom 的节点引用在首个 import state.js 的用例里就固定了，这里按 id 重新绑定
  dom.singerListEl = document.getElementById('singer-list');
  dom.fragmentContainer = container;
  dom.fragmentCanvas = document.getElementById('fragment-canvas');
  dom.fragmentPlayheadCanvas = document.getElementById('fragment-playhead-canvas');
}

const playheadCtx = () => document.getElementById('fragment-playhead-canvas').getContext('2d');

/**
 * 播放头竖线的 x 坐标。
 *
 * 播放头画布上只画播放头，第一条 moveTo 就是竖线起点；随后还有顶部三角手柄的
 * 三条边（第一个点是 x - 6），所以不能取最后一条。
 */
function playheadX() {
  const moves = playheadCtx().__ops('moveTo');
  if (moves.length === 0) return null;
  return moves[0].args[0];
}

/** 内容足够宽，scrollX 才不会被 clamp 回 0。 */
function seedProject() {
  trackManager.clearAll();
  for (let s = 0; s < 2; s++) {
    const singer = trackManager.addSinger({ name: `S${s}`, type: 'singer' });
    for (let f = 0; f < 2; f++) {
      trackManager.addFragment({
        singerId: singer.id,
        startTime: f * 64,
        duration: 64,
        name: `F${s}-${f}`,
        notes: [{ id: `n${s}-${f}`, start: 0, duration: 2, pitch: 60, lyric: 'la' }],
      });
    }
  }
  state.project.bpm = 120;
  state.fragmentZoomX = 1;
  state.fragmentScrollX = 0;
  state.fragmentScrollY = 0;
}

describe('播放头重绘 — 缩放 / 横向滚动后必须跟内容走', () => {
  beforeEach(() => {
    installDom();
    seedProject();
    state.isPlaying = false;
    state.playbackPauseOffset = 0;
    state.currentAudioData = null;
    playheadCtx().__reset();
  });

  it('播放中（含等待推理）横向滚动：按新 scrollX 重画，而不是留在原屏幕位置', () => {
    // 先渲染一次把播放头画布撑到容器尺寸（否则默认 300px 宽，4s 的位置直接落在画布外）
    renderFragmentTimeline();
    // 等待推理的形态：isPlaying 仍为 true，rAF 已取消，位置停在 4s
    state.isPlaying = true;
    drawPlayheadLine(4);
    const before = playheadX();
    expect(before, '首次绘制应画出播放头').to.be.a('number');

    playheadCtx().__reset();
    state.fragmentScrollX = 200;
    renderFragmentTimeline();

    const after = playheadX();
    expect(after, '播放中缩放/滚动后必须重绘播放头').to.be.a('number');
    // 位置由时间轴推导：时间点不变，视图右移 200px → 屏幕 x 左移 200px
    expect(after).to.be.closeTo(before - 200, 0.001);
    expect(after).to.be.closeTo(playbackTimeToX(4) - 200, 0.001);
  });

  it('播放中缩放：位置随 beatWidth 变化，仍等于 playbackTimeToX - scrollX', () => {
    renderFragmentTimeline();
    state.isPlaying = true;
    drawPlayheadLine(4);

    playheadCtx().__reset();
    state.fragmentZoomX = 2;
    renderFragmentTimeline();

    expect(playheadX()).to.be.closeTo(playbackTimeToX(4) - state.fragmentScrollX, 0.001);
  });

  it('暂停态滚动仍然会重绘（既有行为不回归）', () => {
    state.isPlaying = false;
    state.currentAudioData = new Float32Array(1000);
    state.playbackPauseOffset = 3;
    renderFragmentTimeline();
    const before = playheadX();
    expect(before).to.be.a('number');

    playheadCtx().__reset();
    state.fragmentScrollX = 120;
    renderFragmentTimeline();
    expect(playheadX()).to.be.closeTo(before - 120, 0.001);
  });

  it('滚出可视区时不把播放头钉在边缘（画不出来就不画）', () => {
    state.isPlaying = true;
    drawPlayheadLine(1);
    playheadCtx().__reset();
    // 视图右移到播放头左侧之外（1s = 2 拍，120px；滚到 600px 早就出去了）
    state.fragmentScrollX = 600;
    renderFragmentTimeline();
    expect(playheadX(), '播放头在视图外时不应被钳在 x=0').to.equal(null);
  });

  it('空闲（无音频、位置 0）不画幽灵播放头', () => {
    state.isPlaying = false;
    state.currentAudioData = null;
    state.playbackPauseOffset = 0;
    playheadCtx().__reset();
    renderFragmentTimeline();
    expect(playheadX()).to.equal(null);
  });
});
