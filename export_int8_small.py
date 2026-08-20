# -*- coding: utf-8 -*-
"""Export INT8 cond_emb + preflow (W8A8) to ONNX with real MatMulInteger/ConvInteger.

cond_emb.onnx : cond_code [B, T, 512] -> cond_embedding [B, T, 1024]  (W8A8Linear)
preflow.onnx  : x [B, T, 512]        -> y [B, T, 512]                (W8A8 ConvNeXtV2)
"""
import os, sys, gc
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')
os.environ['PYTHONIOENCODING'] = 'utf-8'
import argparse, time, torch, onnx, numpy as np
import torch.nn as nn

INT8_PT = '/workspace/onnx_models/int8/pt/soulxsinger_w8a8_full.pt'
OUT_DIR = '/workspace/onnx_models/int8'

def export_comp(wrap, inp, out_path, in_names, out_names, dynamic_axes):
    with torch.no_grad():
        torch.onnx.export(
            wrap, inp, out_path,
            opset_version=20,
            input_names=in_names, output_names=out_names,
            dynamic_axes=dynamic_axes, dynamo=False,
        )
    m = onnx.load(out_path, load_external_data=False)
    n_i8 = sum(1 for init in m.graph.initializer if init.data_type == onnx.TensorProto.INT8)
    ops = {}
    for n in m.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f'  {os.path.basename(out_path)}: {size_mb:.1f}MB, int8_inits={n_i8}, '
          f'MatMulInteger={ops.get("MatMulInteger",0)}, ConvInteger={ops.get("ConvInteger",0)}', flush=True)
    return m

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', default=OUT_DIR)
    args = parser.parse_args()
    os.makedirs(args.output_dir, exist_ok=True)

    print('Loading INT8 model (mmap)...', flush=True)
    model = torch.load(INT8_PT, weights_only=False, map_location='cpu', mmap=True)
    model.eval()

    # --- cond_emb (W8A8) ---
    ce = model.cfm_decoder.model.cond_emb
    class CE(nn.Module):
        def __init__(self, m): super().__init__(); self.m = m
        def forward(self, x): return self.m(x)
    inp = torch.randn(1, 200, 512)
    export_comp(CE(ce), (inp,), os.path.join(args.output_dir, 'cond_emb.onnx'),
                ['cond_code'], ['cond_embedding'],
                {'cond_code': {1: 'T'}, 'cond_embedding': {1: 'T'}})

    # --- preflow (W8A8) ---
    pf = model.preflow
    class PF(nn.Module):
        def __init__(self, m): super().__init__(); self.m = m
        def forward(self, x): return self.m(x)
    inp2 = torch.randn(1, 200, 512)
    export_comp(PF(pf), (inp2,), os.path.join(args.output_dir, 'preflow.onnx'),
                ['x'], ['y'],
                {'x': {1: 'T'}, 'y': {1: 'T'}})

    del model
    gc.collect()
    print('DONE', flush=True)

if __name__ == '__main__':
    main()