# Create diff_step_probe2.onnx: diff_step_dml.onnx + intermediate probe outputs
# targeting the RoPE chain (the 2048-frame divergence suspect) plus layer
# boundaries / attention internals from the previous probe generation.
#
# Proto-only edit: external weight data reference (diff_step_dml.onnx.data) is
# preserved as-is because we never touch initializers and save into the same dir.
#
# Usage: python scripts/make_trt_rope_probe.py
import onnx
import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, 'onnx_models', 'fp16', 'diff_step_dml.onnx')
DST = os.path.join(REPO, 'onnx_models', 'fp16', 'diff_step_probe2.onnx')

ROPE_CHAIN = [
    'arange_1',      # int64 positions
    'unsqueeze_7',   # int64 [1,seq,1]
    '_to_copy_2',    # fp32 positions
    'matmul',        # fp32 phases pos*inv_freq [1,32,seq]
    'cat_1',         # fp32 duplicated phases [1,seq,64]
    'cos_1',         # fp32 cos rope
    'sin_1',         # fp32 sin rope
    '_to_copy_3',    # fp16 cos rope
    '_to_copy_4',    # fp16 sin rope
]
ATTENTION = [
    'matmul_2',      # [1,16,seq,64] per-head q/k (post rope)
    'val_117',       # [1,16,seq,seq] pre-softmax scores
    'matmul_1',      # [1,16,seq,seq]
    'add_193',
]
LAYERS = ['add_228', 'add_272', 'add_1282', 'add_2292', 'add_3302', 'add_4514']

m = onnx.load(SRC, load_external_data=False)
g = m.graph

existing = {vi.name for vi in g.value_info} | {i.name for i in g.input} \
    | {o.name for o in g.output} | {t.name for t in g.initializer}
produced = {o for n in g.node for o in n.output}

missing = [x for x in ROPE_CHAIN + ATTENTION + LAYERS if x not in produced]
if missing:
    raise SystemExit(f'tensors not produced by graph: {missing}')

have = {o.name for o in g.output}
added = []
for name in ROPE_CHAIN + ATTENTION + LAYERS:
    if name in have:
        continue
    vi = None
    for cand in list(g.value_info):
        if cand.name == name:
            vi = cand
            break
    if vi is None:
        # synthesize a minimal value_info: unknown type -> ORT rejects; better
        # to fail loudly here than produce a broken model
        raise SystemExit(f'no value_info for {name}; cannot type the probe output')
    g.output.append(vi)
    added.append(name)

onnx.save(m, DST)
print(f'wrote {DST}')
print('total outputs:', len(g.output))
print('probe outputs added:', added)
