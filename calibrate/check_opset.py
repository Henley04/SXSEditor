# -*- coding: utf-8 -*-
"""Check opset version of all ONNX models."""
import os
import onnx
from collections import Counter

MODEL_DIRS = [
    (r'd:\Document\electron\SXSEditor\onnx_models', 'Production'),
    (r'd:\Document\electron\SXSEditor\onnx_models\fp16', 'W16A32'),
    (r'd:\Document\electron\SXSEditor\onnx_models\int8', 'INT8 original'),
    (r'd:\Document\electron\SXSEditor\onnx_models\int8\optimized_npu_backup', 'INT8 NPU backup'),
]

for path, label in MODEL_DIRS:
    if not os.path.isdir(path):
        print(f"[{label}] {path} - NOT FOUND")
        continue
    print(f"\n[{label}] {path}")
    onnx_files = [f for f in os.listdir(path) if f.endswith('.onnx')]
    if not onnx_files:
        print(f"  No ONNX files found")
        continue
    opsets = Counter()
    for f in sorted(onnx_files):
        fpath = os.path.join(path, f)
        try:
            m = onnx.load(fpath, load_external_data=False)
            for opset in m.opset_import:
                key = f"{opset.domain or 'ai.onnx'} v{opset.version}"
                opsets[key] += 1
            # Also count operators
            op_types = Counter(n.op_type for n in m.graph.node)
            print(f"  {f}: nodes={len(m.graph.node)}, opset={[(o.domain or 'ai.onnx', o.version) for o in m.opset_import]}")
            # Show top ops
            top_ops = op_types.most_common(5)
            print(f"    top ops: {top_ops}")
        except Exception as e:
            print(f"  {f}: ERROR - {e}")

    print(f"  Opset distribution: {dict(opsets)}")