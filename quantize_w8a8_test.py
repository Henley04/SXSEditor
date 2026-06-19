# -*- coding: utf-8 -*-
"""
W8A8 quantization test: quantize preflow.onnx with INT8 weights AND activations.
Test if WebNN can handle QDQ format with QuantizeLinear on activations.
"""
import os
import sys
import numpy as np
import onnx
from onnx import numpy_helper

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'int8', 'optimized_npu')
OUTPUT_DIR = os.path.join(MODEL_DIR, 'w8a8_test')
os.makedirs(OUTPUT_DIR, exist_ok=True)

def generate_calibration_data(model, num_samples=10):
    """Generate random calibration data matching model inputs."""
    feeds_list = []
    for _ in range(num_samples):
        feeds = {}
        for inp in model.graph.input:
            shape = []
            for d in inp.type.tensor_type.shape.dim:
                if d.dim_value > 0:
                    shape.append(d.dim_value)
                else:
                    shape.append(1)
            dtype = inp.type.tensor_type.elem_type
            if dtype == 1:  # float32
                feeds[inp.name] = np.random.randn(*shape).astype(np.float32)
            elif dtype == 7:  # int64
                feeds[inp.name] = np.random.randint(0, 100, size=shape).astype(np.int64)
            elif dtype == 6:  # int32
                feeds[inp.name] = np.random.randint(0, 100, size=shape).astype(np.int32)
            else:
                feeds[inp.name] = np.random.randn(*shape).astype(np.float32)
        feeds_list.append(feeds)
    return feeds_list


def quantize_w8a8(input_path, output_path):
    """Quantize model with W8A8 (INT8 weights + INT8 activations) using QDQ format."""
    from onnxruntime.quantization import quantize, QuantFormat, QuantType, CalibrationDataReader, StaticQuantConfig

    print(f"\n  Quantizing W8A8: {os.path.basename(input_path)}")

    # Load model to get input info
    model = onnx.load(input_path, load_external_data=True)

    # Create calibration reader
    calibration_data = generate_calibration_data(model, num_samples=10)

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

    reader = CalibReader(calibration_data)

    config = StaticQuantConfig(
        calibration_data_reader=reader,
        quant_format=QuantFormat.QDQ,
        per_channel=False,  # per-tensor for WebNN compatibility
        reduce_range=False,
        op_types_to_quantize=['MatMul', 'Conv', 'Gemm'],
        extra_options={
            'ActivationSymmetric': False,
            'WeightSymmetric': True,
            'QuantizeBias': False,
            'AddQDQPairToWeight': True,  # QDQ on weights
        },
    )

    quantize(
        model_input=input_path,
        model_output=output_path,
        quant_config=config,
    )

    # Check results
    qmodel = onnx.load(output_path, load_external_data=False)
    ops = {}
    for n in qmodel.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1

    ql = ops.get('QuantizeLinear', 0)
    dql = ops.get('DequantizeLinear', 0)
    mm = ops.get('MatMul', 0)
    mmi = ops.get('MatMulInteger', 0)

    size_mb = os.path.getsize(output_path) / 1048576
    data_path = output_path + '.data'
    data_mb = os.path.getsize(data_path) / 1048576 if os.path.exists(data_path) else 0

    print(f"    Size: {size_mb:.1f}MB + {data_mb:.1f}MB data")
    print(f"    Nodes: {sum(ops.values())}")
    print(f"    QuantizeLinear: {ql}, DequantizeLinear: {dql}")
    print(f"    MatMul: {mm}, MatMulInteger: {mmi}")

    return qmodel


def main():
    input_path = os.path.join(MODEL_DIR, 'preflow.onnx')
    output_path = os.path.join(OUTPUT_DIR, 'preflow_w8a8.onnx')

    print("=" * 60)
    print("W8A8 Quantization Test (preflow.onnx)")
    print("=" * 60)

    # Check original model
    model = onnx.load(input_path, load_external_data=False)
    ops = {}
    for n in model.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    print(f"\nOriginal: {sum(ops.values())} nodes")
    for op, cnt in sorted(ops.items(), key=lambda x: -x[1])[:5]:
        print(f"  {op}: {cnt}")

    # Quantize W8A8
    quantize_w8a8(input_path, output_path)

    # Verify with ORT CPU
    print("\n  Verifying with ORT CPU...")
    import onnxruntime as ort
    try:
        sess = ort.InferenceSession(output_path, providers=['CPUExecutionProvider'])
        feeds = {}
        for inp in sess.get_inputs():
            shape = [d if isinstance(d, int) and d > 0 else 1 for d in inp.shape]
            if inp.type == 'tensor(float)':
                feeds[inp.name] = np.random.randn(*shape).astype(np.float32)
            elif inp.type == 'tensor(int64)':
                feeds[inp.name] = np.random.randint(0, 100, size=shape).astype(np.int64)
            else:
                feeds[inp.name] = np.random.randn(*shape).astype(np.float32)
        results = sess.run(None, feeds)
        print(f"    Output shape: {results[0].shape}")
        print(f"    [PASS] ORT CPU inference OK")
    except Exception as e:
        print(f"    [FAIL] {e}")

    print(f"\nOutput: {output_path}")


if __name__ == '__main__':
    main()
