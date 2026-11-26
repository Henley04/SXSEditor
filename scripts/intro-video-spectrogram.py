#!/usr/bin/env python3
"""
从真实推理产出的 WAV 生成宣传片用的梅尔频谱图 / 波形图。

输入必须是 scripts/intro-video-assets.js 真实推理出来的 sample.wav ——
本脚本只做可视化，不做任何音频合成。

用法:
  python3 scripts/intro-video-spectrogram.py \
      --wav intro-video/public/sample.wav \
      --out-dir intro-video/public
"""

import argparse
import json
import os

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import soundfile as sf

# 与 SXSEditor 推理管线一致的频谱参数（src/inference/shared/constants.js）
MEL_BINS = 128
N_FFT = 1024
HOP = 480          # HOP_SIZE @ 24 kHz
F_MIN = 40.0
F_MAX = 12000.0

PALETTE = {
    "bg": "#FBF7EC",
    "ink": "#1A1810",
    "accent": "#B8893B",
    "grid": "#E4DAC2",
}


def hz_to_mel(f):
    return 2595.0 * np.log10(1.0 + f / 700.0)


def mel_to_hz(m):
    return 700.0 * (10.0 ** (m / 2595.0) - 1.0)


def mel_filterbank(sample_rate, n_fft, n_mels, f_min, f_max):
    """三角梅尔滤波器组（与 librosa 的 'htk'-less 实现等价）。"""
    points = mel_to_hz(np.linspace(hz_to_mel(f_min), hz_to_mel(f_max), n_mels + 2))
    bins = np.floor((n_fft + 1) * points / sample_rate).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1))
    for i in range(n_mels):
        left, center, right = bins[i], bins[i + 1], bins[i + 2]
        if center == left:
            center += 1
        if right == center:
            right = center + 1
        fb[i, left:center] = np.linspace(0, 1, center - left, endpoint=False)
        fb[i, center:right] = np.linspace(1, 0, right - center, endpoint=False)
    return fb


def compute_mel(y, sample_rate):
    window = np.hanning(N_FFT)
    n_frames = 1 + (len(y) - N_FFT) // HOP
    if n_frames < 1:
        return np.zeros((MEL_BINS, 1))
    # 分帧 → STFT → 幅度谱
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    frames = y[idx] * window[None, :]
    spec = np.abs(np.fft.rfft(frames, n=N_FFT, axis=1)).T  # (n_freq, n_frames)
    fb = mel_filterbank(sample_rate, N_FFT, MEL_BINS, F_MIN, F_MAX)
    mel = fb @ spec
    # 对数压缩（dB）
    return 20.0 * np.log10(np.maximum(mel, 1e-5))


def style_axes(ax, fig):
    fig.patch.set_facecolor(PALETTE["bg"])
    ax.set_facecolor(PALETTE["bg"])
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(PALETTE["grid"])
    ax.tick_params(colors=PALETTE["ink"], labelsize=11)


def render_mel(mel, sample_rate, out_path, title=None):
    n_frames = mel.shape[1]
    duration = n_frames * HOP / sample_rate
    fig, ax = plt.subplots(figsize=(12.8, 4.4), dpi=100)
    style_axes(ax, fig)
    if title:
        ax.set_title(title, color=PALETTE["ink"], fontsize=15, pad=12, loc="left")
    ax.imshow(
        mel,
        origin="lower",
        aspect="auto",
        extent=[0, duration, 0, MEL_BINS],
        cmap="magma",
        interpolation="nearest",
    )
    ax.set_yticks([0, 32, 64, 96, 128])
    ax.set_yticklabels(["0", "32", "64", "96", "128"])
    ax.set_ylabel("Mel bin", color=PALETTE["ink"], fontsize=12)
    ax.set_xlabel("Time (s)", color=PALETTE["ink"], fontsize=12)
    fig.tight_layout()
    fig.savefig(out_path, facecolor=PALETTE["bg"], bbox_inches="tight")
    plt.close(fig)


def render_wave(y, sample_rate, out_path, title=None):
    t = np.arange(len(y)) / sample_rate
    fig, ax = plt.subplots(figsize=(12.8, 2.6), dpi=100)
    style_axes(ax, fig)
    if title:
        ax.set_title(title, color=PALETTE["ink"], fontsize=14, pad=10, loc="left")
    ax.plot(t, y, color=PALETTE["accent"], linewidth=0.5)
    ax.fill_between(t, y, color=PALETTE["accent"], alpha=0.18)
    ax.set_ylim(-1.05, 1.05)
    ax.set_xlim(0, t[-1] if len(t) else 1)
    ax.set_yticks([-1, 0, 1])
    ax.set_xlabel("Time (s)", color=PALETTE["ink"], fontsize=12)
    ax.set_ylabel("Amp", color=PALETTE["ink"], fontsize=12)
    fig.tight_layout()
    fig.savefig(out_path, facecolor=PALETTE["bg"], bbox_inches="tight")
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", default="intro-video/public/sample.wav")
    ap.add_argument("--out-dir", default="intro-video/public")
    ap.add_argument("--metrics", default=None, help="metrics.json，用于写图注标题")
    args = ap.parse_args()

    y, sr = sf.read(args.wav, dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    os.makedirs(args.out_dir, exist_ok=True)

    mel = compute_mel(y, sr)
    mel_path = os.path.join(args.out_dir, "sample-mel.png")
    wave_path = os.path.join(args.out_dir, "sample-wave.png")
    # 宣传片场景自带标题与指标卡，图内不重复画标题，保持画面干净。
    render_mel(mel, sr, mel_path, None)
    render_wave(y, sr, wave_path, None)

    # 供宣传片做频谱扫描线动画用的逐帧能量包络（真实数据）
    envelope = (mel - mel.min()) / max(1e-6, (mel.max() - mel.min()))
    frame_energy = envelope.mean(axis=0)
    np.save(os.path.join(args.out_dir, "sample-frames.npy"), frame_energy)

    print(f"mel  : {mel_path}  ({mel.shape[1]} frames)")
    print(f"wave : {wave_path}")
    print(f"env  : {os.path.join(args.out_dir, 'sample-frames.npy')} ({frame_energy.shape[0]} frames)")


if __name__ == "__main__":
    main()
