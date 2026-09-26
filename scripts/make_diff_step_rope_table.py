# Fix the TRT-RTX 2048-frame RoPE divergence by baking the rope table into the
# model as weights.
#
# Root cause (measured, see scripts/probe_trt_rope.js / probe_trt_rope_detail.js):
#   TRT-RTX's Myelin-fused position kernel executes the fp32 MatMul
#   (position x inv_freq) at an 11-bit-mantissa grid: positions >= 2049 round to
#   the nearest even (2049 -> 2050), giving a phase error of +-inv_freq per
#   corrupted frame (1.0 rad on the omega=1.0 channel). The rope embedding
#   deviates by up to ~0.95 per channel, poisoning q/k rotation in all 22
#   attention layers; the divergence is amplified over 32 diffusion steps into
#   the tail energy dip. Even fp64 detours get silently absorbed by the EP
#   (dump subgraphs showed DOUBLE nodes inside the TRT engine), so nothing that
#   is computed inside the engine can be trusted for absolute positions.
#
# Fix: precompute cos/sin for positions 0..ROPE_TABLE_MAX-1 offline (fp64 math,
#   fp32-phase emulation, fp16 storage — same rounding as the original graph's
#   Cast(FLOAT->FLOAT16)), store as initializers [1,ROPE_TABLE_MAX,64], and at
#   runtime Slice to [1,seq_len,64]. The engine only performs a data slice —
#   no absolute-position arithmetic exists anywhere inside TRT anymore, so the
#   bug is unreachable by construction. Model I/O contract is unchanged.
#
# Usage:
#   python scripts/make_diff_step_rope_table.py --input in.onnx --output out.onnx
import argparse
import onnx
import numpy as np
from onnx import TensorProto, helper, numpy_helper

ROPE_TABLE_MAX = 8192  # 163.8 s @ 50 fps mel frames

ap = argparse.ArgumentParser()
ap.add_argument('--input', required=True)
ap.add_argument('--output', required=True)
args = ap.parse_args()

m = onnx.load(args.input, load_external_data=False)
g = m.graph

nodes_by_name = {n.name: n for n in g.node}
init_by_name = {i.name: i for i in g.initializer}

CHAIN = [
    'node_arange_1', 'node_unsqueeze_2', 'node_view', 'node_unsqueeze_7',
    'node__to_copy_2', 'node_matmul', 'node_transpose', 'node_cat_1',
    'node_cos_1', 'node_sin_1', 'node__to_copy_3', 'node__to_copy_4',
]
REWIRES = {'_to_copy_3': 'rope_cos_slice', '_to_copy_4': 'rope_sin_slice'}

for name in CHAIN:
    if name not in nodes_by_name:
        raise SystemExit(f'expected node missing: {name}')
if 'expand_1' not in init_by_name:
    raise SystemExit('expand_1 initializer (inv_freq) not found')
if 'sym_size_int_5' not in {o for n in g.node for o in n.output}:
    raise SystemExit('sym_size_int_5 (seq length scalar) not found')

# sanity: chain tensors have exactly the consumers we expect, so removal is safe
producers = {o: n for n in g.node for o in n.output}
expected_consumers = {
    'arange_1': 1, 'unsqueeze_2': 1, 'view': 1, 'unsqueeze_7': 1,
    '_to_copy_2': 1, 'matmul': 1, 'transpose': 1, 'cat_1': 2,
    'cos_1': 1, 'sin_1': 1, '_to_copy_3': 1, '_to_copy_4': 1,
}
for tensor, want in expected_consumers.items():
    got = sum(1 for n in g.node if tensor in n.input and n is not producers.get(tensor))
    if got != want:
        raise SystemExit(f'{tensor}: expected {want} consumer(s), found {got}')

# ---- generate the rope tables (fp64 math, fp32 storage phase, fp16 storage) ----
inv32 = onnx.numpy_helper.to_array(init_by_name['expand_1']).ravel().astype(np.float32)  # [32]
pos = np.arange(ROPE_TABLE_MAX, dtype=np.float32)
phase32 = np.outer(pos, inv32)                                   # fp32 product like the fp32 MatMul
cos32 = np.cos(phase32.astype(np.float64)).astype(np.float32)    # fp32-accurate cos
sin32 = np.sin(phase32.astype(np.float64)).astype(np.float32)
# cat_1 duplicated the phases, so the original cos_1/sin_1 have 64 dims with the
# 32 channels repeated; reproduce that layout exactly.
cos64 = np.concatenate([cos32, cos32], axis=1).astype(np.float16)  # [MAX,64]
sin64 = np.concatenate([sin32, sin32], axis=1).astype(np.float16)
cos_table = numpy_helper.from_array(cos64.reshape(1, ROPE_TABLE_MAX, 64), 'rope_cos_table')
sin_table = numpy_helper.from_array(sin64.reshape(1, ROPE_TABLE_MAX, 64), 'rope_sin_table')

# ---- glue nodes: Slice([1,MAX,64] -> [1,seq,64]) ----
i64 = lambda name, vals: numpy_helper.from_array(np.asarray(vals, dtype=np.int64), name)
new_inits = [
    i64('rope_slice_starts', [0, 0, 0]),
    i64('rope_slice_axes', [0, 1, 2]),
    i64('rope_end_batch', [1]),
    i64('rope_end_dims', [64]),
]
new_nodes = [
    helper.make_node('Unsqueeze', ['sym_size_int_5', 'rope_seq_unsq_axes'], ['rope_seq_1d'], name='node_rope_seq_1d'),
    helper.make_node('Concat', ['rope_end_batch', 'rope_seq_1d', 'rope_end_dims'], ['rope_slice_ends'], axis=0, name='node_rope_slice_ends'),
    helper.make_node('Slice', ['rope_cos_table', 'rope_slice_starts', 'rope_slice_ends', 'rope_slice_axes'], ['rope_cos_slice'], name='node_rope_cos_slice'),
    helper.make_node('Slice', ['rope_sin_table', 'rope_slice_starts', 'rope_slice_ends', 'rope_slice_axes'], ['rope_sin_slice'], name='node_rope_sin_slice'),
]
new_inits.append(i64('rope_seq_unsq_axes', [0]))

# ---- surgery: drop the runtime position chain, splice in the slices ----
first_idx = next(i for i, n in enumerate(g.node) if n.name == 'node_arange_1')
removed = 0
for name in CHAIN:
    g.node.remove(nodes_by_name[name])
    removed += 1
for n in reversed(new_nodes):
    g.node.insert(first_idx, n)
g.initializer.extend(new_inits)
g.initializer.extend([cos_table, sin_table])

for n in g.node:
    if n.name in ('node_unsqueeze_9', 'node_unsqueeze_10'):
        old = n.input[0]
        n.input[0] = REWIRES[old]
        print(f'rewired {n.name}: {old} -> {n.input[0]}')

# drop stale value_info for removed tensors
vi_by_name = {vi.name: vi for vi in g.value_info}
for gone in ['arange_1', 'unsqueeze_2', 'view', 'unsqueeze_7', '_to_copy_2',
             'matmul', 'transpose', 'cat_1', 'cos_1', 'sin_1', '_to_copy_3', '_to_copy_4']:
    if gone in vi_by_name:
        g.value_info.remove(vi_by_name[gone])

# drop initializers that only served the removed chain (avoids ORT
# CleanUnusedInitializersAndNodeArgs warnings on every load)
init_names = {i.name for i in g.initializer}
for gone in ['val_26', 'val_27', 'expand_1']:
    if gone in init_names:
        still_used = any(gone in n.input for n in g.node)
        if not still_used:
            g.initializer.remove(init_by_name[gone])

onnx.save(m, args.output)
print(f'wrote {args.output}: removed {removed} nodes, added rope tables [{1}x{ROPE_TABLE_MAX}x64] fp16 x2 + 4 glue nodes')
