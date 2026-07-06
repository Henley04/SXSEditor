# -*- coding: utf-8 -*-
"""Compare FP32 vs W16A32 vocoder tail nodes to find ISTFT/reshape difference."""
import onnx

# FP32 production
mp = onnx.load(r'd:\Document\electron\SXSEditor\onnx_models\vocoder_dml.onnx', load_external_data=False)
gp = mp.graph
print('=== FP32 production last 20 nodes ===')
for node in list(gp.node)[-20:]:
    print(f'  {node.op_type} ({node.name}): inputs={list(node.input)}, outputs={list(node.output)}')

# Count ops in FP32
from collections import Counter
fp32_ops = Counter(n.op_type for n in gp.node)
print(f'\nFP32 total nodes: {sum(fp32_ops.values())}')
print(f'FP32 ops: {dict(fp32_ops.most_common(15))}')

# W16A32
mp2 = onnx.load(r'd:\Document\electron\SXSEditor\onnx_models\fp16\vocoder_dml.onnx', load_external_data=False)
gp2 = mp2.graph
w16_ops = Counter(n.op_type for n in gp2.node)
print(f'\nW16A32 total nodes: {sum(w16_ops.values())}')
print(f'W16A32 ops: {dict(w16_ops.most_common(15))}')

# Find ISTFT-related ops (Cos, Sin, ComplexMul, etc.)
print('\n=== ISTFT-related ops comparison ===')
istft_related = {'Cos', 'Sin', 'ComplexMul', 'Complex', 'ISTFT', 'STFT', 'Real', 'Imag'}
for label, ops in [('FP32', fp32_ops), ('W16A32', w16_ops)]:
    found = {op: cnt for op, cnt in ops.items() if op in istft_related}
    print(f'  {label}: {found}')
