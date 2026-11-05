'use strict';
/**
 * 跨插件 service（`contributes.services`）—— 命名、版本匹配与依赖图的唯一规则来源。
 *
 * 三个消费者共用这里的规则（加载期校验、运行期解析、管理器投影），写三遍必漂移。
 *
 * 设计取舍：
 *   · **service id 是全局命名空间，不是插件内局部 id。** 与自动化方法的
 *     `<pluginId>.<commandId>` 相反：服务表达的是"能力"（`sv2.codec`、`audio.vad`），
 *     消费方在写代码时就该知道名字，而不是拼别人的插件 id。代价是必须要求
 *     带命名空间前缀（至少一个点），否则一个叫 `codec` 的裸词就被抢注了。
 *   · **版本范围用与 `engines.app` 相同的一套极简 semver。** 不为插件间依赖再引
 *     一个 semver 实现：两边对 `^1.2.0` 的理解必须一致，否则作者会看到
 *     "安装时通过、运行时不匹配"这种最难查的问题。
 *   · **循环依赖只报告、不拒绝。** 调用是运行期按需发起的，A→B→A 只有在真的
 *     递归调用时才致命；而"声明了循环"本身有可能只是两个插件互为可选扩展。
 *     拒绝加载会让一组能正常工作的插件装不上，报告则让用户看得到风险。
 */

/** service id：`<namespace>.<name>`，全局唯一。 */
const SERVICE_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?\.[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** 服务方法名：与命令 id 同一形状（允许点分，便于 `codec.decode` 这类命名）。 */
const SERVICE_METHOD_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** 与 `satisfiesVersion` 接受的 token 形状保持一致（见 pluginManifest.js）。 */
const RANGE_TOKEN_RE = /^(?:>=|<=|>|<|=|\^|~)?v?\d+(?:\.\d+){0,2}$/;

/** 单次服务调用的最大转发深度：A→B→A→B… 必须在宿主侧截断，否则是无限递归。 */
const MAX_CALL_DEPTH = 8;

/** 服务相关的错误码（与 `ERR` 并集使用，宿主侧统一翻成 MCP 码）。 */
const SERVICE_ERR = Object.freeze({
  GONE: 'SERVICE_GONE',
  NOT_FOUND: 'SERVICE_NOT_FOUND',
  VERSION: 'SERVICE_VERSION_MISMATCH',
  DENIED: 'PERMISSION_DENIED',
  RECURSION: 'SERVICE_RECURSION',
});

function isServiceId(id) {
  return typeof id === 'string' && SERVICE_ID_RE.test(id);
}

function isServiceMethod(name) {
  return typeof name === 'string' && SERVICE_METHOD_RE.test(name);
}

/**
 * 版本范围是否可解析。
 *
 * 只做语法检查，不判断"某个版本满不满足"——那是 `satisfiesVersion` 的事。
 * 分开的理由：manifest 校验时还没有提供方，能判断的只有"这句话是不是人话"。
 */
function isVersionRange(range) {
  const text = String(range == null ? '*' : range).trim();
  if (!text || text === '*') return true;
  if (text.length > 64) return false;
  const tokens = text.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((t) => RANGE_TOKEN_RE.test(t));
}

/**
 * 从一组提供方里解析某个服务。
 *
 * @param {{providers: Array<{id:string, version:string, pluginId:string, methods:string[]}>,
 *          id:string, range?:string}} req
 * @returns {{ok:true, provider:object} | {ok:false, reason:string, message:string}}
 */
function resolveService(req) {
  const { providers, id } = req || {};
  const list = (providers || []).filter((p) => p && p.id === id);
  if (!list.length) {
    return { ok: false, reason: SERVICE_ERR.NOT_FOUND, message: `没有插件提供 service '${id}'` };
  }
  const range = req.range == null ? '*' : String(req.range);
  const rangeOk = isVersionRange(range);
  const hit = list.find((p) => {
    // 范围写坏了按"不满足"处理：宁可让插件显示为 degraded，也不要在运行期
    // 用一个作者没想清楚的范围去匹配（那会变成"有时能调、有时不能"）。
    if (!rangeOk) return false;
    // 延迟 require：这个模块被渲染层/单测引用，不该在顶层拖进整张 manifest。
    const { satisfiesVersion } = require('./pluginManifest.js');
    return satisfiesVersion(p.version || '0.0.0', range);
  });
  if (!hit) {
    const versions = list.map((p) => `${p.pluginId}@${p.version}`).join(', ');
    return {
      ok: false,
      reason: SERVICE_ERR.VERSION,
      message: rangeOk
        ? `service '${id}' 的版本不满足 '${range}'（已提供：${versions}）`
        : `service '${id}' 的版本范围写法非法：'${range}'`,
    };
  }
  return { ok: true, provider: hit };
}

/**
 * 依赖图里的环。节点是插件 id，边是"消费方 → 提供方"。
 *
 * 用三色 DFS 而不是 Tarjan：这里最多几十个节点，可读性比渐进复杂度重要，
 * 而且需要把"环上的人"原样报给用户看（Tarjan 还要再回溯一次）。
 *
 * @param {Map<string, string[]>} edges
 * @returns {string[][]} 每个环按遍历顺序给出，首尾同节点（`['a','b','a']`）
 */
function findCycles(edges) {
  const color = new Map(); // 0 未访问 / 1 在栈上 / 2 已完成
  const stack = [];
  const out = [];
  const seen = new Set();

  const visit = (node) => {
    color.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) || []) {
      if (!edges.has(next)) continue; // 只遍历已安装插件之间的事实依赖
      const c = color.get(next) || 0;
      if (c === 1) {
        const at = stack.indexOf(next);
        const cycle = stack.slice(at).concat(next);
        // 同一个环从不同入口会被走到多次，用排序后的节点集合去重
        const key = [...new Set(cycle)].sort().join('>');
        if (!seen.has(key)) {
          seen.add(key);
          out.push(cycle);
        }
      } else if (c === 0) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, 2);
  };

  for (const node of edges.keys()) {
    if ((color.get(node) || 0) === 0) visit(node);
  }
  return out;
}

module.exports = {
  SERVICE_ID_RE,
  SERVICE_METHOD_RE,
  RANGE_TOKEN_RE,
  MAX_CALL_DEPTH,
  SERVICE_ERR,
  isServiceId,
  isServiceMethod,
  isVersionRange,
  resolveService,
  findCycles,
};
