#!/usr/bin/env python3
"""
Compare W8A8 quantized diffstep model against FP32 baseline using calibration data.
Reports MSE, max error, and relative error per sample.
"""

import numpy as np
import onnxruntime as ort
import os
import sys
import time
import gc

FP32_MODEL = "onnx_models/diff_step_dml.onnx"
INT8_MODEL = (
    sys.argv[1] if len(sys.argv) > 1 else "int8_output/onnx/diffstep_dml_w8a8.onnx"
)
CALIB_DATA = "calibrate/data/fp16_calib/diff_step_dml.npz"
NUM_SAMPLES = 8

INPUT_MAP = {
    "input_xt_input": "xt_input",
    "input_t": "t",
    "input_cond": "cond",
    "input_xt_mask": "xt_mask",
}


def load_samples(calib_path, num_samples):
    data = np.load(calib_path, allow_pickle=True)
    samples = []
    for i in range(num_samples):
        prefix = f"sample{i}_"
        inputs = {}
        expected = None
        for key in data.keys():
            if key.startswith(prefix):
                suffix = key[len(prefix) :]
                if suffix == "output":
                    expected = data[key]
                else:
                    model_name = INPUT_MAP.get(suffix, suffix)
                    inputs[model_name] = data[key].astype(np.float32)
        samples.append((inputs, expected))
    return samples


def run_model(model_path, samples, use_dml=True):
    providers = (
        ["DmlExecutionProvider", "CPUExecutionProvider"]
        if use_dml
        else ["CPUExecutionProvider"]
    )

    sess_opts = ort.SessionOptions()
    sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_opts.log_severity_level = 3

    print(f"Loading: {model_path}", flush=True)
    sess = ort.InferenceSession(model_path, sess_opts, providers=providers)

    results = []
    times = []
    for i, (inputs, _) in enumerate(samples):
        t0 = time.time()
        result = sess.run(None, inputs)
        t1 = time.time()
        times.append((t1 - t0) * 1000)
        results.append(result[0])
        print(f"  Sample {i}: {(t1 - t0) * 1000:.1f}ms", flush=True)

    del sess
    gc.collect()
    return results, times


def main():
    print("Loading calibration data...", flush=True)
    samples = load_samples(CALIB_DATA, NUM_SAMPLES)
    print(f"  {len(samples)} samples loaded", flush=True)
    print(
        f"  Sample 0 input shapes: {', '.join(f'{k}={v.shape}' for k, v in samples[0][0].items())}",
        flush=True,
    )
    print(f"  Sample 0 expected output: {samples[0][1].shape}", flush=True)

    print(f"\nRunning FP32 baseline...", flush=True)
    fp32_results, fp32_times = run_model(FP32_MODEL, samples, use_dml=True)
    print(f"  Avg: {np.mean(fp32_times):.1f}ms", flush=True)

    print(f"\nRunning INT8 quantized...", flush=True)
    int8_results, int8_times = run_model(INT8_MODEL, samples, use_dml=True)
    print(f"  Avg: {np.mean(int8_times):.1f}ms", flush=True)

    # Compare
    print(f"\n{'=' * 60}", flush=True)
    print("Accuracy Comparison (INT8 vs FP32)", flush=True)
    print(f"{'=' * 60}", flush=True)

    all_mse = []
    all_max_err = []
    all_rel_err = []

    for i in range(NUM_SAMPLES):
        fp32_out = fp32_results[i]
        int8_out = int8_results[i]
        expected = samples[i][1]

        # INT8 vs FP32
        diff = int8_out - fp32_out
        mse = np.mean(diff**2)
        max_err = np.max(np.abs(diff))
        # Relative error compared to FP32 output magnitude
        fp32_abs = np.mean(np.abs(fp32_out))
        rel_err = np.sqrt(mse) / (fp32_abs + 1e-8)

        # INT8 vs expected
        diff_exp = int8_out - expected
        mse_exp = np.mean(diff_exp**2)
        max_err_exp = np.max(np.abs(diff_exp))

        all_mse.append(mse)
        all_max_err.append(max_err)
        all_rel_err.append(rel_err)

        print(
            f"Sample {i}: MSE={mse:.6f}, MaxErr={max_err:.4f}, RelErr={rel_err:.4f} | vsExpected: MSE={mse_exp:.6f}",
            flush=True,
        )

    print(f"\n{'=' * 60}", flush=True)
    print(f"Overall (INT8 vs FP32):", flush=True)
    print(f"  Avg MSE:      {np.mean(all_mse):.6f}", flush=True)
    print(f"  Avg MaxErr:   {np.mean(all_max_err):.4f}", flush=True)
    print(
        f"  Avg RelErr:   {np.mean(all_rel_err):.4f} ({np.mean(all_rel_err) * 100:.2f}%)",
        flush=True,
    )
    print(f"  Max MaxErr:   {np.max(all_max_err):.4f}", flush=True)

    # NaN check
    any_nan = any(np.isnan(r).any() for r in int8_results)
    print(f"  Has NaN:      {any_nan}", flush=True)

    # Speed comparison
    print(f"\nSpeed Comparison:", flush=True)
    print(f"  FP32 avg: {np.mean(fp32_times):.1f}ms", flush=True)
    print(f"  INT8 avg: {np.mean(int8_times):.1f}ms", flush=True)
    print(f"  Speedup:  {np.mean(fp32_times) / np.mean(int8_times):.2f}x", flush=True)

    # Memory comparison
    fp32_size = os.path.getsize(FP32_MODEL) + os.path.getsize(FP32_MODEL + ".data")
    int8_size = os.path.getsize(INT8_MODEL)
    int8_data = INT8_MODEL + ".data"
    if os.path.exists(int8_data):
        int8_size += os.path.getsize(int8_data)
    print(f"\nMemory:", flush=True)
    print(f"  FP32: {fp32_size / 1024 / 1024:.1f} MB", flush=True)
    print(f"  INT8: {int8_size / 1024 / 1024:.1f} MB", flush=True)
    print(f"  Reduction: {fp32_size / int8_size:.2f}x", flush=True)


if __name__ == "__main__":
    main()
