# -*- coding: utf-8 -*-
"""Export FP16 PyTorch model to ONNX via dynamo, optimize with Olive (DML GPU target),
then compare speed and precision against FP32 ONNX.

Pipeline:
  Phase 1: Export FP16 ONNX (dynamo=True, opset=20) for diff_step + vocoder
  Phase 2: Olive optimization (AcceleratorSpec GPU + DmlExecutionProvider)
  Phase 3: Compare FP16 vs FP32 ONNX (speed + precision: SNR, cos, L0)

Usage:
  python export_fp16_onnx_dynamo.py --phase export
  python export_fp16_onnx_dynamo.py --phase optimize
  python export_fp16_onnx_dynamo.py --phase compare
  python export_fp16_onnx_dynamo.py --phase all
"""
import os
# Skip RoPE precomputation patches — use dynamo=True native Range + Sin/Cos RoPE
os.environ['SKIP_ROPE_PRECOMPUTE'] = '1'

# Mock librosa BEFORE importing export_shared (which imports mel_transform -> librosa)
# librosa.filters.mel triggers numba JIT compilation which is extremely slow.
# mel_basis is a persistent buffer overwritten by load_state_dict, so mock is safe.
import sys
import types
import importlib.util
import numpy as _np

if 'librosa' not in sys.modules:
    _fake_librosa = types.ModuleType('librosa')
    _fake_filters = types.ModuleType('librosa.filters')

    def _fake_mel(sr, n_fft, n_mels=128, fmin=0, fmax=None, **kwargs):
        return _np.zeros((n_mels, n_fft // 2 + 1), dtype=_np.float32)

    _fake_filters.mel = _fake_mel
    _fake_librosa.filters = _fake_filters
    _fake_librosa.__spec__ = importlib.util.spec_from_loader('librosa', loader=None)
    _fake_librosa.__path__ = []
    _fake_filters.__spec__ = importlib.util.spec_from_loader('librosa.filters', loader=None)
    sys.modules['librosa'] = _fake_librosa
    sys.modules['librosa.filters'] = _fake_filters

import argparse
import time
import json
import shutil
import gc
import logging
import numpy as np
from pathlib import Path
from collections import OrderedDict

import torch
import torch.nn as nn

# ============================================================
# Paths
# ============================================================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SOULX_DIR = os.path.join(SCRIPT_DIR, 'SoulX-Singer')
FP16_MODEL_PATH = os.path.join(SCRIPT_DIR, 'pretrained_models_fp16', 'model_fp16_calib.pt')
FP32_MODEL_PATH = os.path.join(SOULX_DIR, 'pretrained_models', 'SoulX-Singer', 'model.pt')

# Output directories
FP16_ONNX_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'fp16_dynamo')
FP32_ONNX_DIR = os.path.join(SCRIPT_DIR, 'onnx_models')  # existing FP32 models

# Models to export/compare (the two largest sub-modules)
MODELS = {
    'diff_step': {
        'output_name': 'diff_step_dml.onnx',
        'input_names': ['xt_input', 't', 'cond', 'xt_mask'],
        'output_names': ['flow_pred'],
    },
    'vocoder': {
        'output_name': 'vocoder_dml.onnx',
        'input_names': ['mel'],
        'output_names': ['waveform'],
    },
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


# ============================================================
# Phase 1: Export FP16 ONNX via dynamo
# ============================================================
def load_fp16_model():
    """Load SoulX-Singer model with FP16 state dict.

    Uses model.half() + model.mel.float() pattern (matches inference.py).
    """
    from export_shared import load_config, load_model, SoulXSinger
    import yaml

    config = load_config()

    # Load FP16 checkpoint
    logger.info(f"Loading FP16 checkpoint: {FP16_MODEL_PATH}")
    ckpt = torch.load(FP16_MODEL_PATH, weights_only=False, map_location='cpu')
    fp16_sd = ckpt['state_dict']
    del ckpt

    # Build model and load FP16 state dict
    model = SoulXSinger(config).cpu()
    model.load_state_dict(fp16_sd, strict=False)
    # Apply FP16: half everything, then restore mel to FP32
    model.half()
    model.mel.float()
    model.eval()

    fp16_p = sum(p.numel() for p in model.parameters() if p.dtype == torch.float16)
    fp32_p = sum(p.numel() for p in model.parameters() if p.dtype == torch.float32)
    logger.info(f"Model loaded: {fp16_p/1e6:.2f}M FP16 + {fp32_p/1e6:.2f}M FP32 params")
    del fp16_sd
    return config, model


def export_diff_step_fp16(model, config, output_dir):
    """Export diff_step as FP16 ONNX via dynamo=True."""
    from export_shared import DiffStepWrapper
    from torch.export import Dim

    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, 'diff_step_dml.onnx')

    logger.info("Exporting diff_step FP16 ONNX (dynamo=True, opset=20)...")
    t0 = time.time()

    wrapper = DiffStepWrapper(model.cfm_decoder).eval()
    # Ensure wrapper is FP16 (inherits from model which is already half)
    wrapper = wrapper.half()
    param_count = sum(p.numel() for p in wrapper.parameters())
    logger.info(f"  diff_step: {param_count/1e6:.1f}M params")

    cond_dim = config.model.flow_matching.hidden_size
    seq_len = 2048
    # FP16 inputs (match model dtype)
    args_tuple = (
        torch.randn(1, seq_len, 128, dtype=torch.float16),
        torch.tensor([0.5], dtype=torch.float16),
        torch.randn(1, seq_len, cond_dim, dtype=torch.float16),
        torch.ones(1, seq_len, dtype=torch.float16),
    )

    seq_len_dim = Dim('seq_len', min=1, max=10000)
    tmp_path = output_path + '.raw.onnx'

    with torch.no_grad():
        torch.onnx.export(
            wrapper, args_tuple, tmp_path,
            input_names=['xt_input', 't', 'cond', 'xt_mask'],
            output_names=['flow_pred'],
            opset_version=20,
            dynamo=True,
            dynamic_shapes={
                'xt_input': {1: seq_len_dim},
                't': None,
                'cond': {1: seq_len_dim},
                'xt_mask': {1: seq_len_dim},
            },
        )

    # Post-process: strip metadata, save with external data
    import onnx
    from onnx import shape_inference
    onnx_model = onnx.load(tmp_path)
    # Delete raw files BEFORE saving final (save disk space)
    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    if os.path.exists(tmp_path + '.data'):
        os.remove(tmp_path + '.data')
    onnx_model = shape_inference.infer_shapes(onnx_model, check_type=False, strict_mode=False)

    # Remove existing output
    if os.path.exists(output_path):
        os.remove(output_path)
    if os.path.exists(output_path + '.data'):
        os.remove(output_path + '.data')

    onnx.save_model(onnx_model, output_path,
                    save_as_external_data=True,
                    all_tensors_to_one_file=True,
                    location='diff_step_dml.onnx.data',
                    size_threshold=1024)

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    data_mb = os.path.getsize(output_path + '.data') / 1024 / 1024 if os.path.exists(output_path + '.data') else 0
    logger.info(f"  Saved: {output_path} ({size_mb:.1f}MB + {data_mb:.1f}MB data)")
    logger.info(f"  Done in {time.time()-t0:.1f}s")

    del wrapper, onnx_model
    gc.collect()


def export_vocoder_fp16(model_fp16, model_fp32, config, output_dir):
    """Export vocoder as FP32 ONNX via dynamo=True, FP16 conversion deferred to Olive.

    VocosFullWrapper cannot be directly exported as FP16 because ISTFT buffers
    (cos_basis, sin_basis, window) require FP32 precision, and dynamo export
    fails on mixed dtype operations (FP16 backbone output + FP32 ISTFT buffer).

    Strategy: export FP32 ONNX with dynamo=True, then use Olive OnnxFloatToFloat16
    (W16A32) in Phase 2 to convert weights to FP16 while keeping sensitive ops
    (Exp, Cos, Sin, LayerNormalization) in FP32 via op_block_list.
    """
    from export_shared import VocosFullWrapper

    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, 'vocoder_dml.onnx')

    logger.info("Exporting vocoder ONNX (dynamo=True, opset=20, FP32 base for Olive W16A32)...")
    t0 = time.time()

    # Use FP32 model for vocoder export (ISTFT requires FP32 precision)
    wrapper = VocosFullWrapper(model_fp32.vocoder).eval()

    param_count = sum(p.numel() for p in wrapper.parameters())
    logger.info(f"  vocoder: {param_count/1e6:.1f}M params (FP32, will be W16A32 via Olive)")

    voc_seq_len = 500
    mel = torch.randn(1, voc_seq_len, 128, dtype=torch.float32)

    tmp_path = output_path + '.raw.onnx'

    with torch.no_grad():
        torch.onnx.export(
            wrapper, (mel,), tmp_path,
            input_names=['mel'],
            output_names=['waveform'],
            opset_version=20,
            dynamo=True,
            dynamic_axes={
                'mel': {1: 'num_frames'},
                'waveform': {1: 'audio_len'},
            },
        )

    # Post-process
    import onnx
    from onnx import shape_inference
    onnx_model = onnx.load(tmp_path)
    # Delete raw files BEFORE saving final (save disk space)
    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    if os.path.exists(tmp_path + '.data'):
        os.remove(tmp_path + '.data')
    onnx_model = shape_inference.infer_shapes(onnx_model, check_type=False, strict_mode=False)

    if os.path.exists(output_path):
        os.remove(output_path)
    if os.path.exists(output_path + '.data'):
        os.remove(output_path + '.data')

    onnx.save_model(onnx_model, output_path,
                    save_as_external_data=True,
                    all_tensors_to_one_file=True,
                    location='vocoder_dml.onnx.data',
                    size_threshold=1024)

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    data_mb = os.path.getsize(output_path + '.data') / 1024 / 1024 if os.path.exists(output_path + '.data') else 0
    logger.info(f"  Saved: {output_path} ({size_mb:.1f}MB + {data_mb:.1f}MB data)")
    logger.info(f"  Done in {time.time()-t0:.1f}s")

    del wrapper, onnx_model
    gc.collect()


def phase_export():
    """Phase 1: Export FP16 ONNX models.

    diff_step: exported directly from FP16 PyTorch model (pure FP16 weights)
    vocoder: exported from FP32 PyTorch model (FP16 conversion deferred to Olive
             W16A32, because VocosFullWrapper ISTFT buffers require FP32 and
             dynamo export fails on mixed dtype operations)

    Skips models whose output already exists (set FORCE_REEXPORT=1 to override).
    """
    logger.info("=" * 60)
    logger.info("PHASE 1: Export FP16 ONNX (dynamo=True, opset=20)")
    logger.info("=" * 60)

    force = bool(os.environ.get('FORCE_REEXPORT'))

    # diff_step: use FP16 model
    diff_step_path = os.path.join(FP16_ONNX_DIR, 'diff_step_dml.onnx')
    if not force and os.path.exists(diff_step_path) and os.path.exists(diff_step_path + '.data'):
        logger.info(f"diff_step_dml.onnx already exists, skipping (set FORCE_REEXPORT=1 to re-export)")
    else:
        config, model_fp16 = load_fp16_model()
        export_diff_step_fp16(model_fp16, config, FP16_ONNX_DIR)
        del model_fp16
        gc.collect()

    # vocoder: use FP32 model (ISTFT precision, FP16 via Olive W16A32)
    vocoder_path = os.path.join(FP16_ONNX_DIR, 'vocoder_dml.onnx')
    if not force and os.path.exists(vocoder_path) and os.path.exists(vocoder_path + '.data'):
        logger.info(f"vocoder_dml.onnx already exists, skipping (set FORCE_REEXPORT=1 to re-export)")
    else:
        from export_shared import load_config, load_model
        config = load_config()
        logger.info(f"Loading FP32 model for vocoder export: {FP32_MODEL_PATH}")
        model_fp32 = load_model(config, FP32_MODEL_PATH)
        export_vocoder_fp16(None, model_fp32, config, FP16_ONNX_DIR)
        del model_fp32
        gc.collect()

    logger.info("Phase 1 complete.")


# ============================================================
# Phase 2: Olive optimization (DML GPU target)
# ============================================================
def _restore_istft_basis_fp32(model_proto, logger):
    """Restore ISTFT basis matrices (cos/sin) to FP32 after FP16 conversion.

    The OnnxFloatToFloat16 pass converts ISTFT cos/sin basis matrices to FP16.
    These matrices have very small values (~0.0005) that lose precision in FP16,
    causing ISTFT output explosion. This function:
    1. Identifies ISTFT basis initializers (shape [1920, 961], small values)
    2. Converts them back to FP32
    3. Inserts Cast nodes around the MatMul ops that use them
       (FP16 input → Cast → FP32, MatMul in FP32 → Cast → FP16 output)
    """
    import onnx
    from onnx import helper, TensorProto, numpy_helper

    graph = model_proto.graph
    init_map = {init.name: init for init in graph.initializer}

    # ISTFT basis matrix shape: [n_fft, num_freq] = [1920, 961]
    # Values are very small (std ~0.0007, max ~0.001)
    ISTFT_BASIS_SHAPE = (1920, 961)
    ISTFT_BASIS_MAX_VAL = 0.002  # basis values are 1/n_fft ≈ 0.0005

    # Find ISTFT basis initializers
    istft_inits = []
    for init in graph.initializer:
        if init.dims == list(ISTFT_BASIS_SHAPE):
            arr = numpy_helper.to_array(init)
            if arr.dtype == np.float16 and float(np.abs(arr).max()) < ISTFT_BASIS_MAX_VAL:
                istft_inits.append(init.name)
                logger.info(f"  Found ISTFT basis init: {init.name} (shape={ISTFT_BASIS_SHAPE}, max={float(np.abs(arr).max()):.6f})")

    if not istft_inits:
        logger.info("  No ISTFT basis FP16 initializers found, skipping restoration")
        return model_proto

    # Convert ISTFT basis initializers to FP32
    new_inits = []
    for init in graph.initializer:
        if init.name in istft_inits:
            arr = numpy_helper.to_array(init).astype(np.float32)
            new_init = numpy_helper.from_array(arr, name=init.name)
            new_inits.append(new_init)
            logger.info(f"  Restored {init.name} to FP32")
        else:
            new_inits.append(init)
    del graph.initializer[:]
    graph.initializer.extend(new_inits)

    # Insert Cast nodes around MatMul ops that use ISTFT basis
    new_nodes = []
    cast_counter = 0
    fixed_matmuls = 0
    for node in graph.node:
        if node.op_type == 'MatMul':
            # Check if any input is an ISTFT basis initializer
            basis_input_idx = None
            other_input_idx = None
            for i, inp in enumerate(node.input):
                if inp in istft_inits:
                    basis_input_idx = i
                    other_input_idx = 1 - i
                    break

            if basis_input_idx is not None:
                # The basis is now FP32, the other input is FP16.
                # Insert Cast(FP16→FP32) for the other input,
                # then Cast(FP32→FP16) for the output.
                other_input = node.input[other_input_idx]
                original_output = node.output[0]

                # Cast other input to FP32
                cast_in_name = f"_istft_cast_in_{cast_counter}"
                cast_in_node = helper.make_node(
                    'Cast',
                    inputs=[other_input],
                    outputs=[cast_in_name],
                    to=TensorProto.FLOAT,
                    name=f"_istft_cast_in_node_{cast_counter}",
                )
                new_nodes.append(cast_in_node)

                # Update MatMul inputs
                node.input[other_input_idx] = cast_in_name

                # MatMul output is now FP32, insert Cast to FP16
                fp32_output = f"_istft_matmul_fp32_{cast_counter}"
                fp16_output = original_output
                node.output[0] = fp32_output

                cast_out_node = helper.make_node(
                    'Cast',
                    inputs=[fp32_output],
                    outputs=[fp16_output],
                    to=TensorProto.FLOAT16,
                    name=f"_istft_cast_out_node_{cast_counter}",
                )
                new_nodes.append(node)
                new_nodes.append(cast_out_node)

                cast_counter += 1
                fixed_matmuls += 1
                continue

        new_nodes.append(node)

    del graph.node[:]
    graph.node.extend(new_nodes)
    logger.info(f"  Fixed {fixed_matmuls} ISTFT MatMul nodes (added {cast_counter * 2} Cast nodes)")

    return model_proto


def phase_optimize(models=None):
    """Phase 2: Olive optimization with DML GPU accelerator spec.

    diff_step: OnnxQuantizationPreprocess -> OnnxPeepholeOptimizer -> resolve_neg1
               (already FP16 weights from dynamo export)
    vocoder:  OnnxQuantizationPreprocess -> OnnxPeepholeOptimizer -> OnnxFloatToFloat16
              (W16A32) -> resolve_neg1
              (FP32 base, FP16 conversion via Olive with op_block_list for sensitive ops)

    Args:
        models: optional list of model names to process (e.g. ['vocoder_dml.onnx']).
                If None, processes all models.
    """
    from olive.hardware.accelerator import AcceleratorSpec, Device
    from olive.hardware.constants import ExecutionProvider
    from olive.model import ONNXModelHandler
    from olive.passes.onnx.quantization import OnnxQuantizationPreprocess
    from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer
    from olive.passes.onnx.float16_conversion import OnnxFloatToFloat16
    from export_shared import resolve_neg1_in_reshape_shapes
    import onnx
    from onnx import shape_inference

    logger.info("=" * 60)
    logger.info("PHASE 2: Olive optimization (GPU + DmlExecutionProvider)")
    logger.info("=" * 60)

    ACCEL_SPEC = AcceleratorSpec(
        accelerator_type=Device.GPU,
        execution_provider=ExecutionProvider.DmlExecutionProvider,
    )
    logger.info(f"AcceleratorSpec: {ACCEL_SPEC.accelerator_type} / {ACCEL_SPEC.execution_provider}")

    os.makedirs(FP16_ONNX_DIR, exist_ok=True)

    # Vocoder W16A32 op_block_list: keep sensitive ops in FP32
    # (ISTFT Exp/Cos/Sin, LayerNormalization, etc.)
    # DML-targeted FP16 conversion is more aggressive than CPU-targeted, so we
    # must also block Div and Clip to protect the window envelope normalization:
    #   y = y / window_envelope.clamp(min=1e-11)
    # In FP16, 1e-11 underflows to 1e-7, and the Div in FP16 loses precision,
    # causing output explosion (std 0.7 vs expected 0.005).
    VOCODER_OP_BLOCK_LIST = [
        'Softmax', 'LayerNormalization', 'ReduceMean', 'Pow', 'Sqrt',
        'Reciprocal', 'Exp', 'Cos', 'Sin', 'Erf', 'Sigmoid', 'Tanh',
        'Div', 'Clip',  # window envelope normalization must stay FP32
    ]

    all_models = ['diff_step_dml.onnx', 'vocoder_dml.onnx']
    if models:
        all_models = [m for m in all_models if m in models]
        logger.info(f"Filtering to models: {all_models}")

    for model_name in all_models:
        model_path = Path(FP16_ONNX_DIR) / model_name
        if not model_path.exists():
            logger.warning(f"Model not found, skipping: {model_path}")
            continue

        is_vocoder = 'vocoder' in model_name
        logger.info(f"\n--- Optimizing: {model_name} ({'W16A32 FP16 conversion' if is_vocoder else 'pure FP16'}) ---")
        input_size = model_path.stat().st_size / (1024 * 1024)
        data_file = model_path.with_suffix(".onnx.data")
        if data_file.exists():
            input_size += data_file.stat().st_size / (1024 * 1024)
        logger.info(f"Input: {model_name} ({input_size:.1f} MB)")

        work_dir = Path(FP16_ONNX_DIR) / f"_olive_work_{model_name.replace('.onnx', '')}"
        if work_dir.exists():
            shutil.rmtree(work_dir)
        work_dir.mkdir(parents=True)

        model = ONNXModelHandler(model_path=str(model_path))

        # Step 1: OnnxQuantizationPreprocess
        logger.info("Step 1: OnnxQuantizationPreprocess")
        preprocess_dir = str(work_dir / "preprocessed")
        preprocess_config = OnnxQuantizationPreprocess.generate_config(
            ACCEL_SPEC, {"skip_symbolic_shape": True}
        )
        preprocess_pass = OnnxQuantizationPreprocess(ACCEL_SPEC, preprocess_config)
        model = preprocess_pass.run(model, preprocess_dir)
        logger.info("OnnxQuantizationPreprocess completed")

        # Step 2: OnnxPeepholeOptimizer
        logger.info("Step 2: OnnxPeepholeOptimizer")
        peephole_dir = str(work_dir / "peephole")
        peephole_config = OnnxPeepholeOptimizer.generate_config(
            ACCEL_SPEC,
            {
                "onnxscript_optimize": True,
                "onnxoptimizer_optimize": True,
                "fuse_reshape_operations": True,
                "cast_chain_elimination": True,
                "save_as_external_data": True,
                "all_tensors_to_one_file": True,
                "size_threshold": 1024,
            },
        )
        peephole_pass = OnnxPeepholeOptimizer(ACCEL_SPEC, peephole_config)
        model = peephole_pass.run(model, peephole_dir)
        logger.info("OnnxPeepholeOptimizer completed")

        # Step 3: For vocoder, apply OnnxFloatToFloat16 (W16A32) conversion
        if is_vocoder:
            logger.info(f"Step 3: OnnxFloatToFloat16 (W16A32, op_block_list={VOCODER_OP_BLOCK_LIST})")
            fp16_dir = str(work_dir / "fp16")
            fp16_config = OnnxFloatToFloat16.generate_config(
                ACCEL_SPEC,
                {
                    "op_block_list": VOCODER_OP_BLOCK_LIST,
                    "keep_io_types": True,
                },
            )
            fp16_pass = OnnxFloatToFloat16(ACCEL_SPEC, fp16_config)
            model = fp16_pass.run(model, fp16_dir)
            logger.info("OnnxFloatToFloat16 completed")

        # Post-processing: resolve_neg1 for DML compat + save final output
        #
        # IMPORTANT: For vocoder, the load+save cycle after FP16 conversion
        # corrupts ISTFT basis precision (SNR drops from 33dB to -43dB).
        # The Olive OnnxFloatToFloat16 output must be used directly (copy only).
        # resolve_neg1_in_reshape_shapes is only needed for diff_step (dynamo
        # export produces Concat([..., -1, ...]) shapes unsupported by DML).
        # The vocoder's dynamo export doesn't produce -1 Reshape shapes, so
        # it works on DML without resolve_neg1.
        final_model_path = Path(model.model_path)

        if is_vocoder:
            # Vocoder: copy Olive output directly (load+save corrupts FP16 ISTFT)
            logger.info("Copying Olive output directly (vocoder: load+save corrupts FP16 precision)")
            if model_path.exists():
                model_path.unlink()
            old_data = model_path.with_name(model_path.name + ".data")
            if old_data.exists():
                old_data.unlink()

            shutil.copy2(str(final_model_path), str(model_path))
            # Copy external data file
            olive_data = final_model_path.with_name(final_model_path.name + ".data")
            if olive_data.exists():
                target_data = model_path.with_name(model_path.name + ".data")
                shutil.copy2(str(olive_data), str(target_data))
            logger.info("Vocoder output copied (no load+save cycle)")
        else:
            # diff_step: resolve_neg1_in_reshape_shapes + save
            logger.info("Step 3: resolve_neg1_in_reshape_shapes (diff_step)")
            pre_proto = onnx.load(str(final_model_path), load_external_data=True)
            try:
                pre_proto = shape_inference.infer_shapes(pre_proto, check_type=False, strict_mode=False)
            except Exception as e:
                logger.warning(f"shape_inference failed (non-fatal): {e}")
            pre_proto = resolve_neg1_in_reshape_shapes(pre_proto)
            logger.info("resolve_neg1_in_reshape_shapes completed")

            logger.info("Saving final output with external data format")
            if model_path.exists():
                model_path.unlink()
            old_data = model_path.with_name(model_path.name + ".data")
            if old_data.exists():
                old_data.unlink()

            onnx.save_model(
                pre_proto,
                str(model_path),
                save_as_external_data=True,
                all_tensors_to_one_file=True,
                location=model_path.name + ".data",
                size_threshold=1024,
            )

        output_size = model_path.stat().st_size / (1024 * 1024)
        output_data = model_path.with_name(model_path.name + ".data")
        if output_data.exists():
            output_size += output_data.stat().st_size / (1024 * 1024)
        logger.info(f"Output: {model_name} ({output_size:.1f} MB)")

        # Clean up work directory
        if work_dir.exists():
            shutil.rmtree(work_dir)

        # Print node count summary
        result_model = onnx.load(str(model_path), load_external_data=False)
        node_count = len(result_model.graph.node)
        op_counts = {}
        for node in result_model.graph.node:
            op_counts[node.op_type] = op_counts.get(node.op_type, 0) + 1
        logger.info(f"Final model: {node_count} nodes")
        for op, cnt in sorted(op_counts.items(), key=lambda x: -x[1])[:8]:
            logger.info(f"  {op}: {cnt}")

    logger.info("Phase 2 complete.")


# ============================================================
# Phase 3: Compare FP16 vs FP32 ONNX (speed + precision)
# ============================================================
def compute_metrics(fp32_out, fp16_out):
    """Compute SNR, cosine similarity, L0 norm."""
    x = fp32_out.flatten().astype(np.float64)
    y = fp16_out.flatten().astype(np.float64)

    if x.shape != y.shape:
        min_len = min(x.shape[0], y.shape[0])
        x = x[:min_len]
        y = y[:min_len]

    diff = x - y
    noise_norm = np.linalg.norm(diff)
    signal_norm = np.linalg.norm(x)

    if noise_norm > 0 and signal_norm > 0:
        snr = 20.0 * np.log10(signal_norm / noise_norm)
    else:
        snr = float('inf') if noise_norm == 0 else -float('inf')

    if signal_norm > 0 and np.linalg.norm(y) > 0:
        cos_sim = float(np.dot(x, y) / (signal_norm * np.linalg.norm(y)))
    else:
        cos_sim = 1.0 if noise_norm == 0 else 0.0

    abs_threshold = max(1e-6, float(np.abs(x).max()) * 1e-3)
    l0_count = int(np.sum(np.abs(diff) > abs_threshold))
    l0_total = int(diff.size)
    l0_ratio = l0_count / l0_total if l0_total > 0 else 0.0

    return {
        'snr_db': float(snr),
        'cosine': float(cos_sim),
        'l0_count': l0_count,
        'l0_total': l0_total,
        'l0_ratio': float(l0_ratio),
        'max_abs_diff': float(np.abs(diff).max()),
    }


def create_session(model_path, use_dml=True):
    """Create ONNX Runtime session with DML or CPU provider."""
    import onnxruntime as ort

    if use_dml:
        providers = ['DmlExecutionProvider', 'CPUExecutionProvider']
    else:
        providers = ['CPUExecutionProvider']

    sess_opts = ort.SessionOptions()
    sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    sess = ort.InferenceSession(model_path, sess_options=sess_opts, providers=providers)

    # Log actual provider
    actual_providers = sess.get_providers()
    logger.info(f"  Providers: {actual_providers}")
    return sess


def benchmark_model(sess, inputs, num_warmup=3, num_runs=10):
    """Benchmark model inference speed. Returns (avg_ms, std_ms)."""
    times = []
    # Warmup
    for _ in range(num_warmup):
        sess.run(None, inputs)

    # Measure
    for _ in range(num_runs):
        t0 = time.perf_counter()
        sess.run(None, inputs)
        elapsed = (time.perf_counter() - t0) * 1000
        times.append(elapsed)

    times = np.array(times)
    return float(times.mean()), float(times.std())


def compare_diff_step(seq_len=512):
    """Compare diff_step FP16 vs FP32."""
    logger.info("\n--- Comparing diff_step ---")
    logger.info(f"  seq_len={seq_len}")

    fp16_path = os.path.join(FP16_ONNX_DIR, 'diff_step_dml.onnx')
    fp32_path = os.path.join(FP32_ONNX_DIR, 'diff_step_dml.onnx')

    if not os.path.exists(fp16_path):
        logger.error(f"FP16 model not found: {fp16_path}")
        return None
    if not os.path.exists(fp32_path):
        logger.error(f"FP32 model not found: {fp32_path}")
        return None

    # Generate test inputs (FP32 baseline)
    np.random.seed(42)
    xt_input_f32 = np.random.randn(1, seq_len, 128).astype(np.float32)
    t_f32 = np.array([0.5], dtype=np.float32)
    cond_f32 = np.random.randn(1, seq_len, 1024).astype(np.float32) * 0.1
    xt_mask_f32 = np.ones((1, seq_len), dtype=np.float32)

    # FP16 versions for the pure-FP16 dynamo export (no keep_io_types)
    xt_input_f16 = xt_input_f32.astype(np.float16)
    t_f16 = t_f32.astype(np.float16)
    cond_f16 = cond_f32.astype(np.float16)
    xt_mask_f16 = xt_mask_f32.astype(np.float16)

    inputs_fp16 = {'xt_input': xt_input_f16, 't': t_f16, 'cond': cond_f16, 'xt_mask': xt_mask_f16}
    inputs_fp32 = {'xt_input': xt_input_f32, 't': t_f32, 'cond': cond_f32, 'xt_mask': xt_mask_f32}

    results = {}

    for label, path, inputs in [('fp16', fp16_path, inputs_fp16), ('fp32', fp32_path, inputs_fp32)]:
        logger.info(f"\n  [{label}] {path}")
        try:
            sess = create_session(path, use_dml=True)
            # Get output
            outputs = sess.run(None, inputs)
            out = outputs[0]

            # Benchmark
            avg_ms, std_ms = benchmark_model(sess, inputs, num_warmup=3, num_runs=10)
            logger.info(f"  [{label}] Output shape: {out.shape}, dtype: {out.dtype}")
            logger.info(f"  [{label}] Speed: {avg_ms:.2f} ± {std_ms:.2f} ms")

            results[label] = {
                'output': out,
                'avg_ms': avg_ms,
                'std_ms': std_ms,
            }
            del sess
        except Exception as e:
            logger.error(f"  [{label}] Failed: {e}")
            import traceback
            traceback.print_exc()
            return None

    # Compute precision metrics (FP16 vs FP32)
    fp32_out = results['fp32']['output']
    fp16_out = results['fp16']['output']

    # Ensure same dtype for comparison
    fp32_out_f = fp32_out.astype(np.float64)
    fp16_out_f = fp16_out.astype(np.float64)

    metrics = compute_metrics(fp32_out_f, fp16_out_f)
    logger.info(f"\n  Precision (FP16 vs FP32):")
    logger.info(f"    SNR: {metrics['snr_db']:.2f} dB")
    logger.info(f"    Cosine: {metrics['cosine']:.8f}")
    logger.info(f"    L0: {metrics['l0_count']}/{metrics['l0_total']} ({metrics['l0_ratio']*100:.4f}%)")
    logger.info(f"    Max abs diff: {metrics['max_abs_diff']:.6e}")

    # Speed comparison
    fp16_ms = results['fp16']['avg_ms']
    fp32_ms = results['fp32']['avg_ms']
    speedup = fp32_ms / fp16_ms if fp16_ms > 0 else 0
    logger.info(f"\n  Speed comparison:")
    logger.info(f"    FP16: {fp16_ms:.2f} ms")
    logger.info(f"    FP32: {fp32_ms:.2f} ms")
    logger.info(f"    Speedup: {speedup:.2f}x")

    return {
        'model': 'diff_step',
        'seq_len': seq_len,
        'precision': metrics,
        'speed': {
            'fp16_ms': fp16_ms,
            'fp32_ms': fp32_ms,
            'speedup': speedup,
        },
    }


def compare_vocoder(num_frames=200):
    """Compare vocoder FP16 vs FP32."""
    logger.info("\n--- Comparing vocoder ---")
    logger.info(f"  num_frames={num_frames}")

    fp16_path = os.path.join(FP16_ONNX_DIR, 'vocoder_dml.onnx')
    fp32_path = os.path.join(FP32_ONNX_DIR, 'vocoder_dml.onnx')

    if not os.path.exists(fp16_path):
        logger.error(f"FP16 model not found: {fp16_path}")
        return None
    if not os.path.exists(fp32_path):
        logger.error(f"FP32 model not found: {fp32_path}")
        return None

    # Generate test input (normalized mel, matching GTSinger distribution)
    np.random.seed(42)
    mel = (np.random.randn(1, num_frames, 128).astype(np.float32) * 0.989 - 0.393)

    inputs = {'mel': mel}

    results = {}

    for label, path in [('fp16', fp16_path), ('fp32', fp32_path)]:
        logger.info(f"\n  [{label}] {path}")
        try:
            sess = create_session(path, use_dml=True)
            outputs = sess.run(None, inputs)
            out = outputs[0]

            avg_ms, std_ms = benchmark_model(sess, inputs, num_warmup=3, num_runs=10)
            logger.info(f"  [{label}] Output shape: {out.shape}, dtype: {out.dtype}")
            logger.info(f"  [{label}] Speed: {avg_ms:.2f} ± {std_ms:.2f} ms")

            results[label] = {
                'output': out,
                'avg_ms': avg_ms,
                'std_ms': std_ms,
            }
            del sess
        except Exception as e:
            logger.error(f"  [{label}] Failed: {e}")
            import traceback
            traceback.print_exc()
            return None

    # Precision metrics
    fp32_out = results['fp32']['output']
    fp16_out = results['fp16']['output']

    metrics = compute_metrics(fp32_out.astype(np.float64), fp16_out.astype(np.float64))
    logger.info(f"\n  Precision (FP16 vs FP32):")
    logger.info(f"    SNR: {metrics['snr_db']:.2f} dB")
    logger.info(f"    Cosine: {metrics['cosine']:.8f}")
    logger.info(f"    L0: {metrics['l0_count']}/{metrics['l0_total']} ({metrics['l0_ratio']*100:.4f}%)")
    logger.info(f"    Max abs diff: {metrics['max_abs_diff']:.6e}")

    # Speed comparison
    fp16_ms = results['fp16']['avg_ms']
    fp32_ms = results['fp32']['avg_ms']
    speedup = fp32_ms / fp16_ms if fp16_ms > 0 else 0
    logger.info(f"\n  Speed comparison:")
    logger.info(f"    FP16: {fp16_ms:.2f} ms")
    logger.info(f"    FP32: {fp32_ms:.2f} ms")
    logger.info(f"    Speedup: {speedup:.2f}x")

    return {
        'model': 'vocoder',
        'num_frames': num_frames,
        'precision': metrics,
        'speed': {
            'fp16_ms': fp16_ms,
            'fp32_ms': fp32_ms,
            'speedup': speedup,
        },
    }


def phase_compare():
    """Phase 3: Compare FP16 vs FP32 ONNX speed and precision."""
    logger.info("=" * 60)
    logger.info("PHASE 3: Compare FP16 vs FP32 ONNX (speed + precision)")
    logger.info("=" * 60)

    all_results = []

    # Compare diff_step at multiple sequence lengths
    for seq_len in [256, 512, 1024]:
        r = compare_diff_step(seq_len=seq_len)
        if r:
            all_results.append(r)

    # Compare vocoder at multiple frame counts
    for num_frames in [100, 200, 500]:
        r = compare_vocoder(num_frames=num_frames)
        if r:
            all_results.append(r)

    # Save report
    report_path = os.path.join(FP16_ONNX_DIR, 'fp16_vs_fp32_comparison.json')
    os.makedirs(FP16_ONNX_DIR, exist_ok=True)
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(all_results, f, indent=2, ensure_ascii=False, default=str)
    logger.info(f"\nReport saved: {report_path}")

    # Print summary table
    logger.info("\n" + "=" * 60)
    logger.info("SUMMARY")
    logger.info("=" * 60)
    logger.info(f"{'Model':<20} {'Size':<12} {'SNR(dB)':<10} {'Cosine':<12} {'L0%':<10} {'FP16(ms)':<10} {'FP32(ms)':<10} {'Speedup':<8}")
    logger.info("-" * 92)
    for r in all_results:
        m = r['precision']
        s = r['speed']
        size = f"{r.get('seq_len', r.get('num_frames', ''))}"
        logger.info(f"{r['model']:<20} {size:<12} {m['snr_db']:<10.2f} {m['cosine']:<12.8f} "
                    f"{m['l0_ratio']*100:<10.4f} {s['fp16_ms']:<10.2f} {s['fp32_ms']:<10.2f} {s['speedup']:<8.2f}")

    logger.info("Phase 3 complete.")


# ============================================================
# Main
# ============================================================
def main():
    parser = argparse.ArgumentParser(description='Export FP16 ONNX, optimize with Olive, compare with FP32')
    parser.add_argument('--phase', type=str, default='all',
                        choices=['export', 'optimize', 'compare', 'all'],
                        help='Phase to run (default: all)')
    parser.add_argument('--models', nargs='+', default=None,
                        help='Models to optimize (e.g. vocoder_dml.onnx). Default: all')
    args = parser.parse_args()

    if args.phase in ('export', 'all'):
        phase_export()
    if args.phase in ('optimize', 'all'):
        phase_optimize(models=args.models)
    if args.phase in ('compare', 'all'):
        phase_compare()


if __name__ == '__main__':
    main()
