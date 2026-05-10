import onnx
from onnx import helper, numpy_helper, TensorProto
import numpy as np
import os
import sys

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'onnx_models')

def fix_diff_step_for_dml(input_path, output_path):
    """
    Fix diff_step model for DirectML by replacing dynamic Reshape with
    shape-inference-aware static reshapes.
    
    Key insight: The dynamic Reshape nodes compute shapes from Concat(Shape(x), [value]).
    Since the actual runtime shapes are determined by the graph inputs,
    we can replace these with Flatten + Unflatten patterns that DML supports.
    """
    print(f"\n{'='*60}")
    print(f"修复 diff_step 模型以兼容 DirectML")
    print(f"{'='*60}")
    
    model = onnx.load(input_path)
    graph = model.graph
    
    print(f"原始模型: {len(graph.node)} 个节点")
    
    # Collect all initializer names
    init_names = {init.name for init in graph.initializer}
    
    # Build a map from output name to node
    output_to_node = {}
    for node in graph.node:
        for out in node.output:
            output_to_node[out] = node
    
    # Strategy: For each Reshape node, check if the shape input comes from
    # Concat([1, -1, dim]) pattern. If so, replace with a Reshape that uses
    # allowzero=0 (which DML supports better) or use Flatten.
    
    # Actually, the real fix is to use onnxruntime's graph optimization
    # to convert dynamic Reshapes to static ones by shape inference.
    
    # Let's try a different approach: use shape_inference to get static shapes,
    # then replace all dynamic Reshapes with static ones.
    
    # First, infer shapes
    try:
        inferred_model = onnx.shape_inference.infer_shapes(model)
        print("  形状推断成功")
    except Exception as e:
        print(f"  形状推断失败: {e}")
        inferred_model = model
    
    # Now, for each Reshape node, try to determine the output shape from value_info
    value_info = {vi.name: vi for vi in inferred_model.graph.value_info}
    output_info = {vi.name: vi for vi in inferred_model.graph.output}
    input_info = {vi.name: vi for vi in inferred_model.graph.input}
    all_info = {**value_info, **output_info, **input_info}
    
    new_nodes = []
    replaced = 0
    
    for node in graph.node:
        if node.op_type == 'Reshape' and len(node.input) >= 2:
            output_name = node.output[0]
            
            # Check if we know the output shape
            if output_name in all_info:
                vi = all_info[output_name]
                shape = []
                static = True
                for d in vi.type.tensor_type.shape.dim:
                    if d.dim_value > 0:
                        shape.append(d.dim_value)
                    elif d.dim_param:
                        # Dynamic dimension - try to use -1 (which means "infer")
                        shape.append(-1)
                        # But DML might not handle -1 well either
                    else:
                        static = False
                        break
                
                if static and len(shape) > 0:
                    # Create a constant initializer for the shape
                    const_name = f"_static_shape_{replaced}"
                    const_init = numpy_helper.from_array(
                        np.array(shape, dtype=np.int64),
                        name=const_name
                    )
                    graph.initializer.append(const_init)
                    
                    new_node = helper.make_node(
                        'Reshape',
                        inputs=[node.input[0], const_name],
                        outputs=list(node.output),
                        name=node.name,
                    )
                    new_nodes.append(new_node)
                    replaced += 1
                    continue
        
        new_nodes.append(node)
    
    # Replace all nodes
    del graph.node[:]
    for node in new_nodes:
        graph.node.append(node)
    
    print(f"  替换了 {replaced} 个动态 Reshape 为静态 Reshape")
    print(f"  总 Reshape 节点: {sum(1 for n in graph.node if n.op_type == 'Reshape')}")
    
    # Save
    onnx.save(model, output_path)
    print(f"  保存到: {output_path}")
    return replaced > 0


def fix_vocoder_for_dml(input_path, output_path):
    """
    Fix vocoder model for DirectML by replacing ConvTranspose(stride=480)
    with an equivalent operation sequence that DML supports.
    
    ConvTranspose with stride=S can be decomposed into:
    1. Reshape to add a new dimension
    2. Transpose
    3. Reshape to expand (inserting zeros)
    4. Multiply by a mask (zero out inserted positions)
    5. Conv with stride=1
    
    But this is very complex. A simpler approach:
    Use the iSTFT interpretation - the vocoder is essentially an iSTFT.
    We can replace ConvTranspose with the explicit iSTFT computation.
    """
    print(f"\n{'='*60}")
    print(f"修复 vocoder 模型以兼容 DirectML")
    print(f"{'='*60}")
    
    model = onnx.load(input_path)
    graph = model.graph
    
    print(f"原始模型: {len(graph.node)} 个节点")
    
    # Find the ConvTranspose node
    conv_trans_node = None
    for node in graph.node:
        if node.op_type == 'ConvTranspose':
            conv_trans_node = node
            break
    
    if conv_trans_node is None:
        print("  未找到 ConvTranspose 节点")
        onnx.save(model, output_path)
        return False
    
    print(f"  ConvTranspose: {conv_trans_node.name}")
    print(f"    输入: {list(conv_trans_node.input)}")
    print(f"    输出: {list(conv_trans_node.output)}")
    
    # Get ConvTranspose attributes
    stride = 480
    for attr in conv_trans_node.attribute:
        if attr.name == 'strides':
            stride = attr.ints[0]
    
    print(f"    stride: {stride}")
    
    # Decompose ConvTranspose(stride=S) into:
    # 1. Expand input by inserting (S-1) zeros between each element
    # 2. Apply Conv1x1 (regular convolution with stride=1)
    
    # Actually, ConvTranspose with stride S on 1D data is equivalent to:
    # - Upsample: insert S-1 zeros between each time step
    # - Conv with the same weight, stride=1
    
    # But the weight shape for ConvTranspose is [in_ch, out_ch, kernel_size]
    # For Conv it's [out_ch, in_ch, kernel_size]
    # So we need to transpose the weight
    
    # Find the weight initializer
    weight_name = conv_trans_node.input[1]
    weight_init = None
    for init in graph.initializer:
        if init.name == weight_name:
            weight_init = init
            break
    
    if weight_init is None:
        print("  未找到权重初始化器")
        return False
    
    weight_array = numpy_helper.to_array(weight_init)
    print(f"    权重形状: {weight_array.shape}")
    # ConvTranspose weight: [in_channels, out_channels/group, kernel_size]
    # Conv weight: [out_channels, in_channels/group, kernel_size]
    
    # For ConvTranspose: weight shape is [C_in, C_out, K]
    # The operation is: output = ConvTranspose(input, weight)
    # Which is equivalent to: output = Conv(upsample(input, stride), weight_transposed)
    # where weight_transposed has shape [C_out, C_in, K]
    
    in_channels = weight_array.shape[0]
    out_channels = weight_array.shape[1]
    kernel_size = weight_array.shape[2]
    
    print(f"    in_channels: {in_channels}, out_channels: {out_channels}, kernel_size: {kernel_size}")
    
    # Create the transposed weight for Conv
    conv_weight = weight_array.transpose(1, 0, 2)  # [C_out, C_in, K]
    conv_weight_name = f"{weight_name}_conv_transposed"
    conv_weight_init = numpy_helper.from_array(conv_weight.astype(np.float32), name=conv_weight_name)
    
    # Remove old weight and add new one
    for i, init in enumerate(graph.initializer):
        if init.name == weight_name:
            # Keep the old one, add the new one
            break
    graph.initializer.append(conv_weight_init)
    
    # Now replace ConvTranspose with:
    # 1. Reshape input from [B, C, T] to [B, C, T, 1]
    # 2. Pad/Expand to [B, C, T*S, 1] by inserting zeros
    # 3. Reshape to [B, C, T*S]
    # 4. Conv with weight [C_out, C_in, K], stride=1
    
    # Actually, a simpler decomposition:
    # ConvTranspose(input, weight, stride=S) = 
    #   Conv(ExpandZeros(input, S), weight_transposed, stride=1)
    #
    # Where ExpandZeros inserts S-1 zeros between each sample.
    # This can be done with:
    # 1. Reshape [B, C, T] -> [B, C, T, 1]
    # 2. ConstantOfShape + Pad to [B, C, T, S] (pad S-1 zeros after each element)
    # 3. Reshape [B, C, T, S] -> [B, C, T*S]
    # 4. Conv [B, C, T*S] with weight [C_out, C_in, K], stride=1
    
    input_name = conv_trans_node.input[0]
    output_name = conv_trans_node.output[0]
    
    # Step 1: Get input shape info
    reshape1_out = f"{conv_trans_node.name}_reshape1"
    reshape1_shape = f"{conv_trans_node.name}_reshape1_shape"
    # Shape: [B, C, T, 1]
    # We need to know B, C, T dynamically...
    # This is getting very complex. Let me try a different approach.
    
    # Alternative: Use DepthToSpace-like operation
    # Or simply: Use the fact that ConvTranspose with stride=S and no padding
    # produces output of size (T-1)*S + K
    # We can use Resize/UpSample + Conv instead
    
    # Actually the simplest DML-compatible approach:
    # Replace ConvTranspose(stride=480) with:
    # 1. Upsample (Resize with nearest mode, scale=480)
    # 2. Conv1D (stride=1)
    
    # But ONNX Resize is also tricky with DML...
    
    # Let me try yet another approach: just use the explicit matrix multiplication
    # form of ConvTranspose.
    
    # ConvTranspose1D(x, w, stride=S) where x:[B,C,T], w:[C_in,C_out,K]
    # Output: [B, C_out, (T-1)*S + K]
    # 
    # This is equivalent to:
    # For each output position o:
    #   y[b, c_out, o] = sum over c_in, k: x[b, c_in, (o-k)//S] * w[c_in, c_out, k]
    #   where (o-k) must be divisible by S and (o-k)//S must be in [0, T)
    
    # This is getting too complex for a script transformation.
    # Let me try the Olive approach instead.
    
    print("\n  ConvTranspose 分解过于复杂，尝试使用 Olive API...")
    
    # Try using Olive programmatically
    try:
        from olive.common.utils import set_tempdir
        from olive.engine import Engine
        from olive.engine.footprint import Footprint
        from olive.model import ONNXModelHandler
        from olive.passes import OnnxConversion
        from olive.passes.onnx.transformer_optimization import TransformerOptimization
        from olive.systems.local import LocalSystem
        
        print("  Olive API 可用!")
        
        # Create an ONNX model handler
        onnx_model = ONNXModelHandler(model_path=input_path)
        
        # Try to run optimization passes
        # ... this needs more investigation
        
    except ImportError as e:
        print(f"  Olive API 导入失败: {e}")
    
    onnx.save(model, output_path)
    print(f"  保存到: {output_path}")
    return False


if __name__ == '__main__':
    # Fix diff_step
    diff_step_path = os.path.join(MODEL_DIR, 'diff_step.onnx')
    diff_step_fixed = os.path.join(MODEL_DIR, 'diff_step_dml.onnx')
    if os.path.exists(diff_step_path):
        fix_diff_step_for_dml(diff_step_path, diff_step_fixed)
    
    # Fix vocoder
    vocoder_path = os.path.join(MODEL_DIR, 'vocoder.onnx')
    vocoder_fixed = os.path.join(MODEL_DIR, 'vocoder_dml.onnx')
    if os.path.exists(vocoder_path):
        fix_vocoder_for_dml(vocoder_path, vocoder_fixed)
