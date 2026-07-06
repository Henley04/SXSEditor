# -*- coding: utf-8 -*-
"""Check Shape node attributes and determine which dim it extracts."""
import onnx
from onnx import numpy_helper

model_path = r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx'
m = onnx.load(model_path, load_external_data=False)
g = m.graph

# node_Shape_1 attributes
for node in g.node:
    if node.name == 'node_Shape_1':
        print(f'node_Shape_1: op={node.op_type}')
        print(f'  inputs: {list(node.input)}')
        print(f'  outputs: {list(node.output)}')
        print(f'  attributes:')
        for attr in node.attribute:
            print(f'    {attr.name}: type={attr.type}, i={attr.i}, ints={list(attr.ints)}')
        if not node.attribute:
            print('    (no attributes)')
        break

# Check if there's a Slice between Shape and val_1
print('\n=== Search for Slice consuming Shape output ===')
shape_outputs = set()
for node in g.node:
    if node.op_type == 'Shape':
        for o in node.output:
            shape_outputs.add(o)

for node in g.node:
    if node.op_type == 'Slice':
        for inp in node.input:
            if inp in shape_outputs:
                print(f'  Slice {node.name}: inputs={list(node.input)}')
                # Check inputs for starts/ends
                init_map = {init.name: init for init in g.initializer}
                for i, inp2 in enumerate(node.input):
                    if inp2 in init_map:
                        arr = numpy_helper.to_array(init_map[inp2])
                        print(f'    input[{i}] ({inp2}): {arr.tolist()}')
                break

# Also check Squeeze consuming val_1
print('\n=== Squeeze consuming val_1 ===')
for node in g.node:
    if node.op_type == 'Squeeze' and 'val_1' in node.input:
        print(f'  Squeeze {node.name}: inputs={list(node.input)}')
        print(f'  outputs: {list(node.output)}')
        # Check axes
        init_map = {init.name: init for init in g.initializer}
        if len(node.input) >= 2 and node.input[1] in init_map:
            arr = numpy_helper.to_array(init_map[node.input[1]])
            print(f'  axes: {arr.tolist()}')
        break

# Production model comparison: how does it get seq_len?
print('\n=== Production model Shape nodes (first 5) ===')
mp = onnx.load(r'd:\Document\electron\SXSEditor\onnx_models\diff_step_dml.onnx', load_external_data=False)
gp = mp.graph
cnt = 0
for node in gp.node:
    if node.op_type == 'Shape':
        cnt += 1
        if cnt <= 5:
            print(f'  {node.name}: inputs={list(node.input)}, outputs={list(node.output)}')
            for attr in node.attribute:
                print(f'    attr {attr.name}: i={attr.i}, ints={list(attr.ints)}')
print(f'  Total Shape in prod: {cnt}')

# W16A32 total Shape
cnt2 = sum(1 for n in g.node if n.op_type == 'Shape')
print(f'  Total Shape in W16A32: {cnt2}')
