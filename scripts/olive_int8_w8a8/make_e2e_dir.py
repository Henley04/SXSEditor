#!/usr/bin/env python
"""Assemble a drop-in model directory for end-to-end A/B runs.

The SXSEditor pipeline resolves `diff_step_dml.onnx` and `vocoder_dml.onnx`
from a single model directory together with the 7 small base encoders.
Rather than copying ~3 GB of base models per candidate, this builds a
"link farm": every base entry is a directory junction / file hardlink into
`onnx_models/`, while the two quantized models are hardlinked from their
quantization output directory.

Hardlinks keep the file *content* identical (no extra disk) while the
pipeline still sees a plain file at the expected path.

Usage:
  python scripts/olive_int8_w8a8/make_e2e_dir.py \
      --diffstep int8_w8a8_output/diffstep/diff_step_dml.onnx \
      --vocoder  int8_w8a8_output/vocoder_wo/vocoder_dml.onnx \
      --out      int8_w8a8_output/e2e_models
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "onnx_models"

# Files that must be *copied*, never hardlinked: onnx.load() refuses to read
# external data from a file with st_nlink > 1 ("potential hardlink attack").
COPY_PREFIXES = ("diff_step", "vocoder")


def must_copy(name: str) -> bool:
    return name.startswith(COPY_PREFIXES)


def junction(src: Path, dst: Path) -> None:
    r = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(dst), str(src)],
        cwd=str(ROOT), capture_output=True, text=True, encoding="mbcs", errors="replace",
    )
    if r.returncode != 0:
        raise RuntimeError(f"mklink /J failed for {dst.name}: {(r.stdout or r.stderr).strip()}")


def link_tree(src: Path, dst: Path) -> None:
    """Hardlink a file; junction a directory. Skips when dst exists."""
    if dst.exists():
        return
    if src.is_dir():
        junction(src, dst)
    elif must_copy(src.name):
        shutil.copy2(src, dst)
    else:
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)


def place(src_onnx: Path, dst_dir: Path) -> list[str]:
    """Copy an .onnx plus every sibling sidecar it needs (.data etc.)."""
    placed = []
    stem = src_onnx.name
    for f in sorted(src_onnx.parent.iterdir()):
        if not f.is_file():
            continue
        # only the requested model's own files (name or name + ".data")
        if f.name != stem and not f.name.startswith(stem + "."):
            continue
        dst = dst_dir / f.name
        if dst.exists():
            dst.unlink()
        shutil.copy2(f, dst)
        placed.append(f"{f.name} ({f.stat().st_size / 1e6:.1f} MB)")
    return placed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=str(BASE))
    ap.add_argument("--diffstep", default=None, help="quantized diff_step .onnx")
    ap.add_argument("--vocoder", default=None, help="quantized vocoder .onnx")
    ap.add_argument("--out", default="int8_w8a8_output/e2e_models")
    ap.add_argument("--reset", action="store_true", help="delete the output dir first")
    args = ap.parse_args()

    base = Path(args.base)
    if not base.is_absolute():
        base = ROOT / base
    out = Path(args.out)
    if not out.is_absolute():
        out = ROOT / out
    if args.reset and out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    # Link the whole base tree first; the two model files that may be swapped
    # are linked in their FP32 form and then replaced below, so a single-stage
    # isolation dir (only vocoder, or only diff_step) still gets both files.
    linked = 0
    for entry in sorted(base.iterdir()):
        link_tree(entry, out / entry.name)
        linked += 1

    print(f"[e2e] linked {linked} base entries -> {out.relative_to(ROOT)}")
    for label, path in (("diff_step", args.diffstep), ("vocoder", args.vocoder)):
        if not path:
            continue
        p = Path(path)
        if not p.is_absolute():
            p = ROOT / p
        if not p.exists():
            print(f"[e2e] !! {label} not found: {p}", file=sys.stderr)
            return 2
        for line in place(p, out):
            print(f"[e2e] {label}: {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
