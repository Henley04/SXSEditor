# -*- coding: utf-8 -*-
"""验证 Vocos vocoder ONNX 与 PyTorch 的精度差异。

Vocos ONNX 已烘焙 ISTFT（输出 'waveform'，shape [B, 480*seq_len - 480]），
无需 JS 端做 ISTFT。本脚本对比：
  1. PyTorch Vocos（含 ISTFTHead）输出波形
  2. FP32 ONNX Vocos 输出波形
  3. FP16 ONNX Vocos 输出波形

重点是 ISTFT 阶段（mag=exp, phase=cos/sin, complex mul, inverse_basis matmul）
在 FP16 下的精度损失。咬字不清的根因大概率在 ISTFT 的 FP16 精度。

用法：
    python scripts/verify_vocoder_precision.py
    python scripts/verify_vocoder_precision.py --seq-len 500
    python scripts/verify_vocoder_precision.py --fp16-path onnx_models/fp16/vocoder_dml.onnx
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


def _to_dtype(arr, is_fp16):
    """根据目标精度转换 numpy 数组。"""
    return arr.astype(np.float16 if is_fp16 else np.float32)


def run_onnx(sess, mel_np, is_fp16):
    """运行 ONNX vocoder，返回 float32 波形。"""
    feeds = {'mel': _to_dtype(mel_np, is_fp16)}
    out = sess.run(['waveform'], feeds)[0]
    return out.astype(np.float32)


def compare(name, ref, cand):
    """对比两组波形的统计差异。"""
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
    # 信噪比 SNR (dB)：10*log10(sum(ref^2)/sum(diff^2))
    ref_energy = float(np.sum(ref ** 2)) + 1e-12
    err_energy = float(np.sum(diff ** 2)) + 1e-12
    snr_db = 10 * np.log10(ref_energy / err_energy)
    # cosine similarity
    cos = float(np.sum(ref * cand) / (np.linalg.norm(ref) * np.linalg.norm(cand) + 1e-8))
    print(f"  [{name}] (len={min_len})")
    print(f"    ref:  mean={ref.mean():.6f}, std={ref.std():.6f}, min={ref.min():.6f}, max={ref.max():.6f}")
    print(f"    cand: mean={cand.mean():.6f}, std={cand.std():.6f}, min={cand.min():.6f}, max={cand.max():.6f}")
    print(f"    L1 mean={l1_mean:.6f}, L1 max={l1_max:.6f}, L1 p99={l1_p99:.6f}")
    print(f"    MSE={mse:.8f}, SNR={snr_db:.2f} dB, Cosine={cos:.6f}")
    return {
        'name': name, 'l1_mean': l1_mean, 'l1_max': l1_max, 'l1_p99': l1_p99,
        'mse': mse, 'snr_db': snr_db, 'cosine': cos
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seq-len', type=int, default=300,
                        help='测试序列长度（mel 帧数，建议 ≤300 避免 CPU 推理慢）')
    parser.add_argument('--fp32-path', default=None,
                        help='FP32 ONNX vocoder 路径')
    parser.add_argument('--fp16-path', default=None,
                        help='FP16 ONNX vocoder 路径')
    parser.add_argument('--model-path', default=None,
                        help='SoulX-Singer model.pt 路径')
    parser.add_argument('--use-real-mel', action='store_true',
                        help='使用真实 mel（从测试音频提取）而非随机 mel（默认随机）')
    parser.add_argument('--save', action='store_true', help='保存结果到 npz')
    args = parser.parse_args()

    print("=" * 60)
    print("Vocos vocoder ONNX vs PyTorch 精度验证")
    print("=" * 60)

    # 1. 加载 PyTorch Vocos
    print("\n[1] Loading SoulX-Singer PyTorch model (for Vocos)...")
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
    vocos_pt = model.vocoder.model  # Vocos nn.Module (backbone + head)
    print(f"    Loaded in {time.time()-t0:.1f}s")
    print(f"    Vocos config: input_channels={vocos_pt.backbone.input_channels}, "
          f"dim={vocos_pt.backbone.embed.out_channels}, "
          f"num_layers={len(vocos_pt.backbone.convnext)}")
    print(f"    ISTFTHead.out: out_features={vocos_pt.head.out.out_features}, "
          f"n_fft={vocos_pt.head.istft.n_fft}, hop_length={vocos_pt.head.istft.hop_length}")

    # 2. 加载 ONNX vocoder
    print("\n[2] Loading ONNX vocoder...")
    import onnxruntime as ort

    fp32_path = args.fp32_path or os.path.join(PROJECT_DIR, 'onnx_models', 'vocoder_dml.onnx')
    fp16_path = args.fp16_path or os.path.join(PROJECT_DIR, 'onnx_models', 'fp16', 'vocoder_dml.onnx')
    print(f"    FP32 ONNX: {fp32_path}")
    print(f"    FP16 ONNX: {fp16_path}")

    if not os.path.exists(fp32_path):
        print(f"    [ERROR] FP32 ONNX not found: {fp32_path}")
        sys.exit(1)
    if not os.path.exists(fp16_path):
        print(f"    [WARN] FP16 ONNX not found: {fp16_path}, will skip FP16 comparison")

    sess_fp32 = ort.InferenceSession(fp32_path, providers=['CPUExecutionProvider'])
    sess_fp16 = None
    if os.path.exists(fp16_path):
        sess_fp16 = ort.InferenceSession(fp16_path, providers=['CPUExecutionProvider'])

    # 打印 ONNX 输入输出信息
    for tag, sess in [('FP32', sess_fp32), ('FP16', sess_fp16)]:
        if sess is None:
            continue
        inputs = [(i.name, i.type, i.shape) for i in sess.get_inputs()]
        outputs = [(o.name, o.type, o.shape) for o in sess.get_outputs()]
        print(f"    {tag} ONNX inputs: {inputs}")
        print(f"    {tag} ONNX outputs: {outputs}")

    # 3. 生成输入 mel
    print(f"\n[3] Generating input mel (seq_len={args.seq_len})...")
    seq_len = args.seq_len
    B = 1
    torch.manual_seed(42)
    np.random.seed(42)

    # Vocos vocoder 期望标准化 mel (mean=0, std=1)，与官方 PyTorch Vocoder.forward 一致。
    # 此处生成标准化 mel 用于精度对比测试。
    mel_pt = torch.randn(B, seq_len, 128)
    print(f"    mel_pt: {tuple(mel_pt.shape)}, mean={mel_pt.mean():.4f}, std={mel_pt.std():.4f}")
    print(f"    min={mel_pt.min():.4f}, max={mel_pt.max():.4f}")

    mel_np = mel_pt.numpy().astype(np.float32)

    # 4. PyTorch Vocos 推理（含 ISTFT）
    print("\n[4] PyTorch Vocos inference (with ISTFT)...")
    t0 = time.time()
    with torch.no_grad():
        # Vocos.forward(x): x (B, input_channels=128, L) → backbone → head → audio (B, T)
        # ONNX wrapper 输入是 mel (B, L, 128)，这里也要 transpose 后再喂给 Vocos
        audio_pt = vocos_pt(mel_pt.transpose(1, 2))  # (B, 1, T) or (B, T)?
    print(f"    Done in {time.time()-t0:.2f}s")
    if audio_pt.dim() == 3:
        audio_pt = audio_pt.squeeze(1)
    print(f"    audio_pt: {tuple(audio_pt.shape)}")
    print(f"    mean={audio_pt.mean():.6f}, std={audio_pt.std():.6f}")
    print(f"    min={audio_pt.min():.6f}, max={audio_pt.max():.6f}")

    # 5. FP32 ONNX 推理
    print("\n[5] FP32 ONNX inference...")
    t0 = time.time()
    audio_fp32 = run_onnx(sess_fp32, mel_np, is_fp16=False)
    print(f"    Done in {time.time()-t0:.2f}s")
    print(f"    audio_fp32: {audio_fp32.shape}")
    print(f"    mean={audio_fp32.mean():.6f}, std={audio_fp32.std():.6f}")
    print(f"    min={audio_fp32.min():.6f}, max={audio_fp32.max():.6f}")

    # 6. FP16 ONNX 推理
    audio_fp16 = None
    if sess_fp16 is not None:
        print("\n[6] FP16 ONNX inference...")
        t0 = time.time()
        audio_fp16 = run_onnx(sess_fp16, mel_np, is_fp16=True)
        print(f"    Done in {time.time()-t0:.2f}s")
        print(f"    audio_fp16: {audio_fp16.shape}")
        print(f"    mean={audio_fp16.mean():.6f}, std={audio_fp16.std():.6f}")
        print(f"    min={audio_fp16.min():.6f}, max={audio_fp16.max():.6f}")

    # 7. 对比
    print("\n[7] Comparison:")
    results = []
    results.append(compare("PyTorch vs FP32 ONNX", audio_pt.numpy(), audio_fp32))
    if audio_fp16 is not None:
        results.append(compare("PyTorch vs FP16 ONNX", audio_pt.numpy(), audio_fp16))
        results.append(compare("FP32 ONNX vs FP16 ONNX", audio_fp32, audio_fp16))

    # 8. 判定
    print("\n[8] Verdict:")
    pt_vs_fp32 = results[0]
    if pt_vs_fp32['snr_db'] > 20 and pt_vs_fp32['cosine'] > 0.99:
        print(f"    [PASS] FP32 ONNX 与 PyTorch 高度一致 (SNR={pt_vs_fp32['snr_db']:.2f}dB, cos={pt_vs_fp32['cosine']:.6f})")
    else:
        print(f"    [WARN] FP32 ONNX 与 PyTorch 存在差异 (SNR={pt_vs_fp32['snr_db']:.2f}dB, cos={pt_vs_fp32['cosine']:.6f})")
        print(f"    可能原因：ISTFT inverse_basis 烘焙方式与 PyTorch torch.istft 实现差异")

    if len(results) >= 2:
        pt_vs_fp16 = results[1]
        fp32_vs_fp16 = results[2]
        if fp32_vs_fp16['snr_db'] < 15 or fp32_vs_fp16['cosine'] < 0.98:
            print(f"    [FAIL] FP16 vs FP32 ONNX 精度严重下降 (SNR={fp32_vs_fp16['snr_db']:.2f}dB, cos={fp32_vs_fp16['cosine']:.6f})")
            print(f"    >>> 咬字不清根因大概率在 FP16 Vocos ISTFT 精度 <<<")
            print(f"    建议：")
            print(f"      1. 生产环境强制使用 FP32 vocoder（vocoderIsFP16=false）")
            print(f"      2. 或重新导出 FP16 ONNX，对 ISTFT 关键算子（exp/cos/sin）保持 FP32")
        elif fp32_vs_fp16['snr_db'] < 25 or fp32_vs_fp16['cosine'] < 0.995:
            print(f"    [WARN] FP16 vs FP32 ONNX 存在精度损失 (SNR={fp32_vs_fp16['snr_db']:.2f}dB, cos={fp32_vs_fp16['cosine']:.6f})")
            print(f"    可能导致咬字不清，建议生产用 FP32")
        else:
            print(f"    [PASS] FP16 vs FP32 ONNX 精度可接受 (SNR={fp32_vs_fp16['snr_db']:.2f}dB, cos={fp32_vs_fp16['cosine']:.6f})")
            print(f"    咬字不清根因不在 vocoder，可能在 diffusion 输出 mel 分布")

    # 9. 多个输入测试（不同 mel 分布）
    print("\n[9] Testing multiple mel distributions...")
    distributions = [
        ('normal', lambda: torch.randn(B, seq_len, 128)),
        ('scaled', lambda: torch.randn(B, seq_len, 128) * 3 + 2),
        ('quiet', lambda: torch.randn(B, seq_len, 128) * 0.5 - 5),
    ]
    for dist_name, gen in distributions:
        torch.manual_seed(42 + hash(dist_name) % 1000)
        m = gen()
        with torch.no_grad():
            a_pt = vocos_pt(m.transpose(1, 2))
            if a_pt.dim() == 3:
                a_pt = a_pt.squeeze(1)
        m_np = m.numpy().astype(np.float32)
        a_fp32 = run_onnx(sess_fp32, m_np, is_fp16=False)
        a_fp16 = run_onnx(sess_fp16, m_np, is_fp16=True) if sess_fp16 else None
        print(f"\n  Distribution: {dist_name} (mel mean={m.mean():.3f}, std={m.std():.3f})")
        compare(f"{dist_name}: PT vs FP32", a_pt.numpy(), a_fp32)
        if a_fp16 is not None:
            compare(f"{dist_name}: FP32 vs FP16", a_fp32, a_fp16)

    # 10. 保存结果
    if args.save:
        output_path = os.path.join(SCRIPT_DIR, 'vocoder_precision_result.npz')
        save_dict = {
            'mel': mel_np,
            'audio_pt': audio_pt.numpy().astype(np.float32),
            'audio_fp32': audio_fp32,
        }
        if audio_fp16 is not None:
            save_dict['audio_fp16'] = audio_fp16
        np.savez(output_path, **save_dict)
        print(f"\n[10] Saved results to {output_path}")

    # 清理
    del model, sess_fp32
    if sess_fp16 is not None:
        del sess_fp16
    clear_memory()
    print("\nDone.")


if __name__ == '__main__':
    main()
