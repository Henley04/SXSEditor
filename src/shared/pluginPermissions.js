/**
 * 插件权限声明与模块分类（审查项 A1）—— CommonJS。
 *
 * 为什么单独一个文件且不写成 ESM：这份逻辑要被 **主进程**（pluginHost.js）、
 * **插件 worker 线程**（pluginWorker.js，由 node 直接加载而非 webpack 打包）
 * 以及 renderer 侧共用。写成 ESM 会让 `require()` 在 node 直载路径下直接
 * SyntaxError（同 gpuCache.js 那次踩的坑），所以这里用 CommonJS，
 * src/shared/pluginContract.js（ESM）再 re-export 给渲染层。
 *
 * 背景：worker_threads **不是安全边界**。插件入口一旦被 require，它就与宿主
 * 同进程：可以 require('child_process') 起子进程（terminate() 杀不掉）、读写
 * userData 下的配置与模型、往磁盘落持久化文件。真正的隔离需要 utilityProcess
 * （独立进程 + 可裁剪的权限），那是后续项；这里先提供"声明 + 拦截"的软约束，
 * 让插件的能力成为可审计的显式声明，而不是默认全开。
 */

/**
 * 可声明的权限组 → 该组覆盖的模块名。
 * 未出现在任何组里的模块（path / os / crypto …）不拦截 —— 只拦真正能逃逸出
 * 宿主生命周期管理的那几类。
 */
const PLUGIN_PERMISSIONS = Object.freeze({
  // 执行子进程：最危险，worker.terminate() 管不到已经 fork 出去的进程
  child_process: ['child_process', 'node:child_process'],
  // 文件系统：可以碰到 userData 下的配置与模型，也能落持久化
  fs: ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'],
  // 网络：外传数据 / 拉取可执行内容
  net: ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'dns', 'node:dns', 'tls', 'node:tls'],
  // 再起一个 worker：同样不受 terminate() 管辖
  worker: ['worker_threads', 'node:worker_threads'],
  // 动态执行代码
  vm: ['vm', 'node:vm'],
});

/**
 * 模块名 → 所属权限组；不属于任何高危组返回 null（不拦截）。
 * @param {string} request require() 的实参
 * @returns {string|null}
 */
function classifyModulePermission(request) {
  if (typeof request !== 'string') return null;
  const name = request.startsWith('node:') ? request.slice(5) : request;
  for (const [group, modules] of Object.entries(PLUGIN_PERMISSIONS)) {
    if (modules.includes(name) || modules.includes(`node:${name}`)) return group;
  }
  return null;
}

/**
 * 校验 manifest.permissions：可选字段，必须是已知权限名数组。
 * 缺省（undefined/null）表示"不启用拦截"，返回空数组 —— 兼容存量插件。
 * @param {unknown} perms
 * @returns {{ok: true, value: string[]} | {ok: false, error: string}}
 */
function validatePermissions(perms) {
  if (perms === undefined || perms === null) return { ok: true, value: [] };
  if (!Array.isArray(perms)) return { ok: false, error: 'manifest.permissions 必须是数组' };
  const known = new Set(Object.keys(PLUGIN_PERMISSIONS));
  const out = [];
  for (const p of perms) {
    if (typeof p !== 'string' || !known.has(p)) {
      return {
        ok: false,
        error: `manifest.permissions 含未知项：${JSON.stringify(p)}（可选：${[...known].join(', ')}）`,
      };
    }
    if (!out.includes(p)) out.push(p);
  }
  return { ok: true, value: out };
}

module.exports = {
  PLUGIN_PERMISSIONS,
  classifyModulePermission,
  validatePermissions,
};
