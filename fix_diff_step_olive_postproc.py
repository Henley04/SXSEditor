# -*- coding: utf-8 -*-
"""Re-generate diff_step_dml W16A32 and TrueFP16 with FULL Olive optimization
+ post-process to fix type mismatches caused by onnxscript_optimize.

Root cause: onnxscript_optimize removes Cast(FP16->FP32) nodes from W16A32
models, treating them as redundant Identity-like ops, but does NOT update
the weight initializer dtype. This leaves MatMul with FP32 activation + FP16
weight, causing "Type parameter (T) bound to different type" on load.

Fix strategy: Run COMPLETE Olive optimization (all passes enabled), then
post-process the optimized model to re-insert Cast nodes wherever MatMul/Gemm/
Conv has mismatched FP32/FP16 input types. This preserves all Olive benefits
(node fusion, dead code elimination, reshape fusion, etc.) while restoring
type safety.

For W16A32: insert Cast(FP16->FP32) before FP16 weight, so activation (FP32)
and weight (via Cast -> FP32) match.

For TrueFP16: insert Cast(FP32->FP16) before FP32 activation (or weight), so
both inputs are FP16. Alternatively convert the FP32 initializer to FP16.
We prefer converting the lone FP32 initializer to FP16 when it's a weight,
and inserting Cast when it's an activation.

Output:
  onnx_models/fp16_w16a32/diff_step_dml.onnx  (full Olive + post-fix)
  onnx_models/fp16_true/diff_step_dml.onnx    (full Olive + post-fix)
"""
import os
import sys
import shutil
import logging
import numpy as np
import onnx
from onnx import numpy_helper, helper, TensorProto, shape_inference

os.environ['ORT_LOGGING_LEVEL'] = '3'
os.environ['ONNXRUNTIME_LOGGING_LEVEL'] = '3'
os.environ['SKIP_ROPE_PRECOMPUTE'] = '1'

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FP32_DIR = os.path.join(SCRIPT_DIR, 'onnx_models')
W16A32_DIR = os.path.join(FP32_DIR, 'fp16_w16a32')
TRUEFP16_DIR = os.path.join(FP32_DIR, 'fp16_true')

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

OPS_WITH_WEIGHTS = {'MatMul', 'Gemm', 'Conv', 'ConvTranspose'}

# Inlined resolve_neg1_in_reshape_shapes (avoid heavy imports)
try:
    import sympy
    HAS_SYMPY = True
except ImportError:
    HAS_SYMPY = False


def resolve_neg1_in_reshape_shapes(model):
    """Replace -1 in Reshape shape Concat with computed static value."""
    if not HAS_SYMPY:
        logger.info("  resolve_neg1: sympy not available, skipping")
        return model

    graph = model.graph
    vi_map = {vi.name: vi for vi in graph.value_info}
    for vi in graph.input:
        vi_map[vi.name] = vi
    for vi in graph.output:
        vi_map[vi.name] = vi
    init_map = {init.name: init for init in graph.initializer}

    def get_shape(vi_name):
        if vi_name not in vi_map:
            return None
        t = vi_map[vi_name].type.tensor_type
        if t.elem_type == 0:
            return None
        dims = []
        for d in t.shape.dim:
            if d.dim_value:
                dims.append(d.dim_value)
            elif d.dim_param:
                dims.append(d.dim_param)
            else:
                dims.append(None)
        return dims

    def get_shape_node_dim(shape_node):
        x_name = shape_node.input[0]
        x_shape = get_shape(x_name)
        if x_shape is None:
            return None
        start = 0
        end = len(x_shape)
        for attr in shape_node.attribute:
            if attr.name == 'start':
                start = attr.i
            elif attr.name == 'end':
                end = attr.i
        if end - start != 1:
            return None
        idx = start if start >= 0 else start + len(x_shape)
        if 0 <= idx < len(x_shape):
            return x_shape[idx]
        return None

    shape_nodes = {}
    for node in graph.node:
        if node.op_type == 'Shape':
            shape_nodes[node.output[0]] = node

    symbol_map = {}

    def get_symbol(name):
        if name not in symbol_map:
            symbol_map[name] = sympy.Symbol(name)
        return symbol_map[name]

    resolved = 0
    node_list_snapshot = list(graph.node)
    for node in node_list_snapshot:
        if node.op_type != 'Reshape' or len(node.input) < 2:
            continue
        shape_input = node.input[1]
        data_input = node.input[0]
        concat_node = None
        for n2 in node_list_snapshot:
            if n2.op_type == 'Concat' and shape_input in n2.output:
                concat_node = n2
                break
        if concat_node is None:
            continue
        neg1_init_name = None
        for inp in concat_node.input:
            if inp in init_map:
                arr = numpy_helper.to_array(init_map[inp])
                if arr.size == 1 and arr.item() == -1:
                    neg1_init_name = inp
                    break
        if neg1_init_name is None:
            continue
        data_shape = get_shape(data_input)
        if data_shape is None:
            continue
        total = sympy.Integer(1)
        for dim in data_shape:
            if isinstance(dim, int):
                total *= dim
            elif isinstance(dim, str):
                total *= get_symbol(dim)
            else:
                total = None
                break
        if total is None:
            continue
        known_prod = sympy.Integer(1)
        for inp in concat_node.input:
            if inp == neg1_init_name:
                continue
            if inp in init_map:
                arr = numpy_helper.to_array(init_map[inp])
                if arr.size == 1:
                    known_prod *= int(arr.item())
                else:
                    known_prod = None
                    break
            elif inp in shape_nodes:
                dim = get_shape_node_dim(shape_nodes[inp])
                if dim is None:
                    known_prod = None
                    break
                if isinstance(dim, int):
                    known_prod *= dim
                elif isinstance(dim, str):
                    known_prod *= get_symbol(dim)
                else:
                    known_prod = None
                    break
            else:
                known_prod = None
                break
        if known_prod is None:
            continue
        neg1_val = sympy.simplify(total / known_prod)
        if not neg1_val.is_Integer:
            continue
        neg1_int = int(neg1_val)
        new_init_name = f"{neg1_init_name}_resolved_{neg1_int}"
        new_arr = np.array([neg1_int], dtype=np.int64)
        new_init = numpy_helper.from_array(new_arr, name=new_init_name)
        graph.initializer.append(new_init)
        for i, inp in enumerate(concat_node.input):
            if inp == neg1_init_name:
                concat_node.input[i] = new_init_name
                break
        resolved += 1

    if resolved:
        logger.info(f"  resolve_neg1: resolved {resolved} -1 values in Reshape shapes")
    return model


def build_type_map(model):
    """Build comprehensive name -> elem_type map from value_info, inputs, outputs, initializers."""
    type_map = {}
    graph = model.graph
    for vi in graph.value_info:
        type_map[vi.name] = vi.type.tensor_type.elem_type
    for inp in graph.input:
        type_map[inp.name] = inp.type.tensor_type.elem_type
    for out in graph.output:
        type_map[out.name] = out.type.tensor_type.elem_type
    for init in graph.initializer:
        type_map[init.name] = init.data_type
    return type_map


def fix_type_mismatches_w16a32(model):
    """Post-process: re-insert Cast(FP16->FP32) nodes where onnxscript removed them.

    For W16A32, weights are FP16 and activations should be FP32. When
    onnxscript_optimize removes the Cast(FP16->FP32) before a MatMul/Gemm/Conv,
    the weight (FP16) directly feeds the op alongside an FP32 activation,
    causing a type mismatch. We re-insert the Cast node.

    Strategy: For each MatMul/Gemm/Conv with mismatched FP32/FP16 inputs:
      - If the FP16 input is an initializer (weight), insert Cast(FP16->FP32)
        and redirect the op to use the Cast output.
      - If the FP16 input is NOT an initializer (it's an activation), we have
        an unexpected situation - log a warning.
    """
    graph = model.graph
    type_map = build_type_map(model)
    init_map = {init.name: init for init in graph.initializer}

    fixes = 0
    new_nodes = []
    new_initializers = []

    for node in graph.node:
        if node.op_type not in OPS_WITH_WEIGHTS:
            new_nodes.append(node)
            continue
        if len(node.input) < 2:
            new_nodes.append(node)
            continue

        # Check types of inputs 0 (activation) and 1 (weight)
        a_name = node.input[0]
        b_name = node.input[1]
        a_type = type_map.get(a_name)
        b_type = type_map.get(b_name)

        if a_type is None or b_type is None:
            new_nodes.append(node)
            continue

        # Only handle FP32 vs FP16 mismatches
        if a_type == TensorProto.FLOAT and b_type == TensorProto.FLOAT16:
            # Activation is FP32, weight is FP16 -> insert Cast(FP16->FP32) on weight
            if b_name in init_map:
                cast_output = f"{b_name}_postcast_fp32"
                cast_node = helper.make_node(
                    'Cast', [b_name], [cast_output],
                    name=f"{node.name}_postcast",
                    to=TensorProto.FLOAT,
                )
                new_nodes.append(cast_node)
                node.input[1] = cast_output
                fixes += 1
                # Update type_map so downstream checks see FP32
                type_map[cast_output] = TensorProto.FLOAT
            else:
                logger.warning(f"  W16A32 fix: {node.name} weight {b_name} is FP16 but not initializer (activation?)")
        elif a_type == TensorProto.FLOAT16 and b_type == TensorProto.FLOAT:
            # Activation is FP16, weight is FP32 - shouldn't happen in W16A32
            # but handle it: insert Cast(FP16->FP32) on activation
            cast_output = f"{a_name}_postcast_fp32"
            cast_node = helper.make_node(
                'Cast', [a_name], [cast_output],
                name=f"{node.name}_postcast_a",
                to=TensorProto.FLOAT,
            )
            new_nodes.append(cast_node)
            node.input[0] = cast_output
            fixes += 1
            type_map[cast_output] = TensorProto.FLOAT

        new_nodes.append(node)

    # Replace graph nodes
    del graph.node[:]
    graph.node.extend(new_nodes)

    logger.info(f"  W16A32 post-fix: inserted {fixes} Cast(FP16->FP32) nodes")
    return model, fixes


def fix_type_mismatches_truefp16(model):
    """Post-process: fix type mismatches in TrueFP16 models.

    For TrueFP16, everything should be FP16. When a Cast(INT64->FP32) feeds
    a MatMul expecting FP16, we have a mismatch.

    Strategy:
      - If the FP32 input is an initializer (weight), convert it to FP16
        (smaller, no Cast needed).
      - If the FP32 input comes from a Cast(INT64->FP32), change the Cast
        'to' attribute to FP16 (INT64->FP16).
      - Otherwise, insert Cast(FP32->FP16).
    """
    graph = model.graph
    type_map = build_type_map(model)
    init_map = {init.name: init for init in graph.initializer}

    # First pass: find Cast(INT64->FP32) nodes and change them to Cast(INT64->FP16)
    cast_fixes = 0
    cast_producers = {}  # output_name -> cast_node
    for node in graph.node:
        if node.op_type == 'Cast':
            cast_producers[node.output[0]] = node

    # Build value_info map for type updates (name -> ValueInfoProto)
    vi_by_name = {vi.name: vi for vi in graph.value_info}

    def update_value_info_type(name, new_elem_type):
        """Update the elem_type of a value_info entry if it exists."""
        if name in vi_by_name:
            vi_by_name[name].type.tensor_type.elem_type = new_elem_type

    # Fix Cast(INT64->FP32) -> Cast(INT64->FP16) when output feeds FP16 ops
    for node in graph.node:
        if node.op_type != 'Cast':
            continue
        input_type = type_map.get(node.input[0])
        to_type = None
        for attr in node.attribute:
            if attr.name == 'to':
                to_type = attr.i
        if input_type == TensorProto.INT64 and to_type == TensorProto.FLOAT:
            # Change to INT64->FP16
            for attr in node.attribute:
                if attr.name == 'to':
                    attr.i = TensorProto.FLOAT16
                    break
            type_map[node.output[0]] = TensorProto.FLOAT16
            # CRITICAL: update value_info to match the new Cast output type
            update_value_info_type(node.output[0], TensorProto.FLOAT16)
            cast_fixes += 1
            logger.info(f"  TrueFP16 fix: Cast(INT64->FP32) -> Cast(INT64->FP16): {node.name}")

    # Second pass: fix remaining FP32/FP16 mismatches in MatMul/Gemm/Conv
    insert_fixes = 0
    convert_fixes = 0
    new_nodes = []

    for node in graph.node:
        if node.op_type not in OPS_WITH_WEIGHTS:
            new_nodes.append(node)
            continue
        if len(node.input) < 2:
            new_nodes.append(node)
            continue

        a_name = node.input[0]
        b_name = node.input[1]
        a_type = type_map.get(a_name)
        b_type = type_map.get(b_name)

        if a_type is None or b_type is None:
            new_nodes.append(node)
            continue

        if a_type == b_type:
            new_nodes.append(node)
            continue

        # Mismatch detected
        if a_type == TensorProto.FLOAT16 and b_type == TensorProto.FLOAT:
            # Activation FP16, weight FP32 -> convert weight initializer to FP16
            if b_name in init_map:
                init = init_map[b_name]
                arr = numpy_helper.to_array(init)
                arr_fp16 = arr.astype(np.float16)
                new_init = numpy_helper.from_array(arr_fp16, name=b_name)
                init.CopyFrom(new_init)
                type_map[b_name] = TensorProto.FLOAT16
                # Update value_info to match new initializer type
                update_value_info_type(b_name, TensorProto.FLOAT16)
                convert_fixes += 1
            else:
                # Insert Cast(FP32->FP16)
                cast_output = f"{b_name}_cast_fp16"
                cast_node = helper.make_node(
                    'Cast', [b_name], [cast_output],
                    name=f"{node.name}_cast_b_fp16",
                    to=TensorProto.FLOAT16,
                )
                new_nodes.append(cast_node)
                node.input[1] = cast_output
                type_map[cast_output] = TensorProto.FLOAT16
                insert_fixes += 1
        elif a_type == TensorProto.FLOAT and b_type == TensorProto.FLOAT16:
            # Activation FP32, weight FP16 -> insert Cast(FP32->FP16) on activation
            cast_output = f"{a_name}_cast_fp16"
            cast_node = helper.make_node(
                'Cast', [a_name], [cast_output],
                name=f"{node.name}_cast_a_fp16",
                to=TensorProto.FLOAT16,
            )
            new_nodes.append(cast_node)
            node.input[0] = cast_output
            type_map[cast_output] = TensorProto.FLOAT16
            insert_fixes += 1

        new_nodes.append(node)

    del graph.node[:]
    graph.node.extend(new_nodes)

    logger.info(f"  TrueFP16 post-fix: {cast_fixes} Cast attrs fixed, "
                f"{convert_fixes} initializers converted to FP16, "
                f"{insert_fixes} Cast(FP32->FP16) inserted")
    return model, cast_fixes + convert_fixes + insert_fixes


def save_model_external(model, output_path):
    """Save model with external data format."""
    if os.path.exists(output_path):
        os.remove(output_path)
    data_path = output_path + '.data'
    if os.path.exists(data_path):
        os.remove(data_path)
    onnx.save_model(
        model, output_path,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=os.path.basename(output_path) + '.data',
        size_threshold=1024,
    )
    size_mb = os.path.getsize(output_path) / 1024 / 1024
    data_mb = os.path.getsize(data_path) / 1024 / 1024 if os.path.exists(data_path) else 0
    logger.info(f"  Saved: {output_path} ({size_mb:.1f}MB + {data_mb:.1f}MB data)")


# ============================================================
# W16A32 with FULL Olive + post-fix
# ============================================================

def generate_w16a32_with_olive():
    """Generate W16A32 diff_step_dml with full Olive optimization + post-fix."""
    logger.info("=" * 60)
    logger.info("W16A32 diff_step_dml: FULL Olive + post-fix")
    logger.info("=" * 60)

    from olive.hardware.accelerator import AcceleratorSpec, Device
    from olive.hardware.constants import ExecutionProvider
    from olive.model import ONNXModelHandler
    from olive.passes.onnx.quantization import OnnxQuantizationPreprocess
    from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer

    accel_spec = AcceleratorSpec(
        accelerator_type=Device.GPU,
        execution_provider=ExecutionProvider.DmlExecutionProvider,
    )

    work_dir = os.path.join(SCRIPT_DIR, 'w16a32_olive_work')
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(work_dir)

    fp32_path = os.path.join(FP32_DIR, 'diff_step_dml.onnx')
    w16a32_pre_olive = os.path.join(work_dir, 'diff_step_dml_w16a32_pre_olive.onnx')
    output_path = os.path.join(W16A32_DIR, 'diff_step_dml.onnx')

    # Step 1: Generate W16A32 (FP16 weights + Cast)
    logger.info("Step 1: Generate W16A32 model")
    model = onnx.load(fp32_path, load_external_data=True)
    graph = model.graph

    weight_names = set()
    for node in graph.node:
        if node.op_type in OPS_WITH_WEIGHTS and len(node.input) >= 2:
            weight_names.add(node.input[1])

    init_map = {init.name: init for init in graph.initializer}
    converted = 0
    for name in weight_names:
        if name in init_map:
            init = init_map[name]
            if init.data_type == TensorProto.FLOAT:
                arr = numpy_helper.to_array(init)
                if arr.size < 100:
                    continue
                arr_fp16 = arr.astype(np.float16)
                new_init = numpy_helper.from_array(arr_fp16, name=name)
                init.CopyFrom(new_init)
                converted += 1
    logger.info(f"  Converted {converted} weights to FP16")

    cast_insertions = 0
    new_node_list = []
    for node in graph.node:
        if node.op_type in OPS_WITH_WEIGHTS and len(node.input) >= 2:
            weight_name = node.input[1]
            if weight_name in init_map:
                init = init_map[weight_name]
                if init.data_type == TensorProto.FLOAT16:
                    cast_output = f"{weight_name}_w16a32_cast"
                    cast_node = helper.make_node(
                        'Cast', [weight_name], [cast_output],
                        name=f"{node.name}_w16a32_cast",
                        to=TensorProto.FLOAT,
                    )
                    new_node_list.append(cast_node)
                    node.input[1] = cast_output
                    cast_insertions += 1
        new_node_list.append(node)
    del graph.node[:]
    graph.node.extend(new_node_list)
    logger.info(f"  Inserted {cast_insertions} Cast(FP16->FP32)")

    save_model_external(model, w16a32_pre_olive)
    del model

    # Step 2: OnnxQuantizationPreprocess (may fail for mixed types, that's OK)
    logger.info("Step 2: OnnxQuantizationPreprocess")
    preprocess_dir = os.path.join(work_dir, 'preprocessed')
    preprocess_config = OnnxQuantizationPreprocess.generate_config(
        accel_spec, {"skip_symbolic_shape": True}
    )
    preprocess_pass = OnnxQuantizationPreprocess(accel_spec, preprocess_config)
    model_handler = ONNXModelHandler(model_path=w16a32_pre_olive)
    try:
        model_handler = preprocess_pass.run(model_handler, preprocess_dir)
        logger.info(f"  OnnxQuantizationPreprocess: OK")
        input_for_peephole = model_handler.model_path
    except Exception as e:
        err_str = str(e)
        if 'TypeInferenceError' in err_str or 'Inferred elem type' in err_str:
            logger.warning(f"  OnnxQuantizationPreprocess failed (expected for W16A32 mixed types)")
            input_for_peephole = w16a32_pre_olive
        else:
            raise

    # Step 3: OnnxPeepholeOptimizer (ALL optimizations enabled)
    logger.info("Step 3: OnnxPeepholeOptimizer (ALL optimizations enabled)")
    peephole_dir = os.path.join(work_dir, 'peephole')
    peephole_config = OnnxPeepholeOptimizer.generate_config(
        accel_spec,
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
    peephole_pass = OnnxPeepholeOptimizer(accel_spec, peephole_config)
    model_handler = ONNXModelHandler(model_path=input_for_peephole)
    model_handler = peephole_pass.run(model_handler, peephole_dir)
    logger.info(f"  OnnxPeepholeOptimizer: OK -> {model_handler.model_path}")

    # Step 4: Load optimized model + post-fix type mismatches
    logger.info("Step 4: Post-fix type mismatches (re-insert deleted Casts)")
    final_model = onnx.load(str(model_handler.model_path), load_external_data=True)

    # Run shape inference (best effort, may fail on mixed types)
    try:
        final_model = shape_inference.infer_shapes(final_model)
    except Exception as e:
        logger.warning(f"  shape_inference failed (expected): {str(e)[:100]}")

    # Fix type mismatches
    final_model, fixes = fix_type_mismatches_w16a32(final_model)

    # Step 5: resolve_neg1
    logger.info("Step 5: resolve_neg1_in_reshape_shapes")
    final_model = resolve_neg1_in_reshape_shapes(final_model)

    # Step 6: Save
    save_model_external(final_model, output_path)
    del final_model

    # Cleanup
    shutil.rmtree(work_dir, ignore_errors=True)

    logger.info(f"  W16A32 complete: {converted} weights, {cast_insertions} initial Casts, "
                f"{fixes} post-fix Casts")
    return converted, cast_insertions, fixes


# ============================================================
# TrueFP16 with FULL Olive + post-fix
# ============================================================

def generate_truefp16_with_olive():
    """Generate TrueFP16 diff_step_dml with full Olive optimization + post-fix."""
    logger.info("=" * 60)
    logger.info("TrueFP16 diff_step_dml: FULL Olive + post-fix")
    logger.info("=" * 60)

    from onnxconverter_common.float16 import convert_float_to_float16
    from olive.hardware.accelerator import AcceleratorSpec, Device
    from olive.hardware.constants import ExecutionProvider
    from olive.model import ONNXModelHandler
    from olive.passes.onnx.quantization import OnnxQuantizationPreprocess
    from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer

    accel_spec = AcceleratorSpec(
        accelerator_type=Device.GPU,
        execution_provider=ExecutionProvider.DmlExecutionProvider,
    )

    work_dir = os.path.join(SCRIPT_DIR, 'truefp16_olive_work')
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(work_dir)

    fp32_path = os.path.join(FP32_DIR, 'diff_step_dml.onnx')
    truefp16_pre_olive = os.path.join(work_dir, 'diff_step_dml_truefp16_pre_olive.onnx')
    output_path = os.path.join(TRUEFP16_DIR, 'diff_step_dml.onnx')

    # Step 1: Convert to TrueFP16 using onnxconverter_common
    logger.info("Step 1: Convert to TrueFP16")
    model = onnx.load(fp32_path, load_external_data=True)
    model_fp16 = convert_float_to_float16(
        model, keep_io_types=True,
        op_block_list=[], node_block_list=[],
        disable_shape_infer=False,
    )
    save_model_external(model_fp16, truefp16_pre_olive)
    del model, model_fp16

    # Step 2: OnnxQuantizationPreprocess
    logger.info("Step 2: OnnxQuantizationPreprocess")
    preprocess_dir = os.path.join(work_dir, 'preprocessed')
    preprocess_config = OnnxQuantizationPreprocess.generate_config(
        accel_spec, {"skip_symbolic_shape": True}
    )
    preprocess_pass = OnnxQuantizationPreprocess(accel_spec, preprocess_config)
    model_handler = ONNXModelHandler(model_path=truefp16_pre_olive)
    try:
        model_handler = preprocess_pass.run(model_handler, preprocess_dir)
        logger.info(f"  OnnxQuantizationPreprocess: OK")
        input_for_peephole = model_handler.model_path
    except Exception as e:
        err_str = str(e)
        if 'TypeInferenceError' in err_str or 'Inferred elem type' in err_str:
            logger.warning(f"  OnnxQuantizationPreprocess failed (expected for mixed types)")
            input_for_peephole = truefp16_pre_olive
        else:
            raise

    # Step 3: OnnxPeepholeOptimizer (ALL optimizations enabled)
    logger.info("Step 3: OnnxPeepholeOptimizer (ALL optimizations enabled)")
    peephole_dir = os.path.join(work_dir, 'peephole')
    peephole_config = OnnxPeepholeOptimizer.generate_config(
        accel_spec,
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
    peephole_pass = OnnxPeepholeOptimizer(accel_spec, peephole_config)
    model_handler = ONNXModelHandler(model_path=input_for_peephole)
    model_handler = peephole_pass.run(model_handler, peephole_dir)
    logger.info(f"  OnnxPeepholeOptimizer: OK -> {model_handler.model_path}")

    # Step 4: Load optimized model + post-fix type mismatches
    logger.info("Step 4: Post-fix type mismatches")
    final_model = onnx.load(str(model_handler.model_path), load_external_data=True)

    try:
        final_model = shape_inference.infer_shapes(final_model)
    except Exception as e:
        logger.warning(f"  shape_inference failed (may be OK): {str(e)[:100]}")

    final_model, fixes = fix_type_mismatches_truefp16(final_model)

    # Step 5: resolve_neg1
    logger.info("Step 5: resolve_neg1_in_reshape_shapes")
    final_model = resolve_neg1_in_reshape_shapes(final_model)

    # Step 6: Save
    save_model_external(final_model, output_path)
    del final_model

    shutil.rmtree(work_dir, ignore_errors=True)

    logger.info(f"  TrueFP16 complete: {fixes} post-fixes applied")
    return fixes


# ============================================================
# Main
# ============================================================

if __name__ == '__main__':
    # W16A32
    converted, casts, post_fixes = generate_w16a32_with_olive()

    # TrueFP16
    true_fixes = generate_truefp16_with_olive()

    print(f"\n{'='*60}")
    print("COMPLETE: Full Olive + Post-fix")
    print(f"{'='*60}")
    print(f"  W16A32:  {converted} weights FP16, {casts} initial Casts, "
          f"{post_fixes} post-fix Casts (Olive deleted them, we restored)")
    print(f"  TrueFP16: {true_fixes} post-fixes applied")
