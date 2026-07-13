# -*- coding: utf-8 -*-
"""
Compare precision of W16A32, INT8 (W8A8), INT8-NPU against FP32 baseline.

For each model, runs all available variants with the same random inputs
(adapted to each variant's input dtype/dim) and computes:
  - MSE (mean squared error)
  - Cosine similarity
  - Max absolute difference
  - SNR (signal-to-noise ratio in dB)

Special handling:
  - W16A32 models expect FP16 inputs → cast from FP32 base
  - INT8 diff_step has cond=512 (includes cond_emb) while FP32 has cond=1024
    → use FP32 cond_emb to bridge: cond_code(512) → cond_emb → cond(1024) for FP32
  - Input name differences (e.g. mel_transform: "audio" vs "waveform") → match by position
"""
import os
import sys
import gc
import json
import numpy as np
import onnx
import onnxruntime as ort

# Suppress ONNX Runtime warnings
os.environ['ORT_LOGGING_LEVEL'] = '3'
os.environ['ONNXRUNTIME_LOGGING_LEVEL'] = '3'

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.join(SCRIPT_DIR, 'onnx_models')

VARIANTS = {
    'FP32':    BASE_DIR,
    'W16A32':  os.path.join(BASE_DIR, 'fp16'),
    'INT8':    os.path.join(BASE_DIR, 'int8'),
    'INT8-NPU':os.path.join(BASE_DIR, 'int8', 'optimized_npu'),
}

# Models to compare (excluding encoders which are trivial Embedding layers)
# diff_step INT8 has cond=512 (includes cond_emb); others have cond=1024
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
WAVEFORM_SAMPLES = 240000
SEED = 42


# ============================================================
# Helpers
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
                # Dynamic dim: assign default values
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
        # 1=FP32, 10=FP16, 6=INT32, 7=INT64
        specs.append({
            'name': inp.name,
            'shape': shape,
            'elem_type': elem_type,
        })
    del model
    return specs


def elem_type_to_np(elem_type):
    return {1: np.float32, 10: np.float16, 6: np.int32, 7: np.int64}.get(elem_type, np.float32)


def generate_base_input(spec, sample_idx):
    """Generate a single input tensor based on spec, using deterministic seed."""
    name_hash = sum(ord(c) for c in spec['name'])
    rng = np.random.RandomState(SEED + sample_idx * 100 + name_hash % 1000)
    shape = spec['shape']
    np_type = elem_type_to_np(spec['elem_type'])

    name_lower = spec['name'].lower()
    if np_type == np.int64:
        return rng.randint(0, 200, size=shape).astype(np.int64)
    elif np_type == np.int32:
        return rng.randint(0, 200, size=shape).astype(np.int32)
    elif np_type == np.float16:
        # Generate FP32 then cast to FP16 (simulates real FP16 input path)
        return _generate_float_input(name_lower, shape, rng).astype(np.float16)
    else:
        return _generate_float_input(name_lower, shape, rng).astype(np.float32)


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
        sig = 0.3 * np.sin(2 * np.pi * 220 * t)
        sig += 0.2 * np.sin(2 * np.pi * 440 * t)
        sig += 0.1 * rng.randn(n).astype(np.float32)
        return np.clip(sig, -1.0, 1.0).reshape(shape).astype(np.float32)
    # Default: standard normal scaled down
    return (rng.randn(*shape) * 0.5).astype(np.float32)


def make_feeds(specs, sample_idx):
    """Generate input dict for a model based on its specs."""
    feeds = {}
    for spec in specs:
        feeds[spec['name']] = generate_base_input(spec, sample_idx)
    return feeds


def adapt_feeds(feeds, target_specs, fp32_specs):
    """Adapt feeds from FP32 specs to target model specs.

    Handles:
    - Input name differences (match by position)
    - dtype differences (FP32 → FP16 cast)
    - Shape differences (cond 1024 → 512 for INT8 diff_step)
    """
    adapted = {}
    fp32_names = [s['name'] for s in fp32_specs]

    for i, tspec in enumerate(target_specs):
        if i < len(fp32_names):
            src_name = fp32_names[i]
        else:
            src_name = tspec['name']

        val = feeds.get(src_name)
        if val is None:
            # Fallback: generate from spec
            val = generate_base_input(tspec, 0)

        # Cast to target dtype
        target_np = elem_type_to_np(tspec['elem_type'])
        if val.dtype != target_np:
            val = val.astype(target_np)

        # Handle shape mismatches (e.g., cond 1024 → 512)
        target_shape = tspec['shape']
        if list(val.shape) != target_shape:
            # If last dim differs (e.g., 1024 vs 512), take first N elements
            if len(val.shape) == len(target_shape):
                slices = tuple(slice(0, min(val.shape[d], target_shape[d])) for d in range(len(target_shape)))
                val = val[slices]
                # Pad if needed
                pad_widths = [(0, max(0, target_shape[d] - val.shape[d])) for d in range(len(target_shape))]
                if any(p[1] > 0 for p in pad_widths):
                    val = np.pad(val, pad_widths, mode='constant')

        adapted[tspec['name']] = val
    return adapted


def run_inference(model_path, feeds):
    """Run ONNX inference on CPU. Returns first output as numpy array."""
    sess = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
    outputs = sess.run(None, feeds)
    result = outputs[0]
    del sess
    return result


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


def compare_model(model_name):
    """Compare all variants of a single model against FP32."""
    print(f"\n{'='*70}")
    print(f"Model: {model_name}")
    print(f"{'='*70}")

    # Find FP32 reference
    fp32_path = find_model(VARIANTS['FP32'], model_name)
    if fp32_path is None:
        print(f"  [SKIP] FP32 model not found")
        return None

    fp32_specs = get_input_specs(fp32_path, model_name)
    print(f"  FP32 inputs: {[(s['name'], s['shape'], s['elem_type']) for s in fp32_specs]}")

    # Find all variants
    variant_paths = {}
    variant_specs = {}
    for vname, vdir in VARIANTS.items():
        if vname == 'FP32':
            variant_paths[vname] = fp32_path
            variant_specs[vname] = fp32_specs
        else:
            path = find_model(vdir, model_name)
            if path:
                variant_paths[vname] = path
                variant_specs[vname] = get_input_specs(path, model_name)
                print(f"  {vname}: found ({os.path.getsize(path)/1e6:.1f} MB)")
            else:
                print(f"  {vname}: not found")

    # Run comparisons
    results = {}
    for sample_idx in range(NUM_SAMPLES):
        feeds = make_feeds(fp32_specs, sample_idx)

        # Run FP32 reference
        try:
            fp32_out = run_inference(fp32_path, feeds)
        except Exception as e:
            print(f"  [FAIL] FP32 inference error on sample {sample_idx}: {e}")
            return None

        # Compare each variant
        for vname in ['W16A32', 'INT8', 'INT8-NPU']:
            if vname not in variant_paths:
                continue

            adapted = adapt_feeds(feeds, variant_specs[vname], fp32_specs)
            try:
                v_out = run_inference(variant_paths[vname], adapted)
            except Exception as e:
                err_msg = str(e)[:120]
                print(f"  [FAIL] {vname} sample {sample_idx}: {err_msg}")
                results.setdefault(vname, {'status': 'FAIL', 'error': err_msg})
                continue

            # Compute metrics
            metrics = compute_metrics(fp32_out, v_out)
            results.setdefault(vname, {'status': 'OK', 'samples': []})
            if results[vname]['status'] == 'OK':
                results[vname]['samples'].append(metrics)

        gc.collect()

    # Average metrics
    print(f"\n  {'Variant':<12} {'Status':<8} {'MSE':<14} {'Cosine':<10} {'MaxDiff':<14} {'SNR(dB)':<10}")
    print(f"  {'-'*64}")
    for vname in ['W16A32', 'INT8', 'INT8-NPU']:
        if vname not in results:
            print(f"  {vname:<12} {'N/A':<8}")
            continue
        r = results[vname]
        if r['status'] != 'OK' or not r.get('samples'):
            print(f"  {vname:<12} {r['status']:<8} {r.get('error', '')[:40]}")
            continue
        samples = r['samples']
        avg_mse = np.mean([s['mse'] for s in samples])
        avg_cos = np.mean([s['cosine'] for s in samples])
        avg_max = np.mean([s['max_diff'] for s in samples])
        avg_snr = np.mean([s['snr_db'] for s in samples])
        quality = 'EXCELLENT' if avg_cos > 0.999 else 'GOOD' if avg_cos > 0.99 else 'FAIR' if avg_cos > 0.95 else 'POOR'
        print(f"  {vname:<12} {'OK':<8} {avg_mse:<14.6e} {avg_cos:<10.6f} {avg_max:<14.6e} {avg_snr:<10.2f} {quality}")
        results[vname]['avg'] = {
            'mse': float(avg_mse), 'cosine': float(avg_cos),
            'max_diff': float(avg_max), 'snr_db': float(avg_snr),
            'quality': quality,
        }

    # File sizes
    print(f"\n  File sizes:")
    for vname in ['FP32', 'W16A32', 'INT8', 'INT8-NPU']:
        if vname not in variant_paths:
            continue
        total_mb = 0
        onnx_path = variant_paths[vname]
        total_mb += os.path.getsize(onnx_path)
        data_path = onnx_path + '.data'
        if os.path.exists(data_path):
            total_mb += os.path.getsize(data_path)
        print(f"    {vname:<12} {total_mb/1e6:.1f} MB")
        if vname in results and results[vname].get('avg'):
            results[vname]['size_mb'] = total_mb / 1e6

    return results


def main():
    print("=" * 70)
    print("Precision Comparison: W16A32 / INT8 / INT8-NPU vs FP32")
    print(f"Samples per model: {NUM_SAMPLES}, Provider: CPU")
    print("=" * 70)

    all_results = {}
    for model_name in MODELS:
        try:
            result = compare_model(model_name)
            if result:
                all_results[model_name] = result
        except Exception as e:
            print(f"\n  [ERROR] {model_name}: {e}")
            import traceback
            traceback.print_exc()
        gc.collect()

    # Save JSON report
    report_path = os.path.join(SCRIPT_DIR, 'scripts', 'precision_comparison_all.json')
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(all_results, f, indent=2, ensure_ascii=False)
    print(f"\nReport saved to: {report_path}")

    # Final summary
    print(f"\n{'='*70}")
    print("FINAL SUMMARY")
    print(f"{'='*70}")
    print(f"{'Model':<25} {'Variant':<10} {'Cosine':<10} {'SNR(dB)':<10} {'Size(MB)':<10} {'Quality':<10}")
    print(f"{'-'*75}")
    for model_name, variants in all_results.items():
        for vname in ['W16A32', 'INT8', 'INT8-NPU']:
            if vname not in variants:
                continue
            r = variants[vname]
            if r.get('avg'):
                a = r['avg']
                size = r.get('size_mb', 0)
                print(f"{model_name:<25} {vname:<10} {a['cosine']:<10.6f} {a['snr_db']:<10.2f} {size:<10.1f} {a['quality']:<10}")
            elif r.get('status') == 'FAIL':
                print(f"{model_name:<25} {vname:<10} {'FAIL':<10} {'-':<10} {'-':<10} {r.get('error','')[:20]}")

    return 0


if __name__ == '__main__':
    sys.exit(main())
