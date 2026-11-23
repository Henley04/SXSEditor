'use strict';
/**
 * vcRuntime.js —— Windows 上 VC++ 运行库（Visual C++ Redistributable 2015-2022）
 * 的探测与原生模块加载失败的归类，全局唯一真源。
 *
 * 背景（旧机器"静默失败 / binding 未找到"）：
 *   · onnxruntime.dll 与自研的 ort_bridge.node 都是 MSVC（VS2019/2022 工具链）
 *     编译的原生模块，动态依赖 UCRT + vcruntime140.dll / vcruntime140_1.dll /
 *     msvcp140.dll，由 "VC++ 2015-2022 Redistributable (x64)" 提供。
 *   · 精简版 / 长期未更新的 Windows 可能缺这套运行库。此时 Windows 加载器报
 *     ERROR_MOD_NOT_FOUND(126) / ERROR_DLL_INIT_FAILED(1114) / ERROR_BAD_EXE_FORMAT(193)，
 *     而 Node 的 require()/process.dlopen() 只是把错误上抛，旧加载器又把多行
 *     错误压成第一行，最终统一显示成 "native module not found" —— 真正的
 *     "缺运行库"原因被掩盖，用户只看到 binding 找不到。
 *
 * 本模块：
 *   1. probeVcRuntime() 显式探测三枚关键 DLL，给出 ok / missing 清单；
 *   2. classifyNativeLoadError() 把原生加载异常归到 'vc-runtime' / 'arch' /
 *      'abi' / 'not-found' / 'unknown'，供加载器给出可操作的提示。
 *
 * 纯 CJS、无第三方依赖（复用 node:fs / node:path / node:os）：主进程
 * （envCheckInfo / ortBridge / 独立 index.js）与单测共用同一份判定，避免
 * 各写各的正则逐渐漂移。非 Windows 一律返回 ok:true / supported:false，
 * 不触碰文件系统（CI 跑在 Linux 上，这条路径必须安静且无副作用）。
 */

const fs = require('node:fs');
const path = require('node:path');
const _os = require('node:os');

/** 三枚 DLL 缺任意一枚都会让 MSVC 原生模块加载失败。vcruntime140_1.dll 是
 *  VS2019 16.x+ / VS2022 引入的，旧机器最常见就缺这一枚。 */
const REQUIRED_CRT_DLLS = Object.freeze([
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'msvcp140.dll',
]);

/** 官方下载入口（aka.ms 跳转至最新版 vc_redist.x64.exe）。 */
const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
/**
 * 写进"会被 IPC 脱敏的错误 message"里的无协议写法。带 https:// 的 URL
 * 会被 ipcSafe 的 POSIX_PATH_RE 吞成 http<path>（`:` 后跟 `//`），所以
 * 提示里只留域名+路径，用户补上 https:// 即可访问；完整 URL 仍用于
 * 不经过脱敏的启动日志与 probe.redistUrl。
 */
const VC_REDIST_HINT = 'aka.ms/vs/17/release/vc_redist.x64.exe';

const STATUS = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',
  UNSUPPORTED: 'unsupported',
});

/**
 * 取系统目录里的 System32。允许 overrides 注入以便单测用假 fs 路径；
 * 生产上 SystemRoot/WINDIR 缺省时回落到 C:\Windows。
 * @param {object} [overrides]
 * @returns {string}
 */
function system32Dir(overrides = {}) {
  const root = overrides.windir
    || process.env.SystemRoot
    || process.env.WINDIR
    || 'C:\\Windows';
  return path.join(root, 'System32');
}

/**
 * 探测 VC++ 运行库是否齐备。
 * @param {object} [overrides] 仅供单测注入 { platform, windir, fsModule }
 * @returns {{supported:boolean, ok:boolean, status:string, missing:string[],
 *            checked:string[], system32:string|null, redistUrl:string}}
 */
function probeVcRuntime(overrides = {}) {
  const platform = overrides.platform || process.platform;
  const redistUrl = VC_REDIST_URL;
  if (platform !== 'win32') {
    return {
      supported: false,
      ok: true,
      status: STATUS.UNSUPPORTED,
      missing: [],
      checked: [],
      system32: null,
      redistUrl,
    };
  }
  const system32 = system32Dir(overrides);
  const fsModule = overrides.fsModule || fs;
  const missing = [];
  for (const dll of REQUIRED_CRT_DLLS) {
    let exists = false;
    try {
      exists = fsModule.existsSync(path.join(system32, dll));
    } catch (_) {
      exists = false; // 权限错误也算"不可用"，保守处理
    }
    if (!exists) missing.push(dll);
  }
  return {
    supported: true,
    ok: missing.length === 0,
    status: missing.length === 0 ? STATUS.OK : STATUS.MISSING,
    missing,
    checked: REQUIRED_CRT_DLLS.slice(),
    system32,
    redistUrl,
  };
}

// ---- 原生加载错误归类 ----------------------------------------------------

const LOAD_ERROR_KIND = Object.freeze({
  VC_RUNTIME: 'vc-runtime', // 缺 CRT / 依赖 DLL（126 / 1114 / "specified module"）
  ARCH: 'arch',             // 32/64 位不符（193 / "not a valid Win32 application"）
  ABI: 'abi',               // NODE_MODULE_VERSION 不匹配（127 / 编译目标错）
  NOT_FOUND: 'not-found',   // .node 文件本身不存在
  UNKNOWN: 'unknown',
});

/**
 * 把 require()/process.dlopen() 抛出的异常归类。
 * Windows 错误码可能以十进制数字出现在 message 里（Node 的 UV 错误），
 * 也可能只有英文/中文文案；两者都匹配。调用方只传 err.message 也成立。
 * @param {Error|string} err
 * @returns {{kind:string, code:number|null, message:string}}
 */
function classifyNativeLoadError(err) {
  const message = String((err && err.message) || err || '');
  const lower = message.toLowerCase();

  // 数字错误码只在明确上下文里才算，避免把路径里的 "126"/"193"/"127"
  // （如 C:\app126\ort_bridge.node）或 NODE_MODULE_VERSION 126 误归类。
  const errCode = (n) => new RegExp(
    `(?:win32[ _]?error|error|code|errno|gle)[^0-9]{0,12}\\b${n}\\b`, 'i'
  ).test(message);

  // ABI 信号必须优先于裸错误码：NODE_MODULE_VERSION 126 里的 126 不是
  // ERROR_MOD_NOT_FOUND。原先 has126 先判会把 ABI 错报成缺运行库。
  const abiMismatch = lower.includes('node_module_version')
    || lower.includes('compiled against a different node')
    || lower.includes('the specified procedure could not be found')
    || message.includes('找不到指定的程序')
    || errCode(127);
  if (abiMismatch) {
    return { kind: LOAD_ERROR_KIND.ABI, code: null, message };
  }

  // 文件本身不存在（require 的 MODULE_NOT_FOUND），区别于"加载失败"。
  const notFound = lower.includes('cannot find module')
    || (lower.includes('module_not_found') && !lower.includes('specified module'));
  if (notFound) {
    return { kind: LOAD_ERROR_KIND.NOT_FOUND, code: null, message };
  }

  // 126 = ERROR_MOD_NOT_FOUND：模块或其某个依赖 DLL 找不到 —— 旧机器上
  // 几乎总是缺 vcruntime140*.dll；1114 = ERROR_DLL_INIT_FAILED。
  const has126 = errCode(126) || lower.includes('0x7e');
  const has1114 = errCode(1114);
  const missingModule = lower.includes('the specified module could not be found')
    || message.includes('找不到指定的模块')
    || message.includes('指定的模块找不到');
  const dllInitFailed = lower.includes('dll initialization routine failed')
    || message.includes('动态链接库(dll)初始化例程失败')
    || lower.includes('a dynamic link library (dll) initialization');
  if (has126 || missingModule || has1114 || dllInitFailed) {
    return {
      kind: LOAD_ERROR_KIND.VC_RUNTIME,
      code: has126 ? 126 : (has1114 ? 1114 : null),
      message,
    };
  }

  // 193 = ERROR_BAD_EXE_FORMAT：32/64 位面包不匹配。
  const has193 = errCode(193) || lower.includes('0xc1');
  const badExe = lower.includes('is not a valid win32 application')
    || message.includes('不是有效的 win32 应用程序')
    || lower.includes('bad exe format');
  if (has193 || badExe) {
    return { kind: LOAD_ERROR_KIND.ARCH, code: 193, message };
  }

  return { kind: LOAD_ERROR_KIND.UNKNOWN, code: null, message };
}

/**
 * 把 classifyNativeLoadError 的结果渲染成人类可读的提示（中英对照）。
 * 只作展示，不改变原始终端错误，便于用户直接贴进 issue。
 * @param {{kind:string, code:number|null, message:string}} classified
 * @returns {string|null} 非未知类型返回可操作提示，否则 null
 */
function describeLoadError(classified) {
  if (!classified) return null;
  switch (classified.kind) {
    case LOAD_ERROR_KIND.VC_RUNTIME:
      return '[sxs-ort-bridge] 加载失败：缺少 Visual C++ 运行库或依赖 DLL'
        + `（Windows 错误 ${classified.code || 126}）。`
        + '请安装 Microsoft Visual C++ 2015-2022 Redistributable (x64) 后重启：'
        + `${VC_REDIST_HINT} —— DLL missing / not loadable; install the VC++ 2015-2022 x64 redistributable and restart. (URL: ${VC_REDIST_HINT})`;
    case LOAD_ERROR_KIND.ARCH:
      return '[sxs-ort-bridge] 加载失败：原生模块位数与应用不符（Windows 错误 193）。'
        + '请确认安装的是 x64 版本。 —— native addon architecture mismatch (expected x64).';
    case LOAD_ERROR_KIND.ABI:
      return '[sxs-ort-bridge] 加载失败：原生模块与当前 Electron/Node ABI 不匹配。'
        + '请重新构建（npm run build:native）或重装应用。 —— NODE_MODULE_VERSION mismatch; rebuild the addon.';
    case LOAD_ERROR_KIND.NOT_FOUND:
      return '[sxs-ort-bridge] 加载失败：找不到 ort_bridge.node 二进制文件。'
        + '请确认安装包完整或执行 npm run build:native。 —— addon binary not found.';
    default:
      return null;
  }
}

module.exports = {
  REQUIRED_CRT_DLLS,
  VC_REDIST_URL,
  VC_REDIST_HINT,
  STATUS,
  LOAD_ERROR_KIND,
  system32Dir,
  probeVcRuntime,
  classifyNativeLoadError,
  describeLoadError,
};
