'use strict';
/**
 * 插件级依赖（manifest.dependencies）的校验与解析（CJS，纯函数）。
 *
 * 与 contributes.services.consumes 的区别：services 是「调用某个服务」的运行期
 * 依赖，缺了只是这个调用不可用；dependencies 是「需要先装上另一个插件」的
 * 部署期依赖，典型场景是把推理运行时（audio.cpp / llama.cpp）单独做成一个
 * 插件，让多个功能插件共享同一份运行时，而不是各自打包一份。
 *
 * 这里只做**查询**：声明依赖绝不触发安装。安装必须由插件显式调用
 * ctx.plugins.installMany()，且经过主进程的用户确认对话框 —— 否则一个插件
 * 装上就能静默往用户机器上装别的东西。
 */
const {
  DEPENDENCY_LIMITS,
  PERMISSION_GROUPS,
} = require('./pluginApi.js');
const { isVersionRange, findCycles } = require('./pluginServices.js');

// 复用 manifest 里的 id 规则，而不是抄一份正则：两处一旦漂移，就会出现
// 「依赖声明里的 id 校验过了、安装时却被判非法」这种最难排查的不一致。
// 延迟 require：pluginManifest.js 会在顶层引入本模块，这里不能在顶层反向引入。
function pluginIdIsValid(id) {
  const { isValidPluginId } = require('./pluginManifest.js');
  return isValidPluginId(id);
}

function fail(error) { return { ok: false, error }; }

/**
 * 校验 manifest.dependencies。
 *
 * @param {*} raw
 * @param {string} pluginId 声明者自己的 id（用于拒绝自依赖）
 * @returns {{ok:true, value:Array<{id:string,range:string,optional:boolean}>}
 *          |{ok:false,error:string}}
 */
function validateDependencies(raw, pluginId) {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail('dependencies 必须是数组');
  if (raw.length > DEPENDENCY_LIMITS.max) {
    return fail(`dependencies 超过上限 ${DEPENDENCY_LIMITS.max} 项`);
  }

  const value = [];
  const seen = new Set();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail(`dependencies[${i}] 必须是对象`);
    }
    const id = item.id;
    if (!pluginIdIsValid(id)) {
      return fail(`dependencies[${i}].id 非法：${JSON.stringify(id)}`);
    }
    if (id === pluginId) {
      return fail(`dependencies[${i}] 不能依赖自己（'${id}'）`);
    }
    if (seen.has(id)) {
      return fail(`dependencies 里重复声明了 '${id}'`);
    }
    seen.add(id);

    const range = item.range == null ? '*' : String(item.range).trim();
    if (range.length > DEPENDENCY_LIMITS.rangeMaxLength || !isVersionRange(range)) {
      return fail(`dependencies[${i}].range 不是合法版本范围：${JSON.stringify(range)}`);
    }
    if (item.optional !== undefined && typeof item.optional !== 'boolean') {
      return fail(`dependencies[${i}].optional 必须是布尔值`);
    }
    value.push({ id, range, optional: item.optional === true });
  }
  return { ok: true, value };
}

/**
 * 已安装插件集合 → 依赖图。节点只取已安装插件，边是「声明者 → 依赖」。
 * 未安装的 id 不会成为节点，findCycles 据此只报告事实存在的环。
 *
 * @param {Array<{id:string, dependencies?:Array<{id:string}>}>} installed
 * @returns {Map<string, string[]>}
 */
function buildPluginEdges(installed) {
  const edges = new Map();
  for (const plugin of installed || []) {
    if (!plugin || !plugin.id) continue;
    const deps = Array.isArray(plugin.dependencies) ? plugin.dependencies : [];
    edges.set(plugin.id, deps.map((d) => d && d.id).filter(Boolean));
  }
  return edges;
}

/**
 * 解析某个插件的依赖是否已满足。
 *
 * 纯函数：**不安装、不落盘、不发 IPC**，只返回判断结果，供插件自己决定
 * 要不要发起安装，以及供插件管理器展示依赖树。
 *
 * @param {object} manifest 已校验的 manifest（含 dependencies）
 * @param {Array<{id:string, version:string, enabled?:boolean}>} installed
 * @returns {{deps:Array<{id,range,optional,installedVersion:string|null,
 *                       satisfied:boolean,missing:boolean}>,
 *           cycles:string[][]}}
 */
function resolvePluginDependencies(manifest, installed) {
  const declared = (manifest && Array.isArray(manifest.dependencies))
    ? manifest.dependencies : [];
  const byId = new Map();
  for (const p of installed || []) {
    if (p && p.id) byId.set(p.id, p);
  }

  // 延迟 require：与 pluginServices.resolveService 同样的理由，避免加载期
  // 把整张 manifest 拖进来形成循环。
  const { satisfiesVersion } = require('./pluginManifest.js');

  const deps = declared.map((d) => {
    const found = byId.get(d.id);
    const installedVersion = found ? String(found.version || '0.0.0') : null;
    const satisfied = !!found && satisfiesVersion(installedVersion, d.range);
    return {
      id: d.id,
      range: d.range,
      optional: d.optional === true,
      installedVersion,
      satisfied,
      missing: !found,
    };
  });

  // 环只在「已安装插件之间」的事实依赖上计算：把本次要查询的 manifest 也
  // 临时并入，这样 A 依赖尚未装好的 B、B 又依赖 A 的情况能被报出来。
  const all = [...(installed || [])];
  if (manifest && manifest.id && !byId.has(manifest.id)) {
    all.push({ id: manifest.id, dependencies: declared });
  }
  const cycles = findCycles(buildPluginEdges(all));

  return { deps, cycles };
}

/** 权限是否允许发起某类安装。集中在这里，避免三处调用各写一遍判断。 */
function hasInstallPermission(perms, action) {
  const allowed = PERMISSION_GROUPS.plugins;
  if (!allowed.includes(action)) return false;
  const values = perms && perms.plugins;
  if (!Array.isArray(values)) return false;
  return values.includes(action);
}

module.exports = {
  validateDependencies,
  buildPluginEdges,
  resolvePluginDependencies,
  hasInstallPermission,
};
