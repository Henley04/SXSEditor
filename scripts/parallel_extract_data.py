# -*- coding: utf-8 -*-
"""并行提取 mel_proj 训练数据（PJS + GTSinger 全量），多进程版。

架构（解决 GIL 竞争问题）:
  - 多进程 Pool (8 processes): IO + resample + pyin（每个进程独立 GIL）
  - 主进程: 批量 STFT + 串行 mcep（复用 diffsptk 模块，5ms/file）

优化要点:
  1. **多进程**: 消除 GIL 竞争，CPU 真正并行
  2. **只读 15s**: sf.read(frames=N) 避免读取整首歌
  3. **复用模块**: diffsptk 模块创建一次，741x 加速
  4. **批处理 STFT**: 一次 forward 处理 8 个文件

输出:
  scripts/mel_proj_train_output/mlp_mel_data.npy
  scripts/mel_proj_train_output/mlp_target_data.npy
"""
import os
import sys
import time
import numpy as np
import soundfile as sf
import torch
import librosa
import diffsptk
from librosa.filters import mel as librosa_mel_fn
from joblib import load
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import cpu_count

# 复用训练脚本的参数和函数
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from train_mel_proj_mlp import (
    SVS_SR, SVS_N_FFT, SVS_HOP, SVS_WIN, SVS_NUM_MELS, SVS_FMIN, SVS_FMAX,
    SVS_MEL_MEAN, SVS_MEL_VAR, SIFIGAN_HOP, SIFIGAN_FFT, MCEP_DIM, ALPHA, BAP_DIM, TOTAL_DIM,
    PJS_DIR, GTSINGER_DIR, STATS_PATH, OUTPUT_DIR,
    make_mel_basis, extract_f0_pyin, collect_gtsinger_files,
)

# ===================== 参数 =====================
NUM_WORKERS = min(8, cpu_count())
GPU_BATCH_SIZE = 8
PROGRESS_INTERVAL = 50
HEARTBEAT_INTERVAL = 30

GTSINGER_MAX_FILES = None  # 全部 2832

MAX_AUDIO_SECONDS = 15
MAX_AUDIO_SAMPLES = SVS_SR * MAX_AUDIO_SECONDS  # 360000

LOG_FILE = os.path.join(OUTPUT_DIR, "parallel_extract.log")


def log(msg):
    import sys
    sys.stdout.write(str(msg) + "\n")
    sys.stdout.flush()
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(str(msg) + "\n")
    except Exception:
        pass


# ===================== CPU 预处理（在子进程中执行）=====================
def cpu_preprocess(args):
    """在子进程中执行：IO + resample + pyin。

    返回 (wav_path, x_bytes, x_len, f0_bytes, f0_len) 用 bytes 传输避免 pickle 开销。
    """
    wav_path = args
    try:
        with sf.SoundFile(wav_path) as f:
            sr = f.samplerate
            n_read = int(MAX_AUDIO_SAMPLES * sr / SVS_SR)
            x = f.read(n_read, dtype='float64')
    except Exception:
        return None

    if x.ndim > 1:
        x = x.mean(axis=1)

    if sr != SVS_SR:
        x = librosa.resample(x, orig_sr=sr, target_sr=SVS_SR)

    x = x[: len(x) // SIFIGAN_HOP * SIFIGAN_HOP]
    if len(x) < SIFIGAN_HOP * 20:
        return None

    f0 = extract_f0_pyin(x, SVS_SR)
    expected = len(x) // SIFIGAN_HOP
    if len(f0) > expected:
        f0 = f0[:expected]
    elif len(f0) < expected:
        f0 = np.pad(f0, (0, expected - len(f0)))

    # 用 np.ascontiguousarray + tobytes 减少 pickle 开销
    return (wav_path, np.ascontiguousarray(x, dtype=np.float32).tobytes(),
            len(x), np.ascontiguousarray(f0, dtype=np.float32).tobytes(), len(f0))


# ===================== GPU 处理器（主进程）=====================
class GpuProcessor:
    """主进程 GPU 处理：批量 STFT + 串行 mcep。"""
    def __init__(self, device):
        self.device = device
        log(f"    [GpuProcessor] Initializing...")
        self.mel_basis = make_mel_basis(SVS_SR, SVS_N_FFT, SVS_NUM_MELS, SVS_FMIN, SVS_FMAX).to(device)
        self.hann_window = torch.hann_window(SVS_WIN).to(device)

        # 复用 diffsptk 模块（741x 加速 vs 每次新建）
        self.spec_module = diffsptk.PitchAdaptiveSpectralAnalysis(
            frame_period=SIFIGAN_HOP, sample_rate=SVS_SR, fft_length=SIFIGAN_FFT,
            algorithm="cheap-trick", out_format="power", default_f0=150, device=device,
        )
        self.mcep_analyzer = diffsptk.MelCepstralAnalysis(
            fft_length=SIFIGAN_FFT, cep_order=MCEP_DIM, alpha=ALPHA, n_iter=0, device=device,
        )

        scaler = load(STATS_PATH)
        self.stats_mean = torch.from_numpy(np.asarray(scaler["mcep"].mean_)).float().to(device)
        self.stats_scale = torch.from_numpy(np.asarray(scaler["mcep"].scale_)).float().to(device)
        log(f"    [GpuProcessor] Ready")

    def process_batch(self, items):
        """处理一批 items (已解码的 x, f0)。

        Returns: list of (mel_np, target_np) or None
        """
        valid = [(i, it) for i, it in enumerate(items) if it is not None]
        if not valid:
            return [None] * len(items)

        B = len(valid)
        pad = (SVS_N_FFT - SVS_HOP) // 2
        max_len = max(it[2] for _, it in valid)  # it[2] = x_len
        max_len = max_len // SIFIGAN_HOP * SIFIGAN_HOP
        if max_len == 0:
            return [None] * len(items)

        # 解码 x, f0
        xs = []
        f0s = []
        for _, it in valid:
            _, x_bytes, x_len, f0_bytes, f0_len = it
            x = np.frombuffer(x_bytes, dtype=np.float32).copy()
            f0 = np.frombuffer(f0_bytes, dtype=np.float32).copy()
            xs.append(x)
            f0s.append(f0)

        # ============ 批量 STFT (50Hz mel) ============
        max_padded_len = max_len + 2 * pad
        x_padded = torch.zeros(B, max_padded_len, device=self.device, dtype=torch.float32)
        for b in range(B):
            x = xs[b]
            x_t = torch.from_numpy(x).float().to(self.device).unsqueeze(0)
            x_t = torch.nn.functional.pad(x_t.unsqueeze(1), (pad, pad), mode="reflect").squeeze(1)
            x_padded[b, :x_t.shape[1]] = x_t[0]

        with torch.no_grad():
            spec_complex = torch.stft(
                x_padded, SVS_N_FFT, hop_length=SVS_HOP, win_length=SVS_WIN,
                window=self.hann_window, center=False, pad_mode="reflect",
                normalized=False, onesided=True, return_complex=True,
            )
            spec_real = torch.view_as_real(spec_complex)
            spec_mag = torch.sqrt(spec_real.pow(2).sum(-1) + 1e-9)
            mel_spec = torch.matmul(self.mel_basis, spec_mag)
            mel_spec = torch.log(torch.clamp(mel_spec, min=1e-5))
            mel_spec = (mel_spec - SVS_MEL_MEAN) / (SVS_MEL_VAR ** 0.5)
            svs_mel_batch = mel_spec.transpose(1, 2)  # (B, T_mel, 128)

        # ============ 串行 mcep（复用模块）============
        results = [None] * len(items)
        for b, (orig_idx, _) in enumerate(valid):
            x = xs[b]
            f0 = f0s[b]
            T = len(x)
            T_mel_actual = (T + 2 * pad - SVS_N_FFT) // SVS_HOP + 1

            x_t = torch.from_numpy(x).float().to(self.device).unsqueeze(0)
            f0_t = torch.from_numpy(f0).float().to(self.device).unsqueeze(0)
            try:
                with torch.no_grad():
                    env = self.spec_module(x_t, f0_t)
                    mcep = self.mcep_analyzer(env).squeeze(0)
            except Exception:
                continue

            svs_mel = svs_mel_batch[b, :T_mel_actual]
            T_align = min(svs_mel.shape[0], mcep.shape[0] // 4)
            if T_align < 10:
                continue

            svs_mel = svs_mel[:T_align]
            mcep = mcep[:T_align * 4]
            mcep_50hz = mcep.reshape(T_align, 4, 40).mean(dim=1)
            mcep_norm = (mcep_50hz - self.stats_mean) / self.stats_scale
            bap = torch.zeros(T_align, BAP_DIM, device=self.device)
            target = torch.cat([mcep_norm, bap], dim=1)

            if torch.isnan(target).any() or torch.isinf(target).any():
                continue

            results[orig_idx] = (svs_mel.cpu().numpy(), target.cpu().numpy())

        return results


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    try:
        open(LOG_FILE, "w").close()
    except Exception:
        pass

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log("=" * 60)
    log("Parallel data extraction (MULTIPROCESS + BATCHED GPU)")
    log("=" * 60)
    log(f"Device: {device}")
    if device == "cuda":
        log(f"GPU: {torch.cuda.get_device_name(0)}")
        log(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")
    log(f"Workers: {NUM_WORKERS} (processes)")
    log(f"GPU batch: {GPU_BATCH_SIZE}")
    log(f"Max audio: {MAX_AUDIO_SECONDS}s")

    # 收集文件
    log(f"\n[1] Collecting files...")
    pjs_files = sorted([os.path.join(PJS_DIR, f) for f in os.listdir(PJS_DIR) if f.endswith(".wav")])
    if GTSINGER_MAX_FILES is None:
        gt_files = collect_gtsinger_files(GTSINGER_DIR, 10**9)
    else:
        gt_files = collect_gtsinger_files(GTSINGER_DIR, GTSINGER_MAX_FILES)
    all_files = pjs_files + gt_files
    log(f"    PJS: {len(pjs_files)}, GTSinger: {len(gt_files)}, Total: {len(all_files)}")

    # 初始化 GPU 处理器（必须在 fork 之前，否则 CUDA 会被子进程继承出问题）
    log(f"\n[2] Initializing GPU processor...")
    gpu_proc = GpuProcessor(device)

    # 暖机 GPU（编译 CUDA kernel）
    log(f"    Warming up GPU...")
    dummy_x = np.zeros(SIFIGAN_HOP * 100, dtype=np.float32)
    dummy_f0 = np.zeros(100, dtype=np.float32)
    _ = gpu_proc.process_batch([
        ("dummy", dummy_x.tobytes(), len(dummy_x), dummy_f0.tobytes(), len(dummy_f0))
    ] * 2)
    torch.cuda.synchronize()
    log(f"    Warmup done")

    # 多进程并行 CPU 预处理
    log(f"\n[3] Extracting (CPU={NUM_WORKERS} procs, GPU=batch{GPU_BATCH_SIZE})...")
    t0 = time.time()
    total = len(all_files)
    all_mel = []
    all_target = []
    processed = 0
    skipped = 0
    last_heartbeat = 0.0

    batch = []
    with ProcessPoolExecutor(max_workers=NUM_WORKERS) as executor:
        # 流式提交，避免一次性提交所有任务
        gen = executor.map(cpu_preprocess, all_files, chunksize=4)
        for result in gen:
            batch.append(result)
            if len(batch) >= GPU_BATCH_SIZE:
                t_gpu_start = time.time()
                results = gpu_proc.process_batch(batch)
                gpu_time = time.time() - t_gpu_start
                for r in results:
                    processed += 1
                    if r is None:
                        skipped += 1
                    else:
                        all_mel.append(r[0])
                        all_target.append(r[1])
                batch = []

                elapsed = time.time() - t0
                if processed % PROGRESS_INTERVAL < GPU_BATCH_SIZE or (elapsed - last_heartbeat) >= HEARTBEAT_INTERVAL:
                    last_heartbeat = elapsed
                    rate = processed / max(elapsed, 0.1)
                    eta = (total - processed) / max(rate, 0.01) if rate > 0.01 else 9999
                    log(f"    [{processed}/{total}] rate={rate:.2f}files/s, skip={skipped}, "
                        f"elapsed={elapsed:.0f}s, eta={eta:.0f}s, gpu_t={gpu_time*1000:.0f}ms")

        # 处理剩余
        if batch:
            results = gpu_proc.process_batch(batch)
            for r in results:
                processed += 1
                if r is None:
                    skipped += 1
                else:
                    all_mel.append(r[0])
                    all_target.append(r[1])

    elapsed = time.time() - t0
    log(f"\n    Done: {processed} files, {skipped} skipped, "
        f"{len(all_mel)} valid, elapsed={elapsed:.0f}s "
        f"({processed/max(elapsed,1):.1f} files/s)")

    if not all_mel:
        log("[ERROR] No valid data!")
        sys.exit(1)

    # 拼接 + 过滤 NaN
    log(f"\n[4] Concatenating...")
    mel_data = np.concatenate(all_mel, axis=0)
    target_data = np.concatenate(all_target, axis=0)

    valid_mask = np.isfinite(mel_data).all(axis=1) & np.isfinite(target_data).all(axis=1)
    if not valid_mask.all():
        n_invalid = (~valid_mask).sum()
        log(f"    [WARN] 过滤 {n_invalid} 个含 NaN/Inf 的帧")
        mel_data = mel_data[valid_mask]
        target_data = target_data[valid_mask]

    log(f"\n[5] Final data:")
    log(f"    mel:    {mel_data.shape} ({mel_data.nbytes/1024/1024:.1f} MB)")
    log(f"    target: {target_data.shape} ({target_data.nbytes/1024/1024:.1f} MB)")
    log(f"    skip:   {skipped} files")

    log(f"\n[6] Data stats:")
    log(f"    SVS mel: mean={mel_data.mean():.4f}, std={mel_data.std():.4f}")
    log(f"    target mcep(0:40): mean={target_data[:, :40].mean():.4f}, "
        f"std={target_data[:, :40].std():.4f}, "
        f"frac|val|>5={np.mean(np.abs(target_data[:, :40]) > 5)*100:.1f}%")

    mel_path = os.path.join(OUTPUT_DIR, "mlp_mel_data.npy")
    target_path = os.path.join(OUTPUT_DIR, "mlp_target_data.npy")
    np.save(mel_path, mel_data)
    np.save(target_path, target_data)
    log(f"\n[7] Saved:")
    log(f"    {mel_path} ({mel_data.nbytes/1024/1024:.1f} MB)")
    log(f"    {target_path} ({target_data.nbytes/1024/1024:.1f} MB)")

    log(f"\n{'='*60}")
    log(f"Next: python scripts/retrain_mlp_from_data.py")
    log(f"{'='*60}")


if __name__ == "__main__":
    main()
