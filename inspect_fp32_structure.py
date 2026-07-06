# -*- coding: utf-8 -*-
"""Check FP32 vocoder.onnx (source of vocoder_dml.onnx) structure."""
import onnx
from onnx import numpy_helper
from collections import Counter
import os

# Check if vocoder.onnx exists
vocoder_onnx = r'd:\Document\electron\SXSEditor\onnx_models\vocoder.onnx'
if os.path.exists(vocoder_onnx):
    print(f'=== vocoder.onnx (source) ===')
    m = onnx.load(vocoder_onnx, load_external_data=False)
    g = m.graph
    print(f'Inputs: {[(i.name, [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim], i.type.tensor_type.elem_type) for i in g.input]}')
    print(f'Outputs: {[(o.name, [d.dim_value or d.dim_param for d in o.type.tensor_type.shape.dim], o.type.tensor_type.elem_type) for o in g.output]}')
    ops = Counter(n.op_type for n in g.node)
    print(f'Total nodes: {sum(ops.values())}')
    for op, cnt in ops.most_common(15):
        print(f'  {op}: {cnt}')
    # Check for DFT/STFT/Complex
    for op in ['DFT', 'STFT', 'Complex', 'Real', 'Imag', 'Conv', 'ConvTranspose']:
        if op in ops:
            print(f'  Has {op}: {ops[op]}')
    # Check istft initializers
    istft_inits = [init.name for init in g.initializer if 'istft' in init.name.lower()]
    print(f'ISTFT initializers: {istft_inits}')
else:
    print(f'vocoder.onnx NOT found at {vocoder_onnx}')

# Also check vocoder_dml.onnx input/output shapes more carefully
print(f'\n=== vocoder_dml.onnx (production) ===')
mp = r'd:\Document\electron\SXSEditor\onnx_models\vocoder_dml.onnx'
m = onnx.load(mp, load_external_data=False)
g = m.graph
print(f'Inputs: {[(i.name, [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim], i.type.tensor_type.elem_type) for i in g.input]}')
print(f'Outputs: {[(o.name, [d.dim_value or d.dim_param for d in o.type.tensor_type.shape.dim], o.type.tensor_type.elem_type) for o in g.output]}')

# List all initializers with their shapes and dtypes
print(f'\n=== vocoder_dml.onnx initializers (first 30, sorted by size) ===')
init_info = []
for init in g.initializer:
    arr_info = (init.name, list(init.dims), init.data_type)
    init_info.append(arr_info)
# Sort by size (product of dims)
def size(x):
    s = 1
    for d in x[1]:
        s *= d
    return s
init_info.sort(key=size, reverse=True)
for name, dims, dtype in init_info[:30]:
    print(f'  {name}: dims={dims}, dtype={dtype}')
print(f'Total initializers: {len(init_info)}')
