# -*- coding: utf-8 -*-
"""Step 2: Export vocoder (Vocos) to FP32 opset 20 ONNX (DML-compatible).

Uses VocosFullWrapper which includes the complete ISTFT reconstruction:
  backbone → head.out (Linear) → exp/clip/cos/sin → MatMul IDFT →
  windowing → fold overlap-add → window envelope normalization

Output: 'waveform' [1, T*hop] (final audio waveform, not raw 'spec').

The MatMul-based IDFT avoids torch.fft.irfft (which exports as DFT nodes
unsupported by DML). The fold-based overlap-add is decomposed by dynamo
export into basic ops (Reshape, Pad, Slice, Add, etc.).
"""
import argparse
import os
import time
import torch

from export_shared import (
    load_config, load_model, VocosFullWrapper,
    FP32_OUTPUT_DIR, export_fp32_opset20, clear_memory,
)


def main():
    parser = argparse.ArgumentParser(
        description="Export Vocos vocoder to FP32 opset 20 ONNX (DML-compatible).")
    default_model_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt')
    parser.add_argument('--model-path', default=default_model_path)
    parser.add_argument('--output-dir', default=FP32_OUTPUT_DIR)
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    config = load_config()

    print("Step 2: Export vocoder FP32 opset 20 ONNX (DML-compatible, full ISTFT)")
    t0 = time.time()

    model = load_model(config, args.model_path)
    wrapper = VocosFullWrapper(model.vocoder).eval()
    param_count = sum(p.numel() for p in wrapper.parameters()) / 1e6
    print(f"  vocoder (full): {param_count:.1f}M params")

    output_path = os.path.join(args.output_dir, 'vocoder_dml.onnx')
    voc_seq_len = 500
    mel = torch.randn(1, voc_seq_len, 128, dtype=torch.float32)

    export_fp32_opset20(
        wrapper,
        (mel,),
        output_path,
        input_names=['mel'],
        output_names=['waveform'],
        decompose_conv_transpose=True,   # No-op if no ConvTranspose, safe to keep
        fix_mixed_precision=False,       # FP32 main path
    )

    del wrapper, model
    clear_memory()

    elapsed = time.time() - t0
    print(f"  Done in {elapsed:.1f}s -> {output_path}")


if __name__ == '__main__':
    main()
