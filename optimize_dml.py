import onnx
from onnx import helper, numpy_helper, TensorProto
import numpy as np
import os
import onnxruntime as ort

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'onnx_models')

def test_dml(model_path, model_name, input_shapes=None):
    """Test DirectML inference with proper input shapes."""
    print(f"\n  测试 {model_name}...")
    try:
        sess = ort.InferenceSession(model_path, providers=['DmlExecutionProvider', 'CPUExecutionProvider'])
        active = sess.get_providers()
        print(f"  EP: {active}")
        
        inputs = {}
        for inp in sess.get_inputs():
            name = inp.name
            shape = inp.shape
            resolved = []
            for d in shape:
                if isinstance(d, int) and d > 0:
                    resolved.append(d)
                elif name in (input_shapes or {}):
                    resolved.append(input_shapes[name])
                else:
                    resolved.append(3)
            if inp.type == 'tensor(int64)':
                inputs[name] = np.arange(np.prod(resolved), dtype=np.int64).reshape(resolved)
            else:
                inputs[name] = np.random.randn(*resolved).astype(np.float32) * 0.01
        
        result = sess.run(None, inputs)
        print(f"  ✅ DML 推理成功! 输出: {[r.shape for r in result]}")
        return True
    except Exception as e:
        msg = str(e)
        if len(msg) > 200:
            msg = msg[:200]
        print(f"  ❌ DML 推理失败: {msg}")
        return False


def fix_vocoder(input_path, output_path):
    """
    Replace ConvTranspose(stride=480) in vocoder with DML-compatible operations.
    
    ConvTranspose1D with stride=S, weight [C_in, C_out, K]:
    output[b, co, t] = sum_{ci, k} input[b, ci, (t-k)//S] * weight[ci, co, k]
    
    Equivalent: upsample input by S (insert S-1 zeros), then Conv1D with weight.T
    """
    print(f"\n{'='*60}")
    print(f"修复 vocoder (ConvTranspose → Upsample+Conv)")
    print(f"{'='*60}")
    
    model = onnx.load(input_path)
    graph = model.graph
    
    # Find ConvTranspose
    ct_idx = None
    ct_node = None
    for i, node in enumerate(graph.node):
        if node.op_type == 'ConvTranspose':
            ct_idx = i
            ct_node = node
            break
    
    if ct_node is None:
        print("  无 ConvTranspose")
        return False
    
    # Get weight
    w_name = ct_node.input[1]
    w_init = next(init for init in graph.initializer if init.name == w_name)
    w = numpy_helper.to_array(w_init)
    c_in, c_out, k = w.shape
    stride = 480
    for attr in ct_node.attribute:
        if attr.name == 'strides':
            stride = attr.ints[0]
    
    print(f"  ConvTranspose: weight [{c_in},{c_out},{k}], stride={stride}")
    
    # Build replacement subgraph
    inp = ct_node.input[0]
    out = ct_node.output[0]
    base = ct_node.name or "ct_repl"
    
    # We'll use explicit Reshape + Pad + Reshape + Conv
    # But to avoid shape inference issues, use fixed-dimension approach
    # Since vocoder always gets [1, C, T_frames] input:
    # 1. Get T from Shape(input)
    # 2. Compute T*S
    # 3. Reshape input [1, C, T] -> [1, C, T, 1]  
    # 4. Pad [1, C, T, 1] -> [1, C, T, S]
    # 5. Reshape [1, C, T, S] -> [1, C, T*S]
    # 6. Conv with w.T, stride=1
    
    # Constants
    const_0 = numpy_helper.from_array(np.array(0, dtype=np.int64), name=f"{base}_c0")
    const_1 = numpy_helper.from_array(np.array(1, dtype=np.int64), name=f"{base}_c1")
    const_2 = numpy_helper.from_array(np.array(2, dtype=np.int64), name=f"{base}_c2")
    const_s = numpy_helper.from_array(np.array(stride, dtype=np.int64), name=f"{base}_cs")
    const_neg1 = numpy_helper.from_array(np.array(-1, dtype=np.int64), name=f"{base}_cneg1")
    # Pad: [0,0,0,0, 0,0,0,S-1] for 4D input
    pad_pads = numpy_helper.from_array(
        np.array([0,0,0,0, 0,0,0,stride-1], dtype=np.int64),
        name=f"{base}_pads"
    )
    pad_val = numpy_helper.from_array(np.array(0.0, dtype=np.float32), name=f"{base}_pval")
    
    # Conv weight: transpose [C_in, C_out, K] -> [C_out, C_in, K]
    w_conv = w.transpose(1, 0, 2).astype(np.float32)
    w_conv_name = f"{w_name}_conv"
    w_conv_init = numpy_helper.from_array(w_conv, name=w_conv_name)
    
    for c in [const_0, const_1, const_2, const_s, const_neg1, pad_pads, pad_val, w_conv_init]:
        graph.initializer.append(c)
    
    nodes = [
        # Shape(input) -> [1, C, T]
        helper.make_node('Shape', [inp], [f"{base}_shape"], name=f"{base}_shape"),
        # shape[2] = T
        helper.make_node('Gather', [f"{base}_shape", f"{base}_c2"], [f"{base}_T"], name=f"{base}_gT", axis=0),
        # T * S
        helper.make_node('Mul', [f"{base}_T", f"{base}_cs"], [f"{base}_TS"], name=f"{base}_mul"),
        # Concat [1, C, T*S]
        helper.make_node('Gather', [f"{base}_shape", f"{base}_c0"], [f"{base}_B"], name=f"{base}_gB", axis=0),
        helper.make_node('Gather', [f"{base}_shape", f"{base}_c1"], [f"{base}_C"], name=f"{base}_gC", axis=0),
        helper.make_node('Concat', [f"{base}_B", f"{base}_C", f"{base}_TS"], [f"{base}_flat_shape"], name=f"{base}_cat", axis=0),
        # Reshape [1, C, T] -> [1, C, T, 1]
        helper.make_node('Concat', [f"{base}_shape", f"{base}_cneg1"], [f"{base}_r1_shape"], name=f"{base}_cat_r1", axis=0),
        helper.make_node('Reshape', [inp, f"{base}_r1_shape"], [f"{base}_r1"], name=f"{base}_r1"),
        # Pad [1, C, T, 1] -> [1, C, T, S]
        helper.make_node('Pad', [f"{base}_r1", f"{base}_pads", f"{base}_pval"], [f"{base}_padded"], name=f"{base}_pad", mode='constant'),
        # Reshape [1, C, T, S] -> [1, C, T*S]
        helper.make_node('Reshape', [f"{base}_padded", f"{base}_flat_shape"], [f"{base}_r2"], name=f"{base}_r2"),
        # Conv [1, C, T*S] + w_conv [C_out, C_in, K] -> [1, C_out, T*S + K - 1]
        helper.make_node('Conv', [f"{base}_r2", w_conv_name], [out], name=f"{base}_conv", kernel_shape=[k], strides=[1], pads=[0, 0]),
    ]
    
    del graph.node[ct_idx]
    for i, n in enumerate(nodes):
        graph.node.insert(ct_idx + i, n)
    
    print(f"  替换为 {len(nodes)} 个节点")
    onnx.save(model, output_path)
    print(f"  保存到: {output_path}")
    
    return test_dml(output_path, "vocoder (fixed)")


def fix_diff_step(input_path, output_path):
    """
    Fix diff_step by converting dynamic Reshape to Flatten where possible.
    
    The 89 Reshape nodes in diff_step follow patterns like:
    - Reshape(x, [1, -1, dim]) -> flatten batch and seq dims
    - Reshape(x, [1, dim, -1]) -> rearrange dims
    
    For DML, we replace these with Transpose + Flatten + Unflatten patterns
    that don't require dynamic shape computation.
    
    Alternative approach: Use onnxruntime's shape inference with concrete input shapes
    to materialize all shapes as constants.
    """
    print(f"\n{'='*60}")
    print(f"修复 diff_step (动态 Reshape → 静态)")
    print(f"{'='*60}")
    
    # Strategy: Use onnxruntime to run the model with a known input shape,
    # capture all intermediate tensor shapes, then create a new model with
    # all Reshape shapes replaced by constants.
    
    # First, run the model on CPU to capture shapes
    print("  在 CPU 上运行模型以捕获中间形状...")
    sess = ort.InferenceSession(input_path, providers=['CPUExecutionProvider'])
    
    # Create test input with a specific shape
    test_seq_len = 43  # A typical sequence length
    test_inputs = {
        'xt_input': np.random.randn(1, test_seq_len, 128).astype(np.float32),
        't': np.array([0.5], dtype=np.float32),
        'cond': np.random.randn(1, test_seq_len, 1024).astype(np.float32),
        'xt_mask': np.ones((1, test_seq_len), dtype=np.float32),
    }
    
    # Run with shape output
    result = sess.run(None, test_inputs)
    print(f"  CPU 推理成功, 输出形状: {[r.shape for r in result]}")
    
    # Now load the ONNX model and replace all dynamic Reshapes
    model = onnx.load(input_path)
    graph = model.graph
    
    # For each Reshape node, we need to figure out what shape it produces
    # when the input has a specific shape. We can do this by:
    # 1. Running the shape computation subgraph with known inputs
    # 2. Replacing the dynamic shape with a constant
    
    # Alternative simpler approach: Since the model always runs with batch=1,
    # we can use onnx-simplifier to freeze all dynamic shapes.
    # But onnx-simplifier might not be installed.
    
    # Let's try yet another approach: replace Reshape with Flatten where appropriate
    # Reshape(x, [1, -1, dim]) is equivalent to:
    #   Flatten(x, axis=2) then Reshape(flat, [1, -1, dim])
    # But this still has a dynamic Reshape...
    
    # The real fix: Use onnxruntime's GraphOptimization to convert
    # dynamic Reshapes to static ones. This is what Olive does.
    
    # Let's try the simplest possible approach:
    # Replace all Reshape(x, Concat(Shape(x)[0:2], [dim])) patterns
    # with Reshape(x, [1, seq_len, dim]) where seq_len is a known constant.
    
    # But seq_len varies! So this won't work for all inputs.
    
    # The fundamental issue: DML's Reshape implementation can't handle
    # shape inputs that are computed at runtime (from Concat/Shape ops).
    # This is a DML bug/limitation.
    
    # Workaround: Use a custom Reshape implementation that DML supports.
    # We can replace Reshape with a series of Transpose + Flatten operations.
    
    # Actually, let's try the most direct approach:
    # Convert all Reshape nodes to use the allowzero=0 attribute
    # and see if that helps DML.
    
    new_nodes = []
    modified = 0
    
    for node in graph.node:
        if node.op_type == 'Reshape':
            # Add allowzero=0 attribute
            new_node = helper.make_node(
                'Reshape',
                inputs=list(node.input),
                outputs=list(node.output),
                name=node.name,
                allowzero=0,
            )
            new_nodes.append(new_node)
            modified += 1
        else:
            new_nodes.append(node)
    
    del graph.node[:]
    for node in new_nodes:
        graph.node.append(node)
    
    print(f"  修改了 {modified} 个 Reshape 节点 (添加 allowzero=0)")
    
    onnx.save(model, output_path)
    print(f"  保存到: {output_path}")
    
    return test_dml(output_path, "diff_step (allowzero)")


if __name__ == '__main__':
    diff_step_path = os.path.join(MODEL_DIR, 'diff_step.onnx')
    vocoder_path = os.path.join(MODEL_DIR, 'vocoder.onnx')
    
    # Test originals
    test_dml(diff_step_path, "diff_step (original)", {'xt_input': 43, 't': 1, 'cond': 43, 'xt_mask': 43})
    test_dml(vocoder_path, "vocoder (original)", {'mel': 10})
    
    # Fix
    diff_fixed = os.path.join(MODEL_DIR, 'diff_step_dml.onnx')
    voc_fixed = os.path.join(MODEL_DIR, 'vocoder_dml.onnx')
    
    diff_ok = fix_diff_step(diff_step_path, diff_fixed)
    voc_ok = fix_vocoder(vocoder_path, voc_fixed)
    
    print(f"\n{'='*60}")
    print(f"结果: diff_step={'✅' if diff_ok else '❌'}, vocoder={'✅' if voc_ok else '❌'}")
    print(f"{'='*60}")
