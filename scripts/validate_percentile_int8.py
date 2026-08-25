#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate the Percentile-99.999 INT8 QDQ diff_step vs FP32 and vs the existing
onnx_models INT8 model, all on the DirectML EP.

Feeds each model with its own input names (xt_input/t/cond/xt_mask OR
acoustic_features/diffusion_step/conditioning/attention_mask) using identical random
content derived from a fixed seed, so outputs are directly comparable.
Reports cos-sim / MSE / SNR against the FP32 reference plus DML latency & speedup.
"""
import argparse
import time

import numpy as np
import onnxruntime as ort

os_env = __import__("os")
os_env.environ.setdefault("ORT_LOGGING_LEVEL", "3")


def load_input_names_and_dtypes(path):
    import onnx
    from onnx import TensorProto

    m = onnx.load(path, load_external_data=False)

    def np_dtype(t):
        te = t.type.tensor_type.elem_type
        if te == TensorProto.BOOL:
            return np.bool_
        if te in (TensorProto.FLOAT, TensorProto.FLOAT16):
            return np.float32
        return np.float32

    mapping = {i.name: np_dtype(i) for i in m.graph.input}
    del m
    return mapping


def make_feeds(feed_types, seq_len, seed):
    """feed_types: dict input_name -> numpy dtype. Content from a fixed seed."""
    rng = np.random.RandomState(seed)
    feeds = {}
    for name, dt in feed_types.items():
        ln = name.lower()
        if ln in ("t", "diffusion_step"):
            feeds[name] = np.array([0.5], dtype=dt)
        elif "mask" in ln:
            feeds[name] = np.ones((1, seq_len), dtype=dt)
        elif "cond" in ln:
            feeds[name] = rng.randn(1, seq_len, 1024).astype(dt)
        elif ln in ("x", "xt_input", "acoustic_features"):
            feeds[name] = rng.randn(1, seq_len, 128).astype(dt)
        else:
            feeds[name] = np.zeros((1, seq_len, 128), dtype=dt)
    return feeds


def run_sess(path, feeds, providers):
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    opts.log_severity_level = 3
    sess = ort.InferenceSession(path, opts, providers=providers)
    out = sess.run(None, feeds)
    for _ in range(3):
        sess.run(None, feeds)
    lat_ms = []
    for _ in range(15):
        t0 = time.perf_counter()
        sess.run(None, feeds)
        lat_ms.append((time.perf_counter() - t0) * 1000.0)
    return out, float(np.mean(lat_ms)), float(np.percentile(lat_ms, 99))


def snr_db(ref, x):
    r = np.asarray(ref, np.float32).ravel()
    s = np.asarray(x, np.float32).ravel()
    n = min(r.size, s.size)
    r, s = r[:n], s[:n]
    noise = r - s
    nz = float(np.mean(noise * noise))
    sig = float(np.mean(r * r))
    if nz < 1e-12:
        return float("inf")
    return 10.0 * np.log10(sig / nz)


def metrics(a, b):
    a = np.asarray(a, np.float32).ravel()
    b = np.asarray(b, np.float32).ravel()
    n = min(a.size, b.size)
    a, b = a[:n], b[:n]
    if n == 0:
        return dict(mse=float("nan"), cos=float("nan"), snr=float("-inf"))
    aa = float(np.linalg.norm(a))
    cos = float(np.dot(a, b) / (aa * (np.linalg.norm(b) or 1.0))) if aa > 1e-12 else 0.0
    return dict(mse=float(np.mean((a - b) ** 2)), cos=float(cos), snr=snr_db(a, b))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--fp32", default="onnx_models/diff_step_dml.onnx")
    p.add_argument("--qmodels", nargs="*", default=[
        "int8_output/onnx/diffstep_dml_w8a8.onnx",
        "onnx_models/int8/diff_step_dml.onnx",
    ], help="quantized models to evaluate")
    p.add_argument("--labels", nargs="*", default=["percentile-qdq", "existing-prod"])
    p.add_argument("--seq", default="256,512,1024,2048")
    args = p.parse_args()

    if len(args.labels) != len(args.qmodels):
        raise SystemExit("--labels must match --qmodels count")

    PROV = ["DmlExecutionProvider"]

    fp32_feed_types = load_input_names_and_dtypes(args.fp32)
    print("=" * 78)
    print("  Percentile-99.999 INT8 QDQ diff_step vs FP32 & existing INT8  (DirectML)")
    print("=" * 78)
    print(f"  FP32 : {args.fp32}")
    for lb, qm in zip(args.labels, args.qmodels):
        print(f"  {lb:16s}: {qm}")
    print()

    # Pre-compute FP32 reference outputs per seq
    fp32_ref = {}
    for seq in [int(x) for x in args.seq.split(",")]:
        feeds = make_feeds(fp32_feed_types, seq, seed=42)
        try:
            out, avg, _ = run_sess(args.fp32, feeds, PROV)
            fp32_ref[seq] = (out[0], avg)
        except Exception as e:
            print(f"[seq={seq}] FP32 failed: {e}")

    print("  seq | model           | cos_sim |   MSE   | SNR(dB) | DML(ms) | vsFP32")
    print("  ----+-----------------+---------+---------+---------+---------+--------")
    for seq, fp_out, fp_avg in [(s, *fp32_ref[s]) for s in fp32_ref]:
        for lb, qm in zip(args.labels, args.qmodels):
            feeds = make_feeds(load_input_names_and_dtypes(qm), seq, seed=42)
            try:
                out, avg, _ = run_sess(qm, feeds, PROV)
            except Exception as e:
                print(f"  {seq:4d} | {lb:16s}| FAILED: {e}")
                continue
            mtr = metrics(fp_out, out)
            ratio = avg / fp_avg if fp_avg > 0 else float("nan")
            print(
                f"  {seq:4d} | {lb:16s}| {mtr['cos']:.5f} | {mtr['mse']:6.2e} | "
                f"{mtr['snr']:6.2f} | {avg:7.1f} | {ratio:5.2f}x"
            )
        print()


if __name__ == "__main__":
    main()