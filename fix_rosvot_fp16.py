"""
修复 FP16 版本的 rosvot_model.onnx
使用修复后的 FP32 模型重新进行 FP16 转换，并修复 ScatterElements 兼容性问题

流程：
  1. OnnxQuantizationPreprocess (skip_symbolic_shape=True)
  2. OnnxPeepholeOptimizer
  3. OnnxFloatToFloat16
  4. 修复 ScatterElements(reduction=add) 的 float16 兼容性问题
  5. 验证模型可正常加载和推理
"""

import os
import shutil
import logging
import tempfile
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, TensorProto
import onnxruntime as ort

from olive.hardware.accelerator import AcceleratorSpec
from olive.passes.onnx.quantization import OnnxQuantizationPreprocess
from olive.passes.onnx.float16_conversion import OnnxFloatToFloat16
from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer
from olive.model import ONNXModelHandler

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

BASE_DIR = Path(r"D:\Document\electron\SXSEditor\onnx_models")
FP32_MODEL = BASE_DIR / "preprocess" / "rosvot_model.onnx"
FP16_MODEL = BASE_DIR / "fp16" / "preprocess" / "rosvot_model.onnx"

ACCEL_SPEC = AcceleratorSpec(accelerator_type="cpu", execution_provider="CPUExecutionProvider")


def convert_fp16(input_path: Path, output_path: Path, work_dir: Path):
    """将 FP32 模型转换为 FP16。"""
    logger.info(f"开始 FP16 转换: {input_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    model = ONNXModelHandler(model_path=input_path)

    # 步骤1: 量化预处理
    logger.info("步骤1: OnnxQuantizationPreprocess (skip_symbolic_shape=True)")
    preprocess_dir = str(work_dir / "preprocessed")
    preprocess_config = OnnxQuantizationPreprocess.generate_config(
        ACCEL_SPEC, {"skip_symbolic_shape": True}
    )
    preprocess_pass = OnnxQuantizationPreprocess(ACCEL_SPEC, preprocess_config)
    model = preprocess_pass.run(model, preprocess_dir)
    logger.info("预处理完成")

    # 步骤2: 窥孔优化
    logger.info("步骤2: OnnxPeepholeOptimizer")
    peephole_dir = str(work_dir / "peephole")
    peephole_config = OnnxPeepholeOptimizer.generate_config(ACCEL_SPEC)
    peephole_pass = OnnxPeepholeOptimizer(ACCEL_SPEC, peephole_config)
    model = peephole_pass.run(model, peephole_dir)
    logger.info("窥孔优化完成")

    # 步骤3: FP16 转换
    logger.info("步骤3: OnnxFloatToFloat16")
    fp16_dir = str(work_dir / "fp16")
    fp16_config = OnnxFloatToFloat16.generate_config(ACCEL_SPEC)
    fp16_pass = OnnxFloatToFloat16(ACCEL_SPEC, fp16_config)
    model = fp16_pass.run(model, fp16_dir)

    # 复制最终输出到目标位置
    final_model_path = Path(model.model_path)
    if final_model_path != output_path:
        shutil.copy2(final_model_path, output_path)
    # 复制可能存在的外部数据文件
    for ext in [".data", ".onnx.data"]:
        src_data = final_model_path.with_suffix(ext)
        if src_data.exists():
            shutil.copy2(src_data, output_path.with_suffix(ext))

    logger.info(f"FP16 转换完成: {output_path}")
    return output_path


def fix_scatter_elements_fp16(model_path: Path):
    """修复 FP16 模型中 ScatterElements(reduction=add) 节点的 float16 兼容性问题。
    
    ScatterElements with reduction='add' 在 CPU EP 上不支持 float16，
    需要在 data 和 updates 输入前插入 Cast(fp16→fp32)，输出后插入 Cast(fp32→fp16)。
    """
    logger.info(f"修复 ScatterElements 兼容性: {model_path}")
    model = onnx.load(str(model_path))
    graph = model.graph

    # 找到所有 ScatterElements 节点
    scatter_nodes = [n for n in graph.node if n.op_type == "ScatterElements"]
    logger.info(f"找到 {len(scatter_nodes)} 个 ScatterElements 节点")

    nodes_to_fix = []
    for node in scatter_nodes:
        for attr in node.attribute:
            if attr.name == "reduction" and attr.s == b"add":
                nodes_to_fix.append(node)
                logger.info(f"  需要修复: {node.name} (reduction=add)")
                break

    if not nodes_to_fix:
        logger.info("无需修复的 ScatterElements 节点")
        del model
        return

    # 为每个需要修复的节点插入 Cast 节点
    new_nodes = []

    for node in graph.node:
        if node in nodes_to_fix:
            logger.info(f"修复节点: {node.name}")

            # 获取 data 输入（第一个输入）和 updates 输入（第三个输入）
            data_input = node.input[0]
            updates_input = node.input[2] if len(node.input) > 2 else None
            output_name = node.output[0]

            # 创建中间名称
            cast_data_name = f"{node.name}_cast_fp32_data"
            cast_updates_name = f"{node.name}_cast_fp32_updates"
            cast_out_name = f"{node.name}_cast_fp32_out"

            # Cast fp16 → fp32 (在 data 输入前)
            cast_data_to_fp32 = helper.make_node(
                "Cast",
                inputs=[data_input],
                outputs=[cast_data_name],
                name=f"{node.name}_CastDataToFP32",
                to=TensorProto.FLOAT,
            )

            # Cast fp16 → fp32 (在 updates 输入前)
            cast_updates_to_fp32 = helper.make_node(
                "Cast",
                inputs=[updates_input],
                outputs=[cast_updates_name],
                name=f"{node.name}_CastUpdatesToFP32",
                to=TensorProto.FLOAT,
            )

            # 修改 ScatterElements 节点的输入和输出
            node.input[0] = cast_data_name
            node.input[2] = cast_updates_name
            node.output[0] = cast_out_name

            # Cast fp32 → fp16 (在 ScatterElements 输出后)
            cast_to_fp16 = helper.make_node(
                "Cast",
                inputs=[cast_out_name],
                outputs=[output_name],
                name=f"{node.name}_CastToFP16",
                to=TensorProto.FLOAT16,
            )

            new_nodes.extend([cast_data_to_fp32, cast_updates_to_fp32, node, cast_to_fp16])
            logger.info(f"  插入 Cast: data={data_input}→fp32, updates={updates_input}→fp32, out→fp16→{output_name}")
        else:
            new_nodes.append(node)

    # 替换图中的节点
    while len(graph.node) > 0:
        graph.node.pop()
    for n in new_nodes:
        graph.node.append(n)

    # 保存
    logger.info(f"保存修复后的模型: {model_path}")
    onnx.save(model, str(model_path))
    del model

    size_mb = model_path.stat().st_size / (1024 * 1024)
    logger.info(f"修复后模型大小: {size_mb:.1f} MB")


def verify_model(model_path: Path):
    """验证 FP16 模型可以正常加载和推理。"""
    logger.info(f"验证模型: {model_path}")

    # 检查文件大小
    size_mb = model_path.stat().st_size / (1024 * 1024)
    logger.info(f"模型大小: {size_mb:.1f} MB")

    # 加载并验证 ONNX 模型结构
    logger.info("加载 ONNX 模型结构...")
    onnx_model = onnx.load(str(model_path))
    logger.info(f"模型输入: {[f'{inp.name} {inp.type}' for inp in onnx_model.graph.input]}")
    logger.info(f"模型输出: {[f'{outp.name} {outp.type}' for outp in onnx_model.graph.output]}")

    # 检查是否有 bool 类型节点（这是之前的问题根源）
    bool_tensors = []
    for node in onnx_model.graph.node:
        for attr in node.attribute:
            if attr.type == onnx.AttributeProto.TENSORS:
                for t in attr.tensors:
                    if t.data_type == onnx.TensorProto.BOOL:
                        bool_tensors.append(f"{node.name}/{attr.name}")
    if bool_tensors:
        logger.warning(f"发现 bool 类型张量: {bool_tensors}")
    else:
        logger.info("未发现 bool 类型张量（正常）")

    del onnx_model

    # 使用 ONNX Runtime 进行推理测试
    logger.info("使用 ONNX Runtime 进行推理测试...")
    session = ort.InferenceSession(
        str(model_path),
        providers=["CPUExecutionProvider"]
    )

    # 打印输入输出信息
    for inp in session.get_inputs():
        logger.info(f"  输入: {inp.name}, shape={inp.shape}, type={inp.type}")
    for outp in session.get_outputs():
        logger.info(f"  输出: {outp.name}, shape={outp.shape}, type={outp.type}")

    # 构造测试输入
    # wav (1, 512000) float16, pitch (1, 4000) int64, uv (1, 4000) int64, word_bd (1, 4000) int64
    # pitch 值必须在 [0, 299] 范围内（Gather 节点索引限制）
    wav = np.random.randn(1, 512000).astype(np.float16)
    pitch = np.random.randint(0, 300, (1, 4000)).astype(np.int64)
    uv = np.random.randint(0, 2, (1, 4000)).astype(np.int64)
    word_bd = np.random.randint(0, 2, (1, 4000)).astype(np.int64)

    input_feed = {
        "wav": wav,
        "pitch": pitch,
        "uv": uv,
        "word_bd": word_bd,
    }

    logger.info("开始推理...")
    outputs = session.run(None, input_feed)

    for i, outp in enumerate(session.get_outputs()):
        logger.info(f"  输出[{i}] {outp.name}: shape={outputs[i].shape}, dtype={outputs[i].dtype}")

    logger.info("推理验证成功！")
    return True


def main():
    logger.info("=" * 60)
    logger.info("修复 FP16 rosvot_model.onnx")
    logger.info("=" * 60)

    # 检查 FP32 源模型
    if not FP32_MODEL.exists():
        logger.error(f"FP32 模型不存在: {FP32_MODEL}")
        return
    fp32_size = FP32_MODEL.stat().st_size / (1024 * 1024)
    logger.info(f"FP32 源模型: {FP32_MODEL} ({fp32_size:.1f} MB)")

    # 临时工作目录
    work_dir = BASE_DIR / "_fp16_work"
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        # 步骤1-3: FP16 转换
        if FP16_MODEL.exists():
            fp16_size_existing = FP16_MODEL.stat().st_size / (1024 * 1024)
            logger.info(f"FP16 模型已存在: {fp16_size_existing:.1f} MB，跳过转换")
        else:
            convert_fp16(FP32_MODEL, FP16_MODEL, work_dir)

        # 步骤4: 修复 ScatterElements 兼容性
        fix_scatter_elements_fp16(FP16_MODEL)

        # 步骤5: 验证
        verify_model(FP16_MODEL)

    finally:
        # 清理临时工作目录
        if work_dir.exists():
            shutil.rmtree(work_dir)
            logger.info("临时工作目录已清理")

    # 输出最终大小
    fp16_size = FP16_MODEL.stat().st_size / (1024 * 1024)
    logger.info(f"\n转换结果: FP32 {fp32_size:.1f} MB -> FP16 {fp16_size:.1f} MB (压缩率 {fp16_size/fp32_size:.1%})")
    logger.info("完成！")


if __name__ == "__main__":
    main()
