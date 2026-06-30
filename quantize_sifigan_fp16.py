# -*- coding: utf-8 -*-
"""SiFiGAN Vocoder FP16 量化脚本。

将 FP32 SiFiGAN ONNX 模型量化为 FP16，将所有权重 initializer 与模型 I/O 类型
从 float32 转换为 float16，并将结果保存为 external_data 格式。

输入:
  - sifigan_vocoder_dml.onnx (DML 优化版, 推荐)
  - sifigan_vocoder.onnx     (未优化版, 兜底)

输出:
  - sifigan_vocoder_dml_fp16.onnx + sifigan_vocoder_dml_fp16.onnx.data

量化策略 (手动实现, 比 onnxconverter_common 快得多):
  - 权重 initializer: float32 -> float16 (numpy astype)
  - 模型输入/输出类型: float32 -> float16
  - 中间张量: 通过 onnx.shape_inference 推断后同步类型
  - Cast 节点处理 (关键):
    * to=FLOAT 的 Cast: 将 'to' 属性改为 FLOAT16, 输出 value_info 同步转 FP16
      (保持 Cast 节点与 FP16 主路径一致, 避免类型断链)
    * to=INT64/INT32/BOOL 等非浮点 Cast: 跳过, 不改 'to' 也不改输出 value_info
      (这些 Cast 输出的是索引/形状张量, 与 FP16 主路径无关)

精度验证:
  - 构造 mel+f0 探针输入
  - 同时跑 FP32 与 FP16 模型 (CPU EP)
  - 计算 cosine 相似度, 阈值 >= 0.95 视为通过

用法:
  python quantize_sifigan_fp16.py
  python quantize_sifigan_fp16.py --in sifigan_vocoder_dml.onnx --out sifigan_vocoder_dml_fp16.onnx
  python quantize_sifigan_fp16.py --skip-validation
"""

import os
import sys
import argparse

import numpy as np
import onnx
from onnx import numpy_helper, TensorProto, shape_inference

# SiFiGAN 探针输入参数 (与 export_sifigan_vocoder.py / optimize_sifigan_dml.py 对齐)
MEL_DIM = 128
F0_MIN_HZ = 80.0
F0_MAX_HZ = 400.0
DEFAULT_SEQ_LEN = 500

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_INPUT = os.path.join(SCRIPT_DIR, 'onnx_models', 'sifigan_vocoder_dml.onnx')
DEFAULT_OUTPUT = os.path.join(SCRIPT_DIR, 'onnx_models', 'sifigan_vocoder_dml_fp16.onnx')


def clear_memory():
    """按需释放内存, 防止内存溢出 (项目规则)。"""
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass
    gc.collect()


def convert_initializers_to_fp16(model):
    """将所有 float32 initializer 转换为 float16。

    跳过 int/bool 等非浮点 initializer (如形状常量)。
    返回转换数量。
    """
    count = 0
    for init in model.graph.initializer:
        if init.data_type == TensorProto.FLOAT:
            arr = numpy_helper.to_array(init).astype(np.float16)
            new_init = numpy_helper.from_array(arr, name=init.name)
            init.CopyFrom(new_init)
            count += 1
    return count


def convert_constant_nodes_to_fp16(model):
    """将所有节点中持有 float32 TensorProto 值的属性转换为 float16。

    涵盖:
      - Constant 节点的 'value' 属性
      - ConstantOfShape 节点的 'value' 属性 (决定输出张量类型)
      - 其他可能携带 TensorProto 属性的节点 (防御性扫描)

    若不转换, 这些常量会保持 FP32, 导致下游算子出现类型不匹配
    (例如 ConstantOfShape 输出 FP32 但 value_info 被改为 FP16, 触发
    "Type (tensor(float16)) of output arg ... of node ..." 错误)。
    跳过非浮点 (INT64/INT32 等) 的 TensorProto 值。
    """
    count = 0
    for node in model.graph.node:
        for attr in node.attribute:
            # 单张量属性 (type == TENSOR)
            if attr.type == onnx.AttributeProto.TENSOR:
                t = attr.t
                if t.data_type == TensorProto.FLOAT:
                    arr = numpy_helper.to_array(t).astype(np.float16)
                    new_t = numpy_helper.from_array(arr, name=t.name)
                    attr.t.CopyFrom(new_t)
                    count += 1
            # 张量列表属性 (type == TENSORS)
            elif attr.type == onnx.AttributeProto.TENSORS:
                for i, t in enumerate(attr.tensors):
                    if t.data_type == TensorProto.FLOAT:
                        arr = numpy_helper.to_array(t).astype(np.float16)
                        new_t = numpy_helper.from_array(arr, name=t.name)
                        attr.tensors[i].CopyFrom(new_t)
                        count += 1
    return count


def convert_io_types_to_fp16(model):
    """将 graph.input / graph.output 中的 float32 类型修改为 float16。"""
    count = 0
    for inp in model.graph.input:
        if inp.type.tensor_type.elem_type == TensorProto.FLOAT:
            inp.type.tensor_type.elem_type = TensorProto.FLOAT16
            count += 1
    for out in model.graph.output:
        if out.type.tensor_type.elem_type == TensorProto.FLOAT:
            out.type.tensor_type.elem_type = TensorProto.FLOAT16
            count += 1
    return count


def collect_cast_output_names(model):
    """收集所有 Cast 节点输出的名称, 按输出类型分类。

    返回 (float_cast_outputs, nonfloat_cast_outputs):
      - float_cast_outputs: Cast(to=FLOAT) 输出名, 这些会在后续被改为 FLOAT16
        (既要改 'to' 属性, 也要改 value_info 类型)
      - nonfloat_cast_outputs: Cast(to=INT64/INT32/BOOL/...) 输出名, 这些跳过
        (不改 'to' 也不改 value_info, 因为输出的是索引/形状张量)
    """
    float_cast_outputs = set()
    nonfloat_cast_outputs = set()
    for node in model.graph.node:
        if node.op_type == 'Cast':
            to_type = None
            for attr in node.attribute:
                if attr.name == 'to':
                    to_type = attr.i
                    break
            for out_name in node.output:
                if not out_name:
                    continue
                if to_type == TensorProto.FLOAT:
                    float_cast_outputs.add(out_name)
                else:
                    nonfloat_cast_outputs.add(out_name)
    return float_cast_outputs, nonfloat_cast_outputs


def rewrite_float_casts_to_fp16(model, float_cast_outputs):
    """将 Cast(to=FLOAT) 节点的 'to' 属性改为 FLOAT16。

    这样 Cast 节点输出 FP16, 与 FP16 主路径一致, 避免类型断链。
    """
    count = 0
    for node in model.graph.node:
        if node.op_type == 'Cast':
            out_names = set(node.output)
            if not (out_names & float_cast_outputs):
                continue
            for attr in node.attribute:
                if attr.name == 'to' and attr.i == TensorProto.FLOAT:
                    attr.i = TensorProto.FLOAT16
                    count += 1
                    break
    return count


def convert_value_info_to_fp16(model, skip_names):
    """将 graph.value_info 中已推断为 float32 的中间张量改为 float16。

    跳过 skip_names 集合中的张量 (非浮点 Cast 节点的输出, 类型由 'to' 属性决定)。
    """
    count = 0
    skipped = 0
    for vi in model.graph.value_info:
        if vi.name in skip_names:
            skipped += 1
            continue
        if vi.type.tensor_type.elem_type == TensorProto.FLOAT:
            vi.type.tensor_type.elem_type = TensorProto.FLOAT16
            count += 1
    return count, skipped


def save_model_external(model, path):
    """保存模型为 external_data 格式 (处理大初始值)。

    与 optimize_sifigan_dml.py / export_sifigan_vocoder.py 保持一致。
    """
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
    print(f"  Saved: {path} ({size_mb:.1f}MB graph + {data_mb:.1f}MB data)")
    return size_mb + data_mb


def make_probe_inputs(seq_len):
    """构造 SiFiGAN 探针输入 (FP32)。

    与 optimize_sifigan_dml.py / export_sifigan_vocoder.py 对齐:
      mel: [1, seq_len, 128] float32
      f0:  [1, seq_len, 1]   float32, 范围 [80, 400] Hz
    """
    np.random.seed(42)
    mel = np.random.randn(1, seq_len, MEL_DIM).astype(np.float32) * 0.1
    f0 = (np.random.rand(1, seq_len, 1).astype(np.float32)
          * (F0_MAX_HZ - F0_MIN_HZ) + F0_MIN_HZ)
    return {'mel': mel, 'f0': f0}


def make_fp16_inputs(fp32_inputs):
    """将 FP32 探针输入转换为 FP16 (与 FP16 模型 I/O 类型匹配)。"""
    return {
        name: arr.astype(np.float16) for name, arr in fp32_inputs.items()
    }


def verify_accuracy(fp32_path, fp16_path, seq_len=DEFAULT_SEQ_LEN, threshold=0.95):
    """验证 FP16 模型与 FP32 模型的输出相似度 (cosine similarity)。"""
    import onnxruntime as ort

    print(f"\n{'='*60}")
    print(f"Accuracy verification (FP32 vs FP16, CPU EP, seq_len={seq_len})")
    print(f"{'='*60}")

    fp32_inputs = make_probe_inputs(seq_len)
    fp16_inputs = make_fp16_inputs(fp32_inputs)

    # FP32 模型推理
    sess_fp32 = None
    sess_fp16 = None
    try:
        sess_fp32 = ort.InferenceSession(fp32_path, providers=['CPUExecutionProvider'])
        out_fp32 = sess_fp32.run(None, fp32_inputs)[0].astype(np.float32).flatten()
        print(f"  FP32 output: shape={out_fp32.shape}, "
              f"range=[{out_fp32.min():.6f}, {out_fp32.max():.6f}]")
    except Exception as e:
        print(f"  [FAIL] FP32 inference failed: {str(e)[:200]}")
        return False
    finally:
        del sess_fp32
        sess_fp32 = None
        clear_memory()

    # FP16 模型推理
    try:
        sess_fp16 = ort.InferenceSession(fp16_path, providers=['CPUExecutionProvider'])
        out_fp16 = sess_fp16.run(None, fp16_inputs)[0].astype(np.float32).flatten()
        print(f"  FP16 output: shape={out_fp16.shape}, "
              f"range=[{out_fp16.min():.6f}, {out_fp16.max():.6f}]")
    except Exception as e:
        print(f"  [FAIL] FP16 inference failed: {str(e)[:200]}")
        return False
    finally:
        del sess_fp16
        sess_fp16 = None
        clear_memory()

    # 长度对齐 (防御性, 实际应一致)
    n = min(len(out_fp32), len(out_fp16))
    a = out_fp32[:n]
    b = out_fp16[:n]

    # cosine similarity
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na < 1e-10 or nb < 1e-10:
        cos = 1.0 if abs(na - nb) < 1e-10 else 0.0
    else:
        cos = float(np.dot(a, b) / (na * nb))

    # L1 误差
    abs_diff = np.abs(a - b)
    max_diff = float(abs_diff.max())
    mean_diff = float(abs_diff.mean())

    print(f"  Cosine similarity: {cos:.6f}")
    print(f"  L1 max error:      {max_diff:.8f}")
    print(f"  L1 mean error:     {mean_diff:.8f}")
    print(f"  Threshold:         {threshold:.4f}")

    if cos >= threshold:
        print(f"  [PASS] FP16 量化精度验证通过 (cosine={cos:.6f} >= {threshold})")
        return True
    else:
        print(f"  [FAIL] FP16 量化精度不达标 (cosine={cos:.6f} < {threshold})")
        return False


def inspect_model_io(model_path):
    """打印模型输入/输出的名称与类型, 便于诊断。"""
    model = onnx.load(model_path, load_external_data=False)
    print(f"  Inputs:")
    for inp in model.graph.input:
        dt = inp.type.tensor_type.elem_type
        dt_name = TensorProto.DataType.Name(dt) if dt else 'unknown'
        dims = [d.dim_value if d.dim_value > 0 else d.dim_param or '?' for d in inp.type.tensor_type.shape.dim]
        print(f"    {inp.name}: {dt_name} {dims}")
    print(f"  Outputs:")
    for out in model.graph.output:
        dt = out.type.tensor_type.elem_type
        dt_name = TensorProto.DataType.Name(dt) if dt else 'unknown'
        dims = [d.dim_value if d.dim_value > 0 else d.dim_param or '?' for d in out.type.tensor_type.shape.dim]
        print(f"    {out.name}: {dt_name} {dims}")


def quantize_sifigan_fp16(input_path, output_path, skip_validation=False, seq_len=DEFAULT_SEQ_LEN):
    """主量化流程: 加载 FP32 -> 转换为 FP16 -> 保存 -> 验证。"""
    print("=" * 60)
    print("SiFiGAN Vocoder FP16 Quantization")
    print("=" * 60)
    print(f"  Input:  {input_path}")
    print(f"  Output: {output_path}")

    if not os.path.exists(input_path):
        # 兜底: 自动尝试未优化版本
        fallback = os.path.join(os.path.dirname(input_path), 'sifigan_vocoder.onnx')
        if os.path.exists(fallback):
            print(f"  [WARN] Input not found, using fallback: {fallback}")
            input_path = fallback
        else:
            print(f"\n[ERROR] Input model not found: {input_path}")
            sys.exit(1)

    # 检查输入模型 I/O 类型
    print(f"\n  Input model I/O types:")
    inspect_model_io(input_path)

    # 加载完整模型 (含外部权重)
    print(f"\n  Loading full model (with external data)...")
    model = onnx.load(input_path, load_external_data=True)

    # 检查是否已为 FP16
    fp_inits = [init for init in model.graph.initializer
                if init.data_type in (TensorProto.FLOAT, TensorProto.FLOAT16)]
    is_already_fp16 = bool(fp_inits) and all(
        init.data_type == TensorProto.FLOAT16 for init in fp_inits
    )
    if is_already_fp16:
        print(f"  [WARN] Model is already FP16, saving as-is")
        save_model_external(model, output_path)
        return

    # 统计转换前的 initializer 类型分布
    type_counts_before = {}
    for init in model.graph.initializer:
        dt = init.data_type
        type_counts_before[dt] = type_counts_before.get(dt, 0) + 1
    type_names_before = {TensorProto.DataType.Name(k): v for k, v in type_counts_before.items()}
    print(f"  Initializer type distribution (before): {type_names_before}")

    # Step 1: 转换 initializer + Constant 节点
    print(f"\n{'='*60}")
    print("Step 1: Convert initializers and Constant nodes to FP16")
    print(f"{'='*60}")
    init_count = convert_initializers_to_fp16(model)
    print(f"  Converted {init_count} float32 initializers to float16")
    const_count = convert_constant_nodes_to_fp16(model)
    print(f"  Converted {const_count} Constant node values to float16")
    type_counts_after = {}
    for init in model.graph.initializer:
        dt = init.data_type
        type_counts_after[dt] = type_counts_after.get(dt, 0) + 1
    type_names_after = {TensorProto.DataType.Name(k): v for k, v in type_counts_after.items()}
    print(f"  Initializer type distribution (after): {type_names_after}")

    # Step 2: 转换 I/O 类型
    print(f"\n{'='*60}")
    print("Step 2: Convert input/output types to FP16")
    print(f"{'='*60}")
    io_count = convert_io_types_to_fp16(model)
    print(f"  Converted {io_count} input/output types to float16")

    # Step 3: 转换 value_info 中间张量 (处理 Cast 节点)
    print(f"\n{'='*60}")
    print("Step 3: Convert value_info to FP16 (handle Cast nodes)")
    print(f"{'='*60}")
    # 先收集 Cast 输出名 (在 shape inference 之前, 节点结构稳定)
    float_cast_outputs, nonfloat_cast_outputs = collect_cast_output_names(model)
    print(f"  Found {len(float_cast_outputs)} Cast(to=FLOAT) outputs (will rewrite to FP16)")
    print(f"  Found {len(nonfloat_cast_outputs)} Cast(to=non-float) outputs (will skip)")
    # 将 Cast(to=FLOAT) 的 'to' 属性改为 FLOAT16
    rewritten = rewrite_float_casts_to_fp16(model, float_cast_outputs)
    print(f"  Rewrote {rewritten} Cast nodes: to=FLOAT -> to=FLOAT16")
    # 运行形状推断, 让中间张量获得类型信息
    try:
        print(f"  Running shape inference...")
        model = shape_inference.infer_shapes(model)
        print(f"  Shape inference complete")
    except Exception as e:
        print(f"  Shape inference failed (continuing): {e}")

    # 跳过非浮点 Cast 输出 (它们的类型由 'to' 属性决定, 不能改)
    vi_count, vi_skipped = convert_value_info_to_fp16(model, nonfloat_cast_outputs)
    print(f"  Converted {vi_count} value_info types to float16 (skipped {vi_skipped} non-float Cast outputs)")

    # Step 4: 保存 FP16 模型
    print(f"\n{'='*60}")
    print("Step 4: Save FP16 model")
    print(f"{'='*60}")
    fp16_size = save_model_external(model, output_path)

    # 源模型大小 (含 .data)
    src_size = os.path.getsize(input_path) / 1024 / 1024
    src_data = input_path + ".data"
    if os.path.exists(src_data):
        src_size += os.path.getsize(src_data) / 1024 / 1024
    ratio = src_size / fp16_size if fp16_size > 0 else 0
    print(f"  Size: src={src_size:.1f}MB, fp16={fp16_size:.1f}MB, ratio={ratio:.2f}x")

    # 检查输出模型 I/O 类型
    print(f"\n  Output model I/O types:")
    inspect_model_io(output_path)

    # 释放 model 内存
    del model
    clear_memory()

    # Step 5: 精度验证
    if skip_validation:
        print(f"\n[SKIP] Accuracy verification skipped")
        return

    print(f"\n{'='*60}")
    print("Step 5: Accuracy verification")
    print(f"{'='*60}")
    passed = verify_accuracy(input_path, output_path, seq_len=seq_len)
    if not passed:
        print(f"\n[FAIL] FP16 quantization accuracy verification failed")
        sys.exit(1)

    print(f"\n[DONE] FP16 quantization complete!")
    print(f"  Output: {output_path}")
    print(f"  Output data: {output_path}.data")


def main():
    parser = argparse.ArgumentParser(
        description="SiFiGAN Vocoder FP16 量化脚本")
    parser.add_argument('--in', dest='input', default=DEFAULT_INPUT,
                        help=f'输入 SiFiGAN ONNX 模型路径 (默认 {DEFAULT_INPUT})')
    parser.add_argument('--out', dest='output', default=DEFAULT_OUTPUT,
                        help=f'输出 FP16 ONNX 模型路径 (默认 {DEFAULT_OUTPUT})')
    parser.add_argument('--seq-len', type=int, default=DEFAULT_SEQ_LEN,
                        help=f'探针输入帧数 (默认 {DEFAULT_SEQ_LEN})')
    parser.add_argument('--skip-validation', action='store_true',
                        help='跳过精度验证')
    args = parser.parse_args()

    quantize_sifigan_fp16(
        input_path=args.input,
        output_path=args.output,
        skip_validation=args.skip_validation,
        seq_len=args.seq_len,
    )


if __name__ == '__main__':
    main()
