# -*- coding: utf-8 -*-
"""Step 2: Create W16A32 vocoder ONNX from FP32 production model.

W16A32 = 权重 FP16 存储, 激活 FP32 计算

实现方式:
  - 直接基于 FP32 生产模型 vocoder_dml.onnx (已含 DML 兼容的 Conv-based ISTFT)
  - 将 Linear/Conv 的 weight initializer 从 FP32 量化为 FP16
  - 在每个使用 FP16 weight 的节点前插入 Cast(FP16->FP32)
  - bias / LayerNorm / istft 参数保持 FP32

这样 W16A32 模型结构与 FP32 生产模型完全一致 (DML 兼容),
仅权重精度降低, 避免 dynamo 导出 torch.fft.irfft 产生的 DFT 节点问题。
"""
import argparse, os, time, shutil
import onnx
from collections import Counter
from export_shared import quantize_weights_to_fp16, clear_memory


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-path', default=None,
                        help='FP32 production vocoder path (default: onnx_models/vocoder_dml.onnx)')
    parser.add_argument('--output-dir', default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'onnx_models', 'fp16'))
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    src_path = args.model_path or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'onnx_models', 'vocoder_dml.onnx')
    output_path = os.path.join(args.output_dir, 'vocoder_dml.onnx')

    if not os.path.exists(src_path):
        raise FileNotFoundError(f"FP32 production vocoder not found: {src_path}")

    print("Step 2: Create W16A32 vocoder from FP32 production model")
    print(f"  Source: {src_path}")
    print(f"  Output: {output_path}")
    t0 = time.time()

    # 加载 FP32 生产模型 (含 external_data)
    print("  Loading FP32 production model (with external data)...")
    model = onnx.load(src_path, load_external_data=True)

    # 量化权重为 FP16
    print("  Quantizing weights to FP16 (W16A32)...")
    model = quantize_weights_to_fp16(model)

    # 保存 (external_data 格式, 与 FP32 生产模型一致)
    print("  Saving W16A32 model...")
    # 清理旧的 external_data 文件
    old_data = output_path + '.data'
    if os.path.exists(old_data):
        os.remove(old_data)

    onnx.save_model(
        model, output_path,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=os.path.basename(output_path) + '.data',
        size_threshold=1024,
    )

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    data_mb = os.path.getsize(output_path + '.data') / 1024 / 1024 if os.path.exists(output_path + '.data') else 0
    print(f"  Done in {time.time() - t0:.1f}s -> {output_path} ({size_mb:.1f}MB + {data_mb:.1f}MB data)")

    # 检查导出结果
    m = onnx.load(output_path, load_external_data=False)
    cast_count = sum(1 for n in m.graph.node if n.op_type == 'Cast')
    total_nodes = sum(1 for n in m.graph.node)
    init_dtypes = Counter()
    for init in m.graph.initializer:
        init_dtypes[init.data_type] += 1
    # 1=FP32, 10=FP16, 7=INT64
    print(f"  Nodes: {total_nodes}, Cast: {cast_count}")
    print(f"  Initializers: FP16={init_dtypes.get(10, 0)}, FP32={init_dtypes.get(1, 0)}, INT64={init_dtypes.get(7, 0)}")
    print(f"  Inputs: {[(i.name, [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim], i.type.tensor_type.elem_type) for i in m.graph.input]}")
    print(f"  Outputs: {[(o.name, [d.dim_value or d.dim_param for d in o.type.tensor_type.shape.dim], o.type.tensor_type.elem_type) for o in m.graph.output]}")

    # 检查是否有 DFT/STFT 节点
    dft_count = sum(1 for n in m.graph.node if n.op_type in ('DFT', 'STFT'))
    print(f"  DFT/STFT nodes: {dft_count} (should be 0)")

    del model
    clear_memory()


if __name__ == '__main__':
    main()
