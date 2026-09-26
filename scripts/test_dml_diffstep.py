#!/usr/bin/env python3
"""Test DML inference of quantized diffstep ONNX."""

import onnxruntime as ort
import numpy as np
import time
import sys
import os

# Suppress ORT warnings
os.environ["ORT_LOGGING_LEVEL"] = "3"


def test_model(model_path, seq_lens=None):
    if seq_lens is None:
        seq_lens = [256]

    sess_opts = ort.SessionOptions()
    sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_opts.log_severity_level = 3

    print(f"Loading: {model_path}", flush=True)

    sess = ort.InferenceSession(
        model_path,
        sess_opts,
        providers=["DmlExecutionProvider", "CPUExecutionProvider"],
    )

    providers = sess.get_providers()
    print(f"  Providers: {providers}", flush=True)

    inputs = sess.get_inputs()
    print(f"  Inputs:", flush=True)
    for inp in inputs:
        print(f"    {inp.name}: {inp.shape} ({inp.type})", flush=True)

    for seq_len in seq_lens:
        feeds = {}
        for inp in inputs:
            name = inp.name
            shape = inp.shape
            if name in ("t", "diffusion_step") or "step" in name.lower():
                feeds[name] = np.array([0.5], dtype=np.float32)
            elif "mask" in name:
                feeds[name] = np.ones((1, seq_len), dtype=np.float32)
            elif "cond" in name:
                feeds[name] = np.random.randn(1, seq_len, 1024).astype(np.float32)
            elif name in ("x", "xt_input"):
                feeds[name] = np.random.randn(1, seq_len, 128).astype(np.float32)
            else:
                # Default: small float32
                dim = shape[-1] if len(shape) > 0 else 1
                feeds[name] = np.random.randn(1, seq_len, dim).astype(np.float32)

        # Warmup
        result = sess.run(None, feeds)
        out_shape = result[0].shape
        has_nan = bool(np.isnan(result[0]).any())
        print(f"  seq_len={seq_len}: shape={out_shape}, NaN={has_nan}", flush=True)

        # Benchmark
        times = []
        for _ in range(10):
            t0 = time.time()
            sess.run(None, feeds)
            t1 = time.time()
            times.append((t1 - t0) * 1000)

        avg = np.mean(times)
        mn = np.min(times)
        mx = np.max(times)
        print(f"    Avg={avg:.1f}ms Min={mn:.1f}ms Max={mx:.1f}ms", flush=True)

    del sess
    print("[PASS]", flush=True)


if __name__ == "__main__":
    model_path = sys.argv[1] if len(sys.argv) > 1 else "onnx_models/int8/diffstep.onnx"
    seq_lens = [int(x) for x in sys.argv[2:]] if len(sys.argv) > 2 else [128, 256, 512]

    try:
        test_model(model_path, seq_lens)
    except Exception as e:
        import traceback

        print(f"[FAIL] {e}", flush=True)
        traceback.print_exc()
        sys.exit(1)
