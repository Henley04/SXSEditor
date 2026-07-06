# -*- coding: utf-8 -*-
"""Analyze all Concat nodes with [-1] input used by Reshape in W16A32 diffStep."""
import onnx
from onnx import numpy_helper

model_path = r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx'
m = onnx.load(model_path, load_external_data=False)
g = m.graph

# Build value_info map
vi_map = {}
for vi in g.value_info:
    vi_map[vi.name] = vi
for vi in g.input:
    vi_map[vi.name] = vi
for vi in g.output:
    vi_map[vi.name] = vi

init_map = {init.name: init for init in g.initializer}

def get_shape(vi_name):
    if vi_name not in vi_map:
        return None
    t = vi_map[vi_name].type.tensor_type
    if t.elem_type == 0:
        return None
    dims = []
    for d in t.shape.dim:
        if d.dim_value:
            dims.append(d.dim_value)
        elif d.dim_param:
            dims.append(d.dim_param)
        else:
            dims.append('?')
    return dims

# Find all Concat nodes whose inputs include [-1] initializer
print('=== Concat nodes with [-1] input ===')
neg1_concats = []
for node in g.node:
    if node.op_type != 'Concat':
        continue
    has_neg1 = False
    for inp in node.input:
        if inp in init_map:
            arr = numpy_helper.to_array(init_map[inp])
            if arr.size == 1 and arr.item() == -1:
                has_neg1 = True
                break
    if has_neg1:
        neg1_concats.append(node)

print(f'Found {len(neg1_concats)} Concat nodes with [-1] input')

# For each, find the Reshape that uses it and the Reshape input shape
patterns = []
for concat_node in neg1_concats[:5]:  # First 5
    concat_output = concat_node.output[0]
    print(f'\n--- Concat {concat_node.name} -> {concat_output} ---')
    print(f'  Concat inputs:')
    for inp in concat_node.input:
        if inp in init_map:
            arr = numpy_helper.to_array(init_map[inp])
            print(f'    {inp} (init): {arr.tolist()}')
        else:
            # Producer
            for n2 in g.node:
                if inp in n2.output:
                    print(f'    {inp} <- {n2.op_type} ({n2.name}), inputs={list(n2.input)}')
                    break

    # Find Reshape using this output
    for n2 in g.node:
        if n2.op_type == 'Reshape' and len(n2.input) >= 2 and n2.input[1] == concat_output:
            reshape_input = n2.input[0]
            print(f'  Used by Reshape: {n2.name}, input={reshape_input}')
            in_shape = get_shape(reshape_input)
            print(f'    Reshape input shape: {in_shape}')
            break

# Collect unique Concat output values pattern (by input types)
print('\n=== Unique Concat input patterns ===')
unique = {}
for node in g.node:
    if node.op_type != 'Concat':
        continue
    has_neg1 = False
    input_pattern = []
    for inp in node.input:
        if inp in init_map:
            arr = numpy_helper.to_array(init_map[inp])
            input_pattern.append(f'const={arr.tolist()}')
            if arr.size == 1 and arr.item() == -1:
                has_neg1 = True
        else:
            for n2 in g.node:
                if inp in n2.output:
                    input_pattern.append(f'{n2.op_type}({n2.name})')
                    break
            else:
                input_pattern.append(f'?({inp})')
    if has_neg1:
        key = tuple(input_pattern)
        if key not in unique:
            unique[key] = 0
        unique[key] += 1

for pattern, count in unique.items():
    print(f'  [{count}x] {list(pattern)}')
