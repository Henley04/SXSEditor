const { parentPort } = require('node:worker_threads');

/**
 * 统一设备分类函数 — 与 nativeSvsPipeline.js 中的 classifyDevice 保持同步
 */
function classifyDevice(name, vramBytes = 0, dmlDiscreteFlag = undefined) {
    const n = (name || '').toLowerCase();

    const npuKeywords = [
        'npu', 'neural processing', 'neural compute',
        'intel ai boost', 'intel neural', 'intel npu',
        'amd xdna', 'amd ryzen ai', 'amd ai engine',
        'qualcomm hexagon', 'qcom npu', 'hexagon npu',
        'snapdragon neural', 'mediatek apu', 'rockchip npu',
    ];
    for (const kw of npuKeywords) {
        if (n.includes(kw)) return 'npu';
    }

    const discreteGpuKeywords = [
        { includes: ['nvidia'] }, { includes: ['geforce'] },
        { includes: ['rtx'] }, { includes: ['gtx'] }, { includes: ['quadro'] },
        { includes: ['radeon', 'rx'] }, { includes: ['radeon', 'pro'] },
        { includes: ['radeon', 'instinct'] },
        { includes: ['amd', 'rx '] }, { includes: ['amd', 'pro w'] }, { includes: ['amd', 'pro v'] },
    ];
    for (const rule of discreteGpuKeywords) {
        if (rule.includes.every(kw => n.includes(kw))) return 'discrete-gpu';
    }
    if (n.includes('intel') && n.includes('arc') && /\barc\s*a\d/i.test(n)) return 'discrete-gpu';

    const integratedGpuKeywords = [
        { includes: ['intel', 'uhd'] }, { includes: ['intel', 'iris'] },
        { includes: ['intel', 'xe'] }, { includes: ['intel', 'hd graphics'] },
    ];
    for (const rule of integratedGpuKeywords) {
        if (rule.includes.every(kw => n.includes(kw))) return 'integrated-gpu';
    }
    if (n.includes('radeon') && !n.includes('rx') && !n.includes('pro') && !n.includes('instinct')) return 'integrated-gpu';
    if (n.includes('microsoft') && n.includes('basic')) return 'integrated-gpu';

    if (dmlDiscreteFlag === true) return 'discrete-gpu';
    if (dmlDiscreteFlag === false) return 'integrated-gpu';

    if (vramBytes > 0 && vramBytes >= 512 * 1024 * 1024) return 'discrete-gpu';
    if (vramBytes > 0) return 'integrated-gpu';

    return 'cpu';
}

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
