/**
 * envCheckIpc.js — 「帮助 → 环境检测」的 IPC 出口。
 *
 * 两个 handler 分别对应两个通道：快照（毫秒级）与运行期探测（带超时）。
 * 具体采集逻辑全在 envCheckInfo.js，本文件只做注册，保持与其它 *Ipc.js 一致。
 */

'use strict';

const { safeHandle } = require('./ipcSafe');
const { IPC_CHANNELS } = require('../shared/ipcChannels');
const { getEnvReport, getEnvCheckProbes } = require('./envCheckInfo');

function registerEnvCheckIpc() {
    // 只读内存，不触发任何系统探测；弹层首屏调用。
    safeHandle(IPC_CHANNELS.ENV_CHECK_GET_REPORT, async () => getEnvReport());
    // 原生桥初始化 / EP 枚举 / NPU 复检，每项内部 4s 超时；失败降级为状态码。
    safeHandle(IPC_CHANNELS.ENV_CHECK_GET_PROBES, async () => getEnvCheckProbes());
}

module.exports = { registerEnvCheckIpc };
