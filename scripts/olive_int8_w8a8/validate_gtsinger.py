#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Accuracy validation of the Olive INT8/W8A32 exports on GTSinger inputs.

Compares quantized models against their FP32 counterparts on the *held-out*
GTSinger items captured by capture_gtsinger.js (item-level split, so no
calibration statistics leak into the validation set).

Metrics
  diff_step  cosine similarity / SNR(dB) / max abs error / relative L2, grouped
             by diffusion timestep so trajectory-dependent drift is visible.
  vocoder    waveform cosine / SNR(dB) / log-mel L1 distance on the first 5 s
             (mel_transform's fixed 240000-sample window).

Usage:
  python scripts/olive_int8_w8a8/validate_gtsinger.py
  python scripts/olive_int8_w8a8/validate_gtsinger.py --providers cpu,dml --bench
"""
import argparse
import json
import os
import time
from pathlib import Path

os.environ.setdefault("ORT_LOGGING_LEVEL", "3")

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "calibrate" / "data" / "gt_int8" / "raw"
OUT_DIR = ROOT / "int8_w8a8_output"
FP32_DIR = ROOT / "onnx_models"
VAL_ITEMS = {3, 7, 11}
DIFF_DIR = None   # set from CLI
VOC_DIR = None
SAMPLE_RATE = 24000
HOP = 480


# --------------------------------------------------------------------------- #
def load_manifest():
    mf = RAW_DIR / "manifest.json"
    m = json.loads(mf.read_text(encoding="utf-8"))
    return m, ROOT / m["binPath"]


class Reader:
    def __init__(self, manifest, bin_path):
        self.m = manifest
        self.fh = open(bin_path, "rb")

    def read(self, rec):
        self.fh.seek(rec["offset"])
        arr = np.frombuffer(self.fh.read(rec["bytes"]), dtype=np.float32).copy()
        dims = rec.get("dims") or []
        return arr.reshape(dims) if dims else arr

    def diff(self, items):
        for rec in self.m["diffStep"]:
            if rec["item"] not in items:
                continue
            yield {
                "item": rec["item"],
                "t": float(rec["t"]),
                "seq": int(rec["seq"]),
                "feeds": {k: self.read(v) for k, v in rec["inputs"].items()},
                "ref": self.read(rec["output"]),
            }

    def voc(self, items):
        for rec in self.m["vocoder"]:
            if rec["item"] not in items:
                continue
            yield {
                "item": rec["item"],
                "feeds": {k: self.read(v) for k, v in rec["inputs"].items()},
                "ref": self.read(rec["output"]),
            }


def session(path, provider):
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.log_severity_level = 3
    kwargs = {}
    if provider == "dml":
        kwargs["provider_options"] = [{"device_id": 0}]
        return ort.InferenceSession(str(path), so, providers=["DmlExecutionProvider"], **kwargs)
    return ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])


def metrics(ref, got):
    ref = np.asarray(ref, dtype=np.float64).reshape(-1)
    got = np.asarray(got, dtype=np.float64).reshape(-1)
    n = min(ref.size, got.size)
    ref, got = ref[:n], got[:n]
    denom = (np.linalg.norm(ref) * np.linalg.norm(got)) + 1e-12
    cos = float(ref @ got / denom)
    noise = float(np.sum((ref - got) ** 2))
    snr = float(10 * np.log10(np.sum(ref ** 2) / (noise + 1e-12) + 1e-12))
    return {
        "cos": cos,
        "snr_db": snr,
        "max_abs": float(np.max(np.abs(ref - got))) if n else 0.0,
        "mse": float(np.mean((ref - got) ** 2)) if n else 0.0,
        "rel_l2": float(np.linalg.norm(ref - got) / (np.linalg.norm(ref) + 1e-12)),
        "nonzero": bool(np.any(got)),
        "nonfinite": int(np.sum(~np.isfinite(got))),
    }


def logmel_distance(a, b, sr=SAMPLE_RATE):
    """L1 distance between log-mels of the first 5 s (both 24 kHz)."""
    try:
        import librosa
    except Exception:
        return None
    n = min(len(a), len(b), 5 * sr)
    if n < sr:
        return None
    ma = librosa.feature.melspectrogram(y=a[:n].astype(np.float32), sr=sr, n_mels=80, hop_length=HOP)
    mb = librosa.feature.melspectrogram(y=b[:n].astype(np.float32), sr=sr, n_mels=80, hop_length=HOP)
    la, lb = np.log10(np.maximum(ma, 1e-8)), np.log10(np.maximum(mb, 1e-8))
    return float(np.mean(np.abs(la - lb)))


# --------------------------------------------------------------------------- #
def validate_diffstep(reader, provider, bench=False):
    fp32 = FP32_DIR / "diff_step_dml.onnx"
    int8 = (DIFF_DIR or (OUT_DIR / "diffstep")) / "diff_step_dml.onnx"
    for p in (fp32, int8):
        if not p.exists():
            raise RuntimeError(f"missing {p}")

    s_fp = session(fp32, provider)
    s_q = session(int8, provider)
    rows = []
    for smp in reader.diff(VAL_ITEMS):
        feeds = smp["feeds"]
        t0 = time.time()
        ref = s_fp.run(None, feeds)[0]
        t_fp = time.time() - t0
        t1 = time.time()
        got = s_q.run(None, feeds)[0]
        t_q = time.time() - t1
        m = metrics(ref, got)
        m.update({"item": smp["item"], "t": smp["t"], "seq": smp["seq"],
                  "lat_fp32": round(t_fp, 3), "lat_int8": round(t_q, 3)})
        rows.append(m)

    by_t = {}
    for r in rows:
        by_t.setdefault(round(r["t"], 3), []).append(r["cos"])

    summary = {
        "model": "diff_step W8A8 (Olive QDQ static, int8 weights + int8 activations)",
        "provider": provider,
        "samples": len(rows),
        "cos_mean": float(np.mean([r["cos"] for r in rows])),
        "cos_min": float(np.min([r["cos"] for r in rows])),
        "snr_db_mean": float(np.mean([r["snr_db"] for r in rows])),
        "snr_db_min": float(np.min([r["snr_db"] for r in rows])),
        "max_abs_max": float(np.max([r["max_abs"] for r in rows])),
        "rel_l2_mean": float(np.mean([r["rel_l2"] for r in rows])),
        "by_t": {str(k): {"cos_mean": float(np.mean(v)), "n": len(v)} for k, v in sorted(by_t.items())},
        "lat_fp32_s": float(np.mean([r["lat_fp32"] for r in rows])),
        "lat_int8_s": float(np.mean([r["lat_int8"] for r in rows])),
        "rows": rows,
    }
    summary["speedup"] = round(summary["lat_fp32_s"] / max(1e-9, summary["lat_int8_s"]), 2)
    return summary


def validate_vocoder(reader, provider, bench=False):
    fp32 = FP32_DIR / "vocoder_dml.onnx"
    int8 = (VOC_DIR or (OUT_DIR / "vocoder")) / "vocoder_dml.onnx"
    for p in (fp32, int8):
        if not p.exists():
            raise RuntimeError(f"missing {p}")

    s_fp = session(fp32, provider)
    s_q = session(int8, provider)
    rows = []
    for smp in reader.voc(VAL_ITEMS):
        feeds = smp["feeds"]
        t0 = time.time()
        ref = s_fp.run(None, feeds)[0]
        t_fp = time.time() - t0
        t1 = time.time()
        got = s_q.run(None, feeds)[0]
        t_q = time.time() - t1
        m = metrics(ref, got)
        m.update({
            "item": smp["item"],
            "frames": int(feeds["mel"].shape[1]),
            "logmel_l1": logmel_distance(ref.reshape(-1), got.reshape(-1)),
            "lat_fp32": round(t_fp, 3),
            "lat_int8": round(t_q, 3),
        })
        rows.append(m)

    summary = {
        "model": "vocoder W8A32 (Olive dynamic MatMul quant, int8 weights + fp32 activations)",
        "provider": provider,
        "samples": len(rows),
        "cos_mean": float(np.mean([r["cos"] for r in rows])),
        "cos_min": float(np.min([r["cos"] for r in rows])),
        "snr_db_mean": float(np.mean([r["snr_db"] for r in rows])),
        "snr_db_min": float(np.min([r["snr_db"] for r in rows])),
        "logmel_l1_mean": float(np.mean([r["logmel_l1"] for r in rows if r["logmel_l1"] is not None])),
        "max_abs_max": float(np.max([r["max_abs"] for r in rows])),
        "lat_fp32_s": float(np.mean([r["lat_fp32"] for r in rows])),
        "lat_int8_s": float(np.mean([r["lat_int8"] for r in rows])),
        "rows": rows,
    }
    summary["speedup"] = round(summary["lat_fp32_s"] / max(1e-9, summary["lat_int8_s"]), 2)
    return summary


def model_facts():
    import onnx
    facts = {}
    targets = [
        ("diffstep/diff_step_dml.onnx", "diff_step W8A8"),
        ("vocoder/vocoder_dml.onnx", "vocoder W8A32"),
    ]
    for name, label in targets:
        p = OUT_DIR / name
        if not p.exists():
            continue
        m = onnx.load(str(p), load_external_data=False)
        qdq = sum(1 for n in m.graph.node if n.op_type in ("QuantizeLinear", "DequantizeLinear"))
        matmul_integer = sum(1 for n in m.graph.node if n.op_type in ("MatMulInteger", "DynamicQuantizeLinear"))
        int8_init = sum(1 for t in m.graph.initializer if t.data_type == 3)
        fp_init = sum(1 for t in m.graph.initializer if t.data_type == 1)
        facts[label] = {
            "size_mb": round((p.stat().st_size + (p.with_name(p.name + ".data").stat().st_size
                                                  if p.with_name(p.name + ".data").exists() else 0)) / 1e6, 1),
            "qdq_nodes": qdq,
            "matmul_integer_nodes": matmul_integer,
            "int8_initializers": int8_init,
            "fp32_initializers": fp_init,
            "ir_version": m.ir_version,
        }
        del m
    return facts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--providers", default="cpu", help="comma separated: cpu,dml")
    ap.add_argument("--bench", action="store_true")
    ap.add_argument("--diffstep-dir", default=None)
    ap.add_argument("--vocoder-dir", default=None)
    ap.add_argument("--out", default=None, help="report json path")
    ap.add_argument("--only", choices=["diffstep", "vocoder", "both"], default="both")
    args = ap.parse_args()

    global DIFF_DIR, VOC_DIR
    DIFF_DIR = Path(args.diffstep_dir) if args.diffstep_dir else None
    VOC_DIR = Path(args.vocoder_dir) if args.vocoder_dir else None

    manifest, bin_path = load_manifest()
    reader = Reader(manifest, bin_path)
    providers = [p.strip() for p in args.providers.split(",") if p.strip()]
    available = ort.get_available_providers()

    report = {"facts": model_facts(), "val_items": sorted(VAL_ITEMS), "runs": []}
    for prov in providers:
        if prov == "dml" and "DmlExecutionProvider" not in available:
            print(f"[skip] {prov}: not available")
            continue
        print(f"==== provider: {prov} ====")
        tasks = [("diffstep", validate_diffstep), ("vocoder", validate_vocoder)]
        if args.only != "both":
            tasks = [t for t in tasks if t[0] == args.only]
        for name, fn in tasks:
            try:
                res = fn(reader, prov, bench=args.bench)
                report["runs"].append(res)
                print(f"  {name:9s} n={res['samples']:3d} cos={res['cos_mean']:.6f} "
                      f"(min {res['cos_min']:.6f})  SNR={res['snr_db_mean']:6.2f} dB "
                      f"(min {res['snr_db_min']:6.2f})  speedup={res['speedup']}x")
                if name == "diffstep":
                    print("    by t:", {k: round(v["cos_mean"], 6) for k, v in res["by_t"].items()})
                else:
                    print(f"    log-mel L1 = {res['logmel_l1_mean']:.4f}")
            except Exception as e:
                print(f"  {name}: FAILED {e}")
                report["runs"].append({"model": name, "provider": prov, "error": str(e)})

    out = Path(args.out) if args.out else (OUT_DIR / "validation_gtsinger.json")
    out.write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\nreport -> {out}")


if __name__ == "__main__":
    main()
