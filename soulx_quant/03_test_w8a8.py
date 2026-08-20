# -*- coding: utf-8 -*-
"""Sanity test: W8A8Linear/Conv1d vs fp32 reference."""
import sys
sys.path.insert(0, '/workspace')
import torch
import torch.nn as nn
import torch.nn.functional as F
from soulx_quant.w8a8_modules import W8A8Linear, W8A8Conv1d

torch.manual_seed(0)

# --- Linear test ---
lin = nn.Linear(1024, 1024, bias=False)
w8 = W8A8Linear(lin.weight.data)
x = torch.randn(2, 64, 1024) * 0.5
with torch.no_grad():
    ref = lin(x)
    out = w8(x)
cos = F.cosine_similarity(ref.flatten(), out.flatten(), dim=0)
err = (ref - out).abs().mean() / ref.abs().mean()
print(f'Linear: cos={cos.item():.6f} rel_err={err.item():.6f}')

# check weight storage is really int8
print('  weight dtype:', w8.weight_int8.dtype, 'shape:', tuple(w8.weight_int8.shape))
print('  scale shape:', tuple(w8.scale.shape), 'scale[0]:', w8.scale[0].item())
print('  fp32 bytes saved: %.1f%%' % (100 * (1 - (w8.weight_int8.numel() + w8.scale.numel()*4) / (lin.weight.numel()*4))))

# --- MLP test (gate/up/down) ---
gate = nn.Linear(1024, 4096, bias=False)
up = nn.Linear(1024, 4096, bias=False)
down = nn.Linear(4096, 1024, bias=False)
w8g, w8u, w8d = W8A8Linear(gate.weight.data), W8A8Linear(up.weight.data), W8A8Linear(down.weight.data)
with torch.no_grad():
    h = F.silu(w8g(x)) * w8u(x)
    o = w8d(h)
    h_ref = F.silu(gate(x)) * up(x)
    o_ref = down(h_ref)
cos = F.cosine_similarity(o_ref.flatten(), o.flatten(), dim=0)
print(f'MLP: cos={cos.item():.6f}')

# --- Conv1d test ---
conv = nn.Conv1d(128, 1024, 7, padding=3)
w8c = W8A8Conv1d(conv.weight.data, conv.bias.data, 1, 3, 1, 1)
xc = torch.randn(1, 128, 500) * 0.5
with torch.no_grad():
    refc = conv(xc)
    outc = w8c(xc)
cos = F.cosine_similarity(refc.flatten(), outc.flatten(), dim=0)
print(f'Conv1d: cos={cos.item():.6f}')

# --- depthwise conv ---
dw = nn.Conv1d(1024, 1024, 7, padding=3, groups=1024)
w8dw = W8A8Conv1d(dw.weight.data, dw.bias.data, 1, 3, 1, 1024)
xd = torch.randn(1, 1024, 500) * 0.5
with torch.no_grad():
    refd = dw(xd)
    outd = w8dw(xd)
cos = F.cosine_similarity(refd.flatten(), outd.flatten(), dim=0)
print(f'DWConv1d: cos={cos.item():.6f}')

# --- group_size test ---
lin2 = nn.Linear(1024, 1024, bias=True)
w8g2 = W8A8Linear(lin2.weight.data, lin2.bias.data, group_size=128)
with torch.no_grad():
    ref2 = lin2(x)
    out2 = w8g2(x)
cos = F.cosine_similarity(ref2.flatten(), out2.flatten(), dim=0)
print(f'Linear group128: cos={cos.item():.6f}')

print('ALL OK')
