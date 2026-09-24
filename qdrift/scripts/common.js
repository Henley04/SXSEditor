/**
 * Q-Drift 校准/评测共用工具（Node + onnxruntime-node + DirectML）
 *
 * 与 src/inference/pipeline 的推理路径保持数学一致：
 *   - CFG + rescale 组合方式同 diffusion.js 的 combine()
 *   - σ_i = (i + 0.5) / N_STEPS，Euler 步 Δσ = 1 / N_STEPS
 *   - 输入张量精度随模型（FP16 图喂 float16）
 */
const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-node');

const ROOT = path.resolve(__dirname, '..', '..');

// ---- 采样器合约（★ 与 src/inference/pipeline/constants.js 保持一致）----
const N_STEPS = 32;
const H = 1.0 / N_STEPS;
const CFG = 3.0;
const RESCALE_CFG = 0.7;      // constants.js: CFG_RESCALE = 0.7
const MEL_DIM = 128;
const COND_DIM = 1024;

const DML_OPTS = {
    executionProviders: [{ name: 'dml', deviceId: 0 }, 'cpu'],
    enableMemPattern: false,
};

// ------------------------------------------------------------------ 随机与精度
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Box-Muller 标准正态 */
function randn(rnd, len) {
    const out = new Float32Array(len);
    for (let i = 0; i < len; i += 2) {
        let u1 = rnd(), u2 = rnd();
        if (u1 < 1e-12) u1 = 1e-12;
        const r = Math.sqrt(-2 * Math.log(u1));
        const th = 2 * Math.PI * u2;
        out[i] = r * Math.cos(th);
        if (i + 1 < len) out[i + 1] = r * Math.sin(th);
    }
    return out;
}

function float32ToFloat16(v) {
    f32[0] = v;
    const x = u32[0];
    const sign = (x >>> 16) & 0x8000;
    let exp = (x >>> 23) & 0xff;
    let mant = x & 0x7fffff;
    if (exp === 0 && mant === 0) return sign;
    if (exp === 255) return sign | (mant ? 0x7e00 : 0x7c00);
    let e = exp - 127 + 15;
    if (e >= 31) return sign | 0x7c00;
    if (e <= 0) {
        if (e < -10) return sign;
        mant |= 0x800000;
        return sign | (mant >>> (14 - e));
    }
    return sign | (e << 10) | (mant >>> 13);
}
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function toF16(a) {
    const u = new Uint16Array(a.length);
    for (let i = 0; i < a.length; i++) u[i] = float32ToFloat16(a[i]);
    return u;
}

function f16ToF32(h) {
    const sign = (h & 0x8000) ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const mant = h & 0x3ff;
    if (exp === 0) return sign * mant * Math.pow(2, -24);
    if (exp === 31) return (mant ? NaN : sign * Infinity);
    return sign * (1 + mant / 1024) * Math.pow(2, exp - 15);
}

function asFloat32(data) {
    if (data instanceof Float32Array) return data;
    if (data instanceof Uint16Array) {
        const dst = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) dst[i] = f16ToF32(data[i]);
        return dst;
    }
    return Float32Array.from(data);
}

// ------------------------------------------------------------------ ONNX 后端
/**
 * 把一个已创建的 ORT 会话包装成统一的 diff_step 调用接口。
 * 输入精度从会话元数据自动探测（fp16/ 下的图并非全是 fp16 I/O）。
 */
function wrapDiffSession(sess, isFp16, tag) {
    return {
        sess, isFp16, tag,
        async call(xt, t, cond, mask, seqLen) {
            const feeds = {};
            if (isFp16) {
                feeds.xt_input = new ort.Tensor('float16', toF16(xt), [1, seqLen, MEL_DIM]);
                feeds.t = new ort.Tensor('float16', toF16(new Float32Array([t])), [1]);
                feeds.cond = new ort.Tensor('float16', toF16(cond), [1, seqLen, cond.length / seqLen]);
                feeds.xt_mask = new ort.Tensor('float16', toF16(mask), [1, seqLen]);
            } else {
                feeds.xt_input = new ort.Tensor('float32', xt, [1, seqLen, MEL_DIM]);
                feeds.t = new ort.Tensor('float32', new Float32Array([t]), [1]);
                feeds.cond = new ort.Tensor('float32', cond, [1, seqLen, cond.length / seqLen]);
                feeds.xt_mask = new ort.Tensor('float32', mask, [1, seqLen]);
            }
            const res = await sess.run(feeds);
            return asFloat32(res.flow_pred.data);
        },
    };
}

/** 默认 DML 路径（应用实际使用的 EP） */
async function makeDiffSession(modelPath) {
    const sess = await ort.InferenceSession.create(modelPath, DML_OPTS);
    const isFp16 = detectFloat16(sess, 'xt_input');
    return wrapDiffSession(sess, isFp16, 'dml');
}

/**
 * 指定 EP 创建 diff_step 会话，用于跨 EP 的量化误差对比
 * （如 WinML / NvTensorRtRtx / OpenVINO / CPU）。
 * @param {string} modelPath
 * @param {Array} executionProviders - ORT EP 列表
 * @param {string} tag - 日志标签
 */
async function makeDiffSessionEps(modelPath, executionProviders, tag) {
    const sess = await ort.InferenceSession.create(modelPath, {
        executionProviders,
        enableMemPattern: false,
    });
    const isFp16 = detectFloat16(sess, 'xt_input');
    console.log(`  diff ${path.basename(modelPath)} [${tag}]: xt_input = ${isFp16 ? 'float16' : 'float32'}`);
    return wrapDiffSession(sess, isFp16, tag);
}

/**
 * 从会话元数据探测输入张量的元素类型。
 * 注意：fp16/ 下的图并非全是 fp16 I/O —— 例如 fp16/vocoder_dml.onnx 是
 * "fp16 权重 + float32 输入输出"，硬编码精度会直接报错。
 */
function detectFloat16(sess, inputName) {
    try {
        const meta = sess.inputMetadata;
        const list = Array.isArray(meta) ? meta : Object.values(meta || {});
        const m = list.find(x => x && x.name === inputName);
        if (m) return String(m.type || '').includes('16');
    } catch (_) { /* 探测失败回退到显式指定 */ }
    return null;
}

async function makeVocoderSession(modelPath) {
    const sess = await ort.InferenceSession.create(modelPath, DML_OPTS);
    const isFp16 = detectFloat16(sess, 'mel');
    console.log(`  vocoder ${path.basename(modelPath)}: mel 输入 = ${isFp16 ? 'float16' : 'float32'}`);
    return async function (mel, frames) {
        const feed = isFp16
            ? { mel: new ort.Tensor('float16', toF16(mel), [1, frames, MEL_DIM]) }
            : { mel: new ort.Tensor('float32', mel, [1, frames, MEL_DIM]) };
        const res = await sess.run(feed);
        return asFloat32(res.waveform.data);
    };
}

/**
 * CFG + rescale 后的速度场，与 diffusion.js combine() 数学等价：
 *   cfgVal  = cond + CFG*(cond - uncond)
 *   rescale = std(cond)/std(cfgVal)
 *   v       = RESCALE_CFG*(cfgVal*rescale) + (1-RESCALE_CFG)*cfgVal
 */
async function cfgVelocity(diff, xt, prompt, cond, pl, tl, tVal, cfgOverride) {
    const cfgStrength = typeof cfgOverride === 'number' ? cfgOverride : CFG;
    const totalLen = pl + tl;
    const xtInput = new Float32Array(totalLen * MEL_DIM);
    xtInput.set(prompt, 0);
    xtInput.set(xt, pl * MEL_DIM);
    const xtMask = new Float32Array(totalLen).fill(1);

    const pred = await diff.call(xtInput, tVal, cond, xtMask, totalLen);
    const flowPred = new Float32Array(tl * MEL_DIM);
    for (let f = 0; f < tl; f++) {
        const src = (pl + f) * MEL_DIM, dst = f * MEL_DIM;
        for (let d = 0; d < MEL_DIM; d++) flowPred[dst + d] = pred[src + d];
    }

    const uncond = await diff.call(xt, tVal, new Float32Array(tl * COND_DIM), new Float32Array(tl).fill(1), tl);

    const n = tl * MEL_DIM;
    let posMean = 0, posM2 = 0, cfgMean = 0, cfgM2 = 0;
    const cfgVal = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const c = flowPred[i];
        const v = c + cfgStrength * (c - uncond[i]);
        cfgVal[i] = v;
        const d1 = c - posMean; posMean += d1 / (i + 1); posM2 += d1 * (c - posMean);
        const d2 = v - cfgMean; cfgMean += d2 / (i + 1); cfgM2 += d2 * (v - cfgMean);
    }
    const posStd = Math.sqrt(Math.max(0, posM2) / Math.max(1, n - 1));
    const cfgStd = Math.sqrt(Math.max(0, cfgM2) / Math.max(1, n - 1));
    const rescale = posStd / (cfgStd + 1e-8);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = RESCALE_CFG * (cfgVal[i] * rescale) + (1 - RESCALE_CFG) * cfgVal[i];
    return v;
}

/**
 * 32 步 Euler 采样。correction 非空时施加 Q-Drift 逐通道修正。
 * @returns {Float32Array} mel (frames*MEL_DIM)
 */
async function runSampler(diff, prompt, cond, pl, tl, seed, correction, cfgAtStep) {
    const xt = randn(mulberry32(seed), tl * MEL_DIM);
    for (let i = 0; i < N_STEPS; i++) {
        const tVal = (i + 0.5) / N_STEPS;
        const cfgI = typeof cfgAtStep === 'function' ? cfgAtStep(i) : undefined;
        const v = await cfgVelocity(diff, xt, prompt, cond, pl, tl, tVal, cfgI);
        if (correction) {
            const base = i * MEL_DIM;
            for (let f = 0; f < tl; f++) {
                const off = f * MEL_DIM;
                for (let ch = 0; ch < MEL_DIM; ch++) {
                    xt[off + ch] += H * v[off + ch] * (1 + correction[base + ch]);
                }
            }
        } else {
            for (let k = 0; k < xt.length; k++) xt[k] += H * v[k];
        }
    }
    return xt;
}

function loadItem(item) {
    const dir = path.join(ROOT, 'qdrift', 'conds_bin');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${item}.json`), 'utf-8'));
    const prompt = new Float32Array(fs.readFileSync(path.join(dir, `${item}_prompt.bin`)).buffer);
    const cond = new Float32Array(fs.readFileSync(path.join(dir, `${item}_cond.bin`)).buffer);
    return { ...meta, prompt, cond };
}

module.exports = {
    ROOT, N_STEPS, H, CFG, RESCALE_CFG, MEL_DIM, COND_DIM, DML_OPTS,
    mulberry32, randn, toF16, f16ToF32, asFloat32, detectFloat16,
    wrapDiffSession, makeDiffSession, makeDiffSessionEps,
    makeVocoderSession, cfgVelocity, runSampler, loadItem,
};
