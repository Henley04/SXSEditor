# -*- coding: utf-8 -*-
"""Compare precision: opset 18 vs opset 20 for key models."""
import os
import numpy as np
import onnxruntime as ort

PROJECT_DIR = r'd:\Document\electron\SXSEditor'

sess_options = ort.SessionOptions()
sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
providers = ['DmlExecutionProvider', 'CPUExecutionProvider']

def compute_metrics(a, b):
    a = np.asarray(a).astype(np.float64)
    b = np.asarray(b).astype(np.float64)
    diff = a - b
    mse = float(np.mean(diff ** 2))
    var_a = float(np.var(a))
    snr = float(10 * np.log10(var_a / max(mse, 1e-16)))
    cos = float(np.dot(a.flatten(), b.flatten()) / (np.linalg.norm(a.flatten()) * np.linalg.norm(b.flatten()) + 1e-16))
    return snr, cos, mse

def run_infer(sess, inputs):
    input_names = [i.name for i in sess.get_inputs()]
    feed = {name: inputs[name] for name in input_names}
    return sess.run(None, feed)

SEQ_LEN = 100

print("=" * 70)
print("Opset 18 vs 20 Precision Comparison (DML EP)")
print("=" * 70)

np.random.seed(42)

# ---- diff_step W16A32 ----
print("\n--- diff_step W16A32 ---")
sess_old = ort.InferenceSession(os.path.join(PROJECT_DIR, 'onnx_models/fp16/diff_step_dml.onnx.bak'),
                                sess_options=sess_options, providers=providers)
sess_new = ort.InferenceSession(os.path.join(PROJECT_DIR, 'onnx_models/fp16/diff_step_dml.onnx'),
                                sess_options=sess_options, providers=providers)
inputs = {
    'xt_input': np.random.randn(1, SEQ_LEN, 128).astype(np.float16),
    't': np.array([0.5], dtype=np.float16),
    'cond': np.random.randn(1, SEQ_LEN, 1024).astype(np.float16),
    'xt_mask': np.ones((1, SEQ_LEN), dtype=np.float16),
}
out_old = run_infer(sess_old, inputs)[0]
out_new = run_infer(sess_new, inputs)[0]
snr, cos, mse = compute_metrics(out_old, out_new)
print(f"  flow_pred {out_old.shape}: SNR={snr:.2f} dB, cos={cos:.6f}, MSE={mse:.2e}")
del sess_old, sess_new

# ---- vocoder W16A32 ----
print("\n--- vocoder W16A32 ---")
sess_old = ort.InferenceSession(os.path.join(PROJECT_DIR, 'onnx_models/fp16/vocoder_dml.onnx.bak'),
                                sess_options=sess_options, providers=providers)
sess_new = ort.InferenceSession(os.path.join(PROJECT_DIR, 'onnx_models/fp16/vocoder_dml.onnx'),
                                sess_options=sess_options, providers=providers)
inputs = {'mel': np.random.randn(1, SEQ_LEN, 128).astype(np.float16)}
out_old = run_infer(sess_old, inputs)[0]
out_new = run_infer(sess_new, inputs)[0]
snr, cos, mse = compute_metrics(out_old, out_new)
print(f"  waveform {out_old.shape}: SNR={snr:.2f} dB, cos={cos:.6f}, MSE={mse:.2e}")
del sess_old, sess_new

# ---- diff_step FP32 ----
print("\n--- diff_step FP32 ---")
sess_old = ort.InferenceSession(os.path.join(PROJECT_DIR, 'onnx_models/diff_step_dml.onnx.bak'),
                                sess_options=sess_options, providers=providers)
sess_new = ort.InferenceSession(os.path.join(PROJECT_DIR, 'onnx_models/diff_step_dml.onnx'),
                                sess_options=sess_options, providers=providers)
inputs = {
    'xt_input': np.random.randn(1, SEQ_LEN, 128).astype(np.float32),
    't': np.array([0.5], dtype=np.float32),
    'cond': np.random.randn(1, SEQ_LEN, 1024).astype(np.float32),
    'xt_mask': np.ones((1, SEQ_LEN), dtype=np.float32),
}
out_old = run_infer(sess_old, inputs)[0]
out_new = run_infer(sess_new, inputs)[0]
snr, cos, mse = compute_metrics(out_old, out_new)
print(f"  flow_pred {out_old.shape}: SNR={snr:.2f} dB, cos={cos:.6f}, MSE={mse:.2e}")
del sess_old, sess_new

# ---- vocoder FP32 ----
print("\n--- vocoder FP32 ---")
sess_old = ort.InferenceSession(os.path.join(PROJECT_DIR, 'onnx_models/vocoder_dml.onnx.bak'),
                                sess_options=sess_options, providers=providers)
sess_new = ort.InferenceSession(os.path.join(PROJECT_DIR, 'onnx_models/vocoder_dml.onnx'),
                                sess_options=sess_options, providers=providers)
inputs = {'mel': np.random.randn(1, SEQ_LEN, 128).astype(np.float32)}
out_old = run_infer(sess_old, inputs)[0]
out_new = run_infer(sess_new, inputs)[0]
snr, cos, mse = compute_metrics(out_old, out_new)
print(f"  waveform {out_old.shape}: SNR={snr:.2f} dB, cos={cos:.6f}, MSE={mse:.2e}")
del sess_old, sess_new

print(f"\n{'='*70}")
print("Done.")