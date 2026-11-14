# -*- coding: utf-8 -*-
"""真实 IEEE FP16 逐层权重敏感度扫描（不依赖 AIMET，内存友好）。

原理：把 Conv/MatMul/Gemm 的权重 initializer 同时登记为图输入（ONNX 允许
initializer 出现在 graph.input 中，ORT 会优先使用 feed 的值），这样只需要建
一次会话，就能逐层把某一层权重换成 fp16 舍入后的值再前向，测输出 SQNR。

用法：
  python scripts/fp16_per_layer_sensitivity.py --model diff_step --seq-limit 128
  python scripts/fp16_per_layer_sensitivity.py --model preflow --samples 2
"""
import argparse
import json
import os
import shutil
import sys
import time

import numpy as np
import onnx
from onnx import helper, TensorProto
import onnxruntime as ort

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
FP32_DIR = os.path.join(PROJECT_DIR, "onnx_models")
CALIB_DIR = os.path.join(PROJECT_DIR, "calibrate", "data", "fp16_calib")
TMP_DIR = os.path.join(os.environ.get("TEMP", "/tmp"), "aimet_fp16_models")
OUT_JSON = os.path.join(SCRIPT_DIR, "fp16_per_layer_report.json")

MODEL_FILES = {
    "note_text_encoder": "note_text_encoder.onnx",
    "note_pitch_encoder": "note_pitch_encoder.onnx",
    "note_type_encoder": "note_type_encoder.onnx",
    "f0_encoder": "f0_encoder.onnx",
    "cond_emb": "cond_emb.onnx",
    "preflow": "preflow.onnx",
    "mel_transform": "mel_transform.onnx",
    "vocoder": "vocoder_dml.onnx",
    "diff_step": "diff_step_dml.onnx",
}
CALIB_FILES = {
    "diff_step": "diff_step_dml.npz",
    "vocoder": "vocoder_dml.npz",
}
SEQ_LIMIT = {"diff_step": 128, "vocoder": 200, "preflow": 512, "cond_emb": 512}
WEIGHT_OPS = {"Conv", "MatMul", "Gemm", "ConvTranspose"}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def stage_model(model_path):
    """onnx 1.21 拒绝多硬链接的外部数据；复制到临时目录并返回路径。"""
    os.makedirs(TMP_DIR, exist_ok=True)
    base = os.path.basename(model_path)
    dst = os.path.join(TMP_DIR, base)
    for src, name in ((model_path, base), (model_path + ".data", base + ".data")):
        if not os.path.exists(src):
            continue
        target = os.path.join(TMP_DIR, name)
        if os.path.exists(target) and os.path.getsize(target) == os.path.getsize(src):
            continue
        log(f"  复制 {name}")
        shutil.copy2(src, target)
    return dst


def load_samples(name, samples):
    path = os.path.join(CALIB_DIR, CALIB_FILES.get(name, f"{name}.npz"))
    data = np.load(path)
    out = []
    lim = SEQ_LIMIT.get(name)
    for i in range(samples):
        prefix = f"sample{i}_input_"
        if not any(k.startswith(prefix) for k in data.files):
            break
        feeds = {k[len(prefix):]: data[k] for k in data.files if k.startswith(prefix)}
        if lim:
            for k, v in list(feeds.items()):
                if v.ndim >= 2 and v.shape[1] > lim:
                    feeds[k] = v[:, :lim, ...] if v.ndim == 3 else v[:, :lim]
        out.append(feeds)
    return out


def cast_feeds(session, feeds):
    types = {"tensor(float)": np.float32, "tensor(float16)": np.float16,
             "tensor(int64)": np.int64, "tensor(int32)": np.int32}
    out = {}
    for inp in session.get_inputs():
        arr = feeds.get(inp.name)
        if arr is None and len(feeds) == 1:
            arr = next(iter(feeds.values()))
        out[inp.name] = np.ascontiguousarray(arr.astype(types.get(inp.type, np.float32), copy=False))
    return out


def sqnr(ref, cand):
    ref = np.asarray(ref, dtype=np.float64).reshape(-1)
    cand = np.asarray(cand, dtype=np.float64).reshape(-1)
    n = min(ref.size, cand.size)
    err = ref[:n] - cand[:n]
    return float(10 * np.log10((np.sum(ref[:n] ** 2) + 1e-20) / (np.sum(err ** 2) + 1e-20)))


def expose_weights(model):
    """把 Conv/MatMul/Gemm 权重登记成图输入，返回 name -> ndarray。"""
    inits = {t.name: t for t in model.graph.initializer}
    existing_inputs = {i.name for i in model.graph.input}
    weights = {}
    for node in model.graph.node:
        if node.op_type not in WEIGHT_OPS or len(node.input) < 2:
            continue
        wname = node.input[1]
        if wname not in inits or wname in existing_inputs or wname in weights:
            continue
        tensor = inits[wname]
        arr = onnx.numpy_helper.to_array(tensor)
        weights[wname] = arr.astype(np.float32)
        model.graph.input.append(
            helper.make_tensor_value_info(wname, TensorProto.FLOAT, list(arr.shape))
        )
    return weights


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, choices=list(MODEL_FILES))
    ap.add_argument("--seq-limit", type=int, default=0)
    ap.add_argument("--samples", type=int, default=1)
    ap.add_argument("--provider", default="CPUExecutionProvider")
    args = ap.parse_args()

    if args.seq_limit:
        SEQ_LIMIT[args.model] = args.seq_limit
    name = args.model
    path = stage_model(os.path.join(FP32_DIR, MODEL_FILES[name]))
    log(f"{name}: 载入 {path}")
    model = onnx.load(path)
    weights = expose_weights(model)
    log(f"  可覆写权重 {len(weights)} 个，最大 {max(v.size for v in weights.values())/1e6:.2f}M 参数")

    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    t0 = time.time()
    sess = ort.InferenceSession(model.SerializeToString(), sess_options=so,
                                providers=[args.provider, "CPUExecutionProvider"])
    log(f"  会话建立 {time.time() - t0:.1f}s")

    samples = load_samples(name, args.samples)
    base_feeds = [cast_feeds(sess, s) for s in samples]
    t0 = time.time()
    refs = [sess.run(None, f)[0] for f in base_feeds]
    log(f"  FP32 参考完成 {time.time() - t0:.2f}s")

    # 全部权重 fp16（等价于 fp16 存储、fp32 计算）
    all16 = {k: v.astype(np.float16).astype(np.float32) for k, v in weights.items()}
    outs = [sess.run(None, {**f, **all16})[0] for f in base_feeds]
    full_sqnr = float(np.mean([sqnr(r, o) for r, o in zip(refs, outs)]))
    log(f"  全权重 FP16 基准 SQNR = {full_sqnr:.2f} dB（对照 fp16 模型 CPU 结果）")

    rows = []
    t0 = time.time()
    for idx, (wname, w) in enumerate(weights.items(), 1):
        override = {wname: w.astype(np.float16).astype(np.float32)}
        vals = [sqnr(r, sess.run(None, {**f, **override})[0]) for r, f in zip(refs, base_feeds)]
        rows.append({"weight": wname, "numel": int(w.size), "sqnr_db": float(np.mean(vals))})
        if idx % 25 == 0 or idx == len(weights):
            log(f"  进度 {idx}/{len(weights)}，{(time.time() - t0) / idx:.2f}s/层")

    rows.sort(key=lambda r: r["sqnr_db"])
    log(f"  最敏感 10 层（单层 fp16 后输出 SQNR 越低越敏感）")
    for r in rows[:10]:
        log(f"    {r['sqnr_db']:8.2f} dB  {r['weight']}")

    payload = {
        "model": name,
        "provider": args.provider,
        "seq_limit": SEQ_LIMIT.get(name),
        "samples": len(samples),
        "num_weights": len(weights),
        "full_fp16_sqnr_db": full_sqnr,
        "layers": rows,
        "seconds": round(time.time() - t0, 1),
    }
    data = {}
    if os.path.exists(OUT_JSON):
        try:
            data = json.load(open(OUT_JSON, encoding="utf-8"))
        except Exception:
            data = {}
    data[name] = payload
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    log(f"写入 {OUT_JSON}")


if __name__ == "__main__":
    main()
