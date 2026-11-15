'use strict';

/**
 * API Provider 管理 IPC。
 *
 * 渲染层只拿到结构化结果与已本地化、可直接展示的错误文案；
 * 密钥明文永远不出主进程。所有 handler 走 safeHandle，保证异常不会被静默吞掉。
 */
const { safeHandle } = require('./ipcSafe');
const { IPC_CHANNELS } = require('../shared/ipcChannels');
const store = require('./apiProviderStore');
const { healthCheck } = require('./apiInference');

function registerApiIpc() {
  safeHandle(IPC_CHANNELS.API_PROVIDERS_LIST, async () => store.list());

  safeHandle(IPC_CHANNELS.API_PROVIDER_SAVE, async (_event, input) => {
    return store.save(input || {});
  });

  safeHandle(IPC_CHANNELS.API_PROVIDER_DELETE, async (_event, id) => {
    return store.remove(String(id || ''));
  });

  safeHandle(IPC_CHANNELS.API_PROVIDER_SET_ACTIVE, async (_event, id) => {
    return store.setActive(String(id || ''));
  });

  safeHandle(IPC_CHANNELS.API_PROVIDER_RESET_BUILTIN, async () => store.resetBuiltin());

  // 连接测试：不抛异常，返回 {ok,message,kind}，UI 直接在状态区显示。
  // 401/403 鉴权、429 限流、超时、DNS 失败都会带上明确原因。
  safeHandle(IPC_CHANNELS.API_PROVIDER_TEST, async (_event, draft) => {
    try {
      const runtime = store.runtimeFromDraft(draft || {});
      return await healthCheck({ runtime });
    } catch (err) {
      return { ok: false, message: err?.message || String(err) };
    }
  });
}

module.exports = { registerApiIpc };
