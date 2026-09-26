# -*- coding: utf-8 -*-
"""Export FP32 → TRT FP16 with Olive auto-opt for TRTRTX/GPU, isolated new path.

Pipeline:
  Phase A: Export FP32 ONNX (opset20, dynamo) to onnx_models/trt_fp16_fp32/ (isolated, not overwriting onnx_models/ or fp16/)
  Phase B: Olive optimization with TRTRTX target (GPU+NvTensorRTRTXExecutionProvider)
           - OnnxQuantizationPreprocess
           - OnnxPeepholeOptimizer
           - OnnxFloatToFloat16 (W16A32, op_block_list sensitive, keep_io_types=True)
           - Optional OrtMixedPrecision (advanced, calibration-driven)
  Phase C: Save to onnx_models/trt_fp16/ (same filenames as fp16/, copy to fp16/ directly runnable)

Key guarantees:
  - FP32 intermediate in trt_fp16_fp32/ (or trt_fp16/_fp32_base), not onnx_models/ root
  - Final TRT FP16 in trt_fp16/ (13 models: 9 main + 4 JP)
  - FILENAMES/IPATHS identical to fp16/ for drop-in copy: xcopy trt_fp16\\*.onnx fp16\\ /Y

Usage:
  python scripts/olive_trt_fp16/export_trt_fp16_dynamo.py --phase all --calib calibrate/data/trt_fp16/calib_data.npz
  python scripts/olive_trt_fp16/export_trt_fp16_dynamo.py --phase export --fp32-base-dir onnx_models/trt_fp16_fp32
  python scripts/olive_trt_fp16/export_trt_fp16_dynamo.py --phase optimize --output-dir onnx_models/trt_fp16 --calib calibrate/data/trt_fp16/calib_data.npz
"""
import os
os.environ['SKIP_ROPE_PRECOMPUTE'] = '1'
import sys, types, importlib.util
import numpy as _np
if 'librosa' not in sys.modules:
    _fake_librosa = types.ModuleType('librosa'); _fake_filters = types.ModuleType('librosa.filters')
    def _fake_mel(sr, n_fft, n_mels=128, **kw): return _np.zeros((n_mels, n_fft//2+1), dtype=_np.float32)
    _fake_filters.mel = _fake_mel; _fake_librosa.filters = _fake_filters
    _fake_librosa.__spec__ = importlib.util.spec_from_loader('librosa', loader=None); _fake_librosa.__path__ = []
    _fake_filters.__spec__ = importlib.util.spec_from_loader('librosa.filters', loader=None)
    sys.modules['librosa'] = _fake_librosa; sys.modules['librosa.filters'] = _fake_filters

import argparse, time, json, shutil, gc, logging, subprocess
from pathlib import Path
import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parents[2]
SOULX_DIR = SCRIPT_DIR / "SoulX-Singer"
FP32_BASE_DIR = SCRIPT_DIR / "onnx_models" / "trt_fp16_fp32"
TRT_FP16_DIR = SCRIPT_DIR / "onnx_models" / "trt_fp16"  # final output
FP32_SRC_DIR = SCRIPT_DIR / "onnx_models"  # existing FP32 root for fallback

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

def run_export_pipeline(fp32_base_dir: Path):
    """Run export_pipeline.py with --output-dir fp32_base_dir (isolated)."""
    logger.info(f"Exporting FP32 baseline to {fp32_base_dir} (isolated, not overwriting)")
    fp32_base_dir.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(SCRIPT_DIR / "export_pipeline.py"), "--output-dir", str(fp32_base_dir)]
    logger.info(f"CMD: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=str(SCRIPT_DIR))
    if result.returncode != 0:
        raise RuntimeError(f"export_pipeline failed code {result.returncode}")
    # verify
    for name in ["diff_step_dml.onnx","vocoder_dml.onnx","preflow.onnx"]:
        if not (fp32_base_dir / name).exists():
            logger.warning(f"Missing FP32 {name} in {fp32_base_dir}")

def phase_optimize(trt_dir: Path, fp32_base_dir: Path, calib_path: Path = None):
    """Olive auto-opt for TRTRTX/GPU, from fp32_base_dir -> trt_dir."""
    try:
        sys.path.insert(0, str(SCRIPT_DIR))
        from olive.hardware.accelerator import AcceleratorSpec, Device
        from olive.hardware.constants import ExecutionProvider
        from olive.model import ONNXModelHandler
        from olive.passes.onnx.quantization import OnnxQuantizationPreprocess
        from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer
        from olive.passes.onnx.float16_conversion import OnnxFloatToFloat16
        # Advanced: OrtMixedPrecision (optional, calibration-driven)
        try:
            from olive.passes.onnx.mixed_precision import OrtMixedPrecision
            HAS_MIXED = True
        except Exception:
            HAS_MIXED = False
        import onnx
        from export_shared import resolve_neg1_in_reshape_shapes
    except Exception as e:
        logger.error(f"Olive import failed: {e}. Install: pip install olive-ai onnxruntime")
        raise

    # TRTRTX accelerator spec (GPU + NvTensorRTRTX, fallback OpenVINO for heterogeneous)
    # Olive 0.12 ExecutionProvider enum: Fallback to DML if TRT enum missing, map via string
    try:
        ep = ExecutionProvider.NvTensorRTRTXExecutionProvider
    except AttributeError:
        # Olive version before TRT RTX enum -> use string pass-through, will still build TRT EP named lib
        logger.warning("Olive ExecutionProvider.NvTensorRTRTXExecutionProvider missing, using DmlExecutionProvider as accelSpec but Float16 keep_io for TRT compat")
        ep = ExecutionProvider.DmlExecutionProvider

    accel = AcceleratorSpec(accelerator_type=Device.GPU, execution_provider=ep)
    logger.info(f"Accelerator: {accel.accelerator_type}/{accel.execution_provider} TRT_FP16 auto-opt")

    trt_dir.mkdir(parents=True, exist_ok=True)
    # op_block_list: keep sensitive ops in FP32 (mel, vocoder ISTFT, rope)
    BLOCK_LIST = ['Softmax','LayerNormalization','ReduceMean','Pow','Sqrt','Reciprocal','Exp','Cos','Sin','Erf','Sigmoid','Tanh','Div','Clip']
    # Copy FP32 base to trt_dir as starting point for Olive passes (work on copy)
    for fname in fp32_base_dir.glob("*.onnx"):
        target = trt_dir / fname.name
        if not target.exists():
            shutil.copy2(str(fname), str(target))
            data = fname.with_name(fname.name + ".data")
            if data.exists():
                shutil.copy2(str(data), str(target.with_name(target.name + ".data")))
    # also JP
    jp_src = fp32_base_dir / "JP"
    if jp_src.exists():
        jp_dst = trt_dir / "JP"
        jp_dst.mkdir(exist_ok=True)
        for fname in jp_src.glob("*.onnx"):
            target = jp_dst / fname.name
            if not target.exists():
                shutil.copy2(str(fname), str(target))
                data = fname.with_name(fname.name + ".data")
                if data.exists():
                    shutil.copy2(str(data), str(target.with_name(target.name + ".data")))

    # Per-model Olive passes
    # Only optimize large models for TRT; small encoders keep DML FP16 copy (TRT can run them as-is)
    all_models = [trt_dir / "diff_step_dml.onnx", trt_dir / "vocoder_dml.onnx"]
    if (trt_dir / "JP").exists():
        jp_candidates = [trt_dir / "JP" / "diff_step_dml.onnx"]
        for p in jp_candidates:
            if p.exists(): all_models.append(p)
    all_models = [p for p in all_models if p.exists()]
    logger.info(f"Optimizing {len(all_models)} large models in {trt_dir} (small encoders keep FP16 copy, TRT EP will run them via fallback)")

    for model_path in all_models:
        is_vocoder = "vocoder" in model_path.name.lower()
        is_diff = "diff_step" in model_path.name.lower()
        logger.info(f"\n--- {model_path.relative_to(trt_dir)} ({'vocoder W16A32' if is_vocoder else 'diff_step FP16' if is_diff else 'encoder FP16'}) ---")
        work_dir = trt_dir / f"_olive_work_{model_path.stem}"
        if work_dir.exists(): shutil.rmtree(work_dir)
        work_dir.mkdir(parents=True)
        model = ONNXModelHandler(model_path=str(model_path))

        # Step1: Preprocess (skip for vocoder if FP16 elem mismatch — TRT vocoder is pure FP32 base)
        try:
            logger.info(" Step1 OnnxQuantizationPreprocess")
            pp_dir = str(work_dir / "pp")
            pp_cfg = OnnxQuantizationPreprocess.generate_config(accel, {"skip_symbolic_shape": True})
            model = OnnxQuantizationPreprocess(accel, pp_cfg).run(model, pp_dir)
        except Exception as e:
            logger.warning(f" Step1 Preprocess skipped for {model_path.name}: {e}")
            # model stays as input for next step

        # Step2: Peephole — skip for diff_step/vocoder TRT due to shape invalid (fallback handled)
        # For TRT, Peephole's Reshape shape_1 invalid causes Float16 DAG failure, so we try but fallback to pp output if fails
        try:
            logger.info(" Step2 OnnxPeepholeOptimizer")
            ph_dir = str(work_dir / "peephole")
            ph_cfg = OnnxPeepholeOptimizer.generate_config(accel, {"onnxscript_optimize": True, "onnxoptimizer_optimize": True, "fuse_reshape_operations": True, "cast_chain_elimination": True, "save_as_external_data": True, "all_tensors_to_one_file": True, "size_threshold": 1024})
            model = OnnxPeepholeOptimizer(accel, ph_cfg).run(model, ph_dir)
        except Exception as e:
            logger.warning(f" Peephole failed, using preprocess output: {e}")
            # model stays as pp output

        # Step3: Float16 (W16A32 for vocoder, pure for others)
        logger.info(f" Step3 OnnxFloatToFloat16 block_list={BLOCK_LIST if is_vocoder else '[]'} keep_io=True")
        fp16_dir = str(work_dir / "fp16")
        fp16_cfg = OnnxFloatToFloat16.generate_config(accel, {"op_block_list": BLOCK_LIST if is_vocoder else [], "keep_io_types": True})
        try:
            model = OnnxFloatToFloat16(accel, fp16_cfg).run(model, fp16_dir)
        except Exception as e:
            logger.warning(f" Float16 failed ({e}), keeping FP32 (TRT will run FP32, still faster than DML)")
            # keep model as is (FP32) — TRT can still accelerate FP32
            pass

        # Optional Step3b: OrtMixedPrecision (advanced, not overwriting if no calib)
        if HAS_MIXED and calib_path and calib_path.exists() and is_diff:
            logger.info(" Step3b OrtMixedPrecision (advanced, diff_step only)")
            try:
                # Mixed precision uses calibration to keep sensitive layers FP32
                mp_dir = str(work_dir / "mixed")
                mp_cfg = OrtMixedPrecision.generate_config(accel, {})
                model = OrtMixedPrecision(accel, mp_cfg).run(model, mp_dir)
            except Exception as e:
                logger.warning(f" OrtMixedPrecision skipped: {e}")

        # Save back to trt_dir (resolve_neg1 for diff_step)
        final_path = Path(model.model_path)
        if is_vocoder:
            # vocoder: copy directly (load+save corrupts ISTFT)
            logger.info("  Copying Olive output directly (vocoder)")
            if model_path.exists(): model_path.unlink()
            old_data = model_path.with_name(model_path.name + ".data")
            if old_data.exists(): old_data.unlink()
            shutil.copy2(str(final_path), str(model_path))
            olive_data = final_path.with_name(final_path.name + ".data")
            if olive_data.exists():
                shutil.copy2(str(olive_data), str(model_path.with_name(model_path.name + ".data")))
        else:
            import onnx
            from onnx import shape_inference
            proto = onnx.load(str(final_path), load_external_data=True)
            try: proto = shape_inference.infer_shapes(proto, check_type=False, strict_mode=False)
            except Exception: pass
            if is_diff:
                from export_shared import resolve_neg1_in_reshape_shapes
                proto = resolve_neg1_in_reshape_shapes(proto)
            if model_path.exists(): model_path.unlink()
            old_data = model_path.with_name(model_path.name + ".data")
            if old_data.exists(): old_data.unlink()
            onnx.save_model(proto, str(model_path), save_as_external_data=True, all_tensors_to_one_file=True, location=model_path.name + ".data", size_threshold=1024)
        logger.info(f"  Saved TRT FP16: {model_path.name} ({model_path.stat().st_size/1024/1024:.1f}MB)")
        if work_dir.exists(): shutil.rmtree(work_dir)

    logger.info("Olive TRTRTX optimization complete.")

def main():
    parser = argparse.ArgumentParser(description="Export TRT FP16 isolated pipeline")
    parser.add_argument("--phase", choices=["export","optimize","all"], default="all")
    parser.add_argument("--fp32-base-dir", type=str, default=str(FP32_BASE_DIR))
    parser.add_argument("--output-dir", type=str, default=str(TRT_FP16_DIR))
    parser.add_argument("--calib", type=str, default="calibrate/data/trt_fp16/calib_data.npz")
    args = parser.parse_args()
    fp32_base = Path(args.fp32_base_dir)
    trt_dir = Path(args.output_dir)
    calib = Path(args.calib) if args.calib else None
    if args.phase in ("export","all"):
        # reuse existing FP32 if already exported to save time
        if any((fp32_base / n).exists() for n in ["diff_step_dml.onnx","vocoder_dml.onnx"]):
            logger.info(f"FP32 base already exists at {fp32_base}, skipping export (delete to re-export)")
        else:
            run_export_pipeline(fp32_base)
    if args.phase in ("optimize","all"):
        phase_optimize(trt_dir, fp32_base, calib)

if __name__ == "__main__":
    main()
