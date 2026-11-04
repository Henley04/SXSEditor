'use strict';
/**
 * 插件自动化方法（`contributes.automation`）—— 命名、投影与错误的唯一规则来源。
 *
 * 为什么要单独一个模块：同一套规则有三个消费者，写三遍必然漂移。
 *   · `pluginManifest` 在加载前校验（作者要在安装时就看到错误，而不是运行期）；
 *   · `PluginService` 在注册时投影成 MCP 方法表条目（运行期唯一权威）；
 *   · `mcpBridge` 在派发时把插件的错误码翻成 MCP 错误码。
 *
 * 命名规则：**方法名 = 完整命令 id**（`<pluginId>.<localId>`）。
 *
 * 这是刻意的选择。用裸 `localId` 会让两个插件都声明的 `export` 互相顶掉，
 * 而"谁装得晚谁赢"在自动化里是灾难：同一句 agent 脚本在别人的机器上会调到
 * 另一个插件的实现。带前缀的名字永远不会歧义，代价只是长一点。
 *
 * 与内置方法同名的问题单独处理：插件 id 允许 `project` / `model` 这类词，
 * 一个 `project` 插件声明 `get` 命令就会拼出 `project.get`。内置方法优先，
 * 这里提供 `conflictsWithBuiltin` 供校验期直接拒绝。
 */

/** 完整命令 id（插件 id + 本地 id）作为方法名的形状。 */
const METHOD_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?\.[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * 插件错误码 → MCP 错误码。
 *
 * 两套词表分开演进：插件侧用 `PERMISSION_DENIED` / `TIMEOUT`，自动化侧只有
 * McpError 那八个码。不映射的话插件一拒绝就塌成 500 INTERNAL，调用方没法
 * 区分"权限不够"和"插件炸了"，重试策略全错。原始码留在 details.pluginCode。
 */
const PLUGIN_ERR_TO_MCP = Object.freeze({
  PERMISSION_DENIED: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  INVALID_REQUEST: 'VALIDATION_ERROR',
  RESULT_TOO_LARGE: 'VALIDATION_ERROR',
  CONFLICT: 'CONFLICT',
});

function mapPluginErrorCode(code) {
  return PLUGIN_ERR_TO_MCP[String(code || '')] || 'INTERNAL';
}

/** `<pluginId>.<localId>` */
function buildMethodName(pluginId, localId) {
  return `${pluginId}.${localId}`;
}

function isMethodName(name) {
  return typeof name === 'string' && METHOD_NAME_RE.test(name);
}

/** 标题是 `{en, 'zh-CN'}` 或字符串；自动化面只留一个词，英文优先。 */
function pickTitle(title) {
  if (!title) return '';
  if (typeof title === 'string') return title;
  return title.en || title['zh-CN'] || Object.values(title)[0] || '';
}

/**
 * 与内置自动化方法撞名？
 *
 * 延迟 require 是为了不让 `pluginManifest` 在顶层把整张 MCP 方法表拖进来 ——
 * 校验只在加载插件时跑，那点 require 成本可以忽略，但顶层依赖会传染给所有
 * 引用 manifest 校验的地方（含渲染层单测）。
 */
function conflictsWithBuiltin(name) {
  try {
    const { getMethod } = require('./mcpSchema.js');
    return !!getMethod(name);
  } catch (_) {
    return false;
  }
}

/**
 * 投影成 `GET /schema` 里的一条。
 *
 * `target: 'plugin'` 让桥接层知道该往插件运行时派发，而不是主进程 handler
 * 或某个渲染窗口 —— 后者需要窗口存在，而自动化恰恰要能在没人看着的时候跑。
 *
 * `long: true` 不是"这个方法一定很慢"，而是让桥接层的超时（600s）宽于插件
 * 自己的命令超时（60s）。反过来（桥接 60s、插件 60s）会变成赛跑：谁先到
 * 谁说话，用户看到的可能是一条"Automation timeout"而不是插件给出的具体原因。
 *
 * `params` 故意是开放的 object：参数形状由插件自己定义，宿主没有资格替它
 * 校验，硬编一个 schema 只会让插件升级参数时被旧宿主挡住。
 */
function buildAutomationDef(entry) {
  const { pluginId, localId, title, description, pluginName, pluginVersion } = entry;
  const name = buildMethodName(pluginId, localId);
  const def = {
    summary: pickTitle(title) || localId,
    description: `Provided by plugin ${pluginName || pluginId}${pluginName ? ` (${pluginId})` : ''}`
      + `${pluginVersion ? ` v${pluginVersion}` : ''}. `
      + 'Parameters are defined by the plugin and are not validated by the host; '
      + 'the return value is whatever the plugin command returned.'
      + (description ? ` ${description}` : ''),
    target: 'plugin',
    long: true,
    mutates: true,
    requires: [],
    aliases: {},
    params: {
      type: 'object',
      additionalProperties: true,
      description: 'Plugin-defined arguments object (passed to the plugin command as-is)',
    },
    examples: [],
    // 谁提供的：`/schema` 与 capabilities 都要能回答这个问题，
    // 否则 agent 看到一堆陌生方法，只能靠猜。
    source: `plugin:${pluginId}`,
  };
  return { name, pluginId, commandId: localId, def };
}

module.exports = {
  METHOD_NAME_RE,
  PLUGIN_ERR_TO_MCP,
  mapPluginErrorCode,
  buildMethodName,
  isMethodName,
  pickTitle,
  conflictsWithBuiltin,
  buildAutomationDef,
};
