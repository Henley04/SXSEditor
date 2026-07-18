/**
 * WebNN 推理模块 — onnxruntime-web 初始化与全局 ort 引用
 *
 * ort.all.min.js 历史上通过 index.html 的 <script src> 同步加载，会阻塞
 * 主窗口渲染进程的 did-finish-load 事件（5-10MB UMD 解析）。
 * 现已从 HTML 移除，改为按需动态加载：首次调用 ensureOrt() 时注入
 * <script> 标签，加载完成后配置 WASM 路径并返回 ort 引用。
 */

// onnxruntime-web UMD bundle path (relative to main window's HTML).
// webpack.renderer.config.js copies ort.all.min.js alongside each entry's HTML.
const ORT_UMD_PATH = './ort.all.min.js';

// Cached ort reference once loaded.
let ort = null;

// In-flight loader promise so concurrent callers share the same script load.
let _loadPromise = null;

/**
 * Dynamically inject <script src="./ort.all.min.js"> into <head>.
 * Resolves with window.ort once the UMD bundle has executed.
 * Idempotent: concurrent callers share the same promise.
 */
function loadOrtScript() {
    if (window.ort) return Promise.resolve(window.ort);
    if (_loadPromise) return _loadPromise;
    _loadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = ORT_UMD_PATH;
        script.async = true;
        script.onload = () => {
            if (window.ort) {
                resolve(window.ort);
            } else {
                _loadPromise = null; // allow retry
                reject(new Error('ort.all.min.js loaded but window.ort is undefined'));
            }
        };
        script.onerror = () => {
            _loadPromise = null; // allow retry
            reject(new Error(`Failed to load ${ORT_UMD_PATH}`));
        };
        document.head.appendChild(script);
    });
    return _loadPromise;
}

/**
 * 确保 ort 全局变量已初始化，并配置 WASM 路径
 * @returns {object} ort 全局对象
 */
export async function ensureOrt() {
    if (ort) return ort;

    // If the UMD bundle has already been loaded (e.g. by another window or
    // legacy <script> tag), use the global directly. Otherwise, load it
    // dynamically now.
    if (typeof window === 'undefined' || !window.ort) {
        await loadOrtScript();
    }

    if (typeof window !== 'undefined' && window.ort) {
        ort = window.ort;
        console.log('[WebNN] onnxruntime-web loaded from global, version:', ort.env?.versions?.web || 'unknown');

        // Configure WASM paths — must point to directory containing .wasm files
        // In Electron dev mode, the HTML is served from http://localhost:9000/main_window/
        // and the WASM files are copied to the same directory by webpack CopyPlugin
        if (ort.env?.wasm) {
            ort.env.wasm.wasmPaths = './';
            // Enable multi-threaded WASM execution. Requires crossOriginIsolated (COOP/COEP),
            // which is set in main.js onHeadersReceived. Sandbox is disabled on all windows.
            const cpuCores = navigator.hardwareConcurrency || 4;
            ort.env.wasm.numThreads = Math.max(1, cpuCores - 1);
            ort.env.wasm.memoryLimit = 3584; // 3.5GB - 32-bit WASM max is ~4GB, leave some headroom
            console.log(`[WebNN] WASM paths configured: ${ort.env.wasm.wasmPaths}, numThreads: ${ort.env.wasm.numThreads} (cpu cores: ${cpuCores}), memoryLimit: ${ort.env.wasm.memoryLimit}MB (32-bit WASM), crossOriginIsolated: ${self.crossOriginIsolated}`);
        }
    } else {
        throw new Error('onnxruntime-web failed to load. ensureOrt() did not find window.ort.');
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
