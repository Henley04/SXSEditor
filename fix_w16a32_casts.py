# -*- coding: utf-8 -*-
"""Post-process W16A32 ONNX models: insert Cast(FP16→FP32) nodes for mixed-type MatMul/Gemm/Conv inputs.

PyTorch dynamo export with FP16 weights produces ONNX graphs where MatMul/Gemm/Conv nodes
have mixed-type inputs (FP16 weight initializer + FP32 activation). ONNX Runtime requires
all inputs to have the same type, so we need to insert Cast nodes (FP16→FP32) before the
FP16 weight inputs.

This gives true W16A32:
- Weight initializers stored as FP16 (50% model size reduction)
- Cast(FP16→FP32) at each weight input (one Cast per weight, predictable count)
- All computation in FP32 (no precision loss from FP16 activations)
"""
import os
import sys
import argparse
import onnx
from onnx import helper, TensorProto, shape_inference
from pathlib import Path


def get_input_dtype(name, init_dtypes, vi_dtypes, graph_input_dtypes):
    """Get the dtype of a graph input/initializer/value_info entry."""
    if name in init_dtypes:
        return init_dtypes[name]
    if name in vi_dtypes:
        return vi_dtypes[name]
    if name in graph_input_dtypes:
        return graph_input_dtypes[name]
    return None


def insert_casts_for_mixed_types(model_path: str, output_path: str = None):
    """Insert Cast(FP16→FP32) nodes for MatMul/Gemm/Conv with mixed-type inputs."""
    if output_path is None:
        output_path = model_path

    print(f"Loading: {model_path}")
    model = onnx.load(model_path, load_external_data=False)
    graph = model.graph

    # Build dtype maps
    init_dtypes = {}
    for init in graph.initializer:
        init_dtypes[init.name] = init.data_type  # 1=FP32, 10=FP16

    vi_dtypes = {}
    for vi in graph.value_info:
        vi_dtypes[vi.name] = vi.type.tensor_type.elem_type

    graph_input_dtypes = {}
    for gi in graph.input:
        graph_input_dtypes[gi.name] = gi.type.tensor_type.elem_type

    # Find nodes with mixed-type inputs
    OPS_TO_CHECK = {'MatMul', 'Gemm', 'Conv', 'ConvTranspose'}
    cast_insertions = 0
    new_nodes_to_insert = []

    for node in graph.node:
        if node.op_type not in OPS_TO_CHECK:
            continue

        # Get dtypes of all inputs
        input_dtypes_list = []
        for inp_name in node.input:
            if not inp_name:
                input_dtypes_list.append(None)
                continue
            dt = get_input_dtype(inp_name, init_dtypes, vi_dtypes, graph_input_dtypes)
            input_dtypes_list.append(dt)

        # Check if there are mixed types (both FP16 and FP32)
        has_fp16 = any(d == TensorProto.FLOAT16 for d in input_dtypes_list)
        has_fp32 = any(d == TensorProto.FLOAT for d in input_dtypes_list)

        if not (has_fp16 and has_fp32):
            continue

        # Insert Cast(FP16→FP32) for each FP16 input
        for i, inp_name in enumerate(node.input):
            if not inp_name:
                continue
            dt = input_dtypes_list[i]
            if dt == TensorProto.FLOAT16:
                cast_name = f"{node.name}_cast_{i}"
                cast_output = f"{inp_name}_cast_fp32"
                cast_node = helper.make_node(
                    'Cast',
                    [inp_name],
                    [cast_output],
                    name=cast_name,
                    to=TensorProto.FLOAT,
                )
                new_nodes_to_insert.append((node, i, cast_node, cast_output))
                cast_insertions += 1

    if cast_insertions == 0:
        print(f"  No Cast insertions needed.")
        return

    # Apply the insertions
    cast_by_target = {}
    for node, input_idx, cast_node, cast_output in new_nodes_to_insert:
        cast_by_target.setdefault(id(node), []).append((input_idx, cast_node, cast_output))

    new_node_list = []
    for node in graph.node:
        if id(node) in cast_by_target:
            for input_idx, cast_node, cast_output in cast_by_target[id(node)]:
                new_node_list.append(cast_node)
                # Replace the input with the Cast output
                node.input[input_idx] = cast_output
        new_node_list.append(node)

    del graph.node[:]
    graph.node.extend(new_node_list)

    print(f"  Inserted {cast_insertions} Cast(FP16→FP32) nodes")

    # Save (skip shape_inference which may introduce encoding issues with DML EP)
    print(f"  Saving: {output_path}")
    onnx.save(model, output_path)
    del model

    # Verify
    model = onnx.load(output_path, load_external_data=False)
    cast_count = sum(1 for n in model.graph.node if n.op_type == 'Cast')
    total_nodes = sum(1 for n in model.graph.node)
    print(f"  Verified: Nodes={total_nodes}, Cast={cast_count}")

    # Re-check for mixed types
    init_dtypes2 = {i.name: i.data_type for i in model.graph.initializer}
    vi_dtypes2 = {vi.name: vi.type.tensor_type.elem_type for vi in model.graph.value_info}
    gi_dtypes2 = {gi.name: gi.type.tensor_type.elem_type for gi in model.graph.input}
    mixed_count = 0
    for node in model.graph.node:
        if node.op_type not in OPS_TO_CHECK:
            continue
        dtypes = [get_input_dtype(inp, init_dtypes2, vi_dtypes2, gi_dtypes2) for inp in node.input if inp]
        if len(set(d for d in dtypes if d is not None)) > 1:
            mixed_count += 1
            if mixed_count <= 3:
                print(f"  Still mixed: {node.name} ({node.op_type}): {[(inp, get_input_dtype(inp, init_dtypes2, vi_dtypes2, gi_dtypes2)) for inp in node.input]}")
    if mixed_count == 0:
        print(f"  No mixed-type nodes remaining")
    del model


def main():
    parser = argparse.ArgumentParser(description="Fix W16A32 ONNX models by inserting Cast nodes")
    parser.add_argument('models', nargs='+', help='ONNX model paths to fix')
    parser.add_argument('--output', nargs='?', default=None, help='Output path (single model only)')
    args = parser.parse_args()

    for model_path in args.models:
        if len(args.models) == 1 and args.output:
            insert_casts_for_mixed_types(model_path, args.output)
        else:
            insert_casts_for_mixed_types(model_path)


if __name__ == '__main__':
    main()
