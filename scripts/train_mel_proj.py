# -*- coding: utf-8 -*-
"""训练 SiFiGAN mel_proj 权重，修复随机初始化导致的电流声。

方案：
  1. 从 PJS 歌声数据提取 SVS mel（128维, 50Hz, hop=480, n_fft=1920, 与 JS 管线一致）
  2. 从同段音频提取 mcep（40维, 200Hz, hop=120, diffsptk MelCepstralAnalysis, 与 SiFiGAN stats 对齐）
  3. mcep 4× 下采样到 50Hz 与 SVS mel 对齐（取每 4 帧平均）
  4. bap(3维) 用 0 填充（保守值，落在 SiFiGAN bap 分布中心）
  5. 训练 mel_proj = nn.Linear(128, 43, bias=False)：
     - 输入：SVS mel (128)
     - 目标：mcep(40) + bap(0) = (43)
     - 损失：L1 loss，前 40 维用 mcep 真值，后 3 维用 0
  6. 保存权重为 .npy，后续替换 ONNX 中的 mel_proj initializer

mel_proj 是逐帧线性变换，50Hz 训练与 200Hz 推理数学等价（每帧独立变换）。
"""
import os
import sys
import time
import numpy as np
import soundfile as sf
import torch
import torch.nn as nn
import librosa
import diffsptk
from librosa.filters import mel as librosa_mel_fn
from joblib import load

# ===================== 参数 =====================
# SVS mel 参数（与 SoulX-Singer mel_transform.py / JS pipeline 一致）
SVS_SR = 24000
SVS_N_FFT = 1920
SVS_HOP = 480  # 50Hz
SVS_WIN = 1920
SVS_NUM_MELS = 128
SVS_FMIN = 0
SVS_FMAX = 12000
SVS_MEL_MEAN = -4.92
SVS_MEL_VAR = 8.14

# SiFiGAN mcep 参数（与 SiFiGAN 训练 stats 对齐）
SIFIGAN_SR = 24000
SIFIGAN_HOP = 120  # 200Hz
SIFIGAN_FFT = 1024
MCEP_DIM = 39  # order，输出 40 维
ALPHA = 0.466
BAP_DIM = 3
TOTAL_DIM = MCEP_DIM + 1 + BAP_DIM  # 40 + 3 = 43

# 训练参数
BATCH_FRAMES = 8192  # 每批帧数
EPOCHS = 100
LR = 1e-3  # 最小二乘已接近最优，用小 LR 微调
WEIGHT_DECAY = 1e-4
PATIENCE = 15
MIN_DELTA = 1e-5

# 数据与输出路径
PJS_DIR = r"D:\Document\electron\SXSEditor\SoulX-Singer\train\lora_jp_v2\dataset\wavs"
STATS_PATH = r"D:\download\model+stats\libritts_r_clean+nus-48e_train_no_dev.joblib"
OUTPUT_DIR = r"D:\Document\electron\SXSEditor\scripts\mel_proj_train_output"
MEL_PROJ_WEIGHT_PATH = os.path.join(OUTPUT_DIR, "mel_proj_weight.npy")
TRAIN_LOG_PATH = os.path.join(OUTPUT_DIR, "train_log.txt")


# ===================== SVS mel 提取（与 mel_transform.py 一致）=====================
def make_mel_basis(sr, n_fft, num_mels, fmin, fmax):
    mel = librosa_mel_fn(sr=sr, n_fft=n_fft, n_mels=num_mels, fmin=fmin, fmax=fmax)
    return torch.from_numpy(mel).float()


def extract_svs_mel(x, sr, mel_basis, hann_window, device="cuda"):
    """提取 SVS mel，与 SoulX-Singer MelSpectrogram 一致。

    参数与 mel_transform.py 完全对齐：
      - n_fft=1920, hop=480, win=1920, fmin=0, fmax=12000, num_mels=128
      - center=False, reflect padding (n_fft-hop)/2 每侧
      - sqrt(spec^2 + 1e-9) → mel_basis → log(clamp(x, 1e-5))
      - 归一化：(x - mean) / sqrt(var)
    """
    x_t = torch.from_numpy(x).float().to(device).unsqueeze(0)  # (1, T)
    # reflect padding (n_fft - hop) / 2 每侧
    pad = (SVS_N_FFT - SVS_HOP) // 2
    x_t = torch.nn.functional.pad(x_t.unsqueeze(1), (pad, pad), mode="reflect").squeeze(1)

    spec = torch.stft(
        x_t, SVS_N_FFT, hop_length=SVS_HOP, win_length=SVS_WIN,
        window=hann_window, center=False, pad_mode="reflect",
        normalized=False, onesided=True, return_complex=True,
    )
    spec = torch.view_as_real(spec)
    spec = torch.sqrt(spec.pow(2).sum(-1) + 1e-9)  # (1, num_mels, T_frames)
    spec = torch.matmul(mel_basis, spec)  # (1, 128, T_frames)
    spec = torch.log(torch.clamp(spec, min=1e-5))  # log mel

    # 归一化
    spec = (spec - SVS_MEL_MEAN) / (SVS_MEL_VAR ** 0.5)
    return spec.squeeze(0).transpose(0, 1)  # (T_frames, 128)


# ===================== mcep 提取（diffsptk 方案A，与 SiFiGAN stats 对齐）=====================
def extract_mcep(x, sr, f0, device="cuda"):
    """提取 mcep，与 SiFiGAN 训练分布对齐。

    流程：librosa.pyin(f0) → diffsptk.PitchAdaptiveSpectralAnalysis(cheap-trick) → MelCepstralAnalysis
    输出：mcep (T_mcep, 40)，T_mcep ≈ T / 120 (200Hz)
    """
    x_t = torch.from_numpy(x).float().to(device).unsqueeze(0)  # (1, T)
    f0_t = torch.from_numpy(f0).float().to(device).unsqueeze(0)  # (1, T_mcep)

    spec_module = diffsptk.PitchAdaptiveSpectralAnalysis(
        frame_period=SIFIGAN_HOP, sample_rate=sr, fft_length=SIFIGAN_FFT,
        algorithm="cheap-trick", out_format="power", default_f0=150, device=device,
    )
    with torch.no_grad():
        env = spec_module(x_t, f0_t).squeeze(0)  # (T_mcep, 513)

    mcep_analyzer = diffsptk.MelCepstralAnalysis(
        fft_length=SIFIGAN_FFT, cep_order=MCEP_DIM, alpha=ALPHA, n_iter=0, device=device,
    )
    with torch.no_grad():
        mcep = mcep_analyzer(env)  # (T_mcep, 40)

    return mcep


def extract_f0_pyin(x, sr):
    """librosa.pyin 提取 f0，帧率 = sr/hop = 200Hz。"""
    f0, voiced, _ = librosa.pyin(
        x, fmin=100, fmax=840, sr=sr,
        frame_length=2048, hop_length=SIFIGAN_HOP,
        fill_na=0.0,
    )
    return f0  # (T_mcep,)


# ===================== 数据预处理 =====================
def process_one_file(wav_path, mel_basis, hann_window, device, stats_mcep_mean_t, stats_mcep_scale_t):
    """处理单个文件，返回 (svs_mel, target_43) 对齐到 50Hz。

    stats_mcep_mean_t / stats_mcep_scale_t: 已转为 device 上的 torch tensor。
    """
    x, sr = sf.read(wav_path)
    if sr != SVS_SR:
        return None
    x = x.astype(np.float64)
    # 截断到 SIFIGAN_HOP 整数倍（cheaptrick 要求）
    x = x[: len(x) // SIFIGAN_HOP * SIFIGAN_HOP]

    # 1. 提取 SVS mel (50Hz)
    svs_mel = extract_svs_mel(x, sr, mel_basis, hann_window, device)  # (T_mel, 128)

    # 2. 提取 mcep (200Hz)
    f0 = extract_f0_pyin(x, sr)
    expected_mcep_frames = len(x) // SIFIGAN_HOP
    if len(f0) > expected_mcep_frames:
        f0 = f0[:expected_mcep_frames]
    elif len(f0) < expected_mcep_frames:
        f0 = np.pad(f0, (0, expected_mcep_frames - len(f0)))

    try:
        mcep = extract_mcep(x, sr, f0, device)  # (T_mcep, 40)
    except Exception as e:
        return None

    # 3. 对齐到 50Hz：mcep 4× 下采样（每 4 帧取平均），与 svs_mel 帧对齐
    T_mel = svs_mel.shape[0]
    T_mcep = mcep.shape[0]
    # svs_mel 帧数 = floor((T + 2*pad - win) / hop) + 1 ≈ T / hop
    # mcep 帧数 = T / 120
    # 比例 ≈ 4:1
    # 取 min(T_mel, T_mcep // 4) 帧
    T_align = min(T_mel, T_mcep // 4)
    if T_align < 10:
        return None

    svs_mel = svs_mel[:T_align]  # (T_align, 128)
    mcep = mcep[:T_align * 4]  # (T_align*4, 40)
    # 4× 下采样：reshape 并取平均
    mcep_50hz = mcep.reshape(T_align, 4, 40).mean(dim=1)  # (T_align, 40)

    # 4. 构造目标 (43)：归一化 mcep(40) + 0(3)
    # 关键：mel_proj 直接输出归一化后的特征（与 SiFiGAN generator 训练分布一致）
    # 后续 ONNX 中 feat_mean 设为 0、feat_scale 设为 1（mel_proj 已完成归一化）
    # bap 部分用 0（归一化后 = 0 = 分布中心，安全）
    mcep_norm = (mcep_50hz - stats_mcep_mean_t) / stats_mcep_scale_t  # (T_align, 40) 归一化
    bap = torch.zeros(T_align, BAP_DIM, device=device)  # (T_align, 3) 全 0
    target = torch.cat([mcep_norm, bap], dim=1)  # (T_align, 43)

    return svs_mel.cpu().numpy(), target.cpu().numpy()


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}")
    if device == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")

    # 加载 stats（用于后续验证，训练本身不需要）
    print(f"\n[1] Loading stats: {STATS_PATH}")
    scaler = load(STATS_PATH)
    stats_mcep_mean = np.asarray(scaler["mcep"].mean_)
    stats_mcep_scale = np.asarray(scaler["mcep"].scale_)
    print(f"    stats mcep mean: range=[{stats_mcep_mean.min():.4f}, {stats_mcep_mean.max():.4f}]")

    # 准备 mel basis 和 hann window
    print(f"\n[2] Preparing mel basis and hann window...")
    mel_basis = make_mel_basis(SVS_SR, SVS_N_FFT, SVS_NUM_MELS, SVS_FMIN, SVS_FMAX).to(device)
    hann_window = torch.hann_window(SVS_WIN).to(device)

    # stats 转 torch tensor
    stats_mcep_mean_t = torch.from_numpy(stats_mcep_mean).float().to(device)
    stats_mcep_scale_t = torch.from_numpy(stats_mcep_scale).float().to(device)

    # 处理所有 PJS 文件
    files = sorted([f for f in os.listdir(PJS_DIR) if f.endswith(".wav")])
    # 小规模验证：先用前 5 个文件
    if "--full" not in sys.argv:
        files = files[:5]
        print(f"\n[3] Processing {len(files)} PJS files (small test, use --full for all)...")
    else:
        print(f"\n[3] Processing {len(files)} PJS files...")

    all_mel = []
    all_target = []
    t0 = time.time()
    for i, fname in enumerate(files):
        path = os.path.join(PJS_DIR, fname)
        result = process_one_file(path, mel_basis, hann_window, device, stats_mcep_mean_t, stats_mcep_scale_t)
        if result is None:
            print(f"    [{i+1}/{len(files)}] {fname}: SKIP (process failed)")
            continue
        mel, target = result
        all_mel.append(mel)
        all_target.append(target)
        if (i + 1) % 10 == 0 or i == 0:
            elapsed = time.time() - t0
            eta = elapsed / (i + 1) * (len(files) - i - 1)
            print(f"    [{i+1}/{len(files)}] {fname}: mel={mel.shape}, target={target.shape}, "
                  f"elapsed={elapsed:.0f}s, eta={eta:.0f}s")

    mel_data = np.concatenate(all_mel, axis=0)  # (N, 128)
    target_data = np.concatenate(all_target, axis=0)  # (N, 43)
    print(f"\n[4] Total data: mel={mel_data.shape}, target={target_data.shape}, "
          f"time={time.time()-t0:.0f}s")

    # 数据统计
    print(f"\n[5] Data stats:")
    print(f"    SVS mel: mean={mel_data.mean():.4f}, std={mel_data.std():.4f}, "
          f"range=[{mel_data.min():.4f}, {mel_data.max():.4f}]")
    print(f"    target mcep(0:40) [已归一化]: mean={target_data[:, :40].mean():.4f}, "
          f"std={target_data[:, :40].std():.4f}, "
          f"frac|val|>5={np.mean(np.abs(target_data[:, :40]) > 5)*100:.1f}%")
    print(f"    target bap(40:43): mean={target_data[:, 40:].mean():.4f}, "
          f"std={target_data[:, 40:].std():.4f}")

    # 保存数据（便于复跑）
    np.save(os.path.join(OUTPUT_DIR, "mel_data.npy"), mel_data)
    np.save(os.path.join(OUTPUT_DIR, "target_data.npy"), target_data)
    print(f"    Saved mel_data.npy and target_data.npy")

    # ===================== 训练 mel_proj =====================
    print(f"\n[6] Training mel_proj (nn.Linear(128, 43, bias=False))...")

    mel_t = torch.from_numpy(mel_data).float().to(device)
    target_t = torch.from_numpy(target_data).float().to(device)

    # mel_proj 权重初始化：用最小二乘解初始化，加速收敛
    # 最小二乘：W = (X^T X)^-1 X^T Y
    print(f"    Initializing with least-squares solution...")
    X = mel_t  # (N, 128)
    Y = target_t  # (N, 43)
    # 加正则化避免奇异
    XtX = X.t() @ X + 1e-4 * torch.eye(128, device=device)
    XtY = X.t() @ Y
    W_init = torch.linalg.solve(XtX, XtY)  # (128, 43)

    mel_proj = nn.Linear(128, 43, bias=False).to(device)
    with torch.no_grad():
        mel_proj.weight.copy_(W_init.t())  # nn.Linear weight shape: (43, 128)

    # 验证初始化质量
    with torch.no_grad():
        pred_init = mel_proj(mel_t)
        loss_init = torch.nn.functional.l1_loss(pred_init, target_t).item()
    print(f"    Init L1 loss: {loss_init:.6f}")

    # 微调
    optimizer = torch.optim.AdamW(mel_proj.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode="min", factor=0.5, patience=10, min_lr=1e-5
    )

    N = mel_t.shape[0]
    best_loss = float("inf")
    best_state = None
    no_improve = 0
    log_lines = []

    for epoch in range(EPOCHS):
        mel_proj.train()
        # 随机打乱
        perm = torch.randperm(N, device=device)
        epoch_loss = 0.0
        n_batches = 0
        for start in range(0, N, BATCH_FRAMES):
            end = min(start + BATCH_FRAMES, N)
            idx = perm[start:end]
            x_batch = mel_t[idx]
            y_batch = target_t[idx]
            pred = mel_proj(x_batch)
            loss = torch.nn.functional.l1_loss(pred, y_batch)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            epoch_loss += loss.item()
            n_batches += 1

        avg_loss = epoch_loss / n_batches
        scheduler.step(avg_loss)

        # 验证全量数据 loss（目标已在归一化空间，loss 即 mcep_norm_l1）
        with torch.no_grad():
            pred_all = mel_proj(mel_t)
            full_loss = torch.nn.functional.l1_loss(pred_all, target_t).item()
            # mcep 部分单独统计
            mcep_l1 = torch.nn.functional.l1_loss(pred_all[:, :40], target_t[:, :40]).item()
            # 检查归一化后落在 [-5, 5] 的比例
            in_range = torch.mean((torch.abs(pred_all[:, :40]) <= 5).float()).item()

        log_line = f"Epoch {epoch+1:3d}/{EPOCHS}: loss={avg_loss:.6f}, full={full_loss:.6f}, mcep_l1={mcep_l1:.4f}, in_range={in_range*100:.1f}%, lr={optimizer.param_groups[0]['lr']:.2e}"
        log_lines.append(log_line)
        if (epoch + 1) % 10 == 0 or epoch == 0:
            print(f"    {log_line}")

        if full_loss < best_loss - MIN_DELTA:
            best_loss = full_loss
            best_state = {k: v.clone() for k, v in mel_proj.state_dict().items()}
            no_improve = 0
        else:
            no_improve += 1
            if no_improve >= PATIENCE:
                print(f"    Early stop at epoch {epoch+1}, best_loss={best_loss:.6f}")
                break

    # 恢复最优
    if best_state is not None:
        mel_proj.load_state_dict(best_state)

    # 保存权重
    with torch.no_grad():
        W = mel_proj.weight.detach().cpu().numpy()  # (43, 128)
    np.save(MEL_PROJ_WEIGHT_PATH, W)
    print(f"\n[7] Saved mel_proj weight: {MEL_PROJ_WEIGHT_PATH} (shape={W.shape})")

    # 最终验证
    with torch.no_grad():
        pred = mel_proj(mel_t)
        loss = torch.nn.functional.l1_loss(pred, target_t).item()
        mcep_l1 = torch.nn.functional.l1_loss(pred[:, :40], target_t[:, :40]).item()
        in_range = torch.mean((torch.abs(pred[:, :40]) <= 5).float()).item()
    print(f"\n[8] Final validation:")
    print(f"    L1 loss: {loss:.6f}")
    print(f"    mcep L1 (normalized): {mcep_l1:.4f}")
    print(f"    mcep in [-5, 5]: {in_range*100:.1f}%")

    # 保存训练日志
    with open(TRAIN_LOG_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines))
    print(f"    Train log: {TRAIN_LOG_PATH}")

    print(f"\n[9] Done. Next step: replace ONNX mel_proj weight with {MEL_PROJ_WEIGHT_PATH}")


if __name__ == "__main__":
    main()
