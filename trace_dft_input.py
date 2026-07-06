# -*- coding: utf-8 -*-
"""Trace DFT input chain to understand complex format."""
import onnx
from onnx import numpy_helper

model_path = r'd:\Document\electron\SXSEditor\onnx_models\fp16\vocoder_dml.onnx'
m = onnx.load(model_path, load_external_data=False)
g = m.graph

vi_map = {vi.name: vi for vi in g.value_info}
for vi in g.input:
    vi_map[vi.name] = vi
for vi in g.output:
    vi_map[vi.name] = vi

init_map = {init.name: init for init in g.initializer}

# DFT node inputs: ['mul_892', 'val_440']
# val_440 is dft_length
print('=== val_440 (dft_length) ===')
if 'val_440' in init_map:
    arr = numpy_helper.to_array(init_map['val_440'])
    print(f'  value: {arr.tolist()}')

# Trace mul_892
print('\n=== Producer of mul_892 ===')
for node in g.node:
    if 'mul_892' in node.output:
        print(f'  {node.op_type} ({node.name}): inputs={list(node.input)}, outputs={list(node.output)}')
        # Get shape
        if 'mul_892' in vi_map:
            t = vi_map['mul_892'].type.tensor_type
            dims = [d.dim_value or d.dim_param or '?' for d in t.shape.dim]
            print(f'  mul_892 shape: {dims}, dtype: {t.elem_type}')
        break

# Trace backward 5 levels
def trace_back(name, depth=5, indent=''):
    if depth <= 0:
        return
    for node in g.node:
        if name in node.output:
            print(f'{indent}{node.op_type} ({node.name}) -> {name}')
            print(f'{indent}  inputs: {list(node.input)}')
            if name in vi_map:
                t = vi_map[name].type.tensor_type
                dims = [d.dim_value or d.dim_param or '?' for d in t.shape.dim]
                print(f'{indent}  shape: {dims}, dtype: {t.elem_type}')
            for inp in node.input:
                if inp in init_map:
                    arr = numpy_helper.to_array(init_map[inp])
                    print(f'{indent}  {inp} (init): shape={arr.shape}')
                else:
                    trace_back(inp, depth-1, indent + '  ')
            break

print('\n=== Full backward trace of mul_892 ===')
trace_back('mul_892', 4)

# Check what consumes DFT output val_441
print('\n=== Consumers of val_441 (DFT output) ===')
for node in g.node:
    if 'val_441' in node.input:
        print(f'  {node.op_type} ({node.name}): inputs={list(node.input)}, outputs={list(node.output)}')
        if 'val_441' in vi_map:
            t = vi_map['val_441'].type.tensor_type
            dims = [d.dim_value or d.dim_param or '?' for d in t.shape.dim]
            print(f'  val_441 shape: {dims}, dtype: {t.elem_type}')
