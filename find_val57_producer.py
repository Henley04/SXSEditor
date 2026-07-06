# -*- coding: utf-8 -*-
"""Find producer of val_57 in diffStep W16A32 model."""
import onnx
from onnx import numpy_helper

model_path = r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx'
m = onnx.load(model_path, load_external_data=False)
g = m.graph

# Find producer of val_57
print('=== Producer of val_57 ===')
for node in g.node:
    if 'val_57' in node.output:
        print(f'  Node: name={node.name!r}, op={node.op_type}')
        print(f'  inputs: {list(node.input)}')
        print(f'  outputs: {list(node.output)}')
        for attr in node.attribute:
            if attr.name == 'value':
                arr = numpy_helper.to_array(attr.t)
                print(f'  attr value: {arr.tolist()}')
            elif attr.name == 'axes':
                print(f'  attr axes: {list(attr.ints)}')
            elif attr.name == 'start':
                print(f'  attr start: {attr.i}')
            elif attr.name == 'end':
                print(f'  attr end: {attr.i}')
            else:
                print(f'  attr {attr.name}: type={attr.type}')
        break

# Find value_info for val_57
print('\n=== value_info for val_57 ===')
for vi in g.value_info:
    if vi.name == 'val_57':
        t = vi.type.tensor_type
        dims = [d.dim_value if d.dim_value else d.dim_param for d in t.shape.dim]
        print(f'  shape: {dims}, dtype: {t.elem_type}')
        break

# Trace back: find producers of val_57's inputs
print('\n=== Tracing val_57 input chain ===')
producer_inputs = None
for node in g.node:
    if 'val_57' in node.output:
        producer_inputs = list(node.input)
        break

if producer_inputs:
    for inp in producer_inputs:
        print(f'\n  Input: {inp}')
        # Check if initializer
        for init in g.initializer:
            if init.name == inp:
                arr = numpy_helper.to_array(init)
                print(f'    -> initializer: dtype={arr.dtype}, value={arr.tolist() if arr.size < 20 else arr.shape}')
                break
        else:
            # Find producer node
            for node in g.node:
                if inp in node.output:
                    print(f'    -> produced by: op={node.op_type}, name={node.name!r}')
                    print(f'       inputs: {list(node.input)}')
                    break
