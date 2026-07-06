# -*- coding: utf-8 -*-
"""Inspect val_1 (Shape output) value_info and producer chain."""
import onnx
from onnx import numpy_helper

model_path = r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx'
m = onnx.load(model_path, load_external_data=False)
g = m.graph

vi_map = {vi.name: vi for vi in g.value_info}
for vi in g.input:
    vi_map[vi.name] = vi

# val_1 value_info
print('=== val_1 value_info ===')
if 'val_1' in vi_map:
    t = vi_map['val_1'].type.tensor_type
    dims = [d.dim_value if d.dim_value else (d.dim_param if d.dim_param else '?') for d in t.shape.dim]
    print(f'  shape: {dims}, dtype: {t.elem_type}')
else:
    print('  not in value_info')

# cond value_info (input)
print('\n=== cond value_info ===')
if 'cond' in vi_map:
    t = vi_map['cond'].type.tensor_type
    dims = [d.dim_value if d.dim_value else (d.dim_param if d.dim_param else '?') for d in t.shape.dim]
    print(f'  shape: {dims}, dtype: {t.elem_type}')

# Check if there's a Slice between Shape and val_1
print('\n=== Producers of val_1 (full chain) ===')
for node in g.node:
    if 'val_1' in node.output:
        print(f'  Direct producer: {node.op_type} ({node.name}), inputs={list(node.input)}')
        break

# Check all nodes that consume val_1
print('\n=== Consumers of val_1 ===')
for node in g.node:
    if 'val_1' in node.input:
        print(f'  {node.op_type} ({node.name}): inputs={list(node.input)}')

# Check val_48 (the -1) value_info
print('\n=== val_48 (the -1 initializer) ===')
for init in g.initializer:
    if init.name == 'val_48':
        arr = numpy_helper.to_array(init)
        print(f'  value: {arr.tolist()}, dtype: {arr.dtype}')
        break

# Check val_56 (the 64)
print('\n=== val_56 (the 64 initializer) ===')
for init in g.initializer:
    if init.name == 'val_56':
        arr = numpy_helper.to_array(init)
        print(f'  value: {arr.tolist()}, dtype: {arr.dtype}')
        break

# Also check val_20 (the 1)
print('\n=== val_20 (the 1 initializer) ===')
for init in g.initializer:
    if init.name == 'val_20':
        arr = numpy_helper.to_array(init)
        print(f'  value: {arr.tolist()}, dtype: {arr.dtype}')
        break
