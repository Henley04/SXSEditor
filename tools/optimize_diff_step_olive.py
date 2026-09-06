# -*- coding: utf-8 -*-
"""Olive optimization for diff_step FP32 DML model.

Applies Olive passes to the dynamo-exported diff_step ONNX model:
  1. OnnxQuantizationPreprocess: ORT shape inference + optimization + auto_merge
  2. OnnxPeepholeOptimizer: onnxscript optimize + Cast chain elimination + Reshape fusion
  3. resolve_neg1_in_reshape_shapes: replace -1 in Reshape shape Concat with computed
     static value (DML EP doesn't support -1 in shape tensor, returns E_INVALIDARG)

DML compatibility is handled here (Olive + post-processing) rather than at export
time (skip_dml_fixes=True in export_step1_diffstep.py).

AcceleratorSpec: GPU + DmlExecutionProvider (target DML EP for inference).
"""
import os
# Avoid RoPE precomputation patches when importing export_shared for resolve_neg1
os.environ['SKIP_ROPE_PRECOMPUTE'] = '1'
import shutil
import logging
from pathlib import Path

from olive.hardware.accelerator import AcceleratorSpec, Device
from olive.hardware.constants import ExecutionProvider
from olive.model import ONNXModelHandler
from olive.passes.onnx.quantization import OnnxQuantizationPreprocess
from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer
# DML compat: resolve -1 in Reshape shapes (DML doesn't support -1 in shape tensor)
from export_shared import resolve_neg1_in_reshape_shapes

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

BASE_DIR = Path(r"D:\Document\electron\SXSEditor\onnx_models")
MODEL_PATH = BASE_DIR / "diff_step_dml.onnx"
WORK_DIR = BASE_DIR / "_olive_diff_step_work"

# GPU + DML accelerator spec: Olive passes target DML EP
ACCEL_SPEC = AcceleratorSpec(
    accelerator_type=Device.GPU,
    execution_provider=ExecutionProvider.DmlExecutionProvider,
)


def main():
    logger.info("=" * 60)
    logger.info("Olive optimization for diff_step FP32 DML model")
    logger.info(f"AcceleratorSpec: {ACCEL_SPEC.accelerator_type} / {ACCEL_SPEC.execution_provider}")
    logger.info("=" * 60)

    if not MODEL_PATH.exists():
        logger.error(f"Model not found: {MODEL_PATH}")
        logger.error("Please run `python export_step1_diffstep.py` first.")
        return 1

    # Backup original
    work_dir = WORK_DIR
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True)

    input_size = MODEL_PATH.stat().st_size / (1024 * 1024)
    data_file = MODEL_PATH.with_suffix(".onnx.data")
    if data_file.exists():
        input_size += data_file.stat().st_size / (1024 * 1024)
    logger.info(f"Input model: {MODEL_PATH.name} ({input_size:.1f} MB)")

    model = ONNXModelHandler(model_path=str(MODEL_PATH))

    # Step 1: OnnxQuantizationPreprocess
    logger.info("\n--- Step 1: OnnxQuantizationPreprocess ---")
    preprocess_dir = str(work_dir / "preprocessed")
    preprocess_config = OnnxQuantizationPreprocess.generate_config(
        ACCEL_SPEC, {"skip_symbolic_shape": True}
    )
    preprocess_pass = OnnxQuantizationPreprocess(ACCEL_SPEC, preprocess_config)
    model = preprocess_pass.run(model, preprocess_dir)
    logger.info("OnnxQuantizationPreprocess completed")

    # Step 2: OnnxPeepholeOptimizer
    # 显式启用 save_as_external_data=True，避免 1688MB 数据内联到 .onnx 文件
    # （默认 save_as_external_data=False 会导致 .onnx 膨胀到 1688MB）
    logger.info("\n--- Step 2: OnnxPeepholeOptimizer ---")
    peephole_dir = str(work_dir / "peephole")
    peephole_config = OnnxPeepholeOptimizer.generate_config(
        ACCEL_SPEC,
        {
            "onnxscript_optimize": True,
            "onnxoptimizer_optimize": True,
            "fuse_reshape_operations": True,
            "cast_chain_elimination": True,
            "save_as_external_data": True,
            "all_tensors_to_one_file": True,
            "size_threshold": 1024,
        },
    )
    peephole_pass = OnnxPeepholeOptimizer(ACCEL_SPEC, peephole_config)
    model = peephole_pass.run(model, peephole_dir)
    logger.info("OnnxPeepholeOptimizer completed")

    # Step 3: resolve_neg1_in_reshape_shapes (DML compat post-processing)
    # DML EP doesn't support -1 in Reshape shape tensor (returns E_INVALIDARG 0x80070057).
    # Replace -1 in Concat-produced Reshape shapes with computed static values.
    logger.info("\n--- Step 3: resolve_neg1_in_reshape_shapes ---")
    import onnx
    from onnx import shape_inference

    final_model_path_pre = Path(model.model_path)
    pre_proto = onnx.load(str(final_model_path_pre), load_external_data=True)
    # Run shape inference to populate value_info for resolve_neg1
    pre_proto = shape_inference.infer_shapes(pre_proto)
    pre_proto = resolve_neg1_in_reshape_shapes(pre_proto)
    logger.info("resolve_neg1_in_reshape_shapes completed")

    # Save final output to target location with proper external data format.
    logger.info("\n--- Saving final output with external data format ---")

    # Remove old output files to avoid stale data
    if MODEL_PATH.exists():
        MODEL_PATH.unlink()
    old_data = MODEL_PATH.with_name(MODEL_PATH.name + ".data")
    if old_data.exists():
        old_data.unlink()

    onnx.save_model(
        pre_proto,
        str(MODEL_PATH),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=MODEL_PATH.name + ".data",
        size_threshold=1024,
    )

    output_size = MODEL_PATH.stat().st_size / (1024 * 1024)
    output_data = MODEL_PATH.with_name(MODEL_PATH.name + ".data")
    if output_data.exists():
        output_size += output_data.stat().st_size / (1024 * 1024)
    logger.info(f"Output model: {MODEL_PATH.name} ({output_size:.1f} MB)")

    # Clean up work directory
    logger.info("\n--- Cleaning temporary files ---")
    if work_dir.exists():
        shutil.rmtree(work_dir)
        logger.info("Temporary work directory cleaned")

    # Print node count summary
    result_model = onnx.load(str(MODEL_PATH), load_external_data=False)
    node_count = len(result_model.graph.node)
    op_counts = {}
    for node in result_model.graph.node:
        op_counts[node.op_type] = op_counts.get(node.op_type, 0) + 1
    logger.info(f"\nFinal model: {node_count} nodes")
    for op, cnt in sorted(op_counts.items(), key=lambda x: -x[1])[:10]:
        logger.info(f"  {op}: {cnt}")

    logger.info("\nDone! Run `python test_precision.py` to verify precision.")
    return 0


if __name__ == "__main__":
    exit(main())
