#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Convert diff_step FP32 ONNX to FP16 compute for DirectML real-speedup.

onnxconverter_common 1.16 chokes on dynamo-exported graphs (_to_copy nodes leave
type mismatches), so this does a manual whole-graph conversion:

  1. every FLOAT initializer -> FLOAT16
  2. existing Cast nodes: to=FLOAT -> to=FLOAT16
  3. graph inputs/outputs stay FP32 (app feeds unchanged); Cast inserted at the
     boundaries and consumers rewired
  4. stale value_info dropped so ORT re-infers types consistently

DirectML executes fp16 GEMM natively (~2x throughput on most GPUs); DML has no
mixed int8-weight x fp32-activation GEMM operator, which is why W8A32 measured
0.90x there while this targets real >1x.

Usage:
  python scripts/make_fp16_diffstep.py <fp32.onnx> <out.onnx>
"""
import argparse
import os

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fp32")
    ap.add_argument("out")
    args = ap.parse_args()

    print(f"[fp16] loading {args.fp32} ...")
    model = onnx.load(args.fp32, load_external_data=True)
    g = model.graph

    # 1. initializers
    n_w = 0
    new_inits = []
    for init in g.initializer:
        if init.data_type == TensorProto.FLOAT:
            arr = numpy_helper.to_array(init)
            if np.max(np.abs(arr)) > 65504.0:
                # e.g. mask constants at -FLT_MAX: clamp to fp16 range; semantics
                # (additive -inf masks) are preserved because softmax underflows
                arr = np.clip(arr, -65504.0, 65504.0)
                print(f"[fp16] clamped out-of-range initializer {init.name}")
            new_inits.append(numpy_helper.from_array(arr.astype(np.float16), name=init.name))
            n_w += 1
        else:
            new_inits.append(init)
    del g.initializer[:]
    g.initializer.extend(new_inits)
    print(f"[fp16] converted {n_w} float initializers")

    # 2. Cast nodes
    n_cast = 0
    for n in g.node:
        if n.op_type == "Cast":
            for at in n.attribute:
                if at.name == "to" and at.i == TensorProto.FLOAT:
                    at.i = TensorProto.FLOAT16
                    n_cast += 1
    print(f"[fp16] flipped {n_cast} Cast attrs")

    # 3. IO boundary casts (graph IO stays FP32)
    io_float = [i.name for i in g.input
                if i.type.tensor_type.elem_type == TensorProto.FLOAT]
    rewires = {}
    cast_nodes = []
    extra_inits = []
    counter = 0
    for name in io_float:
        out_name = f"{name}.to_f16"
        cnode = helper.make_node("Cast", [name], [out_name], to=TensorProto.FLOAT16,
                                 name=f"io_cast_in_{counter}")
        counter += 1
        cast_nodes.append(cnode)
        rewires[name] = out_name

    for n in list(g.node):
        for k, inp in enumerate(n.input):
            if inp in rewires:
                n.input[k] = rewires[inp]

    new_outputs = []
    for o in g.output:
        prod = next((n for n in g.node if o.name in n.output), None)
        if prod is None or prod.op_type == "Cast":
            new_outputs.append(o)
            continue
        cast_out = f"{o.name}.to_f32"
        cnode = helper.make_node("Cast", [o.name], [cast_out], to=TensorProto.FLOAT,
                                 name=f"io_cast_out_{counter}")
        counter += 1
        cast_nodes.append(cnode)
        no = onnx.ValueInfoProto()
        no.CopyFrom(o)
        no.name = cast_out
        no.type.tensor_type.elem_type = TensorProto.FLOAT
        new_outputs.append(no)

    # cast nodes go first (they only depend on graph inputs); output casts already
    # ordered correctly relative to producers because we appended them after all
    # original nodes and ONNX exec order is topological by data dependency anyway.
    in_casts = [c for c in cast_nodes if c.name.startswith("io_cast_in")]
    out_casts = [c for c in cast_nodes if c.name.startswith("io_cast_out")]
    nodes = in_casts + list(g.node) + out_casts
    del g.node[:]
    g.node.extend(nodes)

    # replace graph outputs
    del g.output[:]
    g.output.extend(new_outputs)

    # 4. drop stale value_info (ORT re-infers; avoids type mismatch load errors)
    del g.value_info[:]

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    for p in (args.out, args.out + ".data"):
        if os.path.exists(p):
            os.remove(p)
    onnx.save_model(
        model,
        args.out,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=os.path.basename(args.out) + ".data",
        size_threshold=1024,
    )
    sz = os.path.getsize(args.out + ".data") / 1024 / 1024
    print(f"[fp16] saved {args.out}: {len(cast_nodes)} boundary casts, data={sz:.0f} MB")


if __name__ == "__main__":
    main()
