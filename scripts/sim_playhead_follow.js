/**
 * 播放头分页跟随模拟器（虚拟时钟 + 真实模块）。
 *
 * 与 scripts/sim_fragment_playback.js 同一思路：不"复刻"逻辑，而是直接驱动真代码 ——
 *   · 主窗口：require('src/renderer/{state,timelineRenderer}.js')，调用真实的
 *     tickPlayheadFollow / drawPlayheadLine / renderFragmentTimeline，
 *     断言 state.fragmentScrollX 与播放头**实际画到画布上的 x**；
 *   · 分片编辑器：require('src/fragmentEditor/{state,canvasRenderer}.js')，调用真实的
 *     tickPlayheadFollow（内部走真实 render()→_doRender→drawPlayhead）。
 *
 * 时钟与播放位置是模拟的（虚拟 60fps），其余全是产品代码。
 *
 * 每个场景检查五类问题：
 *   1) 落点错位：分页动画落地那一刻播放头是否在左侧 1/5（容差 4px）；
 *   2) 越界：跟随生效后播放头是否跑出视口；
 *   3) 抖振：scroll 是否来回跳（末尾 clamp 反复触发 / 动画被反复重建）；
 *   4) 瞬移：单帧滚动位移是否过大（说明动画没生效、或时间基准被重置）；
 *   5) 绘制错位：画到画布上的播放头 x 是否与"时间→x − scroll"一致。
 *
 * 用法：
 *   node scripts/sim_playhead_follow.js                 # 全部场景
 *   node scripts/sim_playhead_follow.js S2              # 只跑名字含 S2 的场景
 *   SIM_VERBOSE=1 node scripts/sim_playhead_follow.js   # 打印每次跳转/落地明细
 */

require('@babel/register')({
  presets: ['@babel/preset-env'],
  ignore: [/node_modules/],
});

const { JSDOM } = require('jsdom');

const FRAME_MS = 1000 / 60;
const ANCHOR_TOL_PX = 4;
// 起播回填（reveal）允许开头一段"播放头还在视口外"：动画本身要跑 ~200-400ms
const REVEAL_GRACE_MS = 1200;
const VERBOSE = !!process.env.SIM_VERBOSE;
const FILTER = process.argv[2] || '';

// ==================== DOM ====================
const MAIN_W = 1200;
const MAIN_H = 460;
const FRAG_W = 900;
const FRAG_H = 520;

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div id="singer-list"></div>
  <div id="fragment-canvas-container">
    <canvas id="fragment-canvas"></canvas>
    <canvas id="fragment-playhead-canvas"></canvas>
  </div>
  <div id="piano-roll-wrap"><canvas id="piano-roll"></canvas></div>
  <div id="piano-keys-wrap"><canvas id="piano-keys"></canvas></div>
</body></html>`, { pretendToBeVisual: true, url: 'http://localhost' });

global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.CustomEvent = dom.window.CustomEvent;
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });

function mockSize(el, w, h) {
  Object.defineProperty(el, 'clientWidth', { get: () => w, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => h, configurable: true });
}
const mainContainer = document.getElementById('fragment-canvas-container');
const pianRollWrap = document.getElementById('piano-roll-wrap');
mockSize(mainContainer, MAIN_W, MAIN_H);
mockSize(pianRollWrap, FRAG_W, FRAG_H);
mockSize(document.getElementById('piano-keys-wrap'), 80, FRAG_H);

// 记录型 2D 上下文：不画真像素，但每次绘图调用都留痕 ——
// "播放头画在哪 / 内容被 translate 到哪"必须看真实调用参数，不能自己算一遍。
const CTX_OPS = ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo',
  'quadraticCurveTo', 'bezierCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect',
  'fill', 'stroke', 'clip', 'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText',
  'drawImage', 'putImageData', 'setTransform', 'resetTransform', 'transform', 'translate',
  'scale', 'rotate', 'setLineDash'];
global.HTMLCanvasElement.prototype.getContext = function getContext() {
  if (!this.__ctx2d) {
    const calls = [];
    const c = { canvas: this, font: '13px sans-serif', __calls: calls };
    for (const op of CTX_OPS) c[op] = (...args) => { calls.push({ op, args }); };
    c.getLineDash = () => [];
    c.createLinearGradient = () => ({ addColorStop() {} });
    c.createRadialGradient = () => ({ addColorStop() {} });
    c.createPattern = () => null;
    c.measureText = (s) => ({ width: String(s || '').length * 7, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2 });
    c.getImageData = (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4), width: w, height: h });
    c.createImageData = (w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4), width: w, height: h });
    this.__ctx2d = c;
  }
  return this.__ctx2d;
};

// ==================== 虚拟时钟 ====================
// 跟随器的时间门控（3s 空闲 / 动画进度）全部基于 performance.now()。
// 模拟器同步跑成千上万帧，用真实时钟等于"所有帧都挤在同一毫秒里"，
// 门控与动画都不会触发 —— 必须把时钟换成由帧号驱动的虚拟时间。
let vnow = 0;
// 每个场景的时钟基址：场景内部按 t=0 断言，但时钟必须跨场景单调递增
// （跟随器里"最后一次操作时间"是全局的，时钟倒退会让 3s 门控永久锁死）。
let timeBase = 0;
try { global.performance.now = () => vnow; } catch (_e) { /* 只读实现，退化为真实时钟 */ }
try { dom.window.performance.now = () => vnow; } catch (_e) { /* 同上 */ }

// ==================== 可控 rAF ====================
// 分片编辑器的 render() 是 rAF 合并的：由模拟器决定"下一帧"何时到来，渲染才是确定的。
let rafSeq = 0;
const rafQueue = new Map();
global.requestAnimationFrame = (cb) => { const id = ++rafSeq; rafQueue.set(id, cb); return id; };
global.cancelAnimationFrame = (id) => { rafQueue.delete(id); };
dom.window.requestAnimationFrame = global.requestAnimationFrame;
dom.window.cancelAnimationFrame = global.cancelAnimationFrame;
function flushRaf() {
  if (!rafQueue.size) return;
  const due = [...rafQueue.entries()];
  rafQueue.clear();
  for (const [, cb] of due) {
    try { cb(vnow); } catch (e) { console.error('[raf]', e); }
  }
}

// ==================== 装载真实模块 ====================
const mainState = require('../src/renderer/state.js');
const mainRenderer = require('../src/renderer/timelineRenderer.js');
const fragState = require('../src/fragmentEditor/state.js');
const fragRenderer = require('../src/fragmentEditor/canvasRenderer.js');

const { state, trackManager } = mainState;

// ==================== 项目数据 ====================
function seedMainProject({ singers = 2, fragmentsPerSinger = 8, beatsPerFragment = 32 } = {}) {
  trackManager.clearAll();
  state.project.bpm = 120;
  state.project.timeSignature = [4, 4];
  state.fragmentZoomX = 1;
  state.fragmentScrollX = 0;
  state.fragmentScrollY = 0;
  state.isPlaying = false;
  state.playbackPauseOffset = 0;
  for (let s = 0; s < singers; s++) {
    const singer = trackManager.addSinger({ name: `S${s}`, type: 'singer' });
    for (let f = 0; f < fragmentsPerSinger; f++) {
      const notes = [];
      for (let n = 0; n < 64; n++) {
        notes.push({ id: `n${s}-${f}-${n}`, start: n * 0.5, duration: 0.4, pitch: 60 + (n % 12), lyric: 'la' });
      }
      trackManager.addFragment({
        singerId: singer.id,
        startTime: f * beatsPerFragment,
        duration: beatsPerFragment,
        name: `F${s}-${f}`,
        notes,
      });
    }
  }
  mainRenderer.renderFragmentTimeline();
}

function seedFragmentEditor({ durationBeats = 96 } = {}) {
  fragState.setCurrentProject({ bpm: 120, timeSignature: [4, 4] });
  fragState.setCurrentFragment({ id: 'frag-1', duration: durationBeats, singerId: 's1', notes: [] });
  const notes = [];
  for (let i = 0; i < 64; i++) {
    notes.push({ id: `n${i}`, start: i * 1.0, duration: 0.6, pitch: 62 + (i % 10), lyric: 'la' });
  }
  fragState.setNotes(notes);
  fragState.setScrollX(0);
  fragState.setScrollY(0);
  fragState.setZoomX(1);
  fragState.setFragmentIsPlaying(false);
  fragState.setFragmentPlayStartPosition(0);
  fragState.setFragmentCurrentTime(0);
  fragRenderer.render();
  flushRaf();
}

// ==================== 观察器 ====================
function makeMainRig() {
  const playheadCtx = document.getElementById('fragment-playhead-canvas').getContext('2d');
  const contentCtx = document.getElementById('fragment-canvas').getContext('2d');
  return {
    label: '主窗口',
    viewport: () => mainContainer.clientWidth,
    contentEndSec() {
      const maxBeat = trackManager.getFragments().reduce((m, f) => Math.max(m, f.startTime + f.duration), 0);
      return (maxBeat / state.project.bpm) * 60;
    },
    setPlaying(on) { state.isPlaying = on; },
    tick(sec) {
      // 真实播放循环的顺序：先跟随（可能改 scroll + 重画时间轴），再画播放头
      mainRenderer.tickPlayheadFollow(sec);
      // 只留这一帧"画播放头"的调用记录：取第一个 moveTo 即播放头竖线的 x
      playheadCtx.__calls.length = 0;
      mainRenderer.drawPlayheadLine(sec);
    },
    flush() {},
    getScroll: () => state.fragmentScrollX,
    setScroll(v) { state.fragmentScrollX = v; mainRenderer.renderFragmentTimeline(); },
    drawnPlayheadX() {
      const moves = playheadCtx.__calls.filter((c) => c.op === 'moveTo');
      return moves.length ? moves[0].args[0] : null;
    },
    /**
     * 内容被 translate 到的偏移：renderFragmentTimeline 的顺序是
     * setTransform(dpr,…) → clearRect(0,0,w,h) → translate(-scrollX,-scrollY)。
     * 取"最后一次 clearRect 之后的第一个 translate"，即本帧根变换。
     */
    drawnContentOffset() {
      const calls = contentCtx.__calls;
      let clearIdx = -1;
      for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i].op === 'clearRect') { clearIdx = i; break; }
      }
      if (clearIdx < 0) return null;
      for (let i = clearIdx; i < calls.length; i++) {
        if (calls[i].op === 'translate') return -calls[i].args[0];
      }
      return null;
    },
    expectedViewX(sec) { return mainRenderer.playbackTimeToX(sec) - state.fragmentScrollX; },
    /** 播放头世界坐标（与视口无关） */
    worldX(sec) { return mainRenderer.playbackTimeToX(sec); },
    getMaxScroll(w) {
      const beatWidth = mainRenderer.getBeatWidth();
      const maxBeat = trackManager.getFragments().reduce((m, f) => Math.max(m, f.startTime + f.duration), 0);
      const totalBeats = Math.max(64, Math.ceil((maxBeat + 256) / 64) * 64);
      return Math.max(0, totalBeats * beatWidth - w);
    },
    snapshot: () => mainRenderer.getPlayheadFollowSnapshot(),
    resetFollow: (o) => mainRenderer.resetPlayheadFollow(o),
    settleFollow: () => mainRenderer.settlePlayheadFollow(),
    markGesture: () => mainRenderer.markPlayheadFollowViewportGesture(),
    markActivity: () => mainRenderer.markPlayheadFollowActivity(),
    pointerDown: (d) => mainRenderer.setPlayheadFollowPointerDown(d),
    setZoom(z) {
      state.fragmentZoomX = z;
      mainRenderer.renderFragmentTimeline();
    },
    getZoom: () => state.fragmentZoomX,
    getBeatWidth: () => mainRenderer.getBeatWidth(),
  };
}

function makeFragRig() {
  return {
    label: '分片编辑器',
    viewport: () => pianRollWrap.clientWidth,
    contentEndSec() {
      const p = fragState.getCurrentProject();
      const bpm = p ? p.bpm : 120;
      const f = fragState.getCurrentFragment();
      const fragSec = ((f && f.duration) || 0) / bpm * 60;
      const notesEndSec = fragState.getNotes()
        .reduce((m, n) => Math.max(m, (n.start + n.duration) / bpm * 60), 0);
      return Math.max(fragSec, notesEndSec);
    },
    setPlaying(on) { fragState.setFragmentIsPlaying(on); },
    tick(sec) {
      fragState.setFragmentCurrentTime(sec);
      fragRenderer.tickPlayheadFollow(sec);
      flushRaf();  // 真实 render() 是 rAF 合并的，"下一帧"就把它跑掉
    },
    flush() { flushRaf(); },
    getScroll: () => fragState.getScrollX(),
    setScroll(v) { fragState.setScrollX(v); fragRenderer.render(); flushRaf(); },
    // 钢琴卷帘的播放头画在主画布上，位置由 drawPlayhead 用 timeToX() 算（已减 scrollX）
    drawnPlayheadX() { return fragRenderer.getPlayheadX(); },
    // 钢琴卷帘逐元素 timeToX（没有根 translate），内容偏移等价于 scrollX 本身
    drawnContentOffset() { return null; },
    expectedViewX(sec) {
      const bpm = fragState.getCurrentProject().bpm;
      return fragRenderer.timeToX((sec / 60) * bpm);
    },
    /** 播放头世界坐标（timeToX 已减 scrollX，这里还原） */
    worldX(sec) {
      const bpm = fragState.getCurrentProject().bpm;
      return fragRenderer.timeToX((sec / 60) * bpm) + fragState.getScrollX();
    },
    getMaxScroll(w) {
      const bpm = fragState.getCurrentProject().bpm;
      const endSec = this.contentEndSec();
      const contentPx = (endSec / 60) * bpm * 80 * fragState.getZoomX();
      return Math.max(0, contentPx - w * 0.2);
    },
    snapshot: () => fragRenderer.getPlayheadFollowSnapshot(),
    resetFollow: (o) => fragRenderer.resetPlayheadFollow(o),
    settleFollow: () => fragRenderer.settlePlayheadFollow(),
    markGesture: () => fragRenderer.markPlayheadFollowViewportGesture(),
    markActivity: () => fragRenderer.markPlayheadFollowActivity(),
    pointerDown: (d) => fragRenderer.setPlayheadFollowPointerDown(d),
    setZoom(z) { fragState.setZoomX(z); fragRenderer.render(); flushRaf(); },
    getZoom: () => fragState.getZoomX(),
    getBeatWidth: () => 80 * fragState.getZoomX(),
  };
}

// ==================== 场景执行器 ====================
const results = [];

function check(list, name, ok, detail) {
  list.push({ name, ok: !!ok, detail });
}

/** 把视口摆到"播放头位于 ratio×W"的位置（不给负的 scroll）。 */
function primeViewport(rig, sec, ratio = 0.75) {
  const target = rig.worldX(sec) - rig.viewport() * ratio;
  if (target > 0) rig.setScroll(target);
}

/**
 * 跑一段模拟播放。
 *
 * @param {object} rig
 * @param {object} opts
 * @param {number} opts.seconds     期望模拟的播放秒数（会被内容末端截断，模拟真实"播完就停"）
 * @param {number} [opts.startSec]
 * @param {number} [opts.speed]     播放速率倍数（>1 压缩模拟时长，不改变像素/秒）
 * @param {object} [opts.hooks]     给 onFrame 用的可变匣子（避免引用尚未赋值的 out）
 * @param {function} [opts.onFrame] (ctx) => void
 * @param {boolean} [opts.allowOutside]  允许播放头长时间在视口外（如"按住不跟随"场景）
 * @param {boolean} [opts.allowTeleport] 允许非动画造成的单帧位移（场景自己 setScroll 造成的）
 * @param {boolean} [opts.allowBackward] 允许 scroll 回退（反向回填 / 起播回填）
 * @param {boolean} [opts.checkLanding]  默认 true；被打断/刻意不落地的场景置 false
 */
function simulate(rig, opts) {
  const {
    seconds, startSec = 0, speed = 1, hooks = {}, onFrame,
    allowOutside = false, allowTeleport = false, allowBackward = false, checkLanding = true,
  } = opts;
  const checks = [];
  const jumps = [];
  const landings = [];
  const endSec = Math.min(seconds, rig.contentEndSec());
  const frames = Math.max(0, Math.round((endSec * 1000) / speed / FRAME_MS));

  let prevScroll = rig.getScroll();
  let prevSnap = rig.snapshot();
  let maxViewX = -Infinity;
  let minViewX = Infinity;
  let backwardFrames = 0;
  let teleportFrames = 0;
  let maxStep = 0;
  let outsideFrames = 0;
  let drawnMismatch = 0;
  let contentOffsetMismatch = 0;

  for (let i = 0; i < frames; i++) {
    // 虚拟时钟用"场景基址 + 帧偏移"：每个场景都从 t=0 起算断言，但跟随器的
    // 时钟必须单调（上一次操作时间戳不能比当前时间还大）。
    const tMs = i * FRAME_MS;
    vnow = timeBase + tMs;
    const sec = startSec + (tMs / 1000) * speed;
    const w = rig.viewport();
    const maxScroll = rig.getMaxScroll(w);

    if (onFrame) onFrame({ rig, tMs, sec, i, hooks, w });

    const scrollBefore = rig.getScroll();
    const viewXBefore = rig.expectedViewX(sec);
    rig.setPlaying(true);
    rig.tick(sec);
    rig.flush();

    const snap = rig.snapshot();
    const scroll = rig.getScroll();

    if (snap.jumpCount > (prevSnap.jumpCount || 0)) {
      jumps.push({ tMs, sec, fromViewX: viewXBefore, target: snap.target, from: scrollBefore });
    }
    // 落地 = 动画真的走到了它规划的目标（被打断/被 settle 到别处的不算）。
    // 条件里必须要求"这一帧动画刚结束"，否则动画尾段连续几帧都满足 |scroll-target|<0.6，
    // 同一次落地会被记三遍。
    if (prevSnap.animating && !snap.animating && prevSnap.target != null
        && Math.abs(scroll - prevSnap.target) < 0.6) {
      const target = prevSnap.target;
      landings.push({
        tMs,
        sec,
        viewX: rig.expectedViewX(sec),
        // 目标被 clamp（时间轴开头/末尾滚不过去）时不能要求落点正好是 1/5
        clamped: target <= 0.5 || target >= maxScroll - 0.5,
      });
    }

    // 每帧不变量
    if (scroll < -0.5 || scroll > maxScroll + 0.5) {
      check(checks, '滚动越界', false, `t=${tMs.toFixed(0)}ms scroll=${scroll.toFixed(1)} max=${maxScroll.toFixed(1)}`);
    }
    if (scroll < prevScroll - 0.01) backwardFrames++;
    const step = Math.abs(scroll - prevScroll);
    if (step > maxStep) maxStep = step;
    // 视口只允许"被动画推动"：scroll 变了但前后都没有动画 = 瞬移
    // （分页总位移约 0.7 视口，一帧跳完 = 动画没生效 / 时间基准被重置）
    if (step > 0.01 && !allowTeleport && !snap.animating && !prevSnap.animating) teleportFrames++;

    const viewX = rig.expectedViewX(sec);
    maxViewX = Math.max(maxViewX, viewX);
    minViewX = Math.min(minViewX, viewX);
    // "跟随被允许时播放头必须在视口内"：
    //   · 用户刚操作过的 3s 内本来就允许它跑出屏（需求就是这么定的）；
    //   · 动画在途时也允许（正在把它拉回来）。
    const idleEnough = snap.lastActivityAt == null || vnow - snap.lastActivityAt >= 3000;
    const animating = snap.animating || prevSnap.animating;
    if (!allowOutside && idleEnough && !animating && tMs > REVEAL_GRACE_MS
        && (viewX < -1 || viewX > w + 1)) {
      outsideFrames++;
    }

    // 错位：真实画到画布上的播放头 x 必须等于"时间→x − scroll"
    const drawn = rig.drawnPlayheadX();
    if (drawn != null && drawn >= 0 && drawn <= w && Math.abs(drawn - viewX) > 0.75) drawnMismatch++;
    const contentOffset = rig.drawnContentOffset();
    if (contentOffset != null && Math.abs(contentOffset - scroll) > 0.75) contentOffsetMismatch++;

    prevScroll = scroll;
    prevSnap = snap;
  }

  timeBase += frames * FRAME_MS + 60000;

  check(checks, '播放头越界帧数', allowOutside || outsideFrames <= 2,
    `${outsideFrames} 帧（视口 ${rig.viewport()}px）`);
  check(checks, '滚动回退帧数', allowBackward || backwardFrames === 0, `${backwardFrames} 帧`);
  check(checks, '滚动只在动画中变化', allowTeleport || teleportFrames === 0,
    `${teleportFrames} 帧瞬移（最大单帧位移 ${maxStep.toFixed(1)}px）`);
  check(checks, '播放头绘制错位', drawnMismatch === 0, `${drawnMismatch} 帧与时间轴映射不一致`);
  check(checks, '内容偏移错位', contentOffsetMismatch === 0, `${contentOffsetMismatch} 帧 translate 与 scroll 不一致`);

  // 抖振：跟随只允许"走完一页再跳下一页"。若出现几百毫秒一次、或每次只挪几像素的
  // 跳转，说明临界判定/冷却失效（末尾 clamp 反复触发的典型症状）。
  let minGap = Infinity;
  let minDelta = Infinity;
  for (let i = 1; i < jumps.length; i++) {
    minGap = Math.min(minGap, jumps[i].tMs - jumps[i - 1].tMs);
  }
  for (const j of jumps) {
    minDelta = Math.min(minDelta, Math.abs((j.target ?? j.from) - j.from));
  }
  if (jumps.length >= 2) {
    check(checks, '跳转间隔 ≥ 1s', minGap >= 1000, `最小间隔 ${minGap.toFixed(0)}ms`);
  }
  if (jumps.length >= 1) {
    check(checks, '每次跳转都挪了整页', minDelta >= 100, `最小位移 ${minDelta.toFixed(0)}px`);
  }

  const w = rig.viewport();
  const judged = landings.filter((l) => !l.clamped);
  // 容差要含"一帧量化"：动画名义结束时刻落在两帧之间，播放头最多又多走了
  // 一帧（rate × 16.7ms）。否则会把纯粹的采样量化当成落点偏差。
  const rate = Math.abs(rig.worldX(endSec) - rig.worldX(Math.max(0, endSec - FRAME_MS / 1000))) / FRAME_MS;
  const tol = ANCHOR_TOL_PX + rate * FRAME_MS * speed;
  const landingErrors = judged.map((l) => Math.abs(l.viewX - w * 0.2));
  const worstLanding = landingErrors.length ? Math.max(...landingErrors) : 0;
  if (checkLanding && judged.length) {
    check(checks, '落点 = 左侧 1/5', worstLanding <= tol,
      `最差 ${worstLanding.toFixed(1)}px（容差 ${tol.toFixed(1)}px，共 ${landings.length} 次落地，可判定 ${judged.length} 次）`);
  }

  return { checks, jumps, landings, maxViewX, minViewX, worstLanding, frames, w };
}

// ==================== 场景 ====================
function scenario(name, fn) {
  if (FILTER && !name.includes(FILTER)) return;
  const out = fn();
  results.push({ name, ...out });
  const failed = out.checks.filter((c) => !c.ok);
  const icon = failed.length ? 'FAIL' : 'PASS';
  console.log(`\n[${icon}] ${name}`);
  console.log(`       跳转 ${out.jumps.length} 次 / 视口 ${out.w}px / 播放头 x∈[${out.minViewX.toFixed(0)}, ${out.maxViewX.toFixed(0)}] / ${out.frames} 帧`);
  for (const c of out.checks) {
    if (!c.ok) console.log(`       ✗ ${c.name}: ${c.detail}`);
  }
  if (VERBOSE) {
    for (const j of out.jumps) {
      console.log(`       · 起跳 t=${(j.tMs / 1000).toFixed(2)}s x=${j.fromViewX.toFixed(0)} → scroll=${j.target.toFixed(0)}`);
    }
    for (const l of out.landings) {
      console.log(`       · 落地 t=${(l.tMs / 1000).toFixed(2)}s x=${l.viewX.toFixed(1)}（目标 ${(out.w * 0.2).toFixed(0)}）`);
    }
  }
  return out;
}

const rigFactories = [
  ['主窗口', makeMainRig, seedMainProject],
  ['分片编辑器', makeFragRig, seedFragmentEditor],
];

for (const [label, makeRig, seed] of rigFactories) {
  // ---- S1 常速顺播：连续分页 ----
  scenario(`S1 ${label} 常速顺播 40s（连续分页）`, () => {
    seed();
    const rig = makeRig();
    rig.resetFollow({ reveal: true });
    return simulate(rig, { seconds: 40 });
  });

  // ---- S2 动画途中用户滚轮：立刻让位，不抢回来 ----
  scenario(`S2 ${label} 动画途中滚轮（立即让位）`, () => {
    seed();
    const rig = makeRig();
    rig.resetFollow({ reveal: true });
    const hooks = { interrupted: false, violated: false };
    const out = simulate(rig, {
      seconds: 14,
      hooks,
      checkLanding: false,   // 动画被用户打断，本来就不该落地
      onFrame: ({ rig: r, tMs }) => {
        if (!hooks.interrupted) {
          if (r.snapshot().animating && tMs > 100) {
            hooks.interrupted = true;
            hooks.interruptTMs = tMs;
            hooks.keep = r.getScroll() + 37;   // 用户滚轮把视口推走一点
            r.setScroll(hooks.keep);
            r.markGesture();
          }
          return;
        }
        // 打断之后、3s 门控结束之前：跟随器一次都不许再写 scroll
        if (tMs < hooks.interruptTMs + 3000 - 100 && Math.abs(r.getScroll() - hooks.keep) > 0.01) {
          hooks.violated = true;
        }
      },
    });
    check(out.checks, '确认打断过动画', hooks.interrupted, `interrupted=${hooks.interrupted}`);
    check(out.checks, '打断后不抢回视口', !hooks.violated, `violated=${hooks.violated}`);
    check(out.checks, '打断 3s 后恢复跟随', rig.snapshot().jumpCount >= 2, `jumpCount=${rig.snapshot().jumpCount}`);
    return out;
  });

  // ---- S3 3s 空闲门控 ----
  scenario(`S3 ${label} 3s 空闲门控`, () => {
    seed();
    const rig = makeRig();
    // 从 15s 起播、视口摆在播放头 0.75W 处：播放头 0.8s 后就会越过右临界
    primeViewport(rig, 15);
    rig.resetFollow({ reveal: true });
    const hooks = { actedAt: -1 };
    const out = simulate(rig, {
      seconds: 12,
      startSec: 15,
      hooks,
      onFrame: ({ rig: r, tMs }) => {
        if (hooks.actedAt < 0 && tMs >= 300) {
          hooks.actedAt = tMs;
          r.markActivity();
          r.markGesture();
        }
      },
    });
    check(out.checks, '越界发生在门控窗口内', out.jumps.length > 0, `jumps=${out.jumps.length}`);
    const early = out.jumps.filter((j) => j.tMs < hooks.actedAt + 3000 - 1);
    check(out.checks, '3s 内不跳转', early.length === 0, `提前跳了 ${early.length} 次`);
    check(out.checks, '满 3s 后跳转', out.jumps.some((j) => j.tMs >= hooks.actedAt + 3000 - 1), `jumps=${out.jumps.length}`);
    return out;
  });

  // ---- S4 指针按住 8s：绝不跟随 ----
  scenario(`S4 ${label} 长按拖拽 8s（禁止跟随）`, () => {
    seed();
    const rig = makeRig();
    rig.resetFollow({ reveal: true });
    rig.pointerDown(true);
    // 按住时播放头必然跑出视口 —— 这是"禁止跟随"的预期结果
    const out = simulate(rig, { seconds: 8, allowOutside: true });
    check(out.checks, '按住期间零跳转', out.jumps.length === 0, `jumps=${out.jumps.length}`);
    check(out.checks, '按住期间不滚动', Math.abs(rig.getScroll()) < 1e-6, `scroll=${rig.getScroll().toFixed(1)}`);
    rig.pointerDown(false);
    return out;
  });

  // ---- S5 播到内容末端：clamp 后不许抖振 ----
  scenario(`S5 ${label} 播到末端（clamp 不抖振）`, () => {
    seed();
    const rig = makeRig();
    rig.resetFollow({ reveal: true });
    // 播到内容末端（分片编辑器会被时长截断，主窗口跑到 90s）
    const out = simulate(rig, { seconds: 90 });
    const w = rig.viewport();
    const maxScroll = rig.getMaxScroll(w);
    check(out.checks, '不越过滚动上限', rig.getScroll() <= maxScroll + 0.5,
      `scroll=${rig.getScroll().toFixed(1)} max=${maxScroll.toFixed(1)}`);
    // 跳转节奏/幅度由 simulate 里的「跳转间隔 ≥ 1s / 每次挪整页」统一守护
    check(out.checks, '末端仍在正常分页', out.jumps.length >= 3, `jumps=${out.jumps.length}`);
    return out;
  });

  // ---- S6 起播回填：播放头在视口外 ----
  scenario(`S6 ${label} 起播回填（播放头在视口外）`, () => {
    seed();
    const rig = makeRig();
    // 视口停在后面（真实场景：滚到后面看谱子，再按播放），播放头在 0s
    rig.setScroll((20 / 60) * 120 * rig.getBeatWidth());
    rig.resetFollow({ reveal: true });
    rig.markActivity();   // 用户刚点了播放按钮
    const startViewX = rig.expectedViewX(0);
    // 回填是"反向"滚动，且是短动画一次性拉回来：允许回退与较大单帧位移
    const out = simulate(rig, { seconds: 3, allowBackward: true, checkLanding: false });
    check(out.checks, '起播时确实在视口外', startViewX < 0, `起始 x=${startViewX.toFixed(0)}`);
    check(out.checks, '回填落地（播放头回到视口内）',
      out.landings.length >= 1 && out.landings[0].viewX >= -1,
      `landings=${out.landings.length} x=${out.landings.length ? out.landings[0].viewX.toFixed(0) : 'n/a'}`);
    return out;
  });

  // ---- S7 动画中途暂停：settle 落地 ----
  scenario(`S7 ${label} 动画中途暂停（settle 落地）`, () => {
    seed();
    const rig = makeRig();
    primeViewport(rig, 15);
    rig.resetFollow({ reveal: true });
    const hooks = { paused: false };
    const out = simulate(rig, {
      seconds: 10,
      startSec: 15,
      hooks,
      // 提前 settle 时播放头还没走到预测终点，落点必然略偏右 —— 这里只验"落到规划终点"
      checkLanding: false,
      onFrame: ({ rig: r, tMs }) => {
        const snap = r.snapshot();
        if (!hooks.paused && snap.animating && tMs > 200) {
          hooks.paused = true;
          hooks.target = snap.target;
          hooks.animatingAtStart = r.getScroll();
          r.settleFollow();
          hooks.afterSettle = r.getScroll();
          hooks.animatingAfter = r.snapshot().animating;
        }
      },
    });
    check(out.checks, 'confirm 中途暂停到动画', hooks.paused, `paused=${hooks.paused}`);
    check(out.checks, 'settle 后停在动画终点',
      Math.abs((hooks.afterSettle ?? 0) - (hooks.target ?? -1)) < 1e-6,
      `scroll=${(hooks.afterSettle ?? NaN).toFixed(1)} target=${(hooks.target ?? NaN).toFixed(1)}`);
    check(out.checks, 'settle 后没有残留动画', hooks.animatingAfter === false, `animating=${hooks.animatingAfter}`);
    return out;
  });

  // ---- S8 播放中缩放：落点按新视口算 ----
  scenario(`S8 ${label} 播放中缩放（落点按新宽度）`, () => {
    seed();
    const rig = makeRig();
    rig.resetFollow({ reveal: true });
    const hooks = { zoomed: false };
    const out = simulate(rig, {
      seconds: 25,
      hooks,
      onFrame: ({ rig: r, tMs }) => {
        if (!hooks.zoomed && tMs > 1500) {
          hooks.zoomed = true;
          r.setZoom(r.getZoom() * 2);
          r.markGesture();     // 缩放也是用户操作 → 3s 内不跟随
        }
      },
    });
    check(out.checks, '缩放后仍能正常分页', out.jumps.length >= 2, `jumps=${out.jumps.length}`);
    return out;
  });

  // ---- S9 反向越界：视口被滚到播放头右侧 ----
  scenario(`S9 ${label} 反向越界回填`, () => {
    seed();
    const rig = makeRig();
    rig.resetFollow({ reveal: true });
    const hooks = { done: false };
    const out = simulate(rig, {
      seconds: 10,
      hooks,
      allowTeleport: true,   // 这一帧的 3000px 位移是"用户滚轮"，不是跟随
      allowBackward: true,   // 回填 = 视口向后拉
      onFrame: ({ rig: r, tMs, sec }) => {
        // t≈4s 时用户把视口滚到播放头右边 3000px，然后停手（3s 后应回填）
        if (!hooks.done && tMs >= 4000 - FRAME_MS / 2) {
          hooks.done = true;
          r.setScroll(r.expectedViewX(sec) + 3000);
          r.markActivity();
          r.markGesture();
        }
      },
    });
    const back = out.jumps.filter((j) => j.fromViewX < 0);
    check(out.checks, '反向越界后回填', back.length >= 1, `回填 ${back.length} 次`);
    return out;
  });

  // ---- S10 窄视口 ----
  scenario(`S10 ${label} 窄视口（400px）`, () => {
    seed();
    const narrow = 400;
    const el = label === '主窗口' ? mainContainer : pianRollWrap;
    const orig = Object.getOwnPropertyDescriptor(el, 'clientWidth');
    Object.defineProperty(el, 'clientWidth', { get: () => narrow, configurable: true });
    // 重新渲染一次，让"缓存的视口宽度"跟上（真实窗口在 ResizeObserver 里做的就是这件事）
    if (label === '主窗口') mainRenderer.renderFragmentTimeline();
    else { fragRenderer.resizeCanvases(); fragRenderer.render(); flushRaf(); }
    const rig = makeRig();
    rig.resetFollow({ reveal: true });
    const out = simulate(rig, { seconds: 25 });
    const errs = out.landings.map((l) => Math.abs(l.viewX - narrow * 0.2));
    const worst = errs.length ? Math.max(...errs) : 0;
    check(out.checks, '窄视口落点仍为 1/5', worst <= ANCHOR_TOL_PX, `最差 ${worst.toFixed(1)}px`);
    check(out.checks, '窄视口也有分页', out.jumps.length >= 3, `jumps=${out.jumps.length}`);
    // 还原
    if (orig) Object.defineProperty(el, 'clientWidth', orig);
    else delete el.clientWidth;
    if (label === '主窗口') mainRenderer.renderFragmentTimeline();
    else { fragRenderer.resizeCanvases(); fragRenderer.render(); flushRaf(); }
    return out;
  });
}

// ==================== 汇总 ====================
const allChecks = results.flatMap((r) => r.checks);
const failed = allChecks.filter((c) => !c.ok);
console.log('\n================ 汇总 ================');
console.log(`场景 ${results.length} 个，断言 ${allChecks.length} 条，失败 ${failed.length} 条`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
  process.exitCode = 1;
} else {
  console.log('全部通过');
}
