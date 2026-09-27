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
        // M12: safety clamp — scheduled CFG must be >= 0 (negative CFG is
        // undefined behavior in SVS).
        return Math.max(0, end);
    }

    const clampedStep = Math.max(0, Math.min(step, totalSteps - 1));

    let result;
    if (resolvedMode === 'linear') {
        // start + (end - start) * step / (totalSteps - 1)
        result = start + (end - start) * clampedStep / (totalSteps - 1);
    } else if (resolvedMode === 'cosine') {
        // start + (end - start) * (1 - cos(π * step / (totalSteps - 1))) / 2
        result = start + (end - start) * (1 - Math.cos(Math.PI * clampedStep / (totalSteps - 1))) / 2;
    } else if (resolvedMode === 'custom') {
        // custom: keyframes 分段线性插值
        result = interpolateKeyframes(keyframes, clampedStep, start, end, totalSteps);
    } else {
        // 兜底（不应到达）
        return cfgStrength;
    }

    // M12: safety clamp — scheduled CFG must be >= 0 (negative CFG is undefined
    // behavior in SVS). constant mode is exempt (returns cfgStrength directly).
    return Math.max(0, result);
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

/**
 * Dynamic Thresholding for CFG (Imagen, arXiv:2205.11487, Saharia et al. 2022；
 * 后被 SD 等各类 CFG 工作沿用)。
 *
 * 在 CFG 合并后，对 cfgVal 施加动态阈值截断：
 *   1. 计算 cfgPredBuf 的绝对值分位数 p_dyn（默认 99.5%）。
 *   2. 阈值 t_dyn = max(|mean|, p_dyn)。
 *   3. 超过阈值的值被硬截断到 ±t_dyn（保留符号，幅值限制在阈值内）。
 *
 * 这防止极端 CFG 增强值（在条件和无条件预测差异极大时出现）导致
 * 过曝光/过饱和伪影，同时保留非极端值的动态范围。
 *
 * 与 cfgRescale 的区别：cfgRescale 通过方差匹配全局缩放；
 * dynamic threshold 通过分位数截断局部极端值。两者可叠加使用。
 *
 * 分位数在 mel 维度上估计（128 维/帧，保持时间局部性），并使用
 * 线性插值（percentile × (n-1)，取相邻两 rank 插值）而不是 floor 取整：
 * floor(percentile × 128) 在 percentile ∈ [0.99219, 1.0) 时恒等于 127
 * （帧内绝对值最大值的 rank），threshold = max(mean, 最大值) = 最大值，
 * 截断分支永不触发 → 整个功能静默空转。插值使分位数在 128 个点之间连续。
 *
 * @param {Float32Array} cfgPredBuf - CFG 调整后的预测值缓冲区
 * @param {number} targetLen - targetLen = totalFrames * MEL_DIM
 * @param {number} melDim - mel 维度（128）
 * @param {number} percentile - 分位数（0-1，默认 0.995 = 99.5%）
 * @returns {void} 原地修改 cfgPredBuf
 */
function applyDynamicThreshold(cfgPredBuf, targetLen, melDim, percentile) {
    if (percentile <= 0 || percentile >= 1) return; // 无效分位数则跳过

    // 逐帧处理：每帧 melDim 个元素独立计算分位数
    const numFrames = Math.floor(targetLen / melDim);
    if (numFrames === 0) return;

    // 排序缓冲区用于插值分位数（n=128，排序开销可忽略）
    const absVals = new Float32Array(melDim);

    for (let f = 0; f < numFrames; f++) {
        const frameOff = f * melDim;

        // 收集当前帧的绝对值
        for (let d = 0; d < melDim; d++) {
            absVals[d] = Math.abs(cfgPredBuf[frameOff + d]);
        }

        // 计算均值
        let sum = 0;
        for (let d = 0; d < melDim; d++) {
            sum += absVals[d];
        }
        const mean = sum / melDim;

        // 线性插值分位数（见函数头注释：floor 取整在高分位区间是 no-op）
        const threshold = Math.max(mean, _quantileInterpolated(absVals, percentile));

        // 硬截断：超过 ±threshold 的值压缩到 ±threshold（保留符号）
        if (threshold < 1e-8) continue; // 全零帧跳过
        for (let d = 0; d < melDim; d++) {
            const val = cfgPredBuf[frameOff + d];
            const absVal = Math.abs(val);
            if (absVal > threshold) {
                cfgPredBuf[frameOff + d] = Math.sign(val) * threshold;
            }
        }
    }
}

/**
 * 线性插值分位数：rank = percentile × (n-1)，在相邻两个次序统计量之间
 * 线性插值。排序副本（不改入参顺序——absVals 每帧重建，原地排序亦可，
 * 但保持语义清晰：返回值基于排序结果）。
 *
 * @param {Float32Array} arr - 输入数组（会被原地排序）
 * @param {number} percentile - 0-1 范围
 * @returns {number} 插值分位数
 */
function _quantileInterpolated(arr, percentile) {
    const n = arr.length;
    if (n === 0) return 0;
    if (n === 1) return arr[0];
    // Float32Array.prototype.sort 默认即数值升序
    arr.sort();
    const rank = percentile * (n - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return arr[lo];
    const t = rank - lo;
    return arr[lo] + (arr[hi] - arr[lo]) * t;
}

module.exports = {
    resolveCfgAtStep,
    resolveScheduleMode,
    applyDynamicThreshold,
    VALID_MODES,
    DEFAULT_MODE,
};
