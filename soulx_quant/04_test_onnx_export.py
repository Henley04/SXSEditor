# -*- coding: utf-8 -*-
"""Test that W8A8 modules export to ONNX with real MatMulInteger/ConvInteger."""
import sys, os
sys.path.insert(0, '/workspace')
import torch
import torch.nn as nn
import torch.nn.functional as F
import onnx
import onnxruntime as ort
import numpy as np
from soulx_quant.w8a8_modules import W8A8Linear, W8A8Conv1d, compute_awq_scale, W8A8Linear as _L

torch.manual_seed(0)


def check(model, inputs, name, out_cmp=None):
    with torch.no_grad():
        ref = model(*inputs)
    tmp = f'/tmp/{name}.onnx'
    torch.onnx.export(model, inputs, tmp, opset_version=18,
                      input_names=[f'i{i}' for i in range(len(inputs))],
                      output_names=['output'], dynamo=False)
    m = onnx.load(tmp)
    ops = {}
    for n in m.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    print(f'{name}: ops={ops}')
    sess = ort.InferenceSession(tmp, providers=['CPUExecutionProvider'])
    feeds = {f'i{i}': v.numpy() for i, v in enumerate(inputs)}
    out = sess.run(None, feeds)[0]
    r = ref.numpy().reshape(out.shape).astype(np.float64)
    o = out.astype(np.float64)
    cos = float(np.dot(r.ravel(), o.ravel()) / (np.linalg.norm(r.ravel()) * np.linalg.norm(o.ravel()) + 1e-12))
    print(f'{name}: cos={cos:.6f}')
    return ops, cos


# --- Linear ---
class L(nn.Module):
    def __init__(self):
        super().__init__()
        lin = nn.Linear(1024, 1024, bias=True)
        self.w = W8A8Linear(lin.weight.data, lin.bias.data)
    def forward(self, x):
        return self.w(x)

x = torch.randn(1, 64, 1024) * 0.5
check(L(), (x,), 'linear')

# --- Linear with AWQ scale ---
class LA(nn.Module):
    def __init__(self):
        super().__init__()
        lin = nn.Linear(512, 1024, bias=True)
        awq = compute_awq_scale(lin.weight.data, torch.rand(512) + 0.5)
        self.w = W8A8Linear(lin.weight.data, lin.bias.data, awq_scale=awq)
    def forward(self, x):
        return self.w(x)

xa = torch.randn(1, 64, 512) * 0.5
check(LA(), (xa,), 'linear_awq')

# --- Conv1d ---
class C(nn.Module):
    def __init__(self):
        super().__init__()
        conv = nn.Conv1d(128, 1024, 7, padding=3)
        self.w = W8A8Conv1d(conv.weight.data, conv.bias.data, 1, 3, 1, 1)
    def forward(self, x):
        return self.w(x)

xc = torch.randn(1, 128, 200) * 0.5
check(C(), (xc,), 'conv1d')

# --- depthwise conv ---
class D(nn.Module):
    def __init__(self):
        super().__init__()
        conv = nn.Conv1d(64, 64, 7, padding=3, groups=64)
        self.w = W8A8Conv1d(conv.weight.data, conv.bias.data, 1, 3, 1, 64)
    def forward(self, x):
        return self.w(x)

xd = torch.randn(1, 64, 200) * 0.5
check(D(), (xd,), 'dwconv1d')

print('ALL ONNX EXPORT OK')
