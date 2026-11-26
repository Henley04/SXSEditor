#!/usr/bin/env python
"""Diagnose *why* the W8A8 diff_step collapses at the last diffusion step.

Two hypotheses are confounded in the validation data: the t≈0.98 samples are
both (a) at the end of the trajectory and (b) the CFG unconditional pass
(cond == 0). This script runs a 2x2:

    t = 0.516 / cond kept        (in-distribution reference)
    t = 0.516 / cond zeroed      (does the uncond regime break it?)
    t = 0.984 / cond zeroed      (the failing sample as-is)
    t = 0.984 / cond transplanted(high t with a real cond)

If the collapse follows `cond == 0`, calibration coverage of the unconditional
pass is the problem. If it follows `t`, the late-trajectory magnitudes are.

Usage:
  python scripts/olive_int8_w8a8/diag_uncond.py [--int8-dir int8_w8a8_output/diffstep_u8]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "calibrate" / "data" / "gt_int8" / "raw"
FP32 = ROOT / "onnx_models" / "diff_step_dml.onnx"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--int8-dir", default="int8_w8a8_output/diffstep_u8")
    ap.add_argument("--providers", default="cpu")
    args = ap.parse_args()

    qdir = Path(args.int8_dir)
    if not qdir.is_absolute():
        qdir = ROOT / qdir
    qpath = qdir / "diff_step_dml.onnx"

    mf = json.loads((RAW / "manifest.json").read_text())
    buf = (RAW / "tensors.bin").read_bytes()

    def get(rec):
        return np.frombuffer(buf, dtype="<f4", count=rec["bytes"] // 4,
                             offset=rec["offset"]).reshape(rec["dims"]).copy()

    by_t: dict[float, list] = {}
    for r in mf["diffStep"]:
        by_t.setdefault(round(r["t"], 3), []).append(r)

    mid = by_t[min(by_t, key=lambda t: abs(t - 0.516))][0]
    last = by_t[max(by_t)][0]

    prov = [p.strip() for p in args.providers.split(",") if p.strip()]
    so = ort.SessionOptions()
    so.log_severity_level = 3
    s_fp32 = ort.InferenceSession(str(FP32), so, providers=prov)
    s_int8 = ort.InferenceSession(str(qpath), so, providers=prov)
    inames = [i.name for i in s_fp32.get_inputs()]
    print(f"[diag] inputs={inames} int8={qpath.relative_to(ROOT)}")

    def run(sess, feeds):
        feeds = {k: v for k, v in feeds.items() if k in inames}
        return sess.run(None, feeds)[0]

    def cos(a, b):
        a = a.ravel().astype(np.float64)
        b = b.ravel().astype(np.float64)
        d = np.linalg.norm(a) * np.linalg.norm(b)
        return float(a @ b / d) if d else 0.0

    cond_mid = get(mid["inputs"]["cond"])
    cases = {
        "t=0.516 cond kept": (mid, cond_mid),
        "t=0.516 cond zeroed": (mid, np.zeros_like(cond_mid)),
        "t=0.984 cond zeroed (as captured)": (last, get(last["inputs"]["cond"])),
        "t=0.984 cond transplanted": (last, cond_mid),
    }

    print(f"{'case':40s} {'cos(vs FP32)':>13s} {'|ref|max':>9s} {'|int8|max':>10s} "
          f"{'rel_l2':>7s} {'cos(vs captured ref)':>21s}")
    for name, (rec, cond) in cases.items():
        feeds = {k: get(v) for k, v in rec["inputs"].items()}
        feeds["cond"] = cond
        a = run(s_fp32, feeds)
        b = run(s_int8, feeds)
        rel = float(np.linalg.norm(b - a) / max(np.linalg.norm(a), 1e-9))
        ref = get(rec["output"])
        print(f"{name:40s} {cos(a, b):13.4f} {np.abs(a).max():9.3f} {np.abs(b).max():10.3f} "
              f"{rel:7.3f} {cos(ref, b):21.4f}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
