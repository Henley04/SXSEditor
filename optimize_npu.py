# -*- coding: utf-8 -*-
"""
将 FP32 ONNX 模型转换为 FP16，用于 WebNN NPU 推理。

WebNN NPU 不支持 INT8 量化算子（DequantizeLinear, MatMulInteger, Cast(INT8)）。
FP16 转换保留标准算子（MatMul, Conv, Gemm），全部与 NPU 兼容。
"""

import os
import sys
import shutil
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto
from onnxruntime.transformers.float16 import convert_float_to_float16

BASE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'onnx_models')
OUTPUT_DIR = os.path.join(BASE_DIR, 'fp16', 'optimized_npu')

MODELS = [
    'note_text_encoder.onnx',
    'note_pitch_encoder.onnx',
    'note_type_encoder.onnx',
    'f0_encoder.onnx',
    'preflow.onnx',
    'cond_emb.onnx',
    'diff_step_dml.onnx',
    'vocoder_dml.onnx',
    'mel_transform.onnx',
]

# WebNN NPU 不支持的算子
UNSUPPORTED_OPS = {
    'DynamicQuantizeLinear', 'MatMulInteger', 'ConvInteger',
    'DequantizeLinear', 'QuantizeLinear', 'QLinearMatMul', 'QLinearConv',
}


def check_npu_compatibility(model):
    unsupported = {}
    for node in model.graph.node:
        if node.op_type in UNSUPPORTED_OPS:
            unsupported[node.op_type] = unsupported.get(node.op_type, 0) + 1
    return unsupported


def list_ops(model):
    ops = {}
    for node in model.graph.node:
        ops[node.op_type] = ops.get(node.op_type, 0) + 1
    return ops


def find_initializer(graph, name):
    for init in graph.initializer:
        if init.name == name:
            return init
    return None


def fix_vocoder_conv_transpose(model):
    """将 vocoder 的 ConvTranspose(stride=480) 分解为 NPU 兼容的操作序列。"""
    ct_idx = None
    ct_node = None
    for i, node in enumerate(model.graph.node):
        if node.op_type == 'ConvTranspose':
            ct_idx = i
            ct_node = node
            break
    if ct_node is None:
        return model

    stride = 1
    for attr in ct_node.attribute:
        if attr.name == 'strides':
            stride = attr.ints[0]

    w_name = ct_node.input[1]
    w_init = find_initializer(model.graph, w_name)
    w = numpy_helper.to_array(w_init)
    c_in, c_out, K = w.shape
    has_bias = len(ct_node.input) >= 3
    bias_name = ct_node.input[2] if has_bias else None

    print(f"  ConvTranspose: [{c_in},{c_out},{K}], stride={stride}")

    p_left = K - 1
    need_slice = K < stride
    p_right = max(K - stride, 0)

    inp = ct_node.input[0]
    out = ct_node.output[0]
    base = ct_node.name or "ct"
    graph = model.graph

    w_flip = w.transpose(1, 0, 2)[:, :, ::-1].copy().astype(np.float32)
    graph.initializer.append(numpy_helper.from_array(w_flip, name=f"{w_name}_ft"))

    c = lambda n, v: numpy_helper.from_array(np.array(v, dtype=np.int64), name=f"{base}_{n}")
    graph.initializer.extend([c("c0", 0), c("c2", 2), c("s1d", [stride]), c("ci", [c_in]), c("c1", [1])])
    graph.initializer.append(numpy_helper.from_array(np.array([0,0,0,0,0,0,0,stride-1], dtype=np.int64), name=f"{base}_pad"))
    graph.initializer.append(numpy_helper.from_array(np.array(0.0, dtype=np.float32), name=f"{base}_pv"))

    ns = []
    ns.append(helper.make_node('Shape', [inp], [f"{base}_s"], name=f"{base}_s"))
    ns.append(helper.make_node('Gather', [f"{base}_s", f"{base}_c0"], [f"{base}_B0"], name=f"{base}_gB", axis=0))
    ns.append(helper.make_node('Unsqueeze', [f"{base}_B0", f"{base}_c0"], [f"{base}_B"], name=f"{base}_uB"))
    ns.append(helper.make_node('Gather', [f"{base}_s", f"{base}_c2"], [f"{base}_T0"], name=f"{base}_gT", axis=0))
    ns.append(helper.make_node('Unsqueeze', [f"{base}_T0", f"{base}_c0"], [f"{base}_T"], name=f"{base}_uT"))
    ns.append(helper.make_node('Mul', [f"{base}_T", f"{base}_s1d"], [f"{base}_TS"], name=f"{base}_mTS"))
    ns.append(helper.make_node('Concat', [f"{base}_B", f"{base}_ci", f"{base}_T", f"{base}_c1"], [f"{base}_s4d"], name=f"{base}_c4d", axis=0))
    ns.append(helper.make_node('Reshape', [inp, f"{base}_s4d"], [f"{base}_r4d"], name=f"{base}_r4d"))
    ns.append(helper.make_node('Pad', [f"{base}_r4d", f"{base}_pad", f"{base}_pv"], [f"{base}_pd"], name=f"{base}_pd", mode='constant'))
    ns.append(helper.make_node('Concat', [f"{base}_B", f"{base}_ci", f"{base}_TS"], [f"{base}_fs"], name=f"{base}_cfs", axis=0))
    ns.append(helper.make_node('Reshape', [f"{base}_pd", f"{base}_fs"], [f"{base}_fl"], name=f"{base}_rfl"))

    ci = [f"{base}_fl", f"{w_name}_ft"]
    if has_bias:
        ci.append(bias_name)

    if need_slice:
        ns.append(helper.make_node('Conv', ci, [f"{base}_cv"], name=f"{base}_cv", kernel_shape=[K], strides=[1], pads=[p_left, 0]))
        graph.initializer.append(c("smk", stride - K))
        ns.append(helper.make_node('Sub', [f"{base}_TS", f"{base}_smk"], [f"{base}_ol"], name=f"{base}_sol"))
        graph.initializer.extend([c("ss", [0,0,0]), c("mx", [np.iinfo(np.int64).max]), c("sa", [0,1,2])])
        ns.append(helper.make_node('Concat', [f"{base}_mx", f"{base}_mx", f"{base}_ol"], [f"{base}_se"], name=f"{base}_cse", axis=0))
        ns.append(helper.make_node('Slice', [f"{base}_cv", f"{base}_ss", f"{base}_se", f"{base}_sa"], [out], name=f"{base}_sl"))
    else:
        ns.append(helper.make_node('Conv', ci, [out], name=f"{base}_cv", kernel_shape=[K], strides=[1], pads=[p_left, p_right]))

    del graph.node[ct_idx]
    for i, n in enumerate(ns):
        graph.node.insert(ct_idx + i, n)
    print(f"  替换 ConvTranspose 为 {len(ns)} 个节点")
    return model


def convert_model(model_path, output_path, is_vocoder=False):
    print(f"\n{'='*60}")
    print(f"转换: {os.path.basename(model_path)}")
    print(f"{'='*60}")

    model = onnx.load(model_path)

    if is_vocoder:
        model = fix_vocoder_conv_transpose(model)

    print(f"  转换为 FP16...")
    model_fp16 = convert_float_to_float16(model, keep_io_types=True, disable_shape_infer=False)

    unsupported = check_npu_compatibility(model_fp16)
    if unsupported:
        print(f"  仍不兼容: {unsupported}")
    else:
        print(f"  全部 NPU 兼容")

    ops = list_ops(model_fp16)
    total = sum(ops.values())
    print(f"  节点: {total}")
    for op, cnt in sorted(ops.items(), key=lambda x: -x[1])[:6]:
        print(f"    {op}: {cnt}")

    onnx.save(model_fp16, output_path)
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"  保存: {output_path} ({size_mb:.1f} MB)")
    return model_fp16


def main():
    print("=" * 60)
    print("NPU FP16 模型转换")
    print("=" * 60)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    results = []
    for model_file in MODELS:
        model_path = os.path.join(BASE_DIR, model_file)
        if not os.path.exists(model_path):
            print(f"\n  不存在: {model_file}")
            continue

        output_path = os.path.join(OUTPUT_DIR, model_file)
        is_vocoder = 'vocoder' in model_file

        try:
            model = convert_model(model_path, output_path, is_vocoder=is_vocoder)
            unsupported = check_npu_compatibility(model)
            results.append({'name': model_file, 'ok': True, 'unsup': unsupported,
                           'size': os.path.getsize(output_path) / (1024*1024)})
        except Exception as e:
            print(f"\n  失败: {model_file} - {e}")
            import traceback; traceback.print_exc()
            results.append({'name': model_file, 'ok': False, 'error': str(e)})

    print(f"\n{'='*60}")
    print("结果")
    print(f"{'='*60}")
    for r in results:
        if r['ok']:
            s = f"{r['size']:.1f} MB"
            u = str(r['unsup']) if r['unsup'] else "none"
            print(f"  {r['name']:<30} OK  {s:>10}  {u}")
        else:
            print(f"  {r['name']:<30} FAIL {r.get('error','')[:40]}")

    all_ok = all(r['ok'] and not r.get('unsup') for r in results)
    print(f"\n{'All NPU compatible!' if all_ok else 'Issues found'}")


if __name__ == '__main__':
    main()
