#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Weight-only INT8 export (W8A32): int8 weights, fp32 activations.

Why weight-only for the vocoder: measured on the GTSinger held-out mel set, ORT
dynamic (MatMulInteger) quantization drops waveform cosine to 0.72 (SNR ~2.7 dB);
even quantizing only 8 of 63 MatMul keeps it at 0.90. The vocoder's ISTFT head is
phase sensitive, so changing the arithmetic anywhere in the backbone is audible.

W8A32 keeps the arithmetic in fp32 and only rounds the weights: every MatMul
weight is quantized per output channel to int8 and immediately dequantized by a
DequantizeLinear node, so the graph still runs fp32 MatMul while the weights
occupy 1/4 of the file. Same contract as the existing W16A32 vocoder (narrow
weights, fp32 activations), just at 8 bits.

Usage:
  python scripts/olive_int8_w8a8/weight_only_int8.py \
      --input  onnx_models/vocoder_dml.onnx \
      --output int8_w8a8_output/vocoder_wo/vocoder_dml.onnx
"""
import argparse
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper, helper


# exact node names of the ISTFT head: its basis matrix is phase critical
# (see onnx_models/int8/README.md: an fp32->fp32 round trip alone drops SNR 33 -> -43 dB)
DEFAULT_SKIP = ("/head_out/MatMul", "/MatMul", "/MatMul_1")


def quantize_weight_only(src, dst, skip_suffixes=DEFAULT_SKIP, axis=1, min_dim=16, skip_blocks=()):
    dst.parent.mkdir(parents=True, exist_ok=True)
    model = onnx.load(str(src), load_external_data=True)
    inits = {t.name: t for t in model.graph.initializer}

    extra_inits, replaced = [], []
    new_nodes = []

    for node in model.graph.node:
        if node.op_type != "MatMul" or len(node.input) < 2:
            new_nodes.append(node)
            continue
        wname = node.input[1]
        init = inits.get(wname)
        if init is None or (skip_suffixes and node.name in skip_suffixes):
            new_nodes.append(node)
            continue
        if skip_blocks:
            import re as _re
            m = _re.search(r"convnext\.(\d+)/", node.name)
            if m and int(m.group(1)) in skip_blocks:
                new_nodes.append(node)
                continue
        w = numpy_helper.to_array(init)
        if w.dtype != np.float32 or w.ndim != 2 or min(w.shape) < min_dim:
            new_nodes.append(node)
            continue

        red_axis = 0 if axis == 1 else 1
        amax = np.max(np.abs(w), axis=red_axis, keepdims=True)
        scale = np.maximum(amax / 127.0, 1e-12).astype(np.float32)
        q = np.clip(np.rint(w / scale), -127, 127).astype(np.int8)

        q_name, s_name, dq_name = wname + "_int8", wname + "_scale", wname + "_dq"
        z_name = wname + "_zp"
        extra_inits.append(numpy_helper.from_array(q, q_name))
        extra_inits.append(numpy_helper.from_array(scale.reshape(-1), s_name))
        # per-axis DQ needs a 1-D zero point of the broadcast dim (a scalar is rejected by ORT)
        extra_inits.append(numpy_helper.from_array(np.zeros(scale.size, dtype=np.int8), z_name))
        new_nodes.append(helper.make_node(
            "DequantizeLinear", [q_name, s_name, z_name], [dq_name], name="dq_" + wname, axis=axis))
        node.input[1] = dq_name
        replaced.append(wname)
        new_nodes.append(node)

    replaced = set(replaced)
    keep_inits = [t for t in model.graph.initializer if t.name not in replaced]
    del model.graph.node[:]
    model.graph.node.extend(new_nodes)
    del model.graph.initializer[:]
    model.graph.initializer.extend(keep_inits + extra_inits)

    onnx.save_model(model, str(dst), save_as_external_data=True, all_tensors_to_one_file=True,
                    location=dst.name + ".data", size_threshold=1024, convert_attribute=False)
    onnx.checker.check_model(str(dst))
    return sorted(replaced), dst


def total_mb(p: Path):
    p = Path(p)
    return (p.stat().st_size + (p.with_name(p.name + ".data").stat().st_size
                                if p.with_name(p.name + ".data").exists() else 0)) / 1e6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--axis", type=int, default=1)
    ap.add_argument("--no-skip", action="store_true", help="also quantize head/ISTFT weights")
    ap.add_argument("--skip-blocks", default="", help="comma separated convnext block indices kept in fp32")
    args = ap.parse_args()

    replaced, dst = quantize_weight_only(
        Path(args.input), Path(args.output),
        skip_suffixes=() if args.no_skip else DEFAULT_SKIP, axis=args.axis,
        skip_blocks={int(x) for x in args.skip_blocks.split(",") if x.strip()})
    print(f"[wo8] {len(replaced)} MatMul weights -> int8, output {dst} ({total_mb(dst):.1f} MB)")


if __name__ == "__main__":
    main()
