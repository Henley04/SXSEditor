'use strict';
/**
 * 示例：服务提供方 + 长任务。
 *
 * 两件事在同一个插件里，是因为它们经常一起出现：一个"要跑一会儿"的能力，
 * 既想被界面按钮调，也想被别的插件直接当函数用。
 *
 *   · `services['example.clock']` —— 别的插件通过 `ctx.services.get()` 拿到；
 *   · `commands.countdown` —— 声明了 `long: true`，MCP 可以用 `async: true`
 *     提交成 job，期间 `ctx.ui.progress()` 回报进度、`ctx.signal` 响应取消。
 *
 * 注意 `countdown` 的进度回报**必须**带在 `ctx` 上（不是某个全局对象）：
 * 宿主按请求 id 把进度送回发起这一次调用的人，而不是广播给所有窗口。
 */

let startedAt = Date.now();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 服务端点：宿主已校验 service 与方法都在 manifest 里声明过。 */
const services = {
  'example.clock': {
    async now() {
      return { epochMs: Date.now(), startedAt, uptimeMs: Date.now() - startedAt };
    },
    async offsetMs(ctx, args, meta) {
      // 第二个参数是调用方给的对象，第三个是宿主给的元信息（谁在调）。
      // 参数形状由服务自己定义 —— 宿主不校验，也不该替它校验。
      const base = Number((args && args.base) || Date.now());
      return { offsetMs: base - Date.now(), caller: (meta && meta.caller && meta.caller.id) || null };
    },
  },
};

async function countdown(ctx, args) {
  const total = Math.max(200, Math.min(30000, Number((args && args.ms) || 3000)));
  const step = 100;
  const tail = args && typeof args.tail === 'string' ? args.tail.slice(0, 40) : '';
  const t0 = Date.now();

  for (let elapsed = 0; elapsed < total; elapsed += step) {
    // 取消是协作式的：不检查 signal 也能跑完，但会白烧算力，而且宿主早已
    // 把这次调用结算成 cancelled —— 结果没人要。
    if (ctx.signal && ctx.signal.aborted) {
      throw Object.assign(new Error('倒计时已取消'), { code: 'CANCELLED' });
    }
    await sleep(step);
    ctx.ui.progress(Math.min(1, (elapsed + step) / total), `剩余 ${Math.max(0, total - elapsed - step)}ms`);
  }

  return { ms: Date.now() - t0, requestedMs: total, tail };
}

const commands = {
  countdown,
  info: async () => ({ startedAt, uptimeMs: Date.now() - startedAt, pid: process.pid }),
};

function initialize(ctx) {
  startedAt = Date.now();
  ctx.log.info('example-clock ready');
}

module.exports = {
  initialize,
  commands,
  services,
  dispose() {
    startedAt = Date.now();
  },
};
