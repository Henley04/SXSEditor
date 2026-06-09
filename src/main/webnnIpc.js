const { ipcMain } = require('electron');
const { getMainWindow } = require('./windowManager');
const fs = require('node:fs');

function getMainWindowWebContents() {
  const win = getMainWindow();
  return win && !win.isDestroyed() ? win.webContents : null;
}

let _npuDetectionCache = null;

function registerWebnnIpc() {
  ipcMain.handle('webnn:detectNPU', async () => {
    if (_npuDetectionCache) return _npuDetectionCache;

    const wc = getMainWindowWebContents();
    if (!wc) {
      return { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'No renderer window' };
    }

    return new Promise((resolve) => {
      const requestId = `webnn-detect-${Date.now()}`;
      const timeout = setTimeout(() => {
        const result = { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'Detection timeout' };
        _npuDetectionCache = result;
        resolve(result);
      }, 10000);

      ipcMain.handleOnce(`webnn:detectNPU:response:${requestId}`, async (_, result) => {
        clearTimeout(timeout);
        _npuDetectionCache = result;
        resolve(result);
      });

      wc.send('webnn:detectNPU:request', { requestId });
    });
  });

  ipcMain.handle('webnn:loadModel', async (_, modelId, modelPath, options) => {
    const wc = getMainWindowWebContents();
    if (!wc) return { success: false, error: 'No renderer window' };

    return new Promise((resolve) => {
      const requestId = `webnn-load-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Load model timeout' });
      }, 120000);

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
  // 使用独立 ArrayBuffer 避免池化 buffer 的共享问题，IPC 结构化克隆零拷贝传输
  ipcMain.handle('webnn:readModelFile', async (_, filePath) => {
    try {
      const data = await fs.promises.readFile(filePath);
      // 创建独立 ArrayBuffer（避免 Node.js Buffer 池化导致的共享问题）
      // IPC 结构化克隆会直接转移此 ArrayBuffer 的所有权，零拷贝
      const ab = new ArrayBuffer(data.byteLength);
      new Uint8Array(ab).set(data);
      return { success: true, data: ab };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

/**
 * Detect NPU availability via WebNN API (renderer process).
 * Reuses the existing webnn:detectNPU:request channel.
 * Returns { npuAvailable: boolean, details: string }
 */
async function detectNPUAvailability() {
  if (_npuDetectionCache) {
    return { npuAvailable: !!_npuDetectionCache.npuAvailable, details: _npuDetectionCache.details || '' };
  }

  try {
    const result = await new Promise((resolve) => {
      const wc = getMainWindowWebContents();
      if (!wc) {
        resolve({ npuAvailable: false, details: 'No renderer window' });
        return;
      }

      const requestId = `webnn-detect-npu-avail-${Date.now()}`;
      const timeout = setTimeout(() => {
        resolve({ npuAvailable: false, details: 'Detection timeout' });
      }, 10000);

      ipcMain.handleOnce(`webnn:detectNPU:response:${requestId}`, async (_, result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      wc.send('webnn:detectNPU:request', { requestId });
    });

    // Cache all results (including failures) to avoid repeated slow detection
    _npuDetectionCache = result;
    return { npuAvailable: !!result.npuAvailable, details: result.details || '' };
  } catch (err) {
    const failResult = { npuAvailable: false, details: err.message };
    _npuDetectionCache = failResult;
    return failResult;
  }
}

/**
 * Mark NPU as unavailable (e.g. after a failed probe).
 * Updates the cache so subsequent calls skip detection.
 */
function markNPUUnavailable(reason) {
  _npuDetectionCache = {
    webnnAvailable: false,
    npuAvailable: false,
    gpuAvailable: false,
    details: reason || 'NPU probe failed',
  };
}

module.exports = {
  registerWebnnIpc,
  detectNPUAvailability,
  markNPUUnavailable,
};
