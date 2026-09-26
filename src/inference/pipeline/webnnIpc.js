/**
 * WebNN IPC 请求工具
 *
 * 统一封装主进程 → 渲染进程的 WebNN IPC 调用模式，保证在
 * 成功 / 失败 / 超时三条路径上都正确清理 ipcMain 监听器，
 * 避免长时间运行时累积僵尸监听器导致的内存泄漏与 IPC 通道阻塞。
 */
let ipcMain;
try {
  ({ ipcMain } = require('electron'));
} catch (_) {
  // Allow pipeline modules to be required inside worker_threads / packaged
  // workers where the 'electron' module is unavailable or resolves to a
  // path string. WebNN IPC is main-process only; callers handle null.
  ipcMain = null;
}
const { IPC_TIMEOUT_INFERENCE, IPC_TIMEOUT_MODEL_LOAD, IPC_TIMEOUT_SYNTHESIS } = require('./constants');

/**
 * 发送一次性 WebNN IPC 请求到渲染进程，并在收到响应或超时后自动清理监听器。
 *
 * @param {Object} opts
 * @param {Electron.WebContents} opts.webContents 主窗口 webContents
 * @param {string} opts.requestChannel 渲染进程监听的请求通道（如 'webnn:runInference:request'）
 * @param {string} opts.responsePrefix 响应通道前缀（如 'webnn:runInference:response'）
 * @param {Object} opts.payload 发送给渲染进程的负载（必须包含 requestId）
 * @param {number} opts.timeoutMs 超时毫秒数
 * @param {Function} [opts.onResponse] 响应预处理回调，接收原始 result，返回 { ok: true, value } 或 { ok: false, error }
 * @param {string} [opts.timeoutMessage] 超时时抛出的错误消息
 * @param {Function} [opts.onProgress] 可选进度监听器（通道为 `${responsePrefix}:progress:${requestId}`）
 * @returns {Promise<any>}
 */
function requestWebNNOnce({
    webContents,
    requestChannel,
    responsePrefix,
    payload,
    timeoutMs,
    onResponse,
    timeoutMessage = 'WebNN IPC timeout',
    onProgress,
    onChunkAudio,
}) {
    return new Promise((resolve, reject) => {
        const requestId = payload.requestId ||
            `svs-webnn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        let settled = false;
        const responseChannel = `${responsePrefix}:${requestId}`;
        const progressChannel = `${responsePrefix}:progress:${requestId}`;
        const chunkChannel = `${responsePrefix}:chunk:${requestId}`;

        const cleanup = () => {
            clearTimeout(timeoutHandle);
            if (ipcMain) {
                ipcMain.removeListener(responseChannel, responseHandler);
                if (onProgress) ipcMain.removeListener(progressChannel, progressHandler);
                if (onChunkAudio) ipcMain.removeListener(chunkChannel, chunkHandler);
            }
        };

        const responseHandler = (_event, result) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (onResponse) {
                const r = onResponse(result);
                if (r.ok) resolve(r.value);
                else reject(r.error instanceof Error ? r.error : new Error(String(r.error)));
            } else {
                resolve(result);
            }
        };

        const progressHandler = (_event, data) => {
            try {
                if (onProgress && data && typeof data.progress === 'number') {
                    onProgress(data.progress);
                }
            } catch (_) { /* 进度回调失败不应影响主流程 */ }
        };

        // chunk 流式音频回调：渲染进程 vocoder 每完成一个 chunk 即推送
        const chunkHandler = (_event, data) => {
            try {
                if (onChunkAudio && data && data.audio) {
                    onChunkAudio(data);
                }
            } catch (_) { /* chunk 回调失败不应影响主流程 */ }
        };

        const timeoutHandle = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(timeoutMessage));
        }, timeoutMs);

        if (!ipcMain) {
            clearTimeout(timeoutHandle);
            reject(new Error('WebNN IPC unavailable (ipcMain not available in this context)'));
            return;
        }
        // handleOnce 只触发一次；超时后若响应到达，cleanup 已移除监听器，无副作用
        ipcMain.handleOnce(responseChannel, responseHandler);
        if (onProgress) ipcMain.on(progressChannel, progressHandler);
        if (onChunkAudio) ipcMain.on(chunkChannel, chunkHandler);

        try {
            webContents.send(requestChannel, { ...payload, requestId });
        } catch (err) {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(`Failed to send WebNN IPC request: ${err.message}`));
        }
    });
}

/** 便捷工厂：单次推理请求 */
function requestInference(webContents, modelId, inputs, timeoutMessage) {
    return requestWebNNOnce({
        webContents,
        requestChannel: 'webnn:runInference:request',
        responsePrefix: 'webnn:runInference:response',
        payload: { modelId, inputs },
        timeoutMs: IPC_TIMEOUT_INFERENCE,
        timeoutMessage: timeoutMessage || `WebNN inference timeout (${modelId})`,
    });
}

/** 便捷工厂：模型加载请求 */
function requestModelLoad(webContents, modelId, modelPath, options, timeoutMessage) {
    return requestWebNNOnce({
        webContents,
        requestChannel: 'webnn:loadModel:request',
        responsePrefix: 'webnn:loadModel:response',
        payload: { modelId, modelPath, options: options || { deviceType: 'npu' } },
        timeoutMs: IPC_TIMEOUT_MODEL_LOAD,
        timeoutMessage: timeoutMessage || 'Load timeout',
    });
}

/** 便捷工厂：合成主流程请求（含进度 + 流式 chunk 音频） */
function requestSynthesis(webContents, params, onProgress, opts = {}) {
    return requestWebNNOnce({
        webContents,
        requestChannel: 'webnn:runSynthesis:request',
        responsePrefix: 'webnn:runSynthesis:response',
        payload: { params },
        timeoutMs: opts.timeoutMs || IPC_TIMEOUT_SYNTHESIS,
        timeoutMessage: opts.timeoutMessage || 'WebNN synthesis timeout',
        onProgress,
        onChunkAudio: opts.onChunkAudio,
        onResponse: (result) => result && result.error
            ? { ok: false, error: new Error(result.error) }
            : { ok: true, value: result },
    });
}

module.exports = {
    requestWebNNOnce,
    requestInference,
    requestModelLoad,
    requestSynthesis,
};
