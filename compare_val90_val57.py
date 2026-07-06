# -*- coding: utf-8 -*-
"""Compare production val_90 vs dynamo val_57."""
import onnx
from onnx import numpy_helper

# Production
mp = onnx.load(r'd:\Document\electron\SXSEditor\onnx_models\diff_step_dml.onnx', load_external_data=False)
gp = mp.graph
for init in gp.initializer:
    if init.name == 'val_90':
        arr = numpy_helper.to_array(init)
        print(f'Production val_90: {arr.tolist()}')
        break

# Find all distinct shape initializer values used by Reshape in production
print('\n=== Production Reshape shape initializers (unique) ===')
seen = {}
for node in gp.node:
    if node.op_type == 'Reshape' and len(node.input) >= 2:
        shape_name = node.input[1]
        for init in gp.initializer:
            if init.name == shape_name:
                arr = numpy_helper.to_array(init)
                key = tuple(arr.tolist())
                if key not in seen:
                    seen[key] = shape_name
                    print(f'  {shape_name}: {arr.tolist()}')
                break

# Dynamo W16A32
print('\n=== W16A32 Reshape shape inputs (trace dynamic ones) ===')
mp2 = onnx.load(r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx', load_external_data=False)
gp2 = mp2.graph
init_names = {init.name for init in gp2.initializer}
dynamic_reshape_count = 0
static_reshape_count = 0
for node in gp2.node:
    if node.op_type == 'Reshape' and len(node.input) >= 2:
        if node.input[1] in init_names:
            static_reshape_count += 1
        else:
            dynamic_reshape_count += 1
print(f'  Static (initializer) shape: {static_reshape_count}')
print(f'  Dynamic (computed) shape: {dynamic_reshape_count}')
