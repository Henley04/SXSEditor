# -*- coding: utf-8 -*-
"""训练 SiFiGAN mel_proj MLP 版本，修复线性映射容量不足问题。

背景：
  线性 mel_proj (128->43) 在 PJS 100 文件上 L1=0.3066，5 文件 L1=0.3068，
  20 倍数据几乎无改善 -> 模型容量瓶颈，不是数据瓶颈。
  mel (频域 log-mel) 与 mcep (倒谱域) 之间是非线性关系，纯线性映射到极限。

方案：
  1. 用 2 层 MLP (128->256->256->43, GELU+LayerNorm) 替换线性层
  2. 数据：PJS 100 文件 + GTSinger 200 文件（48kHz->24kHz 重采样）
  3. 训练目标不变：归一化空间 mcep(40) + bap(0)
  4. 保存整个 MLP 的 state_dict，后续重新导出 ONNX
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

# MLP 参数
HIDDEN_DIM = 256
DROPOUT = 0.1

# 训练参数
BATCH_FRAMES = 8192
EPOCHS = 200
LR = 5e-4  # MLP 用稍小 LR
WEIGHT_DECAY = 1e-4
PATIENCE = 20
MIN_DELTA = 1e-5

# 数据路径
PJS_DIR = r"D:\Document\electron\SXSEditor\SoulX-Singer\train\lora_jp_v2\dataset\wavs"
GTSINGER_DIR = r"D:\download\GTSinger\Japanese"
STATS_PATH = r"D:\download\model+stats\libritts_r_clean+nus-48e_train_no_dev.joblib"
OUTPUT_DIR = r"D:\Document\electron\SXSEditor\scripts\mel_proj_train_output"
MLP_WEIGHT_PATH = os.path.join(OUTPUT_DIR, "mel_proj_mlp.pt")
MLP_LOG_PATH = os.path.join(OUTPUT_DIR, "mlp_train_log.txt")
GTSINGER_MAX_FILES = 200  # 限制 GTSinger 文件数


# ===================== MLP 定义 =====================
class MelProjMLP(nn.Module):
    """mel (128) -> c (43) 残差非线性映射。

    结构: y = linear(x) + mlp_residual(x)
      - linear: 线性主干 (128->43)，用最小二乘初始化
      - mlp_residual: 非线性残差 (128->256->256->43)，最后一层 0 初始化

    设计理由:
      - 初始时 mlp_residual=0，y=linear(x)，与纯线性映射等价 (L1≈0.307)
      - 通过训练学习非线性残差，只能改善不能变差
      - 避免 MLP 从随机初始化开始收敛慢的问题
    """
    def __init__(self, in_dim=SVS_NUM_MELS, hidden_dim=HIDDEN_DIM, out_dim=TOTAL_DIM, dropout=DROPOUT):
        super().__init__()
        # 线性主干
        self.linear = nn.Linear(in_dim, out_dim, bias=False)
        # 非线性残差
        self.residual = nn.Sequential(
            nn.Linear(in_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, out_dim),
        )
        # 残差最后一层 0 初始化（初始输出 0，y=linear(x)）
        nn.init.zeros_(self.residual[-1].weight)
        nn.init.zeros_(self.residual[-1].bias)

    def forward(self, x):
        return self.linear(x) + self.residual(x)


# ===================== SVS mel 提取（与 mel_transform.py 一致）=====================
def make_mel_basis(sr, n_fft, num_mels, fmin, fmax):
    mel = librosa_mel_fn(sr=sr, n_fft=n_fft, n_mels=num_mels, fmin=fmin, fmax=fmax)
    return torch.from_numpy(mel).float()


def extract_svs_mel(x, sr, mel_basis, hann_window, device="cuda"):
    """提取 SVS mel，与 SoulX-Singer MelSpectrogram 一致。"""
    x_t = torch.from_numpy(x).float().to(device).unsqueeze(0)
    pad = (SVS_N_FFT - SVS_HOP) // 2
    x_t = torch.nn.functional.pad(x_t.unsqueeze(1), (pad, pad), mode="reflect").squeeze(1)

    spec = torch.stft(
        x_t, SVS_N_FFT, hop_length=SVS_HOP, win_length=SVS_WIN,
        window=hann_window, center=False, pad_mode="reflect",
        normalized=False, onesided=True, return_complex=True,
    )
    spec = torch.view_as_real(spec)
    spec = torch.sqrt(spec.pow(2).sum(-1) + 1e-9)
    spec = torch.matmul(mel_basis, spec)
    spec = torch.log(torch.clamp(spec, min=1e-5))

    spec = (spec - SVS_MEL_MEAN) / (SVS_MEL_VAR ** 0.5)
    return spec.squeeze(0).transpose(0, 1)  # (T_frames, 128)


# ===================== mcep 提取（diffsptk 方案A）=====================
def extract_mcep(x, sr, f0, device="cuda"):
    """提取 mcep，与 SiFiGAN 训练分布对齐。"""
    x_t = torch.from_numpy(x).float().to(device).unsqueeze(0)
    f0_t = torch.from_numpy(f0).float().to(device).unsqueeze(0)

    spec_module = diffsptk.PitchAdaptiveSpectralAnalysis(
        frame_period=SIFIGAN_HOP, sample_rate=sr, fft_length=SIFIGAN_FFT,
        algorithm="cheap-trick", out_format="power", default_f0=150, device=device,
    )
    with torch.no_grad():
        env = spec_module(x_t, f0_t).squeeze(0)

    mcep_analyzer = diffsptk.MelCepstralAnalysis(
        fft_length=SIFIGAN_FFT, cep_order=MCEP_DIM, alpha=ALPHA, n_iter=0, device=device,
    )
    with torch.no_grad():
        mcep = mcep_analyzer(env)

    return mcep


def extract_f0_pyin(x, sr):
    """librosa.pyin 提取 f0，帧率 = sr/hop = 200Hz。"""
    f0, voiced, _ = librosa.pyin(
        x, fmin=100, fmax=840, sr=sr,
        frame_length=2048, hop_length=SIFIGAN_HOP,
        fill_na=0.0,
    )
    return f0


# ===================== 数据预处理 =====================
def process_one_file(wav_path, mel_basis, hann_window, device, stats_mcep_mean_t, stats_mcep_scale_t):
    """处理单个文件，返回 (svs_mel, target_43) 对齐到 50Hz。

    支持任意采样率，自动重采样到 24kHz。
    """
    x, sr = sf.read(wav_path)
    # 重采样到 24kHz
    if sr != SVS_SR:
        x = librosa.resample(x.astype(np.float64), orig_sr=sr, target_sr=SVS_SR)
        sr = SVS_SR
    else:
        x = x.astype(np.float64)

    # 单声道
    if x.ndim > 1:
        x = x.mean(axis=1)

    # 截断到 SIFIGAN_HOP 整数倍
    x = x[: len(x) // SIFIGAN_HOP * SIFIGAN_HOP]
    if len(x) < SIFIGAN_HOP * 20:  # 至少 20 帧
        return None

    # 1. 提取 SVS mel (50Hz)
    svs_mel = extract_svs_mel(x, sr, mel_basis, hann_window, device)

    # 2. 提取 mcep (200Hz)
    f0 = extract_f0_pyin(x, sr)
    expected_mcep_frames = len(x) // SIFIGAN_HOP
    if len(f0) > expected_mcep_frames:
        f0 = f0[:expected_mcep_frames]
    elif len(f0) < expected_mcep_frames:
        f0 = np.pad(f0, (0, expected_mcep_frames - len(f0)))

    try:
        mcep = extract_mcep(x, sr, f0, device)
    except Exception:
        return None

    # 3. 对齐到 50Hz
    T_mel = svs_mel.shape[0]
    T_mcep = mcep.shape[0]
    T_align = min(T_mel, T_mcep // 4)
    if T_align < 10:
        return None

    svs_mel = svs_mel[:T_align]
    mcep = mcep[:T_align * 4]
    mcep_50hz = mcep.reshape(T_align, 4, 40).mean(dim=1)

    # 4. 构造目标 (43)：归一化 mcep(40) + 0(3)
    mcep_norm = (mcep_50hz - stats_mcep_mean_t) / stats_mcep_scale_t
    bap = torch.zeros(T_align, BAP_DIM, device=device)
    target = torch.cat([mcep_norm, bap], dim=1)

    # 检查 NaN（GTSinger 某些音频可能产生 NaN mcep）
    if torch.isnan(target).any() or torch.isinf(target).any():
        return None

    return svs_mel.cpu().numpy(), target.cpu().numpy()


def collect_gtsinger_files(root_dir, max_files):
    """递归收集 GTSinger wav 文件。"""
    files = []
    for dirpath, _, fnames in os.walk(root_dir):
        for f in fnames:
            if f.endswith(".wav"):
                files.append(os.path.join(dirpath, f))
                if len(files) >= max_files:
                    return files
    return files


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}")
    if device == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")

    # 加载 stats
    print(f"\n[1] Loading stats: {STATS_PATH}")
    scaler = load(STATS_PATH)
    stats_mcep_mean = np.asarray(scaler["mcep"].mean_)
    stats_mcep_scale = np.asarray(scaler["mcep"].scale_)
    print(f"    stats mcep mean: range=[{stats_mcep_mean.min():.4f}, {stats_mcep_mean.max():.4f}]")

    # 准备 mel basis 和 hann window
    print(f"\n[2] Preparing mel basis and hann window...")
    mel_basis = make_mel_basis(SVS_SR, SVS_N_FFT, SVS_NUM_MELS, SVS_FMIN, SVS_FMAX).to(device)
    hann_window = torch.hann_window(SVS_WIN).to(device)

    stats_mcep_mean_t = torch.from_numpy(stats_mcep_mean).float().to(device)
    stats_mcep_scale_t = torch.from_numpy(stats_mcep_scale).float().to(device)

    # 收集文件
    pjs_files = sorted([os.path.join(PJS_DIR, f) for f in os.listdir(PJS_DIR) if f.endswith(".wav")])
    gt_files = collect_gtsinger_files(GTSINGER_DIR, GTSINGER_MAX_FILES)

    if "--full" not in sys.argv:
        pjs_files = pjs_files[:5]
        gt_files = gt_files[:5]
        print(f"\n[3] Small test mode: PJS={len(pjs_files)}, GTSinger={len(gt_files)}")
    else:
        print(f"\n[3] Full mode: PJS={len(pjs_files)}, GTSinger={len(gt_files)}")

    all_files = [("PJS", f) for f in pjs_files] + [("GTS", f) for f in gt_files]

    all_mel = []
    all_target = []
    t0 = time.time()
    skip_count = 0
    for i, (tag, path) in enumerate(all_files):
        result = process_one_file(path, mel_basis, hann_window, device, stats_mcep_mean_t, stats_mcep_scale_t)
        if result is None:
            skip_count += 1
            continue
        mel, target = result
        all_mel.append(mel)
        all_target.append(target)
        if (i + 1) % 20 == 0 or i == 0:
            elapsed = time.time() - t0
            eta = elapsed / (i + 1) * (len(all_files) - i - 1)
            print(f"    [{i+1}/{len(all_files)}] {tag}/{os.path.basename(path)}: "
                  f"mel={mel.shape}, elapsed={elapsed:.0f}s, eta={eta:.0f}s, skip={skip_count}")

    mel_data = np.concatenate(all_mel, axis=0)
    target_data = np.concatenate(all_target, axis=0)

    # 保险：过滤包含 NaN/Inf 的帧（防止训练 loss 变 NaN）
    valid_mask = np.isfinite(mel_data).all(axis=1) & np.isfinite(target_data).all(axis=1)
    if not valid_mask.all():
        n_invalid = (~valid_mask).sum()
        print(f"    [WARN] 过滤 {n_invalid} 个含 NaN/Inf 的帧")
        mel_data = mel_data[valid_mask]
        target_data = target_data[valid_mask]

    print(f"\n[4] Total data: mel={mel_data.shape}, target={target_data.shape}, "
          f"skip={skip_count}, time={time.time()-t0:.0f}s")

    # 数据统计
    print(f"\n[5] Data stats:")
    print(f"    SVS mel: mean={mel_data.mean():.4f}, std={mel_data.std():.4f}")
    print(f"    target mcep(0:40) [norm]: mean={target_data[:, :40].mean():.4f}, "
          f"std={target_data[:, :40].std():.4f}, "
          f"frac|val|>5={np.mean(np.abs(target_data[:, :40]) > 5)*100:.1f}%")

    # 保存数据
    np.save(os.path.join(OUTPUT_DIR, "mlp_mel_data.npy"), mel_data)
    np.save(os.path.join(OUTPUT_DIR, "mlp_target_data.npy"), target_data)

    # ===================== 训练 MLP =====================
    print(f"\n[6] Training MelProjMLP ({SVS_NUM_MELS}->{HIDDEN_DIM}->{HIDDEN_DIM}->{TOTAL_DIM})...")

    mel_t = torch.from_numpy(mel_data).float().to(device)
    target_t = torch.from_numpy(target_data).float().to(device)

    model = MelProjMLP().to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"    Parameters: {n_params} ({n_params/1e3:.1f}K)")

    # 用线性最小二乘初始化线性主干（残差已 0 初始化，初始 y=linear(x)）
    print(f"    Initializing linear backbone with least-squares...")
    with torch.no_grad():
        X = mel_t
        Y = target_t
        XtX = X.t() @ X + 1e-4 * torch.eye(SVS_NUM_MELS, device=device)
        XtY = X.t() @ Y
        W_init = torch.linalg.solve(XtX, XtY)  # (128, 43)
        model.linear.weight.copy_(W_init.t())  # nn.Linear weight shape: (43, 128)

    # 验证初始化（应与纯线性映射等价）
    model.eval()
    with torch.no_grad():
        pred_init = model(mel_t)
        loss_init = torch.nn.functional.l1_loss(pred_init, target_t).item()
    print(f"    Init L1 loss: {loss_init:.6f} (应接近纯线性解 0.307)")
    model.train()

    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode="min", factor=0.5, patience=10, min_lr=1e-6
    )

    N = mel_t.shape[0]
    best_loss = float("inf")
    best_state = None
    no_improve = 0
    log_lines = []

    for epoch in range(EPOCHS):
        model.train()
        perm = torch.randperm(N, device=device)
        epoch_loss = 0.0
        n_batches = 0
        for start in range(0, N, BATCH_FRAMES):
            end = min(start + BATCH_FRAMES, N)
            idx = perm[start:end]
            x_batch = mel_t[idx]
            y_batch = target_t[idx]
            pred = model(x_batch)
            loss = torch.nn.functional.l1_loss(pred, y_batch)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            epoch_loss += loss.item()
            n_batches += 1

        avg_loss = epoch_loss / n_batches
        scheduler.step(avg_loss)

        with torch.no_grad():
            pred_all = model(mel_t)
            full_loss = torch.nn.functional.l1_loss(pred_all, target_t).item()
            mcep_l1 = torch.nn.functional.l1_loss(pred_all[:, :40], target_t[:, :40]).item()
            in_range = torch.mean((torch.abs(pred_all[:, :40]) <= 5).float()).item()

        log_line = f"Epoch {epoch+1:3d}/{EPOCHS}: loss={avg_loss:.6f}, full={full_loss:.6f}, mcep_l1={mcep_l1:.4f}, in_range={in_range*100:.1f}%, lr={optimizer.param_groups[0]['lr']:.2e}"
        log_lines.append(log_line)
        if (epoch + 1) % 10 == 0 or epoch == 0:
            print(f"    {log_line}")

        if full_loss < best_loss - MIN_DELTA:
            best_loss = full_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            no_improve = 0
        else:
            no_improve += 1
            if no_improve >= PATIENCE:
                print(f"    Early stop at epoch {epoch+1}, best_loss={best_loss:.6f}")
                break

    if best_state is not None:
        model.load_state_dict(best_state)

    # 保存整个 MLP state_dict
    torch.save({
        "state_dict": model.state_dict(),
        "config": {
            "in_dim": SVS_NUM_MELS, "hidden_dim": HIDDEN_DIM,
            "out_dim": TOTAL_DIM, "dropout": DROPOUT,
        },
        "best_loss": best_loss,
    }, MLP_WEIGHT_PATH)
    print(f"\n[7] Saved MLP weight: {MLP_WEIGHT_PATH}")

    # 最终验证
    model.eval()
    with torch.no_grad():
        pred = model(mel_t)
        loss = torch.nn.functional.l1_loss(pred, target_t).item()
        mcep_l1 = torch.nn.functional.l1_loss(pred[:, :40], target_t[:, :40]).item()
        in_range = torch.mean((torch.abs(pred[:, :40]) <= 5).float()).item()
    print(f"\n[8] Final validation:")
    print(f"    L1 loss: {loss:.6f}")
    print(f"    mcep L1 (normalized): {mcep_l1:.4f}")
    print(f"    mcep in [-5, 5]: {in_range*100:.1f}%")

    with open(MLP_LOG_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines))
    print(f"    Train log: {MLP_LOG_PATH}")

    print(f"\n[9] Done. Next step: re-export ONNX with MLP mel_proj")
    print(f"    python scripts/export_sifigan_with_mlp.py")


if __name__ == "__main__":
    main()
