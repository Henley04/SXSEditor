#!/usr/bin/env python
"""Compare two end-to-end synthesis dumps produced by e2e_dump.js.

Both dumps must use the same noise seed and the same note list, so every
difference in the audio is attributable to the model being swapped in.

Metrics per item:
  cosine     waveform cosine similarity (1.0 = identical)
  snr_db     10*log10(sum(ref^2)/sum(err^2))
  max_abs    largest absolute sample difference
  logmel_l1  L1 distance of 80-bin log10 mel spectrograms (first 10 s)
             -- a proxy for "does it sound the same", level-normalised

Usage:
  python scripts/olive_int8_w8a8/compare_e2e.py \
      --ref int8_w8a8_output/e2e/fp32 \
      --test int8_w8a8_output/e2e/int8 \
      --out int8_w8a8_output/e2e/compare_int8.json [--diff-wav]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SR = 24000


def load(path: Path) -> np.ndarray:
    return np.fromfile(path, dtype="<f4")


def logmel(x: np.ndarray, max_sec: float = 10.0) -> np.ndarray:
    import librosa

    y = x[: int(SR * max_sec)]
    if y.size < 2048:
        y = np.pad(y, (0, 2048 - y.size))
    S = librosa.feature.melspectrogram(
        y=y.astype(np.float64), sr=SR, n_fft=1024, hop_length=256, n_mels=80, power=2.0
    )
    return np.log10(np.maximum(S, 1e-10))


def metrics(ref: np.ndarray, test: np.ndarray) -> dict:
    n = min(ref.size, test.size)
    if n == 0:
        return {"error": "empty"}
    a, b = ref[:n].astype(np.float64), test[:n].astype(np.float64)
    err = b - a
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    cos = float(a @ b / denom) if denom > 0 else 0.0
    sig = float(np.sum(a ** 2))
    noise = float(np.sum(err ** 2))
    snr = 10 * np.log10(sig / noise) if noise > 0 else float("inf")
    mref, mtest = logmel(a), logmel(b)
    frames = min(mref.shape[1], mtest.shape[1])
    mel_l1 = float(np.mean(np.abs(mref[:, :frames] - mtest[:, :frames]))) if frames else float("nan")
    return {
        "samples": int(n),
        "duration_sec": round(n / SR, 3),
        "cosine": round(cos, 6),
        "snr_db": round(snr, 3),
        "max_abs": round(float(np.max(np.abs(err))), 6),
        "rms_ref": round(float(np.sqrt(np.mean(a ** 2))), 6),
        "rms_test": round(float(np.sqrt(np.mean(b ** 2))), 6),
        "rms_ratio_db": round(20 * np.log10(max(np.sqrt(np.mean(b ** 2)), 1e-12) /
                                           max(np.sqrt(np.mean(a ** 2)), 1e-12)), 3),
        "logmel_l1": round(mel_l1, 5),
    }


def write_wav(path: Path, x: np.ndarray) -> None:
    import wave

    pcm = np.clip(x, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--test", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--diff-wav", action="store_true", help="write <test>/itemN_diff.wav")
    args = ap.parse_args()

    ref_dir = Path(args.ref)
    test_dir = Path(args.test)
    if not ref_dir.is_absolute():
        ref_dir = ROOT / ref_dir
    if not test_dir.is_absolute():
        test_dir = ROOT / test_dir

    ref_sum = ref_dir / "summary.json"
    ref_text = {i["index"]: i for i in json.loads(ref_sum.read_text()).get("items", [])} if ref_sum.exists() else {}

    rows = []
    for f in sorted(ref_dir.glob("item*.f32"), key=lambda p: int(p.stem[4:])):
        idx = int(f.stem[4:])
        other = test_dir / f.name
        if not other.exists():
            rows.append({"index": idx, "error": f"missing {other.name}"})
            continue
        ref = load(f)
        test = load(other)
        m = {"index": idx, "item": ref_text.get(idx, {}).get("item", "")}
        m.update(metrics(ref, test))
        rows.append(m)
        if args.diff_wav:
            write_wav(test_dir / f"item{idx}_diff.wav", test[: ref.size] - ref[: min(ref.size, test.size)])
        print(f"  item{idx:<3} cos={m['cosine']:.4f} snr={m['snr_db']:6.2f} dB "
              f"max_abs={m['max_abs']:.4f} logmel_l1={m['logmel_l1']:.4f} "
              f"rms {m['rms_ratio_db']:+.2f} dB")

    ok = [r for r in rows if "error" not in r]
    agg = {}
    if ok:
        agg = {
            "items": len(ok),
            "cosine_mean": round(float(np.mean([r["cosine"] for r in ok])), 6),
            "cosine_min": round(float(np.min([r["cosine"] for r in ok])), 6),
            "snr_db_mean": round(float(np.mean([r["snr_db"] for r in ok])), 3),
            "logmel_l1_mean": round(float(np.mean([r["logmel_l1"] for r in ok])), 5),
            "max_abs_max": round(float(np.max([r["max_abs"] for r in ok])), 6),
            "rms_ratio_db_mean": round(float(np.mean([r["rms_ratio_db"] for r in ok])), 3),
        }
        print(f"[compare] {agg['items']} items  cos={agg['cosine_mean']:.4f} "
              f"(min {agg['cosine_min']:.4f})  snr={agg['snr_db_mean']:.2f} dB  "
              f"logmel_l1={agg['logmel_l1_mean']:.4f}")

    doc = {
        "ref": str(ref_dir.relative_to(ROOT)) if ref_dir.is_relative_to(ROOT) else str(ref_dir),
        "test": str(test_dir.relative_to(ROOT)) if test_dir.is_relative_to(ROOT) else str(test_dir),
        "aggregate": agg,
        "items": rows,
    }
    out = Path(args.out) if args.out else test_dir / "compare.json"
    if not out.is_absolute():
        out = ROOT / out
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"[compare] -> {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
