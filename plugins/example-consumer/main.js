'use strict';
/**
 * 示例：跨插件服务消费方。
 *
 * manifest 里声明了 `consumes: [{ id: 'example.clock', range: '^1.0.0' }]`，
 * 所以：
 *   · 安装弹窗会把"这个插件会去调别的插件"写给用户看；
 *   · 宿主只放行声明过的服务 —— 没声明就调会在主进程被拒（PERMISSION_DENIED）；
 *   · `example-clock` 没装/被停用时，这个插件在管理器里显示为 degraded，
 *     命令调用得到的是 SERVICE_GONE，而不是一句语焉不详的 INTERNAL。
 */

async function now(ctx) {
  // get() 在不可用时直接抛 SERVICE_GONE —— 非可选依赖就该在这里断开，
  // 而不是拿到一个"方法全是空函数"的句柄，然后在更深的地方炸。
  const clock = ctx.services.get('example.clock');
  const t = await clock.now();
  return {
    provider: clock.provider,
    version: clock.version,
    methods: clock.methods,
    uptimeMs: t.uptimeMs,
    epochMs: t.epochMs,
  };
}

/**
 * 查询部署依赖：只读，不安装。
 *
 * manifest.dependencies 声明了「需要先装上 example-clock」。要真正安装时必须
 * 显式调用 ctx.plugins.installMany([...])，主进程会弹出用户确认对话框 ——
 * 声明依赖本身永远不会自动往用户机器上装东西。
 */
async function deps(ctx) {
  const resolved = await ctx.plugins.resolveDependencies();
  const installed = await ctx.plugins.list();
  return { deps: resolved.deps, cycles: resolved.cycles, installed: installed.plugins };
}

async function optionalProbe(ctx) {
  // optional 依赖用 tryGet：拿不到就自己降级，不算错误。
  // 这个命令没有出现在 manifest 的 commands 里，仅作作者参考；宿主不会调用它。
  const clock = ctx.services.tryGet('example.clock');
  return { available: !!clock, services: ctx.services.list() };
}

const commands = { now, optionalProbe, deps };
function initialize(ctx) {
  // 提供方在运行期消失/恢复时能被感知：缓存了它返回值的插件可以据此重算。
  ctx.services.onDidChange((info) => {
    ctx.log.info(`service ${info.id} available=${info.available}`);
  });
  const list = ctx.services.list();
  if (list.length) {
    const dep = list[0];
    ctx.log.info(`dependency ${dep.id}: ${dep.available ? `ok (${dep.provider}@${dep.version})` : `missing (${dep.reason || 'unknown'})`}`);
  }
}

module.exports = { initialize, commands };
