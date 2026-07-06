# -*- coding: utf-8 -*-
"""Debug W16A32 vocoder Conv type mismatch."""
import onnx
from onnx import numpy_helper, TensorProto

mp = r'd:\Document\electron\SXSEditor\onnx_models\fp16\vocoder_dml.onnx'
m = onnx.load(mp, load_external_data=False)
g = m.graph

# Find node_conv1d
print('=== node_conv1d ===')
for node in g.node:
    if node.name == 'node_conv1d':
        print(f'  op: {node.op_type}')
        print(f'  inputs: {list(node.input)}')
        print(f'  outputs: {list(node.output)}')
        for inp in node.input:
            # Check if it's an initializer
            for init in g.initializer:
                if init.name == inp:
                    print(f'    {inp} (init): dims={list(init.dims)}, dtype={init.data_type}')
                    break
            else:
                # Check if it's a Cast output
                for n2 in g.node:
                    if n2.op_type == 'Cast' and inp in n2.output:
                        print(f'    {inp} (Cast output): from {n2.input[0]}')
                        break
                else:
                    print(f'    {inp} (other)')
        break

# Find all Conv nodes and check their weight input types
print('\n=== All Conv nodes with FP16 weight (no Cast) ===')
init_map = {init.name: init for init in g.initializer}
cast_outputs = set()
for node in g.node:
    if node.op_type == 'Cast':
        for out in node.output:
            cast_outputs.add(out)

problem_count = 0
for node in g.node:
    if node.op_type == 'Conv':
        weight_input = node.input[1] if len(node.input) > 1 else None
        if weight_input:
            if weight_input in init_map:
                init = init_map[weight_input]
                if init.data_type == TensorProto.FLOAT16 and weight_input not in cast_outputs:
                    problem_count += 1
                    if problem_count <= 5:
                        print(f'  {node.name}: weight={weight_input} (FP16, NO Cast)')
            elif weight_input not in cast_outputs:
                # weight is not from Cast and not from initializer - check what it is
                is_input = any(i.name == weight_input for i in g.input)
                if is_input:
                    pass  # skip inputs
                else:
                    problem_count += 1
                    if problem_count <= 5:
                        print(f'  {node.name}: weight={weight_input} (NOT from Cast, NOT init)')

print(f'\nTotal Conv with FP16 weight but no Cast: {problem_count}')

# Check all Conv nodes
print('\n=== All Conv nodes (first 10) ===')
conv_count = 0
for node in g.node:
    if node.op_type == 'Conv':
        conv_count += 1
        if conv_count <= 10:
            weight_input = node.input[1] if len(node.input) > 1 else 'NONE'
            weight_type = '?'
            if weight_input in init_map:
                weight_type = f'init dtype={init_map[weight_input].data_type}'
            elif weight_input in cast_outputs:
                weight_type = 'Cast output (FP32)'
            else:
                weight_type = f'other ({weight_input})'
            print(f'  [{conv_count}] {node.name}: weight={weight_input}, {weight_type}')
print(f'Total Conv: {conv_count}')

# Check Cast nodes
print('\n=== Cast nodes (first 10) ===')
cast_count = 0
for node in g.node:
    if node.op_type == 'Cast':
        cast_count += 1
        if cast_count <= 10:
            to_attr = [a.i for a in node.attribute if a.name == 'to']
            print(f'  {node.name}: {node.input[0]} -> {node.output[0]}, to={to_attr}')
print(f'Total Cast: {cast_count}')
