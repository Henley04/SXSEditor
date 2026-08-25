# -*- coding: utf-8 -*-
"""Make the dynamo-exported Percentile INT8 QDQ diff_step DirectML-runnable.

DirectML EP rejects Reshape shape tensors that contain a literal -1 (E_INVALIDARG
0x80070057). The established recipe replaces those -1 values with computed static
shapes via export_shared.resolve_neg1_in_reshape_shapes. This applies exactly that
post-processing to an INT8 QDQ diff_step (diff_step keeps resolve_neg1; vocoder skips
it because it corrupts the FP16 ISTFT basis-matrix precision).

Usage:
  python scripts/fix_int8_resolve_neg1.py <input.onnx> <output.onnx>
"""
import os
import sys

os.environ["SKIP_ROPE_PRECOMPUTE"] = "1"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main():
    in_path, out_path = sys.argv[1], sys.argv[2]
    import onnx
    from onnx import shape_inference
    from export_shared import resolve_neg1_in_reshape_shapes

    print(f"[resolve_neg1] input : {in_path}")
    model = onnx.load(in_path, load_external_data=True)
    before = sum(
        1 for n in model.graph.node if n.op_type == "Reshape"
    )
    try:
        model = shape_inference.infer_shapes(model)
    except Exception as e:
        print(f"  shape_inference warning: {str(e)[:120]}")
    model = resolve_neg1_in_reshape_shapes(model)
    after = sum(1 for n in model.graph.node if n.op_type == "Reshape")
    print(f"[resolve_neg1] Reshape nodes: {before} -> {after}")

    import os as _os
    import shutil as _shutil
    if _os.path.exists(out_path):
        _os.remove(out_path)
    _d = out_path + ".data"
    if _os.path.exists(_d):
        _os.remove(_d)
    onnx.save_model(
        model,
        out_path,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=_os.path.basename(out_path) + ".data",
        size_threshold=1024,
    )
    del model
    print(f"[resolve_neg1] saved : {out_path}")


if __name__ == "__main__":
    main()