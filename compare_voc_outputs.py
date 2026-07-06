# -*- coding: utf-8 -*-
"""Compare FP32 production vocoder vs W16A32 vocoder output shapes."""
import onnx
from onnx import numpy_helper

# FP32 production
mp = onnx.load(r'd:\Document\electron\SXSEditor\onnx_models\vocoder_dml.onnx', load_external_data=False)
gp = mp.graph
print('=== FP32 production vocoder ===')
print(f'Inputs: {[(i.name, [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim], i.type.tensor_type.elem_type) for i in gp.input]}')
print(f'Outputs: {[(o.name, [d.dim_value or d.dim_param for d in o.type.tensor_type.shape.dim], o.type.tensor_type.elem_type) for o in gp.output]}')

# W16A32
mp2 = onnx.load(r'd:\Document\electron\SXSEditor\onnx_models\fp16\vocoder_dml.onnx', load_external_data=False)
gp2 = mp2.graph
print('\n=== W16A32 vocoder ===')
print(f'Inputs: {[(i.name, [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim], i.type.tensor_type.elem_type) for i in gp2.input]}')
print(f'Outputs: {[(o.name, [d.dim_value or d.dim_param for d in o.type.tensor_type.shape.dim], o.type.tensor_type.elem_type) for o in gp2.output]}')

# Check last few nodes of W16A32 to see output producer
print('\n=== W16A32 last 10 nodes ===')
for node in list(gp2.node)[-10:]:
    print(f'  {node.op_type} ({node.name}): inputs={list(node.input)}, outputs={list(node.output)}')

# Check for ISTFT in both
print('\n=== ISTFT/STFT nodes ===')
for label, g in [('FP32', gp), ('W16A32', gp2)]:
    for node in g.node:
        if node.op_type in ('STFT', 'ISTFT'):
            print(f'  {label}: {node.op_type} ({node.name})')
