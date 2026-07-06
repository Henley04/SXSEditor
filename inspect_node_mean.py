# -*- coding: utf-8 -*-
"""Inspect node_mean ReduceMean and its input shape."""
import onnx
from onnx import numpy_helper

model_path = r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx'
m = onnx.load(model_path, load_external_data=False)
g = m.graph

vi_map = {vi.name: vi for vi in g.value_info}
for vi in g.input:
    vi_map[vi.name] = vi
for vi in g.output:
    vi_map[vi.name] = vi

# Find node_mean
for node in g.node:
    if node.name == 'node_mean':
        print(f'node_mean: op={node.op_type}')
        print(f'  inputs: {list(node.input)}')
        print(f'  outputs: {list(node.output)}')
        for attr in node.attribute:
            if attr.name == 'axes':
                print(f'  attr axes: {list(attr.ints)}')
            else:
                print(f'  attr {attr.name}: type={attr.type}')
        # Input shape
        for inp in node.input:
            if inp in vi_map:
                t = vi_map[inp].type.tensor_type
                dims = [d.dim_value if d.dim_value else (d.dim_param if d.dim_param else '?') for d in t.shape.dim]
                print(f'  input {inp} shape: {dims}, dtype: {t.elem_type}')
            else:
                print(f'  input {inp}: not in value_info')
        break

# Find producer of node_mean input
print('\n=== Producer of node_mean input ===')
for node in g.node:
    if node.name == 'node_mean':
        for inp in node.input:
            for n2 in g.node:
                if inp in n2.output:
                    print(f'  {inp} <- {n2.op_type} ({n2.name}), inputs={list(n2.input)}')
                    break
        break

# Count ReduceMean nodes total
total_rm = sum(1 for n in g.node if n.op_type == 'ReduceMean')
print(f'\nTotal ReduceMean: {total_rm}')

# List all ReduceMean with axes
print('\n=== All ReduceMean nodes ===')
cnt = 0
for node in g.node:
    if node.op_type == 'ReduceMean':
        cnt += 1
        axes = None
        for attr in node.attribute:
            if attr.name == 'axes':
                axes = list(attr.ints)
        # Input shape
        in_shape = None
        if node.input and node.input[0] in vi_map:
            t = vi_map[node.input[0]].type.tensor_type
            in_shape = [d.dim_value if d.dim_value else (d.dim_param if d.dim_param else '?') for d in t.shape.dim]
        print(f'  [{cnt}] {node.name}: axes={axes}, input_shape={in_shape}')
        if cnt >= 10:
            break
