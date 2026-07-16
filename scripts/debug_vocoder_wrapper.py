# -*- coding: utf-8 -*-
"""调试 VocosFullWrapper 与 PyTorch Vocos 的差异。

VocosFullWrapper 是 ONNX 导出用的 wrapper，手动实现了 ISTFT。
Vocos 是原始 PyTorch 模型，用 torch.fft.irfft + fold。

如果两者输出不一致，说明 VocosFullWrapper 的 ISTFT 实现有 bug。
如果两者一致但 ONNX 不一致，说明 ONNX 导出有 bug。
"""
import os
import sys
import torch
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, PROJECT_DIR)

from export_shared import load_config, load_model, VocosFullWrapper, clear_memory


def stats(name, t):
    """打印 tensor 统计"""
    if isinstance(t, torch.Tensor):
        t = t.detach().float().cpu()
    t = np.asarray(t).reshape(-1)
    print(f"  {name}: shape={t.shape}, mean={t.mean():.6f}, std={t.std():.6f}, "
          f"min={t.min():.6f}, max={t.max():.6f}")


def main():
    print("=" * 60)
    print("Debug: VocosFullWrapper vs PyTorch Vocos")
    print("=" * 60)

    # 1. 加载模型
    print("\n[1] Loading model...")
    config = load_config()
    model_path = os.path.join(
        PROJECT_DIR, 'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt')
    model = load_model(config, model_path)
    model.eval()

    vocos_pt = model.vocoder.model  # Vocos nn.Module
    wrapper = VocosFullWrapper(model.vocoder).eval()

    # 2. 生成测试输入
    print("\n[2] Generating test mel...")
    seq_len = 100
    mel = torch.randn(1, seq_len, 128, dtype=torch.float32)
    # 反标准化
    mel_denorm = mel * (8.14 ** 0.5) + (-4.92)
    stats("mel (normalized)", mel)
    stats("mel (denormalized)", mel_denorm)

    # 3. 逐步对比：backbone 输出
    print("\n[3] Comparing backbone output...")
    with torch.no_grad():
        # Vocos.forward: backbone(x) where x = [B, 128, T]
        backbone_input = mel_denorm.transpose(1, 2)  # [B, 128, T]
        backbone_out_pt = vocos_pt.backbone(backbone_input)
        backbone_out_wrapper = wrapper.backbone(backbone_input)
        stats("backbone_out (Vocos)", backbone_out_pt)
        stats("backbone_out (Wrapper)", backbone_out_wrapper)
        diff = (backbone_out_pt - backbone_out_wrapper).abs()
        print(f"  backbone diff: mean={diff.mean():.8f}, max={diff.max():.8f}")

    # 4. 逐步对比：head_out (Linear) 输出
    print("\n[4] Comparing head_out (Linear) output...")
    with torch.no_grad():
        head_out_pt = vocos_pt.head.out(backbone_out_pt)  # [B, T, n_fft+2]
        head_out_wrapper = wrapper.head_out(backbone_out_wrapper)
        stats("head_out (Vocos)", head_out_pt)
        stats("head_out (Wrapper)", head_out_wrapper)
        diff = (head_out_pt - head_out_wrapper).abs()
        print(f"  head_out diff: mean={diff.mean():.8f}, max={diff.max():.8f}")

    # 5. 逐步对比：mag 和 phase
    print("\n[5] Comparing mag/phase...")
    with torch.no_grad():
        # Vocos: ISTFTHead.forward
        x_pt = head_out_pt.transpose(1, 2)  # [B, n_fft+2, T]
        mag_pt, p_pt = x_pt.chunk(2, dim=1)
        mag_pt = torch.exp(mag_pt)
        mag_pt = torch.clip(mag_pt, max=1e2)

        # Wrapper: same operations
        x_w = head_out_wrapper.transpose(1, 2)
        mag_w, p_w = x_w.chunk(2, dim=1)
        mag_w = torch.exp(mag_w)
        mag_w = torch.clip(mag_w, max=1e2)

        stats("mag (Vocos)", mag_pt)
        stats("mag (Wrapper)", mag_w)
        stats("phase (Vocos)", p_pt)
        stats("phase (Wrapper)", p_w)

    # 6. 逐步对比：IDFT
    print("\n[6] Comparing IDFT...")
    with torch.no_grad():
        # Vocos: torch.fft.irfft
        S_real_pt = mag_pt * torch.cos(p_pt)
        S_imag_pt = mag_pt * torch.sin(p_pt)
        S_complex = S_real_pt + 1j * S_imag_pt  # [B, num_freq, T]
        ifft_pt = torch.fft.irfft(S_complex, n=vocos_pt.head.istft.n_fft, dim=1, norm="backward")
        stats("ifft (torch.fft.irfft)", ifft_pt)

        # Wrapper: MatMul IDFT
        ifft_w = torch.matmul(wrapper.istft_cos_basis.t(), S_real_pt) - \
                 torch.matmul(wrapper.istft_sin_basis.t(), S_imag_pt)
        stats("ifft (MatMul)", ifft_w)

        diff = (ifft_pt - ifft_w).abs()
        print(f"  IDFT diff: mean={diff.mean():.8f}, max={diff.max():.8f}")
        rel_diff = diff / (ifft_pt.abs() + 1e-8)
        print(f"  IDFT rel diff: mean={rel_diff.mean():.8f}, max={rel_diff.max():.8f}")

    # 7. 逐步对比：windowing
    print("\n[7] Comparing windowing...")
    with torch.no_grad():
        window = vocos_pt.head.istft.window  # [n_fft]
        ifft_win_pt = ifft_pt * window[None, :, None]
        ifft_win_w = ifft_w * wrapper.istft_window.unsqueeze(1)
        stats("ifft*window (Vocos)", ifft_win_pt)
        stats("ifft*window (Wrapper)", ifft_win_w)
        diff = (ifft_win_pt - ifft_win_w).abs()
        print(f"  windowing diff: mean={diff.mean():.8f}, max={diff.max():.8f}")

    # 8. 逐步对比：overlap-add
    print("\n[8] Comparing overlap-add...")
    with torch.no_grad():
        # Vocos: fold
        B, N, T = ifft_win_pt.shape
        hop = vocos_pt.head.istft.hop_length
        win = vocos_pt.head.istft.win_length
        pad = (win - hop) // 2
        output_size = (T - 1) * hop + win
        y_pt = torch.nn.functional.fold(
            ifft_win_pt, output_size=(1, output_size),
            kernel_size=(1, win), stride=(1, hop)
        )[:, 0, 0, pad:pad + T * hop]
        stats("y_fold (Vocos)", y_pt)

        # Wrapper: manual overlap-add
        y_w = wrapper._overlap_add(ifft_win_w)
        stats("y_overlap_add (Wrapper)", y_w)

        # 对比
        min_len = min(y_pt.shape[-1], y_w.shape[-1])
        diff = (y_pt[..., :min_len] - y_w[..., :min_len]).abs()
        print(f"  overlap-add diff: mean={diff.mean():.8f}, max={diff.max():.8f}")

    # 9. 逐步对比：window envelope
    print("\n[9] Comparing window envelope...")
    with torch.no_grad():
        # Vocos
        window_sq = window.square().expand(1, T, -1).transpose(1, 2)  # [1, win, T]
        env_pt = torch.nn.functional.fold(
            window_sq, output_size=(1, output_size),
            kernel_size=(1, win), stride=(1, hop)
        ).squeeze()[pad:pad + T * hop]
        stats("env (Vocos)", env_pt)

        # Wrapper
        wsq = wrapper.istft_window.square()
        wsq_expanded = wsq.unsqueeze(0).unsqueeze(-1).expand(1, -1, T)
        env_w = wrapper._overlap_add(wsq_expanded).squeeze(0)
        stats("env (Wrapper)", env_w)

        min_len = min(env_pt.shape[-1], env_w.shape[-1])
        diff = (env_pt[..., :min_len] - env_w[..., :min_len]).abs()
        print(f"  envelope diff: mean={diff.mean():.8f}, max={diff.max():.8f}")

    # 10. 最终对比：完整 forward
    print("\n[10] Comparing full forward output...")
    with torch.no_grad():
        # Vocos.full forward
        audio_pt = vocos_pt(mel_denorm.transpose(1, 2))  # [B, 1, T] or [B, T]
        if audio_pt.dim() == 3:
            audio_pt = audio_pt.squeeze(1)
        stats("audio (Vocos)", audio_pt)

        # Wrapper full forward
        audio_w = wrapper(mel_denorm)
        stats("audio (Wrapper)", audio_w)

        min_len = min(audio_pt.shape[-1], audio_w.shape[-1])
        diff = (audio_pt[..., :min_len] - audio_w[..., :min_len]).abs()
        print(f"  final diff: mean={diff.mean():.8f}, max={diff.max():.8f}")

        # SNR
        noise = audio_pt[..., :min_len] - audio_w[..., :min_len]
        signal_power = (audio_pt[..., :min_len] ** 2).mean()
        noise_power = (noise ** 2).mean()
        snr = 10 * torch.log10(signal_power / (noise_power + 1e-12))
        print(f"  SNR: {snr.item():.2f} dB")

    print("\nDone.")


if __name__ == "__main__":
    main()
