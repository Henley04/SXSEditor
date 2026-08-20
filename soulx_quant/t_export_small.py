# -*- coding: utf-8 -*-
"""Test ONNX export of quantized cond_emb + preflow (W8A8) -> MatMulInteger kept."""
import os, sys, gc
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')
os.environ['PYTHONIOENCODING'] = 'utf-8'
import torch, onnx, numpy as np
import torch.nn as nn

INT8_PT = '/workspace/onnx_models/int8/pt/soulxsinger_w8a8_full.pt'
print('loading quantized full model (mmap)...', flush=True)
model = torch.load(INT8_PT, weights_only=False, map_location='cpu', mmap=True)
model.eval()

def export_comp(wrap, inp, name, in_names, out_names, dynamic_axes=None):
    with torch.no_grad():
        ref = wrap(*inp) if isinstance(inp, (list, tuple)) else wrap(inp)
    tmp = f'/workspace/onnx_models/int8/{name}.onnx'
    with torch.no_grad():
        torch.onnx.export(wrap, inp, tmp, opset_version=20,
                          input_names=in_names, output_names=out_names,
                          dynamic_axes=dynamic_axes, dynamo=False)
    m = onnx.load(tmp)
    ops = {}
    n_int8_init = 0
    for init in m.graph.initializer:
        if init.data_type == onnx.TensorProto.INT8:
            n_int8_init += 1
    for n in m.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    print(f'{name}: int8_inits={n_int8_init} ops={dict(sorted(ops.items()))}', flush=True)
    return tmp

# --- cond_emb (W8A8) ---
ce = model.cfm_decoder.model.cond_emb
class CE(nn.Module):
    def __init__(self, m): super().__init__(); self.m = m
    def forward(self, x): return self.m(x)
inp = torch.randn(1, 40, 512)
export_comp(CE(ce), (inp,), 'cond_emb_test', ['cond_code'], ['cond_embedding'],
            {'cond_code': {1: 'T'}, 'cond_embedding': {1: 'T'}})

# --- preflow (W8A8) ---
pf = model.preflow
class PF(nn.Module):
    def __init__(self, m): super().__init__(); self.m = m
    def forward(self, x): return self.m(x)
inp2 = torch.randn(1, 40, 512)
export_comp(PF(pf), (inp2,), 'preflow_test', ['x'], ['y'],
            {'x': {1: 'T'}, 'y': {1: 'T'}})

print('DONE', flush=True)
