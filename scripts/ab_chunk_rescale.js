#!/usr/bin/env node
/**
 * ab_chunk_rescale.js — 验证分块扩散"逐 chunk CFG-rescale 独立统计"是否产生
 * chunk 间系统性响度台阶（Task #6：固定位置响度塌陷/乐句整体偏小偏大的候选根因）。
 *
 * 背景：app diffusion.js 的 combine() 在当前 chunk 的 target 帧上独立计算
 *   rescale = std(condPred)/std(cfgPred)，然后 v = cfgVal*(cfgRescale*rescale + 1 - cfgRescale)。
 *   分块时每个 chunk 得到自己的增益因子；整段推理时是全曲单一因子。
 *   若不同 chunk 的内容统计不同 → 增益系统性不同 → 响度台阶（可上可下）。
 *
 * Part 1（诊断）: 整段采样一次（tl=711），每步同时计算
 *   - 整段 rescale（单一因子）
 *   - 各虚拟 chunk 的 rescale（按 app _planChunks 切分：500/50 与 250/50）
 *   折算 blendA = cfgRescale*rescale 的跨 chunk 增益差（dB）。
 *
 * Part 2（因果）: 同一共享噪声场 + 相同线性重叠淡化写回，分块采样成对对比：
 *   X = 逐 chunk 独立 rescale（app 现状）
 *   Y = 全局 rescale（每步用 Part 1 的整段 rescale —— 理想全局统计）
 *   唯一差异 = rescale 因子来源。逐帧 mel 能量差（dB）→ chunk 边界台阶。
 *
 * 采样合约与 app 一致：Euler 32 步、CFG 3.0、rescale 0.7、cfgSchedule linear
 * （1.5→3.0 逐 step）、cond 分支全长（prompt+target）、uncond 仅 target。
 *
 * 用法: node scripts/ab_chunk_rescale.js [item=prj_lagtrain_f0_s02] [seed=1234]
 * 输出: ab_chunk_rescale.log（复制 stdout）/ ab_chunk_rescale_curve.csv
 */

const fs = require('node:fs');
const path = require('node:path');
const ort = require('onnxruntime-node');
const C = require('../qdrift/scripts/common.js');

const ITEM = process.argv[2] || 'prj_lagtrain_f0_s02';
const SEED = Number(process.argv[3] || 1234);
const N_STEPS = C.N_STEPS;           // 32
const H = C.H;
const MEL_DIM = C.MEL_DIM;           // 128
const COND_DIM = C.COND_DIM;         // 1024
const CFG_BASE = C.CFG;              // 3.0
const RESCALE_CFG = C.RESCALE_CFG;   // 0.7
const MODEL = path.join(C.ROOT, 'onnx_models', 'fp16', 'diff_step_dml.onnx');

// app 默认 cfgScheduleMode=linear: start=cfg*0.5, end=cfg
function cfgAtStep(step, totalSteps, cfg) {
    const start = cfg * 0.5, end = cfg;
    return start + (end - start) * step / (totalSteps - 1);
}

/** Welford std over a Float32Array view [start,end) */
function stdOf(arr, start, end) {
    let mean = 0, m2 = 0, n = 0;
    for (let i = start; i < end; i++) {
        const v = arr[i];
        const d = v - mean;
        mean += d / (n + 1);
        m2 += d * (v - mean);
        n++;
    }
    return { std: Math.sqrt(Math.max(0, m2) / Math.max(1, n - 1)), n };
}

/**
 * 一步 CFG 速度场（与 app combine() 等价），同时返回各帧区间的 rescale 统计。
 * @param chunkFramesSpecs: Array<[s,e)> — 需要单独统计 rescale 的 target 帧区间
 * @param rescaleOverride: number|null — 非 null 时用该值代替整段 rescale（Part 2 Y 模式）
 * @returns { v, whole: {rescale}, perChunks: [{s,e,rescale}] }
 */
async function cfgVelocityEx(diff, xt, prompt, condFull, pl, tl, tVal, cfgStrength, chunkFramesSpecs, rescaleOverride) {
    const totalLen = pl + tl;
    const xtInput = new Float32Array(totalLen * MEL_DIM);
    xtInput.set(prompt, 0);
    xtInput.set(xt, pl * MEL_DIM);
    const xtMask = new Float32Array(totalLen).fill(1);

    const pred = await diff.call(xtInput, tVal, condFull, xtMask, totalLen);
    const flowPred = new Float32Array(tl * MEL_DIM);
    for (let f = 0; f < tl; f++) {
        const src = (pl + f) * MEL_DIM, dst = f * MEL_DIM;
        for (let d = 0; d < MEL_DIM; d++) flowPred[dst + d] = pred[src + d];
    }

    const uncond = await diff.call(xt, tVal, new Float32Array(tl * COND_DIM), new Float32Array(tl).fill(1), tl);

    // cfgVal 全量（Welford 按区间重放，避免多份大数组）
    const n = tl * MEL_DIM;
    const cfgVal = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const c = flowPred[i];
        cfgVal[i] = c + cfgStrength * (c - uncond[i]);
    }

    const statsFor = (s, e) => {
        const a = stdOf(flowPred, s * MEL_DIM, e * MEL_DIM);
        const b = stdOf(cfgVal, s * MEL_DIM, e * MEL_DIM);
        return { s, e, rescale: a.std / (b.std + 1e-8), posStd: a.std, cfgStd: b.std };
    };
    const whole = statsFor(0, tl);
    const perChunks = chunkFramesSpecs.map(([s, e]) => statsFor(s, e));

    const rescale = (rescaleOverride !== null && rescaleOverride !== undefined)
        ? rescaleOverride : whole.rescale;
    const blendA = RESCALE_CFG * rescale;
    const blendB = 1 - RESCALE_CFG;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = (blendA + blendB) * cfgVal[i];
    return { v, whole, perChunks };
}

/** app _planChunks（无 F0 搜索简化版）：步进 C-ov，末块截尾并入 */
function planChunks(totalFrames, chunkFrames, overlap) {
    const specs = [];
    let pos = 0;
    while (pos < totalFrames) {
        const chunkStart = specs.length === 0 ? 0 : Math.max(0, pos - overlap);
        const chunkEnd = Math.min(chunkStart + chunkFrames, totalFrames);
        specs.push([chunkStart, chunkEnd]);
        if (chunkEnd >= totalFrames) break;
        pos = chunkEnd;
    }
    return specs;
}

/** 共享噪声场（与 app 相同思路：全曲一次随机，chunk 切片） */
function sharedNoise(seed, tl) {
    return C.randn(C.mulberry32(seed), tl * MEL_DIM);
}

/**
 * 分块采样。rescaleMode:
 *  - 'perChunk': 每 chunk 独立统计（app 现状）
 *  - 'global':   每步用 globalRescales[step]（Part 1 整段值）
 * 写回：非重叠 memcpy，重叠区线性淡化（两种模式一致，隔离 rescale 变量）。
 */
async function runChunked(diff, prompt, condFull, pl, tl, seed, chunkFrames, overlap, rescaleMode, globalRescales, rescaleLog) {
    const specs = planChunks(tl, chunkFrames, overlap);
    const xtAll = sharedNoise(seed, tl);
    for (const [cs, ce] of specs) {
        const cur = ce - cs;
        const t0 = Date.now();
        // chunk 噪声切片 + chunk 条件（prompt 段 + 对应 target 段）
        let xt = new Float32Array(cur * MEL_DIM);
        xt.set(xtAll.subarray(cs * MEL_DIM, ce * MEL_DIM));
        const condChunk = new Float32Array((pl + cur) * COND_DIM);
        condChunk.set(condFull.subarray(0, pl * COND_DIM), 0);
        condChunk.set(condFull.subarray((pl + cs) * COND_DIM, (pl + ce) * COND_DIM), pl * COND_DIM);

        const rescales = [];
        for (let step = 0; step < N_STEPS; step++) {
            const tVal = (step + 0.5) / N_STEPS;
            const cfg = cfgAtStep(step, N_STEPS, CFG_BASE);
            const override = rescaleMode === 'global' ? globalRescales[step] : null;
            const { v, whole } = await cfgVelocityEx(diff, xt, prompt, condChunk, pl, cur, tVal, cfg, [], override);
            if (rescaleMode === 'perChunk') rescales.push(whole.rescale);
            else rescales.push(override);
            for (let k = 0; k < xt.length; k++) xt[k] += H * v[k];
        }
        rescaleLog.push({ cs, ce, mode: rescaleMode, rescales });
        // 写回（线性淡化重叠区）
        if (cs === 0) {
            xtAll.set(xt, 0);
        } else {
            const ovStart = cs;                       // 重叠区在全局的位置
            const ov = Math.min(overlap, cur);
            for (let f = 0; f < ov; f++) {
                const w = (f + 0.5) / ov;             // 0→1
                for (let d = 0; d < MEL_DIM; d++) {
                    const gi = (ovStart + f) * MEL_DIM + d;
                    const ci = f * MEL_DIM + d;
                    xtAll[gi] = (1 - w) * xtAll[gi] + w * xt[ci];
                }
            }
            xtAll.set(xt.subarray(ov * MEL_DIM), (ovStart + ov) * MEL_DIM);
        }
        console.log(`  [chunk ${cs},${ce}) ${cur}f mode=${rescaleMode} rescale avg=${(rescales.reduce((a, b) => a + b, 0) / rescales.length).toFixed(4)} (${Date.now() - t0}ms)`);
    }
    return { mel: xtAll, specs };
}

/** 逐帧 mel 能量（相对 dB） */
function frameEnergyDb(mel, frames) {
    const out = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
        let s = 0;
        for (let d = 0; d < MEL_DIM; d++) { const v = mel[f * MEL_DIM + d]; s += v * v; }
        out[f] = 10 * Math.log10(s / MEL_DIM + 1e-12);
    }
    return out;
}

async function main() {
    console.log(`item=${ITEM} seed=${SEED} steps=${N_STEPS} CFG=${CFG_BASE}(linear) rescale=${RESCALE_CFG}`);
    const item = C.loadItem(ITEM, 'qdrift/conds_proj');
    const pl = item.prompt_len, tl = item.target_len;
    console.log(`pl=${pl} tl=${tl} (${(tl / 50).toFixed(1)}s target)`);

    const diff = await C.makeDiffSession(MODEL);
    console.log('diff session ready (DML)');

    // ---------- Part 1: 整段采样 + 逐步 rescale 诊断 ----------
    console.log('\n=== Part 1: 整段采样，逐 step 提取 rescale（整段 vs 虚拟 chunk） ===');
    const plans = {
        '500/50': planChunks(tl, 500, 50),
        '250/50': planChunks(tl, 250, 50),
    };
    for (const [k, v] of Object.entries(plans)) {
        console.log(`plan ${k}: ${v.map(([s, e]) => `[${s},${e})`).join(' ')}`);
    }
    const allSpecs = new Map();
    for (const [k, v] of Object.entries(plans)) {
        for (const [s, e] of v) {
            if (!allSpecs.has(`${s}-${e}`)) allSpecs.set(`${s}-${e}`, [s, e]);
        }
    }
    const specList = [...allSpecs.values()];

    let xt = sharedNoise(SEED, tl);
    const prompt = item.prompt;
    const wholeRescales = new Array(N_STEPS);
    // perStep[specKey][step] = rescale
    const perStep = new Map(specList.map(([s, e]) => [`${s}-${e}`, new Array(N_STEPS)]));
    const t0 = Date.now();
    for (let step = 0; step < N_STEPS; step++) {
        const tVal = (step + 0.5) / N_STEPS;
        const cfg = cfgAtStep(step, N_STEPS, CFG_BASE);
        const { v, whole, perChunks } = await cfgVelocityEx(diff, xt, prompt, item.cond, pl, tl, tVal, cfg, specList, null);
        wholeRescales[step] = whole.rescale;
        for (const pc of perChunks) perStep.get(`${pc.s}-${pc.e}`)[step] = pc.rescale;
        for (let k = 0; k < xt.length; k++) xt[k] += H * v[k];
        if (step % 8 === 0) console.log(`  step ${step}: whole rescale=${whole.rescale.toFixed(4)} cfg=${cfg.toFixed(3)}`);
    }
    console.log(`整段采样完成 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    console.log('\n--- Part 1 结果: 每步 rescale（整段 | 各虚拟 chunk） ---');
    console.log('step|whole|' + specList.map(([s, e]) => `[${s},${e})`).join('|'));
    for (let step = 0; step < N_STEPS; step++) {
        const row = [step, wholeRescales[step].toFixed(4),
            ...specList.map(([s, e]) => perStep.get(`${s}-${e}`)[step].toFixed(4))];
        console.log(row.join('|'));
    }

    // 跨 chunk 增益差（dB）：gain(c) = 0.7*r_c + 0.3；dB = 20*log10(gain_c/gain_whole)
    console.log('\n--- 每 chunk 平均 rescale 与增益台阶（相对整段） ---');
    const gainDb = (r) => 20 * Math.log10((RESCALE_CFG * r + (1 - RESCALE_CFG)) / (RESCALE_CFG * wholeMean + (1 - RESCALE_CFG)));
    const wholeMean = wholeRescales.reduce((a, b) => a + b, 0) / N_STEPS;
    console.log(`whole mean rescale=${wholeMean.toFixed(4)}  gain=1.000 (0.00dB)`);
    for (const [s, e] of specList) {
        const rs = perStep.get(`${s}-${e}`);
        const mean = rs.reduce((a, b) => a + b, 0) / N_STEPS;
        const min = Math.min(...rs), max = Math.max(...rs);
        console.log(`chunk[${s},${e}): mean=${mean.toFixed(4)} min=${min.toFixed(4)} max=${max.toFixed(4)}  gainDb=${gainDb(mean).toFixed(3)}dB (range ${gainDb(min).toFixed(3)}..${gainDb(max).toFixed(3)})`);
    }

    // ---------- Part 2: 端到端 A/B（独立 rescale vs 全局 rescale） ----------
    console.log('\n=== Part 2: 分块端到端 A/B（X=perChunk 现状 vs Y=global 理想） ===');
    const results = {};
    for (const [cf, ov] of [[500, 50], [250, 50]]) {
        const tag = `${cf}/${ov}`;
        console.log(`\n-- plan ${tag} --`);
        const logX = [], logY = [];
        const X = await runChunked(diff, prompt, item.cond, pl, tl, SEED, cf, ov, 'perChunk', null, logX);
        const Y = await runChunked(diff, prompt, item.cond, pl, tl, SEED, cf, ov, 'global', wholeRescales, logY);
        const eX = frameEnergyDb(X.mel, tl);
        const eY = frameEnergyDb(Y.mel, tl);
        const d = new Float32Array(tl);
        for (let f = 0; f < tl; f++) d[f] = eX[f] - eY[f];
        results[tag] = { X, Y, eX, eY, d, specs: X.specs };
        console.log(`plan ${tag}: X-Y 帧能量差 mean=${(d.reduce((a, b) => a + b, 0) / tl).toFixed(3)}dB min=${Math.min(...d).toFixed(3)} max=${Math.max(...d).toFixed(3)}`);
    }

    // ---------- 输出 CSV ----------
    const csvPath = path.join(C.ROOT, 'ab_chunk_rescale_curve.csv');
    const lines = ['frame,time_s,' + Object.entries(plans).flatMap(([k]) =>
        Object.keys(results).filter(t => t.startsWith(k)).map(t => `dXminusY_${t}_dB`)).join(',') + ',' +
        Object.keys(results).map(t => `eX_${t}_dB`).join(',')];
    for (let f = 0; f < tl; f++) {
        const row = [f, (f / 50).toFixed(2)];
        for (const k of Object.keys(plans)) {
            for (const t of Object.keys(results).filter(x => x.startsWith(k))) {
                row.push(results[t].d[f].toFixed(4));
            }
        }
        for (const t of Object.keys(results)) row.push(results[t].eX[f].toFixed(4));
        lines.push(row.join(','));
    }
    fs.writeFileSync(csvPath, lines.join('\n'));
    console.log(`\nCSV -> ${csvPath}`);

    // chunk 边界台阶量化：边界前后各 25 帧窗平均差
    console.log('\n--- chunk 边界台阶（X−Y，边界前后 25 帧均值跳变） ---');
    for (const [tag, r] of Object.entries(results)) {
        for (const [cs, ce] of r.specs.slice(1)) {
            const a0 = Math.max(0, cs - 25), a1 = cs;
            const b0 = cs, b1 = Math.min(tl, cs + 25);
            const avg = (a, b) => { let s = 0; for (let f = a; f < b; f++) s += r.d[f]; return s / (b - a); };
            const stepDb = avg(b0, b1) - avg(a0, a1);
            console.log(`  ${tag} boundary@${cs} (${(cs / 50).toFixed(1)}s): before=${avg(a0, a1).toFixed(3)}dB after=${avg(b0, b1).toFixed(3)}dB step=${stepDb.toFixed(3)}dB`);
        }
    }

    try { await diff.sess.release(); } catch (_) {}
    console.log('\ndone.');
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
