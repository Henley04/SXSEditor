/**
 * WebNN 推理模块 — NPU/GPU 检测逻辑
 */

import { ensureOrt } from './ortSetup.js';

/**
 * 检测 WebNN/NPU 可用性
 * @returns {{ webnnAvailable: boolean, npuAvailable: boolean, gpuAvailable: boolean, details: string }}
 */
export async function detectNPU() {
    await ensureOrt();

    // 检查 navigator.ml API
    if (typeof navigator === 'undefined' || !navigator.ml) {
        return {
            webnnAvailable: false,
            npuAvailable: false,
            gpuAvailable: false,
            details: 'navigator.ml API not available (WebNN not enabled or unsupported Chromium version)',
        };
    }

    let npuAvailable = false;
    let gpuAvailable = false;
    let details = '';

    // 检测 NPU
    try {
        const npuContext = await navigator.ml.createContext({ deviceType: 'npu' });
        if (npuContext) {
            npuAvailable = true;
            details += 'NPU: available; ';
        }
    } catch (e) {
        details += `NPU: not available (${e.message}); `;
    }

    // 检测 GPU (WebNN)
    try {
        const gpuContext = await navigator.ml.createContext({ deviceType: 'gpu' });
        if (gpuContext) {
            gpuAvailable = true;
            details += 'GPU (WebNN): available; ';
        }
    } catch (e) {
        details += `GPU (WebNN): not available (${e.message}); `;
    }

    return {
        webnnAvailable: npuAvailable || gpuAvailable,
        npuAvailable,
        gpuAvailable,
        details: details.trim(),
    };
}
