# -*- coding: utf-8 -*-
"""Convert FP32 ONNX model to W16A32 by converting only weight initializers to FP16.

与 optimize_onnx.py 的 Olive FP16 转换的区别:
- 不使用 op_block_list (避免 336 个 Cast 节点的 Cast 风暴)
- 只转换 MatMul/Gemm/Conv 的权重初始化器为 FP16
- 激活保持 FP32 (A32)
- 每个 FP16 权重插入一个 Cast(FP16→FP32) 节点
- 总 Cast 节数可控 (约 200-300 个, 而非 336+)

与 dynamo 导出 + FP16 权重的区别:
- 基于已有的 DML EP 兼容的 FP32 ONNX 图
- 保留原始图结构 (DML EP 已验证可运行)
- 只修改权重数据类型和插入 Cast 节点

W16A32 = 权重 FP16 存储 (50% 模型大小), 激活 FP32 计算 (无精度损失)
"""
import os
import sys
import argparse
import onnx
import numpy as np
from onnx import numpy_helper, helper, TensorProto, shape_inference


def convert_w16a32(input_path: str, output_path: str):
    """Convert FP32 ONNX to W16A32 by converting weight initializers to FP16."""
    print(f"Loading: {input_path}")
    # Load with external data
    model = onnx.load(input_path, load_external_data=True)
    graph = model.graph

    # Find weight initializers used by MatMul/Gemm/Conv nodes
    OPS_WITH_WEIGHTS = {'MatMul', 'Gemm', 'Conv', 'ConvTranspose'}
    weight_names = set()
    for node in graph.node:
        if node.op_type in OPS_WITH_WEIGHTS:
            # For MatMul, weight is typically the second input
            # For Gemm, weight is typically the second input (B)
            # For Conv/ConvTranspose, weight is the second input (W)
            if len(node.input) >= 2:
                weight_names.add(node.input[1])

    print(f"  Found {len(weight_names)} weight inputs in MatMul/Gemm/Conv nodes")

    # Convert weight initializers to FP16
    init_map = {init.name: init for init in graph.initializer}
    converted = 0
    for name in weight_names:
        if name in init_map:
            init = init_map[name]
            if init.data_type == TensorProto.FLOAT:
                arr = numpy_helper.to_array(init)
                # Skip very small initializers (e.g., shape tensors)
                if arr.size < 100:
                    continue
                arr_fp16 = arr.astype(np.float16)
                new_init = numpy_helper.from_array(arr_fp16, name=name)
                init.CopyFrom(new_init)
                converted += 1

    print(f"  Converted {converted} weight initializers to FP16")

    if converted == 0:
        print("  No weights to convert, skipping Cast insertion")
        onnx.save(model, output_path)
        return

    # Insert Cast(FP16→FP32) nodes before weight inputs
    cast_insertions = 0
    cast_by_target = {}

    for node in graph.node:
        if node.op_type not in OPS_WITH_WEIGHTS:
            continue
        if len(node.input) < 2:
            continue
        weight_name = node.input[1]
        if weight_name not in init_map:
            continue
        init = init_map[weight_name]
        if init.data_type != TensorProto.FLOAT16:
            continue

        # Need to insert Cast for this weight
        cast_output = f"{weight_name}_w16a32_cast"
        cast_node = helper.make_node(
            'Cast',
            [weight_name],
            [cast_output],
            name=f"{node.name}_w16a32_cast",
            to=TensorProto.FLOAT,
        )
        cast_by_target.setdefault(id(node), (cast_node, 1, cast_output))

    # Apply Cast insertions
    new_node_list = []
    for node in graph.node:
        if id(node) in cast_by_target:
            cast_node, input_idx, cast_output = cast_by_target[id(node)]
            if input_idx < len(node.input):
                new_node_list.append(cast_node)
                node.input[input_idx] = cast_output
                cast_insertions += 1
            else:
                print(f"  Warning: node {node.name} has {len(node.input)} inputs, can't insert Cast at index {input_idx}")
        new_node_list.append(node)

    del graph.node[:]
    graph.node.extend(new_node_list)

    print(f"  Inserted {cast_insertions} Cast(FP16→FP32) nodes")

    # Save
    print(f"  Saving: {output_path}")
    onnx.save(model, output_path)
    del model

    # Verify
    model = onnx.load(output_path, load_external_data=False)
    cast_count = sum(1 for n in model.graph.node if n.op_type == 'Cast')
    total_nodes = sum(1 for n in model.graph.node)
    init_dtypes = {}
    for init in model.graph.initializer:
        init_dtypes[init.data_type] = init_dtypes.get(init.data_type, 0) + 1
    print(f"  Verified: Nodes={total_nodes}, Cast={cast_count}")
    print(f"  Initializers: FP16={init_dtypes.get(10, 0)}, FP32={init_dtypes.get(1, 0)}")
    del model


def main():
    parser = argparse.ArgumentParser(description="Convert FP32 ONNX to W16A32 (weights FP16, activations FP32)")
    parser.add_argument('input', help='Input FP32 ONNX model path')
    parser.add_argument('output', nargs='?', default=None, help='Output W16A32 ONNX model path')
    args = parser.parse_args()

    output = args.output or args.input.replace('.onnx', '_w16a32.onnx')
    convert_w16a32(args.input, output)


if __name__ == '__main__':
    main()
