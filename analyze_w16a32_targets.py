# -*- coding: utf-8 -*-
"""Analyze FP32 production vocoder to determine which initializers should be
quantized to FP16 for W16A32."""
import onnx
from onnx import numpy_helper, helper, TensorProto
from collections import Counter, defaultdict

mp = r'd:\Document\electron\SXSEditor\onnx_models\vocoder_dml.onnx'
m = onnx.load(mp, load_external_data=False)
g = m.graph

# Map initializer name -> (dims, dtype, size)
init_map = {}
for init in g.initializer:
    arr_size = 1
    for d in init.dims:
        arr_size *= d
    init_map[init.name] = (list(init.dims), init.data_type, arr_size)

# For each initializer, find which nodes consume it and as which input
init_consumers = defaultdict(list)  # init_name -> [(node_op, node_name, input_position, is_weight_like)]
for node in g.node:
    for i, inp in enumerate(node.input):
        if inp in init_map:
            init_consumers[inp].append((node.op_type, node.name, i))

# Classify initializers
weight_inits = []  # 2D used by MatMul, or 3D/4D used by Conv
bias_inits = []    # 1D
other_inits = []   # everything else
skip_inits = []    # istft related

for name, (dims, dtype, size) in init_map.items():
    if 'istft' in name.lower() or 'window' in name.lower():
        skip_inits.append((name, dims, dtype))
        continue
    consumers = init_consumers.get(name, [])
    consumer_ops = set(c[0] for c in consumers)
    is_weight = False
    if len(dims) == 2 and 'MatMul' in consumer_ops:
        is_weight = True
    elif len(dims) in (3, 4) and 'Conv' in consumer_ops:
        is_weight = True
    elif len(dims) in (3, 4) and 'ConvTranspose' in consumer_ops:
        is_weight = True

    if is_weight:
        weight_inits.append((name, dims, dtype, size, consumer_ops))
    elif len(dims) == 1:
        bias_inits.append((name, dims, dtype))
    else:
        other_inits.append((name, dims, dtype, consumer_ops))

print(f'=== Classification ===')
print(f'Weight (to quantize to FP16): {len(weight_inits)}')
print(f'Bias (1D, keep FP32): {len(bias_inits)}')
print(f'Skip (istft/window): {len(skip_inits)}')
print(f'Other: {len(other_inits)}')

print(f'\n=== Weight initializers sample (first 5) ===')
total_params = 0
for name, dims, dtype, size, ops in weight_inits[:5]:
    print(f'  {name}: dims={dims}, dtype={dtype}, size={size}, ops={ops}')
    total_params += size
for name, dims, dtype, size, ops in weight_inits:
    total_params += size
print(f'Total weight params: {total_params / 1e6:.1f}M')

print(f'\n=== Skip initializers ===')
for name, dims, dtype in skip_inits:
    print(f'  {name}: dims={dims}, dtype={dtype}')

print(f'\n=== Other initializers (first 10) ===')
for name, dims, dtype, ops in other_inits[:10]:
    print(f'  {name}: dims={dims}, dtype={dtype}, ops={ops}')

# Check Conv weight dims
conv_weights = [w for w in weight_inits if 'Conv' in w[4]]
print(f'\n=== Conv weights ({len(conv_weights)}) ===')
for name, dims, dtype, size, ops in conv_weights[:5]:
    print(f'  {name}: dims={dims}, dtype={dtype}, ops={ops}')

# Check MatMul weight dims
matmul_weights = [w for w in weight_inits if 'MatMul' in w[4]]
print(f'\n=== MatMul weights: {len(matmul_weights)}, all dims: {set(w[1] for w in matmul_weights)}')

# Check for any initializer used by both MatMul and Conv (shared)
shared = [w for w in weight_inits if len(w[4]) > 1]
print(f'\n=== Shared weights (used by multiple op types): {len(shared)}')
for name, dims, dtype, size, ops in shared[:5]:
    print(f'  {name}: dims={dims}, ops={ops}')

# Size estimation
fp32_size = sum(s for _, _, _, s, _ in weight_inits) * 4 / 1024 / 1024
fp16_size = sum(s for _, _, _, s, _ in weight_inits) * 2 / 1024 / 1024
print(f'\n=== Size estimation ===')
print(f'Weight FP32: {fp32_size:.1f} MB')
print(f'Weight FP16: {fp16_size:.1f} MB (saves {fp32_size - fp16_size:.1f} MB)')
