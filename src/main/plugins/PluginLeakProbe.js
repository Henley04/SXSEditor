'use strict';
/**
 * 泄漏探针 —— 把"卸载是否干净"变成可断言的数字。
 *
 * 背景：可逆性最怕的不是"没写 dispose"，而是**没人知道自己没写**。这里给每个
 * 插件在卸载前后各拍一次快照，把差值为 0 当作硬性验收条件（开发/测试下抛错，
 * 生产只记审计），这样"漏了一个 DOM 节点"在下一次跑测试时就会暴露，而不是半年后
 * 由一个莫名其妙的 bug 提醒你。
 *
 * 能测的：ipc handler 数、菜单项数、该插件自己的贡献项数、runtime 进程数、
 * pending RPC、以及各窗口里 `[data-plugin-id]` 节点数。测不到的：插件在 iframe
 * 里自己 new 的定时器（那些随 iframe 销毁一起回收，不需要也不应该由宿主追踪）。
 */
const { TIMEOUTS } = require('../../shared/pluginApi.js');

class PluginLeakProbe {
  constructor(options = {}) {
    this.registry = options.registry;
    this.runtimeManager = options.runtimeManager;
    this.getWindows = options.getWindows || (() => []);
    this.logger = options.logger || console;
    this.ipcHandlers = 0;
    this.enabled = options.enabled !== false;
  }

  /** IPC 计数由注册包装器驱动，见 PluginIpcV2 里的 addHandler/removeHandler。 */
  noteIpcAdded(n = 1) {
    this.ipcHandlers += n;
  }

  noteIpcRemoved(n = 1) {
    this.ipcHandlers -= n;
  }

  _menuCount() {
    try {
      const { Menu } = require('electron');
      const menu = Menu.getApplicationMenu();
      if (!menu) return 0;
      let count = 0;
      const walk = (items) => {
        for (const item of items || []) {
          count++;
          if (item.submenu) walk(item.submenu.items);
        }
      };
      walk(menu.items);
      return count;
    } catch (_) {
      return 0;
    }
  }

  async _domCount(pluginId) {
    let total = 0;
    const detail = {};
    for (const win of this.getWindows()) {
      if (!win || win.isDestroyed()) continue;
      try {
        const n = await win.webContents.executeJavaScript(
          `document.querySelectorAll('[data-plugin-id="${pluginId}"]').length`,
          true,
        );
        if (n) {
          total += Number(n) || 0;
          detail[win.webContents.getURL()] = n;
        }
      } catch (_) { /* 窗口还没加载完，跳过 */ }
    }
    return { total, detail };
  }

  async snapshot(pluginId) {
    const dom = pluginId ? await this._domCount(pluginId) : { total: 0, detail: {} };
    const session = this.runtimeManager && this.runtimeManager.sessions.get(pluginId);
    return {
      ipc: this.ipcHandlers,
      menu: this._menuCount(),
      contributions: this.registry ? this.registry.stats() : null,
      ownContributions: this._ownContributions(pluginId),
      runtimeAlive: session && !session.exited ? 1 : 0,
      pendingRpc: session ? session.pending.size : 0,
      dom: dom.total,
      domDetail: dom.detail,
    };
  }

  /** 只数"这个插件自己的"贡献项。全局 stats() 在这里没有意义：见 assertClean。 */
  _ownContributions(pluginId) {
    if (!this.registry || !pluginId) return 0;
    let total = 0;
    for (const type of ['command', 'menu', 'panel', 'fileType', 'setting', 'hook']) {
      for (const entry of this.registry.list(type)) {
        if (entry && entry.pluginId === pluginId) total++;
      }
    }
    return total;
  }

  /**
   * 卸载后断言：所有"应当归零"的计数确实是 0。
   *
   * 这里**不能**一律用 before/after 差值。一开始就是这么写的，结果每次卸载都报
   * 残留 —— 因为撤销贡献本身就该让计数变少，delta 必然非零。差值只能用在
   * "插件本不该改变"的进程级计数上（ipc handler 数）。
   *
   * 断言项（任一非 0 即视为残留）：
   *   · ownContributions —— 该插件的命令/面板/菜单/文件类型/设置/钩子还剩几条
   *   · runtimeAlive     —— 进程还在
   *   · pendingRpc       —— 还有未回包的调用（说明有东西在等一个不会来的响应）
   *   · dom              —— 任何窗口里还有 [data-plugin-id] 节点
   *   · ipc              —— 相对卸载前新增了 handler
   * 诊断项（不参与判定）：
   *   · menuDelta —— 菜单是整体重建的，条数变少是正常的；只用来在日志里留痕
   *
   * @returns {Promise<{ok:boolean, deltas:object, after:object}>}
   */
  async assertClean(before, pluginId) {
    // 给异步回收一点时间：iframe 的 load 事件、进程的 exit 都是下一个 tick
    await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.leakSampleDelay));
    const after = await this.snapshot(pluginId);
    const checks = {
      ownContributions: after.ownContributions,
      runtimeAlive: after.runtimeAlive,
      pendingRpc: after.pendingRpc,
      dom: after.dom,
      ipc: after.ipc - before.ipc,
    };
    const deltaMenu = after.menu - before.menu;
    const leaked = Object.entries(checks).filter(([, v]) => v !== 0);
    const ok = leaked.length === 0;
    const deltas = { ...checks, menuDelta: deltaMenu, stats: after.contributions };
    if (!ok) {
      this.logger.warn(
        `[plugin:${pluginId}] 卸载后仍有残留：`,
        JSON.stringify(Object.fromEntries(leaked)),
      );
    }
    return { ok, deltas, after };
  }
}

module.exports = { PluginLeakProbe };
