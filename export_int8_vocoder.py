# -*- coding: utf-8 -*-
"""Export INT8 vocoder (W8A32) to ONNX with real int8 weights (DequantizeLinear + Conv/MatMul).

Input mel [B, T, 128] -> waveform [B, T*hop].
Weights stay int8 (DequantizeLinear nodes), activations fp32 (W8A32).
"""
import os, sys, gc
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')
os.environ['PYTHONIOENCODING'] = 'utf-8'
os.environ['SKIP_ROPE_PRECOMPUTE'] = '1'
import argparse, time, torch, onnx, numpy as np

INT8_PT = '/workspace/onnx_models/int8/pt/soulxsinger_w8a8_full.pt'
OUT_DIR = '/workspace/onnx_models/int8'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', default=OUT_DIR)
    parser.add_argument('--fname', default='vocoder.onnx')
    args = parser.parse_args()
    os.makedirs(args.output_dir, exist_ok=True)
    out_path = os.path.join(args.output_dir, args.fname)

    # VocosFullWrapper from export_shared (MatMul-based IDFT + manual overlap-add)
    from export_shared import VocosFullWrapper

    print('Loading INT8 model (mmap)...', flush=True)
    model = torch.load(INT8_PT, weights_only=False, map_location='cpu', mmap=True)
    model.eval()

    wrap = VocosFullWrapper(model.vocoder).eval()
    print(f'  vocoder wrapped, hop={wrap.hop_length}', flush=True)

    B = 1
    T = 64  # 64 frames -> 64*480 samples
    mel = torch.randn(B, T, 128, dtype=torch.float32)
    with torch.no_grad():
        ref = wrap(mel)
    print(f'  Ref output shape: {tuple(ref.shape)}', flush=True)

    print('Exporting to ONNX (dynamo=False)...', flush=True)
    t0 = time.time()
    with torch.no_grad():
        torch.onnx.export(
            wrap, (mel,), out_path,
            opset_version=20,
            input_names=['mel'],
            output_names=['waveform'],
            dynamic_axes={
                'mel': {1: 'num_frames'},
                'waveform': {1: 'audio_len'},
            },
            dynamo=False,
        )
    elapsed = time.time() - t0
    print(f'  Export done in {elapsed:.1f}s', flush=True)

    m = onnx.load(out_path, load_external_data=False)
    n_i8 = sum(1 for init in m.graph.initializer if init.data_type == onnx.TensorProto.INT8)
    ops = {}
    for n in m.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    size_mb = os.path.getsize(out_path) / 1024 / 1024
    data_path = out_path + '.data'
    data_mb = os.path.getsize(data_path) / 1024 / 1024 if os.path.exists(data_path) else 0
    print(f'  {out_path}: {size_mb:.1f}MB + {data_mb:.1f}MB data', flush=True)
    print(f'  int8 initializers: {n_i8}, DequantizeLinear: {ops.get("DequantizeLinear", 0)}, '
          f'Conv: {ops.get("Conv", 0)}, MatMul: {ops.get("MatMul", 0)}', flush=True)
    print(f'  ops: {dict(sorted(ops.items()))}', flush=True)

    print('  Verifying with ONNX Runtime...', flush=True)
    import onnxruntime as ort
    sess = ort.InferenceSession(out_path, providers=['CPUExecutionProvider'])
    out = sess.run(None, {'mel': mel.numpy()})[0]
    cos = float(np.dot(ref.numpy().ravel(), out.ravel()) /
                (np.linalg.norm(ref.numpy().ravel()) * np.linalg.norm(out.ravel()) + 1e-12))
    print(f'  ONNX Runtime cos (vs torch W8A32): {cos:.6f}', flush=True)

    del model, wrap, sess
    gc.collect()
    print('DONE', flush=True)

if __name__ == '__main__':
    main()