# -*- coding: utf-8 -*-
"""
从原始 INT8 模型构建 NPU 优化版本。

优化步骤:
  1. 复制原始 INT8 模型到 optimized_npu/ 目录
  2. 替换 NPU 不支持的算子:
     - DynamicQuantizeLinear + MatMulInteger/ConvInteger → DequantizeLinear + MatMul/Conv
     - STFT → Conv1d(cos/sin) + 幅度计算
     - ReduceL2 → Sqrt(ReduceSum(Mul(x,x)))
     - Range → 预计算常量
  3. 固定所有动态维度为静态值
  4. 使用 onnxsim 简化图（常量折叠、死代码消除等）
  5. 验证 NPU 兼容性

NPU 约束:
  - 仅支持静态 shape
  - 支持 DequantizeLinear, MatMul, Conv, ConvTranspose, GRU, LSTM 等
  - 不支持: DynamicQuantizeLinear, MatMulInteger, ConvInteger, STFT,
           QLinearConv, DeformConv, AdaptivePool, GroupNorm, Scan, Loop,
           FlashAttention, Unique, CumProd
"""

import os
import sys
import shutil
import gc
import argparse
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto, shape_inference

try:
    import onnxsim
    HAS_ONNXSIM = True
except ImportError:
    HAS_ONNXSIM = False
    print("Warning: onnxsim not installed, will skip graph simplification step")

BASE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'onnx_models')
SRC_DIR = os.path.join(BASE_DIR, 'int8')
OUT_DIR = os.path.join(SRC_DIR, 'optimized_npu')

# --- 默认静态维度 ---
DEFAULT_SHAPES = {
    'batch_size': 1,
    'seq_len': 2048,
    'num_samples': 240000,   # 10s @ 24kHz
    'time_frames': 1500,     # 240000 / 160 (hop=160 for rmvpe)
}

# --- 需要替换的 NPU 不支持算子 ---
UNSUPPORTED_OPS = {
    'DynamicQuantizeLinear', 'MatMulInteger', 'ConvInteger', 'STFT',
}

# --- 可分解的算子 ---
DECOMPOSABLE_OPS = {'ReduceL2', 'Range'}


# ============================================================
# 工具函数
# ============================================================

def ensure_node_names(graph):
    """确保所有节点都有唯一名称"""
    used = {n.name for n in graph.node if n.name}
    counter = 0
    for node in graph.node:
        if not node.name:
            while f"node_{counter}" in used:
                counter += 1
            node.name = f"node_{counter}"
            used.add(node.name)
            counter += 1


def list_ops(model):
    """列出模型中所有算子及其数量"""
    ops = {}
    for node in model.graph.node:
        ops[node.op_type] = ops.get(node.op_type, 0) + 1
    return ops


def find_initializer(graph, name):
    for init in graph.initializer:
        if init.name == name:
            return init
    return None


def remove_initializer(graph, name):
    for i, init in enumerate(graph.initializer):
        if init.name == name:
            del graph.initializer[i]
            return True
    return False


def ensure_opset_version(model, min_version=13):
    """确保 opset 版本足够高"""
    for opset in model.opset_import:
        if opset.domain in ('', 'ai.onnx'):
            if opset.version < min_version:
                print(f"  Upgrading opset: {opset.version} -> {min_version}")
                opset.version = min_version
            return
    model.opset_import.append(helper.make_opsetid('', min_version))


def check_npu_compatibility(model):
    """检查模型中是否还有 NPU 不支持的算子"""
    unsupported = {}
    for node in model.graph.node:
        if node.op_type in UNSUPPORTED_OPS:
            unsupported[node.op_type] = unsupported.get(node.op_type, 0) + 1
    return unsupported


def clean_unused_initializers(model):
    """清理不再被引用的初始化器"""
    graph = model.graph
    used = set()
    for node in graph.node:
        for inp in node.input:
            if inp:
                used.add(inp)
    for out in graph.output:
        used.add(out.name)
    to_remove = [init.name for init in graph.initializer if init.name not in used]
    for name in to_remove:
        remove_initializer(graph, name)
    if to_remove:
        print(f"  Cleaned {len(to_remove)} unused initializers")
    return model


WEBNN_MAX_TENSOR_BYTES = 2 * 1024 * 1024 * 1024  # WebNN 2GB 单张量限制


# ============================================================
# 预反量化: DequantizeLinear → 直接使用 FP32 权重
# ============================================================

def pre_dequantize_dql(model):
    """
    预反量化所有 DequantizeLinear 节点。
    将 INT8 权重 × scale 转换为 FP32，移除 DQL 节点，
    使消费者节点（MatMul/Gemm/Conv）直接使用 FP32 权重。

    这大幅减少 NPU 编译器需要处理的节点数，
    因为每个 DQL 节点都需要 NPU 单独编译一个 kernel。
    """
    graph = model.graph
    nodes_to_remove = set()
    initializers_to_remove = set()
    new_initializers = []
    replaced = 0

    # 建立 initializer 查找表
    init_map = {}
    for init in graph.initializer:
        init_map[init.name] = init

    for node in list(graph.node):
        if node.op_type != 'DequantizeLinear':
            continue

        weight_name = node.input[0]
        scale_name = node.input[1]
        zp_name = node.input[2] if len(node.input) > 2 else None
        dql_output = node.output[0]

        weight_init = init_map.get(weight_name)
        scale_init = init_map.get(scale_name)
        if weight_init is None or scale_init is None:
            continue

        scale_arr = numpy_helper.to_array(scale_init)
        weight_arr = numpy_helper.to_array(weight_init)

        # 获取 zero-point
        zp_arr = None
        if zp_name:
            zp_init = init_map.get(zp_name)
            if zp_init is not None:
                zp_arr = numpy_helper.to_array(zp_init)

        if scale_arr.size == 1:
            # per-tensor 量化: 标量 scale
            scale_val = float(scale_arr.item())
            zp_val = float(zp_arr.item()) if zp_arr is not None and zp_arr.size == 1 else 0
            fp32_weight = (weight_arr.astype(np.float32) - zp_val) * scale_val
        else:
            # per-channel 量化: scale 形状 [out_channels]
            # WebNN 要求 scale rank == input rank，但 ORT 量化输出为 1D scale
            # 直接预反量化权重，绕过 WebNN 的 rank 检查
            # 从节点属性读取量化轴（DequantizeLinear opset 13+ 默认 axis=0）
            axis = 0
            for attr in node.attribute:
                if attr.name == 'axis':
                    axis = attr.i
                    break

            # 构建广播形状: 将 scale 从 [C] 扩展到权重形状
            w_shape = list(weight_arr.shape)
            broadcast_shape = [1] * len(w_shape)
            broadcast_shape[axis] = len(scale_arr)
            scale_reshaped = scale_arr.reshape(broadcast_shape).astype(np.float32)

            if zp_arr is not None and zp_arr.size > 1:
                zp_reshaped = zp_arr.reshape(broadcast_shape).astype(np.float32)
            else:
                zp_val = float(zp_arr.item()) if zp_arr is not None and zp_arr.size == 1 else 0
                zp_reshaped = np.float32(zp_val)

            fp32_weight = (weight_arr.astype(np.float32) - zp_reshaped) * scale_reshaped
        new_init = numpy_helper.from_array(fp32_weight, name=weight_name)
        new_initializers.append(new_init)

        # 将 DQL 输出的所有消费者节点的输入重定向到 fp32 权重
        for consumer in graph.node:
            if consumer.name in nodes_to_remove:
                continue
            for idx, inp in enumerate(consumer.input):
                if inp == dql_output:
                    consumer.input[idx] = weight_name

        # 标记删除 DQL 节点和 scale/zp initializers
        nodes_to_remove.add(node.name)
        initializers_to_remove.add(scale_name)
        if zp_name:
            initializers_to_remove.add(zp_name)
        replaced += 1

    # 应用更改
    if nodes_to_remove:
        remaining = [n for n in graph.node if n.name not in nodes_to_remove]
        del graph.node[:]
        graph.node.extend(remaining)

    # 替换旧的 weight initializer（已被 FP32 版本替换）
    # 先删除被替换的旧 initializer，再添加新的
    removed_init_names = set()
    for new_init in new_initializers:
        for i, old_init in enumerate(graph.initializer):
            if old_init.name == new_init.name:
                del graph.initializer[i]
                removed_init_names.add(new_init.name)
                break
    graph.initializer.extend(new_initializers)

    # 删除 scale/zp initializers
    to_remove_final = [init for init in graph.initializer if init.name in initializers_to_remove]
    for init in to_remove_final:
        graph.initializer.remove(init)

    print(f"  Pre-dequantization: replaced {replaced} DequantizeLinear nodes")
    return model, replaced


# ============================================================
# W8A8: 修正 DequantizeLinear scale rank（保留 INT8 权重）
# ============================================================

def fix_w8a8_scale_rank(model):
    """
    W8A8 模式: 保留 DequantizeLinear 节点（INT8 权重），
    但修正 scale/zp 的 rank 以匹配 WebNN 要求（scale rank == input rank）。

    WebNN 的 dequantizeLinear 要求 scale 的 rank 等于 input 的 rank。
    onnxruntime 量化输出的 scale 通常是标量(rank=0) 或 1D(rank=1)。
    需要 reshape 为与 input 同 rank 的 broadcast 形状。

    例如: input=[1,512,2048], scale=[512] → scale reshape 为 [1,512,1]
    """
    graph = model.graph
    fixed = 0

    # 建立 value_info 形状查找表
    shape_map = {}
    for vi in graph.value_info:
        if vi.type.tensor_type.HasField('shape'):
            dims = []
            for d in vi.type.tensor_type.shape.dim:
                dims.append(d.dim_value if d.dim_value > 0 else 1)
            shape_map[vi.name] = dims
    for inp in graph.input:
        if inp.type.tensor_type.HasField('shape'):
            dims = []
            for d in inp.type.tensor_type.shape.dim:
                dims.append(d.dim_value if d.dim_value > 0 else 1)
            shape_map[inp.name] = dims

    # 建立 initializer 查找表
    init_map = {init.name: init for init in graph.initializer}

    for node in list(graph.node):
        if node.op_type != 'DequantizeLinear':
            continue

        input_name = node.input[0]
        scale_name = node.input[1]
        zp_name = node.input[2] if len(node.input) > 2 else None

        scale_init = init_map.get(scale_name)
        if scale_init is None:
            continue

        scale_arr = numpy_helper.to_array(scale_init)

        # 获取 input rank
        input_shape = shape_map.get(input_name)
        if input_shape is None:
            # 尝试从 initializer 获取
            input_init = init_map.get(input_name)
            if input_init is not None:
                input_shape = list(input_init.dims)
            else:
                continue

        input_rank = len(input_shape)

        # scale rank 已经匹配，跳过
        if scale_arr.ndim == input_rank:
            continue

        # 获取量化轴
        axis = 0
        for attr in node.attribute:
            if attr.name == 'axis':
                axis = attr.i
                break

        # 构建 broadcast 形状
        if scale_arr.size == 1:
            # 标量 → [1, 1, ..., 1]
            new_shape = [1] * input_rank
        else:
            # 1D [C] → 在 axis 维度放 C，其余为 1
            new_shape = [1] * input_rank
            new_shape[axis] = len(scale_arr)

        new_scale = scale_arr.reshape(new_shape).astype(np.float32)
        new_scale_init = numpy_helper.from_array(new_scale, name=scale_name)

        # 替换 initializer
        for i, init in enumerate(graph.initializer):
            if init.name == scale_name:
                del graph.initializer[i]
                break
        graph.initializer.append(new_scale_init)

        # 同样处理 zero-point
        if zp_name:
            zp_init = init_map.get(zp_name)
            if zp_init is not None:
                zp_arr = numpy_helper.to_array(zp_init)
                if zp_arr.ndim != input_rank:
                    if zp_arr.size == 1:
                        new_zp_shape = [1] * input_rank
                    else:
                        new_zp_shape = [1] * input_rank
                        new_zp_shape[axis] = len(zp_arr)
                    new_zp = zp_arr.reshape(new_zp_shape)
                    new_zp_init = numpy_helper.from_array(new_zp, name=zp_name)
                    for i, init in enumerate(graph.initializer):
                        if init.name == zp_name:
                            del graph.initializer[i]
                            break
                    graph.initializer.append(new_zp_init)

        fixed += 1

    # 更新 UNSUPPORTED_OPS 以允许 DequantizeLinear
    UNSUPPORTED_OPS.discard('DequantizeLinear')

    print(f"  W8A8 scale rank fix: {fixed} DequantizeLinear nodes")
    return model, fixed


# ============================================================
# 元数据清理
# ============================================================

def strip_metadata(model):
    """移除模型中的冗余元数据（训练信息、文档字符串等）"""
    removed = 0

    # 清除模型级元数据
    n_props = len(model.metadata_props)
    del model.metadata_props[:]
    removed += n_props

    # 清除模型 doc_string
    if model.doc_string:
        model.doc_string = ""
        removed += 1

    # 清除图 doc_string
    if model.graph.doc_string:
        model.graph.doc_string = ""
        removed += 1

    # 清除节点 doc_string
    for node in model.graph.node:
        if node.doc_string:
            node.doc_string = ""
            removed += 1

    # 清除函数 doc_string
    for func in model.functions:
        if func.doc_string:
            func.doc_string = ""
            removed += 1

    if removed > 0:
        print(f"  Cleaned {removed} metadata entries")
    return model


def estimate_istft_intermediate_bytes(seq_len, n_fft=1922, hop_size=480):
    """估算 vocoder ISTFT Pad 中间张量的字节数

    ISTFT 流程: Cat→Reshape→Pad→Reshape→Conv
    Pad 输出: [1, n_fft, seq_len, hop_size] = 4 * n_fft * seq_len * hop_size 字节
    """
    return 4 * n_fft * seq_len * hop_size


def find_max_vocoder_seq_len(n_fft=1922, hop_size=480, max_bytes=None):
    """二分查找 vocoder 在 WebNN 限制内的最大 seq_len"""
    if max_bytes is None:
        max_bytes = int(WEBNN_MAX_TENSOR_BYTES * 0.95)  # 留 5% 余量
    lo, hi = 1, 4096
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if estimate_istft_intermediate_bytes(mid, n_fft, hop_size) <= max_bytes:
            lo = mid
        else:
            hi = mid - 1
    return lo


def validate_vocoder_shapes(model, seq_len):
    """验证 vocoder 模型的中间张量大小是否在 WebNN 限制内"""
    # 从模型中提取 ISTFT Conv 参数
    n_fft = 1922  # 默认值
    hop_size = 480  # 默认值

    graph = model.graph
    for node in graph.node:
        if node.op_type == 'Pad':
            # 检查 Pad 是否是 ISTFT 的 Pad
            for inp_name in node.input[1:]:
                init = find_initializer(graph, inp_name)
                if init is not None:
                    arr = numpy_helper.to_array(init)
                    if arr.dtype in (np.int64, np.int32) and len(arr) >= 8:
                        # ONNX Pad: [begin_batch, begin_C, begin_H, begin_W, end_batch, end_C, end_H, end_W]
                        last_pad = int(arr[-1])
                        if 0 < last_pad < 1000:
                            hop_size = last_pad + 1
                            break

    # 从 Conv 权重推断 n_fft
    for node in graph.node:
        if node.name and 'convolution' in node.name and node.op_type == 'Conv':
            weight_init = find_initializer(graph, node.input[1])
            if weight_init is not None:
                w_shape = list(weight_init.dims)
                if len(w_shape) >= 2:
                    n_fft = w_shape[1]
            break

    pad_bytes = estimate_istft_intermediate_bytes(seq_len, n_fft, hop_size)
    pad_gb = pad_bytes / (1024 ** 3)

    print(f"  ISTFT intermediate tensor estimate: [1,{n_fft},{seq_len},{hop_size}] = {pad_gb:.2f} GB")
    if pad_bytes > WEBNN_MAX_TENSOR_BYTES:
        max_safe = find_max_vocoder_seq_len(n_fft, hop_size)
        print(f"  [WARN] Exceeds WebNN 2GB limit! Recommend seq_len <= {max_safe}")
        return False, max_safe
    else:
        print(f"  [OK] Within WebNN limit ({pad_gb:.2f} GB < 2.00 GB)")
        return True, seq_len


def topological_sort_nodes(graph):
    """拓扑排序节点"""
    from collections import deque

    available = set()
    for inp in graph.input:
        available.add(inp.name)
    for init in graph.initializer:
        available.add(init.name)

    output_to_node = {}
    for node in graph.node:
        for out in node.output:
            output_to_node[out] = node

    nodes = list(graph.node)
    node_by_name = {n.name: n for n in nodes}
    in_degree = {}
    dependents = {}

    for node in nodes:
        deps = 0
        for inp in node.input:
            if inp and inp not in available and inp in output_to_node:
                dep_node = output_to_node[inp]
                if dep_node.name != node.name:
                    deps += 1
                    dependents.setdefault(dep_node.name, []).append(node.name)
        in_degree[node.name] = deps

    queue = deque(name for name, deg in in_degree.items() if deg == 0)
    sorted_names = []
    while queue:
        name = queue.popleft()
        sorted_names.append(name)
        for dep_name in dependents.get(name, []):
            in_degree[dep_name] -= 1
            if in_degree[dep_name] == 0:
                queue.append(dep_name)

    if len(sorted_names) != len(nodes):
        print(f"    Warning: topological sort incomplete ({len(sorted_names)}/{len(nodes)})")
        return

    del graph.node[:]
    for name in sorted_names:
        graph.node.append(node_by_name[name])


# ============================================================
# 算子替换: DynamicQuantizeLinear + MatMulInteger/ConvInteger
# ============================================================

def replace_dql_matmul_chain(model):
    """
    替换 DQL + MatMulInteger/ConvInteger 链
    为 DequantizeLinear + MatMul/Conv

    图模式:
      FP32_input → DQL → (int8_in, scale, zp)
      int8_in + weight + zp_w → MatMulInteger → int32_out
      int32_out → Cast(float) → mul_scale → FP32_result

    替换为:
      weight + scale + zp → DequantizeLinear → FP32_weight
      FP32_input + FP32_weight → MatMul → FP32_result
    """
    graph = model.graph
    nodes_to_remove = set()
    new_nodes = []
    new_initializers = []
    replaced = 0

    output_to_node = {}
    for node in graph.node:
        for out in node.output:
            output_to_node[out] = node

    for quant_node in list(graph.node):
        if quant_node.op_type not in ('MatMulInteger', 'ConvInteger'):
            continue

        is_matmul = quant_node.op_type == 'MatMulInteger'
        weight_name = quant_node.input[1]
        weight_zp_name = quant_node.input[3] if len(quant_node.input) > 3 else None
        if weight_zp_name == '':
            weight_zp_name = None

        # 找 Cast 节点
        quant_output = quant_node.output[0]
        cast_node = None
        for node in graph.node:
            if node.op_type == 'Cast' and quant_output in node.input:
                cast_node = node
                break
        if cast_node is None:
            print(f"    Warning: Cast not found for {quant_node.name}")
            continue

        cast_output = cast_node.output[0]

        # 找 output Mul 节点
        output_mul_node = None
        for node in graph.node:
            if node.op_type == 'Mul' and cast_output in node.input:
                output_mul_node = node
                break
        if output_mul_node is None:
            print(f"    Warning: output Mul not found for {cast_node.name}")
            continue

        # combined_scale
        combined_scale_name = None
        for inp in output_mul_node.input:
            if inp != cast_output:
                combined_scale_name = inp
                break

        # 找 scale Mul 节点
        scale_mul_node = output_to_node.get(combined_scale_name)
        if scale_mul_node is None or scale_mul_node.op_type != 'Mul':
            scale_mul_node = None
            weight_scale_name = combined_scale_name
        else:
            dql_scale_name = None
            weight_scale_name = None
            for inp in scale_mul_node.input:
                producer = output_to_node.get(inp)
                if producer and producer.op_type == 'DynamicQuantizeLinear':
                    dql_scale_name = inp
                else:
                    weight_scale_name = inp
            if weight_scale_name is None:
                print(f"    Warning: weight_scale not found for {quant_node.name}")
                continue

        # 找 DQL 节点
        int8_input = quant_node.input[0]
        dql_node = output_to_node.get(int8_input)
        if dql_node is None or dql_node.op_type != 'DynamicQuantizeLinear':
            print(f"    Warning: DQL not found for {quant_node.name}")
            continue

        fp32_input = dql_node.input[0]

        # 创建 DequantizeLinear 节点
        dequant_output_name = f"{weight_name}_dequant"
        dql_inputs = [weight_name, weight_scale_name]

        if weight_zp_name:
            dql_inputs.append(weight_zp_name)
        else:
            zp_name = f"{weight_name}_zp_default"
            weight_init = find_initializer(graph, weight_name)
            if weight_init:
                zp_dtype = onnx.mapping.TENSOR_TYPE_TO_NP_TYPE[weight_init.data_type]
            else:
                zp_dtype = np.int8
            new_initializers.append(numpy_helper.from_array(
                np.array(0, dtype=zp_dtype), name=zp_name
            ))
            dql_inputs.append(zp_name)

        dql_attrs = {}
        weight_scale_init = find_initializer(graph, weight_scale_name)
        if weight_scale_init:
            scale_array = numpy_helper.to_array(weight_scale_init)
            if scale_array.ndim > 0 and len(scale_array) > 1:
                weight_init = find_initializer(graph, weight_name)
                if weight_init:
                    w_shape = list(weight_init.dims)
                    s_len = len(scale_array)
                    for i, dim in enumerate(w_shape):
                        if dim == s_len:
                            dql_attrs['axis'] = i
                            break
                    else:
                        dql_attrs['axis'] = 1
                else:
                    dql_attrs['axis'] = 1

        dequant_node = helper.make_node(
            'DequantizeLinear', inputs=dql_inputs,
            outputs=[dequant_output_name],
            name=f"{quant_node.name}_dequant", **dql_attrs,
        )
        new_nodes.append(dequant_node)

        final_output = output_mul_node.output[0]

        if is_matmul:
            new_node = helper.make_node(
                'MatMul', inputs=[fp32_input, dequant_output_name],
                outputs=[final_output],
                name=f"{quant_node.name}_replaced",
            )
        else:
            conv_attrs = {}
            for attr in quant_node.attribute:
                if attr.name == 'auto_pad':
                    conv_attrs['auto_pad'] = attr.s.decode('utf-8') if attr.s else 'NOTSET'
                elif attr.name == 'group':
                    conv_attrs['group'] = attr.i
                elif attr.name == 'dilations':
                    conv_attrs['dilations'] = list(attr.ints)
                elif attr.name == 'pads':
                    conv_attrs['pads'] = list(attr.ints)
                elif attr.name == 'strides':
                    conv_attrs['strides'] = list(attr.ints)
            new_node = helper.make_node(
                'Conv', inputs=[fp32_input, dequant_output_name],
                outputs=[final_output],
                name=f"{quant_node.name}_replaced", **conv_attrs,
            )

        new_nodes.append(new_node)

        nodes_to_remove.add(quant_node.name)
        nodes_to_remove.add(cast_node.name)
        nodes_to_remove.add(output_mul_node.name)
        if scale_mul_node is not None:
            nodes_to_remove.add(scale_mul_node.name)

        # 检查 DQL 是否仍被需要
        dql_outputs = set(dql_node.output)
        dql_still_needed = False
        for node in graph.node:
            if node.name in nodes_to_remove:
                continue
            for inp in node.input:
                if inp in dql_outputs:
                    dql_still_needed = True
                    break
            if dql_still_needed:
                break
        if not dql_still_needed:
            nodes_to_remove.add(dql_node.name)

        replaced += 1

    if nodes_to_remove:
        remaining = [n for n in graph.node if n.name not in nodes_to_remove]
        del graph.node[:]
        graph.node.extend(remaining)
        graph.node.extend(new_nodes)
    graph.initializer.extend(new_initializers)

    print(f"  Replaced {replaced} DQL+MatMulInt/ConvInt chains")
    return model, replaced


# ============================================================
# 算子替换: STFT → Conv1d(cos/sin) + 幅度计算
# ============================================================

def replace_stft(model):
    """
    替换 STFT 算子为 Conv1d(cos/sin kernel) + 幅度计算。

    STFT(signal, frame_step, window, frame_length, onesided=1)
    输出 [batch, num_frames, fft_size/2+1, 2]（复数）

    替换为:
      Conv1d(signal, cos_kernel, stride=hop) → real [batch, num_freq, frames]
      Conv1d(signal, sin_kernel, stride=hop) → imag [batch, num_freq, frames]
      magnitude = sqrt(real^2 + imag^2) [batch, num_freq, frames]

    同时替换后续链:
      - Transpose → Pow → ReduceSum → Sqrt（mel_transform 模式）
      - Transpose → Pow → ReduceSum → Add → Sqrt（preprocess 模式）
    """
    graph = model.graph
    nodes_to_remove = set()
    new_nodes = []
    new_initializers = []
    replaced = 0

    for stft_node in list(graph.node):
        if stft_node.op_type != 'STFT':
            continue

        signal_name = stft_node.input[0]
        frame_step_name = stft_node.input[1]
        window_name = stft_node.input[2]
        frame_length_name = stft_node.input[3] if len(stft_node.input) > 3 else None

        # 获取参数（支持 initializer 和 Constant 节点输出）
        def get_constant_value(graph, name):
            """从 initializer 或 Constant 节点获取常量值"""
            init = find_initializer(graph, name)
            if init is not None:
                return numpy_helper.to_array(init)
            for node in graph.node:
                if node.op_type == 'Constant' and name in node.output:
                    for attr in node.attribute:
                        if attr.name == 'value':
                            return numpy_helper.to_array(attr.t)
            return None

        frame_step_val = get_constant_value(graph, frame_step_name)
        window_val = get_constant_value(graph, window_name)
        frame_length_val = get_constant_value(graph, frame_length_name) if frame_length_name else None

        if frame_step_val is None or window_val is None:
            print(f"    Warning: STFT {stft_node.name} missing constant parameters, skipping")
            continue

        hop_size = int(frame_step_val.item())
        window = window_val.astype(np.float32)
        n_fft = len(window)
        if frame_length_val is not None:
            n_fft = int(frame_length_val.item())

        onesided = False
        for attr in stft_node.attribute:
            if attr.name == 'onesided':
                onesided = attr.i == 1

        num_freq = n_fft // 2 + 1 if onesided else n_fft

        # 计算 Conv1d 核
        n = np.arange(n_fft, dtype=np.float32)
        k = np.arange(num_freq, dtype=np.float32).reshape(-1, 1)
        angles = 2 * np.pi * k * n / n_fft

        cos_kernel = (window * np.cos(angles)).reshape(num_freq, 1, n_fft).astype(np.float32)
        sin_kernel = (window * (-np.sin(angles))).reshape(num_freq, 1, n_fft).astype(np.float32)

        cos_kernel_name = f"{stft_node.name}_cos_kernel"
        sin_kernel_name = f"{stft_node.name}_sin_kernel"
        new_initializers.append(numpy_helper.from_array(cos_kernel, name=cos_kernel_name))
        new_initializers.append(numpy_helper.from_array(sin_kernel, name=sin_kernel_name))

        # Conv1d 输入：STFT 接受 1D/2D 信号，但 Conv 需要 3D [batch, channels, length]
        # 回溯 Squeeze → Pad，找到 Pad 输出（已经是 3D: [batch, 1, padded_length]）
        stft_input = signal_name
        squeeze_node = None
        pad_output = None
        for n2 in graph.node:
            if n2.op_type == 'Squeeze' and stft_input in n2.output:
                squeeze_node = n2
                # 回溯到 Pad 输出
                for n3 in graph.node:
                    if n3.op_type == 'Pad' and n2.input[0] in n3.output:
                        pad_output = n3.output[0]
                        break
                break

        if pad_output:
            # Pad 输出已经是 3D [batch, 1, padded_length]，直接用
            conv_input = pad_output
        else:
            # 如果没有 Squeeze → Pad 链，检查信号维度
            # 对于 preprocess 模型，信号来自 If 节点，可能是 2D [batch, length]
            # 需要 Unsqueeze 使其成为 3D
            signal_is_3d = False
            for vi in graph.value_info:
                if vi.name == stft_input:
                    dims = [d.dim_value for d in vi.type.tensor_type.shape.dim]
                    if len(dims) == 3:
                        signal_is_3d = True
                    break

            if not signal_is_3d:
                unsqueeze_name = f"{stft_node.name}_signal_3d"
                unsqueeze_node = helper.make_node(
                    'Unsqueeze', [stft_input, f"{stft_node.name}_axes_3d"],
                    [unsqueeze_name],
                    name=f"{stft_node.name}_unsqueeze_signal",
                )
                unsqueeze_axes = np.array([1], dtype=np.int64)
                new_initializers.append(numpy_helper.from_array(
                    unsqueeze_axes, name=f"{stft_node.name}_axes_3d"
                ))
                new_nodes.append(unsqueeze_node)
                conv_input = unsqueeze_name
            else:
                conv_input = stft_input

        # 创建 Conv1d
        real_name = f"{stft_node.name}_real"
        imag_name = f"{stft_node.name}_imag"
        real_sq = f"{stft_node.name}_real_sq"
        imag_sq = f"{stft_node.name}_imag_sq"
        mag_sq = f"{stft_node.name}_mag_sq"

        # 替换后续链，找到最终输出名称
        stft_output = stft_node.output[0]

        # 找 Transpose（紧接 STFT 输出）
        trans_node = None
        for n2 in graph.node:
            if n2.op_type == 'Transpose' and stft_output in n2.input:
                trans_node = n2
                break

        if trans_node is None:
            print(f"    Warning: Transpose after STFT not found, skipping")
            continue

        trans_output = trans_node.output[0]

        # 找 Pow
        pow_node = None
        for n2 in graph.node:
            if n2.op_type == 'Pow' and trans_output in n2.input:
                pow_node = n2
                break
        if pow_node is None:
            print(f"    Warning: Pow not found, skipping")
            continue

        # 找 ReduceSum
        reduce_node = None
        for n2 in graph.node:
            if n2.op_type == 'ReduceSum' and pow_node.output[0] in n2.input:
                reduce_node = n2
                break
        if reduce_node is None:
            print(f"    Warning: ReduceSum not found, skipping")
            continue

        # 找最终 Sqrt（可能经过 Add）
        current = reduce_node.output[0]
        sqrt_node = None
        add_node = None
        for n2 in graph.node:
            if n2.op_type == 'Add' and current in n2.input:
                add_node = n2
                current = n2.output[0]
                break
        for n2 in graph.node:
            if n2.op_type == 'Sqrt' and current in n2.input:
                sqrt_node = n2
                break

        if sqrt_node is None:
            print(f"    Warning: Sqrt not found, skipping")
            continue

        # 最终输出名称（原 Sqrt 的输出）
        final_output = sqrt_node.output[0]

        # 创建所有替换节点，magnitude 直接写入 final_output
        new_nodes.extend([
            helper.make_node('Conv', [conv_input, cos_kernel_name], [real_name],
                             name=f"{stft_node.name}_conv_cos", strides=[hop_size]),
            helper.make_node('Conv', [conv_input, sin_kernel_name], [imag_name],
                             name=f"{stft_node.name}_conv_sin", strides=[hop_size]),
            helper.make_node('Mul', [real_name, real_name], [real_sq],
                             name=f"{stft_node.name}_mul_real"),
            helper.make_node('Mul', [imag_name, imag_name], [imag_sq],
                             name=f"{stft_node.name}_mul_imag"),
            helper.make_node('Add', [real_sq, imag_sq], [mag_sq],
                             name=f"{stft_node.name}_add_mag"),
            helper.make_node('Sqrt', [mag_sq], [final_output],
                             name=f"{stft_node.name}_sqrt_mag"),
        ])

        # 标记删除
        nodes_to_remove.add(stft_node.name)
        nodes_to_remove.add(trans_node.name)
        nodes_to_remove.add(pow_node.name)
        nodes_to_remove.add(reduce_node.name)
        nodes_to_remove.add(sqrt_node.name)
        if add_node:
            nodes_to_remove.add(add_node.name)
        if squeeze_node:
            nodes_to_remove.add(squeeze_node.name)

        replaced += 1
        print(f"    Replaced STFT -> Conv1d + magnitude: {stft_node.name}")

    if nodes_to_remove:
        remaining = [n for n in graph.node if n.name not in nodes_to_remove]
        del graph.node[:]
        graph.node.extend(remaining)
        graph.node.extend(new_nodes)
    graph.initializer.extend(new_initializers)

    print(f"  Replaced {replaced} STFT nodes")
    return model, replaced


# ============================================================
# 算子替换: ReduceL2 → Sqrt(ReduceSum(Mul(x,x)))
# ============================================================

def replace_reduce_l2(model):
    graph = model.graph
    nodes_to_remove = set()
    new_nodes = []
    new_initializers = []
    replaced = 0

    for node in list(graph.node):
        if node.op_type != 'ReduceL2':
            continue

        inp = node.input[0]
        out = node.output[0]
        base = node.name or "reduceL2"

        axes = None
        keepdims = 1
        for attr in node.attribute:
            if attr.name == 'axes':
                axes = list(attr.ints)
            elif attr.name == 'keepdims':
                keepdims = attr.i

        if len(node.input) > 1 and node.input[1]:
            axes_init = find_initializer(graph, node.input[1])
            if axes_init:
                axes = numpy_helper.to_array(axes_init).tolist()

        if axes is None:
            print(f"    Warning: ReduceL2 {node.name} has no axes, skipping")
            continue

        sq_name = f"{base}_sq"
        rs_name = f"{base}_rs"

        mul_node = helper.make_node('Mul', [inp, inp], [sq_name], name=f"{base}_mul")
        if axes:
            axes_init_name = f"{base}_axes"
            new_initializers.append(numpy_helper.from_array(
                np.array(axes, dtype=np.int64), name=axes_init_name
            ))
            reduce_node = helper.make_node(
                'ReduceSum', [sq_name, axes_init_name], [rs_name],
                name=f"{base}_reducesum", keepdims=keepdims,
            )
        else:
            reduce_node = helper.make_node(
                'ReduceSum', [sq_name], [rs_name],
                name=f"{base}_reducesum", keepdims=keepdims,
            )
        sqrt_node = helper.make_node('Sqrt', [rs_name], [out], name=f"{base}_sqrt")

        new_nodes.extend([mul_node, reduce_node, sqrt_node])
        nodes_to_remove.add(node.name)
        replaced += 1

    if nodes_to_remove:
        remaining = [n for n in graph.node if n.name not in nodes_to_remove]
        del graph.node[:]
        graph.node.extend(remaining)
        graph.node.extend(new_nodes)
        graph.initializer.extend(new_initializers)

    print(f"  Replaced {replaced} ReduceL2 nodes")
    return model, replaced


# ============================================================
# 算子替换: Range → 预计算常量
# ============================================================

def replace_range(model):
    graph = model.graph
    nodes_to_remove = set()
    new_initializers = []
    replaced = 0

    for node in list(graph.node):
        if node.op_type != 'Range':
            continue

        inputs_ok = True
        values = []
        for inp_name in node.input:
            init = find_initializer(graph, inp_name)
            if init is None:
                inputs_ok = False
                break
            values.append(numpy_helper.to_array(init).item())

        if not inputs_ok:
            print(f"    Warning: Range {node.name} has non-constant input, skipping")
            continue

        start, limit, delta = values
        result = np.arange(start, limit, delta, dtype=np.int64)
        new_initializers.append(numpy_helper.from_array(result, name=node.output[0]))
        nodes_to_remove.add(node.name)
        replaced += 1
        print(f"    Replaced Range -> constant ({len(result)} elements): {node.name}")

    if nodes_to_remove:
        remaining = [n for n in graph.node if n.name not in nodes_to_remove]
        del graph.node[:]
        graph.node.extend(remaining)
        graph.initializer.extend(new_initializers)

    print(f"  Replaced {replaced} Range nodes")
    return model, replaced


# ============================================================
# 固定动态维度
# ============================================================

def fix_dynamic_shapes(model, static_shapes):
    """
    将图输入中的动态维度替换为静态值。
    设置后运行 shape_inference 推导所有中间张量的静态形状。
    """
    graph = model.graph
    changed = 0

    for inp in graph.input:
        tensor_type = inp.type.tensor_type
        if not tensor_type.HasField('shape'):
            continue
        shape = tensor_type.shape
        new_dims = []
        for dim in shape.dim:
            if dim.dim_param and dim.dim_param in static_shapes:
                new_dims.append(static_shapes[dim.dim_param])
                changed += 1
            elif dim.dim_value:
                new_dims.append(dim.dim_value)
            else:
                new_dims.append(0)
        # 清除并重建
        while len(shape.dim) > 0:
            shape.dim.pop()
        for val in new_dims:
            d = shape.dim.add()
            d.dim_value = val

    if changed:
        print(f"  Fixed {changed} dynamic dimensions: {static_shapes}")
        try:
            model = shape_inference.infer_shapes(model, check_type=False, strict_mode=False)
            print(f"  Shape inference completed")
        except Exception as e:
            print(f"  Shape inference partially failed (does not affect execution): {e}")
    return model


def compute_mel_output_shapes(model, static_shapes):
    """
    对于包含 mel 频谱计算的模型（STFT → MatMul(mel_basis)），
    手动计算并设置输出形状。
    """
    graph = model.graph

    # 查找 MatMul 节点，其第一个输入是 2D 权重（mel_basis: [n_mels, freq_bins]）
    mel_matmul = None
    n_mels = None
    for node in graph.node:
        if node.op_type == 'MatMul':
            weight_init = find_initializer(graph, node.input[0])
            if weight_init is not None and len(weight_init.dims) == 2:
                n_mels = int(weight_init.dims[0])
                mel_matmul = node
                break

    if mel_matmul is None or n_mels is None:
        return model

    # 计算 num_frames: 从 STFT 参数推导
    num_samples = static_shapes.get('num_samples', 240000)
    n_fft = None
    hop_size = None

    # 查找 Conv 节点（STFT 替换后的 Conv1d）的 kernel_size 和 stride
    for node in graph.node:
        if node.op_type == 'Conv':
            for attr in node.attribute:
                if attr.name == 'strides':
                    hop_size = list(attr.ints)[0]
            # 从权重形状推断 kernel_size
            weight_init = find_initializer(graph, node.input[1])
            if weight_init and len(weight_init.dims) == 3:
                n_fft = int(weight_init.dims[2])
            if n_fft and hop_size:
                break

    # 也检查 Constant 节点中的 STFT 参数（如果 Conv 没找到）
    if n_fft is None or hop_size is None:
        for node in graph.node:
            if node.op_type == 'STFT':
                # 从 STFT input 获取参数
                for inp_name in node.input[1:4]:
                    for init in graph.initializer:
                        if init.name == inp_name:
                            arr = numpy_helper.to_array(init)
                            if arr.dtype in (np.int64, np.int32):
                                if arr.ndim == 0 or (arr.ndim == 1 and len(arr) == 1):
                                    val = int(arr.item())
                                    if hop_size is None:
                                        hop_size = val
                                    elif n_fft is None:
                                        n_fft = val
                            break
                    for cnode in graph.node:
                        if cnode.op_type == 'Constant' and inp_name in cnode.output:
                            for attr in cnode.attribute:
                                if attr.name == 'value':
                                    arr = numpy_helper.to_array(attr.t)
                                    if arr.dtype in (np.int64, np.int32):
                                        if arr.ndim == 0 or (arr.ndim == 1 and len(arr) == 1):
                                            val = int(arr.item())
                                            if hop_size is None:
                                                hop_size = val
                                            elif n_fft is None:
                                                n_fft = val
                            break

    if n_fft is None or hop_size is None:
        return model

    # 计算帧数
    num_frames = (num_samples - n_fft) // hop_size + 1

    # 检查是否有 Pad 节点增加额外样本
    for node in graph.node:
        if node.op_type == 'Pad':
            # 检查 pad 值
            for inp_name in node.input[1:]:
                for init in graph.initializer:
                    if init.name == inp_name:
                        arr = numpy_helper.to_array(init)
                        # ONNX Pad: [begin_batch, begin_channel, ..., end_batch, end_channel, ...]
                        if len(arr) >= 2:
                            # 假设最后一个维度的 pad
                            total_pad = int(arr[-1]) + int(arr[-2]) if len(arr) >= 4 else int(arr[-1])
                            num_frames = (num_samples + total_pad - n_fft) // hop_size + 1
                        break

    # 设置输出形状
    changed = 0
    for out in graph.output:
        tensor_type = out.type.tensor_type
        # 检查是否有形状信息，或者形状中有未知维度
        needs_shape = False
        if not tensor_type.HasField('shape'):
            needs_shape = True
        else:
            for d in tensor_type.shape.dim:
                if d.dim_param or d.dim_value == 0:
                    needs_shape = True
                    break
        if needs_shape:
            # 创建或清空形状
            shape_proto = onnx.TensorShapeProto()
            for val in [1, n_mels, num_frames]:
                d = shape_proto.dim.add()
                d.dim_value = val
            tensor_type.shape.CopyFrom(shape_proto)
            changed += 1
            print(f"  Manually set output shape: {out.name} = [1, {n_mels}, {num_frames}]")

    return model


def set_output_shapes_static(model):
    """将输出中的未知维度名替换为推断值"""
    graph = model.graph
    # 收集 value_info 中的形状信息
    vi_shapes = {}
    for vi in graph.value_info:
        if vi.type.tensor_type.HasField('shape'):
            dims = []
            for d in vi.type.tensor_type.shape.dim:
                if d.dim_param:
                    dims.append(None)
                elif d.dim_value:
                    dims.append(d.dim_value)
                else:
                    dims.append(None)
            vi_shapes[vi.name] = dims

    # 同时收集 initializer 形状
    for init in graph.initializer:
        vi_shapes[init.name] = list(init.dims)

    changed = 0
    for out in graph.output:
        tensor_type = out.type.tensor_type
        if not tensor_type.HasField('shape'):
            continue
        if len(tensor_type.shape.dim) == 0:
            continue
        new_dims = []
        needs_update = False
        for dim in tensor_type.shape.dim:
            if dim.dim_param:
                needs_update = True
                new_dims.append(-1)  # 标记需要更新
            elif dim.dim_value:
                new_dims.append(dim.dim_value)
            else:
                new_dims.append(-1)
                needs_update = True

        if needs_update:
            # 从 value_info 中尝试获取形状
            matched = False
            for vi in graph.value_info:
                if vi.name == out.name and vi.type.tensor_type.HasField('shape'):
                    shape_proto = onnx.TensorShapeProto()
                    for d in vi.type.tensor_type.shape.dim:
                        new_dim = shape_proto.dim.add()
                        if d.dim_value:
                            new_dim.dim_value = d.dim_value
                        elif d.dim_param:
                            new_dim.dim_param = d.dim_param
                    tensor_type.shape.CopyFrom(shape_proto)
                    matched = True
                    changed += 1
                    break
            if not matched:
                # 强制将未知维度设为 1
                shape_proto = onnx.TensorShapeProto()
                for dim in tensor_type.shape.dim:
                    new_dim = shape_proto.dim.add()
                    if dim.dim_param:
                        new_dim.dim_value = 1
                    elif dim.dim_value:
                        new_dim.dim_value = dim.dim_value
                    else:
                        new_dim.dim_value = 1
                tensor_type.shape.CopyFrom(shape_proto)
                changed += 1

    if changed:
        print(f"  Fixed {changed} output dimensions")
    return model


# ============================================================
# 使用 onnxsim 简化图
# ============================================================

def simplify_model(model):
    """使用 onnxsim 简化模型（常量折叠、死代码消除等）"""
    if not HAS_ONNXSIM:
        return model

    try:
        # 构建 input_shapes 字典以帮助 onnxsim
        input_shapes = {}
        for inp in model.graph.input:
            tensor_type = inp.type.tensor_type
            if tensor_type.HasField('shape'):
                dims = []
                for d in tensor_type.shape.dim:
                    if d.dim_value > 0:
                        dims.append(d.dim_value)
                    else:
                        dims.append(1)
                if dims:
                    input_shapes[inp.name] = dims

        simplified, ok = onnxsim.simplify(
            model,
            check_n=0,
            skip_fuse_bn=True,
            dynamic_input_shape=False,
            overwrite_input_shapes=input_shapes if input_shapes else None,
        )
        if ok:
            orig_nodes = len(model.graph.node)
            new_nodes = len(simplified.graph.node)
            print(f"  onnxsim simplification: {orig_nodes} -> {new_nodes} nodes")
            return simplified
        else:
            print(f"  onnxsim simplification failed, using original model")
            return model
    except Exception as e:
        print(f"  onnxsim error: {e}")
        return model


# ============================================================
# 主优化流程
# ============================================================

def optimize_model(model_path, output_path, static_shapes, mode='w8a8'):
    """优化单个模型。mode: 'w8a8'（保留 INT8 权重）或 'fp32'（预反量化为 FP32）"""
    print(f"\n{'='*60}")
    print(f"Optimizing: {os.path.basename(model_path)}")
    print(f"{'='*60}")

    model = onnx.load(model_path)
    ensure_opset_version(model, 13)
    ensure_node_names(model.graph)

    ops = list_ops(model)
    total = sum(ops.values())
    print(f"  Original nodes: {total}")
    for op, cnt in sorted(ops.items(), key=lambda x: -x[1])[:10]:
        flag = ' ***' if op in UNSUPPORTED_OPS else (' *' if op in DECOMPOSABLE_OPS else '')
        print(f"    {op}: {cnt}{flag}")

    # Vocoder 特殊处理: 验证 ISTFT 中间张量大小
    model_basename = os.path.basename(model_path).lower()
    if 'vocoder' in model_basename:
        seq_len = static_shapes.get('seq_len', 500)
        ok, safe_len = validate_vocoder_shapes(model, seq_len)
        if not ok:
            print(f"  Auto-adjusted vocoder seq_len: {seq_len} -> {safe_len}")
            static_shapes['seq_len'] = safe_len

    # 步骤 1: 替换 DQL + MatMulInteger/ConvInteger
    model, _ = replace_dql_matmul_chain(model)
    gc.collect()

    # 步骤 2: 替换 STFT
    model, _ = replace_stft(model)
    gc.collect()

    # 步骤 3: 替换 ReduceL2
    model, _ = replace_reduce_l2(model)

    # 步骤 4: 替换 Range（非常量输入则跳过）
    model, _ = replace_range(model)

    # 步骤 5: 拓扑排序
    topological_sort_nodes(model.graph)

    # 步骤 6: 固定动态维度
    model = fix_dynamic_shapes(model, static_shapes)

    # 步骤 7: 形状推断 + onnxsim 简化
    topological_sort_nodes(model.graph)
    try:
        model = shape_inference.infer_shapes(model, check_type=False, strict_mode=False)
    except Exception:
        pass
    model = simplify_model(model)
    gc.collect()

    # 步骤 8: 修正输出形状（包括手动计算 mel 模型的输出形状）
    model = compute_mel_output_shapes(model, static_shapes)
    model = set_output_shapes_static(model)

    # 步骤 9: 形状推断 + 清理
    try:
        model = shape_inference.infer_shapes(model, check_type=False, strict_mode=False)
    except Exception:
        pass
    model = clean_unused_initializers(model)

    # 步骤 10: 处理 DequantizeLinear 节点
    if mode == 'w8a8':
        # W8A8: 保留 INT8 权重，修正 scale rank 以兼容 WebNN
        model, dql_count = fix_w8a8_scale_rank(model)
    else:
        # FP32: 预反量化所有 DQL 节点为 FP32 权重
        model, dql_count = pre_dequantize_dql(model)
    gc.collect()

    # 步骤 11: 再次 onnxsim
    if dql_count > 0:
        topological_sort_nodes(model.graph)
        try:
            model = shape_inference.infer_shapes(model, check_type=False, strict_mode=False)
        except Exception:
            pass
        model = simplify_model(model)
        gc.collect()

    # 步骤 12: 元数据清理
    model = strip_metadata(model)

    # 最终拓扑排序
    topological_sort_nodes(model.graph)

    # 检查兼容性
    unsupported = check_npu_compatibility(model)
    if unsupported:
        print(f"  Still has incompatible operators: {unsupported}")
    else:
        print(f"  [OK] All NPU compatible")

    ops = list_ops(model)
    total = sum(ops.values())
    print(f"  Optimized nodes: {total}")

    # 保存（外部数据格式：图结构和权重分开存储，加速 protobuf 解析）
    # 删除旧的 .data 文件（如果存在）
    old_data_path = output_path + '.data'
    if os.path.exists(old_data_path):
        os.remove(old_data_path)

    onnx.save_model(model, output_path, save_as_external_data=True,
                    all_tensors_to_one_file=True,
                    location=os.path.basename(output_path) + '.data',
                    size_threshold=1024)

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    data_path = output_path + '.data'
    if os.path.exists(data_path):
        data_mb = os.path.getsize(data_path) / (1024 * 1024)
        print(f"  Saved: {os.path.basename(output_path)} ({size_mb:.1f} MB + {data_mb:.1f} MB data)")
    else:
        print(f"  Saved: {os.path.basename(output_path)} ({size_mb:.1f} MB)")

    return model, unsupported


# ============================================================
# GPU 验证（DirectML）
# ============================================================

def verify_model_dml(model_path):
    """使用 DirectML GPU 验证模型可运行"""
    try:
        import onnxruntime as ort
        providers = ['DmlExecutionProvider', 'CPUExecutionProvider']
        sess = ort.InferenceSession(model_path, providers=providers)

        # 构造随机输入
        feeds = {}
        for inp in sess.get_inputs():
            shape = []
            for d in inp.shape:
                if isinstance(d, str) or d is None or d <= 0:
                    shape.append(1)
                else:
                    shape.append(d)
            if inp.type == 'tensor(float)':
                feeds[inp.name] = np.random.randn(*shape).astype(np.float32)
            elif inp.type == 'tensor(int64)':
                feeds[inp.name] = np.random.randint(0, 100, size=shape).astype(np.int64)
            elif inp.type == 'tensor(int32)':
                feeds[inp.name] = np.random.randint(0, 100, size=shape).astype(np.int32)
            else:
                feeds[inp.name] = np.random.randn(*shape).astype(np.float32)

        outputs = sess.run(None, feeds)
        provider = sess.get_providers()[0]
        print(f"  [OK] GPU verification passed ({provider}), outputs: {[o.shape for o in outputs]}")
        return True
    except Exception as e:
        print(f"  [FAIL] GPU verification failed: {e}")
        return False


# ============================================================
# 主函数
# ============================================================

def main():
    parser = argparse.ArgumentParser(description='INT8 NPU 模型优化')
    parser.add_argument('--fp32', action='store_true',
                        help='FP32 模式: 预反量化所有 DequantizeLinear 为 FP32 权重（默认 W8A8 模式）')
    args = parser.parse_args()
    mode = 'fp32' if args.fp32 else 'w8a8'

    print("=" * 60)
    print(f"INT8 NPU model optimization (mode: {mode.upper()})")
    print("=" * 60)

    # 保存 docs_readme.txt（如果存在）
    docs_path = os.path.join(OUT_DIR, 'docs_readme.txt')
    docs_content = None
    if os.path.exists(docs_path):
        with open(docs_path, 'r', encoding='utf-8') as f:
            docs_content = f.read()

    # 清理输出目录中的旧文件（不删除目录本身，避免 CWD 冲突）
    if os.path.exists(OUT_DIR):
        print(f"\nCleaning output directory: {OUT_DIR}")
        for f in os.listdir(OUT_DIR):
            fp = os.path.join(OUT_DIR, f)
            if os.path.isfile(fp) and f != 'docs_readme.txt':
                os.remove(fp)
            elif os.path.isdir(fp) and f == 'preprocess':
                shutil.rmtree(fp)
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(os.path.join(OUT_DIR, 'preprocess'), exist_ok=True)

    # 恢复 docs_readme.txt
    if docs_content is not None:
        with open(docs_path, 'w', encoding='utf-8') as f:
            f.write(docs_content)

    # 收集所有模型
    models = []
    for f in os.listdir(SRC_DIR):
        if f.endswith('.onnx'):
            models.append((f, f))
    preprocess_src = os.path.join(SRC_DIR, 'preprocess')
    if os.path.exists(preprocess_src):
        for f in os.listdir(preprocess_src):
            if f.endswith('.onnx'):
                models.append((f, os.path.join('preprocess', f)))

    print(f"\nFound {len(models)} model files")

    results = []
    for model_name, rel_path in models:
        src_path = os.path.join(SRC_DIR, rel_path)
        out_path = os.path.join(OUT_DIR, rel_path)

        # 根据模型确定静态维度
        shapes = dict(DEFAULT_SHAPES)
        if 'vocoder' in model_name:
            # Vocoder ISTFT Conv 的 Pad 中间张量 [1,1922,seq_len,480] 受 WebNN 2GB 限制。
            # seq_len=500 → 1.84GB (安全), seq_len=2048 → 7.56GB (超出)
            # 通过二分查找自动确定最大安全 seq_len
            max_safe = find_max_vocoder_seq_len()
            shapes['seq_len'] = min(500, max_safe)
        elif 'diff_step' in model_name:
            shapes['seq_len'] = 2048
        if 'rosvot' in model_name and 'mel' not in model_name:
            shapes['time_frames'] = 1500

        try:
            model, unsupported = optimize_model(src_path, out_path, shapes, mode=mode)

            result = {
                'name': rel_path,
                'ok': True,
                'unsup': unsupported,
                'size': os.path.getsize(out_path) / (1024 * 1024),
            }
            data_path = out_path + '.data'
            if os.path.exists(data_path):
                result['data_size'] = os.path.getsize(data_path) / (1024 * 1024)

            # GPU 验证（跳过非常大的模型以节省内存）
            if result['size'] < 500:
                try:
                    verify_model_dml(out_path)
                except Exception:
                    pass

            results.append(result)

        except Exception as e:
            print(f"\n  Failed: {rel_path} - {e}")
            import traceback
            traceback.print_exc()
            results.append({'name': rel_path, 'ok': False, 'error': str(e)})

        gc.collect()

    # 输出结果
    print(f"\n{'='*60}")
    print("Optimization results summary")
    print(f"{'='*60}")
    for r in results:
        if r['ok']:
            size_str = f"{r['size']:.1f} MB"
            if r.get('data_size'):
                size_str += f" + {r['data_size']:.1f} MB data"
            u = str(r['unsup']) if r['unsup'] else "none"
            status = "OK" if not r['unsup'] else "WARN"
            print(f"  [{status}] {r['name']:<40} {size_str:>20}  unsup: {u}")
        else:
            print(f"  [FAIL] {r['name']:<40} {r.get('error', '')[:60]}")

    all_ok = all(r['ok'] and not r.get('unsup') for r in results)
    print(f"\n{'All NPU compatible!' if all_ok else 'Some models still have incompatible operators'}")
    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main())
