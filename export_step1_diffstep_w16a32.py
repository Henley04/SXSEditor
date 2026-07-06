# -*- coding: utf-8 -*-
"""Step 1: Export diff_step sub-model to W16A32 ONNX via torch.export (dynamo).

W16A32 = 权重 FP16 存储, 激活 FP32 计算

实现方式:
- 将 nn.Linear 的 weight 转为 FP16 (bias 保持 FP32 累积精度)
- 不使用 autocast (CPU autocast + dynamo 有类型提升 bug)
- PyTorch 在 forward 时自动将 FP16 weight 提升为 FP32 参与 MatMul 计算
- 导出的 ONNX 图: FP16 weight initializer + Cast(FP16→FP32) + FP32 MatMul
- 每个 Linear 一个 Cast 节点, 总数可控, 不会有 op_block_list 的 336 Cast 风暴

接口匹配生产环境:
- cond 输入是 1024 维 (cond_emb 已外部应用)
- 不包含 cond_emb 层
"""
import argparse, os, time, torch
import torch.nn as nn
from export_shared import load_config, load_model, clear_memory


class DiffStepOnlyWrapper(nn.Module):
    """只包装 diff_estimator，不包含 cond_emb。
    cond 输入是 1024 维 (cond_emb 已外部应用)，匹配生产环境接口。
    """
    def __init__(self, cfm_decoder):
        super().__init__()
        self.diff_estimator = cfm_decoder.model.diff_estimator

    def forward(self, xt_input, t, cond, xt_mask):
        return self.diff_estimator(xt_input, t, cond, xt_mask)


def convert_linear_weights_to_fp16(module):
    """递归将 nn.Linear 的 weight 转为 FP16, bias 保持 FP32。
    返回转换的层数。
    """
    count = 0
    for child in module.children():
        if isinstance(child, nn.Linear):
            if child.weight is not None:
                child.weight.data = child.weight.data.half()
                # bias 保持 FP32 以保证累积精度
                if child.bias is not None:
                    child.bias.data = child.bias.data.float()
            count += 1
        count += convert_linear_weights_to_fp16(child)
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

    print("Step 1: Export diff_step W16A32 ONNX (weight FP16, activation FP32)")
    t0 = time.time()

    model = load_model(config, model_path)
    wrapper = DiffStepOnlyWrapper(model.cfm_decoder).eval()
    total_params = sum(p.numel() for p in wrapper.parameters())
    print(f"  diff_step: {total_params / 1e6:.1f}M params")

    # 将 Linear 权重转为 FP16 (W16), 激活保持 FP32 (A32)
    converted = convert_linear_weights_to_fp16(wrapper)
    print(f"  Converted {converted} Linear layers to FP16 weights")

    output_path = os.path.join(args.output_dir, 'diff_step_dml.onnx')
    seq_len = 2048

    # FP32 输入 (PyTorch 会在计算时自动提升 FP16 weight 到 FP32)
    dummy_xt = torch.randn(1, seq_len, 128)
    dummy_t = torch.tensor([0.5])
    dummy_cond = torch.randn(1, seq_len, 1024)
    dummy_mask = torch.ones(1, seq_len)

    print("  Exporting via torch.onnx.export (dynamo=False, legacy TorchScript)...")
    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            (dummy_xt, dummy_t, dummy_cond, dummy_mask),
            output_path,
            input_names=['xt_input', 't', 'cond', 'xt_mask'],
            output_names=['flow_pred'],
            opset_version=18,
            dynamo=False,
            dynamic_axes={
                'xt_input': {1: 'seq_len'},
                'cond': {1: 'seq_len'},
                'xt_mask': {1: 'seq_len'},
                'flow_pred': {1: 'seq_len'},
            },
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
    # 1=FP32, 10=FP16
    fp32_count = dtypes.get(1, 0)
    fp16_count = dtypes.get(10, 0)

    # 统计 FP16 vs FP32 initializer
    init_dtypes = Counter()
    for init in m.graph.initializer:
        init_dtypes[init.data_type] += 1

    print(f"  Nodes: {total_nodes}, Cast: {cast_count}")
    print(f"  Value info: FP16={fp16_count}, FP32={fp32_count}")
    print(f"  Initializers: FP16={init_dtypes.get(10, 0)}, FP32={init_dtypes.get(1, 0)}")
    print(f"  Inputs: {[(i.name, [d.dim_value for d in i.type.tensor_type.shape.dim]) for i in m.graph.input]}")
    print(f"  Outputs: {[(o.name, [d.dim_value for d in o.type.tensor_type.shape.dim]) for o in m.graph.output]}")


if __name__ == '__main__':
    main()
