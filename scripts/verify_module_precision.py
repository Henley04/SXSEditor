# -*- coding: utf-8 -*-
"""Module-level precision verification: PyTorch vs FP32 ONNX (CPU EP).

Compares each of the 9 core FP32 ONNX models (opset 20, DML-compatible) against
the original PyTorch submodules on identical fixed-seed inputs, using CPU
ExecutionProvider for deterministic comparison.

Metrics per model:
  - MSE  (mean squared error)
  - RMSE (root mean squared error)
  - COS  (cosine similarity, flattened)
  - SNR  (signal-to-noise ratio in dB, 10*log10(signal_power/noise_power))

Default thresholds: COS >= 0.99, SNR >= 30 dB.
Relaxed thresholds (COS >= 0.95, SNR >= 25 dB) for models with known numerical
differences from ONNX graph rewrites:
  - mel_transform: STFT -> Conv replacement
  - vocoder: ConvTranspose(stride>1) decomposition

Usage:
    python scripts/verify_module_precision.py
    python scripts/verify_module_precision.py --verbose
    python scripts/verify_module_precision.py --output scripts/precision_report.json
"""

import os
import sys
import json
import time
import argparse
import numpy as np
import torch
import onnxruntime as ort

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
SOULX_DIR = os.path.join(PROJECT_DIR, 'SoulX-Singer')
sys.path.insert(0, PROJECT_DIR)
sys.path.insert(0, SOULX_DIR)

from export_shared import (
    load_config, load_model, clear_memory,
    DiffStepWrapper, VocoderBackboneWrapper, VocosFullWrapper,
)

# ============================================================
# Thresholds
# ============================================================
COS_MIN = 0.99
SNR_MIN_DB = 30.0
COS_MIN_RELAXED = 0.95
SNR_MIN_DB_RELAXED = 25.0
RELAXED_MODELS = {'mel_transform', 'vocoder'}

# ============================================================
# Metrics
# ============================================================

def compute_metrics(pytorch_out, onnx_out):
    """Compute MSE, RMSE, COS, SNR between PyTorch and ONNX outputs.

    Both inputs are numpy arrays of the same shape.
    """
    pytorch_out = pytorch_out.astype(np.float64)
    onnx_out = onnx_out.astype(np.float64)
    diff = pytorch_out - onnx_out
    mse = float(np.mean(diff ** 2))
    rmse = float(np.sqrt(mse))
    cos = float(np.dot(pytorch_out.flatten(), onnx_out.flatten()) /
                (np.linalg.norm(pytorch_out) * np.linalg.norm(onnx_out) + 1e-12))
    signal_power = float(np.mean(pytorch_out ** 2))
    noise_power = mse
    snr_db = float(10 * np.log10(signal_power / (noise_power + 1e-12)))
    return {'mse': mse, 'rmse': rmse, 'cos': cos, 'snr_db': snr_db}


# ============================================================
# ONNX session helpers
# ============================================================

def create_onnx_session(onnx_path):
    """Create a CPU EP ONNX session for deterministic comparison."""
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(onnx_path, sess_options=sess_options,
                                providers=['CPUExecutionProvider'])


def get_onnx_input_spec(session):
    """Return ordered dict: {input_name: (shape_list, numpy_dtype)}.

    Static shape values are kept; dynamic dims (strings/None) become 1.
    """
    specs = {}
    for inp in session.get_inputs():
        shape = []
        for d in inp.shape:
            if isinstance(d, int):
                shape.append(d)
            else:
                shape.append(1)
        type_str = str(inp.type)
        if 'float16' in type_str:
            np_dtype = np.float16
        elif 'int64' in type_str:
            np_dtype = np.int64
        elif 'int32' in type_str:
            np_dtype = np.int32
        else:
            np_dtype = np.float32
        specs[inp.name] = (shape, np_dtype)
    return specs


def gen_random_input(shape, np_dtype, vocab_size=None):
    """Generate a random input matching shape and dtype."""
    if np.issubdtype(np_dtype, np.integer):
        high = vocab_size if vocab_size else 256
        return np.random.randint(0, high, size=shape, dtype=np_dtype)
    else:
        return (np.random.randn(*shape) * 0.5).astype(np_dtype)


def make_result(name, pt_out, onnx_out, relaxed=False, verbose=False):
    """Build a result dict from PyTorch and ONNX outputs."""
    pt_np = np.asarray(pt_out, dtype=np.float32)
    on_np = np.asarray(onnx_out, dtype=np.float32)
    if pt_np.shape != on_np.shape:
        min_len = min(pt_np.size, on_np.size)
        pt_flat = pt_np.reshape(-1)[:min_len]
        on_flat = on_np.reshape(-1)[:min_len]
        m = compute_metrics(pt_flat, on_flat)
        shape_mismatch = True
    else:
        m = compute_metrics(pt_np, on_np)
        shape_mismatch = False

    cos_min = COS_MIN_RELAXED if relaxed else COS_MIN
    snr_min = SNR_MIN_DB_RELAXED if relaxed else SNR_MIN_DB
    passed = (m['cos'] >= cos_min) and (m['snr_db'] >= snr_min) and not shape_mismatch

    if verbose:
        print(f"    PT shape: {list(pt_np.shape)}, ONNX shape: {list(on_np.shape)}")
        if shape_mismatch:
            print(f"    [WARN] Shape mismatch! Compared first {min_len} elements.")
        print(f"    PT  mean={pt_np.mean():.6f} std={pt_np.std():.6f} "
              f"min={pt_np.min():.6f} max={pt_np.max():.6f}")
        print(f"    ONX mean={on_np.mean():.6f} std={on_np.std():.6f} "
              f"min={on_np.min():.6f} max={on_np.max():.6f}")

    return {
        'name': name,
        'pytorch_shape': list(pt_np.shape),
        'onnx_shape': list(on_np.shape),
        'mse': m['mse'],
        'rmse': m['rmse'],
        'cos': m['cos'],
        'snr_db': m['snr_db'],
        'passed': passed,
        'relaxed': relaxed,
        'threshold': {'cos_min': cos_min, 'snr_min_db': snr_min},
        'shape_mismatch': shape_mismatch,
    }


def make_error_result(name, error_msg):
    return {
        'name': name,
        'pytorch_shape': None,
        'onnx_shape': None,
        'mse': None,
        'rmse': None,
        'cos': None,
        'snr_db': None,
        'passed': False,
        'relaxed': name in RELAXED_MODELS,
        'threshold': {'cos_min': COS_MIN_RELAXED if name in RELAXED_MODELS else COS_MIN,
                      'snr_min_db': SNR_MIN_DB_RELAXED if name in RELAXED_MODELS else SNR_MIN_DB},
        'shape_mismatch': False,
        'error': error_msg,
    }


# ============================================================
# Per-model verification functions
# ============================================================

def verify_embedding_encoder(model, onnx_dir, model_name, attr_name, vocab_size, verbose=False):
    """Verify an nn.Embedding-based encoder (note_text/pitch/type, f0)."""
    onnx_path = os.path.join(onnx_dir, f'{model_name}.onnx')
    if not os.path.exists(onnx_path):
        return make_error_result(model_name, f'ONNX not found: {onnx_path}')

    sess = create_onnx_session(onnx_path)
    input_spec = get_onnx_input_spec(sess)
    input_name = list(input_spec.keys())[0]
    shape, np_dtype = input_spec[input_name]

    input_ids_np = gen_random_input(shape, np_dtype, vocab_size=vocab_size)
    input_ids_torch = torch.from_numpy(input_ids_np)

    onnx_out = sess.run(None, {input_name: input_ids_np})[0]

    submodule = getattr(model, attr_name)
    with torch.no_grad():
        pt_out = submodule(input_ids_torch)

    del sess
    return make_result(model_name, pt_out, onnx_out,
                       relaxed=(model_name in RELAXED_MODELS), verbose=verbose)


def verify_note_text_encoder(model, onnx_dir, seq_len, verbose=False):
    return verify_embedding_encoder(model, onnx_dir, 'note_text_encoder',
                                    'note_text_encoder', 3000, verbose=verbose)


def verify_note_pitch_encoder(model, onnx_dir, seq_len, verbose=False):
    return verify_embedding_encoder(model, onnx_dir, 'note_pitch_encoder',
                                    'note_pitch_encoder', 256, verbose=verbose)


def verify_note_type_encoder(model, onnx_dir, seq_len, verbose=False):
    return verify_embedding_encoder(model, onnx_dir, 'note_type_encoder',
                                    'note_type_encoder', 256, verbose=verbose)


def verify_f0_encoder(model, onnx_dir, seq_len, verbose=False):
    return verify_embedding_encoder(model, onnx_dir, 'f0_encoder',
                                    'f0_encoder', 361, verbose=verbose)


def verify_preflow(model, onnx_dir, seq_len, verbose=False):
    """Verify preflow (4 ConvNeXtV2Block, input: features [1,T,512])."""
    name = 'preflow'
    onnx_path = os.path.join(onnx_dir, f'{name}.onnx')
    if not os.path.exists(onnx_path):
        return make_error_result(name, f'ONNX not found: {onnx_path}')

    sess = create_onnx_session(onnx_path)
    input_spec = get_onnx_input_spec(sess)
    input_name = list(input_spec.keys())[0]
    shape, np_dtype = input_spec[input_name]

    features_np = gen_random_input(shape, np_dtype)
    features_torch = torch.from_numpy(features_np)

    onnx_out = sess.run(None, {input_name: features_np})[0]

    with torch.no_grad():
        pt_out = model.preflow(features_torch)

    del sess
    return make_result(name, pt_out, onnx_out,
                       relaxed=(name in RELAXED_MODELS), verbose=verbose)


def verify_cond_emb(model, onnx_dir, seq_len, verbose=False):
    """Verify cond_emb (nn.Linear(512,1024), input: cond_code [1,T,512] float32)."""
    name = 'cond_emb'
    onnx_path = os.path.join(onnx_dir, f'{name}.onnx')
    if not os.path.exists(onnx_path):
        return make_error_result(name, f'ONNX not found: {onnx_path}')

    sess = create_onnx_session(onnx_path)
    input_spec = get_onnx_input_spec(sess)
    input_name = list(input_spec.keys())[0]
    shape, np_dtype = input_spec[input_name]

    cond_code_np = gen_random_input(shape, np_dtype)
    cond_code_torch = torch.from_numpy(cond_code_np)

    onnx_out = sess.run(None, {input_name: cond_code_np})[0]

    cond_emb_module = model.cfm_decoder.model.cond_emb
    with torch.no_grad():
        pt_out = cond_emb_module(cond_code_torch)

    del sess
    return make_result(name, pt_out, onnx_out,
                       relaxed=(name in RELAXED_MODELS), verbose=verbose)


def _load_example_audio(target_samples, verbose=False):
    """Try to load a real audio sample from SoulX-Singer/example/audio/.

    Returns a float32 numpy array of shape (1, target_samples) or None on failure.
    """
    audio_dir = os.path.join(SOULX_DIR, 'example', 'audio')
    if not os.path.isdir(audio_dir):
        return None

    candidates = ['zh_prompt.mp3', 'en_prompt.mp3', 'en_target.mp3', 'zh_target.mp3']
    for fname in candidates:
        path = os.path.join(audio_dir, fname)
        if not os.path.exists(path):
            continue
        try:
            import librosa
            audio, sr = librosa.load(path, sr=24000, mono=True)
            if len(audio) < target_samples:
                if verbose:
                    print(f"    Audio too short ({len(audio)} < {target_samples}), padding.")
                audio = np.pad(audio, (0, target_samples - len(audio)))
            audio = audio[:target_samples].astype(np.float32)
            return audio.reshape(1, target_samples)
        except Exception as e:
            if verbose:
                print(f"    Failed to load {fname}: {e}")
            continue
    return None


def verify_mel_transform(model, onnx_dir, seq_len, verbose=False):
    """Verify mel_transform (MelSpectrogramEncoder, input: audio [1,N] float32).

    Uses STFT->Conv replacement in ONNX, so relaxed thresholds apply.
    """
    name = 'mel_transform'
    onnx_path = os.path.join(onnx_dir, f'{name}.onnx')
    if not os.path.exists(onnx_path):
        return make_error_result(name, f'ONNX not found: {onnx_path}')

    sess = create_onnx_session(onnx_path)
    input_spec = get_onnx_input_spec(sess)
    input_name = list(input_spec.keys())[0]
    shape, np_dtype = input_spec[input_name]

    # Try real audio first, fall back to random
    audio_np = _load_example_audio(shape[1] if len(shape) >= 2 else 24000, verbose=verbose)
    if audio_np is None:
        if verbose:
            print(f"    Using random audio input (no example file loaded).")
        audio_np = (np.random.randn(*shape) * 0.1).astype(np.float32)
    else:
        if verbose:
            print(f"    Using real audio from example, shape={audio_np.shape}")

    audio_torch = torch.from_numpy(audio_np)

    onnx_out = sess.run(None, {input_name: audio_np})[0]

    with torch.no_grad():
        pt_out = model.mel(audio_torch)

    del sess
    return make_result(name, pt_out, onnx_out,
                       relaxed=(name in RELAXED_MODELS), verbose=verbose)


def verify_diff_step(model, onnx_dir, seq_len, verbose=False):
    """Verify diff_step (DiffLlama via DiffStepWrapper).

    Inputs: xt_input(1,T,128), t(1,), cond(1,T,512), xt_mask(1,T).
    ONNX was exported with static shape T=2048.
    """
    name = 'diff_step'
    onnx_path = os.path.join(onnx_dir, 'diff_step_dml.onnx')
    if not os.path.exists(onnx_path):
        return make_error_result(name, f'ONNX not found: {onnx_path}')

    sess = create_onnx_session(onnx_path)
    input_spec = get_onnx_input_spec(sess)

    feeds_np = {}
    torch_inputs = {}
    for inp_name, (shape, np_dtype) in input_spec.items():
        if inp_name == 't':
            arr = np.array([0.5], dtype=np.float32)
        elif inp_name == 'xt_mask':
            arr = np.ones(shape, dtype=np.float32)
        else:
            arr = gen_random_input(shape, np_dtype)
        feeds_np[inp_name] = arr
        torch_inputs[inp_name] = torch.from_numpy(arr)

    onnx_out = sess.run(None, feeds_np)[0]

    wrapper = DiffStepWrapper(model.cfm_decoder)
    with torch.no_grad():
        pt_out = wrapper(torch_inputs['xt_input'],
                         torch_inputs['t'],
                         torch_inputs['cond'],
                         torch_inputs['xt_mask'])

    del sess, wrapper
    return make_result(name, pt_out, onnx_out,
                       relaxed=(name in RELAXED_MODELS), verbose=verbose)


def verify_vocoder(model, onnx_dir, seq_len, verbose=False):
    """Verify vocoder (full Vocos: backbone + ISTFTHead via VocosFullWrapper).

    Input: mel(1,T,128) float32. Output: waveform(1, T*hop) float32.
    ONNX was exported with static shape T=500 using VocosFullWrapper which
    includes MatMul-based IDFT and manual overlap-add (DML-compatible).
    PyTorch reference uses the same VocosFullWrapper (full ISTFT reconstruction).
    """
    name = 'vocoder'
    onnx_path = os.path.join(onnx_dir, 'vocoder_dml.onnx')
    if not os.path.exists(onnx_path):
        return make_error_result(name, f'ONNX not found: {onnx_path}')

    sess = create_onnx_session(onnx_path)
    input_spec = get_onnx_input_spec(sess)
    input_name = list(input_spec.keys())[0]
    shape, np_dtype = input_spec[input_name]

    # Use mel-like distribution (standardized: mean~-4.92, var~8.14)
    mel_np = (np.random.randn(*shape) * (8.14 ** 0.5) + (-4.92)).astype(np.float32)
    mel_torch = torch.from_numpy(mel_np)

    onnx_out = sess.run(None, {input_name: mel_np})[0]

    wrapper = VocosFullWrapper(model.vocoder).eval()
    with torch.no_grad():
        pt_out = wrapper(mel_torch)

    del sess, wrapper
    return make_result(name, pt_out, onnx_out,
                       relaxed=(name in RELAXED_MODELS), verbose=verbose)


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description='Module-level precision verification: PyTorch vs FP32 ONNX (CPU)')
    parser.add_argument('--output', default=os.path.join(SCRIPT_DIR, 'precision_report.json'),
                        help='Output JSON report path')
    parser.add_argument('--model-path',
                        default=os.path.join(SOULX_DIR, 'pretrained_models', 'SoulX-Singer', 'model.pt'),
                        help='Path to SoulX-Singer model.pt')
    parser.add_argument('--onnx-dir', default=os.path.join(PROJECT_DIR, 'onnx_models'),
                        help='Directory containing FP32 ONNX models')
    parser.add_argument('--seq-len', type=int, default=100,
                        help='Sequence length hint (ONNX models have static shapes; '
                             'actual shapes are read from each session)')
    parser.add_argument('--verbose', action='store_true',
                        help='Print detailed per-model diagnostics')
    args = parser.parse_args()

    np.random.seed(42)
    torch.manual_seed(42)

    print("=" * 70)
    print("Module-level precision verification: PyTorch vs FP32 ONNX (CPU)")
    print("=" * 70)
    print(f"ONNX dir:   {args.onnx_dir}")
    print(f"Model:      {args.model_path}")
    print(f"Seq len:    {args.seq_len} (hint; ONNX uses static shapes)")
    print(f"Thresholds: COS >= {COS_MIN}, SNR >= {SNR_MIN_DB} dB")
    print(f"            COS >= {COS_MIN_RELAXED}, SNR >= {SNR_MIN_DB_RELAXED} dB "
          f"(relaxed: {sorted(RELAXED_MODELS)})")
    print()

    if not os.path.exists(args.model_path):
        print(f"[ERROR] Model not found: {args.model_path}")
        sys.exit(2)
    if not os.path.isdir(args.onnx_dir):
        print(f"[ERROR] ONNX dir not found: {args.onnx_dir}")
        sys.exit(2)

    config = load_config()
    print("[1/2] Loading SoulX-Singer PyTorch model...")
    t0 = time.time()
    model = load_model(config, args.model_path)
    model.eval()
    print(f"      Loaded in {time.time()-t0:.1f}s")

    verify_fns = [
        verify_note_text_encoder,
        verify_note_pitch_encoder,
        verify_note_type_encoder,
        verify_f0_encoder,
        verify_preflow,
        verify_cond_emb,
        verify_mel_transform,
        verify_diff_step,
        verify_vocoder,
    ]

    print(f"\n[2/2] Running {len(verify_fns)} module verifications...")
    print("-" * 70)

    results = []
    for verify_fn in verify_fns:
        name = verify_fn.__name__.replace('verify_', '')
        print(f"\n  >>> {name}")
        t0 = time.time()
        try:
            result = verify_fn(model, args.onnx_dir, args.seq_len, verbose=args.verbose)
        except Exception as e:
            result = make_error_result(name, f'{type(e).__name__}: {e}')
        elapsed = time.time() - t0

        if 'error' in result:
            print(f"      [ERROR] {result['error']}")
        else:
            status = 'PASS' if result['passed'] else 'FAIL'
            relax_tag = ' (relaxed)' if result.get('relaxed') else ''
            print(f"      [{status}] {name:25s}{relax_tag}")
            print(f"        COS={result['cos']:.6f}  SNR={result['snr_db']:.2f}dB  "
                  f"MSE={result['mse']:.2e}  RMSE={result['rmse']:.2e}  ({elapsed:.1f}s)")
            if args.verbose:
                print(f"        PT shape: {result['pytorch_shape']}, "
                      f"ONNX shape: {result['onnx_shape']}")

        results.append(result)
        clear_memory()

    del model
    clear_memory()

    # Summary table
    print("\n" + "=" * 70)
    print("Summary")
    print("=" * 70)
    header = f"  {'Model':<25} {'COS':>10} {'SNR(dB)':>10} {'MSE':>12} {'Status':>8}"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for r in results:
        if r.get('error'):
            cos_str = 'ERROR'
            snr_str = '-'
            mse_str = '-'
            status = 'FAIL'
        else:
            cos_str = f"{r['cos']:.6f}"
            snr_str = f"{r['snr_db']:.2f}"
            mse_str = f"{r['mse']:.2e}"
            status = 'PASS' if r['passed'] else 'FAIL'
        relax_tag = '*' if r.get('relaxed') else ' '
        print(f"  {r['name']:<25}{relax_tag}{cos_str:>10} {snr_str:>10} {mse_str:>12} {status:>8}")
    print(f"\n  (* = relaxed threshold: COS>={COS_MIN_RELAXED}, SNR>={SNR_MIN_DB_RELAXED}dB)")

    # Save report
    report = {
        'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
        'model_path': args.model_path,
        'onnx_dir': args.onnx_dir,
        'seq_len_hint': args.seq_len,
        'thresholds': {
            'strict': {'cos_min': COS_MIN, 'snr_min_db': SNR_MIN_DB},
            'relaxed': {'cos_min': COS_MIN_RELAXED, 'snr_min_db': SNR_MIN_DB_RELAXED},
            'relaxed_models': sorted(RELAXED_MODELS),
        },
        'results': results,
        'summary': {
            'total': len(results),
            'passed': sum(1 for r in results if r.get('passed')),
            'failed': sum(1 for r in results if not r.get('passed')),
        }
    }
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(f"\nReport saved: {args.output}")
    print(f"Summary: {report['summary']['passed']}/{report['summary']['total']} passed")

    if report['summary']['failed'] > 0:
        sys.exit(1)


if __name__ == '__main__':
    main()
