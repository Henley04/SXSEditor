const { ipcMain } = require('electron');
const { getMainWindow } = require('./windowManager');
const fs = require('node:fs');
const path = require('node:path');
const { isPathAllowed, isSystemPath } = require('./security');
const { getModelDir } = require('./modelDir');

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
  return details.includes('no renderer window')
    || details.includes('detection timeout')
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
  ipcMain.handle('webnn:detectNPU', async () => {
    if (_npuDetectionCache && !_isCacheExpired()) return _npuDetectionCache;

    // 缓存已过期（失败或成功），清除后重新检测（W12: 成功结果也会过期）
    if (_npuDetectionCache && _isCacheExpired()) {
      _npuDetectionCache = null;
      _npuFailureTime = 0;
      _npuSuccessTime = 0;
    }

    const wc = getMainWindowWebContents();
    if (!wc) {
      return { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'No renderer window' };
    }

    return new Promise((resolve) => {
      const requestId = `webnn-detect-${Date.now()}`;
      const responseChannel = `webnn:detectNPU:response:${requestId}`;
      const timeout = _createIpcTimeout(responseChannel, 10000, () => {
        const result = { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'Detection timeout' };
        _npuDetectionCache = result;
        _npuFailureTime = Date.now();
        _npuSuccessTime = 0;
        resolve(result);
      });

      ipcMain.handleOnce(responseChannel, async (_, result) => {
        clearTimeout(timeout);
        _npuDetectionCache = _isTransientDetectionFailure(result) ? null : result;
        // Startup/IPC races are not hardware verdicts and must be retried.
        if (!_npuDetectionCache) {
          _npuFailureTime = 0;
          _npuSuccessTime = 0;
        } else if (!result.npuAvailable && !result.gpuAvailable) {
          _npuFailureTime = Date.now();
          _npuSuccessTime = 0;
        } else {
          _npuFailureTime = 0;
          _npuSuccessTime = Date.now();
        }
        resolve(result);
      });

      wc.send('webnn:detectNPU:request', { requestId });
    });
  });

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
 * Returns { webnnAvailable: boolean, npuAvailable: boolean, gpuAvailable: boolean, details: string }
 */
async function detectNPUAvailability() {
  // 缓存超过 TTL（失败或成功）时清除并重新检测（W12: 成功结果也会过期）
  if (_npuDetectionCache && _isCacheExpired()) {
    _npuDetectionCache = null;
    _npuFailureTime = 0;
    _npuSuccessTime = 0;
  }

  if (_npuDetectionCache) {
    return {
      webnnAvailable: !!_npuDetectionCache.webnnAvailable,
      npuAvailable: !!_npuDetectionCache.npuAvailable,
      gpuAvailable: !!_npuDetectionCache.gpuAvailable,
      details: _npuDetectionCache.details || '',
    };
  }

  try {
    const result = await new Promise((resolve) => {
      const wc = getMainWindowWebContents();
      if (!wc) {
        resolve({ webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'No renderer window' });
        return;
      }

      const requestId = `webnn-detect-npu-avail-${Date.now()}`;
      const responseChannel = `webnn:detectNPU:response:${requestId}`;
      const timeout = _createIpcTimeout(responseChannel, 10000, () => {
        resolve({ webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'Detection timeout' });
      });

      ipcMain.handleOnce(responseChannel, async (_, result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      wc.send('webnn:detectNPU:request', { requestId });
    });

    // Cache all results (including failures) to avoid repeated slow detection
    _npuDetectionCache = _isTransientDetectionFailure(result) ? null : result;
    // Do not cache renderer startup races as a five-minute hardware failure.
    if (!_npuDetectionCache) {
      _npuFailureTime = 0;
      _npuSuccessTime = 0;
    } else if (!result.npuAvailable && !result.gpuAvailable) {
      _npuFailureTime = Date.now();
      _npuSuccessTime = 0;
    } else {
      _npuFailureTime = 0;
      _npuSuccessTime = Date.now();
    }
    return {
      webnnAvailable: !!(result.webnnAvailable || result.npuAvailable || result.gpuAvailable),
      npuAvailable: !!result.npuAvailable,
      gpuAvailable: !!result.gpuAvailable,
      details: result.details || '',
    };
  } catch (err) {
    const failResult = { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: err.message };
    _npuDetectionCache = failResult;
    _npuFailureTime = Date.now();
    _npuSuccessTime = 0;
    return failResult;
  }
}

/**
 * Mark NPU as unavailable (e.g. after a failed probe).
 * Updates the cache so subsequent calls skip detection (until TTL expires).
 */
function markNPUUnavailable(reason) {
  _npuDetectionCache = {
    webnnAvailable: false,
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
