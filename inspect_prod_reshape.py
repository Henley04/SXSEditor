# -*- coding: utf-8 -*-
"""Inspect production FP32 model Reshape shape sources."""
import onnx
from onnx import numpy_helper

mp = onnx.load(r'd:\Document\electron\SXSEditor\onnx_models\diff_step_dml.onnx', load_external_data=False)
gp = mp.graph

# Check val_90 and val_45
for target in ['val_45', 'val_90', 'val_174']:
    print(f'=== {target} ===')
    # Initializer?
    for init in gp.initializer:
        if init.name == target:
            arr = numpy_helper.to_array(init)
            print(f'  initializer: {arr.tolist()}')
            break
    else:
        # Constant node?
        for node in gp.node:
            if node.op_type == 'Constant' and target in node.output:
                for attr in node.attribute:
                    if attr.name == 'value':
                        arr = numpy_helper.to_array(attr.t)
                        print(f'  Constant node {node.name}: {arr.tolist()}')
                        break
                break
        else:
            # Other producer?
            for node in gp.node:
                if target in node.output:
                    print(f'  produced by: op={node.op_type}, name={node.name!r}')
                    print(f'    inputs: {list(node.input)}')
                    break
            else:
                print('  NOT FOUND')

# Count shape sources for Reshape in production
print('\n=== Production Reshape shape source types ===')
init_names = {init.name for init in gp.initializer}
const_outputs = {}
for n in gp.node:
    if n.op_type == 'Constant':
        for o in n.output:
            const_outputs[o] = n.name

from collections import Counter
src_types = Counter()
for node in gp.node:
    if node.op_type == 'Reshape' and len(node.input) >= 2:
        s = node.input[1]
        if s in init_names:
            src_types['initializer'] += 1
        elif s in const_outputs:
            src_types['constant'] += 1
        else:
            src_types['other'] += 1
print(f'  {dict(src_types)}')

# Same for W16A32
print('\n=== W16A32 Reshape shape source types ===')
mp2 = onnx.load(r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx', load_external_data=False)
gp2 = mp2.graph
init_names2 = {init.name for init in gp2.initializer}
const_outputs2 = {}
for n in gp2.node:
    if n.op_type == 'Constant':
        for o in n.output:
            const_outputs2[o] = n.name

src_types2 = Counter()
for node in gp2.node:
    if node.op_type == 'Reshape' and len(node.input) >= 2:
        s = node.input[1]
        if s in init_names2:
            src_types2['initializer'] += 1
        elif s in const_outputs2:
            src_types2['constant'] += 1
        else:
            src_types2['other'] += 1
            # Show the producer
            for n2 in gp2.node:
                if s in n2.output:
                    print(f'    other: {s} produced by {n2.op_type} ({n2.name})')
                    break
print(f'  {dict(src_types2)}')
