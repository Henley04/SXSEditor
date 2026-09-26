#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Re-export diffstep ONNX with skip_dml_fixes=True + QOperator W8A8 quantization.

Produces a real INT8 model (QLinearMatMul operations, not QDQ fake quant).
"""

import os, sys, gc, shutil
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SOULX_DIR = PROJECT_ROOT / "SoulX-Singer"
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(SOULX_DIR))
os.environ.setdefault("SKIP_ROPE_PRECOMPUTE", "1")

import torch
import torch.nn as nn
import numpy as np

MEL_DIM = 128
COND_DIM = 1024


def main():
    from export_shared import load_config, load_model, DiffStepWrapper, postprocess_onnx
    from scripts.int8_bridge import _strip_int8_buffers

    out_dir = PROJECT_ROOT / "int8_output"
    onnx_dir = out_dir / "onnx"
    pt_dir = out_dir / "pt"

    # 1. Load model
    print("[1] Loading SoulX-Singer model...")
    model_path = SOULX_DIR / "pretrained_models" / "SoulX-Singer" / "model.pt"
    config = load_config()
    model = load_model(config, str(model_path))
    model.eval()
    diff_step = model.cfm_decoder.model.diff_estimator
    print(
        f"  diff_step: {type(diff_step).__name__} ({sum(p.numel() for p in diff_step.parameters()) / 1e6:.1f}M params)"
    )

    # 2. Load PT checkpoint (GPTQ W8A8 quantized weights + INT8 buffers)
    print("[2] Loading diff_step_w8a8.pt...")
    ckpt = torch.load(
        pt_dir / "diff_step_w8a8.pt", map_location="cpu", weights_only=False
    )
    diff_step.load_state_dict(ckpt["state_dict"], strict=False)
    print(f"  Loaded {ckpt['int8_tensors']} INT8 tensors (format={ckpt['format']})")

    # 3. Strip INT8 buffers (ONNX uses GPTQ-optimized FP32 weights)
    print("[3] Stripping INT8 buffers...")
    _strip_int8_buffers(diff_step)

    # 4. Export FP32 ONNX with skip_dml_fixes=True
    print("[4] Exporting FP32 ONNX (skip_dml_fixes=True)...")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    diff_step = diff_step.to(device).eval()

    class _CFMShim(nn.Module):
        def __init__(self, diff_est):
            super().__init__()
            self.model = nn.Module()
            self.model.diff_estimator = diff_est

    wrapper = DiffStepWrapper(_CFMShim(diff_step)).to(device).eval()

    seq_len = 256
    dummy_x = torch.randn(1, seq_len, MEL_DIM, device=device)
    dummy_t = torch.tensor([0.5], device=device)
    dummy_cond = torch.randn(1, seq_len, COND_DIM, device=device)
    dummy_mask = torch.ones(1, seq_len, dtype=torch.float32, device=device)

    fp32_path = str(onnx_dir / "diffstep_fp32_raw.onnx")
    torch.onnx.export(
        wrapper,
        (dummy_x, dummy_t, dummy_cond, dummy_mask),
        fp32_path,
        input_names=["x", "diffusion_step", "cond", "x_mask"],
        output_names=["flow_pred"],
        opset_version=20,
        dynamo=True,
        dynamic_shapes={
            "xt_input": {0: "batch", 1: "seq_len"},
            "t": None,
            "cond": {0: "batch", 1: "seq_len"},
            "xt_mask": {0: "batch", 1: "seq_len"},
        },
    )
    print(f"  Exported raw FP32 to {fp32_path}")

    # Apply postprocess with skip_dml_fixes=True (keep Range op, DML-compatible)
    post_path = str(onnx_dir / "diffstep_post.onnx")
    postprocess_onnx(
        fp32_path,
        post_path,
        fix_mixed_precision=False,
        decompose_conv_transpose=False,
        dynamic_input_shape=True,
        skip_stft_replace=True,
        skip_dml_fixes=True,  # Keep Range op, skip fix_arange_slice
    )
    # Clean up raw export
    for p in [fp32_path, fp32_path + ".data"]:
        if os.path.exists(p):
            os.remove(p)
    print(f"  Postprocessed to {post_path}")

    # Free GPU memory
    diff_step.cpu()
    del wrapper, model
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    # 5. ORT static quantization - QOperator format (real INT8)
    print("[5] ORT W8A8 static quantization (QOperator)...")
    from onnxruntime.quantization import (
        QuantType,
        QuantFormat,
        CalibrationDataReader,
        quantize,
        StaticQuantConfig,
    )

    # Build calibration feeds with float32 mask (ORT quant doesn't support bool)
    feeds = []
    for sl in [128, 256, 384, 256]:
        feeds.append(
            {
                "x": np.random.randn(1, sl, MEL_DIM).astype(np.float32),
                "diffusion_step": np.array([0.5], dtype=np.float32),
                "cond": np.random.randn(1, sl, COND_DIM).astype(np.float32),
                "x_mask": np.ones((1, sl), dtype=np.float32),
            }
        )

    class CalibReader(CalibrationDataReader):
        def __init__(self, feeds):
            self.feeds = feeds
            self.idx = 0

        def get_next(self):
            if self.idx >= len(self.feeds):
                return None
            f = self.feeds[self.idx]
            self.idx += 1
            return dict(f)

    reader = CalibReader(feeds)
    int8_path = str(onnx_dir / "diffstep_int8.onnx")

    config = StaticQuantConfig(
        calibration_data_reader=reader,
        quant_format=QuantFormat.QOperator,  # Real INT8 ops (QLinearMatMul)
        per_channel=True,
        reduce_range=False,
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul", "Gemm"],
        extra_options={
            "ActivationSymmetric": False,
            "WeightSymmetric": True,
            "QuantizeBias": False,
        },
    )
    quantize(post_path, int8_path, quant_config=config)
    print(f"  Quantized to {int8_path}")

    # Clean up postprocessed model
    for p in [post_path, post_path + ".data"]:
        if os.path.exists(p):
            os.remove(p)

    # 6. Save as final diffstep.onnx with clean external data
    print("[6] Saving final diffstep.onnx...")
    import onnx

    m = onnx.load(int8_path, load_external_data=True)

    # Verify quantization
    int8_count = sum(1 for i in m.graph.initializer if i.data_type in [2, 3, 13])
    total = len(m.graph.initializer)
    qmatmul = sum(1 for n in m.graph.node if n.op_type == "QLinearMatMul")
    qgemm = sum(1 for n in m.graph.node if n.op_type == "QGemm")
    dql = sum(1 for n in m.graph.node if n.op_type == "DequantizeLinear")
    ql = sum(1 for n in m.graph.node if n.op_type == "QuantizeLinear")
    has_range = sum(1 for n in m.graph.node if n.op_type == "Range")
    has_fix_arange = sum(1 for n in m.graph.node if "fix_arange" in n.name)
    print(f"  INT8 tensors: {int8_count}/{total}")
    print(f"  QLinearMatMul: {qmatmul}, QGemm: {qgemm}")
    print(f"  Q/DQ nodes: {ql}/{dql}")
    print(f"  Range nodes: {has_range}, fix_arange nodes: {has_fix_arange}")

    final_path = str(onnx_dir / "diffstep.onnx")
    # Remove old files
    for p in [final_path, final_path + ".data"]:
        if os.path.exists(p):
            os.remove(p)

    onnx.save_model(
        m,
        final_path,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location="diffstep.onnx.data",
        size_threshold=0,
    )
    del m
    gc.collect()

    # Clean up quant temp
    for p in [int8_path, int8_path + ".data"]:
        if os.path.exists(p):
            os.remove(p)

    onnx_size = os.path.getsize(final_path)
    data_size = (
        os.path.getsize(final_path + ".data")
        if os.path.exists(final_path + ".data")
        else 0
    )
    print(
        f"  Final: {onnx_size / 1024 / 1024:.1f}MB + {data_size / 1024 / 1024:.1f}MB = {(onnx_size + data_size) / 1024 / 1024:.1f}MB"
    )

    print("\nDone! diffstep.onnx is ready.")


if __name__ == "__main__":
    main()
