'use strict';
/**
 * 插件市场索引：契约、校验与检索（M6）。
 *
 * 这一段**只定接口**，不内置任何市场地址。本项目没有运营中的市场服务，硬编码
 * 一个"看起来像官方"的域名比没有更糟：用户会以为那是可信来源。没有配置源时，
 * 上层拿到的是"未配置"，而不是一个默认 URL。
 *
 * 信任模型（重要）
 * ----------------
 *   · 索引里的 `signature` 是**源的自述**，只配用来在列表页提示"看起来是谁签的"；
 *   · 能不能装，只看下载下来的 `.sxsp` 里那份 `signature.json`
 *     （PluginInstaller.previewPackage → pluginSignature.verifyPackage）；
 *   · 两者不一致时由调用方发 `INDEX_SIGNATURE_MISMATCH` 警告。绝不能让
 *     "索引说已签名"变成绕过验签的通道 —— 索引本身没有签名覆盖。
 */

const INDEX_SCHEMA = 'sxs-plugin-index-v1';
/** 索引文件上限：一份纯文本列表，2 MB 足够列几千个插件。 */
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 500;
/** 单条描述上限，避免一个源用超长文本把列表页撑爆。 */
const MAX_TEXT = 2000;

const ENTRY_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function fail(code, error) {
  return { ok: false, code, error };
}

function text(value, max = MAX_TEXT) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isHttpsUrl(value) {
  return /^https:\/\/[^\s]+$/i.test(value);
}

/**
 * 相对地址：`./x.sxsp`、`pkg/x.sxsp`、`../x.sxsp` 都允许，但必须在解析后仍落在
 * 索引所在目录的子路径里（由客户端 resolveEntryFileUrl 保证）。这里只挡明显越界
 * 的写法（协议、以 `/` 开头的绝对路径），因为 shared 层拿不到索引 URL。
 */
function isRelativeUrl(value) {
  if (!value) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  return true;
}

/**
 * 索引条目 → 规范化条目。
 *
 * 坏条目一律**跳过**而不是让整份索引失败：一个源里某个条目的版本号写错，
 * 不该导致用户搜不到其它插件。跳过数量记在 warnings 里，CLI/管理器可以展示。
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('ENTRY_INVALID', '条目不是对象');
  }
  const id = text(raw.id, 64);
  if (!ENTRY_ID_RE.test(id)) return fail('ENTRY_INVALID', `插件 id 非法：${JSON.stringify(raw.id)}`);
  const version = text(raw.version, 32);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    return fail('ENTRY_INVALID', `${id} 的 version 不是语义化版本：${JSON.stringify(raw.version)}`);
  }
  if (Number(raw.apiVersion) !== 2) {
    return fail('ENTRY_INVALID', `${id} 的 apiVersion 必须是 2`);
  }

  const file = raw.file;
  if (!file || typeof file !== 'object') return fail('ENTRY_INVALID', `${id} 缺少 file`);
  const url = text(file.url, 2048);
  if (!isHttpsUrl(url) && !isRelativeUrl(url)) {
    return fail('ENTRY_INVALID', `${id} 的下载地址只允许 https 或相对路径：${url || '(空)'}`);
  }
  const sha256 = text(file.sha256, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    // 没有摘要就没法发现"下载到的东西被换了"，这不是可选项。
    return fail('ENTRY_INVALID', `${id} 缺少合法的 file.sha256`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('ENTRY_INVALID', `${id} 的 file.size 不合法`);

  const sig = raw.signature;
  let signature = null;
  if (sig && typeof sig === 'object') {
    const keyId = text(sig.keyId, 64);
    if (keyId) {
      signature = {
        keyId,
        publisher: text(sig.publisher, 120),
        signedAt: text(sig.signedAt, 40),
        // 索引里没有公钥：指纹只能用来提示"和上次是不是同一把"，不能用来验签。
        publicKey: '',
      };
    }
  }

  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map((k) => text(k, 40)).filter(Boolean).slice(0, 16)
    : [];

  // 权限只收"组名"，不收细节：列表页要能显示"需要 fs / net"，但细节以包内
  // manifest 为准。索引多写一个权限组不会让插件真的获得它。
  const permissionGroups = Array.isArray(raw.permissionGroups)
    ? [...new Set(raw.permissionGroups.map((g) => text(g, 24)).filter(Boolean))].slice(0, 16)
    : [];

  return {
    ok: true,
    value: {
      id,
      name: text(raw.name, 120) || id,
      version,
      apiVersion: 2,
      description: text(raw.description),
      author: text(raw.author, 120),
      homepage: isHttpsUrl(text(raw.homepage, 2048)) ? text(raw.homepage, 2048) : '',
      keywords,
      permissionGroups,
      file: { url, sha256, size },
      signature,
    },
  };
}

/**
 * 解析并校验一份索引。
 * @param {Buffer|string|object} raw
 */
function parseIndex(raw) {
  let json = raw;
  if (Buffer.isBuffer(raw)) {
    if (raw.length > MAX_INDEX_BYTES) return fail('INDEX_TOO_LARGE', '索引文件过大');
    json = raw.toString('utf8');
  }
  if (typeof json === 'string') {
    if (Buffer.byteLength(json, 'utf8') > MAX_INDEX_BYTES) return fail('INDEX_TOO_LARGE', '索引文件过大');
    try {
      json = JSON.parse(json);
    } catch (err) {
      return fail('INDEX_INVALID', `索引不是合法 JSON：${err.message}`);
    }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return fail('INDEX_INVALID', '索引根节点必须是对象');
  }
  if (json.schema !== INDEX_SCHEMA) {
    return fail('INDEX_INVALID', `不支持的索引格式：${JSON.stringify(json.schema)}（期望 ${INDEX_SCHEMA}）`);
  }
  if (!Array.isArray(json.plugins)) return fail('INDEX_INVALID', '索引缺少 plugins 数组');
  if (json.plugins.length > MAX_INDEX_ENTRIES) {
    return fail('INDEX_TOO_LARGE', `索引条目超过 ${MAX_INDEX_ENTRIES} 个`);
  }

  const entries = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of json.plugins) {
    const parsed = normalizeEntry(raw);
    if (!parsed.ok) {
      skipped.push(parsed.error);
      continue;
    }
    // 同一份索引里重复 id：后一条覆盖前一条会让"用户看到的是哪个版本"取决于顺序，
    // 直接跳过并留痕。
    if (seen.has(parsed.value.id)) {
      skipped.push(`重复的插件 id：${parsed.value.id}`);
      continue;
    }
    seen.add(parsed.value.id);
    entries.push(parsed.value);
  }

  return {
    ok: true,
    index: {
      schema: INDEX_SCHEMA,
      name: text(json.name, 120) || 'plugin index',
      updatedAt: text(json.updatedAt, 40),
    },
    entries,
    skipped,
  };
}

function parseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value || ''));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

function comparePre(a, b) {
  // 预发布版本小于同号正式版：1.0.0-beta < 1.0.0
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (+x !== +y) return +x < +y ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 语义化版本比较；任一方不合法时返回 null（调用方按"无法比较"处理）。 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePre(pa.pre, pb.pre);
}

/**
 * 市场条目相对"已安装版本"的关系。
 *
 * 降级是需要用户明确知道的事：签名只保证"是作者发的"，不保证"比你现在的新"。
 * 旧版本同样是合法签名，攻击者可以把用户退回到有已知漏洞的版本。
 */
function versionRelation(entry, installedVersion) {
  if (!installedVersion) return 'new';
  const cmp = compareVersions(entry && entry.version, installedVersion);
  if (cmp === null) return 'unknown';
  if (cmp < 0) return 'downgrade';
  if (cmp > 0) return 'upgrade';
  return 'same';
}

function scoreEntry(entry, term) {
  const q = term.toLowerCase();
  const id = entry.id.toLowerCase();
  const name = entry.name.toLowerCase();
  if (id === q) return 100;
  if (name === q) return 90;
  if (name.startsWith(q)) return 70;
  if (id.includes(q)) return 60;
  if (name.includes(q)) return 50;
  if (entry.keywords.some((k) => k.toLowerCase().includes(q))) return 40;
  if (entry.description.toLowerCase().includes(q)) return 20;
  if (entry.author.toLowerCase().includes(q)) return 10;
  return 0;
}

/**
 * 本地检索。市场索引是一份小 JSON，全部拿到本地再过滤：
 * 这样搜索是同步的、可离线、也不会把用户的每一次按键变成一次请求。
 *
 * @param {object[]} entries parseIndex().entries
 * @param {string} query 空格分隔的多个词，全部命中才算匹配
 * @param {{sort?: 'relevance'|'name'|'updated', limit?: number}} [options]
 */
function search(entries, query, options = {}) {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const entry of entries || []) {
    let total = 0;
    let hit = true;
    for (const term of terms) {
      const s = scoreEntry(entry, term);
      if (s === 0) { hit = false; break; }
      total += s;
    }
    if (!hit) continue;
    scored.push({ entry, score: terms.length ? total : 1 });
  }

  const sort = options.sort === 'name' || options.sort === 'updated' ? options.sort : 'relevance';
  scored.sort((a, b) => {
    if (sort === 'name') return a.entry.name.localeCompare(b.entry.name);
    if (sort === 'updated') {
      const av = a.entry.version;
      const bv = b.entry.version;
      const c = compareVersions(bv, av);
      if (c) return c;
    }
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.name.localeCompare(b.entry.name);
  });

  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 200;
  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * 把条目里的相对下载地址解析成绝对地址（https 源）。
 * 越出索引目录的相对路径直接拒绝：`../../etc/passwd` 这种写法没有任何正当用途。
 */
function resolveEntryFileUrl(entry, indexUrl) {
  const url = entry && entry.file && entry.file.url;
  if (!url) return { ok: false, error: '条目缺少下载地址' };
  if (isHttpsUrl(url)) return { ok: true, url };
  if (!isHttpsUrl(indexUrl) || !isRelativeUrl(url)) {
    return { ok: false, error: `无法解析相对下载地址：${url}` };
  }
  let base;
  try {
    base = new URL(indexUrl);
  } catch (_) {
    return { ok: false, error: '索引地址不合法' };
  }
  let resolved;
  try {
    resolved = new URL(url, base);
  } catch (_) {
    return { ok: false, error: `下载地址不合法：${url}` };
  }
  // 只允许同源：一个索引条目把包指到别的域名，等于绕开了"这个源"的信任范围。
  if (resolved.origin !== base.origin) {
    return { ok: false, error: `下载地址跨域：${resolved.origin}（索引来自 ${base.origin}）` };
  }
  const baseDir = base.pathname.replace(/[^/]*$/, '');
  if (!resolved.pathname.startsWith(baseDir)) {
    return { ok: false, error: `下载地址越出索引目录：${url}` };
  }
  return { ok: true, url: resolved.toString() };
}

module.exports = {
  INDEX_SCHEMA,
  MAX_INDEX_BYTES,
  MAX_INDEX_ENTRIES,
  normalizeEntry,
  parseIndex,
  compareVersions,
  versionRelation,
  search,
  resolveEntryFileUrl,
  _internal: { parseVersion, isHttpsUrl, isRelativeUrl },
};
