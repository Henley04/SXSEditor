'use strict';
/**
 * 钢琴卷帘静态层缓存 — 分页跟随期间不随 scrollX 重建。
 *
 * 与主窗口 timelineRenderer 的网格缓存同源问题：静态层 key 含精确 scrollX，
 * 跟随动画每帧重建（实测 2.85ms vs 命中 2.07ms）。修复为世界坐标锚定 +
 * 按视口量化的页，页内滚动只做带偏移 drawImage。
 */
const { expect } = require('chai');

// 不能只在模块顶层写 DOM：mocha 先加载所有用例文件，后加载的文件在模块顶层
// 改写 document.body.innerHTML 会把这里的节点换掉（本文件单独跑能过、全量挂）。
// 因此在 before 里按 id 重建并重新绑定。
const W = 900;

let state, cr;
let savedRaf = null, savedCancelRaf = null;
let savedBody = '';

function installDom() {
  savedBody = document.body.innerHTML;
  document.body.innerHTML =
    '<div id="piano-roll-wrap"><canvas id="piano-roll"></canvas></div>' +
    '<canvas id="piano-keys"></canvas>';
  // canvasRenderer 在模块加载时绑定了某个 canvas 节点；全量跑时该节点可能已被
  // 别的测试文件替换出文档。把它的绑定节点换回来，render() 才不会因 detached 提前返回。
  const live = document.getElementById('piano-roll');
  if (live && cr && live !== cr.canvas) live.replaceWith(cr.canvas);
  const wrap = document.getElementById('piano-roll-wrap');
  Object.defineProperty(wrap, 'clientWidth', { value: W, configurable: true });
  Object.defineProperty(wrap, 'clientHeight', { value: 520, configurable: true });
}

function installSyncRaf() {
  savedRaf = global.requestAnimationFrame;
  savedCancelRaf = global.cancelAnimationFrame;
  global.requestAnimationFrame = (cb) => { cb(0); return 0; };
  global.cancelAnimationFrame = () => {};
}
function restoreRaf() {
  global.requestAnimationFrame = savedRaf;
  global.cancelAnimationFrame = savedCancelRaf;
}

function lastBlittedStatic() {
  const ops = cr.ctx.__ops('drawImage');
  if (!ops.length) return null;
  return ops[ops.length - 1].args[0];
}
function staticStrokeCount() {
  const c = lastBlittedStatic();
  if (!c || !c.getContext) return 0;
  return c.getContext('2d').__ops('stroke').length;
}

describe('钢琴卷帘静态层缓存 — 分页跟随期间不重建', () => {
  before(() => {
    // 先 require 让模块绑定到当前文档里的 canvas 节点，再 installDom 用
    // replaceWith 把它换回文档（应对全量跑时模块被其他测试文件先加载的情况）。
    state = require('../src/fragmentEditor/state');
    cr = require('../src/fragmentEditor/canvasRenderer');
    installDom();
    cr.invalidateLayoutCache();
    installSyncRaf();
  });
  after(() => { restoreRaf(); document.body.innerHTML = savedBody; });
  beforeEach(() => {
    // 不重建 DOM：canvasRenderer 在模块加载时已绑定 installDom() 创建的 canvas 节点。
    cr.invalidateLayoutCache();
    state.setNotes([]);
    state.setCurrentProject({ bpm: 120, timeSignature: [4, 4] });
    state.setCurrentFragment({ id: 1, duration: 256 });
    state.setZoomX(1);
    state.setScrollX(0);
    state.setScrollY(0);
    cr.invalidateStaticCache();
    cr.ctx.__reset();
  });

  it('页内小步滚动：静态网格不重建', () => {
    cr.render();
    const cached = lastBlittedStatic();
    expect(cached, '应 blit 一张离屏静态层').to.not.equal(null);
    cached.getContext('2d').__reset();

    for (let x = 80; x <= 240; x += 20) {
      state.setScrollX(x);
      cr.render();
    }
    expect(staticStrokeCount(), '页内滚动不应重建静态层').to.equal(0);
  });

  it('跨页时重建一次', () => {
    state.setScrollX(0);
    cr.render();
    state.setScrollX(W + 60);
    cr.render();
    const cached = lastBlittedStatic();
    cached.getContext('2d').__reset();
    for (let x = W + 80; x <= W + 240; x += 40) {
      state.setScrollX(x);
      cr.render();
    }
    expect(staticStrokeCount(), '新页内不应重复重建').to.equal(0);
  });
});
