# -*- coding: utf-8 -*-
"""Debug diffStep W16A32 DML EP failure."""
import os, sys, time
import numpy as np
import onnxruntime as ort


def test_with_providers(model_path, providers, name, feeds):
    print(f'  [{name}] providers={providers}')
    t0 = time.time()
    try:
        sess = ort.InferenceSession(
            model_path,
            providers=providers
        )
        print(f'    Session created in {time.time()-t0:.1f}s')
        t0 = time.time()
        outputs = sess.run(None, feeds)
        print(f'    Inference OK in {time.time()-t0:.3f}s')
        print(f'    Output shape: {outputs[0].shape}, mean={outputs[0].mean():.6f}, std={outputs[0].std():.6f}')
        del sess
        return True
    except Exception as e:
        print(f'    ERROR: {type(e).__name__}: {e}')
        return False


def main():
    np.random.seed(42)
    model_path = r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx'

    feeds = {
        'xt_input': np.random.randn(1, 100, 128).astype(np.float32),
        't': np.array([0.5], dtype=np.float32),
        'cond': np.random.randn(1, 100, 1024).astype(np.float32),
        'xt_mask': np.ones((1, 100), dtype=np.float32),
    }

    print('=== diffStep W16A32 debug ===')
    # 1. CPU only
    test_with_providers(model_path, ['CPUExecutionProvider'], 'CPU EP', feeds)
    print()
    # 2. DML only (no CPU fallback)
    test_with_providers(model_path, ['DmlExecutionProvider'], 'DML only (no fallback)', feeds)
    print()
    # 3. DML + CPU fallback
    test_with_providers(model_path, ['DmlExecutionProvider', 'CPUExecutionProvider'], 'DML+CPU fallback', feeds)


if __name__ == '__main__':
    main()
