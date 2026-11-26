'use strict';
/**
 * 内置推理管线是否需要初始化 —— 全局唯一真源。
 *
 * 插件后端（type:'plugin'）不依赖任何内置 ONNX 模型。若工程里没有由内置模型
 * 支持的轨道，播放、导出、打开分片编辑器、编辑器内播放都不该再白加载 9 个
 * 模型：没装 SoulX-Singer 的用户会先看到"加载模型"进度条，冷启动白等数秒，
 * 甚至因为缺模型弹出下载框，而这跟插件轨道能否出声毫无关系。
 *
 * 判定一律保守：空分片、singer 缺失、backend 尚未经 IPC 到达、type 不认识，
 * 都返回 true。宁可多加载一次，也绝不误伤正常使用内置模型的工程 —— 这条
 * 保守性由回归测试矩阵锁死。
 *
 * 本模块是纯 CJS 且无依赖：主进程（svsIpc.js）、渲染进程 ESM、分片编辑器 ESM
 * 三处共用同一份判定，避免各自手写 type === 'plugin' 逐渐漂移。
 */

function isPluginBackend(backend) {
  return !!(backend && typeof backend === 'object' && !Array.isArray(backend)
    && backend.type === 'plugin');
}

/**
 * 单个分片是否需要内置管线。
 * @param {object|null} fragment
 * @param {object|null} backend  singer.backend / trackBackend，可未归一化
 * @returns {boolean}
 */
function needsBuiltinForFragment(fragment, backend) {
  if (!fragment) return true;
  if (isPluginBackend(backend)) return false;
  return true;
}

/**
 * 整批分片是否需要内置管线：只要有任意一个分片需要，就返回 true。
 * @param {Array<object>} fragments
 * @param {Map<string, object>|Record<string, object>} singerMap  singerId → singer
 * @returns {boolean}
 */
function needsBuiltinPipeline(fragments, singerMap) {
  if (!Array.isArray(fragments) || fragments.length === 0) return true;
  return fragments.some((fragment) => {
    const singer = singerMap && (typeof singerMap.get === 'function'
      ? singerMap.get(fragment.singerId)
      : singerMap[fragment.singerId]);
    if (!singer) return true;
    return needsBuiltinForFragment(fragment, singer && singer.backend);
  });
}

module.exports = {
  isPluginBackend,
  needsBuiltinForFragment,
  needsBuiltinPipeline,
};
