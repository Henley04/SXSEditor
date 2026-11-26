'use strict';

/**
 * 模型调用面的 IPC。
 *
 * 两件事：
 *   1. 设置页读写端点 / 绑定 / 授权 / 审计；
 *   2. 首次调用时的确认窗（把网关的 consent 回调接到渲染层）。
 *
 * 确认窗为什么走 HTML 而不是原生 dialog：原生 `showMessageBox` 没法在 30 秒后
 * 自动关闭，而"没人应达就按拒绝处理"是这套授权模型的地基 —— 没人看着的时候
 * 不应该自动放行数据外发。原生框做不到超时，就只能自己画。
 */

const { BrowserWindow, ipcMain } = require('electron');
const { IPC_CHANNELS } = require('../../shared/ipcChannels');
const { LIMITS } = require('../../shared/modelContract');

/**
 * @param {object} service ModelService
 * @param {{getWindow?:Function, logger?:object}} [opts]
 */
function registerModelIpc(service, opts = {}) {
  if (!service) return { dispose: () => {} };
  const log = opts.logger || console;
  // 弹窗只能画在装了监听器的那个窗口（主窗口）。以前这里是"当前聚焦窗口"，
  // 结果用户开着设置页时，确认请求被投递到一个没有监听器的窗口，界面上什么都
  // 不出现，30 秒后静默失败——最难查的那种。
  const getWindow = opts.getWindow || (() => {
    try { return require('../windowManager').getMainWindow(); } catch (_) { return null; }
  });
  // “人在不在”和“弹哪个窗口”是两件事，必须分开判：用户在设置页里打字也算在。
  const isAttended = opts.isAttended || (() => BrowserWindow.getAllWindows()
    .some((w) => !w.isDestroyed() && w.isVisible() && w.isFocused()));

  /** @type {Map<string, {resolve:Function, timer:NodeJS.Timeout}>} */
  const pending = new Map();
  let seq = 0;

  // 网关遇到 ask 时调用这里。裁决权在网关（_askConsent 的 30s 超时），
  // 这里只负责投递与清理——两边各判一次会让审计里出现两条"超时"。
  service.setConsentHandler((info) => new Promise((resolve) => {
    const win = getWindow();
    if (!win || win.isDestroyed() || !isAttended()) {
      // 不在这里写审计：网关是唯一的裁决者，它会把 'unattended' 记成
      // outcome=unattended。两边都写就会一条拒绝留两条痕。
      resolve('unattended');
      return;
    }
    const requestId = `c${++seq}`;
    // 主窗口缩在后台时，弹窗画了也看不见。用 showInactive 把它摆出来但不抢焦点：
    // 抢焦点会打断用户正在别处做的输入，而确认框本身只等一次点击。
    if (!win.isVisible()) {
      try { win.showInactive(); } catch (_) { /* 最小化恢复失败不阻塞 */ }
    }
    // 兜底清理：比网关的超时晚 2 秒，只为把 pending 表清干净。
    // 不写审计、不改结论——真正的判定已经由网关做了。
    const timer = setTimeout(() => {
      if (!pending.delete(requestId)) return;
      resolve('timeout');
    }, LIMITS.consentTimeoutMs + 2000);

    pending.set(requestId, { resolve, timer });
    try {
      win.webContents.send(IPC_CHANNELS.MODELS_CONSENT_REQUEST, {
        requestId,
        subject: info.subject,
        task: info.task,
        bytesIn: info.bytesIn,
        output: info.output,
        endpoint: {
          id: info.endpoint.id,
          title: info.endpoint.title,
          provider: info.endpoint.provider,
          locality: info.endpoint.locality,
        },
      });
    } catch (err) {
      clearTimeout(timer);
      pending.delete(requestId);
      log.warn('[models] 确认请求发送失败：', err && err.message);
      resolve('deny');
    }
  }));

  ipcMain.handle(IPC_CHANNELS.MODELS_CONSENT_REPLY, (_e, payload) => {
    const row = pending.get(payload && payload.requestId);
    if (!row) return { ok: false };
    clearTimeout(row.timer);
    pending.delete(payload.requestId);
    row.resolve(payload.answer || 'deny');
    return { ok: true };
  });

  const safe = (channel, fn) => {
    ipcMain.handle(channel, async (_e, payload) => {
      try {
        return await fn(payload || {});
      } catch (err) {
        log.warn(`[models] ${channel} 失败：`, err && err.message);
        return { ok: false, error: err && err.message };
      }
    });
  };

  safe(IPC_CHANNELS.MODELS_SNAPSHOT, () => {
    const snap = service.snapshot();
    try {
      const bridge = require('../mcpBridge');
      const bypass = new Set(snap.settings.tokenBypass || []);
      snap.tokens = (bridge.listTokens ? bridge.listTokens() : []).map((t) => ({
        ...t,
        bypassAll: bypass.has(t.id),
      }));
    } catch (_) {
      snap.tokens = [];
    }
    return snap;
  });
  safe(IPC_CHANNELS.MODELS_ENDPOINT_UPSERT, (p) => service.upsertEndpoint(p.endpoint || p));
  safe(IPC_CHANNELS.MODELS_ENDPOINT_REMOVE, (p) => service.removeEndpoint(p.id));
  safe(IPC_CHANNELS.MODELS_BIND, (p) => service.bind(p));
  safe(IPC_CHANNELS.MODELS_UNBIND, (p) => service.unbind(p.task, p.endpointId));
  safe(IPC_CHANNELS.MODELS_SET_DEFAULT, (p) => service.setDefault(p.task, p.endpointId));
  safe(IPC_CHANNELS.MODELS_GRANT, (p) => service.grant(p.subject, p.endpointId, p.decision || 'allow', p.scope || 'always'));
  safe(IPC_CHANNELS.MODELS_REVOKE, (p) => service.revoke(p.subject, p.endpointId));
  safe(IPC_CHANNELS.MODELS_SET_SETTINGS, (p) => {
    service.setSettings({ localFree: p.localFree, tokenBypass: p.tokenBypass });
    return { ok: true };
  });
  safe(IPC_CHANNELS.MODELS_AUDIT, (p) => ({ entries: service.auditList(p) }));

  return {
    dispose() {
      for (const [id, row] of pending) {
        clearTimeout(row.timer);
        row.resolve('deny');
        pending.delete(id);
      }
      for (const ch of [
        IPC_CHANNELS.MODELS_CONSENT_REPLY, IPC_CHANNELS.MODELS_SNAPSHOT,
        IPC_CHANNELS.MODELS_ENDPOINT_UPSERT, IPC_CHANNELS.MODELS_ENDPOINT_REMOVE,
        IPC_CHANNELS.MODELS_BIND, IPC_CHANNELS.MODELS_UNBIND, IPC_CHANNELS.MODELS_SET_DEFAULT,
        IPC_CHANNELS.MODELS_GRANT, IPC_CHANNELS.MODELS_REVOKE,
        IPC_CHANNELS.MODELS_SET_SETTINGS, IPC_CHANNELS.MODELS_AUDIT,
      ]) {
        try { ipcMain.removeHandler(ch); } catch (_) { /* 未注册 */ }
      }
    },
  };
}

module.exports = { registerModelIpc };
