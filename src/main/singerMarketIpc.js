/**
 * Singer Market IPC handlers.
 *
 * Acts as a thin proxy between the Singer Market renderer window and the
 * Cloudflare Workers backend (singer-files.15240287482.workers.dev).
 *
 * All HTTP requests are made from the main process (using Node's `https` /
 * `http` modules) rather than the renderer so that:
 *   1. CSP `connect-src 'self'` does not need to be widened.
 *   2. The Bearer token never enters any renderer's JavaScript context.
 *   3. File uploads stream directly from disk for large .sxssinger files
 *      (only the small multipart prefix/suffix is held in memory).
 *
 * Tokens (sfu_*, sf_*) are persisted to userData/singer-market-token.json so
 * the user stays logged in across launches. The file is created with mode
 * 0o600 (owner read/write only) on POSIX systems.
 *
 * API base override: `*.workers.dev` is DNS-poisoned + SNI-blocked on some
 * networks (notably mainland China). Users can point the client at a mirror
 * or a Workers custom domain without code changes:
 *   - set the SXS_SINGER_API_BASE environment variable, or
 *   - create userData/singer-market-api.json with { "apiBase": "https://..." }
 * The override is read once per launch.
 *
 * Every request is bounded by timeouts: a 5s socket-idle timeout (covers the
 * TLS/connect stage and stalled transfers) and a 30s hard ceiling, so a
 * poisoned IP that drops packets can no longer leave the market window
 * loading forever. Failures surface a clear "network unreachable" message.
 */

const { ipcMain, app } = require('electron');
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');
const net = require('node:net');
const { URL } = require('node:url');
const { t } = require('./locale');

const DEFAULT_API_BASE = 'https://singer-files.15240287482.workers.dev';
// Socket idle timeout (connect + TLS handshake + stalled reads) and a hard
// per-request ceiling so nothing can hang indefinitely.
const SOCKET_IDLE_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 30000;

const MSG_UNREACHABLE =
  'Unable to connect to the singer market service. It may be blocked or unreachable from your network.';
const MSG_TIMEOUT =
  'Connection to the singer market service timed out. It may be blocked or unreachable from your network.';

const TOKEN_FILE = path.join(app.getPath('userData'), 'singer-market-token.json');

// Cached API base override (resolved lazily, once).
let _apiBase = null;

function getApiBase() {
  if (_apiBase) return _apiBase;
  const fromEnv = process.env.SXS_SINGER_API_BASE;
  if (fromEnv && /^https?:\/\//.test(fromEnv)) {
    _apiBase = fromEnv.replace(/\/+$/, '');
    return _apiBase;
  }
  try {
    const cfgPath = path.join(app.getPath('userData'), 'singer-market-api.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg && typeof cfg.apiBase === 'string' && /^https?:\/\//.test(cfg.apiBase)) {
        _apiBase = cfg.apiBase.replace(/\/+$/, '');
        return _apiBase;
      }
    }
  } catch (err) {
    console.warn('[SingerMarket] Failed to read API base override:', err.message);
  }
  return DEFAULT_API_BASE;
}

// In-memory cache of the current session token + user info.
let _session = null;

function loadSession() {
  if (_session) return _session;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const raw = fs.readFileSync(TOKEN_FILE, 'utf-8');
      _session = JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[SingerMarket] Failed to load saved session:', err.message);
  }
  return _session;
}

function saveSession(session) {
  _session = session;
  try {
    // Persist with mode 0o600 on POSIX. On Windows the mode is ignored.
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn('[SingerMarket] Failed to persist session:', err.message);
  }
}

function clearSession() {
  _session = null;
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch (err) {
    console.warn('[SingerMarket] Failed to remove session file:', err.message);
  }
}

function getToken() {
  const s = loadSession();
  return s ? s.token : null;
}

/**
 * Perform an HTTP/HTTPS request and resolve to { status, headers, body }.
 * `body` is a string for textual responses, or a Buffer for binary responses
 * (when `encoding` is null).
 *
 * Options:
 *   - bodyStream: a Readable stream to send as the request body (requires
 *     bodyLength so Content-Length can be set). The stream is piped to the
 *     socket, so large uploads never need to be buffered in memory.
 *   - onProgress(received, total): called as response data arrives (used for
 *     download progress; total comes from Content-Length, 0 when unknown).
 */
function request(method, urlPath, { headers = {}, body = null, bodyStream = null, bodyLength = null, encoding = 'utf-8', onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(getApiBase() + urlPath);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const finalHeaders = { ...headers };
    let bodyBuf = null;

    if (body != null) {
      if (Buffer.isBuffer(body)) {
        bodyBuf = body;
      } else if (typeof body === 'string') {
        bodyBuf = Buffer.from(body, 'utf-8');
      } else {
        bodyBuf = Buffer.from(JSON.stringify(body), 'utf-8');
        if (!finalHeaders['Content-Type']) {
          finalHeaders['Content-Type'] = 'application/json';
        }
      }
      finalHeaders['Content-Length'] = bodyBuf.length;
    } else if (bodyStream != null) {
      if (bodyLength == null) {
        reject(new Error('bodyStream requires bodyLength'));
        return;
      }
      finalHeaders['Content-Length'] = bodyLength;
    }

    const reqOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: finalHeaders,
    };

    let settled = false;
    let totalTimer = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      try { req.destroy(err); } catch (_) {}
      reject(err);
    };

    // Hard ceiling for the whole request lifecycle.
    totalTimer = setTimeout(() => fail(new Error(MSG_TIMEOUT)), TOTAL_TIMEOUT_MS);

    const req = lib.request(reqOptions, (res) => {
      const chunks = [];
      let received = 0;
      const total = parseInt(res.headers['content-length'], 10) || 0;
      res.on('data', (chunk) => {
        chunks.push(chunk);
        received += chunk.length;
        if (onProgress) {
          try { onProgress(received, total); } catch (_) {}
        }
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        if (totalTimer) clearTimeout(totalTimer);
        const buf = Buffer.concat(chunks);
        if (encoding === null) {
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        } else {
          resolve({ status: res.statusCode, headers: res.headers, body: buf.toString(encoding) });
        }
      });
      res.on('error', (err) => fail(new Error(`${MSG_UNREACHABLE} (${err.message})`)));
    });

    // Covers connect/TLS stage and stalled transfers (socket inactivity).
    req.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => fail(new Error(MSG_TIMEOUT)));
    req.on('error', (err) => fail(new Error(`${MSG_UNREACHABLE} (${err.message})`)));

    if (bodyStream != null) {
      bodyStream.on('error', (err) => fail(new Error(`${MSG_UNREACHABLE} (${err.message})`)));
      bodyStream.pipe(req);
    } else {
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    }
  });
}

/**
 * Add the Bearer token to the headers if a session exists.
 */
function withAuth(headers = {}) {
  const token = getToken();
  if (token) {
    return { ...headers, Authorization: `Bearer ${token}` };
  }
  return headers;
}

/**
 * Parse a JSON response body, returning null on parse failure.
 */
function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

/**
 * Extract a human-readable error message from a parsed API response.
 * The backend's error envelope is `{ error: { code, message } }`; older
 * endpoints may return a plain string. Falls back when nothing usable exists
 * so callers never surface `[object Object]` to the user.
 */
function extractError(data, fallback) {
  if (data && data.error != null) {
    if (typeof data.error === 'string') return data.error;
    if (typeof data.error === 'object' && typeof data.error.message === 'string') {
      return data.error.message;
    }
  }
  return fallback;
}

/**
 * Build multipart/form-data prefix/suffix buffers around a file payload.
 * The caller streams the file bytes between the two buffers, keeping memory
 * usage independent of the file size.
 * Returns { prefix, suffix, contentType }.
 */
function buildMultipartParts(fields, file) {
  const boundary = '----SingerMarketBoundary' + Math.random().toString(16).slice(2);
  const prefixParts = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value == null) continue;
    prefixParts.push(Buffer.from(`--${boundary}\r\n`));
    prefixParts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    prefixParts.push(Buffer.from(String(value) + '\r\n'));
  }

  if (file) {
    prefixParts.push(Buffer.from(`--${boundary}\r\n`));
    prefixParts.push(Buffer.from(
      `Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`
    ));
  }

  const suffix = Buffer.from(file ? `\r\n--${boundary}--\r\n` : `--${boundary}--\r\n`);
  return {
    prefix: Buffer.concat(prefixParts),
    suffix,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Build a complete multipart/form-data body from fields and an optional file.
 * Retained (buffer-based) for testing and small payloads; the upload handler
 * uses buildMultipartParts + a file stream instead.
 * Returns { body: Buffer, contentType: string }.
 */
function buildMultipart(fields, file) {
  const { prefix, suffix, contentType } = buildMultipartParts(fields, file);
  return {
    body: Buffer.concat([prefix, file ? file.data : Buffer.alloc(0), suffix]),
    contentType,
  };
}

// ---------------------------------------------------------------------------
// Network diagnostics — run when a request fails at the network layer.
//
// `*.workers.dev` is DNS-poisoned + SNI-blocked on mainland-China networks,
// so a connection failure there means "service not available in your region"
// rather than a generic outage. On failure we probe (results cached 10 min):
//   1. DNS resolution of the API host via the system resolver and AliDNS
//      (divergent answers are evidence of DNS poisoning).
//   2. A raw TCP connect probe to the API host (443) — distinguishes TCP-level
//      blocking from TLS/SNI reset.
//   3. Public-IP geolocation via several endpoints reachable from CN
//      (ip-api.com over HTTP, Baidu qifu, ipip), falling back to the system
//      timezone. Mainland China = country code CN (HK/MO/TW excluded).
// The renderer then shows a region-specific message plus these diagnostics
// (attempts, timeout settings, IPs) instead of a bare error.
// ---------------------------------------------------------------------------

const DIAG_CACHE_MS = 10 * 60 * 1000;
const DIAG_TIMEOUT_MS = 3500;
// Endpoints tried in order; first successful answer wins.
const GEO_ENDPOINTS = [
  { url: 'http://ip-api.com/json/?fields=status,message,country,countryCode,query,timezone', source: 'ip-api.com' },
  { url: 'https://qifu-api.baidubce.com/ip/local/geo/v1/district', source: 'qifu.baidu' },
  { url: 'https://myip.ipip.net/json', source: 'ipip.net' },
];
// Timezones treated as "probably mainland China" when geo lookup fails.
const CN_TIMEZONES = new Set(['Asia/Shanghai', 'Asia/Urumqi', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Kashgar']);
// Parts of China that are NOT the mainland (their IPs geolocate as "中国").
const NON_MAINLAND_CN = new Set(['香港', '澳门', '台湾', 'Hong Kong', 'Macao', 'Taiwan']);

let _diagCache = null;
let _diagInFlight = null;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Raw GET returning parsed JSON. Independent of the API_BASE override. */
function rawGetJson(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: { 'User-Agent': 'SXSEditor/1.0', Accept: 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (e) {
          reject(new Error('invalid JSON response'));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** Best-effort parse of the various geo-IP response shapes. */
function parseGeo(json) {
  if (!json || typeof json !== 'object') return null;
  // ip-api.com: { status, country, countryCode, query, timezone }
  if (json.countryCode) {
    return {
      country: String(json.countryCode).toUpperCase(),
      countryName: json.country || '',
      ip: json.query || null,
      timezone: json.timezone || null,
    };
  }
  // myip.ipip.net: { ret:'ok', data:{ ip, location:['中国','香港',...] } }
  if (json.ret === 'ok' && json.data && Array.isArray(json.data.location)) {
    const loc = json.data.location;
    const top = loc[0] || '';
    const sub = loc[1] || '';
    if (top === '中国' && !NON_MAINLAND_CN.has(sub)) {
      return { country: 'CN', countryName: '中国', ip: json.data.ip || null, timezone: null };
    }
    return { country: null, countryName: sub || top, ip: json.data.ip || null, timezone: null };
  }
  // Baidu qifu: { code:'CHINA'|..., ip, data:{ country:'中国', ... } } (shape varies)
  if (json.ip) {
    if (json.code === 'CHINA') {
      return { country: 'CN', countryName: 'China', ip: json.ip, timezone: null };
    }
    const countryName = json.data && json.data.country;
    if (countryName === '中国') {
      return { country: 'CN', countryName: '中国', ip: json.ip, timezone: null };
    }
    if (countryName) {
      return { country: null, countryName, ip: json.ip, timezone: null };
    }
  }
  return null;
}

/** TCP connect probe (no TLS) — reports whether the port is even reachable. */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const finish = (ok, detail) => {
      socket.destroy();
      if (ok) resolve({ ms: Date.now() - started });
      else reject(new Error(detail));
    };
    socket.setTimeout(timeoutMs, () => finish(false, 'timeout'));
    socket.once('connect', () => finish(true));
    socket.once('error', (e) => finish(false, e.code || e.message));
  });
}

async function diagnoseNetwork(force = false) {
  if (!force && _diagCache && Date.now() - _diagCache.at < DIAG_CACHE_MS) return _diagCache;
  if (_diagInFlight) return _diagInFlight;
  _diagInFlight = (async () => {
    const apiHost = new URL(getApiBase()).hostname;
    const attempts = [];

    // 1. DNS — system resolver vs AliDNS (divergence ⇒ poisoning evidence).
    let systemDns = null;
    let aliDns = null;
    try {
      const t0 = Date.now();
      systemDns = await withTimeout(dns.promises.lookup(apiHost, { all: true }), DIAG_TIMEOUT_MS, 'dns-system');
      attempts.push({
        name: 'DNS(system)',
        ok: true,
        detail: systemDns.map((a) => a.address).join(', '),
        ms: Date.now() - t0,
      });
    } catch (e) {
      attempts.push({ name: 'DNS(system)', ok: false, detail: e.message, ms: null });
    }
    try {
      const resolver = new dns.promises.Resolver();
      resolver.setServers(['223.5.5.5']);
      const t0 = Date.now();
      aliDns = await withTimeout(resolver.resolve4(apiHost), DIAG_TIMEOUT_MS, 'dns-ali');
      attempts.push({ name: 'DNS(AliDNS 223.5.5.5)', ok: true, detail: aliDns.join(', '), ms: Date.now() - t0 });
    } catch (e) {
      attempts.push({ name: 'DNS(AliDNS 223.5.5.5)', ok: false, detail: e.message, ms: null });
    }

    // 2. Raw TCP connect to the API host.
    try {
      const probe = await withTimeout(tcpProbe(apiHost, 443, DIAG_TIMEOUT_MS), DIAG_TIMEOUT_MS + 500, 'tcp');
      attempts.push({ name: `TCP ${apiHost}:443`, ok: true, detail: 'connect ok', ms: probe.ms });
    } catch (e) {
      attempts.push({ name: `TCP ${apiHost}:443`, ok: false, detail: e.message, ms: null });
    }

    // 3. Public-IP geolocation.
    let geo = null;
    let geoSource = 'unknown';
    for (const ep of GEO_ENDPOINTS) {
      if (geo) break;
      try {
        const t0 = Date.now();
        const json = await withTimeout(rawGetJson(ep.url, DIAG_TIMEOUT_MS), DIAG_TIMEOUT_MS + 500, 'geo');
        const parsed = parseGeo(json);
        if (parsed && parsed.country) {
          geo = parsed;
          geoSource = ep.source;
          attempts.push({
            name: `Geo(${ep.source})`,
            ok: true,
            detail: `${parsed.ip || '?'} → ${parsed.countryName || parsed.country}`,
            ms: Date.now() - t0,
          });
        } else if (parsed) {
          geo = parsed;
          geoSource = ep.source;
          attempts.push({
            name: `Geo(${ep.source})`,
            ok: true,
            detail: `${parsed.ip || '?'} → ${parsed.countryName || 'unknown country'}`,
            ms: Date.now() - t0,
          });
        } else {
          attempts.push({ name: `Geo(${ep.source})`, ok: false, detail: 'unrecognized response', ms: Date.now() - t0 });
        }
      } catch (e) {
        attempts.push({ name: `Geo(${ep.source})`, ok: false, detail: e.message, ms: null });
      }
    }
    if (!geo || !geo.country) {
      // Timezone fallback — weak signal, marked as such.
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz && CN_TIMEZONES.has(tz)) {
          geo = { country: 'CN', countryName: 'China (timezone heuristic)', ip: (geo && geo.ip) || null, timezone: tz };
          geoSource = 'timezone-fallback';
          attempts.push({ name: 'Geo(timezone-fallback)', ok: true, detail: tz, ms: null });
        }
      } catch (_) {}
    }

    const result = {
      at: Date.now(),
      apiHost,
      apiDns: {
        system: systemDns ? systemDns.map((a) => a.address) : null,
        ali: Array.isArray(aliDns) ? aliDns : null,
      },
      geo: geo || null,
      geoSource,
      isMainlandChina: !!(geo && geo.country === 'CN'),
      attempts,
    };
    _diagCache = result;
    return result;
  })();
  try {
    return await _diagInFlight;
  } finally {
    _diagInFlight = null;
  }
}

/** Test hook: seed the diagnostics cache without touching the network. */
function _setDiagCache(value) {
  _diagCache = value;
}

/** Multi-line human-readable diagnostics (localized via main-process locale). */
function formatDiagnostics(diag, err) {
  const lines = [];
  const fail = t('singerMarket.diagFailed');
  lines.push(`${t('singerMarket.diagApiAddress')}: ${diag.apiHost}`);
  const sys = diag.apiDns.system ? diag.apiDns.system.join(', ') : fail;
  const ali = diag.apiDns.ali ? diag.apiDns.ali.join(', ') : fail;
  lines.push(`${t('singerMarket.diagDns')}: ${t('singerMarket.diagSystem')}=${sys}; AliDNS=${ali}`);
  lines.push(`${t('singerMarket.diagTimeout')}: socket ${SOCKET_IDLE_TIMEOUT_MS / 1000}s / total ${TOTAL_TIMEOUT_MS / 1000}s`);
  if (diag.geo && diag.geo.ip) {
    lines.push(`${t('singerMarket.diagRegion')}: ${diag.geo.ip} (${diag.geo.countryName || diag.geo.country || '?'}, ${diag.geoSource})`);
  } else if (diag.geo) {
    lines.push(`${t('singerMarket.diagRegion')}: ${diag.geo.countryName || diag.geo.country || '?'} (${diag.geoSource})`);
  } else {
    lines.push(`${t('singerMarket.diagRegion')}: ${t('singerMarket.diagUnknown')}`);
  }
  lines.push(`${t('singerMarket.diagAttempts')}:`);
  for (const a of diag.attempts) {
    lines.push(`  - ${a.name}: ${a.ok ? 'OK' : fail}${a.detail ? ` (${a.detail})` : ''}${a.ms != null ? ` [${a.ms}ms]` : ''}`);
  }
  lines.push(`${t('singerMarket.diagLastError')}: ${err && err.message ? err.message : String(err)}`);
  return lines.join('\n');
}

/**
 * Convert a caught error into the IPC payload. Network-layer failures are
 * enriched with diagnostics; on mainland-China networks the message becomes
 * "service not available in your region" plus probe details (attempts,
 * timeouts, IPs). Non-network errors pass through unchanged.
 */
async function errorPayload(err, diagProvider = diagnoseNetwork) {
  const msg = err && err.message ? err.message : String(err);
  const isNetworkError = msg.startsWith(MSG_UNREACHABLE) || msg.startsWith(MSG_TIMEOUT);
  if (!isNetworkError) {
    return { success: false, error: msg };
  }
  let diag = null;
  try {
    diag = await diagProvider();
  } catch (_) {}
  if (diag && diag.isMainlandChina) {
    return {
      success: false,
      region: 'CN',
      error: `${t('singerMarket.serviceUnavailableCN')}\n\n${formatDiagnostics(diag, err)}`,
    };
  }
  return { success: false, region: diag && diag.geo ? diag.geo.country : null, error: msg };
}

function registerSingerMarketIpc() {
  // Build marker: makes it instantly verifiable in the main-process log that
  // the running app includes the timeout/region-diagnostics code.
  console.log('[SingerMarket] main build 2026-09-26.3 (licenses API + upload license field)');

  // ----- Auth -----
  ipcMain.handle('singer-market:register', async (event, { username, password }) => {
    try {
      const res = await request('POST', '/api/auth/register', {
        body: { username, password },
      });
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300 && data.token) {
        saveSession({ token: data.token, user: data.user });
        return { success: true, user: data.user };
      }
      return { success: false, error: extractError(data, `Registration failed (HTTP ${res.status})`) };
    } catch (err) {
      return await errorPayload(err);
    }
  });

  ipcMain.handle('singer-market:login', async (event, { username, password }) => {
    try {
      const res = await request('POST', '/api/auth/login', {
        body: { username, password },
      });
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300 && data.token) {
        saveSession({ token: data.token, user: data.user });
        return { success: true, user: data.user };
      }
      return { success: false, error: extractError(data, `Login failed (HTTP ${res.status})`) };
    } catch (err) {
      return await errorPayload(err);
    }
  });

  ipcMain.handle('singer-market:logout', async () => {
    try {
      await request('POST', '/api/auth/logout', { headers: withAuth() });
    } catch (_) {
      // Ignore network errors — we clear the local session regardless.
    }
    clearSession();
    return { success: true };
  });

  ipcMain.handle('singer-market:me', async () => {
    if (!getToken()) return { success: false, user: null };
    try {
      const res = await request('GET', '/api/auth/me', { headers: withAuth() });
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300 && data.user) {
        // Update cached user info
        const session = loadSession();
        if (session) {
          saveSession({ ...session, user: data.user });
        }
        return { success: true, user: data.user };
      }
      if (res.status === 401) {
        // Token expired/revoked — clear local session.
        clearSession();
      }
      return { success: false, user: null };
    } catch (err) {
      return { success: false, user: null, error: err.message };
    }
  });

  // ----- File listing / search / filter -----
  ipcMain.handle('singer-market:list', async (event, params = {}) => {
    try {
      const query = new URLSearchParams();
      // Only show public files for browsing (private files only visible to owner)
      query.set('visibility', 'public');
      if (params.tags && Array.isArray(params.tags) && params.tags.length > 0) {
        query.set('tags', params.tags.join(','));
        query.set('tag_mode', params.tag_mode || 'and');
      }
      if (params.q) query.set('q', params.q);
      if (params.page) query.set('page', String(params.page));
      // Backend page-size parameter is `size` (the list envelope echoes it).
      if (params.limit) query.set('size', String(params.limit));

      const res = await request('GET', `/api/files?${query.toString()}`);
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300) {
        return { success: true, data };
      }
      return { success: false, error: extractError(data, `List failed (HTTP ${res.status})`) };
    } catch (err) {
      return await errorPayload(err);
    }
  });

  ipcMain.handle('singer-market:file-detail', async (event, fileId) => {
    try {
      const res = await request('GET', `/api/files/${encodeURIComponent(fileId)}`, {
        headers: withAuth(),
      });
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300) {
        return { success: true, data };
      }
      return { success: false, error: extractError(data, `Fetch failed (HTTP ${res.status})`) };
    } catch (err) {
      return await errorPayload(err);
    }
  });

  // ----- Tags -----
  ipcMain.handle('singer-market:tags', async (event, params = {}) => {
    try {
      const query = new URLSearchParams();
      if (params.q) query.set('q', params.q);
      if (params.suggest) query.set('suggest', '1');
      if (params.exact) query.set('exact', '1');
      if (params.limit) query.set('limit', String(params.limit));

      const res = await request('GET', `/api/tags?${query.toString()}`);
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300) {
        return { success: true, data };
      }
      return { success: false, error: extractError(data, `Tags fetch failed (HTTP ${res.status})`) };
    } catch (err) {
      return await errorPayload(err);
    }
  });

  // ----- Licenses -----
  // License catalog (13 presets + optional custom slot). Used by the upload
  // dialog's license selector and shown as metadata on file detail views.
  ipcMain.handle('singer-market:licenses', async () => {
    try {
      const res = await request('GET', '/api/licenses');
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300) {
        return { success: true, data };
      }
      return { success: false, error: extractError(data, `Licenses fetch failed (HTTP ${res.status})`) };
    } catch (err) {
      return await errorPayload(err);
    }
  });

  // ----- Upload -----
  // The file is streamed from disk between small multipart prefix/suffix
  // buffers, so even tens-of-MB .sxssinger files never double the memory.
  ipcMain.handle('singer-market:upload', async (event, payload) => {
    if (!getToken()) {
      return { success: false, error: 'Not logged in' };
    }
    let fileStream = null;
    try {
      const { filePath, description, tags, visibility, license } = payload;
      if (!filePath) return { success: false, error: 'Missing file path' };

      const fileStat = await fs.promises.stat(filePath);
      const filename = path.basename(filePath);

      const fields = {};
      if (description) fields.description = description;
      if (tags) fields.tags = tags;
      if (visibility) fields.visibility = visibility;
      // `license` is accepted server-side as an alias of license_key
      // (e.g. "cc_by_4_0"). See docs/dev/singer-market.html.
      if (license) fields.license = license;

      const { prefix, suffix, contentType } = buildMultipartParts(fields, {
        filename,
        contentType: 'application/octet-stream',
      });
      const contentLength = prefix.length + fileStat.size + suffix.length;

      fileStream = fs.createReadStream(filePath);
      const res = await request('POST', '/api/files', {
        headers: withAuth({ 'Content-Type': contentType }),
        bodyStream: fileStream,
        bodyLength: contentLength,
      });
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300) {
        return { success: true, data };
      }
      return { success: false, error: extractError(data, `Upload failed (HTTP ${res.status})`) };
    } catch (err) {
      return await errorPayload(err);
    } finally {
      if (fileStream) fileStream.destroy();
    }
  });

  // ----- Download -----
  // Returns the raw file bytes + suggested filename. The renderer is
  // responsible for prompting the user for a save location and writing the
  // file to disk via the existing file:saveFile IPC. Progress is streamed to
  // the sender via 'singer-market:download-progress' events.
  ipcMain.handle('singer-market:download', async (event, fileId) => {
    try {
      const res = await request('GET', `/api/files/${encodeURIComponent(fileId)}/download`, {
        headers: withAuth(),
        encoding: null,
        onProgress: (received, total) => {
          try {
            if (!event.sender.isDestroyed()) {
              event.sender.send('singer-market:download-progress', { fileId, received, total });
            }
          } catch (_) {}
        },
      });
      if (res.status >= 200 && res.status < 300) {
        // Try to extract a filename from Content-Disposition
        const cd = res.headers['content-disposition'] || '';
        let filename = 'singer.sxssinger';
        const match = cd.match(/filename="?([^";]+)"?/i);
        if (match) filename = match[1];
        return {
          success: true,
          data: {
            buffer: res.body.buffer.slice(
              res.body.byteOffset,
              res.body.byteOffset + res.body.byteLength
            ),
            filename,
            contentType: res.headers['content-type'] || 'application/octet-stream',
          },
        };
      }
      let errorMsg = `Download failed (HTTP ${res.status})`;
      try {
        const errBody = JSON.parse(res.body.toString('utf-8'));
        errorMsg = extractError(errBody, errorMsg);
      } catch (_) {}
      return { success: false, error: errorMsg };
    } catch (err) {
      return await errorPayload(err);
    }
  });

  // ----- Pick .sxssinger file for upload (uses native dialog) -----
  ipcMain.handle('singer-market:pick-file', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
      title: 'Select a .sxssinger file',
      filters: [{ name: 'SXS Singer', extensions: ['sxssinger'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    const filePath = result.filePaths[0];
    // Authorize the path so file:readFileBuffer etc. work later if needed.
    try {
      const { authorizePath } = require('./security');
      authorizePath(filePath);
    } catch (_) {}
    return { success: true, filePath, filename: path.basename(filePath) };
  });

  // ----- Pick save destination for downloaded .sxssinger file -----
  ipcMain.handle('singer-market:pick-save-path', async (event, suggestedName) => {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog({
      title: 'Save Singer File',
      defaultPath: suggestedName || 'singer.sxssinger',
      filters: [{ name: 'SXS Singer', extensions: ['sxssinger'] }],
    });
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }
    // Authorize the path so file:saveFile works.
    try {
      const { authorizePath } = require('./security');
      authorizePath(result.filePath);
    } catch (_) {}
    return { success: true, filePath: result.filePath };
  });

  // ----- Get server health -----
  ipcMain.handle('singer-market:health', async () => {
    try {
      const res = await request('GET', '/health');
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300) {
        return { success: true, data };
      }
      return { success: false, error: `Health check failed (HTTP ${res.status})` };
    } catch (err) {
      return await errorPayload(err);
    }
  });
}

module.exports = {
  registerSingerMarketIpc,
  // Exported for testing
  _internal: {
    request, buildMultipart, buildMultipartParts, withAuth,
    loadSession, saveSession, clearSession, extractError, getApiBase,
    errorPayload, diagnoseNetwork, formatDiagnostics, parseGeo,
    _setDiagCache,
    MSG_UNREACHABLE, MSG_TIMEOUT,
  },
};
