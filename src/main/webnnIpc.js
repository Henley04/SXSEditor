const { ipcMain } = require('electron');
const { getMainWindow } = require('./windowManager');
const fs = require('node:fs');
const path = require('node:path');
const { isPathAllowed, isSystemPath } = require('./security');
const { getModelDir } = require('./modelDir');
// 系统级 PnP NPU 检测（独立模块，避免与 gpuInfo 循环 require）
const { detectNPUByPnp, invalidatePnpNpuCache } = require('./npuHardware');

// Model files read via webnn:readModelFile are capped at 2GB to prevent a
// compromised renderer from forcing the main process to allocate unbounded
// memory (and to bound peak memory for the dedicated ArrayBuffer transfer).
const MAX_MODEL_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

/**
 * Validate that a file path is safe to read as an ONNX model file.
 * - must be a non-empty string
 * - must not point at a system directory
 * - must end with .onnx or .onnx.data (model files only)
 * - must be within the configured model dir or an otherwise-allowed path
 */
function _isModelFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  let resolved;
  try {
    resolved = path.resolve(filePath);
  } catch (_) {
    return false;
  }
  if (isSystemPath(resolved)) return false;
  const lower = resolved.toLowerCase();
  if (!lower.endsWith('.onnx') && !lower.endsWith('.onnx.data')) return false;
  const normResolved = resolved.replace(/\\/g, '/');
  try {
    const normModelDir = path.resolve(getModelDir()).replace(/\\/g, '/');
    if (normResolved === normModelDir || normResolved.startsWith(normModelDir + '/')) return true;
  } catch (_) {}
  return isPathAllowed(resolved);
}

function getMainWindowWebContents() {
  const win = getMainWindow();
  return win && !win.isDestroyed() ? win.webContents : null;
}

let _npuDetectionCache = null;
let _npuFailureTime = 0;
// W12: 成功结果也需过期，否则 NPU 运行中变为不可用时仍会返回陈旧的成功缓存
let _npuSuccessTime = 0;
const NPU_FAILURE_TTL_MS = 5 * 60 * 1000; // 5 分钟后允许重新检测
const NPU_SUCCESS_TTL_MS = 5 * 60 * 1000; // W12: 成功缓存 5 分钟后重新检测

// 渲染进程单次检测的超时。
// 原来是 10s：NPU 冷启动（驱动 + OpenVINO/QNN 编译器首次初始化）加上
// NPU/CPU 双路 benchmark 经常超过 10s，于是每次都拿到 "Detection timeout"，
// UI 就一直显示 "WebNN 不可用"。放宽到 30s。
const NPU_DETECT_TIMEOUT_MS = 30000;

// 渲染进程就绪等待上限。
// webContents.send() 在渲染进程注册好监听器之前发出的消息会被静默丢弃，
// 主进程只能干等到超时。启动早期探测（main.js Step 4）存在这种竞态：
// 不加等待就会白等满 NPU_DETECT_TIMEOUT_MS 才回退，把启动流程拖住。
const RENDERER_READY_WAIT_MS = 8000;

/**
 * 等待渲染进程主框架加载完成。
 * @returns {Promise<boolean>} 超时仍未加载完成则返回 false
 */
function _waitForRendererReady(wc) {
  if (!wc || wc.isDestroyed()) return Promise.resolve(false);
  if (!wc.isLoadingMainFrame() && wc.getURL()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const onLoad = () => finish(true);
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { wc.removeListener('did-finish-load', onLoad); } catch (_) { /* wc 已销毁 */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), RENDERER_READY_WAIT_MS);
    wc.on('did-finish-load', onLoad);
  });
}

// 并发去重：设置页、启动探测、管线初始化可能同时发起检测。旧实现会为每个
// 调用各注册一个 handleOnce 并各起一个 10s 定时器，互相之间还会因为
// removeHandler 抢删对方的 handler，导致先到的响应被丢弃后超时。
let _npuDetectPending = null;

/**
 * 统一的检测结果归一化。
 *
 * 语义区分（关键修复点）：
 *  - npuAvailable       : NPU **硬件**是否存在（WebNN 探测为真，或 WebNN
 *                         不可用但系统级 PnP 探测命中）。用于「NPU 可用」
 *                         指示与 OpenVINO NPU gate。
 *  - webnnNpuAvailable  : NPU 在 **WebNN 路径下**真正可用。用于决定是否走
 *                         WebNN 分支、是否把 'NPU (WebNN)' 列为可选设备。
 *  - webnnAvailable     : WebNN 整体可用（WebNN NPU 或 WebNN GPU）。
 *
 * 旧实现把三者混为一谈：WebNN 不可用时 npuAvailable 恒为 false，于是
 * 「有 NPU 硬件但 WebNN 不可用」的机器一律显示“探测不到 NPU”。
 */
function _normalizeResult(webnnNpu, gpu, npu, details, webnnApi) {
  return {
    webnnAvailable: !!(webnnNpu || gpu),
    webnnNpuAvailable: !!webnnNpu,
    webnnApiAvailable: !!(webnnApi || webnnNpu || gpu),
    gpuAvailable: !!gpu,
    npuAvailable: !!npu,
    details: details || '',
  };
}

/**
 * 创建一个在超时后自动清理对应 IPC handler 的 timeout。
 * 避免 renderer 未响应时 handleOnce handler 一直残留。
 */
function _createIpcTimeout(responseChannel, ms, callback) {
  return setTimeout(() => {
    try { ipcMain.removeHandler(responseChannel); } catch (_) { /* handler 可能已被响应移除 */ }
    callback();
  }, ms);
}

/**
 * W14: 统一的 WebNN IPC 超时响应结构，调用方可用 `result.success === false`
 * 或 `result.error === 'timeout'` 一致地判断超时。
 */
function _timeoutResult(channel, ms) {
  return { success: false, error: 'timeout', message: `${channel} timed out after ${ms}ms` };
}

/**
 * 判断缓存是否已过期（失败或成功结果超过各自 TTL 则允许重新检测）。
 * W12: 成功结果也应用 TTL，防止 NPU 运行中变为不可用时仍返回陈旧的成功缓存。
 */
function _isTransientDetectionFailure(result) {
  const details = String(result && result.details || '').toLowerCase();
  // 渲染进程尚未就绪 —— WebNN 结论完全未知。即使 PnP 命中了 NPU 硬件也必须
  // 判为瞬时失败，否则启动早期的一次探测会把"WebNN 未知"缓存 5 分钟，
  // 应用在这期间再也学不到 WebNN 其实可用。
  if (details.includes('no renderer window') || details.includes('renderer not ready')) return true;
  // 已得出硬件结论（含 PnP 回退）的其它情况不算瞬时失败。否则 details 里
  // 残留的 "Detection timeout" 会让结果永不入缓存，每次调用都重跑完整探测。
  if (result && (result.npuAvailable || result.gpuAvailable)) return false;
  return details.includes('detection timeout')
    || details.includes('module not available');
}

function _isCacheExpired() {
  if (!_npuDetectionCache) return true;
  const isFailure = !_npuDetectionCache.npuAvailable && !_npuDetectionCache.gpuAvailable;
  if (isFailure) {
    if (!_npuFailureTime) return false;
    return Date.now() - _npuFailureTime > NPU_FAILURE_TTL_MS;
  }
  // 成功结果：超过 success TTL 则视为过期
  if (!_npuSuccessTime) return true;
  return Date.now() - _npuSuccessTime > NPU_SUCCESS_TTL_MS;
}

function registerWebnnIpc() {
  ipcMain.handle('webnn:detectNPU', async () => detectNPUAvailability());

  ipcMain.handle('webnn:loadModel', async (_, modelId, modelPath, options) => {
    const wc = getMainWindowWebContents();
    if (!wc) return { success: false, error: 'No renderer window' };

    // Allow per-model timeout override (vocoder NPU compilation needs more time)
    const loadTimeout = (options && options.timeout) || 120000;

    return new Promise((resolve) => {
      const requestId = `webnn-load-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const responseChannel = `webnn:loadModel:response:${requestId}`;
      const timeout = _createIpcTimeout(responseChannel, loadTimeout, () => {
        // W14: 标准化超时响应结构
        resolve(_timeoutResult('webnn:loadModel', loadTimeout));
      });

      ipcMain.handleOnce(responseChannel, async (_, result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      wc.send('webnn:loadModel:request', { requestId, modelId, modelPath, options });
    });
  });

  ipcMain.handle('webnn:unloadModel', async (_, modelId) => {
    const wc = getMainWindowWebContents();
    if (!wc) return { success: false, error: 'No renderer window' };

    return new Promise((resolve) => {
      const requestId = `webnn-unload-${Date.now()}`;
      const responseChannel = `webnn:unloadModel:response:${requestId}`;
      const timeout = _createIpcTimeout(responseChannel, 10000, () => {
        // W14: 标准化超时响应结构
        resolve(_timeoutResult('webnn:unloadModel', 10000));
      });

      ipcMain.handleOnce(responseChannel, async (_, result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      wc.send('webnn:unloadModel:request', { requestId, modelId });
    });
  });

  ipcMain.handle('webnn:runInference', async (_, modelId, inputs) => {
    const wc = getMainWindowWebContents();
    if (!wc) throw new Error('No renderer window');

    return new Promise((resolve, reject) => {
      const requestId = `webnn-infer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const responseChannel = `webnn:runInference:response:${requestId}`;
      const timeout = _createIpcTimeout(responseChannel, 120000, () => {
        // W14: 保持 reject，但在 Error 上暴露稳定的 code: 'timeout' 字段，
        // 与其它通道的超时响应结构保持一致（调用方可统一用 code/error 判断超时）
        const err = new Error('webnn:runInference timed out after 120000ms');
        err.code = 'timeout';
        reject(err);
      });

      ipcMain.handleOnce(responseChannel, async (_, result) => {
        clearTimeout(timeout);
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      });

      wc.send('webnn:runInference:request', { requestId, modelId, inputs });
    });
  });

  ipcMain.handle('webnn:getStatus', async () => {
    const wc = getMainWindowWebContents();
    if (!wc) return {};

    return new Promise((resolve) => {
      const requestId = `webnn-status-${Date.now()}`;
      const responseChannel = `webnn:getStatus:response:${requestId}`;
      const timeout = _createIpcTimeout(responseChannel, 5000, () => {
        // W14: 标准化超时响应结构（原先返回空对象 {}，调用方难以判断超时）
        resolve(_timeoutResult('webnn:getStatus', 5000));
      });

      ipcMain.handleOnce(responseChannel, async (_, result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      wc.send('webnn:getStatus:request', { requestId });
    });
  });

  // 完整合成管线 — 在渲染进程本地运行所有推理，消除逐次 IPC 开销
  ipcMain.handle('webnn:runSynthesis', async (_, params) => {
    const wc = getMainWindowWebContents();
    if (!wc) return { error: 'No renderer window' };

    return new Promise((resolve) => {
      const requestId = `webnn-synth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const responseChannel = `webnn:runSynthesis:response:${requestId}`;
      const timeout = _createIpcTimeout(responseChannel, 600000, () => {
        // W14: 标准化超时响应结构（原先仅返回 { error }，缺少 success 字段）
        resolve(_timeoutResult('webnn:runSynthesis', 600000));
      });

      ipcMain.handleOnce(responseChannel, async (_, result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      wc.send('webnn:runSynthesis:request', { requestId, params });
    });
  });

  // 读取模型文件并返回 ArrayBuffer（沙盒渲染进程无法直接读取文件）
  // 使用 ipcMain.on + event.sender.send 模式以支持 transferList 零拷贝传输，
  // 避免 ipcMain.handle 的结构化克隆复制 846MB 模型文件。
  // 每个请求携带唯一 reqId，回复使用 `webnn:readModelFile:reply:<reqId>` 频道，
  // 避免并发请求时回复错位。
  ipcMain.on('webnn:readModelFile', async (event, payload) => {
    const filePath = typeof payload === 'string' ? payload : payload.filePath;
    const reqId = typeof payload === 'string' ? null : payload.reqId;
    const replyChannel = reqId != null
      ? `webnn:readModelFile:reply:${reqId}`
      : 'webnn:readModelFile:reply';
    // Guard every reply so a destroyed sender doesn't throw and become an
    // unhandled rejection (W18).
    const send = (msg, transferList) => {
      try {
        if (!event.sender.isDestroyed()) {
          event.sender.send(replyChannel, msg, transferList || []);
        }
      } catch (_) {
        // sender gone — nothing to do
      }
    };
    try {
      if (!_isModelFilePath(filePath)) {
        send({ success: false, error: 'Path not allowed' });
        return;
      }
      const resolved = path.resolve(filePath);
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile()) {
        send({ success: false, error: 'Not a file' });
        return;
      }
      if (stat.size > MAX_MODEL_FILE_SIZE) {
        send({ success: false, error: 'File too large' });
        return;
      }

      // W16 (verified in place): read directly into a dedicated ArrayBuffer
      // sized to the file size, then transfer it. This avoids the Node Buffer
      // pool and the extra copy that doubled peak memory for large models (the
      // old code readFile'd into a Buffer then copied into a fresh ArrayBuffer
      // for transfer). No additional Buffer allocation occurs here.
      const size = stat.size;
      const ab = new ArrayBuffer(size);
      const view = new Uint8Array(ab);
      const handle = await fs.promises.open(resolved, 'r');
      let offset = 0;
      try {
        while (offset < size) {
          const bytesRead = await handle.read(view, offset, size - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
      } finally {
        await handle.close();
      }
      if (offset !== size) {
        send({ success: false, error: 'Incomplete read' });
        return;
      }
      send({ success: true, data: ab }, [ab]);
    } catch (e) {
      send({ success: false, error: e.message });
    }
  });
}

/**
 * Detect WebNN/NPU/GPU availability via WebNN API (renderer process).
 * Reuses the existing webnn:detectNPU:request channel.
 * When WebNN reports no usable NPU, falls back to system-level PnP hardware
 * detection so a machine with an NPU is never reported as "no NPU".
 *
 * Returns {
 *   webnnAvailable: boolean,    // WebNN usable (NPU or GPU)
 *   webnnNpuAvailable: boolean, // NPU usable through WebNN
 *   webnnApiAvailable: boolean, // navigator.ml present
 *   npuAvailable: boolean,      // NPU hardware present (WebNN or PnP)
 *   gpuAvailable: boolean,      // WebNN GPU usable
 *   details: string,
 * }
 */
async function detectNPUAvailability() {
  // 缓存超过 TTL（失败或成功）时清除并重新检测（W12: 成功结果也会过期）
  if (_npuDetectionCache && _isCacheExpired()) {
    _npuDetectionCache = null;
    _npuFailureTime = 0;
    _npuSuccessTime = 0;
  }

  if (_npuDetectionCache) return { ..._npuDetectionCache };

  // 并发去重：所有调用方共享同一次探测
  if (_npuDetectPending) return _npuDetectPending;

  _npuDetectPending = (async () => {
    // 与 WebNN 探测并行启动系统级 PnP 探测，避免"先等 WebNN 超时、再跑
    // PowerShell"的串行耗时。PnP 结果仅在 WebNN 判定无 NPU 时作为回退使用。
    const pnpPromise = detectNPUByPnp().catch(() => false);

    let result;
    try {
      result = await new Promise((resolve) => {
        const wc = getMainWindowWebContents();
        if (!wc) {
          resolve({ webnnAvailable: false, webnnNpuAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'No renderer window' });
          return;
        }

        const unavailable = (details) => resolve({
          webnnAvailable: false, webnnNpuAvailable: false, npuAvailable: false, gpuAvailable: false, details,
        });

        // 等渲染进程就绪再发请求；否则 send 的消息会被丢弃，只能干等到超时
        _waitForRendererReady(wc).then((ready) => {
          if (!ready) {
            unavailable('Renderer not ready');
            return;
          }

          const requestId = `webnn-detect-npu-avail-${Date.now()}`;
          const responseChannel = `webnn:detectNPU:response:${requestId}`;
          const timeout = _createIpcTimeout(responseChannel, NPU_DETECT_TIMEOUT_MS, () => {
            unavailable('Detection timeout');
          });

          ipcMain.handleOnce(responseChannel, async (_, r) => {
            clearTimeout(timeout);
            resolve(r || {});
          });

          wc.send('webnn:detectNPU:request', { requestId });
        });
      });
    } catch (err) {
      result = { details: err.message };
    }

    const webnnNpu = !!(result.npuAvailable || result.webnnNpuAvailable);
    const gpu = !!result.gpuAvailable;
    let npu = webnnNpu;
    let details = String(result.details || '');

    // WebNN 探测不到 NPU 时回退到系统级 PnP 硬件检测：
    // 「WebNN 不可用」≠「没有 NPU」。没有这层回退，装有 Intel AI Boost /
    // AMD XDNA / Qualcomm Hexagon 的机器会一律显示"探测不到 NPU"。
    if (!npu) {
      const pnp = await pnpPromise;
      if (pnp) {
        npu = true;
        details = (details ? `${details}; ` : '') + 'NPU hardware present (PnP), WebNN NPU unavailable';
      }
    }

    const final = _normalizeResult(webnnNpu, gpu, npu, details, result.webnnApiAvailable);

    // Cache all results (including failures) to avoid repeated slow detection
    _npuDetectionCache = _isTransientDetectionFailure(final) ? null : final;
    // Do not cache renderer startup races as a five-minute hardware failure.
    if (!_npuDetectionCache) {
      _npuFailureTime = 0;
      _npuSuccessTime = 0;
    } else if (!npu && !gpu) {
      _npuFailureTime = Date.now();
      _npuSuccessTime = 0;
    } else {
      _npuFailureTime = 0;
      _npuSuccessTime = Date.now();
    }
    return final;
  })().finally(() => {
    _npuDetectPending = null;
  });

  return _npuDetectPending;
}

/**
 * Mark NPU as unavailable (e.g. after a failed probe).
 * Updates the cache so subsequent calls skip detection (until TTL expires).
 */
function markNPUUnavailable(reason) {
  _npuDetectionCache = {
    webnnAvailable: false,
    webnnNpuAvailable: false,
    npuAvailable: false,
    gpuAvailable: false,
    details: reason || 'NPU probe failed',
  };
  _npuFailureTime = Date.now();
  _npuSuccessTime = 0;
}

/**
 * Clear the NPU failure cache so the next detectNPUAvailability() re-detects.
 * Called when language models are swapped (new models may behave differently on NPU).
 */
function clearNPUFailureCache() {
  // W12: 同时清除成功缓存（成功结果也带 TTL，语言切换后应立即重新检测）
  _npuDetectionCache = null;
  _npuFailureTime = 0;
  _npuSuccessTime = 0;
  invalidatePnpNpuCache();
  // W12: 通知渲染进程清除其本地 _detectionCache。主进程清缓存后若不清渲染端，
  // 切换语言模型时渲染端仍会返回陈旧检测结果。渲染端通过 preload 桥接监听
  // 'webnn:clearNpuCache'（若桥接未暴露则依赖渲染端 success-TTL 自动过期，无副作用）。
  const wc = getMainWindowWebContents();
  if (wc) {
    try { wc.send('webnn:clearNpuCache'); } catch (_) { /* renderer gone — nothing to do */ }
  }
}

module.exports = {
  registerWebnnIpc,
  detectNPUAvailability,
  markNPUUnavailable,
  clearNPUFailureCache,
};
