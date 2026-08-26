# -*- coding: utf-8 -*-
"""Cross-check: DML outputs vs CPU ground truth for fp32 and fp16 models."""
import os
import numpy as np
import onnxruntime as ort

os.environ.setdefault("ORT_LOGGING_LEVEL", "3")

def load_sample(npz, i):
    d = np.load(npz, allow_pickle=True)
    p = f"sample{i}_"
    return {
        "xt_input": d[f"{p}input_xt_input"],
        "t": d[f"{p}input_t"],
        "cond": d[f"{p}input_cond"],
        "xt_mask": d[f"{p}input_xt_mask"],
    }

def sess(path, prov):
    so = ort.SessionOptions()
    so.log_severity_level = 3
    return ort.InferenceSession(path, so, providers=prov)

def metrics(a, b):
    a = np.asarray(a, np.float32).ravel(); b = np.asarray(b, np.float32).ravel()
    n = min(a.size, b.size); a, b = a[:n], b[:n]
    cos = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-30))
    nz = float(np.mean((a - b) ** 2)); sig = float(np.mean(a * a))
    snr = float("inf") if nz < 1e-12 else 10 * np.log10(sig / nz)
    return cos, snr, float(np.abs(b).max())

NPZ = "calibrate/data/fp16_calib/diff_step_dml.npz"
MODELS = {
    "fp32": "onnx_models/diff_step_dml.onnx",
    "fp16": "int8_output/onnx/diffstep_fp16.onnx",
}

s = load_sample(NPZ, 0)
feeds = {k: v.astype(np.float32) for k, v in s.items()}

for label, path in MODELS.items():
    out_names = [o.name for o in sess(path, ["CPUExecutionProvider"]).get_outputs()]
    ref = sess(path, ["CPUExecutionProvider"]).run(out_names, feeds)[0]
    dml = sess(path, ["DmlExecutionProvider", "CPUExecutionProvider"]).run(out_names, feeds)[0]
    cos, snr, amax = metrics(ref, dml)
    print(f"{label}: DML-vs-CPU cos={cos:.5f} snr={snr:.2f}dB | |out|max cpu={np.abs(ref).max():.4f} dml={amax:.4f}")
