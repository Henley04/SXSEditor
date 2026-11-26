'use strict';
/**
 * 插件密钥示例。
 *
 * 要点不是"怎么存一个字符串"，而是三件容易被写错的事：
 *
 *   1. **密钥不是设置**。设置（`ctx.settings`）是用户能在设置页看到并编辑的普通配置；
 *      密钥是"用户填进来、之后不该在任何地方回显"的东西。两者的存储、审计与界面
 *      语义都不同，不要用 state/settings 存 token。
 *   2. **本机可能没在加密**。`set()` 返回的 `encrypted` 是事实而不是保证：Linux 上
 *      没有 keyring 时宿主仍会存（否则插件只能写明文 state.json），但会把
 *      `encrypted:false` 告诉你。界面要如实说，不要默认"反正是加密的"。
 *   3. **读与写是两个权限**。只读的展示面板没有理由能覆盖用户的 token，所以 manifest
 *      里要分开声明 `secrets: ["read", "write"]`。
 *
 * 这个示例把 token 回显在返回值里，是为了让命令行走查能验证往返正确；真实插件
 * 不应该把密钥放进 UI、日志或返回给调用方 —— 它只需要在调用外部服务时自己用一下。
 */

const KEY = 'demo.token';

module.exports = {
  initialize(ctx) {
    ctx.log.info('example-secrets 已就绪（secrets: read/write）');
  },

  commands: {
    /** 写入。参数不合法时自己生成一个，方便从菜单直接点。 */
    async save(ctx, args) {
      const value = args && typeof args.value === 'string' && args.value
        ? args.value
        : `demo-${Date.now().toString(36)}`;
      const r = await ctx.secrets.set(KEY, value);
      await ctx.ui.notify(`已保存 ${KEY}（${r.created ? '新建' : '覆盖'}）`);
      return {
        key: KEY,
        created: r.created,
        bytes: Buffer.byteLength(value, 'utf8'),
        // 事实，不是承诺：false = 本机没有可用的系统密钥环
        encrypted: r.encrypted,
      };
    },

    /** 读回并列出全部密钥名（只列名，不列值）。 */
    async reveal(ctx) {
      const token = await ctx.secrets.get(KEY);
      const { keys, encrypted } = await ctx.secrets.keys();
      await ctx.ui.notify(token === null ? `${KEY} 还没有值` : `${KEY} 已存在（${keys.length} 个密钥）`);
      return {
        key: KEY,
        present: token !== null,
        // 仅用于走查验证往返；真实插件不要这样做
        token,
        keys,
        encrypted,
      };
    },

    /** 删除（幂等）。用于验证"删掉之后确实落盘"。 */
    async clear(ctx) {
      const r = await ctx.secrets.delete(KEY);
      await ctx.ui.notify(r.existed ? `已删除 ${KEY}` : `${KEY} 本来就不存在`);
      return { key: KEY, deleted: r.existed };
    },
  },
};
