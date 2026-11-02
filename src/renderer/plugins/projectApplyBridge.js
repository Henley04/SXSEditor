/**
 * 插件 runtime 的「工程读写」落地端（主窗口侧）。
 *
 * 链路：插件 runtime → 主进程 _handleHostCall → `plugin-host:project-apply`
 *       → 本文件 → mcpAutomation.executeAutomationRequest → 回包
 *
 * 为什么必须绕回渲染进程：工程的唯一真源在渲染层（state / trackManager），
 * 主进程只有文件 IO 能力，没有编辑模型。插件要改工程，只能请渲染层动手。
 *
 * 权限在这里**不判**：主进程已经按 manifest 的 project:read / project:write 拒过
 * 一次了。在这里再判一遍只会产生"两处规则漂移"的风险，不会更安全 ——
 * 渲染层拿不到 manifest，它无从判断自己该不该执行。
 */

import { executeAutomationRequest } from '../mcpAutomation.js';

export function installProjectApplyBridge() {
  const api = window.electronAPI?.pluginHost;
  if (!api || typeof api.onProjectApply !== 'function') return () => {};

  const off = api.onProjectApply(async (payload) => {
    const id = payload && payload.id;
    if (!id) return;

    // operations === null/undefined 表示"只要快照，不写"
    const isRead = payload.operations === null || payload.operations === undefined;
    try {
      const result = isRead
        ? await executeAutomationRequest('project.get', { includeNotes: false })
        : await executeAutomationRequest('project.apply', { operations: payload.operations });
      api.sendProjectApplyResult({ id, ok: true, result });
    } catch (err) {
      api.sendProjectApplyResult({
        id,
        ok: false,
        error: {
          code: (err && err.code) || 'INTERNAL',
          message: (err && err.message) || String(err),
        },
      });
    }
  });

  return () => {
    try { off(); } catch (_) { /* ignore */ }
  };
}
