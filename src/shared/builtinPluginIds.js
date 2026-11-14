'use strict';
/**
 * 随应用分发的内置插件 id 清单 —— 打包拷贝、启动安装、完整性守卫的唯一事实源。
 *
 * 为什么单独抽一份：内置插件的 id 曾经硬编码在 builtinPlugins.js、
 * webpack.main.config.js 和测试三处。任何一处漏加都会变成「包里有源码但启动不装」
 * 或「启动了但打包没拷」，而且这类故障只在全新安装的用户机器上暴露，开发机上
 * 极难复现。现在三处都从这里取清单，新增内置插件只需改这一处。
 *
 * id 必须与插件目录名、manifest.id 三者一致：随包目录按它定位，安装时按它校验，
 * 用户插件目录也以它命名。
 *
 * 目前只有一个内置插件：真实外部工程格式（VOCALOID / Synthesizer V）统一由
 * official-project-import 处理。曾有一个自造示例格式的插件随包分发，但那既不是
 * 真实的 Synthesizer V 2 工程（SV1/SV2 都用 .svp），也不是用户需要的外部格式
 * 支持，已彻底移除。示例/教学用的虚构工程格式只保留在文档与测试里的中性名
 * `.demo`，不随应用分发、不占用真实格式扩展名。
 */
const BUILTIN_PLUGIN_IDS = Object.freeze([
  // VOCALOID (.vsqx / .vpr) 与 Synthesizer V (.svp，SV1/SV2 双世代) 的读写。
  'official-project-import',
]);

module.exports = { BUILTIN_PLUGIN_IDS };
