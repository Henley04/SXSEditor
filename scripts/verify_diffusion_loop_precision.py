# -*- coding: utf-8 -*-
"""验证完整 diffusion loop 在 FP16 vs FP32 下的累积精度差异。

单步 diffStep FP16 精度完美（cosine=0.999999），但 32 步累积可能放大误差。
本脚本：
  1. 用 PyTorch 完整 reverse_diffusion 跑 32 步，得到参考 mel
  2. 用 FP32 ONNX diffStep 模拟 SXSEditor diffusion loop 跑 32 步
  3. 用 FP16 ONNX diffStep 模拟 SXSEditor diffusion loop 跑 32 步
  4. 对比三者最终 mel 的差异

重点验证：
  - FP16 在 32 步累积后是否产生显著 mel 漂移
  - SXSEditor uncond 输入长度差异（含 prompt 段）vs 官方（仅 target）对结果的影响
  - CFG rescale 计算在 FP16 下的数值稳定性

用法：
    python scripts/verify_diffusion_loop_precision.py
    python scripts/verify_diffusion_loop_precision.py --target-len 100 --prompt-len 20
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


def run_onnx_diffstep(sess, feeds, is_fp16):
    """运行 ONNX diffStep，返回 float32 flow_pred。"""
    if is_fp16:
        feeds = {k: v.astype(np.float16) for k, v in feeds.items()}
    else:
        feeds = {k: v.astype(np.float32) for k, v in feeds.items()}
    out = sess.run(['flow_pred'], feeds)[0]
    return out.astype(np.float32)


def sxseditor_diffusion_loop(sess, is_fp16, prompt_mel, target_len, cond_emb,
                              n_steps=32, cfg_strength=3.0, cfg_rescale=0.75):
    """模拟 SXSEditor diffusion loop（含 prompt 段零填充的 uncond）。

    与官方 reverse_diffusion 的差异：
    - uncond 输入 seq_len = totalFramesWithPrompt（含 prompt 段零填充）
    - 官方 uncond 输入 seq_len = target_len（仅 target 段）

    返回最终 target mel (target_len, 128) float32 numpy。
    """
    import onnxruntime as ort

    mel_dim = 128
    prompt_len = prompt_mel.shape[1]
    total_len = prompt_len + target_len

    # 初始噪声
    torch.manual_seed(42)
    np.random.seed(42)
    z = np.random.randn(1, target_len, mel_dim).astype(np.float32)
    xt = z.copy()  # (1, target_len, mel_dim)

    # cond 已是 1024 维（过 cond_emb），形状 (1, total_len, 1024)
    # uncond cond: 全零
    uncond_cond = np.zeros((1, total_len, 1024), dtype=np.float32)
    # cond mask: 全 1
    cond_mask = np.ones((1, total_len), dtype=np.float32)
    # uncond mask: prompt 段 0, target 段 1
    uncond_mask = np.zeros((1, total_len), dtype=np.float32)
    uncond_mask[0, prompt_len:] = 1.0

    # xt_input: prompt 段填 prompt_mel, target 段填 xt
    xt_input = np.zeros((1, total_len, mel_dim), dtype=np.float32)
    xt_input[0, :prompt_len] = prompt_mel[0]
    # uncond xt_input: prompt 段零, target 段填 xt
    xt_uncond = np.zeros((1, total_len, mel_dim), dtype=np.float32)

    dt = 1.0 / n_steps

    for step in range(n_steps):
        t_val = (step + 0.5) / n_steps
        t_arr = np.array([t_val], dtype=np.float32)

        # 更新 xt_input 的 target 段
        xt_input[0, prompt_len:] = xt[0]

        # cond 推理
        feeds_cond = {
            'xt_input': xt_input,
            't': t_arr,
            'cond': cond_emb,
            'xt_mask': cond_mask,
        }
        flow_cond = run_onnx_diffstep(sess, feeds_cond, is_fp16)

        # uncond 推理
        xt_uncond[0, prompt_len:] = xt[0]
        feeds_uncond = {
            'xt_input': xt_uncond,
            't': t_arr,
            'cond': uncond_cond,
            'xt_mask': uncond_mask,
        }
        flow_uncond = run_onnx_diffstep(sess, feeds_uncond, is_fp16)

        # 提取 target 段
        flow_cond_target = flow_cond[0, prompt_len:]  # (target_len, mel_dim)
        flow_uncond_target = flow_uncond[0, prompt_len:]

        if cfg_strength > 0:
            # CFG: cond + cfg * (cond - uncond)
            flow_cfg = flow_cond_target + cfg_strength * (flow_cond_target - flow_uncond_target)
            # rescale: pos_std / cfg_std
            pos_std = float(np.std(flow_cond_target) + 1e-8)
            cfg_std = float(np.std(flow_cfg) + 1e-8)
            rescale = pos_std / cfg_std
            flow_final = cfg_rescale * (flow_cfg * rescale) + (1 - cfg_rescale) * flow_cfg
        else:
            flow_final = flow_cond_target

        # Euler step: xt = xt + flow * dt
        xt = xt + flow_final * dt

        if (step + 1) % 8 == 0:
            print(f"    step {step+1}/{n_steps}: xt mean={xt.mean():.4f}, std={xt.std():.4f}")

    return xt[0]  # (target_len, mel_dim)


def official_reverse_diffusion(diff_estimator, prompt_mel, target_len, cond_emb,
                                n_steps=32, cfg=3.0, rescale_cfg=0.75):
    """官方 reverse_diffusion（uncond 仅用 target 段）。

    返回最终 target mel (target_len, 128) float32 numpy。
    """
    mel_dim = 128
    prompt_len = prompt_mel.shape[1]

    torch.manual_seed(42)
    z = torch.randn(1, target_len, mel_dim)
    xt = z

    # cond_emb: (1, total_len, 1024) → 官方需要 (1, target_len, 1024) 用于 uncond
    # 官方：torch.zeros_like(cond)[:, :xt.shape[1], :] → 取 cond 前 target_len 帧但全零
    cond_full = torch.from_numpy(cond_emb)  # (1, total_len, 1024)
    x_mask = torch.ones(1, target_len)

    h = 1.0 / n_steps
    with torch.no_grad():
        for i in range(n_steps):
            xt_input = torch.cat([prompt_mel, xt], dim=1)  # (1, total_len, mel_dim)
            t = torch.tensor([i + 0.5]) * h

            # cond 推理（含 prompt）
            flow_pred = diff_estimator(xt_input, t, cond_full, torch.ones(1, prompt_len + target_len))
            flow_pred = flow_pred[:, prompt_len:, :]

            if cfg > 0:
                # uncond 推理：只用 xt（target 段），cond 取前 target_len 帧但全零
                uncond_cond = torch.zeros(1, target_len, cond_full.shape[-1])
                uncond_flow_pred = diff_estimator(xt, t, uncond_cond, x_mask)

                pos_std = flow_pred.std()
                flow_pred_cfg = flow_pred + cfg * (flow_pred - uncond_flow_pred)
                rescale_flow_pred = flow_pred_cfg * pos_std / flow_pred_cfg.std()
                flow_pred = rescale_cfg * rescale_flow_pred + (1 - rescale_cfg) * flow_pred_cfg

            dxt = flow_pred * h
            xt = xt + dxt

            if (i + 1) % 8 == 0:
                print(f"    step {i+1}/{n_steps}: xt mean={xt.mean():.4f}, std={xt.std():.4f}")

    return xt[0].numpy()


def compare_mel(name, ref, cand):
    """对比两组 mel 的统计差异。"""
    ref = np.asarray(ref, dtype=np.float32).reshape(-1)
    cand = np.asarray(cand, dtype=np.float32).reshape(-1)
    min_len = min(len(ref), len(cand))
    ref = ref[:min_len]
    cand = cand[:min_len]
    diff = ref - cand
    l1_mean = float(np.mean(np.abs(diff)))
    l1_max = float(np.max(np.abs(diff)))
    l1_p99 = float(np.percentile(np.abs(diff), 99))
    mse = float(np.mean(diff ** 2))
    ref_energy = float(np.sum(ref ** 2)) + 1e-12
    err_energy = float(np.sum(diff ** 2)) + 1e-12
    snr_db = 10 * np.log10(ref_energy / err_energy)
    cos = float(np.sum(ref * cand) / (np.linalg.norm(ref) * np.linalg.norm(cand) + 1e-8))
    print(f"  [{name}] (len={min_len})")
    print(f"    ref:  mean={ref.mean():.6f}, std={ref.std():.6f}, min={ref.min():.6f}, max={ref.max():.6f}")
    print(f"    cand: mean={cand.mean():.6f}, std={cand.std():.6f}, min={cand.min():.6f}, max={cand.max():.6f}")
    print(f"    L1 mean={l1_mean:.6f}, L1 max={l1_max:.6f}, L1 p99={l1_p99:.6f}")
    print(f"    MSE={mse:.8f}, SNR={snr_db:.2f} dB, Cosine={cos:.6f}")
    return {'name': name, 'l1_mean': l1_mean, 'l1_max': l1_max, 'snr_db': snr_db, 'cosine': cos}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--target-len', type=int, default=80,
                        help='target mel 帧数（建议 ≤100 避免 CPU 推理慢，32 步 × 2 推理/步）')
    parser.add_argument('--prompt-len', type=int, default=20,
                        help='prompt mel 帧数')
    parser.add_argument('--n-steps', type=int, default=32, help='diffusion 步数')
    parser.add_argument('--cfg', type=float, default=3.0, help='CFG strength')
    parser.add_argument('--cfg-rescale', type=float, default=0.75, help='CFG rescale')
    parser.add_argument('--fp32-onnx', default=None, help='FP32 ONNX diffStep 路径')
    parser.add_argument('--fp16-onnx', default=None, help='FP16 ONNX diffStep 路径')
    parser.add_argument('--save', action='store_true', help='保存结果到 npz')
    args = parser.parse_args()

    print("=" * 60)
    print("Diffusion loop 累积精度验证 (FP16 vs FP32 vs PyTorch)")
    print("=" * 60)
    print(f"  target_len={args.target_len}, prompt_len={args.prompt_len}, "
          f"n_steps={args.n_steps}, cfg={args.cfg}, cfg_rescale={args.cfg_rescale}")

    # 1. 加载 PyTorch 模型
    print("\n[1] Loading SoulX-Singer PyTorch model...")
    t0 = time.time()
    from export_shared import load_config, load_model, clear_memory

    config = load_config()
    model_path = os.path.join(PROJECT_DIR, 'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt')
    print(f"    Model path: {model_path}")
    if not os.path.exists(model_path):
        print(f"    [ERROR] Model not found: {model_path}")
        sys.exit(1)

    model = load_model(config, model_path)
    model.eval()
    diff_estimator = model.cfm_decoder.model.diff_estimator
    cond_emb_layer = model.cfm_decoder.model.cond_emb
    print(f"    Loaded in {time.time()-t0:.1f}s")

    # 2. 加载 ONNX diffStep
    print("\n[2] Loading ONNX diffStep...")
    import onnxruntime as ort

    fp32_path = args.fp32_onnx or os.path.join(PROJECT_DIR, 'onnx_models', 'diff_step_dml.onnx')
    fp16_path = args.fp16_onnx or os.path.join(PROJECT_DIR, 'onnx_models', 'fp16', 'diff_step_dml.onnx')
    print(f"    FP32 ONNX: {fp32_path}")
    print(f"    FP16 ONNX: {fp16_path}")

    # 使用 DML EP（生产环境后端），反映真实 FP16 精度
    # CPU EP 会自动 promote FP16 到 FP32，无法测出真实 FP16 误差
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_fp32 = ort.InferenceSession(fp32_path, sess_options=sess_options,
                                      providers=['DmlExecutionProvider', 'CPUExecutionProvider'])
    sess_fp16 = ort.InferenceSession(fp16_path, sess_options=sess_options,
                                      providers=['DmlExecutionProvider', 'CPUExecutionProvider'])
    print(f"    Providers: {sess_fp32.get_providers()}")

    # 3. 生成输入
    print(f"\n[3] Generating inputs...")
    torch.manual_seed(42)
    np.random.seed(42)

    mel_dim = 128
    cond_input_dim = 512  # cond_codebook_size（cond_emb 输入维度）
    cond_dim = 1024       # cond_emb 输出维度（hidden_size）
    prompt_len = args.prompt_len
    target_len = args.target_len
    total_len = prompt_len + target_len

    # prompt mel（模拟真实标准化 mel）
    prompt_mel = torch.randn(1, prompt_len, mel_dim) * 2.85 + (-4.92)
    print(f"    prompt_mel: {tuple(prompt_mel.shape)}, mean={prompt_mel.mean():.4f}, std={prompt_mel.std():.4f}")

    # cond_code（模拟 encoder 输出，512 维 = cond_codebook_size）
    # cond_emb 是 Linear(512, 1024)（use_embedding=False）
    cond_code = torch.randn(1, total_len, cond_input_dim)
    # 应用 cond_emb 得到 1024 维
    with torch.no_grad():
        cond_emb = cond_emb_layer(cond_code)  # (1, total_len, 1024)
    print(f"    cond_emb: {tuple(cond_emb.shape)}, mean={cond_emb.mean():.4f}, std={cond_emb.std():.4f}")
    cond_emb_np = cond_emb.numpy().astype(np.float32)

    # 4. PyTorch 官方 reverse_diffusion
    print(f"\n[4] PyTorch official reverse_diffusion ({args.n_steps} steps)...")
    t0 = time.time()
    mel_pt = official_reverse_diffusion(
        diff_estimator, prompt_mel, target_len, cond_emb_np,
        n_steps=args.n_steps, cfg=args.cfg, rescale_cfg=args.cfg_rescale
    )
    print(f"    Done in {time.time()-t0:.1f}s")
    print(f"    mel_pt: {mel_pt.shape}, mean={mel_pt.mean():.4f}, std={mel_pt.std():.4f}")

    # 5. SXSEditor-style diffusion loop - FP32 ONNX
    print(f"\n[5] SXSEditor diffusion loop (FP32 ONNX, {args.n_steps} steps)...")
    t0 = time.time()
    mel_fp32 = sxseditor_diffusion_loop(
        sess_fp32, False, prompt_mel.numpy().astype(np.float32),
        target_len, cond_emb_np,
        n_steps=args.n_steps, cfg_strength=args.cfg, cfg_rescale=args.cfg_rescale
    )
    print(f"    Done in {time.time()-t0:.1f}s")
    print(f"    mel_fp32: {mel_fp32.shape}, mean={mel_fp32.mean():.4f}, std={mel_fp32.std():.4f}")

    # 6. SXSEditor-style diffusion loop - FP16 ONNX
    print(f"\n[6] SXSEditor diffusion loop (FP16 ONNX, {args.n_steps} steps)...")
    t0 = time.time()
    mel_fp16 = sxseditor_diffusion_loop(
        sess_fp16, True, prompt_mel.numpy().astype(np.float32),
        target_len, cond_emb_np,
        n_steps=args.n_steps, cfg_strength=args.cfg, cfg_rescale=args.cfg_rescale
    )
    print(f"    Done in {time.time()-t0:.1f}s")
    print(f"    mel_fp16: {mel_fp16.shape}, mean={mel_fp16.mean():.4f}, std={mel_fp16.std():.4f}")

    # 7. 对比
    print("\n[7] Comparison (final target mel):")
    results = []
    results.append(compare_mel("PyTorch vs FP32 ONNX", mel_pt, mel_fp32))
    results.append(compare_mel("PyTorch vs FP16 ONNX", mel_pt, mel_fp16))
    results.append(compare_mel("FP32 ONNX vs FP16 ONNX", mel_fp32, mel_fp16))

    # 8. 判定
    print("\n[8] Verdict:")
    fp32_vs_fp16 = results[2]
    if fp32_vs_fp16['cosine'] < 0.98 or fp32_vs_fp16['snr_db'] < 20:
        print(f"    [FAIL] FP16 diffusion loop 累积精度严重下降")
        print(f"    >>> 咬字不清根因在 FP16 diffStep 32 步累积误差 <<<")
        print(f"    单步精度完美（cosine=0.999999）但 32 步累积后 cosine={fp32_vs_fp16['cosine']:.6f}")
        print(f"    建议：")
        print(f"      1. 生产环境强制使用 FP32 diffStep（isFP16=false）")
        print(f"      2. 或减少 diffusion 步数（n_steps=16）观察是否改善")
        print(f"      3. 或对 diffStep 关键算子（attention softmax、layernorm）保持 FP32")
    elif fp32_vs_fp16['cosine'] < 0.995 or fp32_vs_fp16['snr_db'] < 30:
        print(f"    [WARN] FP16 diffusion loop 存在累积精度损失 (cos={fp32_vs_fp16['cosine']:.6f})")
        print(f"    可能导致咬字不清，建议生产用 FP32")
    else:
        print(f"    [PASS] FP16 diffusion loop 累积精度可接受 (cos={fp32_vs_fp16['cosine']:.6f})")

    pt_vs_fp32 = results[0]
    if pt_vs_fp32['cosine'] < 0.95:
        print(f"    [WARN] SXSEditor loop vs 官方 loop 存在差异 (cos={pt_vs_fp32['cosine']:.6f})")
        print(f"    可能原因：uncond 输入长度差异（SXSEditor 含 prompt 段零填充，官方仅 target）")
        print(f"    这会影响 CFG 计算，进而影响 mel 质量")

    # 9. 保存
    if args.save:
        output_path = os.path.join(SCRIPT_DIR, 'diffusion_loop_precision_result.npz')
        np.savez(output_path,
                 mel_pt=mel_pt,
                 mel_fp32=mel_fp32,
                 mel_fp16=mel_fp16,
                 prompt_mel=prompt_mel.numpy(),
                 cond_emb=cond_emb_np)
        print(f"\n[9] Saved results to {output_path}")

    # 清理
    del model, sess_fp32, sess_fp16
    clear_memory()
    print("\nDone.")


if __name__ == '__main__':
    main()
