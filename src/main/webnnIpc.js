const { ipcMain } = require('electron');
const { getMainWindow } = require('./windowManager');
const fs = require('node:fs');

function getMainWindowWebContents() {
  const win = getMainWindow();
  return win && !win.isDestroyed() ? win.webContents : null;
}

let _npuDetectionCache = null;
let _npuFailureTime = 0;
const NPU_FAILURE_TTL_MS = 5 * 60 * 1000; // 5 分钟后允许重新检测

/**
 * 判断缓存的失败结果是否已过期（超过 TTL 则允许重新检测）
 */
function _isFailureCacheExpired() {
  if (!_npuDetectionCache) return true;
  // 仅对失败结果（npuAvailable === false 且非成功探测）应用 TTL
  const isFailure = !_npuDetectionCache.npuAvailable && !_npuDetectionCache.gpuAvailable;
  if (!isFailure) return false;
  if (!_npuFailureTime) return false;
  return Date.now() - _npuFailureTime > NPU_FAILURE_TTL_MS;
}

function registerWebnnIpc() {
  ipcMain.handle('webnn:detectNPU', async () => {
    if (_npuDetectionCache && !_isFailureCacheExpired()) return _npuDetectionCache;

    // 失败缓存已过期，清除后重新检测
    if (_npuDetectionCache && _isFailureCacheExpired()) {
      _npuDetectionCache = null;
      _npuFailureTime = 0;
    }

    const wc = getMainWindowWebContents();
    if (!wc) {
      return { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'No renderer window' };
    }

    return new Promise((resolve) => {
      const requestId = `webnn-detect-${Date.now()}`;
      const timeout = setTimeout(() => {
        const result = { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'Detection timeout' };
        _npuDetectionCache = result;
        _npuFailureTime = Date.now();
        resolve(result);
      }, 10000);

      ipcMain.handleOnce(`webnn:detectNPU:response:${requestId}`, async (_, result) => {
        clearTimeout(timeout);
        _npuDetectionCache = result;
        if (!result.npuAvailable && !result.gpuAvailable) {
          _npuFailureTime = Date.now();
        } else {
          _npuFailureTime = 0;
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
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Load model timeout' });
      }, loadTimeout);

      ipcMain.handleOnce(`webnn:loadModel:response:${requestId}`, async (_, result) => {
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
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Unload model timeout' });
      }, 10000);

      ipcMain.handleOnce(`webnn:unloadModel:response:${requestId}`, async (_, result) => {
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
      const timeout = setTimeout(() => {
        reject(new Error('Inference timeout'));
      }, 120000);

      ipcMain.handleOnce(`webnn:runInference:response:${requestId}`, async (_, result) => {
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
      const timeout = setTimeout(() => resolve({}), 5000);

      ipcMain.handleOnce(`webnn:getStatus:response:${requestId}`, async (_, result) => {
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
      const timeout = setTimeout(() => resolve({ error: 'Synthesis timeout' }), 600000);

      ipcMain.handleOnce(`webnn:runSynthesis:response:${requestId}`, async (_, result) => {
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
    try {
      const data = await fs.promises.readFile(filePath);
      // 创建独立 ArrayBuffer（避免 Node.js Buffer 池化导致的共享问题）
      // 通过 transferList 转移所有权给渲染进程，零拷贝
      const ab = new ArrayBuffer(data.byteLength);
      new Uint8Array(ab).set(data);
      event.sender.send(replyChannel, { success: true, data: ab }, [ab]);
    } catch (e) {
      event.sender.send(replyChannel, { success: false, error: e.message });
    }
  });
}

/**
 * Detect WebNN/NPU/GPU availability via WebNN API (renderer process).
 * Reuses the existing webnn:detectNPU:request channel.
 * Returns { webnnAvailable: boolean, npuAvailable: boolean, gpuAvailable: boolean, details: string }
 */
async function detectNPUAvailability() {
  // 失败缓存超过 TTL 时清除并重新检测
  if (_npuDetectionCache && _isFailureCacheExpired()) {
    _npuDetectionCache = null;
    _npuFailureTime = 0;
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
      const timeout = setTimeout(() => {
        resolve({ webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'Detection timeout' });
      }, 10000);

      ipcMain.handleOnce(`webnn:detectNPU:response:${requestId}`, async (_, result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      wc.send('webnn:detectNPU:request', { requestId });
    });

    // Cache all results (including failures) to avoid repeated slow detection
    _npuDetectionCache = result;
    if (!result.npuAvailable && !result.gpuAvailable) {
      _npuFailureTime = Date.now();
    } else {
      _npuFailureTime = 0;
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
}

/**
 * Clear the NPU failure cache so the next detectNPUAvailability() re-detects.
 * Called when language models are swapped (new models may behave differently on NPU).
 */
function clearNPUFailureCache() {
  _npuDetectionCache = null;
  _npuFailureTime = 0;
}

module.exports = {
  registerWebnnIpc,
  detectNPUAvailability,
  markNPUUnavailable,
  clearNPUFailureCache,
};
