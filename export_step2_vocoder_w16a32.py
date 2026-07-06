# -*- coding: utf-8 -*-
"""Step 2: Export vocoder sub-model to W16A32 ONNX via torch.export (dynamo).

W16A32 = 权重 FP16 存储, 激活 FP32 计算

实现方式:
- 将 nn.Linear 的 weight 转为 FP16 (bias 保持 FP32 累积精度)
- 不使用 autocast (CPU autocast + dynamo 有类型提升 bug)
- PyTorch 在 forward 时自动将 FP16 weight 提升为 FP32 参与 MatMul 计算
- 导出的 ONNX 图: FP16 weight initializer + Cast(FP16→FP32) + FP32 MatMul
- 每个 Linear 一个 Cast 节点, 总数可控

对 Vocos 的 ISTFT 重建头 (Exp/Cos/Sin) 关键:
- 这些算子全部在 FP32 计算 (因为权重虽然 FP16, 但计算时被 Cast 到 FP32)
- 不会有 W16A16 下 Exp(FP16) 的数值溢出问题
"""
import argparse, os, time, torch
import torch.nn as nn
from export_shared import load_config, load_model, clear_memory


class VocoderWrapper(nn.Module):
    """Vocoder 包装器，匹配生产环境接口。
    输入: mel (B, T, 128)
    输出: waveform (B, T_audio)
    """
    def __init__(self, vocoder):
        super().__init__()
        self.backbone = vocoder.model.backbone
        self.head_out = vocoder.model.head.out

    def forward(self, mel):
        return self.head_out(self.backbone(mel.transpose(1, 2)))


def convert_linear_weights_to_fp16(module):
    """递归将 nn.Linear 的 weight 转为 FP16, bias 保持 FP32。
    返回转换的层数。
    """
    count = 0
    for child in module.children():
        if isinstance(child, nn.Linear):
            if child.weight is not None:
                child.weight.data = child.weight.data.half()
                if child.bias is not None:
                    child.bias.data = child.bias.data.float()
            count += 1
        count += convert_linear_weights_to_fp16(child)
    return count


def convert_conv_weights_to_fp16(module):
    """递归将 nn.Conv1d/Conv2d 的 weight 转为 FP16, bias 保持 FP32。
    返回转换的层数。
    """
    count = 0
    for child in module.children():
        if isinstance(child, (nn.Conv1d, nn.Conv2d, nn.ConvTranspose1d, nn.ConvTranspose2d)):
            if child.weight is not None:
                child.weight.data = child.weight.data.half()
                if child.bias is not None:
                    child.bias.data = child.bias.data.float()
            count += 1
        count += convert_conv_weights_to_fp16(child)
    return count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-path', default=None)
    parser.add_argument('--output-dir', default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'onnx_models', 'fp16'))
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    config = load_config()
    model_path = args.model_path or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt')

    print("Step 2: Export vocoder W16A32 ONNX (weight FP16, activation FP32)")
    t0 = time.time()

    model = load_model(config, model_path)
    wrapper = VocoderWrapper(model.vocoder).eval()
    total_params = sum(p.numel() for p in wrapper.parameters())
    print(f"  vocoder: {total_params / 1e6:.1f}M params")

    # 将 Linear 和 Conv 权重转为 FP16 (W16), 激活保持 FP32 (A32)
    converted_linear = convert_linear_weights_to_fp16(wrapper)
    converted_conv = convert_conv_weights_to_fp16(wrapper)
    print(f"  Converted {converted_linear} Linear + {converted_conv} Conv layers to FP16 weights")

    output_path = os.path.join(args.output_dir, 'vocoder_dml.onnx')
    voc_seq_len = 500

    dummy_mel = torch.randn(1, voc_seq_len, 128)

    print("  Exporting via torch.onnx.export (dynamo=True)...")
    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            (dummy_mel,),
            output_path,
            input_names=['mel'],
            output_names=['waveform'],
            opset_version=18,
            dynamo=True,
            dynamic_shapes={'mel': {1: 'seq_len'}},
        )

    del wrapper, model
    clear_memory()

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"  Done in {time.time() - t0:.1f}s -> {output_path} ({size_mb:.1f} MB)")

    # 检查导出结果
    import onnx
    from collections import Counter
    m = onnx.load(output_path, load_external_data=False)
    dtypes = Counter()
    for vi in m.graph.value_info:
        t = vi.type.tensor_type.elem_type
        dtypes[t] += 1
    cast_count = sum(1 for n in m.graph.node if n.op_type == 'Cast')
    total_nodes = sum(1 for n in m.graph.node)
    fp32_count = dtypes.get(1, 0)
    fp16_count = dtypes.get(10, 0)

    init_dtypes = Counter()
    for init in m.graph.initializer:
        init_dtypes[init.data_type] += 1

    print(f"  Nodes: {total_nodes}, Cast: {cast_count}")
    print(f"  Value info: FP16={fp16_count}, FP32={fp32_count}")
    print(f"  Initializers: FP16={init_dtypes.get(10, 0)}, FP32={init_dtypes.get(1, 0)}")
    print(f"  Inputs: {[(i.name, [d.dim_value for d in i.type.tensor_type.shape.dim], i.type.tensor_type.elem_type) for i in m.graph.input]}")
    print(f"  Outputs: {[(o.name, [d.dim_value for d in o.type.tensor_type.shape.dim], o.type.tensor_type.elem_type) for o in m.graph.output]}")


if __name__ == '__main__':
    main()
