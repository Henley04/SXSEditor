"""
用 olive-ai 将 onnx_models/fp16/JP/ 下的 4 个 FP32 ONNX 模型转换为 FP16。

olive 的 OnnxFloatToFloat16 内部调用 onnxruntime.transformers.OnnxModel
的 convert_float_to_float16，会同步更新 Cast 节点的 `to` 属性与
value_info 类型（修复 onnxconverter_common 的 bug）。

目标 Execution Provider: DmlExecutionProvider (DirectML)。
olive 的 AcceleratorSpec 设为 GPU + DML，转换时不做 op_block_list，
让 olive 完整转换所有节点（包括 Cast）；如某些 op 在 DML FP16 下不
稳定，可在 OP_BLOCK_LIST 中追加。

推理端 (OnnxSVSPipeline) 通过 probe 自动检测模型输入 dtype 并适配，
转换为 FP16 后推理端会自动用 float16 张量喂入，无需修改应用代码。
"""
import os
import shutil
import onnx

from olive.hardware.accelerator import AcceleratorSpec, Device
from olive.hardware.constants import ExecutionProvider
from olive.model import ONNXModelHandler
from olive.passes.onnx.float16_conversion import OnnxFloatToFloat16


JP_DIR = r'D:\Document\electron\SXSEditor\onnx_models\fp16\JP'
BACKUP_DIR = os.path.join(JP_DIR, '_fp32_backup')
FILES = [
    'note_text_encoder.onnx',
    'preflow.onnx',
    'cond_emb.onnx',
    'diff_step_dml.onnx',
]

# DML FP16 下需要保持 FP32 的算子（如有需要可追加）。
# 留空让 olive 完整转换所有节点，验证 Cast 是否被正确处理。
OP_BLOCK_LIST = None


def restore_fp32():
    """Step 1: 从备份恢复 FP32 原始模型"""
    print('=== Step 1: 从 _fp32_backup 恢复 FP32 原始模型 ===')
    for fname in FILES:
        backup = os.path.join(BACKUP_DIR, fname)
        target = os.path.join(JP_DIR, fname)
        if os.path.exists(backup):
            shutil.copy2(backup, target)
            sz = os.path.getsize(target) / 1024 / 1024
            print(f'  restored {fname}: {sz:.2f}MB (FP32)')
        else:
            raise FileNotFoundError(f'backup not found: {backup}')


def convert_one(fname, accelerator_spec):
    """用 olive OnnxFloatToFloat16 转换单个模型"""
    src = os.path.join(JP_DIR, fname)
    sz_before = os.path.getsize(src) / 1024 / 1024
    print(f'\n[CONVERT] {fname} ({sz_before:.2f}MB FP32) -> FP16')

    input_model = ONNXModelHandler(model_path=src)

    user_config = {}
    if OP_BLOCK_LIST:
        user_config['op_block_list'] = OP_BLOCK_LIST

    config = OnnxFloatToFloat16.generate_config(
        accelerator_spec,
        config=user_config,
        disable_search=True,
    )

    fp16_pass = OnnxFloatToFloat16(accelerator_spec, config)

    # 输出路径：临时文件，转换成功后覆盖原文件
    tmp_out = src + '.fp16.onnx'
    if os.path.exists(tmp_out):
        os.remove(tmp_out)

    output_model = fp16_pass.run(input_model, tmp_out)

    # olive 输出可能在 tmp_out 或带后缀的路径上
    out_path = output_model.model_path
    if not os.path.exists(out_path):
        # 兜底：尝试 tmp_out
        out_path = tmp_out
    if not os.path.exists(out_path):
        raise RuntimeError(f'olive output not found: {out_path}')

    shutil.move(out_path, src)
    # 清理可能的临时残留
    if os.path.exists(tmp_out) and tmp_out != src:
        os.remove(tmp_out)

    sz_after = os.path.getsize(src) / 1024 / 1024
    print(f'  done: {sz_after:.2f}MB (ratio {sz_before / sz_after:.2f}x)')


def verify_one(fname):
    """验证转换结果：输入类型 + Cast 节点一致性"""
    src = os.path.join(JP_DIR, fname)
    print(f'\n[VERIFY] {fname}')
    model = onnx.load(src, load_external_data=False)

    input_types = [inp.type.tensor_type.elem_type for inp in model.graph.input]
    output_types = [out.type.tensor_type.elem_type for out in model.graph.output]
    print(f'  input  elem_type: {input_types} (1=FP32, 7=INT64, 10=FP16)')
    print(f'  output elem_type: {output_types}')

    # 检查所有 Cast 节点的 to 属性与输出 value_info 是否一致
    # 这是之前 onnxconverter_common 出问题的地方
    value_info_map = {}
    for vi in list(model.graph.value_info) + list(model.graph.output):
        if vi.name:
            value_info_map[vi.name] = vi.type.tensor_type.elem_type

    conflicts = 0
    cast_count = 0
    for node in model.graph.node:
        if node.op_type == 'Cast':
            cast_count += 1
            to_attr = None
            for attr in node.attribute:
                if attr.name == 'to':
                    to_attr = attr.i
            if to_attr is None:
                continue
            for out_name in node.output:
                actual = value_info_map.get(out_name)
                if actual is not None and actual != to_attr:
                    conflicts += 1
                    print(f'    [CONFLICT] Cast node {node.name} -> {out_name}: '
                          f'to={to_attr}, value_info={actual}')
    print(f'  Cast nodes: {cast_count}, conflicts: {conflicts}')
    return conflicts == 0


def main():
    # DML 加速器规格
    accelerator_spec = AcceleratorSpec(
        accelerator_type=Device.GPU,
        execution_provider=ExecutionProvider.DmlExecutionProvider,
    )
    print(f'AcceleratorSpec: {accelerator_spec.accelerator_type} / '
          f'{accelerator_spec.execution_provider}')

    restore_fp32()

    print()
    print('=== Step 2: 用 olive OnnxFloatToFloat16 转换 FP32 -> FP16 ===')
    for fname in FILES:
        convert_one(fname, accelerator_spec)

    print()
    print('=== Step 3: 验证转换结果 ===')
    all_ok = True
    for fname in FILES:
        ok = verify_one(fname)
        all_ok = all_ok and ok

    print()
    print('=== Summary ===')
    print(f'{"file":<28} {"size":>10}  cast_ok')
    for fname in FILES:
        p = os.path.join(JP_DIR, fname)
        sz = os.path.getsize(p) / 1024 / 1024 if os.path.exists(p) else 0
        print(f'{fname:<28} {sz:>8.2f}MB')

    print()
    if all_ok:
        print('ALL PASS: Cast 节点类型一致性检查通过，DML 兼容。')
    else:
        print('FAIL: 仍有 Cast 节点冲突，需要加 op_block_list 重试。')


if __name__ == '__main__':
    main()
