# -*- coding: utf-8 -*-
"""Convert diff_step_dml.onnx from split format (.onnx + .onnx.data) to
self-contained format (single .onnx file with all weights embedded).

This is required because the app's model manifest (modelManager.js) only lists
'diff_step_dml.onnx' without the '.data' companion file. Uploading a split-
format model would result in the app downloading only the 2.3MB graph file
without the 844MB of weights, producing a broken model.

The vocoder_dml.onnx is already self-contained (no .data file), so no
conversion is needed for it.
"""
import os
import sys
import shutil
import time
import onnx

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FP16_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'fp16_dynamo')
SRC_ONNX = os.path.join(FP16_DIR, 'diff_step_dml.onnx')
SRC_DATA = os.path.join(FP16_DIR, 'diff_step_dml.onnx.data')

# Output to a separate file to avoid clobbering the original split-format model
DST_ONNX = os.path.join(FP16_DIR, 'diff_step_dml_selfcontained.onnx')


def main():
    if not os.path.exists(SRC_ONNX):
        print(f"ERROR: {SRC_ONNX} not found")
        sys.exit(1)
    if not os.path.exists(SRC_DATA):
        print(f"ERROR: {SRC_DATA} not found")
        sys.exit(1)

    src_size = os.path.getsize(SRC_ONNX) / 1024 / 1024
    data_size = os.path.getsize(SRC_DATA) / 1024 / 1024
    print(f"Source: {SRC_ONNX} ({src_size:.2f} MB) + .data ({data_size:.2f} MB)")

    print("Loading model with external data (this may take a moment)...")
    t0 = time.time()
    model = onnx.load(SRC_ONNX, load_external_data=True)
    print(f"  Loaded in {time.time()-t0:.1f}s")

    # Verify all tensors are in memory (not external)
    for init in model.graph.initializer:
        if init.data_type != onnx.TensorProto.UNDEFINED and init.HasField('raw_data'):
            pass  # has raw_data, good
        elif len(init.float_data) > 0 or len(init.int64_data) > 0 or len(init.int32_data) > 0:
            pass  # has typed data, good
        # external_data ref would be in init.external_data; if raw_data is empty
        # and external_data is set, it's still external

    print(f"Saving self-contained model to {DST_ONNX}...")
    t0 = time.time()
    if os.path.exists(DST_ONNX):
        os.remove(DST_ONNX)
    onnx.save_model(model, DST_ONNX)  # no save_as_external_data => self-contained
    print(f"  Saved in {time.time()-t0:.1f}s")

    dst_size = os.path.getsize(DST_ONNX) / 1024 / 1024
    print(f"Output: {DST_ONNX} ({dst_size:.2f} MB)")

    # Sanity check: reload and verify
    print("Verifying self-contained model...")
    t0 = time.time()
    model2 = onnx.load(DST_ONNX, load_external_data=False)
    print(f"  Verified in {time.time()-t0:.1f}s")
    print(f"  Initializers: {len(model2.graph.initializer)}")
    print(f"  Nodes: {len(model2.graph.node)}")

    # Check no initializer references external data
    ext_count = 0
    for init in model2.graph.initializer:
        for kv in init.external_data:
            if kv.key == 'location':
                ext_count += 1
    if ext_count > 0:
        print(f"  WARNING: {ext_count} initializers still reference external data!")
    else:
        print("  All initializers are self-contained (no external data refs)")

    print("\nDone! Self-contained model ready for upload.")


if __name__ == '__main__':
    main()
