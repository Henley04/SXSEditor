/**
 * recentsIpc —— 「最近的工程」列表的 IPC 边界。
 *
 * 逻辑都在 recentsStore（可单测的纯 Node 模块），这里只做三件事：参数校验、
 * 调用、把结果包成渲染层能直接用的形状。
 *
 * 为什么要校验：这条通道写的是 userData 下的配置文件，任何渲染进程（包括被插件
 * iframe 影响过的上下文）都能调用它。不校验的话，一个非字符串或超长字符串就能把
 * 配置文件写成欢迎页再也读不明白的东西。这里只把它当"要显示的路径文本"看 ——
 * 真正的读盘仍然要走 loadProject 里的 authorizePath + 主进程路径白名单，
 * 列表本身不给任何文件系统能力。
 */
const path = require('node:path');
const { safeHandle } = require('./ipcSafe');
const { IPC_CHANNELS } = require('../shared/ipcChannels');
const {
  listRecents,
  recordRecent,
  removeRecent,
  clearRecents,
} = require('./recentsStore');

/** 路径字符串上限：比 Windows MAX_PATH 宽一点，再长就不是正常路径了。 */
const MAX_PATH_LENGTH = 4096;

/**
 * 校验渲染层递来的路径。
 * @returns {string|null} 合格的路径；不合格返回 null
 */
function validPath(filePath) {
  if (typeof filePath !== 'string') return null;
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.length > MAX_PATH_LENGTH) return null;
  // 控制字符（换行、\0）会污染配置文件与列表文本，真实路径里不会出现
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  // 只记绝对路径：相对路径取决于进程的工作目录，下次启动解析出来的是另一个文件
  if (!path.isAbsolute(trimmed)) return null;
  return trimmed;
}

function registerRecentsIpc() {
  safeHandle(IPC_CHANNELS.RECENTS_LIST, async () => ({ success: true, items: listRecents() }));

  safeHandle(IPC_CHANNELS.RECENTS_RECORD, async (_event, filePath) => {
    const target = validPath(filePath);
    if (!target) return { success: false, error: 'Invalid project path' };
    return recordRecent(target);
  });

  safeHandle(IPC_CHANNELS.RECENTS_REMOVE, async (_event, filePath) => {
    const target = validPath(filePath);
    if (!target) return { success: false, error: 'Invalid project path' };
    return removeRecent(target);
  });

  safeHandle(IPC_CHANNELS.RECENTS_CLEAR, async () => clearRecents());
}

module.exports = { registerRecentsIpc, validPath };
