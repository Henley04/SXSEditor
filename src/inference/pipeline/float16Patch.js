const ort = require('onnxruntime-node');

// 修复 onnxruntime-common 的 float16 类型映射
// Node.js v24+ 原生支持 Float16Array，但 onnxruntime-node 的 native binding (C++)
// 无法识别 Float16Array 的 buffer，导致 "not enough space" 错误。
// 解决方案：强制 float16 Using Uint16Array 存储数据。
(function patchFloat16Mapping() {
    if (typeof Float16Array === 'undefined') return; // 不需要 patch
    try {
        // 触发 checkTypedArray 初始化
        try { new ort.Tensor('float16', new Uint16Array(1), [1]); } catch (_) {}

        // 通过 require.cache 直接访问loaded的模chunks
        for (const [key, mod] of Object.entries(require.cache)) {
            if (key.includes('onnxruntime-common') && key.includes('tensor-impl-type-mapping')) {
                if (mod.exports && mod.exports.NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP) {
                    mod.exports.NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.set('float16', Uint16Array);
                    console.log('[OnnxSVSPipeline] float16 type mapping patched (Uint16Array)');
                }
                break;
            }
        }
    } catch (_) {
        // patch 失败不影响正常运行（非 FP16 Model不需要此 patch）
    }
})();
