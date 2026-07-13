# -*- coding: utf-8 -*-
"""Compare precision of FP16 variants against FP32 baseline on DML.

Compares 4 variants using the SAME random inputs (deterministic seed):
  - FP32    : onnx_models/                    (baseline, opset 20)
  - W16A32  : onnx_models/fp16_w16a32/         (FP16 weights, FP32 activations)
  - TrueFP16: onnx_models/fp16_true/           (FP16 weights + activations)
  - BackupFP16: onnx_models/fp16_backup/      (original FP16 backup, mixed opsets)

All inference runs on DirectML (GPU). For each model and variant:
  - cosine similarity vs FP32 baseline
  - SNR (dB) vs FP32 baseline
  - max abs diff, MSE

Random data is identical across all 4 variants (cast to FP16 when needed).
Differences come only from the model, not from input data.
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
BASE_DIR = os.path.join(SCRIPT_DIR, 'onnx_models')

VARIANTS = {
    'FP32':       BASE_DIR,
    'W16A32':     os.path.join(BASE_DIR, 'fp16_w16a32'),
    'TrueFP16':   os.path.join(BASE_DIR, 'fp16_true'),
    'BackupFP16': os.path.join(BASE_DIR, 'fp16_backup'),
}

# Models to compare (all 9)
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

NUM_SAMPLES = 5
SEQ_LEN = 2048
VOCODER_SEQ_LEN = 500
WAVEFORM_SAMPLES = 24000
SEED = 42


# ============================================================
# Input spec helpers
# ============================================================

def get_input_specs(model_path, model_name=''):
    """Read input names, shapes, dtypes from ONNX model."""
    is_vocoder = 'vocoder' in model_name.lower()
    default_seq = VOCODER_SEQ_LEN if is_vocoder else SEQ_LEN
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
                    shape.append(WAVEFORM_SAMPLES)
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


def _generate_float_input(name_lower, shape, rng):
    """Generate realistic float32 input based on input name."""
    if 'input_ids' in name_lower:
        return rng.randint(0, 200, size=shape).astype(np.float32)
    if name_lower == 't':
        return rng.uniform(0, 1, size=shape).astype(np.float32)
    if 'mask' in name_lower:
        return np.ones(shape, dtype=np.float32)
    if 'waveform' in name_lower or 'audio' in name_lower:
        n = shape[-1]
        t = np.linspace(0, 10, n, dtype=np.float32)
        f0 = 110 + 220 * (rng.randint(0, 4))
        sig = 0.3 * np.sin(2 * np.pi * f0 * t)
        sig += 0.2 * np.sin(2 * np.pi * 2 * f0 * t)
        sig += 0.1 * rng.randn(n).astype(np.float32)
        return np.clip(sig, -1.0, 1.0).reshape(shape).astype(np.float32)
    if 'mel' in name_lower:
        return (rng.randn(*shape) * 2.85 - 4.92).astype(np.float32)
    # Default: standard normal scaled down
    return (rng.randn(*shape) * 0.5).astype(np.float32)


def generate_base_input(spec, sample_idx):
    """Generate a single input tensor based on spec, using deterministic seed."""
    name_hash = sum(ord(c) for c in spec['name'])
    rng = np.random.RandomState(SEED + sample_idx * 100 + name_hash % 1000)
    shape = spec['shape']
    np_type = elem_type_to_np(spec['elem_type'])
    name_lower = spec['name'].lower()

    if np_type == np.int64:
        max_id = 200 if 'text' in name_lower else 256
        return rng.randint(0, max_id, size=shape).astype(np.int64)
    elif np_type == np.int32:
        return rng.randint(0, 200, size=shape).astype(np.int32)
    elif np_type == np.float16:
        return _generate_float_input(name_lower, shape, rng).astype(np.float16)
    else:
        return _generate_float_input(name_lower, shape, rng).astype(np.float32)


def make_feeds(specs, sample_idx):
    """Generate input dict for a model based on its specs.

    For float inputs, always generate as FP32 for consistency, then cast per-variant.
    For integer inputs (int64/int32), keep the original type (embeddings expect int64).
    """
    feeds = {}
    for spec in specs:
        if spec['elem_type'] in (6, 7):  # INT32, INT64 - keep as-is
            feeds[spec['name']] = generate_base_input(spec, sample_idx)
        else:
            # Float: generate as FP32 for consistency, cast per-variant later
            base_spec = dict(spec)
            base_spec['elem_type'] = 1  # FP32
            feeds[spec['name']] = generate_base_input(base_spec, sample_idx)
    return feeds


def adapt_feeds(feeds, target_specs):
    """Adapt feeds (FP32) to target model specs (cast to target dtype)."""
    adapted = {}
    src_names = list(feeds.keys())
    for i, tspec in enumerate(target_specs):
        # Match by name first, fallback to position
        if tspec['name'] in feeds:
            val = feeds[tspec['name']]
        elif i < len(src_names):
            val = feeds[src_names[i]]
        else:
            val = generate_base_input(tspec, 0)

        # Cast to target dtype
        target_np = elem_type_to_np(tspec['elem_type'])
        if val.dtype != target_np:
            val = val.astype(target_np)
        adapted[tspec['name']] = val
    return adapted


# ============================================================
# DML Inference
# ============================================================

# Cache DML session to avoid reloading for each sample
_session_cache = {}


def get_dml_session(model_path):
    """Get or create a cached DML InferenceSession."""
    if model_path not in _session_cache:
        # Use DML execution provider for GPU acceleration
        sess = ort.InferenceSession(
            model_path,
            providers=['DmlExecutionProvider', 'CPUExecutionProvider'],
        )
        _session_cache[model_path] = sess
    return _session_cache[model_path]


def run_inference_dml(model_path, feeds):
    """Run ONNX inference on DML (GPU). Returns first output as numpy array."""
    sess = get_dml_session(model_path)
    outputs = sess.run(None, feeds)
    return outputs[0]


def compute_metrics(ref, test):
    """Compute MSE, cosine similarity, max diff, SNR."""
    ref = ref.flatten().astype(np.float64)
    test = test.flatten().astype(np.float64)
    n = min(len(ref), len(test))
    ref, test = ref[:n], test[:n]

    diff = ref - test
    mse = float(np.mean(diff ** 2))
    max_diff = float(np.max(np.abs(diff)))

    norm_ref = np.linalg.norm(ref)
    norm_test = np.linalg.norm(test)
    if norm_ref < 1e-12 and norm_test < 1e-12:
        cos = 1.0
    elif norm_ref < 1e-12 or norm_test < 1e-12:
        cos = 0.0
    else:
        cos = float(np.dot(ref, test) / (norm_ref * norm_test))

    signal_power = float(np.mean(ref ** 2))
    noise_power = float(np.mean(diff ** 2))
    if noise_power < 1e-20:
        snr = 999.0
    else:
        snr = 10 * np.log10(signal_power / noise_power)

    return {
        'mse': mse,
        'cosine': cos,
        'max_diff': max_diff,
        'snr_db': snr,
    }


def find_model(variant_dir, model_name):
    """Find model file in variant directory."""
    path = os.path.join(variant_dir, model_name + '.onnx')
    if os.path.exists(path):
        return path
    return None


# ============================================================
# Comparison per model
# ============================================================

def compare_model(model_name, output_dir=None, num_samples=None):
    """Compare all variants of a single model against FP32 baseline on DML.

    Returns:
      {
        'model': model_name,
        'variants_found': [list of variants],
        'results': {
          'W16A32':     {'samples': [...], 'avg': {...}},
          'TrueFP16':   {...},
          'BackupFP16': {...},
        },
        'fp32_inputs': [...],
      }
    """
    if num_samples is None:
        num_samples = NUM_SAMPLES

    print(f"\n{'='*70}")
    print(f"Model: {model_name}")
    print(f"{'='*70}")

    # Find FP32 reference (baseline)
    fp32_path = find_model(VARIANTS['FP32'], model_name)
    if fp32_path is None:
        print(f"  [SKIP] FP32 model not found at {VARIANTS['FP32']}")
        return None

    fp32_specs = get_input_specs(fp32_path, model_name)
    print(f"  FP32 inputs: {[(s['name'], s['shape'], s['elem_type']) for s in fp32_specs]}")

    # Find all variants
    variant_paths = {}
    variant_specs = {}
    for vname, vdir in VARIANTS.items():
        path = find_model(vdir, model_name)
        if path:
            sz_mb = os.path.getsize(path) / 1e6
            data_file = path + '.data'
            if os.path.exists(data_file):
                sz_mb += os.path.getsize(data_file) / 1e6
            variant_paths[vname] = path
            variant_specs[vname] = get_input_specs(path, model_name)
            print(f"  {vname}: found ({sz_mb:.1f} MB)")
        else:
            print(f"  {vname}: not found")

    if not any(v in variant_paths for v in ['W16A32', 'TrueFP16', 'BackupFP16']):
        print(f"  [SKIP] No FP16 variants found")
        return None

    # Build comparison variants (skip FP32 - it's the baseline)
    compare_variants = ['W16A32', 'TrueFP16', 'BackupFP16']

    # Run comparisons per sample
    results = {v: {'samples': [], 'errors': []} for v in compare_variants}

    for sample_idx in range(num_samples):
        # Generate SAME FP32 inputs (base for all variants)
        feeds_fp32 = make_feeds(fp32_specs, sample_idx)

        # Run FP32 baseline
        try:
            fp32_out = run_inference_dml(fp32_path, feeds_fp32)
            print(f"  Sample {sample_idx}: FP32 output shape={fp32_out.shape}, "
                  f"range=[{fp32_out.min():.4f}, {fp32_out.max():.4f}]")
        except Exception as e:
            err_msg = str(e)[:200]
            print(f"  [FAIL] FP32 inference on sample {sample_idx}: {err_msg}")
            for v in compare_variants:
                results[v]['errors'].append(f'sample{sample_idx}: FP32 failed - {err_msg}')
            continue

        # Compare each FP16 variant
        for vname in compare_variants:
            if vname not in variant_paths:
                continue

            # Adapt inputs: cast to target dtype (FP16 if model expects FP16)
            adapted = adapt_feeds(feeds_fp32, variant_specs[vname])

            try:
                v_out = run_inference_dml(variant_paths[vname], adapted)
                metrics = compute_metrics(fp32_out, v_out)
                results[vname]['samples'].append({
                    'sample_idx': sample_idx,
                    'cosine': metrics['cosine'],
                    'snr_db': metrics['snr_db'],
                    'mse': metrics['mse'],
                    'max_diff': metrics['max_diff'],
                })
                print(f"    {vname:<12}: cos={metrics['cosine']:.8f}  "
                      f"snr={metrics['snr_db']:.4f} dB  "
                      f"max_diff={metrics['max_diff']:.6f}")
            except Exception as e:
                err_msg = str(e)[:200]
                print(f"    {vname:<12}: [FAIL] {err_msg}")
                results[vname]['errors'].append(f'sample{sample_idx}: {err_msg}')

    # Compute averages
    for vname in compare_variants:
        samples = results[vname]['samples']
        if samples:
            results[vname]['avg'] = {
                'cosine': float(np.mean([s['cosine'] for s in samples])),
                'snr_db': float(np.mean([s['snr_db'] for s in samples])),
                'mse': float(np.mean([s['mse'] for s in samples])),
                'max_diff': float(np.mean([s['max_diff'] for s in samples])),
                'num_ok': len(samples),
            }
            avg = results[vname]['avg']
            print(f"\n  {vname} AVG (n={avg['num_ok']}): cos={avg['cosine']:.8f}  "
                  f"snr={avg['snr_db']:.4f} dB  max_diff={avg['max_diff']:.6f}")
        else:
            results[vname]['avg'] = None
            print(f"\n  {vname} AVG: N/A (no successful samples)")

    # Clear cached sessions for this model
    for v in compare_variants:
        if v in variant_paths:
            if variant_paths[v] in _session_cache:
                del _session_cache[variant_paths[v]]
                gc.collect()
    if fp32_path in _session_cache:
        del _session_cache[fp32_path]
        gc.collect()

    return {
        'model': model_name,
        'variants_found': list(variant_paths.keys()),
        'results': results,
        'fp32_inputs': [(s['name'], s['shape'], s['elem_type']) for s in fp32_specs],
    }


# ============================================================
# Main
# ============================================================

def main():
    import argparse
    parser = argparse.ArgumentParser(
        description='Compare FP16 variants (W16A32, TrueFP16, BackupFP16) vs FP32 on DML'
    )
    parser.add_argument('--models', nargs='+', default=MODELS,
                        help='Models to compare (default: all 9)')
    parser.add_argument('--num-samples', type=int, default=NUM_SAMPLES,
                        help=f'Number of samples per model (default: {NUM_SAMPLES})')
    parser.add_argument('--output-dir', default=SCRIPT_DIR,
                        help='Output directory for report (default: script dir)')
    parser.add_argument('--variants', nargs='+',
                        default=['W16A32', 'TrueFP16', 'BackupFP16'],
                        help='Variants to compare (default: all 3)')
    args = parser.parse_args()

    # Update module-level NUM_SAMPLES (no global needed since we only read it elsewhere)
    num_samples = args.num_samples

    print("=" * 70)
    print("FP16 Precision Comparison (DML Backend)")
    print(f"Models: {args.models}")
    print(f"Variants: {args.variants}")
    print(f"Samples per model: {num_samples}")
    print(f"Seed: {SEED}")
    print("=" * 70)

    t_start = time.time()

    all_results = {}
    for model_name in args.models:
        try:
            result = compare_model(model_name, num_samples=num_samples)
            if result is not None:
                all_results[model_name] = result
        except Exception as e:
            print(f"\n[ERROR] Failed for {model_name}: {e}")
            import traceback
            traceback.print_exc()

    # Build summary table
    print(f"\n\n{'='*90}")
    print("SUMMARY: FP16 Variants vs FP32 Baseline (DML)")
    print(f"{'='*90}")
    print(f"{'Model':<25} {'Variant':<12} {'Cosine':<14} {'SNR (dB)':<12} {'MaxDiff':<12} {'N':<4}")
    print(f"{'-'*90}")

    for model_name, res in all_results.items():
        for vname in args.variants:
            if vname not in res['results']:
                continue
            avg = res['results'][vname].get('avg')
            if avg is None:
                print(f"{model_name:<25} {vname:<12} {'N/A':<14} {'N/A':<12} {'N/A':<12} {0:<4}")
            else:
                print(f"{model_name:<25} {vname:<12} "
                      f"{avg['cosine']:<14.8f} "
                      f"{avg['snr_db']:<12.4f} "
                      f"{avg['max_diff']:<12.6f} "
                      f"{avg['num_ok']:<4}")

    # Save JSON report
    report_path = os.path.join(args.output_dir, 'fp16_precision_comparison.json')
    with open(report_path, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"\nReport saved: {report_path}")

    # Also save CSV summary
    csv_path = os.path.join(args.output_dir, 'fp16_precision_comparison.csv')
    with open(csv_path, 'w') as f:
        f.write('Model,Variant,Cosine,SNR_dB,MaxDiff,MSE,NumOK\n')
        for model_name, res in all_results.items():
            for vname in args.variants:
                if vname not in res['results']:
                    continue
                avg = res['results'][vname].get('avg')
                if avg is None:
                    f.write(f'{model_name},{vname},N/A,N/A,N/A,N/A,0\n')
                else:
                    f.write(f"{model_name},{vname},{avg['cosine']:.8f},"
                            f"{avg['snr_db']:.4f},{avg['max_diff']:.6f},"
                            f"{avg['mse']:.6e},{avg['num_ok']}\n")
    print(f"CSV saved: {csv_path}")

    elapsed = time.time() - t_start
    print(f"\nTotal time: {elapsed:.1f}s")


if __name__ == '__main__':
    main()
