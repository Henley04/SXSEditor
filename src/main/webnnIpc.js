const { ipcMain, BrowserWindow } = require('electron');

function getMainWindowWebContents() {
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  return win ? win.webContents : null;
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
        _npuDetectionCache = { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'Detection timeout' };
        resolve(_npuDetectionCache);
      }, 15000);

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
}

/**
 * Detect NPU availability via WebNN API (renderer process).
 * Reuses the existing webnn:detectNPU:request channel.
 * Returns { npuAvailable: boolean, details: string }
 */
async function detectNPUAvailability() {
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
      }, 15000);

      ipcMain.handleOnce(`webnn:detectNPU:response:${requestId}`, async (_, result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      wc.send('webnn:detectNPU:request', { requestId });
    });

    if (result.npuAvailable) {
      _npuDetectionCache = result;
    }
    return { npuAvailable: !!result.npuAvailable, details: result.details || '' };
  } catch (err) {
    return { npuAvailable: false, details: err.message };
  }
}

module.exports = {
  registerWebnnIpc,
  detectNPUAvailability,
};
