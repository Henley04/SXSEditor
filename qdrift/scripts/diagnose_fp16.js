/**
 * FP16 质量归因诊断：到底是 DiT 还是 vocoder 让听感变差？
 *
 * 背景：单步 |Δv| 和 mel 全局残差都很小（0.4%），但主观上 FP16 明显不如 FP32。
 * 通常是**指标选错了**——全局 mel 残差被高能量帧主导，而感知问题集中在低能量
 * （气声/擦音/静音段）与高频细节上；mel 域 0.4% 的误差经 vocoder 这种非线性
 * 放大器后，波形域差异可能完全不成比例。
 *
 * 本脚本用 6 条波形把误差拆开，并把「同一个 FP32 模型换随机种子」当作感知基线：
 *
 *   AA  = voc32(M_A)   参考（FP32 DiT + FP32 vocoder）
 *   AA2 = voc32(M_A2)  基线：同 FP32 模型、不同种子 → 模型自身的随机性有多大
 *   AB  = voc16(M_A)   ★ 只换 vocoder：同一份 FP32 mel 喂给 FP16 声码器
 *   BA  = voc32(M_B)   只换 DiT
 *   BB  = voc16(M_B)   应用里 FP16 档的实际输出（DiT + vocoder 都换）
 *   CC  = voc16(M_C)   FP16 + Q-Drift
 *
 * 指标：STFT 对数谱距离（LSD, dB）、分段 LSD 分位、分频段 LSD、高频能量比。
 * 判读：某条路径的 LSD 若显著大于 AA2 的 LSD，说明它带来的改变已超出模型自身的
 *       随机性，是真差异而不是噪声。
 *
 * 用法: node qdrift/scripts/diagnose_fp16.js [--items nat_000] [--seed 1234]
 */
const fs = require('fs');
const path = require('path');
const {
    ROOT, N_STEPS, MEL_DIM,
    makeDiffSession, makeVocoderSession, runSampler, loadItem,
} = require('./common');

const OUT = path.join(ROOT, 'qdrift', 'diag');

// 谱域工具（FFT / LSD / 分频段 / 高频能量）统一放在 spectral.js，
// 与 lsd_compare.js 共用，避免两份实现给出不同数字。
const {
    SAMPLE_RATE: SR, spectrum, spec, frameLsd, lsd, stats,
    bandEnergy, frameHfEnergy, hzToBin,
} = require('./spectral');

// ---------------------------------------------------------------- WAV
function writeWav(file, samples) {
    const n = samples.length;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24);
    buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
        buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
    }
    fs.writeFileSync(file, buf);
}

function melRel(ref, test) {
    const frames = ref.length / MEL_DIM;
    let num = 0, den = 0, cnum = 0;
    for (let i = 0; i < ref.length; i++) { const e = test[i] - ref[i]; num += e * e; den += ref[i] * ref[i]; }
    for (let ch = 0; ch < MEL_DIM; ch++) {
        let n2 = 0, d2 = 0;
        for (let f = 0; f < frames; f++) {
            const idx = f * MEL_DIM + ch, e = test[idx] - ref[idx];
            n2 += e * e; d2 += ref[idx] * ref[idx];
        }
        cnum += Math.sqrt(n2 / (d2 + 1e-12));
    }
    return { global: Math.sqrt(num / den), perChannel: cnum / MEL_DIM };
}

// ---------------------------------------------------------------- 主流程
async function main() {
    const args = process.argv.slice(2);
    const getArg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
    const item = getArg('items', 'nat_000');
    const seed = parseInt(getArg('seed', '1234'), 10);
    const seed2 = seed + 999;

    fs.mkdirSync(OUT, { recursive: true });
    const cBin = path.join(ROOT, 'qdrift', 'calib', 'qdrift_c.bin');
    const correction = fs.existsSync(cBin) ? new Float32Array(fs.readFileSync(cBin).buffer) : null;
    console.log(`[Diag] item=${item} seed=${seed}/${seed2} steps=${N_STEPS} qdrift=${!!correction}`);

    const d = loadItem(item);
    const wavPath = path.join(OUT, `${item}__wavs.json`);

    const KEYS = ['AA_fp32_dit_fp32_voc', 'AA2_fp32_seed2', 'AB_fp32_dit_fp16_voc',
        'BA_fp16_dit_fp32_voc', 'BB_fp16_dit_fp16_voc', 'CC_fp16_qdrift_fp16_voc',
        'AD_fp32_linearsched_fp32_voc', 'BD_fp16_linearsched_fp16_voc',
        'BE_fp16dit_fp32voc_linearsched'];
    // 用户 settings.json 的导出配置：CFG 3.0 + linear 调度（start=cfg*0.5 → end=cfg）
    const linearCfg = (i) => 1.5 + 1.5 * i / (N_STEPS - 1);

    let wavs = null;
    if (fs.existsSync(wavPath)) {
        // 波形阶段很贵（8 次 vocoder），缓存下来方便反复调指标
        const raw = JSON.parse(fs.readFileSync(wavPath, 'utf-8'));
        if (KEYS.every(k => Array.isArray(raw[k]))) {
            wavs = {};
            for (const k of KEYS) wavs[k] = Float32Array.from(raw[k]);
            console.log('[Diag] 复用已缓存的波形（删掉该文件可重跑采样+声码器）');
        } else {
            console.log('[Diag] 缓存不完整（新增了 pass），重新生成全部波形');
        }
    }
    if (!wavs) {
        const diff32 = await makeDiffSession(path.join(ROOT, 'onnx_models', 'diff_step_dml.onnx'));
        const diff16 = await makeDiffSession(path.join(ROOT, 'onnx_models', 'fp16', 'diff_step_dml.onnx'));
        console.log('[Diag] 采样：FP32 / FP32(另种子) / FP16 / FP16+Q-Drift');
        const M_A = await runSampler(diff32, d.prompt, d.cond, d.prompt_len, d.target_len, seed, null);
        const M_A2 = await runSampler(diff32, d.prompt, d.cond, d.prompt_len, d.target_len, seed2, null);
        const M_B = await runSampler(diff16, d.prompt, d.cond, d.prompt_len, d.target_len, seed, null);
        const M_C = correction
            ? await runSampler(diff16, d.prompt, d.cond, d.prompt_len, d.target_len, seed, correction)
            : M_B;
        // 用户真实配置：CFG 3.0 + linear 调度
        const M_D32 = await runSampler(diff32, d.prompt, d.cond, d.prompt_len, d.target_len, seed, null, linearCfg);
        const M_D16 = await runSampler(diff16, d.prompt, d.cond, d.prompt_len, d.target_len, seed, null, linearCfg);

        console.log('[Diag] 声码器：fp32 / fp16');
        const voc32 = await makeVocoderSession(path.join(ROOT, 'onnx_models', 'vocoder_dml.onnx'));
        const voc16 = await makeVocoderSession(path.join(ROOT, 'onnx_models', 'fp16', 'vocoder_dml.onnx'));
        const T = d.target_len;
        wavs = {
            AA_fp32_dit_fp32_voc: await voc32(M_A, T),
            AA2_fp32_seed2: await voc32(M_A2, T),
            AB_fp32_dit_fp16_voc: await voc16(M_A, T),
            BA_fp16_dit_fp32_voc: await voc32(M_B, T),
            BB_fp16_dit_fp16_voc: await voc16(M_B, T),
            CC_fp16_qdrift_fp16_voc: await voc16(M_C, T),
            AD_fp32_linearsched_fp32_voc: await voc32(M_D32, T),
            BD_fp16_linearsched_fp16_voc: await voc16(M_D16, T),
            BE_fp16dit_fp32voc_linearsched: await voc32(M_D16, T),
        };
        const raw = {};
        for (const [k, v] of Object.entries(wavs)) raw[k] = Array.from(v);
        fs.writeFileSync(wavPath, JSON.stringify(raw));
        fs.writeFileSync(path.join(OUT, `${item}__mel.json`), JSON.stringify({
            M_A: Array.from(M_A), M_B: Array.from(M_B), M_C: Array.from(M_C),
        }));
    }

    for (const [k, v] of Object.entries(wavs)) writeWav(path.join(OUT, `${item}__${k}.wav`), v);
    console.log(`[Diag] wav -> ${OUT}`);
    console.log('[Diag] 计算频谱 ...');
    for (const [k, v] of Object.entries(wavs)) spec(v, k);

    const REF = 'AA_fp32_dit_fp32_voc';
    const refS = spec(wavs[REF], REF);
    const bands = [[0, 1000], [1000, 4000], [4000, 8000], [8000, 12000]];

    console.log('\n===== STFT 对数谱距离 vs 参考（dB，越小越好）=====');
    console.log('路径                            均值   p50   p95   max | 300ms段 p50   p95    max | 高频能量比');
    const summary = {};
    for (const [k, v] of Object.entries(wavs)) {
        if (k === REF) continue;
        const l = lsd(refS, spec(v, k));
        const hf = bandEnergy(spec(v, k), 6000, SR / 2) / (bandEnergy(spec(v, k), 0, SR / 2) + 1e-20);
        summary[k] = { ...l, hf_ratio: hf };
        console.log(`${k.padEnd(30)} ${l.mean.toFixed(2)}  ${l.p50.toFixed(2)}  ${l.p95.toFixed(2)}  ${l.max.toFixed(2)} |` +
            `     ${l.seg_p50.toFixed(2)}   ${l.seg_p95.toFixed(2)}  ${l.seg_max.toFixed(2)} | ${hf.toFixed(4)}`);
    }
    console.log(`参考（${REF}）高频>6k 能量比 = ${(bandEnergy(refS, 6000, SR / 2) / bandEnergy(refS, 0, SR / 2)).toFixed(4)}`);

    console.log('\n===== 分频段 LSD 均值（dB）=====');
    console.log('路径                             ' + bands.map(b => `${b[0]}-${b[1]}Hz`.padEnd(12)).join(''));
    for (const [k, v] of Object.entries(wavs)) {
        if (k === REF) continue;
        const cells = bands.map(([lo, hi]) => lsd(refS, spec(v, k), { bandLo: lo, bandHi: hi }).mean.toFixed(2).padEnd(12));
        console.log(`${k.padEnd(33)}${cells.join('')}`);
    }

    console.log('\n===== 按内容类型拆解（按参考信号的高频能量分位）=====');
    console.log('路径                            齿音/气声(前10%)   稳态(后50%)   比值');
    const hfE = frameHfEnergy(refS);
    const order = Array.from({ length: hfE.length }, (_, i) => i).sort((a, b) => hfE[b] - hfE[a]);
    const sibIdx = order.slice(0, Math.max(1, Math.floor(order.length * 0.10)));
    const susIdx = order.slice(Math.floor(order.length * 0.50));
    for (const [k, v] of Object.entries(wavs)) {
        if (k === REF) continue;
        const per = frameLsd(refS, spec(v, k));
        const sib = stats(sibIdx.map(i => per[i]));
        const sus = stats(susIdx.map(i => per[i]));
        console.log(`${k.padEnd(30)} ${sib.mean.toFixed(2).padStart(12)} dB   ${sus.mean.toFixed(2).padStart(8)} dB   ${(sib.mean / (sus.mean + 1e-9)).toFixed(2)}×`);
    }

    console.log('\n===== 归一化到「同模型换种子」的基线 =====');
    const base = summary.AA2_fp32_seed2.mean;
    console.log(`基线 AA2（FP32 换种子）= ${base.toFixed(2)} dB —— 单纯换个随机种子就会造成这么大的谱差异。`);
    for (const [k, v] of Object.entries(summary)) {
        if (k === 'AA2_fp32_seed2') continue;
        console.log(`  ${k.padEnd(30)} ${v.mean.toFixed(2)} dB = ${(v.mean / base).toFixed(2)}× 基线`);
    }

    console.log('\n===== 用户真实配置（CFG 3.0 + linear 调度）=====');
    const refD = spec(wavs.AD_fp32_linearsched_fp32_voc, 'AD_fp32_linearsched_fp32_voc');
    const pairs = [
        ['BD_fp16_linearsched_fp16_voc', 'FP16 档（Q-Drift 关）vs FP32 档'],
        ['CC_fp16_qdrift_fp16_voc', '开 Q-Drift 后 vs FP32 档'],
        ['BE_fp16dit_fp32voc_linearsched', '推荐：FP16 DiT + FP32 声码器'],
    ];
    for (const [k, label] of pairs) {
        const l = lsd(refD, spec(wavs[k], k));
        console.log(`  ${label.padEnd(28)} LSD 均值 ${l.mean.toFixed(2)} dB（8-12kHz ${lsd(refD, spec(wavs[k], k), { bandLo: 8000, bandHi: 12000 }).mean.toFixed(2)} dB）`);
    }
    {
        const l = lsd(spec(wavs.BD_fp16_linearsched_fp16_voc, 'BD_fp16_linearsched_fp16_voc'),
            spec(wavs.CC_fp16_qdrift_fp16_voc, 'CC_fp16_qdrift_fp16_voc'));
        console.log(`  ${'开 Q-Drift 前后（同一 FP16 档）'.padEnd(28)} LSD 均值 ${l.mean.toFixed(2)} dB  ← 含「CFG 调度被强制改成 constant」的副作用`);
    }

    const melRaw = path.join(OUT, `${item}__mel.json`);
    if (fs.existsSync(melRaw)) {
        const m = JSON.parse(fs.readFileSync(melRaw, 'utf-8'));
        const A = Float32Array.from(m.M_A), B = Float32Array.from(m.M_B), C = Float32Array.from(m.M_C);
        const mb = melRel(A, B), mc = melRel(A, C);
        console.log('\n===== mel 域 =====');
        console.log(`FP16 vs FP32 : 全局相对残差 ${mb.global.toExponential(3)}   逐通道归一化 ${(mb.perChannel * 100).toFixed(2)}%`);
        console.log(`Q-D  vs FP32 : 全局相对残差 ${mc.global.toExponential(3)}   逐通道归一化 ${(mc.perChannel * 100).toFixed(2)}%`);
        summary._mel = { B: mb, C: mc };
    }

    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ item, seed, summary }, null, 2));
}

main().catch(e => { console.error('[Diag] 失败:', e); process.exit(1); });
