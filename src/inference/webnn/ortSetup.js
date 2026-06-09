/**
 * WebNN 推理模块 — onnxruntime-web 初始化与全局 ort 引用
 */

// onnxruntime-web 通过 script 标签加载（ort.all.min.js），暴露为全局变量 ort
let ort = null;

/**
 * 确保 ort 全局变量已初始化，并配置 WASM 路径
 * @returns {object} ort 全局对象
 */
export async function ensureOrt() {
    if (ort) return ort;
    // UMD bundle exposes 'ort' as a global variable
    if (typeof window !== 'undefined' && window.ort) {
        ort = window.ort;
        console.log('[WebNN] onnxruntime-web loaded from global, version:', ort.env?.versions?.web || 'unknown');

        // Configure WASM paths — must point to directory containing .wasm files
        // In Electron dev mode, the HTML is served from http://localhost:9000/main_window/
        // and the WASM files are copied to the same directory by webpack CopyPlugin
        if (ort.env?.wasm) {
            ort.env.wasm.wasmPaths = './';
            ort.env.wasm.numThreads = 1; // Disable SharedArrayBuffer threading (not available in Electron sandbox)
            console.log('[WebNN] WASM paths configured: ./, numThreads: 1');
        }
    } else {
        throw new Error('onnxruntime-web not loaded. Ensure ort.all.min.js is included via <script> tag.');
    }
    return ort;
}

/**
 * 获取当前 ort 引用（不触发初始化）
 * @returns {object|null}
 */
export function getOrt() {
    return ort;
}
