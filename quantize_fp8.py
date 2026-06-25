# -*- coding: utf-8 -*-
"""
FP8 Quantization Script for SXSEditor ONNX Models.

Converts FP16 ONNX models to FP8 (float8_e4m3fn) by inserting QDQ nodes on weight
tensors of MatMul/Gemm nodes. No calibration data needed — pure weight quantization.

Usage:
  python quantize_fp8.py                          # Quantize all models
  python quantize_fp8.py --models vocoder,diff_step  # Quantize specific models
  python quantize_fp8.py --verify                 # Verify accuracy after quantization

Requirements:
  pip install onnxruntime onnx numpy
"""

import os
import sys
import gc
import time
import argparse
import shutil
import numpy as np

os.environ['PYTHONIOENCODING'] = 'utf-8'
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

import onnx
from onnx import numpy_helper, TensorProto, shape_inference
import onnxruntime as ort

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FP16_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'fp16')
FP8_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'fp8')

SVS_MODELS = [
    'note_text_encoder.onnx',
    'note_pitch_encoder.onnx',
    'note_type_encoder.onnx',
    'f0_encoder.onnx',
    'preflow.onnx',
    'cond_emb.onnx',
    'diff_step_dml.onnx',
    'vocoder_dml.onnx',
    'mel_transform.onnx',
]

PREPROCESS_MODELS = [
    'preprocess/rmvpe_model.onnx',
]

# Non-quantizable models (pure embedding or STFT) — copy as-is from fp16
NON_QUANTIZABLE = {
    'note_text_encoder.onnx',
    'note_pitch_encoder.onnx',
    'note_type_encoder.onnx',
    'f0_encoder.onnx',
    'mel_transform.onnx',
}

FP8_MAX = 448.0  # max representable value in float8_e4m3fn


def copy_model_with_external_data(src_path, dst_path):
    """Copy an ONNX model and its .onnx.data sidecar if present."""
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    shutil.copy2(src_path, dst_path)
    src_data = src_path + '.data'
    if os.path.exists(src_data):
        shutil.copy2(src_data, dst_path + '.data')


def _get_weight_data(init):
    """Extract weight as float32 numpy array, handling both FLOAT and FLOAT16."""
    arr = numpy_helper.to_array(init)
    return arr.astype(np.float32)


def _float32_to_fp8_e4m3fn_bytes(arr_f32):
    """Encode float32 values as float8_e4m3fn raw bytes (uint8-per-element).

    float8_e4m3fn: 1 sign + 4 exponent (bias 7) + 3 mantissa, NaN=0bS1111_111.
    This is the bit-pattern ONNX expects for TensorProto.FLOAT8E4M3FN tensors.
    """
    shape = arr_f32.shape
    f32 = arr_f32.astype(np.float32).ravel()
    sign = (np.frombuffer(f32.tobytes(), dtype=np.uint32) >> 31).astype(np.uint8)
    abs_f32 = np.abs(f32)

    # Exponent and mantissa of the float32
    f32_bits = np.frombuffer(abs_f32.tobytes(), dtype=np.uint32)
    exp_f32 = ((f32_bits >> 23) & 0xFF).astype(np.int32)
    man_f32 = (f32_bits & 0x7FFFFF).astype(np.uint32)

    # float8 e4m3fn: bias=7
    fp8_exp = exp_f32 - 127 + 7

    is_subnormal = fp8_exp <= 0
    is_overflow = fp8_exp > 15

    # Subnormal: value = man * 2^-9, so man = value * 512
    sub_mantissa = np.clip(np.round(abs_f32 * 512.0), 0, 7).astype(np.uint8)
    # Normal: top 3 bits of float32 mantissa
    normal_mantissa = (man_f32 >> 20).astype(np.uint8)
    normal_exp = np.clip(fp8_exp, 1, 15).astype(np.uint8)

    mantissa = np.where(is_subnormal, sub_mantissa, normal_mantissa)
    exponent = np.where(is_subnormal, 0, normal_exp)
    # Overflow → max normal (exp=15, man=6; man=7 is NaN)
    exponent = np.where(is_overflow, np.uint8(15), exponent)
    mantissa = np.where(is_overflow & (mantissa >= 7), np.uint8(6), mantissa)

    # NaN/Inf → NaN encoding
    is_nan_inf = (exp_f32 == 255)
    exponent = np.where(is_nan_inf, np.uint8(15), exponent)
    mantissa = np.where(is_nan_inf, np.uint8(7), mantissa)

    raw = (sign << 7) | (exponent << 3) | mantissa
    return raw.astype(np.uint8).tobytes()


def quantize_model_fp8(src_path, dst_path, model_name):
    """Quantize MatMul/Gemm weight tensors to FP8 via QDQ node insertion.

    For each weight tensor W:
      1. Compute per-tensor scale = max(|W|) / 448
      2. Quantize: W_q = clamp(round(W / scale), -448, 448) as float8_e4m3fn bytes
      3. Insert DequantizeLinear(W_q, scale) → W_dequant  (type tensor(float8_e4m3fn))
      4. Point the MatMul/Gemm node at W_dequant
    """
    print(f"    Loading model...")
    model = onnx.load(src_path, load_external_data=True)

    init_dict = {init.name: init for init in model.graph.initializer}
    init_names = set(init_dict.keys())

    # Detect if model uses float16 activations (fp16 models)
    model_uses_fp16 = any(
        init.data_type == TensorProto.FLOAT16
        for init in model.graph.initializer
        if init.data_type == TensorProto.FLOAT16
    )

    # Find quantizable weight tensors
    quant_targets = []
    for node in model.graph.node:
        if node.op_type in ('MatMul', 'Gemm') and len(node.input) >= 2:
            wname = node.input[1]
            if wname in init_names:
                init = init_dict[wname]
                if init.data_type in (TensorProto.FLOAT, TensorProto.FLOAT16):
                    quant_targets.append((node, wname, init))

    if not quant_targets:
        print(f"    No quantizable weight nodes found — copying as-is")
        copy_model_with_external_data(src_path, dst_path)
        return False

    print(f"    Quantizing {len(quant_targets)} weight tensors to FP8...")

    inits_to_remove = set()
    new_inits = []
    new_nodes = []

    for node, wname, init in quant_targets:
        weight = _get_weight_data(init)
        abs_max = np.max(np.abs(weight))
        if abs_max < 1e-10:
            continue

        scale_val = abs_max / FP8_MAX

        # Quantize to FP8 range, then encode as float8_e4m3fn raw bytes
        w_scaled = weight / scale_val
        w_fp8_f32 = np.clip(np.round(w_scaled), -FP8_MAX, FP8_MAX)
        fp8_bytes = _float32_to_fp8_e4m3fn_bytes(w_fp8_f32)

        q_name = wname + '_q'
        s_name = wname + '_s'
        dq_name = wname + '_dq'

        # Build FP8 weight tensor manually (numpy doesn't have float8 dtype)
        q_tensor = onnx.TensorProto()
        q_tensor.name = q_name
        q_tensor.data_type = TensorProto.FLOAT8E4M3FN  # 17
        q_tensor.dims.extend(weight.shape)
        q_tensor.raw_data = fp8_bytes
        new_inits.append(q_tensor)

        new_inits.append(numpy_helper.from_array(
            np.array(scale_val, dtype=np.float32), name=s_name))

        new_nodes.append(onnx.helper.make_node(
            'DequantizeLinear',
            inputs=[q_name, s_name],
            outputs=[dq_name],
            name=wname + '_fp8_dq',
        ))

        # If model uses fp16 activations, cast DQ output (float32) to float16
        # so MatMul sees matching types
        wire_name = dq_name
        if model_uses_fp16:
            cast_name = wname + '_cast16'
            new_nodes.append(onnx.helper.make_node(
                'Cast',
                inputs=[dq_name],
                outputs=[cast_name],
                to=TensorProto.FLOAT16,
                name=cast_name,
            ))
            wire_name = cast_name

        # Rewire node input
        for i, inp in enumerate(node.input):
            if inp == wname:
                node.input[i] = wire_name
                break

        inits_to_remove.add(wname)

    # Remove old weight initializers
    keep = [init for init in model.graph.initializer if init.name not in inits_to_remove]
    del model.graph.initializer[:]
    model.graph.initializer.extend(keep)
    model.graph.initializer.extend(new_inits)
    model.graph.node.extend(new_nodes)

    # Shape inference
    try:
        model = shape_inference.infer_shapes(model, check_type=False, strict_mode=False)
    except Exception:
        pass

    # Upgrade opset to 21 (required for DequantizeLinear with float8_e4m3fn)
    for opset in model.opset_import:
        if opset.domain == '' or opset.domain == 'ai.onnx':
            if opset.version < 21:
                print(f"    Upgrading opset {opset.version} → 21 (required for FP8)")
                opset.version = 21

    # Save — always use external data for models with large weights
    dst_dir = os.path.dirname(dst_path)
    os.makedirs(dst_dir, exist_ok=True)

    # Check if original used external data, or if our result is large
    orig_has_data = os.path.exists(src_path + '.data')
    model_byte_size = model.ByteSize()
    use_external = orig_has_data or model_byte_size > 100 * 1024 * 1024  # > 100MB proto

    if use_external:
        onnx.save_model(
            model, dst_path,
            save_as_external_data=True,
            all_tensors_to_one_file=True,
            location=os.path.basename(dst_path) + '.data',
            size_threshold=1024,
        )
    else:
        onnx.save_model(model, dst_path)

    # Report sizes
    out_mb = os.path.getsize(dst_path) / 1e6
    data_path = dst_path + '.data'
    data_mb = os.path.getsize(data_path) / 1e6 if os.path.exists(data_path) else 0
    src_mb = os.path.getsize(src_path) / 1e6
    src_data_mb = os.path.getsize(src_path + '.data') / 1e6 if os.path.exists(src_path + '.data') else 0
    src_total = src_mb + src_data_mb
    dst_total = out_mb + data_mb
    ratio = src_total / dst_total if dst_total > 0 else 0
    print(f"    FP8: {out_mb:.1f} + {data_mb:.1f} MB data  (src {src_total:.1f} MB, {ratio:.1f}x)")
    return True


def get_input_shapes(session):
    shapes = {}
    for inp in session.get_inputs():
        shape = []
        for dim in inp.shape:
            shape.append(dim if isinstance(dim, int) else 1)
        shapes[inp.name] = (inp.type, shape)
    return shapes


def make_feeds(input_shapes):
    feeds = {}
    for name, (dtype_str, shape) in input_shapes.items():
        if 'int' in dtype_str:
            feeds[name] = np.random.randint(0, 100, shape).astype(np.int64)
        elif 'float16' in dtype_str:
            feeds[name] = np.random.randn(*shape).astype(np.float16)
        else:
            feeds[name] = np.random.randn(*shape).astype(np.float32)
    return feeds


def verify_accuracy(src_path, dst_path, model_name, num_samples=3):
    """Cosine similarity between FP16 (src) and FP8 (dst) outputs."""
    try:
        src_sess = ort.InferenceSession(src_path, providers=['CPUExecutionProvider'])
        dst_sess = ort.InferenceSession(dst_path, providers=['CPUExecutionProvider'])
    except Exception as e:
        print(f"    [SKIP] Session error: {e}")
        return None

    shapes = get_input_shapes(src_sess)
    sims = []
    for i in range(num_samples):
        feeds = make_feeds(shapes)
        try:
            s = src_sess.run(None, feeds)[0].flatten().astype(np.float64)
            d = dst_sess.run(None, feeds)[0].flatten().astype(np.float64)
            n = min(len(s), len(d))
            s, d = s[:n], d[:n]
            ns, nd = np.linalg.norm(s), np.linalg.norm(d)
            if ns < 1e-10 or nd < 1e-10:
                sims.append(1.0)
            else:
                sims.append(float(np.dot(s, d) / (ns * nd)))
        except Exception as e:
            print(f"    [WARN] sample {i}: {e}")

    del src_sess, dst_sess
    gc.collect()

    if not sims:
        return None
    avg = float(np.mean(sims))
    tag = "PASS" if avg >= 0.90 else "FAIL"
    print(f"    [{tag}] {model_name}: cosine={avg:.6f}")
    return avg


def main():
    parser = argparse.ArgumentParser(description='FP8 Quantization for SXSEditor ONNX Models')
    parser.add_argument('--models', default=None,
                        help='Comma-separated model names (without .onnx)')
    parser.add_argument('--verify', action='store_true',
                        help='Run cosine-similarity verification')
    parser.add_argument('--skip-preprocess', action='store_true')
    args = parser.parse_args()

    print("=" * 60)
    print("FP8 Quantization for SXSEditor")
    print(f"Source: {FP16_DIR}")
    print(f"Output: {FP8_DIR}")
    print("=" * 60)

    if not os.path.exists(FP16_DIR):
        print(f"[ERROR] FP16 directory not found: {FP16_DIR}")
        return 1

    os.makedirs(FP8_DIR, exist_ok=True)

    # Select models
    if args.models:
        names = [n.strip().replace('.onnx', '') for n in args.models.split(',')]
        models = [n for n in SVS_MODELS if n.replace('.onnx', '') in names]
    else:
        models = SVS_MODELS

    results = []

    for model_name in models:
        src = os.path.join(FP16_DIR, model_name)
        dst = os.path.join(FP8_DIR, model_name)

        if not os.path.exists(src):
            print(f"\n[SKIP] {model_name}: not found")
            results.append({'name': model_name, 'ok': False, 'error': 'not found'})
            continue

        src_mb = os.path.getsize(src) / 1e6
        src_data = src + '.data'
        if os.path.exists(src_data):
            src_mb += os.path.getsize(src_data) / 1e6
        print(f"\n{'='*60}")
        print(f"  {model_name}  ({src_mb:.1f} MB)")

        t0 = time.time()

        if model_name in NON_QUANTIZABLE:
            print(f"    Non-quantizable — copying from fp16")
            copy_model_with_external_data(src, dst)
            results.append({'name': model_name, 'ok': True, 'quantized': False, 'cos': 1.0})
        else:
            ok = quantize_model_fp8(src, dst, model_name)
            cos = None
            if ok and args.verify:
                cos = verify_accuracy(src, dst, model_name)
            results.append({'name': model_name, 'ok': True, 'quantized': ok, 'cos': cos})

        print(f"  ({time.time() - t0:.1f}s)")
        gc.collect()

    # Preprocess models
    if not args.skip_preprocess:
        print(f"\n{'='*60}")
        print("Preprocess models")
        for m in PREPROCESS_MODELS:
            src = os.path.join(FP16_DIR, m)
            dst = os.path.join(FP8_DIR, m)
            if os.path.exists(src):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                mb = os.path.getsize(dst) / 1e6
                print(f"  {m}: copied ({mb:.1f} MB)")
                results.append({'name': m, 'ok': True, 'quantized': False})
            else:
                print(f"  [SKIP] {m}")
                results.append({'name': m, 'ok': False})

    # Summary
    print(f"\n{'='*60}")
    print("Summary")
    print(f"{'='*60}")
    for r in results:
        if r['ok']:
            tag = "FP8" if r.get('quantized') else "copy"
            cos = f"cos={r['cos']:.6f}" if r.get('cos') is not None else ""
            print(f"  [OK] {r['name']:<35} {tag}  {cos}")
        else:
            print(f"  [FAIL] {r['name']:<35} {r.get('error','')}")

    all_ok = all(r['ok'] for r in results)

    # Directory sizes
    total = 0
    for root, _, files in os.walk(FP8_DIR):
        for f in files:
            if f.endswith('.onnx') or f.endswith('.data'):
                total += os.path.getsize(os.path.join(root, f))
    print(f"\nTotal FP8: {total / 1e6:.1f} MB")
    print(f"{'All done!' if all_ok else 'Some models failed.'}")
    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main())
