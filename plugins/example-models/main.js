'use strict';
/**
 * 模型调用示例（跑在独立 utilityProcess 里，CommonJS）。
 *
 * 要点就一句：**插件只说 task，不指定端点，也不碰密钥。**
 *
 *   ctx.models.invokeOnce({ task: 'chat', input: '...' })
 *
 * 端点由用户在 设置 → 模型端点 里绑到任务上；第一次调用会弹确认框；密钥全程留在
 * 主进程。插件拿到的只有结果文本。
 *
 * `probeNet` 故意反着做一次，用来看运行时的出站封锁 —— 那是最后一道"防误用"，
 * 不是沙箱：真正的边界是插件拿不到 baseUrl 与凭据。
 */

let lastEndpoint = '';

module.exports = {
  initialize(ctx) {
    // 能力发现：看得见哪些端点（ask 状态）、看不见 baseUrl 与密钥。
    ctx.models.list({ task: 'chat' }).then((res) => {
      const rows = (res && res.endpoints) || [];
      ctx.log.info(`chat 可用端点 ${rows.length} 个：${rows.map((e) => `${e.title}(${e.locality})`).join(', ') || '无'}`);
    }).catch((err) => {
      ctx.log.warn(`列端点失败：${err && err.message}`);
    });
  },

  commands: {
    /**
     * 问一句，流式写状态栏。
     *
     * 三种结局都要给用户一个说法：没有端点、被拒绝、上游失败。静默失败是最糟的
     * —— 用户点了菜单，什么都没发生。
     */
    async ask(ctx) {
      const prompt = String(ctx.settings.get('prompt') || '').trim() || '用一句话介绍你自己';
      await ctx.ui.status('last', '@modelWorking');

      let text = '';
      try {
        const h = ctx.models.invoke(
          { task: 'chat', input: { messages: [{ role: 'user', content: prompt }] } },
          {
            // 有分片就更新状态栏：模型慢的时候，界面上的"在动"比结果更重要
            onChunk: (chunk) => {
              text += String(chunk == null ? '' : chunk);
              ctx.ui.status('last', text.slice(-40));
            },
          },
        );
        const result = await h.done;
        if (result.cancelled) {
          await ctx.ui.status('last', '@modelIdle');
          return { ok: false, error: { code: 'CANCELLED', message: '调用已取消' } };
        }
        lastEndpoint = result.endpointId || '';
        await ctx.ui.status('last', (result.text || '').slice(0, 60));
        await ctx.ui.notify(result.text || '(空回复)', 'info');
        return { ok: true, text: result.text, endpointId: lastEndpoint };
      } catch (err) {
        await ctx.ui.status('last', '@modelIdle');
        // NEED_ENDPOINT / PERMISSION_DENIED 是可以照做的：告诉用户去哪儿绑、去哪儿授权
        const hint = err.code === 'NEED_ENDPOINT'
          ? '（设置 → 模型端点 → 任务绑定 里给 chat 选一个端点）'
          : err.code === 'PERMISSION_DENIED' ? '（在设置 → 访问控制 里授权，或重新触发一次确认）' : '';
        await ctx.ui.notify(`模型调用失败：${err.message}${hint}`, 'error');
        return { ok: false, error: { code: err.code || 'INTERNAL', message: err.message } };
      }
    },

    /** 反面教材：绕过宿主直接发 HTTP。运行时会在 require/fetch 处立刻拦下。 */
    async probeNet(ctx) {
      let requireError = '';
      let fetchError = '';
      try {
        // eslint-disable-next-line global-require
        require('node:https');
      } catch (err) {
        requireError = err.message;
      }
      try {
        await fetch('https://api.example.com/v1/chat/completions', { method: 'POST' });
      } catch (err) {
        fetchError = err.message;
      }
      await ctx.ui.notify(
        requireError ? '已被拦截：插件进程不能 require node:https / 不能 fetch。' : '未拦截（异常！）',
        requireError ? 'warn' : 'error',
      );
      ctx.log.info(`require 拦截：${requireError || '无'}`);
      ctx.log.info(`fetch 拦截：${fetchError || '无'}`);
      return { ok: true, blocked: !!requireError && !!fetchError };
    },
  },
};
