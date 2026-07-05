# -*- coding: utf-8 -*-
"""SiFiGAN Vocoder FP16 量化脚本。

策略：
- 手动实现 FP16 量化，避免 onnxconverter_common 的类型不兼容问题
- 支持混合精度：通过 --keep-fp32-blocks 控制最后几个残差块保留 FP32
- 正确处理大常量（24000/48000等），不截断
- 模型 I/O 保持 FP32（与应用层兼容）

输入:
  - sifigan_vocoder_dml.onnx

输出:
  - sifigan_vocoder_dml_fp16.onnx + .data
"""

import os
import sys
import re
import argparse

import numpy as np
import onnx
from onnx import numpy_helper, TensorProto, helper

MEL_DIM = 128
F0_MIN_HZ = 80.0
F0_MAX_HZ = 400.0
DEFAULT_SEQ_LEN = 500

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_INPUT = os.path.join(SCRIPT_DIR, 'onnx_models', 'sifigan_vocoder_dml.onnx')
DEFAULT_OUTPUT = os.path.join(SCRIPT_DIR, 'onnx_models', 'sifigan_vocoder_dml_fp16.onnx')

KEEP_FP32_BLOCKS = 0
KEEP_OUTPUT_FP32 = False


def clear_memory():
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass
    gc.collect()


def should_keep_fp32(node_name):
    """判断该计算节点是否应该保留为 FP32。"""
    if KEEP_FP32_BLOCKS <= 0:
        return False

    name = node_name

    if '/output_conv/' in name:
        return True

    m = re.search(r'/blocks\.(\d+)/', name)
    if m:
        block_id = int(m.group(1))
        total_blocks = 12
        if block_id >= (total_blocks - KEEP_FP32_BLOCKS):
            return True

    return False


def save_model_external(model, path):
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
    np.random.seed(42)
    mel = np.random.randn(1, seq_len, MEL_DIM).astype(np.float32) * 0.1
    f0 = (np.random.rand(1, seq_len, 1).astype(np.float32)
          * (F0_MAX_HZ - F0_MIN_HZ) + F0_MIN_HZ)
    return {'mel': mel, 'f0': f0}


def verify_accuracy(fp32_path, fp16_path, seq_len=DEFAULT_SEQ_LEN, threshold=0.95):
    import onnxruntime as ort

    print(f"\n{'='*60}")
    print(f"Accuracy verification (FP32 vs FP16, CPU EP, seq_len={seq_len})")
    print(f"{'='*60}")

    fp32_inputs = make_probe_inputs(seq_len)
    fp16_inputs = fp32_inputs

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

    try:
        sess_fp16 = ort.InferenceSession(fp16_path, providers=['CPUExecutionProvider'])
        out_fp16 = sess_fp16.run(None, fp16_inputs)[0].astype(np.float32).flatten()
        print(f"  FP16 output: shape={out_fp16.shape}, "
              f"range=[{out_fp16.min():.6f}, {out_fp16.max():.6f}]")
    except Exception as e:
        print(f"  [FAIL] FP16 inference failed: {str(e)[:200]}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        del sess_fp16
        sess_fp16 = None
        clear_memory()

    n = min(len(out_fp32), len(out_fp16))
    a = out_fp32[:n]
    b = out_fp16[:n]

    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na < 1e-10 or nb < 1e-10:
        cos = 1.0 if abs(na - nb) < 1e-10 else 0.0
    else:
        cos = float(np.dot(a, b) / (na * nb))

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


def check_large_constants(model_path):
    model = onnx.load(model_path, load_external_data=True)
    print(f"  Large constant check:")
    found_fp32 = 0
    found_fp16 = 0
    for node in model.graph.node:
        if node.op_type == 'Constant':
            for attr in node.attribute:
                if attr.type == onnx.AttributeProto.TENSOR:
                    arr = numpy_helper.to_array(attr.t)
                    max_val = float(np.abs(arr).max()) if arr.size > 0 else 0
                    if max_val > 1000:
                        dt_name = TensorProto.DataType.Name(attr.t.data_type)
                        if attr.t.data_type == TensorProto.FLOAT:
                            found_fp32 += 1
                        elif attr.t.data_type == TensorProto.FLOAT16:
                            found_fp16 += 1
                        print(f"    {node.name}: {max_val:.2f} ({dt_name}, shape={arr.shape})")
    for init in model.graph.initializer:
        if init.data_type in (TensorProto.FLOAT, TensorProto.FLOAT16):
            arr = numpy_helper.to_array(init)
            max_val = float(np.abs(arr).max()) if arr.size > 0 else 0
            if max_val > 1000 and arr.size <= 10:
                dt_name = TensorProto.DataType.Name(init.data_type)
                if init.data_type == TensorProto.FLOAT:
                    found_fp32 += 1
                else:
                    found_fp16 += 1
                print(f"    init:{init.name}: {max_val:.2f} ({dt_name}, shape={arr.shape})")
    print(f"  Total: {found_fp32} FP32, {found_fp16} FP16 large constants")


def get_keep_fp32_init_names(model):
    """获取需要保留 FP32 的 initializer 名称。"""
    keep_inits = set()

    if KEEP_OUTPUT_FP32:
        init_names = set(init.name for init in model.graph.initializer)
        for node in model.graph.node:
            if '/output_conv/' in node.name and node.op_type in ('Conv', 'ConvTranspose'):
                for inp in node.input:
                    if inp in init_names:
                        keep_inits.add(inp)

    if KEEP_FP32_BLOCKS <= 0:
        return keep_inits

    init_names = set(init.name for init in model.graph.initializer)

    for node in model.graph.node:
        if node.op_type in ('Conv', 'ConvTranspose') and should_keep_fp32(node.name):
            for inp in node.input:
                if inp in init_names:
                    keep_inits.add(inp)

    return keep_inits


def convert_initializers_to_fp16(model, keep_fp32_inits=None):
    """将 initializer 转换为 FP16。"""
    if keep_fp32_inits is None:
        keep_fp32_inits = set()
    count = 0
    skipped = 0
    for init in model.graph.initializer:
        if init.data_type == TensorProto.FLOAT:
            if init.name in keep_fp32_inits:
                skipped += 1
                continue
            arr = numpy_helper.to_array(init)
            arr_fp16 = arr.astype(np.float16)
            new_init = numpy_helper.from_array(arr_fp16, name=init.name)
            init.CopyFrom(new_init)
            count += 1
    print(f"  Converted {count} initializers to FP16 (skipped {skipped})")
    return count


def convert_constant_nodes_to_fp16(model):
    """将 Constant 节点的值转换为 FP16。"""
    count = 0
    for node in model.graph.node:
        if node.op_type == 'Constant':
            for attr in node.attribute:
                if attr.type == onnx.AttributeProto.TENSOR:
                    if attr.t.data_type == TensorProto.FLOAT:
                        arr = numpy_helper.to_array(attr.t)
                        arr_fp16 = arr.astype(np.float16)
                        new_tensor = numpy_helper.from_array(arr_fp16)
                        attr.t.CopyFrom(new_tensor)
                        count += 1
        elif node.op_type == 'ConstantOfShape':
            for attr in node.attribute:
                if attr.name == 'value' and attr.type == onnx.AttributeProto.TENSOR:
                    if attr.t.data_type == TensorProto.FLOAT:
                        arr = numpy_helper.to_array(attr.t)
                        arr_fp16 = arr.astype(np.float16)
                        new_tensor = numpy_helper.from_array(arr_fp16)
                        attr.t.CopyFrom(new_tensor)
                        count += 1
    print(f"  Converted {count} Constant/ConstantOfShape nodes to FP16")
    return count


def convert_cast_nodes_to_fp16(model):
    """将原始 Cast 节点的 to=FLOAT 改为 to=FLOAT16。
    
    原始模型中有些冗余的 FLOAT->FLOAT Cast 节点。
    量化后输入变成了 FP16，所以 to 也应该改成 FLOAT16。
    """
    count = 0
    for node in model.graph.node:
        if node.op_type == 'Cast':
            for attr in node.attribute:
                if attr.name == 'to' and attr.i == TensorProto.FLOAT:
                    attr.i = TensorProto.FLOAT16
                    count += 1
                    break
    print(f"  Converted {count} Cast nodes (to FLOAT -> FLOAT16)")
    return count


def make_cast_node(name, input_name, output_name, to_type):
    """创建一个 Cast 节点。"""
    return helper.make_node(
        'Cast',
        inputs=[input_name],
        outputs=[output_name],
        name=name,
        to=to_type,
    )


def add_io_cast_nodes(model):
    """在模型输入输出处添加 Cast 节点，保持 I/O 为 FP32。"""
    new_nodes = []

    for inp in model.graph.input:
        if inp.type.tensor_type.elem_type == TensorProto.FLOAT:
            cast_output = f"{inp.name}_fp16"
            cast_node = make_cast_node(
                f"{inp.name}_input_cast",
                inp.name,
                cast_output,
                TensorProto.FLOAT16,
            )
            new_nodes.append(cast_node)
            for node in model.graph.node:
                for i in range(len(node.input)):
                    if node.input[i] == inp.name:
                        node.input[i] = cast_output

    output_names = [out.name for out in model.graph.output]
    for out in model.graph.output:
        if out.type.tensor_type.elem_type == TensorProto.FLOAT:
            cast_input = f"{out.name}_fp16"
            cast_node = make_cast_node(
                f"{out.name}_output_cast",
                cast_input,
                out.name,
                TensorProto.FLOAT,
            )
            new_nodes.append(cast_node)
            for node in model.graph.node:
                for i in range(len(node.output)):
                    if node.output[i] == out.name:
                        node.output[i] = cast_input

    model.graph.node.extend(new_nodes)
    print(f"  Added {len(new_nodes)} I/O Cast nodes")


def find_producer(node_by_output, tensor_name):
    """找到生产某个张量的节点。"""
    return node_by_output.get(tensor_name)


def find_consumers(model, tensor_name):
    """找到消费某个张量的所有节点。"""
    consumers = []
    for node in model.graph.node:
        for inp in node.input:
            if inp == tensor_name:
                consumers.append(node)
                break
    return consumers


def add_mixed_precision_casts(model):
    """为混合精度添加边界 Cast 节点。
    
    对于保留 FP32 的层：
    - 在其输入前插入 FP16 -> FP32 Cast
    - 在其输出后插入 FP32 -> FP16 Cast
    - 把相关的 initializer 恢复为 FP32
    """
    if KEEP_FP32_BLOCKS <= 0:
        return

    keep_init_names = get_keep_fp32_init_names(model)
    print(f"  Keeping {len(keep_init_names)} initializers as FP32")

    for init in model.graph.initializer:
        if init.name in keep_init_names and init.data_type == TensorProto.FLOAT16:
            arr = numpy_helper.to_array(init)
            arr_fp32 = arr.astype(np.float32)
            new_init = numpy_helper.from_array(arr_fp32, name=init.name)
            init.CopyFrom(new_init)

    node_by_output = {}
    for node in model.graph.node:
        for out in node.output:
            node_by_output[out] = node

    keep_nodes = []
    for node in model.graph.node:
        if node.op_type in ('Conv', 'ConvTranspose') and should_keep_fp32(node.name):
            keep_nodes.append(node)

    boundary_inputs = set()
    boundary_outputs = set()
    init_names = set(init.name for init in model.graph.initializer)

    for node in keep_nodes:
        for inp in node.input:
            if inp in init_names:
                continue
            producer = find_producer(node_by_output, inp)
            if producer is None or producer.op_type in ('Conv', 'ConvTranspose') and not should_keep_fp32(producer.name):
                boundary_inputs.add(inp)
            elif producer is not None and producer.op_type not in ('Conv', 'ConvTranspose'):
                boundary_inputs.add(inp)

        for out in node.output:
            consumers = find_consumers(model, out)
            all_keep = True
            for c in consumers:
                if c.op_type in ('Conv', 'ConvTranspose') and not should_keep_fp32(c.name):
                    all_keep = False
                    break
                if c.op_type not in ('Conv', 'ConvTranspose'):
                    all_keep = False
                    break
            if not all_keep:
                boundary_outputs.add(out)

    print(f"  Boundary inputs (FP16->FP32): {len(boundary_inputs)}")
    print(f"  Boundary outputs (FP32->FP16): {len(boundary_outputs)}")

    new_nodes = []

    for inp_name in sorted(boundary_inputs):
        cast_output = f"{inp_name}_fp32"
        cast_node = make_cast_node(
            f"cast_{inp_name.replace('/', '_').replace('.', '_')}_to_fp32",
            inp_name,
            cast_output,
            TensorProto.FLOAT,
        )
        new_nodes.append(cast_node)
        for node in keep_nodes:
            for i in range(len(node.input)):
                if node.input[i] == inp_name:
                    node.input[i] = cast_output

    for out_name in sorted(boundary_outputs):
        cast_input = f"{out_name}_fp32out"
        cast_node = make_cast_node(
            f"cast_{out_name.replace('/', '_').replace('.', '_')}_to_fp16",
            cast_input,
            out_name,
            TensorProto.FLOAT16,
        )
        new_nodes.append(cast_node)
        for node in keep_nodes:
            for i in range(len(node.output)):
                if node.output[i] == out_name:
                    node.output[i] = cast_input

    model.graph.node.extend(new_nodes)
    print(f"  Added {len(new_nodes)} boundary Cast nodes")


def keep_output_layer_fp32(model):
    """保留输出层为 FP32 精度。
    
    输出层对最终波形质量影响最大，保留为 FP32 可以显著提升精度，
    但只增加很小的模型大小（约 0.1MB）。
    """
    if not KEEP_OUTPUT_FP32:
        return

    output_init_names = set()
    output_node_names = set()
    for node in model.graph.node:
        if '/output_conv/' in node.name:
            output_node_names.add(node.name)
            for inp in node.input:
                for init in model.graph.initializer:
                    if init.name == inp:
                        output_init_names.add(inp)
                        break

    print(f"  Output layer nodes: {len(output_node_names)}")
    print(f"  Output layer initializers: {len(output_init_names)}")

    for init in model.graph.initializer:
        if init.name in output_init_names and init.data_type == TensorProto.FLOAT16:
            arr = numpy_helper.to_array(init)
            arr_fp32 = arr.astype(np.float32)
            new_init = numpy_helper.from_array(arr_fp32, name=init.name)
            init.CopyFrom(new_init)

    first_output_node = None
    for node in model.graph.node:
        if '/output_conv/' in node.name:
            first_output_node = node
            break

    if first_output_node is None:
        print("  [WARN] No output conv node found")
        return

    node_by_output = {}
    for node in model.graph.node:
        for out in node.output:
            node_by_output[out] = node

    init_names = set(init.name for init in model.graph.initializer)

    boundary_inputs = set()
    for inp in first_output_node.input:
        if inp in init_names:
            continue
        producer = node_by_output.get(inp)
        if producer is not None and '/output_conv/' not in producer.name:
            boundary_inputs.add(inp)

    print(f"  Output layer boundary inputs: {len(boundary_inputs)}")

    new_nodes = []
    for inp_name in sorted(boundary_inputs):
        cast_output = f"{inp_name}_fp32"
        cast_node = make_cast_node(
            f"cast_output_input_to_fp32",
            inp_name,
            cast_output,
            TensorProto.FLOAT,
        )
        new_nodes.append(cast_node)
        for node in model.graph.node:
            if '/output_conv/' in node.name:
                for i in range(len(node.input)):
                    if node.input[i] == inp_name:
                        node.input[i] = cast_output

    model.graph.node.extend(new_nodes)
    print(f"  Added {len(new_nodes)} Cast nodes for output layer FP32")


def quantize_sifigan_fp16(input_path, output_path, skip_validation=False, seq_len=DEFAULT_SEQ_LEN):
    print("=" * 60)
    print("SiFiGAN Vocoder FP16 Quantization")
    print("=" * 60)
    print(f"  Input:  {input_path}")
    print(f"  Output: {output_path}")
    print(f"  Keep FP32 blocks: {KEEP_FP32_BLOCKS}")
    print(f"  Keep output FP32: {KEEP_OUTPUT_FP32}")

    if not os.path.exists(input_path):
        fallback = os.path.join(os.path.dirname(input_path), 'sifigan_vocoder.onnx')
        if os.path.exists(fallback):
            print(f"  [WARN] Input not found, using fallback: {fallback}")
            input_path = fallback
        else:
            print(f"\n[ERROR] Input model not found: {input_path}")
            sys.exit(1)

    print(f"\n  Input model I/O types:")
    inspect_model_io(input_path)

    print(f"\n  Loading full model (with external data)...")
    model = onnx.load(input_path, load_external_data=True)

    print(f"\n{'='*60}")
    print("Step 1: Convert initializers and constants to FP16")
    print(f"{'='*60}")

    keep_fp32_inits = get_keep_fp32_init_names(model)
    convert_initializers_to_fp16(model, keep_fp32_inits)
    convert_constant_nodes_to_fp16(model)
    convert_cast_nodes_to_fp16(model)

    print(f"\n{'='*60}")
    print("Step 2: Add I/O Cast nodes (keep I/O as FP32)")
    print(f"{'='*60}")
    add_io_cast_nodes(model)

    if KEEP_FP32_BLOCKS > 0:
        print(f"\n{'='*60}")
        print("Step 3: Mixed precision - add boundary Cast nodes")
        print(f"{'='*60}")
        add_mixed_precision_casts(model)

    if KEEP_OUTPUT_FP32:
        step_num = 4 if KEEP_FP32_BLOCKS > 0 else 3
        print(f"\n{'='*60}")
        print(f"Step {step_num}: Keep output layer in FP32")
        print(f"{'='*60}")
        keep_output_layer_fp32(model)

    print(f"\n{'='*60}")
    print("Step 4: Save FP16 model")
    print(f"{'='*60}")
    del model.graph.value_info[:]
    fp16_size = save_model_external(model, output_path)

    src_size = os.path.getsize(input_path) / 1024 / 1024
    src_data = input_path + ".data"
    if os.path.exists(src_data):
        src_size += os.path.getsize(src_data) / 1024 / 1024
    ratio = src_size / fp16_size if fp16_size > 0 else 0
    print(f"  Size: src={src_size:.1f}MB, fp16={fp16_size:.1f}MB, ratio={ratio:.2f}x")

    print(f"\n  Output model I/O types:")
    inspect_model_io(output_path)
    check_large_constants(output_path)

    del model
    clear_memory()

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
    global KEEP_FP32_BLOCKS, KEEP_OUTPUT_FP32
    parser = argparse.ArgumentParser(description="SiFiGAN Vocoder FP16 量化脚本")
    parser.add_argument('--in', dest='input', default=DEFAULT_INPUT)
    parser.add_argument('--out', dest='output', default=DEFAULT_OUTPUT)
    parser.add_argument('--seq-len', type=int, default=DEFAULT_SEQ_LEN)
    parser.add_argument('--skip-validation', action='store_true')
    parser.add_argument('--keep-fp32-blocks', type=int, default=0,
                        help='Number of last residual blocks to keep in FP32 (0=full FP16)')
    parser.add_argument('--keep-output-fp32', action='store_true',
                        help='Keep output layer in FP32 for better accuracy')
    args = parser.parse_args()

    KEEP_FP32_BLOCKS = args.keep_fp32_blocks
    KEEP_OUTPUT_FP32 = args.keep_output_fp32

    quantize_sifigan_fp16(
        input_path=args.input,
        output_path=args.output,
        skip_validation=args.skip_validation,
        seq_len=args.seq_len,
    )


if __name__ == '__main__':
    main()
