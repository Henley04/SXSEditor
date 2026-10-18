/**
 * 分片编辑器共享的撤销栈。
 *
 * 历史上 eventHandlers.js 与 uiControls.js 各自 `new HistoryManager()`，
 * Ctrl+Z 只走 eventHandlers 那个实例 —— 写进 uiControls 实例的命令
 * （音色预设、检查器滑块等）永远不可达，撤销静默失效。
 * 现在所有 fragmentEditor 模块统一 import 这一个实例。
 */
import { HistoryManager } from '../editor/historyManager.js';

export const history = new HistoryManager();
