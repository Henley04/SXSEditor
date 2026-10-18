// gpuCache —— systeminformation.graphics() 的短 TTL 缓存。
//
// 模块系统修正（审查项 §5）：本文件此前写的是 ESM `export`，却被
// src/inference/pipeline/modelLoader.js 以 CJS `require` 引入。webpack 下靠
// interop 侥幸能跑，但一旦走非 webpack 路径（测试、worker，或被 CopyPlugin
// 原样拷贝后由 node 直接加载），`require()` 一个 ESM 文件会直接 SyntaxError。
// 本文件是纯主进程工具，统一改成 CommonJS，与 modelLoader 的 require 对齐。
let _cache = null;
let _cacheTime = 0;
const TTL = 5000;

async function getGraphicsCached() {
  const now = Date.now();
  if (_cache && now - _cacheTime < TTL) return _cache;
  const si = require('systeminformation');
  _cache = await si.graphics();
  _cacheTime = now;
  return _cache;
}

module.exports = { getGraphicsCached, GPU_CACHE_TTL: TTL };
