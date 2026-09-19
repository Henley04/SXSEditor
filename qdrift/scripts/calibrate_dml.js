/**
 * Q-Drift 长序列校准（DirectML / onnxruntime-node）
 *
 * 为什么不用 ModelScope 包里的 Python 脚本：
 *   1. 应用实际跑在 DirectML 上，实测 DML 的 FP16 量化误差是 CPU EP 的 6.5~8 倍，
 *      用 CPU 校准会把 V 低估约 50 倍（方差量级）；
 *   2. onnxruntime-node 就是应用使用的运行时，EP 数值完全一致。
 *
 * 方法（arXiv:2603.18095 Algorithm 1）：
 *   对每条校准样本、每个 step i：
 *     v_fp32 = cfgVelocity(FP32 DiT, x_i, sigma_i)
 *     v_fp16 = cfgVelocity(FP16 DiT, x_i, sigma_i)     // 同一 latent，配对
 *     dv_i   = v_fp16 - v_fp32
 *     x_{i+1} = x_i + h * v_fp32                       // 轨迹用全精度推进
 *   V_{sigma_i} = E[dv^2] - E[dv]^2   （逐 mel 通道，对样本与帧聚合）
 *   c_i         = V_i / (2 * (i + 0.5))                // h 已约去
 *
 * 合约（★ 与 src/inference/pipeline/constants.js + samplers/euler.js 一致）：
 *   N_STEPS = 32, Euler, CFG = 3.0, RESCALE_CFG = 0.7, sigma_i = (i+0.5)/32
 *
 * 用法:
 *   node qdrift/scripts/calibrate_dml.js [--items 8] [--seeds 1234,7777] [--restart]
 */
const fs = require('fs');
const path = require('path');
const {
    ROOT, N_STEPS, H, CFG, RESCALE_CFG, MEL_DIM,
    mulberry32, randn, makeDiffSession, cfgVelocity, loadItem,
} = require('./common');

const CONDS_DIR = path.join(ROOT, 'qdrift', 'conds_bin');
const OUT_PREFIX = path.join(ROOT, 'qdrift', 'calib', 'qdrift');
const STATE_FILE = OUT_PREFIX + '_state.json';

const FP32_DIFF = path.join(ROOT, 'onnx_models', 'diff_step_dml.onnx');
const FP16_DIFF = path.join(ROOT, 'onnx_models', 'fp16', 'diff_step_dml.onnx');

async function main() {
    const args = process.argv.slice(2);
    const getArg = (k, d) => {
        const i = args.indexOf('--' + k);
        return i >= 0 && args[i + 1] ? args[i + 1] : d;
    };
    const restart = args.includes('--restart');
    const nItems = parseInt(getArg('items', '8'), 10);
    const seeds = getArg('seeds', '1234,7777').split(',').map(Number);

    const manifest = JSON.parse(fs.readFileSync(path.join(CONDS_DIR, 'manifest.json'), 'utf-8'));
    const items = manifest.filter(m => m.item.startsWith('nat')).slice(0, nItems);
    console.log(`[Q-Drift] 校准项 ${items.length} 条，seeds=${seeds.join(',')}，EP=DirectML`);
    console.log(`[Q-Drift] 合约: Euler @ ${N_STEPS} 步, CFG=${CFG}, rescale=${RESCALE_CFG}`);

    console.log('[Q-Drift] 加载 FP32/FP16 DiT (DML) ...');
    const t0 = Date.now();
    const fp32 = await makeDiffSession(FP32_DIFF);
    const fp16 = await makeDiffSession(FP16_DIFF);
    console.log(`[Q-Drift] 会话就绪 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // 累加器：(n_steps, mel_dim)
    const S = N_STEPS * MEL_DIM;
    let cnt = new Float64Array(S);
    let s1 = new Float64Array(S);
    let s2 = new Float64Array(S);
    let done = [];
    const dvRms = [];

    if (fs.existsSync(STATE_FILE) && !restart) {
        const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        cnt = Float64Array.from(st.cnt); s1 = Float64Array.from(st.s1); s2 = Float64Array.from(st.s2);
        done = st.done || [];
        for (const r of st.dvRms || []) dvRms.push(r);
        console.log(`[Q-Drift] 续跑：已完成 ${done.length} 个 trajectory`);
    }

    for (const m of items) {
        const d = loadItem(m.item);
        const { prompt, cond, prompt_len: pl, target_len: tl } = d;

        for (const seed of seeds) {
            const key = `${m.item}#${seed}`;
            if (done.includes(key)) { console.log(`  ${key} 缓存（跳过）`); continue; }

            const xt = randn(mulberry32(seed), tl * MEL_DIM);
            const perStep = new Float64Array(N_STEPS);
            const ts = Date.now();
            for (let i = 0; i < N_STEPS; i++) {
                const tVal = (i + 0.5) / N_STEPS;
                const v32 = await cfgVelocity(fp32, xt, prompt, cond, pl, tl, tVal);
                const v16 = await cfgVelocity(fp16, xt, prompt, cond, pl, tl, tVal);
                let acc = 0;
                const sbase = i * MEL_DIM;
                for (let f = 0; f < tl; f++) {
                    const base = f * MEL_DIM;
                    for (let ch = 0; ch < MEL_DIM; ch++) {
                        const dv = v16[base + ch] - v32[base + ch];
                        s1[sbase + ch] += dv;
                        s2[sbase + ch] += dv * dv;
                        acc += dv * dv;
                    }
                }
                for (let ch = 0; ch < MEL_DIM; ch++) cnt[sbase + ch] += tl;
                perStep[i] = Math.sqrt(acc / (tl * MEL_DIM));
                for (let k = 0; k < xt.length; k++) xt[k] += H * v32[k];
            }
            dvRms.push({ key, rms: Array.from(perStep) });
            done.push(key);
            // 每条轨迹后立即落盘：长任务被中断也不会丢进度
            fs.writeFileSync(STATE_FILE, JSON.stringify({
                cnt: Array.from(cnt), s1: Array.from(s1), s2: Array.from(s2), done, dvRms,
            }));
            console.log(`  [${done.length}/${items.length * seeds.length}] ${key} tl=${tl} (${m.seconds}s) ` +
                `|dv|rms ${perStep[0].toExponential(2)} -> ${perStep[N_STEPS - 1].toExponential(2)} ` +
                `(${((Date.now() - ts) / 1000).toFixed(1)}s)`);
        }
    }

    // ---- 汇总 V / c ----
    const V = new Float32Array(S);
    for (let i = 0; i < S; i++) {
        const n = Math.max(cnt[i], 1);
        const mean = s1[i] / n, meanSq = s2[i] / n;
        V[i] = Math.max(0, meanSq - mean * mean);
    }
    const c = new Float32Array(S);
    for (let i = 0; i < N_STEPS; i++) {
        for (let d = 0; d < MEL_DIM; d++) c[i * MEL_DIM + d] = V[i * MEL_DIM + d] / (2 * (i + 0.5));
    }
    fs.writeFileSync(OUT_PREFIX + '_V.bin', Buffer.from(V.buffer));
    fs.writeFileSync(OUT_PREFIX + '_c.bin', Buffer.from(c.buffer));

    const vMean = [], cMean = [];
    for (let i = 0; i < N_STEPS; i++) {
        let a = 0, b = 0;
        for (let d = 0; d < MEL_DIM; d++) { a += V[i * MEL_DIM + d]; b += c[i * MEL_DIM + d]; }
        vMean.push(a / MEL_DIM); cMean.push(b / MEL_DIM);
    }
    const seconds = items.map(m => m.seconds);
    const meta = {
        method: 'Q-Drift (arXiv:2603.18095)',
        solver: 'euler',
        n_steps: N_STEPS,
        mel_dim: MEL_DIM,
        cfg: CFG,
        rescale_cfg: RESCALE_CFG,
        sigma_i: Array.from({ length: N_STEPS }, (_, i) => (i + 0.5) / N_STEPS),
        delta_sigma: H,
        target: 'FP32 ONNX (onnx_models/diff_step_dml.onnx)',
        quantized: 'FP16 ONNX (onnx_models/fp16/diff_step_dml.onnx)',
        subgraph: 'diff_step_dml',
        execution_provider: 'DmlExecutionProvider (onnxruntime-node, 与应用同一运行时)',
        n_calib_items: items.length,
        n_calib_trajectories: done.length,
        seeds,
        dataset: 'Soul-AILab/SoulX-Singer-Eval-Dataset (conds_long/nat_*)',
        sequence_regime_sec: [Math.min(...seconds), Math.max(...seconds)],
        aggregation: 'channel-wise conditional variance V = E[dv^2] - E[dv]^2, scalarized over frames & samples',
        c_formula: 'c_i = V_i / (2*(i+0.5))',
        V_mean_per_step: vMean,
        c_mean_per_step: cMean,
    };
    fs.writeFileSync(OUT_PREFIX + '_meta.json', JSON.stringify(meta, null, 2));
    console.log('\n[Q-Drift] V per-step mean (0,8,16,24,31):',
        [0, 8, 16, 24, 31].map(i => vMean[i].toExponential(3)).join('  '));
    console.log('[Q-Drift] c per-step mean (0,8,16,24,31):',
        [0, 8, 16, 24, 31].map(i => cMean[i].toExponential(3)).join('  '));
    console.log('[Q-Drift] 输出:', OUT_PREFIX + '_V.bin / _c.bin / _meta.json');
    console.log('[Q-Drift] 下一步: node qdrift/scripts/gen_asset.js');
}

main().catch(e => { console.error('[Q-Drift] 失败:', e); process.exit(1); });
