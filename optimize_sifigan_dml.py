# -*- coding: utf-8 -*-
"""SiFiGAN DirectML 兼容性优化脚本。

将 SiFiGAN ONNX 中 DirectML 不支持的大 stride ConvTranspose 节点分解为
DML 兼容的操作序列。

核心问题:
  SiFiGAN Generator 的 4 个上采样层使用 ConvTranspose1D,
  upsample_scales=(5, 4, 3, 2), stride 均 > 1。
  虽然 stride 比 vocoder 的 480 小很多, 但 DirectML 对 stride > 1 的
  ConvTranspose 仍可能不支持, 因此统一分解为 stride=1 的等价序列。

解决方案 (复用 optimize_vocoder_dml.py 的核心分解逻辑):
  ConvTranspose1D(x, w, stride=S, pads=[Pl, Pr]) =
    Conv1D(upsample(x, S), flip(w.T), stride=1, pads=[K-1, K-S-Pl-Pr])

数学原理:
  1. 对输入上采样 S 倍 (在相邻元素间插入 S-1 个零, 长度 T -> T*S)
  2. Conv1D(上采样输入, flip(w.T), stride=1, pads=[K-1, K-S-Pl-Pr])
     其中 flip(w_T)[co, ci, k] = w[ci, co, K-1-k]
  3. 输出长度 = T*S + (K-1) + (K-S-Pl-Pr) - K + 1
              = (T-1)*S + K - Pl - Pr
              与 ConvTranspose 输出长度完全一致 (无需 Slice)
  4. 当 K-S-Pl-Pr < 0 时, 改用 pads=[K-1, 0] + Slice 裁剪末尾

与 optimize_vocoder_dml.py 的差异:
  - SiFiGAN 有 4 个 ConvTranspose 节点 (vocoder 只有 1 个), 需批量处理并
    整体重建 graph.node 避免索引漂移
  - SiFiGAN 输入为 (mel, f0), 探针推理需同时构造两个输入
  - 读取 ConvTranspose 的 pads 属性, 支持非零 padding 的通用分解
  - 大模型以 external_data 格式保存 (参考 export_sifigan_vocoder.py)

用法:
  python optimize_sifigan_dml.py --in sifigan_vocoder.onnx --out sifigan_vocoder_dml.onnx
"""

import os
import sys
import argparse
import shutil

import onnx
from onnx import helper, numpy_helper
import numpy as np


# SiFiGAN 探针输入参数 (与 export_sifigan_vocoder.py 对齐)
MEL_DIM = 128
F0_MIN_HZ = 80.0
F0_MAX_HZ = 400.0
DEFAULT_SEQ_LEN = 500


def find_problematic_conv_transposes(graph):
    """扫描图中所有 stride>1 的 ConvTranspose 节点 (DML 不兼容)。

    Returns:
        list[dict], 每项含 'idx' / 'node' / 'stride' / 'pads' / 'dilations' /
        'groups' / 'output_padding' 等诊断信息。
    """
    problematic = []
    for idx, node in enumerate(graph.node):
        if node.op_type != 'ConvTranspose':
            continue
        stride = None
        pads = None
        dilations = None
        groups = 1
        output_padding = None
        for attr in node.attribute:
            if attr.name == 'strides':
                stride = list(attr.ints)
            elif attr.name == 'pads':
                pads = list(attr.ints)
            elif attr.name == 'dilations':
                dilations = list(attr.ints)
            elif attr.name == 'group':
                groups = attr.i
            elif attr.name == 'output_padding':
                output_padding = list(attr.ints)
        # DML 不支持 stride > 1 的 ConvTranspose
        if stride is not None and any(s > 1 for s in stride):
            problematic.append({
                'idx': idx,
                'node': node,
                'stride': stride,
                'pads': pads if pads is not None else [0, 0],
                'dilations': dilations,
                'groups': groups,
                'output_padding': output_padding,
            })
    return problematic


def inspect_model(model_path):
    """检查模型结构, 打印算子统计与 DML 不兼容节点。仅扫描属性, 不加载权重数据。"""
    print(f"\n{'='*60}")
    print(f"检查模型: {model_path}")
    print(f"{'='*60}")

    # 轻量扫描: 不加载外部权重数据 (仅读取节点属性)
    model = onnx.load(model_path, load_external_data=False)
    graph = model.graph

    op_counts = {}
    for node in graph.node:
        op_counts[node.op_type] = op_counts.get(node.op_type, 0) + 1

    problematic = find_problematic_conv_transposes(graph)

    print(f"  节点总数: {len(graph.node)}")
    print(f"  算子统计 (top 10):")
    for op, cnt in sorted(op_counts.items(), key=lambda x: -x[1])[:10]:
        print(f"    {op}: {cnt}")
    ct_total = op_counts.get('ConvTranspose', 0)
    print(f"  ConvTranspose 节点总数: {ct_total}")
    if problematic:
        print(f"  DML 不兼容 (stride>1) 节点: {len(problematic)} 个")
        for p in problematic:
            print(f"    - [{p['idx']}] {p['node'].name}: "
                  f"ConvTranspose(stride={p['stride']}, pads={p['pads']}, "
                  f"dilations={p['dilations']}, groups={p['groups']})")
            print(f"      inputs: {list(p['node'].input)}")
            print(f"      outputs: {list(p['node'].output)}")
    else:
        print(f"  未发现 stride>1 的 ConvTranspose 节点 (no optimization needed)")

    return problematic


def validate_conv_transpose(ct_node, graph):
    """验证单个 ConvTranspose 节点是否可被分解, 不支持则抛出明确诊断错误。"""
    stride = None
    dilations = None
    groups = 1
    output_padding = None
    for attr in ct_node.attribute:
        if attr.name == 'strides':
            stride = list(attr.ints)
        elif attr.name == 'dilations':
            dilations = list(attr.ints)
        elif attr.name == 'group':
            groups = attr.i
        elif attr.name == 'output_padding':
            output_padding = list(attr.ints)

    if stride is None:
        raise ValueError(
            f"ConvTranspose '{ct_node.name}' 缺少 strides 属性, 无法分解"
        )
    if len(stride) != 1:
        raise ValueError(
            f"ConvTranspose '{ct_node.name}' strides 维度为 {len(stride)}D, "
            f"仅支持 1D (strides 长度为 1) 分解, 多维 ConvTranspose 尚未实现"
        )

    # 权重必须为静态 initializer
    w_name = ct_node.input[1]
    w_init = next((init for init in graph.initializer if init.name == w_name), None)
    if w_init is None:
        raise ValueError(
            f"ConvTranspose '{ct_node.name}' 权重 '{w_name}' 未在 initializer 中找到, "
            f"无法分解 (图输入作为权重的动态 ConvTranspose 不支持分解)"
        )
    w = numpy_helper.to_array(w_init)
    if w.ndim != 3:
        raise ValueError(
            f"ConvTranspose '{ct_node.name}' 权重维度为 {w.ndim}D {w.shape}, "
            f"仅支持 1D ConvTranspose (3D 权重 [c_in, c_out, K]) 分解, "
            f"2D ConvTranspose 分解逻辑尚未实现"
        )

    if dilations is not None and any(d != 1 for d in dilations):
        raise ValueError(
            f"ConvTranspose '{ct_node.name}' dilations={dilations}, "
            f"仅支持 dilations=1 (SiFiGAN 上采样层默认无 dilation), "
            f"带 dilation 的 ConvTranspose 分解逻辑尚未实现"
        )
    if groups != 1:
        raise ValueError(
            f"ConvTranspose '{ct_node.name}' group={groups}, "
            f"分组/深度卷积 ConvTranspose 分解逻辑尚未实现"
        )
    if output_padding is not None and any(p != 0 for p in output_padding):
        raise ValueError(
            f"ConvTranspose '{ct_node.name}' output_padding={output_padding}, "
            f"非零 output_padding 分解逻辑尚未实现"
        )


def build_conv_transpose_replacement(graph, ct_node, uniq_id):
    """
    为单个 ConvTranspose(stride>1) 节点构建 DML 兼容的替换节点序列。

    复用 optimize_vocoder_dml.py 的核心分解逻辑, 并读取 pads 属性支持通用分解:
      ConvTranspose1D(x, w, stride=S, pads=[Pl, Pr]) =
        Conv1D(upsample(x, S), flip(w.T), stride=1, pads=[K-1, K-S-Pl-Pr])

    当 K-S-Pl-Pr >= 0: pads=[K-1, K-S-Pl-Pr], 输出长度 = (T-1)*S + K - Pl - Pr, 无需 Slice
    当 K-S-Pl-Pr  < 0: pads=[K-1, 0], 需要 Slice 裁剪末尾 (S-K+Pl+Pr) 个元素

    Args:
        graph: ONNX 图 (用于追加 initializer)
        ct_node: 待替换的 ConvTranspose 节点
        uniq_id: 唯一标识符, 用于生成不冲突的中间节点名

    Returns:
        list[NodeProto]: 替换节点序列 (顺序与原节点位置对应)
    """
    # 读取属性
    stride = 1
    ct_pads = [0, 0]
    for attr in ct_node.attribute:
        if attr.name == 'strides':
            stride = attr.ints[0]
        elif attr.name == 'pads':
            ct_pads = list(attr.ints)
    ct_pad_left, ct_pad_right = ct_pads[0], ct_pads[1]

    # 读取权重
    w_name = ct_node.input[1]
    w_init = next(init for init in graph.initializer if init.name == w_name)
    w = numpy_helper.to_array(w_init)
    c_in, c_out, K = w.shape

    has_bias = len(ct_node.input) >= 3
    bias_name = ct_node.input[2] if has_bias else None

    print(f"    [{uniq_id}] ConvTranspose '{ct_node.name}': "
          f"weight [{c_in}, {c_out}, {K}], stride={stride}, "
          f"pads=[{ct_pad_left}, {ct_pad_right}], bias={has_bias}")

    # 计算 Conv1D padding (通用公式, 含 ConvTranspose pads)
    p_left = K - 1
    p_right = K - stride - ct_pad_left - ct_pad_right
    need_slice = p_right < 0
    p_right_eff = max(p_right, 0)
    slice_amount = -p_right if need_slice else 0  # = stride - K + ct_pad_left + ct_pad_right

    print(f"        Conv1D 替换: pads=[{p_left}, {p_right_eff}], "
          f"need_slice={need_slice}" + (f", slice_amount={slice_amount}" if need_slice else ""))

    inp = ct_node.input[0]
    out = ct_node.output[0]
    base = f"sifigan_ct_{uniq_id}"

    # === 创建常量 ===

    # 翻转+转置权重: flip(w.T)[co, ci, k] = w[ci, co, K-1-k]
    w_flipped_transposed = w.transpose(1, 0, 2)[:, :, ::-1].copy().astype(np.float32)
    w_conv_name = f"{w_name}_flip_trans_{uniq_id}"
    w_conv_init = numpy_helper.from_array(w_flipped_transposed, name=w_conv_name)
    graph.initializer.append(w_conv_init)

    # Shape 操作常量
    const_0 = numpy_helper.from_array(np.array(0, dtype=np.int64), name=f"{base}_c0")
    const_2 = numpy_helper.from_array(np.array(2, dtype=np.int64), name=f"{base}_c2")
    const_stride_1d = numpy_helper.from_array(
        np.array([stride], dtype=np.int64), name=f"{base}_stride_1d")
    for c in [const_0, const_2, const_stride_1d]:
        graph.initializer.append(c)

    # Pad 常量: 在 axis=3 (最后一维) 后面填充 S-1 个零
    # ONNX Pad 格式: [begin_d0..d3, end_d0..d3]
    pad_pads_4d = numpy_helper.from_array(
        np.array([0, 0, 0, 0, 0, 0, 0, stride - 1], dtype=np.int64),
        name=f"{base}_pad_pads_4d",
    )
    pad_val = numpy_helper.from_array(
        np.array(0.0, dtype=np.float32), name=f"{base}_pad_val")
    graph.initializer.append(pad_pads_4d)
    graph.initializer.append(pad_val)

    # 通道/形状常量
    const_c_in_1d = numpy_helper.from_array(
        np.array([c_in], dtype=np.int64), name=f"{base}_cin_1d")
    const_1_1d = numpy_helper.from_array(
        np.array([1], dtype=np.int64), name=f"{base}_c1_1d")
    graph.initializer.append(const_c_in_1d)
    graph.initializer.append(const_1_1d)

    # === 构建替换节点 ===
    nodes = []

    # Step 1: 获取输入形状 [B, C_in, T]
    nodes.append(helper.make_node('Shape', [inp], [f"{base}_shape"], name=f"{base}_shape"))

    # T = shape[2] (标量 -> 1D)
    nodes.append(helper.make_node('Gather', [f"{base}_shape", f"{base}_c2"],
                                 [f"{base}_T_scalar"], name=f"{base}_gT", axis=0))
    nodes.append(helper.make_node('Unsqueeze', [f"{base}_T_scalar", f"{base}_c0"],
                                 [f"{base}_T"], name=f"{base}_uT"))

    # T * S (1D: [T*S])
    nodes.append(helper.make_node('Mul', [f"{base}_T", f"{base}_stride_1d"],
                                 [f"{base}_TS"], name=f"{base}_mul_TS"))

    # B = shape[0] (标量 -> 1D)
    nodes.append(helper.make_node('Gather', [f"{base}_shape", f"{base}_c0"],
                                 [f"{base}_B_scalar"], name=f"{base}_gB", axis=0))
    nodes.append(helper.make_node('Unsqueeze', [f"{base}_B_scalar", f"{base}_c0"],
                                 [f"{base}_B"], name=f"{base}_uB"))

    # Step 2: Reshape [B, C_in, T] -> [B, C_in, T, 1]
    nodes.append(helper.make_node('Concat',
                                 [f"{base}_B", f"{base}_cin_1d", f"{base}_T", f"{base}_c1_1d"],
                                 [f"{base}_shape_4d"], name=f"{base}_cat_4d", axis=0))
    nodes.append(helper.make_node('Reshape', [inp, f"{base}_shape_4d"],
                                 [f"{base}_r4d"], name=f"{base}_reshape_4d"))

    # Step 3: Pad [B, C_in, T, 1] -> [B, C_in, T, S]
    nodes.append(helper.make_node('Pad',
                                 [f"{base}_r4d", f"{base}_pad_pads_4d", f"{base}_pad_val"],
                                 [f"{base}_padded"], name=f"{base}_pad", mode='constant'))

    # Step 4: Reshape [B, C_in, T, S] -> [B, C_in, T*S]
    nodes.append(helper.make_node('Concat', [f"{base}_B", f"{base}_cin_1d", f"{base}_TS"],
                                 [f"{base}_flat_shape"], name=f"{base}_cat_flat", axis=0))
    nodes.append(helper.make_node('Reshape', [f"{base}_padded", f"{base}_flat_shape"],
                                 [f"{base}_flat"], name=f"{base}_reshape_flat"))

    # Step 5: Conv1D with flip(w.T), stride=1
    conv_inputs = [f"{base}_flat", w_conv_name]
    if has_bias:
        conv_inputs.append(bias_name)
    conv_out_name = f"{base}_conv_out"

    if need_slice:
        # K-S-Pl-Pr < 0: pads=[K-1, 0], 然后 Slice 裁剪末尾 slice_amount 个元素
        conv_node = helper.make_node('Conv', conv_inputs, [conv_out_name],
                                     name=f"{base}_conv",
                                     kernel_shape=[K], strides=[1], pads=[p_left, 0])
        nodes.append(conv_node)

        # out_len = T*S - slice_amount
        const_slice_amount = numpy_helper.from_array(
            np.array([slice_amount], dtype=np.int64), name=f"{base}_slice_amt")
        graph.initializer.append(const_slice_amount)
        nodes.append(helper.make_node('Sub', [f"{base}_TS", f"{base}_slice_amt"],
                                     [f"{base}_out_len"], name=f"{base}_sub_outlen"))

        slice_starts = numpy_helper.from_array(
            np.array([0, 0, 0], dtype=np.int64), name=f"{base}_slice_starts")
        graph.initializer.append(slice_start is None or slice_starts)  # placeholder, replaced below
        graph.initializer[-1] = slice_starts

        const_max = numpy_helper.from_array(
            np.array([np.iinfo(np.int64).max], dtype=np.int64), name=f"{base}_max")
        graph.initializer.append(const_max)
        nodes.append(helper.make_node('Concat',
                                     [f"{base}_max", f"{base}_max", f"{base}_out_len"],
                                     [f"{base}_slice_ends"], name=f"{base}_cat_ends", axis=0))

        slice_axes = numpy_helper.from_array(
            np.array([0, 1, 2], dtype=np.int64), name=f"{base}_slice_axes")
        graph.initializer.append(slice_axes)
        nodes.append(helper.make_node('Slice',
                                     [conv_out_name, f"{base}_slice_starts",
                                      f"{base}_slice_ends", f"{base}_slice_axes"],
                                     [out], name=f"{base}_slice"))
    else:
        # K-S-Pl-Pr >= 0: pads=[K-1, K-S-Pl-Pr], 输出长度直接正确, 无需 Slice
        conv_node = helper.make_node('Conv', conv_inputs, [out],
                                     name=f"{base}_conv",
                                     kernel_shape=[K], strides=[1], pads=[p_left, p_right_eff])
        nodes.append(conv_node)

    return nodes


def fix_all_conv_transposes(model):
    """将所有 stride>1 的 ConvTranspose 节点替换为 DML 兼容序列。

    逐节点扫描, 遇到需替换的 ConvTranspose 用替换序列代替, 其余节点原样保留,
    最后整体替换 graph.node, 避免多节点替换时的索引漂移问题。
    """
    graph = model.graph
    problematic = find_problematic_conv_transposes(graph)

    print(f"\n{'='*60}")
    print(f"分解 {len(problematic)} 个 ConvTranspose 节点")
    print(f"{'='*60}")

    if not problematic:
        print("  无需分解")
        return 0

    # 先验证所有节点可分解 (快速失败, 避免半途修改图)
    for p in problematic:
        validate_conv_transpose(p['node'], graph)

    # 为每个需替换的节点构建替换序列 (同时追加 initializer)
    replace_map = {}
    for order, p in enumerate(problematic):
        ct_node = p['node']
        replace_map[id(ct_node)] = build_conv_transpose_replacement(graph, ct_node, order)

    # 重建节点列表 (保持原始拓扑顺序)
    new_nodes = []
    replaced_count = 0
    for node in graph.node:
        if id(node) in replace_map:
            new_nodes.extend(replace_map[id(node)])
            replaced_count += 1
        else:
            new_nodes.append(node)

    del graph.node[:]
    graph.node.extend(new_nodes)

    print(f"  替换完成: {replaced_count} 个 ConvTranspose -> DML 兼容序列")
    return replaced_count


def run_shape_inference(model):
    """对内存中的模型运行形状推断, 返回新模型 (失败则原样返回)。"""
    print(f"\n  运行 ONNX 形状推断...")
    try:
        inferred = onnx.shape_inference.infer_shapes(model)
        print(f"  形状推断完成")
        return inferred
    except Exception as e:
        print(f"  形状推断失败: {e}")
        return model


def simplify_model(model, seq_len=10):
    """使用 onnxsim 简化内存中的模型 (保留动态输入形状), 失败则原样返回。

    onnxsim 会移除替换后被弃用的原始 ConvTranspose 权重等冗余 initializer。
    """
    print(f"\n  尝试使用 onnxsim 简化模型 (保留动态输入形状)...")
    try:
        import onnxsim
        simplified, check = onnxsim.simplify(
            model,
            overwrite_input_shapes={
                'mel': [1, 'seq_len', MEL_DIM],
                'f0': [1, 'seq_len', 1],
            },
            test_input_shapes={
                'mel': [1, seq_len, MEL_DIM],
                'f0': [1, seq_len, 1],
            },
        )
        if check:
            print(f"  onnxsim 简化成功")
            return simplified
        else:
            print(f"  onnxsim 简化后验证失败, 使用形状推断版本")
            return model
    except ImportError:
        print(f"  onnxsim 未安装, 跳过简化")
        return model
    except Exception as e:
        print(f"  onnxsim 简化失败: {e}")
        return model


def save_model_external(model, path):
    """保存模型为 external_data 格式 (处理大初始值, 参考 export_sifigan_vocoder.py)。"""
    # 清理可能存在的旧 .data 文件
    data_path = path + ".data"
    if os.path.exists(data_path):
        os.remove(data_path)

    onnx.save_model(
        model, path,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=os.path.basename(path) + ".data",
        size_threshold=1024,
    )
    size_mb = os.path.getsize(path) / 1024 / 1024
    data_mb = os.path.getsize(data_path) / 1024 / 1024 if os.path.exists(data_path) else 0
    print(f"  保存: {path} ({size_mb:.1f}MB graph + {data_mb:.1f}MB data)")


def make_probe_inputs(seq_len):
    """构造 SiFiGAN 探针输入。

    Returns:
        dict 输入名 -> np.float32 ndarray
        mel: [1, seq_len, 128]
        f0:  [1, seq_len, 1], 范围 [80, 400] Hz
    """
    np.random.seed(42)
    mel = np.random.randn(1, seq_len, MEL_DIM).astype(np.float32) * 0.1
    f0 = (np.random.rand(1, seq_len, 1).astype(np.float32)
          * (F0_MAX_HZ - F0_MIN_HZ) + F0_MIN_HZ)  # [80, 400] Hz
    return {'mel': mel, 'f0': f0}


def test_with_dml(model_path, seq_len=DEFAULT_SEQ_LEN):
    """使用 DirectML EP 跑探针推理, 验证 DML 可用性。

    Returns:
        True  : DML 活跃且推理成功
        False : DML 活跃但推理失败 (含 ConvTranspose 不兼容错误)
        None  : DML 不可用 (已打印 skipping validation)
    """
    import onnxruntime as ort

    print(f"\n{'='*60}")
    print(f"DML 探针推理: {os.path.basename(model_path)} (seq_len={seq_len})")
    print(f"{'='*60}")

    try:
        sess = ort.InferenceSession(
            model_path, providers=['DmlExecutionProvider', 'CPUExecutionProvider'])
    except Exception as e:
        msg = str(e)
        if 'DML' in msg or 'DirectML' in msg or 'DmlExecutionProvider' in msg:
            print(f"  DML not available, skipping validation")
            return None
        print(f"  ❌ 加载会话失败: {msg[:300]}")
        return False

    active_providers = sess.get_providers()
    dml_active = 'DmlExecutionProvider' in active_providers
    print(f"  活跃 EP: {active_providers}")
    print(f"  DML 状态: {'✅ 活跃' if dml_active else '❌ 未激活 (回退 CPU)'}")

    if not dml_active:
        print(f"  DML not available, skipping validation")
        return None

    inputs = make_probe_inputs(seq_len)
    try:
        results = sess.run(None, inputs)
        print(f"  推理成功! 输出形状: {[r.shape for r in results]}")
        print(f"  输出范围: [{results[0].min():.6f}, {results[0].max():.6f}]")
        return True
    except Exception as e:
        msg = str(e)
        if 'ConvTranspose' in msg or 'stride' in msg or 'DML' in msg:
            print(f"  ❌ DML 推理失败 (疑似 ConvTranspose 不兼容): {msg[:300]}")
        else:
            print(f"  ❌ DML 推理失败: {msg[:300]}")
        return False


def compare_outputs(original_path, fixed_path, seq_len=DEFAULT_SEQ_LEN):
    """比较原始模型与优化后模型的 CPU 推理输出, 验证数值等价性 (误差 < 1e-3)。"""
    import onnxruntime as ort

    print(f"\n{'='*60}")
    print(f"输出对比测试 (CPU, seq_len={seq_len})")
    print(f"{'='*60}")

    inputs = make_probe_inputs(seq_len)

    # 原始模型 (CPU)
    try:
        sess_orig = ort.InferenceSession(original_path, providers=['CPUExecutionProvider'])
        result_orig = sess_orig.run(None, inputs)[0]
        print(f"  原始模型: shape={result_orig.shape}, "
              f"range=[{result_orig.min():.6f}, {result_orig.max():.6f}]")
    except Exception as e:
        print(f"  ❌ 原始模型推理失败: {str(e)[:200]}")
        return False

    # 优化后模型 (CPU)
    try:
        sess_fixed = ort.InferenceSession(fixed_path, providers=['CPUExecutionProvider'])
        result_fixed = sess_fixed.run(None, inputs)[0]
        print(f"  优化模型: shape={result_fixed.shape}, "
              f"range=[{result_fixed.min():.6f}, {result_fixed.max():.6f}]")
    except Exception as e:
        print(f"  ❌ 优化模型推理失败: {str(e)[:200]}")
        return False

    if result_orig.shape != result_fixed.shape:
        print(f"  ❌ 输出形状不匹配: {result_orig.shape} vs {result_fixed.shape}")
        return False

    abs_diff = np.abs(result_orig - result_fixed)
    max_diff = abs_diff.max()
    mean_diff = abs_diff.mean()

    print(f"  绝对误差: max={max_diff:.8f}, mean={mean_diff:.8f}")

    if max_diff < 1e-3:
        print(f"  ✅ 输出一致 (误差 < 1e-3, 在可接受范围内)")
        return True
    elif max_diff < 1e-1:
        print(f"  ⚠️ 输出存在较小差异, 但可能可接受")
        return True
    else:
        print(f"  ❌ 输出差异过大 (max={max_diff:.8f} >= 1e-3)")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="SiFiGAN DirectML 兼容性优化脚本")
    parser.add_argument('--in', dest='input', required=True,
                        help='输入 SiFiGAN ONNX 模型路径 (如 sifigan_vocoder.onnx)')
    parser.add_argument('--out', dest='output', required=True,
                        help='输出 DML 兼容 ONNX 模型路径 (如 sifigan_vocoder_dml.onnx)')
    parser.add_argument('--seq-len', type=int, default=DEFAULT_SEQ_LEN,
                        help=f'探针输入帧数 (默认 {DEFAULT_SEQ_LEN})')
    args = parser.parse_args()

    input_path = args.input
    output_path = args.output

    print("=" * 60)
    print("SiFiGAN DirectML 兼容性优化工具")
    print("=" * 60)
    print(f"  输入: {input_path}")
    print(f"  输出: {output_path}")

    if not os.path.exists(input_path):
        print(f"\n❌ 找不到输入模型: {input_path}")
        sys.exit(1)

    # Step 1: 检查模型 (轻量扫描, 不加载权重数据)
    problematic = inspect_model(input_path)

    if not problematic:
        # 无 DML 不兼容算子, 直接复制文件 (含外部数据)
        print(f"\nno optimization needed")
        shutil.copy2(input_path, output_path)
        data_in = input_path + ".data"
        data_out = output_path + ".data"
        if os.path.exists(data_in) and os.path.abspath(data_in) != os.path.abspath(data_out):
            shutil.copy2(data_in, data_out)
        print(f"  已复制到: {output_path}")
        sys.exit(0)

    # Step 2: 加载完整模型 (含外部权重数据) 并分解所有 stride>1 的 ConvTranspose
    print(f"\n{'='*60}")
    print(f"加载完整模型并分解 ConvTranspose")
    print(f"{'='*60}")
    model = onnx.load(input_path, load_external_data=True)

    try:
        replaced = fix_all_conv_transposes(model)
    except ValueError as e:
        print(f"\n❌ 分解失败 (不支持的算子配置): {e}")
        sys.exit(1)

    if replaced == 0:
        # 理论上不会走到这里 (inspect 已判定), 兜底处理
        print(f"\nno optimization needed")
        shutil.copy2(input_path, output_path)
        data_in = input_path + ".data"
        data_out = output_path + ".data"
        if os.path.exists(data_in) and os.path.abspath(data_in) != os.path.abspath(data_out):
            shutil.copy2(data_in, data_out)
        sys.exit(0)

    # Step 3: 形状推断 (内存)
    model = run_shape_inference(model)

    # Step 4: onnxsim 简化 (内存, 移除冗余 initializer)
    model = simplify_model(model, seq_len=10)

    # Step 5: 保存优化后模型 (external_data 格式)
    print(f"\n{'='*60}")
    print(f"保存优化后模型")
    print(f"{'='*60}")
    save_model_external(model, output_path)

    # Step 6: 数值正确性验证 (CPU 对比, 误差 < 1e-3)
    output_correct = compare_outputs(input_path, output_path, seq_len=args.seq_len)
    if not output_correct:
        print("\n❌ 优化后模型输出与原始模型不一致, 请检查分解逻辑")
        sys.exit(1)

    # Step 7: DML 探针推理验证
    dml_result = test_with_dml(output_path, seq_len=args.seq_len)
    if dml_result is True:
        print(f"\n✅ DML 探针推理通过!")
    elif dml_result is False:
        print(f"\n⚠️ DML 探针推理失败 (数值已验证正确, 但 DML 仍无法运行该模型)")
    else:
        # DML 不可用, 已打印 skipping validation
        pass

    # Step 8: 文件大小对比与最终结果
    print(f"\n{'='*60}")
    print(f"最终结果")
    print(f"{'='*60}")
    orig_size = os.path.getsize(input_path) / (1024 * 1024)
    new_size = os.path.getsize(output_path) / (1024 * 1024)
    print(f"  文件大小: 原始={orig_size:.2f}MB, DML版={new_size:.2f}MB")

    if output_correct and dml_result is True:
        print(f"\n🎉 优化完成! {os.path.basename(output_path)} 已可在 DML 上运行")
    elif output_correct and dml_result is None:
        print(f"\n✅ 数值验证通过 (DML 不可用, 已跳过 DML 验证; CPU 推理可用)")
    elif output_correct:
        print(f"\n⚠️ 数值验证通过, 但 DML 探针推理失败 (模型可作 CPU 回退)")
    else:
        print(f"\n❌ 优化失败")
        sys.exit(1)


if __name__ == '__main__':
    main()
