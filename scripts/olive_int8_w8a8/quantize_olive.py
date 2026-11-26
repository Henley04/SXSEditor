#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Olive INT8 export for SoulX-Singer.

Two products, both produced by Olive passes (hardware-agnostic CPU accel spec so
the resulting graphs stay portable to DML / CPU / NPU):

  diffstep_w8a8.onnx   diff_step, W8A8 -- int8 weights AND int8 activations,
                       static QDQ, calibrated on REAL GTSinger tensors captured
                       from the FP32 pipeline (see capture_gtsinger.js).
  vocoder_w8a32.onnx   vocoder, W8A32 -- int8 weights, fp32 activations
                       (Olive dynamic quantization on MatMul only; the last N
                       MatMul nodes stay FP32 because they are the most
                       quantization-sensitive ones -- see onnx_models/int8/README).

Calibration / validation split is by *item*, so validation never sees an item
that contributed calibration statistics.

Usage:
  python scripts/olive_int8_w8a8/quantize_olive.py --task all
  python scripts/olive_int8_w8a8/quantize_olive.py --task diffstep --calib-method Percentile
"""
import argparse
import json
import logging
import os
import shutil
import sys
import time
from pathlib import Path

os.environ.setdefault("ORT_LOGGING_LEVEL", "3")

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "calibrate" / "data" / "gt_int8" / "raw"
OUT_DIR = ROOT / "int8_w8a8_output"
FP32_DIR = ROOT / "onnx_models"

# held-out items for validation (3 of 12, mixed English/Chinese)
VAL_ITEMS = {3, 7, 11}

DIFF_INPUTS = ("xt_input", "t", "cond", "xt_mask")
VOC_INPUTS = ("mel",)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("olive_int8")


# --------------------------------------------------------------------------- #
# captured tensor access
# --------------------------------------------------------------------------- #
class TensorStore:
    def __init__(self, raw_dir: Path):
        self.raw_dir = Path(raw_dir)
        mf = self.raw_dir / "manifest.json"
        if not mf.exists():
            raise SystemExit(f"missing {mf} — run capture_gtsinger.js first")
        self.manifest = json.loads(mf.read_text(encoding="utf-8"))
        self.bin_path = ROOT / self.manifest["binPath"]
        self._fh = open(self.bin_path, "rb")

    def read(self, rec, name_key="inputs"):
        """Read one tensor record -> np.float32 array with its original shape."""
        self._fh.seek(rec["offset"])
        buf = self._fh.read(rec["bytes"])
        arr = np.frombuffer(buf, dtype=np.float32).copy()
        dims = rec.get("dims") or []
        if dims:
            arr = arr.reshape(dims)
        return arr

    def diff_samples(self, items=None, names=DIFF_INPUTS):
        out = []
        for rec in self.manifest["diffStep"]:
            if items is not None and rec["item"] not in items:
                continue
            feeds = {k: self.read(rec["inputs"][k]) for k in names if k in rec["inputs"]}
            if len(feeds) != len(names):
                continue
            out.append(feeds)
        return out

    def voc_samples(self, items=None, names=VOC_INPUTS):
        out = []
        for rec in self.manifest["vocoder"]:
            if items is not None and rec["item"] not in items:
                continue
            feeds = {k: self.read(rec["inputs"][k]) for k in names if k in rec["inputs"]}
            if len(feeds) != len(names):
                continue
            out.append(feeds)
        return out


# --------------------------------------------------------------------------- #
# Olive data components (registered globally; used via DataConfig below)
# --------------------------------------------------------------------------- #
from olive.data.registry import Registry                     # noqa: E402
from olive.data.constants import DataComponentType           # noqa: E402
from olive.data.config import DataConfig                     # noqa: E402

_STORE_CACHE = {}


def _store(raw_dir):
    raw_dir = str(raw_dir)
    if raw_dir not in _STORE_CACHE:
        _STORE_CACHE[raw_dir] = TensorStore(Path(raw_dir))
    return _STORE_CACHE[raw_dir]


@Registry.register(DataComponentType.LOAD_DATASET, "sxs_gt_calib")
def load_gt_calib(data_dir=None, exclude_items=None, max_samples=0, **kwargs):
    """Real GTSinger diff_step inputs as torch tensors (Olive's reader wants those)."""
    store = _store(data_dir)
    exclude = set(exclude_items or [])
    items = {i for i in range(64)} - exclude
    samples = store.diff_samples(items)
    if max_samples:
        # deterministic stride, keeps the trajectory coverage spread out
        step = max(1, len(samples) // max_samples)
        samples = samples[::step][:max_samples]
    log.info("[data] calibration samples: %d (excluded items %s)", len(samples), sorted(exclude))
    return [{k: torch.from_numpy(v) for k, v in s.items()} for s in samples]


@Registry.register(DataComponentType.DATALOADER, "sxs_serial")
def sxs_serial(dataset, **kwargs):
    return iter(dataset)


# --------------------------------------------------------------------------- #
# Olive helpers
# --------------------------------------------------------------------------- #
def olive_env():
    from olive.hardware.accelerator import AcceleratorSpec, Device
    from olive.hardware.constants import ExecutionProvider
    from olive.model import ONNXModelHandler
    # CPU accel spec = vendor-agnostic graph; DML / NPU consume the same file
    accel = AcceleratorSpec(accelerator_type=Device.CPU, execution_provider=ExecutionProvider.CPUExecutionProvider)
    return accel, ONNXModelHandler


def export_path(model, out_dir: Path):
    """Copy the Olive graph into `out_dir`, keeping its original file name.

    The basename must be preserved: the ONNX proto stores the external-data
    location as a bare file name ("diff_step_dml.onnx.data"), so renaming the
    graph without rewriting that string leaves ORT unable to find the weights.
    A load/save rewrite is not an option for the vocoder (it corrupts the ISTFT
    basis matrix), so the directory carries the "quantized" identity instead.
    """
    src = Path(model.model_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    dst = out_dir / src.name
    for p in (dst, dst.with_name(dst.name + ".data")):
        if p.exists():
            p.unlink()
    shutil.copy2(src, dst)
    src_data = src.with_name(src.name + ".data")
    if src_data.exists():
        shutil.copy2(src_data, dst.with_name(dst.name + ".data"))
    return dst


def size_mb(path: Path):
    total = path.stat().st_size if path.exists() else 0
    data = path.with_name(path.name + ".data")
    if data.exists():
        total += data.stat().st_size
    return total / 1e6


# --------------------------------------------------------------------------- #
# diff_step: W8A8 static QDQ
# --------------------------------------------------------------------------- #
def quantize_diffstep(args):
    from olive.passes.onnx.quantization import OnnxStaticQuantization

    accel, ONNXModelHandler = olive_env()
    src = FP32_DIR / "diff_step_dml.onnx"
    if not src.exists():
        raise SystemExit(f"missing FP32 diff_step: {src}")

    work = OUT_DIR / "_work" / f"diffstep{args.tag}"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    log.info("=" * 70)
    log.info("diff_step W8A8 (int8 weights + int8 activations, QDQ static)")
    log.info("source: %s (%.0f MB)", src, size_mb(src))

    data_config = DataConfig(
        name="sxs_gt_calib",
        load_dataset_config={
            "type": "sxs_gt_calib",
            "params": {"data_dir": str(RAW_DIR), "exclude_items": sorted(VAL_ITEMS)},
        },
        dataloader_config={"type": "sxs_serial"},
    )

    cfg = OnnxStaticQuantization.generate_config(accel, {
        "quant_format": "QDQ",
        "precision": "int8",              # weights
        "activation_type": args.activation_type,   # activations -> true W8A8
        "activation_symmetric": args.activation_type == "int8",
        "weight_symmetric": True,
        "per_channel": True,
        "reduce_range": bool(getattr(args, "reduce_range", 0)),
        "calibrate_method": args.calib_method,
        "op_types_to_quantize": ["MatMul", "Gemm"],
        "quant_preprocess": True,
        "prepare_qdq_config": True,
        "data_config": data_config,
        "save_as_external_data": True,
        "all_tensors_to_one_file": True,
        "size_threshold": 1024,
        **({"nodes_to_exclude": [n for n in args.exclude_nodes.split(",") if n]}
           if getattr(args, "exclude_nodes", "") else {}),
    })

    model = ONNXModelHandler(model_path=str(src))
    t0 = time.time()
    out_model = OnnxStaticQuantization(accel, cfg).run(model, str(work))
    dt = time.time() - t0

    final = export_path(out_model, OUT_DIR / f"diffstep{args.tag}")
    info = {
        "task": "diffstep_w8a8",
        "source": str(src),
        "output": str(final),
        "size_mb": round(size_mb(final), 1),
        "elapsed_sec": round(dt, 1),
        "config": {k: v for k, v in cfg.model_dump().items()
                   if k in ("quant_format", "precision", "activation_type", "activation_symmetric",
                            "weight_symmetric", "per_channel", "calibrate_method", "op_types_to_quantize")},
        "val_items": sorted(VAL_ITEMS),
    }
    log.info("diff_step W8A8 done: %.1f MB in %.0fs -> %s", info["size_mb"], dt, final)
    return info


# --------------------------------------------------------------------------- #
# vocoder: W8A32 (int8 weights, fp32 activations)
# --------------------------------------------------------------------------- #
def last_matmul_names(model_path: Path, count: int):
    import onnx
    m = onnx.load(str(model_path), load_external_data=False)
    names = [n.name for n in m.graph.node if n.op_type == "MatMul"]
    del m
    return names[-count:] if count > 0 else []


def quantize_vocoder(args):
    from olive.passes.onnx.quantization import OnnxDynamicQuantization

    accel, ONNXModelHandler = olive_env()
    src = FP32_DIR / "vocoder_dml.onnx"
    if not src.exists():
        raise SystemExit(f"missing FP32 vocoder: {src}")

    work = OUT_DIR / "_work" / f"vocoder{args.tag}"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    exclude = last_matmul_names(src, args.vocoder_exclude_last)
    log.info("=" * 70)
    log.info("vocoder W8A32 (int8 weights, fp32 activations; dynamic MatMul)")
    log.info("source: %s (%.0f MB); excluding last %d MatMul: %s",
             src, size_mb(src), len(exclude), exclude[:3])

    cfg = OnnxDynamicQuantization.generate_config(accel, {
        "precision": args.vocoder_precision,
        "op_types_to_quantize": ["MatMul"],
        "per_channel": bool(args.vocoder_per_channel),
        "reduce_range": False,
        "weight_symmetric": True,
        "nodes_to_exclude": exclude or None,
        "quant_preprocess": True,
        "save_as_external_data": True,
        "all_tensors_to_one_file": True,
        "size_threshold": 1024,
    })

    model = ONNXModelHandler(model_path=str(src))
    t0 = time.time()
    out_model = OnnxDynamicQuantization(accel, cfg).run(model, str(work))
    dt = time.time() - t0

    final = export_path(out_model, OUT_DIR / f"vocoder{args.tag}")
    info = {
        "task": "vocoder_w8a32",
        "source": str(src),
        "output": str(final),
        "size_mb": round(size_mb(final), 1),
        "elapsed_sec": round(dt, 1),
        "excluded_matmul": exclude,
        "config": {k: v for k, v in cfg.model_dump().items()
                   if k in ("precision", "op_types_to_quantize", "per_channel", "weight_symmetric")},
    }
    log.info("vocoder W8A32 done: %.1f MB in %.0fs -> %s", info["size_mb"], dt, final)
    return info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", choices=["diffstep", "vocoder", "all"], default="all")
    ap.add_argument("--calib-method", default="MinMax",
                    choices=["MinMax", "Entropy", "Percentile", "Distribution", "NonLinear"])
    ap.add_argument("--tag", default="", help="suffix for the output dir (sweeps)")
    ap.add_argument("--activation-type", default="int8", choices=["int8", "uint8"])
    ap.add_argument("--reduce-range", type=int, default=0,
                    help="restrict activations to 7 bits (uint8 0..127); tames outlier-driven range blowup")
    ap.add_argument("--exclude-nodes", default="",
                    help="comma separated node names kept in FP32 (diff_step only), "
                         "e.g. node_MatMul_1816,node_MatMul_1819 for the mel output head")
    ap.add_argument("--vocoder-precision", default="int8", choices=["int8", "uint8"])
    ap.add_argument("--vocoder-per-channel", type=int, default=1)
    ap.add_argument("--vocoder-exclude-last", type=int, default=17,
                    help="keep the last N MatMul nodes in FP32 (sensitive tail)")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    if args.task in ("diffstep", "all"):
        results.append(quantize_diffstep(args))
    if args.task in ("vocoder", "all"):
        results.append(quantize_vocoder(args))

    report = OUT_DIR / f"quantize_report_{int(time.time())}.json"
    report.write_text(json.dumps(results, indent=1, ensure_ascii=False), encoding="utf-8")
    latest = OUT_DIR / "quantize_report.json"
    latest.write_text(json.dumps(results, indent=1, ensure_ascii=False), encoding="utf-8")
    log.info("report -> %s", report)


if __name__ == "__main__":
    main()
