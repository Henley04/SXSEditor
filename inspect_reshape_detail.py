# -*- coding: utf-8 -*-
"""Inspect val_57 shape and producer of _v_1622."""
import onnx
from onnx import numpy_helper, helper, TensorProto

model_path = r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx'
m = onnx.load(model_path, load_external_data=False)
g = m.graph

# val_57
for init in g.initializer:
    if init.name == 'val_57':
        arr = numpy_helper.to_array(init)
        print(f'val_57 (shape tensor): dtype={arr.dtype}, value={arr.tolist()}')
        break

# Find producer of _v_1622
print('\n=== Producer of _v_1622 ===')
for node in g.node:
    if '_v_1622' in node.output:
        print(f'  Node: {node.name} op={node.op_type}')
        print(f'  inputs: {list(node.input)}')
        print(f'  outputs: {list(node.output)}')
        break

# Find value_info for _v_1622
print('\n=== value_info for _v_1622 ===')
for vi in g.value_info:
    if vi.name == '_v_1622':
        t = vi.type.tensor_type
        dims = [d.dim_value if d.dim_value else d.dim_param for d in t.shape.dim]
        print(f'  shape: {dims}, dtype: {t.elem_type}')
        break

# Check output of node_view_1 (view_1)
print('\n=== value_info for view_1 (output of node_view_1) ===')
for vi in g.value_info:
    if vi.name == 'view_1':
        t = vi.type.tensor_type
        dims = [d.dim_value if d.dim_value else d.dim_param for d in t.shape.dim]
        print(f'  shape: {dims}, dtype: {t.elem_type}')
        break

# Compare with production FP32 model
print('\n=== Production FP32 diff_step_dml.onnx Reshape nodes ===')
prod_path = r'd:\Document\electron\SXSEditor\onnx_models\diff_step_dml.onnx'
mp = onnx.load(prod_path, load_external_data=False)
gp = mp.graph
rcount = 0
for node in gp.node:
    if node.op_type == 'Reshape':
        rcount += 1
        if rcount <= 5:
            print(f'  [{rcount}] {node.name} inputs={list(node.input)}')
print(f'  Total Reshape in prod: {rcount}')
