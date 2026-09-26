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
 *     v_ref   = cfgVelocity(参考 DiT, x_i, sigma_i)
 *     v_quant = cfgVelocity(量化 DiT, x_i, sigma_i)    // 同一 latent，配对
 *     dv_i    = v_quant - v_ref
 *     x_{i+1} = x_i + h * v_ref                        // 轨迹用全精度推进
 *   V_{sigma_i} = E[dv^2] - E[dv]^2   （逐 mel 通道，对样本与帧聚合）
 *   c_i         = V_i / (2 * (i + 0.5))                // h 已约去
 *
 * 合约（★ 与 src/inference/pipeline/constants.js + samplers/euler.js 一致）：
 *   N_STEPS = 32, Euler, CFG = 3.0, RESCALE_CFG = 0.7, sigma_i = (i+0.5)/32
 *
 * 用法:
 *   # FP16（默认；不带参数时与旧版完全等价：nat_* 8 条，输出 qdrift/calib/）
 *   node --expose-gc qdrift/scripts/calibrate_dml.js
 *
 *   # FP16 全量重标定（nat + 真实工程，3 seeds）
 *   node --expose-gc qdrift/scripts/calibrate_dml.js --precision fp16 \
 *     --data-dirs qdrift/conds_bin,qdrift/conds_proj --seeds 1234,7777,20260924
 *
 *   # INT8（输出 qdrift/calib_int8/）
 *   node --expose-gc qdrift/scripts/calibrate_dml.js --precision int8 \
 *     --data-dirs qdrift/conds_bin,qdrift/conds_proj --seeds 1234,7777,20260924
 *
 * 选项:
 *   --precision fp16|int8     量化模型精度（默认 fp16）
 *   --ref-model <path>        参考（全精度）模型，默认 onnx_models/diff_step_dml.onnx
 *   --quant-model <path>      量化模型，默认按 precision 选取
 *   --data-dirs <a,b>         条件数据目录（默认 qdrift/conds_bin）
 *   --tags <nat,prj>          item 名前缀白名单（默认 nat,prj）
 *   --items <N>               最多取 N 条（0=全部，默认 0）
 *   --seeds <a,b,c>           噪声种子（默认 1234,7777）
 *   --out-prefix <path>       输出前缀（默认 qdrift/calib[/_int8]/qdrift）
 *   --restart                 忽略 state 重新累计
 */
const fs = require('fs');
const path = require('path');
const {
    ROOT, N_STEPS, H, CFG, RESCALE_CFG, MEL_DIM,
    mulberry32, randn, makeDiffSession, cfgVelocity, loadItem, loadManifests,
} = require('./common');

function parseArgs(argv) {
    const get = (k, d) => {
        const i = argv.indexOf('--' + k);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
    };
    const precision = get('precision', 'fp16');
    const defaultQuant = precision === 'fp16'
        ? path.join(ROOT, 'onnx_models', 'fp16', 'diff_step_dml.onnx')
        : path.join(ROOT, 'onnx_models', 'int8', 'diff_step_dml.onnx');
    return {
        precision,
        refModel: get('ref-model', path.join(ROOT, 'onnx_models', 'diff_step_dml.onnx')),
        quantModel: get('quant-model', defaultQuant),
        dataDirs: get('data-dirs', path.join('qdrift', 'conds_bin')).split(',').map(s => s.trim()).filter(Boolean),
        tags: get('tags', 'nat,prj').split(',').map(s => s.trim()).filter(Boolean),
        nItems: parseInt(get('items', '0'), 10),
        seeds: get('seeds', '1234,7777').split(',').map(Number),
        outPrefix: get('out-prefix', ''),
        restart: argv.includes('--restart'),
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!['fp16', 'int8'].includes(args.precision)) {
        throw new Error(`--precision must be fp16 or int8, got ${args.precision}`);
    }
    const finalQuant = path.isAbsolute(args.quantModel) ? args.quantModel : path.join(ROOT, args.quantModel);
    const finalRef = path.isAbsolute(args.refModel) ? args.refModel : path.join(ROOT, args.refModel);

    const defaultPrefix = path.join(ROOT, 'qdrift',
        args.precision === 'fp16' ? path.join('calib', 'qdrift') : path.join('calib_int8', 'qdrift'));
    const outPrefix = args.outPrefix
        ? (path.isAbsolute(args.outPrefix) ? args.outPrefix : path.join(ROOT, args.outPrefix))
        : defaultPrefix;
    fs.mkdirSync(path.dirname(outPrefix), { recursive: true });
    const stateFile = outPrefix + '_state.json';

    // ---- 样本清单（多目录合并 + 标签过滤）----
    let items = loadManifests(args.dataDirs, args.tags);
    if (args.nItems > 0) items = items.slice(0, args.nItems);
    if (items.length === 0) throw new Error('no calibration items selected (check --data-dirs / --tags)');
    const nTrajTotal = items.length * args.seeds.length;
    const secList = items.map(m => m.seconds).filter(Number.isFinite);
    console.log(`[Q-Drift] precision=${args.precision}  items=${items.length} (tags=${args.tags.join(',')})  seeds=${args.seeds.join(',')}  trajectories=${nTrajTotal}`);
    console.log(`[Q-Drift] data dirs: ${args.dataDirs.join(', ')}`);
    console.log(`[Q-Drift] ref  : ${finalRef}`);
    console.log(`[Q-Drift] quant: ${finalQuant}`);
    console.log(`[Q-Drift] 合约: Euler @ ${N_STEPS} 步, CFG=${CFG}, rescale=${RESCALE_CFG}, EP=DirectML`);
    if (secList.length) {
        console.log(`[Q-Drift] 时长区间: ${Math.min(...secList).toFixed(2)}s ~ ${Math.max(...secList).toFixed(2)}s`);
    }

    console.log('[Q-Drift] 加载参考/量化 DiT (DML) ...');
    const t0 = Date.now();
    const ref = await makeDiffSession(finalRef);
    const quant = await makeDiffSession(finalQuant);
    console.log(`[Q-Drift] 会话就绪 ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `(ref fp16-in=${ref.isFp16} out=${ref.outName}; quant fp16-in=${quant.isFp16} out=${quant.outName})`);

    // 累加器：(n_steps, mel_dim)
    const S = N_STEPS * MEL_DIM;
    let cnt = new Float64Array(S);
    let s1 = new Float64Array(S);
    let s2 = new Float64Array(S);
    let done = [];
    const dvRms = [];

    if (fs.existsSync(stateFile) && !args.restart) {
        const st = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        // state 只在模型路径一致时才可续用（不同量化模型的 Δv 不能混）。
        // 兼容旧版 fp16 state（无模型字段：其合约与默认 fp32/fp16 路径完全相同）。
        const legacyFp16 = args.precision === 'fp16' && !st.ref_model && !st.quant_model;
        if (legacyFp16 || (st.ref_model === finalRef && st.quant_model === finalQuant)) {
            cnt = Float64Array.from(st.cnt); s1 = Float64Array.from(st.s1); s2 = Float64Array.from(st.s2);
            done = st.done || [];
            for (const r of st.dvRms || []) dvRms.push(r);
            console.log(`[Q-Drift] 续跑：已完成 ${done.length}/${nTrajTotal} 个 trajectory`);
        } else {
            console.log('[Q-Drift] state 模型路径与本次不一致，丢弃旧 state 重新累计');
        }
    }

    const persist = () => fs.writeFileSync(stateFile, JSON.stringify({
        cnt: Array.from(cnt), s1: Array.from(s1), s2: Array.from(s2), done, dvRms,
        ref_model: finalRef, quant_model: finalQuant, seeds: args.seeds,
    }));

    let trajIdx = done.length;
    const wallStart = Date.now();
    for (const m of items) {
        const d = loadItem(m.item, m._dir);
        const { prompt, cond, prompt_len: pl, target_len: tl } = d;

        for (const seed of args.seeds) {
            const key = `${m.item}#${seed}`;
            if (done.includes(key)) { console.log(`  ${key} 缓存（跳过）`); continue; }

            const xt = randn(mulberry32(seed), tl * MEL_DIM);
            const perStep = new Float64Array(N_STEPS);
            const ts = Date.now();
            for (let i = 0; i < N_STEPS; i++) {
                const tVal = (i + 0.5) / N_STEPS;
                const vRef = await cfgVelocity(ref, xt, prompt, cond, pl, tl, tVal);
                const vQ = await cfgVelocity(quant, xt, prompt, cond, pl, tl, tVal);
                let acc = 0;
                const sbase = i * MEL_DIM;
                for (let f = 0; f < tl; f++) {
                    const base = f * MEL_DIM;
                    for (let ch = 0; ch < MEL_DIM; ch++) {
                        const dv = vQ[base + ch] - vRef[base + ch];
                        s1[sbase + ch] += dv;
                        s2[sbase + ch] += dv * dv;
                        acc += dv * dv;
                    }
                }
                for (let ch = 0; ch < MEL_DIM; ch++) cnt[sbase + ch] += tl;
                perStep[i] = Math.sqrt(acc / (tl * MEL_DIM));
                for (let k = 0; k < xt.length; k++) xt[k] += H * vRef[k];
            }
            dvRms.push({ key, tl, seconds: m.seconds, rms: Array.from(perStep) });
            done.push(key);
            persist(); // 每条轨迹后立即落盘：长任务被中断也不丢进度
            trajIdx++;
            const el = (Date.now() - ts) / 1000;
            const eta = trajIdx < nTrajTotal
                ? ((Date.now() - wallStart) / 1000 / Math.max(1, trajIdx)) * (nTrajTotal - trajIdx) : 0;
            console.log(`  [${trajIdx}/${nTrajTotal}] ${key} tl=${tl} (${m.seconds}s) pl=${pl}` +
                ` |dv|rms ${perStep[0].toExponential(2)} -> ${perStep[N_STEPS - 1].toExponential(2)}` +
                ` (${el.toFixed(1)}s${eta ? `, ETA ${(eta / 60).toFixed(1)}min` : ''})`);
            if (typeof global.gc === 'function') global.gc();
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
    fs.writeFileSync(outPrefix + '_V.bin', Buffer.from(V.buffer));
    fs.writeFileSync(outPrefix + '_c.bin', Buffer.from(c.buffer));

    const vMean = [], cMean = [];
    for (let i = 0; i < N_STEPS; i++) {
        let a = 0, b = 0;
        for (let d = 0; d < MEL_DIM; d++) { a += V[i * MEL_DIM + d]; b += c[i * MEL_DIM + d]; }
        vMean.push(a / MEL_DIM); cMean.push(b / MEL_DIM);
    }
    const tagBreakdown = {};
    for (const m of items) {
        const tag = m.item.split('_')[0];
        tagBreakdown[tag] = (tagBreakdown[tag] || 0) + 1;
    }
    const meta = {
        method: 'Q-Drift (arXiv:2603.18095)',
        solver: 'euler',
        n_steps: N_STEPS,
        mel_dim: MEL_DIM,
        cfg: CFG,
        rescale_cfg: RESCALE_CFG,
        sigma_i: Array.from({ length: N_STEPS }, (_, i) => (i + 0.5) / N_STEPS),
        delta_sigma: H,
        precision: args.precision,
        target: `FP32 ONNX (${path.relative(ROOT, finalRef)})`,
        quantized: `${args.precision.toUpperCase()} ONNX (${path.relative(ROOT, finalQuant)})`,
        subgraph: 'diff_step_dml',
        execution_provider: 'DmlExecutionProvider (onnxruntime-node, 与应用同一运行时)',
        n_calib_items: items.length,
        n_calib_trajectories: done.length,
        item_tag_breakdown: tagBreakdown,
        seeds: args.seeds,
        data_dirs: args.dataDirs,
        items: items.map(m => ({ item: m.item, seconds: m.seconds, prompt_len: m.prompt_len, target_len: m.target_len })),
        sequence_regime_sec: [Math.min(...secList), Math.max(...secList)],
        aggregation: 'channel-wise conditional variance V = E[dv^2] - E[dv]^2, scalarized over frames & samples',
        c_formula: 'c_i = V_i / (2*(i+0.5))',
        V_mean_per_step: vMean,
        c_mean_per_step: cMean,
    };
    fs.writeFileSync(outPrefix + '_meta.json', JSON.stringify(meta, null, 2));
    console.log('\n[Q-Drift] V per-step mean (0,8,16,24,31):',
        [0, 8, 16, 24, 31].map(i => vMean[i].toExponential(3)).join('  '));
    console.log('[Q-Drift] c per-step mean (0,8,16,24,31):',
        [0, 8, 16, 24, 31].map(i => cMean[i].toExponential(3)).join('  '));
    console.log('[Q-Drift] 输出:', outPrefix + '_V.bin / _c.bin / _meta.json');
    console.log('[Q-Drift] 下一步: node qdrift/scripts/gen_asset.js --calib-prefix ' +
        path.relative(ROOT, outPrefix).replace(/\\/g, '/') + ' --precision ' + args.precision);
}

main().catch(e => { console.error('[Q-Drift] 失败:', e); process.exit(1); });
