# -*- coding: utf-8 -*-
"""Export INT8 diff_step (W8A8) to ONNX with real MatMulInteger + QDIT signature.

QDIT signature: inputs x/diffusion_step/cond/x_mask(bool), output flow_pred.
"""
import os, sys, gc
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')
os.environ['PYTHONIOENCODING'] = 'utf-8'
import argparse, time, torch, onnx, numpy as np

INT8_PT = '/workspace/onnx_models/int8/pt/soulxsinger_w8a8_full.pt'
OUT_DIR = '/workspace/onnx_models/int8'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', default=OUT_DIR)
    args = parser.parse_args()
    os.makedirs(args.output_dir, exist_ok=True)
    out_path = os.path.join(args.output_dir, 'diffstep.onnx')

    print('Loading INT8 model (mmap)...', flush=True)
    model = torch.load(INT8_PT, weights_only=False, map_location='cpu', mmap=True)
    model.eval()

    de = model.cfm_decoder.model.diff_estimator
    print(f'  diff_estimator with W8A8: {sum(1 for _ in de.modules())} modules', flush=True)

    # QDIT wrapper: x, diffusion_step, cond, x_mask(bool) -> flow_pred
    class DiffStepQDITWrapper(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m
        def forward(self, x, diffusion_step, cond, x_mask):
            return self.m(x, diffusion_step, cond, x_mask)

    wrap = DiffStepQDITWrapper(de).eval()

    # Trace inputs
    B = 1
    T = 512  # moderate seq len for trace
    x = torch.randn(B, T, 128, dtype=torch.float32)
    t = torch.tensor([0.5], dtype=torch.float32)
    cond = torch.randn(B, T, 1024, dtype=torch.float32)
    mask = torch.ones(B, T, dtype=torch.bool)  # bool mask

    # Verify the model runs with these inputs
    with torch.no_grad():
        ref = wrap(x, t, cond, mask)
    print(f'  Ref output shape: {tuple(ref.shape)}, dtype={ref.dtype}', flush=True)

    print('Exporting to ONNX (dynamo=False, legacy exporter for MatMulInteger symbolic)...', flush=True)
    t0 = time.time()
    with torch.no_grad():
        torch.onnx.export(
            wrap, (x, t, cond, mask), out_path,
            opset_version=20,
            input_names=['x', 'diffusion_step', 'cond', 'x_mask'],
            output_names=['flow_pred'],
            dynamic_axes={
                'x': {1: 'seq_len'},
                'cond': {1: 'seq_len'},
                'x_mask': {1: 'seq_len'},
                'flow_pred': {1: 'seq_len'},
            },
            dynamo=False,
        )
    elapsed = time.time() - t0
    print(f'  Export done in {elapsed:.1f}s', flush=True)

    # Verify: count int8 initializers and MatMulInteger nodes
    m = onnx.load(out_path, load_external_data=False)
    n_i8 = 0
    for init in m.graph.initializer:
        if init.data_type == onnx.TensorProto.INT8:
            n_i8 += 1
    ops = {}
    for n in m.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    n_mmi = ops.get('MatMulInteger', 0)
    size_mb = os.path.getsize(out_path) / 1024 / 1024
    data_path = out_path + '.data'
    data_mb = os.path.getsize(data_path) / 1024 / 1024 if os.path.exists(data_path) else 0
    print(f'  {out_path}: {size_mb:.1f}MB + {data_mb:.1f}MB data', flush=True)
    print(f'  int8 initializers: {n_i8}, MatMulInteger: {n_mmi}', flush=True)
    print(f'  ops: {dict(sorted(ops.items()))}', flush=True)

    # Verify with ONNX Runtime
    print('  Verifying with ONNX Runtime...', flush=True)
    import onnxruntime as ort
    sess = ort.InferenceSession(out_path, providers=['CPUExecutionProvider'])
    feeds = {
        'x': x.numpy(),
        'diffusion_step': t.numpy(),
        'cond': cond.numpy(),
        'x_mask': mask.numpy(),
    }
    out = sess.run(None, feeds)[0]
    cos = float(np.dot(ref.numpy().ravel(), out.ravel()) /
                (np.linalg.norm(ref.numpy().ravel()) * np.linalg.norm(out.ravel()) + 1e-12))
    print(f'  ONNX Runtime cos: {cos:.6f}', flush=True)

    del model, wrap, sess
    gc.collect()
    print('DONE', flush=True)

if __name__ == '__main__':
    main()