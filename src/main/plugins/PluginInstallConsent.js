'use strict';
/**
 * 插件发起的安装：主进程强制用户确认。
 *
 * 这是整条链路里唯一能"放行落盘"的闸门，且刻意放在主进程 —— 插件进程拿到
 * 的只有 hostCall 通道，没有任何能直接调 installFromPackage 的入口。即便它
 * 伪造参数、绕过 PluginRuntimeManager 的白名单，最后仍需用户在这里点确认。
 *
 * 批量一次弹窗列全批，而不是逐项弹：装 5 个依赖连点 5 次，用户会养成无脑
 * 确认的习惯，反而更不安全。安全默认值是"全部拒绝"（defaultId/cancelId 都
 * 指向它），关掉窗口等同于拒绝。
 */
const { t } = require('../locale.js');

/**
 * @param {{callerId:string, targets:Array<object>, getWindow?:Function}} input
 * @returns {Promise<{confirmed:boolean, response:number}>}
 */
async function confirmInstallBatch(input = {}) {
  const { callerId, targets = [] } = input;
  const win = typeof input.getWindow === 'function' ? input.getWindow() : null;

  const lines = targets.map((target, i) => {
    const rows = [
      `${i + 1}. ${target.pluginId || t('pluginInstallConsent.unknownId')}${target.version ? `@${target.version}` : ''}`,
      `   ${t('pluginInstallConsent.source')}: ${target.sourceLabel}`,
      `   ${t('pluginInstallConsent.relation')}: ${t(`pluginInstallConsent.rel_${target.relation || 'unknown'}`)}`,
    ];
    if (target.signature) {
      rows.push(`   ${t('pluginInstallConsent.signature')}: ${target.signature.status}${target.signature.keyId ? ` (${target.signature.keyId})` : ''}`);
    }
    if (target.permissionsChanged) {
      rows.push(`   ${t('pluginInstallConsent.permissionsChanged')}`);
    }
    if (target.selfUpdate) rows.push(`   ${t('pluginInstallConsent.selfUpdate')}`);
    if (target.nonMarket) rows.push(`   ${t('pluginInstallConsent.nonMarket')}`);
    return rows.join('\n');
  });

  const detail = [
    `${t('pluginInstallConsent.initiator')}: ${callerId}`,
    '',
    ...lines,
  ].join('\n');

  let result;
  try {
    // 延迟取 dialog：模块可能在测试环境里被提前 require，那时 electron 还是
    // 打桩对象，顶层解构会把一个过期引用一直握到运行时。调用时再取，主进程
    // 里始终是真实 electron，测试里也能通过 input.showMessageBox 直接注入。
    const show = typeof input.showMessageBox === 'function'
      ? input.showMessageBox
      : (win, opts) => require('electron').dialog.showMessageBox(win, opts);
    result = await show(win && !win.isDestroyed() ? win : null, {
      type: 'question',
      buttons: [t('pluginInstallConsent.rejectAll'), t('pluginInstallConsent.confirmAll')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: t('pluginInstallConsent.title'),
      message: t('pluginInstallConsent.message'),
      detail,
    });
  } catch (err) {
    // 拿不到窗口、无显示环境、对话框被系统拒绝：一律按拒绝处理。
    // 这条路径必须 fail-closed —— 弹不出确认框时静默放行等于绕过整道闸门。
    return { confirmed: false, response: 0, error: String((err && err.message) || err) };
  }

  // 对话框没给出可识别的选项编号时（无显示环境、返回体异常、被模拟成空值），
  // 一律按"全部拒绝"处理。这里必须判空：一旦 result 为空还直接读 .response，
  // 抛出的异常会传到调用方变成"安装失败"，而不是干净的"用户拒绝"。
  const response = result && Number.isInteger(result.response) ? result.response : 0;
  return { confirmed: response === 1, response };
}

module.exports = { confirmInstallBatch };
