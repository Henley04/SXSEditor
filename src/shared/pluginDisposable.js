'use strict';
/**
 * 可处置性原语（CommonJS）—— 全部插件注册的回收基础。
 *
 * 设计约束：
 *   · 必须是 CJS：插件 runtime 是**裸拷贝**的，按路径 require，不经过 webpack
 *     的 ESM 互操作（同 pluginPermissions.js 的理由）。
 *   · 逆序释放：后注册的先撤销，符合"依赖者先死"的直觉。
 *   · 幂等：重复 dispose 不报错、不重复执行 —— 卸载路径上会被调用两次是常态。
 *   · dispose 之后再 add 立即释放：防止异步回调在卸载后偷偷注册回来。
 *
 * 为什么不用 EventEmitter：宿主需要知道"还有多少东西没收回"，而不是"谁订阅了"。
 * 计数与断言由 PluginLeakProbe 负责，这里只保证每个注册都有对应的回收函数。
 */

/** 包装一个回收函数；`from()` 让 null/undefined/函数都能安全入 store。 */
class Disposable {
  constructor(fn) {
    this._fn = typeof fn === 'function' ? fn : null;
    this._disposed = false;
  }

  get disposed() {
    return this._disposed;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const fn = this._fn;
    this._fn = null;
    if (!fn) return;
    try {
      fn();
    } catch (err) {
      // 回收失败不能中断整条卸载链，否则后面的注册项永远收不回来。
      console.warn('[plugin] dispose failed:', err && err.message ? err.message : err);
    }
  }

  /** 把任意形态转成 Disposable；已是的原样返回。 */
  static from(value) {
    if (value instanceof Disposable) return value;
    if (typeof value === 'function') return new Disposable(value);
    if (value && typeof value.dispose === 'function') return new Disposable(() => value.dispose());
    return new Disposable(null);
  }

  static get none() {
    return new Disposable(null);
  }
}

function toDisposable(fn) {
  return new Disposable(fn);
}

/**
 * 一组可处置对象，逆序释放。
 * 分 store 是为了让泄漏报告能说出"是哪一组没收回"（ipc / menu / renderer / runtime）。
 */
class DisposableStore {
  constructor(name = '') {
    this.name = name;
    this._items = [];
    this._disposed = false;
  }

  get size() {
    return this._items.length;
  }

  get disposed() {
    return this._disposed;
  }

  /** @returns {Disposable} 传进来的那个（便于链式书写） */
  add(item) {
    const d = Disposable.from(item);
    if (this._disposed) {
      // 卸载之后才注册的东西必须当场释放，否则就是泄漏。
      d.dispose();
      return d;
    }
    this._items.push(d);
    return d;
  }

  /** 允许主动回收单个注册项（例如插件自己 unregister 一个命令）。 */
  delete(item) {
    const i = this._items.indexOf(item);
    if (i < 0) return false;
    this._items.splice(i, 1);
    item.dispose();
    return true;
  }

  clear() {
    const items = this._items.splice(0).reverse();
    for (const d of items) d.dispose();
  }

  dispose() {
    if (this._disposed) return;
    this.disposeInternal();
  }

  /** 供外层在标记 disposed 前后精确控制顺序。 */
  disposeInternal() {
    this.clear();
    this._disposed = true;
  }
}

/**
 * 每个插件一个 AbortBucket：DOM 监听、fetch、rAF 全部挂在同一个 signal 上，
 * 卸载时 abort 一次即可全收。比逐个 removeEventListener 可靠得多。
 */
class AbortBucket {
  constructor() {
    this.controller = new AbortController();
  }

  get signal() {
    return this.controller.signal;
  }

  get aborted() {
    return this.controller.signal.aborted;
  }

  /** target.addEventListener(type, fn, {...opts, signal}) 的糖。 */
  listen(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return Disposable.none;
    if (this.controller.signal.aborted) return Disposable.none;
    const options = Object.assign({}, opts, { signal: this.controller.signal });
    target.addEventListener(type, fn, options);
    return new Disposable(() => {
      try {
        target.removeEventListener(type, fn, options);
      } catch (_) { /* 目标已销毁 */ }
    });
  }

  /** 包一层 rAF 循环：回调返回 false 即停止。 */
  loop(fn) {
    let raf = null;
    const tick = () => {
      if (this.controller.signal.aborted) return;
      let again = true;
      try {
        again = fn() !== false;
      } catch (err) {
        console.warn('[plugin] rAF callback failed:', err && err.message);
        again = false;
      }
      if (again) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return new Disposable(() => {
      if (raf != null) cancelAnimationFrame(raf);
      raf = null;
    });
  }

  dispose() {
    if (this.controller.signal.aborted) return;
    try {
      this.controller.abort();
    } catch (_) { /* ignore */ }
  }
}

module.exports = { Disposable, toDisposable, DisposableStore, AbortBucket };
