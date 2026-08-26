#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate INT8 diff_step quantization using REAL calibration data (not random).

Root cause of low cos_sim in previous validate_percentile_int8.py: it fed
np.random.randn() inputs whose range far exceeds real diff_step activations
(xt_input real range ±0.7~2.7, but randn std=1.0 produces many out-of-range
values that get clipped by QuantizeLinear, inflating quantization error).

This script loads real diff_step inputs from the calibration npz and feeds
them to each model (adapting input names per model), producing a fair
apples-to-apples comparison.
"""
import argparse
import time
import os
import numpy as np
import onnxruntime as ort

os.environ.setdefault("ORT_LOGGING_LEVEL", "3")

CALIB_NPZ = "calibrate/data/fp16_calib/diff_step_dml.npz"

# Input name mapping: npz suffix -> (model_A names, model_B names)
# Model A (FP32 / percentile-qdq): xt_input, t, cond, xt_mask
# Model B (existing-prod INT8):    acoustic_features, diffusion_step, conditioning, attention_mask
INPUT_MAP = {
    "xt_input":   ["xt_input", "acoustic_features"],
    "t":          ["t", "diffusion_step"],
    "cond":       ["cond", "conditioning"],
    "xt_mask":    ["xt_mask", "attention_mask"],
}


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


def load_real_samples(npz_path, num_samples=8):
    """Load real diff_step inputs from calibration npz."""
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


def adapt_feeds(sample, feed_types):
    """Adapt real sample data to model's input names and dtypes."""
    feeds = {}
    for name, dt in feed_types.items():
        ln = name.lower()
        # Find which real input corresponds to this model input
        for npz_key, model_names in INPUT_MAP.items():
            if name in model_names:
                arr = sample.get(npz_key)
                if arr is not None:
                    feeds[name] = arr.astype(dt)
                break
    return feeds


def run_sess(path, feeds, providers):
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    opts.log_severity_level = 3
    sess = ort.InferenceSession(path, opts, providers=providers)
    # warmup
    sess.run(None, feeds)
    sess.run(None, feeds)
    # measure
    lat_ms = []
    for _ in range(10):
        t0 = time.perf_counter()
        sess.run(None, feeds)
        lat_ms.append((time.perf_counter() - t0) * 1000.0)
    return sess.run(None, feeds), float(np.mean(lat_ms)), float(np.percentile(lat_ms, 99))


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
    ])
    p.add_argument("--labels", nargs="*", default=["percentile-qdq", "existing-prod"])
    p.add_argument("--npz", default=CALIB_NPZ)
    p.add_argument("--samples", type=int, default=8)
    args = p.parse_args()

    if len(args.labels) != len(args.qmodels):
        raise SystemExit("--labels must match --qmodels count")

    PROV = ["DmlExecutionProvider"]
    samples = load_real_samples(args.npz, args.samples)
    print(f"Loaded {len(samples)} real samples from {args.npz}")
    for i, s in enumerate(samples):
        print(f"  sample{i}: xt_input={s['xt_input'].shape} t={s['t'].item():.3f} "
              f"cond={s['cond'].shape} xt_mask={s['xt_mask'].shape}")

    fp32_feed_types = load_input_names_and_dtypes(args.fp32)

    print("=" * 80)
    print("  INT8 diff_step validation with REAL data (DirectML)")
    print("=" * 80)
    print(f"  FP32 : {args.fp32}")
    for lb, qm in zip(args.labels, args.qmodels):
        print(f"  {lb:16s}: {qm}")
    print()

    # Pre-compute FP32 reference outputs
    fp32_refs = []
    for i, s in enumerate(samples):
        feeds = adapt_feeds(s, fp32_feed_types)
        try:
            out, avg, _ = run_sess(args.fp32, feeds, PROV)
            fp32_refs.append((out[0], avg))
        except Exception as e:
            print(f"[sample{i}] FP32 failed: {e}")
            fp32_refs.append(None)

    print("  samp | model           | cos_sim |   MSE   | SNR(dB) | DML(ms) | vsFP32")
    print("  -----+-----------------+---------+---------+---------+---------+--------")
    for i, s in enumerate(samples):
        if fp32_refs[i] is None:
            continue
        fp_out, fp_avg = fp32_refs[i]
        for lb, qm in zip(args.labels, args.qmodels):
            ft = load_input_names_and_dtypes(qm)
            feeds = adapt_feeds(s, ft)
            try:
                out, avg, _ = run_sess(qm, feeds, PROV)
            except Exception as e:
                print(f"  {i:5d} | {lb:16s}| FAILED: {str(e)[:60]}")
                continue
            mtr = metrics(fp_out, out)
            ratio = avg / fp_avg if fp_avg > 0 else float("nan")
            print(f"  {i:5d} | {lb:16s}| {mtr['cos']:.5f} | {mtr['mse']:6.2e} | "
                  f"{mtr['snr']:6.2f} | {avg:7.1f} | {ratio:5.2f}x")
        print()


if __name__ == "__main__":
    main()
