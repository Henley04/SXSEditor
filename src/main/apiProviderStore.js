'use strict';

/**
 * API Provider 存储（主进程专用）。
 *
 * 设计约束：
 *  - 元数据（id / name / url / builtin / 当前选中）存 settings.json，走
 *    loadSettings / saveSettingsFile 同一入口，避免产生第二套配置。
 *  - 密钥**绝不**写 settings.json：走 secretsStore.js（Electron safeStorage，
 *    Windows DPAPI / macOS Keychain / Linux libsecret；不可用时明文存储并
 *    通过 secretsEncrypted=false 明确告知 UI）。
 *  - 渲染层永远拿不到密钥明文，只拿 hasKey。这样与 singerMarketIpc 的
 *    "HTTP 全在主进程做、token 不进渲染层" 架构约定一致，也无需放宽 CSP。
 *  - 内置免费服务始终存在（不可删除），保证升级用户也能看到它。
 */

const { createSafeStorageSecrets } = require('./secretsStore');
const { getConfigPath } = require('./configStore');
const { loadSettings, saveSettingsFile } = require('./settings');

const FREE_PROVIDER_ID = 'builtin-free-sxseditor';
const FREE_PROVIDER = Object.freeze({
  id: FREE_PROVIDER_ID,
  name: 'Free API By SXSEditor',
  // ModelScope 创空间的**公开访问域名**：无需任何 SDK Token，匿名即可调用
  // /health 与 /v1/synthesize（平台按 User-Agent 区分页面访问与 API 调用，
  // 客户端统一带浏览器 UA）。不限鉴权，但按 IP 保留 20/min、500/day 限流。
  //
  // 不要改回 *.api-inference.modelscope.net：那是平台 API 专用网关，会强制
  // 校验调用者自己的 ModelScope SDK Token，无令牌一律 401（"Authentication
  // failed..."），与"免费开箱即用"的目标冲突。
  url: 'https://syxppp-soulx-singer-free.ms.show',
  builtin: true,
  // 内置服务恒定免鉴权：即使本地残留了旧版保存的 SDK Token，也绝不随请求
  // 发送（带 Token 访问 ms.show 反而会被网关 403 拒绝）。
  authRequired: false,
});

// 历史版本写入过的内置地址，升级时自动迁移到上面的免鉴权公开域名。
const LEGACY_FREE_URLS = Object.freeze([
  'https://studio-syxppp-soulx-singer-free.api-inference.modelscope.net',
]);

const MAX_PROVIDERS = 32;
const MAX_NAME_LEN = 64;
const MAX_URL_LEN = 512;

let _secrets = null;
function secrets() {
  if (_secrets) return _secrets;
  let safeStorage = null;
  try { safeStorage = require('electron').safeStorage; } catch (_) { /* 测试环境 */ }
  _secrets = createSafeStorageSecrets({
    file: getConfigPath('apiProviderSecrets'),
    safeStorage,
    label: 'api-provider',
  });
  return _secrets;
}

/** 只接受 http(s) 绝对地址，去掉 hash / 尾斜杠 / query，禁止内嵌凭据。 */
function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > MAX_URL_LEN) return null;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.hash || u.search) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

function makeId() {
  return `api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 该地址是否为免鉴权的创空间公开入口（含需要迁移的历史网关地址）。 */
function isPublicFreeUrl(url) {
  return url === FREE_PROVIDER.url || LEGACY_FREE_URLS.includes(url);
}

/** 从 settings 读取并规范化元数据；缺失时补内置服务。 */
function _readMeta() {
  const s = loadSettings();
  const raw = Array.isArray(s.apiProviders) ? s.apiProviders : [];
  const out = [];
  let hasBuiltin = false;
  for (const item of raw.slice(0, MAX_PROVIDERS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = typeof item.id === 'string' ? item.id.slice(0, 64) : '';
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, MAX_NAME_LEN) : '';
    let url = normalizeUrl(item.url);
    if (!id || !name || !url) continue;
    const builtin = id === FREE_PROVIDER_ID;
    if (builtin) {
      hasBuiltin = true;
      // 升级迁移：旧版本写死的是强制 SDK Token 的 API 专用网关地址，
      // 自动换成免鉴权的创空间公开域名，避免升级用户仍被要求填 Token。
      if (LEGACY_FREE_URLS.includes(url)) url = FREE_PROVIDER.url;
    }
    out.push({ id, name, url, builtin });
  }
  if (!hasBuiltin) out.unshift({ ...FREE_PROVIDER });
  let activeId = typeof s.activeApiProviderId === 'string' ? s.activeApiProviderId : '';
  if (!out.some((p) => p.id === activeId)) activeId = FREE_PROVIDER_ID;
  return { providers: out, activeId };
}

async function _writeMeta(providers, activeId) {
  const merged = {
    ...loadSettings(),
    apiProviders: providers,
    activeApiProviderId: activeId,
  };
  const result = await saveSettingsFile(merged);
  if (!result || result.success === false) {
    throw new Error(`保存 API Provider 失败：${(result && result.error) || '未知写入错误'}`);
  }
}

/** 渲染层用的列表：含 hasKey，但绝不含密钥明文。 */
function list() {
  const { providers, activeId } = _readMeta();
  const sec = secrets();
  return {
    providers: providers.map((p) => {
      const authRequired = !isPublicFreeUrl(p.url);
      return {
        ...p,
        // 渲染层据此禁用密钥输入：免鉴权公开入口不需要、也不允许带密钥。
        authRequired,
        hasKey: authRequired && sec.has(`provider:${p.id}`),
      };
    }),
    activeId,
    secretsEncrypted: sec.isEncrypted(),
    freeProviderId: FREE_PROVIDER_ID,
  };
}

/**
 * 新建或更新一个 Provider。
 * @param {{id?:string,name:string,url:string,key?:string,keyChanged?:boolean}} input
 *   keyChanged=false（或未传 key）时保留原密钥；key='' 且 keyChanged=true 时清除密钥。
 */
async function save(input) {
  const name = typeof input?.name === 'string' ? input.name.trim().slice(0, MAX_NAME_LEN) : '';
  const url = normalizeUrl(input?.url);
  if (!name) throw new Error('Provider 名称不能为空');
  if (!url) throw new Error('API 网址无效：必须是 http:// 或 https:// 开头的绝对地址，且不能带查询串、片段或内嵌凭据');

  const { providers, activeId } = _readMeta();
  const id = typeof input.id === 'string' && input.id ? input.id : makeId();
  const existing = providers.find((p) => p.id === id);
  const builtin = id === FREE_PROVIDER_ID || (existing && existing.builtin) || false;

  if (existing) {
    existing.name = name;
    existing.url = url;
    existing.builtin = builtin;
  } else {
    if (providers.length >= MAX_PROVIDERS) throw new Error(`最多只能保存 ${MAX_PROVIDERS} 个 API Provider`);
    providers.push({ id, name, url, builtin });
  }

  // 显式 keyChanged 优先；未声明时，只要传了非空 key 就视为要写入
  // （避免调用方漏传 keyChanged 导致密钥被静默忽略）。
  const wantsKeyChange = input?.keyChanged === true
    || (input?.keyChanged === undefined && typeof input?.key === 'string' && input.key.trim() !== '');
  const sec = secrets();
  if (isPublicFreeUrl(url)) {
    // 免鉴权公开服务一律不保存密钥：既避免旧版残留的 SDK Token，也防止
    // 用户误填后请求携带 Bearer 被创空间网关 403 拒绝。
    sec.delete(`provider:${id}`);
  } else if (wantsKeyChange) {
    const k = typeof input.key === 'string' ? input.key.trim() : '';
    if (k) sec.set(`provider:${id}`, k);
    else sec.delete(`provider:${id}`);
  }

  const nextActive = (!activeId || !providers.some((p) => p.id === activeId)) ? id : activeId;
  await _writeMeta(providers, nextActive);
  return { ...list(), savedId: id };
}

async function remove(id) {
  if (id === FREE_PROVIDER_ID) throw new Error('内置免费服务不能删除');
  const { providers, activeId } = _readMeta();
  const next = providers.filter((p) => p.id !== id);
  if (next.length === providers.length) return list();
  secrets().delete(`provider:${id}`);
  const nextActive = activeId === id ? FREE_PROVIDER_ID : activeId;
  await _writeMeta(next, nextActive);
  return list();
}

async function setActive(id) {
  const { providers } = _readMeta();
  if (!providers.some((p) => p.id === id)) throw new Error('该 API Provider 不存在');
  await _writeMeta(providers, id);
  return list();
}

/** 恢复内置免费服务的默认地址/名称（密钥保留）。 */
async function resetBuiltin() {
  const { providers, activeId } = _readMeta();
  const builtin = providers.find((p) => p.id === FREE_PROVIDER_ID);
  if (builtin) {
    builtin.name = FREE_PROVIDER.name;
    builtin.url = FREE_PROVIDER.url;
  } else {
    providers.unshift({ ...FREE_PROVIDER });
  }
  await _writeMeta(providers, activeId);
  return list();
}

/**
 * 供推理链路使用：返回当前选中 Provider 的明文密钥（仅主进程内可见）。
 * @returns {{id:string,name:string,url:string,key:string}|null}
 */
function getActiveRuntime() {
  const { providers, activeId } = _readMeta();
  const p = providers.find((x) => x.id === activeId);
  if (!p) return null;
  // 免鉴权公开入口绝不携带密钥：平台 ms.show 域名带上 Bearer Token 反而
  // 会被网关 403 拒绝；同时也避免旧版残留的 SDK Token 被误发。
  const key = isPublicFreeUrl(p.url) ? '' : (secrets().get(`provider:${p.id}`) || '');
  return { id: p.id, name: p.name, url: p.url, key };
}

/** 测试连接时允许使用尚未保存的表单值。 */
function runtimeFromDraft(draft) {
  let url = normalizeUrl(draft?.url);
  if (LEGACY_FREE_URLS.includes(url)) url = FREE_PROVIDER.url;
  if (!url) throw new Error('API 网址无效：必须是 http:// 或 https:// 开头的绝对地址');
  let key = typeof draft?.key === 'string' ? draft.key.trim() : '';
  if (!key && draft?.id) key = secrets().get(`provider:${draft.id}`) || '';
  if (isPublicFreeUrl(url)) key = '';
  return {
    id: draft?.id || 'draft',
    name: draft?.name || 'API',
    url,
    key,
  };
}

module.exports = {
  FREE_PROVIDER_ID,
  FREE_PROVIDER,
  LEGACY_FREE_URLS,
  isPublicFreeUrl,
  normalizeUrl,
  list,
  save,
  remove,
  setActive,
  resetBuiltin,
  getActiveRuntime,
  runtimeFromDraft,
};
