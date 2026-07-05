# -*- coding: utf-8 -*-
"""
精度验证: W8A8 INT8 vs FP32 ONNX 模型对比。
"""
import os
import sys
import gc
import numpy as np
import onnx
import onnxruntime as ort

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INT8_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'int8')
FP32_DIR = os.path.join(INT8_DIR, 'optimized_npu_fp32')


def get_inputs(model_path):
    model = onnx.load(model_path, load_external_data=False)
    specs = {}
    for inp in model.graph.input:
        shape = [max(d.dim_value, 64) if i > 0 else d.dim_value
                 for i, d in enumerate(inp.type.tensor_type.shape.dim)]
        dtype = {1: np.float32, 6: np.int32, 7: np.int64}.get(inp.type.tensor_type.elem_type, np.float32)
        specs[inp.name] = (shape, dtype)
    return specs


def random_feeds(specs):
    feeds = {}
    for name, (shape, dtype) in specs.items():
        if dtype == np.int64:
            feeds[name] = np.random.randint(0, 100, size=shape).astype(np.int64)
        elif dtype == np.int32:
            feeds[name] = np.random.randint(0, 100, size=shape).astype(np.int32)
        else:
            feeds[name] = np.random.randn(*shape).astype(np.float32)
    return feeds


def compare(name, ref, out):
    ref = ref.flatten().astype(np.float32)
    out = out.flatten().astype(np.float32)
    n = min(len(ref), len(out))
    ref, out = ref[:n], out[:n]
    mse = np.mean((ref - out) ** 2)
    max_diff = np.max(np.abs(ref - out))
    cos_sim = np.dot(ref, out) / (np.linalg.norm(ref) * np.linalg.norm(out) + 1e-10)
    rel_err = np.mean(np.abs(ref - out) / (np.abs(ref) + 1e-10))
    ok = cos_sim > 0.99
    print(f"  [{'PASS' if ok else 'WARN'}] {name}")
    print(f"    MSE={mse:.6f}  MaxDiff={max_diff:.6f}  Cosine={cos_sim:.6f}  RelErr={rel_err:.6f}")
    return ok, mse, cos_sim


def test_model(name):
    print(f"\n=== {name} ===")
    w8a8_path = os.path.join(INT8_DIR, f'{name}.onnx')
    fp32_path = os.path.join(FP32_DIR, f'{name}.onnx')

    if not os.path.exists(w8a8_path):
        print(f"  [SKIP] W8A8 not found"); return None
    if not os.path.exists(fp32_path):
        print(f"  [SKIP] FP32 not found"); return None

    specs = get_inputs(fp32_path)
    feeds = random_feeds(specs)
    print(f"  Inputs: {', '.join(f'{k}{v[0]}' for k, v in specs.items())}")

    fp32_out = ort.InferenceSession(fp32_path, providers=['CPUExecutionProvider']).run(None, feeds)[0]
    w8a8_out = ort.InferenceSession(w8a8_path, providers=['CPUExecutionProvider']).run(None, feeds)[0]

    print(f"  FP32:  {fp32_out.shape}  range [{fp32_out.min():.4f}, {fp32_out.max():.4f}]")
    print(f"  W8A8:  {w8a8_out.shape}  range [{w8a8_out.min():.4f}, {w8a8_out.max():.4f}]")
    return compare(f'{name} W8A8 vs FP32', fp32_out, w8a8_out)


def main():
    print("=" * 60)
    print("W8A8 vs FP32 accuracy comparison")
    print("=" * 60)

    models = ['diff_step_dml', 'vocoder_dml', 'preflow', 'cond_emb']
    results = []
    for name in models:
        try:
            r = test_model(name)
            if r: results.append((name, *r))
        except Exception as e:
            print(f"  [FAIL] {name}: {e}")
            results.append((name, False, -1, -1))
        gc.collect()

    print(f"\n{'='*60}")
    print("Results summary")
    print(f"{'='*60}")
    for name, ok, mse, cos in results:
        print(f"  [{'PASS' if ok else 'WARN'}] {name}:  MSE={mse:.6f}  Cosine={cos:.6f}")
    print(f"\nModel size comparison:")
    for name in models:
        w8 = os.path.join(INT8_DIR, f'{name}.onnx.data')
        fp = os.path.join(FP32_DIR, f'{name}.onnx.data')
        w8sz = os.path.getsize(w8) / 1048576 if os.path.exists(w8) else 0
        fpsz = os.path.getsize(fp) / 1048576 if os.path.exists(fp) else 0
        ratio = fpsz / w8sz if w8sz > 0 else 0
        print(f"  {name}:  W8A8={w8sz:.1f}MB  FP32={fpsz:.1f}MB  ratio={ratio:.1f}x")


if __name__ == '__main__':
    main()
