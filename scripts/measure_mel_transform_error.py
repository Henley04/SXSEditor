#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Quantify the FP16 error of mel_transform on real audio.

The exported graph is pure DSP -- reflect-pad STFT (n_fft 1920, hop 480) ->
magnitude -> Slaney mel matmul (128 bands) -> log(clamp(1e-5)) -- so a
re-implementation in torch is enough to measure the arithmetic error without
the checkpoint. Every fp16 variant also rounds the input waveform, because the
app feeds an fp16 input tensor.

Modes
  fp32         reference
  in16         input only                -> minimum unavoidable error
  w16          input + mel_basis/window  -> "keep activations fp32" case
  act16        input + every activation
  w16a16       weights + activations     -> TrueFP16 (what the app loads)
  w16a16_ftz   TrueFP16 with fp16 subnormals flushed to zero

Caveat: accumulation is modelled as FP32, which makes the estimate optimistic.
The historical W16A32 measurement of 66.5 dB on white noise reproduces as
80 dB here, so expect real DirectML numbers 5-14 dB worse. Use this to compare
variants and to see where the error concentrates, not as an absolute floor.

Usage:
  python scripts/measure_mel_transform_error.py
  python scripts/measure_mel_transform_error.py --audio a.wav b.wav --seconds 4
"""
import argparse
import os
import sys

import numpy as np
import torch

SR = 24000
N_FFT = 1920          # exported mel_basis is (128, 961) => n_fft // 2 + 1
HOP = 480
N_MELS = 128
FMIN, FMAX = 0.0, 12000.0
EPS = 1e-9
LOG_FLOOR = 1e-5
MODES = ("in16", "w16", "act16", "w16a16", "w16a16_ftz")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
DEFAULT_AUDIO = [
    os.path.join(PROJECT_DIR, 'out', 'SXSEditor-linux-x64', 'resources', 'docs',
                 'res', 'example_lty_cn.wav'),
    os.path.join(PROJECT_DIR, 'intro-video', 'public', 'sample.wav'),
]


def hz_to_mel(f):
    f = np.atleast_1d(np.asarray(f, dtype=np.float64))
    f_min, f_sp = 0.0, 200.0 / 3
    mels = (f - f_min) / f_sp
    min_log_hz, logstep = 1000.0, np.log(6.4) / 27.0
    min_log_mel = (min_log_hz - f_min) / f_sp
    big = f >= min_log_hz
    mels[big] = min_log_mel + np.log(f[big] / min_log_hz) / logstep
    return mels


def mel_to_hz(m):
    m = np.atleast_1d(np.asarray(m, dtype=np.float64))
    f_min, f_sp = 0.0, 200.0 / 3
    freqs = f_min + f_sp * m
    min_log_hz, logstep = 1000.0, np.log(6.4) / 27.0
    min_log_mel = (min_log_hz - f_min) / f_sp
    big = m >= min_log_mel
    freqs[big] = min_log_hz * np.exp(logstep * (m[big] - min_log_mel))
    return freqs


def mel_filterbank(sr, n_fft, n_mels, fmin, fmax):
    """librosa.filters.mel(..., htk=False, norm='slaney')."""
    fftfreqs = np.linspace(0, sr / 2, 1 + n_fft // 2, dtype=np.float64)
    mel_f = mel_to_hz(np.linspace(float(hz_to_mel(fmin)[0]),
                                  float(hz_to_mel(fmax)[0]), n_mels + 2))
    fdiff = np.diff(mel_f)
    ramps = mel_f[:, None] - fftfreqs[None, :]
    lower = -ramps[:-2] / fdiff[:-1, None]
    upper = ramps[2:] / fdiff[1:, None]
    w = np.maximum(0.0, np.minimum(lower, upper))
    w *= (2.0 / (mel_f[2:n_mels + 2] - mel_f[:n_mels]))[:, None]   # Slaney
    return w.astype(np.float32)


BASIS = torch.from_numpy(mel_filterbank(SR, N_FFT, N_MELS, FMIN, FMAX))
WINDOW = torch.hann_window(N_FFT, periodic=True, dtype=torch.float32)


def q16(x, ftz=False):
    y = x.to(torch.float16)
    if ftz:
        y = torch.where(y.abs() < 2 ** -14, torch.zeros_like(y), y)
    return y.to(torch.float32)


def mel_forward(wav, mode):
    """float32 [N] -> log-mel [T, 128] float32."""
    ftz = mode.endswith("ftz")
    ident = lambda t: t
    qa = (lambda t: q16(t, ftz)) if mode in ("act16", "w16a16", "w16a16_ftz") else ident
    qw = (lambda t: q16(t, ftz)) if mode in ("w16", "w16a16", "w16a16_ftz") else ident

    x = torch.as_tensor(wav, dtype=torch.float32).unsqueeze(0)
    if mode != "fp32":
        x = q16(x, ftz)
    basis, win = qw(BASIS), qw(WINDOW)

    pad = N_FFT // 2
    xp = torch.nn.functional.pad(x, (pad, pad), mode="reflect")
    framed = qa(xp.unfold(-1, N_FFT, HOP) * win)

    spec = torch.fft.rfft(framed, dim=-1)
    re, im = qa(spec.real), qa(spec.imag)
    mag = qa(torch.sqrt(qa(qa(re * re) + qa(im * im)) + EPS))
    mel = qa(torch.matmul(mag, basis.t()))                  # fp32 accumulate
    return qa(torch.log(torch.clamp(mel, min=LOG_FLOOR))).squeeze(0)


def compare(ref, cand):
    r, c = ref.reshape(-1).double(), cand.reshape(-1).double()
    d = r - c
    ad = d.abs().numpy()
    return dict(
        snr_db=10 * np.log10(float((r ** 2).sum() / ((d ** 2).sum() + 1e-30))),
        cosine=float((r * c).sum() / (np.linalg.norm(r) * np.linalg.norm(c) + 1e-30)),
        mae=float(ad.mean()), p99=float(np.percentile(ad, 99)), max=float(ad.max()))


def band_snr(ref, cand, mask):
    r = ref[mask].double(); d = (ref[mask] - cand[mask]).double()
    return 10 * np.log10(float((r ** 2).sum() / ((d ** 2).sum() + 1e-30)))


def load(path, seconds, offset=0.0):
    import soundfile as sf
    from scipy.signal import resample_poly
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    x = data.mean(axis=1)
    if sr != SR:
        g = np.gcd(int(sr), SR)
        x = resample_poly(x, SR // g, sr // g).astype(np.float32)
    if offset:
        x = x[int(offset * SR):]
    return x[: int(seconds * SR)] if seconds else x


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', nargs='+', default=None,
                    help='wav files (default: the docs example + intro sample)')
    ap.add_argument('--seconds', type=float, default=4.0)
    ap.add_argument('--offsets', nargs='+', type=float, default=[0.0, 6.0, 12.0])
    args = ap.parse_args()

    paths = args.audio or [p for p in DEFAULT_AUDIO if os.path.exists(p)]
    if not paths:
        print('no audio found; pass --audio')
        return 1

    segs = []
    for p in paths:
        name = os.path.basename(p).replace('.wav', '')[:14]
        for off in args.offsets:
            wav = load(p, args.seconds, off)
            if wav.size > N_FFT:
                segs.append((f"{name}@{int(off)}s", wav))

    print(f"{'segment':>20} {'mode':>11} {'SNR dB':>7} {'cos':>10} "
          f"{'MAE':>7} {'p99':>7} {'max':>7}")
    print("-" * 72)
    refs = {}
    for name, wav in segs:
        ref = mel_forward(wav, "fp32")
        refs[name] = (ref, wav)
        for mode in MODES:
            r = compare(ref, mel_forward(wav, mode))
            print(f"{name:>20} {mode:>11} {r['snr_db']:7.2f} {r['cosine']:10.7f} "
                  f"{r['mae']:7.4f} {r['p99']:7.4f} {r['max']:7.4f}")
        print()

    name = segs[0][0]          # 第一段是人声素材，四分位统计用它更有意义
    ref, wav = refs[name]
    print(f"bins below fp16 smallest normal (6.1e-5): "
          f"{float((np.exp(ref.numpy()) < 2**-14).mean())*100:.1f}%")
    print(f"log-mel range: [{float(ref.min()):.2f}, {float(ref.max()):.2f}]\n")

    cand = mel_forward(wav, "w16a16")
    qs = np.percentile(ref.numpy(), [25, 50, 75])
    print(f"By reference energy quartile ({name}, w16a16):")
    bands = {
        "Q1 quietest": ref.numpy() <= qs[0],
        "Q2": (ref.numpy() > qs[0]) & (ref.numpy() <= qs[1]),
        "Q3": (ref.numpy() > qs[1]) & (ref.numpy() <= qs[2]),
        "Q4 loudest": ref.numpy() > qs[2],
    }
    for k, m in bands.items():
        print(f"  {k:>12}: SNR={band_snr(ref, cand, m):7.2f} dB  "
              f"MAE={float((ref[m] - cand[m]).abs().mean()):.4f}  "
              f"ref [{float(ref[m].min()):.2f}, {float(ref[m].max()):.2f}]")

    if len(refs) > 1:
        (a, _), (b, _) = list(refs.values())[0], list(refs.values())[-1]
        t = min(a.shape[0], b.shape[0])
        d_sig = float((a[:t] - b[:t]).abs().mean())
        d_q = float((a - mel_forward(list(refs.values())[0][1], "w16a16")).abs().mean())
        print(f"\nScale check: |mel(A) - mel(B)| = {d_sig:.4f} log-mel units, "
              f"|fp32 - fp16| = {d_q:.4f}  ->  {d_sig / max(d_q, 1e-12):.0f}x")
    return 0


if __name__ == '__main__':
    sys.exit(main())
