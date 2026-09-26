#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build W8A32 QDQ ONNX for diff_step: weights stored as INT8 initializers
(per-output-channel symmetric), DequantizeLinear restores FP32 for MatMul/Gemm.

v2 fixes vs v1:
  - v1 kept the FP32 weight initializer and let QuantizeLinear read it at runtime,
    so the saved model was still ~1.7 GB with no int8 storage at all.
  - v2 pre-quantizes weights in numpy, stores INT8 initializers (4x smaller file)
    and inserts only DequantizeLinear nodes. Scale is 1-D with length exactly equal
    to the quantized axis dimension (ONNX per-axis kernel requirement).
  - Axis choice: Gemm(transB=1) weights are [out,in] -> axis 0; MatMul B weights are
    constant-folded [in,out] -> axis = last.

Usage:
  python scripts/build_w8a32_diffstep.py <fp32.onnx> <out.onnx>
"""
import argparse
import gc
import itertools
import os

import numpy as np
import onnx
from onnx import helper, numpy_helper


def convert(model_path, out_path):
    print(f"[w8a32] loading {model_path} (external data) ...")
    model = onnx.load(model_path, load_external_data=True)
    graph = model.graph

    init_names = {init.name for init in graph.initializer}

    # collect MatMul/Gemm B-operand edges whose source is an initializer
    weight_edges = []  # (node_index, input_slot, init_name)
    for ni, node in enumerate(graph.node):
        if node.op_type in ("MatMul", "Gemm") and len(node.input) >= 2:
            if node.input[1] in init_names:
                weight_edges.append((ni, 1, node.input[1]))

    targets = sorted({name for _, _, name in weight_edges})
    total_consumers = {}
    for nd in graph.node:
        for inp in nd.input:
            total_consumers[inp] = total_consumers.get(inp, 0) + 1
    print(f"[w8a32] quantizing {len(targets)} weight initializers")

    counter = itertools.count()
    dq_out_of = {}   # fp32 init name -> DQ output tensor name
    shared_fp32 = set()

    new_inits = []
    dq_nodes = []

    for wname in targets:
        init = next(i for i in graph.initializer if i.name == wname)
        arr = numpy_helper.to_array(init)
        if arr.dtype not in (np.float32, np.float16):
            print(f"  skip non-float weight {wname} dtype={arr.dtype}")
            continue
        arr = arr.astype(np.float32)

        cons_ops = {graph.node[ni].op_type for ni, _, n in weight_edges if n == wname}
        if cons_ops <= {"Gemm"}:
            qaxis = 0                      # [out,in]
        elif cons_ops <= {"MatMul"}:
            qaxis = len(arr.shape) - 1     # folded [in,out]
        else:                              # mixed consumers
            qaxis = 0 if init.dims[0] <= init.dims[-1] else len(arr.shape) - 1

        try:
            reduce_axes = tuple(i for i in range(arr.ndim) if i != qaxis)
            amax = np.max(np.abs(arr), axis=reduce_axes).astype(np.float32)
            assert amax.shape == (init.dims[qaxis],), \
                f"scale len {amax.shape} != axis dim {init.dims[qaxis]}"
            amax = np.maximum(amax, 1e-8)
            scale = (amax / 127.0).astype(np.float32)
            shape_scale = [1] * arr.ndim
            shape_scale[qaxis] = -1
            q = np.clip(np.round(arr / scale.reshape(shape_scale)), -127, 127).astype(np.int8)
        except ValueError:
            print(f"  DEBUG fail {wname}: dims={tuple(init.dims)} shape={arr.shape} "
                  f"ndim={arr.ndim} cons_ops={cons_ops} qaxis={qaxis}")
            raise
        del arr

        base = f"q8_{next(counter)}_{wname}"
        i8_name = base + ".i8"
        scale_name = base + ".scale"
        zp_name = base + ".zp"
        dq_name = base + ".dq_out"

        new_inits.append(numpy_helper.from_array(q, name=i8_name))
        new_inits.append(numpy_helper.from_array(scale, name=scale_name))
        new_inits.append(numpy_helper.from_array(np.zeros(scale.shape, dtype=np.int8), name=zp_name))
        dq_nodes.append(helper.make_node(
            "DequantizeLinear",
            [i8_name, scale_name, zp_name],
            [dq_name],
            axis=int(qaxis),
            name=base + ".dq",
        ))
        # keep FP32 original only when non-MatMul consumers exist
        if total_consumers.get(wname, 0) > sum(1 for _, _, n in weight_edges if n == wname):
            shared_fp32.add(wname)
        else:
            dq_out_of[wname] = dq_name

        del q
        gc.collect()

    for init in new_inits:
        graph.initializer.append(init)

    # remove replaced FP32 weight initializers (unless shared with other ops)
    keep = [i for i in graph.initializer if i.name not in dq_out_of]
    del graph.initializer[:]
    graph.initializer.extend(keep)

    # rewire MatMul/Gemm weight inputs to DQ outputs
    for ni, slot, wname in weight_edges:
        if wname in dq_out_of:
            graph.node[ni].input[slot] = dq_out_of[wname]

    # order nodes so each DQ precedes its first consumer
    dq_by_out = {n.output[0]: n for n in dq_nodes}
    ordered = []
    emitted = set()
    for n in graph.node:
        for inp in n.input:
            d = dq_by_out.get(inp)
            if d is not None and id(d) not in emitted:
                ordered.append(d)
                emitted.add(id(d))
        ordered.append(n)
    for i, d in enumerate(dq_nodes):
        if id(d) not in emitted:
            ordered.append(d)
            emitted.add(id(d))
    del graph.node[:]
    graph.node.extend(ordered)

    out_dir = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(out_dir, exist_ok=True)
    for p in (out_path, out_path + ".data"):
        if os.path.exists(p):
            os.remove(p)
    onnx.save_model(
        model,
        out_path,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=os.path.basename(out_path) + ".data",
        size_threshold=1024,
    )
    n_dq = sum(1 for n in graph.node if n.op_type == "DequantizeLinear")
    sz = os.path.getsize(out_path + ".data") / 1024 / 1024
    print(f"[w8a32] saved {out_path}: {n_dq} DQ nodes, data={sz:.0f} MB, "
          f"shared-fp32-kept={len(shared_fp32)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fp32")
    ap.add_argument("out")
    args = ap.parse_args()
    convert(args.fp32, args.out)


if __name__ == "__main__":
    main()
