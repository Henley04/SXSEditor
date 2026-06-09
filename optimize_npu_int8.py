# -*- coding: utf-8 -*-
"""
将 INT8 动态量化 ONNX 模型中的 WebNN NPU 不兼容算子替换为兼容算子。

WebNN NPU 不支持以下 INT8 动态量化算子：
  - DynamicQuantizeLinear（运行时量化激活）
  - MatMulInteger（INT8 矩阵乘法）
  - ConvInteger（INT8 卷积）

替换策略：
  DynamicQuantizeLinear + MatMulInteger + Cast + Mul(scales) + Mul(output)
    → MatMul(FP32_input, dequantized_FP32_weight)

  DynamicQuantizeLinear + ConvInteger + Cast + Mul(scales) + Mul(output)
    → Conv(FP32_input, dequantized_FP32_weight, ...)

  ReduceL2 → Sqrt(ReduceSum(Mul(x, x)))
  Range → 预计算常量

DequantizeLinear 保留不动（WebNN NPU 支持）。
"""

import os
import sys
import shutil
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto, shape_inference

BASE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'onnx_models')
INPUT_DIR = os.path.join(BASE_DIR, 'int8', 'optimized_npu')
OUTPUT_DIR = INPUT_DIR  # 原地替换（先备份）

# WebNN NPU 不支持的算子（需要替换）
UNSUPPORTED_OPS = {
    'DynamicQuantizeLinear', 'MatMulInteger', 'ConvInteger',
    'STFT',
}

# WebNN NPU 不支持的其他算子（需要分解）
DECOMPOSABLE_OPS = {
    'ReduceL2', 'Range',
}

# 所有需要关注的算子
ALL_FLAGGED_OPS = UNSUPPORTED_OPS | DECOMPOSABLE_OPS


def ensure_node_names(graph):
    """确保所有节点都有唯一的名称（id() 追踪改用名称追踪的前提）"""
    used_names = set()
    for node in graph.node:
        if node.name:
            used_names.add(node.name)

    counter = 0
    for node in graph.node:
        if not node.name:
            while True:
                name = f"node_{counter}"
                counter += 1
                if name not in used_names:
                    node.name = name
                    used_names.add(name)
                    break


def check_npu_compatibility(model):
    """检查模型中是否还有不兼容算子"""
    unsupported = {}
    for node in model.graph.node:
        if node.op_type in UNSUPPORTED_OPS:
            unsupported[node.op_type] = unsupported.get(node.op_type, 0) + 1
    return unsupported


def list_ops(model):
    """列出模型中所有算子"""
    ops = {}
    for node in model.graph.node:
        ops[node.op_type] = ops.get(node.op_type, 0) + 1
    return ops


def find_initializer(graph, name):
    """根据名称查找初始化器"""
    for init in graph.initializer:
        if init.name == name:
            return init
    return None


def remove_initializer(graph, name):
    """删除指定名称的初始化器"""
    for i, init in enumerate(graph.initializer):
        if init.name == name:
            del graph.initializer[i]
            return True
    return False


def find_nodes_consuming(graph, tensor_name):
    """查找消费指定张量的所有节点"""
    consumers = []
    for i, node in enumerate(graph.node):
        if tensor_name in node.input:
            consumers.append((i, node))
    return consumers


def find_node_producing(graph, tensor_name):
    """查找产生指定张量的节点"""
    for node in graph.graph.node if hasattr(graph, 'graph') else graph.node:
        if tensor_name in node.output:
            return node
    return None


def dequantize_weight(graph, weight_name, scale_name, zp_name):
    """
    反量化权重：float_weight = (int8_weight - zero_point) * scale
    返回反量化后的 numpy 数组
    """
    w_init = find_initializer(graph, weight_name)
    s_init = find_initializer(graph, scale_name)
    zp_init = find_initializer(graph, zp_name) if zp_name else None

    if w_init is None:
        raise ValueError(f"Weight initializer not found: {weight_name}")
    if s_init is None:
        raise ValueError(f"Scale initializer not found: {scale_name}")

    w = numpy_helper.to_array(w_init).astype(np.float32)
    s = numpy_helper.to_array(s_init).astype(np.float32)
    zp = numpy_helper.to_array(zp_init).astype(np.float32) if zp_init else np.float32(0)

    # Dequantize: float_weight = (int8_weight - zero_point) * scale
    float_w = (w - zp) * s
    return float_w


def replace_dynamic_quant_matmul_chain(model):
    """
    替换 DynamicQuantizeLinear + MatMulInteger + Cast + Mul(scales) + Mul(output) 链
    为单个 MatMul(FP32_input, dequantized_FP32_weight)

    图模式：
      FP32_input → DQL → (int8_in, in_scale, in_zp)
      int8_in + weight_quantized + in_zp + weight_zp → MatMulInteger → int32_out
      int32_out → Cast → FP32_int32
      in_scale * weight_scale → Mul → combined_scale
      FP32_int32 * combined_scale → Mul → FP32_result

    替换为：
      FP32_input + dequantized_weight → MatMul → FP32_result

    注意：一个 DQL 的 scale 输出可能被多个 scale_mul 节点消费，
    因此必须从 MatMulInteger/ConvInteger 输出向前追踪，
    而不是从 DQL scale 向后查找 scale_mul_node。
    """
    graph = model.graph
    nodes_to_remove = set()
    new_nodes = []
    new_initializers = []
    replaced_count = 0

    # 建立 output_name -> node 的映射
    output_to_node = {}
    for node in graph.node:
        for out in node.output:
            output_to_node[out] = node

    # 遍历所有 MatMulInteger 和 ConvInteger 节点（从消费者向前追踪）
    for quant_node in list(graph.node):
        if quant_node.op_type not in ('MatMulInteger', 'ConvInteger'):
            continue

        is_matmul = quant_node.op_type == 'MatMulInteger'
        weight_name = quant_node.input[1]
        weight_zp_name = quant_node.input[3] if len(quant_node.input) > 3 else None

        # 步骤1: 找 Cast 节点（quant_node 输出的消费者）
        quant_output = quant_node.output[0]
        cast_node = None
        for node in graph.node:
            if node.op_type == 'Cast' and quant_output in node.input:
                cast_node = node
                break

        if cast_node is None:
            print(f"    警告: 找不到 Cast 节点 for {quant_node.name}")
            continue

        cast_output = cast_node.output[0]

        # 步骤2: 找 output_mul_node（Cast 输出 * combined_scale）
        output_mul_node = None
        for node in graph.node:
            if node.op_type == 'Mul' and cast_output in node.input:
                output_mul_node = node
                break

        if output_mul_node is None:
            print(f"    警告: 找不到 output Mul 节点 for {cast_node.name}")
            continue

        # combined_scale 是 output_mul_node 的另一个输入
        combined_scale_name = None
        for inp in output_mul_node.input:
            if inp != cast_output:
                combined_scale_name = inp
                break

        if combined_scale_name is None:
            print(f"    警告: 找不到 combined_scale for {output_mul_node.name}")
            continue

        # 步骤3: 找 scale_mul_node（产生 combined_scale 的节点）
        scale_mul_node = output_to_node.get(combined_scale_name)
        if scale_mul_node is None or scale_mul_node.op_type != 'Mul':
            # combined_scale 可能是直接初始化器（不经过 Mul）
            # 在这种情况下，不需要 scale_mul_node
            scale_mul_node = None
            # combined_scale_name 本身就是 weight_scale
            weight_scale_name = combined_scale_name
            dql_scale_name = None
        else:
            # scale_mul_node 有两个输入：DQL scale 和 weight_scale
            dql_scale_name = None
            weight_scale_name = None
            for inp in scale_mul_node.input:
                # 查找哪个输入是 DQL 的 scale 输出
                producer = output_to_node.get(inp)
                if producer and producer.op_type == 'DynamicQuantizeLinear':
                    dql_scale_name = inp
                else:
                    weight_scale_name = inp

            if weight_scale_name is None:
                print(f"    警告: 找不到 weight_scale for {quant_node.name}")
                continue

        # 步骤4: 找 DQL 节点（产生 quant_node 的第一个输入）
        int8_input = quant_node.input[0]
        dql_node = output_to_node.get(int8_input)
        if dql_node is None or dql_node.op_type != 'DynamicQuantizeLinear':
            print(f"    警告: 找不到 DQL 节点 for {quant_node.name}")
            continue

        fp32_input = dql_node.input[0]

        # 步骤5: 反量化权重
        try:
            float_weight = dequantize_weight(graph, weight_name, weight_scale_name, weight_zp_name)
        except ValueError as e:
            print(f"    警告: 反量化失败 {quant_node.name}: {e}")
            continue

        # 添加反量化后的权重初始化器
        float_weight_name = f"{weight_name}_dequant"
        new_initializers.append(numpy_helper.from_array(
            float_weight.astype(np.float32), name=float_weight_name
        ))

        # 最终输出
        final_output = output_mul_node.output[0]

        if is_matmul:
            # 创建新的 MatMul 节点
            new_node = helper.make_node(
                'MatMul',
                inputs=[fp32_input, float_weight_name],
                outputs=[final_output],
                name=f"{quant_node.name}_dequant_replaced",
            )
        else:
            # 复制 ConvInteger 的属性到新 Conv 节点
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
                'Conv',
                inputs=[fp32_input, float_weight_name],
                outputs=[final_output],
                name=f"{quant_node.name}_dequant_replaced",
                **conv_attrs,
            )

        new_nodes.append(new_node)

        # 标记需要删除的节点
        nodes_to_remove.add(quant_node.name)
        nodes_to_remove.add(cast_node.name)
        nodes_to_remove.add(output_mul_node.name)
        if scale_mul_node is not None:
            nodes_to_remove.add(scale_mul_node.name)

        # 检查 DQL 节点是否可以安全删除
        # 只有当 DQL 的所有输出都不再被其他未删除节点消费时，才删除 DQL
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

        replaced_count += 1
        op_type = 'MatMul' if is_matmul else 'Conv'
        print(f"    替换 DQL+{quant_node.op_type} → {op_type}: {dql_node.name} → {new_node.name}")

    # 删除旧节点，添加新节点
    if nodes_to_remove:
        remaining_nodes = [n for n in graph.node if n.name not in nodes_to_remove]
        del graph.node[:]
        graph.node.extend(remaining_nodes)
        graph.node.extend(new_nodes)

    # 添加新的初始化器
    graph.initializer.extend(new_initializers)

    print(f"  替换了 {replaced_count} 个 DQL+MatMulInt/ConvInt 链")
    return model, replaced_count


def replace_reduce_l2(model):
    """
    替换 ReduceL2 为 Sqrt(ReduceSum(Mul(x, x)))

    ReduceL2(x, axes, keepdims) = Sqrt(ReduceSum(x * x, axes, keepdims))
    """
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

        # 提取属性
        axes = None
        keepdims = 1
        for attr in node.attribute:
            if attr.name == 'axes':
                axes = list(attr.ints)
            elif attr.name == 'keepdims':
                keepdims = attr.i

        # 如果 axes 是第二个输入（opset 18+）
        if len(node.input) > 1 and node.input[1]:
            axes_init = find_initializer(graph, node.input[1])
            if axes_init:
                axes = numpy_helper.to_array(axes_init).tolist()

        if axes is None:
            print(f"    警告: ReduceL2 {node.name} 没有 axes 属性，跳过")
            continue

        # 创建替换节点序列: Mul → ReduceSum → Sqrt
        sq_name = f"{base}_sq"
        rs_name = f"{base}_rs"

        # Mul(x, x) — 逐元素平方
        mul_node = helper.make_node('Mul', [inp, inp], [sq_name], name=f"{base}_mul")
        # ReduceSum(sq, axes, keepdims)
        rs_attrs = {'keepdims': keepdims}
        if axes:
            axes_init_name = f"{base}_axes"
            new_initializers.append(numpy_helper.from_array(
                np.array(axes, dtype=np.int64), name=axes_init_name
            ))
            reduce_node = helper.make_node(
                'ReduceSum', [sq_name, axes_init_name], [rs_name],
                name=f"{base}_reducesum", **rs_attrs,
            )
        else:
            reduce_node = helper.make_node(
                'ReduceSum', [sq_name], [rs_name],
                name=f"{base}_reducesum", **rs_attrs,
            )
        # Sqrt
        sqrt_node = helper.make_node('Sqrt', [rs_name], [out], name=f"{base}_sqrt")

        new_nodes.extend([mul_node, reduce_node, sqrt_node])
        nodes_to_remove.add(node.name)
        replaced += 1
        print(f"    替换 ReduceL2 → Mul+ReduceSum+Sqrt: {node.name}")

    if nodes_to_remove:
        remaining_nodes = [n for n in graph.node if n.name not in nodes_to_remove]
        del graph.node[:]
        graph.node.extend(remaining_nodes)
        graph.node.extend(new_nodes)
        graph.initializer.extend(new_initializers)

    print(f"  替换了 {replaced} 个 ReduceL2")
    return model, replaced


def replace_range(model):
    """
    替换 Range 算子为预计算的常量。

    Range(start, limit, delta) — 如果所有输入都是常量，则预计算结果。
    """
    graph = model.graph
    nodes_to_remove = set()
    new_initializers = []
    replaced = 0

    for node in list(graph.node):
        if node.op_type != 'Range':
            continue

        # 检查所有输入是否都是常量
        start_init = find_initializer(graph, node.input[0])
        limit_init = find_initializer(graph, node.input[1])
        delta_init = find_initializer(graph, node.input[2])

        if start_init is None or limit_init is None or delta_init is None:
            print(f"    警告: Range {node.name} 有非常量输入，跳过")
            continue

        start = numpy_helper.to_array(start_init).item()
        limit = numpy_helper.to_array(limit_init).item()
        delta = numpy_helper.to_array(delta_init).item()

        # 预计算 range
        result = np.arange(start, limit, delta, dtype=np.int64)
        out_name = node.output[0]

        # 添加常量初始化器
        new_initializers.append(numpy_helper.from_array(result, name=out_name))

        nodes_to_remove.add(node.name)
        replaced += 1
        print(f"    替换 Range → 常量 ({len(result)} 个元素): {node.name}")

    if nodes_to_remove:
        remaining_nodes = [n for n in graph.node if n.name not in nodes_to_remove]
        del graph.node[:]
        graph.node.extend(remaining_nodes)
        graph.initializer.extend(new_initializers)

    print(f"  替换了 {replaced} 个 Range")
    return model, replaced


def replace_stft(model):
    """
    替换 STFT 算子为 Conv1d（cos/sin 核）+ 幅度计算。

    STFT(signal, frame_step, window, frame_length, onesided=1) 输出复数张量
    [batch, num_frames, fft_size/2+1, 2]（实部+虚部）。

    替换策略：
      DFT 可以表示为矩阵乘法，等价于 Conv1d（stride=hop_size）：
        real[k,t] = Conv1d(signal, cos_kernel, stride=hop_size)
        imag[k,t] = Conv1d(signal, sin_kernel, stride=hop_size)
      其中 cos_kernel[k,0,n] = window[n] * cos(2π*k*n/N)
            sin_kernel[k,0,n] = window[n] * (-sin(2π*k*n/N))

    同时替换后续的幅度计算链（Transpose + Pow + ReduceSum + Sqrt），
    直接用 Mul + Mul + Add + Sqrt 计算幅度谱。
    """
    graph = model.graph
    nodes_to_remove = set()
    new_nodes = []
    new_initializers = []
    replaced = 0

    for node in list(graph.node):
        if node.op_type != 'STFT':
            continue

        stft_node = node
        # STFT inputs: [signal, frame_step, window, frame_length]
        signal_name = stft_node.input[0]
        frame_step_name = stft_node.input[1]
        window_name = stft_node.input[2]
        frame_length_name = stft_node.input[3] if len(stft_node.input) > 3 else None

        # 获取参数
        frame_step_init = find_initializer(graph, frame_step_name)
        window_init = find_initializer(graph, window_name)
        frame_length_init = find_initializer(graph, frame_length_name) if frame_length_name else None

        if frame_step_init is None or window_init is None:
            print(f"    警告: STFT {stft_node.name} 缺少常量参数，跳过")
            continue

        hop_size = int(numpy_helper.to_array(frame_step_init).item())
        window = numpy_helper.to_array(window_init).astype(np.float32)
        n_fft = len(window)
        if frame_length_init is not None:
            n_fft = int(numpy_helper.to_array(frame_length_init).item())

        # 检查 onesided 属性
        onesided = False
        for attr in stft_node.attribute:
            if attr.name == 'onesided':
                onesided = attr.i == 1

        num_freq = n_fft // 2 + 1 if onesided else n_fft

        # 计算 Conv1d 核：cos_kernel 和 sin_kernel
        # DFT: X[k] = sum_n(x[n] * window[n] * exp(-2πi*k*n/N))
        # real: sum_n(x[n] * window[n] * cos(2π*k*n/N))
        # imag: sum_n(x[n] * window[n] * (-sin(2π*k*n/N)))
        n = np.arange(n_fft, dtype=np.float32)
        k = np.arange(num_freq, dtype=np.float32).reshape(-1, 1)
        angles = 2 * np.pi * k * n / n_fft

        cos_kernel = (window * np.cos(angles)).astype(np.float32)  # [num_freq, n_fft]
        sin_kernel = (window * (-np.sin(angles))).astype(np.float32)  # [num_freq, n_fft]

        # Conv1d 核形状: [out_channels, in_channels, kernel_size]
        cos_kernel = cos_kernel.reshape(num_freq, 1, n_fft)
        sin_kernel = sin_kernel.reshape(num_freq, 1, n_fft)

        cos_kernel_name = f"{stft_node.name}_cos_kernel"
        sin_kernel_name = f"{stft_node.name}_sin_kernel"
        new_initializers.append(numpy_helper.from_array(cos_kernel, name=cos_kernel_name))
        new_initializers.append(numpy_helper.from_array(sin_kernel, name=sin_kernel_name))

        # 查找 STFT 之前的 Squeeze 节点（如果信号是 3D 的，需要跳过 Squeeze）
        # STFT 的输入是 Squeeze 的输出，但 Conv1d 需要 3D 输入
        # 所以 Conv1d 应该使用 Squeeze 之前的 Pad 输出
        squeeze_node = None
        pad_output_name = None
        for n2 in graph.node:
            if n2.op_type == 'Squeeze' and signal_name in n2.output:
                squeeze_node = n2
                pad_output_name = n2.input[0]  # Pad 的输出
                break

        conv_input = pad_output_name if pad_output_name else signal_name

        # 创建 Conv1d 节点
        real_name = f"{stft_node.name}_real"
        imag_name = f"{stft_node.name}_imag"

        real_conv = helper.make_node(
            'Conv',
            inputs=[conv_input, cos_kernel_name],
            outputs=[real_name],
            name=f"{stft_node.name}_conv_cos",
            strides=[hop_size],
        )
        imag_conv = helper.make_node(
            'Conv',
            inputs=[conv_input, sin_kernel_name],
            outputs=[imag_name],
            name=f"{stft_node.name}_conv_sin",
            strides=[hop_size],
        )
        new_nodes.extend([real_conv, imag_conv])

        # 计算幅度：sqrt(real^2 + imag^2)
        real_sq_name = f"{stft_node.name}_real_sq"
        imag_sq_name = f"{stft_node.name}_imag_sq"
        mag_sq_name = f"{stft_node.name}_mag_sq"
        mag_name = f"{stft_node.name}_mag"

        mul_real = helper.make_node('Mul', [real_name, real_name], [real_sq_name],
                                    name=f"{stft_node.name}_mul_real")
        mul_imag = helper.make_node('Mul', [imag_name, imag_name], [imag_sq_name],
                                    name=f"{stft_node.name}_mul_imag")
        add_mag = helper.make_node('Add', [real_sq_name, imag_sq_name], [mag_sq_name],
                                   name=f"{stft_node.name}_add_mag")
        sqrt_mag = helper.make_node('Sqrt', [mag_sq_name], [mag_name],
                                    name=f"{stft_node.name}_sqrt_mag")
        new_nodes.extend([mul_real, mul_imag, add_mag, sqrt_mag])

        # 查找 STFT 后的幅度计算链：Transpose → Pow → ReduceSum → Sqrt
        # 并将最终 Sqrt 的输出替换为我们的 mag_name
        stft_output = stft_node.output[0]

        # 查找消费 STFT 输出的 Transpose 节点
        trans_node = None
        for n2 in graph.node:
            if n2.op_type == 'Transpose' and stft_output in n2.input:
                trans_node = n2
                break

        if trans_node is None:
            print(f"    警告: 找不到 STFT 后的 Transpose 节点，跳过")
            continue

        trans_output = trans_node.output[0]

        # 查找 Pow 节点
        pow_node = None
        for n2 in graph.node:
            if n2.op_type == 'Pow' and trans_output in n2.input:
                pow_node = n2
                break

        if pow_node is None:
            print(f"    警告: 找不到 Pow 节点，跳过")
            continue

        pow_output = pow_node.output[0]

        # 查找 ReduceSum 节点
        reduce_node = None
        for n2 in graph.node:
            if n2.op_type == 'ReduceSum' and pow_output in n2.input:
                reduce_node = n2
                break

        if reduce_node is None:
            print(f"    警告: 找不到 ReduceSum 节点，跳过")
            continue

        reduce_output = reduce_node.output[0]

        # 查找 Sqrt 节点（幅度）
        sqrt_node = None
        for n2 in graph.node:
            if n2.op_type == 'Sqrt' and reduce_output in n2.input:
                sqrt_node = n2
                break

        if sqrt_node is None:
            print(f"    警告: 找不到 Sqrt 节点，跳过")
            continue

        # 将 Sqrt 的输出名称赋给我们的 mag 输出
        final_output = sqrt_node.output[0]
        sqrt_mag.output[0] = final_output

        # 标记需要删除的节点
        nodes_to_remove.add(stft_node.name)
        nodes_to_remove.add(trans_node.name)
        nodes_to_remove.add(pow_node.name)
        nodes_to_remove.add(reduce_node.name)
        nodes_to_remove.add(sqrt_node.name)

        # 如果有 Squeeze 节点，也删除
        if squeeze_node:
            nodes_to_remove.add(squeeze_node.name)

        replaced += 1
        print(f"    替换 STFT → Conv1d(cos/sin) + 幅度计算: {stft_node.name}")

    if nodes_to_remove:
        remaining_nodes = [n for n in graph.node if n.name not in nodes_to_remove]
        del graph.node[:]
        graph.node.extend(remaining_nodes)
        graph.node.extend(new_nodes)
        graph.initializer.extend(new_initializers)

    print(f"  替换了 {replaced} 个 STFT")
    return model, replaced


def clean_unused_initializers(model):
    """清理不再被任何节点引用的初始化器"""
    graph = model.graph

    # 收集所有被节点引用的初始化器名称
    used_names = set()
    for node in graph.node:
        for inp in node.input:
            used_names.add(inp)

    # 也保留图输出的引用
    for out in graph.output:
        used_names.add(out.name)

    # 删除未引用的初始化器（只删除量化相关的）
    quant_related_suffixes = ['_quantized', '_scale', '_zero_point', '_scales_mul:0',
                               '_output_scale_mul', '_output_quantized_cast']
    removed = 0
    to_remove = []
    for init in graph.initializer:
        if init.name not in used_names:
            # 只删除量化相关的未引用初始化器
            if any(s in init.name for s in quant_related_suffixes):
                to_remove.append(init.name)

    for name in to_remove:
        remove_initializer(graph, name)
        removed += 1

    if removed > 0:
        print(f"  清理了 {removed} 个未引用的量化初始化器")
    return model


def optimize_model(model_path, output_path):
    """优化单个模型"""
    print(f"\n{'='*60}")
    print(f"优化: {os.path.basename(model_path)}")
    print(f"{'='*60}")

    model = onnx.load(model_path)

    # 确保所有节点都有唯一名称（名称追踪的前提）
    ensure_node_names(model.graph)

    ops = list_ops(model)
    total = sum(ops.values())
    print(f"  原始节点: {total}")
    for op, cnt in sorted(ops.items(), key=lambda x: -x[1])[:8]:
        flag = ' ***' if op in ALL_FLAGGED_OPS else ''
        print(f"    {op}: {cnt}{flag}")

    # 步骤1: 替换 DynamicQuantizeLinear + MatMulInteger/ConvInteger 链
    model, n1 = replace_dynamic_quant_matmul_chain(model)

    # 步骤2: 替换 ReduceL2
    model, n2 = replace_reduce_l2(model)

    # 步骤3: 替换 Range
    model, n3 = replace_range(model)

    # 步骤4: 替换 STFT
    model, n4 = replace_stft(model)

    # 步骤5: 清理未引用的初始化器
    model = clean_unused_initializers(model)

    # 检查兼容性
    unsupported = check_npu_compatibility(model)
    if unsupported:
        print(f"  仍有不兼容算子: {unsupported}")
    else:
        print(f"  全部 NPU 兼容!")

    ops = list_ops(model)
    total = sum(ops.values())
    print(f"  优化后节点: {total}")
    for op, cnt in sorted(ops.items(), key=lambda x: -x[1])[:8]:
        print(f"    {op}: {cnt}")

    # 保存（大模型使用外部数据格式）
    try:
        onnx.save(model, output_path)
    except ValueError:
        # protobuf 2GB 限制，使用外部数据格式
        print(f"  模型超过 2GB，使用外部数据格式保存...")
        onnx.save_model(model, output_path, save_as_external_data=True,
                        all_tensors_to_one_file=True,
                        location=os.path.basename(output_path) + '.data',
                        size_threshold=1024)
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    data_path = output_path + '.data'
    if os.path.exists(data_path):
        data_mb = os.path.getsize(data_path) / (1024 * 1024)
        print(f"  保存: {output_path} ({size_mb:.1f} MB + {data_mb:.1f} MB data)")
    else:
        print(f"  保存: {output_path} ({size_mb:.1f} MB)")

    return model, unsupported


def main():
    print("=" * 60)
    print("INT8 NPU 算子兼容性优化")
    print("=" * 60)

    # 备份原始模型
    backup_dir = INPUT_DIR + '_backup'
    if not os.path.exists(backup_dir):
        print(f"\n备份原始模型到: {backup_dir}")
        shutil.copytree(INPUT_DIR, backup_dir)
        print("备份完成")
    else:
        print(f"\n备份目录已存在: {backup_dir}")

    # 查找所有需要优化的 ONNX 模型
    models_to_optimize = []
    for f in os.listdir(INPUT_DIR):
        if f.endswith('.onnx'):
            models_to_optimize.append(f)

    # 也处理 preprocess 子目录
    preprocess_dir = os.path.join(INPUT_DIR, 'preprocess')
    if os.path.exists(preprocess_dir):
        for f in os.listdir(preprocess_dir):
            if f.endswith('.onnx'):
                models_to_optimize.append(os.path.join('preprocess', f))

    print(f"\n找到 {len(models_to_optimize)} 个模型文件")

    results = []
    for model_file in models_to_optimize:
        model_path = os.path.join(INPUT_DIR, model_file)
        output_path = model_path  # 原地替换

        try:
            model, unsupported = optimize_model(model_path, output_path)
            results.append({
                'name': model_file,
                'ok': True,
                'unsup': unsupported,
                'size': os.path.getsize(output_path) / (1024 * 1024),
            })
        except Exception as e:
            print(f"\n  失败: {model_file} - {e}")
            import traceback
            traceback.print_exc()
            results.append({'name': model_file, 'ok': False, 'error': str(e)})

    # 输出结果
    print(f"\n{'='*60}")
    print("优化结果")
    print(f"{'='*60}")
    for r in results:
        if r['ok']:
            s = f"{r['size']:.1f} MB"
            u = str(r['unsup']) if r['unsup'] else "none"
            print(f"  {r['name']:<40} OK  {s:>10}  unsup: {u}")
        else:
            print(f"  {r['name']:<40} FAIL {r.get('error', '')[:60]}")

    all_ok = all(r['ok'] and not r.get('unsup') for r in results)
    print(f"\n{'All NPU compatible!' if all_ok else 'Some models still have unsupported ops'}")


if __name__ == '__main__':
    main()
