#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Re-export and quantize vocoder ONNX with clean external data."""

import os, sys, gc, shutil
from pathlib import Path

# Setup paths
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
    from export_shared import (
        load_config,
        load_model,
        VocosFullWrapper,
        postprocess_onnx,
    )
    from scripts.int8_bridge import _strip_int8_buffers

    out_dir = PROJECT_ROOT / "int8_output"
    onnx_dir = out_dir / "onnx"
    pt_dir = out_dir / "pt"

    # Step 1: Load model
    print("[1] Loading SoulX-Singer model...")
    model_path = SOULX_DIR / "pretrained_models" / "SoulX-Singer" / "model.pt"
    config = load_config()
    model = load_model(config, str(model_path))
    model.eval()
    vocoder = model.vocoder
    print(f"  vocoder: {type(vocoder).__name__}")

    # Step 2: Load PT checkpoint (INT8 weights + GPTQ-optimized FP32 weights)
    print("[2] Loading vocoder_w8a32.pt...")
    voc_ckpt = torch.load(
        pt_dir / "vocoder_w8a32.pt", map_location="cpu", weights_only=False
    )
    vocoder.load_state_dict(voc_ckpt["state_dict"], strict=False)
    print(
        f"  Loaded {voc_ckpt['int8_tensors']} INT8 tensors (format={voc_ckpt['format']})"
    )

    # Step 3: Strip INT8 buffers (ONNX uses GPTQ-optimized FP32 weights)
    print("[3] Stripping INT8 buffers...")
    _strip_int8_buffers(vocoder)

    # Step 4: Export FP32 ONNX
    print("[4] Exporting vocoder FP32 ONNX...")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    vocoder = vocoder.to(device).eval()
    voc_wrapper = VocosFullWrapper(vocoder).to(device).eval()

    seq_len = 256
    dummy_mel = torch.randn(1, seq_len, MEL_DIM, device=device)

    fp32_path = str(onnx_dir / "vocoder_fp32.onnx")
    torch.onnx.export(
        voc_wrapper,
        (dummy_mel,),
        fp32_path,
        input_names=["mel"],
        output_names=["output"],
        opset_version=20,
        dynamo=True,
        dynamic_shapes={"mel": {0: "batch", 1: "seq_len"}},
    )
    print(f"  Exported to {fp32_path}")

    # Postprocess
    final_path = str(onnx_dir / "vocoder_post.onnx")
    postprocess_onnx(
        fp32_path,
        final_path,
        fix_mixed_precision=False,
        decompose_conv_transpose=True,
        dynamic_input_shape=True,
        skip_stft_replace=False,
        skip_dml_fixes=False,
    )
    # Clean up temp files
    for p in [fp32_path, fp32_path + ".data", fp32_path + ".data.1"]:
        if os.path.exists(p):
            os.remove(p)
    print(f"  Postprocessed to {final_path}")

    # Free GPU memory
    vocoder.cpu()
    del voc_wrapper, model
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    # Step 5: ORT dynamic quantization (W8A32)
    print("[5] ORT W8A32 dynamic quantization...")
    from onnxruntime.quantization import quantize_dynamic, QuantType

    quant_path = str(onnx_dir / "vocoder_quant.onnx")
    quantize_dynamic(
        model_input=final_path,
        model_output=quant_path,
        op_types_to_quantize=["MatMul", "Gemm", "Conv"],
        weight_type=QuantType.QInt8,
        per_channel=True,
        reduce_range=False,
    )
    print(f"  Quantized to {quant_path}")

    # Clean up postprocessed model
    for p in [final_path, final_path + ".data"]:
        if os.path.exists(p):
            os.remove(p)

    # Step 6: Clean external data (remove stale FP32 data)
    print("[6] Cleaning external data...")
    import onnx
    from onnx import TensorProto

    m = onnx.load(quant_path, load_external_data=True)

    # Verify quantization
    int8_count = sum(1 for i in m.graph.initializer if i.data_type in [2, 3, 13])
    total = len(m.graph.initializer)
    dql = sum(1 for n in m.graph.node if n.op_type == "DynamicQuantizeLinear")
    matmul_int = sum(1 for n in m.graph.node if n.op_type == "MatMulInteger")
    conv_int = sum(1 for n in m.graph.node if n.op_type == "ConvInteger")
    print(
        f"  Quantized: {int8_count}/{total} INT8 tensors, {dql} DQDynamic, {matmul_int} MatMulInteger, {conv_int} ConvInteger"
    )

    # Save with clean external data
    clean_path = str(onnx_dir / "vocoder.onnx")
    # Remove existing files
    for p in [clean_path, clean_path + ".data"]:
        if os.path.exists(p):
            os.remove(p)

    onnx.save_model(
        m,
        clean_path,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location="vocoder.onnx.data",
        size_threshold=0,
    )
    del m
    gc.collect()

    # Verify final file
    onnx_size = os.path.getsize(clean_path)
    data_size = (
        os.path.getsize(clean_path + ".data")
        if os.path.exists(clean_path + ".data")
        else 0
    )
    print(
        f"  Final: vocoder.onnx={onnx_size / 1024 / 1024:.1f}MB + vocoder.onnx.data={data_size / 1024 / 1024:.1f}MB = {(onnx_size + data_size) / 1024 / 1024:.1f}MB total"
    )

    # Clean up quant temp
    for p in [quant_path, quant_path + ".data"]:
        if os.path.exists(p):
            os.remove(p)

    # Final verification
    print("\n[7] Final verification...")
    m2 = onnx.load(clean_path, load_external_data=False)
    int8_count = sum(1 for i in m2.graph.initializer if i.data_type in [2, 3, 13])
    total = len(m2.graph.initializer)
    print(f"  {int8_count}/{total} INT8 tensors")
    del m2

    print("\nDone! vocoder.onnx is ready.")


if __name__ == "__main__":
    main()
