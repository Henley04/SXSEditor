'use strict';
/**
 * 随应用分发的内置插件 id 清单 —— 打包拷贝、启动安装、完整性守卫的唯一事实源。
 *
 * 为什么单独抽一份：以前只有 official-project-import 一个内置插件，id 硬编码在
 * builtinPlugins.js、webpack.main.config.js 和测试三处。加入 example-sv2 后若仍各写
 * 一份，任何一处漏加都会变成「包里有源码但启动不装」或「启动了但打包没拷」，
 * 而且这类故障只在全新安装的用户机器上暴露，开发机上极难复现。
 *
 * id 必须与插件目录名、manifest.id 三者一致：随包目录按它定位，安装时按它校验，
 * 用户插件目录也以它命名。
 */
const BUILTIN_PLUGIN_IDS = Object.freeze([
  // VOCALOID / Synthesizer V 工程（.vsqx / .vpr / .svp）的读写。
  'official-project-import',
  // .sv2 示例工程格式的双向读写（伴奏可内嵌或按相对路径旁挂）。
  'example-sv2',
]);

module.exports = { BUILTIN_PLUGIN_IDS };
