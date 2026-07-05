# -*- coding: utf-8 -*-
"""验证 diffsptk 全套管线提取的 mcep 是否与 SiFiGAN 训练 stats 分布对齐。

SiFiGAN 训练管线：pyworld.harvest + pyworld.cheaptrick + pysptk.sp2mc(order=39, alpha=0.466)
diffsptk 等价管线：diffsptk.Pitch(fcnf0) + diffsptk.PitchAdaptiveSpectralAnalysis(cheap-trick) + 手动 sp2mc

手动 sp2mc 算法（与 pysptk.sp2mc 一致）：
  1. c = real(fft(log(sp), axis=-1))  # 实倒谱
  2. c = c[..., :order+1]  # 截断
  3. mc = freqt(c, order, alpha)  # 频率变换
"""
import os
import numpy as np
import soundfile as sf
import torch
import librosa
import diffsptk
from joblib import load

# SiFiGAN 训练参数
SAMPLE_RATE = 24000
FRAME_PERIOD = 120  # samples = 5ms * 24kHz
FFT_SIZE = 1024
MCEP_DIM = 39  # order，输出 40 维
ALPHA = 0.466  # 24kHz all-pass filter coefficient

PJS_DIR = r"D:\Document\electron\SXSEditor\SoulX-Singer\train\lora_jp_v2\dataset\wavs"
STATS_PATH = r"D:\download\model+stats\libritts_r_clean+nus-48e_train_no_dev.joblib"


def extract_f0_pyin(x, fs):
    """librosa.pyin 提取 f0，帧率 = fs/hop_length = 200Hz（5ms）。"""
    f0, voiced, _ = librosa.pyin(
        x, fmin=100, fmax=840, sr=fs,
        frame_length=2048, hop_length=FRAME_PERIOD,
        fill_na=0.0,
    )
    return f0  # (T,)


def extract_mcep_diffsptk(x, fs, f0, device="cuda"):
    """diffsptk：PitchAdaptiveSpectralAnalysis(cheap-trick) + 手动 sp2mc。"""
    x_t = torch.from_numpy(x).float().to(device).unsqueeze(0)  # (1, T)
    f0_t = torch.from_numpy(f0).float().to(device).unsqueeze(0)  # (1, T)

    # Spectral envelope（cheap-trick），unvoiced 帧用 default_f0=150
    spec_module = diffsptk.PitchAdaptiveSpectralAnalysis(
        frame_period=FRAME_PERIOD,
        sample_rate=fs,
        fft_length=FFT_SIZE,
        algorithm="cheap-trick",
        out_format="power",
        default_f0=150,
        device=device,
    )
    with torch.no_grad():
        env = spec_module(x_t, f0_t).squeeze(0)  # (T, 513)

    # 手动 sp2mc：log(env) → fft → cepstrum → freqt
    log_env = torch.log(env + 1e-12)  # (T, 513)
    cep = torch.fft.fft(log_env, dim=-1).real  # (T, 513)
    cep = cep[:, :MCEP_DIM + 1]  # (T, 40)

    freqt = diffsptk.FrequencyTransform(
        in_order=MCEP_DIM, out_order=MCEP_DIM, alpha=ALPHA,
        device=device,
    )
    with torch.no_grad():
        mcep = freqt(cep)  # (T, 40)

    return mcep.cpu().numpy()


def extract_mcep_diffsptk_direct(x, fs, f0, device="cuda"):
    """方案A：PitchAdaptiveSpectralAnalysis + MelCepstralAnalysis（直接从 power spectrum 做 mcep）。"""
    x_t = torch.from_numpy(x).float().to(device).unsqueeze(0)
    f0_t = torch.from_numpy(f0).float().to(device).unsqueeze(0)  # (1, T)

    spec_module = diffsptk.PitchAdaptiveSpectralAnalysis(
        frame_period=FRAME_PERIOD, sample_rate=fs, fft_length=FFT_SIZE,
        algorithm="cheap-trick", out_format="power", default_f0=150, device=device,
    )
    with torch.no_grad():
        env = spec_module(x_t, f0_t).squeeze(0)  # (T, 513)

    mcep_analyzer = diffsptk.MelCepstralAnalysis(
        fft_length=FFT_SIZE, cep_order=MCEP_DIM, alpha=ALPHA, n_iter=0,
        device=device,
    )
    with torch.no_grad():
        mcep = mcep_analyzer(env)  # (T, 40)

    return mcep.cpu().numpy()


def main():
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}")
    if device == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")

    # 加载 stats
    print(f"\n[1] Loading stats: {STATS_PATH}")
    scaler = load(STATS_PATH)
    stats_mcep_mean = np.asarray(scaler["mcep"].mean_)  # (40,)
    stats_mcep_scale = np.asarray(scaler["mcep"].scale_)
    print(f"    stats mcep mean: range=[{stats_mcep_mean.min():.4f}, {stats_mcep_mean.max():.4f}]")
    print(f"    stats mcep scale: range=[{stats_mcep_scale.min():.4f}, {stats_mcep_scale.max():.4f}]")

    # 取前 5 个 PJS 文件
    files = sorted([f for f in os.listdir(PJS_DIR) if f.endswith(".wav")])[:5]
    print(f"\n[2] Extracting from {len(files)} PJS files...")

    all_mcep_sp2mc = []
    all_mcep_direct = []
    all_f0 = []

    for fname in files:
        path = os.path.join(PJS_DIR, fname)
        x, fs = sf.read(path)
        if fs != SAMPLE_RATE:
            print(f"    [WARN] {fname} sr={fs}, skip")
            continue
        x = x.astype(np.float64)

        try:
            # 截断音频到 FRAME_PERIOD 整数倍，避免 cheaptrick 帧数不匹配
            x = x[: len(x) // FRAME_PERIOD * FRAME_PERIOD]
            f0 = extract_f0_pyin(x, fs)
            # 对齐帧数：diffsptk 期望 floor(T/frame_period)，pyin center=True 会多 1 帧
            expected_frames = len(x) // FRAME_PERIOD
            if len(f0) > expected_frames:
                f0 = f0[:expected_frames]
            elif len(f0) < expected_frames:
                f0 = np.pad(f0, (0, expected_frames - len(f0)))
            mcep_sp2mc = extract_mcep_diffsptk(x, fs, f0, device)
            mcep_direct = extract_mcep_diffsptk_direct(x, fs, f0, device)
        except Exception as e:
            print(f"    [SKIP] {fname}: {type(e).__name__}: {str(e)[:80]}")
            continue

        minlen = min(mcep_sp2mc.shape[0], mcep_direct.shape[0], len(f0))
        all_mcep_sp2mc.append(mcep_sp2mc[:minlen])
        all_mcep_direct.append(mcep_direct[:minlen])
        all_f0.append(f0[:minlen])
        f0_nz = np.count_nonzero(f0)
        print(f"    {fname}: mcep_sp2mc={mcep_sp2mc.shape}, mcep_direct={mcep_direct.shape}, "
              f"f0_voiced={f0_nz}/{len(f0)} ({f0_nz/len(f0)*100:.1f}%)")

    mcep_sp2mc = np.concatenate(all_mcep_sp2mc, axis=0)
    mcep_direct = np.concatenate(all_mcep_direct, axis=0)
    f0 = np.concatenate(all_f0, axis=0)

    print(f"\n[3] Distribution comparison (5 files, {mcep_sp2mc.shape[0]} frames):")
    print(f"    Method sp2mc (cheaptrick + manual freqt, 与 SiFiGAN 训练一致):")
    print(f"      mcep mean: range=[{mcep_sp2mc.mean(axis=0).min():.4f}, {mcep_sp2mc.mean(axis=0).max():.4f}]")
    print(f"      mcep overall: mean={mcep_sp2mc.mean():.4f}, std={mcep_sp2mc.std():.4f}")
    print(f"    Method direct (cheaptrick + MelCepstralAnalysis):")
    print(f"      mcep mean: range=[{mcep_direct.mean(axis=0).min():.4f}, {mcep_direct.mean(axis=0).max():.4f}]")
    print(f"      mcep overall: mean={mcep_direct.mean():.4f}, std={mcep_direct.std():.4f}")

    # 与 stats 对齐度评估（只用 voiced 帧，因为 SiFiGAN 训练可能也只用 voiced）
    voiced = f0 > 0
    print(f"\n[4] Alignment with SiFiGAN stats (all frames):")
    norm_sp2mc = (mcep_sp2mc - stats_mcep_mean) / stats_mcep_scale
    norm_direct = (mcep_direct - stats_mcep_mean) / stats_mcep_scale
    print(f"    sp2mc normalized: mean={norm_sp2mc.mean():.4f}, std={norm_sp2mc.std():.4f}, "
          f"frac|val|>5={np.mean(np.abs(norm_sp2mc) > 5)*100:.1f}%, >10={np.mean(np.abs(norm_sp2mc) > 10)*100:.1f}%")
    print(f"    direct normalized: mean={norm_direct.mean():.4f}, std={norm_direct.std():.4f}, "
          f"frac|val|>5={np.mean(np.abs(norm_direct) > 5)*100:.1f}%, >10={np.mean(np.abs(norm_direct) > 10)*100:.1f}%")

    print(f"\n[5] Alignment with SiFiGAN stats (voiced frames only, {voiced.sum()}/{len(voiced)}):")
    norm_sp2mc_v = (mcep_sp2mc[voiced] - stats_mcep_mean) / stats_mcep_scale
    norm_direct_v = (mcep_direct[voiced] - stats_mcep_mean) / stats_mcep_scale
    print(f"    sp2mc normalized: mean={norm_sp2mc_v.mean():.4f}, std={norm_sp2mc_v.std():.4f}, "
          f"frac|val|>5={np.mean(np.abs(norm_sp2mc_v) > 5)*100:.1f}%, >10={np.mean(np.abs(norm_sp2mc_v) > 10)*100:.1f}%")
    print(f"    direct normalized: mean={norm_direct_v.mean():.4f}, std={norm_direct_v.std():.4f}, "
          f"frac|val|>5={np.mean(np.abs(norm_direct_v) > 5)*100:.1f}%, >10={np.mean(np.abs(norm_direct_v) > 10)*100:.1f}%")

    score_sp2mc = np.mean(np.abs(norm_sp2mc_v))
    score_direct = np.mean(np.abs(norm_direct_v))
    print(f"\n[6] Recommendation (lower mean|normalized| is better):")
    print(f"    sp2mc: {score_sp2mc:.4f}")
    print(f"    direct: {score_direct:.4f}")


if __name__ == "__main__":
    main()
