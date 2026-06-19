# -*- coding: utf-8 -*-
"""
Compare FP32 vs W8A8 (INT8) model accuracy.

Loads each FP32 model from onnx_models/ and corresponding W8A8 model from
onnx_models/int8/optimized_npu/, runs both with the same random inputs,
and computes MSE, cosine similarity, and max absolute difference.
"""

import os
import sys
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
W8A8_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'int8')
FP32_DIR = os.path.join(SCRIPT_DIR, 'onnx_models')

# Model input specifications
SEQ_LEN = 2048
VOCODER_SEQ_LEN = 500
WAVEFORM_SAMPLES = 240000

MODEL_SPECS = [
    {
        'name': 'note_text_encoder',
        'fp32_file': 'note_text_encoder.onnx',
        'w8a8_file': 'note_text_encoder.onnx',
        'inputs': {'input_ids': ('int64', [1, SEQ_LEN])},
    },
    {
        'name': 'note_pitch_encoder',
        'fp32_file': 'note_pitch_encoder.onnx',
        'w8a8_file': 'note_pitch_encoder.onnx',
        'inputs': {'input_ids': ('int64', [1, SEQ_LEN])},
    },
    {
        'name': 'note_type_encoder',
        'fp32_file': 'note_type_encoder.onnx',
        'w8a8_file': 'note_type_encoder.onnx',
        'inputs': {'input_ids': ('int64', [1, SEQ_LEN])},
    },
    {
        'name': 'f0_encoder',
        'fp32_file': 'f0_encoder.onnx',
        'w8a8_file': 'f0_encoder.onnx',
        'inputs': {'input_ids': ('int64', [1, SEQ_LEN])},
    },
    {
        'name': 'preflow',
        'fp32_file': 'preflow.onnx',
        'w8a8_file': 'preflow.onnx',
        'inputs': {'features': ('float32', [1, SEQ_LEN, 512])},
    },
    {
        'name': 'cond_emb',
        'fp32_file': 'cond_emb.onnx',
        'w8a8_file': 'cond_emb.onnx',
        'inputs': {'cond_code': ('float32', [1, SEQ_LEN, 512])},
    },
    {
        'name': 'diff_step',
        'fp32_file': 'diff_step_dml.onnx',
        'w8a8_file': 'diff_step_dml.onnx',
        'inputs': {
            'xt_input': ('float32', [1, SEQ_LEN, 128]),
            't': ('float32', [1]),
            'cond': ('float32', [1, SEQ_LEN, 512]),
            'xt_mask': ('float32', [1, SEQ_LEN]),
        },
    },
    {
        'name': 'vocoder',
        'fp32_file': 'vocoder_dml.onnx',
        'w8a8_file': 'vocoder_dml.onnx',
        'inputs': {'mel': ('float32', [1, VOCODER_SEQ_LEN, 128])},
    },
    {
        'name': 'mel_transform',
        'fp32_file': 'mel_transform.onnx',
        'w8a8_file': 'mel_transform.onnx',
        'inputs': {'waveform': ('float32', [1, WAVEFORM_SAMPLES])},
    },
]


def make_feeds(inputs_spec):
    """Generate random inputs matching the spec."""
    feeds = {}
    for name, (dtype_str, shape) in inputs_spec.items():
        if dtype_str == 'int64':
            feeds[name] = np.random.randint(0, 255, size=shape).astype(np.int64)
        elif dtype_str == 'float32':
            feeds[name] = np.random.randn(*shape).astype(np.float32)
        elif dtype_str == 'float16':
            feeds[name] = np.random.randn(*shape).astype(np.float16)
    return feeds


def cosine_similarity(a, b):
    """Compute cosine similarity between two arrays."""
    a_flat = a.flatten().astype(np.float64)
    b_flat = b.flatten().astype(np.float64)
    dot = np.dot(a_flat, b_flat)
    norm_a = np.linalg.norm(a_flat)
    norm_b = np.linalg.norm(b_flat)
    if norm_a < 1e-12 or norm_b < 1e-12:
        return 0.0
    return dot / (norm_a * norm_b)


def find_model_file(base_dir, model_file):
    """Find model file, trying with and without .data extension."""
    path = os.path.join(base_dir, model_file)
    if os.path.exists(path):
        return path
    return None


def run_inference(model_path, feeds):
    """Run ONNX model inference. Returns dict of output_name -> numpy array."""
    import onnxruntime as ort
    sess = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
    outputs = sess.run(None, feeds)
    output_names = [o.name for o in sess.get_outputs()]
    result = {}
    for name, val in zip(output_names, outputs):
        if isinstance(val, np.ndarray):
            result[name] = val
    return result


def compare_model(spec, num_samples=5):
    """Compare FP32 vs W8A8 for a single model."""
    name = spec['name']
    fp32_file = spec['fp32_file']
    w8a8_file = spec['w8a8_file']
    inputs_spec = spec['inputs']

    fp32_path = find_model_file(FP32_DIR, fp32_file)
    w8a8_path = find_model_file(W8A8_DIR, w8a8_file)

    if fp32_path is None:
        return {'name': name, 'status': 'SKIP', 'reason': 'FP32 model not found'}
    if w8a8_path is None:
        return {'name': name, 'status': 'SKIP', 'reason': 'W8A8 model not found'}

    print(f"\n  {name}:")
    print(f"    FP32: {os.path.basename(fp32_path)}")
    print(f"    W8A8: {os.path.basename(w8a8_path)}")

    all_mse = []
    all_cosine = []
    all_max_diff = []

    for i in range(num_samples):
        feeds = make_feeds(inputs_spec)

        try:
            fp32_out = run_inference(fp32_path, feeds)
        except Exception as e:
            return {'name': name, 'status': 'FAIL', 'reason': f'FP32 inference error: {e}'}

        try:
            w8a8_out = run_inference(w8a8_path, feeds)
        except Exception as e:
            return {'name': name, 'status': 'FAIL', 'reason': f'W8A8 inference error: {e}'}

        # Compare outputs — only compare first output (primary tensor)
        fp32_vals = list(fp32_out.values())
        w8a8_vals = list(w8a8_out.values())
        if not fp32_vals or not w8a8_vals:
            continue
        fp32_val = fp32_vals[0]
        w8a8_val = w8a8_vals[0]

        # Handle shape mismatch (different ndims or sizes)
        if fp32_val.shape != w8a8_val.shape:
            # Truncate to common leading dimensions, squeeze extras
            ndim = min(fp32_val.ndim, w8a8_val.ndim)
            slices = tuple(slice(0, min(fp32_val.shape[d], w8a8_val.shape[d])) for d in range(ndim))
            fp32_val = fp32_val[slices]
            w8a8_val = w8a8_val[slices]
            # If one has more dims, take first slice to reduce
            while fp32_val.ndim > ndim:
                fp32_val = fp32_val[..., 0]
            while w8a8_val.ndim > ndim:
                w8a8_val = w8a8_val[..., 0]

        mse = float(np.mean((fp32_val.astype(np.float64) - w8a8_val.astype(np.float64)) ** 2))
        cos = cosine_similarity(fp32_val, w8a8_val)
        max_diff = float(np.max(np.abs(fp32_val.astype(np.float64) - w8a8_val.astype(np.float64))))

        all_mse.append(mse)
        all_cosine.append(cos)
        all_max_diff.append(max_diff)

    if not all_mse:
        return {'name': name, 'status': 'SKIP', 'reason': 'No outputs to compare'}

    avg_mse = np.mean(all_mse)
    avg_cosine = np.mean(all_cosine)
    avg_max_diff = np.mean(all_max_diff)

    print(f"    MSE:            {avg_mse:.6e}")
    print(f"    Cosine Sim:     {avg_cosine:.6f}")
    print(f"    Max Abs Diff:   {avg_max_diff:.6e}")

    quality = 'EXCELLENT' if avg_cosine > 0.99 else 'GOOD' if avg_cosine > 0.95 else 'FAIR' if avg_cosine > 0.9 else 'POOR'
    print(f"    Quality:        {quality}")

    return {
        'name': name,
        'status': 'OK',
        'mse': avg_mse,
        'cosine': avg_cosine,
        'max_diff': avg_max_diff,
        'quality': quality,
    }


def main():
    print("=" * 60)
    print("FP32 vs W8A8 Accuracy Comparison")
    print(f"FP32 dir: {FP32_DIR}")
    print(f"W8A8 dir: {W8A8_DIR}")
    print("=" * 60)

    if not os.path.exists(W8A8_DIR):
        print(f"\nW8A8 directory not found: {W8A8_DIR}")
        print("Run export_w8a8_npu.py first.")
        return 1

    results = []
    for spec in MODEL_SPECS:
        result = compare_model(spec, num_samples=5)
        results.append(result)

    # Summary table
    print(f"\n{'='*60}")
    print("Summary")
    print(f"{'='*60}")
    print(f"{'Model':<25} {'Status':<8} {'MSE':<14} {'Cosine':<10} {'MaxDiff':<14} {'Quality':<10}")
    print("-" * 80)
    for r in results:
        if r['status'] == 'OK':
            print(f"{r['name']:<25} {'OK':<8} {r['mse']:<14.6e} {r['cosine']:<10.6f} {r['max_diff']:<14.6e} {r['quality']:<10}")
        else:
            print(f"{r['name']:<25} {r['status']:<8} {'N/A':<14} {'N/A':<10} {'N/A':<14} {r.get('reason', '')[:20]}")

    ok_count = sum(1 for r in results if r['status'] == 'OK')
    print(f"\n{ok_count}/{len(results)} models compared successfully")

    return 0


if __name__ == '__main__':
    sys.exit(main())
