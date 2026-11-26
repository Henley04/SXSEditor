/**
 * 全局 EP 策略：CPU 后端强制所有模型走 CPU。
 *
 * 'cpu' 是 nativeInferenceBackend 的第 4 个取值，与 Windows ML / DirectML 同级。
 * 它和「DML 创建失败后回落到 CPU」不是一回事：这是用户显式选择的全局开关，
 * 所有 ONNX session（主模型、音高检测器、声码器、插件 runner）都必须只带
 * executionProviders: ['cpu']，不再尝试 WinML / DML / WebNN。
 *
 * worker_threads 里 require('electron') 拿不到 app.getPath()，svsWorker 启动时把
 * 主进程的设置快照挂到 globalThis；主进程/渲染进程回落到 loadSettings()。
 * 读取顺序与 winmlProvider._getSettings() 一致，避免两处读到不一致的后端。
 */
'use strict';

function _getSettings() {
    const snapshot = globalThis.__SXS_SETTINGS_SNAPSHOT__;
    if (snapshot && typeof snapshot === 'object') return snapshot;
    try {
        const { loadSettings } = require('../../main/settings');
        return loadSettings() || {};
    } catch (_err) {
        return {};
    }
}

/** 当前是否处于「所有模型强制 CPU」后端。传入 settings 可跳过全局读取（测试用）。 */
function isCpuOnlyBackend(settings) {
    const s = settings || _getSettings();
    return !!s && s.nativeInferenceBackend === 'cpu';
}

module.exports = { isCpuOnlyBackend };
