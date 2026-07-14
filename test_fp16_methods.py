# -*- coding: utf-8 -*-
"""Systematically test various Olive FP16 optimization methods for vocoder.

Tests each method individually, then combinations, to find the one with
minimal precision loss while still achieving FP16 speedup.

Methods tested:
  1. OrtMixedPrecision (auto mixed precision)
  2. OnnxFloatToFloat16 with CPU spec (W16A32, matches existing working model)
  3. OnnxFloatToFloat16 with DML spec + full op_block_list
  4. OnnxFloatToFloat16 with DML spec + node_block_list for ISTFT
  5. OrtTransformersOptimization with float16=True
  6. Combinations of the above

Each method is evaluated on:
  - SNR (dB) vs FP32 baseline
  - Cosine similarity
  - Inference speed (ms) and speedup vs FP32
"""
import os
os.environ['SKIP_ROPE_PRECOMPUTE'] = '1'

# Mock librosa before any imports that trigger it
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

import torch
import onnx
import onnxruntime as ort
from onnx import helper, numpy_helper, TensorProto, shape_inference

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FP32_ONNX_PATH = os.path.join(SCRIPT_DIR, 'onnx_models', 'vocoder_dml.onnx')
FP32_DYNAMO_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'fp16_dynamo')
FP32_DYNAMO_BASE = os.path.join(FP32_DYNAMO_DIR, '_vocoder_fp32_base.onnx')  # dynamo=True FP32 base
TEST_DIR = os.path.join(FP32_DYNAMO_DIR, '_fp16_tests')
RESULTS_PATH = os.path.join(FP32_DYNAMO_DIR, 'fp16_methods_comparison.json')


def export_fp32_dynamo_base():
    """Export vocoder as FP32 ONNX via dynamo=True (base for all FP16 tests)."""
    if os.path.exists(FP32_DYNAMO_BASE) and os.path.exists(FP32_DYNAMO_BASE + '.data'):
        logger.info(f"FP32 dynamo base already exists: {FP32_DYNAMO_BASE}")
        return

    from export_shared import load_config, load_model, VocosFullWrapper
    config = load_config()
    model_path = os.path.join(SCRIPT_DIR, 'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt')
    model = load_model(config, model_path)
    wrapper = VocosFullWrapper(model.vocoder).eval()

    mel = torch.randn(1, 500, 128, dtype=torch.float32)
    os.makedirs(FP32_DYNAMO_DIR, exist_ok=True)

    tmp_path = FP32_DYNAMO_BASE + '.raw.onnx'
    with torch.no_grad():
        torch.onnx.export(
            wrapper, (mel,), tmp_path,
            input_names=['mel'], output_names=['waveform'],
            opset_version=20, dynamo=True,
            dynamic_axes={'mel': {1: 'num_frames'}, 'waveform': {1: 'audio_len'}},
        )

    # Post-process: shape inference + save with external data
    onnx_model = onnx.load(tmp_path)
    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    if os.path.exists(tmp_path + '.data'):
        os.remove(tmp_path + '.data')
    onnx_model = shape_inference.infer_shapes(onnx_model, check_type=False, strict_mode=False)

    if os.path.exists(FP32_DYNAMO_BASE):
        os.remove(FP32_DYNAMO_BASE)
    if os.path.exists(FP32_DYNAMO_BASE + '.data'):
        os.remove(FP32_DYNAMO_BASE + '.data')

    onnx.save_model(onnx_model, FP32_DYNAMO_BASE,
                    save_as_external_data=True, all_tensors_to_one_file=True,
                    location=os.path.basename(FP32_DYNAMO_BASE) + '.data', size_threshold=1024)

    size_mb = os.path.getsize(FP32_DYNAMO_BASE) / 1024 / 1024
    data_mb = os.path.getsize(FP32_DYNAMO_BASE + '.data') / 1024 / 1024
    logger.info(f"FP32 dynamo base saved: {size_mb:.1f}MB + {data_mb:.1f}MB data")

    del wrapper, model, onnx_model
    gc.collect()


def compute_metrics(fp32_out, fp16_out):
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
    return {
        'snr_db': float(snr),
        'cosine': float(cos_sim),
        'max_abs_diff': float(np.abs(diff).max()),
        'out_std': float(y.std()),
    }


def benchmark_session(sess, inputs, num_warmup=3, num_runs=10):
    for _ in range(num_warmup):
        sess.run(None, inputs)
    times = []
    for _ in range(num_runs):
        t0 = time.perf_counter()
        sess.run(None, inputs)
        times.append((time.perf_counter() - t0) * 1000)
    times = np.array(times)
    return float(times.mean()), float(times.std())


def evaluate_model(model_path, mel_input, fp32_output, fp32_time_ms):
    """Evaluate a model: precision + speed. Returns dict or None on failure."""
    try:
        sess = ort.InferenceSession(model_path, providers=['DmlExecutionProvider', 'CPUExecutionProvider'])
        out = sess.run(None, {'mel': mel_input})[0]
        avg_ms, std_ms = benchmark_session(sess, {'mel': mel_input})
        metrics = compute_metrics(fp32_output, out)
        metrics['avg_ms'] = avg_ms
        metrics['std_ms'] = std_ms
        metrics['speedup'] = fp32_time_ms / avg_ms if avg_ms > 0 else 0
        del sess
        return metrics
    except Exception as e:
        logger.error(f"  Evaluation failed: {e}")
        return None


def get_fp32_baseline(mel_input):
    """Get FP32 baseline output and timing."""
    sess = ort.InferenceSession(FP32_ONNX_PATH, providers=['DmlExecutionProvider', 'CPUExecutionProvider'])
    out = sess.run(None, {'mel': mel_input})[0]
    avg_ms, std_ms = benchmark_session(sess, {'mel': mel_input})
    del sess
    return out, avg_ms, std_ms


# ============================================================
# FP16 conversion methods
# ============================================================
def method_ort_mixed_precision(input_path, output_path, work_dir):
    """Method 1: OrtMixedPrecision (auto mixed precision) with keep_io_types."""
    from olive.hardware.accelerator import AcceleratorSpec, Device
    from olive.hardware.constants import ExecutionProvider
    from olive.model import ONNXModelHandler
    from olive.passes.onnx.mixed_precision import OrtMixedPrecision
    from olive.passes.onnx.float16_conversion import OnnxFloatToFloat16

    ACCEL_SPEC = AcceleratorSpec(
        accelerator_type=Device.GPU,
        execution_provider=ExecutionProvider.DmlExecutionProvider,
    )

    model = ONNXModelHandler(model_path=input_path)
    config = OrtMixedPrecision.generate_config(ACCEL_SPEC, {})
    pass_obj = OrtMixedPrecision(ACCEL_SPEC, config)
    model = pass_obj.run(model, str(work_dir))

    # OrtMixedPrecision doesn't set keep_io_types, so manually convert IO to FP32
    # by post-processing with OnnxFloatToFloat16 keep_io_types=True (no op_block_list
    # since the model is already FP16 internally)
    proto = onnx.load(Path(model.model_path), load_external_data=True)
    # Use onnxruntime's float16 converter to fix IO types
    from onnxruntime.transformers.float16 import convert_float_to_float16
    proto = convert_float_to_float16(
        proto,
        keep_io_types=True,
        op_block_list=[],  # don't block any ops, just fix IO
        node_block_list=[],
    )
    _save_proto(proto, output_path)
    return output_path


def method_float16_cpu_spec(input_path, output_path, work_dir):
    """Method 2: OnnxFloatToFloat16 with CPU spec (matches existing working model)."""
    from olive.hardware.accelerator import AcceleratorSpec
    from olive.model import ONNXModelHandler
    from olive.passes.onnx.quantization import OnnxQuantizationPreprocess
    from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer
    from olive.passes.onnx.float16_conversion import OnnxFloatToFloat16

    CPU_SPEC = AcceleratorSpec(accelerator_type="cpu", execution_provider="CPUExecutionProvider")
    OP_BLOCK_LIST = [
        'Softmax', 'LayerNormalization', 'ReduceMean', 'Pow', 'Sqrt',
        'Reciprocal', 'Exp', 'Cos', 'Sin', 'Erf', 'Sigmoid', 'Tanh',
    ]

    model = ONNXModelHandler(model_path=input_path)

    # Preprocess
    config = OnnxQuantizationPreprocess.generate_config(CPU_SPEC, {"skip_symbolic_shape": True})
    model = OnnxQuantizationPreprocess(CPU_SPEC, config).run(model, str(work_dir / "preprocessed"))

    # Peephole
    config = OnnxPeepholeOptimizer.generate_config(CPU_SPEC)
    model = OnnxPeepholeOptimizer(CPU_SPEC, config).run(model, str(work_dir / "peephole"))

    # FP16 conversion
    config = OnnxFloatToFloat16.generate_config(CPU_SPEC, {
        "op_block_list": OP_BLOCK_LIST,
        "keep_io_types": True,
    })
    model = OnnxFloatToFloat16(CPU_SPEC, config).run(model, str(work_dir / "fp16"))

    _copy_output(model, output_path)
    return output_path


def method_float16_dml_full_block(input_path, output_path, work_dir):
    """Method 3: OnnxFloatToFloat16 with DML spec + full op_block_list (current approach)."""
    from olive.hardware.accelerator import AcceleratorSpec, Device
    from olive.hardware.constants import ExecutionProvider
    from olive.model import ONNXModelHandler
    from olive.passes.onnx.quantization import OnnxQuantizationPreprocess
    from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer
    from olive.passes.onnx.float16_conversion import OnnxFloatToFloat16

    ACCEL_SPEC = AcceleratorSpec(
        accelerator_type=Device.GPU,
        execution_provider=ExecutionProvider.DmlExecutionProvider,
    )
    OP_BLOCK_LIST = [
        'Softmax', 'LayerNormalization', 'ReduceMean', 'Pow', 'Sqrt',
        'Reciprocal', 'Exp', 'Cos', 'Sin', 'Erf', 'Sigmoid', 'Tanh',
        'Div', 'Clip',
    ]

    model = ONNXModelHandler(model_path=input_path)

    config = OnnxQuantizationPreprocess.generate_config(ACCEL_SPEC, {"skip_symbolic_shape": True})
    model = OnnxQuantizationPreprocess(ACCEL_SPEC, config).run(model, str(work_dir / "preprocessed"))

    config = OnnxPeepholeOptimizer.generate_config(ACCEL_SPEC)
    model = OnnxPeepholeOptimizer(ACCEL_SPEC, config).run(model, str(work_dir / "peephole"))

    config = OnnxFloatToFloat16.generate_config(ACCEL_SPEC, {
        "op_block_list": OP_BLOCK_LIST,
        "keep_io_types": True,
    })
    model = OnnxFloatToFloat16(ACCEL_SPEC, config).run(model, str(work_dir / "fp16"))

    _copy_output(model, output_path)
    return output_path


def method_float16_dml_node_block(input_path, output_path, work_dir):
    """Method 4: OnnxFloatToFloat16 with DML spec + node_block_list for ISTFT nodes."""
    from olive.hardware.accelerator import AcceleratorSpec, Device
    from olive.hardware.constants import ExecutionProvider
    from olive.model import ONNXModelHandler
    from olive.passes.onnx.quantization import OnnxQuantizationPreprocess
    from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer
    from olive.passes.onnx.float16_conversion import OnnxFloatToFloat16

    ACCEL_SPEC = AcceleratorSpec(
        accelerator_type=Device.GPU,
        execution_provider=ExecutionProvider.DmlExecutionProvider,
    )
    # Block all sensitive ops + use node_block_list for ISTFT MatMul nodes
    OP_BLOCK_LIST = [
        'Softmax', 'LayerNormalization', 'ReduceMean', 'Pow', 'Sqrt',
        'Reciprocal', 'Exp', 'Cos', 'Sin', 'Erf', 'Sigmoid', 'Tanh',
        'Div', 'Clip',
        'MatMul',  # Block ALL MatMul to keep ISTFT basis in FP32
    ]

    model = ONNXModelHandler(model_path=input_path)

    config = OnnxQuantizationPreprocess.generate_config(ACCEL_SPEC, {"skip_symbolic_shape": True})
    model = OnnxQuantizationPreprocess(ACCEL_SPEC, config).run(model, str(work_dir / "preprocessed"))

    config = OnnxPeepholeOptimizer.generate_config(ACCEL_SPEC)
    model = OnnxPeepholeOptimizer(ACCEL_SPEC, config).run(model, str(work_dir / "peephole"))

    config = OnnxFloatToFloat16.generate_config(ACCEL_SPEC, {
        "op_block_list": OP_BLOCK_LIST,
        "keep_io_types": True,
    })
    model = OnnxFloatToFloat16(ACCEL_SPEC, config).run(model, str(work_dir / "fp16"))

    _copy_output(model, output_path)
    return output_path


def method_transformer_opt_fp16(input_path, output_path, work_dir):
    """Method 5: OrtTransformersOptimization with float16=True."""
    from olive.hardware.accelerator import AcceleratorSpec, Device
    from olive.hardware.constants import ExecutionProvider
    from olive.model import ONNXModelHandler
    from olive.passes.onnx.transformer_optimization import OrtTransformersOptimization

    ACCEL_SPEC = AcceleratorSpec(
        accelerator_type=Device.GPU,
        execution_provider=ExecutionProvider.DmlExecutionProvider,
    )
    FORCE_FP32_OPS = [
        'Softmax', 'LayerNormalization', 'ReduceMean', 'Pow', 'Sqrt',
        'Reciprocal', 'Exp', 'Cos', 'Sin', 'Erf', 'Sigmoid', 'Tanh',
        'Div', 'Clip',
    ]

    model = ONNXModelHandler(model_path=input_path)
    config = OrtTransformersOptimization.generate_config(ACCEL_SPEC, {
        "float16": True,
        "keep_io_types": True,
        "force_fp32_ops": FORCE_FP32_OPS,
    })
    pass_obj = OrtTransformersOptimization(ACCEL_SPEC, config)
    model = pass_obj.run(model, str(work_dir / "transformer_opt"))

    _copy_output(model, output_path)
    return output_path


def method_mixed_precision_then_peephole(input_path, output_path, work_dir):
    """Method 6 (combo): OrtMixedPrecision + OnnxPeepholeOptimizer + IO fix."""
    from olive.hardware.accelerator import AcceleratorSpec, Device
    from olive.hardware.constants import ExecutionProvider
    from olive.model import ONNXModelHandler
    from olive.passes.onnx.mixed_precision import OrtMixedPrecision
    from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer

    ACCEL_SPEC = AcceleratorSpec(
        accelerator_type=Device.GPU,
        execution_provider=ExecutionProvider.DmlExecutionProvider,
    )

    model = ONNXModelHandler(model_path=input_path)

    # Step 1: Mixed precision
    config = OrtMixedPrecision.generate_config(ACCEL_SPEC, {
        "op_block_list": [
            'Softmax', 'LayerNormalization', 'ReduceMean', 'Pow', 'Sqrt',
            'Reciprocal', 'Exp', 'Cos', 'Sin', 'Erf', 'Sigmoid', 'Tanh',
            'Div', 'Clip', 'Add',  # Add is in default block list
        ],
    })
    model = OrtMixedPrecision(ACCEL_SPEC, config).run(model, str(work_dir / "mixed"))

    # Step 2: Peephole to clean up Cast chains
    config = OnnxPeepholeOptimizer.generate_config(ACCEL_SPEC)
    model = OnnxPeepholeOptimizer(ACCEL_SPEC, config).run(model, str(work_dir / "peephole"))

    # Step 3: Fix IO types to FP32
    proto = onnx.load(Path(model.model_path), load_external_data=True)
    from onnxruntime.transformers.float16 import convert_float_to_float16
    proto = convert_float_to_float16(proto, keep_io_types=True, op_block_list=[], node_block_list=[])
    _save_proto(proto, output_path)
    return output_path


def method_float16_dml_then_restore_istft(input_path, output_path, work_dir):
    """Method 7 (combo): DML FP16 + manual ISTFT basis restoration to FP32."""
    from export_shared import resolve_neg1_in_reshape_shapes

    # First run method 3 (DML full block)
    tmp_path = output_path + '.tmp'
    method_float16_dml_full_block(input_path, tmp_path, work_dir / "step1")

    # Then restore ISTFT basis to FP32
    model_proto = onnx.load(tmp_path, load_external_data=True)

    # Find ISTFT basis initializers (shape [1920, 961], small values)
    ISTFT_BASIS_SHAPE = (1920, 961)
    ISTFT_BASIS_MAX_VAL = 0.002
    istft_inits = []
    for init in model_proto.graph.initializer:
        if init.dims == list(ISTFT_BASIS_SHAPE):
            arr = numpy_helper.to_array(init)
            if arr.dtype == np.float16 and float(np.abs(arr).max()) < ISTFT_BASIS_MAX_VAL:
                istft_inits.append(init.name)

    if not istft_inits:
        logger.warning("  No ISTFT basis found to restore")
        shutil.copy2(tmp_path, output_path)
        for ext in ['.data', '.onnx.data']:
            src = tmp_path + ext
            if os.path.exists(src):
                shutil.copy2(src, output_path + ext)
    else:
        logger.info(f"  Restoring {len(istft_inits)} ISTFT basis matrices to FP32")
        # Convert basis inits to FP32
        new_inits = []
        for init in model_proto.graph.initializer:
            if init.name in istft_inits:
                arr = numpy_helper.to_array(init).astype(np.float32)
                new_inits.append(numpy_helper.from_array(arr, name=init.name))
            else:
                new_inits.append(init)
        del model_proto.graph.initializer[:]
        model_proto.graph.initializer.extend(new_inits)

        # Insert Cast nodes around MatMul ops using ISTFT basis
        new_nodes = []
        cast_counter = 0
        for node in model_proto.graph.node:
            if node.op_type == 'MatMul':
                basis_idx = None
                other_idx = None
                for i, inp in enumerate(node.input):
                    if inp in istft_inits:
                        basis_idx = i
                        other_idx = 1 - i
                        break
                if basis_idx is not None:
                    other_input = node.input[other_idx]
                    original_output = node.output[0]

                    cast_in_name = f"_istft_cast_in_{cast_counter}"
                    new_nodes.append(helper.make_node(
                        'Cast', inputs=[other_input], outputs=[cast_in_name],
                        to=TensorProto.FLOAT, name=f"_istft_cast_in_node_{cast_counter}",
                    ))
                    node.input[other_idx] = cast_in_name

                    fp32_output = f"_istft_matmul_fp32_{cast_counter}"
                    node.output[0] = fp32_output
                    new_nodes.append(node)
                    new_nodes.append(helper.make_node(
                        'Cast', inputs=[fp32_output], outputs=[original_output],
                        to=TensorProto.FLOAT16, name=f"_istft_cast_out_node_{cast_counter}",
                    ))
                    cast_counter += 1
                    continue
            new_nodes.append(node)
        del model_proto.graph.node[:]
        model_proto.graph.node.extend(new_nodes)

        # Save
        _save_proto(model_proto, output_path)

    # Cleanup tmp
    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    for ext in ['.data', '.onnx.data']:
        p = tmp_path + ext
        if os.path.exists(p):
            os.remove(p)

    return output_path


def _copy_output(model, output_path):
    """Copy Olive model output to target path."""
    final_path = Path(model.model_path)
    if final_path != Path(output_path):
        shutil.copy2(final_path, output_path)
    # Copy external data files
    for data_file in final_path.parent.glob("*.data"):
        if data_file.name == final_path.name + ".data":
            shutil.copy2(data_file, output_path + ".data")
        elif data_file.name == final_path.stem + ".onnx.data":
            shutil.copy2(data_file, output_path.replace(".onnx", ".onnx.data"))


def _save_proto(proto, output_path):
    """Save ONNX proto with external data format."""
    if os.path.exists(output_path):
        os.remove(output_path)
    for ext in ['.data', '.onnx.data']:
        p = output_path + ext if ext == '.data' else output_path.replace('.onnx', ext)
        if os.path.exists(p):
            os.remove(p)
    onnx.save_model(proto, output_path,
                    save_as_external_data=True, all_tensors_to_one_file=True,
                    location=os.path.basename(output_path) + '.data', size_threshold=1024)


# ============================================================
# Main test runner
# ============================================================
METHODS = [
    ('1_ort_mixed_precision', method_ort_mixed_precision),
    # Methods 2/3/4 already tested in round 1:
    #   2_float16_cpu_spec:       SNR=33.18dB, cos=0.99976, 19.04ms, 15.07x, 494.3MB
    #   3_float16_dml_full_block: SNR=33.18dB, cos=0.99976, 17.36ms, 16.52x, 494.3MB
    #   4_float16_dml_node_block: SNR=40.99dB, cos=0.99996, 32.74ms, 8.76x, 985.1MB
    ('6_mixed_precision_peephole', method_mixed_precision_then_peephole),
    ('7_dml_fp16_restore_istft', method_float16_dml_then_restore_istft),
]


def run_tests():
    os.makedirs(TEST_DIR, exist_ok=True)

    # Step 1: Export FP32 dynamo base
    logger.info("=" * 60)
    logger.info("Step 1: Export FP32 dynamo base model")
    logger.info("=" * 60)
    export_fp32_dynamo_base()

    # Step 2: Get FP32 baseline
    logger.info("\n" + "=" * 60)
    logger.info("Step 2: Get FP32 baseline")
    logger.info("=" * 60)
    np.random.seed(42)
    mel_input = (np.random.randn(1, 200, 128).astype(np.float32) * 0.989 - 0.393)
    fp32_output, fp32_ms, fp32_std = get_fp32_baseline(mel_input)
    logger.info(f"FP32 baseline: mean={fp32_output.mean():.6f}, std={fp32_output.std():.6f}, speed={fp32_ms:.2f}ms")

    # Also test FP32 dynamo base
    fp32_dyn_metrics = evaluate_model(FP32_DYNAMO_BASE, mel_input, fp32_output, fp32_ms)
    if fp32_dyn_metrics:
        logger.info(f"FP32 dynamo base vs FP32 legacy: SNR={fp32_dyn_metrics['snr_db']:.2f}dB, speed={fp32_dyn_metrics['avg_ms']:.2f}ms")

    # Step 3: Test each method
    results = {
        'fp32_baseline': {
            'speed_ms': fp32_ms,
            'speed_std': fp32_std,
            'output_std': float(fp32_output.std()),
        },
        'fp32_dynamo_base': fp32_dyn_metrics,
        'methods': {},
    }

    for method_name, method_func in METHODS:
        logger.info("\n" + "=" * 60)
        logger.info(f"Testing: {method_name}")
        logger.info("=" * 60)

        output_path = os.path.join(TEST_DIR, f'vocoder_{method_name}.onnx')
        work_dir = Path(TEST_DIR) / f'_work_{method_name}'

        # Clean previous
        if os.path.exists(output_path):
            os.remove(output_path)
        for ext in ['.data', '.onnx.data']:
            p = output_path + ext
            if os.path.exists(p):
                os.remove(p)
        if work_dir.exists():
            shutil.rmtree(work_dir, ignore_errors=True)
        work_dir.mkdir(parents=True)

        try:
            t0 = time.time()
            method_func(FP32_DYNAMO_BASE, output_path, work_dir)
            elapsed = time.time() - t0
            logger.info(f"  Conversion done in {elapsed:.1f}s")

            # Evaluate
            metrics = evaluate_model(output_path, mel_input, fp32_output, fp32_ms)
            if metrics:
                # Add model size
                size_mb = os.path.getsize(output_path) / 1024 / 1024
                data_path = output_path + '.data'
                if os.path.exists(data_path):
                    size_mb += os.path.getsize(data_path) / 1024 / 1024
                data_path2 = output_path.replace('.onnx', '.onnx.data')
                if os.path.exists(data_path2):
                    size_mb += os.path.getsize(data_path2) / 1024 / 1024
                metrics['model_size_mb'] = size_mb
                metrics['conversion_time_s'] = elapsed

                logger.info(f"  SNR: {metrics['snr_db']:.2f} dB")
                logger.info(f"  Cosine: {metrics['cosine']:.8f}")
                logger.info(f"  Speed: {metrics['avg_ms']:.2f} ms (speedup: {metrics['speedup']:.2f}x)")
                logger.info(f"  Size: {size_mb:.1f} MB")
                logger.info(f"  Output std: {metrics['out_std']:.6f}")

                results['methods'][method_name] = metrics
            else:
                results['methods'][method_name] = {'error': 'evaluation failed'}
                logger.error(f"  {method_name}: evaluation failed")

        except Exception as e:
            logger.error(f"  {method_name} failed: {e}", exc_info=True)
            results['methods'][method_name] = {'error': str(e)}

        # Cleanup work dir to save disk
        if work_dir.exists():
            shutil.rmtree(work_dir, ignore_errors=True)
        gc.collect()

    # Save results
    with open(RESULTS_PATH, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False, default=str)
    logger.info(f"\nResults saved: {RESULTS_PATH}")

    # Print summary
    logger.info("\n" + "=" * 80)
    logger.info("SUMMARY: FP16 Optimization Methods Comparison")
    logger.info("=" * 80)
    logger.info(f"FP32 baseline: {fp32_ms:.2f} ms, output std={fp32_output.std():.6f}")
    logger.info("-" * 80)
    logger.info(f"{'Method':<35} {'SNR(dB)':<10} {'Cosine':<12} {'Speed(ms)':<12} {'Speedup':<8} {'Size(MB)':<10} {'OutStd':<10}")
    logger.info("-" * 80)
    for method_name, _ in METHODS:
        r = results['methods'].get(method_name, {})
        if 'error' in r:
            logger.info(f"{method_name:<35} ERROR: {r['error'][:40]}")
        else:
            logger.info(f"{method_name:<35} {r['snr_db']:<10.2f} {r['cosine']:<12.8f} "
                        f"{r['avg_ms']:<12.2f} {r['speedup']:<8.2f} {r['model_size_mb']:<10.1f} {r['out_std']:<10.6f}")

    # Cleanup test models (keep only the best one)
    logger.info("\nCleaning up test models...")
    best_method = None
    best_snr = -float('inf')
    for method_name, _ in METHODS:
        r = results['methods'].get(method_name, {})
        if 'error' not in r and r['snr_db'] > best_snr and r['cosine'] > 0.99:
            best_snr = r['snr_db']
            best_method = method_name

    if best_method:
        logger.info(f"Best method: {best_method} (SNR={best_snr:.2f}dB)")
        # Keep best, delete others
        best_path = os.path.join(TEST_DIR, f'vocoder_{best_method}.onnx')
        for method_name, _ in METHODS:
            if method_name != best_method:
                p = os.path.join(TEST_DIR, f'vocoder_{method_name}.onnx')
                if os.path.exists(p):
                    os.remove(p)
                for ext in ['.data', '.onnx.data']:
                    pp = p + ext
                    if os.path.exists(pp):
                        os.remove(pp)
    else:
        logger.warning("No valid method found with cos > 0.99")


if __name__ == '__main__':
    run_tests()
