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
 * Dynamic Thresholding for CFG (arXiv:2507.08965).
 *
 * 在 CFG 合并后，对 cfgVal 施加动态阈值截断：
 *   1. 计算 cfgPredBuf 的绝对值分位数 p_dyn（默认 99.5%）。
 *   2. 阈值 t_dyn = max(|mean|, p_dyn)。
 *   3. 超过阈值的值被截断到 ±t_dyn，然后线性映射回 ±t_dyn 范围内。
 *
 * 这防止极端 CFG 增强值（在条件和无条件预测差异极大时出现）导致
 * 过曝光/过饱和伪影，同时保留非极端值的动态范围。
 *
 * 与 cfgRescale 的区别：cfgRescale 通过方差匹配全局缩放；
 * dynamic threshold 通过分位数截断局部极端值。两者可叠加使用。
 *
 * 采用 partial selection 算法（O(n) 平均），避免全排序的 O(n log n) 开销。
 * 在 mel 维度上操作（128 维），而非全帧合并，以保持时间局部性。
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

    // 临时缓冲区用于 partial selection
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

        // Partial selection 找分位数
        const threshold = Math.max(mean, _partialSelect(absVals, percentile));

        // 截断 + 线性映射：超过 ±threshold 的值压缩到 ±threshold
        if (threshold < 1e-8) continue; // 全零帧跳过
        for (let d = 0; d < melDim; d++) {
            const val = cfgPredBuf[frameOff + d];
            const absVal = Math.abs(val);
            if (absVal > threshold) {
                // 线性映射：保持符号，截断到 threshold
                cfgPredBuf[frameOff + d] = Math.sign(val) * threshold;
            }
        }
    }
}

/**
 * Partial selection (quickselect) 找到数组中第 k 小的元素。
 * 平均 O(n)，最坏 O(n²)（对 melDim=128 可忽略）。
 * 原地修改输入数组（partial sort 副作用）。
 *
 * @param {Float32Array} arr - 输入数组（会被部分重排）
 * @param {number} percentile - 0-1 范围
 * @returns {number} 分位数对应的值
 */
function _partialSelect(arr, percentile) {
    const n = arr.length;
    if (n === 0) return 0;
    if (n === 1) return arr[0];

    const k = Math.min(n - 1, Math.max(0, Math.floor(percentile * n)));
    return _quickselect(arr, 0, n - 1, k);
}

function _quickselect(arr, lo, hi, k) {
    while (lo < hi) {
        // Partition (Lomuto scheme)
        const pivot = arr[hi];
        let i = lo;
        for (let j = lo; j < hi; j++) {
            if (arr[j] <= pivot) {
                const tmp = arr[i];
                arr[i] = arr[j];
                arr[j] = tmp;
                i++;
            }
        }
        const tmp = arr[i];
        arr[i] = arr[hi];
        arr[hi] = tmp;

        if (i === k) return arr[k];
        if (i < k) {
            lo = i + 1;
        } else {
            hi = i - 1;
        }
    }
    return arr[k];
}

module.exports = {
    resolveCfgAtStep,
    resolveScheduleMode,
    applyDynamicThreshold,
    VALID_MODES,
    DEFAULT_MODE,
};
