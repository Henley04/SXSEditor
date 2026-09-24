/**
 * Q-Drift 开关的默认值策略（纯函数，无依赖，渲染层/主进程共用）。
 *
 * 规则：用户显式设置过 → 用设置值；否则按模型精度推断 —— FP16 默认启用；
 * INT8 默认关闭（INT8 有独立校准表 qdriftCorrectionInt8，但校正幅度大，保持
 * opt-in，由用户在设置中显式打开）；FP32 无量化误差，永远关闭。
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
 * Q-Drift 在当前配置下是否真的会生效（FP16/INT8 DiT 才可能生效，其余一律自动跳过）。
 * 仅用于 UI 提示，真正的判定在 src/inference/pipeline/qdrift/index.js。
 * 注意 INT8 校正表资产（qdriftCorrectionInt8.js）缺失时运行时仍会自动降级关闭。
 * @param {Object} settings
 * @param {string} [key]
 * @returns {boolean}
 */
export function isQDriftEffective(settings, key = EXPORT_QDRIFT_KEY) {
    const s = settings || {};
    if (!resolveQDriftDefault(s, key)) return false;
    return s.modelPrecision === 'fp16' || s.modelPrecision === 'int8';
}
