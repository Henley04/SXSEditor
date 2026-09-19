/**
 * Q-Drift 开关的默认值策略（纯函数，无依赖，渲染层/主进程共用）。
 *
 * 规则：用户显式设置过 → 用设置值；否则按模型精度推断 —— 只有 FP16 的 DiT 才有
 * 量化误差的多步累积问题，FP32/INT8 下 Q-Drift 没有意义（INT8 需要单独校准）。
 *
 * ★ 关键：主进程侧 **不要** 在加载设置时给这两个键写默认值。一旦落盘成固定布尔值，
 * 用户之后切换模型精度时开关就会停在陈旧值上（"切到 FP16 却还是没勾上"）。
 * 保持"未设置 = 跟随精度"的语义。
 */

/** 预览路径的设置键 */
export const PREVIEW_QDRIFT_KEY = 'previewEnableQDrift';
/** 导出路径的设置键 */
export const EXPORT_QDRIFT_KEY = 'exportEnableQDrift';

/**
 * @param {Object} settings - 设置对象（loadSettings() 的结果）
 * @param {string} [key] - 'previewEnableQDrift' | 'exportEnableQDrift'
 * @returns {boolean} Q-Drift 是否应启用
 */
export function resolveQDriftDefault(settings, key = EXPORT_QDRIFT_KEY) {
    const s = settings || {};
    const v = s[key];
    if (typeof v === 'boolean') return v;
    return s.modelPrecision === 'fp16';
}

/**
 * Q-Drift 在当前配置下是否真的会生效（FP16 DiT 才生效，其余一律自动跳过）。
 * 仅用于 UI 提示，真正的判定在 src/inference/pipeline/qdrift/index.js。
 * @param {Object} settings
 * @param {string} [key]
 * @returns {boolean}
 */
export function isQDriftEffective(settings, key = EXPORT_QDRIFT_KEY) {
    const s = settings || {};
    if (!resolveQDriftDefault(s, key)) return false;
    return s.modelPrecision === 'fp16';
}
