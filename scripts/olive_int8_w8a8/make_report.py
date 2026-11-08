#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Render the INT8 validation results as a Markdown report.

Reads int8_w8a8_output/validation_gtsinger.json (built by collect_results.py,
which merges every val_*.json sweep plus the end-to-end audio comparisons) and
writes int8_w8a8_output/INT8_REPORT.md.

Usage:
  python scripts/olive_int8_w8a8/collect_results.py
  python scripts/olive_int8_w8a8/make_report.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "int8_w8a8_output"


def fmt(x, n=4, dash="—"):
    return dash if x is None else f"{x:.{n}f}"


def pick(runs, needle):
    for r in runs:
        if needle in r.get("model", ""):
            return r
    return None


def main():
    val_path = OUT / "validation_gtsinger.json"
    if not val_path.exists():
        raise SystemExit(f"missing {val_path} — run collect_results.py first")
    rep = json.loads(val_path.read_text(encoding="utf-8"))
    runs = rep.get("runs", [])
    e2e = rep.get("e2e", {})
    qrep = []
    qp = OUT / "quantize_report.json"
    if qp.exists():
        qrep = json.loads(qp.read_text(encoding="utf-8"))

    w8a8 = pick(runs, "uint8 activations")
    w8a8_s8 = pick(runs, "int8 activations")
    ds_wo = pick(runs, "diff_step W8A32")
    voc = pick(runs, "all backbone MatMul int8")
    voc_tail = pick(runs, "convnext 24-29")
    e2e_full = next((e for e in e2e.get("results", []) if e["model"].startswith("full INT8")), None)
    e2e_wo = next((e for e in e2e.get("results", []) if e["model"].startswith("full W8A32")), None)
    e2e_voc = next((e for e in e2e.get("results", []) if e["model"].startswith("vocoder")), None)
    e2e_diff = next((e for e in e2e.get("results", []) if e["model"].startswith("diff_step")), None)

    L = []
    A = L.append
    A("# SoulX-Singer INT8 导出与 GTSinger 精度验证\n")
    A("> Microsoft Olive 0.12.1 导出；校准与验证数据全部取自仓库真实 FP32 管线，"
      "输入为 GTSinger（SoulX-Singer-Eval-Dataset）音符序列。\n")

    # ---------------- 结论 ----------------
    A("## 1. 结论\n")
    A("**权重 + 激活全 int8 的 diff_step 不可用**：单步余弦 0.915、SNR 8.1 dB 看似尚可，"
      "但端到端合成与 FP32 完全去相关（cos ≈ 0，电平 −12 dB）。"
      "**只量化权重（W8A32）几乎无损**：单步余弦 0.99997，端到端 cos 0.963、SNR 11.3 dB、"
      "电平一致、log-mel L1 0.032。\n")
    A("| 部件 | 配置 | 单步/频谱精度 | 端到端 cos | 结论 |")
    A("|---|---|---|---|---|")
    if w8a8:
        A(f"| diff_step | W8A8（权重 int8 + 激活 uint8） | cos {fmt(w8a8['cos_mean'])} / "
          f"SNR {fmt(w8a8['snr_db_mean'], 2)} dB | {fmt(e2e_diff and e2e_diff['cosine_mean'])} | ❌ 不可用 |")
    if ds_wo:
        A(f"| diff_step | W8A32（权重 int8 + 激活 fp32） | cos {fmt(ds_wo['cos_mean'], 6)} / "
          f"SNR {fmt(ds_wo['snr_db_mean'], 2)} dB | "
          f"{fmt(e2e_wo and e2e_wo['cosine_mean'])} | ✅ 可用 |")
    if voc:
        A(f"| vocoder | W8A32（全部主干 MatMul int8） | cos {fmt(voc['cos_mean'])} / "
          f"SNR {fmt(voc['snr_db_mean'], 2)} dB | {fmt(e2e_voc and e2e_voc['cosine_mean'])} | ✅ 可用 |")
    if voc_tail:
        A(f"| vocoder | W8A32 + convnext 24–29 保 fp32 | cos {fmt(voc_tail['cos_mean'])} / "
          f"SNR {fmt(voc_tail['snr_db_mean'], 2)} dB | — | ✅ 更稳，体积 +150 MB |")
    A("")

    # ---------------- 数据 ----------------
    A("## 2. 校准 / 验证数据\n")
    A("- 来源：`eval_data/Soul-AILab/SoulX-Singer-Eval-Dataset/metadata.csv` 中 `dataset == GTSinger`，"
      "12 条（6 英文 / 6 中文），音高、时值、音素全部来自数据集标注。")
    A("- 采集：`capture_gtsinger.js` 跑真实 FP32 管线，在每个 item 的 CFG 轨迹上取 5 个时间步"
      "（t≈0.02/0.27/0.52/0.77/0.98），记录 diff_step 的四路输入与 FP32 输出，以及 vocoder 的 mel 输入与输出。"
      "总计 60 个 diff_step 样本 + 13 个 vocoder 样本（257 MB）。")
    A("- 划分：按 **item** 隔离，验证集固定为 item 3 / 7 / 11，校准集 45 个样本，验证集绝不参与统计量。")
    A("- ⚠️ 数据保真修复：GTSinger 的中文标注只有声母/韵母（`zh` + `uan`），没有声调，"
      "而词表键是带声调的 `zh_quan1..4`。直接喂 `zh_quan` 会走到 `<UNK>`（"
      "`textProcessing._lookupPhonemeId` 的声调回退正则需要 `[1-5]`），"
      "即**修复前中文音素 100% 是 `<UNK>`**。`align_tones.js` 用数据集 `txt` 字段的原文汉字"
      "经管线自身的「汉字→音素」恢复真实声调，覆盖率 265/267（仅 2 个「诶」类音节本身不在词表）。"
      "校准集与验证集都基于修复后的数据。\n")

    # ---------------- 模型事实 ----------------
    A("## 3. 产物\n")
    A("| 文件 | 体积 | 结构 | 说明 |")
    A("|---|---|---|---|")
    A("| `diffstep_u8/diff_step_dml.onnx` | 445.4 MB | 997 QDQ / 721 int8 权重 | diff_step，int8 权重 + uint8 激活（Olive 静态 QDQ） |")
    A("| `diffstep_wo/diff_step_dml.onnx` | 611.2 MB | 116 MatMulInteger / 116 int8 权重 | diff_step，int8 权重 + fp32 激活（DequantizeLinear 后置） |")
    A("| `vocoder_wo/vocoder_dml.onnx` | 280.9 MB | 92 MatMulInteger / 92 int8 权重 | vocoder，int8 权重 + fp32 激活，ISTFT 头保 fp32 |")
    A("| `vocoder_wo_tail24/vocoder_dml.onnx` | 431.7 MB | 92 MatMulInteger | 同上，另把 convnext block 24–29 保 fp32 |")
    A("")
    A("（`diffstep_u8` 的 QDQ 计数与体积取自 `onnx` 直接扫描，不依赖 EP。）\n")

    # ---------------- 逐步精度 ----------------
    A("## 4. diff_step 精度（held-out item）\n")
    A("| 配置 | EP | 样本 | cos 均值 | cos 最小 | SNR 均值 | SNR 最小 | rel_L2 均值 |")
    A("|---|---|---|---|---|---|---|---|")
    for r in runs:
        if "diff_step" not in r["model"]:
            continue
        A(f"| {r['model']} | {r.get('provider', '—')} | {r['samples']} | {fmt(r['cos_mean'], 6)} | "
          f"{fmt(r['cos_min'], 6)} | {fmt(r['snr_db_mean'], 2)} dB | {fmt(r['snr_db_min'], 2)} dB | "
          f"{fmt(r.get('rel_l2_mean'))} |")
    A("")
    A("按扩散时间步（cos 均值）：\n")
    ts = sorted({k for r in runs if r.get("by_t") for k in r["by_t"]})
    if ts:
        A("| 配置 | EP | " + " | ".join(f"t={t}" for t in ts) + " |")
        A("|---" * (len(ts) + 2) + "|")
        for r in runs:
            if not r.get("by_t"):
                continue
            A(f"| {r['model']} | {r.get('provider', '—')} | " +
              " | ".join(fmt(r['by_t'].get(t, {}).get("cos_mean"), 6) for t in ts) + " |")
    A("")

    # ---------------- vocoder ----------------
    A("## 5. vocoder 精度（held-out item）\n")
    A("CPU 与 DML 结果一致（W8A32 的 DML 与 CPU 余弦到小数点后 6 位相同），"
      "说明该导出不依赖执行提供器的数值路径。\n")
    A("| 配置 | EP | 样本 | cos 均值 | cos 最小 | SNR 均值 | log-mel L1 |")
    A("|---|---|---|---|---|---|---|")
    for r in runs:
        if "vocoder" not in r["model"]:
            continue
        A(f"| {r['model']} | {r.get('provider', '—')} | {r['samples']} | {fmt(r['cos_mean'], 6)} | "
          f"{fmt(r['cos_min'], 6)} | {fmt(r['snr_db_mean'], 2)} dB | {fmt(r.get('logmel_l1_mean'), 5)} |")
    A("")

    # ---------------- 端到端 ----------------
    A("## 6. 端到端合成（同一音符序列 + 固定噪声种子）\n")
    A(f"种子 1234，item {e2e.get('items')}，24 kHz。参考为 FP32 全量模型 `e2e/fp32`。\n")
    A("| 模型组合 | 波形 cos | SNR (dB) | log-mel L1 | 电平差 (dB) | 试听 |")
    A("|---|---|---|---|---|---|")
    for e in e2e.get("results", []):
        A(f"| {e['model']} | {fmt(e['cosine_mean'])} | {fmt(e['snr_db_mean'], 2)} | "
          f"{fmt(e['logmel_l1_mean'], 5)} | {fmt(e.get('rms_ratio_db_mean'), 2)} | "
          f"`{e['dir']}/` |")
    A("")
    A("说明：扩散采样对任何扰动都是放大的，**波形 cos 不能当作「音质好坏」的绝对判据**"
      "（换一个随机种子，FP32 与自己也基本不相关）。这里的关键区分是电平与 log-mel："
      "W8A32 组合的电平与 FP32 相差 < 0.3 dB、log-mel L1 0.032（与 vocoder 单体的 0.019 同量级）；"
      "而 W8A8 diff_step 组合电平掉 11.9–12.6 dB、log-mel L1 2.0 以上，听感上是噪声化的。"
      "可直接对比 `e2e/fp32/item7.wav` 与 `e2e/int8_wo/item7.wav`、`e2e/int8/item7.wav`。\n")

    # ---------------- 诊断 ----------------
    A("## 7. 为什么 W8A8 会崩：t≈0.98 的末步\n")
    A("末步样本有三个特征叠在一起：`cond` 全零（CFG 无条件支路）、输出幅值约为其它步的 2 倍、"
      "相对误差 rel_L2 ≈ 1.0。用 `diag_uncond.py` 做 2×2 对照可把变量拆开：\n")
    A("| case | cos(vs FP32) | rel_L2 |")
    A("|---|---|---|")
    A("| t=0.516，cond 保留 | 0.975 | 0.30 |")
    A("| t=0.516，cond 置零 | 0.975 | 0.31 |")
    A("| t=0.984，cond 置零（原始样本） | 0.689 | 0.97 |")
    A("| t=0.984，cond 换成中段真实值 | 0.700 | 0.94 |")
    A("")
    A("→ **与 cond 无关，是时间步 t 本身**：轨迹末段输出幅值翻倍，逐张量（per-tensor）激活量化"
      "在幅值放大后相对步长变粗，误差被整体放大。Llama 系模型的 massive activation 也会放大这一现象，"
      "这也是学术界要用 SmoothQuant / AWQ 而非朴素 per-tensor 量化 W8A8 的原因——Olive 0.12 未提供这类 pass。\n")
    A("已排除的缓解手段（都不解决问题）：\n")
    A("- 保留 mel 输出头两个 MatMul 为 fp32：cos 0.9147 → 0.9150（体积 +14 MB）")
    A("- `reduce_range=1`：数值与不开启完全一致（Olive 未透传该开关）")
    A("- 激活改 int8 对称：反而更差（cos 0.871）\n")

    # ---------------- 建议 ----------------
    A("## 8. 建议\n")
    A("1. **发布形态**：diff_step 与 vocoder 都走 W8A32（int8 权重 + fp32 激活）。"
      "diff_step 单步 cos 0.99997、端到端 cos 0.963 且电平一致，是本模型上性价比最高的 8-bit 方案。")
    A("2. vocoder 用 `vocoder_wo`（280.9 MB）。若对音色更敏感，用 `vocoder_wo_tail24`（431.7 MB，"
      "convnext 24–29 保 fp32，log-mel L1 0.008）。")
    A("3. 若一定要「权重 + 激活都 int8」，必须先引入离群值抑制（SmoothQuant 式逐通道缩放）"
      "或按 block 做敏感度分析后局部保 fp32，否则末步不可用；仅靠换校准方法/`reduce_range` 无效。")
    A("4. 当前 int8 目录的旧模型还带着 issue #36 的 cond=512 缺陷，换模型时注意 `cond_emb` 与 "
      "`diff_step` 的 cond 维必须同为 1024。\n")

    # ---------------- 复现 ----------------
    A("## 9. 复现命令\n")
    A("```bash")
    A("PY=/c/Users/15240/AppData/Local/Python/bin/python.exe")
    A("# 1) GTSinger 条目（含原文，用于恢复声调）+ 声调对齐")
    A("$PY scripts/olive_int8_w8a8/prepare_gtsinger.py --limit 12 --per-lang 6")
    A("node   scripts/olive_int8_w8a8/align_tones.js")
    A("# 2) 从真实 FP32 管线抓取校准/验证张量")
    A("node   scripts/olive_int8_w8a8/capture_gtsinger.js --limit 12 --per-item 5")
    A("# 3) 量化")
    A("$PY scripts/olive_int8_w8a8/quantize_olive.py --task diffstep --tag _u8 --activation-type uint8")
    A("$PY scripts/olive_int8_w8a8/weight_only_int8.py --input onnx_models/diff_step_dml.onnx \\")
    A("    --output int8_w8a8_output/diffstep_wo/diff_step_dml.onnx")
    A("$PY scripts/olive_int8_w8a8/quantize_olive.py --task vocoder")
    A("# 4) 单步精度")
    A("$PY scripts/olive_int8_w8a8/validate_gtsinger.py --only diffstep --diffstep-dir int8_w8a8_output/diffstep_u8 \\")
    A("    --out int8_w8a8_output/val_diffstep_u8.json")
    A("$PY scripts/olive_int8_w8a8/diag_uncond.py")
    A("# 5) 端到端")
    A("$PY scripts/olive_int8_w8a8/make_e2e_dir.py --reset --diffstep <diff_step> --vocoder <vocoder> \\")
    A("    --out int8_w8a8_output/e2e_models_wo")
    A("node   scripts/olive_int8_w8a8/e2e_dump.js --model-dir onnx_models \\")
    A("    --out int8_w8a8_output/e2e/fp32 --items 3,7,9,11 --seed 1234")
    A("node   scripts/olive_int8_w8a8/e2e_dump.js --model-dir int8_w8a8_output/e2e_models_wo \\")
    A("    --out int8_w8a8_output/e2e/int8_wo --items 3,7,9,11 --seed 1234")
    A("$PY scripts/olive_int8_w8a8/compare_e2e.py --ref int8_w8a8_output/e2e/fp32 \\")
    A("    --test int8_w8a8_output/e2e/int8_wo --out int8_w8a8_output/e2e/compare_int8_wo.json")
    A("# 6) 汇总 + 报告")
    A("$PY scripts/olive_int8_w8a8/collect_results.py && $PY scripts/olive_int8_w8a8/make_report.py")
    A("```")

    out = OUT / "INT8_REPORT.md"
    out.write_text("\n".join(L) + "\n", encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
