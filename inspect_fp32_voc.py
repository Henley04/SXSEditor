# -*- coding: utf-8 -*-
"""Inspect FP32 production vocoder: outputs, ISTFT structure, Conv nodes."""
import onnx
from onnx import numpy_helper
from collections import Counter

mp = r'd:\Document\electron\SXSEditor\onnx_models\vocoder_dml.onnx'
m = onnx.load(mp, load_external_data=False)
g = m.graph

print('=== FP32 production vocoder ===')
print(f'Inputs: {[(i.name, [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim], i.type.tensor_type.elem_type) for i in g.input]}')
print(f'Outputs: {[(o.name, [d.dim_value or d.dim_param for d in o.type.tensor_type.shape.dim], o.type.tensor_type.elem_type) for o in g.output]}')

# Find Conv nodes that use inverse_basis
print('\n=== Conv nodes using onnx_istft.* ===')
for node in g.node:
    if node.op_type == 'Conv':
        for inp in node.input:
            if 'istft' in inp.lower():
                print(f'  Conv ({node.name}): inputs={list(node.input)}, outputs={list(node.output)}')
                for attr in node.attribute:
                    print(f'    attr {attr.name}: {attr.i if attr.type == 2 else attr.type}')

# Find the chain of nodes using inverse_basis
print('\n=== All nodes consuming onnx_istft.* initializers ===')
istft_inits = {init.name for init in g.initializer if 'istft' in init.name.lower()}
print(f'istft initializers: {istft_inits}')
for node in g.node:
    for inp in node.input:
        if inp in istft_inits:
            print(f'  {node.op_type} ({node.name}): inputs={list(node.input)}, outputs={list(node.output)}')

# Trace forward from Conv using inverse_basis
print('\n=== Forward trace from Conv(inverse_basis) ===')
conv_output = None
for node in g.node:
    if node.op_type == 'Conv':
        for inp in node.input:
            if inp in istft_inits:
                conv_output = node.output[0]
                print(f'Start: Conv -> {conv_output}')
                break

# Find consumers of conv_output, then their consumers, etc. (5 levels)
def trace_forward(name, depth=6, indent=''):
    if depth <= 0:
        return
    for node in g.node:
        if name in node.input:
            print(f'{indent}{node.op_type} ({node.name}) <- {name}')
            print(f'{indent}  inputs: {list(node.input)}')
            print(f'{indent}  outputs: {list(node.output)}')
            for out in node.output:
                trace_forward(out, depth-1, indent + '  ')

if conv_output:
    trace_forward(conv_output, 6)

# Count ops
print('\n=== Op counts (top 15) ===')
ops = Counter(n.op_type for n in g.node)
for op, cnt in ops.most_common(15):
    print(f'  {op}: {cnt}')
print(f'Total nodes: {sum(ops.values())}')
