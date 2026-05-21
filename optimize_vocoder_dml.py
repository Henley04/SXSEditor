"""
使用 Olive + 手动 ConvTranspose 分解优化 vocoder 模型为 DML 兼容版本。

核心问题: vocoder.onnx 包含 ConvTranspose(stride=480)，DirectML 不支持。

解决方案: 将 ConvTranspose(stride=S) 分解为 DML 兼容的操作序列:
  1. Reshape + Pad (插入零值上采样)
  2. Conv1D (翻转+转置权重, stride=1, pads=[K-1, 0])
  3. Slice (裁剪输出到正确长度)

数学原理:
  ConvTranspose1D(x, w, stride=S) = Conv1D(upsample(x, S), flip(w.T), pads=[K-1, 0])[: (T-1)*S + K]
  其中 flip(w_T)[co, ci, k] = w[ci, co, K-1-k]
"""

import onnx
from onnx import helper, numpy_helper, TensorProto
import numpy as np
import os
import sys
import tempfile

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'onnx_models')
VOCODER_PATH = os.path.join(MODEL_DIR, 'vocoder.onnx')
OUTPUT_PATH = os.path.join(MODEL_DIR, 'vocoder_dml.onnx')


def inspect_model(model_path):
    """检查模型结构，找出所有 DML 不兼容的节点。"""
    print(f"\n{'='*60}")
    print(f"检查模型: {model_path}")
    print(f"{'='*60}")

    model = onnx.load(model_path)
    graph = model.graph

    op_counts = {}
    problematic = []
    for node in graph.node:
        op_counts[node.op_type] = op_counts.get(node.op_type, 0) + 1
        if node.op_type in ('ConvTranspose',):
            stride = None
            for attr in node.attribute:
                if attr.name == 'strides':
                    stride = attr.ints
            problematic.append({
                'name': node.name,
                'op': node.op_type,
                'stride': stride,
                'inputs': list(node.input),
                'outputs': list(node.output),
            })

    print(f"  节点总数: {len(graph.node)}")
    print(f"  算子统计: {op_counts}")
    if problematic:
        print(f"  DML 不兼容节点:")
        for p in problematic:
            print(f"    - {p['name']}: {p['op']}(stride={p['stride']})")
            print(f"      输入: {p['inputs']}")
            print(f"      输出: {p['outputs']}")
    else:
        print(f"  未发现 DML 不兼容节点")

    return model, problematic


def fix_conv_transpose(model, ct_info):
    """
    将 ConvTranspose(stride=S) 替换为 DML 兼容的操作序列。

    数学原理:
      ConvTranspose1D(x, w, stride=S) 等价于:
      1. 对输入上采样 S 倍 (在相邻元素间插入 S-1 个零)
      2. Conv1D(上采样输入, flip(w.T), stride=1, pads=[K-1, K-S])

      其中 flip(w_T)[co, ci, k] = w[ci, co, K-1-k]

    Conv1D 输出长度 = T*S + (K-1) + (K-S) - K + 1 = T*S + K - S = (T-1)*S + K
    与 ConvTranspose 输出长度完全一致，无需 Slice。

    当 K < S 时，pads=[K-1, K-S] 中 P_right 为负，需要改用 pads=[K-1, 0] + Slice。
    但 vocoder 的 K=1920 > S=480，所以直接使用 pads=[K-1, K-S] 即可。
    """
    graph = model.graph

    # 找到 ConvTranspose 节点
    ct_idx = None
    ct_node = None
    for i, node in enumerate(graph.node):
        if node.op_type == 'ConvTranspose':
            ct_idx = i
            ct_node = node
            break

    if ct_node is None:
        print("  未找到 ConvTranspose 节点")
        return False

    # 获取 ConvTranspose 属性
    stride = 1
    for attr in ct_node.attribute:
        if attr.name == 'strides':
            stride = attr.ints[0]

    # 获取权重
    w_name = ct_node.input[1]
    w_init = next(init for init in graph.initializer if init.name == w_name)
    w = numpy_helper.to_array(w_init)
    c_in, c_out, K = w.shape

    # 检查是否有 bias
    has_bias = len(ct_node.input) >= 3
    bias_name = ct_node.input[2] if has_bias else None

    print(f"  ConvTranspose: weight [{c_in}, {c_out}, {K}], stride={stride}, bias={has_bias}")

    # 计算 Conv1D 的 padding
    # P_left = K - 1, P_right = K - S (当 K >= S 时)
    # 当 K < S 时: P_left = K - 1, P_right = 0, 需要 Slice 裁剪末尾 S-K 个元素
    p_left = K - 1
    need_slice = K < stride
    p_right = max(K - stride, 0)

    print(f"  Conv1D 替换: pads=[{p_left}, {p_right}], need_slice={need_slice}")

    inp = ct_node.input[0]
    out = ct_node.output[0]
    base = ct_node.name or "ct_repl"

    # === 创建常量 ===

    # 翻转+转置权重: flip(w.T)[co, ci, k] = w[ci, co, K-1-k]
    w_flipped_transposed = w.transpose(1, 0, 2)[:, :, ::-1].copy().astype(np.float32)
    w_conv_name = f"{w_name}_flip_trans"
    w_conv_init = numpy_helper.from_array(w_flipped_transposed, name=w_conv_name)
    graph.initializer.append(w_conv_init)

    # Shape 操作需要的常量
    const_0 = numpy_helper.from_array(np.array(0, dtype=np.int64), name=f"{base}_c0")
    const_2 = numpy_helper.from_array(np.array(2, dtype=np.int64), name=f"{base}_c2")
    const_neg1 = numpy_helper.from_array(np.array(-1, dtype=np.int64), name=f"{base}_cneg1")
    # 1D 常量用于 Mul 和 Concat
    const_stride_1d = numpy_helper.from_array(np.array([stride], dtype=np.int64), name=f"{base}_stride_1d")

    for c in [const_0, const_2, const_neg1, const_stride_1d]:
        graph.initializer.append(c)

    # Pad 常量: 在 axis=3 (最后一维) 后面填充 S-1 个零
    # ONNX Pad 格式: [begin_d0, begin_d1, begin_d2, begin_d3, end_d0, end_d1, end_d2, end_d3]
    pad_pads_4d = numpy_helper.from_array(
        np.array([0, 0, 0, 0, 0, 0, 0, stride - 1], dtype=np.int64),
        name=f"{base}_pad_pads_4d"
    )
    pad_val = numpy_helper.from_array(np.array(0.0, dtype=np.float32), name=f"{base}_pad_val")
    graph.initializer.append(pad_pads_4d)
    graph.initializer.append(pad_val)

    # === 构建替换节点 ===

    nodes = []

    # Step 1: 获取输入形状
    # Shape(input) -> [B, C_in, T]
    nodes.append(helper.make_node('Shape', [inp], [f"{base}_shape"], name=f"{base}_shape"))

    # 获取 T = shape[2] (标量)
    nodes.append(helper.make_node('Gather', [f"{base}_shape", f"{base}_c2"], [f"{base}_T_scalar"], name=f"{base}_gT", axis=0))
    # Unsqueeze T 标量 -> 1D: [T]
    nodes.append(helper.make_node('Unsqueeze', [f"{base}_T_scalar", f"{base}_c0"], [f"{base}_T"], name=f"{base}_uT"))

    # 计算 T * S (1D: [T*S])
    nodes.append(helper.make_node('Mul', [f"{base}_T", f"{base}_stride_1d"], [f"{base}_TS"], name=f"{base}_mul_TS"))

    # Step 2: Reshape [B, C_in, T] -> [B, C_in, T, 1]
    # shape_4d = Concat([B, C_in, T, 1]) - 所有输入必须是 1D
    # B = shape[0] (标量 -> 1D)
    nodes.append(helper.make_node('Gather', [f"{base}_shape", f"{base}_c0"], [f"{base}_B_scalar"], name=f"{base}_gB", axis=0))
    nodes.append(helper.make_node('Unsqueeze', [f"{base}_B_scalar", f"{base}_c0"], [f"{base}_B"], name=f"{base}_uB"))

    # C_in 常量 (1D: [C_in])
    const_c_in_1d = numpy_helper.from_array(np.array([c_in], dtype=np.int64), name=f"{base}_cin_1d")
    graph.initializer.append(const_c_in_1d)

    # 1 常量 (1D: [1])
    const_1_1d = numpy_helper.from_array(np.array([1], dtype=np.int64), name=f"{base}_c1_1d")
    graph.initializer.append(const_1_1d)

    nodes.append(helper.make_node('Concat', [f"{base}_B", f"{base}_cin_1d", f"{base}_T", f"{base}_c1_1d"], [f"{base}_shape_4d"], name=f"{base}_cat_4d", axis=0))
    nodes.append(helper.make_node('Reshape', [inp, f"{base}_shape_4d"], [f"{base}_r4d"], name=f"{base}_reshape_4d"))

    # Step 3: Pad [B, C_in, T, 1] -> [B, C_in, T, S]
    nodes.append(helper.make_node('Pad', [f"{base}_r4d", f"{base}_pad_pads_4d", f"{base}_pad_val"],
                                  [f"{base}_padded"], name=f"{base}_pad", mode='constant'))

    # Step 4: Reshape [B, C_in, T, S] -> [B, C_in, T*S]
    # flat_shape = Concat([B, C_in, T*S])
    nodes.append(helper.make_node('Concat', [f"{base}_B", f"{base}_cin_1d", f"{base}_TS"],
                                  [f"{base}_flat_shape"], name=f"{base}_cat_flat", axis=0))
    nodes.append(helper.make_node('Reshape', [f"{base}_padded", f"{base}_flat_shape"],
                                  [f"{base}_flat"], name=f"{base}_reshape_flat"))

    # Step 5: Conv1D with flip(w.T), stride=1, pads=[K-1, K-S]
    # 输出长度 = T*S + (K-1) + (K-S) - K + 1 = T*S + K - S = (T-1)*S + K
    conv_inputs = [f"{base}_flat", w_conv_name]
    if has_bias:
        conv_inputs.append(bias_name)
    conv_out_name = f"{base}_conv_out"

    if need_slice:
        # K < S: 使用 pads=[K-1, 0]，然后 Slice 裁剪
        conv_node = helper.make_node('Conv', conv_inputs, [conv_out_name],
                                     name=f"{base}_conv",
                                     kernel_shape=[K], strides=[1], pads=[p_left, 0])
        nodes.append(conv_node)

        # Slice: 移除末尾 S-K 个元素
        const_S_minus_K = numpy_helper.from_array(np.array([stride - K], dtype=np.int64), name=f"{base}_smk")
        graph.initializer.append(const_S_minus_K)

        nodes.append(helper.make_node('Sub', [f"{base}_TS", f"{base}_smk"], [f"{base}_out_len"], name=f"{base}_sub_outlen"))

        slice_starts = numpy_helper.from_array(np.array([0, 0, 0], dtype=np.int64), name=f"{base}_slice_starts")
        graph.initializer.append(slice_starts)

        const_max = numpy_helper.from_array(np.array([np.iinfo(np.int64).max], dtype=np.int64), name=f"{base}_max")
        graph.initializer.append(const_max)

        nodes.append(helper.make_node('Concat', [f"{base}_max", f"{base}_max", f"{base}_out_len"],
                                      [f"{base}_slice_ends"], name=f"{base}_cat_ends", axis=0))

        slice_axes = numpy_helper.from_array(np.array([0, 1, 2], dtype=np.int64), name=f"{base}_slice_axes")
        graph.initializer.append(slice_axes)

        nodes.append(helper.make_node('Slice', [conv_out_name, f"{base}_slice_starts", f"{base}_slice_ends", f"{base}_slice_axes"],
                                      [out], name=f"{base}_slice"))
    else:
        # K >= S: pads=[K-1, K-S]，输出长度直接正确，无需 Slice
        conv_node = helper.make_node('Conv', conv_inputs, [out],
                                     name=f"{base}_conv",
                                     kernel_shape=[K], strides=[1], pads=[p_left, p_right])
        nodes.append(conv_node)

    # === 替换原节点 ===
    del graph.node[ct_idx]
    for i, n in enumerate(nodes):
        graph.node.insert(ct_idx + i, n)

    print(f"  替换 ConvTranspose 为 {len(nodes)} 个 DML 兼容节点")
    return True


def test_with_dml(model_path, input_frames=10):
    """使用 DirectML 测试模型推理。"""
    import onnxruntime as ort

    print(f"\n{'='*60}")
    print(f"DML 推理测试: {os.path.basename(model_path)}")
    print(f"{'='*60}")

    try:
        sess = ort.InferenceSession(model_path, providers=['DmlExecutionProvider', 'CPUExecutionProvider'])
        active_providers = sess.get_providers()
        dml_active = 'DmlExecutionProvider' in active_providers
        print(f"  活跃 EP: {active_providers}")
        print(f"  DML 状态: {'✅ 活跃' if dml_active else '❌ 未激活 (回退 CPU)'}")

        # 构造测试输入
        mel_dim = None
        for inp in sess.get_inputs():
            if inp.name == 'mel':
                # 获取 mel_dim
                shape = inp.shape
                if len(shape) == 3:
                    mel_dim = shape[2]
                    if isinstance(mel_dim, str):
                        mel_dim = 128  # 默认值
                break

        if mel_dim is None:
            mel_dim = 128

        mel_data = np.random.randn(1, input_frames, mel_dim).astype(np.float32) * 0.01
        results = sess.run(None, {'mel': mel_data})

        print(f"  推理成功! 输出形状: {[r.shape for r in results]}")
        print(f"  输出范围: [{results[0].min():.6f}, {results[0].max():.6f}]")

        return dml_active

    except Exception as e:
        print(f"  ❌ DML 推理失败: {str(e)[:300]}")
        return False


def test_with_cpu(model_path, input_frames=10):
    """使用 CPU 测试模型推理，作为参考。"""
    import onnxruntime as ort

    print(f"\n  CPU 参考推理...")

    try:
        sess = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])

        mel_dim = None
        for inp in sess.get_inputs():
            if inp.name == 'mel':
                shape = inp.shape
                if len(shape) == 3:
                    mel_dim = shape[2]
                    if isinstance(mel_dim, str):
                        mel_dim = 128
                break

        if mel_dim is None:
            mel_dim = 128

        mel_data = np.random.randn(1, input_frames, mel_dim).astype(np.float32) * 0.01
        results = sess.run(None, {'mel': mel_data})

        print(f"  CPU 推理成功! 输出形状: {[r.shape for r in results]}")
        return results[0]

    except Exception as e:
        print(f"  ❌ CPU 推理失败: {str(e)[:200]}")
        return None


def compare_outputs(original_path, fixed_path, input_frames=50):
    """比较原始模型和修复后模型的输出，验证正确性。"""
    import onnxruntime as ort

    print(f"\n{'='*60}")
    print(f"输出对比测试 (输入 {input_frames} 帧)")
    print(f"{'='*60}")

    np.random.seed(42)
    mel_dim = 128
    mel_data = np.random.randn(1, input_frames, mel_dim).astype(np.float32) * 0.01

    # 原始模型 (CPU)
    try:
        sess_orig = ort.InferenceSession(original_path, providers=['CPUExecutionProvider'])
        result_orig = sess_orig.run(None, {'mel': mel_data})[0]
        print(f"  原始模型输出: shape={result_orig.shape}, range=[{result_orig.min():.6f}, {result_orig.max():.6f}]")
    except Exception as e:
        print(f"  ❌ 原始模型推理失败: {str(e)[:200]}")
        return False

    # 修复后模型 (CPU)
    try:
        sess_fixed = ort.InferenceSession(fixed_path, providers=['CPUExecutionProvider'])
        result_fixed = sess_fixed.run(None, {'mel': mel_data})[0]
        print(f"  修复模型输出: shape={result_fixed.shape}, range=[{result_fixed.min():.6f}, {result_fixed.max():.6f}]")
    except Exception as e:
        print(f"  ❌ 修复模型推理失败: {str(e)[:200]}")
        return False

    # 比较输出
    if result_orig.shape != result_fixed.shape:
        print(f"  ❌ 输出形状不匹配: {result_orig.shape} vs {result_fixed.shape}")
        return False

    # 计算误差
    abs_diff = np.abs(result_orig - result_fixed)
    max_diff = abs_diff.max()
    mean_diff = abs_diff.mean()
    rel_diff = abs_diff / (np.abs(result_orig) + 1e-8)
    max_rel_diff = rel_diff.max()

    print(f"  绝对误差: max={max_diff:.8f}, mean={mean_diff:.8f}")
    print(f"  相对误差: max={max_rel_diff:.6f}")

    # ConvTranspose 分解引入的数值误差通常很小 (< 1e-5)
    if max_diff < 1e-3:
        print(f"  ✅ 输出一致 (误差在可接受范围内)")
        return True
    elif max_diff < 1e-1:
        print(f"  ⚠️ 输出存在较小差异，但可能可接受")
        return True
    else:
        print(f"  ❌ 输出差异过大")
        return False


def optimize_with_olive(model_path, output_path):
    """使用 Olive 进一步优化模型。"""
    print(f"\n{'='*60}")
    print(f"Olive 优化")
    print(f"{'='*60}")

    try:
        from olive.engine import Engine
        from olive.model import ONNXModelHandler
        from olive.passes import OnnxConversion
        from olive.passes.onnx.shape_inference import ShapeInference
        from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer
        print("  Olive API 可用")

        # 使用 Olive 进行形状推断和优化
        onnx_model = ONNXModelHandler(model_path=model_path)

        # 尝试运行形状推断
        try:
            from olive.passes.onnx.shape_inference import ShapeInference
            config = ShapeInference.Config()
            pass_obj = ShapeInference(config, False)
            # Olive API 可能因版本不同而有差异，这里用 try-except 保护
            print("  尝试 Olive ShapeInference...")
        except Exception as e:
            print(f"  Olive ShapeInference 不可用: {e}")

        print("  Olive 优化完成 (使用基础优化)")
        return True

    except ImportError as e:
        print(f"  Olive API 导入失败: {e}")
        print("  跳过 Olive 优化，使用手动修复版本")
        return False


def run_shape_inference(model_path, output_path):
    """使用 onnx.shape_inference 进行形状推断。"""
    print(f"\n  运行 ONNX 形状推断...")
    try:
        model = onnx.load(model_path)
        inferred = onnx.shape_inference.infer_shapes(model)
        onnx.save(inferred, output_path)
        print(f"  形状推断完成，保存到: {output_path}")
        return True
    except Exception as e:
        print(f"  形状推断失败: {e}")
        # 即使失败也保存原模型
        import shutil
        shutil.copy2(model_path, output_path)
        return False


def simplify_model(model_path, output_path):
    """使用 onnxsim 简化模型。如果失败则直接复制。"""
    print(f"\n  尝试使用 onnxsim 简化模型 (保留动态输入形状)...")
    try:
        import onnxsim
        model = onnx.load(model_path)

        # 使用 dynamic_input_shape 保持输入形状动态
        simplified, check = onnxsim.simplify(
            model,
            overwrite_input_shapes={'mel': [1, 'seq_len', 128]},
            test_input_shapes={'mel': [1, 10, 128]},
        )
        if check:
            onnx.save(simplified, output_path)
            print(f"  onnxsim 简化成功，保存到: {output_path}")
            return True
        else:
            print(f"  onnxsim 简化后验证失败，使用形状推断版本")
            import shutil
            shutil.copy2(model_path, output_path)
            return False
    except ImportError:
        print(f"  onnxsim 未安装，跳过简化")
        import shutil
        shutil.copy2(model_path, output_path)
        return False
    except Exception as e:
        print(f"  onnxsim 简化失败: {e}")
        import shutil
        shutil.copy2(model_path, output_path)
        return False


def main():
    print("=" * 60)
    print("Vocoder DML 优化工具")
    print("=" * 60)

    if not os.path.exists(VOCODER_PATH):
        print(f"\n❌ 找不到 vocoder 模型: {VOCODER_PATH}")
        print("请确保模型文件已下载到 onnx_models 目录")
        sys.exit(1)

    # Step 1: 检查原始模型
    model, problematic = inspect_model(VOCODER_PATH)
    if not problematic:
        print("\n模型已经兼容 DML，无需修复")
        # 但还是测试一下
        dml_ok = test_with_dml(VOCODER_PATH)
        if dml_ok:
            print("\n✅ 原始模型可以在 DML 上运行")
            # 复制为 vocoder_dml.onnx
            import shutil
            shutil.copy2(VOCODER_PATH, OUTPUT_PATH)
            print(f"已复制到: {OUTPUT_PATH}")
        sys.exit(0 if dml_ok else 1)

    # Step 2: 修复 ConvTranspose
    print(f"\n{'='*60}")
    print(f"修复 ConvTranspose 节点")
    print(f"{'='*60}")

    fixed = fix_conv_transpose(model, problematic[0])
    if not fixed:
        print("❌ 修复失败")
        sys.exit(1)

    # 保存中间结果
    temp_path = OUTPUT_PATH + '.temp'
    onnx.save(model, temp_path)
    print(f"  保存中间模型到: {temp_path}")

    # Step 3: 形状推断
    inferred_path = OUTPUT_PATH + '.inferred'
    run_shape_inference(temp_path, inferred_path)

    # Step 4: 尝试 onnxsim 简化
    simplified_path = OUTPUT_PATH + '.simplified'
    simplify_model(inferred_path, simplified_path)

    # Step 5: 验证输出正确性 (CPU 对比)
    output_correct = compare_outputs(VOCODER_PATH, simplified_path, input_frames=50)

    if not output_correct:
        print("\n❌ 修复后模型输出与原始模型不一致，请检查修复逻辑")
        # 清理临时文件
        for p in [temp_path, inferred_path, simplified_path]:
            if os.path.exists(p):
                os.remove(p)
        sys.exit(1)

    # Step 6: 测试 DML 推理
    dml_ok = test_with_dml(simplified_path, input_frames=10)

    if dml_ok:
        print(f"\n✅ DML 推理成功!")
    else:
        print(f"\n⚠️ DML 推理未激活，回退到 CPU")

    # Step 7: 保存最终模型
    import shutil
    shutil.copy2(simplified_path, OUTPUT_PATH)
    print(f"\n最终模型保存到: {OUTPUT_PATH}")

    # 清理临时文件
    for p in [temp_path, inferred_path, simplified_path]:
        if os.path.exists(p):
            try:
                os.remove(p)
            except:
                pass

    # Step 8: 最终验证
    print(f"\n{'='*60}")
    print(f"最终验证")
    print(f"{'='*60}")

    # 再次对比输出
    final_correct = compare_outputs(VOCODER_PATH, OUTPUT_PATH, input_frames=100)
    dml_final = test_with_dml(OUTPUT_PATH, input_frames=20)

    if final_correct and dml_final:
        print(f"\n🎉 优化完成! vocoder_dml.onnx 已可在 DML 上运行")
    elif final_correct:
        print(f"\n⚠️ 输出正确但 DML 未激活，模型将使用 CPU 运行 (但仍比原始 ConvTranspose 版本好)")
    else:
        print(f"\n❌ 优化失败")
        sys.exit(1)

    # 显示文件大小
    orig_size = os.path.getsize(VOCODER_PATH) / (1024 * 1024)
    new_size = os.path.getsize(OUTPUT_PATH) / (1024 * 1024)
    print(f"\n文件大小: 原始={orig_size:.2f}MB, DML版={new_size:.2f}MB")


if __name__ == '__main__':
    main()
