// 通过命名空间调用 execFile（而不是在导入时解构）：解构会把函数引用固化，
// 测试无法打桩，模块也拿不到运行时的替换实现。
const childProcess = require('node:child_process');

// 系统级 NPU 硬件检测（不依赖 WebNN / navigator.ml）。
//
// 抽成独立模块的原因：WebNN 检测（src/main/webnnIpc.js）与硬件聚合检测
// （src/main/gpuInfo.js）都需要它，放在任意一侧都会形成循环 require。
//
// 背景：NPU 在不同厂商/驱动版本下会被归入不同的 PnP 设备类，且 FriendlyName
// 各不相同。旧实现只匹配 `Class -eq "ComputeAccelerator"`，会漏掉被归到
// System / SoftwareDevice 下的 Intel AI Boost，导致有 NPU 的机器被判定为
// “探测不到 NPU”。

let _pnpNpuCache = null;
let _pnpNpuTime = 0;
const PNP_NPU_TTL_MS = 5 * 60 * 1000; // 5 分钟

// 输出哨兵标记：PowerShell 可能夹带进度条、警告、BOM 等额外输出，
// 直接解析纯数字极易失配（旧实现的 /^\s*[1-9]\d*\s*$/ 正则就因此长期误判）。
// 改为输出 SXSNPU=<n> 后用正则提取，与无关输出完全解耦。
const PNP_SENTINEL = 'SXSNPU=';

// 设备类：ComputeAccelerator 是 Windows 的 “神经处理器” 类，
// NeuralProcessor / Accelerator 出现在部分驱动与 OEM 变体上。
const NPU_CLASSES = ['ComputeAccelerator', 'NeuralProcessor', 'Accelerator'];
// FriendlyName 关键字：覆盖 Intel AI Boost / AMD XDNA / Ryzen AI /
// Qualcomm Hexagon / 各家的 NPU 命名。
//
// NPU 必须带 \b 词边界：裸 `NPU` 会命中 "I-npu-t"（实测把
// "Microsoft Input Configuration Device" 和 "USB Input Device" 误判为 NPU，
// 于是没有 NPU 的机器也会显示 "NPU 可用"）。
const NPU_NAME_REGEX = '\\bNPU\\b|AI Boost|XDNA|Ryzen AI|Hexagon|Neural Processing|Neural Compute';

function buildPnpCommand() {
  const classFilter = NPU_CLASSES.map((c) => `$_.Class -eq '${c}'`).join(' -or ');
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$ProgressPreference = "SilentlyContinue"',
    // -PresentOnly 排除不存在/已拔出的设备；Status -eq 'OK' 排除有问题的设备，
    // 避免把驱动异常的 NPU 报告为可用。
    `$d = @(Get-PnpDevice -PresentOnly | Where-Object { $_.Status -eq 'OK' -and ((${classFilter}) -or $_.FriendlyName -match '${NPU_NAME_REGEX}') })`,
    `Write-Output "${PNP_SENTINEL}$($d.Count)"`,
  ].join('; ');
}

/**
 * 从 PowerShell 输出中解析命中数量。
 * 只要输出里出现过 `SXSNPU=<n>` 就采信，忽略进度条/警告等无关内容。
 * @param {string} stdout
 * @returns {number} 命中的 NPU 设备数
 */
function parsePnpOutput(stdout) {
  const match = new RegExp(`${PNP_SENTINEL}(\\d+)`).exec(String(stdout || ''));
  return match ? Number(match[1]) : 0;
}

/**
 * 系统级 NPU 硬件检测：枚举当前存在的 PnP 设备，匹配 NPU 设备类或已知 NPU
 * 设备名。不依赖 WebNN。
 * @returns {Promise<boolean>}
 */
async function detectNPUByPnp() {
  if (process.platform !== 'win32') return false;
  if (_pnpNpuCache !== null && Date.now() - _pnpNpuTime < PNP_NPU_TTL_MS) return _pnpNpuCache;

  return new Promise((resolve) => {
    childProcess.execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildPnpCommand()],
      { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        // Node 在超时/超 buffer 时会把 stdout 置为已收到的部分内容，
        // 因此即使 err 非空也尝试解析哨兵，避免把慢机器误判为无 NPU。
        const count = parsePnpOutput(stdout);
        const ok = count > 0;
        if (ok) console.log(`[Main] NPU detected via PnP (${count} device(s))`);
        else if (err) console.warn('[Main] NPU PnP probe failed:', err.message);
        _pnpNpuCache = ok;
        _pnpNpuTime = Date.now();
        resolve(ok);
      },
    );
  });
}

/** 使 PnP NPU 缓存失效（切换语言模型 / 用户手动重新检测时调用） */
function invalidatePnpNpuCache() {
  _pnpNpuCache = null;
  _pnpNpuTime = 0;
}

module.exports = {
  detectNPUByPnp,
  invalidatePnpNpuCache,
  // 供单元测试使用
  __test: { PNP_SENTINEL, NPU_NAME_REGEX, buildPnpCommand, parsePnpOutput },
};
