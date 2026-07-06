# -*- coding: utf-8 -*-
"""Test DML EP compatibility for W16A32 models."""
import os, sys, time
import numpy as np
import onnxruntime as ort


def test_session(model_path, name, feeds):
    print(f'Testing {name}: {os.path.basename(model_path)}')
    t0 = time.time()
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    try:
        sess = ort.InferenceSession(
            model_path, sess_options=sess_options,
            providers=['DmlExecutionProvider', 'CPUExecutionProvider']
        )
        print(f'  Session created in {time.time()-t0:.1f}s')
        print(f'  Providers: {sess.get_providers()}')

        t0 = time.time()
        outputs = sess.run(None, feeds)
        print(f'  Inference done in {time.time()-t0:.3f}s')
        print(f'  Output shape: {outputs[0].shape}, dtype: {outputs[0].dtype}')
        print(f'  Output stats: mean={outputs[0].mean():.6f}, std={outputs[0].std():.6f}')
        del sess
        return True
    except Exception as e:
        print(f'  ERROR: {e}')
        return False


def main():
    np.random.seed(42)

    # Test diffStep
    diff_feeds = {
        'xt_input': np.random.randn(1, 100, 128).astype(np.float32),
        't': np.array([0.5], dtype=np.float32),
        'cond': np.random.randn(1, 100, 1024).astype(np.float32),
        'xt_mask': np.ones((1, 100), dtype=np.float32),
    }
    diff_ok = test_session(
        r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx',
        'diffStep W16A32',
        diff_feeds
    )

    print()

    # Test vocoder
    voc_feeds = {
        'mel': np.random.randn(1, 100, 128).astype(np.float32),
    }
    voc_ok = test_session(
        r'd:\Document\electron\SXSEditor\onnx_models\fp16\vocoder_dml.onnx',
        'vocoder W16A32',
        voc_feeds
    )

    print()
    print('=' * 60)
    if diff_ok and voc_ok:
        print('BOTH OK - DML EP compatible')
    else:
        if not diff_ok:
            print('diffStep: FAILED')
        if not voc_ok:
            print('vocoder: FAILED')


if __name__ == '__main__':
    main()
