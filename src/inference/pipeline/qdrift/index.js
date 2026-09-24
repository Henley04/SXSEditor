/**
 * Q-Drift 推理期漂移校正（arXiv:2603.18095 在 SoulX-Singer 量化 DiT 上的特化）
 *
 * 背景：量化（FP16 / INT8）导出的 diff_step_dml 在 32 步 rectified-flow 采样中，
 * 每步的量化噪声 Δv 会沿轨迹累积。Q-Drift 不改权重、不重新导出，只在采样器侧加
 * 一个逐通道缩放：
 *
 *   原始 Euler:  x_{i+1} = x_i + h · v̂(x_i, σ_i, c)
 *   校正 Euler:  x_{i+1} = x_i + h · ((1 + c_i) ⊙ v̂(x_i, σ_i, c))
 *   其中 c_i = V_{σ_i} / (2·(i + 0.5))，V 由配对 FP32/量化模型校准测得的逐通道方差。
 *
 * 每种精度各自一张校正表（Δv 量级不同：INT8 比 FP16 大约 2~3 个数量级）：
 *   fp16 → qdriftCorrection.js      （qdrift/calib/qdrift_c.bin）
 *   int8 → qdriftCorrectionInt8.js  （qdrift/calib_int8/qdrift_c.bin，可选资产）
 *
 * ★ 校准合约（CONTRACT）—— 违反即静默降级：跑错 σ 网格/采样器/CFG 会让 c 落到
 *   错误分布上（FP16 下 |c|~1e-5 听感不可察；INT8 下 |c|~1e-3 同样难以及时发现），
 *   所以开启时对求解器/步数/CFG 一律强制锁定，并在日志里写明被覆盖的每一项。
 *
 * 校准产物由 qdrift/scripts/gen_asset.js 生成。
 *
 * 适用范围：onnxruntime-node + DirectML / TensorRT 的 FP16 与 INT8 DiT 路径
 * （pipeline/diffusion.js）。WebNN/NPU 路径（inference/webnn/diffusion.js）用的是
 * 另一套模型（int8-npu 等），量化误差来源完全不同，不套用本校正。
 */
'use strict';

const CORRECTION_FP16 = require('./qdriftCorrection');
const { resolveQDriftDefault } = require('./defaults');

/** 精度 → 资产模块（INT8 资产是可选的，缺失时惰性 require 失败即禁用） */
const CORRECTION_MODULES = {
    fp16: './qdriftCorrection',
    int8: './qdriftCorrectionInt8',
};

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

// 每种精度独立缓存：Float32Array | false（加载失败/不存在）
const _correctionCache = { fp16: null, int8: null };

/**
 * 惰性解码并返回指定精度的逐通道修正因子 c，形状 (nSteps, melDim)。
 * @param {'fp16'|'int8'} [precision='fp16']
 * @returns {Float32Array|null} 不可用（资产缺失/形状不符/合约不符）时返回 null
 */
function getCorrection(precision = 'fp16') {
    if (precision !== 'fp16' && precision !== 'int8') return null;
    const cached = _correctionCache[precision];
    if (cached !== null) return cached || null;

    // INT8 资产是可选的：文件尚未生成时 require 直接抛错，按不可用处理
    let asset = null;
    if (precision === 'fp16') {
        asset = CORRECTION_FP16;
    } else {
        try {
            asset = require(CORRECTION_MODULES.int8);
        } catch (e) {
            console.warn(`[Q-Drift] INT8 校正表资产缺失（${e && e.message}），本次不启用`);
            _correctionCache.int8 = false;
            return null;
        }
    }

    try {
        const meta = (asset && asset.meta) || {};
        if (meta.n_steps !== CONTRACT.nSteps) {
            console.warn(`[Q-Drift:${precision}] 校准步数 ${meta.n_steps} ≠ 合约 ${CONTRACT.nSteps}，已禁用`);
            _correctionCache[precision] = false;
            return null;
        }
        if (String(meta.solver) !== CONTRACT.solver) {
            console.warn(`[Q-Drift:${precision}] 校准求解器 ${meta.solver} ≠ 合约 ${CONTRACT.solver}，已禁用`);
            _correctionCache[precision] = false;
            return null;
        }
        const buf = Buffer.from(asset.base64, 'base64');
        if (buf.length !== CONTRACT.nSteps * CONTRACT.melDim * 4) {
            console.warn(`[Q-Drift:${precision}] 校正表字节数异常 ${buf.length}，已禁用`);
            _correctionCache[precision] = false;
            return null;
        }
        const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
        _correctionCache[precision] = arr;
        return arr;
    } catch (e) {
        console.warn(`[Q-Drift:${precision}] 校正表解码失败，已禁用:`, e && e.message);
        _correctionCache[precision] = false;
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
 * 启用条件：用户开关打开 + 对应精度的校正表可用 + 当前 DiT 为 FP16 或 INT8。
 * 启用后：求解器、步数、CFG、rescale 全部锁定为合约值，CFG 调度 / 动态阈值 /
 *         SDEdit 局部修复一律关闭 —— 这些都会改变速度场 v 的分布，令 c 失效。
 *
 * @param {Object} req
 * @param {boolean} req.enabled - 用户设置开关
 * @param {boolean} req.isFP16 - 当前 diff_step I/O 是否为 FP16（兼容旧调用）
 * @param {'fp32'|'fp16'|'int8'|'int8-npu'|string} [req.diffStepPrecision] -
 *        diff_step 的量化精度类别；缺省时用 isFP16 推断
 * @param {string} req.samplerName - 请求的求解器
 * @param {number} req.totalSteps - 请求的步数
 * @param {number} req.cfgStrength - 请求的 CFG
 * @param {number} req.cfgRescale - 请求的 CFG rescale
 * @param {Object|null} req.cfgScheduleOpts - CFG 调度（将被清空）
 * @param {Object|null} req.dynamicThresholdOpts - 动态阈值（将被清空）
 * @returns {{active:boolean, reason:string|null, notes:string[],
 *            correction:Float32Array|null, precision:string|null,
 *            params:{samplerName:string,totalSteps:number,cfgStrength:number,
 *                    cfgRescale:number,cfgScheduleOpts:null,dynamicThresholdOpts:null,
 *                    sdEditDisabled:boolean}}}
 */
function resolveQDrift(req) {
    const {
        enabled, isFP16, samplerName, totalSteps,
        cfgStrength, cfgRescale, cfgScheduleOpts, dynamicThresholdOpts,
        diffStepEp, diffStepPrecision,
    } = req || {};
    const notes = [];
    const inactive = (reason) => ({
        active: false, reason, notes, correction: null, precision: null,
        params: {
            samplerName, totalSteps, cfgStrength, cfgRescale,
            cfgScheduleOpts, dynamicThresholdOpts, sdEditDisabled: false,
        },
    });

    if (!enabled) return inactive('disabled');

    // 精度类别：显式 diffStepPrecision 优先；否则退回 isFP16 推断（旧调用兼容）。
    // int8-npu 走 WebNN 另一套运行时，不支持。
    let precision;
    if (diffStepPrecision === 'int8') precision = 'int8';
    else if (diffStepPrecision === 'fp16' || (diffStepPrecision === undefined && isFP16)) precision = 'fp16';
    else precision = null;
    if (!precision) {
        notes.push(`Q-Drift 仅对 FP16/INT8 DiT 有意义（当前 diffStepPrecision=${diffStepPrecision || (isFP16 ? 'fp16' : 'fp32')}），本次不启用`);
        return inactive('precision-unsupported');
    }

    const correction = getCorrection(precision);
    if (!correction) return inactive('correction-unavailable');
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
        precision,
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
