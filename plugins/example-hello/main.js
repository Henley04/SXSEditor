'use strict';
/**
 * v2 插件入口（跑在独立 utilityProcess 里，CommonJS）。
 *
 * 契约：
 *   · 导出 `initialize(ctx)` —— 可选，进程启动后调用一次；
 *   · 导出 `commands.<localId>(ctx, args)` —— 与 manifest.contributes.commands 的 id 对应；
 *   · 导出 `panels.rpc(ctx, method, params)`（所有面板共用一个 dispatcher），
 *     或 `panels.<localId>.rpc(ctx, method, params)`（每个面板一个），
 *     或 `onPanelRpc(ctx, panelId, method, params)` —— 面板发来的每一条 RPC 都会落到
 *     这里，`method` 就是面板声明的 apiScopes 之一。三种写法按上面顺序取第一个可用的。
 *
 * 注意：这里**没有** net / fs 的自由访问。ctx 提供的是宿主裁剪过的能力
 * （project / state / ort / fs(受限) / ui / hardware）。想联网要单独申请 net 权限。
 */

let disposed = false;

module.exports = {
  initialize(ctx) {
    ctx.log.info(`example-hello 已就绪（app ${ctx.capabilities?.hardware?.appVersion || '?'}）`);
    // 进程被回收时要收的东西挂在这里：定时器、ORT session、临时文件。
    // 宿主在卸载/重载时先发 dispose，再（必要时）强杀进程。
    ctx.onDispose(() => {
      disposed = true;
      ctx.log.info('example-hello 正在退出');
    });

    // 用户在设置页改了值 → 宿主推 settings.changed → 这里立即拿到新快照。
    // 不需要自己轮询，也不需要重启插件。
    ctx.onSettingsChanged((_c, values) => {
      ctx.log.info(`设置已更新：${JSON.stringify(values)}`);
    });
  },

  commands: {
    /**
     * 一个"什么都不改"的命令：读工程 → 累加计数 → 通知 → 更新状态栏。
     * 演示五件事：settings、state 持久化、project.read、ui.notify、ui.status。
     */
    async greet(ctx) {
      if (disposed) throw Object.assign(new Error('插件正在退出'), { code: 'PLUGIN_UNLOADED' });
      // 设置页里的"计数步长"，缺省 1；值域收敛由宿主按 schema 做，这里只防御非数字
      const step = Number(ctx.settings.get('step')) || 1;
      const count = (ctx.state.get('greetCount') || 0) + step;
      ctx.state.set('greetCount', count);

      let bpm = null;
      try {
        const snapshot = await ctx.project.read();
        bpm = snapshot && snapshot.project ? snapshot.project.bpm : null;
      } catch (err) {
        // 读失败不该让命令整体失败：插件要能降级
        ctx.log.warn(`读取工程失败：${err && err.message}`);
      }

      const greeting = String(ctx.settings.get('greeting') || 'Hello');
      const showBpm = ctx.settings.get('showBpm') !== false;
      await ctx.ui.notify(`${greeting} #${count}${showBpm && bpm ? ` · 当前 BPM ${bpm}` : ''}`);
      // 更新声明过的状态栏条目（id 是本插件 manifest 里的 localId）
      await ctx.ui.status('count', `${greeting} ×${count}`);
      return { count, bpm };
    },

    /** 写工程：ops 语义与 MCP 的 project.apply 完全一致。 */
    async bumpTempo(ctx, args) {
      const bpm = Number(args && args.bpm) || 132;
      const result = await ctx.project.apply([{ op: 'set_project', value: { bpm } }]);
      await ctx.ui.notify(`已把 BPM 设为 ${bpm}`);
      return { bpm, applied: result && result.applied };
    },
  },

  panels: {
    /** 面板 RPC 的唯一入口。method 已经过宿主按 apiScopes 校验。 */
    async rpc(ctx, method, params) {
      switch (method) {
        case 'project.read':
          return ctx.project.read();
        case 'project.apply':
          return ctx.project.apply((params && params.operations) || []);
        case 'state.get':
          return ctx.state.get((params && params.key) || 'greetCount');
        case 'state.set':
          ctx.state.set((params && params.key) || 'greetCount', params && params.value);
          return { ok: true };
        case 'ui.notify':
          await ctx.ui.notify(String((params && params.message) || ''));
          return { ok: true };
        default:
          throw Object.assign(new Error(`未知面板方法 ${method}`), { code: 'UNSUPPORTED' });
      }
    },
  },
};
