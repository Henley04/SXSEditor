'use strict';
/**
 * 插件市场客户端（M6 第 2 段）。
 *
 * 定位：**接口先定，服务后接**。这里不假设存在一个"官方市场"，也不内置地址。
 * 用户/企业自己加源（HTTPS 索引 JSON），搜索、预览、下载、安装走同一条路。
 *
 * 为什么"预览"要下载整包
 * ----------------------
 * 索引里的签名是**源的自述**，源本身没有签名覆盖，改一个字段就能让列表显示
 * "Example Studio 已签名"。真正能回答"这是谁签的"的只有包里的 signature.json。
 * 所以预览 = 下载到缓存 → 校验 sha256/大小 → 用安装器同一套逻辑验签 →
 * 把"索引怎么说"和"包里实际是什么"并排给用户看，不一致就明确告警。
 *
 * 网络边界
 * --------
 *   · 只接受 https（`file://` 源需显式设置 SXSEDITOR_ALLOW_FILE_SOURCES=1，
 *     给离线/内网镜像与走查用，默认关闭）；
 *   · 单份索引 ≤ 2 MB，包 ≤ manifest 允许的上限，重定向 ≤ 3 跳且不得降级为 http；
 *   · 不做后台轮询，不自动更新：每次操作都要有用户动作。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { fileURLToPath, pathToFileURL } = require('node:url');

const market = require('../../shared/pluginMarket.js');
const { PACKAGE } = require('../../shared/pluginApi.js');
const store = require('./PluginStateStore.js');

const SOURCES_FILE = 'market-sources.json';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SOURCES = 16;
const FETCH_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_REDIRECTS = 3;

function sourcesFile() {
  return path.join(store.paths().state, SOURCES_FILE);
}

function marketDir() {
  const dir = path.join(store.paths().state, 'market');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function allowFileSources() {
  return process.env.SXSEDITOR_ALLOW_FILE_SOURCES === '1';
}

function readSources() {
  const raw = store.readJson(sourcesFile(), null);
  const list = raw && Array.isArray(raw.sources) ? raw.sources : [];
  return list.filter((s) => s && typeof s.url === 'string' && s.url);
}

function writeSources(list) {
  store.writeJsonAtomic(sourcesFile(), { sources: list });
}

function sourceIdFor(url) {
  return `src-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 10)}`;
}

function publicSource(source) {
  return {
    id: source.id,
    name: source.name || source.url,
    url: source.url,
    addedAt: source.addedAt || 0,
    kind: source.url.startsWith('file://') ? 'file' : 'https',
  };
}

function listSources() {
  return readSources().map(publicSource);
}

/**
 * 加一个源。
 *
 * 只收 https（或显式开启的 file://）。收到 http 就拒绝：市场索引决定"用户会看到
 * 哪些插件"，它值得一张证书；在 2026 年让索引走明文，等于把"装哪个包"交给同网段。
 */
function addSource(input = {}) {
  const raw = String(input.url || '').trim();
  if (!raw) return { ok: false, code: 'INVALID_SOURCE', error: '缺少索引地址' };

  // 判断"这是路径还是 URL"。盘符要单独认：`D:\mirror` 会被 URL 规则读成
  // scheme = "d"，于是合法的 Windows 路径在开启离线源后被当成未知协议拒掉。
  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(raw);
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !isWindowsPath;

  let url = raw;
  if (!hasScheme) {
    // 离线源：允许直接给绝对路径（比让用户手拼 `file:///D:/...` 现实）。
    if (!allowFileSources()) {
      return {
        ok: false,
        code: 'INVALID_SOURCE',
        error: '索引地址必须是 https://（离线源需显式设置 SXSEDITOR_ALLOW_FILE_SOURCES=1 后重启）',
      };
    }
    if (!path.isAbsolute(raw)) {
      return { ok: false, code: 'INVALID_SOURCE', error: 'file:// 源必须是绝对路径' };
    }
    url = pathToFileURL(path.resolve(raw)).href;
  } else if (/^file:/i.test(raw)) {
    if (!allowFileSources()) {
      return {
        ok: false,
        code: 'INVALID_SOURCE',
        error: '默认不接受 file:// 源。离线镜像请设置 SXSEDITOR_ALLOW_FILE_SOURCES=1 后重启',
      };
    }
    // 统一走 fileURLToPath 再回写规范形式。`file://D:\a\b.json` 这种手写形态
    // 在 WHATWG 里 host 会变成盘符，pathname 只剩 `\a\b.json`，直接拿去 stat
    // 会读不到文件（Windows 上表现为"源加成功、搜索结果永远为空"）。
    const asPath = filePathOf(raw);
    if (!asPath || !path.isAbsolute(asPath)) {
      return {
        ok: false,
        code: 'INVALID_SOURCE',
        error: 'file:// 源必须是绝对路径，形如 file:///C:/mirror/index.json',
      };
    }
    url = pathToFileURL(path.resolve(asPath)).href;
  } else if (!/^https:\/\//i.test(raw)) {
    return { ok: false, code: 'INVALID_SOURCE', error: '索引地址必须是 https://（离线源需显式开启 file://）' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return { ok: false, code: 'INVALID_SOURCE', error: '索引地址不是合法 URL' };
  }
  if (parsed.protocol === 'https:' && parsed.username) {
    // 带凭据的 URL 会被写进日志与源列表，等于把口令展示给任何看屏幕的人。
    return { ok: false, code: 'INVALID_SOURCE', error: '索引地址不能带用户名/口令' };
  }

  const list = readSources();
  const existed = list.find((s) => s.url === url);
  if (existed) return { ok: true, source: publicSource(existed), existed: true };
  if (list.length >= MAX_SOURCES) {
    return { ok: false, code: 'TOO_MANY_SOURCES', error: `最多 ${MAX_SOURCES} 个源` };
  }

  const source = {
    id: sourceIdFor(url),
    name: String(input.name || '').trim().slice(0, 80) || parsed.hostname || url,
    url,
    addedAt: Date.now(),
  };
  list.push(source);
  writeSources(list);
  invalidate(source.id);
  store.audit('market-source-add', source.id, { url, name: source.name });
  return { ok: true, source: publicSource(source), existed: false };
}

function removeSource(id) {
  const list = readSources();
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return { ok: false, code: 'SOURCE_NOT_FOUND', error: `没有这个源：${id}` };
  const [removed] = list.splice(idx, 1);
  writeSources(list);
  invalidate(id);
  store.audit('market-source-remove', id, { url: removed.url });
  return { ok: true, removed: publicSource(removed) };
}

// ------------------------------------------------------------ 取索引

const indexCache = new Map(); // sourceUrl → { at, parsed }

function invalidate(sourceId) {
  for (const url of indexCache.keys()) {
    if (sourceIdFor(url) === sourceId) indexCache.delete(url);
  }
}

function filePathOf(fileUrl) {
  try {
    const u = new URL(fileUrl);
    if (u.protocol !== 'file:') return '';
    // 不用 decodeURIComponent(u.pathname)：Windows 上 pathname 是 `/D:/a/b`，
    // 少了个盘符前的分隔符就是另一条路径，而且非空 host（`file://host/share`）
    // 会被静默当成相对路径。fileURLToPath 两个问题都处理，并且会拒掉非本地 host。
    return fileURLToPath(u);
  } catch (_) {
    return '';
  }
}

/**
 * 取一个 https 资源。只做"读进内存 + 上限 + 超时 + 安全重定向"，
 * 不做 gzip 之外的任何协商 —— 市场索引与包都是二进制/JSON，不需要更多。
 */
function httpsGetBuffer(url, options = {}) {
  const maxBytes = options.maxBytes || market.MAX_INDEX_BYTES;
  const timeoutMs = options.timeoutMs || FETCH_TIMEOUT_MS;
  const redirects = options.redirects || 0;

  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let target;
    try {
      target = new URL(url);
    } catch (_) {
      done({ ok: false, code: 'FETCH_FAILED', error: `地址不合法：${url}` });
      return;
    }
    if (target.protocol !== 'https:') {
      done({ ok: false, code: 'FETCH_FAILED', error: `只允许 https：${url}` });
      return;
    }

    const req = https.get(target, {
      timeout: timeoutMs,
      headers: { 'user-agent': 'SXSEditor-PluginMarket/1', accept: 'application/json, application/octet-stream' },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          done({ ok: false, code: 'FETCH_FAILED', error: '重定向次数过多' });
          return;
        }
        let next;
        try {
          next = new URL(res.headers.location, target).toString();
        } catch (_) {
          done({ ok: false, code: 'FETCH_FAILED', error: '重定向地址不合法' });
          return;
        }
        // 不允许 http 降级；跨域重定向本身允许（CDN 常见），但每次都要重新过协议检查。
        if (!/^https:\/\//i.test(next)) {
          done({ ok: false, code: 'FETCH_FAILED', error: '重定向到了非 https 地址' });
          return;
        }
        httpsGetBuffer(next, { ...options, redirects: redirects + 1 }).then(done);
        return;
      }
      if (status !== 200) {
        res.resume();
        done({ ok: false, code: 'FETCH_FAILED', error: `HTTP ${status}` });
        return;
      }
      const declared = Number(res.headers['content-length'] || 0);
      if (declared && declared > maxBytes) {
        res.destroy();
        done({ ok: false, code: 'FETCH_TOO_LARGE', error: `响应超过 ${maxBytes} 字节` });
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          done({ ok: false, code: 'FETCH_TOO_LARGE', error: `响应超过 ${maxBytes} 字节` });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => done({ ok: true, buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || '' }));
      res.on('error', (err) => done({ ok: false, code: 'FETCH_FAILED', error: err.message }));
    });

    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, code: 'FETCH_TIMEOUT', error: `请求超时（${timeoutMs} ms）` });
    });
    req.on('error', (err) => done({ ok: false, code: 'FETCH_FAILED', error: err.message }));
  });
}

async function fetchIndex(source, options = {}) {
  const cached = indexCache.get(source.url);
  if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ok: true, ...cached.parsed, cached: true };
  }

  let raw;
  if (source.url.startsWith('file://')) {
    if (!allowFileSources()) {
      return { ok: false, code: 'MARKET_FORBIDDEN', error: 'file:// 源未开启' };
    }
    const p = filePathOf(source.url);
    try {
      const stat = fs.statSync(p);
      if (stat.size > market.MAX_INDEX_BYTES) {
        return { ok: false, code: 'INDEX_TOO_LARGE', error: '索引文件过大' };
      }
      raw = fs.readFileSync(p);
    } catch (err) {
      return { ok: false, code: 'FETCH_FAILED', error: `读取索引失败：${err.message}` };
    }
  } else {
    const res = await httpsGetBuffer(source.url, { maxBytes: market.MAX_INDEX_BYTES });
    if (!res.ok) return res;
    raw = res.buffer;
  }

  const parsed = market.parseIndex(raw);
  if (!parsed.ok) return { ok: false, code: parsed.code, error: parsed.error };

  indexCache.set(source.url, { at: Date.now(), parsed });
  return { ok: true, ...parsed, cached: false };
}

function sourceListOrAll(sourceId) {
  const list = readSources();
  if (!sourceId) return list;
  return list.filter((s) => s.id === sourceId);
}

/**
 * 搜索。单个源失败不影响其它源 —— 市场页最不该出现的状态是"一个源 502，
 * 整页空白"。
 */
async function search(query, options = {}) {
  const sources = sourceListOrAll(options.sourceId);
  if (!sources.length) {
    return {
      ok: true,
      query: String(query || ''),
      results: [],
      sources: [],
      errors: [],
      needsSource: true,
    };
  }

  const results = [];
  const errors = [];
  const sourceViews = [];
  await Promise.all(sources.map(async (source) => {
    const res = await fetchIndex(source, { force: options.force });
    if (!res.ok) {
      errors.push({ sourceId: source.id, name: source.name, code: res.code, error: res.error });
      return;
    }
    sourceViews.push({ id: source.id, name: source.name, index: res.index, count: res.entries.length, cached: res.cached });
    for (const entry of market.search(res.entries, query, { sort: options.sort, limit: options.limit })) {
      results.push({
        ...entry,
        sourceId: source.id,
        sourceName: source.name,
        // 索引自述签名：只用于列表页提示，不参与安装判定。
        signatureClaim: entry.signature,
      });
    }
  }));

  // 多源合并后再排一次：各源内部的有序不能代表合并后的有序。
  const merged = market.search(results, query, { sort: options.sort, limit: options.limit });
  return { ok: true, query: String(query || ''), results: merged, sources: sourceViews, errors, needsSource: false };
}

// ------------------------------------------------------------ 预览

function cacheFileFor(entry) {
  return path.join(marketDir(), `${entry.id}-${entry.version}.sxsp`);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function downloadEntry(source, entry) {
  const dest = cacheFileFor(entry);
  if (fs.existsSync(dest)) {
    const st = fs.statSync(dest);
    if (st.size === entry.file.size && sha256File(dest) === entry.file.sha256) {
      return { ok: true, path: dest, cached: true };
    }
    // 缓存与索引对不上：删掉重下，而不是"将就用旧的"。
    try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
  }

  if (entry.file.size > PACKAGE.maxTotalBytes) {
    return { ok: false, code: 'PACKAGE_TOO_LARGE', error: '包体超过宿主允许的上限' };
  }

  let buf;
  if (source.url.startsWith('file://')) {
    const indexPath = filePathOf(source.url);
    const baseDir = path.dirname(indexPath);
    const abs = path.resolve(baseDir, entry.file.url);
    if (!abs.startsWith(path.resolve(baseDir) + path.sep)) {
      return { ok: false, code: 'DOWNLOAD_FAILED', error: `下载地址越出索引目录：${entry.file.url}` };
    }
    try {
      buf = fs.readFileSync(abs);
    } catch (err) {
      return { ok: false, code: 'DOWNLOAD_FAILED', error: `读取包失败：${err.message}` };
    }
  } else {
    const resolved = market.resolveEntryFileUrl(entry, source.url);
    if (!resolved.ok) return { ok: false, code: 'DOWNLOAD_FAILED', error: resolved.error };
    const res = await httpsGetBuffer(resolved.url, {
      maxBytes: Math.min(entry.file.size + 1024, PACKAGE.maxTotalBytes),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    if (!res.ok) return { ok: false, code: 'DOWNLOAD_FAILED', error: res.error };
    buf = res.buffer;
  }

  if (buf.length !== entry.file.size) {
    return {
      ok: false,
      code: 'CHECKSUM_MISMATCH',
      error: `包大小与索引不符（索引 ${entry.file.size}，实际 ${buf.length}）`,
    };
  }
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  if (digest !== entry.file.sha256) {
    return { ok: false, code: 'CHECKSUM_MISMATCH', error: '包的 sha256 与索引不符' };
  }

  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return { ok: true, path: dest, cached: false };
}

function contribSummary(preview) {
  return preview.contributes || {};
}

/**
 * 下载并预览。
 *
 * 返回里同时有 `entry`（索引怎么说）与 `preview`（包里实际是什么）。
 * `warnings` 是给用户看的差异点，不是错误 —— 用户仍可以决定安装。
 */
async function preview(sourceId, pluginId, options = {}) {
  const sources = sourceListOrAll(sourceId);
  if (!sources.length) {
    return { ok: false, code: 'SOURCE_NOT_FOUND', error: sourceId ? `没有这个源：${sourceId}` : '还没有配置市场源' };
  }

  for (const source of sources) {
    const res = await fetchIndex(source, { force: options.force });
    if (!res.ok) continue;
    const entry = res.entries.find((e) => e.id === pluginId);
    if (!entry) continue;

    const downloaded = await downloadEntry(source, entry);
    if (!downloaded.ok) {
      store.audit('market-download', pluginId, { source: source.id, code: downloaded.code, error: downloaded.error });
      return downloaded;
    }

    const inspected = require('./PluginInstaller.js').previewPackage(downloaded.path, {
      appVersion: options.appVersion,
    });
    if (!inspected.ok) {
      return { ok: false, code: 'PACKAGE_INVALID', error: inspected.error };
    }

    const warnings = [];
    const p = inspected.preview;
    if (p.id !== entry.id) {
      warnings.push({ code: 'ID_MISMATCH', message: `包里是 ${p.id}，索引写的是 ${entry.id}` });
    }
    if (p.version !== entry.version) {
      warnings.push({ code: 'VERSION_MISMATCH', message: `包里是 ${p.version}，索引写的是 ${entry.version}` });
    }
    const claimed = entry.signature && entry.signature.keyId;
    const actual = p.signature && p.signature.status !== 'unsigned' ? p.signature.keyId : '';
    if (claimed && actual && claimed !== actual) {
      warnings.push({ code: 'INDEX_SIGNATURE_MISMATCH', message: '索引声明的签名密钥与包里的不一致' });
    }
    if (claimed && !actual) {
      warnings.push({ code: 'INDEX_SIGNATURE_MISMATCH', message: '索引说已签名，包里没有有效签名' });
    }

    const installed = installedVersionOf(entry.id);
    const relation = market.versionRelation(entry, installed);
    if (relation === 'downgrade') {
      warnings.push({
        code: 'DOWNGRADE',
        message: `这是旧版本（已装 ${installed}，市场上是 ${entry.version}）`,
      });
    }

    store.audit('market-preview', entry.id, {
      source: source.id,
      version: entry.version,
      signature: p.signature.status,
      installable: p.installable,
    });

    return {
      ok: true,
      source: publicSource(source),
      entry,
      installedVersion: installed || '',
      relation,
      preview: p,
      contributes: contribSummary(p),
      warnings,
      packagePath: downloaded.path,
      cached: downloaded.cached,
    };
  }

  return { ok: false, code: 'ENTRY_NOT_FOUND', error: `没有找到插件：${pluginId}` };
}

function installedVersionOf(id) {
  // registry 里记的是"启停/隔离"等运行时状态，不含版本号（版本在 manifest 与
  // 包记录里）。市场判断升级/降级需要的是"装的是哪一版"，所以读包记录。
  try {
    const rec = require('./PluginInstaller.js').readPackageRecord(id);
    if (rec && rec.version) return rec.version;
  } catch (_) { /* ignore */ }
  return '';
}

/** 清掉下载缓存（管理器/CLI 的"清理市场缓存"）。 */
function clearCache() {
  const dir = marketDir();
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.sxsp') && !name.endsWith('.part')) continue;
    try { fs.unlinkSync(path.join(dir, name)); removed += 1; } catch (_) { /* ignore */ }
  }
  indexCache.clear();
  return { ok: true, removed };
}

module.exports = {
  listSources,
  addSource,
  removeSource,
  search,
  preview,
  clearCache,
  fetchIndex,
  _internal: { httpsGetBuffer, sourceIdFor, allowFileSources, cacheFileFor },
};
