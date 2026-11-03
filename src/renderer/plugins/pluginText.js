/**
 * 插件贡献点共用的小工具（渲染层）。
 *
 * 三个函数都只做一件事，目的是让四个贡献点模块不必各自实现一遍：
 *   · pickLocalized：manifest 的文案是 { en, 'zh-CN' } 对象，渲染前必须落成字符串；
 *   · evalWhen：把 `projectOpen && !playing` 这类封闭条件求值成布尔；
 *   · hostContext：宿主状态的唯一读取口（不在模块里直接 import state，
 *     否则这些模块就没法在测试或别的窗口里复用）。
 */

import { t } from '../../i18n/index.js';
import { showPluginToast } from './pluginToast.js';

/**
 * 取当前语言文案。缺省回退到 en，再回退到第一个非空值。
 * @param {string|object|null} value
 * @param {string} locale
 * @returns {string}
 */
export function pickLocalized(value, locale) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const lang = String(locale || 'en');
  return value[lang] || value[lang.split('-')[0]] || value.en || Object.values(value)[0] || '';
}

/**
 * 插件自带字典的键前缀。
 *
 * 为什么加前缀：插件可以叫 `example-hello`，也可能有键 `common.ok`；不隔离的话
 * 一次 `registerPluginMessages` 就会覆盖宿主自己的 `common.*`。
 */
export function pluginMessageKey(pluginId, key) {
  return `plugin.${pluginId}.${key}`;
}

/**
 * 求值 when 子句。`!` 取反，`&&` 连接；未知条件一律视为 false（宁可少显示，
 * 不要在状态没准备好时把插件按钮画出来又立刻撤掉）。
 * @param {string|null} clause
 * @param {object} ctx
 */
export function evalWhen(clause, ctx) {
  if (!clause) return true;
  return String(clause).split('&&').every((raw) => {
    const text = raw.trim();
    if (!text) return true;
    const negated = text.startsWith('!');
    const name = negated ? text.slice(1).trim() : text;
    const value = !!(ctx && ctx[name]);
    return negated ? !value : value;
  });
}

/** 读当前语言（与 document.documentElement.lang 保持同步）。 */
export function currentLocale() {
  return document.documentElement.lang || 'en';
}

/**
 * 解析插件提供的文本：`@key` 引用 `contributes.i18n` 里的词条，其它原样返回。
 * 翻译缺失时退回键本身（去掉 @），而不是把 `plugin.xxx.yyy` 这种内部键漏给用户。
 */
export function resolvePluginText(pluginId, value) {
  if (typeof value !== 'string' || !value.startsWith('@')) return value;
  const key = pluginMessageKey(pluginId, value.slice(1));
  const translated = t(key);
  return translated === key ? value.slice(1) : translated;
}

/**
 * 统一的错误提示。插件命令失败不该静默：用户点了按钮却什么都没发生，
 * 比弹一条"插件执行失败"更让人困惑。
 */
export function reportCommandFailure(result) {
  const message = (result && result.error && result.error.message) || t('plugins.commandFailed');
  showPluginToast(message, 'error');
}
