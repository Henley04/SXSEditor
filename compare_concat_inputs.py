# -*- coding: utf-8 -*-
"""Compare production val_90 Concat inputs vs W16A32 val_57 Concat inputs."""
import onnx
from onnx import numpy_helper

def trace_inputs(model_path, concat_name, target_output):
    print(f'\n=== {target_output} in {model_path} ===')
    m = onnx.load(model_path, load_external_data=False)
    g = m.graph
    init_map = {init.name: init for init in g.initializer}
    for node in g.node:
        if node.op_type == 'Concat' and target_output in node.output:
            print(f'  Concat node: {node.name}')
            print(f'  inputs: {list(node.input)}')
            for inp in node.input:
                if inp in init_map:
                    arr = numpy_helper.to_array(init_map[inp])
                    print(f'    {inp} (initializer): {arr.tolist()}')
                else:
                    # Find producer
                    for n2 in g.node:
                        if inp in n2.output:
                            print(f'    {inp} produced by: {n2.op_type} ({n2.name}), inputs={list(n2.input)}')
                            break
            break

# Production val_90
trace_inputs(r'd:\Document\electron\SXSEditor\onnx_models\diff_step_dml.onnx', 'node_Concat_90', 'val_90')

# Trace val_2, val_4, val_88, val_89 in production
print('\n=== Production val_2, val_4, val_88, val_89 deep trace ===')
mp = onnx.load(r'd:\Document\electron\SXSEditor\onnx_models\diff_step_dml.onnx', load_external_data=False)
gp = mp.graph
init_map = {init.name: init for init in gp.initializer}
for target in ['val_2', 'val_4', 'val_88', 'val_89']:
    if target in init_map:
        arr = numpy_helper.to_array(init_map[target])
        print(f'  {target} (init): {arr.tolist()}')
    else:
        for n in gp.node:
            if target in n.output:
                print(f'  {target} produced by {n.op_type} ({n.name}), inputs={list(n.input)}')
                break

# W16A32 val_57
trace_inputs(r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx', 'node_Concat_57', 'val_57')
