require('@babel/register')({
  presets: ['@babel/preset-env'],
  ignore: [/node_modules/],
});

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost',
});
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;
Object.defineProperty(global, 'navigator', {
  value: dom.window.navigator,
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// 模拟 canvas getContext
//
// 测试有效性：旧版本把所有绘图方法一律 stub 成 no-op，并且 `measureText` 恒返回
// width: 0。结果是 src/fragmentEditor/canvasRenderer.js（2500 行）与
// src/renderer/timelineRenderer.js（996 行）实际上一个像素都没被验证过 —— 测试
// 只能证明"渲染函数不抛异常"，画错位置、画漏音符、坐标算错全都测不出来。
//
// 现在改成"记录型"上下文：
//   · 每次绘图调用都记进 ctx.__calls（[{ op, args }]），测试可以断言
//     "画了多少个音符矩形""歌词文本画在哪个 x 上"；
//   · measureText 返回按字符数估算的宽度（不再恒为 0），依赖文本宽度的换行/
//     截断逻辑才有被覆盖的可能；
//   · 仍然不抛异常 —— 任何渲染代码都能在 jsdom 里跑完。
// ---------------------------------------------------------------------------
const CANVAS_NOOP_OPS = [
  'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo',
  'quadraticCurveTo', 'bezierCurveTo', 'arc', 'arcTo', 'ellipse', 'rect',
  'roundRect', 'fill', 'stroke', 'clip', 'fillRect', 'strokeRect', 'clearRect',
  'fillText', 'strokeText', 'drawImage', 'putImageData', 'setTransform',
  'resetTransform', 'transform', 'translate', 'scale', 'rotate', 'setLineDash',
];

function createRecordingContext(canvas) {
  const calls = [];
  const ctx = {
    canvas: canvas || null,
    // 记录型断言入口
    __calls: calls,
    /** 取某种操作的调用记录 */
    __ops(op) { return calls.filter((c) => c.op === op); },
    /** 清空记录（每个用例开头调用，避免互相污染） */
    __reset() { calls.length = 0; },
  };
  for (const op of CANVAS_NOOP_OPS) {
    ctx[op] = function (...args) { calls.push({ op, args }); };
  }
  ctx.getLineDash = function () { return []; };
  ctx.createLinearGradient = function () {
    return { addColorStop() {} };
  };
  ctx.createRadialGradient = function () {
    return { addColorStop() {} };
  };
  ctx.createPattern = function () { return null; };
  ctx.getImageData = function (x, y, w, h) {
    return { data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4), width: w, height: h };
  };
  ctx.createImageData = function (w, h) {
    return { data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4), width: w, height: h };
  };
  // 估算文本宽度：拉丁字符约 0.5em，CJK 约 1em。恒返回 0 会让所有"按宽度换行/
  // 裁剪"的分支永远走不到，等于那部分逻辑没有测试。
  ctx.measureText = function (text) {
    const s = String(text == null ? '' : text);
    let units = 0;
    for (const ch of s) units += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.5;
    const size = Number(ctx.font && ctx.font.match(/(\d+(?:\.\d+)?)px/)?.[1]) || 13;
    return { width: units * size, actualBoundingBoxAscent: size, actualBoundingBoxDescent: size * 0.2 };
  };
  return ctx;
}

const _canvasContexts = new WeakMap();
HTMLCanvasElement.prototype.getContext = function () {
  if (!_canvasContexts.has(this)) {
    _canvasContexts.set(this, createRecordingContext(this));
  }
  return _canvasContexts.get(this);
};
// 供测试直接取用
global.__canvasContextOf = function (canvas) {
  return _canvasContexts.get(canvas) || null;
};

const sinon = require('sinon');

// CustomEvent 必须用 jsdom realm 的实现：document.dispatchEvent 按 jsdom 的
// 内部品牌校验收事件，Node 22+ 自带的全局 CustomEvent（另一 realm）会被拒收
// （"parameter 1 is not of type 'Event'"），setLocale / themeManager 的
// 事件派发都会挂。不能再用 `typeof global.CustomEvent === 'undefined'` 判断
// —— 新版 Node 早已自带 CustomEvent，那个 polyfill 条件永远不成立。
global.CustomEvent = dom.window.CustomEvent
  || class CustomEvent extends dom.window.Event {
    constructor(type, options = {}) {
      super(type, options);
      this.detail = options.detail || null;
    }
  };

// Register SVGElement global for JSDOM
if (typeof global.SVGElement === 'undefined') {
  global.SVGElement = dom.window.SVGElement;
}

// Mocha root hook 插件，提供 sinon sandbox 自动清理
let _sinonSandbox;
exports.mochaHooks = {
  beforeEach() {
    _sinonSandbox = sinon.createSandbox();
  },
  afterEach() {
    if (_sinonSandbox) {
      _sinonSandbox.restore();
      _sinonSandbox = null;
    }
  },
};
