'use strict';
/**
 * `plugin://` 自定义协议 —— 插件面板的静态资源来源。
 *
 * 为什么不用 file://：file 协议的 origin 不可控，且宿主页面（dev 下是 http://localhost）
 * 无法把 file:// 里的插件内容当成一个独立源来隔离。自定义标准协议给出稳定 origin
 * （`plugin://<id>`），配合 iframe 的 `sandbox="allow-scripts"`（不给 same-origin）
 * 形成"双重隔离"：插件既没有 host 的 DOM，也没有自己的持久存储。
 *
 * 路径夹紧与 onnx:// 的写法一致：前缀比较必须带 `path.sep`，否则
 * `/home/user` 与 `/home/userevil` 会被判成同一个根。
 */
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 面板文档的 CSP：不允许外链脚本、不允许联网。
 *
 * ⚠️ 为什么 script-src 里既有 `'self'` 又有 `plugin:`：
 * 面板所在 iframe 是 `sandbox="allow-scripts"`（**没有** allow-same-origin），
 * 于是文档的 origin 是 opaque（唯一源）。而 `'self'` 是按"与文档同源"来匹配的，
 * 对 opaque origin 语义上匹配不到任何真实 URL —— 只写 `'self'` 有把面板自己的
 * JS 一起挡掉的风险（表现为面板空白、控制台一条 CSP 拒绝）。
 * scheme-source（`plugin:`）只按 URL 的协议匹配，与文档 origin 无关，因此可靠。
 *
 * 放行整个 `plugin:` 协议不等于放行外网：能命中它的只有本协议 handler，
 * 而 handler 只从"已加载插件"的目录里读文件（见下方路径夹紧）。
 */
const PANEL_CSP = [
  "default-src 'self' plugin:",
  "script-src 'self' plugin:",
  "style-src 'self' 'unsafe-inline' plugin:",
  "img-src 'self' data: plugin:",
  "media-src 'self' plugin:",
  "font-src 'self' plugin:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** 必须在 app ready 之前调用。 */
function registerSchemePrivileges(protocolModule) {
  const proto = protocolModule || require('electron').protocol;
  proto.registerSchemesAsPrivileged([{
    scheme: 'plugin',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: false,
      bypassCSP: false,
    },
  }]);
}

/**
 * app ready 之后注册 handler。
 * @param {{resolvePluginDir:(id:string)=>string|null}} options
 */
function registerHandler(options) {
  const { protocol } = require('electron');
  const resolvePluginDir = options.resolvePluginDir;

  protocol.handle('plugin', async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch (_) {
      return new Response('bad url', { status: 400 });
    }
    const id = url.hostname;
    const dir = resolvePluginDir(id);
    if (!dir) {
      return new Response('plugin not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }

    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.resolve(dir, rel);
    const root = path.resolve(dir);
    if (target !== root && !target.startsWith(root + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }

    let data;
    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        data = fs.readFileSync(path.join(target, 'index.html'));
      } else {
        data = fs.readFileSync(target);
      }
    } catch (_) {
      return new Response('not found', { status: 404 });
    }

    const ext = path.extname(target === root ? 'index.html' : target).toLowerCase();
    const isDoc = ext === '.html' || ext === '.htm';
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
      // 插件面板不允许被任意站点嵌入；只有宿主窗口（file:// 或 localhost）可以
      'x-content-type-options': 'nosniff',
      // 宿主窗口开了 Cross-Origin-Embedder-Policy: require-corp（为了 SharedArrayBuffer），
      // 于是每个跨源子资源都必须显式声明 CORP，否则被 COEP 拦成
      // ERR_BLOCKED_BY_RESPONSE —— iframe 里只剩一张空白错误页。
      // plugin:// 与宿主（http://localhost 或 file://）永远是跨源的，所以这里必须给。
      'cross-origin-resource-policy': 'cross-origin',
    };
    if (isDoc) headers['content-security-policy'] = PANEL_CSP;
    return new Response(data, { status: 200, headers });
  });
}

/** 生成面板 URL。nonce 仅用于日志与"同一插件多面板"区分，不做鉴权。 */
function panelUrl(pluginId, entry, nonce) {
  const clean = String(entry || '').replace(/^\/+/, '');
  const suffix = nonce ? `?n=${encodeURIComponent(nonce)}` : '';
  return `plugin://${pluginId}/${clean}${suffix}`;
}

module.exports = { registerSchemePrivileges, registerHandler, panelUrl, PANEL_CSP, MIME };
