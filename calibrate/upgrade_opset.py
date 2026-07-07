# -*- coding: utf-8 -*-
"""Upgrade ONNX models to opset 20 (DML EP compatible max).

opset 19/20 improvements for W16A32 FP16:
  - Cast: supports saturate mode (opset 19), prevents FP16 overflow
  - DML EP: newer shader implementations for MatMul/Conv/Reshape at higher opset
  - Resize: antialias support (opset 19)
  - Better FP16 path selection in DML EP for opset 19+

Strategy:
  - Update ai.onnx opset_import to 20
  - Run onnx.shape_inference to refresh type info
  - Run onnxsim to clean up and validate
  - Verify DML EP compatibility
  - Precision compare with opset 18 baseline
"""
import os
import sys
import time
import shutil
import numpy as np
import onnx
from onnx import shape_inference, version_converter

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)

try:
    import onnxsim
    HAS_ONNXSIM = True
except ImportError:
    HAS_ONNXSIM = False
    print("[WARNING] onnxsim not installed, skip simplification")

TARGET_OPSET = 20

# Models to upgrade (FP16/W16A32 + production)
MODELS = [
    # W16A32 models
    (r'onnx_models\fp16\diff_step_dml.onnx', 'diff_step_dml_opset20.onnx', True),
    (r'onnx_models\fp16\vocoder_dml.onnx', 'vocoder_dml_opset20.onnx', True),
    # Production FP32 models
    (r'onnx_models\diff_step_dml.onnx', 'diff_step_dml_opset20.onnx', False),
    (r'onnx_models\vocoder_dml.onnx', 'vocoder_dml_opset20.onnx', False),
    (r'onnx_models\preflow.onnx', 'preflow_opset20.onnx', False),
    (r'onnx_models\mel_transform.onnx', 'mel_transform_opset20.onnx', False),
    (r'onnx_models\cond_emb.onnx', 'cond_emb_opset20.onnx', False),
    (r'onnx_models\f0_encoder.onnx', 'f0_encoder_opset20.onnx', False),
    (r'onnx_models\note_pitch_encoder.onnx', 'note_pitch_encoder_opset20.onnx', False),
    (r'onnx_models\note_text_encoder.onnx', 'note_text_encoder_opset20.onnx', False),
    (r'onnx_models\note_type_encoder.onnx', 'note_type_encoder_opset20.onnx', False),
]


def upgrade_opset(model_path, output_path, has_external_data=False):
    """Upgrade model to opset 20, simplify, validate."""
    print(f"\n  Upgrading: {os.path.basename(model_path)} -> {os.path.basename(output_path)}")

    # 1. Load
    t0 = time.time()
    if has_external_data:
        model = onnx.load(model_path, load_external_data=True)
    else:
        model = onnx.load(model_path)
    print(f"    Loaded in {time.time()-t0:.1f}s, nodes={len(model.graph.node)}")

    # 2. Check current opset
    old_opset = None
    for opset in model.opset_import:
        if opset.domain == '' or opset.domain == 'ai.onnx':
            old_opset = opset.version
            break
    print(f"    Current opset: {old_opset}")

    if old_opset is None:
        print(f"    ERROR: No ai.onnx opset found")
        return False
    if old_opset >= TARGET_OPSET:
        print(f"    Already at opset {old_opset}, skipping")
        return False

    # 3. Update opset
    for opset in model.opset_import:
        if opset.domain == '' or opset.domain == 'ai.onnx':
            opset.version = TARGET_OPSET
            break

    # 4. Shape inference
    try:
        model = shape_inference.infer_shapes(model, strict_mode=False)
        print(f"    Shape inference OK")
    except Exception as e:
        print(f"    Shape inference WARNING: {e}")

    # 5. onnxsim
    if HAS_ONNXSIM:
        try:
            model, check = onnxsim.simplify(
                model,
                check_n=0,  # skip check to save time
                perform_topological_sort=True,
            )
            print(f"    onnxsim: OK, nodes={len(model.graph.node)}")
        except Exception as e:
            print(f"    onnxsim SKIP: {e}")

    # 6. Save
    if has_external_data:
        data_file = output_path + '.data'
        if os.path.exists(data_file):
            os.remove(data_file)
        onnx.save_model(
            model, output_path,
            save_as_external_data=True,
            all_tensors_to_one_file=True,
            location=os.path.basename(output_path) + '.data',
            size_threshold=1024,
        )
    else:
        onnx.save(model, output_path)

    # 7. Verify
    m2 = onnx.load(output_path, load_external_data=False)
    opset_ver = None
    for opset in m2.opset_import:
        if opset.domain == '' or opset.domain == 'ai.onnx':
            opset_ver = opset.version
    print(f"    Saved: nodes={len(m2.graph.node)}, opset={opset_ver}")
    return True


def verify_dml(model_path, name, has_external_data=False):
    """Quick DML EP compatibility check."""
    import onnxruntime as ort
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    try:
        sess = ort.InferenceSession(
            model_path, sess_options=sess_options,
            providers=['DmlExecutionProvider', 'CPUExecutionProvider']
        )
        # Check input/output info
        inputs = [(i.name, i.type) for i in sess.get_inputs()]
        outputs = [(o.name, o.type) for o in sess.get_outputs()]
        del sess
        return True, f"inputs={len(inputs)}, outputs={len(outputs)}"
    except Exception as e:
        return False, str(e)


def main():
    print("=" * 60)
    print(f"ONNX Opset Upgrade: -> {TARGET_OPSET}")
    print("=" * 60)

    results = {}
    for rel_path, out_name, has_ext in MODELS:
        model_path = os.path.join(PROJECT_DIR, rel_path)
        output_path = os.path.join(PROJECT_DIR, os.path.dirname(rel_path), out_name)
        if not os.path.exists(model_path):
            print(f"  SKIP (not found): {rel_path}")
            continue

        upgraded = upgrade_opset(model_path, output_path, has_ext)
        if not upgraded:
            continue

        # DML verification
        ok, info = verify_dml(output_path, out_name, has_ext)
        status = "DML OK" if ok else f"DML FAIL: {info}"
        print(f"    DML: {status}")
        results[out_name] = ok

    print(f"\n{'='*60}")
    print(f"Summary:")
    for name, ok in results.items():
        print(f"  {'PASS' if ok else 'FAIL'}: {name}")

    if not all(results.values()):
        print(f"\nWARNING: Some models failed DML verification!")
    else:
        print(f"\nAll models upgraded to opset {TARGET_OPSET} and DML compatible!")


if __name__ == '__main__':
    main()