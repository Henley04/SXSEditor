# -*- coding: utf-8 -*-
"""验证 diffStep ONNX 与 PyTorch 的精度差异。

加载 SoulX-Singer PyTorch 模型和 SXSEditor ONNX diffStep，
用同一份输入对比单步输出 flow_pred 的 L1 error 和 cosine similarity。

如果 diffStep ONNX 精度正常（L1 < 0.01, cosine > 0.99），
则咬字不清根因不在 ONNX 导出，而在 diffusion loop 实现差异
（SXSEditor uncond 输入长度与官方不同）。

如果 diffStep ONNX 精度异常，则需重新导出 ONNX。

用法：
    python scripts/verify_diffstep_precision.py
    python scripts/verify_diffstep_precision.py --seq-len 1000
    python scripts/verify_diffstep_precision.py --onnx-path onnx_models/fp16/diff_step_dml.onnx
"""
import os
import sys
import time
import argparse
import numpy as np
import torch

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, PROJECT_DIR)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seq-len', type=int, default=500, help='测试序列长度')
    parser.add_argument('--onnx-path', default=None,
                        help='ONNX diffStep 路径（默认 onnx_models/diff_step_dml.onnx FP32）')
    parser.add_argument('--model-path', default=None,
                        help='SoulX-Singer model.pt 路径')
    parser.add_argument('--save', action='store_true', help='保存结果到 npz')
    args = parser.parse_args()

    print("=" * 60)
    print("diffStep ONNX vs PyTorch 精度验证")
    print("=" * 60)

    # 1. 加载 PyTorch 模型
    print("\n[1] Loading SoulX-Singer PyTorch model...")
    t0 = time.time()
    from export_shared import load_config, load_model, clear_memory

    config = load_config()
    model_path = args.model_path or os.path.join(
        PROJECT_DIR, 'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt')
    print(f"    Model path: {model_path}")
    if not os.path.exists(model_path):
        print(f"    [ERROR] Model not found: {model_path}")
        sys.exit(1)

    model = load_model(config, model_path)
    model.eval()
    print(f"    Loaded in {time.time()-t0:.1f}s")

    # 提取 diff_estimator（输入 cond 已过 cond_emb，1024 维）
    diff_estimator = model.cfm_decoder.model.diff_estimator

    # 2. 加载 ONNX diffStep
    print("\n[2] Loading ONNX diffStep...")
    import onnxruntime as ort

    onnx_path = args.onnx_path or os.path.join(PROJECT_DIR, 'onnx_models', 'diff_step_dml.onnx')
    print(f"    ONNX path: {onnx_path}")
    if not os.path.exists(onnx_path):
        print(f"    [ERROR] ONNX not found: {onnx_path}")
        sys.exit(1)

    providers = ['CPUExecutionProvider']
    sess = ort.InferenceSession(onnx_path, providers=providers)
    input_names = [i.name for i in sess.get_inputs()]
    output_names = [o.name for o in sess.get_outputs()]
    print(f"    Inputs: {input_names}")
    print(f"    Outputs: {output_names}")

    # 3. 生成随机输入
    print(f"\n[3] Generating random inputs (seq_len={args.seq_len})...")
    seq_len = args.seq_len
    B = 1
    torch.manual_seed(42)
    np.random.seed(42)

    xt_input = torch.randn(B, seq_len, 128)
    t = torch.tensor([0.5])
    cond = torch.randn(B, seq_len, 1024)  # 已过 cond_emb 的维度
    xt_mask = torch.ones(B, seq_len)

    print(f"    xt_input: {tuple(xt_input.shape)}, mean={xt_input.mean():.4f}, std={xt_input.std():.4f}")
    print(f"    t: {t.item()}")
    print(f"    cond: {tuple(cond.shape)}, mean={cond.mean():.4f}, std={cond.std():.4f}")
    print(f"    xt_mask: {tuple(xt_mask.shape)}")

    # 4. PyTorch 推理
    print("\n[4] PyTorch inference...")
    t0 = time.time()
    with torch.no_grad():
        flow_pred_pt = diff_estimator(xt_input, t, cond, xt_mask)
    print(f"    Done in {time.time()-t0:.2f}s")
    print(f"    flow_pred_pt: {tuple(flow_pred_pt.shape)}")
    print(f"    mean={flow_pred_pt.mean():.6f}, std={flow_pred_pt.std():.6f}")
    print(f"    min={flow_pred_pt.min():.6f}, max={flow_pred_pt.max():.6f}")

    # 5. ONNX 推理
    # 检测 ONNX 输入类型，自动转换为 float16（FP16 模型）或保持 float32
    print("\n[5] ONNX inference...")
    input_dtypes = {i.name: i.type for i in sess.get_inputs()}
    is_fp16_onnx = any('float16' in dt for dt in input_dtypes.values())
    print(f"    ONNX input dtypes: {input_dtypes}")
    print(f"    is_fp16_onnx: {is_fp16_onnx}")

    np_dtype = np.float16 if is_fp16_onnx else np.float32
    xt_input_np = xt_input.numpy().astype(np_dtype)
    t_np = t.numpy().astype(np_dtype)
    cond_np = cond.numpy().astype(np_dtype)
    xt_mask_np = xt_mask.numpy().astype(np_dtype)

    feeds = {
        'xt_input': xt_input_np,
        't': t_np,
        'cond': cond_np,
        'xt_mask': xt_mask_np,
    }
    t0 = time.time()
    flow_pred_onnx = sess.run(output_names, feeds)[0]
    # 统一回 float32 做对比
    flow_pred_onnx = flow_pred_onnx.astype(np.float32)
    print(f"    Done in {time.time()-t0:.2f}s")
    print(f"    flow_pred_onnx: {flow_pred_onnx.shape}")
    print(f"    mean={flow_pred_onnx.mean():.6f}, std={flow_pred_onnx.std():.6f}")
    print(f"    min={flow_pred_onnx.min():.6f}, max={flow_pred_onnx.max():.6f}")

    # 6. 对比
    print("\n[6] Comparison (PyTorch vs ONNX):")
    pt_np = flow_pred_pt.numpy()
    diff = pt_np - flow_pred_onnx
    l1_mean = float(np.mean(np.abs(diff)))
    l1_max = float(np.max(np.abs(diff)))
    l1_p99 = float(np.percentile(np.abs(diff), 99))
    mse = float(np.mean(diff ** 2))
    cosine = float(np.sum(pt_np * flow_pred_onnx) /
                    (np.linalg.norm(pt_np) * np.linalg.norm(flow_pred_onnx) + 1e-8))

    print(f"    L1 mean error: {l1_mean:.6f}")
    print(f"    L1 max error:  {l1_max:.6f}")
    print(f"    L1 p99 error:  {l1_p99:.6f}")
    print(f"    MSE:           {mse:.8f}")
    print(f"    Cosine sim:    {cosine:.6f}")

    # 判定
    print("\n[7] Verdict:")
    if l1_mean < 0.01 and cosine > 0.99:
        print("    [PASS] diffStep ONNX 精度正常 (L1<0.01, cosine>0.99)")
        print("    咬字不清根因不在 ONNX 导出，可能在：")
        print("      - diffusion loop 实现差异（SXSEditor uncond 输入长度与官方不同）")
        print("      - diffusion 输出 mel 分布漂移")
        print("      - encoder/cond_emb 精度问题")
    elif l1_mean < 0.05 and cosine > 0.95:
        print("    [WARN] diffStep ONNX 精度边缘 (L1<0.05, cosine>0.95)")
        print("    可能存在累积误差，建议检查 FP16 量化或 dynamo 导出")
    else:
        print("    [FAIL] diffStep ONNX 精度异常 (L1>=0.05 或 cosine<=0.95)")
        print("    需重新导出 ONNX，检查 dynamo 追踪或算子替换")

    # 8. 多个 timestep 测试
    print("\n[8] Testing multiple timesteps...")
    t_values = [0.1, 0.3, 0.5, 0.7, 0.9]
    for t_val in t_values:
        t_tensor = torch.tensor([t_val])
        with torch.no_grad():
            flow_pt = diff_estimator(xt_input, t_tensor, cond, xt_mask)
        feeds['t'] = np.array([t_val], dtype=np_dtype)
        flow_onnx = sess.run(output_names, feeds)[0].astype(np.float32)
        pt_arr = flow_pt.numpy()
        l1 = float(np.mean(np.abs(pt_arr - flow_onnx)))
        cos = float(np.sum(pt_arr * flow_onnx) /
                     (np.linalg.norm(pt_arr) * np.linalg.norm(flow_onnx) + 1e-8))
        print(f"    t={t_val}: L1 mean={l1:.6f}, cosine={cos:.6f}")

    # 9. 保存结果
    if args.save:
        output_path = os.path.join(SCRIPT_DIR, 'diffstep_precision_result.npz')
        np.savez(output_path,
                 pt=pt_np,
                 onnx=flow_pred_onnx,
                 diff=diff,
                 xt_input=xt_input_np,
                 cond=cond_np)
        print(f"\n[9] Saved results to {output_path}")

    # 清理
    del model, sess
    clear_memory()
    print("\nDone.")


if __name__ == "__main__":
    main()
