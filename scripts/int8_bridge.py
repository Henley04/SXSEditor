# -*- coding: utf-8 -*-
"""Project-specific bridge for INT8 quantization pipeline.

Provides:
  load_components  - load SoulX-Singer model, extract diff_step / vocoder / small models
  iter_calibration - yield diff_step forward kwargs from real eval data
  export_onnx      - export quantized models to ONNX with QDIT-compatible signatures
  quantize_onnx_int8 - apply ORT INT8 quantization (QDQ W8A8 / dynamic W8A32)
"""

import os, sys, gc, json, math, random, shutil
from pathlib import Path

import torch
import torch.nn as nn
import numpy as np

# Ensure project root is on path
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
SOULX_DIR = PROJECT_ROOT / "SoulX-Singer"
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(SOULX_DIR))

# Skip RoPE precompute patch (use native dynamo=True path)
os.environ.setdefault("SKIP_ROPE_PRECOMPUTE", "1")

MEL_DIM = 128
COND_DIM = 1024
HOP_SIZE = 480
SAMPLE_RATE = 24000


def load_components(model_path, device="cuda"):
    """Load SoulX-Singer and return (model, vocoder, small_models, export_examples).

    model       - full SoulXSinger (on CPU, for state_dict saving)
    vocoder     - Vocos vocoder module (extracted from model, on CPU)
    small       - dict of small modules {cond_emb, f0_encoder, ...}
    export_examples - dummy inputs dict for ONNX export
    """
    from export_shared import load_config, load_model

    config = load_config()
    model = load_model(config, str(model_path))
    model.eval()

    # Extract sub-modules
    diff_step = model.cfm_decoder.model.diff_estimator
    vocoder = model.vocoder
    cond_emb = model.cfm_decoder.model.cond_emb

    small = {
        "cond_emb": cond_emb,
        "note_text_encoder": model.note_text_encoder,
        "note_pitch_encoder": model.note_pitch_encoder,
        "note_type_encoder": model.note_type_encoder,
        "f0_encoder": model.f0_encoder,
        "preflow": model.preflow,
    }

    # Dummy inputs for ONNX export (seq_len=256)
    seq_len = 256
    export_examples = {
        "diff_step": {
            "x": torch.randn(1, seq_len, MEL_DIM),
            "diffusion_step": torch.tensor([0.5]),
            "cond": torch.randn(1, seq_len, COND_DIM),
            "x_mask": torch.ones(1, seq_len, dtype=torch.bool),
        },
        "vocoder": {
            "mel": torch.randn(1, seq_len, MEL_DIM),
        },
    }

    n_diff = sum(p.numel() for p in diff_step.parameters()) / 1e6
    print(f"  [bridge] model loaded: {type(model).__name__}")
    print(f"  [bridge] diff_step: {type(diff_step).__name__} ({n_diff:.1f}M params)")
    print(f"  [bridge] vocoder: {type(vocoder).__name__}")
    return model, vocoder, small, export_examples


def iter_calibration(eval_dir, limit=64, batch_size=1):
    """Yield diff_step forward kwargs from realistic data.

    Uses mel-spectrogram statistics from the eval set to generate
    timestep-conditioned calibration samples.
    """
    eval_dir = Path(eval_dir)
    soulx_eval = eval_dir / "soulx-singer-eval"
    if soulx_eval.exists():
        eval_dir = soulx_eval

    # Try to load real annotations for sequence length info
    annotation_dir = eval_dir / "annotation"
    annotations = []
    if annotation_dir.exists():
        for jf in annotation_dir.glob("*.target.jsonl"):
            with open(jf, encoding="utf-8") as f:
                for line in f:
                    annotations.append(json.loads(line.strip()))
        random.shuffle(annotations)
        annotations = annotations[:limit]
        print(f"  [bridge] calibration: {len(annotations)} real samples from eval set")
    else:
        print(
            f"  [bridge] calibration: using synthetic data (no eval annotations found)"
        )

    n_samples = len(annotations) if annotations else limit

    for i in range(n_samples):
        if annotations:
            ann = annotations[i]
            total_dur = sum(ann.get("ph_durs", [0.5] * 20))
            seq_len = max(32, min(1024, int(total_dur * SAMPLE_RATE / HOP_SIZE)))
        else:
            seq_len = random.choice([128, 256, 512, 768])

        # Realistic mel: log-mel with dataset statistics
        x = torch.randn(1, seq_len, MEL_DIM) * math.sqrt(8.14) + (-4.92)
        x = x.clamp(-20, 5)

        # Timestep spread across [0, 1)
        diffusion_step = torch.tensor([i / max(1, n_samples - 1)])

        # Cond embedding: realistic range
        cond = torch.randn(1, seq_len, COND_DIM) * 0.3

        # Full sequence mask
        x_mask = torch.ones(1, seq_len, dtype=torch.bool)

        yield {
            "x": x,
            "diffusion_step": diffusion_step,
            "cond": cond,
            "x_mask": x_mask,
        }


def export_onnx(
    diff_step,
    vocoder,
    small_models,
    export_examples,
    output_dir,
    opset=20,
    external_data=True,
):
    """Export all models to ONNX.

    diff_step  - GPTQ-quantized DiffLlama (weights are FP32 but GPTQ-optimized)
    vocoder    - AWQ-quantized Vocos (weights are FP32 but AWQ-scaled)
    small_models - dict of small modules (copied from existing ONNX)
    """
    from export_shared import DiffStepWrapper, VocosFullWrapper, postprocess_onnx

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"

    # Remove INT8 buffers before ONNX export (they're not part of the graph)
    _strip_int8_buffers(diff_step)
    _strip_int8_buffers(vocoder)

    # --- 1. DiffStep (QDIT signature) ---
    print("\n  [bridge] exporting diffstep.onnx (QDIT signature)...")
    diff_step = diff_step.to(device).eval()

    # Use DiffStepWrapper from export_shared
    # Build a minimal cfm_decoder-like object with model.diff_estimator = diff_step
    class _CFMShim(nn.Module):
        def __init__(self, diff_est):
            super().__init__()
            self.model = nn.Module()
            self.model.diff_estimator = diff_est

    wrapper = DiffStepWrapper(_CFMShim(diff_step)).to(device).eval()

    dummy = export_examples["diff_step"]
    dummy = {k: v.to(device) for k, v in dummy.items()}

    fp32_path = str(output_dir / "diffstep_fp32.onnx")
    try:
        torch.onnx.export(
            wrapper,
            (dummy["x"], dummy["diffusion_step"], dummy["cond"], dummy["x_mask"]),
            fp32_path,
            input_names=["x", "diffusion_step", "cond", "x_mask"],
            output_names=["flow_pred"],
            opset_version=opset,
            dynamo=True,
            dynamic_shapes={
                "xt_input": {0: "batch", 1: "seq_len"},
                "t": None,
                "cond": {0: "batch", 1: "seq_len"},
                "xt_mask": {0: "batch", 1: "seq_len"},
            },
        )
        final_path = str(output_dir / "diffstep.onnx")
        postprocess_onnx(
            fp32_path,
            final_path,
            fix_mixed_precision=False,
            decompose_conv_transpose=False,
            dynamic_input_shape=True,
            skip_stft_replace=True,
            skip_dml_fixes=True,  # Keep Range op (DML-compatible), skip fix_arange_slice
        )
        # Clean up temp files
        _cleanup_onnx_temp(fp32_path, final_path)
        print(f"    -> {final_path}")
    except Exception as e:
        print(f"    [ERROR] diffstep export failed: {e}")
        import traceback

        traceback.print_exc()

    diff_step.cpu()
    del wrapper
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    # --- 2. Vocoder ---
    print("\n  [bridge] exporting vocoder.onnx...")
    vocoder = vocoder.to(device).eval()
    voc_wrapper = VocosFullWrapper(vocoder).to(device).eval()

    voc_dummy = export_examples["vocoder"]
    voc_dummy = {k: v.to(device) for k, v in voc_dummy.items()}

    fp32_path = str(output_dir / "vocoder_fp32.onnx")
    try:
        torch.onnx.export(
            voc_wrapper,
            (voc_dummy["mel"],),
            fp32_path,
            input_names=["mel"],
            output_names=["output"],
            opset_version=opset,
            dynamo=True,
            dynamic_shapes={"mel": {0: "batch", 1: "seq_len"}},
        )
        final_path = str(output_dir / "vocoder.onnx")
        postprocess_onnx(
            fp32_path,
            final_path,
            fix_mixed_precision=False,
            decompose_conv_transpose=True,
            dynamic_input_shape=True,
            skip_stft_replace=False,
            skip_dml_fixes=False,
        )
        _cleanup_onnx_temp(fp32_path, final_path)
        print(f"    -> {final_path}")
    except Exception as e:
        print(f"    [ERROR] vocoder export failed: {e}")
        import traceback

        traceback.print_exc()

    vocoder.cpu()
    del voc_wrapper
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    # --- 3. Small models (copy from existing) ---
    existing_onnx = PROJECT_ROOT / "onnx_models"
    small_files = [
        "cond_emb.onnx",
        "f0_encoder.onnx",
        "note_text_encoder.onnx",
        "note_pitch_encoder.onnx",
        "note_type_encoder.onnx",
        "preflow.onnx",
        "mel_transform.onnx",
    ]
    print("\n  [bridge] copying small model ONNX files...")
    for fname in small_files:
        src = existing_onnx / fname
        if src.exists():
            dst = output_dir / fname
            shutil.copy2(src, dst)
            data_src = existing_onnx / (fname + ".data")
            if data_src.exists():
                shutil.copy2(data_src, output_dir / (fname + ".data"))
            print(f"    -> {fname}")
        else:
            print(f"    [SKIP] {fname} not found at {src}")

    print("\n  [bridge] ONNX export complete")


def _strip_int8_buffers(module):
    """Remove qweight/weight_scale/weight_zero/act_scale buffers added during quantization.

    These are for PT storage only; ONNX export uses the FP32 (GPTQ-optimized) weights.
    """
    for m in module.modules():
        for attr in ["qweight", "weight_scale", "weight_zero", "act_scale"]:
            if attr in m._buffers:
                del m._buffers[attr]


def _cleanup_onnx_temp(fp32_path, final_path):
    """Remove temporary FP32 ONNX files after post-processing."""
    for p in [fp32_path, fp32_path + ".data", fp32_path + ".data.1"]:
        if os.path.exists(p):
            os.remove(p)


def quantize_onnx_int8(onnx_dir, calib_feeds_diffstep):
    """Apply ORT INT8 quantization to exported FP32 ONNX models.

    diffstep.onnx -> W8A8 static QDQ (true INT8 weights + activations)
    vocoder.onnx  -> W8A32 dynamic (true INT8 weights, FP32 activations)
    """
    import onnx
    from onnxruntime.quantization import (
        QuantType,
        QuantFormat,
        CalibrationDataReader,
        quantize,
        quantize_dynamic,
    )

    onnx_dir = Path(onnx_dir)

    # --- DiffStep: W8A8 static QDQ ---
    ds_path = onnx_dir / "diffstep.onnx"
    if ds_path.exists():
        print("\n  [bridge] ORT W8A8 static quantization: diffstep.onnx")

        class CalibReader(CalibrationDataReader):
            def __init__(self, feeds):
                self.feeds = feeds
                self.idx = 0

            def get_next(self):
                if self.idx >= len(self.feeds):
                    return None
                f = self.feeds[self.idx]
                self.idx += 1
                # Keep original dtypes (bool mask stays bool)
                return dict(f)

        reader = CalibReader(calib_feeds_diffstep)

        int8_path = str(ds_path).replace(".onnx", "_int8.onnx")
        try:
            from onnxruntime.quantization import StaticQuantConfig

            config = StaticQuantConfig(
                calibration_data_reader=reader,
                quant_format=QuantFormat.QDQ,
                per_channel=True,
                reduce_range=False,
                activation_type=QuantType.QUInt8,
                weight_type=QuantType.QInt8,
                op_types_to_quantize=["MatMul", "Gemm"],
                extra_options={
                    "ActivationSymmetric": False,
                    "WeightSymmetric": True,
                    "QuantizeBias": False,
                    "AddQDQPairToWeight": True,
                },
            )
            quantize(str(ds_path), int8_path, quant_config=config)
            shutil.move(int8_path, str(ds_path))
            for ext in [".data"]:
                p = int8_path + ext
                if os.path.exists(p):
                    shutil.move(p, str(ds_path) + ext)
            print(f"    -> W8A8 QDQ quantized diffstep.onnx")
        except Exception as e:
            print(f"    [WARNING] Static quant failed ({e}), trying dynamic W8A8...")
            # Fallback: dynamic quantization (W8A8 but activations quantized at runtime)
            quantize_dynamic(
                model_input=str(ds_path),
                model_output=int8_path,
                op_types_to_quantize=["MatMul", "Gemm"],
                weight_type=QuantType.QInt8,
                per_channel=True,
                reduce_range=False,
            )
            shutil.move(int8_path, str(ds_path))
            for ext in [".data"]:
                p = int8_path + ext
                if os.path.exists(p):
                    shutil.move(p, str(ds_path) + ext)
            print(f"    -> W8A8 dynamic quantized diffstep.onnx (fallback)")

    # --- Vocoder: W8A32 dynamic ---
    voc_path = onnx_dir / "vocoder.onnx"
    if voc_path.exists():
        print("\n  [bridge] ORT W8A32 dynamic quantization: vocoder.onnx")
        int8_path = str(voc_path).replace(".onnx", "_int8.onnx")
        quantize_dynamic(
            model_input=str(voc_path),
            model_output=int8_path,
            op_types_to_quantize=["MatMul", "Gemm", "Conv"],
            weight_type=QuantType.QInt8,
            per_channel=True,
            reduce_range=False,
        )
        shutil.move(int8_path, str(voc_path))
        for ext in [".data"]:
            p = int8_path + ext
            if os.path.exists(p):
                shutil.move(p, str(voc_path) + ext)
        print(f"    -> W8A32 dynamic quantized vocoder.onnx")

    # --- Verify INT8 ---
    print("\n  [bridge] verifying INT8 tensors...")
    for name in ["diffstep.onnx", "vocoder.onnx"]:
        p = onnx_dir / name
        if not p.exists():
            continue
        m = onnx.load(str(p), load_external_data=False)
        int8_count = sum(
            1 for i in m.graph.initializer if i.data_type in [3, 13]
        )  # INT8 or UINT8
        ql = sum(1 for n in m.graph.node if n.op_type == "QuantizeLinear")
        dql = sum(1 for n in m.graph.node if n.op_type == "DequantizeLinear")
        dq = sum(1 for n in m.graph.node if n.op_type == "DynamicQuantizeLinear")
        total = len(m.graph.initializer)
        print(
            f"    {name}: {int8_count}/{total} INT8 tensors, {ql} Q + {dql} DQ + {dq} DQDynamic nodes"
        )
        del m

    gc.collect()
