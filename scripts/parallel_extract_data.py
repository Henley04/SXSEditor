# -*- coding: utf-8 -*-
"""并行提取 mel_proj 训练数据（PJS + GTSinger 全量）。

流水线设计（消除 GPU 空闲）：
  - 8 个 CPU 线程并行：IO + librosa.resample + librosa.pyin（主要瓶颈，释放 GIL）
  - 1 个 GPU 线程串行：extract_svs_mel (STFT) + extract_mcep (diffsptk)
  - queue 连接，CPU 准备好就立即送 GPU，GPU 不再等 pyin

对比原串行版本：
  - 原版 200 文件 ~60min，GPU 利用率 ~30%
  - 并行版 2932 文件预期 ~3-4h，GPU 利用率 ~80%+

输出：
  scripts/mel_proj_train_output/mlp_mel_data.npy
  scripts/mel_proj_train_output/mlp_target_data.npy
"""
import os
import sys
import time
import queue
import threading
import numpy as np
import soundfile as sf
import torch
import librosa
import diffsptk
from librosa.filters import mel as librosa_mel_fn
from joblib import load

# 复用训练脚本的参数和提取函数
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from train_mel_proj_mlp import (
    SVS_SR, SVS_N_FFT, SVS_HOP, SVS_WIN, SVS_NUM_MELS, SVS_FMIN, SVS_FMAX,
    SVS_MEL_MEAN, SVS_MEL_VAR, SIFIGAN_HOP, SIFIGAN_FFT, MCEP_DIM, ALPHA, BAP_DIM, TOTAL_DIM,
    PJS_DIR, GTSINGER_DIR, STATS_PATH, OUTPUT_DIR,
    make_mel_basis, extract_svs_mel, extract_mcep, extract_f0_pyin, collect_gtsinger_files,
)

# ===================== 并行参数 =====================
NUM_CPU_WORKERS = 8          # CPU 线程数（IO + resample + pyin）
GPU_QUEUE_MAXSIZE = 16       # GPU 队列最大长度（限制内存，每个 item ~10-50MB）
PROGRESS_INTERVAL = 50       # 每 N 个文件报告一次进度

# GTSinger 文件数限制（None = 全部）
GTSINGER_MAX_FILES = None  # 用全部 2832 个文件


# ===================== CPU 预处理（释放 GIL，适合多线程）=====================
def cpu_preprocess(wav_path):
    """CPU 部分：IO + resample + pyin。

    librosa.pyin 是主要瓶颈（单文件 0.5-2s），且释放 GIL，
    8 线程并行可加速 ~6-7x（受 CPU 核心数限制）。
    """
    try:
        x, sr = sf.read(wav_path)
    except Exception:
        return None

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

    # pyin 提取 f0（200Hz，与 mcep 帧率对齐）
    f0 = extract_f0_pyin(x, sr)
    expected_mcep_frames = len(x) // SIFIGAN_HOP
    if len(f0) > expected_mcep_frames:
        f0 = f0[:expected_mcep_frames]
    elif len(f0) < expected_mcep_frames:
        f0 = np.pad(f0, (0, expected_mcep_frames - len(f0)))

    return (wav_path, x, sr, f0)


# ===================== GPU 处理（串行，但无空闲）=====================
def gpu_process(item, mel_basis, hann_window, device, stats_mcep_mean_t, stats_mcep_scale_t):
    """GPU 部分：svs_mel + mcep + 对齐到 50Hz + 构造 target(43)。"""
    if item is None:
        return None
    wav_path, x, sr, f0 = item

    # 1. SVS mel (50Hz, 128 dim)
    svs_mel = extract_svs_mel(x, sr, mel_basis, hann_window, device)

    # 2. mcep (200Hz, 40 dim)
    try:
        mcep = extract_mcep(x, sr, f0, device)
    except Exception:
        return None

    # 3. 对齐到 50Hz（mcep 4 帧平均 → 1 帧）
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

    # NaN 检查（GTSinger 某些音频可能产生 NaN mcep）
    if torch.isnan(target).any() or torch.isinf(target).any():
        return None

    return svs_mel.cpu().numpy(), target.cpu().numpy()


# ===================== 并行流水线 =====================
def parallel_extract(all_files, mel_basis, hann_window, device, stats_mcep_mean_t, stats_mcep_scale_t):
    """流水线：8 CPU 线程 → queue → 1 GPU 线程消费。

    Args:
        all_files: [(tag, path), ...]

    Returns:
        all_mel: [np.ndarray (T, 128), ...]
        all_target: [np.ndarray (T, 43), ...]
        skip_count: 被跳过的文件数
    """
    work_queue = queue.Queue()
    for tag, path in all_files:
        work_queue.put((tag, path))

    gpu_queue = queue.Queue(maxsize=GPU_QUEUE_MAXSIZE)
    all_results = []
    stats_lock = threading.Lock()
    processed = [0]
    skipped = [0]
    t0 = time.time()
    total = len(all_files)

    SENTINEL = ("__SENTINEL__", None, None)

    def cpu_worker():
        """CPU 线程：从 work_queue 取文件，处理后放 gpu_queue。"""
        while True:
            try:
                tag, path = work_queue.get_nowait()
            except queue.Empty:
                return
            try:
                item = cpu_preprocess(path)
                gpu_queue.put((tag, path, item))
            except Exception as e:
                # 异常文件标记为 None，让 GPU 消费者计数 skip
                gpu_queue.put((tag, path, None))

    def gpu_consumer():
        """GPU 线程：从 gpu_queue 取数据，做 STFT + mcep。"""
        while True:
            tag, path, item = gpu_queue.get()
            if tag == "__SENTINEL__":
                return
            try:
                result = gpu_process(item, mel_basis, hann_window, device,
                                     stats_mcep_mean_t, stats_mcep_scale_t)
            except Exception:
                result = None

            with stats_lock:
                processed[0] += 1
                if result is None:
                    skipped[0] += 1
                else:
                    all_results.append(result)

                # 进度报告
                n = processed[0]
                if n % PROGRESS_INTERVAL == 0 or n == total:
                    elapsed = time.time() - t0
                    rate = n / max(elapsed, 0.1)
                    eta = (total - n) / max(rate, 0.01)
                    gpu_q = gpu_queue.qsize()
                    work_q = work_queue.qsize()
                    print(f"    [{n}/{total}] rate={rate:.1f}files/s, skip={skipped[0]}, "
                          f"elapsed={elapsed:.0f}s, eta={eta:.0f}s, "
                          f"gpu_queue={gpu_q}, work_queue={work_q}")

    # 启动 CPU workers
    cpu_threads = [threading.Thread(target=cpu_worker, daemon=True) for _ in range(NUM_CPU_WORKERS)]
    for t in cpu_threads:
        t.start()

    # 启动 GPU consumer
    gpu_thread = threading.Thread(target=gpu_consumer, daemon=True)
    gpu_thread.start()

    # 等待 CPU 完成
    for t in cpu_threads:
        t.join()

    # 发送 sentinel 通知 GPU consumer 结束
    gpu_queue.put(SENTINEL)
    gpu_thread.join()

    # 分离 mel 和 target
    all_mel = [r[0] for r in all_results]
    all_target = [r[1] for r in all_results]

    elapsed = time.time() - t0
    print(f"\n    Done: {processed[0]} files, {skipped[0]} skipped, "
          f"{len(all_results)} valid, elapsed={elapsed:.0f}s "
          f"({processed[0]/elapsed:.1f} files/s)")

    return all_mel, all_target, skipped[0]


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print("=" * 60)
    print("Parallel data extraction for mel_proj MLP training")
    print("=" * 60)
    print(f"Device: {device}")
    if device == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")
    print(f"CPU workers: {NUM_CPU_WORKERS}")
    print(f"GPU queue maxsize: {GPU_QUEUE_MAXSIZE}")

    # 1. 加载 stats
    print(f"\n[1] Loading stats: {STATS_PATH}")
    scaler = load(STATS_PATH)
    stats_mcep_mean = np.asarray(scaler["mcep"].mean_)
    stats_mcep_scale = np.asarray(scaler["mcep"].scale_)
    print(f"    stats mcep mean: range=[{stats_mcep_mean.min():.4f}, {stats_mcep_mean.max():.4f}]")

    # 2. 准备 mel basis 和 hann window
    print(f"\n[2] Preparing mel basis and hann window...")
    mel_basis = make_mel_basis(SVS_SR, SVS_N_FFT, SVS_NUM_MELS, SVS_FMIN, SVS_FMAX).to(device)
    hann_window = torch.hann_window(SVS_WIN).to(device)
    stats_mcep_mean_t = torch.from_numpy(stats_mcep_mean).float().to(device)
    stats_mcep_scale_t = torch.from_numpy(stats_mcep_scale).float().to(device)

    # 3. 收集文件（全量）
    print(f"\n[3] Collecting files...")
    pjs_files = sorted([os.path.join(PJS_DIR, f) for f in os.listdir(PJS_DIR) if f.endswith(".wav")])
    if GTSINGER_MAX_FILES is None:
        gt_files = collect_gtsinger_files(GTSINGER_DIR, 10**9)  # 不限制
    else:
        gt_files = collect_gtsinger_files(GTSINGER_DIR, GTSINGER_MAX_FILES)
    print(f"    PJS: {len(pjs_files)} files")
    print(f"    GTSinger: {len(gt_files)} files (all)")
    print(f"    Total: {len(pjs_files) + len(gt_files)} files")

    all_files = [("PJS", f) for f in pjs_files] + [("GTS", f) for f in gt_files]

    # 4. 并行提取
    print(f"\n[4] Parallel extraction (CPU={NUM_CPU_WORKERS}, GPU=1)...")
    all_mel, all_target, skip_count = parallel_extract(
        all_files, mel_basis, hann_window, device, stats_mcep_mean_t, stats_mcep_scale_t
    )

    if not all_mel:
        print("[ERROR] No valid data extracted!")
        sys.exit(1)

    # 5. 拼接 + 过滤 NaN
    print(f"\n[5] Concatenating {len(all_mel)} arrays...")
    mel_data = np.concatenate(all_mel, axis=0)
    target_data = np.concatenate(all_target, axis=0)

    # 保险：过滤包含 NaN/Inf 的帧
    valid_mask = np.isfinite(mel_data).all(axis=1) & np.isfinite(target_data).all(axis=1)
    if not valid_mask.all():
        n_invalid = (~valid_mask).sum()
        print(f"    [WARN] 过滤 {n_invalid} 个含 NaN/Inf 的帧")
        mel_data = mel_data[valid_mask]
        target_data = target_data[valid_mask]

    print(f"\n[6] Final data:")
    print(f"    mel:    {mel_data.shape} ({mel_data.nbytes/1024/1024:.1f} MB)")
    print(f"    target: {target_data.shape} ({target_data.nbytes/1024/1024:.1f} MB)")
    print(f"    skip:   {skip_count} files")

    # 数据统计
    print(f"\n[7] Data stats:")
    print(f"    SVS mel: mean={mel_data.mean():.4f}, std={mel_data.std():.4f}")
    print(f"    target mcep(0:40) [norm]: mean={target_data[:, :40].mean():.4f}, "
          f"std={target_data[:, :40].std():.4f}, "
          f"frac|val|>5={np.mean(np.abs(target_data[:, :40]) > 5)*100:.1f}%")

    # 保存
    mel_path = os.path.join(OUTPUT_DIR, "mlp_mel_data.npy")
    target_path = os.path.join(OUTPUT_DIR, "mlp_target_data.npy")
    np.save(mel_path, mel_data)
    np.save(target_path, target_data)
    print(f"\n[8] Saved:")
    print(f"    {mel_path} ({mel_data.nbytes/1024/1024:.1f} MB)")
    print(f"    {target_path} ({target_data.nbytes/1024/1024:.1f} MB)")

    print(f"\n{'='*60}")
    print(f"Next: python scripts/retrain_mlp_from_data.py")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
