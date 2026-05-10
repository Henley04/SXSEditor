import onnx
from onnx import helper, numpy_helper
import numpy as np
import os
import onnxruntime as ort

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'onnx_models')

def test_dml(model_path, model_name, input_shapes=None):
    print(f"\n  测试 {model_name}...")
    try:
        sess = ort.InferenceSession(model_path, providers=['DmlExecutionProvider', 'CPUExecutionProvider'])
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
        msg = str(e)[:200]
        print(f"  ❌ DML 推理失败: {msg}")
        return False


def fix_vocoder(input_path, output_path):
    print(f"\n{'='*60}")
    print(f"修复 vocoder (ConvTranspose → Pad+Conv)")
    print(f"{'='*60}")
    
    model = onnx.load(input_path)
    graph = model.graph
    
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
    
    w_name = ct_node.input[1]
    w_init = next(init for init in graph.initializer if init.name == w_name)
    w = numpy_helper.to_array(w_init)
    c_in, c_out, k = w.shape
    stride = 480
    for attr in ct_node.attribute:
        if attr.name == 'strides':
            stride = attr.ints[0]
    
    print(f"  ConvTranspose: weight [{c_in},{c_out},{k}], stride={stride}")
    
    inp = ct_node.input[0]
    out = ct_node.output[0]
    base = ct_node.name or "ct_repl"
    
    # Use 1D constants for Concat (need 1D tensors, not scalars)
    const_1 = numpy_helper.from_array(np.array([1], dtype=np.int64), name=f"{base}_c1")
    const_c = numpy_helper.from_array(np.array([c_in], dtype=np.int64), name=f"{base}_cc")
    const_s = numpy_helper.from_array(np.array([stride], dtype=np.int64), name=f"{base}_cs")
    
    # Pad: for 3D input [C, T, 1] -> [C, T, S]
    pad_pads = numpy_helper.from_array(
        np.array([0, 0, 0, 0, 0, stride - 1], dtype=np.int64),
        name=f"{base}_pads"
    )
    pad_val = numpy_helper.from_array(np.array(0.0, dtype=np.float32), name=f"{base}_pval")
    
    # Conv weight: transpose [C_in, C_out, K] -> [C_out, C_in, K]
    w_conv = w.transpose(1, 0, 2).astype(np.float32)
    w_conv_name = f"{w_name}_conv"
    w_conv_init = numpy_helper.from_array(w_conv, name=w_conv_name)
    
    for c in [const_1, const_c, const_s, pad_pads, pad_val, w_conv_init]:
        graph.initializer.append(c)
    
    nodes = [
        # Shape(input) -> [1, C, T]
        helper.make_node('Shape', [inp], [f"{base}_shape"], name=f"{base}_shape"),
        # T = shape[2] (scalar)
        helper.make_node('Gather', [f"{base}_shape", f"{base}_gi2"], [f"{base}_T"], name=f"{base}_gT", axis=0),
        # T*S (scalar)
        helper.make_node('Mul', [f"{base}_T", f"{base}_cs_scalar"], [f"{base}_TS"], name=f"{base}_mul"),
        
        # Unsqueeze T and TS to 1D for Concat
        helper.make_node('Unsqueeze', [f"{base}_T", f"{base}_gi0"], [f"{base}_T_1d"], name=f"{base}_uT"),
        helper.make_node('Unsqueeze', [f"{base}_TS", f"{base}_gi0"], [f"{base}_TS_1d"], name=f"{base}_uTS"),
        
        # Reshape [1, C, T] -> [C, T]: shape = [C, T]
        helper.make_node('Concat', [f"{base}_cc", f"{base}_T_1d"], [f"{base}_shape_2d"], name=f"{base}_cat2d", axis=0),
        helper.make_node('Reshape', [inp, f"{base}_shape_2d"], [f"{base}_2d"], name=f"{base}_r2d"),
        
        # Reshape [C, T] -> [C, T, 1]: shape = [C, T, 1]
        helper.make_node('Concat', [f"{base}_cc", f"{base}_T_1d", f"{base}_c1"], [f"{base}_shape_3d"], name=f"{base}_cat3d", axis=0),
        helper.make_node('Reshape', [f"{base}_2d", f"{base}_shape_3d"], [f"{base}_3d"], name=f"{base}_r3d"),
        
        # Pad [C, T, 1] -> [C, T, S]
        helper.make_node('Pad', [f"{base}_3d", f"{base}_pads", f"{base}_pval"], [f"{base}_padded"], name=f"{base}_pad", mode='constant'),
        
        # Reshape [C, T, S] -> [C, T*S]: shape = [C, T*S]
        helper.make_node('Concat', [f"{base}_cc", f"{base}_TS_1d"], [f"{base}_shape_flat"], name=f"{base}_catflat", axis=0),
        helper.make_node('Reshape', [f"{base}_padded", f"{base}_shape_flat"], [f"{base}_flat"], name=f"{base}_rflat"),
        
        # Reshape [C, T*S] -> [1, C, T*S]: shape = [1, C, T*S]
        helper.make_node('Concat', [f"{base}_c1", f"{base}_cc", f"{base}_TS_1d"], [f"{base}_shape_final"], name=f"{base}_catfinal", axis=0),
        helper.make_node('Reshape', [f"{base}_flat", f"{base}_shape_final"], [f"{base}_final"], name=f"{base}_rfinal"),
        
        # Conv [1, C, T*S] + w_conv [C_out, C_in, K] -> [1, C_out, T*S + K - 1]
        helper.make_node('Conv', [f"{base}_final", w_conv_name], [out], name=f"{base}_conv", kernel_shape=[k], strides=[1], pads=[0, 0]),
    ]
    
    # Add missing scalar constants for Gather indices and Unsqueeze axes
    gi2 = numpy_helper.from_array(np.array(2, dtype=np.int64), name=f"{base}_gi2")
    gi0 = numpy_helper.from_array(np.array(0, dtype=np.int64), name=f"{base}_gi0")
    cs_scalar = numpy_helper.from_array(np.array(stride, dtype=np.int64), name=f"{base}_cs_scalar")
    
    for c in [gi2, gi0, cs_scalar]:
        graph.initializer.append(c)
    
    del graph.node[ct_idx]
    for i, n in enumerate(nodes):
        graph.node.insert(ct_idx + i, n)
    
    print(f"  替换为 {len(nodes)} 个节点")
    onnx.save(model, output_path)
    print(f"  保存到: {output_path}")
    
    return test_dml(output_path, "vocoder (fixed)", {'mel': 10})


if __name__ == '__main__':
    vocoder_path = os.path.join(MODEL_DIR, 'vocoder.onnx')
    voc_fixed = os.path.join(MODEL_DIR, 'vocoder_dml.onnx')
    voc_ok = fix_vocoder(vocoder_path, voc_fixed)
    print(f"\nvocoder: {'✅' if voc_ok else '❌'}")
