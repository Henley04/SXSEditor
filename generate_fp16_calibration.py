# -*- coding: utf-8 -*-
"""Generate calibration data for FP16 quantization (all 9 models).

Uses FP32 ONNX models as the reference (not PyTorch) for two reasons:
  1. The FP32 ONNX models are the comparison baseline per user request
     ("精度比较使用fp32onnx与fp16onnx比较")
  2. FP32 ONNX models load much faster than the 2.7GB PyTorch checkpoint

Strategy (self-calibration, no training data needed):
  1. Generate diverse inputs covering the full input space of each model:
     - Multiple sequence lengths (short/medium/long)
     - Multiple distributions (noise, realistic mel/audio, masks, IDs)
     - Deterministic seeded random for reproducibility
  2. Run FP32 ONNX model on DML -> save reference outputs
  3. Save calibration inputs + reference outputs per model

The saved reference outputs serve dual purpose:
  - Calibration reference for FP16 quantization (compare against)
  - Precision verification baseline (same as comparison baseline)

Output: calibrate/data/fp16_calib/<model_name>.npz
  Contains: sample{i}_input_{name}, sample{i}_output
"""
import os
import sys
import gc
import json
import time
import numpy as np
import onnx
import onnxruntime as ort

# Suppress ONNX Runtime warnings
os.environ['ORT_LOGGING_LEVEL'] = '3'
os.environ['ONNXRUNTIME_LOGGING_LEVEL'] = '3'

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = SCRIPT_DIR
FP32_DIR = os.path.join(PROJECT_DIR, 'onnx_models')  # FP32 production models
OUTPUT_DIR = os.path.join(PROJECT_DIR, 'calibrate', 'data', 'fp16_calib')

# Deterministic seed for reproducibility
SEED = 42

# Calibration samples per model (varied sequence lengths)
NUM_SAMPLES = 8


# ============================================================
# Input generators with breadth and generalization
# ============================================================

def gen_xt_input(shape, sample_idx, rng):
    """diff_step xt_input: [1, T, 128] - diffusion noisy mel state.
    Covers: pure noise (step 0), clear mel (step T), intermediate states.
    """
    T = shape[1]
    # Vary noise scale across samples: 0.1 (clear) to 3.0 (pure noise)
    noise_scale = 0.1 + 2.9 * (sample_idx / max(1, NUM_SAMPLES - 1))
    # Mix of structured signal + noise for breadth
    t_axis = np.linspace(0, 10, T, dtype=np.float32)
    signal = 0.3 * np.sin(2 * np.pi * 440 * t_axis / T * 10).reshape(1, T, 1)
    noise = rng.randn(*shape).astype(np.float32) * noise_scale
    return (signal + noise).astype(np.float32)


def gen_t(shape, sample_idx, rng):
    """diff_step t: [1] - diffusion timestep in [0, 1].
    Cover the full range evenly.
    """
    return np.array([sample_idx / max(1, NUM_SAMPLES - 1)], dtype=np.float32)


def gen_cond(shape, sample_idx, rng):
    """diff_step cond: [1, T, 1024] - condition embedding (already processed).
    Standard normal scaled to match typical embedding magnitudes.
    """
    return (rng.randn(*shape) * 0.5).astype(np.float32)


def gen_xt_mask(shape, sample_idx, rng):
    """diff_step xt_mask: [1, T] - attention mask.
    Vary mask patterns: all-ones, partial, random.
    """
    T = shape[1]
    if sample_idx % 4 == 0:
        # All ones (full mask)
        return np.ones(shape, dtype=np.float32)
    elif sample_idx % 4 == 1:
        # Partial mask (first 75%)
        mask = np.zeros(shape, dtype=np.float32)
        mask[:, :int(T * 0.75)] = 1.0
        return mask
    elif sample_idx % 4 == 2:
        # Partial mask (first 50%)
        mask = np.zeros(shape, dtype=np.float32)
        mask[:, :int(T * 0.5)] = 1.0
        return mask
    else:
        # Random mask
        return (rng.rand(*shape) > 0.2).astype(np.float32)


def gen_mel(shape, sample_idx, rng):
    """vocoder mel: [1, T, 128] - normalized mel spectrogram.
    Match real distribution: mean ~ -5, std ~ 2.85 (from config).
    Also include noise-like mel (diffusion step 0).
    """
    if sample_idx < NUM_SAMPLES // 3:
        # Clear mel (matched distribution)
        return (rng.randn(*shape) * 2.85 - 4.92).astype(np.float32)
    elif sample_idx < 2 * NUM_SAMPLES // 3:
        # Noise mel (diffusion step 0, N(0,1))
        return rng.randn(*shape).astype(np.float32)
    else:
        # Intermediate: clear + noise
        base = rng.randn(*shape) * 2.85 - 4.92
        noise = rng.randn(*shape) * (0.5 + 2.0 * (sample_idx / NUM_SAMPLES))
        return (base + noise).astype(np.float32)


def gen_features(shape, sample_idx, rng):
    """preflow features: [1, T, 512] - text encoder features.
    """
    return (rng.randn(*shape) * 0.5).astype(np.float32)


def gen_cond_code(shape, sample_idx, rng):
    """cond_emb cond_code: [1, T, 512] - condition code (continuous, pre-embedding).
    """
    return (rng.randn(*shape) * 0.3).astype(np.float32)


def gen_audio(shape, sample_idx, rng):
    """mel_transform audio: [1, num_samples] - raw waveform.
    Multi-harmonic signal + noise to cover spectral diversity.
    """
    n = shape[1]
    t = np.linspace(0, 10, n, dtype=np.float32)
    # Base frequency varies per sample for spectral diversity
    f0 = 110 + 220 * (sample_idx % 4)
    sig = 0.3 * np.sin(2 * np.pi * f0 * t)
    sig += 0.2 * np.sin(2 * np.pi * 2 * f0 * t)
    sig += 0.1 * np.sin(2 * np.pi * 3 * f0 * t)
    sig += 0.1 * rng.randn(n).astype(np.float32)
    return np.clip(sig, -1.0, 1.0).reshape(shape).astype(np.float32)


def gen_input_ids(shape, sample_idx, rng, vocab_size=200):
    """note_*_encoder / f0_encoder input_ids: [1, T] int64.
    Cover different ID ranges and patterns.
    """
    # Vary max ID per sample for breadth
    max_id = max(10, int(vocab_size * (0.2 + 0.8 * (sample_idx + 1) / NUM_SAMPLES)))
    return rng.randint(0, max_id, size=shape).astype(np.int64)


# ============================================================
# Model input specs (read from ONNX)
# ============================================================

def get_input_specs(model_path, model_name=''):
    """Read input names, shapes, dtypes from ONNX model."""
    is_vocoder = 'vocoder' in model_name.lower()
    is_mel = 'mel_transform' in model_name.lower()
    if is_vocoder:
        default_seq = 500
    elif is_mel:
        default_seq = 24000
    else:
        default_seq = 2048

    model = onnx.load(model_path, load_external_data=False)
    specs = []
    for inp in model.graph.input:
        shape = []
        for d in inp.type.tensor_type.shape.dim:
            if d.dim_value > 0:
                shape.append(d.dim_value)
            elif d.dim_param:
                name = d.dim_param.lower()
                if 'seq' in name or 'time' in name or 'frame' in name:
                    shape.append(default_seq)
                elif 'sample' in name:
                    shape.append(24000)
                elif 'batch' in name:
                    shape.append(1)
                else:
                    shape.append(default_seq)
            else:
                shape.append(1)
        elem_type = inp.type.tensor_type.elem_type
        specs.append({
            'name': inp.name,
            'shape': shape,
            'elem_type': elem_type,
        })
    del model
    return specs


def elem_type_to_np(elem_type):
    return {1: np.float32, 10: np.float16, 6: np.int32, 7: np.int64}.get(elem_type, np.float32)


# ============================================================
# Per-input generation dispatch
# ============================================================

def generate_input(inp_spec, sample_idx, rng, model_name=''):
    """Generate a single input array based on its spec and name."""
    name = inp_spec['name']
    shape = inp_spec['shape']
    name_lower = name.lower()
    np_type = elem_type_to_np(inp_spec['elem_type'])

    if np_type == np.int64:
        # Embedding lookup indices
        max_id = 200 if 'text' in name_lower else 256
        return rng.randint(0, max_id, size=shape).astype(np.int64)
    elif np_type == np.int32:
        return rng.randint(0, 200, size=shape).astype(np.int32)

    # Float inputs dispatched by name
    if name_lower == 'xt_input':
        return gen_xt_input(shape, sample_idx, rng)
    elif name_lower == 't':
        return gen_t(shape, sample_idx, rng)
    elif name_lower == 'cond':
        return gen_cond(shape, sample_idx, rng)
    elif name_lower == 'xt_mask':
        return gen_xt_mask(shape, sample_idx, rng)
    elif name_lower == 'mel':
        return gen_mel(shape, sample_idx, rng)
    elif name_lower == 'features':
        return gen_features(shape, sample_idx, rng)
    elif name_lower == 'cond_code':
        return gen_cond_code(shape, sample_idx, rng)
    elif name_lower in ('audio', 'waveform'):
        return gen_audio(shape, sample_idx, rng)
    elif 'input_ids' in name_lower:
        vocab_size = 200 if 'text' in model_name.lower() else 256
        return gen_input_ids(shape, sample_idx, rng, vocab_size)
    else:
        # Default: standard normal scaled down
        return (rng.randn(*shape) * 0.5).astype(np.float32)


# ============================================================
# Main calibration data generation
# ============================================================

# Models to calibrate (same 9 as export/quantize)
MODELS = [
    'diff_step_dml',
    'vocoder_dml',
    'preflow',
    'cond_emb',
    'mel_transform',
    'note_text_encoder',
    'note_pitch_encoder',
    'note_type_encoder',
    'f0_encoder',
]


def main():
    global NUM_SAMPLES
    import argparse
    parser = argparse.ArgumentParser(
        description='Generate FP16 calibration data for all 9 models (using FP32 ONNX as reference)'
    )
    parser.add_argument('--num-samples', type=int, default=NUM_SAMPLES,
                        help=f'Number of calibration samples per model (default: {NUM_SAMPLES})')
    parser.add_argument('--output-dir', default=OUTPUT_DIR,
                        help=f'Output directory (default: {OUTPUT_DIR})')
    parser.add_argument('--fp32-dir', default=FP32_DIR,
                        help=f'FP32 models directory (default: {FP32_DIR})')
    parser.add_argument('--provider', default='dml',
                        choices=['dml', 'cpu'],
                        help='ONNX Runtime provider (default: dml)')
    args = parser.parse_args()

    NUM_SAMPLES = args.num_samples
    os.makedirs(args.output_dir, exist_ok=True)

    provider = 'DmlExecutionProvider' if args.provider == 'dml' else 'CPUExecutionProvider'
    providers = [provider, 'CPUExecutionProvider']

    print("=" * 70)
    print("FP16 Calibration Data Generator (FP32 ONNX reference)")
    print(f"Provider: {provider}")
    print(f"Samples per model: {NUM_SAMPLES}, Seed: {SEED}")
    print(f"FP32 source: {args.fp32_dir}")
    print(f"Output: {args.output_dir}")
    print("=" * 70)

    summary = {}
    t_start = time.time()

    for model_name in MODELS:
        print(f"\n{'='*60}")
        print(f"  {model_name}")
        print(f"{'='*60}")

        fp32_path = os.path.join(args.fp32_dir, model_name + '.onnx')
        if not os.path.exists(fp32_path):
            print(f"  [SKIP] FP32 model not found: {fp32_path}")
            continue

        # Get input specs from ONNX model
        specs = get_input_specs(fp32_path, model_name)
        print(f"  Inputs: {[(s['name'], s['shape'], s['elem_type']) for s in specs]}")

        # Create DML session for FP32 reference
        print(f"  Loading FP32 model on {provider}...")
        try:
            sess = ort.InferenceSession(fp32_path, providers=providers)
        except Exception as e:
            print(f"  [FAIL] Failed to load FP32 model: {e}")
            continue

        # Generate samples
        save_data = {}
        successful = 0

        for sample_idx in range(NUM_SAMPLES):
            # Deterministic seed per (model, sample)
            name_hash = sum(ord(c) for c in model_name)
            rng = np.random.RandomState(SEED + sample_idx * 100 + name_hash % 1000)

            # Generate inputs
            feeds = {}
            for spec in specs:
                arr = generate_input(spec, sample_idx, rng, model_name=model_name)
                # Cast to spec dtype
                target_np = elem_type_to_np(spec['elem_type'])
                if arr.dtype != target_np:
                    arr = arr.astype(target_np)
                feeds[spec['name']] = arr

            # Run FP32 ONNX reference
            try:
                outputs = sess.run(None, feeds)
                output = outputs[0]
            except Exception as e:
                print(f"    Sample {sample_idx}: [FAIL] {str(e)[:150]}")
                continue

            # Save inputs and output
            for name, arr in feeds.items():
                save_data[f'sample{sample_idx}_input_{name}'] = arr
            save_data[f'sample{sample_idx}_output'] = output

            successful += 1
            print(f"    Sample {sample_idx}: OK, output shape={output.shape}, "
                  f"range=[{output.min():.4f}, {output.max():.4f}]")

        # Save .npz
        if successful > 0:
            save_path = os.path.join(args.output_dir, f'{model_name}.npz')
            np.savez(save_path, **save_data)
            summary[model_name] = {
                'num_samples': successful,
                'input_names': [s['name'] for s in specs],
                'input_shapes': [s['shape'] for s in specs],
                'file': save_path,
            }
            print(f"  Saved {successful} samples -> {save_path}")
        else:
            print(f"  [WARN] No valid samples for {model_name}")

        # Clean up session
        del sess
        gc.collect()

    # Save summary
    summary_path = os.path.join(args.output_dir, 'calibration_summary.json')
    with open(summary_path, 'w') as f:
        json.dump(summary, f, indent=2)

    elapsed = time.time() - t_start
    print(f"\n{'='*70}")
    print(f"Done. Calibration data for {len(summary)} models in {elapsed:.1f}s")
    print(f"Output: {args.output_dir}")
    print(f"Models: {list(summary.keys())}")
    print(f"{'='*70}")


if __name__ == '__main__':
    main()
