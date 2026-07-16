# -*- coding: utf-8 -*-
"""Generate self-calibration data for PTQ using model's own example audio.

策略 (Self-Calibration, 无需训练数据):
  1. 用 example/audio/ 里的示例音频 (模型原始自带) 提取真实 mel
  2. 用随机噪声 mel 模拟 diffusion 早期 step (step 0 ≈ 纯噪声)
  3. 用真实 mel + 小扰动模拟中间 step
  4. 覆盖 mel 分布的完整范围 (从噪声到清晰特征)

同时收集 vocoder backbone 各层激活统计 (用于 SmoothQuant)。

输出:
  calibrate/data/voc_mel_samples.npy     (N, T, 128) mel 校准样本
  calibrate/data/voc_activation_stats.npz 各层激活通道级统计
"""
import os
import sys
import json
import time
import numpy as np
import torch

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, PROJECT_DIR)
sys.path.insert(0, os.path.join(PROJECT_DIR, 'SoulX-Singer'))

from export_shared import load_config, load_model, clear_memory

EXAMPLE_AUDIO_DIR = os.path.join(PROJECT_DIR, 'SoulX-Singer', 'example', 'audio')
OUTPUT_DIR = os.path.join(SCRIPT_DIR, 'data')

# 真实 mel 分布参数 (来自 config)
MEL_MEAN = -4.92
MEL_VAR = 8.14
MEL_STD = np.sqrt(MEL_VAR)  # ≈ 2.85


def extract_mel_from_audio(model, wav_path, device='cpu'):
    """用模型的 mel_transform 从音频提取 mel。"""
    import soundfile as sf
    wav, sr = sf.read(wav_path)
    if sr != 24000:
        if sr == 48000:
            wav = wav[::2]
        else:
            return None
    if len(wav.shape) > 1:
        wav = wav.mean(axis=1)
    wav_t = torch.from_numpy(wav.astype(np.float32)).unsqueeze(0).to(device)
    with torch.no_grad():
        mel = model.mel(wav_t)  # (1, T, 128) or (1, 128, T)
    mel = mel.squeeze(0).cpu().float().numpy()
    if mel.shape[0] == 128:  # (128, T) -> (T, 128)
        mel = mel.T
    return mel  # (T, 128)


def generate_calibration_mels(model, device='cpu', n_real=6, n_synthetic=200, seq_len=200):
    """生成校准 mel 样本。

    Returns:
        mel_samples: list of (T, 128) arrays
    """
    mel_samples = []

    # 1. 从 example 音频提取真实 mel
    print(f"  [1] Extracting real mel from example audio...")
    example_wavs = [f for f in os.listdir(EXAMPLE_AUDIO_DIR) if f.endswith('.mp3') or f.endswith('.wav')]
    real_count = 0
    for wav_name in example_wavs:
        if real_count >= n_real:
            break
        wav_path = os.path.join(EXAMPLE_AUDIO_DIR, wav_name)
        try:
            mel = extract_mel_from_audio(model, wav_path, device)
            if mel is not None and mel.shape[0] > 10:
                # 切成 seq_len 长度的片段
                for start in range(0, mel.shape[0] - seq_len, seq_len // 2):
                    chunk = mel[start:start + seq_len]
                    mel_samples.append(chunk)
                    real_count += 1
                    if real_count >= n_real * 3:  # 每个音频取 3 段
                        break
                print(f"    {wav_name}: mel shape={mel.shape}, extracted chunks")
        except Exception as e:
            print(f"    {wav_name}: SKIP - {e}")

    print(f"    Total real mel chunks: {len(mel_samples)}")

    # 2. 合成噪声 mel (模拟 diffusion step 0, 纯噪声)
    print(f"  [2] Generating synthetic noise mel (step 0 distribution)...")
    np.random.seed(42)
    n_noise = n_synthetic // 3
    for _ in range(n_noise):
        # 纯噪声: N(0, 1)
        noise_mel = np.random.randn(seq_len, 128).astype(np.float32)
        mel_samples.append(noise_mel)

    # 3. 合成中间 step mel (真实 mel + 不同强度噪声)
    print(f"  [3] Generating intermediate step mel (real + noise)...")
    n_mid = n_synthetic // 3
    if mel_samples:
        real_mels_for_mix = [m for m in mel_samples[:n_real * 3]] if len(mel_samples) > 0 else []
        for i in range(n_mid):
            if real_mels_for_mix:
                base = real_mels_for_mix[i % len(real_mels_for_mix)].copy()
            else:
                base = np.random.randn(seq_len, 128).astype(np.float32) * MEL_STD + MEL_MEAN
            # 噪声强度从 0.1 到 3.0 (模拟 step 1 到 step 31)
            noise_scale = 0.1 + 2.9 * (i / max(1, n_mid))
            noise = np.random.randn(seq_len, 128).astype(np.float32) * noise_scale
            mel_samples.append(base + noise)

    # 4. 合成清晰 mel (匹配真实分布)
    print(f"  [4] Generating clear mel (matched distribution)...")
    n_clear = n_synthetic - n_noise - n_mid
    for _ in range(n_clear):
        clear_mel = np.random.randn(seq_len, 128).astype(np.float32) * MEL_STD + MEL_MEAN
        mel_samples.append(clear_mel)

    print(f"  Total mel samples: {len(mel_samples)}")
    return mel_samples


def collect_activations(model, mel_samples, device='cpu', max_samples=50):
    """收集 vocoder backbone 各层激活统计 (通道级)。"""
    print(f"\n  Collecting activations from {min(len(mel_samples), max_samples)} samples...")

    activations = {}  # name -> {'abs_max': [per_channel], 'count': N}

    def make_hook(name, n_channels):
        def hook(module, inp, out):
            x = inp[0] if isinstance(inp, tuple) else inp
            x_np = x.detach().cpu().float().numpy()
            if name not in activations:
                activations[name] = {
                    'abs_max': np.zeros(n_channels, dtype=np.float32),
                    'abs_sum': np.zeros(n_channels, dtype=np.float64),
                    'sq_sum': np.zeros(n_channels, dtype=np.float64),
                    'count': np.zeros(n_channels, dtype=np.int64),
                }
            stats = activations[name]
            # x_np shape: (B, C, T) for Conv1d input
            if x_np.ndim == 3:
                # 通道维是 dim 1
                for c in range(min(x_np.shape[1], n_channels)):
                    ch_data = x_np[:, c, :].flatten()
                    stats['abs_max'][c] = max(stats['abs_max'][c], float(np.abs(ch_data).max()))
                    stats['abs_sum'][c] += float(np.abs(ch_data).sum())
                    stats['sq_sum'][c] += float((ch_data ** 2).sum())
                    stats['count'][c] += ch_data.size
        return hook

    backbone = model.vocoder.model.backbone

    # 注册 hook: backbone 入口 + 每个 ConvNeXtBlock
    # backbone 入口: (B, 128, T) -> 通道数 128
    entrance_hook = make_hook('backbone.entrance', 128)

    # 先跑一次确定每层通道数
    mel0 = torch.from_numpy(mel_samples[0]).T.unsqueeze(0).to(device)  # (1, 128, T)
    with torch.no_grad():
        hooks = []
        def entrance_pre_hook(m, inp):
            entrance_hook(m, inp, None)
            return inp
        hooks.append(backbone.register_forward_pre_hook(entrance_pre_hook))

        # 确定每个 ConvNeXtBlock 的输出通道数 (先经过 embed: 128 -> 1024)
        block_channels = []
        with torch.no_grad():
            x = backbone.embed(mel0)  # (1, 1024, T)
            for i, layer in enumerate(backbone.convnext):
                x = layer(x)
                block_channels.append(x.shape[1])

        for i, layer in enumerate(backbone.convnext):
            n_ch = block_channels[i]
            hooks.append(layer.register_forward_hook(make_hook(f'backbone.convnext.{i}', n_ch)))

        # 跑校准样本
        for idx, mel in enumerate(mel_samples[:max_samples]):
            mel_t = torch.from_numpy(mel.astype(np.float32)).T.unsqueeze(0).float().to(device)  # (1, 128, T)
            with torch.no_grad():
                _ = model.vocoder.model.backbone(mel_t)
            if (idx + 1) % 10 == 0:
                print(f"    Processed {idx+1}/{max_samples}")

        for h in hooks:
            h.remove()

    return activations


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--n-synthetic', type=int, default=200)
    parser.add_argument('--device', type=str, default='cuda' if torch.cuda.is_available() else 'cpu')
    parser.add_argument('--seq-len', type=int, default=200)
    args = parser.parse_args()

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"[1] Loading PyTorch model on {args.device}...")
    config = load_config()
    model_path = os.path.join(PROJECT_DIR, 'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt')
    model = load_model(config, model_path)
    model = model.to(args.device)
    model.eval()

    print(f"\n[2] Generating calibration mel samples...")
    mel_samples = generate_calibration_mels(
        model, device=args.device,
        n_real=6, n_synthetic=args.n_synthetic, seq_len=args.seq_len
    )

    # 保存 mel 样本
    mel_array = np.stack(mel_samples)  # (N, T, 128)
    np.save(os.path.join(OUTPUT_DIR, 'voc_mel_samples.npy'), mel_array)
    print(f"  Saved mel samples: {mel_array.shape}, mean={mel_array.mean():.4f}, std={mel_array.std():.4f}")

    print(f"\n[3] Collecting vocoder backbone activations...")
    activations = collect_activations(model, mel_samples, device=args.device, max_samples=50)

    # 保存激活统计
    act_stats = {}
    for name, stats in activations.items():
        abs_mean = stats['abs_sum'] / np.maximum(stats['count'], 1)
        rms = np.sqrt(stats['sq_sum'] / np.maximum(stats['count'], 1))
        act_stats[f'{name}_abs_max'] = stats['abs_max']
        act_stats[f'{name}_abs_mean'] = abs_mean.astype(np.float32)
        act_stats[f'{name}_rms'] = rms.astype(np.float32)
        print(f"  {name}: channels={len(stats['abs_max'])}, "
              f"abs_max=[{stats['abs_max'].min():.4f}, {stats['abs_max'].max():.4f}], "
              f"rms=[{rms.min():.4f}, {rms.max():.4f}]")

    np.savez(os.path.join(OUTPUT_DIR, 'voc_activation_stats.npz'), **act_stats)
    print(f"\n  Saved activation stats for {len(activations)} layers")

    del model
    clear_memory()
    print(f"\nDone. Output: {OUTPUT_DIR}")


if __name__ == '__main__':
    main()
