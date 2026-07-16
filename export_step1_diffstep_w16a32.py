# -*- coding: utf-8 -*-
"""Step 1: Export diff_step sub-model to W16A32 ONNX via torch.export (dynamo) + post-process.

W16A32 = 权重 FP16 存储, 激活 FP32 计算

实现方式:
- 将 nn.Linear 的 weight 转为 FP16 (bias 保持 FP32 累积精度)
- 不使用 autocast (CPU autocast + dynamo 有类型提升 bug)
- PyTorch 在 forward 时自动将 FP16 weight 提升为 FP32 参与 MatMul 计算
- 导出的 ONNX 图: FP16 weight initializer + Cast(FP16→FP32) + FP32 MatMul
- 每个 Linear 一个 Cast 节点, 总数可控

关键: 导出后必须应用 postprocess_onnx (STFT 替换、onnxsim 等) 才能在 DML EP 上运行
(与生产 FP32 模型导出流程一致, 参见 export_step3_postprocess.py)

接口匹配生产环境:
- cond 输入是 1024 维 (cond_emb 已外部应用)
- 不包含 cond_emb 层
"""
import argparse, os, time, torch
import torch.nn as nn
from torch.export import Dim
from export_shared import load_config, load_model, postprocess_onnx, clear_memory


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

    # 先导出到临时文件, 再后处理到最终文件
    raw_path = os.path.join(args.output_dir, 'diff_step_w16a32_raw.onnx')
    output_path = os.path.join(args.output_dir, 'diff_step_dml.onnx')
    seq_len = 2048

    # FP32 输入 (PyTorch 会在计算时自动提升 FP16 weight 到 FP32)
    dummy_xt = torch.randn(1, seq_len, 128)
    dummy_t = torch.tensor([0.5])
    dummy_cond = torch.randn(1, seq_len, 1024)
    dummy_mask = torch.ones(1, seq_len)

    # 使用 Dim 对象指定动态维度
    seq_len_dim = Dim('seq_len', min=1, max=10000)

    print("  Exporting via torch.onnx.export (dynamo=True)...")
    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            (dummy_xt, dummy_t, dummy_cond, dummy_mask),
            raw_path,
            input_names=['xt_input', 't', 'cond', 'xt_mask'],
            output_names=['flow_pred'],
            opset_version=18,
            dynamo=True,
            dynamic_shapes={
                'xt_input': {1: seq_len_dim},
                't': None,
                'cond': {1: seq_len_dim},
                'xt_mask': {1: seq_len_dim},
            },
        )
    print(f"  Raw export done in {time.time() - t0:.1f}s")

    del wrapper, model
    clear_memory()

    # 后处理 (STFT 替换、onnxsim、拓扑排序等), 与生产 FP32 流程一致
    # fix_mixed_precision=True: onnxsim 后重新插入 Cast(FP16->FP32) 修复混合类型
    print("  Post-processing (STFT replacement, onnxsim, etc.)...")
    postprocess_onnx(raw_path, output_path, fix_mixed_precision=True)

    # 清理临时文件
    if os.path.exists(raw_path):
        os.remove(raw_path)
    raw_data = raw_path + '.data'
    if os.path.exists(raw_data):
        os.remove(raw_data)

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    data_path = output_path + '.data'
    data_mb = os.path.getsize(data_path) / (1024 * 1024) if os.path.exists(data_path) else 0
    print(f"  Done in {time.time() - t0:.1f}s -> {output_path} ({size_mb:.1f}MB + {data_mb:.1f}MB data)")

    # 检查导出结果
    import onnx
    from collections import Counter
    m = onnx.load(output_path, load_external_data=False)
    cast_count = sum(1 for n in m.graph.node if n.op_type == 'Cast')
    total_nodes = sum(1 for n in m.graph.node)

    init_dtypes = Counter()
    for init in m.graph.initializer:
        init_dtypes[init.data_type] += 1

    print(f"  Nodes: {total_nodes}, Cast: {cast_count}")
    print(f"  Initializers: FP16={init_dtypes.get(10, 0)}, FP32={init_dtypes.get(1, 0)}")
    print(f"  Inputs: {[(i.name, [d.dim_value for d in i.type.tensor_type.shape.dim], i.type.tensor_type.elem_type) for i in m.graph.input]}")
    print(f"  Outputs: {[(o.name, [d.dim_value for d in o.type.tensor_type.shape.dim], o.type.tensor_type.elem_type) for o in m.graph.output]}")


if __name__ == '__main__':
    main()
