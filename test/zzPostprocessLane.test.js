/**
 * 音色 / 后处理 lane 的 UI 接线测试。
 *
 * 目的：这一层最容易出的错不是算法，而是"DOM 里没有对应节点 / i18n 缺键 /
 * 面板和 state 没接上"——这类缺陷单测纯算法时完全测不出来，只有真的把
 * fragmentEditor.html 装进 jsdom 再驱动一遍才能暴露。
 *
 * 文件名刻意排在文件列表最后：本文件会把整页 DOM 换成分片编辑器，避免影响
 * 其它依赖最小 canvas DOM 的用例。
 */
const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'fragmentEditor.html'), 'utf8');
const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
const PAGE_HTML = bodyMatch ? bodyMatch[1] : '';

// jsdom（即便 pretendToBeVisual）不保证把 rAF 挂到全局；canvasRenderer.render()
// 直接调用 requestAnimationFrame。这里用**同步**替身而不是 setTimeout：
// 异步回调会飘到后续测试（DOM 已被别的用例换掉）才执行，导致无关失败。
if (typeof global.requestAnimationFrame !== 'function') {
  global.requestAnimationFrame = (cb) => { cb(0); return 1; };
  global.cancelAnimationFrame = () => {};
}

// canvasRenderer 在模块加载时就调用 document.getElementById('piano-roll').getContext()，
// 因此 require 之前必须有最小 canvas DOM；完整页面在 before() 里安装。
document.body.innerHTML = '<canvas id="piano-roll"></canvas><canvas id="piano-keys"></canvas>';

const state = require('../src/fragmentEditor/state');
const uiControls = require('../src/fragmentEditor/uiControls');
const cr = require('../src/fragmentEditor/canvasRenderer');
const { POSTPROCESS_PARAM_LIST, POSTPROCESS_PARAMS } = require('../src/fragmentEditor/postprocessParams');
const {
  getTimbreValueAt,
  buildF0ParamArrays,
  buildMelPostprocessPayload,
  hasF0PostprocessEffect,
  hasSpectralPostprocessEffect,
  serializePostprocessForSignature,
} = require('../src/fragmentEditor/postprocessAccess');
const { t } = require('../src/i18n/index.js');

describe('分片编辑器 音色 / 后处理 lane 接线', () => {
  let savedBody = '';
  before(() => {
    // 不能放在模块顶层：其它测试文件也在模块加载时改写 body，谁最后加载谁留下，
    // 模块顶层设置会被后续文件覆盖。放到 before() 才能保证本组用例看到完整页面。
    savedBody = document.body.innerHTML;
    document.body.innerHTML = PAGE_HTML;
    uiControls.setupPostprocessUi();
  });

  after(() => {
    document.body.innerHTML = savedBody;
  });

  beforeEach(() => {
    state.setPostprocess(require('../src/fragmentEditor/postprocessParams').createDefaultPostprocessState());
    state.setActiveTimbreParam('f0Smooth');
    state.getSelectedTimbreAnchors().clear();
    uiControls.syncPostprocessUi();
  });

  it('每个参数都有一条独立曲线槽位', () => {
    const curves = state.getPostprocessCurves();
    for (const param of POSTPROCESS_PARAM_LIST) {
      expect(curves[param.id], `${param.id} 缺少曲线槽位`).to.be.an('object');
      expect(curves[param.id].keyframes).to.be.an('array');
    }
    expect(Object.keys(curves)).to.have.length(POSTPROCESS_PARAM_LIST.length);
  });

  it('音色 lane 的参数子标签按注册表生成（7 个参数 / 2 个分组）', () => {
    const chips = document.querySelectorAll('#param-subtabs .pp-chip');
    expect(chips).to.have.length(POSTPROCESS_PARAM_LIST.length);
    expect(document.querySelectorAll('#param-subtabs .pp-group-label')).to.have.length(2);
    for (const chip of chips) {
      // 文本必须是真翻译而不是键名（缺键时 t() 回退成 key 本身）
      expect(chip.textContent).to.not.match(/^fragment\./);
    }
  });

  it('检查器为每个参数生成滑块 + 读数', () => {
    const rows = document.querySelectorAll('#pp-inspector-rows .pp-row');
    expect(rows).to.have.length(POSTPROCESS_PARAM_LIST.length);
    for (const param of POSTPROCESS_PARAM_LIST) {
      const slider = document.querySelector(`.pp-slider[data-param="${param.id}"]`);
      expect(slider, `${param.id} 缺少滑块`).to.not.equal(null);
      expect(parseFloat(slider.min)).to.equal(param.min);
      expect(parseFloat(slider.max)).to.equal(param.max);
      const val = document.querySelector(`.pp-row-val[data-param="${param.id}"]`);
      expect(val.textContent).to.be.a('string').and.not.equal('');
    }
  });

  it('i18n 覆盖所有参数标签与说明（中英文都不缺键）', () => {
    for (const param of POSTPROCESS_PARAM_LIST) {
      expect(t(param.labelKey)).to.not.equal(param.labelKey);
      expect(t(param.descKey)).to.not.equal(param.descKey);
    }
    for (const key of ['fragment.ppGroupF0', 'fragment.ppGroupSpec', 'fragment.inspPostprocess',
      'fragment.anchorStrength', 'fragment.hudPitchAnchor', 'fragment.ppPreset',
      'fragment.kbdRightDragAnchor', 'fragment.shortcutTimbreEdit',
      // 悬浮提示卡 / 右键拖拽 HUD 用到的新增键
      'fragment.ppGroupF0Desc', 'fragment.ppGroupSpecDesc', 'fragment.ppTipRange',
      'fragment.ppTipDefault', 'fragment.ppTipAnchorHint', 'fragment.ppPresetDesc',
      'fragment.laneTimbreDesc', 'fragment.hudRightDragHint', 'fragment.abbrStrength',
      'fragment.abbrSmoothing', 'fragment.paramPanelToggle', 'fragment.shortcutSwitchTopMode',
      'fragment.shortcutSwitchLanes', 'fragment.kbdHover', 'fragment.shortcutTimbreHoverTip']) {
      expect(t(key), `${key} 缺翻译`).to.not.equal(key);
    }
  });

  it('每个参数（子标签 + 检查器行）都挂了悬浮提示', () => {
    for (const param of POSTPROCESS_PARAM_LIST) {
      const chip = document.querySelector(`.pp-chip[data-param="${param.id}"]`);
      const label = document.querySelector(`.pp-row-label[data-param="${param.id}"]`);
      const slider = document.querySelector(`.pp-slider[data-param="${param.id}"]`);
      // 不再用原生 title（延迟 ~1s 且不跟随主题），改为 .pp-tip 悬浮卡
      expect(chip.hasAttribute('title'), `${param.id} chip 仍在用原生 title`).to.equal(false);
      expect(label.hasAttribute('title'), `${param.id} 行标签仍在用原生 title`).to.equal(false);
      expect(chip.getAttribute('aria-describedby')).to.equal('pp-hover-tip');
      expect(label.getAttribute('aria-describedby')).to.equal('pp-hover-tip');
      expect(slider.getAttribute('aria-describedby')).to.equal('pp-hover-tip');
    }
  });

  it('悬浮提示内容含作用说明 + 取值范围/默认值', async () => {
    const chip = document.querySelector('.pp-chip[data-param="f0Median"]');
    chip.dispatchEvent(new window.MouseEvent('mouseenter'));
    // 提示卡有 120ms 防抖延迟
    await new Promise((resolve) => setTimeout(resolve, 200));

    const tip = document.getElementById('pp-hover-tip');
    expect(tip).to.not.equal(null);
    expect(tip.querySelector('.pp-tip-title').textContent).to.equal(t('fragment.ppF0Median'));
    expect(tip.querySelector('.pp-tip-meta').textContent).to.contain(t('fragment.ppTipRange'));
    expect(tip.querySelector('.pp-tip-meta').textContent).to.contain(t('fragment.ppTipDefault'));
    expect(tip.querySelector('.pp-tip-desc').textContent).to.contain(t('fragment.ppF0MedianDesc'));
  });

  it('语言切换后，动态生成的参数名跟着变（不再永远停在英文）', () => {
    // 回归：子标签/检查器行在 setupPostprocessUi() 里用 t() 现场生成，而它比
    // initI18n() 先跑，locale 还是默认的 'en'；applyLocale() 只刷静态节点，
    // 于是这些控件会一直是英文（整页中文里唯独音色参数名是英文）。
    const { setLocale } = require('../src/i18n/index.js');
    const chip = document.querySelector('.pp-chip[data-param="f0Median"]');
    const english = chip.textContent;
    try {
      setLocale('zh-CN');
      uiControls.refreshPostprocessLabels();
      expect(chip.textContent).to.equal(t('fragment.ppF0Median'));
      expect(chip.textContent).to.not.equal(english);
      expect(document.querySelector('.pp-row-label[data-param="f0Median"]').textContent)
        .to.equal(t('fragment.ppF0Median'));
      expect(document.querySelector('.pp-group-label[data-group="spec"]').textContent)
        .to.equal(t('fragment.ppGroupSpec'));
      expect(document.querySelector('.pp-row-group[data-group="f0"]').textContent)
        .to.equal(t('fragment.ppGroupF0'));
    } finally {
      setLocale('en');
      uiControls.refreshPostprocessLabels();
    }
  });

  it('右键按住锚点的 HUD 会画出操作提示行（左右调强度 · 上下调平滑）', () => {
    const ctx = cr.ctx;
    ctx.__reset();
    const hint = t('fragment.hudRightDragHint');
    state.setAnchorDragHud({
      x: 40, y: 40,
      title: 'X',
      strength: 80, smoothness: 20,
      strengthLabel: t('fragment.anchorStrength'),
      smoothnessLabel: t('fragment.smoothing'),
      hint,
    });
    try {
      cr._drawAnchorDragHud({ hudBg: '#fff', hudBorder: '#000', fgPrimary: '#000', fgMuted: '#666' }, 600, 400);
      const texts = ctx.__ops('fillText').map((call) => String(call.args[0]));
      // 提示行必须真的画出来：以前只有"数值"两行，用户按住不动看不出能调什么
      expect(texts.some((s) => s === hint), `HUD 未画出提示行：${JSON.stringify(texts)}`).to.equal(true);
      expect(texts.some((s) => s.includes(String(80)))).to.equal(true);
    } finally {
      state.setAnchorDragHud(null);
    }
  });

  it('切到音色 lane 时子标签显示，切走后隐藏', () => {
    state.setParamPanelCollapsed(false);
    state.setParamPanelMode('Timbre');
    uiControls.updateParamPanelState();
    expect(document.getElementById('param-subtabs').style.display).to.equal('flex');

    state.setParamPanelMode('VOL');
    uiControls.updateParamPanelState();
    expect(document.getElementById('param-subtabs').style.display).to.equal('none');
  });

  it('点击参数 chip 切换激活参数并同步高亮', () => {
    const chip = document.querySelector('.pp-chip[data-param="specSmoothT"]');
    chip.click();
    expect(state.getActiveTimbreParam()).to.equal('specSmoothT');
    expect(chip.classList.contains('active')).to.equal(true);
    expect(document.querySelector('.pp-chip[data-param="f0Smooth"]').classList.contains('active')).to.equal(false);
  });

  it('拖动滑块写入全局默认值，并把取值量化到步进', () => {
    const slider = document.querySelector('.pp-slider[data-param="specSmoothT"]');
    slider.value = '1.37';
    slider.dispatchEvent(new window.Event('input'));
    const def = state.getPostprocessDefaults().specSmoothT;
    // step 0.1 → 量化到 1.4
    expect(def).to.be.closeTo(1.4, 1e-9);
    expect(hasSpectralPostprocessEffect()).to.equal(true);
    const label = document.querySelector('.pp-row-val[data-param="specSmoothT"]');
    expect(label.textContent).to.contain('1.4');
  });

  it('选中锚点时滑块改为编辑锚点数值', () => {
    const anchors = state.getPostprocessCurves().f0Smooth.keyframes;
    anchors.push({ time: 2, value: 40, strength: 100, smoothness: 30 });
    state.invalidateTimbreCache();
    state.getSelectedTimbreAnchors().add(0);
    uiControls.syncPostprocessUi();

    const slider = document.querySelector('.pp-slider[data-param="f0Smooth"]');
    expect(parseFloat(slider.value)).to.equal(40);
    slider.value = '65';
    slider.dispatchEvent(new window.Event('input'));
    expect(anchors[0].value).to.equal(65);
    // 默认值不受影响
    expect(state.getPostprocessDefaults().f0Smooth).to.equal(0);
  });

  it('取值落在曲线锚点上时按曲线插值，离开曲线范围回落到默认值', () => {
    const anchors = state.getPostprocessCurves().f0Smooth.keyframes;
    anchors.push({ time: 0, value: 0, strength: 100, smoothness: 0 });
    anchors.push({ time: 4, value: 80, strength: 100, smoothness: 0 });
    state.invalidateTimbreCache();
    expect(getTimbreValueAt('f0Smooth', 2)).to.be.closeTo(40, 1e-6);
    expect(getTimbreValueAt('f0Smooth', 99)).to.be.closeTo(80, 1e-6);

    state.getPostprocessCurves().f0Smooth.keyframes = [];
    state.invalidateTimbreCache();
    state.getPostprocessDefaults().f0Smooth = 12;
    expect(getTimbreValueAt('f0Smooth', 2)).to.equal(12);
  });

  it('F0 参数采样：帧数与取值都对，未启用时返回 active=false', () => {
    const frames = 100;
    const idle = buildF0ParamArrays(frames, 120, 24000, 480);
    expect(idle.active).to.equal(false);
    expect(idle.smooth).to.have.length(frames);

    state.getPostprocessDefaults().f0Smooth = 50;
    state.getPostprocessDefaults().f0Median = 5;
    state.invalidateTimbreCache();
    expect(hasF0PostprocessEffect()).to.equal(true);
    const active = buildF0ParamArrays(frames, 120, 24000, 480);
    expect(active.active).to.equal(true);
    expect(active.smooth[0]).to.equal(50);
    expect(active.median[0]).to.equal(5);
  });

  it('频谱后处理载荷：帧数以第一个音符为基准，边界为该音符之后的音符起点', () => {
    const notes = [
      { id: 1, start: 2, duration: 2, pitch: 60, lyric: 'a' },
      { id: 2, start: 4, duration: 2, pitch: 62, lyric: 'b' },
    ];
    // 全部关闭 → null
    expect(buildMelPostprocessPayload(notes, 120, 24000, 480)).to.equal(null);

    state.getPostprocessDefaults().specSmoothT = 1.2;
    state.getPostprocessDefaults().specBlend = 50;
    state.invalidateTimbreCache();

    const payload = buildMelPostprocessPayload(notes, 120, 24000, 480);
    expect(payload).to.be.an('object');
    // 跨度 = 6 - 2 = 4 拍 = 2s = 100 帧（24k/480），+1 帧余量
    expect(payload.frames).to.be.closeTo(101, 1);
    expect(payload.sigmaT).to.have.length(payload.frames);
    expect(payload.blend[0]).to.equal(50);
    // 第二个音符起点相对第一个音符 = 2 拍 = 1s = 50 帧
    expect(Array.from(payload.boundaries)).to.deep.equal([50]);
    // 载荷必须携带时间锚点（多段/多 region/单音符 padding 的对齐依据）
    expect(payload.startBeat).to.equal(2);
    expect(payload.bpm).to.equal(120);
  });

  it('签名随曲线变化（改曲线必须触发重新合成）', () => {
    const before = serializePostprocessForSignature();
    state.getPostprocessCurves().specBlend.keyframes.push({ time: 1, value: 80, strength: 100, smoothness: 30 });
    state.invalidateTimbreCache();
    const after = serializePostprocessForSignature();
    expect(after).to.not.equal(before);
  });

  it('音高曲线锚点强度：100 时曲线经过锚点，0 时被拉向邻居连线', () => {    state.setPitchCurve({
      enabled: true,
      anchorPoints: [
        { time: 0, pitch: 60, strength: 100, smoothness: 0 },
        { time: 1, pitch: 72, strength: 100, smoothness: 0 },
        { time: 2, pitch: 60, strength: 100, smoothness: 0 },
      ],
      brushSegments: [],
    });
    state.invalidatePitchCurveCache();
    expect(cr.getPitchAtTime(1)).to.be.closeTo(72, 1e-6);

    state.getPitchCurve().anchorPoints[1].strength = 0;
    state.invalidatePitchCurveCache();
    expect(cr.getPitchAtTime(1)).to.be.closeTo(60, 1e-6);

    state.getPitchCurve().anchorPoints[1].strength = 50;
    state.invalidatePitchCurveCache();
    expect(cr.getPitchAtTime(1)).to.be.closeTo(66, 1e-6);
  });
});

describe('分片编辑器 音符→参数 lane 对齐虚线', () => {
  const { ctx } = cr;

  function resetCalls() {
    ctx.__calls.length = 0;
  }

  // 记录型 ctx：把 moveTo/lineTo 配对成线段
  function segments() {
    const out = [];
    let last = null;
    for (const call of ctx.__calls) {
      if (call.op === 'moveTo') last = call.args;
      else if (call.op === 'lineTo' && last) {
        out.push([last, call.args]);
        last = null;
      }
    }
    return out;
  }

  const color = { fgDisabled: '#5a5a72' };
  const NOTES = [
    { id: 1, start: 1, duration: 2, pitch: 60, lyric: 'a' },
    { id: 2, start: 3, duration: 2, pitch: 62, lyric: 'b' },
  ];

  beforeEach(() => {
    state.setZoomX(1);
    state.setScrollX(0);
    state.setScrollY(0);
    state.setNotes(NOTES.map((n) => ({ ...n })));
    resetCalls();
  });

  it('lane 内每个音符起点/终点各画一条竖虚线，同 x 只画一次', () => {
    cr._drawParamAlignmentGuides(color, NOTES, 500, 100, 180);
    // 剔除顶部小刻度（长度 3px），只留贯穿 lane 的虚线
    const laneSegs = segments().filter(([a, b]) => Math.abs(b[1] - a[1]) > 10);
    // 1 拍 = 80px：音符1 = 80/240，音符2 = 240/400，240 处共享 → 去重
    expect(laneSegs.map(([a]) => a[0])).to.deep.equal([80.5, 240.5, 400.5]);
    for (const [a, b] of laneSegs) {
      expect(a[1]).to.equal(101);
      expect(b[1]).to.equal(179);
      expect(a[0]).to.equal(b[0]);
    }
  });

  it('竖向虚线与音符边界像素对齐（+0.5 保证 1px 实线不模糊）', () => {
    cr._drawParamAlignmentGuides(color, NOTES, 500, 100, 180);
    const xs = segments().map(([a]) => a[0]);
    for (const x of xs) expect(x % 1).to.equal(0.5);
  });

  it('使用虚线而非实线', () => {
    cr._drawParamAlignmentGuides(color, NOTES, 500, 100, 180);
    const dashCalls = ctx.__calls.filter((c) => c.op === 'setLineDash');
    expect(dashCalls.some((c) => Array.isArray(c.args[0]) && c.args[0].length === 2)).to.equal(true);
  });

  it('视口外的音符不画线', () => {
    cr._drawParamAlignmentGuides(color, NOTES, 100, 100, 180);
    const laneSegs = segments().filter(([a, b]) => Math.abs(b[1] - a[1]) > 10);
    // 500px 视口里只有 80.5；100px 视口里 240/400 被裁掉
    expect(laneSegs.map(([a]) => a[0])).to.deep.equal([80.5]);
  });

  it('空音符列表不产生任何绘制', () => {
    cr._drawParamAlignmentGuides(color, [], 500, 100, 180);
    expect(ctx.__calls.length).to.equal(0);
  });

  it('钢琴卷帘区：每个音符从本体下沿拉两条线到 lane 顶部', () => {
    // 让 pitchToY 落在 areaTop 之上：pitch 60 → 24 + 67*16 = 1096，scrollY 500 → y≈614
    state.setScrollY(500);
    resetCalls();
    cr._drawPianoAlignmentGuides(color, NOTES, 500, 700);
    const segs = segments();
    // 两个音符 × 2 条边 = 4 条线（钢琴区不去重：不同音高起点相同也要各自连到本体）
    expect(segs).to.have.length(4);
    // 起点 y = 音符本体下沿：HEADER(24) + (127-pitch)*16 - scrollY(500) + NOTE_HEIGHT(16) + 2
    const expectY0 = (pitch) => 24 + (127 - pitch) * 16 - 500 + 16 + 2;
    for (let i = 0; i < segs.length; i++) {
      const [a, b] = segs[i];
      const pitch = i < 2 ? 60 : 62;
      expect(a[1]).to.equal(expectY0(pitch));
      expect(b[1]).to.equal(700);          // 终点是 lane 顶部
      expect(a[0]).to.equal(b[0]);
    }
    // x 顺序：音符1 起/终、音符2 起/终
    expect(segs.map(([a]) => a[0])).to.deep.equal([80.5, 240.5, 240.5, 400.5]);
  });

  it('音符整体落在 lane 下方时不画（避免负长度线段）', () => {
    state.setScrollY(0); // pitchToY 远大于 areaTop
    resetCalls();
    cr._drawPianoAlignmentGuides(color, NOTES, 500, 300);
    expect(segments().length).to.equal(0);
  });
});

describe('音色参数量化与共享撤销栈', () => {
  const { quantizeParamValue } = require('../src/fragmentEditor/postprocessParams');
  const { history } = require('../src/fragmentEditor/history.js');

  // 上一个 describe 的 after() 已把 body 换回最小 DOM；这里重建整页并重新
  // 装配动态节点（preset 下拉 / 检查器行），测试只依赖 DOM 与 state，不依赖绘制。
  before(() => {
    document.body.innerHTML = PAGE_HTML;
    uiControls.setupPostprocessUi();
  });
  after(() => {
    document.body.innerHTML = '<canvas id="piano-roll"></canvas><canvas id="piano-keys"></canvas>';
  });

  beforeEach(() => {
    state.setPostprocess(require('../src/fragmentEditor/postprocessParams').createDefaultPostprocessState());
    uiControls.syncPostprocessUi();
  });

  it('中值窗口量化为奇数（2→3、4→5、8→9、0/1→0）', () => {
    expect(quantizeParamValue('f0Median', 0)).to.equal(0);
    expect(quantizeParamValue('f0Median', 1)).to.equal(0);
    expect(quantizeParamValue('f0Median', 2)).to.equal(3);
    expect(quantizeParamValue('f0Median', 4)).to.equal(5);
    expect(quantizeParamValue('f0Median', 8)).to.equal(9);
    expect(quantizeParamValue('f0Median', 9)).to.equal(9);
  });

  it('预设变更进共享撤销栈：Ctrl+Z 对应的 history.undo() 能回退', () => {
    const before = state.getPostprocessDefaults().specSmoothT;
    const select = document.getElementById('pp-preset-select');
    select.value = 'standard';
    select.dispatchEvent(new window.Event('change'));
    expect(state.getPostprocessDefaults().specSmoothT).to.not.equal(before);
    expect(history.canUndo()).to.equal(true);
    history.undo();
    expect(state.getPostprocessDefaults().specSmoothT).to.equal(before);
  });

  it('检查器滑块 change 提交一次撤销（input 只预览）', () => {
    const slider = document.querySelector('.pp-slider[data-param="f0Smooth"]');
    slider.value = '30';
    slider.dispatchEvent(new window.Event('input'));
    expect(state.getPostprocessDefaults().f0Smooth).to.equal(30);
    const entriesBefore = history.undoStack.length;
    slider.dispatchEvent(new window.Event('change'));
    expect(history.undoStack.length).to.equal(entriesBefore + 1);
    history.undo();
    expect(state.getPostprocessDefaults().f0Smooth).to.equal(0);
  });
});
