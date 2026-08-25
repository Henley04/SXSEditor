#!/usr/bin/env python3
"""
Map Q-DiT quantized layer names to ONNX initializer names by comparing FP32 weight fingerprints.
Then inject Q-DiT INT8 weights + scales into the ORT-quantized ONNX model.
"""

import numpy as np
import onnx
from onnx import numpy_helper
import torch
import sys
import os
import gc
import struct

# Paths
FP32_MODEL = "onnx_models/diff_step_dml.onnx"
INT8_MODEL = "int8_output/onnx/diffstep_dml_w8a8.onnx"
OUTPUT_MODEL = "int8_output/onnx/diffstep_qdit.onnx"
QDIT_WEIGHTS = "int8_output/pt/diff_step_w8a8.pt"
ONNX_DATA_DIR = os.path.dirname(FP32_MODEL)


def compute_fingerprint(arr, n=10):
    """Compute a fingerprint from first n elements + sum + shape."""
    flat = arr.flatten()
    first = flat[:n].tobytes()
    return (first, flat.shape)


def load_onnx_initializer(model, init, data_dir):
    """Load a single ONNX initializer, handling external data."""
    if len(init.external_data) > 0:
        # Pass base_path to numpy_helper so it resolves external data correctly
        return numpy_helper.to_array(init, data_dir)
    return numpy_helper.to_array(init)


def build_qdit_fingerprints(sd):
    """Build fingerprints for Q-DiT FP32 weights."""
    fps = {}
    for k, v in sd.items():
        if k.endswith(".weight") and not k.endswith(".qweight"):
            base = k.replace(".weight", "")
            if f"{base}.qweight" in sd:
                arr = v.numpy()
                fp = compute_fingerprint(arr)
                fps[base] = (fp, arr.shape, arr.dtype)
    return fps


def build_onnx_fingerprints(model, data_dir, target_shapes):
    """Build fingerprints for ONNX initializers with matching shapes."""
    fps = {}
    for init in model.graph.initializer:
        shape = tuple(init.dims)
        # Only check 2D initializers that could be weights
        if len(shape) != 2:
            continue
        if shape not in target_shapes:
            continue
        try:
            arr = load_onnx_initializer(model, init, data_dir)
            fp = compute_fingerprint(arr)
            fps[init.name] = (fp, arr.shape, arr.dtype, init)
        except Exception as e:
            print(f"  Warning: Could not load {init.name}: {e}", flush=True)
    return fps


def match_layers(qdit_fps, onnx_fps):
    """Match Q-DiT layers to ONNX initializers by fingerprint."""
    mapping = {}
    used_onnx = set()

    # First pass: exact fingerprint match
    for qdit_name, (qdit_fp, qdit_shape, qdit_dtype) in qdit_fps.items():
        for onnx_name, (onnx_fp, onnx_shape, onnx_dtype, _) in onnx_fps.items():
            if onnx_name in used_onnx:
                continue
            if qdit_fp == onnx_fp and qdit_shape == onnx_shape:
                mapping[qdit_name] = onnx_name
                used_onnx.add(onnx_name)
                break

    return mapping


def inject_qdit_weights(model, sd, mapping, data_dir):
    """Replace ORT-calibrated weights with Q-DiT weights in the ONNX model."""
    # Build initializer name -> index map
    init_map = {init.name: i for i, init in enumerate(model.graph.initializer)}

    injected = 0
    skipped = 0

    for qdit_name, onnx_name in mapping.items():
        # Get Q-DiT quantized data
        qweight_key = f"{qdit_name}.qweight"
        scale_key = f"{qdit_name}.weight_scale"
        zero_key = f"{qdit_name}.weight_zero"

        if qweight_key not in sd:
            skipped += 1
            continue

        qweight = sd[qweight_key].numpy()  # int8
        weight_scale = sd[scale_key].numpy()  # float32 per-channel
        weight_zero = sd[zero_key].numpy()  # float32, value=128

        # ONNX QLinearMatMul weight name
        quant_weight_name = f"{onnx_name}_quantized"
        scale_name = f"{onnx_name}_scale"
        zp_name = f"{onnx_name}_zero_point"

        # Find these in the model's initializers
        replaced = False

        # Replace quantized weight
        if quant_weight_name in init_map:
            idx = init_map[quant_weight_name]
            old_init = model.graph.initializer[idx]
            # Create new initializer with Q-DiT weight
            new_init = numpy_helper.from_array(
                qweight.astype(np.int8), name=quant_weight_name
            )
            # Copy data type
            new_init.data_type = old_init.data_type  # Should be int8 (3)
            model.graph.initializer[idx].CopyFrom(new_init)
            replaced = True

        # Replace weight scale
        if scale_name in init_map:
            idx = init_map[scale_name]
            new_scale = numpy_helper.from_array(
                weight_scale.astype(np.float32), name=scale_name
            )
            model.graph.initializer[idx].CopyFrom(new_scale)
            replaced = True

        # Replace weight zero point
        # Q-DiT uses weight_zero=128 (float), but ONNX expects int8 zero point
        # For symmetric quantization, zero point = 0
        if zp_name in init_map:
            idx = init_map[zp_name]
            # Q-DiT weight_zero=128 means symmetric with uint8 representation
            # In ONNX with int8 weights, symmetric zero point = 0
            zp = np.zeros(weight_scale.shape, dtype=np.int8)
            new_zp = numpy_helper.from_array(zp, name=zp_name)
            model.graph.initializer[idx].CopyFrom(new_zp)
            replaced = True

        if replaced:
            injected += 1
        else:
            skipped += 1

    return injected, skipped


def main():
    print("[1/5] Loading Q-DiT weights...", flush=True)
    state = torch.load(QDIT_WEIGHTS, map_location="cpu", weights_only=False)
    sd = state["state_dict"]
    print(f"  {len(sd)} keys, format={state.get('format', 'unknown')}", flush=True)

    print("\n[2/5] Building Q-DiT fingerprints...", flush=True)
    qdit_fps = build_qdit_fingerprints(sd)
    print(f"  {len(qdit_fps)} Q-DiT weight fingerprints", flush=True)

    # Target shapes for matching
    target_shapes = set()
    for _, (fp, shape, _) in qdit_fps.items():
        target_shapes.add(shape)
    print(f"  Target shapes: {target_shapes}", flush=True)

    print("\n[3/5] Loading FP32 ONNX model and building fingerprints...", flush=True)
    fp32_model = onnx.load(FP32_MODEL, load_external_data=False)
    onnx_fps = build_onnx_fingerprints(fp32_model, ONNX_DATA_DIR, target_shapes)
    print(f"  {len(onnx_fps)} ONNX initializer fingerprints", flush=True)

    print("\n[4/5] Matching layers...", flush=True)
    mapping = match_layers(qdit_fps, onnx_fps)
    print(f"  Matched: {len(mapping)}/{len(qdit_fps)}", flush=True)

    # Show some matches
    for qdit_name, onnx_name in sorted(mapping.items())[:10]:
        print(f"    {qdit_name} -> {onnx_name}", flush=True)

    unmatched_qdit = [k for k in qdit_fps if k not in mapping]
    if unmatched_qdit:
        print(f"\n  Unmatched Q-DiT layers ({len(unmatched_qdit)}):", flush=True)
        for name in unmatched_qdit[:10]:
            print(f"    {name}: shape={qdit_fps[name][1]}", flush=True)

    # Free FP32 model memory
    del fp32_model, onnx_fps
    gc.collect()

    if len(mapping) < len(qdit_fps) * 0.9:
        print(
            f"\n  WARNING: Only matched {len(mapping)}/{len(qdit_fps)} layers!",
            flush=True,
        )
        # Try second pass: match by sum instead of first elements
        print("  Trying second pass with sum-based matching...", flush=True)
        # Rebuild fingerprints using sum
        qdit_sums = {}
        for k, v in sd.items():
            if k.endswith(".weight") and f"{k.replace('.weight', '')}.qweight" in sd:
                qdit_sums[k.replace(".weight", "")] = float(v.sum().item())
        # Reload onnx fingerprints
        fp32_model2 = onnx.load(FP32_MODEL, load_external_data=False)
        for init in fp32_model2.graph.initializer:
            if len(init.dims) == 2:
                try:
                    arr = load_onnx_initializer(fp32_model2, init, ONNX_DATA_DIR)
                    s = float(arr.sum())
                    for qn, qs in qdit_sums.items():
                        if abs(s - qs) < 0.01 and qn not in mapping:
                            mapping[qn] = init.name
                            break
                except:
                    pass
        del fp32_model2
        gc.collect()
        print(
            f"  After second pass: {len(mapping)}/{len(qdit_fps)} matched", flush=True
        )

    print("\n[5/5] Injecting Q-DiT weights into quantized model...", flush=True)
    int8_model = onnx.load(INT8_MODEL, load_external_data=False)
    injected, skipped = inject_qdit_weights(int8_model, sd, mapping, ONNX_DATA_DIR)
    print(f"  Injected: {injected}, Skipped: {skipped}", flush=True)

    # Save
    print(f"\nSaving to {OUTPUT_MODEL}...", flush=True)
    onnx.save(int8_model, OUTPUT_MODEL, save_as_external_data=True, size_threshold=1024)
    print("Done!", flush=True)

    del int8_model
    gc.collect()


if __name__ == "__main__":
    main()
