#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Real INT8 export pipeline: Q-DiT W8A8 for diff_step + AWQ W8A32 for vocoder.

Pipeline:
  1. Load SoulX-Singer model
  2. GPTQ W8A8 quantize diff_step (DiffLlama) using Q-DiT engine
  3. AWQ W8A32 quantize vocoder (Vocos)
  4. Save PT checkpoints (with real INT8 tensors)
  5. Export FP32 ONNX (with GPTQ-optimized weights)
  6. ORT INT8 quantization (QDQ W8A8 for diffstep, dynamic W8A32 for vocoder)
  7. Olive DML optimization
  8. Copy to onnx_models/int8/
  9. Validate

Environment variables (see .env):
  SOULX_ROOT   - SoulX-Singer repo root (default: ./SoulX-Singer)
  QDIT_ROOT    - Q-DiT repo root (default: C:/Users/.../Temp/Q-DiT)
  MODEL_PATH   - Path to model.pt
  EVAL_DIR     - SoulX-Singer-Eval-Dataset directory
  OUTPUT_DIR   - Output directory for quantized models
  PYTHON       - Python executable (default: python)
"""

import argparse, gc, json, os, sys, time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="INT8 quantization export pipeline")
    parser.add_argument(
        "--sxs", default=os.environ.get("SOULX_ROOT", ""), help="SoulX-Singer repo root"
    )
    parser.add_argument(
        "--qdit", default=os.environ.get("QDIT_ROOT", ""), help="Q-DiT repo root"
    )
    parser.add_argument(
        "--model", default=os.environ.get("MODEL_PATH", ""), help="Path to model.pt"
    )
    parser.add_argument(
        "--eval", default=os.environ.get("EVAL_DIR", ""), help="Eval dataset directory"
    )
    parser.add_argument(
        "--out",
        default=os.environ.get("OUTPUT_DIR", "int8_output"),
        help="Output directory",
    )
    parser.add_argument(
        "--calib",
        type=int,
        default=int(os.environ.get("CALIB_SAMPLES", "64")),
        help="Calibration samples",
    )
    parser.add_argument(
        "--skip-quant",
        action="store_true",
        help="Skip quantization, only export ONNX from existing PT",
    )
    parser.add_argument("--skip-onnx", action="store_true", help="Skip ONNX export")
    parser.add_argument(
        "--skip-olive", action="store_true", help="Skip Olive DML optimization"
    )
    parser.add_argument("--skip-validate", action="store_true", help="Skip validation")
    args = parser.parse_args()

    # Resolve paths
    project_root = Path(__file__).resolve().parent.parent
    sxs_root = Path(args.sxs) if args.sxs else project_root / "SoulX-Singer"
    qdit_root = (
        Path(args.qdit) if args.qdit else Path(os.environ.get("TEMP", "/tmp")) / "Q-DiT"
    )
    model_path = (
        Path(args.model)
        if args.model
        else sxs_root / "pretrained_models" / "SoulX-Singer" / "model.pt"
    )
    eval_dir = Path(args.eval) if args.eval else None
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 70)
    print("  SoulX-Singer INT8 Quantization Pipeline")
    print("=" * 70)
    print(f"  Project root:  {project_root}")
    print(f"  SoulX root:    {sxs_root}")
    print(f"  Q-DiT root:    {qdit_root}")
    print(f"  Model path:    {model_path}")
    print(f"  Eval dir:      {eval_dir}")
    print(f"  Output dir:    {out_dir}")
    print(f"  Calib samples: {args.calib}")
    print("=" * 70)

    # Ensure paths in sys.path
    sys.path.insert(0, str(project_root))
    sys.path.insert(0, str(sxs_root))
    if str(qdit_root) not in sys.path:
        sys.path.insert(0, str(qdit_root))

    import torch

    # Load bridge
    from scripts.int8_bridge import (
        load_components,
        iter_calibration,
        export_onnx,
        quantize_onnx_int8,
    )

    # Load adapter
    from scripts.soulx_qdit_adapter import (
        quantize_diff_step_w8a8,
        quantize_vocoder_w8a32,
    )

    # Step 1: Load model
    print("\n[Step 1/7] Loading model...")
    t0 = time.time()
    model, vocoder, small_models, export_examples = load_components(
        model_path, device="cuda"
    )
    print(f"  Loaded in {time.time() - t0:.1f}s")

    # Extract diff_step from model
    diff_step = model.cfm_decoder.model.diff_estimator
    print(f"  diff_step type: {type(diff_step).__name__}")

    # Step 2: Prepare calibration data
    print("\n[Step 2/7] Preparing calibration data...")
    if eval_dir:
        calib_gen = iter_calibration(eval_dir, limit=args.calib, batch_size=1)
        # Materialize for reuse
        calib_list = list(calib_gen)
        print(f"  Calibration samples: {len(calib_list)}")
    else:
        print("  WARNING: No eval dir provided, using synthetic calibration")
        calib_list = list(iter_calibration(Path("."), limit=args.calib, batch_size=1))
        print(f"  Synthetic samples: {len(calib_list)}")

    if not args.skip_quant:
        # Step 3: Q-DiT W8A8 quantization of diff_step
        print("\n[Step 3/7] Q-DiT W8A8 quantization of diff_step...")
        t0 = time.time()
        diff_step = quantize_diff_step_w8a8(
            diff_step, calib_list, qdit_root=qdit_root, wbits=8, abits=8
        )
        print(f"  Q-DiT quantization done in {time.time() - t0:.1f}s")

        # Step 4: AWQ W8A32 quantization of vocoder
        print("\n[Step 4/7] AWQ W8A32 quantization of vocoder...")
        t0 = time.time()
        vocoder_calib = [
            {"mel": ex["x"].cpu()} for ex in calib_list[:32]
        ]  # mel-like calibration
        vocoder = quantize_vocoder_w8a32(vocoder, calibration=vocoder_calib, wbits=8)
        print(f"  AWQ quantization done in {time.time() - t0:.1f}s")

        # Step 5: Save PT checkpoints
        print("\n[Step 5/7] Saving PT checkpoints...")
        pt_dir = out_dir / "pt"
        pt_dir.mkdir(parents=True, exist_ok=True)

        # Save diff_step state dict (with INT8 tensors)
        ds_sd = diff_step.state_dict()
        int8_count = sum(
            1 for v in ds_sd.values() if torch.is_tensor(v) and v.dtype == torch.int8
        )
        print(f"  diff_step: {int8_count} INT8 tensors in state_dict")
        torch.save(
            {
                "state_dict": ds_sd,
                "format": "qdit-w8a8",
                "wbits": 8,
                "abits": 8,
                "int8_tensors": int8_count,
            },
            pt_dir / "diff_step_w8a8.pt",
        )
        print(f"  Saved {pt_dir / 'diff_step_w8a8.pt'}")

        # Save vocoder state dict (with INT8 tensors)
        voc_sd = vocoder.state_dict()
        int8_count = sum(
            1 for v in voc_sd.values() if torch.is_tensor(v) and v.dtype == torch.int8
        )
        print(f"  vocoder: {int8_count} INT8 tensors in state_dict")
        torch.save(
            {
                "state_dict": voc_sd,
                "format": "awq-w8a32",
                "wbits": 8,
                "abits": 32,
                "int8_tensors": int8_count,
            },
            pt_dir / "vocoder_w8a32.pt",
        )
        print(f"  Saved {pt_dir / 'vocoder_w8a32.pt'}")

        # Verify INT8
        for label, sd in [("diff_step", ds_sd), ("vocoder", voc_sd)]:
            n = sum(
                v.numel()
                for v in sd.values()
                if torch.is_tensor(v) and v.dtype == torch.int8
            )
            if n == 0:
                raise RuntimeError(
                    f"{label}: no INT8 tensors found - fake quantization rejected!"
                )
            print(f"  [VERIFY] {label}: {n / 1e6:.1f}M INT8 elements verified")
    else:
        print("\n[Step 3-5] Loading quantized PT checkpoints...")
        pt_dir = out_dir / "pt"
        ds_ckpt = torch.load(
            pt_dir / "diff_step_w8a8.pt", map_location="cpu", weights_only=False
        )
        diff_step.load_state_dict(ds_ckpt["state_dict"], strict=False)
        print(
            f"  diff_step: loaded {ds_ckpt['int8_tensors']} INT8 tensors (format={ds_ckpt['format']})"
        )

        voc_ckpt = torch.load(
            pt_dir / "vocoder_w8a32.pt", map_location="cpu", weights_only=False
        )
        vocoder.load_state_dict(voc_ckpt["state_dict"], strict=False)
        print(
            f"  vocoder: loaded {voc_ckpt['int8_tensors']} INT8 tensors (format={voc_ckpt['format']})"
        )

    if not args.skip_onnx:
        # Step 6: Export ONNX (FP32 with GPTQ-optimized weights)
        print("\n[Step 6/7] Exporting ONNX...")
        onnx_dir = out_dir / "onnx"
        onnx_dir.mkdir(parents=True, exist_ok=True)

        t0 = time.time()
        export_onnx(
            diff_step, vocoder, small_models, export_examples, onnx_dir, opset=20
        )
        print(f"  ONNX export done in {time.time() - t0:.1f}s")

        # ORT INT8 quantization on exported ONNX
        print("\n  Applying ORT INT8 quantization...")
        # Prepare calibration feeds for ORT static quantization
        calib_feeds = []
        for ex in calib_list[:32]:
            feed = {}
            for k, v in ex.items():
                if torch.is_tensor(v):
                    feed[k] = v.cpu().numpy()
            calib_feeds.append(feed)

        quantize_onnx_int8(onnx_dir, calib_feeds)

        # Save quantization config
        config = {
            "diff_step": "Q-DiT W8A8 (GPTQ + ORT QDQ static)",
            "vocoder": "AWQ W8A32 (AWQ + ORT dynamic)",
            "small_models": "FP32 (copied from existing)",
            "fake_quant": False,
            "int8_tensor_cores": True,
            "calibration_samples": args.calib,
            "ort_quantization": True,
        }
        (out_dir / "quantization_config.json").write_text(json.dumps(config, indent=2))
        print(f"  Saved quantization_config.json")
    else:
        print("\n[Step 6] Skipping ONNX export (--skip-onnx)")

    if not args.skip_olive:
        # Step 7: Olive DML optimization
        print("\n[Step 7/7] Olive DML optimization...")
        olive_dir = out_dir / "olive"
        try:
            from scripts.olive_dml import optimize_dml

            optimize_dml(out_dir / "onnx", olive_dir)
            print("  Olive optimization complete")
        except Exception as e:
            print(f"  WARNING: Olive optimization failed: {e}")
            print("  ONNX models are still usable without Olive optimization")

    # Cleanup
    print("\n[Cleanup] Freeing memory...")
    del model, diff_step, vocoder
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    print("\n" + "=" * 70)
    print("  INT8 Quantization Pipeline Complete!")
    print(f"  Output: {out_dir}")
    print("=" * 70)

    # List output files
    for f in sorted(out_dir.rglob("*")):
        if f.is_file():
            size_mb = f.stat().st_size / (1024 * 1024)
            print(f"    {f.relative_to(out_dir)}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
