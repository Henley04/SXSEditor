# -*- coding: utf-8 -*-
"""Export vocoder_W16A32.pt (Vocos FP16 weight dump) to W16A32 ONNX.

Source checkpoint layout (produced by the W16A32 weight packer):
  {
    'meta': {'scheme': 'fp16', 'cfg': {input_channels, dim, intermediate_dim,
                                       num_layers, n_fft, hop_size, padding}},
    'weights': {name: {'mode': 'fp16', 'w': torch.float16 tensor}, ...}
  }

Export pipeline (same proven main path as the production vocoder):
  1. Build Vocos from meta cfg, load FP16 weights into an FP32 model
     (FP16 values are exactly representable in FP32, round-trip is lossless).
  2. Wrap with VocosFullWrapper (MatMul-based IDFT + manual Pad/Add overlap-add,
     fully DML-compatible: no DFT/STFT/Col2Im/ConvTranspose nodes).
  3. torch.onnx.export dynamo=True, opset 20, dynamic batch/seq shapes,
     then postprocess (onnxsim etc.). DML fixes delegated to Olive later.
  4. quantize_weights_to_fp16: weight initializers -> FP16 storage with
     Cast(FP16->FP32) before each consumer; bias/LayerNorm/ISTFT stay FP32.
  5. Numerical verification vs the PyTorch FP32 reference (cosine + SNR).

Memory discipline: large intermediates are deleted and torch caches cleared
after each heavy step (see clear_memory()).
"""
import argparse
import gc
import os
import sys
import types
from pathlib import Path

import numpy as np
import torch

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(PROJECT_ROOT / "SoulX-Singer"))
os.environ.setdefault("SKIP_ROPE_PRECOMPUTE", "1")

from export_shared import (  # noqa: E402
    VocosFullWrapper,
    export_fp32_opset20,
    quantize_weights_to_fp16,
    clear_memory,
)

DEFAULT_PT = PROJECT_ROOT / "vocoder_W16A32.pt"
DEFAULT_OUT_DIR = PROJECT_ROOT / "w16a32_output"
MEL_DIM = 128


def build_vocos_from_ckpt(ckpt_path: Path):
    """Build Vocos model and load the FP16 packed weights (as FP32 params)."""
    from soulxsinger.models.modules.vocoder import Vocos

    ckpt = torch.load(str(ckpt_path), map_location="cpu", weights_only=False)
    cfg_dict = ckpt["meta"]["cfg"]
    print(f"  scheme={ckpt['meta'].get('scheme')}, cfg={cfg_dict}")
    cfg_ns = types.SimpleNamespace(**cfg_dict)

    vocos = Vocos(cfg=cfg_ns).cpu().eval()

    # Packed weights: {name: {'mode': 'fp16', 'w': half_tensor}}
    packed = ckpt["weights"]
    state = {}
    for name, entry in packed.items():
        if entry.get("mode") != "fp16":
            raise ValueError(f"Unsupported weight mode for {name}: {entry.get('mode')}")
        # FP16 -> FP32: every FP16 value is exactly representable in FP32.
        state[name] = entry["w"].float()
    missing, unexpected = vocos.load_state_dict(state, strict=False)
    if missing or unexpected:
        raise RuntimeError(f"state_dict mismatch: missing={missing}, unexpected={unexpected}")
    print(f"  Loaded {len(state)} tensors from {ckpt_path.name}")

    del ckpt, packed, state
    gc.collect()
    return vocos


def export(vocos, fp32_onnx_path: Path):
    """Export FP32 ONNX (dynamo, opset 20, dynamic mel shapes)."""
    # VocosFullWrapper expects an object exposing .model (like the Vocoder container).
    holder = types.SimpleNamespace(model=vocos)
    wrapper = VocosFullWrapper(holder).cpu().eval()

    dummy_mel = torch.randn(1, 256, MEL_DIM, dtype=torch.float32)
    with torch.no_grad():
        export_fp32_opset20(
            wrapper,
            (dummy_mel,),
            str(fp32_onnx_path),
            input_names=["mel"],
            output_names=["output"],
            dynamic_shapes={"mel": {0: "batch", 1: "seq_len"}},
            # Wrapper already implements MatMul-IDFT + manual overlap-add:
            # no STFT/DFT nodes to replace, no ConvTranspose to decompose.
            skip_stft_replace=True,
            decompose_conv_transpose=True,
            # DML -1-in-Reshape fixups are handled by Olive passes afterwards.
            skip_dml_fixes=True,
        )

    wrapper.cpu()
    del wrapper, holder, dummy_mel
    clear_memory()


def repair_fp16_consumer_edges(model):
    """Insert Cast(FP16->FP32) on every raw FP16-initializer consumer edge.

    quantize_weights_to_fp16 only casts the *weight slot* (input[1]) of
    MatMul/Gemm/Conv. The dynamo exporter sometimes emits weight-first
    MatMuls (matmul(W, x)) or Transpose(W)->MatMul chains, leaving FP16
    initializers flowing directly into FP32 consumers -> ORT type-error.

    For each FP16 initializer, reuse an existing W16A32 Cast when present;
    otherwise create one and rewire every remaining direct consumer edge.
    Returns the number of extra Cast nodes inserted.
    """
    from onnx import helper, TensorProto

    graph = model.graph
    init_names = {i.name for i in graph.initializer if i.data_type == TensorProto.FLOAT16}
    total_added = 0

    for name in init_names:
        cast_out = None
        cast_node_name = f"{name}_w16a32_repair_cast"
        # Reuse an existing Cast(FP16->FP32) of this initializer if present.
        for node in graph.node:
            if node.op_type == "Cast" and node.input[0] == name:
                for attr in node.attribute:
                    if attr.name == "to" and attr.i == TensorProto.FLOAT:
                        cast_out = node.output[0]
                        break
            if cast_out is not None:
                break

        first_consumer_idx = None
        for idx, node in enumerate(graph.node):
            if name not in node.input:
                continue
            if node.op_type == "Cast" and node.input[0] == name:
                continue  # existing cast edge
            if cast_out is None:
                cast_out = cast_node_name + "_out"
            if first_consumer_idx is None:
                first_consumer_idx = idx
            for slot, inp in enumerate(node.input):
                if inp == name:
                    node.input[slot] = cast_out

        if cast_node_name + "_out" == cast_out and first_consumer_idx is not None:
            cast_node = helper.make_node(
                "Cast", [name], [cast_out], name=cast_node_name, to=TensorProto.FLOAT
            )
            graph.node.insert(first_consumer_idx, cast_node)
            total_added += 1

    return total_added


def fix_neg1_const_reshapes(model):
    """Rewrite float-tensor Reshapes whose const shape contains -1.

    DML rejects runtime -1 resolution in Reshape shape tensors
    (0x80070057 / 0x8007023E). Replace each const spec [..,-1,..] with a
    runtime-computed shape: Concat of constants and
        inferred = Size(x) // prod(known spec dims).
    Size is rank-agnostic (input rank need not match spec length), and only
    standard shape ops are emitted (all DML-compatible).
    Int64 shape-flow Reshapes are left untouched (DML partitions those on CPU).
    """
    import onnx
    from onnx import helper, numpy_helper, TensorProto

    graph = model.graph
    vi = {v.name: v for v in graph.value_info}
    for v in graph.input:
        vi[v.name] = v
    init_map = {i.name: i for i in graph.initializer}

    fixed = 0
    for node in list(graph.node):
        if node.op_type != "Reshape" or len(node.input) < 2:
            continue
        shape_name = node.input[1]
        if shape_name not in init_map:
            continue
        spec = numpy_helper.to_array(init_map[shape_name]).tolist()
        if not isinstance(spec, list) or spec.count(-1) != 1:
            continue

        data_name = node.input[0]
        data_vi = vi.get(data_name)
        if data_vi is not None and data_vi.type.tensor_type.elem_type != TensorProto.FLOAT:
            continue  # non-float (e.g. int64 shape flow): leave for CPU partition

        base = (node.name or "reshape").replace("/", "_").replace(":", "_")
        p = f"{base}_n1fix_{fixed}"
        new_nodes = []

        # total elements as an int64 scalar (rank-agnostic)
        total = f"{p}_size"
        new_nodes.append(helper.make_node("Size", [data_name], [total], name=total))

        known_prod = 1
        for s in spec:
            if s != -1:
                known_prod *= int(s)
        inferred = f"{p}_inferred"
        if known_prod != 1:
            kp = numpy_helper.from_array(np.array(known_prod, dtype=np.int64), name=f"{p}_kp")
            graph.initializer.append(kp)
            new_nodes.append(helper.make_node("Div", [total, f"{p}_kp"], [inferred],
                                              name=inferred))
        else:
            inferred = total

        # Build Concat parts: constants as 1-element int64 tensors, -1 -> inferred
        part_names = []
        for i, s in enumerate(spec):
            ci = f"{p}_part{i}"
            if s == -1:
                val_name = inferred
            else:
                cinit = numpy_helper.from_array(np.array(int(s), dtype=np.int64), name=f"{p}_c{i}")
                graph.initializer.append(cinit)
                val_name = f"{p}_c{i}"
            uns = f"{p}_uns{i}"
            axes = numpy_helper.from_array(np.array([0], dtype=np.int64), name=f"{p}_ax{i}")
            graph.initializer.append(axes)
            new_nodes.append(helper.make_node("Unsqueeze", [val_name, f"{p}_ax{i}"], [uns],
                                              name=uns))
            part_names.append(uns)
        new_shape = f"{p}_newshape"
        new_nodes.append(helper.make_node("Concat", part_names, [new_shape],
                                          name=new_shape, axis=0))

        idx_in_graph = list(graph.node).index(node)
        for j, n in enumerate(new_nodes):
            graph.node.insert(idx_in_graph + j, n)
        node.input[1] = new_shape
        fixed += 1

    if fixed:
        print(f"  fix_neg1_const_reshapes: rewrote {fixed} Reshape node(s)")
    return model


def to_w16a32(fp32_onnx_path: Path, w16_onnx_path: Path):
    """Convert weight initializers to FP16 + Cast(FP16->FP32) (A32 stays)."""
    import onnx
    from collections import Counter

    model = onnx.load(str(fp32_onnx_path), load_external_data=True)
    # DML: eliminate -1 from const Reshape specs BEFORE dtype conversion
    # (pure shape-graph surgery, no shape-inference/save cycle on FP16 data).
    model = fix_neg1_const_reshapes(model)
    model = quantize_weights_to_fp16(model)
    extra = repair_fp16_consumer_edges(model)
    print(f"  repair_fp16_consumer_edges: +{extra} Cast nodes for weight-first edges")

    for p in (w16_onnx_path, Path(str(w16_onnx_path) + ".data")):
        if p.exists():
            p.unlink()
    onnx.save_model(
        model,
        str(w16_onnx_path),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=w16_onnx_path.name + ".data",
        size_threshold=1024,
    )

    # Report graph stats
    m = onnx.load(str(w16_onnx_path), load_external_data=False)
    init_dtypes = Counter(i.data_type for i in m.graph.initializer)
    casts = sum(1 for n in m.graph.node if n.op_type == "Cast")
    dft = sum(1 for n in m.graph.node if n.op_type in ("DFT", "STFT", "Col2Im", "ConvTranspose"))
    print(f"  Initializers: FP16={init_dtypes.get(10, 0)}, FP32={init_dtypes.get(1, 0)}")
    print(f"  Cast nodes: {casts}, DML-hostile nodes (DFT/STFT/Col2Im/ConvTranspose): {dft}")
    print(f"  Inputs: {[(i.name, [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim]) for i in m.graph.input]}")
    print(f"  Outputs: {[(o.name, [d.dim_value or d.dim_param for d in o.type.tensor_type.shape.dim]) for o in m.graph.output]}")

    size = w16_onnx_path.stat().st_size / 1024 / 1024
    data = Path(str(w16_onnx_path) + ".data")
    size += data.stat().st_size / 1024 / 1024 if data.exists() else 0
    print(f"  W16A32 model total size: {size:.1f} MB")

    del model, m
    clear_memory()


def metrics(ref: np.ndarray, got: np.ndarray):
    ref = ref.reshape(-1).astype(np.float64)
    got = got.reshape(-1).astype(np.float64)
    cos = float(ref @ got / (np.linalg.norm(ref) * np.linalg.norm(got) + 1e-12))
    noise = np.sum((ref - got) ** 2)
    snr = float(10 * np.log10(np.sum(ref ** 2) / (noise + 1e-12)))
    return cos, snr, float(np.max(np.abs(ref - got)))


def verify(vocos, w16_onnx_path: Path, ref_io_path: Path):
    """PyTorch FP32 reference vs W16A32 ONNX (CPU) on two sequence lengths."""
    import onnxruntime as ort

    holder = types.SimpleNamespace(model=vocos)
    wrapper = VocosFullWrapper(holder).cpu().eval()

    sess = ort.InferenceSession(str(w16_onnx_path), providers=["CPUExecutionProvider"])

    rng = np.random.default_rng(42)
    ref_cases = {}
    ok = True
    for frames in (100, 257):
        mel_np = (rng.standard_normal((1, frames, MEL_DIM)) * 0.1).astype(np.float32)
        with torch.no_grad():
            ref = wrapper(torch.from_numpy(mel_np)).cpu().numpy()
        got = sess.run(None, {"mel": mel_np})[0]
        cos, snr, maxdiff = metrics(ref, got)
        print(f"  [frames={frames}] cosine={cos:.6f} SNR={snr:.2f} dB max|d|={maxdiff:.2e} "
              f"shapes ref={ref.shape} onnx={got.shape}")
        if cos < 0.999 or snr < 25.0:
            ok = False
        ref_cases[f"mel_{frames}"] = mel_np
        ref_cases[f"ref_{frames}"] = got  # ONNX output is the pre-Olive reference

    np.savez(str(ref_io_path), **ref_cases)
    print(f"  Reference I/O saved to {ref_io_path.name}")

    del sess, wrapper, holder
    clear_memory()
    return ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pt", default=str(DEFAULT_PT))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUT_DIR))
    args = parser.parse_args()

    pt_path = Path(args.pt)
    out_dir = Path(args.output_dir)
    work_dir = out_dir / "work"
    onnx_dir = out_dir / "onnx"
    for d in (work_dir, onnx_dir):
        d.mkdir(parents=True, exist_ok=True)

    fp32_path = work_dir / "vocoder_fp32.onnx"
    w16_path = onnx_dir / "vocoder_w16a32.onnx"
    ref_io_path = onnx_dir / "vocoder_w16a32_ref_io.npz"

    print("[1/4] Building Vocos and loading packed FP16 weights...")
    vocos = build_vocos_from_ckpt(pt_path)

    print("[2/4] Exporting FP32 ONNX (opset 20, dynamo, dynamic shapes)...")
    export(vocos, fp32_path)

    print("[3/4] Converting weights to FP16 (W16A32)...")
    to_w16a32(fp32_path, w16_path)

    print("[4/4] Numerical verification (PyTorch FP32 vs ONNX CPU)...")
    ok = verify(vocos, w16_path, ref_io_path)

    # FP32 temp export can be ~1GB; remove as soon as W16A32 is produced.
    for p in (fp32_path, Path(str(fp32_path) + ".data")):
        if p.exists():
            p.unlink()
    del vocos
    clear_memory()

    if not ok:
        print("EXPORT VERIFICATION FAILED")
        return 1
    print(f"\nDone. W16A32 ONNX: {w16_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
