# -*- coding: utf-8 -*-
"""Inspect DFT nodes in W16A32 vocoder."""
import onnx
from onnx import numpy_helper

model_path = r'd:\Document\electron\SXSEditor\onnx_models\fp16\vocoder_dml.onnx'
m = onnx.load(model_path, load_external_data=False)
g = m.graph

# Find all DFT nodes
dft_nodes = []
for node in g.node:
    if node.op_type == 'DFT':
        dft_nodes.append(node)

print(f'Found {len(dft_nodes)} DFT nodes')
for i, node in enumerate(dft_nodes):
    print(f'\n--- DFT [{i+1}] {node.name} ---')
    print(f'  inputs: {list(node.input)}')
    print(f'  outputs: {list(node.output)}')
    for attr in node.attribute:
        if attr.name == 'axis':
            print(f'  attr axis: {attr.i}')
        elif attr.name == 'dft_length':
            print(f'  attr dft_length: {attr.i}')
        elif attr.name == 'inverse':
            print(f'  attr inverse: {attr.i}')
        elif attr.name == 'is_onesided':
            print(f'  attr is_onesided: {attr.i}')
        else:
            print(f'  attr {attr.name}: type={attr.type}')

# Also check for Complex/Real/Imag nodes around DFT
print('\n=== Complex-related ops ===')
from collections import Counter
ops = Counter(n.op_type for n in g.node)
complex_related = {'DFT', 'Complex', 'Real', 'Imag', 'ComplexMul', 'ComplexAbs'}
for op, cnt in ops.items():
    if op in complex_related:
        print(f'  {op}: {cnt}')

# Check FP32 production model for comparison
print('\n=== FP32 production vocoder DFT/Complex ops ===')
mp = onnx.load(r'd:\Document\electron\SXSEditor\onnx_models\vocoder_dml.onnx', load_external_data=False)
gp = mp.graph
fp32_ops = Counter(n.op_type for n in gp.node)
for op, cnt in fp32_ops.items():
    if op in complex_related:
        print(f'  {op}: {cnt}')

# Find onnx_istft initializers in FP32
print('\n=== FP32 onnx_istft initializers ===')
for init in gp.initializer:
    if 'istft' in init.name.lower():
        arr = numpy_helper.to_array(init)
        print(f'  {init.name}: shape={arr.shape}, dtype={arr.dtype}')
