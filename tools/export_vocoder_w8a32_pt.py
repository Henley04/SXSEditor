# -*- coding: utf-8 -*-
"""Export true W8A32 vocoder (INT8 weight storage + FP32 activations).

"True W8A32" is the INT8 analogue of the W16A32 rule:
  - every Conv/MatMul weight initializer with >= 2 dims is stored as
    per-tensor symmetric INT8 (zero point 0, scale = max(|w|) / 127);
  - a DequantizeLinear(INT8 -> FLOAT32) node is inserted before every
    consumer edge of such a weight (including weight-first MatMul chains);
  - 1D tensors (bias, LayerNorm gain), ISTFT basis/window constants and
    graph I/O stay FLOAT32.
No MatMulInteger / QLinear* / activation quantization anywhere: compute is
all FP32, only storage is INT8.

Source: the FP32 base is reconstructed by dequantizing the W16A32 artifact
(w16a32_output/onnx/vocoder_w16a32.onnx): its FP16 weights are exact in
FP32, so dequantizing them back is lossless.

Usage:
  python tools/export_vocoder_w8a32_pt.py
  python tools/export_vocoder_w8a32_pt.py --fp32-base onnx_models/vocoder_dml.onnx
  python tools/export_vocoder_w8a32_pt.py --output-dir w8a32_output
"""
import argparse
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

import numpy as np
import onnx
from collections import Counter
from onnx import TensorProto, helper, numpy_helper
from export_vocoder_w16a32_pt import fix_neg1_const_reshapes

WEIGHT_OPS = {"MatMul", "Gemm", "Conv", "ConvTranspose"}
PREFIX = "w8a32"


# ============================================================
# FP32 base reconstruction (from the W16A32 artifact, lossless)
# ============================================================
def rebuild_fp32_base(w16a32_path: Path, fp32_base_path: Path):
    """Turn the W16A32 artifact back into a plain FP32 model.

    The W16A32 build stores Conv/MatMul weights as FP16 initializers with a
    Cast(FP16 -> FP32) node before every consumer. FP16 values are exactly
    representable in FP32, so this is lossless: convert each FP16 weight to
    an FP32 initializer and drop its Cast node(s), rewiring consumers to the
    raw initializer.
    """
    model = onnx.load(str(w16a32_path), load_external_data=True)
    graph = model.graph

    fp16_names = {i.name for i in graph.initializer if i.data_type == TensorProto.FLOAT16}
    nodes_snapshot = list(graph.node)

    # Drop Cast(FP16 -> FP32) nodes that feed an FP16 weight; remember their
    # output so consumers can be rewired to the raw initializer.
    cast_out_to_init = {}
    for n in nodes_snapshot:
        if (n.op_type == "Cast" and n.input and n.input[0] in fp16_names
                and any(a.name == "to" and a.i == TensorProto.FLOAT for a in n.attribute)):
            cast_out_to_init[n.output[0]] = n.input[0]

    converted = 0
    for name in sorted(fp16_names):
        w16 = numpy_helper.to_array(
            next(i for i in graph.initializer if i.name == name)).astype(np.float32)
        graph.initializer[[i.name for i in graph.initializer].index(name)].CopyFrom(
            numpy_helper.from_array(w16, name=name))
        converted += 1

    for node in nodes_snapshot:
        for slot, inp in enumerate(node.input):
            if inp in cast_out_to_init:
                node.input[slot] = cast_out_to_init[inp]

    kept_nodes = [n for n in nodes_snapshot
                  if not (n.op_type == "Cast" and n.output[0] in cast_out_to_init)]
    del graph.node[:]
    graph.node.extend(kept_nodes)

    used = {inp for n in kept_nodes for inp in n.input if inp}
    kept_inits = [i for i in graph.initializer if i.name in used]
    del graph.initializer[:]
    graph.initializer.extend(kept_inits)

    for p in (fp32_base_path, Path(str(fp32_base_path) + ".data")):
        if p.exists():
            p.unlink()
    onnx.save_model(
        model, str(fp32_base_path),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=fp32_base_path.name + ".data",
        size_threshold=1024,
    )
    leftover_fp16 = sum(1 for i in kept_inits if i.data_type == TensorProto.FLOAT16)
    print(f"[base] converted {converted} FP16 weights -> FP32, "
          f"dropped {len(cast_out_to_init)} Cast(FP16->FP32) nodes; "
          f"remaining FP16 inits: {leftover_fp16}")
    print(f"[base] FP32 base: {fp32_base_path} "
          f"({fp32_base_path.stat().st_size / 1048576:.1f} MB graph + "
          f"{(fp32_base_path.parent / (fp32_base_path.name + '.data')).stat().st_size / 1048576:.1f} MB data)")
    if leftover_fp16:
        raise RuntimeError("FP32 base still contains FP16 initializers")
    return model


# ============================================================
# True W8A32 conversion
# ============================================================
def quantize_weights_to_int8(model, per_channel=True):
    """Store >=2D Conv/MatMul weight initializers as symmetric INT8.

    Initializer-based (mirrors quantize_weights_to_fp16): a weight is any
    FLOAT initializer with >= 2 dims consumed by a MatMul/Gemm/Conv/
    ConvTranspose in ANY input slot (dynamo emits weight-first MatMuls for
    the IDFT stage). For each, the initializer becomes INT8 and one
    DequantizeLinear(INT8 -> FP32) is rewired into every consumer edge, so
    all activation compute stays FP32.

    per_channel: scale per output channel (axis 0 for slot-1 weights,
    axis 1 for weight-first MatMul slot 0); falls back to per-tensor when
    a single init is consumed through both MatMul slots.
    """
    graph = model.graph
    init_consumers = {}
    for node in graph.node:
        for inp in node.input:
            if inp:
                init_consumers.setdefault(inp, []).append(node)
    nodes_snapshot = list(graph.node)

    quantized = 0
    total_params = 0
    skipped_istft = 0
    skipped_1d = 0
    per_channel_count = 0
    per_tensor_count = 0
    new_inits = []
    new_dq_by_idx = {}  # node idx -> [DQ node, ...] to insert before it

    for init in list(graph.initializer):
        name = init.name
        if init.data_type != TensorProto.FLOAT:
            continue
        dims = list(init.dims)
        if len(dims) <= 1:
            skipped_1d += 1
            continue
        low = name.lower()
        if "istft" in low or "window" in low:
            skipped_istft += 1
            continue
        consumers = [c for c in init_consumers.get(name, [])
                     if c.op_type in WEIGHT_OPS]
        if not consumers:
            continue

        w = numpy_helper.to_array(init)
        if np.max(np.abs(w)) <= 0:
            continue

        # Per-channel axis: Conv/ConvTranspose/Gemm weight slot (input[1])
        # and MatMul slot 1 -> dim 0 (output channels); MatMul slot 0
        # (weight-first, IDFT stage) -> dim 1. Mixed usage -> per-tensor.
        axis = None
        if per_channel:
            axes = set()
            for c in consumers:
                for slot, inp in enumerate(c.input):
                    if inp != name or slot >= 2:
                        continue
                    if c.op_type in ("Conv", "ConvTranspose", "Gemm"):
                        axes.add(0)
                    elif c.op_type == "MatMul":
                        axes.add(0 if slot == 1 else 1)
            if len(axes) == 1:
                axis = axes.pop()

        if axis is not None:
            max_abs = np.max(np.abs(w), axis=tuple(i for i in range(w.ndim) if i != axis))
            scale = np.maximum(max_abs / 127.0, 1e-12).astype(np.float32)
            inv = (1.0 / scale).astype(np.float32)
            shape = [1] * w.ndim
            shape[axis] = scale.size
            q = np.clip(np.round(w * inv.reshape(shape)), -128, 127).astype(np.int8)
            per_channel_count += 1
        else:
            scale = np.array([float(np.max(np.abs(w))) / 127.0], dtype=np.float32)
            q = np.clip(np.round(w / (scale[0] + 1e-30)), -128, 127).astype(np.int8)
            per_tensor_count += 1

        new_init = numpy_helper.from_array(q, name=name)
        for i, ex in enumerate(graph.initializer):
            if ex.name == name:
                graph.initializer[i].CopyFrom(new_init)
                break

        scale_name = f"{PREFIX}_scale_{quantized}"
        zp_name = f"{PREFIX}_zp_{quantized}"
        dq_out = f"{PREFIX}_dq_{quantized}_out"
        if axis is not None:
            zp = np.zeros(scale.shape, dtype=np.int8)
        else:
            zp = np.array(0, dtype=np.int8)
        new_inits.append(numpy_helper.from_array(scale, name=scale_name))
        new_inits.append(numpy_helper.from_array(zp, name=zp_name))
        dq = helper.make_node("DequantizeLinear", [name, scale_name, zp_name],
                              [dq_out], name=f"{PREFIX}_dq_{quantized}",
                              axis=(axis if axis is not None else 0))

        # Rewire every consumer edge to the DQ output; insert the DQ node
        # exactly once, before the first consumer.
        first_idx = None
        for idx, node in enumerate(nodes_snapshot):
            if name not in node.input:
                continue
            if first_idx is None:
                first_idx = idx
            for slot, inp in enumerate(node.input):
                if inp == name:
                    node.input[slot] = dq_out
        if first_idx is not None:
            new_dq_by_idx.setdefault(first_idx, []).append(dq)
        quantized += 1
        total_params += int(np.prod(dims))

    if new_inits:
        graph.initializer.extend(new_inits)
    if new_dq_by_idx:
        rebuilt = []
        for idx, node in enumerate(nodes_snapshot):
            rebuilt.extend(new_dq_by_idx.get(idx, []))
            rebuilt.append(node)
        del graph.node[:]
        graph.node.extend(rebuilt)

    print(f"  quantize_weights_to_int8: {quantized} weights -> INT8 "
          f"({total_params / 1e6:.1f}M params), {quantized} DequantizeLinear inserted "
          f"(per-channel: {per_channel_count}, per-tensor: {per_tensor_count})")
    print(f"    Skipped: {skipped_istft} istft/window, {skipped_1d} 1D/other")
    return model


def repair_int8_consumer_edges(model):
    """DequantizeLinear on every remaining direct INT8-initializer edge.

    quantize_weights_to_int8 only rewires the weight slot (input[1]) of
    MatMul/Gemm/Conv/ConvTranspose. Weight-first MatMul chains (matmul(W, x))
    or Transpose(W) -> MatMul would otherwise feed INT8 straight into FP32
    consumers. Reuses the initializer's existing DQ output when present.
    """
    graph = model.graph
    int8_names = {i.name for i in graph.initializer if i.data_type == TensorProto.INT8}
    dq_out_by_init = {}
    for node in graph.node:
        if node.op_type == "DequantizeLinear" and node.input and node.input[0] in int8_names:
            dq_out_by_init.setdefault(node.input[0], node.output[0])

    total_added = 0
    counter = 0
    nodes_snapshot = list(graph.node)
    for name in sorted(int8_names):
        existing = dq_out_by_init.get(name)
        consumers = []
        for node in nodes_snapshot:
            # DequantizeLinear nodes must keep the raw INT8 initializer as
            # input[0]; skipping them also leaves zero-point inits alone
            # (their only consumer is a DQ node).
            if node.op_type == "DequantizeLinear":
                continue
            for slot, inp in enumerate(node.input):
                if inp == name:
                    consumers.append((node, slot))
        if not consumers:
            continue
        if existing is None:
            # Should not happen (quantizer always emits a DQ), but stay safe.
            existing = f"{PREFIX}_repair_dq_{counter}_out"
            scale_name = f"{PREFIX}_repair_scale_{counter}"
            zp_name = f"{PREFIX}_repair_zp_{counter}"
            w = numpy_helper.to_array(next(i for i in graph.initializer if i.name == name))
            max_abs = float(np.max(np.abs(w)))
            graph.initializer.append(numpy_helper.from_array(
                np.array(max_abs / 127.0 if max_abs > 0 else 1.0, dtype=np.float32),
                name=scale_name))
            graph.initializer.append(numpy_helper.from_array(
                np.array(0, dtype=np.int8), name=zp_name))
            first = consumers[0][0]
            first_idx = list(graph.node).index(first)
            graph.node.insert(
                first_idx,
                helper.make_node("DequantizeLinear", [name, scale_name, zp_name],
                                 [existing], name=f"{PREFIX}_repair_dq_{counter}", axis=0),
            )
            counter += 1
            total_added += 1
        for node, slot in consumers:
            node.input[slot] = existing
    print(f"  repair_int8_consumer_edges: +{total_added} DequantizeLinear for raw INT8 edges")
    return total_added


# ============================================================
# Validation report
# ============================================================
def report(w8_path: Path):
    m = onnx.load(str(w8_path), load_external_data=False)
    g = m.graph
    op_counts = Counter(n.op_type for n in g.node)
    int8_inits = {i.name for i in g.initializer if i.data_type == TensorProto.INT8}
    dq_nodes = [n for n in g.node if n.op_type == "DequantizeLinear"]
    hostile = sum(1 for n in g.node if n.op_type in ("DFT", "STFT", "Col2Im", "ConvTranspose"))

    bad = []
    for n in g.node:
        if n.op_type == "DequantizeLinear":
            continue
        for inp in n.input:
            if inp in int8_inits:
                bad.append((n.op_type, inp))

    data = Path(str(w8_path) + ".data")
    total_mb = (w8_path.stat().st_size + (data.stat().st_size if data.exists() else 0)) / 1048576

    print("\n=== W8A32 report ===")
    print(f"  nodes: {len(g.node)}")
    print(f"  top ops: {op_counts.most_common(12)}")
    print(f"  initializers: {len(g.initializer)} {dict(Counter(i.data_type for i in g.initializer))}")
    print(f"  INT8 weight inits: {len(int8_inits)}, DequantizeLinear: {len(dq_nodes)}")
    print(f"  raw INT8 consumer edges (must be 0): {len(bad)}")
    if bad:
        print(f"    first: {bad[:5]}")
    print(f"  DML-hostile nodes (DFT/STFT/Col2Im/ConvTranspose): {hostile}")
    print(f"  inputs: {[(i.name, i.type.tensor_type.elem_type) for i in g.input]}")
    print(f"  outputs: {[(o.name, o.type.tensor_type.elem_type) for o in g.output]}")
    print(f"  total size: {total_mb:.1f} MB")
    return len(bad)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fp32-base", default=str(ROOT / "onnx_models" / "vocoder_dml.onnx"),
                    help="FP32 vocoder ONNX to quantize (default: production FP32 model)")
    ap.add_argument("--from-w16a32",
                    default=str(ROOT / "w16a32_output" / "onnx" / "vocoder_w16a32.onnx"),
                    help="Fallback base: dequantize the W16A32 artifact to FP32 "
                         "when --fp32-base is missing")
    ap.add_argument("--per-tensor", action="store_true",
                    help="per-tensor scales (default: per-channel output-axis)")
    ap.add_argument("--output-dir", default=str(ROOT / "w8a32_output"))
    args = ap.parse_args()

    variant = "per_tensor" if args.per_tensor else "per_channel"
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    fp32_base = out_dir / "vocoder_fp32_base.onnx"
    w8_path = out_dir / f"vocoder_w8a32_{variant}.onnx"

    if os.path.exists(args.fp32_base):
        src_used = Path(args.fp32_base)
        # The production model's .data may be a hardlink (disk-space saving);
        # the onnx external-data checker rejects hardlinked files. Copy to a
        # regular file in the output dir to break the link.
        base_data = Path(str(src_used) + ".data")
        if base_data.exists() and os.stat(base_data).st_nlink > 1:
            copy_dst = out_dir / src_used.name
            data_dst = out_dir / (src_used.name + ".data")
            import shutil
            for src_p, dst_p in ((src_used, copy_dst), (base_data, data_dst)):
                if not dst_p.exists():
                    shutil.copy2(str(src_p), str(dst_p))
            src_used = copy_dst
            print(f"[base] hardlinked data detected -> copied base to {copy_dst}")
        print(f"[base] reusing existing FP32 base: {src_used}")
    else:
        src = Path(args.from_w16a32)
        if not src.exists():
            print(f"[base] no FP32 base ({args.fp32_base}) and no W16A32 fallback ({src})")
            sys.exit(1)
        print(f"[base] dequantizing W16A32 artifact to FP32 base: {src}")
        rebuild_fp32_base(src, fp32_base)
        src_used = fp32_base

    print(f"[w8a32] converting {src_used}")
    model = onnx.load(str(src_used), load_external_data=True)
    model = fix_neg1_const_reshapes(model)
    model = quantize_weights_to_int8(model, per_channel=not args.per_tensor)
    repair_int8_consumer_edges(model)

    if w8_path.exists():
        w8_path.unlink()
    w8_data = Path(str(w8_path) + ".data")
    if w8_data.exists():
        w8_data.unlink()
    onnx.save_model(
        model, str(w8_path),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=w8_path.name + ".data",
        size_threshold=1024,
    )

    if report(w8_path) != 0:
        print("  [FAIL] raw INT8 consumer edges present")
        sys.exit(1)
    print("  [OK] true W8A32: INT8 storage only, all activations FP32")


if __name__ == "__main__":
    main()
