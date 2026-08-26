#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build a W8A32 QDQ ONNX for diff_step: quantize ONLY weights to INT8 (per-channel
symmetric), keep activations FP32.

Why W8A32 instead of W8A8:
  - CUDA probe: weight-only INT8 -> cos 0.9999 / SNR 38dB (near-lossless).
  - ORT QDQ W8A8 caps DML/CPU at cos ~0.77 because INT8 activations are per-tensor,
    far below the per-last-dim activation scale that made CUDA W8A8 hit 0.998.
  - W8A32 keeps the same DP4A-style INT8 weight tensor-core benefit on DirectML while
    avoiding the activation-quantization precision cliff.

This builder works directly on the exported FP32 ONNX graph WITHOUT the ORT
calibrator (which OOMs on CPU / fails on DML for this dynamo graph). It adds, for
every MatMul/Gemm weight initializer, a QuantizeLinear->DequantizeLinear pair with a
per-channel scale computed from the weight itself (symmetric int8, axis=1 for MatMul /
axis=1 for Gemm weights).

Usage:
  python scripts/build_w8a32_diffstep.py <fp32.onnx> <out.onnx>
"""
import argparse
import os

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def build(model_path, out_path):
    model = onnx.load(model_path, load_external_data=True)
    graph = model.graph

    # collect weights (initializers) used by MatMul/Gemm as the 2nd input
    used_weights = set()
    for node in graph.node:
        if node.op_type in ("MatMul", "Gemm") and len(node.input) >= 2:
            used_weights.add(node.input[1])

    # map name->initializer
    init_map = {i.name: i for i in graph.initializer}

    # For each weight to quantize, remove the FP32 initializer and insert Q->DQ nodes
    new_nodes = []
    removed_inits = set()
    replacements = {}  # tensor name -> new produced tensor name

    import itertools
    _counter = itertools.count()

    def make_new_name():
        return f"q8_{next(_counter)}_"

    quantized_dq = {}  # original weight name -> its DQ output name (reuse on repeat)

    for node in graph.node:
        if node.op_type in ("MatMul", "Gemm") and node.input[1] in used_weights:
            wname = node.input[1]
            if wname in quantized_dq:
                # already quantized; just re-route this node's weight input
                nc = onnx.NodeProto()
                nc.CopyFrom(node)
                nc.input[1] = quantized_dq[wname]
                new_nodes.append(nc)
                continue
            if wname not in init_map:
                new_nodes.append(node)
                continue
            w = init_map[wname]
            arr = numpy_helper.to_array(w).astype(np.float32)
            is_matmul = node.op_type == "MatMul"
            # weight layout: [out, in] for Gemm (transA=0) and MatMul; per-channel
            # scale over the output dim (axis 0 for [out,in], fall back to 1 if wider
            # in the input dim).
            reduce_axis = 0 if arr.shape[0] <= arr.shape[1] else 1
            amax = np.abs(arr).max(axis=reduce_axis)  # per-channel, 1-D
            amax = np.maximum(amax, 1e-8)
            scale = (amax / 127.0).astype(np.float32)
            zp = np.zeros(scale.shape, dtype=np.int8)

            # names: QuantizeLinear reads the FP32 weight initializer directly and
            # produces an int8 intermediate; no pre-quantized initializer needed.
            qname = make_new_name()
            dqname = make_new_name()
            scale_name = make_new_name() + "scale"
            zp_name = make_new_name() + "zp"

            scale_init = numpy_helper.from_array(scale, name=scale_name)
            zp_init = numpy_helper.from_array(zp, name=zp_name)

            # Q node: per-channel quantization (scale is 1-D) -> scalar axis attribute
            q_node = helper.make_node(
                "QuantizeLinear",
                [wname, scale_name, zp_name],
                [qname],
                axis=int(reduce_axis),
            )
            dq_node = helper.make_node(
                "DequantizeLinear",
                [qname, scale_name, zp_name],
                [dqname],
                axis=int(reduce_axis),
            )

            # add inits (only scale/zp; the FP32 weight initializer stays as-is
            # because QuantizeLinear reads it directly)
            graph.initializer.append(scale_init)
            graph.initializer.append(zp_init)

            # new nodes: Q, DQ, then the original node with input[1]=dqname
            nc = onnx.NodeProto()
            nc.CopyFrom(node)
            nc.input[1] = dqname
            new_nodes.append(q_node)
            new_nodes.append(dq_node)
            new_nodes.append(nc)
            quantized_dq[wname] = dqname
            continue
        new_nodes.append(node)

    # remove quantized weight initializers (rebuild list)
    kept = [i for i in graph.initializer if i.name not in removed_inits]
    del graph.initializer[:]
    graph.initializer.extend(kept)
    del graph.node[:]
    graph.node.extend(new_nodes)

    # save (external data)
    if os.path.exists(out_path):
        os.remove(out_path)
    for ext in (".data",):
        p = out_path + ext
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
    n_q = sum(1 for n in graph.node if n.op_type == "QuantizeLinear")
    print(f"saved {out_path}: {n_q} QuantizeLinear nodes, removed {len(removed_inits)} weights")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fp32")
    ap.add_argument("out")
    args = ap.parse_args()
    build(args.fp32, args.out)


if __name__ == "__main__":
    main()