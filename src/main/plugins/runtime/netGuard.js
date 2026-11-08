'use strict';
/**
 * 出站网络封锁（插件进程内的最后一道闸）。
 *
 * 防的是**误用**，不是防恶意 —— 真正的边界在架构上：插件拿不到端点的 baseUrl，
 * 也拿不到密钥（密钥只存在主进程，出站一律由宿主代发，见设计方案 §12.7）。
 * 但如果插件作者顺手写了 `fetch('https://api.openai.com/...')`，今天的代码会
 * 真的发出去：请求里没有密钥所以失败，用户看到的是"模型调不通"，而真实原因
 * 是"你绕过了宿主"。更糟的情况是插件把用户数据发给自己的服务器 —— 那时代码里
 * 不会有一行 `permissions.net` 声明，安装弹窗上也不会有任何提示。
 *
 * 所以这里把整条出站路径堵死，并给出一条能直接照做的错误信息：
 *   · Module._load 拦截 http / https / http2 / net / tls / dgram / dns / undici
 *   · 覆盖全局 fetch / WebSocket / EventSource（Node 18+ 的 fetch 走内置 undici，
 *     不经过 Module._load，只拦 require 是拦不住的）
 *
 * 需要联网的插件没有例外通道：模型、TTS、伴奏全部走 ctx.models.invoke()，
 * 由宿主按端点配置、ACL 与审计统一出站。这是"随处可调用"与"密钥不外泄"能同时
 * 成立的前提 —— 一旦允许插件自带 HTTP，端点鉴权就形同虚设。
 */
const Module = require('node:module');
const path = require('node:path');

/** 拦掉的模块名（`node:` 前缀在校验时剥离）。 */
const BLOCKED_MODULES = Object.freeze([
  'http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'dns/promises', 'undici',
]);

const GUARD_FLAG = Symbol.for('sxs.plugin.netGuard');

function blockMessage(what) {
  // 不加 `[plugin:xxx]` 前缀：宿主在写插件日志时已经带了，重复两层反而难读。
  return [
    `插件进程不允许自建网络连接（已拦截 ${what}）。`,
    '模型 / TTS / 伴奏等能力请用 ctx.models.invoke({ task, input })：',
    '宿主负责选择端点、征求用户同意并统一出站，插件既不需要也拿不到密钥。',
    '如果你确实需要访问自建服务，请把它注册成端点（permissions.models: ["provide"]）。',
  ].join('');
}

/**
 * 安装封锁。幂等：同一个进程重复调用只生效一次。
 *
 * @param {{pluginId?:string, log?:(level:string,msg:string)=>void}} [opts]
 * @returns {{ blocked: string[], dispose: Function }}
 */
function installNetworkGuard(opts = {}) {
  if (globalThis[GUARD_FLAG]) return globalThis[GUARD_FLAG];

  const blocked = [];
  const originalLoad = Module._load;

  const deny = (what) => {
    const err = new Error(blockMessage(what));
    err.code = 'PLUGIN_NET_BLOCKED';
    return err;
  };

  Module._load = function guardedLoad(request, parent, isMain) {
    const name = String(request || '').replace(/^node:/, '');
    if (BLOCKED_MODULES.includes(name)) {
      // 放行 Node / Electron 自身的加载链，只拦"落在磁盘上的真实模块"。
      // ⚠️ 不能用 `from.includes('electron')` 这种子串判断：本仓库就装在
      // `D:\Document\electron\SXSEditor`，路径里带 "electron" 会把整个项目
      // 当成运行时内部模块，封锁直接失效（CI 的 Windows job 上正好命中）。
      // 判据改成三条硬事实：没有父模块（内建）、父模块是 node: 伪路径、
      // 或父模块位于 Node 运行时目录内。
      const from = parent && parent.filename ? String(parent.filename) : '';
      const runtimeDir = path.dirname(process.execPath).replace(/\\/g, '/').toLowerCase();
      const fromNorm = from.replace(/\\/g, '/').toLowerCase();
      const internal = !from
        || from.startsWith('node:')
        || !path.isAbsolute(from)
        || (runtimeDir !== '' && fromNorm.startsWith(runtimeDir + '/'));
      if (!internal) {
        blocked.push(name);
        const err = deny(name);
        if (typeof opts.log === 'function') opts.log('warn', err.message);
        throw err;
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  // 全局 fetch / WebSocket / EventSource：不走 Module._load，必须单独覆盖。
  const globals = ['fetch', 'WebSocket', 'EventSource'];
  for (const key of globals) {
    if (typeof globalThis[key] !== 'function') continue;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: function blockedNetworkGlobal() {
        blocked.push(key);
        const err = deny(key);
        if (typeof opts.log === 'function') opts.log('warn', err.message);
        // fetch 的调用方习惯 .catch，直接抛也能被 await 捕获；两者都可。
        throw err;
      },
    });
  }

  const handle = {
    blocked,
    dispose() {
      Module._load = originalLoad;
      delete globalThis[GUARD_FLAG];
    },
  };
  globalThis[GUARD_FLAG] = handle;
  return handle;
}

module.exports = { installNetworkGuard, BLOCKED_MODULES };
