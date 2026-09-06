# -*- coding: utf-8 -*-
"""Step 4: Export JP-specific FP32 opset 20 ONNX models.

Exports 4 JP models to onnx_models/JP/:
  1. note_text_encoder.onnx - extended embedding (3033x512), FP32
  2. preflow.onnx - 4 ConvNeXtV2Block (merged LoRA), FP32, no LayerNorm at input
  3. cond_emb.onnx - Linear 512->1024 (merged LoRA), FP32
  4. diff_step_dml.onnx - DiffLlama 22-layer diff_estimator (merged LoRA), FP32

Based on SoulX-Singer/train/lora_jp_v3/export_onnx.py but uses FP32 + opset 20
(via export_shared.export_fp32_opset20) instead of FP16 + opset 17.

Does NOT touch onnx_models/fp16/JP/ (the existing FP16 export path).

Usage:
    python export_step4_jp.py
    python export_step4_jp.py --checkpoint path/to/stage3_best.pt --output-dir onnx_models/JP
"""
import argparse
import os
import sys

import torch
import torch.nn as nn

# Windows console Unicode fix
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# Shared utilities (importing this also adds SoulX-Singer to sys.path)
from export_shared import (
    load_config,
    load_model,
    FP32_OUTPUT_DIR,
    export_fp32_opset20,
    clear_memory,
    DiffStepWrapper,
)

# JP LoRA utilities
from train.lora_jp_v3.lora import apply_lora_to_model, merge_lora_into_base

# JP wrappers + helpers (reuse from existing export script - do NOT redefine)
from train.lora_jp_v3.export_onnx import (
    PreflowONNX,
    TextEncoderONNX,
    CondEmbONNX,
    DiffStepONNX,
    build_full_embedding,
    load_lora_checkpoint,
    _ensure_rotary_emb,
    EMBED_DIM,
    MEL_DIM,
    COND_DIM,
)


def parse_args():
    parser = argparse.ArgumentParser(
        description='Export JP-specific FP32 opset 20 ONNX models (4 files)')
    parser.add_argument(
        '--checkpoint', type=str,
        default=os.path.join('SoulX-Singer', 'outputs', 'lora_jp_v3', 'stage3', 'stage3_best.pt'),
        help='JP LoRA checkpoint path (default: SoulX-Singer/outputs/lora_jp_v3/stage3/stage3_best.pt)')
    parser.add_argument(
        '--base-model', dest='base_model', type=str,
        default=os.path.join('SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt'),
        help='Base SoulX-Singer model.pt path')
    parser.add_argument(
        '--output-dir', dest='output_dir', type=str,
        default=os.path.join(FP32_OUTPUT_DIR, 'JP'),
        help='Output directory (default: onnx_models/JP/)')
    parser.add_argument(
        '--opset', type=int, default=20,
        help='ONNX opset version (default: 20; export_fp32_opset20 always uses 20)')
    return parser.parse_args()


def main():
    args = parse_args()
    os.makedirs(args.output_dir, exist_ok=True)

    print('=' * 60)
    print('Step 4: Export JP FP32 opset 20 ONNX models')
    print('=' * 60)
    print(f'  checkpoint: {args.checkpoint}')
    print(f'  base model: {args.base_model}')
    print(f'  output dir: {args.output_dir}')
    print(f'  opset:      {args.opset} (export_fp32_opset20 hardcodes opset 20)')

    # ---------------------------------------------------------------
    # 1. Load base model
    # ---------------------------------------------------------------
    print('\n[1/6] Loading base model...')
    config = load_config()
    model = load_model(config, args.base_model)
    print(f'  Base embedding rows: {model.note_text_encoder.weight.shape[0]}')

    # ---------------------------------------------------------------
    # 2. Load JP checkpoint + extend note_text_encoder embedding
    # ---------------------------------------------------------------
    print('\n[2/6] Loading JP checkpoint + extending embedding...')
    ft_ckpt = torch.load(args.checkpoint, map_location='cpu', weights_only=False)
    print(f'  epoch={ft_ckpt.get("epoch", "?")}, stage={ft_ckpt.get("stage", "?")}, '
          f'loss={ft_ckpt.get("loss", "?")}')

    if 'embed_weight' in ft_ckpt:
        ew = ft_ckpt['embed_weight']
        if ew.shape[0] > model.note_text_encoder.weight.shape[0]:
            new_emb = nn.Embedding(ew.shape[0], EMBED_DIM)
            new_emb.weight.data = ew
            model.note_text_encoder = new_emb
            print(f'  Extended embedding: {tuple(ew.shape)}')
        else:
            print(f'  Embedding not extended (ckpt {ew.shape[0]} <= base {model.note_text_encoder.weight.shape[0]})')

    # ---------------------------------------------------------------
    # 3. Apply LoRA structure + load LoRA weights + merge into base
    # ---------------------------------------------------------------
    print('\n[3/6] Applying LoRA + loading weights + merging...')
    lora_rank = ft_ckpt.get('lora_rank', 16)
    lora_alpha = ft_ckpt.get('lora_alpha', 32)
    print(f'  LoRA config: rank={lora_rank}, alpha={lora_alpha}')

    apply_lora_to_model(model, rank=lora_rank, alpha=lora_alpha)

    lora_state = ft_ckpt.get('lora_state', {})
    loaded = 0
    for name, module in model.named_modules():
        if hasattr(module, 'lora_A') and hasattr(module, 'lora_B') and name in lora_state:
            ls = lora_state[name]
            module.lora_A.data.copy_(ls['lora_A'])
            module.lora_B.data.copy_(ls['lora_B'])
            loaded += 1
    print(f'  Loaded LoRA weights: {loaded} / {len(lora_state)} layers')

    merge_lora_into_base(model)
    print('  Merged LoRA into base weights')

    # ---------------------------------------------------------------
    # 4. Build full embedding (base rows 0-2999 + JP rows 3000-3032)
    # ---------------------------------------------------------------
    print('\n[4/6] Building full embedding...')
    base_ckpt = torch.load(args.base_model, map_location='cpu', weights_only=False)
    full_embed = build_full_embedding(ft_ckpt, base_ckpt)
    del base_ckpt
    clear_memory()

    # ---------------------------------------------------------------
    # 5. Export 4 JP ONNX files as FP32 opset 20
    #    (no .half() anywhere - this is FP32 export)
    # ---------------------------------------------------------------
    print('\n[5/6] Exporting 4 JP ONNX files (FP32, opset 20)...')

    # 5a. note_text_encoder.onnx (TextEncoderONNX wrapper, FP32)
    print('\n  [5a] note_text_encoder.onnx...')
    text_model = TextEncoderONNX(full_embed).eval()  # FP32, no .half()
    dummy_ids = torch.randint(0, full_embed.shape[0], (1, 10), dtype=torch.long)
    export_fp32_opset20(
        text_model, (dummy_ids,),
        os.path.join(args.output_dir, 'note_text_encoder.onnx'),
        input_names=['input_ids'], output_names=['embeddings'],
        decompose_conv_transpose=False,
    )
    del text_model
    clear_memory()

    # 5b. preflow.onnx (PreflowONNX wrapper, FP32, no LayerNorm at input)
    print('\n  [5b] preflow.onnx...')
    pf_sd = model.preflow.state_dict()
    preflow_model = PreflowONNX(pf_sd).eval()  # FP32, no .half()
    dummy_feat = torch.randn(1, 100, EMBED_DIM)  # FP32
    export_fp32_opset20(
        preflow_model, (dummy_feat,),
        os.path.join(args.output_dir, 'preflow.onnx'),
        input_names=['features'], output_names=['processed_features'],
        decompose_conv_transpose=False,
    )
    del preflow_model
    clear_memory()

    # 5c. cond_emb.onnx (CondEmbONNX wrapper, FP32)
    print('\n  [5c] cond_emb.onnx...')
    cond_emb_linear = nn.Linear(EMBED_DIM, COND_DIM)
    cond_emb_linear.load_state_dict(model.cfm_decoder.model.cond_emb.state_dict())
    cond_model = CondEmbONNX(cond_emb_linear).eval()  # FP32, no .half()
    dummy_cond = torch.randn(1, 20, EMBED_DIM)  # FP32
    export_fp32_opset20(
        cond_model, (dummy_cond,),
        os.path.join(args.output_dir, 'cond_emb.onnx'),
        input_names=['cond_code'], output_names=['cond_embedding'],
        decompose_conv_transpose=False,
    )
    del cond_model
    clear_memory()

    # 5d. diff_step_dml.onnx (DiffStepONNX wrapper, FP32)
    print('\n  [5d] diff_step_dml.onnx...')
    _ensure_rotary_emb(model)  # transformers 5.x compatibility
    diff_estimator = model.cfm_decoder.model.diff_estimator
    diff_step_model = DiffStepONNX(diff_estimator).eval()  # FP32, no .half()
    seq_len = 100
    xt_input = torch.randn(1, seq_len, MEL_DIM)  # FP32
    t = torch.tensor([0.5])  # FP32
    cond = torch.randn(1, seq_len, COND_DIM)  # FP32, 1024-dim cond_embedding
    xt_mask = torch.ones(1, seq_len)  # FP32
    export_fp32_opset20(
        diff_step_model, (xt_input, t, cond, xt_mask),
        os.path.join(args.output_dir, 'diff_step_dml.onnx'),
        input_names=['xt_input', 't', 'cond', 'xt_mask'],
        output_names=['flow_pred'],
        decompose_conv_transpose=False,
    )
    del diff_step_model
    clear_memory()

    # ---------------------------------------------------------------
    # 6. Print summary
    # ---------------------------------------------------------------
    print('\n[6/6] Summary')
    print(f'\nJP FP32 opset 20 export complete: {args.output_dir}')
    for fname in ['note_text_encoder.onnx', 'preflow.onnx', 'cond_emb.onnx', 'diff_step_dml.onnx']:
        fpath = os.path.join(args.output_dir, fname)
        if os.path.exists(fpath):
            size_mb = os.path.getsize(fpath) / 1024 / 1024
            data_path = fpath + '.data'
            data_mb = os.path.getsize(data_path) / 1024 / 1024 if os.path.exists(data_path) else 0.0
            print(f'  {fname}: {size_mb:.1f}MB + {data_mb:.1f}MB data')
        else:
            print(f'  {fname}: MISSING')

    del model
    clear_memory()
    print('\nDone.')


if __name__ == '__main__':
    main()
