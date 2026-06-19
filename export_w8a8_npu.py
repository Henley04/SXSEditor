# -*- coding: utf-8 -*-
"""
W8A8 PTQ pipeline.

Flow:
  1. Load PyTorch FP32 model (SoulX-Singer)
  2. For each sub-model:
     a. Export to FP32 ONNX (torch.onnx.export with dynamo=True)
     b. Generate calibration data from PyTorch FP32 model
     c. ORT W8A8 static quantization (QDQ format, calibration-based)
     d. Save INT8 → onnx_models/int8/
     e. NPU-optimize → onnx_models/int8/optimized_npu/

Memory management: one model at a time, explicit cleanup between models.
GPU acceleration: use CUDA if available for PyTorch inference.
"""

import os
import sys
import gc
import time
import argparse
import shutil
import numpy as np

# Force UTF-8 output to avoid GBK encoding errors on Windows
os.environ['PYTHONIOENCODING'] = 'utf-8'
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

import torch

# Add SoulX-Singer to path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SOULX_DIR = os.path.join(SCRIPT_DIR, 'SoulX-Singer')

# Import shared utilities (patches, model loading, wrappers)
from export_shared import (
    load_config, load_model, clear_memory,
    DiffStepWrapper, VocoderBackboneWrapper,
    DEFAULT_OUTPUT_DIR, postprocess_onnx,
)

import onnx
from onnx import helper, numpy_helper, TensorProto, shape_inference

# Output directories
INT8_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'int8')
NPU_DIR = os.path.join(INT8_DIR, 'optimized_npu')
FP32_TEMP_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'int8', 'temp_fp32')

# Static shapes for NPU
SEQ_LEN = 2048
VOCODER_SEQ_LEN = 500
WAVEFORM_SAMPLES = 240000  # 10s @ 24kHz

DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'

# ============================================================
# Sub-model wrappers (for PyTorch export)
# ============================================================

class NoteTextEncoderWrapper(torch.nn.Module):
    def __init__(self, encoder):
        super().__init__()
        self.encoder = encoder
    def forward(self, input_ids):
        return self.encoder(input_ids)

class NotePitchEncoderWrapper(torch.nn.Module):
    def __init__(self, encoder):
        super().__init__()
        self.encoder = encoder
    def forward(self, input_ids):
        return self.encoder(input_ids)

class NoteTypeEncoderWrapper(torch.nn.Module):
    def __init__(self, encoder):
        super().__init__()
        self.encoder = encoder
    def forward(self, input_ids):
        return self.encoder(input_ids)

class F0EncoderWrapper(torch.nn.Module):
    def __init__(self, encoder):
        super().__init__()
        self.encoder = encoder
    def forward(self, input_ids):
        return self.encoder(input_ids)

class PreflowWrapper(torch.nn.Module):
    def __init__(self, preflow):
        super().__init__()
        self.preflow = preflow
    def forward(self, features):
        return self.preflow(features)

class CondEmbWrapper(torch.nn.Module):
    def __init__(self, cond_emb):
        super().__init__()
        self.cond_emb = cond_emb
    def forward(self, cond_code):
        return self.cond_emb(cond_code)

class MelTransformWrapper(torch.nn.Module):
    def __init__(self, mel):
        super().__init__()
        self.mel = mel
    def forward(self, waveform):
        return self.mel(waveform)


# ============================================================
# Model definitions
# ============================================================

MODELS = [
    {
        'name': 'note_text_encoder',
        'wrapper': 'note_text_encoder',
        'inputs': {'input_ids': (torch.long, [1, SEQ_LEN])},
        'quantizable': False,  # Pure Embedding, no quantizable ops
    },
    {
        'name': 'note_pitch_encoder',
        'wrapper': 'note_pitch_encoder',
        'inputs': {'input_ids': (torch.long, [1, SEQ_LEN])},
        'quantizable': False,
    },
    {
        'name': 'note_type_encoder',
        'wrapper': 'note_type_encoder',
        'inputs': {'input_ids': (torch.long, [1, SEQ_LEN])},
        'quantizable': False,
    },
    {
        'name': 'f0_encoder',
        'wrapper': 'f0_encoder',
        'inputs': {'input_ids': (torch.long, [1, SEQ_LEN])},
        'quantizable': False,
    },
    {
        'name': 'preflow',
        'wrapper': 'preflow',
        'inputs': {'features': (torch.float32, [1, SEQ_LEN, 512])},
        'quantizable': True,
    },
    {
        'name': 'cond_emb',
        'wrapper': 'cond_emb',
        'inputs': {'cond_code': (torch.float32, [1, SEQ_LEN, 512])},
        'quantizable': True,
    },
    {
        'name': 'diff_step',
        'wrapper': 'diff_step',
        'inputs': {
            'xt_input': (torch.float32, [1, SEQ_LEN, 128]),
            't': (torch.float32, [1]),
            'cond': (torch.float32, [1, SEQ_LEN, 512]),
            'xt_mask': (torch.float32, [1, SEQ_LEN]),
        },
        'quantizable': True,
    },
    {
        'name': 'vocoder',
        'wrapper': 'vocoder',
        'inputs': {'mel': (torch.float32, [1, VOCODER_SEQ_LEN, 128])},
        'quantizable': True,
    },
    {
        'name': 'mel_transform',
        'wrapper': 'mel_transform',
        'inputs': {'waveform': (torch.float32, [1, WAVEFORM_SAMPLES])},
        'quantizable': False,  # Uses STFT, not compatible with standard quantization
    },
]


# ============================================================
# Helpers
# ============================================================

def make_dummy_inputs(inputs_spec):
    """Create dummy tensors from input spec."""
    feeds = {}
    for name, (dtype, shape) in inputs_spec.items():
        if dtype == torch.long:
            feeds[name] = torch.randint(0, 100, shape, dtype=torch.long)
        else:
            feeds[name] = torch.randn(shape, dtype=dtype)
    return feeds

def get_sub_model(model, wrapper_name):
    """Extract sub-model from SoulX-Singer."""
    if wrapper_name == 'note_text_encoder':
        return NoteTextEncoderWrapper(model.note_text_encoder)
    elif wrapper_name == 'note_pitch_encoder':
        return NotePitchEncoderWrapper(model.note_pitch_encoder)
    elif wrapper_name == 'note_type_encoder':
        return NoteTypeEncoderWrapper(model.note_type_encoder)
    elif wrapper_name == 'f0_encoder':
        return F0EncoderWrapper(model.f0_encoder)
    elif wrapper_name == 'preflow':
        return PreflowWrapper(model.preflow)
    elif wrapper_name == 'cond_emb':
        return CondEmbWrapper(model.cfm_decoder.model.cond_emb)
    elif wrapper_name == 'diff_step':
        return DiffStepWrapper(model.cfm_decoder)
    elif wrapper_name == 'vocoder':
        return VocoderBackboneWrapper(model.vocoder)
    elif wrapper_name == 'mel_transform':
        return MelTransformWrapper(model.mel)
    else:
        raise ValueError(f"Unknown wrapper: {wrapper_name}")


def export_fp32_onnx(wrapper, dummy_inputs, output_path, model_name, use_dynamo=True):
    """Export PyTorch model to FP32 ONNX."""
    input_names = list(dummy_inputs.keys())
    dummy_tuple = tuple(dummy_inputs.values())

    with torch.no_grad():
        if use_dynamo:
            torch.onnx.export(
                wrapper,
                dummy_tuple,
                output_path,
                input_names=input_names,
                output_names=['output'],
                opset_version=18,
                dynamo=True,
            )
        else:
            torch.onnx.export(
                wrapper,
                dummy_tuple,
                output_path,
                input_names=input_names,
                output_names=['output'],
                opset_version=18,
                dynamo=False,
            )

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"    FP32 ONNX: {model_name}.onnx ({size_mb:.1f} MB)")
    return output_path


def generate_calibration_data_onnx(fp32_model_path, inputs_spec, num_samples=20):
    """Generate calibration data by running the FP32 PyTorch model.

    Returns a list of numpy dicts suitable for ORT's CalibrationDataReader.
    """
    feeds_list = []
    for _ in range(num_samples):
        feeds = {}
        for name, (dtype, shape) in inputs_spec.items():
            if dtype == torch.long:
                feeds[name] = np.random.randint(0, 255, size=shape).astype(np.int64)
            elif name == 't':
                feeds[name] = np.random.rand(*shape).astype(np.float32)
            elif name == 'xt_mask':
                feeds[name] = np.ones(shape, dtype=np.float32)
            else:
                feeds[name] = np.random.randn(*shape).astype(np.float32)
        feeds_list.append(feeds)
    return feeds_list


def quantize_w8a8_ort(fp32_onnx_path, int8_onnx_path, model_name, inputs_spec):
    """Apply ORT W8A8 static quantization (QDQ format).

    QDQ format: QuantizeLinear + DequantizeLinear + MatMul pattern.
    NPU compiler fuses QDQ into native INT8 MACs (true W8A8 execution).
    """
    from onnxruntime.quantization import quantize, QuantFormat, QuantType, CalibrationDataReader, StaticQuantConfig

    print(f"    Quantizing W8A8 with ORT (QDQ format)...")

    # Generate calibration data
    calib_data = generate_calibration_data_onnx(fp32_onnx_path, inputs_spec, num_samples=20)

    class CalibReader(CalibrationDataReader):
        def __init__(self, data_list):
            self.data = data_list
            self.idx = 0
        def get_next(self):
            if self.idx >= len(self.data):
                return None
            result = self.data[self.idx]
            self.idx += 1
            return result

    reader = CalibReader(calib_data)

    config = StaticQuantConfig(
        calibration_data_reader=reader,
        quant_format=QuantFormat.QDQ,  # QDQ format: NPU fuses QDQ → native INT8 MACs
        per_channel=False,
        reduce_range=False,
        op_types_to_quantize=['MatMul', 'Conv', 'Gemm'],
        extra_options={
            'ActivationSymmetric': False,
            'WeightSymmetric': True,
            'QuantizeBias': False,
            'AddQDQPairToWeight': True,  # Full QDQ on weights for NPU fusion
        },
    )

    quantize(
        model_input=fp32_onnx_path,
        model_output=int8_onnx_path,
        quant_config=config,
    )

    size_mb = os.path.getsize(int8_onnx_path) / (1024 * 1024)
    data_path = int8_onnx_path + '.data'
    data_mb = os.path.getsize(data_path) / (1024 * 1024) if os.path.exists(data_path) else 0

    # Check quantization result
    qmodel = onnx.load(int8_onnx_path, load_external_data=False)
    ops = {}
    for n in qmodel.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    ql = ops.get('QuantizeLinear', 0)
    dql = ops.get('DequantizeLinear', 0)

    print(f"    INT8 ONNX: {model_name}.onnx ({size_mb:.1f} MB + {data_mb:.1f} MB data)")
    print(f"    QDQ nodes: {ql} QuantizeLinear + {dql} DequantizeLinear")

    return qmodel


def optimize_onnx_model(input_path, output_path, model_name, fix_scale_rank=True):
    """Optimize an ONNX model for W8A8 deployment.

    fix_scale_rank=True: Reshape DQL scales for WebNN (NPU models)
    fix_scale_rank=False: Keep 1D DQL scales for ORT CPU (INT8 models)
    """
    from optimize_npu_int8 import (
        ensure_opset_version, ensure_node_names, list_ops,
        replace_dql_matmul_chain, replace_stft, replace_reduce_l2, replace_range,
        topological_sort_nodes, fix_dynamic_shapes, fix_w8a8_scale_rank,
        pre_dequantize_dql, validate_vocoder_shapes,
        simplify_model, strip_metadata, clean_unused_initializers,
        check_npu_compatibility, set_output_shapes_static,
        compute_mel_output_shapes,
    )

    print(f"    NPU optimizing...")
    model = onnx.load(input_path)
    ensure_opset_version(model, 13)
    ensure_node_names(model.graph)

    ops = list_ops(model)
    print(f"      Input: {sum(ops.values())} nodes")

    # Vocoder: validate ISTFT intermediate tensor size
    vocoder_seq_len = VOCODER_SEQ_LEN
    if 'vocoder' in model_name:
        ok, safe_len = validate_vocoder_shapes(model, vocoder_seq_len)
        if not ok:
            print(f"      Auto-adjust vocoder seq_len: {vocoder_seq_len} → {safe_len}")
            vocoder_seq_len = safe_len

    # Step 1: Replace DQL + MatMulInteger/ConvInteger
    model, _ = replace_dql_matmul_chain(model)
    gc.collect()

    # Step 2: Replace STFT → Conv1d(cos/sin)
    model, _ = replace_stft(model)
    gc.collect()

    # Step 3: Replace ReduceL2 → Sqrt+ReduceSum+Mul
    model, _ = replace_reduce_l2(model)

    # Step 4: Replace Range → constant
    model, _ = replace_range(model)

    # Step 5: Topological sort
    topological_sort_nodes(model.graph)

    # Step 6: Static shapes
    static_shapes = {'batch_size': 1, 'seq_len': SEQ_LEN,
                     'num_samples': WAVEFORM_SAMPLES, 'time_frames': 1500}
    if 'vocoder' in model_name:
        static_shapes['seq_len'] = vocoder_seq_len
    model = fix_dynamic_shapes(model, static_shapes)

    # Step 7: Shape inference + simplify
    topological_sort_nodes(model.graph)
    try:
        model = shape_inference.infer_shapes(model, check_type=False, strict_mode=False)
    except Exception:
        pass
    model = simplify_model(model)
    gc.collect()

    # Step 8: Fix output shapes
    model = compute_mel_output_shapes(model, static_shapes)
    model = set_output_shapes_static(model)

    # Step 9: Shape inference + cleanup
    try:
        model = shape_inference.infer_shapes(model, check_type=False, strict_mode=False)
    except Exception:
        pass
    model = clean_unused_initializers(model)

    # Step 10: Handle DequantizeLinear scale rank
    if fix_scale_rank:
        # NPU/WebNN: Reshape DQL scales to match input rank
        model, dql_count = fix_w8a8_scale_rank(model)
    else:
        # ORT CPU: Keep 1D scales as-is
        dql_count = sum(1 for n in model.graph.node if n.op_type == 'DequantizeLinear')
    gc.collect()

    # Step 11: Simplify again
    if dql_count > 0:
        topological_sort_nodes(model.graph)
        try:
            model = shape_inference.infer_shapes(model, check_type=False, strict_mode=False)
        except Exception:
            pass
        model = simplify_model(model)
        gc.collect()

    # Step 12: Strip metadata
    model = strip_metadata(model)
    topological_sort_nodes(model.graph)

    # Check compatibility
    unsupported = check_npu_compatibility(model)
    if unsupported:
        print(f"      [WARN] Unsupported ops: {unsupported}")
    else:
        print(f"      [OK] All NPU compatible")

    ops = list_ops(model)
    print(f"      Output: {sum(ops.values())} nodes")

    # Save
    old_data_path = output_path + '.data'
    if os.path.exists(old_data_path):
        os.remove(old_data_path)
    onnx.save_model(model, output_path, save_as_external_data=True,
                    all_tensors_to_one_file=True,
                    location=os.path.basename(output_path) + '.data',
                    size_threshold=1024)

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    data_path = output_path + '.data'
    data_mb = os.path.getsize(data_path) / (1024 * 1024) if os.path.exists(data_path) else 0
    print(f"      Saved: {model_name}.onnx ({size_mb:.1f} MB + {data_mb:.1f} MB data)")

    return model, unsupported


# ============================================================
# Main pipeline
# ============================================================

def process_one_model(model_cfg, pytorch_model, config):
    """Process a single model: export FP32 → quantize W8A8 → NPU optimize."""
    name = model_cfg['name']
    wrapper_name = model_cfg['wrapper']
    inputs_spec = model_cfg['inputs']
    is_quantizable = model_cfg['quantizable']

    print(f"\n{'='*60}")
    print(f"Processing: {name}")
    print(f"{'='*60}")

    t0 = time.time()

    # 1. Extract sub-model
    wrapper = get_sub_model(pytorch_model, wrapper_name).to(DEVICE).eval()
    param_count = sum(p.numel() for p in wrapper.parameters())
    print(f"  Parameters: {param_count / 1e6:.2f}M, Device: {DEVICE}")

    # 2. Export to FP32 ONNX
    os.makedirs(FP32_TEMP_DIR, exist_ok=True)
    fp32_path = os.path.join(FP32_TEMP_DIR, f'{name}_fp32.onnx')
    dummy_inputs = make_dummy_inputs(inputs_spec)
    dummy_on_device = {k: v.to(DEVICE) for k, v in dummy_inputs.items()}

    print(f"  Exporting FP32 ONNX...")
    use_dynamo = name != 'cond_emb'
    export_fp32_onnx(wrapper, dummy_on_device, fp32_path, name, use_dynamo=use_dynamo)

    del wrapper, dummy_inputs, dummy_on_device
    if DEVICE == 'cuda':
        torch.cuda.empty_cache()
    gc.collect()

    # 3. Quantize W8A8 (INT8 weight storage via QOperator)
    int8_raw_path = os.path.join(INT8_DIR, f'{name}_raw.onnx')
    if is_quantizable:
        quantize_w8a8_ort(fp32_path, int8_raw_path, name, inputs_spec)
    else:
        print(f"  Non-quantizable (Embedding/STFT) — re-saving FP32 with correct refs")
        model = onnx.load(fp32_path)
        raw_data = int8_raw_path + '.data'
        if os.path.exists(raw_data):
            os.remove(raw_data)
        onnx.save_model(model, int8_raw_path, save_as_external_data=True,
                        all_tensors_to_one_file=True,
                        location=os.path.basename(int8_raw_path) + '.data',
                        size_threshold=1024)

    # 4. Optimize for NPU (WebNN: fix DQL scale rank)
    npu_path = os.path.join(NPU_DIR, f'{name}.onnx')
    _, unsupported = optimize_onnx_model(int8_raw_path, npu_path, name, fix_scale_rank=True)

    # 5. Optimize for INT8 (ORT CPU: keep 1D scales)
    int8_path = os.path.join(INT8_DIR, f'{name}.onnx')
    optimize_onnx_model(int8_raw_path, int8_path, name, fix_scale_rank=False)

    # Cleanup raw file
    for p in [int8_raw_path, int8_raw_path + '.data']:
        if os.path.exists(p):
            os.remove(p)

    elapsed = time.time() - t0
    print(f"\n  Done in {elapsed:.1f}s")

    return {'name': name, 'ok': True, 'unsupported': unsupported}


def main():
    parser = argparse.ArgumentParser(description='W8A8 PTQ Export Pipeline')
    parser.add_argument('--model-path', default=None,
                        help='Path to SoulX-Singer model.pt')
    args = parser.parse_args()

    print("=" * 60)
    print("W8A8 PTQ Export Pipeline")
    print(f"Device: {DEVICE}")
    print(f"INT8 output: {INT8_DIR}")
    print(f"NPU output:  {NPU_DIR}")
    print("=" * 60)

    # Load config and model
    config = load_config()
    model_path = args.model_path or os.path.join(
        SOULX_DIR, 'pretrained_models', 'SoulX-Singer', 'model.pt')

    print(f"\nLoading PyTorch model: {model_path}")
    pytorch_model = load_model(config, model_path)
    pytorch_model.eval()
    print(f"  Model loaded successfully")

    # Prepare output directories
    os.makedirs(INT8_DIR, exist_ok=True)
    os.makedirs(NPU_DIR, exist_ok=True)
    os.makedirs(os.path.join(NPU_DIR, 'preprocess'), exist_ok=True)

    # Process each model
    results = []
    for model_cfg in MODELS:
        try:
            result = process_one_model(model_cfg, pytorch_model, config)
            results.append(result)
        except Exception as e:
            print(f"\n  [FAIL] {model_cfg['name']}: {e}")
            import traceback
            traceback.print_exc()
            results.append({'name': model_cfg['name'], 'ok': False, 'error': str(e)})
        gc.collect()

    # Cleanup
    del pytorch_model
    clear_memory()

    # Clean temp dir
    if os.path.exists(FP32_TEMP_DIR):
        shutil.rmtree(FP32_TEMP_DIR, ignore_errors=True)

    # Summary
    print(f"\n{'='*60}")
    print("Export Summary")
    print(f"{'='*60}")
    for r in results:
        if r['ok']:
            u = str(r.get('unsupported', {})) if r.get('unsupported') else "none"
            status = "OK" if not r.get('unsupported') else "WARN"
            print(f"  [{status}] {r['name']:<30} unsup: {u}")
        else:
            print(f"  [FAIL] {r['name']:<30} {r.get('error', '')[:50]}")

    all_ok = all(r['ok'] for r in results)
    print(f"\n{'All models exported successfully!' if all_ok else 'Some models failed.'}")
    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main())
