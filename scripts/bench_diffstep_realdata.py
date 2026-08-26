#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unified accuracy + latency benchmark for diff_step candidates on REAL calib data.

Measures, for the FP32 baseline and each candidate model:
  - cos_sim / MSE / SNR against FP32 outputs (real eval samples, seq 2048)
  - mean/p50 latency over N repetitions (same provider) -> real speedup ratio

Usage:
  python scripts/bench_diffstep_realdata.py --provider dml \
      --models w8a32=int8_output/onnx/diffstep_w8a32.onnx fp16=int8_output/onnx/diffstep_fp16.onnx
"""
import argparse
import gc
import os
import time

import numpy as np
import onnxruntime as ort

os.environ.setdefault("ORT_LOGGING_LEVEL", "3")

CALIB_NPZ = "calibrate/data/fp16_calib/diff_step_dml.npz"

INPUT_MAP = {
    "xt_input": ["xt_input", "acoustic_features"],
    "t": ["t", "diffusion_step"],
    "cond": ["cond", "conditioning"],
    "xt_mask": ["xt_mask", "attention_mask"],
}


def load_real_samples(npz_path, num_samples):
    data = np.load(npz_path, allow_pickle=True)
    samples = []
    for i in range(num_samples):
        prefix = f"sample{i}_"
        sample = {}
        for suffix in ["input_xt_input", "input_t", "input_cond", "input_xt_mask"]:
            key = f"{prefix}{suffix}"
            if key in data:
                sample[suffix.replace("input_", "")] = data[key]
        if sample:
            samples.append(sample)
    return samples


def session_io(path):
    import onnx
    from onnx import TensorProto
    m = onnx.load(path, load_external_data=False)
    dt_map = {TensorProto.FLOAT: np.float32, TensorProto.FLOAT16: np.float32,
              TensorProto.BOOL: np.bool_, TensorProto.INT64: np.int64}
    ins = {i.name: dt_map.get(i.type.tensor_type.elem_type, np.float32) for i in m.graph.input}
    outs = [o.name for o in m.graph.output]
    del m
    return ins, outs


def adapt_feeds(sample, feed_types):
    feeds = {}
    for name, dt in feed_types.items():
        for npz_key, names in INPUT_MAP.items():
            if name in names and npz_key in sample:
                feeds[name] = sample[npz_key].astype(dt)
                break
    missing = set(feed_types) - set(feeds)
    if missing:
        raise RuntimeError(f"model inputs not mapped: {missing}")
    return feeds


def make_session(path, provider):
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    opts.log_severity_level = 3
    providers = (["DmlExecutionProvider", "CPUExecutionProvider"] if provider == "dml"
                 else ["CPUExecutionProvider"])
    return ort.InferenceSession(path, opts, providers=providers)


def snr_db(ref, x):
    r = np.asarray(ref, np.float32).ravel()
    s = np.asarray(x, np.float32).ravel()
    n = min(r.size, s.size)
    r, s = r[:n], s[:n]
    nz = float(np.mean((r - s) ** 2))
    sig = float(np.mean(r * r))
    return float("inf") if nz < 1e-12 else 10.0 * np.log10(sig / nz)


def metrics(ref, x):
    a = np.asarray(ref, np.float32).ravel()
    b = np.asarray(x, np.float32).ravel()
    n = min(a.size, b.size)
    a, b = a[:n], b[:n]
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    cos = float(np.dot(a, b) / (na * nb)) if na > 1e-12 and nb > 1e-12 else 0.0
    mse = float(np.mean((a - b) ** 2))
    return cos, mse, snr_db(a, b)


def run_once(sess, feeds, out_names):
    outs = sess.run(out_names, feeds)
    return outs


def bench_latency(sess, feeds, out_names, warmup, reps):
    for _ in range(warmup):
        sess.run(out_names, feeds)
    lat = []
    for _ in range(reps):
        t0 = time.perf_counter()
        sess.run(out_names, feeds)
        lat.append((time.perf_counter() - t0) * 1000.0)
    lat = np.array(lat)
    return float(lat.mean()), float(np.percentile(lat, 50)), float(np.percentile(lat, 99))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fp32", default="onnx_models/diff_step_dml.onnx")
    ap.add_argument("--models", nargs="*", default=[],
                    help="label=path candidates to compare against FP32")
    ap.add_argument("--provider", choices=["dml", "cpu"], default="dml")
    ap.add_argument("--npz", default=CALIB_NPZ)
    ap.add_argument("--samples", type=int, default=8)
    ap.add_argument("--warmup", type=int, default=3)
    ap.add_argument("--reps", type=int, default=10)
    ap.add_argument("--bench-sample", type=int, default=0)
    args = ap.parse_args()

    samples = load_real_samples(args.npz, args.samples)
    print(f"provider={args.provider.upper()} samples={len(samples)} "
          f"warmup={args.warmup} reps={args.reps}")

    def parse_pair(s):
        lbl, _, p = s.partition("=")
        return (lbl or os.path.basename(p)), p

    cands = [parse_pair(s) for s in args.models]

    results = {}

    # ---- FP32 baseline ----
    print(f"[fp32] {args.fp32}")
    fio_in, fio_out = session_io(args.fp32)
    sess = make_session(args.fp32, args.provider)
    refs = []
    acc_lat = None
    for i, s in enumerate(samples):
        feeds = adapt_feeds(s, fio_in)
        outs = run_once(sess, feeds, fio_out)
        refs.append(outs[0])
    bm = adapt_feeds(samples[args.bench_sample], fio_in)
    mean_ms, p50, p99 = bench_latency(sess, bm, fio_out, args.warmup, args.reps)
    results["fp32"] = dict(cos=1.0, snr=float("inf"), mean=mean_ms, p50=p50, p99=p99)
    print(f"[fp32] latency mean={mean_ms:.0f}ms p50={p50:.0f}ms p99={p99:.0f}ms")
    del sess
    gc.collect()

    # ---- candidates ----
    header = f"  {'model':14s}| {'cos':>8s} | {'SNR dB':>8s} | {'mean ms':>8s} | {'p50 ms':>8s} | speedup"
    print(header)
    print("  " + "-" * (len(header) - 4))
    base = results["fp32"]["mean"]
    for label, path in [("fp32", args.fp32)] + cands:
        if label == "fp32":
            r = results["fp32"]
            print(f"  {label:14s}| {'1.00000':>8s} | {'inf':>8s} | "
                  f"{r['mean']:8.0f} | {r['p50']:8.0f} |   1.00x")
            continue
        try:
            cio_in, cio_out = session_io(path)
            sess = make_session(path, args.provider)
        except Exception as e:
            print(f"  {label:14s}| LOAD FAILED: {str(e)[:90]}")
            continue
        cos_l, snr_l = [], []
        ok = True
        for i, s in enumerate(samples):
            feeds = adapt_feeds(s, cio_in)
            try:
                outs = run_once(sess, feeds, cio_out)
            except Exception as e:
                print(f"  {label:14s}| RUN FAILED at sample{i}: {str(e)[:80]}")
                ok = False
                break
            cos, mse, snr = metrics(refs[i], outs[0])
            cos_l.append(cos)
            snr_l.append(snr)
        if ok:
            mean_ms, p50, p99 = bench_latency(sess, adapt_feeds(samples[args.bench_sample], cio_in),
                                              cio_out, args.warmup, args.reps)
            sp = base / mean_ms if mean_ms > 0 else float("nan")
            cos_m = float(np.mean(cos_l))
            snr_m = float(np.mean([v for v in snr_l if np.isfinite(v)]) if snr_l else float("nan"))
            print(f"  {label:14s}| {cos_m:8.5f} | {snr_m:8.2f} | "
                  f"{mean_ms:8.0f} | {p50:8.0f} |  {sp:5.2f}x")
        del sess
        gc.collect()

    sz = lambda p: (os.path.getsize(p) + os.path.getsize(p + ".data")) / 1024 / 1024 \
        if os.path.exists(p + ".data") else os.path.getsize(p) / 1024 / 1024
    print("\n  sizes (MB):")
    for label, path in [("fp32", args.fp32)] + cands:
        try:
            print(f"    {label:14s} {sz(path):8.0f}")
        except OSError:
            pass


if __name__ == "__main__":
    main()
