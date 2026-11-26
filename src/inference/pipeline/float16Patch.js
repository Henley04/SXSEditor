// 修复 onnxruntime-common 的 float16 类型映射
// Node.js v24+ / Electron 42+ (Chromium 138) 原生支持 Float16Array，但
// onnxruntime-node 的 native binding (C++) 无法识别 Float16Array 的 buffer，
// 导致 "not enough space: expected N, got 0" 错误。
// 解决方案：强制 float16 Using Uint16Array 存储数据。
//
// 注意（冷启动审查）：本文件**不再**在 require 时自执行。原先它顶层
// `require('onnxruntime-node')` 并立即打补丁，意味着任何 `require('./float16Patch')`
// 都会把整个 ORT native addon 拉起来 —— 这是冷启动把 ORT 提前加载的隐蔽入口之一。
// 现在改为显式函数，由 ortRuntime.getOrt() 在真正加载 ORT 之后调用（幂等），
// 需要在进程早期主动打补丁的 worker 入口自行调用本函数。
//
// 注意：在 webpack 打包后，`require` 会被替换为 `__webpack_require__`，
// `require.cache` 指向 webpack 自己的模块缓存（`__webpack_require__.c`），
// 其中不包含 onnxruntime-common（它由 external 的 onnxruntime-node 在运行时加载）。
// 因此必须通过 `__non_webpack_require__` 访问 Node.js 原生 require.cache。
const nativeRequire = (typeof __non_webpack_require__ !== 'undefined')
    ? __non_webpack_require__
    : require;

const PATCH_FLAG = '__sxsOrtFloat16Patched';

/**
 * 给已加载的 onnxruntime-node 打 float16 类型映射补丁。
 *
 * 幂等：重复调用只会命中全局标记直接返回，不会重复扫描 require.cache。
 *
 * @param {any} ort onnxruntime-node 模块对象（已 require）
 * @returns {boolean} 是否成功应用补丁
 */
function applyFloat16Patch(ort) {
    if (!ort) return false;
    if (globalThis[PATCH_FLAG]) return true;
    if (typeof Float16Array === 'undefined') return false; // 不需要 patch
    try {
        // 触发 checkTypedArray 初始化
        try { new ort.Tensor('float16', new Uint16Array(1), [1]); } catch (_) {}

        // 确保onnxruntime-common已loaded到原生 require.cache
        try { nativeRequire('onnxruntime-common'); } catch (_) {}

        const cache = nativeRequire.cache || {};
        let patched = false;
        for (const [key, mod] of Object.entries(cache)) {
            if (key.includes('onnxruntime-common') && key.includes('tensor-impl-type-mapping')) {
                if (mod.exports && mod.exports.NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP) {
                    mod.exports.NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.set('float16', Uint16Array);
                    console.log('[OnnxSVSPipeline] float16 type mapping patched (Uint16Array)');
                    patched = true;
                }
                break;
            }
        }
        if (!patched) {
            console.warn('[OnnxSVSPipeline] float16 type mapping patch NOT applied (tensor-impl-type-mapping not found in native require.cache)');
        } else {
            globalThis[PATCH_FLAG] = true;
        }
        return patched;
    } catch (e) {
        console.warn('[OnnxSVSPipeline] float16 type mapping patch failed:', e.message);
        return false;
    }
}

module.exports = { applyFloat16Patch };
