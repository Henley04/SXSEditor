# -*- coding: utf-8 -*-
"""Inspect node_view_1 Reshape node and surrounding context in diffStep W16A32."""
import onnx
from onnx import helper

model_path = r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx'
m = onnx.load(model_path, load_external_data=False)
g = m.graph

# Find node_view_1
target = None
for node in g.node:
    if node.name == 'node_view_1':
        target = node
        break

if target is None:
    print('node_view_1 not found')
    # Search any node containing 'view' in name
    for node in g.node:
        if 'view' in node.name.lower():
            print(f'  candidate: {node.name} ({node.op_type})')
else:
    print(f'Found: {target.name} op={target.op_type}')
    print(f'  inputs: {list(target.input)}')
    print(f'  outputs: {list(target.output)}')

# Print all Reshape nodes
print('\n=== All Reshape nodes ===')
reshape_count = 0
for node in g.node:
    if node.op_type == 'Reshape':
        reshape_count += 1
        print(f'  [{reshape_count}] {node.name}')
        print(f'      inputs: {list(node.input)}')
        # Try to get shape from second input (if initializer)
        if len(node.input) >= 2:
            shape_name = node.input[1]
            for init in g.initializer:
                if init.name == shape_name:
                    import numpy as np
                    from onnx import numpy_helper
                    arr = numpy_helper.to_array(init)
                    print(f'      shape ({shape_name}): {arr.tolist()}')
                    break
print(f'\nTotal Reshape: {reshape_count}')
