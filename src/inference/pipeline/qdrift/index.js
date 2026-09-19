/**
 * Q-Drift 推理期漂移校正（arXiv:2603.18095 在 SoulX-Singer FP16 DiT 上的特化）
 *
 * 背景：FP16 导出的 diff_step_dml 在 32 步 rectified-flow 采样中，每步的量化噪声
 * Δv 会沿轨迹累积。Q-Drift 不改权重、不重新导出，只在采样器侧加一个逐通道缩放：
 *
 *   原始 Euler:  x_{i+1} = x_i + h · v̂(x_i, σ_i, c)
 *   校正 Euler:  x_{i+1} = x_i + h · ((1 + c_i) ⊙ v̂(x_i, σ_i, c))
 *   其中 c_i = V_{σ_i} / (2·(i + 0.5))，V 由配对 FP32/FP16 校准测得的逐通道方差。
 *
 * ★ 校准合约（CONTRACT）—— 违反即静默降级，因为 |c| 极小（1e-5 量级），
 *   跑错 σ 网格在听感上完全无法察觉。所以开启时对求解器/步数/CFG 一律强制锁定，
 *   并在日志里写明被覆盖的每一项。
 *
 * 校准产物由 qdrift/scripts/gen_asset.js 从 qdrift/calib/qdrift_c.bin 生成。
 *
 * 适用范围：仅 onnxruntime-node + DirectML 的 FP16 DiT 路径（pipeline/diffusion.js）。
 * WebNN/NPU 路径（inference/webnn/diffusion.js）用的是另一套模型（int8-npu 等），
 * 量化误差来源完全不同，不套用本校正。
 */
'use strict';

const CORRECTION = require('./qdriftCorrection');
const { resolveQDriftDefault } = require('./defaults');

/**
 * 校准合约：必须与生成 qdrift_c.bin 时的采样配置一致
 * （qdrift/scripts/calibrate_dml.js 顶部的同名常量）
 */
const CONTRACT = Object.freeze({
    nSteps: 32,
    solver: 'euler',
    cfgStrength: 3.0,
    cfgRescale: 0.7,
    melDim: 128,
});

let _correction = null;   // Float32Array | false（加载失败）

/**
 * 惰性解码并返回逐通道修正因子 c，形状 (nSteps, melDim)。
 * @returns {Float32Array|null} 不可用（缺失/形状不符/合约不符）时返回 null
 */
function getCorrection() {
    if (_correction !== null) return _correction || null;
    try {
        const meta = (CORRECTION && CORRECTION.meta) || {};
        if (meta.n_steps !== CONTRACT.nSteps) {
            console.warn(`[Q-Drift] 校准步数 ${meta.n_steps} ≠ 合约 ${CONTRACT.nSteps}，已禁用`);
            _correction = false;
            return null;
        }
        if (String(meta.solver) !== CONTRACT.solver) {
            console.warn(`[Q-Drift] 校准求解器 ${meta.solver} ≠ 合约 ${CONTRACT.solver}，已禁用`);
            _correction = false;
            return null;
        }
        const buf = Buffer.from(CORRECTION.base64, 'base64');
        if (buf.length !== CONTRACT.nSteps * CONTRACT.melDim * 4) {
            console.warn(`[Q-Drift] 校正表字节数异常 ${buf.length}，已禁用`);
            _correction = false;
            return null;
        }
        const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
        _correction = arr;
        return arr;
    } catch (e) {
        console.warn('[Q-Drift] 校正表解码失败，已禁用:', e && e.message);
        _correction = false;
        return null;
    }
}

/**
 * 实测过的执行提供者（|Δv| 量级一致，校准得到的 c 可直接套用）。
 *
 * 实测（nat_000，前 3 步，同一 latent）：
 *   DML            8.94e-3 → 1.26e-2 → 1.29e-2   （基线 1.00x）
 *   NvTensorRtRtx  8.66e-3 → 1.23e-2 → 1.30e-2   （0.98x，与 DML 同量级）
 *   CPU            2.01e-3 → 3.80e-3             （约 1/4 ~ 1/8，明显更小）
 * 即：量化误差的主导项是 FP16 本身的表示/累加精度，与 GPU EP 的选择无关；
 * 但 CPU EP 走的是另一套 fp16 kernel，误差小得多，套用 GPU 的 c 属于超量校正。
 */
// 注意：不要用 /nv/i 之类的宽匹配 —— "OpenVINO" 里就含 "nv"，会被误判为已实测。
const MEASURED_EP_PATTERNS = [/dml/i, /tensorrt/i];

/**
 * 判断该 EP 上的 Δv 统计与本校准是否匹配。
 * @param {string|null|undefined} ep - sessionEPs.diffStep 之类的 EP 标识
 * @returns {boolean} 未知（null）时按匹配处理，避免在缺少信号时误关
 */
function isEpMeasured(ep) {
    if (!ep) return true;
    const s = String(ep);
    return MEASURED_EP_PATTERNS.some(re => re.test(s));
}

/**
 * 判断是否启用 Q-Drift，并给出强制锁定后的有效采样参数。
 *
 * 启用条件：用户开关打开 + 校正表可用 + 当前 DiT 为 FP16。
 * 启用后：求解器、步数、CFG、rescale 全部锁定为合约值，CFG 调度 / 动态阈值 /
 *         SDEdit 局部修复一律关闭 —— 这些都会改变速度场 v 的分布，令 c 失效。
 *
 * @param {Object} req
 * @param {boolean} req.enabled - 用户设置开关
 * @param {boolean} req.isFP16 - 当前 diff_step 是否为 FP16
 * @param {string} req.samplerName - 请求的求解器
 * @param {number} req.totalSteps - 请求的步数
 * @param {number} req.cfgStrength - 请求的 CFG
 * @param {number} req.cfgRescale - 请求的 CFG rescale
 * @param {Object|null} req.cfgScheduleOpts - CFG 调度（将被清空）
 * @param {Object|null} req.dynamicThresholdOpts - 动态阈值（将被清空）
 * @returns {{active:boolean, reason:string|null, notes:string[],
 *            correction:Float32Array|null,
 *            params:{samplerName:string,totalSteps:number,cfgStrength:number,
 *                    cfgRescale:number,cfgScheduleOpts:null,dynamicThresholdOpts:null,
 *                    sdEditDisabled:boolean}}}
 */
function resolveQDrift(req) {
    const {
        enabled, isFP16, samplerName, totalSteps,
        cfgStrength, cfgRescale, cfgScheduleOpts, dynamicThresholdOpts,
        diffStepEp,
    } = req || {};
    const notes = [];
    const inactive = (reason) => ({
        active: false, reason, notes, correction: null,
        params: {
            samplerName, totalSteps, cfgStrength, cfgRescale,
            cfgScheduleOpts, dynamicThresholdOpts, sdEditDisabled: false,
        },
    });

    if (!enabled) return inactive('disabled');
    const correction = getCorrection();
    if (!correction) return inactive('correction-unavailable');
    if (!isFP16) {
        notes.push('Q-Drift 仅对 FP16 DiT 有意义（当前为 FP32），本次不启用');
        return inactive('not-fp16');
    }
    if (!isEpMeasured(diffStepEp)) {
        notes.push(`diffStep 跑在 ${diffStepEp} 上，Δv 统计与校准时实测的 DML / NvTensorRtRtx 不一致，本次不启用`);
        return inactive('ep-not-measured');
    }

    if (samplerName !== CONTRACT.solver) {
        notes.push(`求解器 ${samplerName} → ${CONTRACT.solver}`);
    }
    if (totalSteps !== CONTRACT.nSteps) {
        notes.push(`采样步数 ${totalSteps} → ${CONTRACT.nSteps}`);
    }
    if (Math.abs((cfgStrength || 0) - CONTRACT.cfgStrength) > 1e-6) {
        notes.push(`CFG ${cfgStrength} → ${CONTRACT.cfgStrength}`);
    }
    if (Math.abs((cfgRescale || 0) - CONTRACT.cfgRescale) > 1e-6) {
        notes.push(`CFG rescale ${cfgRescale} → ${CONTRACT.cfgRescale}`);
    }
    if (cfgScheduleOpts) notes.push('CFG 调度已关闭（Q-Drift 要求固定 CFG）');
    if (dynamicThresholdOpts) notes.push('动态阈值已关闭（Q-Drift 要求标准 CFG + rescale）');
    notes.push('SDEdit 局部修复已关闭（会改变速度场分布）');

    return {
        active: true,
        reason: null,
        notes,
        correction,
        params: {
            samplerName: CONTRACT.solver,
            totalSteps: CONTRACT.nSteps,
            cfgStrength: CONTRACT.cfgStrength,
            cfgRescale: CONTRACT.cfgRescale,
            cfgScheduleOpts: null,
            dynamicThresholdOpts: null,
            sdEditDisabled: true,
        },
    };
}

/**
 * 构造传给求解器的上下文（Euler 求解器据此做逐通道缩放）。
 * @param {boolean} active
 * @param {Float32Array|null} correction
 * @returns {{active:boolean, c:Float32Array|null, steps:number}}
 */
function buildQDriftCtx(active, correction) {
    return { active: !!active, c: active ? correction : null, steps: CONTRACT.nSteps };
}

/** 读取用户设置开关（与 diffusion.js 的 _readSDEditRepair 同款惰性 require）。
 *  用户未显式设置时按模型精度推断：FP16 DiT 默认启用，其余默认关闭。
 *  @param {string} [key] - 'previewEnableQDrift' | 'exportEnableQDrift' */
function readQDriftEnabled(key) {
    try {
        const { loadSettings } = require('../../../main/settings');
        return resolveQDriftDefault(loadSettings(), key);
    } catch (_) {
        return false;
    }
}

module.exports = {
    CONTRACT,
    getCorrection,
    resolveQDrift,
    buildQDriftCtx,
    readQDriftEnabled,
    isEpMeasured,
};
