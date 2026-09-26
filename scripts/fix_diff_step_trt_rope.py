# Fix the TRT-RTX 2048-frame RoPE divergence in diff_step.
#
# Root cause (measured, see scripts/probe_trt_rope.js):
#   TRT-RTX's Myelin-fused kernel executes the fp32 MatMul (position x inv_freq)
#   at reduced precision (11-bit mantissa grid): positions >= 2049 are rounded
#   to the nearest even (2049 -> 2050), producing a phase error of +-inv_freq
#   per corrupted frame (1.0 rad on the omega=1.0 channel). The rope embedding
#   then deviates by up to ~0.95 per channel, poisoning q/k rotation in all 22
#   attention layers; the residual stream diverges from frame 2048 and the
#   32-step diffusion amplifies it into the tail energy dip.
#
# Fix: force the position->phase MatMul onto the CPU EP by computing it in
#   float64. Neither TRT-RTX nor DirectML supports double, so ORT assigns the
#   two Casts + MatMul to CPU (exact fp64 math), and the engine receives exact
#   fp32 phases. TRT's Sin/Cos on exact fp32 arguments was verified accurate.
#   CPU/DML/TRT all produce identical, position-exact rope embeddings.
#
# The op set is architectural, not version-dependent: TRT has never supported
# fp64, DirectML has no double operator.
#
# Usage:
#   python scripts/fix_diff_step_trt_rope.py --input a.onnx --output b.onnx
import argparse
import onnx
from onnx import TensorProto
from onnx import helper

ap = argparse.ArgumentParser()
ap.add_argument('--input', required=True)
ap.add_argument('--output', required=True)
args = ap.parse_args()

m = onnx.load(args.input, load_external_data=False)
g = m.graph

nodes = {n.name: n for n in g.node}
outputs_of = {o: n for n in g.node for o in n.output}

# --- sanity: the expected chain exists ---
for name in ['node__to_copy_2', 'node_matmul', 'node_transpose']:
    if name not in nodes:
        raise SystemExit(f'expected node missing: {name}')
if 'expand_1' not in {i.name for i in g.initializer}:
    raise SystemExit('expand_1 initializer (inv_freq) not found')
matmul_node = nodes['node_matmul']
if matmul_node.op_type != 'MatMul' or sorted(matmul_node.input) != sorted(['expand_1', '_to_copy_2']):
    raise SystemExit(f'unexpected matmul inputs: {list(matmul_node.input)}')

# consumers that must be rewired: node_transpose reads matmul (the only one)
consumers_of_matmul = [n for n in g.node if 'matmul' in n.input and n.name != 'node_transpose']
for n in consumers_of_matmul:
    raise SystemExit(f'unexpected extra consumer of matmul: {n.name}')

# --- surgery ---
# 1) drop the fp32 path: Cast(_to_copy_2) and MatMul
g.node.remove(nodes['node__to_copy_2'])
g.node.remove(nodes['node_matmul'])

# 2) fp64 detour (CPU EP): positions -> double, inv_freq -> double, matmul, -> float
k = g.input[2].type.tensor_type.shape.dim[1].dim_param or 'seq_len'  # informational only
new_nodes = [
    helper.make_node('Cast', ['unsqueeze_7'], ['_to_copy_2_f64'], name='node__to_copy_2_f64', to=TensorProto.DOUBLE),
    helper.make_node('Cast', ['expand_1'], ['expand_1_f64'], name='node_expand_1_f64', to=TensorProto.DOUBLE),
    helper.make_node('MatMul', ['expand_1_f64', '_to_copy_2_f64'], ['matmul_f64'], name='node_matmul_f64'),
    helper.make_node('Cast', ['matmul_f64'], ['matmul_f32'], name='node_matmul_f32', to=TensorProto.FLOAT),
]
g.node.extend(new_nodes)

# 3) rewire downstream (Transpose of the rope chain) to the exact fp32 phases
nodes['node_transpose'].input[0] = 'matmul_f32'

# 4) drop stale value_info for removed tensors
vi_by_name = {vi.name: vi for vi in g.value_info}
for gone in ['_to_copy_2', 'matmul']:
    if gone in vi_by_name:
        g.value_info.remove(vi_by_name[gone])

# 5) retarget probe outputs that referenced removed tensors.
#    NOTE: TRT-RTX EP rejects graph outputs of type DOUBLE (EP_FAIL in
#    GetCapability), so a DOUBLE tensor can never be a graph output.
#    Collect first, then mutate — removing while iterating skips entries.
to_remove = []
for o in g.output:
    if o.name == 'matmul':
        o.name = 'matmul_f32'
    elif o.name == '_to_copy_2':
        to_remove.append(o)
for o in to_remove:
    g.output.remove(o)

# keep node order: ORT is tolerant, but insert new nodes where the old matmul was
onnx.save(m, args.output)
print(f'wrote {args.output}')
print('surgery: Cast->f64 positions, Cast->f64 inv_freq, f64 MatMul, Cast->f32, rewired node_transpose')
