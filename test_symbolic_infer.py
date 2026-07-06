# -*- coding: utf-8 -*-
"""Try SymbolicShapeInference to fold dynamic shape Concat for W16A32 diffStep."""
import onnx
import onnxruntime
from onnxruntime.tools.symbolic_shape_infer import SymbolicShapeInference

model_path = r'd:\Document\electron\SXSEditor\onnx_models\fp16\diff_step_dml.onnx'
m = onnx.load(model_path, load_external_data=False)
print(f'Before: {len(m.graph.node)} nodes')

try:
    m2 = SymbolicShapeInference.infer_shapes(m, auto_merge=True, guess_output_rank=False)
    print(f'After symbolic infer: {len(m2.graph.node)} nodes')
    # Check if val_57 still exists as Concat output
    found = False
    for node in m2.graph.node:
        if node.op_type == 'Concat' and 'val_57' in node.output:
            found = True
            print(f'val_57 still produced by Concat: {node.name}')
            print(f'  inputs: {list(node.input)}')
            break
    if not found:
        print('val_57 Concat gone or changed')

    # Try onnxsim after symbolic inference
    import onnxsim
    simplified, ok = onnxsim.simplify(m2, check_n=0, skip_fuse_bn=True, dynamic_input_shape=True)
    if ok:
        print(f'After onnxsim: {len(simplified.graph.node)} nodes')
        # Check val_57 again
        for node in simplified.graph.node:
            if 'val_57' in node.output:
                print(f'val_57 now: op={node.op_type}, name={node.name}')
                break
        else:
            # Check if val_57 became initializer
            for init in simplified.graph.initializer:
                if init.name == 'val_57':
                    from onnx import numpy_helper
                    arr = numpy_helper.to_array(init)
                    print(f'val_57 became initializer: {arr.tolist()}')
                    break
    else:
        print('onnxsim failed after symbolic infer')
except Exception as e:
    print(f'ERROR: {type(e).__name__}: {e}')
    import traceback
    traceback.print_exc()
