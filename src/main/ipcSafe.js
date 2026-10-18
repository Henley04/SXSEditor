// 跨 IPC 边界的错误只应带出"能看懂但不能用来探查本机"的信息。
// Electron 序列化 handler 抛出的 Error 时只保留 message（见
// electron/electron#24427），但本仓库大量 message 天然含绝对路径
// （ENOENT: ... open '/home/<user>/...'）、模型路径、驱动/算子诊断，
// 因此这里统一做一次脱敏：绝对路径、UNC 路径、换行（会把多行堆栈带出去）
// 全部替换掉，超长部分截断。

// electron 只在函数内部按需取，不在模块顶层解构。
//
// 原因：`ipcSafe` 会被所有 IPC 模块间接依赖，而测试（test/singerMarketIpc.timeout.test.js）
// 为了拿到"真正注册上去的 handler"，会在换掉 electron stub 后 `delete require.cache`
// 重新 require 目标模块。若这里在顶层 `const { ipcMain } = require('electron')`，
// ipcSafe 早在第一次加载时就把旧 stub 的 ipcMain 闭包住了 —— 重新 require 不会
// 重新执行本模块，于是 safeHandle 把 handler 注册到**旧 stub**，测试的捕获 stub
// 永远收不到，`handlers['singer-market:list']` 就是 undefined。
// 惰性 require 让 ipcMain 在每次调用时解析，与被测模块的加载时机保持一致。
// 生产环境里 require('electron') 命中模块缓存，返回同一个单例，行为不变。
const MAX_ERROR_MESSAGE_LENGTH = 500;
const WINDOWS_PATH_RE = /[A-Za-z]:[\\/][^\s"'<>|]+/g;
const UNC_PATH_RE = /\\\\[^\s"'<>|]+/g;
// POSIX 绝对路径：至少两级（"/home/u/x"、"/opt/app/x" 一定命中）。
// 前缀限定为行首或标点/空白，避免把 "a/b" 这类相对片段误伤，同时能覆盖
// 被引号包裹的路径（open '/home/u/x'）。
const POSIX_PATH_RE = /(^|[\s'"(=:])(\/[^\s"'<>|]+(?:\/[^\s"'<>|]+)+)/g;

function describeError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message.length > 0) return err.message;
  return String(err);
}

function sanitizeErrorMessage(message) {
  return String(message)
    // 换行/回车：去掉，防止把多行堆栈或日志片段整段带过边界
    .replace(/\r?\n/g, ' ')
    .replace(WINDOWS_PATH_RE, '<path>')
    .replace(UNC_PATH_RE, '<path>')
    .replace(POSIX_PATH_RE, '$1<path>')
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * Register an IPC handler that logs the real failure in the main process but
 * only ever rejects with a sanitized message.
 *
 * The return contract is unchanged: the handler still rejects (preload call
 * sites that rely on `ipcRenderer.invoke(...)` rejecting, or on
 * `result.error`, keep working). Only `err.message` is rewritten; the full
 * detail stays in the main-process log (console.error is mirrored to the
 * per-session log file by main/crashReporter).
 */
function safeHandle(channel, listener) {
  // 惰性取 ipcMain（见文件头注释）：不在模块顶层解构。
  const { ipcMain } = require('electron');
  return ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await listener(event, ...args);
    } catch (err) {
      const detail = describeError(err);
      console.error(`[IPC] ${channel} failed:`, detail);
      const safeError = new Error(sanitizeErrorMessage(detail));
      // 保留 err.code（ENOENT / EACCES 之类），渲染侧可据此分支，且不含路径。
      if (err && typeof err.code === 'string') safeError.code = err.code;
      throw safeError;
    }
  });
}

module.exports = {
  safeHandle,
  sanitizeErrorMessage,
};
