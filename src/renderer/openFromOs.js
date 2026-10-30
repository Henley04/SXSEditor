/**
 * 系统投递的文件（双击 / "打开方式"）在渲染层的落点。
 *
 * 主进程只做两件事：把路径放进 pending 槽、发一声"有文件待取"的通知。
 * 取与不取、按什么方式打开，全部由这里决定 —— 冷启动（路径来自 argv，
 * 早就躺在槽里）和运行中再双击（路径来自 second-instance / open-file）
 * 因此走同一条代码路径，不会出现两套逻辑各自处理一半的情况。
 */
import { loadProject } from './projectManager.js';
import { refreshAll } from './timelineRenderer.js';

let installed = false;

async function applyTarget(target) {
  if (!target || typeof target.path !== 'string') return;

  if (target.kind === 'singer') {
    const api = window.electronAPI;
    if (!api?.openSingerFileAt) return;
    const res = await api.openSingerFileAt(target.path);
    if (res && res.success === false && !res.canceled) {
      console.warn('[open] singer file rejected:', res.error);
    }
    return;
  }

  // 工程：loadProject 自己会处理"未保存改动"的确认框；用户选择取消时静默返回
  await loadProject(target.path);
  refreshAll();
}

/** 取走主进程暂存的文件并打开。重复调用安全：槽被取走即清空。 */
export async function consumePendingOpenFile() {
  try {
    const target = await window.electronAPI?.takePendingOpenFile?.();
    if (target) await applyTarget(target);
  } catch (err) {
    console.error('[open] failed to take pending file:', err);
  }
}

/** 挂上"有新文件"的监听。只挂一次。 */
export function installOpenFromOs() {
  if (installed) return;
  installed = true;
  window.electronAPI?.onFileRequested?.(() => {
    consumePendingOpenFile();
  });
}
