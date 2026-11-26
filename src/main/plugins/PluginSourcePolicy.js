'use strict';
/**
 * 插件发起安装时的来源归一化与权限闸门（主进程，纯判定 + 本地 fs 检查）。
 *
 * 这一层存在的理由：插件是第三方进程，传过来的 spec 完全不可信。所有"能不能
 * 用这个来源"的判定都在主进程完成，且要在任何网络请求 / 文件读取之前。
 * 三种来源分开授权，因为它们的风险不一样：市场包有索引里的 sha256 与尺寸，
 * URL 包没有索引背书，本地路径则要防止插件去读系统目录里的任意 zip。
 */
const fs = require('node:fs');
const path = require('node:path');

const { PACKAGE, DEPENDENCY_LIMITS } = require('../../shared/pluginApi.js');
const marketContract = require('../../shared/pluginMarket.js');
const { versionRelation } = marketContract;
const { isHttpsUrl } = marketContract._internal;
const { hasInstallPermission } = require('../../shared/pluginDependencies.js');
const { isSystemPath } = require('../security.js');

/** 单次批量安装的上限：一次弹窗里塞 200 个目标，用户只会无脑点确认。 */
const MAX_BATCH = Math.min(DEPENDENCY_LIMITS.max, 16);

function fail(code, error) { return { ok: false, code, error }; }

/**
 * 校验某个来源是否已被授权。返回所需权限名，供调用方在审计与错误里复用。
 */
function requiredPermission(kind) {
  if (kind === 'market') return 'installMarket';
  if (kind === 'url') return 'installUrl';
  if (kind === 'path') return 'installPath';
  return null;
}

function assertSourceAllowed(kind, perms) {
  const needed = requiredPermission(kind);
  if (!needed) return fail('INVALID_REQUEST', `未知安装来源：${kind}`);
  if (!hasInstallPermission(perms, needed)) {
    return fail('PERMISSION_DENIED', `缺少权限 plugins:${needed}`);
  }
  return { ok: true, permission: needed };
}

/**
 * 归一化一条安装请求。
 *
 * 三态 spec：
 *   · {pluginId, version?, sourceId?}  市场索引（有 sha256 / size 背书）
 *   · {url}                            https 直链 .sxsp
 *   · {path}                           本地 .sxsp 绝对路径
 *
 * @returns {{ok:true, target:object}|{ok:false,code,error}}
 */
function normalizeInstallSpec(spec, perms, callerId) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return fail('INVALID_REQUEST', '安装请求必须是对象');
  }

  let kind;
  const kinds = ['market', 'url', 'path'].filter((k) => {
    if (k === 'market') return spec.pluginId !== undefined;
    if (k === 'url') return spec.url !== undefined;
    return spec.path !== undefined;
  });
  if (kinds.length !== 1) {
    return fail('INVALID_REQUEST', '安装请求必须且只能指定一种来源：pluginId / url / path');
  }
  kind = kinds[0];

  const allowed = assertSourceAllowed(kind, perms);
  if (!allowed.ok) return allowed;

  const base = {
    kind,
    permission: allowed.permission,
    nonMarket: kind !== 'market',
    sourceLabel: '',
    selfUpdate: false,
    pluginId: '',
    version: typeof spec.version === 'string' ? spec.version.trim() : '',
    sourceId: typeof spec.sourceId === 'string' ? spec.sourceId.trim() : '',
    url: '',
    path: '',
  };

  if (kind === 'market') {
    const id = String(spec.pluginId || '').trim();
    // 复用 manifest 的 id 规则，避免"这里放行、装的时候才发现 id 非法"
    const { isValidPluginId } = require('../../shared/pluginManifest.js');
    if (!isValidPluginId(id)) return fail('INVALID_REQUEST', `pluginId 非法：${JSON.stringify(id)}`);
    if (spec.version !== undefined && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(base.version)) {
      return fail('INVALID_REQUEST', `version 非法：${JSON.stringify(spec.version)}`);
    }
    base.pluginId = id;
    base.selfUpdate = id === callerId;
    base.sourceLabel = base.sourceId ? `市场源 ${base.sourceId}` : '已配置的市场源';
  } else if (kind === 'url') {
    const url = String(spec.url || '').trim();
    if (!isHttpsUrl(url)) return fail('INVALID_REQUEST', '只允许 https 包地址（不接受 http / file / 相对路径）');
    if (spec.version !== undefined && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(base.version)) {
      return fail('INVALID_REQUEST', `version 非法：${JSON.stringify(spec.version)}`);
    }
    base.url = url;
    base.sourceLabel = `非市场来源（URL）${new URL(url).host}`;
  } else {
    const p = String(spec.path || '').trim();
    if (!path.isAbsolute(p)) return fail('INVALID_REQUEST', '本地包路径必须是绝对路径');
    if (!p.toLowerCase().endsWith(PACKAGE.ext)) {
      return fail('INVALID_REQUEST', `本地包必须是 ${PACKAGE.ext} 文件`);
    }
    if (isSystemPath(p)) return fail('FORBIDDEN', '不允许从系统目录安装插件');
    let real;
    try {
      real = fs.realpathSync(p);
    } catch (err) {
      return fail('NOT_FOUND', `读取本地包失败：${err.message}`);
    }
    if (isSystemPath(real)) return fail('FORBIDDEN', '不允许从系统目录安装插件');
    let st;
    try {
      st = fs.statSync(real);
    } catch (err) {
      return fail('NOT_FOUND', `读取本地包失败：${err.message}`);
    }
    if (!st.isFile()) return fail('INVALID_REQUEST', '本地包路径不是文件');
    if (st.size > PACKAGE.maxTotalBytes) return fail('PACKAGE_TOO_LARGE', '包体超过宿主允许的上限');
    base.path = real;
    base.sourceLabel = `非市场来源（本地文件）${path.basename(real)}`;
  }

  // 自更新单独要 selfUpdate 权限：一个能装依赖的插件不等于能换掉自己的代码。
  if (base.selfUpdate && !hasInstallPermission(perms, 'selfUpdate')) {
    return fail('PERMISSION_DENIED', '缺少权限 plugins:selfUpdate（自更新）');
  }
  return { ok: true, target: base };
}

/**
 * 归一化整批。任何一条不合法就整批拒绝 —— 批量安装的价值是"一次看清、一次
 * 决定"，若允许部分非法项混进去，用户确认框里就分不清哪几条真的会装。
 */
function normalizeInstallBatch(specs, perms, callerId) {
  if (!Array.isArray(specs) || specs.length === 0) {
    return fail('INVALID_REQUEST', '安装请求必须是非空数组');
  }
  if (specs.length > MAX_BATCH) {
    return fail('INVALID_REQUEST', `单次最多安装 ${MAX_BATCH} 个插件`);
  }
  const targets = [];
  const seen = new Set();
  for (let i = 0; i < specs.length; i++) {
    const r = normalizeInstallSpec(specs[i], perms, callerId);
    if (!r.ok) return fail(r.code, `第 ${i + 1} 项：${r.error}`);
    const key = `${r.target.kind}:${r.target.pluginId || r.target.url || r.target.path}`;
    if (seen.has(key)) return fail('INVALID_REQUEST', `第 ${i + 1} 项与前面的目标重复`);
    seen.add(key);
    targets.push(r.target);
  }
  return { ok: true, targets };
}

/**
 * 已装版本与目标版本的关系。市场/URL/本地包统一走这里，避免三处各写一遍。
 */
function relationTo(target, installedVersion) {
  if (!target.version) return installedVersion ? 'unknown' : 'new';
  return versionRelation({ version: target.version }, installedVersion);
}

module.exports = {
  MAX_BATCH,
  requiredPermission,
  assertSourceAllowed,
  normalizeInstallSpec,
  normalizeInstallBatch,
  relationTo,
};
