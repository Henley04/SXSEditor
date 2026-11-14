# -*- coding: utf-8 -*-
"""生成 diff_step 的混合精度 FP16 变体（FP16 GEMM + 关键算子保留 FP32）并实测精度/速度。

思路：整图 FP16 的误差主要来自逐元素链（LayerNorm 的 ReduceMean/Sqrt/Reciprocal、
attention Softmax、时间嵌入）。把这些算子留在 FP32（两侧插 Cast），GEMM 仍走 FP16，
用极小的额外带宽换取数值稳定性。

用法：
  python scripts/make_fp16_diffstep_mixed.py --block Softmax --out /tmp/v1.onnx
  python scripts/make_fp16_diffstep_mixed.py --block Softmax,ReduceMean,Sqrt,Reciprocal --bench
"""
import argparse
import json
import os
import shutil
import sys
import time

import numpy as np
import onnx
import onnxruntime as ort
from onnxconverter_common import float16

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
FP32_MODEL = os.path.join(PROJECT_DIR, "onnx_models", "diff_step_dml.onnx")
FP16_MODEL = os.path.join(PROJECT_DIR, "onnx_models", "fp16", "diff_step_dml.onnx")
CALIB = os.path.join(PROJECT_DIR, "calibrate", "data", "fp16_calib", "diff_step_dml.npz")
TMP_DIR = os.path.join(os.environ.get("TEMP", "/tmp"), "fp16_mixed")
REPORT = os.path.join(SCRIPT_DIR, "fp16_diffstep_mixed_report.json")


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def stage(path):
    os.makedirs(TMP_DIR, exist_ok=True)
    base = os.path.basename(path)
    dst = os.path.join(TMP_DIR, base)
    for src, name in ((path, base), (path + ".data", base + ".data")):
        if not os.path.exists(src):
            continue
        target = os.path.join(TMP_DIR, name)
        if os.path.exists(target) and os.path.getsize(target) == os.path.getsize(src):
            continue
        log(f"  复制 {name}")
        shutil.copy2(src, target)
    return dst


def load_feeds(seq, sample=0):
    d = np.load(CALIB)
    feeds = {k[len(f"sample{sample}_input_"):]: d[k]
             for k in d.files if k.startswith(f"sample{sample}_input_")}
    for k, v in list(feeds.items()):
        if v.ndim >= 2 and v.shape[1] > seq:
            feeds[k] = v[:, :seq, ...] if v.ndim == 3 else v[:, :seq]
    return {k: v.astype(np.float32) for k, v in feeds.items()}


def session(path, provider):
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(path, sess_options=so, providers=[provider, "CPUExecutionProvider"])


def feed_for(sess, feeds):
    types = {"tensor(float)": np.float32, "tensor(float16)": np.float16}
    out = {}
    for i in sess.get_inputs():
        out[i.name] = np.ascontiguousarray(feeds[i.name].astype(types.get(i.type, np.float32), copy=False))
    return out


def sqnr(ref, cand):
    ref = ref.astype(np.float64).reshape(-1)
    cand = cand.astype(np.float64).reshape(-1)
    return float(10 * np.log10((np.sum(ref ** 2) + 1e-20) / (np.sum((ref - cand) ** 2) + 1e-20)))


def bench(path, feeds, ref, runs=15, label=""):
    s = session(path, "DmlExecutionProvider")
    f = feed_for(s, feeds)
    for _ in range(3):
        out = s.run(None, f)[0]
    lat = []
    for _ in range(runs):
        t0 = time.perf_counter()
        out = s.run(None, f)[0]
        lat.append((time.perf_counter() - t0) * 1000)
    lat.sort()
    return {"label": label, "sqnr_db": sqnr(ref, out), "p50_ms": round(lat[len(lat) // 2], 2),
            "p90_ms": round(lat[int(len(lat) * 0.9)], 2), "min_ms": round(lat[0], 2)}


def convert(fp32_path, out_path, block_ops):
    log(f"载入 fp32 图 {os.path.basename(fp32_path)} ...")
    model = onnx.load(fp32_path)
    log(f"转换 FP16，block={block_ops}")
    t0 = time.time()
    m16 = float16.convert_float_to_float16(
        model, keep_io_types=False, op_block_list=list(block_ops), disable_shape_infer=False
    )
    log(f"转换完成 {time.time() - t0:.1f}s，节点 {len(m16.graph.node)}")
    if os.path.exists(out_path):
        os.remove(out_path)
    onnx.save_model(m16, out_path, save_as_external_data=True, all_tensors_to_one_file=True,
                    location=os.path.basename(out_path) + ".data", size_threshold=1024)
    log(f"写入 {out_path}")
    return out_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--block", default="Softmax")
    ap.add_argument("--out", default="")
    ap.add_argument("--seq", type=int, default=256)
    ap.add_argument("--runs", type=int, default=15)
    ap.add_argument("--bench", action="store_true")
    ap.add_argument("--tag", default="")
    args = ap.parse_args()

    block = [b.strip() for b in args.block.split(",") if b.strip()]
    out = args.out or os.path.join(TMP_DIR, f"diff_step_{'_'.join(block) or 'fp16'}.onnx")
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    fp32_path = stage(FP32_MODEL)
    convert(fp32_path, out, block)

    if not args.bench:
        return
    feeds = load_feeds(args.seq)
    log(f"基准：fp32 CPU 参考（seq={args.seq}）")
    s32 = session(fp32_path, "CPUExecutionProvider")
    ref = s32.run(None, feed_for(s32, feeds))[0]

    results = []
    results.append(bench(out, feeds, ref, args.runs, f"mixed[{','.join(block) or 'none'}]"))
    results.append(bench(FP16_MODEL, feeds, ref, args.runs, "fp16(all)"))
    results.append(bench(os.path.join(PROJECT_DIR, "onnx_models", "diff_step_dml.onnx"), feeds, ref,
                         max(5, args.runs // 3), "fp32(dml)"))
    for r in results:
        log(f"  {r['label']:34s} SQNR {r['sqnr_db']:6.2f} dB  p50 {r['p50_ms']:6.2f} ms  min {r['min_ms']:6.2f}")

    data = {}
    if os.path.exists(REPORT):
        try:
            data = json.load(open(REPORT, encoding="utf-8"))
        except Exception:
            data = {}
    key = args.tag or (",".join(block) or "all_fp16")
    data[key] = {"seq": args.seq, "results": results}
    with open(REPORT, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    log(f"写入 {REPORT}")


if __name__ == "__main__":
    main()
