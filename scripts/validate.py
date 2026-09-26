#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate INT8 ONNX models vs FP32 ONNX models.

Uses ONNX Runtime with DirectML provider to:
1. Run diff_step and vocoder on identical inputs
2. Compare outputs (cosine similarity, MSE, max error)
3. Measure inference latency and VRAM
"""

import argparse, json, time, os, sys
from pathlib import Path
import numpy as np


def run_session(model_path, feeds, provider="DmlExecutionProvider", warmup=3, runs=10):
    """Run ONNX model and return (output, avg_latency_ms, peak_vram_mb)."""
    import onnxruntime as ort

    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    try:
        sess = ort.InferenceSession(
            model_path, sess_options, providers=[provider, "CPUExecutionProvider"]
        )
    except Exception:
        sess = ort.InferenceSession(
            model_path, sess_options, providers=["CPUExecutionProvider"]
        )

    # Warmup
    for _ in range(warmup):
        try:
            sess.run(None, feeds)
        except Exception as e:
            print(f"    Warmup error: {e}")
            break

    # Timed runs
    latencies = []
    for _ in range(runs):
        t0 = time.perf_counter()
        outputs = sess.run(None, feeds)
        latencies.append((time.perf_counter() - t0) * 1000)

    avg_lat = np.mean(latencies)
    p99_lat = np.percentile(latencies, 99)

    del sess
    return outputs, avg_lat, p99_lat


def compare_tensors(fp32_out, int8_out, name="output"):
    """Compare two output tensors and return metrics."""
    a = np.asarray(fp32_out).flatten().astype(np.float64)
    b = np.asarray(int8_out).flatten().astype(np.float64)

    if a.shape != b.shape:
        return {"error": f"shape mismatch: {a.shape} vs {b.shape}"}

    mse = np.mean((a - b) ** 2)
    mae = np.mean(np.abs(a - b))
    max_err = np.max(np.abs(a - b))

    # Cosine similarity
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    cos_sim = float(np.dot(a, b) / (norm_a * norm_b + 1e-12))

    # SNR
    signal_power = np.mean(a**2)
    noise_power = mse + 1e-12
    snr_db = 10 * np.log10(signal_power / noise_power)

    return {
        "mse": float(mse),
        "mae": float(mae),
        "max_error": float(max_err),
        "cosine_similarity": cos_sim,
        "snr_db": float(snr_db),
    }


def validate_diffstep(fp32_path, int8_path, seq_len=256):
    """Validate diff_step ONNX models."""
    print(f"\n  [diff_step] FP32: {fp32_path}")
    print(f"  [diff_step] INT8: {int8_path}")

    # Prepare feeds
    np.random.seed(42)
    feeds = {
        "x": np.random.randn(1, seq_len, 128).astype(np.float32) * np.sqrt(8.14) - 4.92,
        "diffusion_step": np.array([0.5], dtype=np.float32),
        "cond": np.random.randn(1, seq_len, 1024).astype(np.float32) * 0.3,
        "x_mask": np.ones((1, seq_len), dtype=np.uint8),  # bool as uint8 for ORT
    }

    print("  Running FP32...")
    fp32_out, fp32_lat, fp32_p99 = run_session(fp32_path, feeds)
    print("  Running INT8...")
    int8_out, int8_lat, int8_p99 = run_session(int8_path, feeds)

    metrics = compare_tensors(fp32_out[0], int8_out[0], "flow_pred")
    metrics["fp32_latency_ms"] = float(fp32_lat)
    metrics["int8_latency_ms"] = float(int8_lat)
    metrics["fp32_p99_ms"] = float(fp32_p99)
    metrics["int8_p99_ms"] = float(int8_p99)
    metrics["speedup"] = float(fp32_lat / int8_lat) if int8_lat > 0 else 0

    # File sizes
    fp32_size = sum(
        os.path.getsize(Path(fp32_path).parent / f)
        for f in os.listdir(Path(fp32_path).parent)
        if f.startswith(Path(fp32_path).stem)
    )
    int8_size = sum(
        os.path.getsize(Path(int8_path).parent / f)
        for f in os.listdir(Path(int8_path).parent)
        if f.startswith(Path(int8_path).stem)
    )
    metrics["fp32_size_mb"] = fp32_size / (1024 * 1024)
    metrics["int8_size_mb"] = int8_size / (1024 * 1024)
    metrics["compression_ratio"] = fp32_size / max(int8_size, 1)

    return metrics


def validate_vocoder(fp32_path, int8_path, seq_len=256):
    """Validate vocoder ONNX models."""
    print(f"\n  [vocoder] FP32: {fp32_path}")
    print(f"  [vocoder] INT8: {int8_path}")

    np.random.seed(42)
    feeds = {
        "mel": np.random.randn(1, seq_len, 128).astype(np.float32) * np.sqrt(8.14)
        - 4.92,
    }

    print("  Running FP32...")
    fp32_out, fp32_lat, fp32_p99 = run_session(fp32_path, feeds)
    print("  Running INT8...")
    int8_out, int8_lat, int8_p99 = run_session(int8_path, feeds)

    metrics = compare_tensors(fp32_out[0], int8_out[0], "output")
    metrics["fp32_latency_ms"] = float(fp32_lat)
    metrics["int8_latency_ms"] = float(int8_lat)
    metrics["speedup"] = float(fp32_lat / int8_lat) if int8_lat > 0 else 0

    return metrics


def main():
    parser = argparse.ArgumentParser(description="Validate INT8 ONNX models")
    parser.add_argument(
        "--fp32-dir", required=True, help="Directory with FP32 ONNX models"
    )
    parser.add_argument(
        "--int8-dir", required=True, help="Directory with INT8 ONNX models"
    )
    parser.add_argument("--out", required=True, help="Output JSON report path")
    parser.add_argument(
        "--seq-len", type=int, default=256, help="Sequence length for validation"
    )
    args = parser.parse_args()

    fp32_dir = Path(args.fp32_dir)
    int8_dir = Path(args.int8_dir)

    report = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "seq_len": args.seq_len,
        "models": {},
    }

    # Validate diff_step
    fp32_ds = fp32_dir / "diffstep.onnx"
    if not fp32_ds.exists():
        fp32_ds = fp32_dir / "diff_step_dml.onnx"
    int8_ds = int8_dir / "diffstep.onnx"
    if not int8_ds.exists():
        int8_ds = int8_dir / "diff_step_dml.onnx"

    if fp32_ds.exists() and int8_ds.exists():
        report["models"]["diff_step"] = validate_diffstep(
            str(fp32_ds), str(int8_ds), args.seq_len
        )
    else:
        print(f"  [SKIP] diff_step: FP32={fp32_ds.exists()} INT8={int8_ds.exists()}")

    # Validate vocoder
    fp32_voc = fp32_dir / "vocoder.onnx"
    if not fp32_voc.exists():
        fp32_voc = fp32_dir / "vocoder_dml.onnx"
    int8_voc = int8_dir / "vocoder.onnx"
    if not int8_voc.exists():
        int8_voc = int8_dir / "vocoder_dml.onnx"

    if fp32_voc.exists() and int8_voc.exists():
        report["models"]["vocoder"] = validate_vocoder(
            str(fp32_voc), str(int8_voc), args.seq_len
        )
    else:
        print(f"  [SKIP] vocoder: FP32={fp32_voc.exists()} INT8={int8_voc.exists()}")

    # Summary
    print("\n" + "=" * 60)
    print("  Validation Summary")
    print("=" * 60)
    for model_name, m in report["models"].items():
        print(f"\n  {model_name}:")
        if "cosine_similarity" in m:
            print(f"    Cosine similarity: {m['cosine_similarity']:.6f}")
            print(f"    SNR:               {m['snr_db']:.2f} dB")
            print(f"    MSE:               {m['mse']:.2e}")
            print(f"    Max error:         {m['max_error']:.2e}")
        if "speedup" in m:
            print(f"    FP32 latency:      {m['fp32_latency_ms']:.2f} ms")
            print(f"    INT8 latency:      {m['int8_latency_ms']:.2f} ms")
            print(f"    Speedup:           {m['speedup']:.2f}x")
        if "compression_ratio" in m:
            print(f"    FP32 size:         {m['fp32_size_mb']:.1f} MB")
            print(f"    INT8 size:         {m['int8_size_mb']:.1f} MB")
            print(f"    Compression:      {m['compression_ratio']:.2f}x")
    print("=" * 60)

    # Save report
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\n  Report saved to {args.out}")


if __name__ == "__main__":
    main()
