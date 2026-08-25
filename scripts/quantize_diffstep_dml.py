#!/usr/bin/env python3
"""
Quantize the FP32 DML-compatible diff_step ONNX model to W8A8 QOperator format.
This preserves the DML-compatible graph structure by starting from the working FP32 model.

Output: real INT8 ops (QLinearMatMul), no fake quantization, no dequantization at runtime.
"""

import numpy as np
import onnx
from onnxruntime.quantization import (
    CalibrationDataReader,
    QuantFormat,
    QuantType,
    CalibrationMethod,
    StaticQuantConfig,
    quantize,
)
import os
import sys
import time
import gc

MODEL_FP32 = "onnx_models/diff_step_dml.onnx"
MODEL_INT8 = "int8_output/onnx/diffstep_dml_w8a8.onnx"
CALIB_DATA = "calibrate/data/fp16_calib/diff_step_dml.npz"

# Input name mapping: calibration key suffix -> model input name
INPUT_MAP = {
    "input_xt_input": "xt_input",
    "input_t": "t",
    "input_cond": "cond",
    "input_xt_mask": "xt_mask",
}


class NpzCalibrationReader(CalibrationDataReader):
    """Read calibration data from NPZ file."""

    def __init__(self, calib_path, num_samples=8):
        self.data = np.load(calib_path, allow_pickle=True)
        self.num_samples = num_samples
        self.sample_idx = 0
        self._current = None
        self._next_sample()

    def _next_sample(self):
        if self.sample_idx >= self.num_samples:
            self._current = None
            return

        prefix = f"sample{self.sample_idx}_"
        self._current = {}
        for suffix, model_name in INPUT_MAP.items():
            key = f"{prefix}{suffix}"
            if key in self.data:
                arr = self.data[key]
                # Ensure float32
                if arr.dtype != np.float32:
                    arr = arr.astype(np.float32)
                self._current[model_name] = arr

        self.sample_idx += 1

    def get_next(self):
        if self._current is None:
            return None
        result = self._current
        self._next_sample()
        return result

    def rewind(self):
        self.sample_idx = 0
        self._next_sample()


def main():
    print(f"[1/5] Loading calibration data from {CALIB_DATA}", flush=True)
    reader = NpzCalibrationReader(CALIB_DATA, num_samples=8)

    # Verify first sample
    sample = reader.get_next()
    if sample is None:
        print("ERROR: No calibration data found!", flush=True)
        sys.exit(1)
    for name, arr in sample.items():
        print(f"  {name}: shape={arr.shape}, dtype={arr.dtype}", flush=True)
    reader.rewind()

    print(f"\n[2/5] Checking FP32 model: {MODEL_FP32}", flush=True)
    model = onnx.load(MODEL_FP32, load_external_data=False)
    print(f"  IR version: {model.ir_version}", flush=True)
    print(f"  Opset: {model.opset_import[0].version}", flush=True)
    matmul_count = sum(1 for n in model.graph.node if n.op_type == "MatMul")
    print(f"  MatMul nodes: {matmul_count}", flush=True)
    del model
    gc.collect()

    print(
        f"\n[3/5] Running static quantization (QOperator, W8A8, per-channel)...",
        flush=True,
    )
    t0 = time.time()

    config = StaticQuantConfig(
        calibration_data_reader=reader,
        calibrate_method=CalibrationMethod.MinMax,
        quant_format=QuantFormat.QOperator,
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
        per_channel=True,
        reduce_range=False,
        op_types_to_quantize=["MatMul", "Gemm", "Conv"],
        use_external_data_format=True,
        extra_options={
            "WeightSymmetric": True,
            "ActivationSymmetric": False,
        },
    )

    quantize(
        MODEL_FP32,
        MODEL_INT8,
        quant_config=config,
    )

    t1 = time.time()
    print(f"  Quantization done in {t1 - t0:.1f}s", flush=True)

    print(f"\n[4/5] Verifying quantized model", flush=True)
    model_int8 = onnx.load(MODEL_INT8, load_external_data=False)

    qlinear_matmul = sum(
        1 for n in model_int8.graph.node if n.op_type == "QLinearMatMul"
    )
    qgemm = sum(1 for n in model_int8.graph.node if n.op_type == "QGemm")
    matmul = sum(1 for n in model_int8.graph.node if n.op_type == "MatMul")
    reshape = sum(1 for n in model_int8.graph.node if n.op_type == "Reshape")
    shape_ops = sum(1 for n in model_int8.graph.node if n.op_type == "Shape")
    range_ops = sum(1 for n in model_int8.graph.node if n.op_type == "Range")

    int8_inits = sum(
        1 for init in model_int8.graph.initializer if init.data_type in [3, 6]
    )  # int8/uint8
    total_inits = len(model_int8.graph.initializer)

    print(f"  QLinearMatMul: {qlinear_matmul}", flush=True)
    print(f"  QGemm: {qgemm}", flush=True)
    print(f"  MatMul (remaining): {matmul}", flush=True)
    print(f"  Reshape: {reshape}", flush=True)
    print(f"  Shape: {shape_ops}", flush=True)
    print(f"  Range: {range_ops}", flush=True)
    print(f"  INT8 initializers: {int8_inits}/{total_inits}", flush=True)

    # Check for fix_arange_slice nodes (DML incompatible)
    fix_arange = sum(1 for n in model_int8.graph.node if "fix_arange" in n.name.lower())
    print(f"  fix_arange nodes: {fix_arange}", flush=True)

    del model_int8
    gc.collect()

    # Check file sizes
    main_size = os.path.getsize(MODEL_INT8)
    data_path = MODEL_INT8 + ".data"
    data_size = os.path.getsize(data_path) if os.path.exists(data_path) else 0
    print(f"\n  Main file: {main_size / 1024 / 1024:.1f} MB", flush=True)
    print(f"  Data file: {data_size / 1024 / 1024:.1f} MB", flush=True)
    print(f"  Total: {(main_size + data_size) / 1024 / 1024:.1f} MB", flush=True)

    print(f"\n[5/5] Done! Output: {MODEL_INT8}", flush=True)


if __name__ == "__main__":
    main()
