'use strict';

/**
 * adapter 注册表。
 *
 * 封闭集合：插件只能指认这里已有的协议，不能自带一个"map 函数"来决定请求长什么样。
 * 理由很直接 —— adapter 一旦可编程，插件就能把出站地址改到任意地方，而请求是我们
 * 代发的、密钥在我们手上。这比"少支持几个私有协议"危险得多。
 */

const { createOpenAICompatibleAdapter } = require('./openaiCompatible');
const { createAnthropicAdapter } = require('./anthropic');
const { createLocalProcessAdapter } = require('./localProcess');

/**
 * @param {{fetchImpl?:Function, logger?:object, localBackends?:Map<string,object>}} [opts]
 * @returns {{adapters: Map<string, object>, local: object}}
 */
function createAdapters(opts = {}) {
  const local = createLocalProcessAdapter({ logger: opts.logger, backends: opts.localBackends });
  const adapters = new Map([
    ['openai-compatible', createOpenAICompatibleAdapter(opts)],
    ['anthropic', createAnthropicAdapter(opts)],
    ['local-process', local],
  ]);
  return { adapters, local };
}

module.exports = { createAdapters };
