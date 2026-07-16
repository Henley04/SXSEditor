"""
使用 Olive + onnxruntime 对 onnx_models 下的所有 ONNX 模型进行优化量化。

输出结构：
  onnx_models/int8/  - INT8 动态量化模型
  onnx_models/fp16/  - FP16 转换模型 (W16A32 混合精度)

非 ONNX 模型（如 TensorFlow basic_pitch_model）按原结构复制到两个输出文件夹中。

优化流程：
  INT8: 清除形状信息 -> onnxruntime 动态量化 (QInt8)
  FP16: Olive 量化预处理 -> 窥孔优化 -> FP16 转换 (op_block_list 保持敏感算子 FP32)

W16A32 混合精度策略：
  - MatMul/Conv/Gemm: 权重 FP16，激活 FP16 (省显存+加速)
  - Softmax/LayerNorm/ReduceMean/Pow/Sqrt/Reciprocal: FP32 (数值稳定性)
  - Exp/Cos/Sin: FP32 (ISTFT 重建头 + RoPE)
  - Erf/Sigmoid/Tanh: FP32 (饱和激活函数)
  - 端到端 FP16 vs FP32 SNR 从 17.47 dB 提升到接近 30+ dB
"""

import os
import sys
import shutil
import logging
import tempfile
from pathlib import Path

import onnx
from onnxruntime.quantization import quantize_dynamic, QuantType

from olive.hardware.accelerator import AcceleratorSpec
from olive.passes.onnx.quantization import OnnxQuantizationPreprocess
from olive.passes.onnx.float16_conversion import OnnxFloatToFloat16
from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer
from olive.model import ONNXModelHandler

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

BASE_DIR = Path(r"D:\Document\electron\SXSEditor\onnx_models")
INT8_DIR = BASE_DIR / "int8"
FP16_DIR = BASE_DIR / "fp16"

# 不需要量化的文件/文件夹
SKIP_NAMES = {"int8", "fp16", "README.md", "_olive_work", "_test_work", "_test_int8"}

# 需要原样复制的非ONNX文件夹
NON_ONNX_DIRS = ["basic_pitch_model"]

# W16A32 混合精度: 敏感算子保持 FP32，MatMul/Conv/Gemm 保持 FP16
# 这些算子在 FP16 下精度损失大或数值不稳定:
# - Softmax: attention 概率计算，exp 累积误差
# - LayerNormalization: 归一化，方差计算不稳
# - ReduceMean/Pow/Sqrt/Reciprocal: LayerNorm 内部计算
# - Exp/Cos/Sin: ISTFT 重建头 (mag=exp(x)) + RoPE rotary embedding
# - Erf: GELU 激活函数
# - Sigmoid/Tanh: 饱和激活函数，FP16 下边界精度损失
OP_BLOCK_LIST = [
    'Softmax',
    'LayerNormalization',
    'ReduceMean',
    'Pow',
    'Sqrt',
    'Reciprocal',
    'Exp',
    'Cos',
    'Sin',
    'Erf',
    'Sigmoid',
    'Tanh',
]

# Per-model op_block_list 覆盖
# diffStep (DiffLlama) 用 LayerNorm 实现 (ReduceMean+Pow+Sqrt+Reciprocal)，
# 全部 block 会产生 336 个 Cast 节点，FP32→FP16 截断累积误差反而恶化精度。
# 实测：diffStep 用 W16A32 (336 Cast) SNR=11.49 dB < W16A16 SNR=17.84 dB。
# 因此 diffStep 保持 W16A16 (空 block_list)，只 block Softmax 减少量化误差。
# vocoder (Vocos) 用原生 LayerNormalization op，block 后 Cast 少，精度改善明显
# (SNR 19.09 → 26.75 dB)。
PER_MODEL_OP_BLOCK_LIST = {
    'diff_step_dml.onnx': ['Softmax'],  # 只 block Softmax，避免 LayerNorm 实现的 Cast 风暴
    'vocoder_dml.onnx': OP_BLOCK_LIST,  # 全量 block，vocoder 受益明显
}

# CPU 加速器规格
ACCEL_SPEC = AcceleratorSpec(accelerator_type="cpu", execution_provider="CPUExecutionProvider")


def find_onnx_models(base_dir: Path) -> list[tuple[Path, str]]:
    """找到所有 .onnx 模型文件，返回 (绝对路径, 相对路径) 列表。"""
    results = []
    for root, dirs, files in os.walk(base_dir):
        rel_root = Path(root).relative_to(base_dir)
        if any(part in SKIP_NAMES for part in rel_root.parts):
            continue
        if any(part in NON_ONNX_DIRS for part in rel_root.parts):
            continue
        for f in files:
            if f.endswith(".onnx"):
                full_path = Path(root) / f
                rel_path = str(full_path.relative_to(base_dir))
                results.append((full_path, rel_path))
    return results


def find_onnx_data_files(base_dir: Path) -> list[tuple[Path, str]]:
    """找到所有 .onnx.data 外部数据文件。"""
    results = []
    for root, dirs, files in os.walk(base_dir):
        rel_root = Path(root).relative_to(base_dir)
        if any(part in SKIP_NAMES for part in rel_root.parts):
            continue
        if any(part in NON_ONNX_DIRS for part in rel_root.parts):
            continue
        for f in files:
            if f.endswith(".onnx.data"):
                full_path = Path(root) / f
                rel_path = str(full_path.relative_to(base_dir))
                results.append((full_path, rel_path))
    return results


def strip_shape_info(model_path: Path, output_path: Path) -> Path:
    """清除 ONNX 模型中的形状信息，避免形状推断冲突。"""
    logger.info(f"Clearing shape info: {model_path.name}")
    model = onnx.load(str(model_path))

    # 清除所有 value_info
    while len(model.graph.value_info) > 0:
        model.graph.value_info.pop()

    # 清除输出的形状
    for output in model.graph.output:
        if output.type.tensor_type.HasField('shape'):
            output.type.tensor_type.ClearField('shape')

    onnx.save(model, str(output_path))
    del model
    return output_path


def optimize_model_int8(input_path: Path, output_path: Path, work_dir: Path):
    """对单个模型执行 INT8 动态量化。"""
    logger.info(f"[INT8] Start processing: {input_path.name}")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # 步骤1: 清除形状信息（避免形状推断冲突）
    temp_no_shape = work_dir / f"no_shape_{input_path.name}"
    strip_shape_info(input_path, temp_no_shape)

    # 步骤2: 动态 INT8 量化
    logger.info(f"[INT8] Dynamic INT8 quantization - {input_path.name}")
    quantize_dynamic(
        str(temp_no_shape),
        str(output_path),
        weight_type=QuantType.QInt8,
    )

    # 清理临时文件
    if temp_no_shape.exists():
        temp_no_shape.unlink()

    logger.info(f"[INT8] Completed: {input_path.name} -> {output_path}")


def optimize_model_fp16(input_path: Path, output_path: Path, work_dir: Path):
    """对单个模型执行 FP16 转换优化 (W16A32 混合精度)."""
    model_name = input_path.name
    logger.info(f"[FP16] Start processing: {model_name}")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # 选择 per-model op_block_list
    op_block_list = PER_MODEL_OP_BLOCK_LIST.get(model_name, OP_BLOCK_LIST)

    model = ONNXModelHandler(model_path=input_path)

    # 步骤1: 量化预处理
    logger.info(f"[FP16] Step 1: Quantization preprocessing - {model_name}")
    preprocess_dir = str(work_dir / "preprocessed")
    preprocess_config = OnnxQuantizationPreprocess.generate_config(
        ACCEL_SPEC, {"skip_symbolic_shape": True}
    )
    preprocess_pass = OnnxQuantizationPreprocess(ACCEL_SPEC, preprocess_config)
    model = preprocess_pass.run(model, preprocess_dir)
    logger.info(f"[FP16] Preprocessing completed: {model_name}")

    # 步骤2: 窥孔优化
    logger.info(f"[FP16] Step 2: Peephole optimization - {model_name}")
    peephole_dir = str(work_dir / "peephole")
    peephole_config = OnnxPeepholeOptimizer.generate_config(ACCEL_SPEC)
    peephole_pass = OnnxPeepholeOptimizer(ACCEL_SPEC, peephole_config)
    model = peephole_pass.run(model, peephole_dir)
    logger.info(f"[FP16] Peephole optimization completed: {model_name}")

    # 步骤3: FP16 转换 (W16A32: 敏感算子保持 FP32 via op_block_list)
    logger.info(f"[FP16] Step 3: FP16 conversion (op_block_list={op_block_list}) - {model_name}")
    fp16_dir = str(work_dir / "fp16")
    fp16_config = OnnxFloatToFloat16.generate_config(
        ACCEL_SPEC,
        {
            "op_block_list": op_block_list,
            "keep_io_types": True,
        },
    )
    fp16_pass = OnnxFloatToFloat16(ACCEL_SPEC, fp16_config)
    model = fp16_pass.run(model, fp16_dir)

    # 复制最终输出到目标位置
    _copy_model_output(model, output_path)
    logger.info(f"[FP16] Completed: {model_name} -> {output_path}")


def _copy_model_output(model: ONNXModelHandler, output_path: Path):
    """将 Olive 输出的模型文件复制到目标位置。"""
    final_model_path = Path(model.model_path)
    if final_model_path != output_path:
        shutil.copy2(final_model_path, output_path)
    # 复制可能存在的外部数据文件
    for ext in [".data", ".onnx.data"]:
        src_data = final_model_path.with_suffix(ext)
        if src_data.exists():
            shutil.copy2(src_data, output_path.with_suffix(ext))
    # 也检查同目录下其他 .data 文件
    parent = final_model_path.parent
    for data_file in parent.glob("*.data"):
        if data_file != final_model_path.with_suffix(".data") and data_file != final_model_path.with_suffix(".onnx.data"):
            shutil.copy2(data_file, output_path.parent / data_file.name)


def copy_non_onnx_files(src_dir: Path, dst_dir: Path):
    """复制非ONNX文件（如TensorFlow模型）到目标目录，保持原结构。"""
    for non_onnx_dir in NON_ONNX_DIRS:
        src = src_dir / non_onnx_dir
        dst = dst_dir / non_onnx_dir
        if src.exists():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
            logger.info(f"Copied non-ONNX directory: {src} -> {dst}")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Olive ONNX optimization (INT8 + W16A32 FP16)")
    parser.add_argument('--models', nargs='+', default=None,
                        help='只处理指定模型文件名（如 diff_step_dml.onnx vocoder_dml.onnx）')
    parser.add_argument('--fp16-only', action='store_true',
                        help='只执行 FP16 转换，跳过 INT8')
    parser.add_argument('--int8-only', action='store_true',
                        help='只执行 INT8 量化，跳过 FP16')
    args = parser.parse_args()

    logger.info("=" * 60)
    logger.info("Olive ONNX model optimization tool (W16A32 mixed precision)")
    logger.info("=" * 60)

    # 创建输出目录
    INT8_DIR.mkdir(parents=True, exist_ok=True)
    FP16_DIR.mkdir(parents=True, exist_ok=True)

    # 临时工作目录
    work_dir = BASE_DIR / "_olive_work"
    work_dir.mkdir(parents=True, exist_ok=True)

    # 查找所有 ONNX 模型
    onnx_models = find_onnx_models(BASE_DIR)
    onnx_data_files = find_onnx_data_files(BASE_DIR)

    # 按 --models 过滤
    if args.models:
        model_set = set(args.models)
        onnx_models = [(p, r) for p, r in onnx_models if Path(r).name in model_set]
        logger.info(f"Filtered to {len(onnx_models)} models: {[r for _, r in onnx_models]}")

    logger.info(f"Found {len(onnx_models)} ONNX model files")
    logger.info(f"Found {len(onnx_data_files)} external data files")

    for full_path, rel_path in onnx_models:
        size_mb = full_path.stat().st_size / (1024 * 1024)
        data_file = full_path.with_suffix(".onnx.data")
        if data_file.exists():
            size_mb += data_file.stat().st_size / (1024 * 1024)
        logger.info(f"  - {rel_path} ({size_mb:.1f} MB)")

    # 复制非ONNX文件到两个输出目录
    if not args.fp16_only and not args.int8_only:
        logger.info("\n--- Copying non-ONNX files ---")
        copy_non_onnx_files(BASE_DIR, INT8_DIR)
        copy_non_onnx_files(BASE_DIR, FP16_DIR)

    # 复制 README 文件
    if not args.fp16_only and not args.int8_only:
        for readme in BASE_DIR.glob("README.md"):
            shutil.copy2(readme, INT8_DIR / "README.md")
            shutil.copy2(readme, FP16_DIR / "README.md")
        for readme in (BASE_DIR / "preprocess").glob("README.md"):
            (INT8_DIR / "preprocess").mkdir(parents=True, exist_ok=True)
            (FP16_DIR / "preprocess").mkdir(parents=True, exist_ok=True)
            shutil.copy2(readme, INT8_DIR / "preprocess" / "README.md")
            shutil.copy2(readme, FP16_DIR / "preprocess" / "README.md")

    # INT8 量化
    if not args.fp16_only:
        logger.info("\n" + "=" * 60)
        logger.info("Starting INT8 dynamic quantization")
        logger.info("=" * 60)

        for i, (full_path, rel_path) in enumerate(onnx_models, 1):
            logger.info(f"\n[{i}/{len(onnx_models)}] INT8: {rel_path}")
            output_path = INT8_DIR / rel_path
            model_work_dir = work_dir / "int8" / Path(rel_path).stem
            model_work_dir.mkdir(parents=True, exist_ok=True)

            try:
                optimize_model_int8(full_path, output_path, model_work_dir)
            except Exception as e:
                logger.error(f"[INT8] Failed: {rel_path} - {e}", exc_info=True)
                # 失败时复制原始文件作为回退
                shutil.copy2(full_path, output_path)
                data_file = full_path.with_suffix(".onnx.data")
                if data_file.exists():
                    shutil.copy2(data_file, output_path.with_suffix(".onnx.data"))
                logger.warning(f"[INT8] Fallback: copied original file {rel_path}")

    # FP16 转换 (W16A32)
    if not args.int8_only:
        logger.info("\n" + "=" * 60)
        logger.info("Starting FP16 conversion (W16A32 mixed precision)")
        logger.info(f"op_block_list: {OP_BLOCK_LIST}")
        logger.info("=" * 60)

        for i, (full_path, rel_path) in enumerate(onnx_models, 1):
            logger.info(f"\n[{i}/{len(onnx_models)}] FP16: {rel_path}")
            output_path = FP16_DIR / rel_path
            model_work_dir = work_dir / "fp16" / Path(rel_path).stem
            model_work_dir.mkdir(parents=True, exist_ok=True)

            try:
                optimize_model_fp16(full_path, output_path, model_work_dir)
            except Exception as e:
                logger.error(f"[FP16] Failed: {rel_path} - {e}", exc_info=True)
                # 失败时复制原始文件作为回退
                shutil.copy2(full_path, output_path)
                data_file = full_path.with_suffix(".onnx.data")
                if data_file.exists():
                    shutil.copy2(data_file, output_path.with_suffix(".onnx.data"))
                logger.warning(f"[FP16] Fallback: copied original file {rel_path}")

        # 复制 .onnx.data 文件到 FP16 输出目录（如果量化后模型仍需要）
        logger.info("\n--- Checking external data files for FP16 ---")
        for src_path, rel_path in onnx_data_files:
            dst_path = FP16_DIR / rel_path
            if not dst_path.exists():
                dst_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src_path, dst_path)
                logger.info(f"[FP16] Copied external data: {rel_path}")

    # 清理临时工作目录
    logger.info("\n--- Cleaning temporary files ---")
    if work_dir.exists():
        shutil.rmtree(work_dir)
        logger.info("Temporary work directory cleaned")

    # 输出统计
    logger.info("\n" + "=" * 60)
    logger.info("Optimization completed! Statistics:")
    logger.info("=" * 60)

    for label, out_dir in [("INT8", INT8_DIR), ("FP16", FP16_DIR)]:
        if not out_dir.exists():
            continue
        total_size = sum(f.stat().st_size for f in out_dir.rglob("*") if f.is_file())
        logger.info(f"{label}: {total_size / (1024*1024):.1f} MB total ({out_dir})")

    # 详细对比
    logger.info("\n--- Model size comparison ---")
    logger.info(f"{'Model':<40} {'Original':>10} {'INT8':>10} {'FP16':>10}")
    for full_path, rel_path in onnx_models:
        orig_size = full_path.stat().st_size / (1024 * 1024)
        data_file = full_path.with_suffix(".onnx.data")
        if data_file.exists():
            orig_size += data_file.stat().st_size / (1024 * 1024)

        int8_path = INT8_DIR / rel_path
        int8_size = int8_path.stat().st_size / (1024 * 1024) if int8_path.exists() else 0
        int8_data = int8_path.with_suffix(".onnx.data")
        if int8_data.exists():
            int8_size += int8_data.stat().st_size / (1024 * 1024)

        fp16_path = FP16_DIR / rel_path
        fp16_size = fp16_path.stat().st_size / (1024 * 1024) if fp16_path.exists() else 0
        fp16_data = fp16_path.with_suffix(".onnx.data")
        if fp16_data.exists():
            fp16_size += fp16_data.stat().st_size / (1024 * 1024)

        logger.info(f"{rel_path:<40} {orig_size:>8.1f}MB {int8_size:>8.1f}MB {fp16_size:>8.1f}MB")

    logger.info("\nDone!")


if __name__ == "__main__":
    main()
