const { parentPort } = require('node:worker_threads');
const { classifyDevice } = require('./deviceClassifier');

/**
 * Phase 1: WMI 快速查询 (~400ms) — 获取 GPU 名称和驱动版本
 * AdapterRAM 上限 4GB，仅用于分类参考，不作为准确显存值
 */
async function queryGPUFast() {
    const { execFile } = require('node:child_process');
    return new Promise((resolve) => {
        execFile('powershell', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
            'Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion | ConvertTo-Json -Compress'
        ], { timeout: 5000 }, (err, stdout) => {
            if (err || !stdout) { resolve([]); return; }
            try {
                let data = JSON.parse(stdout.trim());
                if (!Array.isArray(data)) data = [data];
                const controllers = data.map((c, idx) => {
                    const vramBytes = c.AdapterRAM || 0;
                    const deviceType = classifyDevice(c.Name, vramBytes);
                    return {
                        adapterIndex: idx,
                        model: c.Name || '',
                        vram: 0,
                        memoryTotal: Math.round(vramBytes / (1024 * 1024)),
                        memoryUsed: 0,
                        vendor: '',
                        driverVersion: c.DriverVersion || '',
                        deviceType,
                        isDiscrete: deviceType === 'discrete-gpu',
                        _source: 'wmi',
                    };
                });
                resolve(controllers);
            } catch (_) { resolve([]); }
        });
    });
}

/**
 * Phase 2: systeminformation 完整查询 (~9s) — 获取准确显存和使用情况
 */
async function queryGPUFull() {
    const si = require('systeminformation');
    const graphics = await si.graphics();
    const controllers = graphics.controllers || [];
    return controllers.map((c, idx) => {
        const vramBytes = (c.memoryTotal || c.vram || 0) * 1024 * 1024;
        const deviceType = classifyDevice(c.model, vramBytes);
        return {
            adapterIndex: idx,
            model: c.model || '',
            vram: c.vram || 0,
            memoryTotal: c.memoryTotal || c.vram || 0,
            memoryUsed: c.memoryUsed || 0,
            vendor: c.vendor || '',
            deviceType,
            isDiscrete: deviceType === 'discrete-gpu',
            _source: 'si',
        };
    });
}

(async () => {
    try {
        // 先用 WMI 快速获取基本信息
        const fast = await queryGPUFast();
        parentPort.postMessage({ phase: 'fast', success: true, data: fast });

        // 再用 systeminformation 获取完整信息（包含准确显存）
        const full = await queryGPUFull();
        parentPort.postMessage({ phase: 'full', success: true, data: full });
    } catch (err) {
        parentPort.postMessage({ phase: 'error', success: false, error: err.message });
    }
})();
