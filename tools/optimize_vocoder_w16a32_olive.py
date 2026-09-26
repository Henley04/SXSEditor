# -*- coding: utf-8 -*-
"""Hardware-agnostic Olive optimization for the W16A32 vocoder ONNX.

"Hardware-agnostic" means Olive passes that do not depend on any vendor
execution provider: the accelerator spec is CPU / CPUExecutionProvider, so the
resulting model remains portable (DML / CPU / other EPs all consume the same
graph). Only generic graph rewrites are applied:

  1. OnnxQuantizationPreprocess: ORT shape inference + graph optimization +
     auto-merge (CPU EP, portable).
  2. OnnxPeepholeOptimizer: onnxscript optimize + onnxoptimizer optimize +
     Cast-chain elimination + Reshape fusion, serialized as external data.

IMPORTANT (lesson learned on this exact vocoder): do NOT run
resolve_neg1_in_reshape_shapes or an onnx shape-inference/save cycle on the
vocoder graph here. That post-processing, combined with an onnx.load/save
cycle, corrupts the FP32 ISTFT basis-matrix precision (SNR 33 dB -> -43 dB).
The Olive output is copied to the destination verbatim.
"""
import argparse
import gc
import logging
import shutil
from pathlib import Path

import numpy as np

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
DEFAULT_IN_DIR = PROJECT_ROOT / "w16a32_output" / "onnx"
DEFAULT_OUT_DIR = PROJECT_ROOT / "w16a32_output" / "olive"


def cos_snr(ref: np.ndarray, got: np.ndarray):
    ref = ref.reshape(-1).astype(np.float64)
    got = got.reshape(-1).astype(np.float64)
    cos = float(ref @ got / (np.linalg.norm(ref) * np.linalg.norm(got) + 1e-12))
    snr = float(10 * np.log10(np.sum(ref ** 2) / (np.sum((ref - got) ** 2) + 1e-12)))
    return cos, snr


def model_size_mb(*paths: Path) -> float:
    total = 0.0
    for p in paths:
        if p.exists():
            total += p.stat().st_size
    return total / 1024 / 1024


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", default=str(DEFAULT_IN_DIR))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUT_DIR))
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    model_path = input_dir / "vocoder_w16a32.onnx"
    ref_io_path = input_dir / "vocoder_w16a32_ref_io.npz"
    if not model_path.exists():
        raise FileNotFoundError(f"Run export_vocoder_w16a32_pt.py first. Missing: {model_path}")

    # Keep Olive's internal external-data location verbatim (the proto stores
    # the basename "vocoder_w16a32.onnx.data"); renaming would break loading
    # and an onnx load/save rewrite risks ISTFT basis precision. The
    # pre/post distinction is the directory (onnx/ vs olive/).
    final_path = output_dir / "vocoder_w16a32.onnx"
    work_dir = output_dir / "_olive_work"
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True)

    in_size = model_size_mb(model_path, Path(str(model_path) + ".data"))
    logger.info("=" * 60)
    logger.info("Hardware-agnostic Olive optimization for W16A32 vocoder")
    logger.info(f"  Input : {model_path} ({in_size:.1f} MB)")
    logger.info(f"  Output: {final_path}")
    logger.info("=" * 60)

    # ---- Hardware-agnostic accelerator spec: CPU + CPUExecutionProvider ----
    from olive.hardware.accelerator import AcceleratorSpec, Device
    from olive.hardware.constants import ExecutionProvider
    from olive.model import ONNXModelHandler
    from olive.passes.onnx.quantization import OnnxQuantizationPreprocess
    from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer

    accel = AcceleratorSpec(
        accelerator_type=Device.CPU,
        execution_provider=ExecutionProvider.CPUExecutionProvider,
    )
    logger.info(f"AcceleratorSpec: {accel.accelerator_type} / {accel.execution_provider}")

    olive_model = ONNXModelHandler(model_path=str(model_path))

    # ---- Pass 1: OnnxQuantizationPreprocess (ORT opt + shape inference) ----
    logger.info("--- Pass 1: OnnxQuantizationPreprocess (ORT optimization) ---")
    pre_config = OnnxQuantizationPreprocess.generate_config(accel, {"skip_symbolic_shape": True})
    olive_model = OnnxQuantizationPreprocess(accel, pre_config).run(
        olive_model, str(work_dir / "preprocess")
    )
    gc.collect()

    # ---- Pass 2: OnnxPeepholeOptimizer (generic graph peephole rewrites) ----
    logger.info("--- Pass 2: OnnxPeepholeOptimizer ---")
    peep_config = OnnxPeepholeOptimizer.generate_config(accel, {
        "onnxscript_optimize": True,
        "onnxoptimizer_optimize": True,
        "fuse_reshape_operations": True,
        "cast_chain_elimination": True,
        "save_as_external_data": True,
        "all_tensors_to_one_file": True,
        "size_threshold": 1024,
    })
    olive_model = OnnxPeepholeOptimizer(accel, peep_config).run(
        olive_model, str(work_dir / "peephole")
    )
    gc.collect()

    # ---- Copy Olive output verbatim (NO onnx load/save/shape-inference cycle) ----
    olive_out = Path(olive_model.model_path)
    logger.info(f"Olive output: {olive_out}")
    for suffix in ("", ".data"):
        dst = Path(str(final_path) + suffix)
        src = Path(str(olive_out) + suffix)
        if dst.exists():
            dst.unlink()
        if src.exists():
            shutil.copy2(src, dst)
            logger.info(f"  Copied {src.name} -> {dst.name}")

    if not final_path.exists():
        raise RuntimeError(f"Olive output missing: {olive_out}")

    out_size = model_size_mb(final_path, Path(str(final_path) + ".data"))
    logger.info(f"Output size: {out_size:.1f} MB (input {in_size:.1f} MB)")

    # ---- Verification: pre-Olive reference vs Olive output ----
    logger.info("--- Verification ---")
    import onnxruntime as ort

    ref_io = np.load(str(ref_io_path))
    mel_100 = ref_io["mel_100"]
    mel_257 = ref_io["mel_257"]

    # CPU parity
    sess_cpu = ort.InferenceSession(str(final_path), providers=["CPUExecutionProvider"])
    worst = (1.0, 1e9)
    for tag, mel, ref_key in (("100", mel_100, "ref_100"), ("257", mel_257, "ref_257")):
        got = sess_cpu.run(None, {"mel": mel})[0]
        cos, snr = cos_snr(ref_io[ref_key], got)
        logger.info(f"  CPU  frames={tag}: cosine={cos:.6f} SNR={snr:.2f} dB shape={got.shape}")
        worst = (min(worst[0], cos), min(worst[1], snr))
    del sess_cpu
    gc.collect()

    # DML smoke test
    dml_ok = False
    try:
        sess_dml = ort.InferenceSession(
            str(final_path), providers=["DmlExecutionProvider", "CPUExecutionProvider"]
        )
        dml_ok = "DmlExecutionProvider" in sess_dml.get_providers()
        got_dml = sess_dml.run(None, {"mel": mel_257})[0]
        cos_dml, snr_dml = cos_snr(ref_io["ref_257"], got_dml)
        logger.info(
            f"  DML  frames=257: active={dml_ok} cosine={cos_dml:.6f} SNR={snr_dml:.2f} dB"
        )
        worst = (min(worst[0], cos_dml), min(worst[1], snr_dml))
        del sess_dml
        gc.collect()
    except Exception as e:
        logger.warning(f"  DML smoke test failed: {str(e)[:300]}")

    # Graph stats (read-only header inspection)
    import onnx
    from onnx import TensorProto
    from collections import Counter

    head = onnx.load(str(final_path), load_external_data=False)
    init_dt = Counter(i.data_type for i in head.graph.initializer)
    casts = sum(1 for n in head.graph.node if n.op_type == "Cast")
    hostile = sum(1 for n in head.graph.node if n.op_type in ("DFT", "STFT", "Col2Im", "ConvTranspose"))
    logger.info(
        f"  Graph: {len(head.graph.node)} nodes, FP16 inits={init_dt.get(TensorProto.FLOAT16, 0)}, "
        f"FP32 inits={init_dt.get(TensorProto.FLOAT, 0)}, Cast={casts}, hostile={hostile}"
    )
    del head
    gc.collect()

    # ---- Cleanup temp Olive work dir ----
    shutil.rmtree(work_dir, ignore_errors=True)

    cos_w, snr_w = worst
    if cos_w < 0.9 or snr_w < 20.0:
        logger.error(f"VERIFICATION FAILED: cosine={cos_w:.6f} SNR={snr_w:.2f} dB")
        return 1

    logger.info(f"PASS. Final model: {final_path} (DML active={dml_ok})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
