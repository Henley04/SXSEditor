/**
 * persistentCache.js — 推理层"跨进程重启"的小型 JSON 缓存工具。
 *
 * 用途：把一次性的探测/校验结果（dummy 推理校验、WinML EP 解析结果）
 * 落到 userData 里，下次启动直接复用，避免重复付出数十秒的模型/EP 探测成本。
 *
 * 设计约束：
 *   · 主进程与 svsWorker（worker_threads）都要能用 —— worker 里
 *     `require('electron')` 不可靠，因此目录优先取
 *     `globalThis.__SXS_USER_DATA_DIR__`（由 svsIpc 经 workerData 下发），
 *     其次才尝试 electron.app.getPath('userData')，都取不到就禁用缓存；
 *   · 写入走"临时文件 + rename"的原子替换，并对同一文件串行化；
 *   · 读取失败 / 损坏 / 版本不匹配一律回退到空状态，绝不抛给调用方 ——
 *     缓存只是加速手段，不能成为新的故障源。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WRITE_DEBOUNCE_MS = 400;

/** userData 目录。worker 场景依赖 svsIpc 下发的全局快照。 */
function resolveUserDataDir() {
  const injected = globalThis.__SXS_USER_DATA_DIR__;
  if (typeof injected === 'string' && injected) return injected;
  try {
    const electron = require('electron');
    const app = electron && electron.app;
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (_) { /* 非 Electron 环境（单测 / CLI worker） */ }
  return null;
}

/**
 * 创建一个"一个文件一份 JSON 状态"的缓存实例。
 *
 * @param {string} fileName userData 下的文件名
 * @param {{format?:number, merge?:function}} [options]
 *   format 用于整体失效（结构变更时递增）；
 *   merge(diskData, localData) 在落盘前把磁盘上其它进程写入的条目合并进来，
 *   避免主进程与 svsWorker 同时校验时后写的一方覆盖前者的记录。
 */
function createJsonFileCache(fileName, options = {}) {
  const format = Number(options.format) || 1;
  const mergeFn = typeof options.merge === 'function' ? options.merge : null;
  let dirOverride = null;
  let state = null;        // { format, data: object }
  let loadedForKey = null; // `${dir}`，用于目录变更后强制重读
  let dirty = false;
  let timer = null;
  let writeSeq = 0;
  let writeChain = Promise.resolve();

  function getDir() {
    return dirOverride || resolveUserDataDir();
  }

  function getFilePath() {
    const dir = getDir();
    return dir ? path.join(dir, fileName) : null;
  }

  function configureDir(dir) {
    if (typeof dir !== 'string' || !dir) return;
    if (dirOverride === dir) return;
    dirOverride = dir;
    state = null;
    loadedForKey = null;
  }

  /** 取消显式目录，回到"自动解析 userData"（单测隔离用）。 */
  function clearDirOverride() {
    dirOverride = null;
    state = null;
    loadedForKey = null;
  }

  function emptyState() {
    return { format, data: {} };
  }

  function load() {
    const dir = getDir();
    if (!dir) return emptyState();
    if (loadedForKey === dir && state) return state;
    loadedForKey = dir;
    state = emptyState();
    try {
      const file = getFilePath();
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.format === format && parsed.data && typeof parsed.data === 'object') {
        state = { format, data: parsed.data };
      }
    } catch (_) {
      // 文件不存在 / 损坏 / 旧格式 —— 用空状态覆盖是一次正常升级
    }
    return state;
  }

  function scheduleWrite() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, WRITE_DEBOUNCE_MS);
    // 缓存写入不能阻止进程退出（CLI / 测试进程）
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /**
   * 读取（懒加载）后原地修改 data。
   * mutator 返回 false 表示"没有变化"，不会触发落盘。
   */
  function update(mutator) {
    const s = load();
    const changed = mutator(s.data);
    if (changed !== false) {
      dirty = true;
      scheduleWrite();
    }
    return changed;
  }

  async function flush() {
    if (!dirty) return false;
    const dir = getDir();
    const file = getFilePath();
    if (!dir || !file || !state) return false;
    dirty = false;
    // 落盘前合并磁盘上的新条目（另一个进程可能刚写过），本地条目优先。
    if (mergeFn) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && parsed.format === format && parsed.data && typeof parsed.data === 'object') {
          state.data = mergeFn(parsed.data, state.data);
        }
      } catch (_) { /* 文件不存在 / 损坏：直接用本地状态覆盖 */ }
    }
    const payload = JSON.stringify({ format, data: state.data });
    // 序号在"捕获 payload"时就分配，而不是在异步回调里：否则 flushSync 先落盘、
    // 异步回调后才拿到更大的序号，会把更新的数据覆盖回旧快照。
    writeSeq += 1;
    const seq = writeSeq;
    writeChain = writeChain.then(async () => {
      let tmp = null;
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        tmp = `${file}.${process.pid}.${seq}.tmp`;
        await fs.promises.writeFile(tmp, payload, 'utf8');
        // 期间有更新的同步写（flushSync）落地：本次 payload 已过期，放弃 rename。
        if (seq !== writeSeq) {
          try { await fs.promises.unlink(tmp); } catch (_e) { /* 已被清理 */ }
          return;
        }
        await fs.promises.rename(tmp, file);
      } catch (_) {
        if (tmp) {
          try { await fs.promises.unlink(tmp); } catch (_e) { /* 临时文件可能没建成 */ }
        }
      }
    });
    return writeChain;
  }

  /**
   * 同步落盘，供 before-quit 这类无法等待 Promise 的退出路径使用。
   *
   * 写入默认有 400ms debounce 且 timer 调了 unref()，如果"校验完就退出"
   * （CLI / 测试 / 用户快速关闭窗口），这次结果会直接丢掉。退出时同步写一次，
   * 保证下次启动能命中。与异步 flush() 共用状态，重复调用是幂等的。
   *
   * @returns {boolean} 是否真的写了文件
   */
  function flushSync() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return false;
    const dir = getDir();
    const file = getFilePath();
    if (!dir || !file || !state) return false;
    dirty = false;
    if (mergeFn) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && parsed.format === format && parsed.data && typeof parsed.data === 'object') {
          state.data = mergeFn(parsed.data, state.data);
        }
      } catch (_) { /* 文件不存在 / 损坏：直接用本地状态覆盖 */ }
    }
    const payload = JSON.stringify({ format, data: state.data });
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeSeq += 1;
      const tmp = `${file}.${process.pid}.${writeSeq}.sync.tmp`;
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 清空内存与磁盘缓存（用户手动重建 / 测试用）。 */
  async function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    dirty = false;
    state = emptyState();
    loadedForKey = getDir();
    const file = getFilePath();
    if (!file) return;
    try { await fs.promises.unlink(file); } catch (_) { /* 不存在即已清空 */ }
  }

  /** 仅重置内存状态，供单测在不同用例间隔离。 */
  function resetMemory() {
    state = null;
    loadedForKey = null;
    dirty = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    fileName,
    getDir,
    getFilePath,
    configureDir,
    clearDirOverride,
    load,
    update,
    flush,
    flushSync,
    clear,
    resetMemory,
  };
}

module.exports = {
  resolveUserDataDir,
  createJsonFileCache,
};
