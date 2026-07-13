# -*- coding: utf-8 -*-
"""Convert all 9 FP32 ONNX models to W16A32 (FP16 weights, FP32 activations).

W16A32 = weights stored as FP16 (50% size reduction), activations computed as FP32
(no precision loss). A Cast(FP16->FP32) node is inserted before each weight-using op.

This script operates directly on the existing FP32 opset 20 ONNX models (already
dynamo-exported), which is equivalent to the PyTorch weight conversion + dynamo
export path but much faster (avoids loading the 2.7GB PyTorch checkpoint).

Pipeline per model:
  1. Load FP32 opset 20 ONNX
  2. Convert weight initializers (MatMul/Gemm/Conv) to FP16
  3. Insert Cast(FP16->FP32) nodes
  4. Save with external data format
  5. Apply Olive DML optimization (OnnxQuantizationPreprocess + OnnxPeepholeOptimizer)

Output: onnx_models/fp16_w16a32/<model_name>.onnx (+ .onnx.data)
"""
import os
import sys
import gc
import json
import shutil
import logging
import time
import numpy as np
import onnx
from onnx import numpy_helper, helper, TensorProto, shape_inference

# Suppress ONNX Runtime warnings
os.environ['ORT_LOGGING_LEVEL'] = '3'
os.environ['ONNXRUNTIME_LOGGING_LEVEL'] = '3'

# Skip RoPE precomputation patches (consistent with other olive scripts)
os.environ['SKIP_ROPE_PRECOMPUTE'] = '1'

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FP32_DIR = os.path.join(SCRIPT_DIR, 'onnx_models')
OUTPUT_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'fp16_w16a32')

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# Inline resolve_neg1_in_reshape_shapes to avoid importing export_shared
# (which triggers heavy imports of transformers/torch/soulxsinger).
try:
    import sympy
    HAS_SYMPY = True
except ImportError:
    HAS_SYMPY = False


def resolve_neg1_in_reshape_shapes(model):
    """Replace -1 in Reshape shape Concat with computed static value.

    Dynamo export produces Concat([1, Shape(x)[start:end], -1, 64]) for Reshape.
    DML EP doesn't support -1 in shape tensor (returns E_INVALIDARG 0x80070057).
    Compute -1 statically using sympy to cancel dynamic dimensions.

    Only resolves when -1 simplifies to an integer (dynamic dims cancel out).
    """
    if not HAS_SYMPY:
        logger.info("  resolve_neg1: sympy not available, skipping")
        return model

    graph = model.graph

    # Build value_info map
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
        """For Shape(x) with start/end attrs, return the single dim of x[start]."""
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
            return None  # multi-element output, can't resolve to single dim
        idx = start if start >= 0 else start + len(x_shape)
        if 0 <= idx < len(x_shape):
            return x_shape[idx]
        return None

    # Find Shape producers: output_name -> shape_node
    shape_nodes = {}
    for node in graph.node:
        if node.op_type == 'Shape':
            shape_nodes[node.output[0]] = node

    # Symbol cache
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

        # Find Concat producing shape_input
        concat_node = None
        for n2 in node_list_snapshot:
            if n2.op_type == 'Concat' and shape_input in n2.output:
                concat_node = n2
                break
        if concat_node is None:
            continue

        # Check for [-1] in Concat inputs
        neg1_init_name = None
        for inp in concat_node.input:
            if inp in init_map:
                arr = numpy_helper.to_array(init_map[inp])
                if arr.size == 1 and arr.item() == -1:
                    neg1_init_name = inp
                    break
        if neg1_init_name is None:
            continue

        # Get Reshape input shape
        data_shape = get_shape(data_input)
        if data_shape is None:
            continue

        # Build sympy expression for total elements (Reshape preserves count)
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

        # Build sympy expression for Concat known dims (excluding -1)
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

        # Compute -1 = total / known_prod
        neg1_val = sympy.simplify(total / known_prod)
        if not neg1_val.is_Integer:
            logger.info(f"  resolve_neg1: cannot resolve to integer for {node.name}: {neg1_val}")
            continue

        neg1_int = int(neg1_val)

        # Create a NEW initializer for the resolved value, do NOT modify the
        # original [-1] initializer because it may be shared by other consumers
        # (e.g., ReduceMean with axes=[-1] meaning last axis).
        new_init_name = f"{neg1_init_name}_resolved_{neg1_int}"
        new_arr = np.array([neg1_int], dtype=np.int64)
        new_init = numpy_helper.from_array(new_arr, name=new_init_name)
        graph.initializer.append(new_init)
        # Update only this Concat's input to use the new initializer
        for i, inp in enumerate(concat_node.input):
            if inp == neg1_init_name:
                concat_node.input[i] = new_init_name
                break
        resolved += 1

    if resolved:
        logger.info(f"  resolve_neg1: resolved {resolved} -1 values in Reshape shapes")
    return model

# Models to convert (all 9)
MODELS = [
    'diff_step_dml',
    'vocoder_dml',
    'preflow',
    'cond_emb',
    'mel_transform',
    'note_text_encoder',
    'note_pitch_encoder',
    'note_type_encoder',
    'f0_encoder',
]

# Ops that use weight initializers
OPS_WITH_WEIGHTS = {'MatMul', 'Gemm', 'Conv', 'ConvTranspose'}


# ============================================================
# W16A32 conversion
# ============================================================

def convert_w16a32_model(input_path, output_path):
    """Convert FP32 ONNX model to W16A32 (FP16 weights + FP32 activations).

    Steps:
      1. Load FP32 model with external data
      2. Find weight initializers used by MatMul/Gemm/Conv nodes
      3. Convert those initializers to FP16
      4. Insert Cast(FP16->FP32) nodes before each weight-using op
      5. Save with external data format
    """
    logger.info(f"  Loading: {input_path}")
    model = onnx.load(input_path, load_external_data=True)
    graph = model.graph

    # Find weight initializers used by weight-using ops
    weight_names = set()
    for node in graph.node:
        if node.op_type in OPS_WITH_WEIGHTS:
            if len(node.input) >= 2:
                weight_names.add(node.input[1])

    logger.info(f"  Found {len(weight_names)} weight inputs in MatMul/Gemm/Conv nodes")

    # Convert weight initializers to FP16
    init_map = {init.name: init for init in graph.initializer}
    converted = 0
    for name in weight_names:
        if name in init_map:
            init = init_map[name]
            if init.data_type == TensorProto.FLOAT:
                arr = numpy_helper.to_array(init)
                # Skip very small initializers (e.g., shape tensors)
                if arr.size < 100:
                    continue
                arr_fp16 = arr.astype(np.float16)
                new_init = numpy_helper.from_array(arr_fp16, name=name)
                init.CopyFrom(new_init)
                converted += 1

    logger.info(f"  Converted {converted} weight initializers to FP16")

    if converted == 0:
        logger.info(f"  No weights to convert, saving as-is")
        # Still save with external data
        _save_with_external_data(model, output_path)
        del model
        return converted, 0

    # Insert Cast(FP16->FP32) nodes before weight inputs
    # Build the new node list with Cast nodes inserted before weight-using ops
    cast_insertions = 0
    new_node_list = []

    for node in graph.node:
        if node.op_type in OPS_WITH_WEIGHTS and len(node.input) >= 2:
            weight_name = node.input[1]
            if weight_name in init_map:
                init = init_map[weight_name]
                if init.data_type == TensorProto.FLOAT16:
                    # Create a Cast node for this weight
                    cast_output = f"{weight_name}_w16a32_cast"
                    cast_node = helper.make_node(
                        'Cast',
                        [weight_name],
                        [cast_output],
                        name=f"{node.name}_w16a32_cast",
                        to=TensorProto.FLOAT,
                    )
                    new_node_list.append(cast_node)
                    # Redirect the weight-using node to the Cast output
                    node.input[1] = cast_output
                    cast_insertions += 1
        new_node_list.append(node)

    del graph.node[:]
    graph.node.extend(new_node_list)

    logger.info(f"  Inserted {cast_insertions} Cast(FP16->FP32) nodes")

    # Save with external data format
    _save_with_external_data(model, output_path)
    del model

    return converted, cast_insertions


def _save_with_external_data(model, output_path):
    """Save model with external data format."""
    # Remove old files
    if os.path.exists(output_path):
        os.remove(output_path)
    data_path = output_path + '.data'
    if os.path.exists(data_path):
        os.remove(data_path)

    onnx.save_model(
        model,
        output_path,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=os.path.basename(output_path) + '.data',
        size_threshold=1024,
    )

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    data_mb = os.path.getsize(data_path) / 1024 / 1024 if os.path.exists(data_path) else 0
    logger.info(f"  Saved: {output_path} ({size_mb:.1f}MB + {data_mb:.1f}MB data)")


# ============================================================
# Olive DML optimization
# ============================================================

def apply_olive_dml_optimization(model_path):
    """Apply Olive DML optimization passes to a W16A32 model.

    Uses OnnxQuantizationPreprocess + OnnxPeepholeOptimizer (same as
    optimize_diff_step_olive.py but for W16A32 models).
    """
    try:
        from olive.hardware.accelerator import AcceleratorSpec, Device
        from olive.hardware.constants import ExecutionProvider
        from olive.model import ONNXModelHandler
        from olive.passes.onnx.quantization import OnnxQuantizationPreprocess
        from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer
    except ImportError as e:
        logger.warning(f"  Olive not available, skipping DML optimization: {e}")
        return False

    logger.info(f"  Applying Olive DML optimization...")

    accel_spec = AcceleratorSpec(
        accelerator_type=Device.GPU,
        execution_provider=ExecutionProvider.DmlExecutionProvider,
    )

    work_dir = model_path + '_olive_work'
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(work_dir)

    try:
        model = ONNXModelHandler(model_path=model_path)

        # Step 1: OnnxQuantizationPreprocess
        # NOTE: This step may fail for W16A32 models with shape inference errors
        # (mixed FP16/FP32 types). If it fails, skip and continue with peephole.
        preprocess_dir = os.path.join(work_dir, 'preprocessed')
        preprocess_config = OnnxQuantizationPreprocess.generate_config(
            accel_spec, {"skip_symbolic_shape": True}
        )
        preprocess_pass = OnnxQuantizationPreprocess(accel_spec, preprocess_config)
        try:
            model = preprocess_pass.run(model, preprocess_dir)
            logger.info(f"  OnnxQuantizationPreprocess completed")
        except Exception as e:
            err_str = str(e)
            if 'TypeInferenceError' in err_str or 'Inferred elem type' in err_str:
                logger.warning(f"  OnnxQuantizationPreprocess failed (shape inference on mixed FP16/FP32): {err_str[:120]}")
                logger.warning(f"  Skipping preprocess, continuing with PeepholeOptimizer + resolve_neg1")
                # Reset model to original path (preprocess didn't produce output)
                model = ONNXModelHandler(model_path=model_path)
            else:
                raise

        # Step 2: OnnxPeepholeOptimizer
        # NOTE: cast_chain_elimination is DISABLED for W16A32 because it removes
        # the Cast(FP16->FP32) nodes that are essential for W16A32 type safety.
        # Without these Cast nodes, MatMul receives FP16 weight + FP32 activation
        # causing "Type parameter (T) bound to different type" errors on load.
        peephole_dir = os.path.join(work_dir, 'peephole')
        peephole_config = OnnxPeepholeOptimizer.generate_config(
            accel_spec,
            {
                "onnxscript_optimize": True,
                "onnxoptimizer_optimize": True,
                "fuse_reshape_operations": True,
                "cast_chain_elimination": False,
                "save_as_external_data": True,
                "all_tensors_to_one_file": True,
                "size_threshold": 1024,
            },
        )
        peephole_pass = OnnxPeepholeOptimizer(accel_spec, peephole_config)
        model = peephole_pass.run(model, peephole_dir)
        logger.info(f"  OnnxPeepholeOptimizer completed")

        # Step 3: resolve_neg1_in_reshape_shapes (DML compat) - inlined to avoid
        # importing export_shared (which triggers heavy transformers/torch imports)
        final_path_pre = model.model_path
        pre_proto = onnx.load(str(final_path_pre), load_external_data=True)
        # Use shape_inference with strict_mode=False to handle mixed types
        try:
            pre_proto = shape_inference.infer_shapes(pre_proto)
        except Exception as e:
            logger.warning(f"  shape_inference failed (expected for W16A32 mixed types): {str(e)[:100]}")
        pre_proto = resolve_neg1_in_reshape_shapes(pre_proto)
        logger.info(f"  resolve_neg1_in_reshape_shapes completed")

        # Save final output with proper external data format
        if os.path.exists(model_path):
            os.remove(model_path)
        old_data = model_path + '.data'
        if os.path.exists(old_data):
            os.remove(old_data)

        onnx.save_model(
            pre_proto,
            str(model_path),
            save_as_external_data=True,
            all_tensors_to_one_file=True,
            location=os.path.basename(model_path) + '.data',
            size_threshold=1024,
        )
        logger.info(f"  Olive optimization saved to: {model_path}")

    except Exception as e:
        logger.error(f"  Olive optimization failed: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        if os.path.exists(work_dir):
            shutil.rmtree(work_dir)

    return True


# ============================================================
# Main
# ============================================================

def main():
    import argparse
    parser = argparse.ArgumentParser(
        description='Convert all 9 FP32 ONNX models to W16A32 (FP16 weights, FP32 activations)'
    )
    parser.add_argument('--fp32-dir', default=FP32_DIR,
                        help=f'FP32 models directory (default: {FP32_DIR})')
    parser.add_argument('--output-dir', default=OUTPUT_DIR,
                        help=f'Output directory (default: {OUTPUT_DIR})')
    parser.add_argument('--models', nargs='+', default=MODELS,
                        help='Models to convert (default: all 9)')
    parser.add_argument('--skip-olive', action='store_true',
                        help='Skip Olive DML optimization')
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    print("=" * 70)
    print("W16A32 Conversion Pipeline (FP16 weights, FP32 activations)")
    print(f"FP32 source: {args.fp32_dir}")
    print(f"Output: {args.output_dir}")
    print(f"Models: {args.models}")
    print(f"Olive DML optimization: {'SKIP' if args.skip_olive else 'ENABLED'}")
    print("=" * 70)

    t_start = time.time()
    results = {}

    for model_name in args.models:
        logger.info(f"\n{'='*60}")
        logger.info(f"Processing: {model_name}")
        logger.info(f"{'='*60}")

        fp32_path = os.path.join(args.fp32_dir, model_name + '.onnx')
        output_path = os.path.join(args.output_dir, model_name + '.onnx')

        if not os.path.exists(fp32_path):
            logger.warning(f"  FP32 model not found: {fp32_path}")
            results[model_name] = {'convert': 'SKIP', 'olive': 'SKIP', 'reason': 'not found'}
            continue

        fp32_size = os.path.getsize(fp32_path) / 1024 / 1024
        data_file = fp32_path + '.data'
        if os.path.exists(data_file):
            fp32_size += os.path.getsize(data_file) / 1024 / 1024
        logger.info(f"  FP32 size: {fp32_size:.1f} MB")

        # Convert to W16A32
        try:
            converted, casts = convert_w16a32_model(fp32_path, output_path)
            results[model_name] = {'convert': 'OK', 'weights_converted': converted, 'casts': casts}
        except Exception as e:
            logger.error(f"  W16A32 conversion failed: {e}")
            import traceback
            traceback.print_exc()
            results[model_name] = {'convert': 'FAIL', 'error': str(e)[:200]}
            continue

        # Apply Olive DML optimization
        if not args.skip_olive:
            try:
                olive_ok = apply_olive_dml_optimization(output_path)
                results[model_name]['olive'] = 'OK' if olive_ok else 'FAIL'
            except Exception as e:
                logger.error(f"  Olive optimization failed: {e}")
                results[model_name]['olive'] = f'FAIL: {str(e)[:100]}'
        else:
            results[model_name]['olive'] = 'SKIP'

        # Check final size
        final_size = os.path.getsize(output_path) / 1024 / 1024
        final_data = output_path + '.data'
        if os.path.exists(final_data):
            final_size += os.path.getsize(final_data) / 1024 / 1024
        ratio = final_size / fp32_size * 100 if fp32_size > 0 else 0
        results[model_name]['final_size_mb'] = final_size
        results[model_name]['size_ratio'] = ratio
        logger.info(f"  Final size: {final_size:.1f} MB ({ratio:.1f}% of FP32)")

        gc.collect()

    # Summary
    print(f"\n{'='*70}")
    print("SUMMARY")
    print(f"{'='*70}")
    print(f"{'Model':<25} {'Convert':<10} {'Olive':<10} {'Size':<12} {'Ratio':<8}")
    print(f"{'-'*70}")
    for model_name, r in results.items():
        convert = r.get('convert', 'N/A')
        olive = r.get('olive', 'N/A')
        size = r.get('final_size_mb', 0)
        ratio = r.get('size_ratio', 0)
        print(f"{model_name:<25} {convert:<10} {olive:<10} {size:<12.1f} {ratio:<8.1f}%")

    # Save report
    report_path = os.path.join(args.output_dir, 'w16a32_conversion_report.json')
    with open(report_path, 'w') as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\nReport saved: {report_path}")

    elapsed = time.time() - t_start
    print(f"Total time: {elapsed:.1f}s")


if __name__ == '__main__':
    main()
