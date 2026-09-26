# -*- coding: utf-8 -*-
"""DML optimization for ONNX models.

Uses ORT graph optimization with DmlExecutionProvider to optimize ONNX models
for DirectML inference. Includes onnxslim for graph simplification.

Olive 0.12.1 lacks general ONNX optimization passes, so we use ORT's built-in
graph optimizer (which is what Olive would call internally) plus onnxslim.
"""

import json
import os
import sys
import shutil
from pathlib import Path


def optimize_dml(input_dir, output_dir):
    """Optimize all ONNX models in input_dir for DML.

    Steps per model:
    1. onnxslim: simplify graph (remove redundant nodes)
    2. ORT graph optimization: fuse operators for DML execution
    3. Save optimized model back
    """
    input_dir = Path(input_dir)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    onnx_files = list(input_dir.glob("*.onnx"))
    if not onnx_files:
        print("  [DML-Opt] No ONNX files found to optimize")
        return

    print(f"  [DML-Opt] Found {len(onnx_files)} ONNX files to optimize")

    for onnx_file in onnx_files:
        print(f"\n  [DML-Opt] Processing {onnx_file.name}...")
        _optimize_single(onnx_file, input_dir, output_dir)

    print("\n  [DML-Opt] Optimization complete")


def _optimize_single(onnx_file, input_dir, output_dir):
    """Optimize a single ONNX model for DML."""
    import onnx

    model_path = str(onnx_file)
    data_file = input_dir / (onnx_file.name + ".data")

    # Step 1: onnxslim (graph simplification)
    print(f"    Step 1: onnxslim simplification...")
    try:
        import onnxslim

        model = onnx.load(model_path, load_external_data=False)
        model_orig_nodes = len(model.graph.node)
        model = onnxslim.slim(model)
        slim_path = str(output_dir / f"{onnx_file.stem}_slim.onnx")
        onnx.save(model, slim_path, save_as_external_data=True, size_threshold=0)
        print(f"      Nodes: {model_orig_nodes} -> {len(model.graph.node)}")
        model_path = slim_path
        # Copy data file if onnxslim created one
        slim_data = Path(slim_path + ".data")
        if slim_data.exists():
            data_file = slim_data
    except Exception as e:
        print(f"      onnxslim skipped: {e}")
        # Copy original
        shutil.copy2(onnx_file, output_dir / onnx_file.name)
        if data_file.exists():
            shutil.copy2(data_file, output_dir / (onnx_file.name + ".data"))
        model_path = str(output_dir / onnx_file.name)

    # Step 2: ORT graph optimization with DML
    print(f"    Step 2: ORT graph optimization (DML)...")
    try:
        import onnxruntime as ort
        import numpy as np

        sess_options = ort.SessionOptions()
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        # Save optimized model
        opt_path = str(output_dir / onnx_file.name)
        sess_options.optimized_model_filepath = opt_path

        # Try DML first, fall back to CPU
        providers = ["DmlExecutionProvider", "CPUExecutionProvider"]

        try:
            sess = ort.InferenceSession(model_path, sess_options, providers=providers)
            print(f"      ORT optimization with DML: OK")
            del sess
        except Exception as dml_err:
            print(f"      DML optimization failed ({dml_err}), trying CPU...")
            sess_options2 = ort.SessionOptions()
            sess_options2.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            sess_options2.optimized_model_filepath = opt_path
            sess = ort.InferenceSession(
                model_path, sess_options2, providers=["CPUExecutionProvider"]
            )
            print(f"      ORT optimization with CPU: OK")
            del sess

        # Move external data file
        opt_data = Path(opt_path + ".data")
        if not opt_data.exists() and data_file.exists():
            shutil.copy2(data_file, opt_data)

        # Verify optimized model
        if os.path.exists(opt_path):
            m = onnx.load(opt_path, load_external_data=False)
            int8_count = sum(
                1 for i in m.graph.initializer if i.data_type in [2, 3]
            )
            qmatmul = sum(
                1 for n in m.graph.node if n.op_type in ["QLinearMatMul", "MatMulInteger"]
            )
            dql = sum(1 for n in m.graph.node if n.op_type == "DynamicQuantizeLinear")
            total = len(m.graph.initializer)
            print(f"      Verified: {int8_count}/{total} INT8 tensors, {qmatmul} QLinearMatMul, {dql} DQDynamic")
            del m

        # Clean up temp slim file
        if model_path != opt_path and os.path.exists(model_path):
            os.remove(model_path)
            slim_data_path = model_path + ".data"
            if os.path.exists(slim_data_path):
                os.remove(slim_data_path)

    except Exception as e:
        print(f"      ORT optimization failed: {e}")
        # Copy original as fallback
        shutil.copy2(onnx_file, output_dir / onnx_file.name)
        if data_file.exists():
            shutil.copy2(data_file, output_dir / (onnx_file.name + ".data"))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    optimize_dml(args.input, args.output)
