# -*- coding: utf-8 -*-
"""Precision test: compare PyTorch output vs ONNX CPU vs ONNX DML."""
import os
import sys
import numpy as np
import torch
import onnxruntime as ort

# Import wrappers from export scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_shared import load_config, load_model
from export_shared import DiffStepWrapper, VocosFullWrapper
from export_step3_postprocess import MelTransformWrapper

MODEL_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt')


def cosine_similarity(a, b):
    a = a.flatten()
    b = b.flatten()
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))


def snr_db(a, b):
    # SNR = 10 log10(var(a) / var(a-b))
    var_a = np.var(a)
    var_e = np.var(a - b)
    return 10 * np.log10(var_a / (var_e + 1e-12))


def print_stats(name, arr):
    print(f'  {name}: shape={arr.shape}, dtype={arr.dtype}, '
          f'mean={arr.mean():.6f}, std={arr.std():.6f}, '
          f'min={arr.min():.6f}, max={arr.max():.6f}, '
          f'NaN={np.sum(np.isnan(arr))}')


def test_mel_transform():
    print('=' * 80)
    print('TEST: mel_transform (FP32)')
    print('=' * 80)

    # Load PyTorch model
    config = load_config()
    model = load_model(config, MODEL_PATH)
    wrapper = MelTransformWrapper(model.mel).eval().to(torch.float32)

    # Random input
    np.random.seed(42)
    audio_np = np.random.randn(1, 48000).astype(np.float32)
    audio_torch = torch.from_numpy(audio_np)

    # PyTorch output
    with torch.no_grad():
        output_torch = wrapper(audio_torch).numpy()
    print_stats('PyTorch', output_torch)

    # ONNX CPU
    sess_cpu = ort.InferenceSession(
        'onnx_models/mel_transform.onnx',
        providers=['CPUExecutionProvider']
    )
    output_cpu = sess_cpu.run(None, {'audio': audio_np})[0]
    print_stats('ONNX CPU', output_cpu)

    # ONNX DML
    sess_dml = ort.InferenceSession(
        'onnx_models/mel_transform.onnx',
        providers=['DmlExecutionProvider', 'CPUExecutionProvider']
    )
    output_dml = sess_dml.run(None, {'audio': audio_np})[0]
    print_stats('ONNX DML', output_dml)

    # Compare
    print()
    cos_pt_cpu = cosine_similarity(output_torch, output_cpu)
    cos_pt_dml = cosine_similarity(output_torch, output_dml)
    cos_cpu_dml = cosine_similarity(output_cpu, output_dml)
    snr_pt_cpu = snr_db(output_torch, output_cpu)
    snr_pt_dml = snr_db(output_torch, output_dml)
    print(f'  Cosine(PyTorch vs CPU): {cos_pt_cpu:.6f}')
    print(f'  Cosine(PyTorch vs DML): {cos_pt_dml:.6f}')
    print(f'  Cosine(CPU vs DML): {cos_cpu_dml:.6f}')
    print(f'  SNR(PyTorch vs CPU): {snr_pt_cpu:.2f} dB')
    print(f'  SNR(PyTorch vs DML): {snr_pt_dml:.2f} dB')

    print()
    if cos_pt_dml > 0.9999 and snr_pt_dml > 60:
        print('  ✅ PASS: mel_transform precision OK')
        return True
    else:
        print('  ❌ FAIL: precision too low')
        return False


def test_diff_step():
    print('\n' + '=' * 80)
    print('TEST: diff_step (FP32)')
    print('=' * 80)

    # Load PyTorch model
    config = load_config()
    model = load_model(config, MODEL_PATH)
    wrapper = DiffStepWrapper(model.cfm_decoder).eval().to(torch.float32)

    # Random input
    np.random.seed(42)
    T = 100
    xt_input_np = np.random.randn(1, T, 128).astype(np.float32)
    t_np = np.array([0.5], dtype=np.float32)
    cond_np = np.random.randn(1, T, 1024).astype(np.float32)
    xt_mask_np = np.ones((1, T), dtype=np.float32)

    xt_input_torch = torch.from_numpy(xt_input_np)
    t_torch = torch.from_numpy(t_np)
    cond_torch = torch.from_numpy(cond_np)
    xt_mask_torch = torch.from_numpy(xt_mask_np)

    # PyTorch output
    with torch.no_grad():
        output_torch = wrapper(xt_input_torch, t_torch, cond_torch, xt_mask_torch).numpy()
    print_stats('PyTorch', output_torch)

    # ONNX CPU
    sess_cpu = ort.InferenceSession(
        'onnx_models/diff_step_dml.onnx',
        providers=['CPUExecutionProvider']
    )
    output_cpu = sess_cpu.run(None, {
        'xt_input': xt_input_np,
        't': t_np,
        'cond': cond_np,
        'xt_mask': xt_mask_np,
    })[0]
    print_stats('ONNX CPU', output_cpu)

    # ONNX DML
    sess_dml = ort.InferenceSession(
        'onnx_models/diff_step_dml.onnx',
        providers=['DmlExecutionProvider', 'CPUExecutionProvider']
    )
    output_dml = sess_dml.run(None, {
        'xt_input': xt_input_np,
        't': t_np,
        'cond': cond_np,
        'xt_mask': xt_mask_np,
    })[0]
    print_stats('ONNX DML', output_dml)

    # Compare
    print()
    cos_pt_cpu = cosine_similarity(output_torch, output_cpu)
    cos_pt_dml = cosine_similarity(output_torch, output_dml)
    cos_cpu_dml = cosine_similarity(output_cpu, output_dml)
    snr_pt_cpu = snr_db(output_torch, output_cpu)
    snr_pt_dml = snr_db(output_torch, output_dml)
    print(f'  Cosine(PyTorch vs CPU): {cos_pt_cpu:.6f}')
    print(f'  Cosine(PyTorch vs DML): {cos_pt_dml:.6f}')
    print(f'  Cosine(CPU vs DML): {cos_cpu_dml:.6f}')
    print(f'  SNR(PyTorch vs CPU): {snr_pt_cpu:.2f} dB')
    print(f'  SNR(PyTorch vs DML): {snr_pt_dml:.2f} dB')

    print()
    nan_count = np.sum(np.isnan(output_dml))
    if nan_count == 0 and cos_pt_dml > 0.999 and snr_pt_dml > 30:
        print('  ✅ PASS: diff_step precision OK')
        return True
    else:
        print(f'  ❌ FAIL: NaN={nan_count}, cos={cos_pt_dml:.6f}, SNR={snr_pt_dml:.2f}')
        return False


def test_vocoder():
    print('\n' + '=' * 80)
    print('TEST: vocoder (FP32)')
    print('=' * 80)

    # Load PyTorch model
    config = load_config()
    model = load_model(config, MODEL_PATH)
    wrapper = VocosFullWrapper(model.vocoder).eval().to(torch.float32)

    # Random input
    np.random.seed(42)
    T = 100
    mel_np = np.random.randn(1, T, 128).astype(np.float32)
    mel_torch = torch.from_numpy(mel_np)

    # PyTorch output
    with torch.no_grad():
        output_torch = wrapper(mel_torch).numpy()
    print_stats('PyTorch', output_torch)

    # ONNX CPU
    sess_cpu = ort.InferenceSession(
        'onnx_models/vocoder_dml.onnx',
        providers=['CPUExecutionProvider']
    )
    output_cpu = sess_cpu.run(None, {'mel': mel_np})[0]
    print_stats('ONNX CPU', output_cpu)

    # ONNX DML
    sess_dml = ort.InferenceSession(
        'onnx_models/vocoder_dml.onnx',
        providers=['DmlExecutionProvider', 'CPUExecutionProvider']
    )
    output_dml = sess_dml.run(None, {'mel': mel_np})[0]
    print_stats('ONNX DML', output_dml)

    # Compare
    print()
    cos_pt_cpu = cosine_similarity(output_torch, output_cpu)
    cos_pt_dml = cosine_similarity(output_torch, output_dml)
    cos_cpu_dml = cosine_similarity(output_cpu, output_dml)
    snr_pt_cpu = snr_db(output_torch, output_cpu)
    snr_pt_dml = snr_db(output_torch, output_dml)
    print(f'  Cosine(PyTorch vs CPU): {cos_pt_cpu:.6f}')
    print(f'  Cosine(PyTorch vs DML): {cos_pt_dml:.6f}')
    print(f'  Cosine(CPU vs DML): {cos_cpu_dml:.6f}')
    print(f'  SNR(PyTorch vs CPU): {snr_pt_cpu:.2f} dB')
    print(f'  SNR(PyTorch vs DML): {snr_pt_dml:.2f} dB')

    print()
    nan_count = np.sum(np.isnan(output_dml))
    if nan_count == 0 and cos_pt_dml > 0.999 and snr_pt_dml > 30:
        print('  ✅ PASS: vocoder precision OK')
        return True
    else:
        print(f'  ❌ FAIL: NaN={nan_count}, cos={cos_pt_dml:.6f}, SNR={snr_pt_dml:.2f}')
        return False


def main():
    results = []
    results.append(test_mel_transform())
    results.append(test_diff_step())
    results.append(test_vocoder())

    print('\n' + '=' * 80)
    print('SUMMARY')
    print('=' * 80)
    all_ok = all(results)
    names = ['mel_transform', 'diff_step', 'vocoder']
    for name, ok in zip(names, results):
        print(f'  {name}: {"✅ PASS" if ok else "❌ FAIL"}')

    print()
    if all_ok:
        print('✅ ALL TESTS PASSED')
    else:
        print('❌ SOME TESTS FAILED')
        sys.exit(1)


if __name__ == '__main__':
    main()
