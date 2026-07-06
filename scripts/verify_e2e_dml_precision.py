# -*- coding: utf-8 -*-
"""端到端精度验证：DML EP 下 FP32 pipeline vs FP16 pipeline 的最终音频对比。

这是最接近生产场景的测试：
1. 用 DML EP FP32 diffStep 跑 32 步 → FP32 mel → FP32 vocoder → FP32 音频
2. 用 DML EP FP16 diffStep 跑 32 步 → FP16 mel → FP16 vocoder → FP16 音频
3. 对比两者的最终音频差异

如果端到端音频差异显著（cosine < 0.95 或 SNR < 20dB），则 FP16 是咬字不清根因。
如果差异微小（cosine > 0.99），则根因在别处（如 SXSEditor loop 实现、真实数据分布等）。

用法：
    python scripts/verify_e2e_dml_precision.py
    python scripts/verify_e2e_dml_precision.py --target-len 200 --seq-len-multiple 4
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


def create_dml_session(model_path):
    import onnxruntime as ort
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(
        model_path, sess_options=sess_options,
        providers=['DmlExecutionProvider', 'CPUExecutionProvider']
    )


def run_diffstep(sess, feeds, is_fp16):
    # 自动检测模型输入类型（W16A32 模型用 keep_io_types=True，输入是 float32）
    input_dtype = sess.get_inputs()[0].type
    if 'float16' in str(input_dtype):
        feeds = {k: v.astype(np.float16) for k, v in feeds.items()}
    else:
        feeds = {k: v.astype(np.float32) for k, v in feeds.items()}
    return sess.run(['flow_pred'], feeds)[0].astype(np.float32)


def run_vocoder(sess, mel_np, is_fp16):
    # 自动检测模型输入类型
    input_dtype = sess.get_inputs()[0].type
    if 'float16' in str(input_dtype):
        mel = mel_np.astype(np.float16)
    else:
        mel = mel_np.astype(np.float32)
    return sess.run(['waveform'], {'mel': mel})[0].astype(np.float32)


def diffusion_loop(sess, is_fp16, prompt_mel, target_len, cond_emb,
                   n_steps=32, cfg_strength=3.0, cfg_rescale=0.75):
    """SXSEditor 风格 diffusion loop。返回最终 target mel (target_len, 128)。"""
    mel_dim = 128
    prompt_len = prompt_mel.shape[1]
    total_len = prompt_len + target_len

    np.random.seed(42)
    z = np.random.randn(1, target_len, mel_dim).astype(np.float32)
    xt = z.copy()

    uncond_cond = np.zeros((1, total_len, 1024), dtype=np.float32)
    cond_mask = np.ones((1, total_len), dtype=np.float32)
    uncond_mask = np.zeros((1, total_len), dtype=np.float32)
    uncond_mask[0, prompt_len:] = 1.0

    xt_input = np.zeros((1, total_len, mel_dim), dtype=np.float32)
    xt_input[0, :prompt_len] = prompt_mel[0]
    xt_uncond = np.zeros((1, total_len, mel_dim), dtype=np.float32)

    dt = 1.0 / n_steps

    for step in range(n_steps):
        t_val = (step + 0.5) / n_steps
        t_arr = np.array([t_val], dtype=np.float32)

        xt_input[0, prompt_len:] = xt[0]
        feeds_cond = {'xt_input': xt_input, 't': t_arr, 'cond': cond_emb, 'xt_mask': cond_mask}
        flow_cond = run_diffstep(sess, feeds_cond, is_fp16)

        xt_uncond[0, prompt_len:] = xt[0]
        feeds_uncond = {'xt_input': xt_uncond, 't': t_arr, 'cond': uncond_cond, 'xt_mask': uncond_mask}
        flow_uncond = run_diffstep(sess, feeds_uncond, is_fp16)

        flow_cond_target = flow_cond[0, prompt_len:]
        flow_uncond_target = flow_uncond[0, prompt_len:]

        if cfg_strength > 0:
            flow_cfg = flow_cond_target + cfg_strength * (flow_cond_target - flow_uncond_target)
            pos_std = float(np.std(flow_cond_target) + 1e-8)
            cfg_std = float(np.std(flow_cfg) + 1e-8)
            rescale = pos_std / cfg_std
            flow_final = cfg_rescale * (flow_cfg * rescale) + (1 - cfg_rescale) * flow_cfg
        else:
            flow_final = flow_cond_target

        xt = xt + flow_final * dt

    return xt[0]  # (target_len, mel_dim)


def stats(name, ref, cand):
    ref = np.asarray(ref, dtype=np.float32).reshape(-1)
    cand = np.asarray(cand, dtype=np.float32).reshape(-1)
    n = min(len(ref), len(cand))
    ref, cand = ref[:n], cand[:n]
    diff = ref - cand
    l1 = float(np.mean(np.abs(diff)))
    l1_max = float(np.max(np.abs(diff)))
    mse = float(np.mean(diff ** 2))
    ref_e = float(np.sum(ref ** 2)) + 1e-12
    err_e = float(np.sum(diff ** 2)) + 1e-12
    snr = 10 * np.log10(ref_e / err_e)
    cos = float(np.sum(ref * cand) / (np.linalg.norm(ref) * np.linalg.norm(cand) + 1e-8))
    # 相关系数
    corr = float(np.corrcoef(ref, cand)[0, 1])
    print(f"  [{name}] (len={n})")
    print(f"    ref:  mean={ref.mean():.6f}, std={ref.std():.6f}, min={ref.min():.6f}, max={ref.max():.6f}")
    print(f"    cand: mean={cand.mean():.6f}, std={cand.std():.6f}, min={cand.min():.6f}, max={cand.max():.6f}")
    print(f"    L1 mean={l1:.6f}, L1 max={l1_max:.6f}, MSE={mse:.8f}")
    print(f"    SNR={snr:.2f} dB, Cosine={cos:.6f}, Corr={corr:.6f}")
    return {'l1': l1, 'snr': snr, 'cos': cos, 'corr': corr}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--target-len', type=int, default=200, help='target mel 帧数')
    parser.add_argument('--prompt-len', type=int, default=30, help='prompt mel 帧数')
    parser.add_argument('--n-steps', type=int, default=32)
    parser.add_argument('--cfg', type=float, default=3.0)
    parser.add_argument('--cfg-rescale', type=float, default=0.75)
    parser.add_argument('--save', action='store_true')
    args = parser.parse_args()

    print("=" * 60)
    print("端到端 DML EP 精度验证 (FP32 pipeline vs FP16 pipeline)")
    print("=" * 60)
    print(f"  target_len={args.target_len}, prompt_len={args.prompt_len}, n_steps={args.n_steps}")

    # 1. 加载 PyTorch 模型（用于 cond_emb）
    print("\n[1] Loading PyTorch model (for cond_emb)...")
    t0 = time.time()
    from export_shared import load_config, load_model, clear_memory

    config = load_config()
    model_path = os.path.join(PROJECT_DIR, 'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt')
    model = load_model(config, model_path)
    model.eval()
    cond_emb_layer = model.cfm_decoder.model.cond_emb
    print(f"    Loaded in {time.time()-t0:.1f}s")

    # 2. 创建 DML sessions
    print("\n[2] Creating DML sessions...")
    fp32_diff = create_dml_session(os.path.join(PROJECT_DIR, 'onnx_models', 'diff_step_dml.onnx'))
    fp16_diff = create_dml_session(os.path.join(PROJECT_DIR, 'onnx_models', 'fp16', 'diff_step_dml.onnx'))
    fp32_voc = create_dml_session(os.path.join(PROJECT_DIR, 'onnx_models', 'vocoder_dml.onnx'))
    fp16_voc = create_dml_session(os.path.join(PROJECT_DIR, 'onnx_models', 'fp16', 'vocoder_dml.onnx'))
    print("    All sessions created")

    # 3. 生成输入
    print("\n[3] Generating inputs...")
    torch.manual_seed(42)
    np.random.seed(42)

    mel_dim = 128
    prompt_len = args.prompt_len
    target_len = args.target_len
    total_len = prompt_len + target_len

    # 模拟真实标准化 mel
    prompt_mel = (torch.randn(1, prompt_len, mel_dim) * 2.85 + (-4.92)).numpy().astype(np.float32)
    cond_code = torch.randn(1, total_len, 512)
    with torch.no_grad():
        cond_emb = cond_emb_layer(cond_code).numpy().astype(np.float32)
    print(f"    prompt_mel: {prompt_mel.shape}, mean={prompt_mel.mean():.4f}")
    print(f"    cond_emb: {cond_emb.shape}, mean={cond_emb.mean():.4f}")

    # 4. FP32 pipeline: diffStep FP32 → vocoder FP32
    print(f"\n[4] FP32 pipeline (diffStep FP32 + vocoder FP32, {args.n_steps} steps)...")
    t0 = time.time()
    mel_fp32 = diffusion_loop(
        fp32_diff, False, prompt_mel, target_len, cond_emb,
        n_steps=args.n_steps, cfg_strength=args.cfg, cfg_rescale=args.cfg_rescale
    )
    print(f"    diffStep done in {time.time()-t0:.1f}s, mel mean={mel_fp32.mean():.4f}, std={mel_fp32.std():.4f}")

    t0 = time.time()
    audio_fp32 = run_vocoder(fp32_voc, mel_fp32.reshape(1, -1, 128), is_fp16=False)
    print(f"    vocoder done in {time.time()-t0:.1f}s, audio shape={audio_fp32.shape}")

    # 5. FP16 pipeline: diffStep FP16 → vocoder FP16
    print(f"\n[5] FP16 pipeline (diffStep FP16 + vocoder FP16, {args.n_steps} steps)...")
    t0 = time.time()
    mel_fp16 = diffusion_loop(
        fp16_diff, True, prompt_mel, target_len, cond_emb,
        n_steps=args.n_steps, cfg_strength=args.cfg, cfg_rescale=args.cfg_rescale
    )
    print(f"    diffStep done in {time.time()-t0:.1f}s, mel mean={mel_fp16.mean():.4f}, std={mel_fp16.std():.4f}")

    t0 = time.time()
    audio_fp16 = run_vocoder(fp16_voc, mel_fp16.reshape(1, -1, 128), is_fp16=True)
    print(f"    vocoder done in {time.time()-t0:.1f}s, audio shape={audio_fp16.shape}")

    # 6. 混合 pipeline: diffStep FP32 → vocoder FP16（隔离 vocoder FP16 影响）
    print(f"\n[6] Mixed pipeline (diffStep FP32 + vocoder FP16)...")
    audio_mix_voc16 = run_vocoder(fp16_voc, mel_fp32.reshape(1, -1, 128), is_fp16=True)
    print(f"    done, audio shape={audio_mix_voc16.shape}")

    # 7. 混合 pipeline: diffStep FP16 → vocoder FP32（隔离 diffStep FP16 影响）
    print(f"\n[7] Mixed pipeline (diffStep FP16 + vocoder FP32)...")
    audio_mix_diff16 = run_vocoder(fp32_voc, mel_fp16.reshape(1, -1, 128), is_fp16=False)
    print(f"    done, audio shape={audio_mix_diff16.shape}")

    # 8. 对比
    print("\n[8] Comparison (final audio):")
    print("\n  --- mel 对比 ---")
    stats("mel: FP32 vs FP16", mel_fp32, mel_fp16)

    print("\n  --- 端到端音频对比 ---")
    r1 = stats("audio: FP32 pipeline vs FP16 pipeline", audio_fp32, audio_fp16)

    print("\n  --- 隔离 vocoder FP16 影响（同 mel, 不同 vocoder 精度）---")
    r2 = stats("audio: vocoder FP32 vs vocoder FP16 (same FP32 mel)", audio_fp32, audio_mix_voc16)

    print("\n  --- 隔离 diffStep FP16 影响（不同 mel, 同 vocoder 精度）---")
    r3 = stats("audio: diffStep FP32 mel vs diffStep FP16 mel (same FP32 vocoder)", audio_fp32, audio_mix_diff16)

    # 9. 判定
    print("\n[9] Verdict:")
    if r1['cos'] < 0.95 or r1['snr'] < 15:
        print(f"    [FAIL] 端到端 FP16 vs FP32 音频差异显著 (cos={r1['cos']:.6f}, SNR={r1['snr']:.2f}dB)")
        if r2['cos'] > 0.99 and r3['cos'] < 0.95:
            print(f"    >>> 根因在 FP16 diffStep 32 步累积误差 <<<")
            print(f"    vocoder FP16 影响可忽略 (cos={r2['cos']:.6f})")
            print(f"    diffStep FP16 累积导致 mel 漂移 (cos={r3['cos']:.6f})")
            print(f"    建议：diffStep 用 FP32，vocoder 可用 FP16")
        elif r3['cos'] > 0.99 and r2['cos'] < 0.95:
            print(f"    >>> 根因在 FP16 vocoder <<<")
            print(f"    diffStep FP16 影响可忽略 (cos={r3['cos']:.6f})")
            print(f"    vocoder FP16 导致音频质量下降 (cos={r2['cos']:.6f})")
            print(f"    建议：vocoder 用 FP32，diffStep 可用 FP16")
        else:
            print(f"    >>> 两者都有影响 <<<")
            print(f"    diffStep FP16 累积 cos={r3['cos']:.6f}, vocoder FP16 cos={r2['cos']:.6f}")
            print(f"    建议：生产环境全部用 FP32")
    else:
        print(f"    [PASS] 端到端 FP16 vs FP32 差异可接受 (cos={r1['cos']:.6f}, SNR={r1['snr']:.2f}dB)")
        print(f"    咬字不清根因可能在：")
        print(f"      - 真实数据分布下的精度差异（本测试用随机数据）")
        print(f"      - SXSEditor loop vs 官方 loop 实现差异")
        print(f"      - 其他非精度问题（如 F0 处理、encoder 等）")

    # 10. 保存
    if args.save:
        output_path = os.path.join(SCRIPT_DIR, 'e2e_precision_result.npz')
        np.savez(output_path,
                 mel_fp32=mel_fp32, mel_fp16=mel_fp16,
                 audio_fp32=audio_fp32, audio_fp16=audio_fp16,
                 audio_mix_voc16=audio_mix_voc16, audio_mix_diff16=audio_mix_diff16,
                 prompt_mel=prompt_mel, cond_emb=cond_emb)
        print(f"\n[10] Saved to {output_path}")

    # 清理
    del model, fp32_diff, fp16_diff, fp32_voc, fp16_voc
    clear_memory()
    print("\nDone.")


if __name__ == '__main__':
    main()
