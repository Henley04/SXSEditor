/**
 * 把校准产物 qdrift/calib/qdrift_c.bin 转成应用可直接 require 的资产模块。
 *
 * 用法: node qdrift/scripts/gen_asset.js
 * 输出: src/inference/pipeline/qdrift/qdriftCorrection.js  （base64 + meta，勿手改）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const C_BIN = path.join(ROOT, 'qdrift', 'calib', 'qdrift_c.bin');
const META = path.join(ROOT, 'qdrift', 'calib', 'qdrift_meta.json');
const OUT = path.join(ROOT, 'src', 'inference', 'pipeline', 'qdrift', 'qdriftCorrection.js');

if (!fs.existsSync(C_BIN) || !fs.existsSync(META)) {
    console.error('缺少校准产物，请先运行 calibrate_dml.js');
    process.exit(1);
}

const buf = fs.readFileSync(C_BIN);
const meta = JSON.parse(fs.readFileSync(META, 'utf-8'));

const keep = {
    method: meta.method,
    solver: meta.solver,
    n_steps: meta.n_steps,
    mel_dim: meta.mel_dim,
    cfg: meta.cfg,
    rescale_cfg: meta.rescale_cfg,
    target: meta.target,
    quantized: meta.quantized,
    subgraph: meta.subgraph,
    execution_provider: meta.execution_provider,
    runtime: meta.runtime,
    n_calib_items: meta.n_calib_items,
    n_calib_trajectories: meta.n_calib_trajectories,
    seeds: meta.seeds,
    sequence_regime_sec: meta.sequence_regime_sec,
    c_formula: meta.c_formula,
    aggregation: meta.aggregation,
    generated_at: new Date().toISOString(),
};

const b64 = buf.toString('base64');
// 每行 100 字符折行，避免超长单行
const lines = b64.match(/.{1,100}/g) || [];
const body = `/**
 * Q-Drift 逐通道漂移修正因子 c —— 自动生成，请勿手动编辑。
 *
 * 由 qdrift/scripts/gen_asset.js 依据 qdrift/calib/qdrift_c.bin 生成。
 * 重新校准后请重跑该脚本。
 *
 * 形状: (${meta.n_steps}, ${meta.mel_dim}) = ${buf.length / 4} 个 float32，行主序（step, mel 通道）
 * 合约: ${meta.solver} @ ${meta.n_steps} 步, CFG=${meta.cfg}, rescale=${meta.rescale_cfg}
 * 目标: ${meta.quantized} 相对 ${meta.target}
 * 数据: ${meta.n_calib_items} 条自然乐谱 × ${(meta.seeds || []).length} seed = ${meta.n_calib_trajectories} 条配对轨迹
 *       （${Array.isArray(meta.sequence_regime_sec) ? meta.sequence_regime_sec.join('–') + ' s' : 'n/a'}）
 */
'use strict';

const META = ${JSON.stringify(keep, null, 2).split('\n').join('\n')};

const BASE64 =
${lines.map(l => "    '" + l + "'").join(' +\n')};

module.exports = { meta: META, base64: BASE64 };
`;

fs.writeFileSync(OUT, body);
console.log(`[gen_asset] c(${meta.n_steps}x${meta.mel_dim}) -> ${OUT}`);
console.log(`[gen_asset] base64 ${b64.length} 字符 / bin ${buf.length} 字节`);
console.log(`[gen_asset] c 逐步均值 (0,8,16,24,31):`,
    [0, 8, 16, 24, 31].map(i => {
        const arr = new Float32Array(buf.buffer, buf.byteOffset + i * meta.mel_dim * 4, meta.mel_dim);
        let s = 0; for (const v of arr) s += v;
        return (s / meta.mel_dim).toExponential(3);
    }).join('  '));
