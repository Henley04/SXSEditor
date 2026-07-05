# -*- coding: utf-8 -*-
"""测试 diffsptk.Aperiodicity 输出维度和分布。"""
import os
import numpy as np
import soundfile as sf
import torch
import diffsptk

SAMPLE_RATE = 24000
FRAME_PERIOD = 5  # samples = 120
FFT_SIZE = 1024
F0_FLOOR = 100
F0_CEIL = 840

PJS_DIR = r"D:\Document\electron\SXSEditor\SoulX-Singer\train\lora_jp_v2\dataset\wavs"


def main():
    fname = sorted([f for f in os.listdir(PJS_DIR) if f.endswith(".wav")])[0]
    path = os.path.join(PJS_DIR, fname)
    x, fs = sf.read(path)
    x = x.astype(np.float64)
    print(f"File: {fname}, sr={fs}, len={len(x)}")

    # diffsptk.Aperiodicity
    # fft_length=None → band aperiodicity (uninterpolated)
    ap_module = diffsptk.Aperiodicity(
        frame_period=FRAME_PERIOD * (SAMPLE_RATE // 1000 // 2),  # 不确定，先用 120
        sample_rate=SAMPLE_RATE,
        fft_length=None,
        algorithm="d4c",
        out_format="a",
    )
    # 实际 frame_period 单位是 samples，5ms * 24kHz = 120 samples
    ap_module = diffsptk.Aperiodicity(
        frame_period=120,
        sample_rate=SAMPLE_RATE,
        fft_length=None,
        algorithm="d4c",
        out_format="a",
    )
    x_t = torch.from_numpy(x).float().unsqueeze(0)
    with torch.no_grad():
        bap = ap_module(x_t, f0=None)  # 不确定输入，试试
    print(f"d4c band aperiodicity output shape: {bap.shape}")
    print(f"  range: [{bap.min():.4f}, {bap.max():.4f}], mean={bap.mean():.4f}")


if __name__ == "__main__":
    main()
