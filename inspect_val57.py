# -*- coding: utf-8 -*-
"""Check what val_57 is (Constant node or initializer)."""
import onnx
from onnx import numpy_helper, TensorProto

model_path = r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx'
m = onnx.load(model_path, load_external_data=False)
g = m.graph

# Search val_57 in initializers
found_init = False
for init in g.initializer:
    if init.name == 'val_57':
        found_init = True
        arr = numpy_helper.to_array(init)
        print(f'val_57 in initializer: dtype={arr.dtype}, value={arr.tolist()}')
        break
print(f'val_57 in initializer: {found_init}')

# Search val_57 in Constant nodes
found_const = False
for node in g.node:
    if node.op_type == 'Constant' and 'val_57' in node.output:
        found_const = True
        print(f'val_57 produced by Constant node: {node.name}')
        for attr in node.attribute:
            if attr.name == 'value':
                arr = numpy_helper.to_array(attr.t)
                print(f'  value: dtype={arr.dtype}, value={arr.tolist()}')
                break
        break
print(f'val_57 in Constant node: {found_const}')

# Count Constant nodes total
const_count = sum(1 for n in g.node if n.op_type == 'Constant')
print(f'\nTotal Constant nodes: {const_count}')

# Count how many Constant nodes output shape tensors used by Reshape
const_for_reshape = 0
const_outputs = set()
for n in g.node:
    if n.op_type == 'Constant':
        for o in n.output:
            const_outputs.add(o)

for n in g.node:
    if n.op_type == 'Reshape' and len(n.input) >= 2:
        if n.input[1] in const_outputs:
            const_for_reshape += 1
print(f'Constant nodes used as Reshape shape input: {const_for_reshape}')

# List a few Constant node outputs to understand
print('\nFirst 5 Constant nodes:')
cnt = 0
for n in g.node:
    if n.op_type == 'Constant':
        cnt += 1
        if cnt <= 5:
            print(f'  {n.name} -> {list(n.output)}')
