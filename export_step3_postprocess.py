# -*- coding: utf-8 -*-
"""Step 3: Export 7 additional FP32 opset 20 ONNX models to onnx_models/ root.

Exports: note_text_encoder, note_pitch_encoder, note_type_encoder, f0_encoder,
preflow, cond_emb, mel_transform — all FP32 opset 20, post-processed for DML.
"""
import argparse
import os

import torch
import torch.nn as nn

from export_shared import (
    load_config,
    load_model,
    FP32_OUTPUT_DIR,
    export_fp32_opset20,
    clear_memory,
)


# ============================================================
# Wrapper classes
# ============================================================

class EmbeddingWrapper(nn.Module):
    """Wrap nn.Embedding for ONNX export."""

    def __init__(self, embedding):
        super().__init__()
        self.embedding = embedding

    def forward(self, input_ids):
        return self.embedding(input_ids)


class PreflowWrapper(nn.Module):
    """Wrap preflow (nn.Sequential of ConvNeXtV2Block)."""

    def __init__(self, preflow):
        super().__init__()
        self.preflow = preflow

    def forward(self, features):
        return self.preflow(features)


class CondEmbWrapper(nn.Module):
    """Wrap cfm_decoder.model.cond_emb.

    cond_emb may be nn.Embedding (use_embedding=True) or nn.Linear
    (use_embedding=False). The actual type is checked at runtime to build
    the correct dummy input.
    """

    def __init__(self, cond_emb):
        super().__init__()
        self.cond_emb = cond_emb

    def forward(self, cond_code):
        return self.cond_emb(cond_code)


class MelTransformWrapper(nn.Module):
    """Wrap MelSpectrogramEncoder."""

    def __init__(self, mel):
        super().__init__()
        self.mel = mel

    def forward(self, audio):
        return self.mel(audio)


# ============================================================
# Export helper
# ============================================================

def export_model(wrapper, args_tuple, output_path, input_names, output_names, dynamic_axes=None, dynamic_shapes=None, skip_stft_replace=False):
    print(f"\n  Exporting: {os.path.basename(output_path)}")
    if dynamic_axes:
        print(f"    dynamic_axes: {dynamic_axes}")
    if dynamic_shapes:
        print(f"    dynamic_shapes: {dynamic_shapes}")
    if skip_stft_replace:
        print(f"    skip_stft_replace: True (native STFT preserved)")
    export_fp32_opset20(
        wrapper,
        args_tuple,
        output_path,
        input_names=input_names,
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        dynamic_shapes=dynamic_shapes,
        decompose_conv_transpose=False,
        fix_mixed_precision=False,
        skip_stft_replace=skip_stft_replace,
    )


# ============================================================
# Main
# ============================================================

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL_PATH = os.path.join(
    SCRIPT_DIR, 'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt'
)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Export 7 additional FP32 opset 20 ONNX models "
        "(encoders, preflow, cond_emb, mel_transform)"
    )
    parser.add_argument(
        '--output-dir',
        default=FP32_OUTPUT_DIR,
        help=f"Output directory (default: {FP32_OUTPUT_DIR})",
    )
    parser.add_argument(
        '--model-path',
        default=DEFAULT_MODEL_PATH,
        help="Path to SoulX-Singer checkpoint",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    os.makedirs(args.output_dir, exist_ok=True)

    print("Step 3: Export 7 additional FP32 opset 20 ONNX models")
    print(f"  Output dir: {args.output_dir}")
    print(f"  Model path: {args.model_path}")

    config = load_config()
    model = load_model(config, args.model_path)

    enc_cfg = config.model.encoder
    cfm_cfg = config.model.flow_matching
    audio_cfg = config.audio

    vocab_size = enc_cfg.vocab_size
    f0_bin = enc_cfg.f0_bin
    text_dim = enc_cfg.text_dim
    cond_codebook_size = cfm_cfg.cond_codebook_size
    hidden_size = cfm_cfg.hidden_size
    sample_rate = audio_cfg.sample_rate

    print(f"  vocab_size={vocab_size}, f0_bin={f0_bin}, text_dim={text_dim}")
    print(f"  cond_codebook_size={cond_codebook_size}, hidden_size={hidden_size}")
    print(f"  sample_rate={sample_rate}")

    exported = []

    # 1. note_text_encoder (nn.Embedding(vocab_size, text_dim))
    export_model(
        EmbeddingWrapper(model.note_text_encoder),
        (torch.randint(0, vocab_size, (1, 100), dtype=torch.long),),
        os.path.join(args.output_dir, 'note_text_encoder.onnx'),
        ['input_ids'],
        ['embeddings'],
        dynamic_axes={'input_ids': {1: 'seq_len'}, 'embeddings': {1: 'seq_len'}},
    )
    exported.append('note_text_encoder.onnx')
    clear_memory()

    # 2. note_pitch_encoder (nn.Embedding(256, pitch_dim))
    export_model(
        EmbeddingWrapper(model.note_pitch_encoder),
        (torch.randint(0, 256, (1, 100), dtype=torch.long),),
        os.path.join(args.output_dir, 'note_pitch_encoder.onnx'),
        ['input_ids'],
        ['embeddings'],
        dynamic_axes={'input_ids': {1: 'seq_len'}, 'embeddings': {1: 'seq_len'}},
    )
    exported.append('note_pitch_encoder.onnx')
    clear_memory()

    # 3. note_type_encoder (nn.Embedding(256, type_dim))
    export_model(
        EmbeddingWrapper(model.note_type_encoder),
        (torch.randint(0, 256, (1, 100), dtype=torch.long),),
        os.path.join(args.output_dir, 'note_type_encoder.onnx'),
        ['input_ids'],
        ['embeddings'],
        dynamic_axes={'input_ids': {1: 'seq_len'}, 'embeddings': {1: 'seq_len'}},
    )
    exported.append('note_type_encoder.onnx')
    clear_memory()

    # 4. f0_encoder (nn.Embedding(f0_bin, f0_dim))
    export_model(
        EmbeddingWrapper(model.f0_encoder),
        (torch.randint(0, f0_bin, (1, 200), dtype=torch.long),),
        os.path.join(args.output_dir, 'f0_encoder.onnx'),
        ['input_ids'],
        ['embeddings'],
        dynamic_axes={'input_ids': {1: 'seq_len'}, 'embeddings': {1: 'seq_len'}},
    )
    exported.append('f0_encoder.onnx')
    clear_memory()

    # 5. preflow (nn.Sequential of ConvNeXtV2Block, preserves text_dim)
    export_model(
        PreflowWrapper(model.preflow),
        (torch.randn(1, 100, text_dim),),
        os.path.join(args.output_dir, 'preflow.onnx'),
        ['features'],
        ['processed_features'],
        dynamic_axes={'features': {1: 'seq_len'}, 'processed_features': {1: 'seq_len'}},
    )
    exported.append('preflow.onnx')
    clear_memory()

    # 6. cond_emb (nn.Embedding or nn.Linear, check at runtime)
    cond_emb = model.cfm_decoder.model.cond_emb
    if isinstance(cond_emb, nn.Embedding):
        print(f"  cond_emb is nn.Embedding({cond_codebook_size}, {hidden_size})")
        cond_input = (
            torch.randint(0, cond_codebook_size, (1, 100), dtype=torch.long),
        )
    else:
        print(
            f"  cond_emb is {type(cond_emb).__name__}"
            f"({cond_codebook_size}, {hidden_size})"
        )
        cond_input = (torch.randn(1, 100, cond_codebook_size),)
    export_model(
        CondEmbWrapper(cond_emb),
        cond_input,
        os.path.join(args.output_dir, 'cond_emb.onnx'),
        ['cond_code'],
        ['cond_embedding'],
        dynamic_axes={'cond_code': {1: 'seq_len'}, 'cond_embedding': {1: 'seq_len'}},
    )
    exported.append('cond_emb.onnx')
    clear_memory()

    # 7. mel_transform (MelSpectrogramEncoder)
    #    Use native STFT operator with dynamic shapes for reference mel extraction
    #    (skip Cooley-Tukey DFT replacement to support variable audio length)
    #    Needs dynamo=True to handle complex STFT (requires torch.export)
    from torch.export import Dim
    len_dim = Dim('num_samples', min=1, max=1000000)
    export_model(
        MelTransformWrapper(model.mel),
        (torch.randn(1, sample_rate),),
        os.path.join(args.output_dir, 'mel_transform.onnx'),
        ['audio'],
        ['mel'],
        dynamic_shapes={
            'audio': {1: len_dim},
        },
        skip_stft_replace=True,
    )
    exported.append('mel_transform.onnx')
    clear_memory()

    del model
    clear_memory()

    print("\n  Done. Exported 7 models to:", args.output_dir)
    for name in exported:
        print(f"    - {name}")


if __name__ == '__main__':
    main()
