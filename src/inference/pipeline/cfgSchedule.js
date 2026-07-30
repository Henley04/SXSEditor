/**
 * Task 11: CFG 强度曲线调度。
 *
 * 在 diffusion 采样循环中按 step 动态调整 CFG 引导强度，替代固定 cfgStrength。
 * 支持四种模式：
 *   - constant: 固定值（与改造前行为字节级一致，用于回归保证）
 *   - linear:   start + (end - start) * step / (totalSteps - 1)
 *   - cosine:   start + (end - start) * (1 - cos(π * step / (totalSteps - 1))) / 2
 *   - custom:   keyframes 分段线性插值
 *
 * 默认值规则：
 *   - cfgStrengthStart 为 null/undefined 时回退到 cfgStrength * 0.5
 *   - cfgStrengthEnd   为 null/undefined 时回退到 cfgStrength
 *   即默认 linear/cosine 从 0.5×cfg 线性/余弦上升到 cfg（早期低 CFG 稳定结构，
 *   后期高 CFG 锐化细节）。
 *
 * constant 模式直接返回 cfgStrength，确保与 Task 11 改造前的固定 CFG 行为
 * 字节级一致（resolveCfgAtStep 不引入任何浮点误差）。
 */

const VALID_MODES = ['constant', 'linear', 'cosine', 'custom'];
const DEFAULT_MODE = 'linear';

/**
 * 解析 CFG 调度模式。非法/缺失时回退到 DEFAULT_MODE。
 * @param {string} [mode] - 调度模式
 * @returns {string}
 */
function resolveScheduleMode(mode) {
    if (typeof mode === 'string' && VALID_MODES.includes(mode)) return mode;
    return DEFAULT_MODE;
}

/**
 * 按 step 解析有效 CFG 强度。
 *
 * @param {Object} params
 * @param {string} [params.mode='linear'] - 调度模式 constant|linear|cosine|custom
 * @param {number} params.cfgStrength - 基准 CFG 强度（constant 模式直接返回此值；
 *   其他模式作为 end 的默认值与 start 的 0.5× 基准）
 * @param {number|null} [params.cfgStrengthStart=null] - 起始 CFG 强度，null 时回退到 cfgStrength*0.5
 * @param {number|null} [params.cfgStrengthEnd=null] - 终止 CFG 强度，null 时回退到 cfgStrength
 * @param {Array<{step:number,value:number}>|null} [params.keyframes=null] - custom 模式关键帧
 * @param {number} params.step - 当前步索引（0-based）
 * @param {number} params.totalSteps - 总步数
 * @returns {number} 当前步的有效 CFG 强度
 */
function resolveCfgAtStep({ mode, cfgStrength, cfgStrengthStart, cfgStrengthEnd, keyframes, step, totalSteps }) {
    const resolvedMode = resolveScheduleMode(mode);

    // constant: 直接返回 cfgStrength（字节级一致，无浮点误差）
    if (resolvedMode === 'constant') {
        return cfgStrength;
    }

    // 默认值：start 回退到 cfgStrength*0.5，end 回退到 cfgStrength
    const start = (typeof cfgStrengthStart === 'number' && Number.isFinite(cfgStrengthStart))
        ? cfgStrengthStart
        : cfgStrength * 0.5;
    const end = (typeof cfgStrengthEnd === 'number' && Number.isFinite(cfgStrengthEnd))
        ? cfgStrengthEnd
        : cfgStrength;

    // 边界：totalSteps <= 1 时无法插值，返回 end（= 最终目标 CFG）
    if (!Number.isFinite(totalSteps) || totalSteps <= 1) {
        return end;
    }

    const clampedStep = Math.max(0, Math.min(step, totalSteps - 1));

    if (resolvedMode === 'linear') {
        // start + (end - start) * step / (totalSteps - 1)
        return start + (end - start) * clampedStep / (totalSteps - 1);
    }

    if (resolvedMode === 'cosine') {
        // start + (end - start) * (1 - cos(π * step / (totalSteps - 1))) / 2
        return start + (end - start) * (1 - Math.cos(Math.PI * clampedStep / (totalSteps - 1))) / 2;
    }

    // custom: keyframes 分段线性插值
    if (resolvedMode === 'custom') {
        return interpolateKeyframes(keyframes, clampedStep, start, end, totalSteps);
    }

    // 兜底（不应到达）
    return cfgStrength;
}

/**
 * keyframes 分段线性插值。
 * keyframes 格式：[{step, value}, ...]，按 step 升序。
 * - step < 第一帧 → 第一帧 value
 * - step > 最后一帧 → 最后一帧 value
 * - 两帧之间 → 线性插值
 * - keyframes 非法/空 → 回退到 linear(start→end)
 * @private
 */
function interpolateKeyframes(keyframes, step, start, end, totalSteps) {
    if (!Array.isArray(keyframes) || keyframes.length === 0) {
        // 无关键帧 → 回退到 linear
        return start + (end - start) * step / Math.max(1, totalSteps - 1);
    }

    // 解析并排序关键帧（过滤非法项）
    const parsed = [];
    for (const kf of keyframes) {
        if (kf && typeof kf.step === 'number' && Number.isFinite(kf.step) &&
            typeof kf.value === 'number' && Number.isFinite(kf.value)) {
            parsed.push({ step: kf.step, value: kf.value });
        }
    }
    if (parsed.length === 0) {
        return start + (end - start) * step / Math.max(1, totalSteps - 1);
    }
    parsed.sort((a, b) => a.step - b.step);

    // 边界外
    if (step <= parsed[0].step) return parsed[0].value;
    if (step >= parsed[parsed.length - 1].step) return parsed[parsed.length - 1].value;

    // 两帧之间线性插值
    for (let i = 0; i < parsed.length - 1; i++) {
        const a = parsed[i];
        const b = parsed[i + 1];
        if (step >= a.step && step <= b.step) {
            if (b.step === a.step) return b.value;
            const t = (step - a.step) / (b.step - a.step);
            return a.value + (b.value - a.value) * t;
        }
    }

    // 兜底
    return end;
}

module.exports = {
    resolveCfgAtStep,
    resolveScheduleMode,
    VALID_MODES,
    DEFAULT_MODE,
};
