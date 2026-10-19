/**
 * onnxruntime-node 的惰性访问入口。
 *
 * 背景（冷启动审查）：onnxruntime-node 是 native addon，require 一次要加载
 * ORT 及其 DML / WinML 依赖 DLL，实测数百毫秒。此前全仓有 10 处顶层
 * `const ort = require('onnxruntime-node')`，只要启动路径上碰到**任意一个**，
 * 整个 addon 就会在主窗口 reveal 之前被拉起 —— 这是冷启动最大的一块固定成本，
 * 而首次合成根本还没发生。
 *
 * 做法：所有使用方改为持有本模块导出的 `lazyOrt`（代理对象），真正的
 * require 推迟到第一次**实际访问属性**时（即真正建 Tensor / Session 的那一刻）。
 *
 * 为什么用 Proxy 而不是把每个 `ort.X` 改成 `getOrt().X`：
 *   · 改动面从"每个使用点"缩小到"每个文件一行 import"，`new ort.Tensor(...)`、
 *     `ort.InferenceSession.create(...)` 等既有写法完全不用动；
 *   · 属性首次访问后写入缓存 target，之后是普通属性读取，无代理开销。
 *
 * float16 patch 的耦合：onnxruntime-node 首次加载后必须打 float16 类型映射补丁
 * （Node 24+ / Electron 42+ 原生 Float16Array 与 ORT 的 C++ binding 不兼容）。
 * 原实现是 `require('./pipeline/float16Patch')` 的自执行副作用，一旦惰性化就会
 * 漏打补丁，所以在这里显式串起来，并保证幂等。
 */

let _ort = null;

/**
 * 取到真实的 onnxruntime-node 模块（首次调用时加载并打补丁）。
 * @returns {any}
 */
function getOrt() {
  if (_ort) return _ort;
  // eslint-disable-next-line global-require
  _ort = require('onnxruntime-node');
  try {
    // 幂等：patch 内部有全局标记，重复调用无副作用
    const patch = require('./pipeline/float16Patch.js');
    if (typeof patch.applyFloat16Patch === 'function') patch.applyFloat16Patch(_ort);
  } catch (_) {
    // 补丁失败不能阻断推理（原实现也是只 warn 不抛）
  }
  return _ort;
}

/** 是否已加载（供诊断 / 测试查询，不触发加载）。 */
function isOrtLoaded() {
  return _ort !== null;
}

/**
 * 惰性代理。属性首次读取时加载真实模块并缓存到 target 上。
 * 支持 `new lazyOrt.Tensor(...)`：get trap 返回的是类本身。
 */
const lazyOrt = new Proxy(Object.create(null), {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'symbol') return undefined; // Symbol.toPrimitive / inspect 等
    const ort = getOrt();
    const value = ort[prop];
    // 只缓存数据属性与类/函数引用；原型链上的方法（如 Tensor.prototype.*）
    // 由拿到的类自己携带，不需要单独缓存。
    target[prop] = value;
    return value;
  },
  has(_target, prop) {
    return prop in getOrt();
  },
});

module.exports = { getOrt, lazyOrt, isOrtLoaded };
