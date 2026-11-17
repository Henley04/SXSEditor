/**
 * 阶段 3：画布"实际 F0 叠画"。
 *
 * 主曲线仍按锚点求值（编辑语义），叠画线 = 统一求值入口
 * buildPitchCurveF0Data 的逐帧结果（含后处理/抖动/颤音）Hz → MIDI。
 * 钉死：缓存键失效、音符外断线（主曲线与叠画都不许跨越空隙连线）、
 * 细半透明样式、"仅显示差异 > X 音分"开关。
 */
const { expect } = require('chai');

document.body.innerHTML =
  '<canvas id="piano-roll"></canvas><canvas id="piano-keys"></canvas>';

// jsdom pretendToBeVisual 提供的是**异步** rAF：render() 的绘制会飘到断言之后。
// 注意：多个测试文件在模块加载时改写 global.requestAnimationFrame，且全部文件
// 先于任何测试加载 —— 模块级赋值会被后加载者覆盖。必须放进 before/after 钩子。
let savedRaf = null, savedCancelRaf = null;
function installSyncRaf() {
  savedRaf = global.requestAnimationFrame;
  savedCancelRaf = global.cancelAnimationFrame;
  // 返回 0（falsy）避免 render() 的 _renderRaf 守卫卡死后续调用
  global.requestAnimationFrame = (cb) => { cb(0); return 0; };
  global.cancelAnimationFrame = () => {};
}
function restoreRaf() {
  global.requestAnimationFrame = savedRaf;
  global.cancelAnimationFrame = savedCancelRaf;
}

const state = require('../src/fragmentEditor/state');
const cr = require('../src/fragmentEditor/canvasRenderer');
const { createDefaultPostprocessState } = require('../src/fragmentEditor/postprocessParams');
const { getCanvasColors } = require('../src/themes/canvasTheme');

/** 两个音符中间留 2 拍空隙（0..2 与 4..6），锚点横跨空隙。 */
function setupGapScene() {
  state.setNotes([
    { id: 1, start: 0, duration: 2, pitch: 60, lyric: 'la' },
    { id: 2, start: 4, duration: 2, pitch: 64, lyric: 'la' },
  ]);
  state.setPitchCurve({
    enabled: true,
    anchorPoints: [
      { time: 0.5, pitch: 62, strength: 100, smoothness: 0 },
      { time: 5.5, pitch: 66, strength: 100, smoothness: 0 },
    ],
    brushSegments: [],
  });
  state.invalidatePitchCurveCache();
}

/** 给 recording ctx 补 strokeStyle / lineWidth 记录（setup.js 只记方法调用）。 */
function instrumentCtx() {
  const ctx = cr.ctx;
  if (ctx.__styleInstrumented) return;
  ctx.__styleInstrumented = true;
  let style = null, lineW = null;
  Object.defineProperty(ctx, 'strokeStyle', {
    configurable: true,
    get() { return style; },
    set(v) { style = v; ctx.__calls.push({ op: 'strokeStyle', args: [v] }); },
  });
  Object.defineProperty(ctx, 'lineWidth', {
    configurable: true,
    get() { return lineW; },
    set(v) { lineW = v; ctx.__calls.push({ op: 'lineWidth', args: [v] }); },
  });
}

/** 按当前 strokeStyle 收集各子路径的折线点（beginPath/moveTo 分段）。 */
function polylinesByStyle(style) {
  const out = [];
  let cur = null, curStyle = null;
  for (const c of cr.ctx.__calls) {
    if (c.op === 'strokeStyle') { curStyle = c.args[0]; continue; }
    if (c.op === 'beginPath') { cur = null; continue; }
    if (c.op === 'moveTo') {
      if (curStyle === style) { cur = [c.args]; out.push(cur); } else cur = null;
      continue;
    }
    if (c.op === 'lineTo' && cur) cur.push(c.args);
  }
  return out;
}

describe('实际 F0 叠画 — getActualF0Overlay 缓存', () => {
  beforeEach(() => {
    state.setNotes([]);
    state.setPitchCurve({ enabled: true, anchorPoints: [], brushSegments: [] });
    state.setCurrentProject({ bpm: 120, timeSignature: [4, 4] });
    state.setCurrentFragment({ id: 1, duration: 8 });
    state.setPostprocess(createDefaultPostprocessState());
    state.setZoomX(1);
    state.setScrollX(0);
    state.setScrollY(0);
    cr.invalidateNoteAnalysisCache();
    cr.invalidatePitchResolver();
    state.invalidatePitchCurveCache();
    cr.setActualF0DiffThreshold(0);
  });

  it('midi = 统一入口 Hz → 半音；音符外 = 0；重复调用命中缓存', () => {
    setupGapScene();
    const ov = cr.getActualF0Overlay();
    expect(cr.getActualF0Overlay()).to.equal(ov); // 同引用 = 缓存命中
    const hz = cr.buildPitchCurveF0Data();
    expect(hz).to.not.equal(null);
    expect(ov.midi.length).to.equal(hz.length);
    for (let i = 0; i < hz.length; i++) {
      if (hz[i] > 0) expect(ov.midi[i]).to.be.closeTo(69 + 12 * Math.log2(hz[i] / 440), 1e-4);
      else expect(ov.midi[i]).to.equal(0);
    }
    // 空隙（2..4 拍）内全 0
    const i2 = Math.ceil(2 / ov.beatPerFrame), i4 = Math.floor(4 / ov.beatPerFrame);
    for (let i = i2; i < i4; i++) expect(ov.midi[i]).to.equal(0);
    expect(ov.beatPerFrame).to.be.closeTo((480 / 24000) / (60 / 120), 1e-12);
  });

  it('缓存键：曲线 / 音符 / 后处理 / bpm 任一变化都失效', () => {
    setupGapScene();
    const a = cr.getActualF0Overlay();
    state.invalidatePitchCurveCache(); // pitchCurveVersion++
    const b = cr.getActualF0Overlay();
    expect(b).to.not.equal(a);
    state.setNotes([{ id: 1, start: 0, duration: 6, pitch: 60, lyric: 'la' }]);
    const c = cr.getActualF0Overlay();
    expect(c).to.not.equal(b);
    state.setPostprocess(createDefaultPostprocessState()); // timbreVersion++
    const d = cr.getActualF0Overlay();
    expect(d).to.not.equal(c);
    state.setCurrentProject({ bpm: 140, timeSignature: [4, 4] });
    const e = cr.getActualF0Overlay();
    expect(e).to.not.equal(d);
  });

  it('无曲线内容（score / 空手动 + auto 关）：midi = null', () => {
    state.setNotes([{ id: 1, start: 0, duration: 4, pitch: 60, lyric: 'la' }]);
    const ov = cr.getActualF0Overlay();
    expect(ov.midi).to.equal(null);
  });
});

describe('实际 F0 叠画 — 渲染', () => {
  let savedBody = '';
  before(() => {
    // 模块级 body 改写会被后加载的测试文件覆盖（谁最后加载谁留下），
    // 且 cr.canvas 可能已被替换出文档。与 zzPostprocessLane 相同：在
    // before() 里重建最小 canvas DOM 并把 cr.canvas 换回文档。
    savedBody = document.body.innerHTML;
    document.body.innerHTML =
      '<canvas id="piano-roll"></canvas><canvas id="piano-keys"></canvas>';
    const live = document.getElementById('piano-roll');
    if (live && live !== cr.canvas) live.replaceWith(cr.canvas);
    // jsdom 不做布局：给人造容器尺寸，render 才有可见窗
    const parent = cr.canvas.parentElement;
    Object.defineProperty(parent, 'clientWidth', { value: 900, configurable: true });
    Object.defineProperty(parent, 'clientHeight', { value: 600, configurable: true });
    cr.invalidateLayoutCache();
    instrumentCtx();
    installSyncRaf();
  });

  after(() => {
    restoreRaf();
    document.body.innerHTML = savedBody;
    cr.invalidateLayoutCache();
  });

  beforeEach(() => {
    state.setNotes([]);
    state.setPitchCurve({ enabled: true, anchorPoints: [], brushSegments: [] });
    state.setCurrentProject({ bpm: 120, timeSignature: [4, 4] });
    state.setCurrentFragment({ id: 1, duration: 8 });
    state.setPostprocess(createDefaultPostprocessState());
    state.setZoomX(1);
    state.setScrollX(0);
    state.setScrollY(0);
    state.setCurrentParamMode('Pitch');
    cr.invalidateNoteAnalysisCache();
    cr.invalidatePitchResolver();
    cr.invalidateLayoutCache();
    cr.invalidateStaticCache();
    state.invalidatePitchCurveCache();
    cr.setActualF0DiffThreshold(0);
    setupGapScene();
    cr.ctx.__reset();
  });

  it('主曲线在音符空隙处断开，不把两侧连成直线', () => {
    cr.render();
    const c = getCanvasColors();
    const lines = polylinesByStyle(c.pitchLine);
    expect(lines.length).to.be.at.least(1);
    let sawBothSides = false;
    for (const line of lines) {
      let left = false, right = false;
      for (const [x] of line) {
        const t = cr.xToTime(x);
        if (t < 2) left = true;
        if (t > 4) right = true;
        // 任何一条线段都不许横跨空隙
      }
      if (left && right) sawBothSides = true;
      for (let i = 1; i < line.length; i++) {
        const t0 = cr.xToTime(line[i - 1][0]);
        const t1 = cr.xToTime(line[i][0]);
        expect(t0 < 2 && t1 > 4).to.equal(false);
        expect(t0 > 4 && t1 < 2).to.equal(false);
      }
    }
    expect(sawBothSides).to.equal(false); // 空隙两侧必须是不同子路径
  });

  it('叠画线：细（1px）半透明主题色，且只在音符内绘制', () => {
    cr.render();
    const c = getCanvasColors();
    expect(c.pitchActualF0).to.be.a('string');
    const styleCalls = cr.ctx.__ops('strokeStyle').filter((x) => x.args[0] === c.pitchActualF0);
    expect(styleCalls.length).to.be.at.least(1);
    // 设置叠画样式后紧跟 lineWidth = 1
    const idx = cr.ctx.__calls.findIndex((x) => x.op === 'strokeStyle' && x.args[0] === c.pitchActualF0);
    const lw = cr.ctx.__calls.slice(idx, idx + 4).find((x) => x.op === 'lineWidth');
    expect(lw.args[0]).to.equal(1);
    const lines = polylinesByStyle(c.pitchActualF0);
    expect(lines.length).to.be.at.least(2); // 空隙断成至少两段
    for (const line of lines) {
      for (const [x] of line) {
        const t = cr.xToTime(x);
        expect(t > 2.001 && t < 3.999).to.equal(false); // 空隙内部不画（边界帧属于音符）
      }
    }
  });

  it('差异阈值开关：阈值极大时叠画不画任何点，归零恢复', () => {
    cr.setActualF0DiffThreshold(1000);
    cr.ctx.__reset();
    cr.render();
    const c = getCanvasColors();
    expect(polylinesByStyle(c.pitchActualF0).length).to.equal(0);
    cr.setActualF0DiffThreshold(0);
    cr.ctx.__reset();
    cr.render();
    expect(polylinesByStyle(c.pitchActualF0).length).to.be.at.least(1);
  });
});