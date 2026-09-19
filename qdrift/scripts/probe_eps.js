/**
 * 跨执行提供者的 FP16 量化误差探测。
 *
 * 目的：Q-Drift 的校正因子 c 来自 "FP16 图相对 FP32 图的 Δv 方差"，
 * 而这个 Δv 是 **EP 相关** 的 —— 实测 DML 上的 |Δv| 是 CPU EP 的 6.5~8 倍。
 * 应用除了 DML 还会尝试 Windows ML 插件 EP（NvTensorRtRtx / OpenVINO），
 * 所以必须逐个 EP 量一遍，才能判断「用 DML 校准的 c 能不能直接套到别的 EP 上」。
 *
 * 指标：Δv_i = v_fp16(x_i, σ_i) - v_fp32(x_i, σ_i)（同一 latent 配对），
 *       报告 |Δv|rms 及其相对 |v_fp32|rms 的大小，以及单步耗时。
 *
 * 用法（WinML 需要原生桥接，必须显式指到 .node）:
 *   SXS_ORT_BRIDGE_PATH=D:/Document/electron/SXSEditor/.webpack/main/native/ort_bridge.node \
 *     node qdrift/scripts/probe_eps.js --steps 3 --eps dml,trtrtx,openvino,cpu
 */
const path = require('path');
const {
    ROOT, N_STEPS, H, MEL_DIM,
    mulberry32, randn, detectFloat16, wrapDiffSession,
    makeDiffSession, makeDiffSessionEps, cfgVelocity, loadItem,
} = require('./common');

const FP32_DIFF = path.join(ROOT, 'onnx_models', 'diff_step_dml.onnx');
const FP16_DIFF = path.join(ROOT, 'onnx_models', 'fp16', 'diff_step_dml.onnx');

// WinML 需要 winmlEnabled=true；模块在纯 Node 下读不到 electron settings，
// 用模块自带的进程内快照入口注入。
globalThis.__SXS_SETTINGS_SNAPSHOT__ = { winmlEnabled: true, nativeInferenceBackend: 'winml' };

/** 创建一个 EP 上的 FP32 + FP16 配对会话；失败返回 null 并打印原因。 */
async function buildPair(name) {
    try {
        if (name === 'dml') {
            return { fp32: await makeDiffSession(FP32_DIFF), fp16: await makeDiffSession(FP16_DIFF) };
        }
        if (name === 'cpu') {
            return {
                fp32: await makeDiffSessionEps(FP32_DIFF, ['cpu'], 'cpu'),
                fp16: await makeDiffSessionEps(FP16_DIFF, ['cpu'], 'cpu'),
            };
        }
        if (name === 'trtrtx' || name === 'openvino') {
            const ortBridge = require(path.join(ROOT, 'src', 'inference', 'winml', 'ortBridge.js'));
            const winml = require(path.join(ROOT, 'src', 'inference', 'winml', 'winmlProvider.js'));
            if (name === 'trtrtx') {
                // 走应用的真实路径：候选链按优先级挑 EP（dynamic 形状 → NvTensorRtRtx）
                const a = await winml.tryCreateWinMLSession(FP32_DIFF, false, false);
                const b = await winml.tryCreateWinMLSession(FP16_DIFF, false, false);
                if (!a || !b) throw new Error('tryCreateWinMLSession 返回 null');
                return {
                    fp32: wrapDiffSession(a.session, detectFloat16(a.session, 'xt_input'), a.ep),
                    fp16: wrapDiffSession(b.session, detectFloat16(b.session, 'xt_input'), b.ep),
                };
            }
            // OpenVINO 不在 dynamic 形状的默认候选链里，直接按设备索引建会话
            const devices = await ortBridge.listDevices();
            const idx = (devices || []).findIndex(d =>
                String(d.epName || '').includes('OpenVINO') &&
                String(d.deviceType || '').toLowerCase() === 'cpu');
            if (idx < 0) throw new Error('未找到 OpenVINO CPU 设备条目');
            const tag = `OpenVINO/${(devices[idx].deviceType || 'cpu')}`;
            const s32 = await ortBridge.createSessionWithEps(FP32_DIFF, [idx], 'OpenVINOExecutionProvider');
            const s16 = await ortBridge.createSessionWithEps(FP16_DIFF, [idx], 'OpenVINOExecutionProvider');
            return {
                fp32: wrapDiffSession(s32, detectFloat16(s32, 'xt_input'), tag),
                fp16: wrapDiffSession(s16, detectFloat16(s16, 'xt_input'), tag),
            };
        }
        throw new Error(`未知 EP: ${name}`);
    } catch (e) {
        console.log(`  !! [${name}] 会话创建失败: ${String(e.message || e).split('\n')[0].slice(0, 160)}`);
        return null;
    }
}

async function probe(name, item, nSteps, seed) {
    console.log(`\n=== EP: ${name} ===`);
    const t0 = Date.now();
    const pair = await buildPair(name);
    if (!pair) return null;
    console.log(`  会话就绪 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const d = loadItem(item);
    const { prompt, cond, prompt_len: pl, target_len: tl } = d;
    const xt = randn(mulberry32(seed), tl * MEL_DIM);
    const rows = [];
    for (let i = 0; i < nSteps; i++) {
        const tVal = (i + 0.5) / N_STEPS;
        const ts = Date.now();
        let v32, v16;
        try {
            v32 = await cfgVelocity(pair.fp32, xt, prompt, cond, pl, tl, tVal);
            v16 = await cfgVelocity(pair.fp16, xt, prompt, cond, pl, tl, tVal);
        } catch (e) {
            console.log(`  !! step ${i} 推理失败: ${String(e.message || e).split('\n')[0].slice(0, 160)}`);
            return { name, rows, failedAt: i };
        }
        const ms = Date.now() - ts;
        let sd = 0, sv = 0;
        for (let k = 0; k < v32.length; k++) {
            const dv = v16[k] - v32[k];
            sd += dv * dv; sv += v32[k] * v32[k];
        }
        const rms = Math.sqrt(sd / v32.length);
        const vrms = Math.sqrt(sv / v32.length);
        rows.push({ step: i, rms, rel: rms / vrms, ms });
        console.log(`  step ${i}  |dv|rms=${rms.toExponential(3)}  rel=${(rms / vrms).toExponential(3)}  ${ms}ms`);
        for (let k = 0; k < xt.length; k++) xt[k] += H * v32[k];
    }
    return { name, rows, failedAt: null };
}

async function main() {
    const args = process.argv.slice(2);
    const getArg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
    const item = getArg('cond', 'nat_000');
    const nSteps = parseInt(getArg('steps', '3'), 10);
    const eps = getArg('eps', 'dml,trtrtx,openvino,cpu').split(',').map(s => s.trim()).filter(Boolean);
    const seed = parseInt(getArg('seed', '1234'), 10);
    console.log(`[ProbeEP] 样本 ${item}，${nSteps} 步，EP = ${eps.join(', ')}`);

    const results = [];
    for (const ep of eps) results.push(await probe(ep, item, nSteps, seed));

    console.log('\n===== 汇总（同一步、同一 latent）=====');
    console.log('EP         ' + Array.from({ length: nSteps }, (_, i) => `step${i}`.padEnd(11)).join('') + '  相对 DML');
    const base = (results.find(r => r && r.name === 'dml') || {}).rows || [];
    for (const r of results) {
        if (!r) continue;
        const cells = Array.from({ length: nSteps }, (_, i) => {
            const row = r.rows[i];
            return row ? row.rms.toExponential(2).padEnd(11) : '—'.padEnd(11);
        });
        let ratio = '—';
        if (r.rows.length && base.length) {
            const rs = r.rows.map((row, i) => (base[i] ? row.rms / base[i].rms : null)).filter(Boolean);
            if (rs.length) ratio = (rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2) + 'x';
        }
        console.log(`${r.name.padEnd(11)}${cells.join('')}  ${ratio}${r.failedAt !== null ? `  (step${r.failedAt} 失败)` : ''}`);
    }
}

main().catch(e => { console.error('[ProbeEP] 失败:', e); process.exit(1); });
