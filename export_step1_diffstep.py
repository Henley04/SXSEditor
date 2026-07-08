# -*- coding: utf-8 -*-
"""Step 1: Export diff_step sub-model to FP32 opset 20 ONNX (DML main path)."""
import argparse
import os
import time
import torch
from export_shared import (
    load_config, load_model, DiffStepWrapper,
    FP32_OUTPUT_DIR, export_fp32_opset20, clear_memory,
)

DEFAULT_MODEL_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt',
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-path', default=DEFAULT_MODEL_PATH)
    parser.add_argument('--output-dir', default=FP32_OUTPUT_DIR)
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    print("Step 1: Export diff_step FP32 opset 20 ONNX (DML main path)")
    t0 = time.time()

    config = load_config()
    model = load_model(config, args.model_path)
    wrapper = DiffStepWrapper(model.cfm_decoder).eval()

    param_count = sum(p.numel() for p in wrapper.parameters())
    print(f"  diff_step: {param_count / 1e6:.1f}M params")

    output_path = os.path.join(args.output_dir, 'diff_step_dml.onnx')
    seq_len = 2048
    # cond is cond_embedding (hidden_size-dim, already processed by cond_emb.onnx)
    # Matches pipeline: preprocessing.js runs cond_emb first, then feeds
    # cond_embedding to diff_step. hidden_size from config = COND_DIM (1024).
    cond_dim = config.model.flow_matching.hidden_size
    print(f"  cond_dim (hidden_size): {cond_dim}")
    args_tuple = (
        torch.randn(1, seq_len, 128, dtype=torch.float32),
        torch.tensor([0.5], dtype=torch.float32),
        torch.randn(1, seq_len, cond_dim, dtype=torch.float32),
        torch.ones(1, seq_len, dtype=torch.float32),
    )
    input_names = ['xt_input', 't', 'cond', 'xt_mask']
    output_names = ['flow_pred']

    export_fp32_opset20(
        wrapper, args_tuple, output_path,
        input_names=input_names,
        output_names=output_names,
        dynamic_shapes={
            'xt_input': {1: 'seq_len'},
            'cond': {1: 'seq_len'},
            'xt_mask': {1: 'seq_len'},
            'flow_pred': {1: 'seq_len'},
        },
        decompose_conv_transpose=False,
        fix_mixed_precision=False,
    )

    del wrapper, model
    clear_memory()

    elapsed = time.time() - t0
    print(f"  Done in {elapsed:.1f}s -> {output_path}")


if __name__ == '__main__':
    main()
