# -*- coding: utf-8 -*-
"""Test: (1) diff_estimator accepts bool x_mask; (2) quantized cond_emb exports to ONNX with MatMulInteger."""
import os, sys, gc
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')
os.environ['PYTHONIOENCODING'] = 'utf-8'
import torch, onnx, numpy as np

INT8_PT = '/workspace/onnx_models/int8/pt/soulxsinger_w8a8_full.pt'

print('loading quantized full model (mmap)...', flush=True)
model = torch.load(INT8_PT, weights_only=False, map_location='cpu', mmap=True)
model.eval()

# --- test 1: diff_estimator with bool mask ---
de = model.cfm_decoder.model.diff_estimator
x = torch.randn(1, 64, 128)
t = torch.tensor([0.5])
cond = torch.randn(1, 64, 1024)
mask_f = torch.ones(1, 64)
mask_b = torch.ones(1, 64, dtype=torch.bool)
with torch.no_grad():
    out_f = de(x, t, cond, mask_f)
    out_b = de(x, t, cond, mask_b)
print('bool mask OK, out_f.shape=', tuple(out_f.shape),
      'max diff vs float mask:', float((out_f - out_b).abs().max()), flush=True)

# --- test 2: export quantized cond_emb (W8A8) to ONNX with MatMulInteger ---
import torch.nn as nn
ce = model.cfm_decoder.model.cond_emb
class CE(nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m
    def forward(self, x):
        return self.m(x)
wrap = CE(ce)
inp = torch.randn(1, 40, 512)
with torch.no_grad():
    ref = wrap(inp)
tmp = '/workspace/onnx_models/int8/cond_emb_test.onnx'
torch.onnx.export(wrap, (inp,), tmp, opset_version=20,
                  input_names=['cond_code'], output_names=['cond_embedding'], dynamo=False)
m = onnx.load(tmp)
ops = {}
for n in m.graph.node:
    ops[n.op_type] = ops.get(n.op_type, 0) + 1
print('cond_emb onnx ops:', ops, flush=True)
import onnxruntime as ort
sess = ort.InferenceSession(tmp, providers=['CPUExecutionProvider'])
out = sess.run(None, {'cond_code': inp.numpy()})[0]
cos = float(np.dot(ref.numpy().ravel(), out.ravel()) / (np.linalg.norm(ref.numpy().ravel()) * np.linalg.norm(out.ravel()) + 1e-12))
print('cond_emb onnx cos:', cos, flush=True)
print('DONE', flush=True)
